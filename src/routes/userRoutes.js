import express from "express";
import {
  createAdmin,
  createUser,
  getAllUsers,
  getAllAdmins,
  getUserById,
  updateUser,
  deleteUser,
  getAssignableUsers, // ✅ NEW import
  getAdminOverview,
} from "../controllers/userController.js";
import {
  setUserPassword,
  resendVerification,
  getResetRequests,
  dismissResetRequest,
} from "../controllers/accountController.js";
import { authenticate } from "../middleware/auth.js";
import { authorize } from "../middleware/role.js";
import { requirePermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();

// ==================== SUPERADMIN ROUTES ====================
// SuperAdmin creates Admin
router.post(
  "/admins",
  authenticate,
  authorize("SuperAdmin"),
  createAdmin
);

// SuperAdmin gets all Admins
router.get(
  "/admins",
  authenticate,
  authorize("SuperAdmin"),
  getAllAdmins
);

// SuperAdmin: one Admin's organization statistics (never mixed with other Admins)
router.get(
  "/admins/:id/overview",
  authenticate,
  authorize("SuperAdmin"),
  getAdminOverview
);

// ==================== TASK ASSIGNMENT ROUTE ====================
// Lightweight user list for task assignment. Scoped to the caller's
// organization; returns only SAFE fields.
//
// ⚠️ IMPORTANT: This MUST be declared BEFORE "/users/:id",
// otherwise Express treats "assignable" as an :id and
// calls getUserById instead!
router.get(
  "/users/assignable",
  authenticate,
  getAssignableUsers
);

// ==================== USER MANAGEMENT (permission based) ====================
// Admin / SuperAdmin / Managers granted users.* — org isolation is enforced in the controller
router.post(
  "/users",
  authenticate,
  requirePermission("users", "create"),
  createUser
);

router.get(
  "/users",
  authenticate,
  requirePermission("users", "view"),
  getAllUsers
);

router.get(
  "/users/:id",
  authenticate,
  requirePermission("users", "view"),
  getUserById
);

router.put(
  "/users/:id",
  authenticate,
  requirePermission("users", "edit"),
  updateUser
);

router.delete(
  "/users/:id",
  authenticate,
  requirePermission("users", "delete"),
  deleteUser
);

// ==================== PASSWORDS (set by administrators only) ====================
router.post("/users/:id/set-password", authenticate, requirePermission("users", "edit"), setUserPassword);
router.post("/users/:id/resend-verification", authenticate, requirePermission("users", "edit"), resendVerification);

// Forgot-password requests waiting for this administrator
router.get("/password-requests", authenticate, requirePermission("users", "edit"), getResetRequests);
router.patch("/password-requests/:id/dismiss", authenticate, requirePermission("users", "edit"), dismissResetRequest);

export default router;
