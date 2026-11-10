import mongoose from "mongoose";
import ActivityLog, { ACTIVITY_TYPES } from "../models/ActivityLog.js";
import User from "../models/User.js";
import { logActivity, touchLastSeen } from "../services/activityService.js";

/* =========================================================
   Activity page — Admin sees their organization's Managers + Users
   (and themselves); SuperAdmin sees everyone.
========================================================= */

const ONLINE_MS = 5 * 60 * 1000;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// people the requester may see
const peopleFilter = (req) =>
  req.user.role === "SuperAdmin"
    ? {}
    : { $or: [{ _id: req.user._id }, { admin_id: req.user._id }, { createdBy: req.user._id, admin_id: null, role: { $ne: "SuperAdmin" } }] };

// log entries the requester may see
const logFilter = (req) => (req.user.role === "SuperAdmin" ? {} : { admin_id: req.user._id });

// POST /api/activity/view  { page, label } — any logged-in user
export const recordPageView = async (req, res) => {
  const page = String(req.body?.page || "").slice(0, 200);
  const label = String(req.body?.label || "").slice(0, 100);
  if (!page) return res.json({ success: true });
  touchLastSeen(req.user._id, { lastPage: label || page });
  // the same page again within 30 seconds is not logged twice
  const recent = await ActivityLog.exists({
    user: req.user._id,
    type: "page_view",
    page,
    at: { $gte: new Date(Date.now() - 30 * 1000) },
  });
  if (!recent) await logActivity(req.user, { type: "page_view", action: `Opened ${label || page}`, page, req });
  res.json({ success: true });
};

// POST /api/activity/logout — any logged-in user
export const recordLogout = async (req, res) => {
  await logActivity(req.user, { type: "logout", action: "Logged out", req });
  res.json({ success: true });
};

// GET /api/activity/users?search=&role=
export const getActivityUsers = async (req, res) => {
  try {
    const filter = { ...peopleFilter(req) };
    const and = [];
    if (req.query.role && ["SuperAdmin", "Admin", "Manager", "User"].includes(req.query.role)) and.push({ role: req.query.role });
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
      and.push({ $or: [{ name: rx }, { email: rx }, { department: rx }] });
    }
    const query = and.length ? { $and: [filter, ...and] } : filter;

    const users = await User.find(query)
      .select("name email role department status lastLoginAt lastSeenAt lastPage createdAt")
      .sort({ lastSeenAt: -1, name: 1 })
      .limit(1000)
      .lean();

    const ids = users.map((u) => u._id);
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const counts = await ActivityLog.aggregate([
      { $match: { user: { $in: ids }, at: { $gte: weekAgo } } },
      {
        $group: {
          _id: "$user",
          logins7d: { $sum: { $cond: [{ $eq: ["$type", "login"] }, 1, 0] } },
          failed7d: { $sum: { $cond: [{ $eq: ["$type", "login_failed"] }, 1, 0] } },
          actions7d: { $sum: { $cond: [{ $eq: ["$type", "action"] }, 1, 0] } },
          views7d: { $sum: { $cond: [{ $eq: ["$type", "page_view"] }, 1, 0] } },
          actionsToday: {
            $sum: { $cond: [{ $and: [{ $eq: ["$type", "action"] }, { $gte: ["$at", startOfToday] }] }, 1, 0] },
          },
          lastAction: { $max: { $cond: [{ $eq: ["$type", "action"] }, "$at", null] } },
        },
      },
    ]);
    const byUser = new Map(counts.map((c) => [String(c._id), c]));

    // most recent action text per person
    const lastActions = await ActivityLog.aggregate([
      { $match: { user: { $in: ids }, type: "action" } },
      { $sort: { at: -1 } },
      { $group: { _id: "$user", action: { $first: "$action" }, detail: { $first: "$detail" }, at: { $first: "$at" } } },
    ]);
    const lastActionBy = new Map(lastActions.map((a) => [String(a._id), a]));

    const data = users.map((u) => {
      const c = byUser.get(String(u._id)) || {};
      const la = lastActionBy.get(String(u._id));
      return {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department || "",
        status: u.status,
        lastLoginAt: u.lastLoginAt || null,
        lastSeenAt: u.lastSeenAt || null,
        lastPage: u.lastPage || "",
        online: Boolean(u.lastSeenAt && now - new Date(u.lastSeenAt).getTime() < ONLINE_MS),
        lastAction: la ? { action: la.action, detail: la.detail, at: la.at } : null,
        logins7d: c.logins7d || 0,
        failed7d: c.failed7d || 0,
        actions7d: c.actions7d || 0,
        views7d: c.views7d || 0,
        actionsToday: c.actionsToday || 0,
      };
    });

    const summary = {
      people: data.length,
      online: data.filter((u) => u.online).length,
      loggedInToday: data.filter((u) => u.lastLoginAt && new Date(u.lastLoginAt) >= startOfToday).length,
      actionsToday: data.reduce((s, u) => s + u.actionsToday, 0),
      neverLoggedIn: data.filter((u) => !u.lastLoginAt).length,
    };

    res.json({ success: true, summary, data });
  } catch (err) {
    console.error("Activity users error:", err);
    res.status(500).json({ success: false, message: "Unable to load activity" });
  }
};

// GET /api/activity/logs?userId=&type=&role=&from=&to=&search=&page=&limit=
export const getActivityLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { ...logFilter(req) };

    if (req.query.userId) {
      if (!isId(req.query.userId)) return res.status(400).json({ success: false, message: "Invalid user" });
      filter.user = req.query.userId;
    }
    if (req.query.type && ACTIVITY_TYPES.includes(req.query.type)) filter.type = req.query.type;
    if (req.query.role && ["SuperAdmin", "Admin", "Manager", "User"].includes(req.query.role)) filter.role = req.query.role;
    if (req.query.from || req.query.to) {
      filter.at = {};
      if (req.query.from) {
        const d = new Date(req.query.from);
        if (!Number.isNaN(d.getTime())) filter.at.$gte = d;
      }
      if (req.query.to) {
        const d = new Date(req.query.to);
        if (!Number.isNaN(d.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) d.setHours(23, 59, 59, 999);
          filter.at.$lte = d;
        }
      }
      if (!Object.keys(filter.at).length) delete filter.at;
    }
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
      filter.$or = [{ userName: rx }, { userEmail: rx }, { action: rx }, { detail: rx }, { page: rx }];
    }

    const [total, rows] = await Promise.all([
      ActivityLog.countDocuments(filter),
      ActivityLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);

    res.json({
      success: true,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      data: rows.map((r) => ({
        _id: r._id,
        user: r.user,
        userName: r.userName,
        userEmail: r.userEmail,
        role: r.role,
        department: r.department,
        type: r.type,
        action: r.action,
        detail: r.detail,
        page: r.page,
        ip: r.ip,
        device: r.device,
        at: r.at,
      })),
    });
  } catch (err) {
    console.error("Activity logs error:", err);
    res.status(500).json({ success: false, message: "Unable to load activity log" });
  }
};
