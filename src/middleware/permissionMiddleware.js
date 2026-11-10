// src/middleware/permissionMiddleware.js
import User from "../models/User.js";
import RolePermission from "../models/RolePermission.js";
import CustomRole from "../models/CustomRole.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  fullPermissions,
  sanitizePermissions,
  intersectPermissions,
  can,
} from "../config/permissions.js";

// What an Admin account may use (and grant). Set by SuperAdmin; null → everything.
export const getAdminPermissions = (admin) =>
  admin?.permissions ? sanitizePermissions(admin.permissions, fullPermissions()) : fullPermissions();

// Saved org configuration for a member role, falling back to defaults.
export const getOrgRolePermissions = async (adminId, role) => {
  const saved = adminId
    ? await RolePermission.findOne({ admin_id: adminId, role }).lean()
    : null;
  return sanitizePermissions(saved?.permissions || DEFAULT_ROLE_PERMISSIONS[role], DEFAULT_ROLE_PERMISSIONS[role]);
};

/**
 * Effective permissions for a user document.
 * SuperAdmin → all | Admin → own cap | Manager/User → org role config ∩ their Admin's cap
 */
// What this member would get from the role alone (without individual overrides)
export const resolveRolePermissions = async (user) => {
  const [basePerms, custom] = await Promise.all([
    getOrgRolePermissions(user.admin_id, user.role),
    user.customRole ? CustomRole.findOne({ _id: user.customRole, admin_id: user.admin_id }).lean() : null,
  ]);
  return custom?.permissions ? sanitizePermissions(custom.permissions, basePerms) : basePerms;
};

export const resolvePermissions = async (user) => {
  if (!user) return sanitizePermissions({});
  if (user.role === "SuperAdmin") return fullPermissions();
  if (user.role === "Admin") return getAdminPermissions(user);

  const [basePerms, admin, custom] = await Promise.all([
    getOrgRolePermissions(user.admin_id, user.role),
    user.admin_id ? User.findById(user.admin_id).select("permissions role status").lean() : null,
    user.customRole ? CustomRole.findOne({ _id: user.customRole, admin_id: user.admin_id }).lean() : null,
  ]);
  // A custom role with its own permissions replaces the base role's configuration
  const roleOnly = custom?.permissions ? sanitizePermissions(custom.permissions, basePerms) : basePerms;
  // ⭐ Individual access (set on the Roles page → Individuals) wins over the role
  const rolePerms = user.permissions ? sanitizePermissions(user.permissions, roleOnly) : roleOnly;

  // A member whose organization no longer exists gets nothing.
  if (!admin || admin.role !== "Admin") return sanitizePermissions({});
  return intersectPermissions(rolePerms, getAdminPermissions(admin));
};

// Any ONE of several [module, action] pairs is enough
export const requireAnyPermission = (...pairs) => async (req, res, next) => {
  try {
    const perms = await ensurePermissions(req);
    if (!pairs.some(([m, a]) => can(perms, m, a))) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Missing permission: ${pairs.map((p) => p.join(".")).join(" or ")}`,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Computes req.permissions once per request (after authenticate).
export const attachPermissions = async (req, res, next) => {
  try {
    if (!req.permissions) req.permissions = await resolvePermissions(req.user);
    next();
  } catch (err) {
    next(err);
  }
};

const ensurePermissions = async (req) => {
  if (!req.permissions) req.permissions = await resolvePermissions(req.user);
  return req.permissions;
};

export const hasPermission = (req, moduleId, action) => can(req.permissions, moduleId, action);

export const requirePermission = (moduleId, action) => async (req, res, next) => {
  try {
    const perms = await ensurePermissions(req);
    if (!can(perms, moduleId, action)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Missing permission: ${moduleId}.${action}`,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// GET → view, POST → create, PUT/PATCH → edit, DELETE → delete
const METHOD_ACTIONS = { GET: "view", HEAD: "view", POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" };

export const permissionByMethod = (moduleId) => (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  return requirePermission(moduleId, METHOD_ACTIONS[req.method] || "view")(req, res, next);
};
