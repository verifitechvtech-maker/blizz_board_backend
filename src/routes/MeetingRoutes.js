
import express from "express";

import { authenticate } from "../middleware/authMiddleware.js";

import {
  createMeeting,
  getMeetings,
  getMeetingById,
  updateMeeting,
  deleteMeeting,
  resendMeetingInvitation,
  resendMeetingReminder,
  generateMOM,
  getIntegrationStatus,
  getMeetingRoom,
} from "../controllers/MeetingController.js";
import {
  getParticipants,
  uploadRecordingFile,
  saveRecording,
  streamRecording,
  deleteRecording,
  uploadMeetingAttachment,
  saveMeetingAttachment,
  downloadMeetingAttachment,
} from "../controllers/meetingMediaController.js";

const router = express.Router();

// All meeting endpoints require a valid JWT.
router.use(authenticate);

// Org members for the member / action-owner pickers (BEFORE "/:id")
router.get("/participants", getParticipants);
router.get("/integration-status", getIntegrationStatus);
router.get("/room/:roomId", getMeetingRoom); // video call join page (before /:id)
router.get("/attachments/:filename", downloadMeetingAttachment);
router.post("/:id/attachments", uploadMeetingAttachment, saveMeetingAttachment);

// Meeting CRUD
router.post("/", createMeeting);
router.get("/", getMeetings);
router.get("/:id", getMeetingById);
router.put("/:id", updateMeeting);
router.delete("/:id", deleteMeeting);

// Meeting emails and MOM
router.post("/:id/send-invitation", resendMeetingInvitation);
router.post("/:id/send-reminder", resendMeetingReminder);
router.post("/:id/send-mom", generateMOM);

// Whole-meeting recording (recorded in the organizer's browser)
router.post("/:id/recording", uploadRecordingFile, saveRecording);
router.get("/:id/recording", streamRecording);
router.delete("/:id/recording", deleteRecording);

export default router;
