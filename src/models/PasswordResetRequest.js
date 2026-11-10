import mongoose from "mongoose";

// "Forgot password" requests — handled by the user's Admin
// (or SuperAdmin when an Admin forgets his own password).
const passwordResetRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Organization that handles it; null → SuperAdmin
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    status: { type: String, enum: ["Pending", "Completed", "Dismissed"], default: "Pending", index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.models.PasswordResetRequest ||
  mongoose.model("PasswordResetRequest", passwordResetRequestSchema);
