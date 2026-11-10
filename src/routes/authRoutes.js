import express from "express";
import {
  login,
  getMyProfile,
  updateMyProfile,
  updateMyPreferences,
  changePassword,
  verifyEmail,
  forgotPassword,
} from "../controllers/authController.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();

router.post("/login", login);
// Public — one-time email verification + password reveal, and forgot-password requests
router.post("/verify-email", verifyEmail);
router.post("/forgot-password", forgotPassword);
router.get("/me", authenticate, getMyProfile);
router.put("/me", authenticate, requirePermission("settings", "edit"), updateMyProfile);
router.put("/me/preferences", authenticate, requirePermission("settings", "edit"), updateMyPreferences);
// Password change is account security — always allowed for the account owner
router.put("/change-password", authenticate, changePassword);

export default router;
