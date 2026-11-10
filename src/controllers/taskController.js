import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Task, { TASK_STATUSES, TASK_PRIORITIES, CHECKLIST_TYPES } from "../models/Task.js";
import User from "../models/User.js";
import MonthlyProgress from "../models/MonthlyProgress.js";
import TaskBank from "../models/TaskBank.js";
import { departmentCodeOf, generateReferenceId, nextReworkId, peekReworkId, referenceIdTaken } from "../services/referenceIdService.js";
import { computeWorkload, parseDepartments } from "../services/taskFormService.js";
import { dueDateOf, parseDateRange, parseMonthlyConfig, parseMonthlyTarget, rangeOf, recalcMonthlyTotal, shapeMonthly } from "../services/monthlyTaskService.js";
import Department from "../models/Department.js";
import { MEMBER_ROLES } from "../config/permissions.js";
import { hasPermission } from "../middleware/permissionMiddleware.js";
import { readCSV, isValidISODate, parseFlexibleDate, parseFlexibleTime } from "../utils/csv.js";
import { emitToUser } from "../socket/realtime.js";
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_MB, pushUploadsToCloud, sendStoredFile, removeStoredFile } from "../services/fileStorage.js";
import { parseReviewScore, scoreProfile, celebrationFor, levelFor, LEVELS } from "../services/scoreService.js";
import {
  notifyTaskAssigned,
  notifyTaskReassigned,
  notifyStatusChanged,
  notifyReviewDecision,
  notifyTaskComment,
  notifySubtaskAssigned,
  deadlineOf,
  startOf,
  reminderTimeOf,
  parseReminders,
} from "../services/taskNotificationService.js";

// Fire-and-forget: emails must never delay or fail the API response
export const announce = (tasks, assignerId) =>
  tasks.forEach((t) => t?.assignedTo && notifyTaskAssigned(t._id || t, assignerId));

/* ==================== FILE UPLOAD SETUP ==================== */

// Absolute path → backend/uploads/tasks (independent of the process cwd)
export const UPLOAD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/tasks"
);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const taskAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `task-${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "webp", "pdf", "doc", "docx",
  "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip",
];
export const MAX_ATTACHMENT_SIZE = MAX_UPLOAD_SIZE; // 8 MB — files are stored on Cloudinary
export const TASK_FILES_FOLDER = "tasks"; // Cloudinary folder (task + Task Bank files share it)
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

const attachmentMulter = (field) =>
  multer({
    storage: taskAttachmentStorage,
    limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENTS_PER_REQUEST },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      if (ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
        cb(null, true);
      } else {
        const err = new Error(
          `"${file.originalname}" is not a supported file type. Allowed: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(", ")}`
        );
        err.status = 400;
        cb(err);
      }
    },
  }).array(field, MAX_ATTACHMENTS_PER_REQUEST);

// Turns multer errors into clean 400 JSON responses instead of the global 500.
// Accepted files are then moved to Cloudinary before the controller runs.
const toCloud = pushUploadsToCloud(TASK_FILES_FOLDER);
const withUploadErrors = (upload) => (req, res, next) => {
  upload(req, res, async (err) => {
    if (!err) {
      const empty = (req.files || []).find((f) => f.size === 0);
      if (empty) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: `"${empty.originalname}" is empty` });
      }
      return toCloud(req, res, next);
    }
    let message = err.message || "File upload failed";
    if (err.code === "LIMIT_FILE_SIZE") message = `Each file must be ${MAX_UPLOAD_MB} MB or smaller`;
    if (err.code === "LIMIT_FILE_COUNT") message = `You can upload at most ${MAX_ATTACHMENTS_PER_REQUEST} files at once`;
    if (err.code === "LIMIT_UNEXPECTED_FILE") message = "Unexpected file field";
    return res.status(400).json({ success: false, message });
  });
};

// POST /:id/attachments (field "attachments")
export const uploadTaskAttachments = withUploadErrors(attachmentMulter("attachments"));
// Create / edit task form (multipart field "files")
export const uploadTaskFiles = withUploadErrors(attachmentMulter("files"));

export const toAttachment = (f, userId) => ({
  name: f.originalname,
  size: f.size,
  filename: f.filename,
  mimetype: f.mimetype,
  url: `/api/tasks/attachments/${f.filename}`,
  uploadedBy: userId,
  uploadedAt: new Date(),
});

// disk (older files / temp) and Cloudinary
const unlinkQuietly = (filename) => removeStoredFile(UPLOAD_DIR, TASK_FILES_FOLDER, filename);

// Remove files from disk once NO task and NO Task Bank template references them
// (multi-assign clones and tasks assigned from a template share the same files)
export const removeUnreferencedFiles = async (filenames = []) => {
  for (const filename of filenames.filter(Boolean)) {
    const stillUsed =
      (await Task.exists({ "attachments.filename": filename })) ||
      (await Task.exists({ "subtasks.attachments.filename": filename })) ||
      (await TaskBank.exists({ "attachments.filename": filename }));
    if (!stillUsed) await unlinkQuietly(filename);
  }
};

// Uploaded files of a request that failed validation must not stay on disk
export const discardUploads = (req) => Promise.all((req.files || []).map((f) => unlinkQuietly(f.filename)));

/**
 * multipart/form-data sends every field as a string.
 * Parse JSON arrays/objects and booleans back so the JSON code path works unchanged.
 */
const normalizeBody = (req) => {
  if (!req.is("multipart/form-data")) return req.body;
  const body = { ...req.body };
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    const v = value.trim();
    if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
      try { body[key] = JSON.parse(v); } catch { /* keep raw string */ }
    } else if (v === "true" || v === "false") {
      body[key] = v === "true";
    }
  }
  return body;
};

/* ==================== HELPERS ==================== */

export class AssignError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Organization of a member account (admin_id; legacy accounts only have createdBy)
export const userOrgId = (user) => user?.admin_id || user?.createdBy || null;

const orgMemberQuery = (orgId) => ({
  role: { $in: MEMBER_ROLES },
  $or: [{ admin_id: orgId }, { createdBy: orgId, admin_id: null }],
});

/**
 * Resolve a SINGLE user by ObjectId | name | email (case-insensitive).
 * ⭐ Lookup is restricted to the requester's organization, so a person with the
 *    same name in ANOTHER organization can never be picked up by mistake.
 * Throws AssignError with a user-facing message.
 */
export const resolveAssignedUser = async (assignedUser, department, adminId, role) => {
  if (!assignedUser) return null;
  // `department` is one name or the list of the task's departments
  const deptNames = (Array.isArray(department) ? department : [department]).map((d) => String(d || "").trim()).filter(Boolean);
  const deptKeys = deptNames.map((d) => d.toLowerCase());

  const input = typeof assignedUser === "object" ? assignedUser._id || assignedUser.id || assignedUser.name : assignedUser;
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  const isSuper = role === "SuperAdmin";
  if (!isSuper && !adminId) {
    throw new AssignError("Your account is not linked to an organization", 403);
  }
  const scope = isSuper ? { role: { $in: MEMBER_ROLES } } : orgMemberQuery(adminId);

  let user = null;
  if (mongoose.Types.ObjectId.isValid(trimmed)) {
    user = await User.findOne({ _id: trimmed, ...scope }).lean();
    if (!user && (await User.exists({ _id: trimmed }))) {
      throw new AssignError("The selected user is not in your organization", 403);
    }
  }

  if (!user) {
    const byName = await User.find({
      ...scope,
      name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
    }).limit(5).lean();

    let candidates = byName;
    if (byName.length > 1 && deptKeys.length) {
      candidates = byName.filter((u) => deptKeys.includes(String(u.department || "").trim().toLowerCase()));
    }
    if (candidates.length > 1) {
      throw new AssignError(`More than one user is named "${trimmed}". Select the user from the list instead.`);
    }
    user = candidates[0] || null;
  }

  if (!user) {
    user = await User.findOne({ ...scope, email: trimmed.toLowerCase() }).lean();
  }

  if (!user) {
    throw new AssignError(`User "${trimmed}" was not found in your organization`);
  }

  if (user.status === "Inactive") {
    throw new AssignError(`${user.name} is inactive and cannot receive tasks`);
  }

  // ⭐ Department restriction — a department task can only go to people of its department(s)
  if (deptKeys.length && user.department && !deptKeys.includes(String(user.department).trim().toLowerCase())) {
    const label = deptNames.length === 1 ? `the "${deptNames[0]}" department` : `any of these departments: ${deptNames.join(", ")}`;
    throw new AssignError(`${user.name} is not in ${label}`);
  }

  return user;
};

/**
 * Resolve MULTIPLE users at once — de-dupes by _id.
 */
const resolveAssignedUsers = async (inputs, department, adminId, role) => {
  if (!inputs || inputs.length === 0) return [];
  const resolved = [];
  for (const item of inputs) {
    const u = await resolveAssignedUser(item, department, adminId, role);
    if (u && !resolved.some((r) => String(r._id) === String(u._id))) {
      resolved.push(u);
    }
  }
  return resolved;
};

/**
 * ⭐ KEY HELPER — normalise the `assignedUser` field.
 *
 * The frontend sends the SAME field name (`assignedUser`) for both:
 *   • string  → single user      (old behaviour)
 *   • array   → multi-user        (new behaviour)
 * `assignedUsers` (array) is honoured when it holds more than one entry.
 *
 * Returns one of:
 *   { mode: "none"    }                      — explicitly unassign
 *   { mode: "single", value: "ranjith" }    — single user
 *   { mode: "multi",  values: ["a","b"] }   — multi-user
 *   { mode: "skip"    }                      — field not provided
 */
const normalizeAssignedUserInput = (assignedUser, assignedUsers) => {
  if (Array.isArray(assignedUsers) && assignedUsers.filter(Boolean).length > 1) {
    assignedUser = assignedUsers;
  }

  if (assignedUser === undefined) return { mode: "skip" };

  // Explicit unassign
  if (assignedUser === null || assignedUser === "") return { mode: "none" };

  // Array → multi (single-element arrays collapse to "single" for safety)
  if (Array.isArray(assignedUser)) {
    const cleaned = assignedUser
      .map((v) => (typeof v === "string" ? v.trim() : v))
      .filter((v) => v !== "" && v !== null && v !== undefined);

    if (cleaned.length === 0) return { mode: "none" };
    if (cleaned.length === 1) return { mode: "single", value: cleaned[0] };
    return { mode: "multi", values: cleaned };
  }

  // Plain string/ObjectId
  return { mode: "single", value: assignedUser };
};

const isOrgAdmin = (req) => ["SuperAdmin", "Admin"].includes(req.user.role);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Start date/time + the chosen reminder, checked against the end (due date + time).
 * `current` = the task as it is now (edit) or {} (create). Returns { values } or { error }.
 */
const scheduleFrom = (body, current = {}) => {
  const values = {};
  if (body.startDate !== undefined) {
    const day = body.startDate ? String(body.startDate).slice(0, 10) : "";
    if (day && !isValidISODate(day)) return { error: "Start date must be a real date" };
    values.startDate = day || null;
  }
  if (body.startTime !== undefined) {
    if (body.startTime && !HHMM.test(body.startTime)) return { error: "Start time must use HH:mm" };
    values.startTime = body.startTime || "";
  }

  const merged = {
    startDate: values.startDate !== undefined ? values.startDate : current.startDate,
    startTime: values.startTime !== undefined ? values.startTime : current.startTime,
    dueDate: body.dueDate !== undefined ? body.dueDate || null : current.dueDate,
    dueTime: body.dueTime !== undefined ? body.dueTime : current.dueTime,
  };
  const start = startOf(merged);
  const end = deadlineOf(merged);
  if (start && end && start.getTime() > end.getTime()) {
    return { error: "The start date and time must be before the end" };
  }

  const input =
    body.reminder && typeof body.reminder === "object"
      ? body.reminder
      : body.reminderOption !== undefined
        ? { option: body.reminderOption, customAt: body.reminderCustomAt }
        : undefined;
  const before = current.reminder || {};
  const option = input ? input.option || "none" : before.option || "none";
  const customAt = input ? input.customAt || "" : before.customAt || "";
  const timesChanged = ["startDate", "startTime", "dueDate", "dueTime"].some((k) => body[k] !== undefined);
  if (input || (timesChanged && option !== "none")) {
    const r = reminderTimeOf(merged, option, customAt);
    if (r.error) return { error: r.error };
    const sameTime = Boolean(r.at && before.at && new Date(before.at).getTime() === r.at.getTime());
    values.reminder = {
      option,
      customAt: option === "custom" ? customAt : "",
      at: r.at,
      sentAt: sameTime ? before.sentAt || null : null, // a new reminder time is sent again
    };
  }
  // named reminders (title + date & time)
  if (body.reminders !== undefined) {
    const parsed = parseReminders(body.reminders || [], current.reminders || []);
    if (parsed.error) return { error: parsed.error };
    values.reminders = parsed.reminders;
  }
  return { values };
};

// Everyone who had the original task (all copies of a shared task)
const originalAssigneeIds = async (original) => {
  const copies = original.taskGroupId
    ? await Task.find({ taskGroupId: original.taskGroupId, admin_id: original.admin_id }).select("assignedTo").lean()
    : [original];
  return new Set(copies.map((t) => (t.assignedTo ? String(t.assignedTo._id || t.assignedTo) : "")).filter(Boolean));
};

/**
 * Rework Task ID for one person, from the original task's ID:
 *   same person as the original → TECH14-1, TECH14-2…
 *   a new person                → TECH14-<their department code><n> (e.g. TECH14-DEV1); no code → TECH14-N1
 */
const reworkIdFor = async ({ orgId, originalRef, originalAssignees, user, reserve }) => {
  const same = originalAssignees.has(String(user._id));
  const code = same ? null : (await departmentCodeOf(orgId, user.department)) || "N";
  const referenceId = reserve ? await nextReworkId(orgId, originalRef, code) : await peekReworkId(orgId, originalRef, code);
  return { referenceId, sameAssignee: same, departmentCode: code };
};
const isSelf = (req, user) => user && String(user._id || user) === String(req.user._id);

// Assigning work to anyone other than yourself requires tasks.assign
export const ensureCanAssign = (req, users, moduleId = "tasks") => {
  if (users.every((u) => isSelf(req, u))) return;
  if (!hasPermission(req, moduleId, "assign")) {
    throw new AssignError("You do not have permission to assign tasks to other users", 403);
  }
};

/**
 * Task-level authorization (on top of module permission + data scope):
 *   SuperAdmin / Admin → any task in their scope
 *   Manager            → any task in his scope (his department + his own)
 *   User               → only tasks he created; assignees may only change status
 */
const canModifyTask = (req, task) => {
  if (isOrgAdmin(req) || req.user.role === "Manager") return true;
  return Boolean(task.assignedBy) && String(task.assignedBy) === String(req.user._id);
};

export const MAX_CHECKLIST_ITEMS = 50;

/**
 * Checklist rows from the form: [{ _id?, desc, type, employee }] (employee = user id).
 * Employees must belong to the organization. Rows kept by _id keep their answers.
 */
const parseChecklist = async (input, orgId, existing = []) => {
  if (!Array.isArray(input)) throw new AssignError("Checklist must be a list");
  if (input.length > MAX_CHECKLIST_ITEMS) throw new AssignError(`Add at most ${MAX_CHECKLIST_ITEMS} checklist rows`);
  const ids = [...new Set(input.map((r) => String(r?.employee?.userId || r?.employee || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const people = ids.length
    ? await User.find({ _id: { $in: ids }, ...(orgId ? orgMemberQuery(orgId) : {}) }).select("name").lean()
    : [];
  const byId = new Map(people.map((u) => [String(u._id), u]));
  return input.map((r, i) => {
    const desc = String(r?.desc || "").trim();
    if (!desc) throw new AssignError(`Checklist row ${i + 1}: enter a description`);
    if (desc.length > 300) throw new AssignError(`Checklist row ${i + 1}: the description can be at most 300 characters`);
    const type = r?.type || "Check";
    if (!CHECKLIST_TYPES.includes(type)) throw new AssignError(`Checklist row ${i + 1}: type must be ${CHECKLIST_TYPES.join(", ")}`);
    const empId = String(r?.employee?.userId || r?.employee || "");
    let employee = { userId: null, name: "" };
    if (empId) {
      const u = byId.get(empId);
      if (!u) throw new AssignError(`Checklist row ${i + 1}: the employee is not in your organization`);
      employee = { userId: u._id, name: u.name };
    }
    const before = r?._id && existing.find((e) => String(e._id) === String(r._id));
    const keep = before && before.type === type;
    return {
      ...(before ? { _id: before._id } : {}),
      desc,
      type,
      employee,
      done: keep ? before.done : false,
      value: keep ? before.value : "",
      doneAt: keep ? before.doneAt : null,
      doneBy: keep ? before.doneBy : "",
    };
  });
};

const sendError = (res, error) => {
  const status = error.status || (error.name === "ValidationError" || error.name === "CastError" ? 400 : 500);
  return res.status(status).json({ success: false, message: error.message });
};

const getActor = async (req) => {
  if (req.user?.name) return { id: req.user.id, name: req.user.name };
  try {
    const user = await User.findById(req.user.id).select("name email");
    return { id: req.user.id, name: user?.name || user?.email || "Unknown" };
  } catch {
    return { id: req.user.id, name: "Unknown" };
  }
};

const shapeAttachment = (a) => ({
  name: a.name,
  size: a.size,
  filename: a.filename || "",
  mimetype: a.mimetype || "",
  url: a.filename ? `/api/tasks/attachments/${a.filename}` : a.url || "",
  uploadedAt: a.uploadedAt || null,
  downloadable: Boolean(a.filename),
});

const shapeSubtask = (subtask) => {
  const s = subtask.toObject ? subtask.toObject() : subtask;
  return {
    ...s,
    assignedTo: s.assignedTo?._id || s.assignedTo || null,
    assignedToName: s.assignedTo?.name || "",
    assignedToEmail: s.assignedTo?.email || "",
    dueDate: s.dueDate ? new Date(s.dueDate).toISOString().slice(0, 10) : "",
    attachments: (s.attachments || []).map(shapeAttachment),
  };
};

const shapeTask = (task) => {
  const t = task.toObject ? task.toObject() : task;
  return {
    id: t._id,
    name: t.name,
    referenceId: t.referenceId,
    department: t.department,
    departments: t.departments?.length ? t.departments : t.department ? [t.department] : [],
    departmentIds: t.departmentIds || [],
    reworkOf: t.reworkOf?.task || t.reworkOf?.referenceId ? t.reworkOf : null,
    assignedUser: t.assignedTo?.name || "",
    assignedTo: t.assignedTo?._id || t.assignedTo || null,
    assignedBy: t.assignedBy?._id || t.assignedBy || null,
    assignedByName: t.assignedBy?.name || "",
    taskGroupId: t.taskGroupId || null,
    sourceTemplate: t.sourceTemplate || null,
    description: t.description,
    startDate: t.startDate ? new Date(t.startDate).toISOString().slice(0, 10) : "",
    startTime: t.startTime || "",
    dueDate: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "",
    dueTime: t.dueTime || "",
    reminder: t.reminder?.option && t.reminder.option !== "none"
      ? { option: t.reminder.option, customAt: t.reminder.customAt || "", at: t.reminder.at, sentAt: t.reminder.sentAt }
      : null,
    reminders: (t.reminders || []).map((r) => ({ _id: r._id, title: r.title, customAt: r.customAt, at: r.at, sentAt: r.sentAt })),
    priority: t.priority,
    complexity: t.complexity,
    reward: t.reward,
    recurring: t.recurring,
    recurrenceInterval: t.recurrenceInterval,
    taskType: t.taskType || "standard",
    monthly: t.taskType === "monthly" ? shapeMonthly(t.monthly) : null,
    attachments: (t.attachments || []).map(shapeAttachment),
    subtasks: (t.subtasks || []).map(shapeSubtask),
    checklist: (t.checklist || []).map((c) => ({
      _id: c._id,
      desc: c.desc,
      type: c.type,
      employee: c.employee?.userId ? { userId: c.employee.userId, name: c.employee.name } : null,
      done: c.done,
      value: c.value || "",
      doneAt: c.doneAt,
      doneBy: c.doneBy || "",
    })),
    isTaskBank: t.isTaskBank || false,
    status: t.status,
    statusHistory: t.statusHistory,
    reworkCount: t.reworkCount || 0,
    reviewScore: t.reviewScore ?? null,
    reviewComments: (t.reviewComments || []).map((c) => ({
      _id: c._id,
      decision: c.decision,
      text: c.text || "",
      score: c.score ?? null,
      by: c.by,
      byName: c.byName || "",
      at: c.at,
    })),
    completedAt: t.completedAt,
    // the assignee opened / updated the task from the assignment email
    emailViewedAt: t.emailActivity?.lastViewedAt || t.emailActivity?.viewedAt || null,
    emailUpdatedAt: t.emailActivity?.lastUpdateAt || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
};

const populateTask = (query) =>
  query
    .populate("assignedTo", "name email department")
    .populate("assignedBy", "name email")
    .populate("subtasks.assignedTo", "name email");

/* ==================== GET /api/tasks  ==================== */
export const getTasks = async (req, res) => {
  try {
    const { status, priority, department, assignedTo, search } = req.query;

    const filter = { ...req.scope };
    filter.isTaskBank = { $ne: true };

    if (status && status !== "All Status") filter.status = status;
    if (priority && priority !== "All Priority") filter.priority = priority;
    if (assignedTo) filter.assignedTo = assignedTo;

    if (search) {
      const rx = { $regex: search, $options: "i" };
      const searchOr = [{ name: rx }, { description: rx }, { department: rx }, { referenceId: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    if (department && department !== "All Departments") {
      filter.$and = [...(filter.$and || []), { $or: [{ department }, { departments: department }] }];
    }

    const tasks = await Task.find(filter)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/:id ==================== */
export const getTaskById = async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, ...req.scope })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    res.json({ success: true, data: shapeTask(task) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ⭐ NEW — GET /api/tasks/group/:groupId */
export const getTasksByGroup = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.groupId)) {
      return res.status(400).json({ success: false, message: "Invalid groupId" });
    }
    const tasks = await Task.find({ taskGroupId: req.params.groupId, ...req.scope })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: 1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks  ====================
 * JSON or multipart/form-data (field "files" for attachments).
 * `assignedUser` accepts a string (single) or an array (multi).
 */
export const createTask = async (req, res) => {
  try {
    const body = normalizeBody(req);
    const {
      name, referenceId, description,
      dueDate, dueTime, priority, complexity, reward, recurring,
      recurrenceInterval, subtasks, status,
      assignedUser, assignedUsers, taskType = "standard", monthly,
    } = body;

    if (!["standard", "monthly", "rework"].includes(taskType)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Task type must be standard, monthly or rework" });
    }

    // ⭐ One or more departments (the first is the primary one)
    let deptInfo;
    try {
      deptInfo = (await parseDepartments(body, req.adminId)) || { department: "", departments: [], departmentIds: [] };
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }
    const department = deptInfo.department;

    // ⭐ Rework → the original task (required for a Rework task, optional otherwise)
    const reworkInput = body.reworkOf?.task || body.reworkOf?._id || body.reworkOf?.id || body.reworkOf || body.reworkOfTaskId;
    let reworkOf = null;
    let reworkOriginalAssignees = new Set();
    if (reworkInput) {
      const ref = String(reworkInput);
      const original = mongoose.Types.ObjectId.isValid(ref)
        ? await Task.findOne({ _id: ref, ...req.scope, isTaskBank: { $ne: true } }).lean()
        : await Task.findOne({ referenceId: ref, ...req.scope, isTaskBank: { $ne: true } }).lean();
      if (!original) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: "The rework reference task was not found" });
      }
      reworkOriginalAssignees = await originalAssigneeIds(original);
      reworkOf = {
        task: original._id,
        referenceId: original.referenceId || "",
        name: original.name,
        departments: original.departments?.length ? original.departments : original.department ? [original.department] : [],
      };
    } else if (taskType === "rework") {
      await discardUploads(req);
      return res.status(400).json({ success: false, code: "REWORK_REFERENCE_REQUIRED", message: "Select the original task this rework is for" });
    }
    let monthlyConfig = null;
    if (taskType === "monthly") {
      const parsed = parseMonthlyConfig(monthly);
      if (parsed.error) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: parsed.error });
      }
      monthlyConfig = parsed.config;
    }

    if (!name || !String(name).trim()) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    if (priority && !TASK_PRIORITIES.includes(priority)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: `Invalid priority. Allowed: ${TASK_PRIORITIES.join(", ")}` });
    }

    const actor = await getActor(req);
    const inputMode = normalizeAssignedUserInput(assignedUser, assignedUsers);

    // Resolve users based on input shape (org-scoped, department-checked)
    let users = [];
    try {
      if (inputMode.mode === "multi") {
        users = await resolveAssignedUsers(inputMode.values, deptInfo.departments, req.adminId, req.user.role);
      } else if (inputMode.mode === "single") {
        const u = await resolveAssignedUser(inputMode.value, deptInfo.departments, req.adminId, req.user.role);
        if (u) users = [u];
      }
      ensureCanAssign(req, users);
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }

    // Every task must go to at least one valid user
    if (users.length === 0) {
      await discardUploads(req);
      return res.status(400).json({
        success: false,
        code: "ASSIGNEE_REQUIRED",
        message: "Assign the task to at least one user",
      });
    }

    const initialStatus = TASK_STATUSES.includes(status) ? status : "To Do";

    // ⭐ checklist rows (Desc · Type · Employee)
    let checklist = [];
    if (body.checklist !== undefined) {
      try {
        checklist = await parseChecklist(body.checklist || [], req.user.role === "SuperAdmin" ? userOrgId(users[0]) : req.adminId);
      } catch (err) {
        await discardUploads(req);
        return sendError(res, err);
      }
    }

    // ⭐ start → end and the chosen reminder
    const finalDueDate = monthlyConfig ? dueDateOf(monthlyConfig) : dueDate || undefined;
    const schedule = scheduleFrom({ ...body, dueDate: finalDueDate, dueTime: dueTime || "" });
    if (schedule.error) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: schedule.error });
    }

    // ⭐ Reference ID comes from the department's code: FF1, FF2… (one ID for every copy of the task)
    const taskOrgId = req.user.role === "SuperAdmin" ? userOrgId(users[0]) : req.adminId;
    // every task gets a unique ID: primary department code (FF1…) or TSK-1… without one;
    // a Rework task's ID comes from the original's instead (TECH14-1 / TECH14-DEV1), per person
    const isReworkId = taskType === "rework" && Boolean(reworkOf?.referenceId);
    const autoReferenceId = isReworkId ? "" : await generateReferenceId(taskOrgId, department);
    const referenceIdFor = async (u) =>
      isReworkId
        ? (
            await reworkIdFor({
              orgId: req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId,
              originalRef: reworkOf.referenceId,
              originalAssignees: reworkOriginalAssignees,
              user: u,
              reserve: true,
            })
          ).referenceId
        : autoReferenceId;

    // ⭐ Attachments come ONLY from files actually uploaded with this request
    const attachments = (req.files || []).map((f) => toAttachment(f, req.user._id));

    const basePayload = {
      name: String(name).trim(),
      referenceId: autoReferenceId,
      department: department || "",
      departments: deptInfo.departments,
      departmentIds: deptInfo.departmentIds,
      reworkOf,
      assignedBy: req.user._id,
      assignedAt: new Date(),
      isTaskBank: false,
      description: description || "",
      // a Monthly Task is due on its end date and does not repeat
      dueDate: finalDueDate,
      ...schedule.values,
      checklist,
      dueTime: dueTime || "",
      priority: priority || "Medium",
      complexity: Number(complexity) || 0,
      reward: Number(reward) || 0,
      recurring: monthlyConfig ? false : Boolean(recurring),
      recurrenceInterval,
      taskType,
      monthly: monthlyConfig,
      attachments,
      subtasks: Array.isArray(subtasks)
        ? subtasks
            .map((s) => ({
              title: s.title || s,
              dueDate: s.dueDate || null,
              assignedBy: req.user._id,
              assignedByName: actor.name,
              assignedAt: new Date(),
            }))
            .filter((s) => s.title)
        : [],
      status: initialStatus,
    };

    // ⭐ SINGLE USER (or zero users) — old behaviour, no group
    if (users.length <= 1) {
      const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(users[0]) : req.adminId;

      const task = await Task.create({
        ...basePayload,
        referenceId: await referenceIdFor(users[0]),
        assignedTo: users[0]?._id || null,
        subtasks: basePayload.subtasks.map((subtask) => ({ ...subtask, assignedTo: users[0]?._id || null })),
        admin_id: taskAdminId,
        taskGroupId: null,
        statusHistory: [
          { from: null, to: initialStatus, changedBy: req.user._id, changedByName: actor.name },
        ],
      });

      announce([task], req.user._id);
      const populated = await populateTask(Task.findById(task._id));

      return res.status(201).json({
        success: true,
        message: users[0] ? "Task created & assigned" : "Task created",
        data: shapeTask(populated),
      });
    }

    // ⭐ MULTI USER — clone one task per user, share taskGroupId (clones share the uploaded files)
    const groupId = new mongoose.Types.ObjectId();

    const created = await Promise.all(
      users.map(async (u) => {
        const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId;
        return Task.create({
          ...basePayload,
          referenceId: await referenceIdFor(u),
          assignedTo: u._id,
          subtasks: basePayload.subtasks.map((subtask) => ({ ...subtask, assignedTo: u._id })),
          admin_id: taskAdminId,
          taskGroupId: groupId,
          statusHistory: [
            { from: null, to: initialStatus, changedBy: req.user._id, changedByName: actor.name },
          ],
        });
      })
    );

    announce(created, req.user._id);
    const populated = await populateTask(Task.find({ _id: { $in: created.map((t) => t._id) } }));

    return res.status(201).json({
      success: true,
      message: `Task assigned to ${users.length} users`,
      taskGroupId: groupId,
      data: populated.map(shapeTask),
    });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/bank  ==================== */
export const saveToTaskBank = async (req, res) => {
  try {
    const {
      name, referenceId, department, description,
      dueDate, priority, complexity, reward, recurring,
      recurrenceInterval, attachments, subtasks,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Only Admin can save tasks to the Task Bank",
      });
    }

    let taskAdminId = req.adminId;
    if (req.user.role === "SuperAdmin" && req.body.adminId) {
      taskAdminId = req.body.adminId;
    }

    const bankTask = await Task.create({
      name: name.trim(),
      referenceId: referenceId || "",
      department: department || "",
      description: description || "",
      assignedTo: null,
      assignedBy: req.user.id,
      assignedAt: new Date(),
      admin_id: taskAdminId,
      isTaskBank: true,
      dueDate: dueDate || undefined,
      priority: priority || "Medium",
      complexity: Number(complexity) || 0,
      reward: Number(reward) || 0,
      recurring: Boolean(recurring),
      recurrenceInterval,
      attachments: Array.isArray(attachments) ? attachments : [],
      subtasks: Array.isArray(subtasks)
        ? subtasks.map((s) => ({ title: s.title || s }))
        : [],
      status: "To Do",
      statusHistory: [],
      completedAt: null,
    });

    const populated = await Task.findById(bankTask._id)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    res.status(201).json({
      success: true,
      message: "Task saved to Task Bank",
      data: shapeTask(populated),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/bank  ==================== */
export const getTaskBank = async (req, res) => {
  try {
    const { priority, department, search } = req.query;

    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Only Admin can view the Task Bank",
      });
    }

    const filter = { ...req.scope, isTaskBank: true };

    if (priority && priority !== "All Priority") filter.priority = priority;
    if (department && department !== "All Departments") filter.department = department;

    if (search) {
      const rx = { $regex: search, $options: "i" };
      const searchOr = [{ name: rx }, { description: rx }, { department: rx }, { referenceId: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const tasks = await Task.find(filter)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/bank/:id/assign  ====================
 * ⭐ `assignedUser` accepts BOTH shapes (string | array) here too.
 */
export const assignFromBank = async (req, res) => {
  try {
    const {
      department, dueDate, priority, complexity, reward,
      assignedUser, // ⭐ same field — string OR array
    } = req.body;

    const task = await Task.findOne({
      _id: req.params.id,
      ...req.scope,
      isTaskBank: true,
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "Task Bank item not found" });
    }

    if (req.user.role === "User") {
      return res.status(403).json({ success: false, message: "Only Admin can assign from Task Bank" });
    }

    const inputMode = normalizeAssignedUserInput(assignedUser);
    if (inputMode.mode === "skip" || inputMode.mode === "none") {
      return res.status(400).json({ success: false, message: "assignedUser is required" });
    }

    let users = [];
    if (inputMode.mode === "multi") {
      users = await resolveAssignedUsers(
        inputMode.values,
        department || task.department,
        req.adminId,
        req.user.role
      );
    } else {
      const u = await resolveAssignedUser(
        inputMode.value,
        department || task.department,
        req.adminId,
        req.user.role
      );
      if (u) users = [u];
    }

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot assign — none of the selected users belong to your organization",
      });
    }

    const actor = await getActor(req);

    const updateFields = {};
    if (department !== undefined) updateFields.department = department;
    if (dueDate !== undefined) updateFields.dueDate = dueDate || undefined;
    if (priority !== undefined) updateFields.priority = priority;
    if (complexity !== undefined) updateFields.complexity = Number(complexity) || 0;
    if (reward !== undefined) updateFields.reward = Number(reward) || 0;

    // ⭐ SINGLE — convert the bank task in place (old behaviour)
    if (users.length === 1) {
      const u = users[0];
      task.isTaskBank = false;
      task.assignedTo = u._id;
      task.assignedBy = req.user.id;
      task.assignedAt = new Date();
      Object.assign(task, updateFields);
      if (req.user.role === "SuperAdmin" && u.admin_id) task.admin_id = u.admin_id;
      task.taskGroupId = null;
      task.status = "To Do";
      task.statusHistory = [
        { from: null, to: "To Do", changedBy: req.user.id, changedByName: actor.name },
      ];
      task.completedAt = null;
      await task.save();

      const populated = await Task.findById(task._id)
        .populate("assignedTo", "name email department")
        .populate("assignedBy", "name email");

      return res.json({
        success: true,
        message: "Task assigned from Task Bank",
        data: shapeTask(populated),
      });
    }

    // ⭐ MULTI — clone the bank task N times (original stays in bank)
    const groupId = new mongoose.Types.ObjectId();
    const created = await Promise.all(
      users.map(async (u) => {
        let taskAdminId = req.adminId;
        if (req.user.role === "SuperAdmin" && u.admin_id) taskAdminId = u.admin_id;
        return Task.create({
          name: task.name,
          referenceId: task.referenceId,
          department: updateFields.department ?? task.department,
          description: task.description,
          assignedTo: u._id,
          assignedBy: req.user.id,
          assignedAt: new Date(),
          admin_id: taskAdminId,
          isTaskBank: false,
          taskGroupId: groupId,
          dueDate: updateFields.dueDate ?? task.dueDate,
          priority: updateFields.priority ?? task.priority,
          complexity: updateFields.complexity ?? task.complexity,
          reward: updateFields.reward ?? task.reward,
          recurring: task.recurring,
          recurrenceInterval: task.recurrenceInterval,
          attachments: task.attachments,
          subtasks: task.subtasks,
          status: "To Do",
          statusHistory: [
            { from: null, to: "To Do", changedBy: req.user.id, changedByName: actor.name },
          ],
          completedAt: null,
        });
      })
    );

    const populated = await Task.find({ _id: { $in: created.map((t) => t._id) } })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    return res.json({
      success: true,
      message: `Task assigned from Task Bank to ${users.length} users`,
      taskGroupId: groupId,
      data: populated.map(shapeTask),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== DELETE /api/tasks/bank/:id  ==================== */
export const deleteFromBank = async (req, res) => {
  try {
    if (req.user.role === "User") {
      return res.status(403).json({ success: false, message: "Only Admin can delete Task Bank items" });
    }

    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      ...req.scope,
      isTaskBank: true,
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "Task Bank item not found" });
    }

    res.json({ success: true, message: "Task Bank item deleted" });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/:id  (edit / reassign) ====================
 * JSON or multipart/form-data (field "files" = new attachments,
 * `attachments` = list of EXISTING attachments to keep).
 * `assignedUser` accepts a string (single, "" = unassign) or an array (multi).
 */
export const updateTask = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Invalid task ID" });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope, isTaskBank: { $ne: true } });
    if (!task) {
      await discardUploads(req);
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // ⭐ Task-level authorization (module permission is checked by the route)
    if (!canModifyTask(req, task)) {
      await discardUploads(req);
      return res.status(403).json({
        success: false,
        message: "Only the task creator, a Manager or an Admin can edit this task. You can still update its status.",
      });
    }

    // Who had the task before this edit (for "task reassigned" emails)
    const previousAssignee = task.assignedTo ? String(task.assignedTo) : null;

    // previous → new: reassignment notice; nobody → someone: normal assignment email
    const announceChange = () => {
      const now = task.assignedTo ? String(task.assignedTo) : null;
      if (now === previousAssignee) return;
      if (previousAssignee) notifyTaskReassigned(task._id, previousAssignee, req.user._id);
      else announce([task], req.user._id);
    };

    const body = normalizeBody(req);

    if (body.priority !== undefined && !TASK_PRIORITIES.includes(body.priority)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: `Invalid priority. Allowed: ${TASK_PRIORITIES.join(", ")}` });
    }
    if (body.name !== undefined && !String(body.name).trim()) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Task name cannot be empty" });
    }

    // ⭐ Detect input mode from `assignedUser` (preferred) OR `assignedTo` (legacy alias)
    let assignedUserField = body.assignedUser;
    if (assignedUserField === undefined && body.assignedTo !== undefined) {
      assignedUserField = body.assignedTo;
    }
    const inputMode = normalizeAssignedUserInput(assignedUserField, body.assignedUsers);
    // ⭐ departments: a new selection replaces the old one (the first is the primary)
    let deptInfo;
    try {
      deptInfo = await parseDepartments(body, task.admin_id || req.adminId);
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }
    const department = deptInfo
      ? deptInfo.departments
      : task.departments?.length ? task.departments : task.department;

    let users = [];
    try {
      if (inputMode.mode === "multi") {
        users = await resolveAssignedUsers(inputMode.values, department, req.adminId, req.user.role);
      } else if (inputMode.mode === "single") {
        users = [await resolveAssignedUser(inputMode.value, department, req.adminId, req.user.role)];
      }
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }

    // Sending the CURRENT assignee back (normal edit form submit) is not a reassignment
    const unchangedSingle =
      inputMode.mode === "single" && task.assignedTo && String(users[0]._id) === String(task.assignedTo);
    const reassigning =
      (inputMode.mode === "single" && !unchangedSingle) ||
      inputMode.mode === "multi" ||
      (inputMode.mode === "none" && task.assignedTo);

    if (reassigning) {
      try {
        if (inputMode.mode === "none") {
          if (!hasPermission(req, "tasks", "assign")) {
            throw new AssignError("You do not have permission to reassign tasks", 403);
          }
        } else {
          ensureCanAssign(req, users);
        }
      } catch (err) {
        await discardUploads(req);
        return sendError(res, err);
      }
    }

    // Monthly Task: the creator can change the target and the start / end dates
    // (the tracking method and the saved daily entries stay as they are)
    const isMonthly = task.taskType === "monthly" && task.monthly;
    let rangeChanged = false;
    if (isMonthly) {
      if (inputMode.mode === "none") {
        await discardUploads(req);
        return res.status(400).json({ success: false, code: "ASSIGNEE_REQUIRED", message: "A Monthly Task must stay assigned to at least one user" });
      }
      const newTarget = body.monthly?.target ?? body.monthlyTarget;
      if (newTarget !== undefined) {
        const parsed = parseMonthlyTarget(newTarget);
        if (parsed.error) {
          await discardUploads(req);
          return res.status(400).json({ success: false, message: parsed.error });
        }
        task.monthly.target = parsed.target;
      }
      const newStart = body.monthly?.startDate;
      const newEnd = body.monthly?.endDate;
      if (newStart !== undefined || newEnd !== undefined) {
        const current = rangeOf(task.monthly);
        const range = parseDateRange(newStart ?? current.startDate, newEnd ?? current.endDate);
        if (range.error) {
          await discardUploads(req);
          return res.status(400).json({ success: false, message: range.error });
        }
        rangeChanged = range.startDate !== current.startDate || range.endDate !== current.endDate;
        Object.assign(task.monthly, range);
        task.dueDate = dueDateOf(task.monthly);
      }
      delete body.dueDate;
      delete body.recurring;
    }

    const oldDeadline = `${task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ""}|${task.dueTime || ""}`;

    const fields = [
      "name", "description", "dueDate", "dueTime",
      "priority", "complexity", "reward", "recurring",
      "recurrenceInterval", "subtasks",
    ];
    fields.forEach((f) => {
      if (body[f] !== undefined) task[f] = body[f];
    });
    if (body.name !== undefined) task.name = String(body.name).trim();
    // the Task ID is generated once and never edited
    if (deptInfo) {
      task.department = deptInfo.department;
      task.departments = deptInfo.departments;
      task.departmentIds = deptInfo.departmentIds;
    }
    if (body.dueDate === "") task.dueDate = undefined;

    // ⭐ start → end and the chosen reminder (checked with the new due date / time)
    const schedule = scheduleFrom({ ...body, dueDate: body.dueDate !== undefined ? task.dueDate : undefined }, task.toObject());
    if (schedule.error) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: schedule.error });
    }
    for (const [key, value] of Object.entries(schedule.values)) task.set(key, value);

    // ⭐ checklist rows — answers stay on rows that are kept
    if (body.checklist !== undefined) {
      try {
        task.checklist = await parseChecklist(body.checklist || [], task.admin_id || req.adminId, task.checklist);
      } catch (err) {
        await discardUploads(req);
        return sendError(res, err);
      }
    }
    const newDeadline = `${task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ""}|${task.dueTime || ""}`;
    if (newDeadline !== oldDeadline) {
      // New deadline → reminders start over
      task.set("notifications.reminder3hAt", null);
      task.set("notifications.reminder1hAt", null);
      task.set("notifications.overdueAlertAt", null);
    }
    const removedFiles = [];
    if (Array.isArray(body.subtasks)) {
      // keep who assigned each existing subtask; new ones are assigned by the editor
      const editor = await getActor(req);
      const existing = new Map(task.subtasks.map((s) => [String(s._id), s]));
      const byTitle = new Map(task.subtasks.map((s) => [s.title, s]));
      const nextSubtasks = body.subtasks
        .map((s) => {
          const title = String(s.title || s || "").trim();
          const old = (s._id && existing.get(String(s._id))) || byTitle.get(title);
          return {
            ...(old ? { _id: old._id } : {}),
            title,
            completed: Boolean(s.completed ?? old?.completed),
            assignedTo: old?.assignedTo || task.assignedTo,
            dueDate: s.dueDate !== undefined ? s.dueDate || null : old?.dueDate || null,
            attachments: old?.attachments || [],
            completedAt: old?.completedAt || null,
            assignedBy: old ? old.assignedBy : req.user._id,
            assignedByName: old ? old.assignedByName : editor.name,
            assignedAt: old ? old.assignedAt : new Date(),
          };
        })
        .filter((s) => s.title);
      const keptSubtaskFiles = new Set(nextSubtasks.flatMap((s) => (s.attachments || []).map((a) => a.filename)));
      task.subtasks.forEach((s) => s.attachments.forEach((a) => {
        if (a.filename && !keptSubtaskFiles.has(a.filename)) removedFiles.push(a.filename);
      }));
      task.subtasks = nextSubtasks;
    }

    // ⭐ ATTACHMENTS — keep only the existing ones the client still lists, then add uploads
    if (Array.isArray(body.attachments)) {
      const keep = new Set(
        body.attachments.flatMap((a) =>
          typeof a === "string" ? [a] : [a?.filename, a?.url, a?.name].filter(Boolean)
        )
      );
      task.attachments = task.attachments.filter((a) => {
        const kept = keep.has(a.filename) || keep.has(a.url) || (!a.filename && keep.has(a.name));
        if (!kept && a.filename) removedFiles.push(a.filename);
        return kept;
      });
    }
    task.attachments.push(...(req.files || []).map((f) => toAttachment(f, req.user._id)));

    // ⭐ MULTI — clone task for the extra users
    if (inputMode.mode === "multi") {
      const actor = await getActor(req);
      const groupId = task.taskGroupId || new mongoose.Types.ObjectId();

      // Repoint THIS task to the first user
      const firstChanged = String(task.assignedTo) !== String(users[0]._id);
      if (firstChanged) {
        task.notifications = { assignedAt: null, reminder3hAt: null, reminder1hAt: null, overdueAlertAt: null };
      }
      task.assignedTo = users[0]._id;
      task.assignedBy = req.user._id;
      task.assignedAt = new Date();
      task.taskGroupId = groupId;
      if (req.user.role === "SuperAdmin") task.admin_id = userOrgId(users[0]);
      await task.save();
      await removeUnreferencedFiles(removedFiles);
      if (firstChanged) announceChange();
      // totals always belong to the current assignee's own entries
      if (isMonthly && (firstChanged || rangeChanged)) await recalcMonthlyTotal(task._id, task.assignedTo);

      // Clone for remaining users
      const cloned = await Promise.all(
        users.slice(1).map(async (u) => {
          const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId;
          return Task.create({
            name: task.name,
            referenceId: task.referenceId,
            department: task.department,
            departments: task.departments,
            departmentIds: task.departmentIds,
            reworkOf: task.reworkOf,
            description: task.description,
            assignedTo: u._id,
            assignedBy: req.user._id,
            assignedAt: new Date(),
            admin_id: taskAdminId,
            isTaskBank: false,
            taskGroupId: groupId,
            dueDate: task.dueDate,
            dueTime: task.dueTime,
            startDate: task.startDate,
            startTime: task.startTime,
            reminder: task.reminder ? { ...task.reminder.toObject?.() ?? task.reminder, sentAt: null } : undefined,
            reminders: (task.reminders || []).map((r) => ({ title: r.title, customAt: r.customAt, at: r.at, sentAt: null })),
            priority: task.priority,
            complexity: task.complexity,
            reward: task.reward,
            recurring: task.recurring,
            recurrenceInterval: task.recurrenceInterval,
            taskType: task.taskType || "standard",
            // each person tracks their own month from zero
            monthly: isMonthly ? { ...task.monthly.toObject(), totalCompleted: 0 } : null,
            attachments: task.attachments,
            subtasks: task.subtasks.map((st) => ({
              title: st.title,
              assignedTo: st.assignedTo || u._id,
              dueDate: st.dueDate || null,
              attachments: st.attachments || [],
            })),
            checklist: (task.checklist || []).map((c) => ({ desc: c.desc, type: c.type, employee: c.employee })),
            status: "To Do",
            statusHistory: [
              { from: null, to: "To Do", changedBy: req.user._id, changedByName: actor.name },
            ],
            completedAt: null,
          });
        })
      );

      announce(cloned, req.user._id);
      const populated = await populateTask(
        Task.find({ _id: { $in: [task._id, ...cloned.map((t) => t._id)] } })
      );

      return res.json({
        success: true,
        message: `Task reassigned to ${users.length} users`,
        taskGroupId: groupId,
        data: populated.map(shapeTask),
      });
    }

    // ⭐ SINGLE or NONE
    if (reassigning) {
      task.assignedBy = req.user._id;
      task.assignedAt = new Date();
      task.taskGroupId = null; // single-user assignment detaches from any previous group
      if (inputMode.mode === "none") {
        task.assignedTo = null;
      } else {
        task.assignedTo = users[0]._id;
        if (req.user.role === "SuperAdmin") task.admin_id = userOrgId(users[0]);
      }
      // New assignee → new assignment email + fresh reminders
      task.notifications = { assignedAt: null, reminder3hAt: null, reminder1hAt: null, overdueAlertAt: null };
    }

    await task.save();
    await removeUnreferencedFiles(removedFiles);
    if (reassigning) announceChange();
    if (isMonthly && (reassigning || rangeChanged) && task.assignedTo) await recalcMonthlyTotal(task._id, task.assignedTo);

    const populated = await populateTask(Task.findById(task._id));

    res.json({ success: true, message: "Task updated", data: shapeTask(populated) });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/:id/status  ==================== */
// Review flow:
//   • the assignee moves the task To Do → In Progress → Review
//   • only the person who ASSIGNED the task can mark it Completed (from Review),
//     giving a score 1–10 that is added to the assignee's points (they are told their new score)
//   • or the assigner sends it back from Review for rework (In Progress / To Do, with a reason)
//   • only the assigner can reopen a Completed task (the reward is taken back)
// Tasks without an assigner (old / imported) fall back to Admin / Manager.
export const isTaskAssigner = (req, task) => {
  if (task.assignedBy) return String(task.assignedBy) === String(req.user._id);
  return isOrgAdmin(req) || req.user.role === "Manager";
};

export const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const note = String(req.body.note || req.body.comment || "").trim().slice(0, 2000);

    if (!status || !TASK_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${TASK_STATUSES.join(", ")}`,
      });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const isManager = canModifyTask(req, task);
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user.id);

    if (!isManager && !isAssignee) {
      return res.status(403).json({
        success: false,
        message: "Only the assignee, the task creator, a Manager or an Admin can update this status",
      });
    }

    const from = task.status;
    if (from === status) {
      return res.json({ success: true, message: "Status unchanged", data: shapeTask(task) });
    }

    const isAssigner = isTaskAssigner(req, task);
    const selfAssigned = task.assignedBy && task.assignedTo && String(task.assignedBy) === String(task.assignedTo);

    if (status === "Completed") {
      if (!isAssigner) {
        return res.status(403).json({
          success: false,
          code: "ASSIGNER_ONLY",
          message: "Only the person who assigned this task can mark it Completed. Move it to Review and they will check it.",
        });
      }
      if (from !== "Review" && !selfAssigned) {
        return res.status(409).json({
          success: false,
          code: "REVIEW_FIRST",
          message: "The task must be in Review before it can be marked Completed.",
        });
      }
      if (!selfAssigned && parseReviewScore(req.body.score) === null) {
        return res.status(400).json({
          success: false,
          code: "SCORE_REQUIRED",
          message: "Give the task a score from 1 to 10 to approve it.",
        });
      }
    }

    if (from === "Completed" && !isAssigner) {
      return res.status(403).json({
        success: false,
        code: "ASSIGNER_ONLY",
        message: "Only the person who assigned this task can reopen it.",
      });
    }

    // The assigner sending the work back from Review = rework
    const isRework = from === "Review" && ["To Do", "In Progress"].includes(status) && isAssigner && !selfAssigned;

    const actor = await getActor(req);

    task.status = status;
    task.statusHistory.push({
      from,
      to: status,
      changedBy: req.user.id,
      changedByName: actor.name,
      note: isRework ? `Rework requested${note ? `: ${note}` : ""}` : note,
    });

    let score = null;
    let celebration = null;
    // Points = the score (1–10) the assigner gives; your own tasks earn no points
    const reward = status === "Completed" && !selfAssigned ? parseReviewScore(req.body.score) : 0;

    if (status === "Completed") {
      task.completedAt = new Date();
      task.reviewScore = reward || null;
      task.pointsAwarded = reward;
    } else {
      task.completedAt = null;
      task.reviewScore = null;
    }
    if (isRework) task.reworkCount = (task.reworkCount || 0) + 1;

    // The assignee's note when sending the work for Review — the assigner reads it before reviewing
    if (status === "Review" && note) {
      task.reviewComments.push({ decision: "submitted", text: note, by: req.user.id, byName: actor.name });
    }

    // Save the reviewer's comment so the assignee can read it on the task
    if (isRework || (status === "Completed" && !selfAssigned)) {
      task.reviewComments.push({
        decision: isRework ? "rework" : "completed",
        text: note,
        score: isRework ? null : reward || null,
        by: req.user.id,
        byName: actor.name,
      });
    }

    const before = status === "Completed" && task.assignedTo ? await scoreProfile(task.assignedTo) : null;
    await task.save();

    if (status === "Completed" && task.assignedTo && reward) {
      const user = await User.findByIdAndUpdate(task.assignedTo, { $inc: { points: reward } }, { new: true }).select("points");
      score = user?.points ?? null;
      celebration = celebrationFor(before, await scoreProfile(task.assignedTo), reward);
    } else if (from === "Completed" && task.assignedTo) {
      // Reopened → the points given for completing it are taken back
      const given = task.pointsAwarded || 0;
      const user = await User.findByIdAndUpdate(task.assignedTo, { $inc: { points: -given } }, { new: true }).select("points");
      if (user && user.points < 0) await User.updateOne({ _id: user._id }, { points: 0 });
      task.pointsAwarded = 0;
      await task.save();
    }

    // Pop the "you win" screen on the assignee's open tabs (also when they completed their own task)
    if (celebration) {
      emitToUser(task.assignedTo, "task:celebrate", {
        ...celebration,
        taskId: String(task._id),
        taskName: task.name,
        approvedBy: selfAssigned ? "" : actor.name,
      });
    }

    const who = { _id: req.user._id, name: actor.name };
    // Tell the person who assigned the task who changed it (email + dashboard)
    notifyStatusChanged(task, who, from, status, status === "Review" ? note : "");
    // Tell the assignee the result of the review
    if (status === "Completed" && !selfAssigned) {
      notifyReviewDecision(task, who, { decision: "completed", reward, score, note, celebration });
    } else if (isRework) {
      notifyReviewDecision(task, who, { decision: "rework", note });
    }

    const populated = await Task.findById(task._id)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    res.json({
      success: true,
      message:
        status === "Completed"
          ? reward
            ? `Task completed with ${reward}/10. ${populated.assignedTo?.name || "The assignee"} earned ${reward} points${score !== null ? ` (total score: ${score})` : ""}.`
            : "Task completed."
          : isRework
          ? `Sent back for rework. ${populated.assignedTo?.name || "The assignee"} has been notified.`
          : `Status updated: "${from}" → "${status}"`,
      score,
      celebration,
      // the "you win" screen is shown to the person who did the task
      celebrateFor: celebration ? String(task.assignedTo) : null,
      rework: isRework,
      data: shapeTask(populated),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/:id/comments ==================== */
// Comment thread on a task — the assignee, the assigner (and Managers / Admins) can write;
// everyone who can see the task can read it. The other person is notified.
export const addTaskComment = async (req, res) => {
  try {
    const text = String(req.body.text || req.body.comment || "").trim().slice(0, 2000);
    if (!text) return res.status(400).json({ success: false, message: "Write a comment first." });

    const task = await Task.findOne({ _id: req.params.id, ...req.scope });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user.id);
    if (!isAssignee && !canModifyTask(req, task)) {
      return res.status(403).json({ success: false, message: "Only the assigned person or the person who assigned this task can comment" });
    }

    const actor = await getActor(req);
    task.reviewComments.push({ decision: "comment", text, by: req.user.id, byName: actor.name });
    await task.save();

    notifyTaskComment(task, { _id: req.user._id || req.user.id, name: actor.name }, text);

    const populated = await populateTask(Task.findById(task._id));
    res.status(201).json({ success: true, message: "Comment added", data: shapeTask(populated) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== SUBTASKS (assign / tick / move / remove) ==================== */
//   POST   /api/tasks/:id/subtasks          { title }            → assigner / manager gives a subtask to this person
//   PATCH  /api/tasks/:id/subtasks/:subId   { completed }        → the assignee (or a manager) ticks it
//   PATCH  /api/tasks/:id/subtasks/:subId   { moveTo: taskId }   → manager moves it to another person of the same shared task
//   DELETE /api/tasks/:id/subtasks/:subId                        → manager removes it
const findScopedTask = async (req, res, id = req.params.id) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ success: false, message: "Invalid task ID" });
    return null;
  }
  const task = await Task.findOne({ _id: id, ...req.scope });
  if (!task) res.status(404).json({ success: false, message: "Task not found" });
  return task;
};

const subtaskResponse = async (res, taskIds, message, status = 200) => {
  const tasks = await Task.find({ _id: { $in: taskIds } })
    .populate("assignedTo", "name email department")
    .populate("assignedBy", "name email")
    .populate("subtasks.assignedTo", "name email");
  res.status(status).json({ success: true, message, data: tasks.map(shapeTask) });
};

export const addSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) {
      await discardUploads(req);
      return;
    }
    if (!canModifyTask(req, task)) {
      await discardUploads(req);
      return res.status(403).json({ success: false, message: "Only the person who assigned this task, a Manager or an Admin can assign subtasks" });
    }
    const title = String(req.body.title || "").trim().slice(0, 300);
    if (!title) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Subtask title is required" });
    }
    const dueDate = String(req.body.dueDate || "").trim();
    if (dueDate && !isValidISODate(dueDate)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Subtask deadline must be a valid date" });
    }
    let assignee;
    try {
      assignee = await resolveAssignedUser(
        req.body.assignedTo || task.assignedTo,
        null,
        req.adminId,
        req.user.role
      );
      if (!assignee) throw new AssignError("Select a user for this subtask");
    } catch (error) {
      await discardUploads(req);
      return sendError(res, error);
    }

    const actor = await getActor(req);
    task.subtasks.push({
      title,
      assignedTo: assignee._id,
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null,
      attachments: (req.files || []).map((file) => toAttachment(file, req.user._id)),
      assignedBy: req.user._id,
      assignedByName: actor.name,
      assignedAt: new Date(),
    });
    await task.save();
    notifySubtaskAssigned(task, { _id: req.user._id, name: actor.name }, title, assignee._id);
    await subtaskResponse(res, [task._id], `Subtask assigned to ${assignee.name}`, 201);
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

export const updateSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) {
      await discardUploads(req);
      return;
    }
    const sub = task.subtasks.id(req.params.subId);
    if (!sub) {
      await discardUploads(req);
      return res.status(404).json({ success: false, message: "Subtask not found" });
    }

    const isManager = canModifyTask(req, task);
    const isAssignee =
      (task.assignedTo && String(task.assignedTo) === String(req.user._id)) ||
      (sub.assignedTo && String(sub.assignedTo) === String(req.user._id));
    if ((req.files?.length || req.body.attachments !== undefined) && !isManager && !isAssignee) {
      await discardUploads(req);
      return res.status(403).json({ success: false, message: "Only the assignee or a task manager can add files to this subtask" });
    }

    // Move to another person of the same shared task
    if (req.body.moveTo !== undefined) {
      if (!isManager) {
        await discardUploads(req);
        return res.status(403).json({ success: false, message: "Only the person who assigned this task, a Manager or an Admin can move subtasks" });
      }
      const target = await findScopedTask(req, res, req.body.moveTo);
      if (!target) {
        await discardUploads(req);
        return;
      }
      if (!task.taskGroupId || String(target.taskGroupId) !== String(task.taskGroupId) || String(target._id) === String(task._id)) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: "A subtask can only move to another person of the same shared task" });
      }
      const actor = await getActor(req);
      target.subtasks.push({
        title: sub.title,
        completed: false,
        assignedTo: target.assignedTo,
        dueDate: sub.dueDate,
        attachments: sub.attachments,
        assignedBy: req.user._id,
        assignedByName: actor.name,
        assignedAt: new Date(),
      });
      sub.deleteOne();
      await Promise.all([task.save(), target.save()]);
      notifySubtaskAssigned(target, { _id: req.user._id, name: actor.name }, target.subtasks[target.subtasks.length - 1].title);
      const to = await User.findById(target.assignedTo).select("name");
      return subtaskResponse(res, [task._id, target._id], `Subtask moved to ${to?.name || "the other person"}`);
    }

    if (req.body.dueDate !== undefined) {
      if (!isManager) {
        await discardUploads(req);
        return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can change subtask deadlines" });
      }
      const dueDate = String(req.body.dueDate || "").trim();
      if (dueDate && !isValidISODate(dueDate)) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: "Subtask deadline must be a valid date" });
      }
      sub.dueDate = dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null;
    }
    if (req.body.assignedTo !== undefined) {
      if (!isManager) {
        await discardUploads(req);
        return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can reassign subtasks" });
      }
      let assignee;
      try {
        assignee = await resolveAssignedUser(req.body.assignedTo, null, req.adminId, req.user.role);
      } catch (error) {
        await discardUploads(req);
        return sendError(res, error);
      }
      if (!assignee) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: "Select a user for this subtask" });
      }
      const previousAssignee = sub.assignedTo;
      sub.assignedTo = assignee._id;
      if (String(previousAssignee || "") !== String(assignee._id)) {
        notifySubtaskAssigned(task, { _id: req.user._id, name: (await getActor(req)).name }, sub.title, assignee._id);
      }
    }
    if (req.body.completed !== undefined) {
      if (!isManager && !isAssignee) {
        await discardUploads(req);
        return res.status(403).json({ success: false, message: "Only the assignee, the task creator, a Manager or an Admin can tick subtasks" });
      }
      sub.completed = Boolean(req.body.completed);
      sub.completedAt = sub.completed ? new Date() : null;
    }
    if (req.body.title !== undefined) {
      if (!isManager) {
        await discardUploads(req);
        return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can rename subtasks" });
      }
      const title = String(req.body.title || "").trim().slice(0, 300);
      if (!title) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: "Subtask title is required" });
      }
      sub.title = title;
    }
    const removedFiles = [];
    if (isManager && Array.isArray(req.body.attachments)) {
      const keep = new Set(req.body.attachments.map((file) => file?.filename).filter(Boolean));
      sub.attachments = sub.attachments.filter((file) => {
        if (keep.has(file.filename)) return true;
        if (file.filename) removedFiles.push(file.filename);
        return false;
      });
    }
    sub.attachments.push(...(req.files || []).map((file) => toAttachment(file, req.user._id)));
    await task.save();
    await removeUnreferencedFiles(removedFiles);
    await subtaskResponse(res, [task._id], "Subtask updated");
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

export const deleteSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) return;
    if (!canModifyTask(req, task)) {
      return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can remove subtasks" });
    }
    const sub = task.subtasks.id(req.params.subId);
    if (!sub) return res.status(404).json({ success: false, message: "Subtask not found" });
    const removedFiles = sub.attachments.map((file) => file.filename);
    sub.deleteOne();
    await task.save();
    await removeUnreferencedFiles(removedFiles);
    await subtaskResponse(res, [task._id], "Subtask removed");
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/scoreboard  ==================== */
// My points, level and badges + the organization's leaderboard (top 10)
export const getScoreboard = async (req, res) => {
  try {
    const me = await scoreProfile(req.user._id);

    const filter = { status: "Active", role: { $ne: "SuperAdmin" } };
    if (req.user.role !== "SuperAdmin") {
      const orgId = req.user.role === "Admin" ? req.user._id : req.adminId;
      filter.$or = [{ _id: orgId }, { admin_id: orgId }];
    }
    const top = await User.find(filter).select("name department points").sort({ points: -1, name: 1 }).limit(10).lean();
    const leaderboard = top.map((u, i) => {
      const level = levelFor(u.points || 0);
      return {
        rank: i + 1,
        userId: String(u._id),
        name: u.name,
        department: u.department || "",
        points: u.points || 0,
        level: { name: level.name, icon: level.icon },
      };
    });

    res.json({ success: true, data: { me, leaderboard, levels: LEVELS } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/:id/attachments  ==================== */
export const addTaskAttachments = async (req, res) => {
  try {
    const task = mongoose.Types.ObjectId.isValid(req.params.id)
      ? await Task.findOne({ _id: req.params.id, ...req.scope })
      : null;
    if (!task) {
      await discardUploads(req);
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // Creator / Manager / Admin, or the assignee (to attach deliverables)
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user._id);
    if (!canModifyTask(req, task) && !isAssignee) {
      await discardUploads(req);
      return res.status(403).json({ success: false, message: "You cannot add files to this task" });
    }

    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: "No files received" });
    }

    const newFiles = req.files.map((f) => toAttachment(f, req.user._id));
    task.attachments.push(...newFiles);
    await task.save();

    const populated = await populateTask(Task.findById(task._id));

    res.json({
      success: true,
      message: `${newFiles.length} file(s) uploaded`,
      data: shapeTask(populated),
    });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/attachments/:filename ====================
 * Authenticated download — the file is only served when it belongs to a task
 * inside the requester's data scope.
 */
export const downloadTaskAttachment = async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ""));
    const task = await Task.findOne({
      ...req.scope,
      $or: [
        { "attachments.filename": filename },
        { "subtasks.attachments.filename": filename },
      ],
    })
      .select("attachments subtasks")
      .lean();
    const file =
      task?.attachments.find((a) => a.filename === filename) ||
      task?.subtasks.flatMap((subtask) => subtask.attachments || []).find((a) => a.filename === filename);

    if (!file) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    await sendStoredFile(res, {
      dir: UPLOAD_DIR,
      folder: TASK_FILES_FOLDER,
      filename,
      downloadName: file.name,
      mimetype: file.mimetype,
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== DELETE /api/tasks/:id  ==================== */
export const deleteTask = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid task ID" });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope, isTaskBank: { $ne: true } });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    // ⭐ Users may only delete tasks they created; Managers/Admins any task in scope
    if (!canModifyTask(req, task)) {
      return res.status(403).json({
        success: false,
        message: "You can only delete tasks that you created",
      });
    }

    await task.deleteOne();
    await removeUnreferencedFiles([
      ...task.attachments.map((a) => a.filename),
      ...task.subtasks.flatMap((subtask) => subtask.attachments.map((a) => a.filename)),
    ]);
    await MonthlyProgress.deleteMany({ task: task._id }); // its daily entries go with it

    res.json({ success: true, message: "Task deleted", data: { id: task._id } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/stats ==================== */
export const getTaskStats = async (req, res) => {
  try {
    const scope = { ...req.scope, isTaskBank: { $ne: true } };

    const [total, todo, progress, review, completed] = await Promise.all([
      Task.countDocuments(scope),
      Task.countDocuments({ ...scope, status: "To Do" }),
      Task.countDocuments({ ...scope, status: "In Progress" }),
      Task.countDocuments({ ...scope, status: "Review" }),
      Task.countDocuments({ ...scope, status: "Completed" }),
    ]);
    res.json({ success: true, data: { total, todo, progress, review, completed } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/import  ====================
 * CSV → real tasks (shown on the Task Calendar and the Tasks page).
 * ?preview=true  → validate only, nothing is saved.
 * Columns (case/spacing ignored): Title*, Start Date, Start Time, End Date*, End Time,
 *   Department, Assignee (name or email), Status, Priority, Description
 * Dates may be written any common way (2026-11-07, 07/11/2026, 7 Nov 2026, Excel dates…),
 * times as 17:00 / 5 pm. The Reference ID is always generated automatically.
 * Old files with a single "Date" / "Time" column still work (= End Date / End Time).
 */
const IMPORT_COLUMNS = {
  title: ["title", "tasktitle", "task", "taskname", "name"],
  startDate: ["startdate", "start", "fromdate", "from", "startson", "startingdate"],
  startTime: ["starttime", "fromtime"],
  date: ["enddate", "end", "todate", "to", "duedate", "deadline", "endingdate", "date", "taskdate"],
  time: ["endtime", "totime", "duetime", "deadlinetime", "time", "tasktime"],
  department: ["department", "dept"],
  assignee: ["assignee", "assignedto", "assigneduser", "user", "email"],
  assignedBy: ["assignedby", "assigner", "assignedbyname", "assignedbyemail"],
  status: ["status"],
  priority: ["priority"],
  description: ["description", "details", "taskdescription"],
};

// "17:30" → "5:30 PM" (preview display only; tasks keep storing 24-hour HH:MM)
const to12h = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return hhmm || "";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * "Assigned By" column of the import → a user of the SAME organization
 * (the org admin, managers or users), matched by email or exact name.
 */
const resolveImportAssigner = async (input, orgId) => {
  const trimmed = String(input || "").trim();
  if (!trimmed || !orgId) return null;
  const scope = {
    role: { $ne: "SuperAdmin" },
    $or: [{ _id: orgId }, { admin_id: orgId }, { createdBy: orgId, admin_id: null }],
  };
  let user = await User.findOne({ ...scope, email: trimmed.toLowerCase() }).select("name status").lean();
  if (!user) {
    const byName = await User.find({
      ...scope,
      name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
    }).select("name status").limit(2).lean();
    if (byName.length > 1) {
      throw new AssignError(`More than one user is named "${trimmed}" — use their email in Assigned By`);
    }
    user = byName[0] || null;
  }
  if (!user) throw new AssignError(`Assigned By "${trimmed}" was not found in your organization`);
  if (user.status === "Inactive") throw new AssignError(`Assigned By: ${user.name} is inactive`);
  return user;
};

const IMPORT_STATUS = {
  pending: "To Do", todo: "To Do", "to do": "To Do",
  "in progress": "In Progress", inprogress: "In Progress",
  review: "Review", completed: "Completed", done: "Completed",
};

export const MAX_IMPORT_ROWS = 1000;

export const uploadImportCSV = withUploadErrors(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith(".csv")) return cb(null, true);
      const err = new Error("Only .csv files can be imported");
      err.status = 400;
      cb(err);
    },
  }).single("file")
);

export const importTasks = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No CSV file received" });
    }
    const preview = String(req.query.preview || req.body?.preview || "") === "true";

    let parsed;
    try {
      parsed = readCSV(req.file.buffer.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    // first matching header wins, in the order the names are listed ("End Date" before "Date")
    const col = Object.fromEntries(
      Object.entries(IMPORT_COLUMNS).map(([key, names]) => {
        const name = names.find((n) => parsed.headers.includes(n));
        return [key, name ? parsed.headers.indexOf(name) : -1];
      })
    );
    if (col.title === -1 || col.date === -1) {
      return res.status(400).json({
        success: false,
        message: 'The CSV must have "Title" and "End Date" columns in the header row',
      });
    }
    if (parsed.rows.length === 0) {
      return res.status(400).json({ success: false, message: "The CSV has a header row but no task rows" });
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({
        success: false,
        message: `Too many rows (${parsed.rows.length}). Import at most ${MAX_IMPORT_ROWS} rows at a time.`,
      });
    }

    // Departments of the organization (validated only when the org has defined any)
    const deptFilter =
      req.user.role === "SuperAdmin" ? {} : { $or: [{ admin_id: req.adminId }, { createdBy: req.adminId }] };
    const orgDepartments = await Department.find(deptFilter).select("name").lean();
    const deptByKey = new Map(orgDepartments.map((d) => [d.name.trim().toLowerCase(), d.name]));

    const seen = new Set();
    const results = [];

    for (const { line, values } of parsed.rows) {
      const get = (key) => (col[key] >= 0 ? String(values[col[key]] ?? "").trim() : "");
      const errors = [];

      const title = get("title");
      const rawStart = get("startDate");
      const rawStartTime = get("startTime");
      const rawEnd = get("date");
      const rawEndTime = get("time");
      const rawDept = get("department");
      const assigneeInput = get("assignee");
      const assignedByInput = get("assignedBy");
      const rawStatus = get("status");
      const rawPriority = get("priority");

      if (!title) errors.push("Title is required");

      // End date (required) — any common format; a time written in the date cell is used too
      const end = rawEnd ? parseFlexibleDate(rawEnd) : null;
      if (!rawEnd) errors.push("End Date is required");
      else if (!end) errors.push(`End Date "${rawEnd}" is not a date we can read (e.g. 2026-11-07, 07/11/2026 or 7 Nov 2026)`);
      const date = end?.date || "";
      let time = end?.time || "";
      if (rawEndTime) {
        const t = parseFlexibleTime(rawEndTime);
        if (!t) errors.push(`End Time "${rawEndTime}" is not a time (e.g. 17:00 or 5:00 PM)`);
        else time = t;
      }

      // Start date (optional)
      const start = rawStart ? parseFlexibleDate(rawStart) : null;
      if (rawStart && !start) errors.push(`Start Date "${rawStart}" is not a date we can read (e.g. 2026-11-01, 01/11/2026 or 1 Nov 2026)`);
      const startDate = start?.date || "";
      let startTime = start?.time || "";
      if (rawStartTime) {
        const t = parseFlexibleTime(rawStartTime);
        if (!t) errors.push(`Start Time "${rawStartTime}" is not a time (e.g. 09:00 or 9:00 AM)`);
        else startTime = t;
      }
      if (startTime && !startDate) startTime = "";
      if (startDate && date && `${startDate}T${startTime || "00:00"}` > `${date}T${time || "23:59"}`) {
        errors.push(`Start Date ${startDate}${startTime ? ` ${startTime}` : ""} is after the End Date ${date}${time ? ` ${time}` : ""}`);
      }

      let department = rawDept;
      if (rawDept && deptByKey.size > 0) {
        department = deptByKey.get(rawDept.toLowerCase());
        if (!department) errors.push(`Department "${rawDept}" does not exist`);
      }

      const status = rawStatus ? IMPORT_STATUS[rawStatus.toLowerCase()] : "To Do";
      if (!status) errors.push(`Status "${rawStatus}" is not valid (use Pending, In Progress, Review or Completed)`);

      const priority = rawPriority
        ? TASK_PRIORITIES.find((p) => p.toLowerCase() === rawPriority.toLowerCase())
        : "Medium";
      if (!priority) errors.push(`Priority "${rawPriority}" is not valid (use ${TASK_PRIORITIES.join(", ")})`);

      let assignee = null;
      if (assigneeInput) {
        try {
          assignee = await resolveAssignedUser(assigneeInput, department || "", req.adminId, req.user.role);
          ensureCanAssign(req, [assignee]);
        } catch (err) {
          errors.push(err.message);
          assignee = null;
        }
      } else if (req.user.role === "SuperAdmin") {
        errors.push("Assignee is required so the task belongs to an organization");
      }

      // Assigned By (optional) — blank means the person doing the import
      const orgId = req.user.role === "SuperAdmin" ? userOrgId(assignee) : req.adminId;
      let assigner = null;
      if (assignedByInput) {
        try {
          assigner = await resolveImportAssigner(assignedByInput, orgId);
        } catch (err) {
          errors.push(err.message);
        }
      }

      const data = {
        name: title,
        startDate,
        startTime,
        dueDate: date,
        dueTime: time || "",
        department: department || "",
        assignedTo: assignee?._id || null,
        assignedUser: assignee?.name || "",
        assignedBy: assigner?._id || req.user._id,
        assignedByName: assigner?.name || req.user.name || "",
        status: status || "To Do",
        priority: priority || "Medium",
        description: get("description"),
        referenceId: "", // always generated on save (department code + number)
        admin_id: req.user.role === "SuperAdmin" ? userOrgId(assignee) : req.adminId,
      };

      let state = errors.length ? "invalid" : "valid";

      // ⭐ Duplicates — same title + date + assignee inside this file or already in the org
      if (state === "valid") {
        const key = [title.toLowerCase(), date, String(data.assignedTo || "")].join("|");
        if (seen.has(key)) {
          state = "duplicate";
          errors.push("Duplicate of an earlier row in this file");
        } else {
          seen.add(key);
          const exists = await Task.exists({
            admin_id: data.admin_id,
            isTaskBank: { $ne: true },
            name: { $regex: new RegExp(`^${escapeRegex(title)}$`, "i") },
            dueDate: new Date(`${date}T00:00:00.000Z`),
            assignedTo: data.assignedTo,
          });
          if (exists) {
            state = "duplicate";
            errors.push("A task with the same title, date and assignee already exists");
          }
        }
      }

      results.push({ line, state, errors, data });
    }

    const valid = results.filter((r) => r.state === "valid");
    const summary = {
      total: results.length,
      valid: valid.length,
      invalid: results.filter((r) => r.state === "invalid").length,
      duplicates: results.filter((r) => r.state === "duplicate").length,
    };
    const rowsForClient = results.map(({ line, state, errors, data }) => ({
      line,
      state,
      errors,
      title: data.name,
      startDate: data.startDate ? `${data.startDate}${data.startTime ? ` ${to12h(data.startTime)}` : ""}` : "",
      endDate: data.dueDate ? `${data.dueDate}${data.dueTime ? ` ${to12h(data.dueTime)}` : ""}` : "",
      date: data.dueDate,
      time: data.dueTime,
      department: data.department,
      assignee: data.assignedUser,
      assignedBy: data.assignedByName,
      status: data.status,
      priority: data.priority,
    }));

    if (preview) {
      return res.json({ success: true, preview: true, summary, rows: rowsForClient });
    }

    if (valid.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows to import",
        summary,
        rows: rowsForClient,
      });
    }

    // every imported task gets its department's next reference ID (FF1, FF2…) automatically
    for (const { data } of valid) {
      data.referenceId = await generateReferenceId(data.admin_id, data.department);
    }

    const actor = await getActor(req);
    const inserted = await Task.insertMany(
      valid.map(({ data }) => ({
        name: data.name,
        referenceId: data.referenceId,
        description: data.description,
        department: data.department,
        departments: data.department ? [data.department] : [],
        startDate: data.startDate ? new Date(`${data.startDate}T00:00:00.000Z`) : null,
        startTime: data.startDate ? data.startTime : "",
        dueDate: data.dueDate,
        dueTime: data.dueTime,
        priority: data.priority,
        status: data.status,
        completedAt: data.status === "Completed" ? new Date() : null,
        assignedTo: data.assignedTo,
        assignedBy: data.assignedBy,
        assignedAt: new Date(),
        admin_id: data.admin_id,
        isTaskBank: false,
        statusHistory: [
          { from: null, to: data.status, changedBy: req.user._id, changedByName: actor.name, note: "Imported from CSV" },
        ],
      }))
    );

    // each task is announced as coming from its own "Assigned By" person
    inserted.forEach((t) => announce([t], t.assignedBy || req.user._id));

    res.status(201).json({
      success: true,
      message: `${inserted.length} task(s) imported` +
        (summary.total > inserted.length ? `, ${summary.total - inserted.length} row(s) skipped` : ""),
      imported: inserted.length,
      skipped: summary.total - inserted.length,
      summary,
      rows: rowsForClient,
      first_date: valid[0]?.data.dueDate || null,
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/reference-options ====================
 * Searchable list for "Rework Reference Task ID": earlier tasks the user can see.
 * One entry per task (copies of a shared task are shown once).
 */
export const getReferenceOptions = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const filter = { ...req.scope, isTaskBank: { $ne: true }, referenceId: { $nin: ["", null] } };
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      const searchOr = [{ referenceId: rx }, { name: rx }, { department: rx }, { departments: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }
    const tasks = await Task.find(filter)
      .select("referenceId name description priority department departments status taskGroupId assignedTo dueDate dueTime createdAt")
      .populate("assignedTo", "name department")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const byKey = new Map();
    for (const t of tasks) {
      const key = t.taskGroupId ? `g:${t.taskGroupId}` : `t:${t._id}`;
      const entry = byKey.get(key);
      if (entry) {
        if (t.assignedTo?.name && !entry.assignees.includes(t.assignedTo.name)) entry.assignees.push(t.assignedTo.name);
        if (t.assignedTo?._id) entry.assigneeIds.push(String(t.assignedTo._id));
        continue;
      }
      byKey.set(key, {
        id: t._id,
        referenceId: t.referenceId,
        name: t.name,
        departments: t.departments?.length ? t.departments : t.department ? [t.department] : [],
        status: t.status,
        dueDate: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "",
        assignees: t.assignedTo?.name ? [t.assignedTo.name] : [],
        // used to fill the rework form automatically
        assigneeIds: t.assignedTo?._id ? [String(t.assignedTo._id)] : [],
        description: t.description || "",
        priority: t.priority || "Medium",
        dueTime: t.dueTime || "",
      });
    }
    res.json({ success: true, data: [...byKey.values()].slice(0, 50) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/workload/:userId ====================
 * Live workload of an employee for the Create Task form.
 * Same organization only; seeing someone else's workload needs tasks.assign.
 */
export const getEmployeeWorkload = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    const user = await User.findOne({
      _id: userId,
      ...(req.user.role === "SuperAdmin" ? {} : orgMemberQuery(req.adminId)),
    })
      .select("name department role")
      .lean();
    if (!user) return res.status(404).json({ success: false, message: "Employee not found in your organization" });
    if (!isSelf(req, user) && !hasPermission(req, "tasks", "assign")) {
      return res.status(403).json({ success: false, message: "You can only see your own workload" });
    }
    const workload = await computeWorkload(user._id);
    res.json({ success: true, data: { user: { id: user._id, name: user.name, department: user.department || "" }, ...workload } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/rework-id-preview ====================
 * ?reworkOf=<original task id>&userIds=a,b → the Task ID each person's rework would get
 * (TECH14-1 for the original person, TECH14-DEV1 for a new one). Nothing is reserved.
 */
export const getReworkIdPreview = async (req, res) => {
  try {
    const { reworkOf } = req.query;
    if (!mongoose.Types.ObjectId.isValid(reworkOf)) {
      return res.status(400).json({ success: false, message: "Invalid original task" });
    }
    const original = await Task.findOne({ _id: reworkOf, ...req.scope, isTaskBank: { $ne: true } }).lean();
    if (!original || !original.referenceId) {
      return res.status(404).json({ success: false, message: "Original task not found" });
    }
    const ids = String(req.query.userIds || "").split(",").filter((id) => mongoose.Types.ObjectId.isValid(id)).slice(0, 50);
    const users = await User.find({
      _id: { $in: ids },
      ...(req.user.role === "SuperAdmin" ? {} : orgMemberQuery(req.adminId)),
    })
      .select("name department admin_id createdBy")
      .lean();
    const originalAssignees = await originalAssigneeIds(original);
    const out = [];
    for (const u of users) {
      const orgId = req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId;
      out.push({
        userId: String(u._id),
        name: u.name,
        department: u.department || "",
        ...(await reworkIdFor({ orgId, originalRef: original.referenceId, originalAssignees, user: u, reserve: false })),
      });
    }
    res.json({ success: true, data: { originalReferenceId: original.referenceId, people: out } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/:id/checklist/:itemId ====================
 * Tick a Check row, or answer a Text / Number row.
 * Allowed: the task's assignee, the row's employee, or whoever may edit the task.
 */
export const updateChecklistItem = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ success: false, message: "Invalid task or checklist item" });
    }
    const task = await Task.findOne({ _id: id, ...req.scope, isTaskBank: { $ne: true } });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    const item = task.checklist.id(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Checklist item not found" });

    const allowed =
      isSelf(req, task.assignedTo) ||
      (item.employee?.userId && isSelf(req, item.employee.userId)) ||
      canModifyTask(req, task);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "Only the assigned person, this row's employee or the task's creator can update it" });
    }

    const { done, value } = req.body || {};
    if (item.type === "Check") {
      if (typeof done !== "boolean") return res.status(400).json({ success: false, message: "Send done: true or false" });
      item.done = done;
    } else {
      const text = String(value ?? "").trim();
      if (text.length > 300) return res.status(400).json({ success: false, message: "The answer can be at most 300 characters" });
      if (item.type === "Number" && text && !/^-?\d+(\.\d+)?$/.test(text)) {
        return res.status(400).json({ success: false, message: "Enter a number" });
      }
      item.value = text;
      item.done = Boolean(text);
    }
    const actor = await getActor(req);
    item.doneAt = item.done ? new Date() : null;
    item.doneBy = item.done ? actor.name : "";
    await task.save();

    const populated = await populateTask(Task.findById(task._id));
    res.json({ success: true, data: shapeTask(populated) });
  } catch (error) {
    sendError(res, error);
  }
};
