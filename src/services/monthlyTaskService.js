import mongoose from "mongoose";
import Task, { TRACKING_METHODS } from "../models/Task.js";
import MonthlyProgress from "../models/MonthlyProgress.js";

/* =========================================================
   Monthly Task helpers (a target over a start → end date range)
   total completed = sum of the daily counts (missing day = 0)
   remaining       = max(target − total, 0)
   percent         = total / target × 100, capped at 100
========================================================= */

export const MAX_MONTHLY_TARGET = 1_000_000;
export const MAX_RANGE_DAYS = 366;
export const MAX_DAILY_COUNT = 100_000;

const pad = (n) => String(n).padStart(2, "0");

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// Deadline of a monthly task = its end date (an older task: the last day of its month)
export const dueDateOf = (monthly) => new Date(`${rangeOf(monthly).endDate}T00:00:00.000Z`);

// "YYYY-MM-DD" that is a real calendar date
export const isISODate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (start, end) =>
  Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;

export const rangeDates = (start, end) => Array.from({ length: daysBetween(start, end) }, (_, i) => addDays(start, i));

// Tracked days of a task (older tasks without dates → their whole month)
export const rangeOf = (monthly) => {
  if (monthly?.startDate && monthly?.endDate) return { startDate: monthly.startDate, endDate: monthly.endDate };
  return {
    startDate: `${monthly.year}-${pad(monthly.month)}-01`,
    endDate: `${monthly.year}-${pad(monthly.month)}-${pad(daysInMonth(monthly.year, monthly.month))}`,
  };
};

/** Start / end date check. Returns { startDate, endDate, year, month } or { error }. */
export const parseDateRange = (startDate, endDate) => {
  if (!isISODate(startDate)) return { error: "Select a valid starting date" };
  if (!isISODate(endDate)) return { error: "Select a valid end date" };
  if (endDate < startDate) return { error: "End date cannot be before the starting date" };
  if (daysBetween(startDate, endDate) > MAX_RANGE_DAYS) {
    return { error: `The task can cover at most ${MAX_RANGE_DAYS} days` };
  }
  const [year, month] = startDate.split("-").map(Number);
  if (year < 2000 || year > 2100) return { error: "Select a valid starting date" };
  return { startDate, endDate, year, month };
};

const isWholeNumber = (v) => typeof v === "number" && Number.isInteger(v);
const toNumber = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));

/**
 * Validates the Monthly Task settings from the create form.
 * Returns { config } or { error }.
 */
export const parseMonthlyConfig = (input) => {
  const m = input && typeof input === "object" ? input : {};
  const target = toNumber(m.target);
  const trackingMethod = m.trackingMethod || "number";
  const unitPerCheck = m.unitPerCheck === undefined || m.unitPerCheck === "" ? 1 : toNumber(m.unitPerCheck);

  // starting + end date; without them (older clients) the whole target month
  let { startDate, endDate } = m;
  if (!startDate && !endDate) {
    const year = toNumber(m.year);
    const month = toNumber(m.month);
    if (!isWholeNumber(year) || year < 2000 || year > 2100) return { error: "Select a valid starting date" };
    if (!isWholeNumber(month) || month < 1 || month > 12) return { error: "Select a valid starting date" };
    ({ startDate, endDate } = rangeOf({ year, month }));
  }
  const range = parseDateRange(startDate, endDate);
  if (range.error) return range;
  if (!isWholeNumber(target) || target < 1) return { error: "Monthly target must be a whole number greater than 0" };
  if (target > MAX_MONTHLY_TARGET) return { error: `Monthly target cannot be more than ${MAX_MONTHLY_TARGET}` };
  if (!TRACKING_METHODS.includes(trackingMethod)) {
    return { error: `Tracking method must be one of: ${TRACKING_METHODS.join(", ")}` };
  }
  if (!isWholeNumber(unitPerCheck) || unitPerCheck < 1 || unitPerCheck > MAX_DAILY_COUNT) {
    return { error: "Units per ticked day must be a whole number of at least 1" };
  }
  return {
    config: {
      year: range.year,
      month: range.month,
      startDate: range.startDate,
      endDate: range.endDate,
      target,
      trackingMethod,
      unitPerCheck,
      totalCompleted: 0,
    },
  };
};

export const parseMonthlyTarget = (value) => {
  const target = toNumber(value);
  if (!isWholeNumber(target) || target < 1) return { error: "Monthly target must be a whole number greater than 0" };
  if (target > MAX_MONTHLY_TARGET) return { error: `Monthly target cannot be more than ${MAX_MONTHLY_TARGET}` };
  return { target };
};

export const summarize = (target, totalCompleted) => {
  const total = Math.max(0, Number(totalCompleted) || 0);
  const goal = Math.max(1, Number(target) || 1);
  return {
    target: goal,
    totalCompleted: total,
    remaining: Math.max(goal - total, 0),
    percent: Math.min(100, Math.round((total / goal) * 1000) / 10),
  };
};

// Monthly block of the task API response
export const shapeMonthly = (monthly) => {
  if (!monthly) return null;
  const m = monthly.toObject ? monthly.toObject() : monthly;
  const { startDate, endDate } = rangeOf(m);
  return {
    year: m.year,
    month: m.month,
    startDate,
    endDate,
    totalDays: daysBetween(startDate, endDate),
    trackingMethod: m.trackingMethod,
    unitPerCheck: m.unitPerCheck || 1,
    ...summarize(m.target, m.totalCompleted),
  };
};

// Re-adds the saved daily counts (inside the task's dates) so the total always matches the records
export const recalcMonthlyTotal = async (taskId, userId) => {
  const task = await Task.findById(taskId).select("monthly").lean();
  if (!task?.monthly || !userId) return 0;
  const { startDate, endDate } = rangeOf(task.monthly);
  const [row] = await MonthlyProgress.aggregate([
    {
      $match: {
        task: new mongoose.Types.ObjectId(String(taskId)),
        user: new mongoose.Types.ObjectId(String(userId)),
        date: { $gte: startDate, $lte: endDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$count" } } },
  ]);
  const total = row?.total || 0;
  await Task.updateOne({ _id: taskId }, { $set: { "monthly.totalCompleted": total } });
  return total;
};

// Today as "YYYY-MM-DD" in the user's time zone (no entries for days that haven't happened)
export const todayIn = (timeZone) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "Asia/Kolkata" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

// Every date from start to end, with 0 for dates nobody filled in
export const buildDailyRows = (monthly, records) => {
  const byDate = new Map(records.map((r) => [r.date, r]));
  const { startDate, endDate } = rangeOf(monthly);
  return rangeDates(startDate, endDate).map((date) => {
    const r = byDate.get(date);
    return {
      date,
      count: r ? r.count : 0,
      checked: r ? Boolean(r.checked) : false,
      remarks: r?.remarks || "",
      entered: Boolean(r),
      updatedAt: r?.updatedAt || null,
    };
  });
};
