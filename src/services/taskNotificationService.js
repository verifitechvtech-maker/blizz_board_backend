// Task notifications — email + in-app (dashboard) for:
//   • assignment                    → assignee
//   • 3h / 1h before deadline       → assignee (only while the task is still "To Do")
//   • deadline reached, not started → assignee AND the person who assigned it
//   • status change                 → the person who assigned it (shows who changed it)
import { DateTime } from "luxon";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { send, layout, button, escapeHtml, frontendUrl } from "./accountEmailService.js";
import { actionLink, createActionToken, emailStatusOptions } from "./taskEmailActionService.js";

export const TASK_TIME_ZONE =
  process.env.TASK_TIME_ZONE || process.env.MEETING_TIME_ZONE || "Asia/Kolkata";

const HOUR = 60 * 60 * 1000;
// A deadline missed longer ago than this is never alerted (e.g. old tasks when the job first starts)
export const OVERDUE_ALERT_WINDOW_MS = 2 * HOUR;

/**
 * Deadline = due date + due time in TASK_TIME_ZONE.
 * No due time → end of that day (23:59). No due date → null (no reminders).
 */
export const deadlineOf = (task) => {
  if (!task?.dueDate) return null;
  const day = new Date(task.dueDate).toISOString().slice(0, 10);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime || "") ? task.dueTime : "23:59";
  const dt = DateTime.fromISO(`${day}T${time}`, { zone: TASK_TIME_ZONE });
  return dt.isValid ? dt.toJSDate() : null;
};

const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Start = start date + start time (no time → start of that day). No start date → null. */
export const startOf = (task) => {
  if (!task?.startDate) return null;
  const day = new Date(task.startDate).toISOString().slice(0, 10);
  const time = TIME_RX.test(task.startTime || "") ? task.startTime : "00:00";
  const dt = DateTime.fromISO(`${day}T${time}`, { zone: TASK_TIME_ZONE });
  return dt.isValid ? dt.toJSDate() : null;
};

export const REMINDER_OPTIONS = ["none", "at_start", "before_15m", "before_1h", "before_1d", "custom"];
const REMINDER_BEFORE = { before_15m: 15 * 60 * 1000, before_1h: HOUR, before_1d: 24 * HOUR };

/**
 * When the chosen reminder goes out. Returns { at } (null = no reminder) or { error }.
 * custom = "YYYY-MM-DDTHH:mm" in TASK_TIME_ZONE.
 */
export const reminderTimeOf = (task, option = "none", customAt = "") => {
  if (!REMINDER_OPTIONS.includes(option)) return { error: "Choose a valid reminder" };
  if (option === "none") return { at: null };
  if (option === "custom") {
    if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(customAt || "")) {
      return { error: "Pick the date and time for the custom reminder" };
    }
    const dt = DateTime.fromISO(customAt, { zone: TASK_TIME_ZONE });
    return dt.isValid ? { at: dt.toJSDate() } : { error: "Pick a valid reminder date and time" };
  }
  if (option === "at_start") {
    const start = startOf(task);
    return start ? { at: start } : { error: "Set a start date to be reminded at the start" };
  }
  const deadline = deadlineOf(task);
  return deadline ? { at: new Date(deadline.getTime() - REMINDER_BEFORE[option]) } : { error: "Set an end date for this reminder" };
};

const formatDeadline = (date) =>
  DateTime.fromJSDate(date).setZone(TASK_TIME_ZONE).toFormat("dd LLL yyyy, hh:mm a");

const wantsEmail = (user, kind) => {
  const prefs = user?.preferences || {};
  if (user?.status === "Inactive") return false;
  if (kind === "reminder") return prefs.taskReminders !== false && prefs.emailNotifications !== false;
  return prefs.emailNotifications !== false;
};

const taskLink = () => `${frontendUrl()}/dashboard/tasks`;

const detailsHtml = (task, deadline) => `
  <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:13px">
    <tr><td style="padding:6px 0;color:#6E8799;width:120px">Task</td><td style="padding:6px 0"><strong>${escapeHtml(task.name)}</strong></td></tr>
    ${task.department ? `<tr><td style="padding:6px 0;color:#6E8799">Department</td><td>${escapeHtml(task.department)}</td></tr>` : ""}
    <tr><td style="padding:6px 0;color:#6E8799">Priority</td><td>${escapeHtml(task.priority || "Medium")}</td></tr>
    <tr><td style="padding:6px 0;color:#6E8799">Deadline</td><td>${deadline ? escapeHtml(formatDeadline(deadline)) : "Not set"}</td></tr>
    <tr><td style="padding:6px 0;color:#6E8799">Status</td><td>${escapeHtml(task.status)}</td></tr>
  </table>`;

const detailsText = (task, deadline) =>
  `Task: ${task.name}\nPriority: ${task.priority || "Medium"}\nDeadline: ${
    deadline ? formatDeadline(deadline) : "Not set"
  }\nStatus: ${task.status}\nOpen: ${taskLink()}`;

// Buttons in the assignment email: update the task without logging in (confirmed on the task page)
const emailActionsHtml = (task, assigneeId) => {
  const token = createActionToken(task, assigneeId);
  const options = emailStatusOptions(task);
  const small = (href, label, color) =>
    `<a href="${href}" style="background:${color};color:#fff;text-decoration:none;padding:10px 16px;border-radius:9px;font-weight:700;display:inline-block;margin:0 6px 8px 0">${escapeHtml(label)}</a>`;
  return `
    <div style="margin:18px 0;padding:14px;border:1px solid #D5E7EE;border-radius:12px;background:#F7FBFC">
      <div style="font-size:12px;font-weight:700;color:#264b64;margin-bottom:10px">Update this task straight from your email</div>
      ${small(actionLink(token), "View task", "#123B5D")}
      ${options.includes("In Progress") ? small(actionLink(token, "In Progress"), "Start working", "#16A6B8") : ""}
      ${options.includes("Review") ? small(actionLink(token, "Review"), "Send for review", "#0b8f87") : ""}
      <div style="font-size:11px;color:#6E8799;margin-top:4px">Your update shows in the application straight away. The link works for 30 days.</div>
    </div>`;
};
const emailActionsText = (task, assigneeId) =>
  `\nView or update this task from your email: ${actionLink(createActionToken(task, assigneeId))}`;

const notify = (data) => Notification.create(data).catch((e) => console.error("[notify]", e.message));

// Never let a notification problem break the request that triggered it
const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error("[taskNotification]", err.message);
    return null;
  }
};

// ==================== ASSIGNMENT ====================
export const notifyTaskAssigned = safe(async (taskOrId, assignerId) => {
  // Always reload (ObjectIds also expose ._id, so don't guess the argument type)
  const task = await Task.findById(taskOrId?._id || taskOrId);
  if (!task?.assignedTo || task.isTaskBank) return;

  // Claim → each assignment is announced once
  const claimed = await Task.updateOne(
    { _id: task._id, "notifications.assignedAt": null },
    { $set: { "notifications.assignedAt": new Date() } }
  );
  if (!claimed.modifiedCount) return;

  const [assignee, assigner] = await Promise.all([
    User.findById(task.assignedTo).select("name email status preferences"),
    User.findById(assignerId || task.assignedBy).select("name"),
  ]);
  if (!assignee) return;

  const selfAssigned = String(assignee._id) === String(assigner?._id);
  const deadline = deadlineOf(task);
  const by = assigner?.name || "your administrator";

  await notify({
    recipient: assignee._id,
    admin_id: task.admin_id,
    type: "task_assigned",
    task: task._id,
    taskName: task.name,
    actor: assigner?._id || null,
    actorName: assigner?.name || "",
    message: selfAssigned ? `You created "${task.name}"` : `${by} assigned you "${task.name}"`,
  });

  if (selfAssigned || !wantsEmail(assignee, "general")) return;
  await send({
    to: assignee.email,
    subject: `New task assigned: ${task.name}`,
    text: `Hi ${assignee.name},\n\n${by} assigned you a new task.\n\n${detailsText(task, deadline)}${emailActionsText(task, assignee._id)}`,
    html: layout("New task assigned", `
      <p>Hi <strong>${escapeHtml(assignee.name)}</strong>,</p>
      <p><strong>${escapeHtml(by)}</strong> assigned you a new task.</p>
      ${detailsHtml(task, deadline)}
      ${task.description ? `<p style="color:#4f6f7a">${escapeHtml(task.description)}</p>` : ""}
      ${emailActionsHtml(task, assignee._id)}
      ${button(taskLink(), "Open my tasks")}`),
  });
});

// ==================== REASSIGNMENT ====================
// New assignee: "reassigned to you". Previous assignee: "reassigned to <name>" (or "removed").
export const notifyTaskReassigned = safe(async (taskId, previousAssigneeId, actorId) => {
  const task = await Task.findById(taskId);
  if (!task || task.isTaskBank) return;

  const [actor, previous, current] = await Promise.all([
    User.findById(actorId).select("name"),
    previousAssigneeId ? User.findById(previousAssigneeId).select("name email status preferences") : null,
    task.assignedTo ? User.findById(task.assignedTo).select("name email status preferences") : null,
  ]);
  const by = actor?.name || "An administrator";
  const deadline = deadlineOf(task);

  // The new person counts as "assigned" — no extra plain assignment email later
  await Task.updateOne({ _id: task._id }, { $set: { "notifications.assignedAt": new Date() } });

  if (current && String(current._id) !== String(actorId)) {
    const message = `${by} reassigned "${task.name}" to you${previous ? ` (previously ${previous.name})` : ""}`;
    await notify({
      recipient: current._id, admin_id: task.admin_id, type: "task_reassigned",
      task: task._id, taskName: task.name, actor: actor?._id || null, actorName: actor?.name || "", message,
    });
    if (wantsEmail(current, "general")) {
      await send({
        to: current.email,
        subject: `Task reassigned to you: ${task.name}`,
        text: `Hi ${current.name},\n\n${message}.\n\n${detailsText(task, deadline)}${emailActionsText(task, current._id)}`,
        html: layout("Task has been reassigned to you", `
          <p>Hi <strong>${escapeHtml(current.name)}</strong>,</p>
          <p><strong>${escapeHtml(by)}</strong> reassigned this task to you${
            previous ? ` (previously assigned to <strong>${escapeHtml(previous.name)}</strong>)` : ""}.</p>
          ${detailsHtml(task, deadline)}
          ${task.description ? `<p style="color:#4f6f7a">${escapeHtml(task.description)}</p>` : ""}
          ${emailActionsHtml(task, current._id)}
          ${button(taskLink(), "Open my tasks")}`),
      });
    }
  }

  if (previous && String(previous._id) !== String(current?._id) && String(previous._id) !== String(actorId)) {
    const message = current
      ? `${by} reassigned "${task.name}" to ${current.name} — it is no longer assigned to you`
      : `${by} removed you from "${task.name}" — it is no longer assigned to you`;
    await notify({
      recipient: previous._id, admin_id: task.admin_id, type: "task_reassigned",
      task: task._id, taskName: task.name, actor: actor?._id || null, actorName: actor?.name || "", message,
    });
    if (wantsEmail(previous, "general")) {
      await send({
        to: previous.email,
        subject: current
          ? `Task reassigned: ${task.name} → ${current.name}`
          : `Task reassigned: you were removed from ${task.name}`,
        text: `Hi ${previous.name},\n\n${message}. You don't need to work on it any more.\n\nTask: ${task.name}`,
        html: layout("Task has been reassigned", `
          <p>Hi <strong>${escapeHtml(previous.name)}</strong>,</p>
          <p><strong>${escapeHtml(by)}</strong> reassigned <strong>${escapeHtml(task.name)}</strong>${
            current ? ` to <strong>${escapeHtml(current.name)}</strong>` : ""}.
          It is no longer assigned to you, so you don't need to work on it any more.</p>
          ${button(taskLink(), "View my tasks")}`),
      });
    }
  }
});

// ==================== STATUS CHANGE ====================
// Tells the person who assigned the task (the "manager") who changed what.
export const notifyStatusChanged = safe(async (task, actor, from, to, note = "") => {
  if (!task?.assignedBy || String(task.assignedBy) === String(actor._id)) return;

  const manager = await User.findById(task.assignedBy).select("name email status preferences");
  if (!manager) return;

  const message = `${actor.name} changed "${task.name}" from ${from} to ${to}${note ? ` — Comment: ${note}` : ""}`;
  await notify({
    recipient: manager._id,
    admin_id: task.admin_id,
    type: "task_status",
    task: task._id,
    taskName: task.name,
    actor: actor._id,
    actorName: actor.name,
    fromStatus: from,
    toStatus: to,
    message,
  });

  if (!wantsEmail(manager, "general")) return;
  const deadline = deadlineOf(task);
  await send({
    to: manager.email,
    subject: `${actor.name} moved "${task.name}" to ${to}`,
    text: `Hi ${manager.name},\n\n${message}.\n\n${detailsText(task, deadline)}`,
    html: layout("Task status updated", `
      <p>Hi <strong>${escapeHtml(manager.name)}</strong>,</p>
      <p><strong>${escapeHtml(actor.name)}</strong> changed the status of
      <strong>${escapeHtml(task.name)}</strong>:</p>
      <p style="font-size:15px"><span style="color:#6E8799">${escapeHtml(from)}</span> → <strong style="color:#0b8f87">${escapeHtml(to)}</strong></p>
      ${note ? `<p style="padding:10px 12px;border-left:3px solid #1677A8;background:#EEF6FF"><strong>Comment:</strong> ${escapeHtml(note)}</p>` : ""}
      ${detailsHtml(task, deadline)}
      ${button(taskLink(), "View task")}`),
  });
});

// ==================== REVIEW RESULT → assignee ====================
// decision "completed": the assigner approved the work → reward + new score
// decision "rework":    the assigner sent it back from Review (with the reason)
export const notifyReviewDecision = safe(async (task, actor, { decision, reward = 0, score = null, note = "", celebration = null }) => {
  if (!task?.assignedTo || String(task.assignedTo) === String(actor._id)) return;

  const assignee = await User.findById(task.assignedTo).select("name email status preferences points");
  if (!assignee) return;

  const completed = decision === "completed";
  const total = score ?? assignee.points ?? 0;
  const extras = completed && celebration
    ? [
        celebration.levelUp ? ` Level up: ${celebration.level.icon} ${celebration.level.name}!` : "",
        ...(celebration.newBadges || []).map((b) => ` New badge: ${b.icon} ${b.name}.`),
      ].join("")
    : "";
  const message = completed
    ? `${actor.name} approved "${task.name}" with a score of ${reward}/10 — your task is completed. +${reward} points, your total score is now ${total}.${extras}${note ? ` Comment: ${note}` : ""}`
    : `${actor.name} sent "${task.name}" back for rework${note ? `: ${note}` : "."}`;

  await notify({
    recipient: assignee._id,
    admin_id: task.admin_id,
    type: completed ? "task_completed" : "task_rework",
    task: task._id,
    taskName: task.name,
    actor: actor._id,
    actorName: actor.name,
    fromStatus: "Review",
    toStatus: task.status,
    message,
    celebration: completed ? celebration : null,
  });

  if (!wantsEmail(assignee, "general")) return;
  const deadline = deadlineOf(task);
  await send({
    to: assignee.email,
    subject: completed ? `✅ "${task.name}" is completed — scored ${reward}/10` : `↺ Rework needed: "${task.name}"`,
    text: `Hi ${assignee.name},\n\n${message}\n\n${detailsText(task, deadline)}`,
    html: layout(completed ? "Your task is completed" : "Rework requested", `
      <p>Hi <strong>${escapeHtml(assignee.name)}</strong>,</p>
      ${
        completed
          ? `<p><strong>${escapeHtml(actor.name)}</strong> reviewed and approved <strong>${escapeHtml(task.name)}</strong>.</p>
             <p style="font-size:15px">Score: <strong style="color:#0b8f87">${reward}/10</strong> · +${reward} points · Your total: <strong style="color:#0b8f87">${total}</strong></p>
             ${note ? `<p style="padding:10px 12px;border-left:3px solid #16a34a;background:#f0fdf4"><strong>Comment:</strong> ${escapeHtml(note)}</p>` : ""}`
          : `<p><strong>${escapeHtml(actor.name)}</strong> reviewed <strong>${escapeHtml(task.name)}</strong> and sent it back for rework.</p>
             ${note ? `<p style="padding:10px 12px;border-left:3px solid #f59e0b;background:#fffbeb">${escapeHtml(note)}</p>` : ""}`
      }
      ${detailsHtml(task, deadline)}
      ${button(taskLink(), "View task")}`),
  });
});

// ==================== TASK COMMENT → the other person (assigner ↔ assignee) ====================
export const notifyTaskComment = safe(async (task, actor, text) => {
  const ids = [task?.assignedTo, task?.assignedBy]
    .filter(Boolean)
    .map(String)
    .filter((id, i, all) => id !== String(actor._id) && all.indexOf(id) === i);
  if (!ids.length) return;

  const people = await User.find({ _id: { $in: ids } }).select("name email status preferences");
  const message = `${actor.name} commented on "${task.name}": ${text}`;
  for (const person of people) {
    await notify({
      recipient: person._id,
      admin_id: task.admin_id,
      type: "task_comment",
      task: task._id,
      taskName: task.name,
      actor: actor._id,
      actorName: actor.name,
      toStatus: task.status,
      message,
    });
    if (!wantsEmail(person, "general")) continue;
    await send({
      to: person.email,
      subject: `💬 ${actor.name} commented on "${task.name}"`,
      text: `Hi ${person.name},\n\n${message}\n\nView task: ${taskLink()}`,
      html: layout("New comment on a task", `
        <p>Hi <strong>${escapeHtml(person.name)}</strong>,</p>
        <p><strong>${escapeHtml(actor.name)}</strong> commented on <strong>${escapeHtml(task.name)}</strong>:</p>
        <p style="padding:10px 12px;border-left:3px solid #1677A8;background:#EEF6FF;white-space:pre-wrap">${escapeHtml(text)}</p>
        ${button(taskLink(), "View task")}`),
    });
  }
});

// ==================== SUBTASK ASSIGNED → assignee (dashboard only) ====================
export const notifySubtaskAssigned = safe(async (task, actor, title, assigneeId = task?.assignedTo) => {
  if (!assigneeId || String(assigneeId) === String(actor._id)) return;
  await notify({
    recipient: assigneeId,
    admin_id: task.admin_id,
    type: "task_subtask",
    task: task._id,
    taskName: task.name,
    actor: actor._id,
    actorName: actor.name,
    message: `${actor.name} assigned you a subtask in "${task.name}": ${title}`,
  });
});

// ==================== REMINDER SWEEP (runs every minute) ====================
const REMINDERS = {
  reminder3hAt: { label: "3 hours", n: 1 },
  reminder1hAt: { label: "1 hour", n: 2 },
};

const claim = async (task, field, alsoSet = {}) => {
  const res = await Task.updateOne(
    { _id: task._id, status: "To Do", [`notifications.${field}`]: null },
    { $set: { [`notifications.${field}`]: new Date(), ...alsoSet } }
  );
  return res.modifiedCount === 1;
};

const sendReminder = async (task, field, deadline) => {
  const { label, n } = REMINDERS[field];
  const user = await User.findById(task.assignedTo).select("name email status preferences");
  if (!user) return;

  await notify({
    recipient: user._id,
    admin_id: task.admin_id,
    type: "task_reminder",
    task: task._id,
    taskName: task.name,
    message: `Reminder ${n}: "${task.name}" is due in ${label} and has not been started`,
  });

  if (!wantsEmail(user, "reminder")) return;
  await send({
    to: user.email,
    subject: `Reminder ${n}: "${task.name}" is due in ${label}`,
    text: `Hi ${user.name},\n\nYour task has not been started and is due in ${label}.\n\n${detailsText(task, deadline)}`,
    html: layout(`Reminder ${n} — due in ${label}`, `
      <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
      <p>Your task has <strong>not been started</strong> yet and its deadline is in <strong>${label}</strong>.</p>
      ${detailsHtml(task, deadline)}
      ${button(taskLink(), "Start the task")}`),
  });
};

const sendOverdueAlerts = async (task, deadline) => {
  const [user, manager] = await Promise.all([
    User.findById(task.assignedTo).select("name email status preferences"),
    task.assignedBy ? User.findById(task.assignedBy).select("name email status preferences") : null,
  ]);
  if (!user) return;

  await notify({
    recipient: user._id,
    admin_id: task.admin_id,
    type: "task_overdue",
    task: task._id,
    taskName: task.name,
    message: `Deadline reached: "${task.name}" has not been started — please start it now`,
  });
  if (wantsEmail(user, "reminder")) {
    await send({
      to: user.email,
      subject: `⚠ Deadline reached: please start "${task.name}"`,
      text: `Hi ${user.name},\n\nThe deadline for this task has arrived and it has not been started. Please start it now.\n\n${detailsText(task, deadline)}`,
      html: layout("Deadline reached — task not started", `
        <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
        <p style="color:#A83C55"><strong>The deadline has arrived and this task has not been started.</strong> Please start it now.</p>
        ${detailsHtml(task, deadline)}
        ${button(taskLink(), "Start the task now")}`),
    });
  }

  // Manager = whoever assigned it (skip when the user assigned it to himself)
  if (!manager || String(manager._id) === String(user._id)) return;
  await notify({
    recipient: manager._id,
    admin_id: task.admin_id,
    type: "task_overdue",
    task: task._id,
    taskName: task.name,
    actor: user._id,
    actorName: user.name,
    message: `${user.name} has not started "${task.name}" and its deadline has passed`,
  });
  if (wantsEmail(manager, "general")) {
    await send({
      to: manager.email,
      subject: `⚠ ${user.name} has not started "${task.name}" (deadline reached)`,
      text: `Hi ${manager.name},\n\n${user.name} has not started this task and the deadline has arrived.\n\n${detailsText(task, deadline)}`,
      html: layout("Alert — task not started at deadline", `
        <p>Hi <strong>${escapeHtml(manager.name)}</strong>,</p>
        <p><strong>${escapeHtml(user.name)}</strong> has <strong>not started</strong> this task and its deadline has arrived.</p>
        ${detailsHtml(task, deadline)}
        ${button(taskLink(), "View task")}`),
    });
  }
};

// The reminder the assigner chose (any status except Completed)
const sendChosenReminder = async (task, now) => {
  const user = await User.findById(task.assignedTo).select("name email status preferences");
  if (!user) return;
  const deadline = deadlineOf(task);
  const start = startOf(task);
  const when =
    start && start.getTime() > now.getTime()
      ? `starts ${formatDeadline(start)}`
      : deadline
        ? `is due ${formatDeadline(deadline)}`
        : "needs your attention";
  await notify({
    recipient: user._id,
    admin_id: task.admin_id,
    type: "task_reminder",
    task: task._id,
    taskName: task.name,
    message: `Reminder: "${task.name}" ${when}`,
  });
  if (!wantsEmail(user, "reminder")) return;
  await send({
    to: user.email,
    subject: `Reminder: "${task.name}" ${when}`,
    text: `Hi ${user.name},\n\nThis is the reminder set for your task: it ${when}.\n\n${detailsText(task, deadline)}`,
    html: layout("Task reminder", `
      <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
      <p>This is the reminder set for your task — it <strong>${escapeHtml(when)}</strong>.</p>
      ${detailsHtml(task, deadline)}
      ${button(taskLink(), "Open the task")}`),
  });
};

export const MAX_TASK_REMINDERS = 10;

/**
 * Named reminders from the form: [{ _id?, title, customAt: "YYYY-MM-DDTHH:mm" }].
 * Keeps `sentAt` of a reminder whose title and time did not change. Returns { reminders } or { error }.
 */
export const parseReminders = (input, existing = []) => {
  if (!Array.isArray(input)) return { error: "Reminders must be a list" };
  if (input.length > MAX_TASK_REMINDERS) return { error: `Add at most ${MAX_TASK_REMINDERS} reminders` };
  const out = [];
  for (const [i, r] of input.entries()) {
    const title = String(r?.title || "").trim();
    const customAt = String(r?.customAt || "").trim();
    if (!title) return { error: `Give reminder ${i + 1} a title` };
    if (title.length > 120) return { error: `Reminder ${i + 1}: the title can be at most 120 characters` };
    const parsed = reminderTimeOf({}, "custom", customAt);
    if (parsed.error) return { error: `Reminder ${i + 1}: pick its date and time` };
    const before = existing.find((e) => (r?._id && String(e._id) === String(r._id)) || (e.title === title && e.customAt === customAt));
    const unchanged = before && before.title === title && before.customAt === customAt;
    out.push({
      ...(before?._id ? { _id: before._id } : {}),
      title,
      customAt,
      at: parsed.at,
      sentAt: unchanged ? before.sentAt || null : null,
    });
  }
  return { reminders: out };
};

const sendNamedReminder = async (task, reminder) => {
  const user = await User.findById(task.assignedTo).select("name email status preferences");
  if (!user) return;
  const deadline = deadlineOf(task);
  await notify({
    recipient: user._id,
    admin_id: task.admin_id,
    type: "task_reminder",
    task: task._id,
    taskName: task.name,
    // the form names the reminder after the task → don't repeat the name
    message: reminder.title === task.name ? `Reminder: "${task.name}"` : `Reminder: ${reminder.title} — task "${task.name}"`,
  });
  if (!wantsEmail(user, "reminder")) return;
  await send({
    to: user.email,
    subject: `Reminder: ${reminder.title} (${task.name})`,
    text: `Hi ${user.name},\n\nReminder: ${reminder.title}\n\n${detailsText(task, deadline)}`,
    html: layout(`Reminder: ${escapeHtml(reminder.title)}`, `
      <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
      <p>Reminder: <strong>${escapeHtml(reminder.title)}</strong></p>
      ${detailsHtml(task, deadline)}
      ${button(taskLink(), "Open the task")}`),
  });
};

/** Reminders chosen in the task form whose time has come (sent once, within 2 hours). */
export const runChosenReminderSweep = async (now = new Date()) => {
  const due = await Task.find({
    isTaskBank: { $ne: true },
    assignedTo: { $ne: null },
    status: { $ne: "Completed" },
    "reminder.at": { $lte: now, $gte: new Date(now.getTime() - OVERDUE_ALERT_WINDOW_MS) },
    "reminder.sentAt": null,
  }).lean();
  let sent = 0;

  // named reminders (each one on its own)
  const windowStart = new Date(now.getTime() - OVERDUE_ALERT_WINDOW_MS);
  const withNamed = await Task.find({
    isTaskBank: { $ne: true },
    assignedTo: { $ne: null },
    status: { $ne: "Completed" },
    reminders: { $elemMatch: { at: { $lte: now, $gte: windowStart }, sentAt: null } },
  }).lean();
  for (const task of withNamed) {
    for (const r of task.reminders || []) {
      const time = new Date(r.at).getTime();
      if (r.sentAt || time > now.getTime() || time < windowStart.getTime()) continue;
      const claimed = await Task.updateOne(
        { _id: task._id, reminders: { $elemMatch: { _id: r._id, sentAt: null } } },
        { $set: { "reminders.$.sentAt": now } }
      );
      if (claimed.modifiedCount !== 1) continue;
      try {
        await sendNamedReminder(task, r);
        sent += 1;
      } catch (err) {
        console.error(`[taskReminder] reminder ${r._id}:`, err.message);
      }
    }
  }

  for (const task of due) {
    // claim first so two runs never send the same reminder
    const claimed = await Task.updateOne({ _id: task._id, "reminder.sentAt": null }, { $set: { "reminder.sentAt": now } });
    if (claimed.modifiedCount !== 1) continue;
    try {
      await sendChosenReminder(task, now);
      sent += 1;
    } catch (err) {
      console.error(`[taskReminder] chosen reminder ${task._id}:`, err.message);
    }
  }
  return sent;
};

/**
 * One pass over not-started tasks. `now` is injectable for tests.
 * Returns { reminder3h, reminder1h, overdue } counts.
 */
export const runTaskReminderSweep = async (now = new Date()) => {
  const counts = { reminder3h: 0, reminder1h: 0, overdue: 0 };

  // Due dates are whole days — look 2 days around now, then use the exact deadline
  const tasks = await Task.find({
    status: "To Do",
    isTaskBank: { $ne: true },
    assignedTo: { $ne: null },
    dueDate: { $gte: new Date(now.getTime() - 2 * 24 * HOUR), $lte: new Date(now.getTime() + 2 * 24 * HOUR) },
    "notifications.overdueAlertAt": null,
  }).lean();

  for (const task of tasks) {
    const deadline = deadlineOf(task);
    if (!deadline) continue;
    const left = deadline.getTime() - now.getTime();
    const n = task.notifications || {};

    try {
      if (left <= 0) {
        if (-left <= OVERDUE_ALERT_WINDOW_MS &&
            (await claim(task, "overdueAlertAt", {
              "notifications.reminder3hAt": n.reminder3hAt || now,
              "notifications.reminder1hAt": n.reminder1hAt || now,
            }))) {
          await sendOverdueAlerts(task, deadline);
          counts.overdue += 1;
        }
      } else if (left <= HOUR) {
        if (!n.reminder1hAt &&
            (await claim(task, "reminder1hAt", { "notifications.reminder3hAt": n.reminder3hAt || now }))) {
          await sendReminder(task, "reminder1hAt", deadline);
          counts.reminder1h += 1;
        }
      } else if (left <= 3 * HOUR) {
        if (!n.reminder3hAt && (await claim(task, "reminder3hAt"))) {
          await sendReminder(task, "reminder3hAt", deadline);
          counts.reminder3h += 1;
        }
      }
    } catch (err) {
      console.error(`[taskReminder] task ${task._id}:`, err.message);
    }
  }
  return counts;
};
