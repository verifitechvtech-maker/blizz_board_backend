import mongoose from "mongoose";

// One Telegram chat ↔ one app account. The bot acts as this user (same permissions as the web app).
const telegramLinkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    chatId: { type: String, required: true, unique: true },
    username: { type: String, default: "" },
    firstName: { type: String, default: "" },
    linkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Short-lived one-time code made on the Settings page; the bot exchanges it for a link.
// Only the hash is stored; MongoDB removes expired codes on its own (TTL index).
const telegramLinkCodeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  codeHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export const TelegramLinkCode =
  mongoose.models.TelegramLinkCode || mongoose.model("TelegramLinkCode", telegramLinkCodeSchema);

export default mongoose.models.TelegramLink || mongoose.model("TelegramLink", telegramLinkSchema);
