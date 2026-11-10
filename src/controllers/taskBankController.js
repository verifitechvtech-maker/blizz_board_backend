import mongoose from "mongoose";
import TaskBank from "../models/TaskBank.js";
import multer from "multer";
import { readCSV } from "../utils/csv.js";
import Task, { TASK_PRIORITIES } from "../models/Task.js";
import User from "../models/User.js";
import { MEMBER_ROLES } from "../config/permissions.js";
import { hasPermission } from "../middleware/permissionMiddleware.js";
import { notifyTaskAssigned, notifyTaskReassigned } from "../services/taskNotificationService.js";
import path from "path";
import fs from "fs";
import {
  UPLOAD_DIR,
  TASK_FILES_FOLDER,
  toAttachment,
  discardUploads,
  removeUnreferencedFiles,
} from "./taskController.js";
import { sendStoredFile } from "../services/fileStorage.js";

// ==================== HELPERS ====================

const parseTags = (tags) => {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
};

// ⭐ Visibility filter — what items can this user SEE?
// SuperAdmin → everything | Admin/User → global templates + OWN org's templates
const visibilityFilter = (req) =>
  req.user.role === "SuperAdmin"
    ? {}
    : { $or: [{ isGlobal: true }, { admin_id: req.adminId }] };

// ⭐ EDIT filter — what items can this user CHANGE?
// SuperAdmin → anything | Admin → only OWN private templates (global templates are read-only for admins)
const editableFilter = (req) =>
  req.user.role === "SuperAdmin"
    ? { _id: req.params.id }
    : { _id: req.params.id, admin_id: req.adminId, isGlobal: false };

// ⭐ CHANGED: scoped finder for READ operations (view, duplicate, assign)
const findVisibleOr404 = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid id." });
    return null;
  }
  const item = await TaskBank.findOne({ _id: req.params.id, ...visibilityFilter(req) });
  if (!item) {
    res.status(404).json({ success: false, message: "Item not found." });
    return null;
  }
  return item;
};

// ⭐ CHANGED: scoped finder for WRITE operations (update, delete)
const findEditableOr404 = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid id." });
    return null;
  }
  const item = await TaskBank.findOne(editableFilter(req));
  if (!item) {
    res.status(404).json({ success: false, message: "Item not found." });
    return null;
  }
  return item;
};


// ⭐ Only the requester's organization's assignments are visible (a global template
//    is shared by many orgs — Admin2 must not see who Admin1 assigned it to).
const shapeItem = (item, req) => {
  const json = item.toJSON();
  const visible = (json.assignments || []).filter(
    (a) => req.user.role === "SuperAdmin" || String(a.admin_id) === String(req.adminId)
  );
  json.assignments = visible
    .slice(-5)
    .reverse()
    .map((a) => ({
      task: a.task,
      user: a.user,
      userName: a.userName,
      assignedAt: a.assignedAt,
    }));
  json.assignedCount = visible.length;
  // template files — downloaded through the Task Bank (same visibility as the template)
  json.attachments = (json.attachments || []).map((a) => ({
    name: a.name,
    size: a.size,
    filename: a.filename,
    mimetype: a.mimetype,
    uploadedAt: a.uploadedAt,
    url: `/api/taskbank/${json._id || json.id}/attachments/${a.filename}`,
  }));
  json.lastAssignedTo = json.assignments[0]?.userName || "";
  return json;
};

const escapeRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class AssignError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Resolve users by id / name / email inside the requester's organization.
const resolveAssignees = async (req, inputs, department) => {
  const isSuper = req.user.role === "SuperAdmin";
  if (!isSuper && !req.adminId) throw new AssignError("Your account is not linked to an organization", 403);

  const scope = isSuper
    ? { role: { $in: MEMBER_ROLES } }
    : { role: { $in: MEMBER_ROLES }, $or: [{ admin_id: req.adminId }, { createdBy: req.adminId, admin_id: null }] };

  const users = [];
  for (const input of inputs) {
    const value = String(input._id || input.id || input).trim();
    let user = null;

    if (mongoose.isValidObjectId(value)) {
      user = await User.findOne({ _id: value, ...scope }).lean();
      if (!user && (await User.exists({ _id: value }))) {
        throw new AssignError("The selected user is not in your organization", 403);
      }
    }
    if (!user) {
      const matches = await User.find({ ...scope, name: new RegExp(`^${escapeRx(value)}$`, "i") }).limit(2).lean();
      if (matches.length > 1) throw new AssignError(`More than one user is named "${value}". Select the user from the list.`);
      user = matches[0] || (await User.findOne({ ...scope, email: value.toLowerCase() }).lean());
    }
    if (!user) throw new AssignError(`User "${value}" was not found in your organization`);
    if (user.status === "Inactive") throw new AssignError(`${user.name} is inactive and cannot receive tasks`);
    if (
      department &&
      user.department &&
      user.department.trim().toLowerCase() !== department.trim().toLowerCase()
    ) {
      throw new AssignError(`${user.name} is not in the "${department}" department`);
    }
    if (String(user._id) !== String(req.user._id) && !hasPermission(req, "taskbank", "assign")) {
      throw new AssignError("You do not have permission to assign tasks", 403);
    }
    if (!users.some((u) => String(u._id) === String(user._id))) users.push(user);
  }
  return users;
};

// ==================== CONTROLLERS ====================

// GET /api/taskbank?search=&category=&department=&type=&priority=
export const getItems = async (req, res) => {
  try {
    const { search, category, department, type, priority } = req.query;

    // ⭐ build isolation + search as separate conditions (so $or never clashes)
    const conditions = [];

    // ⭐⭐⭐ ISOLATION — Admin2 never sees Admin1's private templates
    if (req.user.role !== "SuperAdmin") {
      conditions.push({ $or: [{ isGlobal: true }, { admin_id: req.adminId }] });
    }

    const filter = {};
    if (category)   filter.category = category;
    if (department) filter.department = department;
    if (type)       filter.type = type;
    if (priority)   filter.priority = priority;

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      conditions.push({
        $or: [
          { title: rx },
          { description: rx },
          { category: rx },
          { department: rx },
          { tags: rx },
        ],
      });
    }

    if (conditions.length) filter.$and = conditions;

    const items = await TaskBank.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, count: items.length, data: items.map((i) => shapeItem(i, req)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/taskbank/stats
export const getStats = async (req, res) => {
  try {
    // ⭐ stats respect isolation too
    const items = await TaskBank.find(visibilityFilter(req));
    res.json({
      success: true,
      data: {
        totalRepository: items.length,
        readyToAssign: items.filter((i) => i.status === "Ready to Assign").length,
        ideas: items.filter((i) => i.type === "Idea" || i.status === "Draft").length,
        recentlyUsed: items.filter((i) => shapeItem(i, req).assignedCount > 0 || i.usageCount > 0).length,
        departmentCount: new Set(items.map((i) => i.department)).size,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/taskbank/seed  (adds sample data once)
export const seed = async (req, res) => {
  try {
    const count = await TaskBank.countDocuments();
    if (count > 0) {
      return res.json({ success: true, message: `Already has ${count} items — seed skipped.` });
    }

    // ⭐ seeded items = GLOBAL templates (visible to every admin as shared library)
    await TaskBank.insertMany([
      { title: "Monthly Performance Report", description: "Collect department performance data and prepare the monthly management report.", category: "Reporting", department: "Management", type: "Template", priority: "High", status: "Ready to Assign", estimatedTime: "2-3 hours", tags: ["Report", "Monthly", "Management"], usageCount: 8, isGlobal: true, admin_id: null },
      { title: "Website Performance Audit", description: "Review website performance, identify issues and prepare optimization tasks.", category: "Development", department: "Development", type: "Template", priority: "High", status: "Ready to Assign", estimatedTime: "4 hours", tags: ["Website", "Audit", "Performance"], usageCount: 5, isGlobal: true, admin_id: null },
      { title: "Employee Onboarding Checklist", description: "Create a reusable onboarding workflow for new employees joining the company.", category: "HR", department: "Human Resources", type: "Idea", priority: "Medium", status: "Draft", estimatedTime: "1-2 hours", tags: ["Onboarding", "HR", "Employee"], usageCount: 0, isGlobal: true, admin_id: null },
      { title: "Client Follow-up Process", description: "Create a standard process for following up with clients after project delivery.", category: "Client Management", department: "Sales", type: "Template", priority: "Medium", status: "Ready to Assign", estimatedTime: "1 hour", tags: ["Client", "Follow-up", "Sales"], usageCount: 4, isGlobal: true, admin_id: null },
      { title: "Social Media Campaign", description: "Plan and organize social media content for the upcoming campaign.", category: "Marketing", department: "Marketing", type: "Idea", priority: "Low", status: "Draft", estimatedTime: "3 hours", tags: ["Social Media", "Campaign", "Marketing"], usageCount: 1, isGlobal: true, admin_id: null },
      { title: "Quarterly Security Review", description: "Review system access, security settings and department permissions.", category: "Security", department: "IT", type: "Template", priority: "High", status: "Ready to Assign", estimatedTime: "3-4 hours", tags: ["Security", "Review", "Access"], usageCount: 3, isGlobal: true, admin_id: null },
    ]);

    res.json({ success: true, message: "Sample data added." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/taskbank/:id
export const getItem = async (req, res) => {
  try {
    // ⭐ scoped — Admin2 can't open Admin1's private template by ID
    const item = await findVisibleOr404(req, res);
    if (!item) return;
    res.json({ success: true, data: shapeItem(item, req) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/taskbank
export const createItem = async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();

    if (!title || !description) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: title ? "Description is required." : "Title is required." });
    }

    const type = req.body.type === "Idea" ? "Idea" : "Template";

    // ⭐⭐⭐ ISOLATION — SuperAdmin → global template | Admin → private (Admin2 never sees)
    const isSuper = req.user.role === "SuperAdmin";

    const item = await TaskBank.create({
      title,
      description,
      category: req.body.category || "General",
      department: req.body.department || "Management",
      type,
      priority: req.body.priority || "Medium",
      status: type === "Idea" ? "Draft" : "Ready to Assign",
      // "" = estimated time switched off in the form
      estimatedTime: req.body.estimatedTime !== undefined ? String(req.body.estimatedTime).trim() : "1 hour",
      createdBy: req.user?.name || "Admin User", // display name — from the account, not the body
      tags: parseTags(req.body.tags),
      attachments: (req.files || []).map((f) => toAttachment(f, req.user._id)), // uploaded with the form
      isGlobal: isSuper,                    // ⭐ only SuperAdmin creates shared templates
      admin_id: isSuper ? null : req.adminId, // ⭐ from TOKEN
      creatorId: req.user._id,              // ⭐ real owner
    });

    res.status(201).json({ success: true, message: "Item created.", data: shapeItem(item, req) });
  } catch (err) {
    await discardUploads(req);
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/taskbank/:id
export const updateItem = async (req, res) => {
  try {
    // ⭐ Admin can edit only OWN private templates — global templates are read-only for them
    const item = await findEditableOr404(req, res);
    if (!item) {
      await discardUploads(req);
      return;
    }

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    if (!title || !description) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: title ? "Description is required." : "Title is required." });
    }

    item.title = title;
    item.description = description;
    if (req.body.category)      item.category = req.body.category;
    if (req.body.department)    item.department = req.body.department;
    if (req.body.type)          item.type = req.body.type;
    if (req.body.priority)      item.priority = req.body.priority;
    if (req.body.status)        item.status = req.body.status;
    if (req.body.estimatedTime !== undefined) item.estimatedTime = String(req.body.estimatedTime).trim();
    if (req.body.tags !== undefined) item.tags = parseTags(req.body.tags);

    // files: keep the ones still listed (JSON list of filenames), then add the new uploads
    const removed = [];
    if (req.body.keepAttachments !== undefined) {
      let keep = req.body.keepAttachments;
      if (typeof keep === "string") {
        try { keep = JSON.parse(keep); } catch { keep = []; }
      }
      const keepSet = new Set((Array.isArray(keep) ? keep : []).map(String));
      item.attachments = item.attachments.filter((a) => {
        if (keepSet.has(a.filename)) return true;
        removed.push(a.filename);
        return false;
      });
    }
    item.attachments.push(...(req.files || []).map((f) => toAttachment(f, req.user._id)));

    // ⭐ never allow ownership/visibility change via body
    delete req.body.isGlobal;
    delete req.body.admin_id;
    delete req.body.creatorId;

    await item.save();
    await removeUnreferencedFiles(removed);
    res.json({ success: true, message: "Item updated.", data: shapeItem(item, req) });
  } catch (err) {
    await discardUploads(req);
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/taskbank/:id
export const deleteItem = async (req, res) => {
  try {
    // ⭐ same protection as update
    const item = await findEditableOr404(req, res);
    if (!item) return;

    await item.deleteOne();
    // files go too, unless a task assigned from this template still uses them
    await removeUnreferencedFiles((item.attachments || []).map((a) => a.filename));
    res.json({ success: true, message: `"${item.title}" deleted.`, data: { id: item.id } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/taskbank/:id/duplicate
export const duplicateItem = async (req, res) => {
  try {
    // ⭐ must be able to SEE the original (global or own)
    const item = await findVisibleOr404(req, res);
    if (!item) return;

    const { _id, createdAt, updatedAt, assignments, ...rest } = item.toObject();

    const copy = await TaskBank.create({
      ...rest,
      title: `${item.title} Copy`,
      usageCount: 0,
      // ⭐⭐⭐ the COPY belongs to the duplicator's org — even if original was global
      isGlobal: false,
      admin_id: req.adminId,
      creatorId: req.user._id,
    });

    res.status(201).json({ success: true, message: "Item duplicated.", data: shapeItem(copy, req) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/taskbank/:id/assign
// Body: { assignedUser: <userId | name | email> (or assignedUsers: [...]), dueDate, priority, department, reward, complexity }
// ⭐ Creates a REAL Task linked to the selected user(s) — the template itself stays in the bank.
export const assignItem = async (req, res) => {
  try {
    const item = await findVisibleOr404(req, res);
    if (!item) return;

    const raw = Array.isArray(req.body.assignedUsers) && req.body.assignedUsers.length
      ? req.body.assignedUsers
      : [req.body.assignedUser];
    const inputs = raw.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean);

    if (!inputs.length) {
      return res.status(400).json({ success: false, message: "Select the user to assign this task to." });
    }

    const { dueDate, dueTime, reward, complexity } = req.body;
    const department = req.body.department !== undefined ? String(req.body.department).trim() : item.department;
    const priority = req.body.priority || item.priority;

    if (!TASK_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Invalid priority. Allowed: ${TASK_PRIORITIES.join(", ")}` });
    }
    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) {
      return res.status(400).json({ success: false, message: "Invalid due date." });
    }

    // Org-scoped + department-checked user lookup (shared with the Tasks module)
    let users;
    try {
      users = await resolveAssignees(req, inputs, department);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }

    const actorName = req.user.name || req.user.email || "Unknown";
    const groupId = users.length > 1 ? new mongoose.Types.ObjectId() : null;

    const tasks = await Promise.all(
      users.map((u) =>
        Task.create({
          name: item.title,
          description: item.description,
          department,
          priority,
          dueDate: dueDate || undefined,
          dueTime: dueTime || "",
          reward: reward !== undefined ? Number(reward) || 0 : 10,
          complexity: complexity !== undefined ? Number(complexity) || 0 : 0,
          assignedTo: u._id,
          assignedBy: req.user._id,
          assignedAt: new Date(),
          // ⭐ the task belongs to the ASSIGNEE's organization
          admin_id: u.admin_id || u.createdBy || req.adminId,
          isTaskBank: false,
          taskGroupId: groupId,
          sourceTemplate: item._id,
          // the template's files travel with the task (same stored files)
          attachments: (item.attachments || []).map((a) => ({
            name: a.name,
            size: a.size,
            filename: a.filename,
            mimetype: a.mimetype,
            url: `/api/tasks/attachments/${a.filename}`,
            uploadedBy: a.uploadedBy,
            uploadedAt: a.uploadedAt,
          })),
          status: "To Do",
          statusHistory: [
            {
              from: null,
              to: "To Do",
              changedBy: req.user._id,
              changedByName: actorName,
              note: `Assigned from Task Bank: ${item.title}`,
            },
          ],
        })
      )
    );

    // Record the assignment on the template (usage stats + "Assigned to" display)
    await TaskBank.updateOne(
      { _id: item._id },
      {
        $inc: { usageCount: tasks.length },
        $push: {
          assignments: {
            $each: tasks.map((t, i) => ({
              task: t._id,
              user: users[i]._id,
              userName: users[i].name,
              admin_id: t.admin_id,
              assignedBy: req.user._id,
              assignedAt: t.assignedAt,
            })),
          },
        },
      }
    );

    // Assignment email + dashboard notification for each assignee (fire-and-forget)
    tasks.forEach((t) => notifyTaskAssigned(t._id, req.user._id));

    const updated = await TaskBank.findById(item._id);
    const names = users.map((u) => u.name).join(", ");

    res.status(201).json({
      success: true,
      message: `"${item.title}" assigned to ${names}.`,
      data: shapeItem(updated, req),
      tasks: tasks.map((t, i) => ({
        id: t._id,
        name: t.name,
        assignedTo: users[i]._id,
        assignedUser: users[i].name,
        dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : "",
        status: t.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


// POST /api/taskbank/:id/reassign   { assignedUser, taskId? , department? }
// Moves the task created from this template (latest one, or `taskId`) to another user.
// The template keeps a single active assignment — no duplicate task is created.
export const reassignItem = async (req, res) => {
  try {
    const item = await findVisibleOr404(req, res);
    if (!item) return;

    const mine = (item.assignments || []).filter(
      (a) => req.user.role === "SuperAdmin" || String(a.admin_id) === String(req.adminId)
    );
    const target = req.body.taskId
      ? mine.find((a) => String(a.task) === String(req.body.taskId))
      : mine[mine.length - 1];
    if (!target) {
      return res.status(400).json({ success: false, message: "This template has not been assigned yet — use Assign." });
    }

    const task = await Task.findOne({
      _id: target.task,
      ...(req.user.role === "SuperAdmin" ? {} : { admin_id: req.adminId }),
    });
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "The task created from this template was deleted. Use Assign to create a new one.",
      });
    }

    const input = String(req.body.assignedUser || "").trim();
    if (!input) return res.status(400).json({ success: false, message: "Select the user to reassign this task to." });

    const department = req.body.department !== undefined ? String(req.body.department).trim() : task.department;
    let users;
    try {
      users = await resolveAssignees(req, [input], department);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }
    const user = users[0];
    if (String(user._id) === String(task.assignedTo)) {
      return res.status(400).json({ success: false, message: `The task is already assigned to ${user.name}.` });
    }

    const previous = task.assignedTo ? String(task.assignedTo) : null;
    const actorName = req.user.name || req.user.email || "Unknown";
    task.assignedTo = user._id;
    task.assignedBy = req.user._id;
    task.assignedAt = new Date();
    task.department = department;
    task.taskGroupId = null;
    // reminders start over for the new person
    task.notifications = { assignedAt: null, reminder3hAt: null, reminder1hAt: null, overdueAlertAt: null };
    task.statusHistory.push({
      from: task.status,
      to: task.status,
      changedBy: req.user._id,
      changedByName: actorName,
      note: `Reassigned to ${user.name}`,
    });
    await task.save();

    // Update the template's assignment record (who has it now)
    await TaskBank.updateOne(
      { _id: item._id, "assignments.task": task._id },
      {
        $set: {
          "assignments.$.user": user._id,
          "assignments.$.userName": user.name,
          "assignments.$.assignedBy": req.user._id,
          "assignments.$.assignedAt": new Date(),
        },
      }
    );

    // Emails: "reassigned to you" + "no longer assigned to you"
    if (previous) notifyTaskReassigned(task._id, previous, req.user._id);
    else notifyTaskAssigned(task._id, req.user._id);

    const updated = await TaskBank.findById(item._id);
    res.json({
      success: true,
      message: `"${item.title}" reassigned to ${user.name}.`,
      data: shapeItem(updated, req),
      task: { id: task._id, assignedTo: user._id, assignedUser: user.name },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


// ==================== CSV IMPORT ====================
// POST /api/taskbank/import[?preview=true]  (multipart "file")
// Columns: Title*, Description*, Category, Department, Type (Template|Idea), Priority (High|Medium|Low),
//          Estimated Time, Tags ("a, b" or "a; b")
const BANK_COLUMNS = {
  title: ["title", "name", "task", "taskname", "template"],
  description: ["description", "details"],
  category: ["category"],
  department: ["department", "dept"],
  type: ["type"],
  priority: ["priority"],
  estimatedTime: ["estimatedtime", "estimate", "time", "duration"],
  tags: ["tags", "tag", "labels"],
};

export const uploadBankCSV = (req, res, next) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (r, file, cb) =>
      file.originalname.toLowerCase().endsWith(".csv")
        ? cb(null, true)
        : cb(Object.assign(new Error("Only .csv files can be imported"), { status: 400 })),
  }).single("file")(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "The CSV file must be 2 MB or smaller" : err.message });
  });

export const importItems = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No CSV file received" });
    const preview = String(req.query.preview || "") === "true";

    let parsed;
    try {
      parsed = readCSV(req.file.buffer.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    const col = Object.fromEntries(
      Object.entries(BANK_COLUMNS).map(([k, names]) => [k, parsed.headers.findIndex((h) => names.includes(h))])
    );
    if (col.title === -1 || col.description === -1) {
      return res.status(400).json({ success: false, message: 'The CSV must have "Title" and "Description" columns' });
    }
    if (!parsed.rows.length) return res.status(400).json({ success: false, message: "The CSV has a header row but no rows" });
    if (parsed.rows.length > 1000) return res.status(400).json({ success: false, message: "Import at most 1000 rows at a time" });

    const isSuper = req.user.role === "SuperAdmin";
    // Existing titles this organization can see (own + global) → duplicates
    const existing = await TaskBank.find(visibilityFilter(req)).select("title").lean();
    const taken = new Set(existing.map((e) => e.title.trim().toLowerCase()));
    const seen = new Set();

    const rows = parsed.rows.map(({ line, values }) => {
      const get = (k) => (col[k] >= 0 ? String(values[col[k]] ?? "").trim() : "");
      const errors = [];
      const title = get("title");
      const description = get("description");
      const rawType = get("type");
      const rawPriority = get("priority");
      if (!title) errors.push("Title is required");
      if (title.length > 150) errors.push("Title is longer than 150 characters");
      if (!description) errors.push("Description is required");
      const type = !rawType ? "Template" : ["template", "idea"].includes(rawType.toLowerCase()) ? (rawType.toLowerCase() === "idea" ? "Idea" : "Template") : null;
      if (!type) errors.push(`Type "${rawType}" must be Template or Idea`);
      const priority = !rawPriority ? "Medium" : ["High", "Medium", "Low"].find((p) => p.toLowerCase() === rawPriority.toLowerCase());
      if (!priority) errors.push(`Priority "${rawPriority}" must be High, Medium or Low`);

      let state = errors.length ? "invalid" : "valid";
      const key = title.toLowerCase();
      if (state === "valid") {
        if (seen.has(key)) {
          state = "duplicate";
          errors.push("Duplicate of an earlier row in this file");
        } else if (taken.has(key)) {
          state = "duplicate";
          errors.push("A Task Bank item with this title already exists");
        }
        seen.add(key);
      }
      return {
        line,
        state,
        errors,
        data: {
          title,
          description,
          category: get("category") || "General",
          department: get("department") || "Management",
          type: type || "Template",
          priority: priority || "Medium",
          estimatedTime: get("estimatedTime") || "1 hour",
          tags: parseTags(get("tags").replace(/;/g, ",")),
        },
      };
    });

    const summary = {
      total: rows.length,
      valid: rows.filter((r) => r.state === "valid").length,
      invalid: rows.filter((r) => r.state === "invalid").length,
      duplicates: rows.filter((r) => r.state === "duplicate").length,
    };
    const forClient = rows.map(({ line, state, errors, data }) => ({ line, state, errors, ...data }));

    if (preview) return res.json({ success: true, preview: true, summary, rows: forClient });
    const valid = rows.filter((r) => r.state === "valid");
    if (!valid.length) return res.status(400).json({ success: false, message: "No valid rows to import", summary, rows: forClient });

    const inserted = await TaskBank.insertMany(
      valid.map(({ data }) => ({
        ...data,
        status: data.type === "Idea" ? "Draft" : "Ready to Assign",
        createdBy: req.user.name || "Admin User",
        isGlobal: isSuper,
        admin_id: isSuper ? null : req.adminId,
        creatorId: req.user._id,
      }))
    );
    res.status(201).json({
      success: true,
      message: `${inserted.length} item(s) imported` + (summary.total > inserted.length ? `, ${summary.total - inserted.length} row(s) skipped` : ""),
      imported: inserted.length,
      summary,
      rows: forClient,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/taskbank/:id/attachments/:filename — a template file (whoever can see the template)
export const downloadBankAttachment = async (req, res) => {
  try {
    const item = await findVisibleOr404(req, res);
    if (!item) return;
    const filename = path.basename(String(req.params.filename || ""));
    const file = (item.attachments || []).find((a) => a.filename === filename);
    if (!file) return res.status(404).json({ success: false, message: "Attachment not found" });
    await sendStoredFile(res, {
      dir: UPLOAD_DIR,
      folder: TASK_FILES_FOLDER,
      filename,
      downloadName: file.name,
      mimetype: file.mimetype,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
