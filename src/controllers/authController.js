import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { resolvePermissions } from "../middleware/permissionMiddleware.js";
import { logActivity } from "../services/activityService.js";
export { verifyEmail, forgotPassword } from "./accountController.js";

// Safe public shape of the logged-in account (never password / tokens)
const shapeMe = (user, permissions) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  department: user.department,
  status: user.status,
  emailVerified: user.emailVerified !== false,
  bio: user.bio || "",
  points: user.points || 0,
  admin_id: user.admin_id || null,
  preferences: user.preferences || {},
  permissions,
  createdAt: user.createdAt,
});

// Generate JWT Token
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      email: user.email,
      admin_id: user.admin_id || null, // ⭐ NEW LINE ADDED (1 of 2)
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || "7d" }
  );
};

// ==================== LOGIN ====================
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Find user WITH password (select: false by default)
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Check if user is active
    if (user.status === "Inactive") {
      return res.status(403).json({
        success: false,
        message: "Your account is deactivated. Contact admin.",
      });
    }

    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logActivity(user, { type: "login_failed", action: "Wrong password at login", req });
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // ⭐ Accounts created by an administrator must verify their email first
    if (user.emailVerified === false) {
      return res.status(403).json({
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email first. Open the verification link sent to your inbox.",
      });
    }

    const token = generateToken(user);
    const permissions = await resolvePermissions(user);

    const now = new Date();
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, lastSeenAt: now } });
    logActivity(user, { type: "login", action: "Logged in", req });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        ...shapeMe(user, permissions),
        token,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== GET MY PROFILE ====================
// Also returns the CURRENT role + permissions so the frontend can refresh them.
export const getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile fetched successfully",
      data: shapeMe(user, await resolvePermissions(user)),
    });
  } catch (error) {
    console.error("Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== UPDATE MY PROFILE ====================
// Personal fields only. Role, email, department, status and org are managed
// by an Admin on the Users page (department drives Manager data scope).
export const updateMyProfile = async (req, res) => {
  try {
    const { name, phone, bio } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ success: false, message: "Name cannot be empty" });
      }
      updates.name = String(name).trim();
    }
    if (phone !== undefined) {
      const clean = String(phone).trim();
      if (clean && !/^[+\d][\d\s-]{5,19}$/.test(clean)) {
        return res.status(400).json({ success: false, message: "Enter a valid phone number" });
      }
      updates.phone = clean;
    }
    if (bio !== undefined) updates.bio = String(bio);

    // Admins own their organization — they may set their own department
    if (req.body.department !== undefined && ["Admin", "SuperAdmin"].includes(req.user.role)) {
      updates.department = String(req.body.department).trim();
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: shapeMe(user, await resolvePermissions(user)),
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map((e) => e.message).join(", "),
      });
    }
    console.error("Update Profile Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ==================== UPDATE MY PREFERENCES ====================
const PREFERENCE_BOOLEANS = [
  "microphone", "keepAwake", "aiSummary",
  "emailNotifications", "taskReminders", "desktopNotifications", "telegramNotifications",
];
const PREFERENCE_CHOICES = {
  aiProvider: ["Gemini", "OpenAI", "Disabled"],
  language: ["English", "Tamil", "Hindi"],
  timezone: ["Asia/Kolkata", "Asia/Singapore", "Europe/London", "America/New_York"],
};

export const updateMyPreferences = async (req, res) => {
  try {
    const updates = {};
    for (const key of PREFERENCE_BOOLEANS) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== "boolean") {
          return res.status(400).json({ success: false, message: `${key} must be true or false` });
        }
        updates[`preferences.${key}`] = req.body[key];
      }
    }
    for (const [key, allowed] of Object.entries(PREFERENCE_CHOICES)) {
      if (req.body[key] !== undefined) {
        if (!allowed.includes(req.body[key])) {
          return res.status(400).json({ success: false, message: `Invalid ${key}. Allowed: ${allowed.join(", ")}` });
        }
        updates[`preferences.${key}`] = req.body[key];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: "No valid preferences to update" });
    }

    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true });
    return res.status(200).json({
      success: true,
      message: "Preferences saved",
      data: user.preferences,
    });
  } catch (error) {
    console.error("Update Preferences Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ==================== CHANGE PASSWORD ====================
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      // 400 (not 401) so the frontend does not treat it as an expired session
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    user.password = newPassword; // pre-save hook will hash it
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change Password Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};