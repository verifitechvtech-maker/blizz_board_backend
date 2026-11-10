
import mongoose from "mongoose";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, isTranscriptionLanguage } from "../config/transcriptionLanguages.js";

const attendeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    department: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

// MoM page: discussion points (checklist) and action plans with one or more owners
const pointSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
  },
  { _id: true }
);

const personSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, default: "" },
  },
  { _id: false }
);

const actionPlanSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    owners: { type: [personSchema], default: [] },
    owner: { type: String, trim: true, default: "" }, // display text (names joined)
    dueDate: { type: Date, default: null },
    completed: { type: Boolean, default: false },
  },
  { _id: true }
);

// Whole-meeting recording made in the organizer's browser (file on disk, not in MongoDB)
const recordingFileSchema = new mongoose.Schema(
  {
    filename: { type: String, default: "" },
    name: { type: String, default: "" },
    size: { type: Number, default: 0 },
    mimetype: { type: String, default: "" },
    durationSec: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const meetingAttachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    name: { type: String, required: true },
    size: { type: Number, default: 0 },
    mimetype: { type: String, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const meetingChatMessageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderName: { type: String, default: "" },
    text: { type: String, trim: true, maxlength: 2000, default: "" },
    attachment: { type: meetingAttachmentSchema, default: null },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const transcriptEntrySchema = new mongoose.Schema(
  {
    speaker: { type: String, trim: true, default: "Speaker" },
    text: { type: String, trim: true, required: true },
    at: { type: Date, default: null },        // absolute time (Google / live)
    offsetSec: { type: Number, default: null }, // seconds from start (imported files)
    endSec: { type: Number, default: null },    // end of the line in the recording (whisper)
    speakerId: { type: String, default: "" },   // key into transcript.speakers ("S1", "S2", …)
    edited: { type: Boolean, default: false },  // text corrected by a user
  },
  { _id: false }
);

// One per distinct voice / speaker in the transcript. "label" is what the transcriber
// produced ("Speaker 1", or the name from Google / an imported file); "name" is the
// attendee a user assigned to it. Lines show name || label.
const transcriptSpeakerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    email: { type: String, trim: true, lowercase: true, default: "" },
    // "" = not named · "voice" = matched to the person's voice profile · "manual" = chosen by a user
    // · "name" = the transcript already carried this attendee's name (Google / imported file)
    matchedBy: { type: String, default: "" },
    matchScore: { type: Number, default: null },
  },
  { _id: false }
);

// One voice vector per detected speaker — kept to match voice profiles recorded later.
const voiceprintSchema = new mongoose.Schema(
  { id: { type: String, required: true }, embedding: { type: [Number], default: [] } },
  { _id: false }
);

const transcriptSchema = new mongoose.Schema(
  {
    // google = Google Meet API, live = browser speech recognition, import = uploaded file,
    // whisper = transcribed from the meeting recording on this server
    source: { type: String, enum: ["", "google", "live", "import", "whisper"], default: "" },
    // whisper job state: "" | queued | processing | done | failed
    status: { type: String, default: "" },
    error: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    // language the transcript was made in ("auto" = detected → detectedLanguage)
    language: { type: String, default: "" },
    detectedLanguage: { type: String, default: "" },
    notice: { type: String, default: "" }, // non-fatal note, e.g. speakers could not be separated
    speakers: { type: [transcriptSpeakerSchema], default: [] },
    voiceprints: { type: [voiceprintSchema], default: undefined, select: false },
    entries: { type: [transcriptEntrySchema], default: [] },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    _id: false,
    // Voice data stays on the server — never in an API response
    toJSON: { transform: (doc, ret) => { delete ret.voiceprints; return ret; } },
  }
);

const actionItemSchema = new mongoose.Schema(
  {
    task: {
      type: String,
      required: true,
      trim: true,
    },
    assignedTo: {
      type: String,
      trim: true,
      default: "",
    },
    dueDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed"],
      default: "Pending",
    },
  },
  { timestamps: true }
);

const meetingSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    meetingDate: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      default: "",
    },
    endTime: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    meetingType: {
      type: String,
      enum: ["Online", "Offline", "Hybrid"],
      default: "Online",
    },
    attendees: {
      type: [attendeeSchema],
      default: [],
    },
    agenda: {
      type: String,
      default: "",
    },
    discussionPoints: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 10000,
      default: "",
    },
    decisions: {
      type: String,
      default: "",
    },
    actionItems: {
      type: [actionItemSchema],
      default: [],
    },
    departments: {
      type: [String],
      default: [],
    },
    points: {
      type: [pointSchema],
      default: [],
    },
    actions: {
      type: [actionPlanSchema],
      default: [],
    },
    recording: {
      type: Boolean,
      default: false, // "record whole meeting" enabled for this meeting
    },
    transcription: {
      type: Boolean,
      default: false, // show / collect a transcript for this meeting
    },
    recordingFile: {
      type: recordingFileSchema,
      default: null,
    },
    attachments: { type: [meetingAttachmentSchema], default: [] },
    chatMessages: { type: [meetingChatMessageSchema], default: [] },
    googleRecordingUrl: {
      type: String,
      default: "", // Google Drive link of a Meet recording (Workspace accounts)
    },
    transcript: {
      type: transcriptSchema,
      default: () => ({}),
    },
    // Language chosen for transcribing this meeting (recording + live). Kept for re-runs.
    transcriptionLanguage: {
      type: String,
      default: DEFAULT_TRANSCRIPTION_LANGUAGE,
      validate: {
        validator: isTranscriptionLanguage,
        message: (p) => `"${p.value}" is not a supported transcription language`,
      },
    },
    status: {
      type: String,
      enum: ["Scheduled", "Ongoing", "Completed", "Cancelled"],
      default: "Scheduled",
    },

    // Built-in video call (WebRTC): private room id + the link emailed to attendees
    // (/meet/<videoRoomId> — opens shortly before the start, closes after the end)
    videoProvider: {
      type: String,
      enum: ["", "webrtc", "google"],
      default: "",
    },
    videoRoomId: {
      type: String,
      default: "",
    },
    videoLink: {
      type: String,
      default: "",
    },
    // Who was talking when, in the video call (each person's own microphone, reported by their
    // browser, server time) — names the transcript's speakers. Not sent in normal API responses.
    callActivity: {
      type: [
        {
          _id: false,
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          name: { type: String, default: "" },
          start: { type: Date, required: true },
          end: { type: Date, required: true },
        },
      ],
      default: [],
      select: false,
    },
    // Recording made inside the video call: when it started (server time) → lines up with callActivity
    callRecording: {
      startedAt: { type: Date, default: null },
      startedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      stoppedAt: { type: Date, default: null },
    },
    // Google Meet integration (older meetings)
    googleEventId: {
      type: String,
      default: "",
    },
    googleMeetLink: {
      type: String,
      default: "",
    },

    // Email tracking
    invitationSentAt: {
      type: Date,
      default: null,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    momEmailSentAt: {
      type: Date,
      default: null,
    },
    // "YYYY-MM-DD|HH:mm" the Telegram reminder was sent for (a new time → sent again)
    telegramReminderFor: {
      type: String,
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// one meeting per room id (empty = no room yet)
meetingSchema.index({ videoRoomId: 1 }, { unique: true, partialFilterExpression: { videoRoomId: { $type: "string", $gt: "" } } });

const Meeting = mongoose.model("Meeting", meetingSchema);

export default Meeting;
