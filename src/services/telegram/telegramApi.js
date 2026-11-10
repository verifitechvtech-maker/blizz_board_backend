/* =========================================================
   Minimal Telegram Bot API client (no extra npm package).
   Token: TELEGRAM_BOT_TOKEN in .env — without it the bot is off.
========================================================= */

export const telegramToken = () => process.env.TELEGRAM_BOT_TOKEN || "";

// Tests swap in a fake so nothing is sent to the real Telegram
let transport = null;
export const setTelegramTransport = (fn) => {
  transport = fn;
};

export const telegramEnabled = () => Boolean(telegramToken()) && (process.env.NODE_ENV !== "test" || Boolean(transport));

export class TelegramError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const tg = async (method, params = {}, { timeoutMs = 15000 } = {}) => {
  if (transport) return transport(method, params);
  const res = await fetch(`https://api.telegram.org/bot${telegramToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError(data.description || `Telegram ${method} failed (${res.status})`, data.error_code || res.status);
  return data.result;
};

// HTML parse mode — every piece of user text must go through this
export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const sendMessage = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// Edit in place (button presses); falls back to a new message when the old one can't be edited
export const editOrSend = async (chatId, messageId, text, extra = {}) => {
  if (messageId) {
    try {
      return await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      });
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return null;
    }
  }
  return sendMessage(chatId, text, extra);
};

export const answerCallback = (id, text = "", showAlert = false) =>
  tg("answerCallbackQuery", { callback_query_id: id, text: text.slice(0, 190), show_alert: showAlert }).catch(() => {});

let botInfo = null;
export const getBotInfo = async () => {
  if (!botInfo && telegramToken()) botInfo = await tg("getMe");
  return botInfo;
};
