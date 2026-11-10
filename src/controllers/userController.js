import mongoose from "mongoose";
import User from "../models/User.js";
import CustomRole from "../models/CustomRole.js";
import Task from "../models/Task.js";
import Department from "../models/Department.js";
import Meeting from "../models/Meeting.js";
import Ticket from "../models/Ticket.js";

// Custom role must belong to the user's organization; returns the role doc or throws
const loadCustomRole = async (customRoleId, orgId) => {
  if (!customRoleId) return null;
  if (!mongoose.Types.ObjectId.isValid(customRoleId)) {
    const e = new Error("Invalid role selected"); e.status = 400; throw e;
  }
  const role = await CustomRole.findOne({ _id: customRoleId, admin_id: orgId }).lean();
  if (!role) {
    const e = new Error("The selected role does not exist in this organization"); e.status = 400; throw e;
  }
  return role;
};
import { MEMBER_ROLES, ROLE_LABELS } from "../config/permissions.js";
import { hasPermission } from "../middleware/permissionMiddleware.js";
import { orgMemberFilter, assignableRolesFor } from "./permissionController.js";
import { issueVerification, applyAdminPassword } from "./accountController.js";

// Message suffix telling the admin whether the verification email went out
const emailNote = (email) =>
  email.sent
    ? " A verification email has been sent."
    : ` The verification email could not be sent (${email.reason}) — use "Resend verification" later.`;

const validateObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ==================== SUPERADMIN: CREATE ADMIN ====================
export const createAdmin = async (req, res) => {
  try {
    const { name, email, password, phone, department } = req.body;
    const companyName = String(req.body.companyName || "").trim();

    if (!companyName) {
      return res.status(400).json({
        success: false,
        message: "Company name is required for an Admin account",
      });
    }

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    // Check duplicate email
    const existing = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const admin = await User.create({
      name,
      email,
      password, // pre-save hook hashes it
      phone: phone || "",
      department: department || "",
      companyName,
      role: "Admin",
      status: "Active",
      createdBy: req.user._id, // SuperAdmin's _id
      // ⭐ admin_id stays null — Admin is ROOT of his own org
      // (scopeMiddleware uses his own _id when role = "Admin")
    });

    // ⭐ Must verify email before first login; password is revealed once via the link
    const mail = await issueVerification(admin, password, "welcome");

    return res.status(201).json({
      success: true,
      message: "Admin created successfully by SuperAdmin." + emailNote(mail),
      emailSent: mail.sent,
      data: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        companyName: admin.companyName,
        status: admin.status,
        emailVerified: admin.emailVerified,
        createdBy: admin.createdBy,
      },
    });
  } catch (error) {
    console.error("Create Admin Error:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.join(", "),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== CREATE USER (Admin / SuperAdmin / Manager with users.create) ====================
// role: "Manager" | "User" (members of an org) | "Admin" (SuperAdmin only → new org)
export const createUser = async (req, res) => {
  try {
    const { name, email, password, phone, department, status } = req.body;
    let role = req.body.role || "User";

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    // ⭐ Role must be one the requester is allowed to hand out (never SuperAdmin)
    if (!assignableRolesFor(req.user).includes(role) && !(req.user.role === "Manager" && role === "User")) {
      return res.status(403).json({
        success: false,
        message: `You are not allowed to create accounts with the role "${role}"`,
      });
    }

    if (role === "Admin") {
      // SuperAdmin creating an Admin = same as POST /api/admins
      return createAdmin(req, res);
    }

    // Which organization does the new member belong to?
    let orgId = req.adminId; // Admin → himself, Manager → his admin
    if (req.user.role === "SuperAdmin") {
      if (!validateObjectId(req.body.adminId)) {
        return res.status(400).json({
          success: false,
          message: "Select the Admin (organization) this user belongs to",
        });
      }
      const org = await User.findOne({ _id: req.body.adminId, role: "Admin" }).lean();
      if (!org) {
        return res.status(400).json({ success: false, message: "Selected Admin does not exist" });
      }
      orgId = org._id;
    }

    // Organization-defined role → its base access level decides `role`
    let customRole = null;
    try {
      customRole = await loadCustomRole(req.body.customRoleId, orgId);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }
    if (customRole) {
      if (req.user.role === "Manager" && customRole.baseRole !== "User") {
        return res.status(403).json({ success: false, message: "You can only give Team Member level roles" });
      }
      role = customRole.baseRole;
    }

    const existing = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const user = await User.create({
      name,
      email,
      password,
      phone: phone || "",
      department: department || "",
      role,
      status: status === "Inactive" ? "Inactive" : "Active",
      createdBy: req.user._id,
      admin_id: orgId, // ⭐ org key — never from the client for Admins/Managers
      customRole: customRole?._id || null,
    });

    const mail = await issueVerification(user, password, "welcome");

    return res.status(201).json({
      success: true,
      message: `${ROLE_LABELS[role]} created successfully.` + emailNote(mail),
      emailSent: mail.sent,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        department: user.department,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
        createdBy: user.createdBy,
        admin_id: user.admin_id,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("Create User Error:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.join(", "),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== GET ALL USERS (DATA ISOLATED) ====================
export const getAllUsers = async (req, res) => {
  try {
    let filter;

    if (req.user.role === "SuperAdmin") {
      // SuperAdmin sees ALL users except other SuperAdmins
      filter = { role: { $ne: "SuperAdmin" } };
      if (validateObjectId(req.query.adminId)) {
        filter = { ...orgMemberFilter(req.query.adminId), role: { $in: MEMBER_ROLES } };
      }
    } else {
      // Admin / Manager (with users.view) → ONLY his org's members ← DATA ISOLATION
      filter = { ...orgMemberFilter(req.adminId), role: { $in: MEMBER_ROLES } };
    }

    const users = await User.find(filter)
      .select("-password -permissions")
      .populate("admin_id", "name email companyName")
      .populate("customRole", "name baseRole")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      count: users.length,
      data: users.map((u) => ({
        ...u,
        organization: u.admin_id
          ? { _id: u.admin_id._id, name: u.admin_id.name, companyName: u.admin_id.companyName || "" }
          : u.role === "Admin"
          ? { _id: u._id, name: u.name, companyName: u.companyName || "" }
          : null,
        admin_id: u.admin_id?._id || u.admin_id || null,
        customRole: u.customRole?._id || null,
        customRoleName: u.customRole?.name || "",
      })),
    });
  } catch (error) {
    console.error("Get Users Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== GET ALL ADMINS (SuperAdmin only) ====================
export const getAllAdmins = async (req, res) => {
  try {
    const admins = await User.find({ role: "Admin" })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    // Organization size per Admin (for the SuperAdmin dashboard)
    const counts = await User.aggregate([
      { $match: { role: { $in: MEMBER_ROLES } } },
      { $project: { org: { $ifNull: ["$admin_id", "$createdBy"] }, role: 1, status: 1 } },
      {
        $group: {
          _id: "$org",
          members: { $sum: 1 },
          managers: { $sum: { $cond: [{ $eq: ["$role", "Manager"] }, 1, 0] } },
          activeMembers: { $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] } },
        },
      },
    ]);
    const byOrg = Object.fromEntries(counts.map((c) => [String(c._id), c]));

    const data = admins.map((a) => ({
      ...a,
      members: byOrg[String(a._id)]?.members || 0,
      managers: byOrg[String(a._id)]?.managers || 0,
      activeMembers: byOrg[String(a._id)]?.activeMembers || 0,
    }));

    return res.status(200).json({
      success: true,
      message: "Admins fetched successfully",
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Get Admins Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Can the requester see / manage this account?
const canManageAccount = (requester, target) => {
  if (requester.role === "SuperAdmin") return target.role !== "SuperAdmin";
  if (!MEMBER_ROLES.includes(target.role)) return false;
  // Managers (with users.* permissions) only manage Team Members, never other Managers
  if (requester.role === "Manager" && target.role !== "User") return false;
  const orgId = requester.role === "Admin" ? requester._id : requester.admin_id;
  const targetOrg = target.admin_id || target.createdBy;
  return Boolean(orgId && targetOrg && String(targetOrg) === String(orgId));
};

// ==================== GET SINGLE USER ====================
export const getUserById = async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format",
      });
    }

    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const isSelf = String(user._id) === String(req.user._id);
    if (!isSelf && !canManageAccount(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. This user is outside your organization.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User fetched successfully",
      data: user,
    });
  } catch (error) {
    console.error("Get User Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== UPDATE USER ====================
export const updateUser = async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format",
      });
    }

    const existingUser = await User.findById(req.params.id);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!canManageAccount(req.user, existingUser)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only update users in your organization.",
      });
    }

    const { name, email, phone, department, status, password } = req.body;
    let { role } = req.body;

    // Organization-defined role: "" clears it, an id sets it (and its base access level)
    let customRoleUpdate;
    if (req.body.customRoleId !== undefined && existingUser.role !== "Admin") {
      if (!req.body.customRoleId) {
        customRoleUpdate = null;
      } else {
        try {
          const cr = await loadCustomRole(req.body.customRoleId, existingUser.admin_id || existingUser.createdBy);
          customRoleUpdate = cr._id;
          role = cr.baseRole;
        } catch (err) {
          return res.status(err.status || 400).json({ success: false, message: err.message });
        }
      }
      if (String(customRoleUpdate || "") !== String(existingUser.customRole || "") && !hasPermission(req, "users", "assign")) {
        return res.status(403).json({ success: false, message: "Access denied. You do not have permission to change roles." });
      }
    }

    // ⭐ Only an administrator sets passwords; the user views it via a one-time email link
    if (password !== undefined && password !== "") {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }
      if (String(existingUser._id) === String(req.user._id)) {
        return res.status(403).json({ success: false, message: "Use Settings → Security to change your own password." });
      }
    }

    // ⭐ ROLE CHANGE — needs users.assign + an allowed target role
    if (role !== undefined && role !== existingUser.role) {
      if (!hasPermission(req, "users", "assign")) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You do not have permission to change roles.",
        });
      }
      if (String(existingUser._id) === String(req.user._id)) {
        return res.status(403).json({ success: false, message: "You cannot change your own role." });
      }
      const allowed = assignableRolesFor(req.user);
      if (!allowed.includes(role)) {
        return res.status(403).json({
          success: false,
          message: `You are not allowed to assign the role "${role}"`,
        });
      }
      // Admin owns an organization; members belong to one — switching would orphan data.
      if ((role === "Admin") !== (existingUser.role === "Admin")) {
        return res.status(400).json({
          success: false,
          message:
            "Admins own an organization. Create a new Admin account instead of converting between Admin and member roles.",
        });
      }
    }

    // Check email conflict
    if (email && email.toLowerCase().trim() !== existingUser.email) {
      const emailTaken = await User.findOne({ email: email.toLowerCase().trim() });
      if (emailTaken) {
        return res.status(409).json({
          success: false,
          message: "Email already in use",
        });
      }
    }

    const updateFields = {};
    if (name) updateFields.name = name;
    if (email) updateFields.email = email;
    if (phone !== undefined) updateFields.phone = phone;
    if (department !== undefined) updateFields.department = department;
    if (status) updateFields.status = status;
    if (role !== undefined) updateFields.role = role;
    if (customRoleUpdate !== undefined) updateFields.customRole = customRoleUpdate;
    // Company name belongs to Admin accounts; only the Super Admin changes it
    if (req.body.companyName !== undefined && existingUser.role === "Admin" && req.user.role === "SuperAdmin") {
      const companyName = String(req.body.companyName).trim();
      if (!companyName) return res.status(400).json({ success: false, message: "Company name cannot be empty" });
      updateFields.companyName = companyName;
    }
    // ⭐ admin_id, createdBy, permissions are NEVER taken from the body

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    ).select("-password -permissions");

    let note = "";
    if (password) {
      const target = await User.findById(req.params.id).select("+password");
      const sent = await applyAdminPassword(req, target, String(password));
      note = sent.sent
        ? " New password set — the user was emailed a one-time link to view it."
        : ` New password set, but the email could not be sent (${sent.reason}).`;
    }

    return res.status(200).json({
      success: true,
      message: "User updated successfully." + note,
      data: updatedUser,
    });
  } catch (error) {
    console.error("Update User Error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.join(", "),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== DELETE USER ====================
export const deleteUser = async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format",
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account." });
    }

    if (!canManageAccount(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only delete users in your organization.",
      });
    }

    // Deleting an Admin would orphan his whole organization
    if (user.role === "Admin") {
      const members = await User.countDocuments(orgMemberFilter(user._id));
      if (members > 0) {
        return res.status(409).json({
          success: false,
          message: `This Admin still has ${members} user(s). Deactivate the Admin instead, or remove the users first.`,
        });
      }
    }

    await User.findByIdAndDelete(req.params.id);

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Delete User Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== ASSIGNABLE USERS (task assignment dropdown) ====================
// @route  GET /api/users/assignable
export const getAssignableUsers = async (req, res) => {
  try {
    // Anyone without tasks.assign can only see himself (self-assigned tasks)
    if (!hasPermission(req, "tasks", "assign") && !hasPermission(req, "taskbank", "assign")) {
      const me = await User.findById(req.user._id).select("name email department role").lean();
      return res.status(200).json({ success: true, data: MEMBER_ROLES.includes(me?.role) ? [me] : [] });
    }

    let filter;
    if (req.user.role === "SuperAdmin") {
      filter = { role: { $in: MEMBER_ROLES }, status: "Active" };
      if (validateObjectId(req.query.adminId)) {
        filter = { ...orgMemberFilter(req.query.adminId), ...filter };
      }
    } else {
      filter = { ...orgMemberFilter(req.adminId), role: { $in: MEMBER_ROLES }, status: "Active" };
    }

    const users = await User.find(filter)
      .select("name email department role admin_id")   // 🔒 safe fields only
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ success: true, data: users });
  } catch (error) {
    console.error("getAssignableUsers error:", error);
    res.status(500).json({ success: false, message: "Failed to load assignable users" });
  }
};


// ==================== GET /api/admins/:id/overview (SuperAdmin) ====================
// One Admin's organization ONLY: team, tasks, meetings, tickets — never mixed with others.
export const getAdminOverview = async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid admin ID format" });
    }
    const admin = await User.findOne({ _id: req.params.id, role: "Admin" })
      .select("name email phone department companyName status createdAt emailVerified")
      .lean();
    if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

    const orgId = admin._id;
    const members = await User.find({ ...orgMemberFilter(orgId), role: { $in: MEMBER_ROLES } })
      .select("name email department role status customRole createdAt")
      .populate("customRole", "name")
      .sort({ createdAt: -1 })
      .lean();
    const orgUserIds = [orgId, ...members.map((m) => m._id)];

    const now = new Date();
    const taskScope = { admin_id: orgId, isTaskBank: { $ne: true } };
    const [byStatus, overdue, departments, meetings, openTickets, recentTasks] = await Promise.all([
      Task.aggregate([{ $match: taskScope }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      Task.countDocuments({ ...taskScope, status: { $ne: "Completed" }, dueDate: { $lt: now } }),
      Department.countDocuments({ $or: [{ admin_id: orgId }, { createdBy: orgId }] }),
      Meeting.countDocuments({ createdBy: { $in: orgUserIds } }),
      Ticket.countDocuments({ user: { $in: orgUserIds }, status: { $in: ["Open", "In Progress"] } }),
      Task.find(taskScope)
        .select("name status priority dueDate assignedTo createdAt")
        .populate("assignedTo", "name")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);
    const statusCount = Object.fromEntries(byStatus.map((b) => [b._id, b.n]));
    const totalTasks = byStatus.reduce((sum, b) => sum + b.n, 0);

    res.json({
      success: true,
      data: {
        admin,
        stats: {
          members: members.length,
          managers: members.filter((m) => m.role === "Manager").length,
          users: members.filter((m) => m.role === "User").length,
          activeMembers: members.filter((m) => m.status === "Active").length,
          inactiveMembers: members.filter((m) => m.status !== "Active").length,
          departments,
          tasks: {
            total: totalTasks,
            todo: statusCount["To Do"] || 0,
            inProgress: statusCount["In Progress"] || 0,
            review: statusCount.Review || 0,
            completed: statusCount.Completed || 0,
            overdue,
            completionRate: totalTasks ? Math.round(((statusCount.Completed || 0) / totalTasks) * 100) : 0,
          },
          meetings,
          openTickets,
        },
        members: members.map((m) => ({ ...m, customRoleName: m.customRole?.name || "" })),
        recentTasks: recentTasks.map((t) => ({
          _id: t._id,
          name: t.name,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
          assignedUser: t.assignedTo?.name || "",
          createdAt: t.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("Admin Overview Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
