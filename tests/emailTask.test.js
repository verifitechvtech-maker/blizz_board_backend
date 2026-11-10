// Create tasks by email — processInboundEmail with an in-memory database (no real mailbox)
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-only-for-tests";
// real services from .env (email, Cloudinary, task inbox, Render flags) are never used by tests
for (const k of ["SMTP_USER", "SMTP_PASS", "CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "TASK_INBOX_ENABLED", "RENDER"]) process.env[k] = "";
process.env.NODE_ENV = "test";
process.env.TASK_INBOX_ADDRESS = "boss+tasks@gmail.com";
process.env.TASK_INBOX_REQUIRE_AUTH = "true";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();

const User = (await import("../src/models/User.js")).default;
const Task = (await import("../src/models/Task.js")).default;
const Department = (await import("../src/models/Department.js")).default;
const InboundTaskEmail = (await import("../src/models/InboundTaskEmail.js")).default;
const { processInboundEmail, senderVerified, parseBody, parseDue } = await import("../src/services/emailTaskService.js");
const { sentMessages } = await import("../src/services/accountEmailService.js");
const { removeUnreferencedFiles } = await import("../src/controllers/taskController.js");

const AUTH_OK = (domain) =>
  `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass (google.com: domain designates 1.2.3.4) smtp.mailfrom=x@${domain}; dmarc=pass (p=NONE) header.from=${domain}`;

let admin, manager, priya, john, outsiderOrgUser;
let n = 0;
const mail = (over = {}) => ({
  messageId: `<m${++n}@acme.test>`,
  from: "manager@acme.test",
  to: ["boss+tasks@gmail.com"],
  cc: [],
  subject: "Prepare report",
  text: "",
  attachments: [],
  authResults: AUTH_OK("acme.test"),
  ...over,
});
const lastReply = () => sentMessages[sentMessages.length - 1];

before(async () => {
  await mongoose.connect(mongod.getUri());
  admin = await User.create({ name: "Org Admin", email: "admin@acme.test", password: "Admin@123", role: "Admin" });
  await Department.create({ name: "Development", admin_id: admin._id, createdBy: admin._id });
  const member = (name, email, role, department, extra = {}) =>
    User.create({ name, email, password: "Pass@123", role, department, admin_id: admin._id, createdBy: admin._id, ...extra });
  manager = await member("Mona Manager", "manager@acme.test", "Manager", "Development");
  priya = await member("Priya", "priya@acme.test", "User", "Development");
  john = await member("John", "john@acme.test", "User", "Sales");
  const other = await User.create({ name: "Other Admin", email: "other@else.test", password: "Admin@123", role: "Admin" });
  outsiderOrgUser = await User.create({ name: "Stranger", email: "stranger@else.test", password: "Pass@123", role: "User", admin_id: other._id, createdBy: other._id });
});

after(async () => {
  const files = (await Task.find().lean()).flatMap((t) => t.attachments.map((a) => a.filename));
  await Task.deleteMany({});
  await removeUnreferencedFiles(files); // no test files left in uploads/tasks
  await mongoose.disconnect();
  await mongod.stop();
});

describe("parsing", () => {
  test("body fields are taken out, quoted reply and signature cut", () => {
    const { description, fields } = parseBody(
      "Please collect the KPIs.\nDue: 15 Nov 2026 5:00 PM\nPriority: high\nAssign: priya@acme.test, John\nDepartment: Development\n\nThanks\n--\nMona\n> old quoted text"
    );
    assert.equal(description, "Please collect the KPIs.\n\nThanks");
    assert.deepEqual(fields, { assign: ["priya@acme.test", "John"], due: "15 Nov 2026 5:00 PM", priority: "high", department: "Development" });
  });

  test("due dates: absolute, today / tomorrow / in N days, with times; nonsense → null", () => {
    assert.deepEqual(parseDue("15 Nov 2026 5:00 PM"), { date: "2026-11-15", time: "17:00" });
    assert.equal(parseDue("tomorrow 9:30 AM").time, "09:30");
    assert.match(parseDue("in 3 days").date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(parseDue(""), { date: "", time: "" });
    assert.equal(parseDue("someday"), null);
  });

  test("sender verification needs SPF / DKIM / DMARC pass for the From domain", () => {
    assert.equal(senderVerified(AUTH_OK("acme.test"), "a@acme.test"), true);
    assert.equal(senderVerified("mx.google.com; dkim=pass header.i=@evil.test; spf=fail smtp.mailfrom=a@evil.test; dmarc=fail header.from=acme.test", "a@acme.test"), false);
    assert.equal(senderVerified("", "a@acme.test"), false);
  });
});

describe("creating tasks", () => {
  test("To/CC people get the task; subject = title; body fields applied; sender is the assigner", async () => {
    const r = await processInboundEmail(mail({
      subject: "Re: [High] Monthly KPI report",
      to: ["boss+tasks@gmail.com", "Priya <priya@acme.test>"],
      text: "Collect the numbers.\nDue: 15 Nov 2026 5:00 PM\nDepartment: Development",
    }));
    assert.equal(r.status, "created", r.reason);
    const task = await Task.findById(r.tasks[0]).lean();
    assert.equal(task.name, "Monthly KPI report");
    assert.equal(task.priority, "High");
    assert.equal(task.description, "Collect the numbers.");
    assert.equal(task.dueTime, "17:00");
    assert.equal(task.dueDate.toISOString().slice(0, 10), "2026-11-15");
    assert.equal(String(task.assignedTo), String(priya._id));
    assert.equal(String(task.assignedBy), String(manager._id));
    assert.equal(String(task.admin_id), String(admin._id));
    assert.ok(task.referenceId, "gets a task ID");
    assert.equal(task.statusHistory[0].note, "Created from email");
    assert.equal(lastReply().to, "manager@acme.test");
    assert.match(lastReply().subject, /^Task created/);
  });

  test("several people → one task each in a shared group; attachments stored, bad ones skipped", async () => {
    const r = await processInboundEmail(mail({
      subject: "Team task",
      cc: ["priya@acme.test", "john@acme.test"],
      attachments: [
        { filename: "brief.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 test"), size: 13 },
        { filename: "virus.exe", contentType: "application/octet-stream", content: Buffer.from("MZ"), size: 2 },
        { filename: "logo.png", contentType: "image/png", content: Buffer.from("png"), size: 3, related: true },
      ],
    }));
    assert.equal(r.status, "created", r.reason);
    const tasks = await Task.find({ _id: { $in: r.tasks } }).lean();
    assert.equal(tasks.length, 2);
    assert.ok(tasks[0].taskGroupId && String(tasks[0].taskGroupId) === String(tasks[1].taskGroupId));
    assert.equal(tasks[0].attachments.length, 1);
    assert.equal(tasks[0].attachments[0].name, "brief.pdf");
    assert.match(lastReply().text, /virus\.exe \(file type not allowed\)/);
  });

  test("nobody else addressed → the sender gets the task", async () => {
    const r = await processInboundEmail(mail({ from: "priya@acme.test", subject: "My own todo", authResults: AUTH_OK("acme.test") }));
    assert.equal(r.status, "created", r.reason);
    const task = await Task.findById(r.tasks[0]).lean();
    assert.equal(String(task.assignedTo), String(priya._id));
  });

  test("the same email twice creates the task once", async () => {
    const m = mail({ subject: "Only once", cc: ["priya@acme.test"] });
    assert.equal((await processInboundEmail(m)).status, "created");
    assert.equal((await processInboundEmail(m)).status, "duplicate");
    assert.equal(await Task.countDocuments({ name: "Only once" }), 1);
  });
});

describe("rejections and safety", () => {
  test("user without tasks.assign cannot give work to others — told by email", async () => {
    const r = await processInboundEmail(mail({ from: "priya@acme.test", subject: "For John", cc: ["john@acme.test"] }));
    assert.equal(r.status, "rejected");
    assert.match(r.reason, /permission to assign/);
    assert.match(lastReply().subject, /^Task not created/);
  });

  test("people from another organization, unknown departments and bad dates are rejected", async () => {
    let r = await processInboundEmail(mail({ cc: ["stranger@else.test"] }));
    assert.equal(r.status, "rejected");
    assert.match(r.reason, /not found in your organization/);

    r = await processInboundEmail(mail({ cc: ["priya@acme.test"], text: "Department: Nowhere" }));
    assert.match(r.reason, /Department "Nowhere" does not exist/);

    r = await processInboundEmail(mail({ cc: ["priya@acme.test"], text: "Due: someday" }));
    assert.match(r.reason, /not a date/);

    r = await processInboundEmail(mail({ cc: ["john@acme.test"], text: "Department: Development" }));
    assert.match(r.reason, /not in the "Development" department/);

    r = await processInboundEmail(mail({ subject: "Re: " }));
    assert.match(r.reason, /subject is empty/);
  });

  test("admin must name the assignees", async () => {
    const r = await processInboundEmail(mail({ from: "admin@acme.test", subject: "Admin task" }));
    assert.equal(r.status, "rejected");
    assert.match(r.reason, /To \/ CC/);
  });

  test("forged sender, strangers, automatic mail and inactive users are ignored without a reply", async () => {
    const before = sentMessages.length;
    const forged = await processInboundEmail(mail({ authResults: "mx.google.com; spf=fail smtp.mailfrom=x@evil.test; dmarc=fail header.from=acme.test", cc: ["priya@acme.test"] }));
    assert.equal(forged.status, "ignored");
    assert.equal((await processInboundEmail(mail({ from: "nobody@acme.test" }))).status, "ignored");
    assert.equal((await processInboundEmail(mail({ autoSubmitted: "auto-replied" }))).status, "ignored");
    assert.equal((await processInboundEmail(mail({ from: "boss+tasks@gmail.com", authResults: AUTH_OK("gmail.com") }))).status, "ignored");
    await User.updateOne({ _id: john._id }, { status: "Inactive" });
    assert.equal((await processInboundEmail(mail({ from: "john@acme.test" }))).status, "ignored");
    assert.equal(sentMessages.length, before, "no replies to ignored mail");
    assert.equal(await Task.countDocuments({ assignedBy: john._id }), 0);
    assert.ok(await InboundTaskEmail.exists({ status: "ignored" }), "ignored mail is logged");
  });
});
