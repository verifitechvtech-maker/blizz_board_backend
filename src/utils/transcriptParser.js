// Turns transcript files into [{ speaker, text, offsetSec }].
// Supports: WebVTT (.vtt), SubViewer (.sbv), Google Meet / Docs text export
// ("Name: text" lines, optional "00:01:23" timestamp lines) and plain text.

const toSeconds = (stamp) => {
  const parts = String(stamp).trim().replace(",", ".").split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

const TIME_RANGE = /^(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d+)?\s*(-->|,)\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d+)?/;
const TIME_ONLY = /^\(?(\d{1,2}:)?\d{1,2}:\d{2}\)?$/;
// "Name: text" — name up to 60 chars, no URL-like prefixes
const SPEAKER_LINE = /^([^:\n]{1,60}?):\s+(.+)$/;
// WebVTT voice tag <v Name>text
const VTT_VOICE = /^<v\s+([^>]+)>(.*)$/i;

const pushEntry = (entries, speaker, text, offsetSec) => {
  const clean = String(text || "").replace(/<[^>]+>/g, "").trim();
  if (!clean) return;
  entries.push({ speaker: (speaker || "Speaker").trim().slice(0, 80), text: clean.slice(0, 5000), offsetSec });
};

export const parseTranscript = (raw) => {
  const text = String(raw || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const entries = [];
  const isCaptionFile = /^WEBVTT/.test(text.trim()) || lines.some((l) => TIME_RANGE.test(l.trim()));

  if (isCaptionFile) {
    // Blocks: [index]\n<time range>\n<text lines>\n\n
    let offset = null;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const joined = buffer.join(" ").trim();
      const voice = joined.match(VTT_VOICE);
      const speakerLine = joined.match(SPEAKER_LINE);
      if (voice) pushEntry(entries, voice[1], voice[2], offset);
      else if (speakerLine) pushEntry(entries, speakerLine[1], speakerLine[2], offset);
      else pushEntry(entries, "Speaker", joined, offset);
      buffer = [];
    };
    for (const line of lines) {
      const l = line.trim();
      if (!l) { flush(); continue; }
      if (/^WEBVTT/.test(l) || /^NOTE\b/.test(l) || /^\d+$/.test(l)) continue;
      if (TIME_RANGE.test(l)) { flush(); offset = toSeconds(l.split(/-->|,/)[0]); continue; }
      buffer.push(l);
    }
    flush();
    return entries;
  }

  // Google Meet text export / plain notes
  let offset = null;
  let lastSpeaker = "Speaker";
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (TIME_ONLY.test(l)) { offset = toSeconds(l.replace(/[()]/g, "")); continue; }
    // Header lines of a Meet transcript doc
    if (/^(Transcript|Attendees|Meeting ended|This editable transcript)/i.test(l)) continue;
    const m = l.match(SPEAKER_LINE);
    if (m && !/^https?$/i.test(m[1])) {
      lastSpeaker = m[1];
      pushEntry(entries, m[1], m[2], offset);
    } else {
      pushEntry(entries, lastSpeaker, l, offset);
    }
  }
  return entries;
};
