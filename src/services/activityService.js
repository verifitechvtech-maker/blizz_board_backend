import ActivityLog from "../models/ActivityLog.js";
import User from "../models/User.js";
import Task from "../models/Task.js";

/* =========================================================
   Activity tracking
   - logActivity(): one entry (login, logout, page view, action)
   - trackActivity middleware: updates "last seen" on every request
     and logs every successful change (POST / PUT / PATCH / DELETE)
   Nothing here ever blocks or fails a request.
========================================================= */

const orgOf = (user) => (user?.role === "Admin" ? user._id : user?.admin_id || null);

export const clientIp = (req) =>
  String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
  req?.ip ||
  req?.socket?.remoteAddress ||
  "";

// "Chrome on Windows", "Safari on iPhone"…
export const deviceOf = (req) => {
  const ua = String(req?.headers?.["user-agent"] || "");
  if (!ua) return "";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
};

export const logActivity = async (user, { type, action = "", detail = "", page = "", req = null }) => {
  try {
    if (!user) return;
    await ActivityLog.create({
      admin_id: orgOf(user),
      user: user._id,
      userName: user.name || "",
      userEmail: user.email || "",
      role: user.role || "",
      department: user.department || "",
      type,
      action: String(action).slice(0, 200),
      detail: String(detail).slice(0, 300),
      page: String(page).slice(0, 200),
      method: req?.method || "",
      path: String(req?.originalUrl || "").split("?")[0].slice(0, 300),
      ip: clientIp(req),
      device: deviceOf(req),
    });
  } catch (err) {
    console.error("Activity log failed:", err.message);
  }
};

// "Last seen" is saved at most once a minute per person
const lastTouch = new Map();
export const touchLastSeen = (userId, extra = {}) => {
  const key = String(userId);
  const now = Date.now();
  if (!Object.keys(extra).length && now - (lastTouch.get(key) || 0) < 60 * 1000) return;
  lastTouch.set(key, now);
  User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date(now), ...extra } }).catch(() => {});
};

/* ---------------- what a request did, in plain words ---------------- */

const ID = "[^/]+";
const RULES = [
  // tasks
  ["POST", `^/api/tasks/import$`, "Imported tasks"],
  ["POST", `^/api/tasks/bank$`, "Saved a task to Task Bank"],
  ["PATCH", `^/api/tasks/bank/${ID}/assign$`, "Assigned a Task Bank task"],
  ["POST", `^/api/tasks$`, "Created a task"],
  ["PATCH", `^/api/tasks/(${ID})/status$`, (req) => {
    const s = req.body?.status;
    if (s === "Review") return "Sent a task for review";
    if (s === "Completed") return "Approved / completed a task";
    return s ? `Changed task status to ${s}` : "Changed task status";
  }],
  ["POST", `^/api/tasks/(${ID})/comments$`, "Commented on a task"],
  ["POST", `^/api/tasks/(${ID})/subtasks$`, "Added a subtask"],
  ["PATCH", `^/api/tasks/(${ID})/subtasks/${ID}$`, "Updated a subtask"],
  ["DELETE", `^/api/tasks/(${ID})/subtasks/${ID}$`, "Deleted a subtask"],
  ["PATCH", `^/api/tasks/(${ID})/checklist/${ID}$`, "Updated a checklist item"],
  ["PUT", `^/api/tasks/(${ID})/monthly/${ID}$`, "Updated monthly progress"],
  ["POST", `^/api/tasks/(${ID})/attachments$`, "Added task attachments"],
  ["(PUT|PATCH)", `^/api/tasks/(${ID})$`, "Edited a task"],
  ["DELETE", `^/api/tasks/(${ID})$`, "Deleted a task"],
  // task bank / calendar
  ["POST", `^/api/taskbank/import$`, "Imported Task Bank items"],
  ["POST", `^/api/taskbank/${ID}/(re)?assign$`, "Assigned a Task Bank task"],
  ["POST", `^/api/taskbank`, "Added a Task Bank item"],
  ["PUT", `^/api/taskbank/${ID}$`, "Edited a Task Bank item"],
  ["DELETE", `^/api/taskbank/${ID}$`, "Deleted a Task Bank item"],
  ["POST", `^/api/taskcalendar/import$`, "Imported calendar tasks"],
  ["POST", `^/api/taskcalendar$`, "Added a calendar task"],
  ["PUT", `^/api/taskcalendar/${ID}$`, "Edited a calendar task"],
  ["DELETE", `^/api/taskcalendar/${ID}$`, "Deleted a calendar task"],
  // users / roles / departments
  ["POST", `^/api/users$`, "Created a user"],
  ["PUT", `^/api/users/${ID}$`, "Edited a user"],
  ["DELETE", `^/api/users/${ID}$`, "Deleted a user"],
  ["POST", `^/api/users/${ID}/set-password$`, "Set a user's password"],
  ["POST", `^/api/users/${ID}/resend-verification$`, "Resent a verification email"],
  ["POST", `^/api/admins$`, "Created an admin"],
  ["POST", `^/api/departments$`, "Created a department"],
  ["PATCH", `^/api/departments/${ID}$`, "Edited a department"],
  ["DELETE", `^/api/departments/${ID}$`, "Deleted a department"],
  ["(POST|PUT|DELETE)", `^/api/(permissions|custom-roles)`, "Changed roles / permissions"],
  // meetings
  ["POST", `^/api/meetings$`, "Created a meeting (MoM)"],
  ["PUT", `^/api/meetings/${ID}$`, "Edited a meeting (MoM)"],
  ["DELETE", `^/api/meetings/${ID}$`, "Deleted a meeting (MoM)"],
  ["POST", `^/api/meetings/${ID}/send-mom$`, "Sent meeting minutes"],
  ["POST", `^/api/meetings/${ID}/send-(invitation|reminder)$`, "Sent a meeting invitation / reminder"],
  ["POST", `^/api/meetings/${ID}/recording$`, "Uploaded a meeting recording"],
  // support / reports / settings
  ["POST", `^/api/support/tickets$`, "Raised a support ticket"],
  ["POST", `^/api/support/tickets/${ID}/reply$`, "Replied to a support ticket"],
  ["PATCH", `^/api/support/tickets/${ID}$`, "Updated a support ticket"],
  ["POST", `^/api/reports/save$`, "Saved a report"],
  ["(PUT|PATCH)", `^/api/(profile|me|settings|users/me)`, "Updated profile / settings"],
  ["POST", `^/api/chat/groups$`, "Created a chat group"],
].map(([method, path, label]) => ({ method: new RegExp(`^${method}$`), path: new RegExp(path), label }));

// noisy or private endpoints that are not logged as actions
const SKIP = /^\/api\/(activity|notifications|push|auth|telegram)(\/|$)|^\/api\/chat\/(?!groups$)/;

const describe = (req) => {
  const path = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  if (SKIP.test(path)) return null;
  for (const rule of RULES) {
    const m = rule.method.test(req.method) && path.match(rule.path);
    if (m) {
      const label = typeof rule.label === "function" ? rule.label(req) : rule.label;
      const taskId = path.startsWith("/api/tasks/") ? m[1] : null;
      return { label, taskId };
    }
  }
  return null; // unknown change → not logged
};

const taskDetail = async (taskId, res) => {
  try {
    const id = /^[0-9a-f]{24}$/i.test(String(taskId || "")) ? taskId : null;
    const task = id ? await Task.findById(id).select("referenceId name").lean() : null;
    if (task) return [task.referenceId ? `#${task.referenceId}` : "", task.name].filter(Boolean).join(" ");
  } catch {
    /* ignore */
  }
  return res?.locals?.activityDetail || "";
};

/** Middleware (after authenticate): last seen + log of successful changes. */
export const trackActivity = (req, res, next) => {
  const user = req.user;
  if (!user) return next();
  touchLastSeen(user._id);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const what = describe(req);
      if (!what) return;
      (async () => {
        let detail = what.taskId ? await taskDetail(what.taskId, res) : "";
        if (!detail && what.label === "Created a task" && req.body?.name) detail = String(req.body.name);
        if (!detail && /user|admin/i.test(what.label) && (req.body?.name || req.body?.email)) {
          detail = String(req.body.name || req.body.email);
        }
        await logActivity(user, { type: "action", action: what.label, detail, req });
      })();
    });
  }
  next();
};
