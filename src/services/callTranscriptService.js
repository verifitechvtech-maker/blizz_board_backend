import fs from "node:fs";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import Meeting from "../models/Meeting.js";
import { transcribeFile } from "./transcriptionService.js";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "../config/transcriptionLanguages.js";

/* =========================================================
   Live transcript of a video call, line by line, with each person's name.
   Every browser transcribes ONLY its own microphone and sends the text; the server
   writes the line under the account that sent it (from the login token) — so the
   name is always right. The lines are the meeting's transcript (source "live"),
   shown on the MoM page after the call.
========================================================= */

export const MAX_CAPTION_LENGTH = 1000;
const MAX_ENTRIES = 5000;

// BCP-47 tag for the browser's speech recognition (e.g. "en" → "en-IN")
export const speechLangFor = (code) =>
  TRANSCRIPTION_LANGUAGES.find((l) => l.code === code)?.speech ||
  TRANSCRIPTION_LANGUAGES.find((l) => l.code === DEFAULT_TRANSCRIPTION_LANGUAGE)?.speech ||
  "en-IN";

// one writer per meeting at a time, so lines from several people never overwrite each other
const queues = new Map();
const serial = (key, job) => {
  const next = (queues.get(key) || Promise.resolve()).then(job, job);
  queues.set(key, next.finally(() => queues.get(key) === next && queues.delete(key)));
  return next;
};

/**
 * Add one spoken line. Returns { saved, entry } or { saved: false, reason } when the
 * meeting already holds another kind of transcript (recording / imported / Google) —
 * that one is never mixed with or overwritten by call captions.
 */
export const appendCallCaption = (meetingId, user, rawText, at = new Date()) =>
  serial(String(meetingId), async () => {
    const text = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION_LENGTH);
    if (!text) return { saved: false, reason: "empty" };

    const meeting = await Meeting.findById(meetingId).select("transcript attendees transcriptionLanguage");
    if (!meeting) return { saved: false, reason: "missing" };
    const t = meeting.transcript || {};
    const entries = t.entries || [];
    if (entries.length && t.source && t.source !== "live") return { saved: false, reason: `existing-${t.source}` };
    if (entries.length >= MAX_ENTRIES) return { saved: false, reason: "full" };

    // the speaker = this account (one per person, named after them)
    const speakers = (t.speakers || []).map((s) => (s.toObject ? s.toObject() : s));
    let speaker = speakers.find((s) => s.userId && String(s.userId) === String(user._id));
    if (!speaker) {
      const n = speakers.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/^S/, "")) || 0), 0) + 1;
      const attendee = (meeting.attendees || []).find((a) => a.userId && String(a.userId) === String(user._id));
      speaker = {
        id: `S${n}`,
        label: user.name,
        name: user.name,
        userId: user._id,
        email: attendee?.email || user.email || "",
        matchedBy: "call",
        matchScore: null,
      };
      speakers.push(speaker);
    }

    const entry = { speaker: speaker.name, speakerId: speaker.id, text, at, offsetSec: null, endSec: null, edited: false };
    await Meeting.updateOne(
      { _id: meetingId },
      {
        $set: {
          transcription: true,
          "transcript.source": "live",
          "transcript.speakers": speakers,
          "transcript.language": meeting.transcriptionLanguage || DEFAULT_TRANSCRIPTION_LANGUAGE,
          "transcript.status": "",
          "transcript.updatedAt": new Date(),
          "transcript.updatedBy": user._id,
        },
        $push: { "transcript.entries": entry },
      }
    );
    return { saved: true, entry };
  });

/* ---------------- Server transcription of one person's speech clip ----------------
   The browser records only its OWN microphone while that person talks and uploads the clip
   with their login → the line is theirs (user id), never guessed from the voice. */

export const MAX_CLIP_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_CLIPS = 30;
let pending = 0;
let clipChain = Promise.resolve();

// Whisper writes these for silence / noise — not speech
const NOT_SPEECH = /^[\s.,!?…-]*$|^\s*[\[(][^\])]*[\])]\s*$/;

/* Optional: a whisper.cpp server (the engine Meetily is built on) for call transcripts.
   WHISPER_SERVER_URL=http://127.0.0.1:8178   → POST /inference (multipart "file", response_format=json)
   Not set → the built-in Whisper worker is used. */
const whisperServerUrl = () => String(process.env.WHISPER_SERVER_URL || "").replace(/\/+$/, "");

// whisper.cpp wants 16 kHz mono WAV — convert the browser's clip (webm / ogg / mp4)
const toWav = (file) =>
  new Promise((resolve, reject) => {
    const out = `${file}.wav`;
    const ff = spawn(ffmpegPath, ["-v", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]);
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("Could not read the audio clip"))));
  });

const transcribeWithWhisperServer = async (file, language) => {
  const wav = await toWav(file);
  try {
    const form = new FormData();
    form.append("file", new Blob([await fs.promises.readFile(wav)], { type: "audio/wav" }), "clip.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    if (language && language !== "auto") form.append("language", language);
    const res = await fetch(`${whisperServerUrl()}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`whisper server answered ${res.status}`);
    const data = await res.json();
    return { segments: [{ text: String(data.text || "") }] };
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
};

/** Transcribe a clip (one at a time — clips never overload the server). Returns the text ("" = nothing said). */
export const transcribeClip = (file, language) => {
  if (pending >= MAX_PENDING_CLIPS) {
    fs.promises.unlink(file).catch(() => {});
    return Promise.reject(Object.assign(new Error("Transcription is busy — try again in a moment"), { status: 503 }));
  }
  pending += 1;
  const job = clipChain.then(async () => {
    try {
      const lang = language || DEFAULT_TRANSCRIPTION_LANGUAGE;
      const result = whisperServerUrl()
        ? await transcribeWithWhisperServer(file, lang)
        : await transcribeFile(file, { language: lang, diarize: false, maxSpeakers: 1 });
      const text = (result?.segments || []).map((s) => String(s.text || "").trim()).join(" ").replace(/\s+/g, " ").trim();
      return NOT_SPEECH.test(text) ? "" : text;
    } finally {
      pending -= 1;
      fs.promises.unlink(file).catch(() => {});
    }
  });
  clipChain = job.catch(() => {});
  return job;
};
