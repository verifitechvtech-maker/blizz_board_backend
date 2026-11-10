// Queue for transcribing meeting recordings with local Whisper (one at a time).
// Result is saved on the meeting as transcript { source: "whisper", entries, speakers, language, status }.
// The language comes from meeting.transcriptionLanguage ("auto" = detect); lines are grouped
// by voice into "Speaker 1", "Speaker 2", … which users then map to attendees.
import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Meeting from "../models/Meeting.js";
import { normalizeLanguage } from "../config/transcriptionLanguages.js";
import { callPeople, nameSpeakersByCall } from "../utils/callSpeakers.js";
import { nameSpeakersByVoice } from "./voiceProfileService.js";
import { applySpeakers } from "../utils/transcriptSpeakers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDING_DIR = path.resolve(here, "../../uploads/meetings");

// Multilingual Whisper "base" (~77 MB). Override in .env, e.g. onnx-community/whisper-small
export const WHISPER_MODEL = () => process.env.WHISPER_MODEL || "onnx-community/whisper-base";
// Fallback when a meeting has no language saved: a code ("ta") or name ("tamil"); empty → English
export const WHISPER_LANGUAGE = () => normalizeLanguage(process.env.WHISPER_LANGUAGE || "en");
// Speaker separation by voice (local WeSpeaker model, ~7 MB download). WHISPER_DIARIZE=false turns it off.
export const SPEAKER_MODEL = () => process.env.SPEAKER_MODEL || "onnx-community/wespeaker-voxceleb-resnet34-LM";
export const DIARIZE = () => !/^(0|false|no|off)$/i.test(process.env.WHISPER_DIARIZE || "");
// Voice similarity (0–1) above which two lines count as the same speaker
export const SPEAKER_THRESHOLD = () => Number(process.env.SPEAKER_THRESHOLD) || 0.4;

let worker = null;
let seq = 0;
const waiting = new Map();

const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(path.resolve(here, "../workers/whisperWorker.js"));
  worker.unref(); // never keeps the process alive on shutdown
  worker.on("message", (msg) => {
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
  });
  worker.on("error", (err) => {
    for (const p of waiting.values()) p.reject(err);
    waiting.clear();
    worker = null;
  });
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
};

// Default transcriber (tests replace it via setTranscriber)
// options: { language: "en" | "ta" | … | "auto", maxSpeakers }
// resolves { seconds, segments: [{ text, start, end?, speakerIndex? }], language?, notice? }
let transcriber = (file, options = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({
      id,
      file,
      model: WHISPER_MODEL(),
      language: options.language || WHISPER_LANGUAGE(),
      diarize: options.diarize ?? DIARIZE(), // one person's clip (video call) → no grouping by voice
      speakerModel: SPEAKER_MODEL(),
      maxSpeakers: options.maxSpeakers,
      threshold: SPEAKER_THRESHOLD(),
    });
  });

export const transcribeFile = (file, options) => transcriber(file, options);

export const setTranscriber = (fn) => {
  transcriber = fn;
};

// Voice profile from a sample file → { embedding: number[], seconds } (tests replace it)
let voiceprinter = (file) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ type: "voiceprint", id, file, speakerModel: SPEAKER_MODEL() });
  });

export const createVoiceprint = (file) => voiceprinter(file);

export const setVoiceprinter = (fn) => {
  voiceprinter = fn;
};

const queue = [];
let running = false;

const setStatus = (meetingId, patch) =>
  Meeting.updateOne(
    { _id: meetingId },
    { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transcript.${k}`, v])) }
  );

const runNext = async () => {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    const meeting = await Meeting.findById(job.meetingId)
      .select("recordingFile title transcriptionLanguage attendees createdBy callRecording +callActivity")
      .populate("createdBy", "name email");
    const file = meeting?.recordingFile?.filename ? path.join(RECORDING_DIR, path.basename(meeting.recordingFile.filename)) : null;
    if (!file || !fs.existsSync(file)) throw new Error("The recording file is missing.");

    await setStatus(job.meetingId, { status: "processing", error: "", startedAt: new Date() });
    const started = Date.now();
    const language = meeting.transcriptionLanguage || WHISPER_LANGUAGE();
    // Upper bound for voices: the invited attendees + the organizer (diarization may not find more)
    const maxSpeakers = Math.min(12, Math.max(2, (meeting.attendees?.length || 0) + 1));
    const result = await transcriber(file, { language, maxSpeakers });
    const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
    const entries = result.segments.map((s) => {
      const n = (Number.isInteger(s.speakerIndex) ? s.speakerIndex : 0) + 1;
      return { speaker: `Speaker ${n}`, speakerId: `S${n}`, text: s.text, offsetSec: round(s.start), endSec: round(s.end), at: null };
    });
    if (!entries.length) throw new Error("No speech was found in the recording.");
    const ids = [...new Set(entries.map((e) => e.speakerId))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const voiceprints = (result.voiceprints || [])
      .filter((v) => Number.isInteger(v.index) && v.embedding?.length)
      .map((v) => ({ id: `S${v.index + 1}`, embedding: Array.from(v.embedding) }));
    // Attendees who recorded a voice profile are named automatically (confident matches only)
    const named = await nameSpeakersByVoice(
      ids.map((id) => ({ id, label: `Speaker ${id.slice(1)}`, name: "", userId: null, email: "", matchedBy: "", matchScore: null })),
      voiceprints,
      meeting
    ).catch((err) => {
      console.error("Voice profile matching failed:", err.message);
      return null;
    });
    let speakers = named?.speakers || ids.map((id) => ({ id, label: `Speaker ${id.slice(1)}`, name: "", userId: null, email: "" }));

    // Recorded inside the video call → name speakers by who was talking (their own microphone)
    const byCall = nameSpeakersByCall(speakers, entries, meeting.callActivity, meeting.callRecording?.startedAt, callPeople(meeting));
    speakers = byCall.speakers;

    await Meeting.updateOne(
      { _id: job.meetingId },
      {
        $set: {
          transcription: true,
          "transcript.source": "whisper",
          "transcript.entries": applySpeakers(entries.slice(0, 5000), speakers),
          "transcript.speakers": speakers,
          "transcript.voiceprints": voiceprints,
          "transcript.language": language,
          "transcript.detectedLanguage": language === "auto" ? result.language || "" : "",
          "transcript.notice": result.notice || "",
          "transcript.status": "done",
          "transcript.error": "",
          "transcript.updatedAt": new Date(),
          "transcript.updatedBy": job.userId || null,
        },
      }
    );
    console.log(`📝 Transcribed "${meeting.title}" (${result.language || language}): ${entries.length} lines, ${speakers.length} speaker(s) (${named?.matched || 0} named by voice profile, ${byCall.matched} by the video call), ${Math.round(result.seconds || 0)}s audio in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error("Transcription failed:", err.message);
    await setStatus(job.meetingId, { status: "failed", error: err.message.slice(0, 500) }).catch(() => {});
  } finally {
    running = false;
    setImmediate(runNext);
  }
};

/** Put a meeting's recording in the queue. Returns the queue position (1 = next). */
export const queueTranscription = async (meetingId, userId) => {
  if (queue.some((j) => String(j.meetingId) === String(meetingId))) return queue.length;
  await setStatus(meetingId, { status: "queued", error: "" });
  queue.push({ meetingId, userId });
  setImmediate(runNext);
  return queue.length + (running ? 1 : 0);
};

// After a restart, anything that was "processing" or "queued" would wait forever → re-queue it
export const resumeInterruptedTranscriptions = async () => {
  const stuck = await Meeting.find({ "transcript.status": { $in: ["queued", "processing"] } }).select("_id").lean();
  for (const m of stuck) await queueTranscription(m._id, null);
  if (stuck.length) console.log(`📝 Re-queued ${stuck.length} interrupted transcription(s)`);
};
