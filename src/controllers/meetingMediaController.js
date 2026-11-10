// MoM extras: participant list, whole-meeting recording, transcript (language, speakers, edits).
// Every lookup is limited to meetings of the requester's organization that they created or attend.
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Meeting from "../models/Meeting.js";
import User from "../models/User.js";
import { meetingAccess } from "../middleware/orgScope.js";
import { parseTranscript } from "../utils/transcriptParser.js";
import { fetchGoogleMeetTranscript } from "../services/googleMeetTranscriptService.js";
import { queueTranscription, createVoiceprint } from "../services/transcriptionService.js";
import { nameSpeakersByVoice } from "../services/voiceProfileService.js";
import {
  TRANSCRIPTION_LANGUAGES,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  AUTO_LANGUAGE,
  isTranscriptionLanguage,
} from "../config/transcriptionLanguages.js";
import { buildSpeakers, applySpeakers, withSpeakerNames } from "../utils/transcriptSpeakers.js";
import { callPeople, nameSpeakersByCall } from "../utils/callSpeakers.js";
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_MB, pushUploadsToCloud, sendStoredFile, removeStoredFile } from "../services/fileStorage.js";

export const RECORDING_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/meetings"
);
fs.mkdirSync(RECORDING_DIR, { recursive: true });

export const MEETING_FILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/meeting-files"
);
fs.mkdirSync(MEETING_FILES_DIR, { recursive: true });

export const MAX_MEETING_FILE_SIZE = MAX_UPLOAD_SIZE; // 8 MB (Cloudinary)
export const MEETING_FILES_FOLDER = "meeting-files"; // Cloudinary folder
const removeMeetingFile = (filename) => removeStoredFile(MEETING_FILES_DIR, MEETING_FILES_FOLDER, filename);
const meetingFileToCloud = pushUploadsToCloud(MEETING_FILES_FOLDER);
const MEETING_FILE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip",
]);

export const MAX_RECORDING_SIZE = 1024 * 1024 * 1024; // 1 GB
const RECORDING_TYPES = /^(video|audio)\/(webm|mp4|ogg|mpeg|x-m4a|mp3|wav|x-wav)(;.*)?$/i;
const MAX_TRANSCRIPT_ENTRIES = 5000;

const findMeeting = async (req, res, select) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid meeting ID" });
    return null;
  }
  const q = Meeting.findOne({ _id: req.params.id, ...meetingAccess(req) });
  const meeting = await (select ? q.select(select) : q);
  if (!meeting) res.status(404).json({ success: false, message: "Meeting not found" });
  return meeting;
};

const fail = (res, err) => {
  console.error("Meeting media error:", err);
  res.status(err.status || 500).json({ success: false, message: err.status ? err.message : "Internal server error", code: err.code });
};

const meetingFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEETING_FILES_DIR),
    filename: (_req, file, cb) => cb(null, `meeting-file-${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MEETING_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (MEETING_FILE_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(Object.assign(new Error("Unsupported file type"), { status: 400 }));
  },
}).single("file");

export const uploadMeetingAttachment = (req, res, next) =>
  meetingFileUpload(req, res, (err) => {
    if (!err) return meetingFileToCloud(req, res, next);
    const message = err.code === "LIMIT_FILE_SIZE" ? `File must be ${MAX_UPLOAD_MB} MB or smaller` : err.message;
    res.status(400).json({ success: false, message });
  });

export const saveMeetingAttachment = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) {
      if (req.file) await removeMeetingFile(req.file.filename);
      return;
    }
    if (!req.file || !req.file.size) {
      if (req.file) await removeMeetingFile(req.file.filename);
      return res.status(400).json({ success: false, message: "Choose a non-empty file to upload" });
    }
    const attachment = {
      filename: req.file.filename,
      name: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedBy: req.user._id,
      uploadedAt: new Date(),
    };
    meeting.attachments.push(attachment);
    await meeting.save();
    res.status(201).json({ success: true, data: attachment });
  } catch (err) {
    if (req.file) await removeMeetingFile(req.file.filename);
    fail(res, err);
  }
};

export const downloadMeetingAttachment = async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ""));
    const meeting = await Meeting.findOne({
      ...meetingAccess(req),
      $or: [{ "attachments.filename": filename }, { "chatMessages.attachment.filename": filename }],
    }).select("attachments chatMessages").lean();
    const attachment =
      meeting?.attachments.find((file) => file.filename === filename) ||
      meeting?.chatMessages.find((message) => message.attachment?.filename === filename)?.attachment;
    if (!attachment) return res.status(404).json({ success: false, message: "File not found" });
    await sendStoredFile(res, {
      dir: MEETING_FILES_DIR,
      folder: MEETING_FILES_FOLDER,
      filename,
      downloadName: attachment.name,
      mimetype: attachment.mimetype,
    });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== GET /api/meetings/participants ====================
// Everyone in my organization (Admin + members) — for the member / action-owner pickers.
export const getParticipants = async (req, res) => {
  try {
    const filter = req.orgUserIds
      ? { _id: { $in: req.orgUserIds }, status: "Active" }
      : { role: { $ne: "SuperAdmin" }, status: "Active" };
    const users = await User.find(filter).select("name email department role").sort({ name: 1 }).lean();
    res.json({ success: true, count: users.length, data: users });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== GET /api/meetings/transcription-languages ====================
export const getTranscriptionLanguages = (req, res) =>
  res.json({
    success: true,
    data: {
      default: DEFAULT_TRANSCRIPTION_LANGUAGE,
      auto: { code: AUTO_LANGUAGE, name: "Auto-detect" },
      languages: TRANSCRIPTION_LANGUAGES,
    },
  });

// Optional "language" in a request body: undefined = keep the meeting's, invalid = 400
const readLanguage = (req, res) => {
  const value = req.body?.language;
  if (value === undefined || value === null || value === "") return undefined;
  if (!isTranscriptionLanguage(value)) {
    res.status(400).json({ success: false, message: `"${String(value).slice(0, 20)}" is not a supported transcription language` });
    return null;
  }
  return String(value);
};

// ==================== RECORDING ====================
const recordingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECORDING_DIR),
    filename: (req, file, cb) => {
      const fromName = path.extname(file.originalname || "").toLowerCase();
      const ext = [".webm", ".mp4", ".m4a", ".mp3", ".ogg", ".wav"].includes(fromName)
        ? fromName
        : /mp4/i.test(file.mimetype) ? ".mp4" : /mpeg|mp3/i.test(file.mimetype) ? ".mp3" : /wav/i.test(file.mimetype) ? ".wav" : /ogg/i.test(file.mimetype) ? ".ogg" : ".webm";
      cb(null, `meeting-${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_RECORDING_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    // Browsers label recordings differently (codec suffixes, generic types) — accept by type OR extension
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (RECORDING_TYPES.test(file.mimetype) || [".webm", ".mp4", ".m4a", ".mp3", ".ogg", ".wav"].includes(ext)) {
      return cb(null, true);
    }
    const err = new Error("Recording must be an audio or video file (webm, mp4, mp3, ogg, wav)");
    err.status = 400;
    cb(err);
  },
}).single("recording");

export const uploadRecordingFile = (req, res, next) =>
  recordingUpload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Recording is larger than 1 GB" : err.message;
    res.status(400).json({ success: false, message });
  });

const removeFile = (filename) =>
  filename ? fs.promises.unlink(path.join(RECORDING_DIR, path.basename(filename))).catch(() => {}) : null;

// POST /api/meetings/:id/recording (multipart field "recording")
export const saveRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return removeFile(req.file?.filename);
    if (!req.file) return res.status(400).json({ success: false, message: "No recording received" });
    if (req.file.size === 0) {
      await removeFile(req.file.filename);
      return res.status(400).json({ success: false, message: "The recording is empty" });
    }

    const old = meeting.recordingFile?.filename;
    meeting.recording = true;
    const fromCall = req.body.fromCall === "1" || req.body.fromCall === "true";
    if (!fromCall && meeting.callRecording?.startedAt) meeting.callRecording = { startedAt: null, startedBy: null, stoppedAt: null };
    meeting.recordingFile = {
      filename: req.file.filename,
      name: `${meeting.title} - recording${path.extname(req.file.filename)}`,
      size: req.file.size,
      mimetype: RECORDING_TYPES.test(req.file.mimetype)
        ? req.file.mimetype.split(";")[0]
        : ({ ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" }[path.extname(req.file.filename)] || "video/webm"),
      durationSec: Math.max(0, Math.round(Number(req.body.durationSec) || 0)),
      uploadedBy: req.user._id,
      uploadedAt: new Date(),
    };
    await meeting.save();
    if (old && old !== req.file.filename) await removeFile(old);

    res.status(201).json({
      success: true,
      message: "Recording saved to this MoM",
      data: meeting.recordingFile,
    });
  } catch (err) {
    await removeFile(req.file?.filename);
    fail(res, err);
  }
};

// GET /api/meetings/:id/recording  — authenticated stream (Range supported for seeking)
export const streamRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res, "recordingFile title");
    if (!meeting) return;
    const file = meeting.recordingFile;
    const full = file?.filename ? path.join(RECORDING_DIR, path.basename(file.filename)) : null;
    if (!full || !fs.existsSync(full)) {
      return res.status(404).json({ success: false, message: "No recording for this meeting" });
    }
    res.set("Cache-Control", "private, no-store");
    if (req.query.download === "1") return res.download(full, file.name);
    res.type(file.mimetype || "video/webm");
    return res.sendFile(full);
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /api/meetings/:id/recording
export const deleteRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const old = meeting.recordingFile?.filename;
    meeting.recordingFile = null;
    await meeting.save();
    await removeFile(old);
    res.json({ success: true, message: "Recording deleted" });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== TRANSCRIPT ====================
const cleanEntries = (list) =>
  (Array.isArray(list) ? list : [])
    .map((e) => ({
      speaker: String(e?.speaker || "Speaker").trim().slice(0, 80) || "Speaker",
      text: String(e?.text || "").trim().slice(0, 5000),
      at: e?.at && !Number.isNaN(new Date(e.at).getTime()) ? new Date(e.at) : null,
      offsetSec: Number.isFinite(Number(e?.offsetSec)) && e?.offsetSec !== null ? Number(e.offsetSec) : null,
    }))
    .filter((e) => e.text);

const plain = (doc) => (doc?.toObject ? doc.toObject() : { ...doc });

const saveTranscript = async (req, res, meeting, entries, source, { append = false, extra = {} } = {}) => {
  const keep = append && meeting.transcript?.source === source;
  const current = keep ? (meeting.transcript.entries || []).map(plain) : [];
  const merged = [...current, ...entries].slice(0, MAX_TRANSCRIPT_ENTRIES);
  // Speaker assignments made earlier survive appends (live transcription)
  const built = buildSpeakers(merged, keep ? (meeting.transcript.speakers || []).map(plain) : [], meeting.attendees);
  meeting.transcription = true;
  meeting.transcript = {
    source,
    entries: built.entries,
    speakers: built.speakers,
    language: meeting.transcriptionLanguage || DEFAULT_TRANSCRIPTION_LANGUAGE,
    updatedAt: new Date(),
    updatedBy: req.user._id,
  };
  Object.assign(meeting, extra);
  await meeting.save();
  return res.json({
    success: true,
    message: `Transcript saved (${merged.length} line${merged.length === 1 ? "" : "s"})`,
    data: { transcript: meeting.transcript, googleRecordingUrl: meeting.googleRecordingUrl },
  });
};

// PUT /api/meetings/:id/transcript  { entries: [...], source: "live", append?: true }
export const putTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const entries = cleanEntries(req.body.entries);
    const source = req.body.source === "import" ? "import" : "live";
    if (!entries.length && !req.body.append) {
      return res.status(400).json({ success: false, message: "Transcript is empty" });
    }
    return saveTranscript(req, res, meeting, entries, source, { append: Boolean(req.body.append) });
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/import  { text: "<file contents>" }
export const importTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const text = String(req.body.text || "");
    if (!text.trim()) return res.status(400).json({ success: false, message: "The transcript file is empty" });
    if (text.length > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Transcript file is larger than 2 MB" });
    }
    const entries = parseTranscript(text);
    if (!entries.length) {
      return res.status(400).json({ success: false, message: "No transcript lines were found in this file" });
    }
    return saveTranscript(req, res, meeting, entries, "import");
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/google  — pull from Google Meet (Workspace accounts)
export const fetchTranscriptFromGoogle = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const { entries, recordingUrl } = await fetchGoogleMeetTranscript(meeting.googleMeetLink, req.app.get("meetClient"));
    return saveTranscript(req, res, meeting, cleanEntries(entries), "google", {
      extra: recordingUrl ? { googleRecordingUrl: recordingUrl } : {},
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/whisper  { language? } — (re)create the transcript from the recording
export const transcribeRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const language = readLanguage(req, res);
    if (language === null) return;
    if (!meeting.recordingFile?.filename) {
      return res.status(400).json({ success: false, message: "Record the meeting first — there is no recording to transcribe." });
    }
    if (["queued", "processing"].includes(meeting.transcript?.status)) {
      return res.status(409).json({ success: false, message: "This recording is already being transcribed." });
    }
    if (language && language !== meeting.transcriptionLanguage) {
      meeting.transcriptionLanguage = language;
      await meeting.save();
    }
    const position = await queueTranscription(meeting._id, req.user._id);
    res.status(202).json({
      success: true,
      message: position > 1 ? `Queued — ${position - 1} recording(s) ahead of this one` : "Transcription started",
      data: { status: "queued", position, language: meeting.transcriptionLanguage },
    });
  } catch (err) {
    fail(res, err);
  }
};

// GET /api/meetings/:id/transcript — current transcript + job status (for polling)
export const getTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res, "transcript transcription transcriptionLanguage recordingFile googleRecordingUrl");
    if (!meeting) return;
    res.json({
      success: true,
      data: {
        transcript: withSpeakerNames(meeting.toObject()).transcript,
        transcription: meeting.transcription,
        transcriptionLanguage: meeting.transcriptionLanguage,
      },
    });
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /api/meetings/:id/transcript
export const clearTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    meeting.transcript = {
      source: "", entries: [], speakers: [], status: "", error: "", notice: "", language: "", detectedLanguage: "",
      updatedAt: new Date(), updatedBy: req.user._id,
    };
    await meeting.save();
    res.json({ success: true, message: "Transcript cleared" });
  } catch (err) {
    fail(res, err);
  }
};

// PUT /api/meetings/:id/transcript/language  { language } — used for the next recording / transcription
export const setTranscriptionLanguage = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const language = readLanguage(req, res);
    if (language === null) return;
    if (!language) return res.status(400).json({ success: false, message: "Choose a transcription language" });
    meeting.transcriptionLanguage = language;
    await meeting.save();
    res.json({ success: true, message: "Transcription language saved", data: { transcriptionLanguage: language } });
  } catch (err) {
    fail(res, err);
  }
};

const busyTranscript = (meeting, res) => {
  if (!["queued", "processing"].includes(meeting.transcript?.status)) return false;
  res.status(409).json({ success: false, message: "Wait until the recording has finished transcribing." });
  return true;
};

// PUT /api/meetings/:id/transcript/speakers  { speakers: [{ id, name, userId? }] }
// Assign an attendee (or any typed name) to a detected speaker; "" name = back to "Speaker N".
export const updateTranscriptSpeakers = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    if (busyTranscript(meeting, res)) return;
    if (!Array.isArray(req.body.speakers) || !req.body.speakers.length) {
      return res.status(400).json({ success: false, message: "No speaker changes received" });
    }
    const speakers = (meeting.transcript?.speakers || []).map(plain);
    const attendees = meeting.attendees || [];
    const orgIds = req.orgUserIds ? new Set(req.orgUserIds.map(String)) : null;

    for (const change of req.body.speakers) {
      const sp = speakers.find((s) => s.id === String(change?.id || ""));
      if (!sp) return res.status(400).json({ success: false, message: `Unknown speaker "${String(change?.id || "").slice(0, 20)}"` });
      const name = String(change.name ?? "").trim().slice(0, 80);
      // A user link is kept only for an attendee of this meeting or a member of my organization
      let userId = null;
      let email = "";
      if (name && change.userId && mongoose.isValidObjectId(change.userId)) {
        const attendee = attendees.find((a) => a.userId && String(a.userId) === String(change.userId));
        if (attendee) {
          userId = attendee.userId;
          email = attendee.email || "";
        } else if (!orgIds || orgIds.has(String(change.userId))) {
          const user = await User.findById(change.userId).select("email").lean();
          if (user) {
            userId = user._id;
            email = user.email || "";
          }
        }
      } else if (name) {
        email = attendees.find((a) => a.name && a.name.trim().toLowerCase() === name.toLowerCase())?.email || "";
      }
      Object.assign(sp, { name, userId, email, matchedBy: name ? "manual" : "", matchScore: null });
    }

    meeting.transcript.speakers = speakers;
    meeting.transcript.entries = applySpeakers((meeting.transcript.entries || []).map(plain), speakers);
    meeting.transcript.updatedAt = new Date();
    meeting.transcript.updatedBy = req.user._id;
    await meeting.save();
    res.json({ success: true, message: "Speaker names saved", data: { transcript: meeting.transcript } });
  } catch (err) {
    fail(res, err);
  }
};

// PATCH /api/meetings/:id/transcript/entries/:index  { text?, speakerId?, original? }
// Correct one line. "original" (the text the editor started from) guards against the line
// having changed meanwhile (e.g. live transcription or another editor).
export const editTranscriptEntry = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    if (busyTranscript(meeting, res)) return;
    const entries = (meeting.transcript?.entries || []).map(plain);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
      return res.status(404).json({ success: false, message: "Transcript line not found" });
    }
    const entry = entries[index];
    if (req.body.original !== undefined && String(req.body.original) !== entry.text) {
      return res.status(409).json({ success: false, message: "This line was changed meanwhile — reload the transcript and try again." });
    }
    if (req.body.text !== undefined) {
      const text = String(req.body.text).trim().slice(0, 5000);
      if (!text) return res.status(400).json({ success: false, message: "A transcript line cannot be empty" });
      if (text !== entry.text) Object.assign(entry, { text, edited: true });
    }
    const speakers = (meeting.transcript.speakers || []).map(plain);
    if (req.body.speakerId === "new") {
      // Two people were heard as one voice → split this line off into a new speaker
      const n = speakers.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/^S/, "")) || 0), 0) + 1;
      speakers.push({ id: `S${n}`, label: `Speaker ${n}`, name: "", userId: null, email: "" });
      entry.speakerId = `S${n}`;
      meeting.transcript.speakers = speakers;
    } else if (req.body.speakerId !== undefined) {
      if (!speakers.some((s) => s.id === String(req.body.speakerId))) {
        return res.status(400).json({ success: false, message: "Unknown speaker" });
      }
      entry.speakerId = String(req.body.speakerId);
    }
    meeting.transcript.entries = applySpeakers(entries, speakers);
    meeting.transcript.updatedAt = new Date();
    meeting.transcript.updatedBy = req.user._id;
    await meeting.save();
    res.json({ success: true, message: "Transcript line saved", data: { transcript: meeting.transcript } });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== VOICE PROFILE (the logged-in user's own) ====================
// A ~10 s sample the user records of themselves, with consent. Only a voice vector is kept;
// the audio file is deleted straight away. Used to put names on transcript speakers.
const voiceSampleUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECORDING_DIR),
    filename: (req, file, cb) => cb(null, `voice-${Date.now()}-${crypto.randomUUID()}.webm`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^(audio|video)\//i.test(file.mimetype) || /\.(webm|ogg|wav|mp3|m4a|mp4)$/i.test(file.originalname || "")) return cb(null, true);
    const err = new Error("The voice sample must be an audio file");
    err.status = 400;
    cb(err);
  },
}).single("sample");

export const uploadVoiceSample = (req, res, next) =>
  voiceSampleUpload(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "The voice sample is larger than 10 MB" : err.message });
  });

const profileStatus = (u) => ({
  enrolled: Boolean(u?.voiceProfile?.updatedAt),
  updatedAt: u?.voiceProfile?.updatedAt || null,
  seconds: u?.voiceProfile?.seconds || 0,
});

// GET /api/meetings/voice-profile
export const getVoiceProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("voiceProfile.updatedAt voiceProfile.seconds").lean();
    res.json({ success: true, data: profileStatus(user) });
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/voice-profile   (multipart "sample", consent=1)
export const saveVoiceProfile = async (req, res) => {
  const file = req.file?.filename;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No voice sample received" });
    if (!["1", "true"].includes(String(req.body.consent))) {
      return res.status(400).json({ success: false, message: "Please agree to store your voice profile first" });
    }
    let print;
    try {
      print = await createVoiceprint(path.join(RECORDING_DIR, path.basename(file)));
    } catch (err) {
      return res.status(422).json({ success: false, message: err.message || "The voice sample could not be processed" });
    }
    const now = new Date();
    await User.updateOne(
      { _id: req.user._id },
      { $set: { "voiceProfile.embedding": print.embedding, "voiceProfile.seconds": print.seconds || 0, "voiceProfile.consentAt": now, "voiceProfile.updatedAt": now } }
    );
    res.json({ success: true, message: "Voice profile saved — meeting transcripts can now show your name", data: profileStatus({ voiceProfile: { updatedAt: now, seconds: print.seconds } }) });
  } catch (err) {
    fail(res, err);
  } finally {
    await removeFile(file);
  }
};

// DELETE /api/meetings/voice-profile
export const deleteVoiceProfile = async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $unset: { voiceProfile: "" } });
    res.json({ success: true, message: "Voice profile deleted", data: profileStatus(null) });
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/identify — name speakers from attendees' voice profiles
// (e.g. after someone recorded their profile). Names chosen by hand are kept.
export const identifyTranscriptSpeakers = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res, "+transcript.voiceprints +callActivity");
    if (!meeting) return;
    if (busyTranscript(meeting, res)) return;
    const voiceprints = (meeting.transcript?.voiceprints || []).map(plain);

    // Recorded in the video call → who was talking (their own microphone) names the speakers
    if (meeting.callRecording?.startedAt && meeting.callActivity?.length) {
      await meeting.populate("createdBy", "name email");
      const voice = voiceprints.length
        ? await nameSpeakersByVoice((meeting.transcript.speakers || []).map(plain), voiceprints, meeting)
        : { speakers: (meeting.transcript.speakers || []).map(plain), matched: 0 };
      const byCall = nameSpeakersByCall(
        voice.speakers,
        (meeting.transcript.entries || []).map(plain),
        meeting.callActivity.map(plain),
        meeting.callRecording.startedAt,
        callPeople(meeting)
      );
      meeting.transcript.speakers = byCall.speakers;
      meeting.transcript.entries = applySpeakers((meeting.transcript.entries || []).map(plain), byCall.speakers);
      await meeting.save();
      const matched = voice.matched + byCall.matched;
      const transcript = meeting.toObject().transcript;
      delete transcript.voiceprints;
      return res.json({
        success: true,
        message: matched
          ? `${matched} speaker${matched === 1 ? "" : "s"} named from who was talking in the video call`
          : "No speaker clearly matched a call participant — assign them by hand",
        data: { transcript, matched },
      });
    }

    if (!voiceprints.length) {
      return res.status(400).json({
        success: false,
        message: "This transcript has no voice data — click “Transcribe recording” once to create it, then try again.",
      });
    }
    const { speakers, matched, profiles } = await nameSpeakersByVoice((meeting.transcript.speakers || []).map(plain), voiceprints, meeting);
    meeting.transcript.speakers = speakers;
    meeting.transcript.entries = applySpeakers((meeting.transcript.entries || []).map(plain), speakers);
    await meeting.save();
    const message = !profiles
      ? "None of the attendees has recorded a voice profile yet"
      : matched
      ? `${matched} speaker${matched === 1 ? "" : "s"} recognized from voice profiles`
      : "No speaker clearly matched an attendee's voice profile — assign them by hand";
    const transcript = meeting.toObject().transcript;
    delete transcript.voiceprints;
    res.json({ success: true, message, data: { transcript, matched } });
  } catch (err) {
    fail(res, err);
  }
};
