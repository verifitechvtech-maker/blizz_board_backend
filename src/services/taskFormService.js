import mongoose from "mongoose";
import Task from "../models/Task.js";
import Department from "../models/Department.js";
import { orgDepartmentFilter } from "./referenceIdService.js";

/* =========================================================
   Create Task helpers
   • several departments per task (names + ids; the first one is the primary)
   • employee workload (live from the tasks collection)
========================================================= */

export const MAX_TASK_DEPARTMENTS = 20;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Selected departments from the request: `departments` (array) or the old single `department`.
 * Returns undefined when neither was sent (edit without a department change).
 * Known departments of the organization give their real name + id; unknown names are kept as typed.
 */
export const parseDepartments = async (body, orgId) => {
  let input;
  if (Array.isArray(body.departments)) input = body.departments;
  else if (typeof body.departments === "string" && body.departments.trim()) input = body.departments.split(",");
  else if (body.department !== undefined) input = body.department ? [body.department] : [];
  else return undefined;

  const names = [];
  for (const raw of input) {
    const name = String(typeof raw === "object" && raw ? raw.name || "" : raw || "").trim();
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  if (names.length > MAX_TASK_DEPARTMENTS) {
    const err = new Error(`Select at most ${MAX_TASK_DEPARTMENTS} departments`);
    err.status = 400;
    throw err;
  }

  const docs = orgId && names.length
    ? await Department.find({
        ...orgDepartmentFilter(orgId),
        name: { $in: names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i")) },
      }).select("name").lean()
    : [];
  const byKey = new Map(docs.map((d) => [d.name.toLowerCase(), d]));
  const departments = names.map((n) => byKey.get(n.toLowerCase())?.name || n);
  return {
    department: departments[0] || "",
    departments,
    departmentIds: departments.map((n) => byKey.get(n.toLowerCase())?._id).filter(Boolean),
  };
};

/* ---------------- Workload ---------------- */

const PRIORITY_WEIGHT = { Low: 1, Medium: 2, High: 3, Critical: 4 };
// active-load points: ≤ 6 Low, ≤ 14 Medium, above that High
export const WORKLOAD_LIMITS = { low: 6, medium: 14 };
const DAY = 24 * 60 * 60 * 1000;

/**
 * Workload of one person from their assigned tasks.
 * Completed (and cancelled, if ever added) tasks are not active work.
 * Active load = Σ priority weight (Low 1 … Critical 4) + 2 per overdue task + 1 per task due within 3 days.
 */
export const computeWorkload = async (userId, now = new Date()) => {
  const tasks = await Task.find({
    assignedTo: new mongoose.Types.ObjectId(String(userId)),
    isTaskBank: { $ne: true },
  })
    .select("status priority dueDate")
    .lean();

  const counts = { total: tasks.length, pending: 0, inProgress: 0, review: 0, completed: 0, overdue: 0, dueSoon: 0 };
  let points = 0;
  for (const t of tasks) {
    const status = String(t.status || "To Do");
    if (status === "Completed" || status === "Cancelled") {
      counts.completed += status === "Completed" ? 1 : 0;
      continue;
    }
    if (status === "In Progress") counts.inProgress += 1;
    else if (status === "Review") counts.review += 1;
    else counts.pending += 1;

    points += PRIORITY_WEIGHT[t.priority] || 2;
    if (t.dueDate) {
      // due dates are stored as the day (00:00 UTC) — overdue once that whole day has passed
      const endOfDueDay = new Date(t.dueDate).getTime() + DAY;
      if (endOfDueDay < now.getTime()) {
        counts.overdue += 1;
        points += 2;
      } else if (endOfDueDay - now.getTime() <= 3 * DAY) {
        counts.dueSoon += 1;
        points += 1;
      }
    }
  }

  const active = counts.pending + counts.inProgress + counts.review;
  const status = points <= WORKLOAD_LIMITS.low ? "Low" : points <= WORKLOAD_LIMITS.medium ? "Medium" : "High";
  return { ...counts, active, points, status, limits: WORKLOAD_LIMITS };
};
