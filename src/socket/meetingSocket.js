import Meeting from "../models/Meeting.js";
import path from "node:path";
import { findRoomMeetingFor, MAX_ROOM_PARTICIPANTS, roomState } from "../services/videoRoomService.js";

/* =========================================================
   WebRTC signaling for MoM video calls (rides on the authenticated Socket.IO connection)
   meet:join   { roomId }               → ack { ok, peers } and "meet:peer-joined" to the others
   meet:signal { to, description | candidate } → relayed only between sockets in the same room
   meet:media  { audio, video, screen } → "meet:media" to the others
   meet:leave  / disconnect             → "meet:peer-left"
   meet:recording { on }                → organizer / Admin starts or stops the in-call recording
   meet:chat { text, attachmentFilename? } → persist and broadcast a chat message to this meeting
   Media itself flows browser ↔ browser; nothing is recorded here.
========================================================= */

const rooms = new Map(); // roomId → Map(socketId → { socketId, userId, name, audio, video, screen })
const recordingIn = new Map(); // roomId → { by: name, startedAt }
let ioRef = null;

const channel = (roomId) => `meet:${roomId}`;
const peersOf = (roomId) => [...(rooms.get(roomId)?.values() || [])];

const leaveRoom = (socket) => {
  const roomId = socket.data.meetRoom;
  if (!roomId) return;
  const room = rooms.get(roomId);
  room?.delete(socket.id);
  if (room && room.size === 0) rooms.delete(roomId);
  if (!rooms.has(roomId)) {
    recordingIn.delete(roomId);
  }
  socket.leave(channel(roomId));
  socket.data.meetRoom = null;
  socket.data.meetMeetingId = null;
  socket.to(channel(roomId)).emit("meet:peer-left", { socketId: socket.id });
};

/** Meeting deleted / cancelled → everyone in its call is told it ended. */
export const endVideoRoom = (roomId, reason = "The meeting was cancelled") => {
  if (!ioRef || !roomId) return;
  ioRef.to(channel(roomId)).emit("meet:ended", { reason });
  ioRef.in(channel(roomId)).socketsLeave(channel(roomId));
  rooms.delete(roomId);
};

export const activeParticipants = (roomId) => peersOf(roomId).length;
export const isInCall = (roomId, userId) => peersOf(roomId).some((p) => p.userId === String(userId));

export const registerMeetingSocket = (io) => {
  ioRef = io;
  io.on("connection", (socket) => {
    socket.on("meet:join", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const roomId = String(payload?.roomId || "");
        // access: organizer, attendee or the organization's Admin (from the login token)
        const meeting = await findRoomMeetingFor(socket.user, roomId);
        if (!meeting) return reply({ ok: false, code: "NOT_FOUND", message: "This meeting link is not valid for your account." });

        const state = roomState(meeting);
        if (state === "early") return reply({ ok: false, code: "TOO_EARLY", message: "This meeting hasn't opened yet." });
        if (state === "ended") return reply({ ok: false, code: "ENDED", message: "This meeting has ended." });
        if (state === "cancelled") return reply({ ok: false, code: "CANCELLED", message: "This meeting was cancelled." });

        if (socket.data.meetRoom && socket.data.meetRoom !== roomId) leaveRoom(socket);
        const room = rooms.get(roomId) || new Map();
        if (!room.has(socket.id) && room.size >= MAX_ROOM_PARTICIPANTS) {
          return reply({ ok: false, code: "FULL", message: `This call is full (${MAX_ROOM_PARTICIPANTS} people).` });
        }

        const me = {
          socketId: socket.id,
          userId: String(socket.user._id),
          name: socket.user.name,
          audio: payload?.audio !== false,
          video: payload?.video !== false,
          screen: false,
        };
        const peers = [...room.values()].filter((p) => p.socketId !== socket.id);
        room.set(socket.id, me);
        rooms.set(roomId, room);
        socket.join(channel(roomId));
        socket.data.meetRoom = roomId;
        socket.data.meetMeetingId = meeting._id;
        // only the organizer or an Admin may record the call
        socket.data.canRecord =
          String(meeting.createdBy?._id || meeting.createdBy) === String(socket.user._id) ||
          ["Admin", "SuperAdmin"].includes(socket.user.role);
        socket.to(channel(roomId)).emit("meet:peer-joined", me);

        // the first person in turns a scheduled meeting into an ongoing one
        if (meeting.status === "Scheduled") {
          await Meeting.updateOne({ _id: meeting._id, status: "Scheduled" }, { $set: { status: "Ongoing" } });
        }
        reply({
          ok: true,
          peers,
          self: me,
          canRecord: socket.data.canRecord,
          recording: recordingIn.get(roomId) || null,
          chatMessages: (meeting.chatMessages || []).slice(-100).map((message) => ({
            id: message._id,
            sender: message.sender,
            senderName: message.senderName,
            text: message.text,
            attachment: message.attachment,
            sentAt: message.sentAt,
          })),
        });
      } catch (err) {
        console.error("meet:join failed:", err.message);
        reply({ ok: false, code: "ERROR", message: "Could not join the meeting." });
      }
    });

    socket.on("meet:signal", (payload) => {
      const roomId = socket.data.meetRoom;
      const to = String(payload?.to || "");
      // relay only to someone in the same call
      if (!roomId || !rooms.get(roomId)?.has(to)) return;
      const message = { from: socket.id };
      if (payload.description && typeof payload.description === "object") message.description = payload.description;
      if (payload.candidate && typeof payload.candidate === "object") message.candidate = payload.candidate;
      io.to(to).emit("meet:signal", message);
    });

    socket.on("meet:media", (payload) => {
      const roomId = socket.data.meetRoom;
      const me = rooms.get(roomId)?.get(socket.id);
      if (!me) return;
      me.audio = Boolean(payload?.audio);
      me.video = Boolean(payload?.video);
      me.screen = Boolean(payload?.screen);
      socket.to(channel(roomId)).emit("meet:media", { socketId: socket.id, audio: me.audio, video: me.video, screen: me.screen });
    });

    socket.on("meet:recording", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const roomId = socket.data.meetRoom;
      if (!roomId) return reply({ ok: false, message: "Join the call first." });
      if (!socket.data.canRecord) return reply({ ok: false, message: "Only the organizer or an Admin can record this call." });
      try {
        const now = new Date();
        if (payload?.on) {
          await Meeting.updateOne(
            { _id: socket.data.meetMeetingId },
            { $set: { "callRecording.startedAt": now, "callRecording.startedBy": socket.user._id, "callRecording.stoppedAt": null } }
          );
          recordingIn.set(roomId, { by: socket.user.name, startedAt: now });
          io.to(channel(roomId)).emit("meet:recording", { on: true, by: socket.user.name, startedAt: now });
        } else {
          await Meeting.updateOne({ _id: socket.data.meetMeetingId }, { $set: { "callRecording.stoppedAt": now } });
          recordingIn.delete(roomId);
          io.to(channel(roomId)).emit("meet:recording", { on: false, by: socket.user.name });
        }
        reply({ ok: true, startedAt: now });
      } catch (err) {
        console.error("meet:recording failed:", err.message);
        reply({ ok: false, message: "Could not start the recording." });
      }
    });

    socket.on("meet:chat", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const roomId = socket.data.meetRoom;
      if (!roomId || !rooms.get(roomId)?.has(socket.id)) {
        return reply({ ok: false, message: "Join the meeting before sending a chat message." });
      }
      const text = String(payload?.text || "").trim().slice(0, 2000);
      const filename = path.basename(String(payload?.attachmentFilename || ""));
      if (!text && !filename) return reply({ ok: false, message: "Write a message or attach a file." });
      try {
        const meeting = await Meeting.findById(socket.data.meetMeetingId).select("attachments chatMessages");
        if (!meeting) return reply({ ok: false, message: "Meeting not found." });
        const attachment = filename
          ? meeting.attachments.find((file) => file.filename === filename)
          : null;
        if (filename && !attachment) return reply({ ok: false, message: "That file does not belong to this meeting." });
        const message = {
          sender: socket.user._id,
          senderName: socket.user.name,
          text,
          attachment: attachment ? {
            filename: attachment.filename,
            name: attachment.name,
            size: attachment.size,
            mimetype: attachment.mimetype,
          } : null,
          sentAt: new Date(),
        };
        meeting.chatMessages.push(message);
        if (meeting.chatMessages.length > 200) meeting.chatMessages.splice(0, meeting.chatMessages.length - 200);
        await meeting.save();
        const saved = meeting.chatMessages[meeting.chatMessages.length - 1];
        const outgoing = {
          id: saved._id,
          sender: socket.user._id,
          senderName: socket.user.name,
          text,
          attachment: saved.attachment,
          sentAt: saved.sentAt,
        };
        ioRef.to(channel(roomId)).emit("meet:chat-message", outgoing);
        reply({ ok: true, data: outgoing });
      } catch (err) {
        console.error("meet:chat save failed:", err.message);
        reply({ ok: false, message: "Could not save your chat message." });
      }
    });

    socket.on("meet:leave", () => leaveRoom(socket));
    socket.on("disconnect", () => leaveRoom(socket));
  });
};
