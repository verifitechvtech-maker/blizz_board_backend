// Individual (per-person) reports: assigned / completed / pending / in progress / overdue,
// on-time rate and average completion time — for every user of the requester's organization.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { parseDateRange } from "../utils/dateRange.js";
import { MEMBER_ROLES, ROLE_LABELS } from "../config/permissions.js";
import { deadlineOf, startOf } from "../services/taskNotificationService.js";

const DAY_MS = 86400000;
const round1 = (n) => Math.round(n * 10) / 10;

// "3 days 4 hours" / "5 hours" / "20 minutes"
const humanDuration = (ms) => {
  if (ms === null || ms === undefined || ms < 0) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  return parts.join(" ") || "under an hour";
};

const firstChange = (history, to) => (history || []).find((h) => h.to === to)?.changedAt || null;
const lastChange = (history, to) => [...(history || [])].reverse().find((h) => h.to === to)?.changedAt || null;

/**
 * Everything about one task for the individual report:
 * dates (assigned / start / deadline / started / sent for review / completed),
 * how long it took, on time or late, review score, rework, subtasks, checklist, comments.
 */
const taskDetail = (t, now = new Date()) => {
  const history = t.statusHistory || [];
  const assignedAt = t.assignedAt || t.createdAt || null;
  const plannedStart = startOf(t);
  const deadline = deadlineOf(t);
  const startedAt = firstChange(history, "In Progress");
  const submittedAt = lastChange(history, "Review");
  const completedAt = t.status === "Completed" ? t.completedAt || lastChange(history, "Completed") : null;

  // time taken counts from the planned start (if set and already reached), else from when it was assigned
  const countFrom = plannedStart && assignedAt && plannedStart > new Date(assignedAt) ? plannedStart : assignedAt;
  const takenMs = completedAt && countFrom ? Math.max(0, new Date(completedAt) - new Date(countFrom)) : null;
  const workMs = completedAt && startedAt ? Math.max(0, new Date(completedAt) - new Date(startedAt)) : null;
  const openMs = !completedAt && assignedAt ? Math.max(0, now - new Date(assignedAt)) : null;
  const plannedMs = plannedStart && deadline ? Math.max(0, deadline - plannedStart) : deadline && assignedAt ? Math.max(0, deadline - new Date(assignedAt)) : null;

  let timeliness = "no_deadline";
  let lateMs = null;
  if (deadline) {
    if (completedAt) {
      lateMs = new Date(completedAt) - deadline;
      timeliness = lateMs <= 0 ? "on_time" : "late";
    } else {
      lateMs = now - deadline;
      timeliness = lateMs > 0 ? "overdue" : "in_time";
    }
  }

  const subtasks = t.subtasks || [];
  const checklist = t.checklist || [];
  return {
    _id: t._id,
    referenceId: t.referenceId || "",
    name: t.name,
    description: t.description || "",
    department: t.department || "",
    departments: t.departments?.length ? t.departments : t.department ? [t.department] : [],
    priority: t.priority,
    taskType: t.taskType || "standard",
    status: t.status,
    assignedByName: t.assignedBy?.name || "",
    assignedAt,
    plannedStart,
    deadline,
    dueDate: t.dueDate,
    startedAt,
    submittedAt,
    completedAt,
    daysTaken: takenMs !== null ? round1(takenMs / DAY_MS) : null,
    timeTaken: humanDuration(takenMs),
    workTime: humanDuration(workMs),
    daysOpen: openMs !== null ? round1(openMs / DAY_MS) : null,
    openFor: humanDuration(openMs),
    plannedDays: plannedMs !== null ? round1(plannedMs / DAY_MS) : null,
    plannedTime: humanDuration(plannedMs),
    timeliness, // on_time | late | overdue | in_time | no_deadline
    lateBy: lateMs !== null && lateMs > 0 ? humanDuration(lateMs) : "",
    earlyBy: completedAt && lateMs !== null && lateMs < 0 ? humanDuration(-lateMs) : "",
    reworkCount: t.reworkCount || 0,
    reviewScore: t.reviewScore ?? null,
    points: t.pointsAwarded || 0,
    subtasks: { done: subtasks.filter((x) => x.completed).length, total: subtasks.length },
    checklist: { done: checklist.filter((x) => x.done).length, total: checklist.length },
    attachments: (t.attachments || []).length,
    comments: (t.reviewComments || [])
      .filter((c) => c.text)
      .map((c) => ({ decision: c.decision, text: c.text, byName: c.byName || "", score: c.score ?? null, at: c.at })),
    history: history.map((h) => ({ from: h.from, to: h.to, byName: h.changedByName || "", note: h.note || "", at: h.changedAt })),
  };
};

const orgFilter = (orgId) => ({
  $or: [{ _id: orgId }, { admin_id: orgId }, { createdBy: orgId, admin_id: null }],
});

const parseRange = (q) => {
  if (q.from || q.to) {
    const start = q.from ? new Date(`${q.from}T00:00:00.000Z`) : null;
    const end = q.to ? new Date(`${q.to}T23:59:59.999Z`) : null;
    return { start: start && !isNaN(start) ? start : null, end: end && !isNaN(end) ? end : null };
  }
  return parseDateRange(q.dateRange || "all_time") || { start: null, end: null };
};

// GET /api/reports/individual?userId=&department=&role=&dateRange=&from=&to=&adminId=
export const getIndividualReport = async (req, res) => {
  try {
    const q = req.query;
    const isSuper = req.user.role === "SuperAdmin";
    const orgId = isSuper ? (mongoose.isValidObjectId(q.adminId) ? q.adminId : null) : req.adminId;

    // ---- people in scope ----
    const userFilter = { status: { $in: ["Active", "Inactive"] } };
    if (orgId) Object.assign(userFilter, orgFilter(orgId));
    else userFilter.role = { $ne: "SuperAdmin" };
    // Managers report on their own department; Team Members only on themselves
    if (req.user.role === "Manager" && req.user.department) userFilter.department = req.user.department;
    if (req.user.role === "User") userFilter._id = req.user._id;

    if (q.department && q.department !== "All Departments") userFilter.department = q.department;
    if (q.role && q.role !== "All Roles") {
      if (String(q.role).startsWith("custom:")) {
        const id = q.role.slice(7);
        if (mongoose.isValidObjectId(id)) userFilter.customRole = id;
      } else if (["Admin", ...MEMBER_ROLES].includes(q.role)) {
        userFilter.role = q.role;
        if (q.role !== "Admin") userFilter.customRole = null;
      }
    }
    if (q.userId) {
      if (!mongoose.isValidObjectId(q.userId)) return res.status(400).json({ success: false, message: "Invalid user" });
      userFilter._id = userFilter._id && String(userFilter._id) !== String(q.userId) ? null : q.userId;
    }

    const people = await User.find(userFilter)
      .select("name email department role status points customRole admin_id")
      .populate("customRole", "name")
      .sort({ name: 1 })
      .lean();
    const ids = people.map((p) => p._id);

    // ---- tasks of those people (in the date range, by creation date) ----
    const { start, end } = parseRange(q);
    const match = { isTaskBank: { $ne: true }, assignedTo: { $in: ids } };
    if (orgId) match.admin_id = new mongoose.Types.ObjectId(String(orgId));
    if (start || end) {
      match.createdAt = {};
      if (start) match.createdAt.$gte = start;
      if (end) match.createdAt.$lte = end;
    }
    const now = new Date();

    const rows = await Task.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$assignedTo",
          total: { $sum: 1 },
          todo: { $sum: { $cond: [{ $eq: ["$status", "To Do"] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "In Progress"] }, 1, 0] } },
          review: { $sum: { $cond: [{ $eq: ["$status", "Review"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] } },
          overdue: {
            $sum: {
              $cond: [{ $and: [{ $ne: ["$status", "Completed"] }, { $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] }, 1, 0],
            },
          },
          completedWithDue: {
            $sum: { $cond: [{ $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$dueDate", null] }, { $ne: ["$completedAt", null] }] }, 1, 0] },
          },
          // due dates are whole days → on time = completed before the END of that day
          onTime: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "Completed"] },
                    { $ne: ["$dueDate", null] },
                    { $ne: ["$completedAt", null] },
                    { $lte: ["$completedAt", { $add: ["$dueDate", 86399999] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          completionMs: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$completedAt", null] }] },
                { $subtract: ["$completedAt", { $ifNull: ["$assignedAt", "$createdAt"] }] },
                0,
              ],
            },
          },
          completedWithTime: {
            $sum: { $cond: [{ $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$completedAt", null] }] }, 1, 0] },
          },
          points: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, "$reward", 0] } },
        },
      },
    ]);
    const byUser = Object.fromEntries(rows.map((r) => [String(r._id), r]));

    const data = people.map((p) => {
      const r = byUser[String(p._id)] || {};
      const total = r.total || 0;
      const completed = r.completed || 0;
      return {
        userId: p._id,
        name: p.name,
        email: p.email,
        department: p.department || "",
        role: p.role,
        roleLabel: p.customRole?.name || ROLE_LABELS[p.role] || p.role,
        status: p.status,
        assigned: total,
        completed,
        pending: r.todo || 0,
        inProgress: r.inProgress || 0,
        review: r.review || 0,
        overdue: r.overdue || 0,
        completionRate: total ? Math.round((completed / total) * 100) : 0,
        onTimeRate: r.completedWithDue ? Math.round(((r.onTime || 0) / r.completedWithDue) * 100) : null,
        avgCompletionHours: r.completedWithTime ? Math.round((r.completionMs / r.completedWithTime / 36e5) * 10) / 10 : null,
        avgCompletionDays: r.completedWithTime ? round1(r.completionMs / r.completedWithTime / DAY_MS) : null,
        pointsEarned: r.points || 0,
      };
    });

    // Detail for one person: every task in the range with all its details
    let tasks = [];
    let personSummary = null;
    if (q.userId && ids.length) {
      const raw = await Task.find({ ...match, assignedTo: ids[0] })
        .select(
          "referenceId name description department departments priority taskType status assignedBy assignedAt createdAt " +
            "startDate startTime dueDate dueTime completedAt statusHistory reworkCount reviewScore pointsAwarded " +
            "subtasks.completed checklist.done attachments.name reviewComments"
        )
        .populate("assignedBy", "name")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();
      tasks = raw.map((t) => taskDetail(t, now));

      const done = tasks.filter((t) => t.daysTaken !== null);
      const scored = tasks.filter((t) => t.reviewScore);
      const withDeadline = done.filter((t) => t.timeliness === "on_time" || t.timeliness === "late");
      personSummary = {
        avgDaysToComplete: done.length ? round1(done.reduce((a, t) => a + t.daysTaken, 0) / done.length) : null,
        fastest: done.length ? done.reduce((a, t) => (t.daysTaken < a.daysTaken ? t : a)) : null,
        slowest: done.length ? done.reduce((a, t) => (t.daysTaken > a.daysTaken ? t : a)) : null,
        onTime: withDeadline.filter((t) => t.timeliness === "on_time").length,
        late: withDeadline.filter((t) => t.timeliness === "late").length,
        avgScore: scored.length ? round1(scored.reduce((a, t) => a + t.reviewScore, 0) / scored.length) : null,
        reworks: tasks.reduce((a, t) => a + t.reworkCount, 0),
      };
      if (personSummary.fastest) personSummary.fastest = { name: personSummary.fastest.name, timeTaken: personSummary.fastest.timeTaken };
      if (personSummary.slowest) personSummary.slowest = { name: personSummary.slowest.name, timeTaken: personSummary.slowest.timeTaken };
    }

    const totals = data.reduce(
      (t, d) => ({
        people: t.people + 1,
        assigned: t.assigned + d.assigned,
        completed: t.completed + d.completed,
        pending: t.pending + d.pending,
        inProgress: t.inProgress + d.inProgress,
        overdue: t.overdue + d.overdue,
      }),
      { people: 0, assigned: 0, completed: 0, pending: 0, inProgress: 0, overdue: 0 }
    );

    res.json({
      success: true,
      data: {
        people: data,
        totals: { ...totals, completionRate: totals.assigned ? Math.round((totals.completed / totals.assigned) * 100) : 0 },
        tasks,
        personSummary,
        range: { start, end },
      },
    });
  } catch (err) {
    console.error("Individual report error:", err);
    res.status(500).json({ success: false, message: "Failed to build the individual report" });
  }
};
