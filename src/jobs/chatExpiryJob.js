import cron from "node-cron";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import { backupFilesOf, backfillChatFileBackups } from "../services/chatBackupService.js";

// Disappearing messages: every minute, delete messages past their expiresAt
// (their files are moved to the chat backup, never deleted),
// then point each chat at its newest remaining message.
export const sweepExpiredMessages = async () => {
  const expired = await Message.find({ expiresAt: { $lte: new Date() } })
    .select("_id conversation sender attachments createdAt")
    .limit(1000)
    .lean();

  if (!expired.length) return 0;

  await backupFilesOf(expired);

  await Message.deleteMany({ _id: { $in: expired.map((m) => m._id) } });

  const conversationIds = [...new Set(expired.map((m) => String(m.conversation)))];
  for (const id of conversationIds) {
    const latest = await Message.findOne({ conversation: id }).sort({ createdAt: -1 }).select("_id createdAt").lean();
    await Conversation.updateOne(
      { _id: id },
      latest ? { lastMessage: latest._id, lastMessageAt: latest.createdAt } : { lastMessage: null }
    );
  }

  return expired.length;
};

export const startChatExpiryJob = () => {
  backfillChatFileBackups()
    .then((n) => n && console.log(`🗂️  Chat file backup: recorded ${n} earlier file(s)`))
    .catch((err) => console.error("chat backup backfill:", err.message));
  cron.schedule("* * * * *", async () => {
    try {
      await sweepExpiredMessages();
    } catch (err) {
      console.error("chatExpiryJob:", err.message);
    }
  });
  console.log("🕒 Disappearing-messages cleanup started (every minute)");
};
