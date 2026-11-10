// Create tasks by email.
//
// A registered user sends an email to the task inbox address (TASK_INBOX_ADDRESS):
//   To / CC  → the people to assign (anyone in the organization, by email)
//   Subject  → task title; [High] / [Medium] / [Low] in the subject sets the priority
//   Body     → description. Optional lines anywhere in the body:
//                Assign: priya@company.com, John Doe
//                Due: 15 Nov 2026 5:00 PM        (also "today", "tomorrow", "in 3 days")
//                Priority: High
//                Department: Development
//   Files    → task attachments (same types as the app, 8 MB each, at most 10)
// No one besides the sender (and the inbox) → the task is assigned to the sender.
//
// Safety:
//   • only active users of the app can create tasks, and only with the same permissions
//     as in the app (tasks.create; tasks.assign to give work to someone else)
//   • the sender address must pass the receiving server's SPF / DKIM / DMARC check,
//     so nobody can create tasks by faking a colleague's From address
//   • automatic mail (out-of-office, mailing lists, bounces) is ignored, so there are no loops
//   • every email is processed once (Message-ID is remembered)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import Task, { TASK_PRIORITIES } from "../models/Task.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import InboundTaskEmail from "../models/InboundTaskEmail.js";
import { resolvePermissions, hasPermission } from "../middleware/permissionMiddleware.js";
import { generateReferenceId } from "./referenceIdService.js";
import { parseFlexibleDate } from "../utils/csv.js";
import { cloudEnabled, pushFileToCloud, MAX_UPLOAD_SIZE, MAX_UPLOAD_MB } from "./fileStorage.js";
import { send, layout, button, escapeHtml, frontendUrl } from "./accountEmailService.js";
import { TASK_TIME_ZONE } from "./taskNotificationService.js";
import {
  UPLOAD_DIR,
  TASK_FILES_FOLDER,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENTS_PER_REQUEST,
  toAttachment,
  announce,
  resolveAssignedUser,
  ensureCanAssign,
  removeUnreferencedFiles,
  AssignError,
} from "../controllers/taskController.js";

/* ==================== SETTINGS ==================== */

export const inboxAddress = () => String(process.env.TASK_INBOX_ADDRESS || "").trim().toLowerCase();

const requireSenderAuth = () => String(process.env.TASK_INBOX_REQUIRE_AUTH || "true").toLowerCase() !== "false";

/* ==================== SMALL HELPERS ==================== */

const lower = (v) => String(v || "").trim().toLowerCase();
const domainOf = (email) => lower(email).split("@")[1] || "";
const emailOf = (v) => lower(String(v || "").replace(/^.*<([^>]+)>.*$/, "$1"));

class EmailTaskError extends Error {}

/**
 * Was the From address really used by its owner?
 * Reads the receiving server's Authentication-Results header (the TOP one — the one our
 * own mail server added; anything below it came with the message and is not trusted).
 * Accepts DMARC pass, or DKIM / SPF pass for the From domain.
 */
export const senderVerified = (authResults, fromAddress) => {
  if (!requireSenderAuth()) return true;
  const text = lower(authResults);
  const domain = domainOf(fromAddress);
  if (!text || !domain) return false;

  const aligned = (d) => {
    const clean = lower(d).replace(/^@/, "").split("@").pop();
    return clean === domain || domain.endsWith(`.${clean}`);
  };

  const dmarc = /dmarc=pass\b[^;]*?header\.from=([^\s;]+)/.exec(text);
  if (dmarc && aligned(dmarc[1])) return true;

  for (const m of text.matchAll(/dkim=pass\b[^;]*?header\.(?:i|d)=([^\s;]+)/g)) {
    if (aligned(m[1])) return true;
  }

  const spf = /spf=pass\b[^;]*?smtp\.mailfrom=([^\s;]+)/.exec(text);
  if (spf && aligned(spf[1])) return true;

  return false;
};

/** Out-of-office replies, bounces, mailing lists… must never create tasks or get answers */
const isAutomatic = ({ autoSubmitted, precedence, from }) => {
  if (autoSubmitted && lower(autoSubmitted) !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(lower(precedence))) return true;
  return /^(mailer-daemon|postmaster|no-?reply|noreply)@/.test(lower(from));
};

const cleanSubject = (subject) => {
  let s = String(subject || "").trim();
  // "Re: Fwd: …" prefixes
  while (/^(re|fw|fwd|aw|wg)\s*:\s*/i.test(s)) s = s.replace(/^(re|fw|fwd|aw|wg)\s*:\s*/i, "");
  let priority = "";
  s = s.replace(/\[(high|medium|low)\]/gi, (_, p) => {
    priority = p;
    return "";
  });
  return { title: s.replace(/\s{2,}/g, " ").trim().slice(0, 200), priority };
};

const FIELD = /^\s*(assign|assignee|assignees|assign to|assigned to|due|due date|deadline|priority|department|dept)\s*[:=-]\s*(.+?)\s*$/i;

/** Body → { description, fields } — field lines are taken out; quoted replies / signatures cut off */
export const parseBody = (text) => {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const fields = { assign: [], due: "", priority: "", department: "" };
  const kept = [];

  for (const line of lines) {
    // stop at the quoted earlier message or the signature
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^>/.test(line)) break;
    if (/^--\s*$/.test(line)) break;

    const m = FIELD.exec(line);
    if (m) {
      const key = lower(m[1]);
      if (key.startsWith("assign")) fields.assign.push(...m[2].split(/[,;]/).map((v) => v.trim()).filter(Boolean));
      else if (key.startsWith("due") || key === "deadline") fields.due = m[2];
      else if (key === "priority") fields.priority = m[2];
      else fields.department = m[2];
      continue;
    }
    kept.push(line);
  }

  const description = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
  return { description, fields };
};

/** "today" / "tomorrow" / "in 3 days" / any date the CSV import understands (+ optional time) */
export const parseDue = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { date: "", time: "" };
  const now = DateTime.now().setZone(TASK_TIME_ZONE);

  const rel = /^(today|tomorrow|in\s+(\d{1,3})\s+days?)\b\s*(.*)$/i.exec(raw);
  if (rel) {
    const days = /^today/i.test(rel[1]) ? 0 : /^tomorrow/i.test(rel[1]) ? 1 : Number(rel[2]);
    const date = now.plus({ days }).toISODate();
    const rest = rel[3].trim();
    if (!rest) return { date, time: "" };
    const withTime = parseFlexibleDate(`${date} ${rest}`);
    if (!withTime?.time) return null;
    return { date, time: withTime.time };
  }

  const parsed = parseFlexibleDate(raw);
  return parsed ? { date: parsed.date, time: parsed.time || "" } : null;
};

/* ==================== REPLIES ==================== */

const HELP_HTML = () => `
<p style="margin-top:18px;font-size:13px;color:#4f6f7a"><strong>How to create a task by email</strong><br>
Send to <strong>${escapeHtml(inboxAddress())}</strong><br>
• <strong>Subject</strong> = task title (add [High] or [Low] for priority)<br>
• <strong>To / CC</strong> = the people to assign (their email in the app)<br>
• <strong>Body</strong> = description, plus optional lines:<br>
&nbsp;&nbsp;<code>Due: 15 Nov 2026 5:00 PM</code> · <code>Priority: High</code> · <code>Department: Development</code> · <code>Assign: name or email</code><br>
• Attach files up to ${MAX_UPLOAD_MB} MB each.</p>`;

const replyCreated = (to, subject, tasks, people, skipped) => {
  const t = tasks[0];
  const rows = [
    ["Task ID", t.referenceId ? `#${t.referenceId}` : "—"],
    ["Assigned to", people.join(", ")],
    ["Priority", t.priority],
    ["Due", t.dueDate ? `${DateTime.fromJSDate(t.dueDate, { zone: "utc" }).toFormat("dd LLL yyyy")}${t.dueTime ? ` · ${DateTime.fromFormat(t.dueTime, "HH:mm").toFormat("h:mm a")}` : ""}` : "No due date"],
    ["Department", t.department || "—"],
    ["Files", String(t.attachments?.length || 0)],
  ];
  const html = layout(
    "Task created from your email",
    `<p>“<strong>${escapeHtml(t.name)}</strong>” was created.</p>
     <table style="border-collapse:collapse;font-size:13px">${rows
       .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6E8799">${k}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`)
       .join("")}</table>
     ${skipped.length ? `<p style="color:#9a6a0a;font-size:13px">Not attached: ${skipped.map(escapeHtml).join("; ")}</p>` : ""}
     ${button(`${frontendUrl()}/dashboard/tasks`, "Open tasks")}`
  );
  const text = `Task "${t.name}" was created${t.referenceId ? ` (#${t.referenceId})` : ""} and assigned to ${people.join(", ")}.` +
    (skipped.length ? `\nNot attached: ${skipped.join("; ")}` : "") +
    `\n${frontendUrl()}/dashboard/tasks`;
  return send({ to, subject: `Task created: ${subject}`, text, html });
};

const replyRejected = (to, subject, reason) =>
  send({
    to,
    subject: `Task not created: ${subject || "(no subject)"}`,
    text: `Your email did not create a task: ${reason}\n\nSend to ${inboxAddress()}: Subject = title, To/CC = people to assign, ` +
      `optional body lines "Due: 15 Nov 2026 5:00 PM", "Priority: High", "Department: …", "Assign: …".`,
    html: layout(
      "Task not created",
      `<p>Your email “${escapeHtml(subject || "(no subject)")}” did not create a task:</p>
       <p style="background:#FDECEE;border:1px solid #F5C6CF;border-radius:10px;padding:10px 12px;color:#b34444">${escapeHtml(reason)}</p>
       ${HELP_HTML()}`
    ),
  });

/* ==================== ATTACHMENTS ==================== */

// mailparser attachments → stored task files (disk, then Cloudinary when it is set up)
const storeAttachments = async (files, senderId) => {
  const saved = [];
  const skipped = [];
  for (const a of files) {
    // inline pictures (logos in signatures) are not task files
    if (a.related || (a.contentDisposition === "inline" && a.cid)) continue;
    const name = path.basename(String(a.filename || "attachment")).slice(0, 180);
    const ext = path.extname(name).slice(1).toLowerCase();
    const size = a.size ?? a.content?.length ?? 0;
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) { skipped.push(`${name} (file type not allowed)`); continue; }
    if (!size) { skipped.push(`${name} (empty)`); continue; }
    if (size > MAX_UPLOAD_SIZE) { skipped.push(`${name} (larger than ${MAX_UPLOAD_MB} MB)`); continue; }
    if (saved.length >= MAX_ATTACHMENTS_PER_REQUEST) { skipped.push(`${name} (more than ${MAX_ATTACHMENTS_PER_REQUEST} files)`); continue; }

    const filename = `task-${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const full = path.join(UPLOAD_DIR, filename);
    await fs.promises.writeFile(full, a.content);
    try {
      if (cloudEnabled()) await pushFileToCloud(full, TASK_FILES_FOLDER, filename);
    } catch (err) {
      await fs.promises.unlink(full).catch(() => {});
      console.error("Email task: file upload failed:", err.message);
      skipped.push(`${name} (upload failed)`);
      continue;
    }
    saved.push(toAttachment({ originalname: name, size, filename, mimetype: a.contentType || "" }, senderId));
  }
  return { saved, skipped };
};

/* ==================== MAIN ==================== */

/**
 * Turn one received email into task(s).
 * mail = { messageId, from, to: [], cc: [], subject, text, attachments: [], authResults, autoSubmitted, precedence }
 * → { status: "created" | "rejected" | "ignored" | "duplicate", reason?, tasks? }
 */
export const processInboundEmail = async (mail) => {
  const from = emailOf(mail.from);
  const messageId = String(mail.messageId || "").trim() ||
    crypto.createHash("sha256").update(`${from}|${mail.subject}|${mail.date || ""}|${mail.text || ""}`).digest("hex");

  if (await InboundTaskEmail.exists({ messageId })) return { status: "duplicate" };

  const log = async (status, extra = {}) => {
    try {
      await InboundTaskEmail.create({ messageId, from, subject: String(mail.subject || "").slice(0, 300), status, ...extra });
    } catch (err) {
      if (err.code !== 11000) throw err; // another run got it first
    }
    return { status, ...extra };
  };

  // 1. Not for us → no reply at all (avoids mail loops and answering spam)
  if (!from || from === inboxAddress()) return log("ignored", { reason: "Sent by the inbox itself" });
  if (isAutomatic({ ...mail, from })) return log("ignored", { reason: "Automatic email" });
  if (!senderVerified(mail.authResults, from)) {
    return log("ignored", { reason: "Sender address could not be verified (SPF/DKIM/DMARC)" });
  }
  const sender = await User.findOne({ email: from, status: "Active" });
  if (!sender) return log("ignored", { reason: "Sender is not an active user of the app" });

  const subjectInfo = cleanSubject(mail.subject);
  const orgId = sender.role === "Admin" ? sender._id : sender.admin_id;
  const reject = async (reason) => {
    await replyRejected(from, subjectInfo.title || mail.subject, reason);
    return log("rejected", { reason, sender: sender._id, admin_id: orgId || null });
  };

  try {
    // 2. Same permissions as the app
    if (sender.role === "SuperAdmin" || !orgId) {
      throw new EmailTaskError("Tasks by email are created inside an organization. Please sign in as an organization user.");
    }
    const permissions = await resolvePermissions(sender);
    const req = { user: sender, permissions, adminId: orgId };
    if (!hasPermission(req, "tasks", "create")) {
      throw new EmailTaskError("Your account does not have permission to create tasks.");
    }

    // 3. Title, priority, due, department
    const { title, priority: subjectPriority } = subjectInfo;
    if (!title) throw new EmailTaskError("The subject is empty. The subject becomes the task title.");

    const { description, fields } = parseBody(mail.text);

    const priorityInput = fields.priority || subjectPriority;
    const priority = priorityInput ? TASK_PRIORITIES.find((p) => lower(p) === lower(priorityInput)) : "Medium";
    if (!priority) throw new EmailTaskError(`Priority "${priorityInput}" is not valid. Use ${TASK_PRIORITIES.join(", ")}.`);

    const due = parseDue(fields.due);
    if (!due) throw new EmailTaskError(`Due "${fields.due}" is not a date we can read. Example: Due: 15 Nov 2026 5:00 PM`);

    let department = "";
    if (fields.department) {
      const dept = await Department.findOne({
        $or: [{ admin_id: orgId }, { createdBy: orgId }],
        name: { $regex: new RegExp(`^${fields.department.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      }).select("name").lean();
      if (!dept) throw new EmailTaskError(`Department "${fields.department}" does not exist in your organization.`);
      department = dept.name;
    }

    // 4. Who gets the task: To / CC (minus the inbox and the sender) + "Assign:" lines; nobody → the sender
    const inbox = inboxAddress();
    const recipients = [...(mail.to || []), ...(mail.cc || [])].map(emailOf).filter((e) => e && e !== inbox && e !== from);
    const inputs = [...new Set([...recipients, ...fields.assign.map((v) => (v.includes("@") ? emailOf(v) : v))])];

    if (!inputs.length && sender.role === "Admin") {
      throw new EmailTaskError("Add the people to assign in To / CC, or an \"Assign:\" line in the body.");
    }

    const users = [];
    const problems = [];
    for (const input of inputs.length ? inputs : [String(sender._id)]) {
      try {
        const u = await resolveAssignedUser(input, department, orgId, sender.role);
        if (u && !users.some((x) => String(x._id) === String(u._id))) users.push(u);
      } catch (err) {
        problems.push(err.message);
      }
    }
    if (problems.length) throw new EmailTaskError(problems.join(" · "));
    ensureCanAssign(req, users);
    if (!department) department = users[0]?.department || "";

    // 5. Files, then the task(s) — several people → one task each, sharing a group id (as in the app)
    const { saved, skipped } = await storeAttachments(mail.attachments || [], sender._id);
    let created;
    try {
      const referenceId = await generateReferenceId(orgId, department);
      const groupId = users.length > 1 ? new mongoose.Types.ObjectId() : null;
      const base = {
        name: title,
        referenceId,
        description,
        department,
        departments: department ? [department] : [],
        assignedBy: sender._id,
        assignedAt: new Date(),
        isTaskBank: false,
        dueDate: due.date || undefined,
        dueTime: due.time || "",
        priority,
        status: "To Do",
        attachments: saved,
        admin_id: orgId,
        taskGroupId: groupId,
        statusHistory: [
          { from: null, to: "To Do", changedBy: sender._id, changedByName: sender.name, note: "Created from email" },
        ],
      };
      created = await Task.insertMany(users.map((u) => ({ ...base, assignedTo: u._id })));
    } catch (err) {
      await removeUnreferencedFiles(saved.map((a) => a.filename));
      throw err;
    }

    announce(created, sender._id);
    await replyCreated(from, title, created, users.map((u) => u.name), skipped);
    return log("created", { sender: sender._id, admin_id: orgId, tasks: created.map((t) => t._id) });
  } catch (err) {
    if (err instanceof EmailTaskError || err instanceof AssignError) return reject(err.message);
    console.error("Email task failed:", err);
    return reject("Something went wrong while creating the task. Please try again or create it in the app.");
  }
};
