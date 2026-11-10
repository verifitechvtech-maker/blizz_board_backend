// Organization-defined roles (managed like departments on the Users page).
import mongoose from "mongoose";
import CustomRole from "../models/CustomRole.js";
import User from "../models/User.js";
import { ROLE_LABELS } from "../config/permissions.js";

const orgOf = (req) => {
  if (req.user.role !== "SuperAdmin") return req.adminId;
  const id = req.query.adminId || req.body?.adminId;
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
};

const shape = (r, users = 0) => ({
  _id: r._id,
  name: r.name,
  description: r.description,
  baseRole: r.baseRole,
  baseRoleLabel: ROLE_LABELS[r.baseRole],
  hasOwnPermissions: Boolean(r.permissions),
  users,
  createdAt: r.createdAt,
});

const clean = (body) => ({
  name: String(body.name || "").trim(),
  description: String(body.description || "").trim(),
  baseRole: body.baseRole === "Manager" ? "Manager" : "User",
});

// GET /api/custom-roles[?adminId=] — roles of my organization (+ user counts)
export const listCustomRoles = async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) {
      // SuperAdmin without an org selected → every org's roles (labelled)
      if (req.user.role !== "SuperAdmin") return res.json({ success: true, data: [] });
    }
    const roles = await CustomRole.find(orgId ? { admin_id: orgId } : {}).sort({ name: 1 }).lean();
    const counts = await User.aggregate([
      { $match: { customRole: { $in: roles.map((r) => r._id) } } },
      { $group: { _id: "$customRole", n: { $sum: 1 } } },
    ]);
    const byRole = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
    res.json({
      success: true,
      data: roles.map((r) => ({ ...shape(r, byRole[String(r._id)] || 0), admin_id: r.admin_id })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/custom-roles { name, description, baseRole }
export const createCustomRole = async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json({ success: false, message: "Select the organization (Admin) for this role." });
    const data = clean(req.body);
    if (!data.name) return res.status(400).json({ success: false, message: "Role name is required." });
    if (["superadmin", "super admin", "admin"].includes(data.name.toLowerCase())) {
      return res.status(400).json({ success: false, message: `"${data.name}" is reserved. Choose another name.` });
    }
    const role = await CustomRole.create({ ...data, admin_id: orgId, createdBy: req.user._id });
    res.status(201).json({ success: true, message: `Role "${role.name}" created`, data: shape(role) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: "A role with this name already exists." });
    if (err.name === "ValidationError") return res.status(400).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

const findOwn = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid role ID" });
    return null;
  }
  const filter = { _id: req.params.id };
  if (req.user.role !== "SuperAdmin") filter.admin_id = req.adminId;
  const role = await CustomRole.findOne(filter);
  if (!role) res.status(404).json({ success: false, message: "Role not found" });
  return role;
};

// PUT /api/custom-roles/:id { name, description, baseRole }
export const updateCustomRole = async (req, res) => {
  try {
    const role = await findOwn(req, res);
    if (!role) return;
    const data = clean({ ...role.toObject(), ...req.body });
    if (!data.name) return res.status(400).json({ success: false, message: "Role name is required." });
    const baseChanged = data.baseRole !== role.baseRole;
    Object.assign(role, data);
    await role.save();
    // Everyone holding this role follows its access level
    if (baseChanged) await User.updateMany({ customRole: role._id }, { role: role.baseRole });
    res.json({ success: true, message: `Role "${role.name}" updated`, data: shape(role) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: "A role with this name already exists." });
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/custom-roles/:id — only when nobody uses it
export const deleteCustomRole = async (req, res) => {
  try {
    const role = await findOwn(req, res);
    if (!role) return;
    const inUse = await User.countDocuments({ customRole: role._id });
    if (inUse) {
      return res.status(409).json({
        success: false,
        message: `${inUse} user(s) have the role "${role.name}". Change their role first.`,
      });
    }
    await role.deleteOne();
    res.json({ success: true, message: `Role "${role.name}" deleted` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
