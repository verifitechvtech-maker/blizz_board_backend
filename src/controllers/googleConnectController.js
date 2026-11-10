// In-app "Reconnect Google": an Admin clicks a button, signs in to Google, and the new
// refresh token is saved to backend/.env AND used immediately (no restart needed).
import crypto from "node:crypto";
import { google } from "googleapis";
import { setEnvValue } from "../utils/envFile.js";
import { resetGoogleStatusCache } from "../services/googleCalendarService.js";
import { frontendUrl } from "../services/accountEmailService.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.readonly",
];
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map(); // state → { userId, at }

// Must exactly match an "Authorized redirect URI" of the OAuth client in Google Cloud
export const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 5000}/oauth2callback`;

const client = () =>
  new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());

// POST /api/google/connect-url  (Admin / SuperAdmin)
export const getConnectUrl = (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({
      success: false,
      message: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing in backend/.env",
    });
  }
  for (const [s, v] of pendingStates) if (Date.now() - v.at > STATE_TTL_MS) pendingStates.delete(s);
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, { userId: String(req.user._id), at: Date.now() });

  const url = client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    scope: SCOPES,
    state,
  });
  res.json({ success: true, data: { url, redirectUri: redirectUri() } });
};

const backToApp = (res, status, message = "") => {
  const target = new URL(`${frontendUrl()}/dashboard/mom`);
  target.searchParams.set("google", status);
  if (message) target.searchParams.set("reason", message.slice(0, 300));
  res.redirect(target.toString());
};

// GET /oauth2callback  (public — Google redirects the browser here)
export const oauthCallback = async (req, res) => {
  const { state, code, error } = req.query;
  const pending = state && pendingStates.get(String(state));
  if (state) pendingStates.delete(String(state));

  if (error) return backToApp(res, "error", `Google said: ${error}`);
  if (!pending || Date.now() - pending.at > STATE_TTL_MS) {
    return backToApp(res, "error", "This sign-in link expired. Click Reconnect Google again.");
  }
  if (!code) return backToApp(res, "error", "Google did not return an authorization code.");

  try {
    const { tokens } = await client().getToken(String(code));
    if (!tokens.refresh_token) {
      return backToApp(
        res,
        "error",
        "Google returned no refresh token. Remove the app at myaccount.google.com/permissions and try again."
      );
    }
    setEnvValue("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
    process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token; // live immediately
    resetGoogleStatusCache();
    console.log("✅ Google reconnected from the app — new refresh token saved to .env");
    return backToApp(res, "connected");
  } catch (err) {
    console.error("Google reconnect failed:", err.response?.data || err.message);
    return backToApp(res, "error", `Token exchange failed: ${err.response?.data?.error || err.message}`);
  }
};
