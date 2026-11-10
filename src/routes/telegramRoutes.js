import express from "express";
import crypto from "crypto";
import TelegramLink, { TelegramLinkCode } from "../models/TelegramLink.js";
import { getBotInfo, sendMessage, telegramEnabled } from "../services/telegram/telegramApi.js";
import { hashLinkCode } from "../services/telegram/telegramBot.js";

const router = express.Router();

const CODE_LIFETIME_MIN = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const newCode = () =>
  Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

const botUsername = async () => {
  if (!telegramEnabled()) return "";
  try {
    return (await getBotInfo())?.username || "";
  } catch {
    return "";
  }
};

// GET /api/telegram/status — is the bot on, and is my account connected?
router.get("/status", async (req, res, next) => {
  try {
    const link = await TelegramLink.findOne({ user: req.user._id }).lean();
    res.json({
      success: true,
      data: {
        enabled: telegramEnabled(),
        botUsername: await botUsername(),
        linked: Boolean(link),
        username: link?.username || "",
        firstName: link?.firstName || "",
        linkedAt: link?.linkedAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/telegram/link-code — one-time code (10 min) + t.me deep link that sends it to the bot
router.post("/link-code", async (req, res, next) => {
  try {
    if (!telegramEnabled()) {
      return res.status(503).json({ success: false, message: "The Telegram bot is not configured on the server" });
    }
    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_LIFETIME_MIN * 60 * 1000);
    await TelegramLinkCode.deleteMany({ user: req.user._id });
    await TelegramLinkCode.create({ user: req.user._id, codeHash: hashLinkCode(code), expiresAt });
    const username = await botUsername();
    res.json({
      success: true,
      data: {
        code,
        expiresAt,
        botUsername: username,
        deepLink: username ? `https://t.me/${username}?start=${code}` : "",
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/telegram/link — disconnect my Telegram
router.delete("/link", async (req, res, next) => {
  try {
    const link = await TelegramLink.findOneAndDelete({ user: req.user._id });
    if (link && telegramEnabled()) {
      sendMessage(link.chatId, "🚪 This chat was disconnected from your Task Management account.", {
        reply_markup: { remove_keyboard: true },
      }).catch(() => {});
    }
    res.json({ success: true, message: "Telegram disconnected" });
  } catch (err) {
    next(err);
  }
});

export default router;
