import Department from "../models/Department.js";
import Task from "../models/Task.js";
import Counter from "../models/Counter.js";

/* =========================================================
   Task reference IDs per department
   Each department has a short code (e.g. "FF"); every new task in it gets
   the code + the next number: FF1, FF2, FF3… The number goes up atomically,
   so two tasks created at the same moment never get the same ID.
========================================================= */

export const MAX_PREFIX_LENGTH = 6;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Departments of one organization (older records only have createdBy)
export const orgDepartmentFilter = (orgId) => ({ $or: [{ admin_id: orgId }, { createdBy: orgId }] });

// Letters only, so the number after it is always clear (FF12, never F1F12)
export const normalizePrefix = (input) => {
  const value = String(input ?? "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(value) || value.length > MAX_PREFIX_LENGTH) {
    return { error: `Reference code must be 1–${MAX_PREFIX_LENGTH} letters (e.g. FF)` };
  }
  return { prefix: value };
};

// "Finance Flow" → FF, "Development" → DEV; skips codes already used in the organization
export const suggestPrefix = (name, taken = new Set()) => {
  const words = String(name || "").toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.join("");
  const candidates = [];
  if (words.length > 1) candidates.push(words.map((w) => w[0]).join("").slice(0, MAX_PREFIX_LENGTH));
  for (let n = 3; n <= Math.min(MAX_PREFIX_LENGTH, letters.length); n += 1) candidates.push(letters.slice(0, n));
  if (letters.length && letters.length < 3) candidates.push(letters);
  const base = candidates.find(Boolean) || "T";
  candidates.push(...Array.from({ length: 26 }, (_, i) => `${base.slice(0, MAX_PREFIX_LENGTH - 1)}${String.fromCharCode(65 + i)}`));
  return candidates.find((c) => c && !taken.has(c)) || base;
};

export const takenPrefixes = async (orgId, exceptId = null) => {
  const rows = await Department.find({
    ...orgDepartmentFilter(orgId),
    refPrefix: { $ne: null },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select("refPrefix").lean();
  return new Set(rows.map((d) => d.refPrefix));
};

// Older departments get a code the first time it is needed
export const ensurePrefix = async (dept) => {
  if (dept.refPrefix) return dept.refPrefix;
  const orgId = dept.admin_id || dept.createdBy;
  const prefix = suggestPrefix(dept.name, await takenPrefixes(orgId, dept._id));
  const saved = await Department.findOneAndUpdate(
    { _id: dept._id, $or: [{ refPrefix: null }, { refPrefix: { $exists: false } }] },
    { $set: { refPrefix: prefix } },
    { new: true }
  );
  return saved?.refPrefix || (await Department.findById(dept._id).select("refPrefix").lean())?.refPrefix || prefix;
};

// Highest number already used with this code in the organization (so IDs never repeat)
export const highestUsedNumber = async (orgId, prefix) => {
  const rows = await Task.find({ admin_id: orgId, referenceId: { $regex: `^${escapeRegex(prefix)}\\d+$` } })
    .select("referenceId")
    .lean();
  return rows.reduce((max, t) => Math.max(max, Number(t.referenceId.slice(prefix.length)) || 0), 0);
};

/** Next reference ID for a task in this department, or null if the department isn't found. */
export const nextReferenceId = async (orgId, departmentName) => {
  const name = String(departmentName || "").trim();
  if (!orgId || !name) return null;
  const dept = await Department.findOne({
    ...orgDepartmentFilter(orgId),
    name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
  }).lean();
  if (!dept) return null;
  const prefix = await ensurePrefix(dept);
  const updated = await Department.findByIdAndUpdate(dept._id, { $inc: { taskSeq: 1 } }, { new: true }).lean();
  return `${prefix}${updated.taskSeq}`;
};

/**
 * Older tasks (created before reference IDs) get one, oldest first:
 * their department's code + next number. Copies of a shared task get the same ID.
 * Safe to run again — tasks that already have an ID are never changed.
 */
export const backfillReferenceIds = async () => {
  const tasks = await Task.find({
    $or: [{ referenceId: "" }, { referenceId: null }, { referenceId: { $exists: false } }],
    isTaskBank: { $ne: true },
    admin_id: { $ne: null },
  })
    .sort({ createdAt: 1, _id: 1 }) // _id breaks ties between tasks saved in the same millisecond
    .populate("assignedTo", "department")
    .lean();

  const groupIds = new Map(); // taskGroupId → reference ID given in this run
  let assigned = 0;
  let skipped = 0;
  for (const task of tasks) {
    let ref = task.taskGroupId ? groupIds.get(String(task.taskGroupId)) : null;
    if (!ref && task.taskGroupId) {
      // a copy of this shared task may already have an ID
      ref = (await Task.findOne({ taskGroupId: task.taskGroupId, referenceId: { $nin: ["", null] } })
        .select("referenceId")
        .lean())?.referenceId;
    }
    if (!ref) {
      // the task's department; only a task with NO department uses its assignee's
      const deptName = task.department || task.assignedTo?.department;
      ref = await nextReferenceId(task.admin_id, deptName);
      // no known department code → the organization's TSK- number, so every task has an ID
      if (!ref) ref = await nextGeneralReferenceId(task.admin_id);
    }
    if (!ref) {
      skipped += 1;
      continue;
    }
    if (task.taskGroupId) groupIds.set(String(task.taskGroupId), ref);
    await Task.updateOne({ _id: task._id, $or: [{ referenceId: "" }, { referenceId: null }, { referenceId: { $exists: false } }] }, { $set: { referenceId: ref } });
    assigned += 1;
  }
  return { assigned, skipped };
};

// Tasks with no department code still get a unique ID: TSK-1, TSK-2… per organization
// (the hyphen keeps it apart from department codes, which are letters only)
export const nextGeneralReferenceId = async (orgId) => {
  const counter = await Counter.findOneAndUpdate(
    { key: `task:${orgId || "none"}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return `TSK-${counter.seq}`;
};

// Department code number, else the organization-wide TSK- number
export const generateReferenceId = async (orgId, departmentName) =>
  (await nextReferenceId(orgId, departmentName)) || nextGeneralReferenceId(orgId);

// Is this reference ID already used by another task in the organization?
// (copies of one shared task carry the same ID — pass its taskGroupId to allow those)
export const referenceIdTaken = async (orgId, referenceId, { exceptGroupId = null } = {}) => {
  if (!referenceId) return false;
  return Boolean(
    await Task.exists({
      admin_id: orgId,
      isTaskBank: { $ne: true },
      referenceId: { $regex: new RegExp(`^${escapeRegex(referenceId)}$`, "i") },
      ...(exceptGroupId ? { taskGroupId: { $ne: exceptGroupId } } : {}),
    })
  );
};

/* ---------------- Rework Task IDs ----------------
   Original TECH14 →
     the same person redoes it    → TECH14-1, TECH14-2…
     a new person (dept code DEV) → TECH14-DEV1, TECH14-DEV2…
*/

// Department code of a person's department (null when unknown)
export const departmentCodeOf = async (orgId, departmentName) => {
  const name = String(departmentName || "").trim();
  if (!orgId || !name) return null;
  const dept = await Department.findOne({
    ...orgDepartmentFilter(orgId),
    name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
  }).lean();
  return dept ? ensurePrefix(dept) : null;
};

const reworkPattern = (originalRef, code) => new RegExp(`^${escapeRegex(originalRef)}-${code ? escapeRegex(code) : ""}(\\d+)$`, "i");

// highest number already used for this original + code (so IDs never repeat, imports included)
const highestRework = async (orgId, originalRef, code) => {
  const rx = reworkPattern(originalRef, code);
  const rows = await Task.find({ admin_id: orgId, referenceId: rx }).select("referenceId").lean();
  return rows.reduce((max, t) => Math.max(max, Number(t.referenceId.match(rx)?.[1]) || 0), 0);
};

const reworkKey = (orgId, originalRef, code) => `rework:${orgId}:${originalRef.toUpperCase()}:${code || ""}`;

/** Next rework ID (reserves it). code = null → same person → "-1" style. */
export const nextReworkId = async (orgId, originalRef, code = null) => {
  const key = reworkKey(orgId, originalRef, code);
  await Counter.updateOne({ key }, { $max: { seq: await highestRework(orgId, originalRef, code) } }, { upsert: true });
  const counter = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true });
  return `${originalRef}-${code || ""}${counter.seq}`;
};

/** What the next rework ID would be, without reserving it (form preview). */
export const peekReworkId = async (orgId, originalRef, code = null) => {
  const counter = await Counter.findOne({ key: reworkKey(orgId, originalRef, code) }).lean();
  const seq = Math.max(counter?.seq || 0, await highestRework(orgId, originalRef, code));
  return `${originalRef}-${code || ""}${seq + 1}`;
};
