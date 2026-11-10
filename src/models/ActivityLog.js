import mongoose from "mongoose";

/* =========================================================
   Activity log — who did what and when (logins, pages opened,
   tasks created / updated…). Only Admin / SuperAdmin can read it.
   Old entries are removed automatically after 180 days.
========================================================= */

export const ACTIVITY_TYPES = ["login", "login_failed", "logout", "page_view", "action"];

const activityLogSchema = new mongoose.Schema(
  {
    // organization the person belongs to (an Admin's own _id for Admins, null for SuperAdmin)
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userName: { type: String, default: "" },
    userEmail: { type: String, default: "" },
    role: { type: String, default: "" },
    department: { type: String, default: "" },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    action: { type: String, default: "", maxlength: 200 }, // "Created a task", "Opened Tasks"
    detail: { type: String, default: "", maxlength: 300 }, // "#DEV12 web page → Review"
    page: { type: String, default: "", maxlength: 200 },
    method: { type: String, default: "" },
    path: { type: String, default: "", maxlength: 300 },
    ip: { type: String, default: "" },
    device: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

activityLogSchema.index({ admin_id: 1, at: -1 });
activityLogSchema.index({ user: 1, at: -1 });
activityLogSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const ActivityLog = mongoose.models.ActivityLog || mongoose.model("ActivityLog", activityLogSchema);

export default ActivityLog;
