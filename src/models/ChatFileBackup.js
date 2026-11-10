import mongoose from "mongoose";

// Every file shared in chat. When a disappearing message is deleted, its file is moved
// to uploads/chat-backup and stays listed here (Settings → Chat file backup).
const chatFileBackupSchema = new mongoose.Schema(
  {
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // organization
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", default: null },
    conversationType: { type: String, default: "" },
    conversationName: { type: String, default: "" },
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    senderName: { type: String, default: "" },
    // sender + everyone who received it
    visibleTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    filename: { type: String, required: true, unique: true }, // stored name on disk
    name: { type: String, required: true }, // original name
    size: { type: Number, default: 0 },
    mimetype: { type: String, default: "" },
    sharedAt: { type: Date, default: Date.now },

    // "chat" → still in the conversation (uploads/chat) · "backup" → message gone, file in uploads/chat-backup
    location: { type: String, enum: ["chat", "backup"], default: "chat" },
    messageDeletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

chatFileBackupSchema.index({ visibleTo: 1, sharedAt: -1 });

const ChatFileBackup =
  mongoose.models.ChatFileBackup || mongoose.model("ChatFileBackup", chatFileBackupSchema);

export default ChatFileBackup;
