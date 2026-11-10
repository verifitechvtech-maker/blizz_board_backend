import mongoose from "mongoose";
import dotenv from "dotenv";
import { server } from "./app.js";
import { startMeetingReminderJob } from "./jobs/meetingReminderJob.js";
import { startTaskReminderJob } from "./jobs/taskReminderJob.js";
import { startChatExpiryJob } from "./jobs/chatExpiryJob.js";
import { startEmailTaskInboxJob } from "./jobs/emailTaskInboxJob.js";
import { backfillReferenceIds } from "./services/referenceIdService.js";
import { resumeInterruptedTranscriptions } from "./services/transcriptionService.js";
import { startTelegramBot } from "./services/telegram/telegramBot.js";

dotenv.config();

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is missing from .env");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log("✅ Socket.IO initialized");
      console.log("✅ Chat REST routes registered at /api/chat");
      console.log("✅ Task attachments: GET /api/tasks/attachments/:filename (authenticated)");

      startMeetingReminderJob();
      startTaskReminderJob();
      startChatExpiryJob();
      startTelegramBot(); // off unless TELEGRAM_BOT_TOKEN is set
      startEmailTaskInboxJob(); // off unless TASK_INBOX_ENABLED=true
      // older tasks get a department reference ID (FF1, FF2…) so every task shows one
      backfillReferenceIds()
        .then(({ assigned, skipped }) => {
          if (assigned || skipped) {
            console.log(`✅ Reference IDs: ${assigned} older task(s) numbered${skipped ? `, ${skipped} without a known department` : ""}`);
          }
        })
        .catch((e) => console.error("Reference ID backfill failed:", e.message));
      resumeInterruptedTranscriptions().catch((e) => console.error("Transcription resume failed:", e.message));
    });
  })
  .catch((error) => {
    console.error("❌ MongoDB connection failed:", error.message);
    process.exit(1);
  });