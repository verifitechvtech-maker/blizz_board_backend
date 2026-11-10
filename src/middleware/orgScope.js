// src/middleware/orgScope.js
// For records that only store the creating user (meetings, tickets):
// req.orgUserIds = every account of the requester's organization (Admin + members).
// SuperAdmin → null (no restriction).
import User from "../models/User.js";

export const attachOrgUsers = async (req, res, next) => {
  try {
    if (req.user.role === "SuperAdmin" || req.orgUserIds !== undefined) {
      req.orgUserIds = req.orgUserIds ?? null;
      return next();
    }
    const orgId = req.adminId;
    if (!orgId) {
      req.orgUserIds = [req.user._id];
      return next();
    }
    const members = await User.find({
      $or: [{ admin_id: orgId }, { createdBy: orgId, admin_id: null }],
    }).select("_id").lean();
    req.orgUserIds = [orgId, ...members.map((m) => m._id)];
    next();
  } catch (err) {
    next(err);
  }
};

// Mongo filter: records created by someone in my organization
export const createdInOrg = (req, field = "createdBy") =>
  req.orgUserIds ? { [field]: { $in: req.orgUserIds } } : {};

// Meetings: inside my organization AND I am allowed to see this meeting —
// its creator, one of its attendees (by account or email), or the organization's Admin.
export const meetingAccess = (req) => {
  const org = createdInOrg(req);
  if (!req.user || ["Admin", "SuperAdmin"].includes(req.user.role)) return org;
  const email = String(req.user.email || "").trim().toLowerCase();
  return {
    ...org,
    $or: [
      { createdBy: req.user._id },
      { "attendees.userId": req.user._id },
      ...(email ? [{ "attendees.email": email }] : []),
    ],
  };
};

// Deleting a meeting: its creator or the organization's Admin only
export const meetingOwner = (req) =>
  !req.user || ["Admin", "SuperAdmin"].includes(req.user.role)
    ? createdInOrg(req)
    : { ...createdInOrg(req), createdBy: req.user._id };
