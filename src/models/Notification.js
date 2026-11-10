import mongoose from "mongoose";
import { emitToUser } from "../socket/realtime.js";
import { pushNotificationDoc } from "../services/pushService.js";
import { telegramNotificationDoc } from "../services/telegram/telegramNotify.js";

// In-app notifications (dashboard panel). Emails are sent alongside when allowed.
export const NOTIFICATION_TYPES = [
  "task_assigned", "task_reassigned", "task_reminder", "task_overdue", "task_status",
  "task_completed", "task_rework", "task_subtask", "task_viewed", "task_comment",
  "support_ticket", "support_reply",
];

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    taskName: { type: String, default: "" },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "" },
    fromStatus: { type: String, default: "" },
    toStatus: { type: String, default: "" },
    message: { type: String, default: "" },
    // Task completed → points earned, new score, level-up, new badges (the "you win" screen)
    celebration: { type: mongoose.Schema.Types.Mixed, default: null },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });

// ⭐ Real time: every new notification is pushed to the recipient's open tabs immediately
notificationSchema.post("save", function (doc) {
  if (this.$locals.wasNew === false) return;
  emitToUser(doc.recipient, "notification:new", doc.toObject());
  // ...and to the recipient's browsers as a push notification, even with the app closed
  pushNotificationDoc(doc).catch((err) => console.error("[push]", err.message));
  // ...and to their Telegram, if they connected the bot
  telegramNotificationDoc(doc).catch((err) => console.error("[telegram]", err.message));
});
notificationSchema.pre("save", function (next) {
  this.$locals.wasNew = this.isNew;
  next();
});

export default mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
