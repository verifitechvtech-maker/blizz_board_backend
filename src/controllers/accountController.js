import mongoose from "mongoose";
import User from "../models/User.js";
import PasswordResetRequest from "../models/PasswordResetRequest.js";
import { encryptSecret, decryptSecret, newToken, hashToken } from "../utils/credentialCrypto.js";
import { sendVerificationEmail, sendResetRequestNotification } from "../services/accountEmailService.js";
import { MEMBER_ROLES } from "../config/permissions.js";

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // link valid 24h
export const REVEAL_SECONDS = 30;                       // password visible 30s

const validId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Store the admin-set password (encrypted) + a one-time token, and email the link.
 * `user` must be a saved User document. Returns { sent, reason }.
 */
export const issueVerification = async (user, plainPassword, reason = "welcome") => {
  const token = newToken();
  user.verificationTokenHash = hashToken(token);
  user.verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MS);
  user.pendingPasswordEnc = encryptSecret(plainPassword);
  user.passwordRevealedAt = null;
  if (reason === "welcome") {
    user.emailVerified = false;
    user.emailVerifiedAt = null;
  }
  await user.save();
  return sendVerificationEmail(user, token, reason);
};

// Who may manage this account (same rules as the Users page)
const canManage = (requester, target) => {
  if (requester.role === "SuperAdmin") return target.role !== "SuperAdmin";
  if (!MEMBER_ROLES.includes(target.role)) return false;
  if (requester.role === "Manager" && target.role !== "User") return false;
  const orgId = requester.role === "Admin" ? requester._id : requester.admin_id;
  const targetOrg = target.admin_id || target.createdBy;
  return Boolean(orgId && targetOrg && String(orgId) === String(targetOrg));
};

// ==================== POST /api/auth/verify-email  (public) ====================
// Verifies the email AND returns the admin-set password exactly once.
export const verifyEmail = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const token = String(req.body?.token || "");
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ success: false, message: "Invalid verification link." });
    }

    const user = await User.findOne({ verificationTokenHash: hashToken(token) }).select(
      "+verificationTokenHash +verificationExpires +pendingPasswordEnc"
    );
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "This link was already used or is no longer valid. Ask your administrator to send a new one.",
      });
    }
    if (!user.verificationExpires || user.verificationExpires < new Date()) {
      return res.status(410).json({
        success: false,
        message: "This verification link has expired. Ask your administrator to send a new one.",
      });
    }

    let password = null;
    if (user.pendingPasswordEnc) {
      try {
        password = decryptSecret(user.pendingPasswordEnc);
      } catch {
        password = null; // key changed — admin must set a new password
      }
    }

    // ⭐ One-time: token and stored password are destroyed NOW, before responding
    user.emailVerified = true;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    user.verificationTokenHash = null;
    user.verificationExpires = null;
    user.pendingPasswordEnc = null;
    user.passwordRevealedAt = new Date();
    await user.save();

    return res.json({
      success: true,
      message: "Email verified successfully.",
      data: {
        name: user.name,
        email: user.email,
        password,
        visibleForSeconds: REVEAL_SECONDS,
      },
    });
  } catch (error) {
    console.error("Verify Email Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ==================== POST /api/auth/forgot-password  (public) ====================
// Creates a request for the responsible administrator and notifies them by email.
// Always answers the same way so it cannot be used to discover accounts.
export const forgotPassword = async (req, res) => {
  const generic = {
    success: true,
    message: "If an account exists for this email, your administrator has been notified to reset your password.",
  };
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }

    const user = await User.findOne({ email });
    if (!user || user.status === "Inactive" || user.role === "SuperAdmin") return res.json(generic);

    // Members → their Admin; Admins → SuperAdmin(s)
    const handlerOrg = user.role === "Admin" ? null : user.admin_id || user.createdBy || null;

    // One open request at a time per user (no notification spam)
    const open = await PasswordResetRequest.findOne({ user: user._id, status: "Pending" });
    if (open) return res.json(generic);

    await PasswordResetRequest.create({ user: user._id, admin_id: handlerOrg });

    const handlers = handlerOrg
      ? await User.find({ _id: handlerOrg, role: "Admin", status: "Active" })
      : await User.find({ role: "SuperAdmin", status: "Active" });
    await Promise.all(handlers.map((h) => sendResetRequestNotification(h, user)));

    return res.json(generic);
  } catch (error) {
    console.error("Forgot Password Error:", error);
    return res.json(generic);
  }
};

// ==================== GET /api/password-requests ====================
export const getResetRequests = async (req, res) => {
  try {
    const status = ["Pending", "Completed", "Dismissed"].includes(req.query.status) ? req.query.status : "Pending";
    const filter = { status };
    if (req.user.role !== "SuperAdmin") filter.admin_id = req.adminId;

    const requests = await PasswordResetRequest.find(filter)
      .populate("user", "name email role department status admin_id createdBy")
      .sort({ createdAt: -1 })
      .lean();

    const data = requests
      .filter((r) => r.user && canManage(req.user, r.user))
      .map((r) => ({
        _id: r._id,
        status: r.status,
        requestedAt: r.createdAt,
        user: { _id: r.user._id, name: r.user.name, email: r.user.email, role: r.user.role, department: r.user.department },
      }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Get Reset Requests Error:", error);
    res.status(500).json({ success: false, message: "Failed to load password requests" });
  }
};

// ==================== PATCH /api/password-requests/:id/dismiss ====================
export const dismissResetRequest = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid request ID" });
    const request = await PasswordResetRequest.findOne({ _id: req.params.id, status: "Pending" }).populate("user");
    if (!request || !request.user || !canManage(req.user, request.user)) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    request.status = "Dismissed";
    request.resolvedBy = req.user._id;
    request.resolvedAt = new Date();
    await request.save();
    res.json({ success: true, message: "Request dismissed" });
  } catch (error) {
    console.error("Dismiss Reset Request Error:", error);
    res.status(500).json({ success: false, message: "Failed to dismiss request" });
  }
};

/**
 * Admin sets a new password for an account (used by PUT /users/:id with `password`
 * and by POST /users/:id/set-password). Sends a fresh one-time reveal link and
 * closes open reset requests. `target` must be loaded with select("+password").
 */
export const applyAdminPassword = async (req, target, password) => {
  target.password = password; // pre-save hook hashes it
  await target.save();
  const email = await issueVerification(target, password, "reset");
  await PasswordResetRequest.updateMany(
    { user: target._id, status: "Pending" },
    { status: "Completed", resolvedBy: req.user._id, resolvedAt: new Date() }
  );
  return email;
};

// ==================== POST /api/users/:id/set-password ====================
export const setUserPassword = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid user ID format" });
    const password = String(req.body?.password || "");
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }
    const target = await User.findById(req.params.id).select("+password");
    if (!target) return res.status(404).json({ success: false, message: "User not found" });
    if (String(target._id) === String(req.user._id) || !canManage(req.user, target)) {
      return res.status(403).json({ success: false, message: "Access denied. You cannot reset this account's password." });
    }

    const email = await applyAdminPassword(req, target, password);
    res.json({
      success: true,
      message: email.sent
        ? `New password set. ${target.name} has been emailed a one-time link to view it.`
        : `New password set, but the email could not be sent (${email.reason}).`,
      emailSent: email.sent,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: Object.values(error.errors).map((e) => e.message).join(", ") });
    }
    console.error("Set User Password Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ==================== POST /api/users/:id/resend-verification ====================
// New link for a pending password. If it was already viewed, the admin must set a new one.
export const resendVerification = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid user ID format" });
    const target = await User.findById(req.params.id).select("+pendingPasswordEnc");
    if (!target) return res.status(404).json({ success: false, message: "User not found" });
    if (!canManage(req.user, target)) return res.status(403).json({ success: false, message: "Access denied." });

    if (!target.pendingPasswordEnc) {
      return res.status(409).json({
        success: false,
        message: "The password was already viewed. Set a new password to send a new link.",
      });
    }
    const plain = decryptSecret(target.pendingPasswordEnc);
    const email = await issueVerification(target, plain, target.emailVerified === false ? "welcome" : "reset");
    res.json({
      success: email.sent,
      message: email.sent ? `Verification email sent to ${target.email}.` : `Email could not be sent (${email.reason}).`,
      emailSent: email.sent,
    });
  } catch (error) {
    console.error("Resend Verification Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
