// Public task page opened from the assignment email (token in the URL, no login)
//   GET  /api/task-email/:token          → task summary + the statuses the assignee may pick
//   POST /api/task-email/:token/view     → "viewed" (sent by the page's script, not by mail scanners)
//   POST /api/task-email/:token/status   { status, note } → update the status (same rules as the app)
// Errors never use 401 — the frontend treats 401 as "log out".
import Task from "../models/Task.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { emitToUser } from "../socket/realtime.js";
import { notifyStatusChanged } from "../services/taskNotificationService.js";
import { emailStatusOptions, readActionToken } from "../services/taskEmailActionService.js";

const INVALID = "This task link is not valid or has expired. Open the task from the application instead.";

// Token → the task, still assigned to the person the email was sent to
const loadFromToken = async (req, res) => {
  const data = readActionToken(req.params.token);
  if (!data) {
    res.status(410).json({ success: false, message: INVALID });
    return null;
  }
  const [task, user] = await Promise.all([
    Task.findById(data.taskId),
    User.findById(data.userId).select("name email status"),
  ]);
  if (!task || !user || user.status === "Inactive") {
    res.status(410).json({ success: false, message: INVALID });
    return null;
  }
  if (String(task.assignedTo || "") !== String(user._id)) {
    res.status(403).json({ success: false, message: "This task has been reassigned — this email link no longer works." });
    return null;
  }
  return { task, user };
};

const summary = async (task, user) => {
  const assigner = task.assignedBy ? await User.findById(task.assignedBy).select("name") : null;
  return {
    id: task._id,
    name: task.name,
    referenceId: task.referenceId || "",
    description: task.description || "",
    priority: task.priority || "Medium",
    department: task.departments?.length ? task.departments.join(", ") : task.department || "",
    startDate: task.startDate || null,
    dueDate: task.dueDate || null,
    dueTime: task.dueTime || "",
    status: task.status,
    assignee: user.name,
    assignedBy: assigner?.name || "",
    options: emailStatusOptions(task),
    history: (task.statusHistory || []).slice(-5).reverse().map((h) => ({
      from: h.from, to: h.to, by: h.changedByName, note: h.note, at: h.changedAt,
    })),
  };
};

// Both people's open app tabs refresh their task list
const announce = (task) => {
  const payload = { taskId: String(task._id), status: task.status };
  emitToUser(task.assignedTo, "task:changed", payload);
  if (task.assignedBy) emitToUser(task.assignedBy, "task:changed", payload);
};

export const getEmailTask = async (req, res) => {
  try {
    const found = await loadFromToken(req, res);
    if (!found) return;
    res.json({ success: true, data: await summary(found.task, found.user) });
  } catch (error) {
    console.error("[taskEmail] get:", error.message);
    res.status(500).json({ success: false, message: "Could not load the task." });
  }
};

export const markEmailTaskViewed = async (req, res) => {
  try {
    const found = await loadFromToken(req, res);
    if (!found) return;
    const { task, user } = found;
    const now = new Date();
    // first view → claim it atomically so the assigner hears about it only once
    const first = await Task.updateOne(
      { _id: task._id, "emailActivity.viewedAt": null },
      { $set: { "emailActivity.viewedAt": now, "emailActivity.lastViewedAt": now } }
    );
    if (first.modifiedCount) {
      if (task.assignedBy && String(task.assignedBy) !== String(user._id)) {
        await Notification.create({
          recipient: task.assignedBy,
          admin_id: task.admin_id,
          type: "task_viewed",
          task: task._id,
          taskName: task.name,
          actor: user._id,
          actorName: user.name,
          message: `${user.name} opened "${task.name}" from the email`,
        }).catch((e) => console.error("[taskEmail] notify:", e.message));
      }
      announce(task);
    } else {
      await Task.updateOne({ _id: task._id }, { $set: { "emailActivity.lastViewedAt": now } });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("[taskEmail] view:", error.message);
    res.status(500).json({ success: false, message: "Could not record the view." });
  }
};

export const updateEmailTaskStatus = async (req, res) => {
  try {
    const found = await loadFromToken(req, res);
    if (!found) return;
    const { task, user } = found;
    const status = String(req.body?.status || "");
    const note = String(req.body?.note || "").trim().slice(0, 1000);

    if (task.status === status) {
      return res.json({ success: true, message: `The task is already "${status}".`, data: await summary(task, user) });
    }
    const allowed = emailStatusOptions(task);
    if (!allowed.includes(status)) {
      return res.status(409).json({
        success: false,
        message: task.status === "Completed"
          ? "This task is already completed."
          : task.status === "Review"
          ? "This task is waiting for review by the person who assigned it."
          : `From the email you can move this task to: ${allowed.join(", ")}.`,
        data: await summary(task, user),
      });
    }

    const from = task.status;
    const now = new Date();
    task.status = status;
    task.statusHistory.push({
      from,
      to: status,
      changedBy: user._id,
      changedByName: user.name,
      note: `Updated from email${note ? `: ${note}` : ""}`,
    });
    task.completedAt = null;
    task.reviewScore = null;
    task.emailActivity = {
      viewedAt: task.emailActivity?.viewedAt || now,
      lastViewedAt: now,
      lastUpdateAt: now,
    };
    await task.save();

    // Same notification as an update in the app (dashboard + email to the assigner)
    notifyStatusChanged(task, { _id: user._id, name: user.name }, from, status);
    announce(task);

    res.json({
      success: true,
      message: `Status updated: "${from}" → "${status}". ${task.assignedBy ? "The person who assigned it has been notified." : ""}`.trim(),
      data: await summary(task, user),
    });
  } catch (error) {
    console.error("[taskEmail] status:", error.message);
    res.status(500).json({ success: false, message: "Could not update the task." });
  }
};
