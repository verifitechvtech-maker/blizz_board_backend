import mongoose from "mongoose";
import User from "../models/User.js";
import RolePermission from "../models/RolePermission.js";
import CustomRole from "../models/CustomRole.js";
import {
  MODULES,
  ROLE_LABELS,
  MEMBER_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  ACTION_LABELS,
  sanitizePermissions,
  isSubset,
  countPermissions,
} from "../config/permissions.js";
import {
  getAdminPermissions,
  getOrgRolePermissions,
  resolvePermissions,
  resolveRolePermissions,
} from "../middleware/permissionMiddleware.js";

// Org members: admin_id is the org key; createdBy covers accounts made before admin_id existed.
export const orgMemberFilter = (adminId) => ({
  $or: [{ admin_id: adminId }, { createdBy: adminId, admin_id: null }],
});

// Roles the requester may hand out on the Users page.
export const assignableRolesFor = (requester) => {
  if (requester.role === "SuperAdmin") return ["Admin", ...MEMBER_ROLES];
  if (requester.role === "Admin") return [...MEMBER_ROLES];
  return [];
};

// ==================== GET /api/permissions/catalog ====================
export const getCatalog = (req, res) => {
  res.json({
    success: true,
    data: {
      modules: MODULES,
      roles: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
      assignableRoles: assignableRolesFor(req.user).map((value) => ({
        value,
        label: ROLE_LABELS[value],
      })),
      defaults: DEFAULT_ROLE_PERMISSIONS,
      actionLabels: ACTION_LABELS,
    },
  });
};

// ==================== GET /api/permissions/me ====================
export const getMyPermissions = (req, res) => {
  res.json({
    success: true,
    data: { role: req.user.role, permissions: req.permissions },
  });
};

// ==================== GET /api/permissions/roles ====================
// Admin → his org's Manager/User role configuration + real user counts
export const getOrgRoles = async (req, res) => {
  try {
    const adminId = req.user._id;
    const grantable = getAdminPermissions(req.user);

    const roles = await Promise.all(
      MEMBER_ROLES.map(async (role) => {
        const saved = await RolePermission.findOne({ admin_id: adminId, role }).lean();
        const permissions = await getOrgRolePermissions(adminId, role);
        const [users, activeUsers] = await Promise.all([
          User.countDocuments({ ...orgMemberFilter(adminId), role }),
          User.countDocuments({ ...orgMemberFilter(adminId), role, status: "Active" }),
        ]);
        return {
          role,
          label: ROLE_LABELS[role],
          permissions,
          permissionCount: countPermissions(permissions),
          isCustomized: Boolean(saved),
          updatedAt: saved?.updatedAt || null,
          users,
          activeUsers,
        };
      })
    );

    // Organization-defined roles (own permissions, or inherited from their base role)
    const customs = await CustomRole.find({ admin_id: adminId }).sort({ name: 1 }).lean();
    const baseByRole = Object.fromEntries(roles.map((r) => [r.role, r.permissions]));
    const customRoles = await Promise.all(
      customs.map(async (c) => {
        const permissions = c.permissions
          ? sanitizePermissions(c.permissions, baseByRole[c.baseRole])
          : baseByRole[c.baseRole];
        const [users, activeUsers] = await Promise.all([
          User.countDocuments({ customRole: c._id }),
          User.countDocuments({ customRole: c._id, status: "Active" }),
        ]);
        return {
          role: `custom:${c._id}`,
          customRoleId: c._id,
          label: c.name,
          description: c.description,
          baseRole: c.baseRole,
          permissions,
          permissionCount: countPermissions(permissions),
          isCustomized: Boolean(c.permissions),
          users,
          activeUsers,
        };
      })
    );

    res.json({ success: true, data: { roles: [...roles, ...customRoles], grantable } });
  } catch (error) {
    console.error("Get Org Roles Error:", error);
    res.status(500).json({ success: false, message: "Failed to load role permissions" });
  }
};

// ==================== PUT /api/permissions/roles/:role ====================
export const updateOrgRole = async (req, res) => {
  try {
    const { role } = req.params;
    if (!MEMBER_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed: ${MEMBER_ROLES.join(", ")}`,
      });
    }

    const permissions = sanitizePermissions(req.body.permissions);
    const grantable = getAdminPermissions(req.user);

    // ⭐ An Admin can never grant something he does not have himself
    if (!isSubset(permissions, grantable)) {
      return res.status(403).json({
        success: false,
        message: "You cannot grant permissions that your own account does not have.",
      });
    }

    const doc = await RolePermission.findOneAndUpdate(
      { admin_id: req.user._id, role },
      { permissions, updatedBy: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      message: `${ROLE_LABELS[role]} permissions saved`,
      data: {
        role,
        permissions: sanitizePermissions(doc.permissions),
        permissionCount: countPermissions(doc.permissions),
        updatedAt: doc.updatedAt,
      },
    });
  } catch (error) {
    console.error("Update Org Role Error:", error);
    res.status(500).json({ success: false, message: "Failed to save role permissions" });
  }
};

// ==================== DELETE /api/permissions/roles/:role ====================
// Back to defaults (removes the saved org configuration)
export const resetOrgRole = async (req, res) => {
  try {
    const { role } = req.params;
    if (!MEMBER_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }
    await RolePermission.deleteOne({ admin_id: req.user._id, role });
    const permissions = await getOrgRolePermissions(req.user._id, role);
    res.json({
      success: true,
      message: `${ROLE_LABELS[role]} permissions reset to defaults`,
      data: { role, permissions, permissionCount: countPermissions(permissions) },
    });
  } catch (error) {
    console.error("Reset Org Role Error:", error);
    res.status(500).json({ success: false, message: "Failed to reset role permissions" });
  }
};

// ==================== GET /api/permissions/admins ====================
// SuperAdmin → every Admin account with its permission cap + org size
export const getAdminAccess = async (req, res) => {
  try {
    const admins = await User.find({ role: "Admin" })
      .select("name email department companyName status permissions createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const data = await Promise.all(
      admins.map(async (admin) => {
        const permissions = getAdminPermissions(admin);
        const members = await User.countDocuments(orgMemberFilter(admin._id));
        return {
          _id: admin._id,
          name: admin.name,
          email: admin.email,
          companyName: admin.companyName || "",
          department: admin.department,
          status: admin.status,
          permissions,
          permissionCount: countPermissions(permissions),
          isRestricted: Boolean(admin.permissions),
          members,
        };
      })
    );

    res.json({ success: true, data });
  } catch (error) {
    console.error("Get Admin Access Error:", error);
    res.status(500).json({ success: false, message: "Failed to load admin permissions" });
  }
};

// ==================== PUT /api/permissions/admins/:id ====================
export const updateAdminAccess = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid admin ID format" });
    }

    const admin = await User.findOne({ _id: req.params.id, role: "Admin" });
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    admin.permissions = sanitizePermissions(req.body.permissions);
    admin.markModified("permissions");
    await admin.save();

    res.json({
      success: true,
      message: `Access updated for ${admin.name}`,
      data: {
        _id: admin._id,
        permissions: admin.permissions,
        permissionCount: countPermissions(admin.permissions),
        isRestricted: true,
      },
    });
  } catch (error) {
    console.error("Update Admin Access Error:", error);
    res.status(500).json({ success: false, message: "Failed to update admin permissions" });
  }
};


// ==================== PUT /api/permissions/custom-roles/:id ====================
// Admin sets the permissions of one organization-defined role
export const updateCustomRolePermissions = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid role ID" });
    }
    const role = await CustomRole.findOne({ _id: req.params.id, admin_id: req.user._id });
    if (!role) return res.status(404).json({ success: false, message: "Role not found" });

    // reset → follow the base role again
    if (req.body.reset) {
      role.permissions = null;
      await role.save();
      return res.json({ success: true, message: `"${role.name}" now uses the ${role.baseRole} permissions` });
    }

    const permissions = sanitizePermissions(req.body.permissions);
    if (!isSubset(permissions, getAdminPermissions(req.user))) {
      return res.status(403).json({
        success: false,
        message: "You cannot grant permissions that your own account does not have.",
      });
    }
    role.permissions = permissions;
    role.markModified("permissions");
    await role.save();
    res.json({
      success: true,
      message: `"${role.name}" permissions saved`,
      data: { permissions, permissionCount: countPermissions(permissions) },
    });
  } catch (error) {
    console.error("Update Custom Role Permissions Error:", error);
    res.status(500).json({ success: false, message: "Failed to save role permissions" });
  }
};


// ==================== INDIVIDUAL ACCESS ====================
// GET /api/permissions/users — every member of my organization with their access
export const getIndividualAccess = async (req, res) => {
  try {
    const members = await User.find({ ...orgMemberFilter(req.user._id), role: { $in: MEMBER_ROLES } })
      .select("permissions name email department role status customRole admin_id createdBy")
      .populate("customRole", "name")
      .sort({ name: 1 });

    const data = await Promise.all(
      members.map(async (m) => {
        const doc = m.toObject();
        doc.customRole = m.customRole?._id || null;
        if (!doc.admin_id) doc.admin_id = req.user._id; // legacy accounts
        const [effective, fromRole] = await Promise.all([resolvePermissions(doc), resolveRolePermissions(doc)]);
        return {
          _id: m._id,
          name: m.name,
          email: m.email,
          department: m.department,
          status: m.status,
          role: m.role,
          roleLabel: m.customRole?.name || ROLE_LABELS[m.role],
          hasOverride: Boolean(m.permissions),
          permissions: effective,
          rolePermissions: fromRole,
          permissionCount: countPermissions(effective),
        };
      })
    );
    res.json({ success: true, data: { users: data, grantable: getAdminPermissions(req.user) } });
  } catch (error) {
    console.error("Get Individual Access Error:", error);
    res.status(500).json({ success: false, message: "Failed to load individual access" });
  }
};

// PUT /api/permissions/users/:id  { permissions } | { reset: true }
export const updateIndividualAccess = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    const member = await User.findOne({
      _id: req.params.id,
      ...orgMemberFilter(req.user._id),
      role: { $in: MEMBER_ROLES },
    });
    if (!member) return res.status(404).json({ success: false, message: "User not found in your organization" });

    if (req.body.reset) {
      member.permissions = null;
      await member.save();
      return res.json({ success: true, message: `${member.name} now uses the permissions of their role` });
    }

    const permissions = sanitizePermissions(req.body.permissions);
    if (!isSubset(permissions, getAdminPermissions(req.user))) {
      return res.status(403).json({
        success: false,
        message: "You cannot grant permissions that your own account does not have.",
      });
    }
    member.permissions = permissions;
    member.markModified("permissions");
    await member.save();
    res.json({
      success: true,
      message: `Individual access saved for ${member.name}`,
      data: { permissions, permissionCount: countPermissions(permissions) },
    });
  } catch (error) {
    console.error("Update Individual Access Error:", error);
    res.status(500).json({ success: false, message: "Failed to save individual access" });
  }
};
