
import "dotenv/config";
import { google } from "googleapis";
import http from "node:http";

const redirectUri = "http://localhost:5001/oauth2callback";

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
      console.log("\nYour refresh token (keep it secret):\n");
      console.log(tokens.refresh_token);
      console.log("\nCopy it into GOOGLE_REFRESH_TOKEN in your .env file.");
    }
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    res.writeHead(500);
    res.end("Token exchange failed. Check the backend terminal.");
  } finally {
    server.close();
  }
});

server.listen(5001, () => {
  console.log("Open this URL in your browser to authorize Google:");
  console.log(authUrl);
});
