import crypto from "node:crypto";
import { DateTime } from "luxon";
import Meeting from "../models/Meeting.js";
import { attachOrgUsers, meetingAccess } from "../middleware/orgScope.js";
import { frontendUrl } from "./accountEmailService.js";
import { sendMeetingInvitation } from "./meetingEmailService.js";
import { speechLangFor } from "./callTranscriptService.js";

/* =========================================================
   Built-in video calls (WebRTC) for MoM meetings
   • every online meeting gets a private room: <FRONTEND_URL>/meet/<roomId>
   • the link opens JOIN_EARLY minutes before the start and closes JOIN_LATE minutes after the end
   • only the organizer, invited attendees and the organization's Admin can join
   • video/audio go browser ↔ browser; the server only relays the connection setup (Socket.IO)
========================================================= */

const TIME_ZONE = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
export const JOIN_EARLY_MINUTES = Number(process.env.MEETING_JOIN_EARLY_MINUTES || 15);
export const JOIN_LATE_MINUTES = Number(process.env.MEETING_JOIN_LATE_MINUTES || 30);
const DEFAULT_LENGTH_MINUTES = 60;
export const MAX_ROOM_PARTICIPANTS = Number(process.env.MEETING_MAX_PARTICIPANTS || 8);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Start, end, and when the link opens / closes (meeting time zone). */
export const meetingWindow = (meeting) => {
  const day = new Date(meeting.meetingDate).toISOString().slice(0, 10);
  const startTime = HHMM.test(meeting.startTime || "") ? meeting.startTime : "09:00";
  const start = DateTime.fromISO(`${day}T${startTime}`, { zone: TIME_ZONE });
  let end = HHMM.test(meeting.endTime || "") ? DateTime.fromISO(`${day}T${meeting.endTime}`, { zone: TIME_ZONE }) : null;
  if (!end || end <= start) end = start.plus({ minutes: DEFAULT_LENGTH_MINUTES });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    opensAt: start.minus({ minutes: JOIN_EARLY_MINUTES }).toJSDate(),
    closesAt: end.plus({ minutes: JOIN_LATE_MINUTES }).toJSDate(),
  };
};

/** "early" (not open yet) · "open" · "ended" · "cancelled" */
export const roomState = (meeting, now = new Date()) => {
  if (meeting.status === "Cancelled") return "cancelled";
  const w = meetingWindow(meeting);
  if (now < w.opensAt) return "early";
  if (now > w.closesAt) return "ended";
  return "open";
};

export const videoLinkFor = (roomId) => `${frontendUrl()}/meet/${roomId}`;

/** Give the meeting its room + link (once — the link never changes afterwards). */
export const ensureVideoRoom = (meeting) => {
  if (meeting.videoRoomId) return false;
  meeting.videoRoomId = crypto.randomBytes(16).toString("base64url"); // 22 unguessable characters
  meeting.videoLink = videoLinkFor(meeting.videoRoomId);
  meeting.videoProvider = "webrtc";
  return true;
};

/**
 * Make sure the meeting has its video room, then email the invitation (with the link) to the attendees.
 * options.resend → send again · options.onlyEmails → just these attendees (newly added people)
 */
export const createVideoRoomAndSendInvitation = async (meeting, options = {}) => {
  const linkCreated = ensureVideoRoom(meeting);
  if (linkCreated) await meeting.save();

  let invitationSent = false;
  let emailWarning = null;
  if (!meeting.invitationSentAt || options.resend || linkCreated || options.onlyEmails?.length || options.updated) {
    const result = await sendMeetingInvitation(meeting, { onlyEmails: options.onlyEmails, updated: options.updated });
    if (result.sent) {
      meeting.invitationSentAt = new Date();
      invitationSent = true;
      if (result.failedCount) emailWarning = `${result.failedCount} invitation email(s) failed`;
    } else {
      emailWarning = result.reason || "Invitation email was not sent";
    }
    await meeting.save();
  }
  return { videoLink: meeting.videoLink, linkCreated, invitationSent, emailWarning };
};

/* ---------------- ICE servers (how browsers find a path to each other) ----------------
   STUN: Google's free public STUN servers (default) — enough for most networks.
   TURN: relays the call when a direct path is blocked (strict firewalls, mobile data).
         Google offers NO public TURN — run your own (coturn, see backend/deploy/turnserver.conf.example)
         or use a TURN provider, and put its address in .env:
           TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
           TURN_SECRET=<same as static-auth-secret in coturn>   → short-lived per-user passwords (recommended)
           or TURN_USERNAME + TURN_CREDENTIAL                     → one fixed login (provider dashboards)
*/

export const GOOGLE_STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
];

const listFromEnv = (value) => String(value || "").split(",").map((u) => u.trim()).filter(Boolean);

// How long a generated TURN password works (default 12 hours — longer than any meeting window)
export const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 12 * 60 * 60);

/**
 * TURN REST API credentials (coturn "use-auth-secret"):
 * username = "<expiry unix time>:<user id>", password = base64(HMAC-SHA1(secret, username)).
 * The browser only ever gets a password that expires — the secret stays on the server.
 */
export const turnCredentials = (secret, userId, now = Date.now()) => {
  const expiry = Math.floor(now / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${String(userId || "user")}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiresAt: new Date(expiry * 1000) };
};

/** ICE servers for one user's browser. */
export const iceServers = (user = null, now = Date.now()) => {
  const stun = listFromEnv(process.env.STUN_URLS);
  const list = [{ urls: stun.length ? stun : GOOGLE_STUN_SERVERS }];

  const turnUrls = listFromEnv(process.env.TURN_URLS || process.env.TURN_URL);
  if (turnUrls.length) {
    if (process.env.TURN_SECRET) {
      const { username, credential } = turnCredentials(process.env.TURN_SECRET, user?._id, now);
      list.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      list.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return list;
};

// "relay" forces every call through TURN (privacy / very strict networks); default "all"
export const iceTransportPolicy = () => (process.env.WEBRTC_FORCE_RELAY === "true" ? "relay" : "all");

/**
 * The meeting behind a room id, only if this user may see it
 * (same rule as the MoM list: organizer, attendee, or the organization's Admin).
 */
export const findRoomMeetingFor = async (user, roomId) => {
  if (!roomId || typeof roomId !== "string" || roomId.length > 64) return null;
  const req = {
    user,
    adminId: user.role === "Admin" ? user._id : user.admin_id,
  };
  await new Promise((resolve, reject) => attachOrgUsers(req, null, (err) => (err ? reject(err) : resolve())));
  return Meeting.findOne({ videoRoomId: roomId, ...meetingAccess(req) }).populate("createdBy", "name email");
};

/** What the join page needs (no transcript, recording or other private data). */
export const roomInfo = (meeting, user, now = new Date()) => {
  const w = meetingWindow(meeting);
  const organizerId = String(meeting.createdBy?._id || meeting.createdBy || "");
  return {
    meetingId: meeting._id,
    roomId: meeting.videoRoomId,
    title: meeting.title,
    agenda: meeting.agenda || "",
    organizer: meeting.createdBy?.name || "",
    isOrganizer: organizerId === String(user._id),
    attendees: (meeting.attendees || []).map((a) => a.name).filter(Boolean),
    ...w,
    state: roomState(meeting, now),
    serverTime: now,
    joinEarlyMinutes: JOIN_EARLY_MINUTES,
    joinLateMinutes: JOIN_LATE_MINUTES,
    maxParticipants: MAX_ROOM_PARTICIPANTS,
    transcription: Boolean(meeting.transcription),
    speechLang: speechLangFor(meeting.transcriptionLanguage),
    iceServers: iceServers(user),
    iceTransportPolicy: iceTransportPolicy(),
    turnConfigured: Boolean(listFromEnv(process.env.TURN_URLS || process.env.TURN_URL).length),
    me: { id: user._id, name: user.name },
  };
};
