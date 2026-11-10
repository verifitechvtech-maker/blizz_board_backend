import mongoose from "mongoose";

// One row per email read from the task inbox (create-task-by-email).
// messageId is unique, so the same email is never turned into tasks twice.
const inboundTaskEmailSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true },
    from: { type: String, default: "" },
    subject: { type: String, default: "" },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // created → tasks made · rejected → sender was told why · ignored → not for us (no reply)
    status: { type: String, enum: ["created", "rejected", "ignored"], required: true },
    reason: { type: String, default: "" },
    tasks: [{ type: mongoose.Schema.Types.ObjectId, ref: "Task" }],
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.models.InboundTaskEmail ||
  mongoose.model("InboundTaskEmail", inboundTaskEmailSchema);
