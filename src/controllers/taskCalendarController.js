import TaskCalendar from "../models/TaskCalendar.js";
import { parseCSVLine } from "../utils/csv.js";

// ============================================================
// CSV PARSER HELPERS  (UNCHANGED — keep as is)
// ============================================================

const parseTasksCSV = (text) => {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");

  if (lines.length < 2) throw new Error("CSV needs a header row + at least 1 task row.");

  const headers = parseCSVLine(lines[0]).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  const col = (...names) => headers.findIndex((h) => names.includes(h));

  const c = {
    title:       col("title", "tasktitle", "task", "name"),
    date:        col("date", "duedate", "taskdate"),
    time:        col("time", "tasktime"),
    department:  col("department", "dept"),
    assignee:    col("assignee", "assignedto", "user"),
    status:      col("status"),
    priority:    col("priority"),
    description: col("description", "details"),
  };

  if (c.title === -1 || c.date === -1)
    throw new Error('CSV must have "Title" and "Date" columns.');

  const rows = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    const get = (idx) => (idx >= 0 ? String(v[idx] || "").trim() : "");
    const title = get(c.title);
    const date = get(c.date);

    if (!title && !date) continue;
    if (!title) { errors.push(`Row ${i + 1}: title missing.`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Row ${i + 1}: date must be YYYY-MM-DD.`);
      continue;
    }

    const status = get(c.status);
    const priority = get(c.priority);

    rows.push({
      title,
      due_date: date,
      time: get(c.time) || "09:00",
      department: get(c.department) || "Management",
      assigned_to: get(c.assignee),
      status: ["Pending", "In Progress", "Completed"].includes(status) ? status : "Pending",
      priority: ["High", "Medium", "Low"].includes(priority) ? priority : "Medium",
      description: get(c.description),
    });
  }

  return { rows, errors };
};

// ============================================================
// CONTROLLERS
// ============================================================

// GET /api/taskcalendar — daily work tasks for calendar
export const getTasks = async (req, res) => {
  try {
    // ⭐⭐⭐ ISOLATION — Admin1 sees his org events | User sees his own | SuperAdmin all
    const tasks = await TaskCalendar.find(req.scope)
      .sort({ due_date: 1, time: 1 })
      .lean();
    res.json({ success: true, tasks });
  } catch {
    res.status(500).json({ success: false, message: "Failed to load tasks." });
  }
};

// POST /api/taskcalendar — create task (calendar modal)
export const createTask = async (req, res) => {
  try {
    const { title, due_date } = req.body;
    if (!title || !due_date) {
      return res.status(400).json({ success: false, message: "Title and due_date are required." });
    }

    const task = await TaskCalendar.create({
      title,
      due_date,
      time: req.body.time || "09:00",
      department: req.body.department || "Management",
      assigned_to: req.body.assigned_to || "",
      priority: req.body.priority || "Medium",
      status: req.body.status || "Pending",
      description: req.body.description || "",
      // ⭐⭐⭐ ISOLATION — stamped from TOKEN, never from body
      admin_id: req.adminId,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, message: "Task created.", task });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// POST /api/taskcalendar/import — CSV file import ⭐
export const importTasks = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No CSV file received." });
    }

    const { rows, errors } = parseTasksCSV(req.file.buffer.toString("utf8"));

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: errors[0] || "No valid tasks in CSV.",
        imported: 0,
        skipped: errors.length,
      });
    }

    // ⭐⭐⭐ ISOLATION — every imported row gets admin_id + createdBy stamped
    const stampedRows = rows.map((row) => ({
      ...row,
      admin_id: req.adminId,
      createdBy: req.user._id,
    }));

    const inserted = await TaskCalendar.insertMany(stampedRows, { ordered: false });

    res.status(201).json({
      success: true,
      message: `${inserted.length} task(s) imported.`,
      imported: inserted.length,
      skipped: errors.length,
      errors,
      first_date: inserted[0]?.due_date || null,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "Import failed." });
  }
};

// PUT /api/taskcalendar/:id — update task (edit modal)
export const updateTask = async (req, res) => {
  try {
    // ⭐⭐⭐ ID-PROOF — wrong admin/user gets "not found" even with correct ID
    const task = await TaskCalendar.findOne({ _id: req.params.id, ...req.scope });
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const allowed = ["title", "due_date", "time", "department", "assigned_to", "priority", "status", "description"];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) task[key] = req.body[key];
    });

    await task.save();
    res.json({ success: true, message: "Task updated.", task });
  } catch {
    res.status(400).json({ success: false, message: "Invalid task id." });
  }
};

// DELETE /api/taskcalendar/:id — delete task
export const deleteTask = async (req, res) => {
  try {
    // ⭐⭐⭐ ID-PROOF — scope included
    const task = await TaskCalendar.findOneAndDelete({ _id: req.params.id, ...req.scope });
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }
    res.json({ success: true, message: "Task deleted." });
  } catch {
    res.status(400).json({ success: false, message: "Invalid task id." });
  }
};