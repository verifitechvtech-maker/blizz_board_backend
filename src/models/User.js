import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false, // hide password by default in queries
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    role: {
      type: String,
      enum: ["SuperAdmin", "Admin", "Manager", "User"],
      default: "User",
    },
    department: {
      type: String,
      trim: true,
      default: "",
    },
    // Admin accounts: the company / organization this Admin runs
    companyName: {
      type: String,
      trim: true,
      default: "",
      maxlength: [120, "Company name must be at most 120 characters"],
    },
    // Optional organization-defined role (title + permissions); `role` stays the access level
    customRole: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomRole",
      default: null,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    // WHO created this user — for data isolation (audit)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // ⭐⭐⭐ NEW — ORGANIZATION ISOLATION KEY
    // User → his admin's _id | Admin → null (he IS the root, scope uses his own _id)
    // WITHOUT THIS FIELD, Mongoose silently drops admin_id in createUser!
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    // ⭐ NEW — reward points (taskController adds points when task completed)
    points: {
      type: Number,
      default: 0,
    },
    // Admin accounts — modules/actions this Admin may use AND grant to their
    // Managers/Users. Set by SuperAdmin. null → full access.
    // Manager/User accounts — individual access set by their Admin (Roles →
    // Individuals); replaces the role's permissions. null → follow the role.
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // ⭐ Email verification for accounts created by an administrator.
    // false → cannot log in yet. undefined (older accounts) → treated as verified.
    emailVerified: { type: Boolean },
    emailVerifiedAt: { type: Date, default: null },
    verificationTokenHash: { type: String, select: false, default: null },
    verificationExpires: { type: Date, select: false, default: null },
    // Admin-set password, AES-encrypted, kept ONLY until the user views it once
    pendingPasswordEnc: { type: String, select: false, default: null },
    passwordRevealedAt: { type: Date, default: null },
    // Activity (shown to Admin / SuperAdmin on the Activity page)
    lastLoginAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    lastPage: { type: String, default: "" },
    bio: {
      type: String,
      trim: true,
      default: "",
      maxlength: [500, "Bio must be at most 500 characters"],
    },
    // Voice profile the user recorded themselves (with consent) so meeting transcripts can
    // show their name. Only a voice vector is kept — not the audio. Hidden from queries.
    voiceProfile: {
      embedding: { type: [Number], select: false, default: undefined },
      seconds: { type: Number, default: 0 },
      consentAt: { type: Date, default: null },
      updatedAt: { type: Date, default: null },
    },
    // Personal preferences shown on the Settings page.
    preferences: {
      microphone: { type: Boolean, default: true },
      keepAwake: { type: Boolean, default: true },
      aiSummary: { type: Boolean, default: true },
      emailNotifications: { type: Boolean, default: true },
      taskReminders: { type: Boolean, default: true },
      desktopNotifications: { type: Boolean, default: true }, // browser push notifications
      telegramNotifications: { type: Boolean, default: true }, // sent to the connected Telegram bot chat
      aiProvider: { type: String, default: "Gemini" },
      language: { type: String, default: "English" },
      timezone: { type: String, default: "Asia/Kolkata" },
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;