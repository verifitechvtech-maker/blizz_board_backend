
import mongoose from "mongoose";
import Task from "../models/Task.js";
import MonthlyProgress from "../models/MonthlyProgress.js";
import User from "../models/User.js";
import {
  MAX_DAILY_COUNT,
  buildDailyRows,
  isISODate,
  rangeOf,
  recalcMonthlyTotal,
  shapeMonthly,
  todayIn,
} from "../services/monthlyTaskService.js";

/* =========================================================
   Monthly Task — daily progress
   GET /api/tasks/:id/monthly        → every date from start to end (missing = 0) + summary
   PUT /api/tasks/:id/monthly/:date  → save one day's entry
   Who may edit (decided from the logged-in user's token, never from the request body):
     • the assigned user  → only TODAY's entry
     • the task's creator → any day of the task up to today (corrections)
     • everyone else      → read-only
   Each person's copy of a shared task has its own entries and totals.
========================================================= */

const sameId = (a, b) => Boolean(a && b) && String(a._id || a) === String(b._id || b);

const findMonthlyTask = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid task ID" });
    return null;
  }
  // req.scope keeps every organization (and every member's own tasks) separate
  const task = await Task.findOne({ _id: req.params.id, ...req.scope, isTaskBank: { $ne: true } })
    .populate("assignedTo", "name email department")
    .populate("assignedBy", "name email");
  if (!task) {
    res.status(404).json({ success: false, message: "Task not found" });
    return null;
  }
  if (task.taskType !== "monthly" || !task.monthly) {
    res.status(400).json({ success: false, message: "This is not a Monthly Task" });
    return null;
  }
  return task;
};

const userTimeZone = async (req) => {
  if (req.user?.preferences?.timezone) return req.user.preferences.timezone;
  const me = await User.findById(req.user._id).select("preferences.timezone").lean();
  return me?.preferences?.timezone;
};

// "creator" → any past day, "today" → only today, "none" → read-only
const editModeOf = (req, task) => {
  if (task.status === "Completed") return "none";
  if (sameId(task.assignedBy, req.user._id)) return "creator";
  if (sameId(task.assignedTo, req.user._id)) return "today";
  return "none";
};

const progressPayload = async (req, task) => {
  const { startDate, endDate } = rangeOf(task.monthly);
  const assigneeId = task.assignedTo?._id || task.assignedTo;
  // only the assignee's entries inside the task's dates
  const records = assigneeId
    ? await MonthlyProgress.find({
        task: task._id,
        user: assigneeId,
        date: { $gte: startDate, $lte: endDate },
      }).lean()
    : [];
  const editMode = editModeOf(req, task);

  return {
    task: {
      id: task._id,
      name: task.name,
      description: task.description,
      department: task.department,
      status: task.status,
      taskGroupId: task.taskGroupId || null,
      assignedTo: assigneeId || null,
      assignedUser: task.assignedTo?.name || "",
      assignedByName: task.assignedBy?.name || "",
    },
    monthly: shapeMonthly(task.monthly),
    days: buildDailyRows(task.monthly, records),
    // the assignee fills in today; the creator can correct earlier days; others only view
    editMode,
    canEdit: editMode !== "none",
    today: todayIn(await userTimeZone(req)),
  };
};

/* ==================== GET /api/tasks/:id/monthly ==================== */
export const getMonthlyProgress = async (req, res) => {
  try {
    const task = await findMonthlyTask(req, res);
    if (!task) return;
    res.json({ success: true, data: await progressPayload(req, task) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ==================== PUT /api/tasks/:id/monthly/:date ==================== */
export const updateMonthlyProgress = async (req, res) => {
  try {
    const task = await findMonthlyTask(req, res);
    if (!task) return;

    const assigneeId = task.assignedTo?._id || task.assignedTo;
    if (!assigneeId) {
      return res.status(400).json({ success: false, message: "This task has no assigned user." });
    }
    const isCreator = sameId(task.assignedBy, req.user._id);
    if (!isCreator && !sameId(assigneeId, req.user._id)) {
      return res.status(403).json({
        success: false,
        code: "ASSIGNEE_ONLY",
        message: "Only the assigned user (today's count) or the task's creator can update this progress.",
      });
    }
    if (task.status === "Completed") {
      return res.status(409).json({
        success: false,
        message: "This task is already completed, so its daily progress is locked.",
      });
    }

    // the date must be one of the task's days
    const { trackingMethod, unitPerCheck } = task.monthly;
    const { startDate, endDate } = rangeOf(task.monthly);
    const date = String(req.params.date || "");
    const realDate = isISODate(date);
    if (!realDate || date < startDate || date > endDate) {
      return res.status(400).json({ success: false, message: `Date must be between ${startDate} and ${endDate}` });
    }
    const today = todayIn(await userTimeZone(req));
    if (date > today) {
      return res.status(400).json({ success: false, message: "You cannot enter progress for a future date." });
    }
    // the assignee adds only today's count; earlier days can be corrected by the creator
    if (!isCreator && date !== today) {
      return res.status(403).json({
        success: false,
        code: "TODAY_ONLY",
        message: "You can only add today's count. Ask the task's creator to correct an earlier day.",
      });
    }

    const body = req.body || {};
    let count;
    let checked;
    if (trackingMethod === "checkbox") {
      if (typeof body.checked !== "boolean") {
        return res.status(400).json({ success: false, message: "Send checked: true or false for checkbox tracking." });
      }
      checked = body.checked;
      count = checked ? unitPerCheck || 1 : 0; // one ticked day = its units; unticked = nothing done
    } else {
      count = typeof body.count === "string" && body.count.trim() !== "" ? Number(body.count) : body.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return res.status(400).json({ success: false, message: "Daily count must be a whole number of 0 or more." });
      }
      if (count > MAX_DAILY_COUNT) {
        return res.status(400).json({ success: false, message: `Daily count cannot be more than ${MAX_DAILY_COUNT}.` });
      }
      checked = count > 0;
    }

    const update = { count, checked, admin_id: task.admin_id || null, updatedBy: req.user._id };
    if (body.remarks !== undefined) {
      if (typeof body.remarks !== "string" || body.remarks.length > 500) {
        return res.status(400).json({ success: false, message: "Remarks must be text of at most 500 characters." });
      }
      update.remarks = body.remarks.trim();
    }

    // the entry always belongs to the task's assignee (from the task, not from the request)
    const key = { task: task._id, user: assigneeId, date };
    const save = () => MonthlyProgress.findOneAndUpdate(key, { $set: update }, { upsert: true, new: true, runValidators: true });
    try {
      await save();
    } catch (err) {
      if (err.code !== 11000) throw err;
      await save(); // two saves at the same moment → the second one updates the row the first created
    }

    task.monthly.totalCompleted = await recalcMonthlyTotal(task._id, assigneeId);
    res.json({ success: true, message: "Progress saved", data: await progressPayload(req, task) });
  } catch (error) {
    const status = error.name === "ValidationError" || error.name === "CastError" ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
};
