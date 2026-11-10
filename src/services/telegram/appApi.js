import jwt from "jsonwebtoken";

/* =========================================================
   The bot does NOT touch tasks directly — it calls this app's own
   REST API as the linked user. So permissions, data scope, emails,
   in-app notifications, sockets and scores all behave exactly as
   in the web app, and every change shows there straight away.
========================================================= */

const baseUrl = () =>
  (process.env.TELEGRAM_INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");

// Short-lived token for one bot action; authenticate() reloads the user fresh from the DB
const tokenFor = (userId) => jwt.sign({ id: String(userId), via: "telegram" }, process.env.JWT_SECRET, { expiresIn: "5m" });

export class AppApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const appApi = async (userId, method, url, json) => {
  const headers = { Authorization: `Bearer ${tokenFor(userId)}` };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(baseUrl() + url, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new AppApiError(data.message || `Request failed (${res.status})`, res.status, data.code);
  }
  return data;
};
