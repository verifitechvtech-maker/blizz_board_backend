import "dotenv/config";
import { google } from "googleapis";
import http from "node:http";

import { setEnvValue } from "../utils/envFile.js";

const saveRefreshToken = (token) => setEnvValue("GOOGLE_REFRESH_TOKEN", token);

// Same redirect address as the in-app reconnect (GOOGLE_REDIRECT_URI in .env)
const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:5001/oauth2callback";
const listenPort = Number(new URL(redirectUri).port || 80);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/calendar.events",
    // Read Meet transcripts / recordings of meetings this account organized
    "https://www.googleapis.com/auth/meetings.space.readonly",
  ],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);

  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Google authorization failed. Check the terminal.");
    console.error("OAuth error:", error || "Authorization code missing");
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "Google authorization successful. Check your backend terminal."
    );

    if (!tokens.refresh_token) {
      console.log(
        "No refresh token returned. Revoke the app's access and authorize again."
      );
    } else {
      saveRefreshToken(tokens.refresh_token);
      console.log("\n✅ Google connected. The new GOOGLE_REFRESH_TOKEN was saved to backend/.env");
      console.log("   (previous file kept as backend/.env.backup). Restart the backend now.");
      console.log("\nTip: if this keeps expiring after ~7 days, open Google Cloud Console →");
      console.log("     APIs & Services → OAuth consent screen and set Publishing status to \"In production\".");
    }
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    res.writeHead(500);
    res.end("Token exchange failed. Check the backend terminal.");
  } finally {
    server.close();
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${listenPort} is busy (the backend is running). Use the "Reconnect Google" button on the MoM page instead, or stop the backend and run this again.`);
    process.exit(1);
  }
  throw err;
});

server.listen(listenPort, () => {
  console.log("Open this URL in your browser to authorize Google:");
  console.log(authUrl);
});
