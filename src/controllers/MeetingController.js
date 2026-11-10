
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";
import Meeting from "../models/Meeting.js";
import { meetingAccess, meetingOwner } from "../middleware/orgScope.js";
import { cancelMeetingEvent } from "../services/meetingNotificationService.js";
import {
  createVideoRoomAndSendInvitation,
  findRoomMeetingFor,
  roomInfo,
} from "../services/videoRoomService.js";
import { endVideoRoom } from "../socket/meetingSocket.js";
import { MEETING_FILES_DIR, MEETING_FILES_FOLDER, RECORDING_DIR } from "./meetingMediaController.js";
import { removeStoredFile } from "../services/fileStorage.js";
import {
  sendMeetingReminder,
  sendMomEmail,
} from "../services/meetingEmailService.js";

const getUserId = (req) =>
  req.user?.id || req.user?._id || req.user?.userId;

const handleError = (res, error) => {
  console.error("Meeting error:", error);

  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

// CREATE MEETING + VIDEO CALL LINK (WebRTC) + INVITATION
export const createMeeting = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid authenticated user",
      });
    }

    const { title, meetingDate } = req.body;

    if (!title?.trim() || !meetingDate) {
      return res.status(400).json({
        success: false,
        message: "Meeting title and meeting date are required",
      });
    }

    // Recording metadata and attachments are written by their own endpoints.
    // Meeting links are made by the server only — a typed link is never saved.
    const {
      recordingFile, transcript, attachments, chatMessages, googleRecordingUrl, googleMeetLink, googleEventId,
      videoRoomId, videoLink, videoProvider, invitationSentAt, reminderSentAt, momEmailSentAt, telegramReminderFor,
      ...fields
    } = req.body;

    const meeting = await Meeting.create({
      ...fields,
      title: title.trim(),
      createdBy: userId,
    });

    let integration = {
      videoLink: "",
      invitationSent: false,
      warning: null,
    };

    // Online / Hybrid → private video room for the scheduled time, link emailed to the attendees
    if (meeting.meetingType !== "Offline") {
      try {
        const result = await createVideoRoomAndSendInvitation(meeting);

        integration = {
          videoLink: result.videoLink || "",
          invitationSent: result.invitationSent || false,
          warning: result.emailWarning || null,
        };
      } catch (error) {
        console.error("Meeting integration failed:", error.message);

        integration.warning = error.message;
        integration.code = error.code || null;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Meeting created successfully",
      data: meeting,
      integration,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// GET ALL MEETINGS
export const getMeetings = async (req, res) => {
  try {
    // ⭐ Organization isolation + only meetings I created or was invited to (Admin: all of the org)
    const meetings = await Meeting.find(meetingAccess(req))
      .populate("createdBy", "name email")
      .sort({ meetingDate: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: meetings.length,
      data: meetings,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// GET SINGLE MEETING
export const getMeetingById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) })
      .populate("createdBy", "name email");

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: meeting.toObject(),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// UPDATE MEETING
export const updateMeeting = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const updates = { ...req.body };

    delete updates.createdBy;
    delete updates._id;
    delete updates.googleEventId;
    delete updates.googleMeetLink;
    delete updates.videoRoomId;
    delete updates.videoLink;
    delete updates.videoProvider;
    delete updates.invitationSentAt;
    delete updates.reminderSentAt;
    delete updates.momEmailSentAt;
    delete updates.telegramReminderFor;
    // Managed by the recording / transcript endpoints only
    delete updates.recordingFile;
    delete updates.transcript;
    delete updates.attachments;
    delete updates.chatMessages;
    delete updates.googleRecordingUrl;

    const before = await Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) })
      .select("title agenda meetingDate startTime endTime attendees meetingType status videoRoomId")
      .lean();

    if (!before) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, ...meetingAccess(req) },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    // Video call: same link; new attendees get the invitation, a new date / time goes to everyone
    const integration = { invited: [], videoLink: meeting.videoLink || "", warning: null };
    try {
      if (meeting.status === "Cancelled" && before.status !== "Cancelled") {
        endVideoRoom(meeting.videoRoomId, "The meeting was cancelled");
      } else if (meeting.meetingType !== "Offline" && meeting.status !== "Cancelled") {
        const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
        const timeChanged =
          day(before.meetingDate) !== day(meeting.meetingDate) ||
          (before.startTime || "") !== (meeting.startTime || "") ||
          (before.endTime || "") !== (meeting.endTime || "");
        const oldEmails = new Set((before.attendees || []).map((a) => String(a.email || "").toLowerCase()).filter(Boolean));
        const newEmails = (meeting.attendees || [])
          .map((a) => String(a.email || "").toLowerCase())
          .filter((e) => e && !oldEmails.has(e));

        let result = null;
        if (!meeting.videoRoomId) {
          result = await createVideoRoomAndSendInvitation(meeting);
          integration.invited = (meeting.attendees || []).map((a) => a.name);
        } else if (timeChanged) {
          result = await createVideoRoomAndSendInvitation(meeting, { updated: true });
          integration.invited = (meeting.attendees || []).map((a) => a.name);
        } else if (newEmails.length) {
          result = await createVideoRoomAndSendInvitation(meeting, { onlyEmails: newEmails });
          integration.invited = (meeting.attendees || [])
            .filter((a) => newEmails.includes(String(a.email || "").toLowerCase()))
            .map((a) => a.name);
        }
        if (result) {
          integration.videoLink = result.videoLink;
          integration.warning = result.emailWarning;
        }
      }
    } catch (error) {
      console.error("Meeting invitation failed:", error.message);
      integration.warning = error.message;
    }

    return res.status(200).json({
      success: true,
      message: "Meeting updated successfully",
      data: meeting,
      integration,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// DELETE MEETING
export const deleteMeeting = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    // Only the creator (or the organization's Admin) may delete
    const meeting = await Meeting.findOneAndDelete({ _id: req.params.id, ...meetingOwner(req) });

    if (!meeting) {
      const visible = await Meeting.exists({ _id: req.params.id, ...meetingAccess(req) });
      return res.status(visible ? 403 : 404).json({
        success: false,
        message: visible ? "Only the meeting creator or an administrator can delete this meeting" : "Meeting not found",
      });
    }

    // anyone still in the call is told it ended; the link stops working with the meeting
    endVideoRoom(meeting.videoRoomId, "The meeting was deleted");
    const storedFiles = new Set([
      meeting.recordingFile?.filename,
      ...(meeting.attachments || []).map((attachment) => attachment.filename),
    ].filter(Boolean));
    await Promise.all([...storedFiles].map(async (filename) => {
      const safeName = path.basename(filename);
      try {
        await fs.unlink(path.join(RECORDING_DIR, safeName)); // recordings stay on disk
      } catch (error) {
        if (error.code !== "ENOENT") console.error("Could not remove deleted meeting file:", error.message);
      }
      // meeting files: disk (older ones) and Cloudinary
      await removeStoredFile(MEETING_FILES_DIR, MEETING_FILES_FOLDER, safeName);
    }));

    // Older Google Meet meetings: try to withdraw their Google Calendar event. Video calls are
    // built in now, so a disconnected / expired Google account is only logged, never shown.
    if (meeting.googleEventId) {
      cancelMeetingEvent(meeting).catch((error) =>
        console.warn("Old Google event not cancelled:", error.message)
      );
    }

    return res.status(200).json({
      success: true,
      message: "Meeting deleted successfully",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// RESEND MEETING INVITATION
export const resendMeetingInvitation = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    if (meeting.meetingType === "Offline") {
      meeting.meetingType = "Online"; // asking for a link means it is (also) online
    }

    const result = await createVideoRoomAndSendInvitation(meeting, { resend: true });

    const parts = [
      result.linkCreated ? "Video call link created" : "Video call link ready",
      result.invitationSent ? "invitation emailed to the members" : `invitation NOT sent (${result.emailWarning})`,
    ];

    return res.status(200).json({
      success: true,
      message: parts.join(", ") + ".",
      data: {
        meetingId: meeting._id,
        videoLink: result.videoLink,
        invitationSent: result.invitationSent,
        warning: result.emailWarning || null,
        meeting,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// SEND REMINDER MANUALLY
export const resendMeetingReminder = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    const result = await sendMeetingReminder(meeting);

    if (!result.sent) {
      return res.status(400).json({
        success: false,
        message: result.reason || "Reminder email was not sent",
      });
    }

    meeting.reminderSentAt = new Date();
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: "Reminder email sent successfully",
      sentCount: result.sentCount,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// SEND MINUTES OF MEETING (MOM)
export const generateMOM = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    const result = await sendMomEmail(meeting);

    if (!result.sent) {
      return res.status(400).json({
        success: false,
        message: result.reason || "MOM email was not sent",
      });
    }

    meeting.momEmailSentAt = new Date();
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: "MOM email sent successfully",
      sentCount: result.sentCount,
    });
  } catch (error) {
    return handleError(res, error);
  }
};


// GET /api/meetings/integration-status — is Google Meet / invitation email usable right now?
export const getIntegrationStatus = async (req, res) => {
  try {
    // video calls are built in (WebRTC) — nothing to connect; only email can be missing
    const email = process.env.SMTP_USER && process.env.SMTP_PASS
      ? { ok: true }
      : { ok: false, message: "Email (SMTP) is not configured in .env — invitations cannot be sent." };
    res.json({ success: true, data: { video: { ok: true, provider: "webrtc" }, email } });
  } catch (error) {
    return handleError(res, error);
  }
};

// VIDEO CALL ROOM — what the /meet/:roomId page shows (only for people invited to the meeting)
export const getMeetingRoom = async (req, res) => {
  try {
    const meeting = await findRoomMeetingFor(req.user, String(req.params.roomId || ""));
    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "This meeting link is not valid for your account. Sign in with the email the invitation was sent to.",
      });
    }
    return res.status(200).json({ success: true, data: roomInfo(meeting, req.user) });
  } catch (error) {
    return handleError(res, error);
  }
};
