// Runs in a worker thread: decode a recording with ffmpeg and transcribe it with
// Whisper (local, no API key — the same approach as Meetily). Keeps the API responsive.
// Optional extras, also local:
//  • language = "auto" → Whisper language detection on the first 30 s of speech
//  • diarize          → a speaker-embedding model (WeSpeaker) groups the lines by voice
//                        into Speaker 1, Speaker 2, … and returns one voiceprint per speaker
//  • type: "voiceprint" → a voice profile from a short sample a user recorded of themselves
import { parentPort } from "node:worker_threads";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { pipeline, env, Tensor, AutoProcessor, AutoModel } from "@huggingface/transformers";
import { clusterSpeakers } from "../utils/speakerClustering.js";
import { cleanSegments } from "../utils/transcriptCleanup.js";

env.cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../models");

const RATE = 16000;
let asr = null;
let loadedModel = "";
let speakerModel = null;
let loadedSpeakerModel = "";

const decode = (file) =>
  new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not read the recording audio (${err.trim().split("\n").pop() || code})`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });

// Whisper's own language detection: one decoder step after <|startoftranscript|>,
// then the most likely language token. (transformers.js does not do this itself.)
const detectLanguage = async (audio) => {
  const gc = asr.model.generation_config;
  if (!gc?.is_multilingual || !gc.lang_to_id) return "en";

  // Start at the first audible sample so leading silence doesn't decide the language
  let start = 0;
  while (start < audio.length && Math.abs(audio[start]) < 0.01) start += 160;
  if (start >= audio.length) start = 0;
  const { input_features } = await asr.processor(audio.subarray(start, start + 30 * RATE));
  const sot = new Tensor("int64", BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
  const { logits } = await asr.model({ input_features, decoder_input_ids: sot });
  const vocab = logits.dims.at(-1);
  const last = logits.data.length - vocab;
  let best = { code: "en", score: -Infinity };
  for (const [token, id] of Object.entries(gc.lang_to_id)) {
    const score = logits.data[last + id];
    if (score > best.score) best = { code: token.replace(/[<|>]/g, ""), score };
  }
  return best.code;
};

const loadSpeakerModel = async (modelId) => {
  if (!speakerModel || loadedSpeakerModel !== modelId) {
    speakerModel = {
      processor: await AutoProcessor.from_pretrained(modelId),
      model: await AutoModel.from_pretrained(modelId, { dtype: "q8" }),
    };
    loadedSpeakerModel = modelId;
  }
};

const embed = async (samples) => {
  const res = await speakerModel.model(await speakerModel.processor(samples));
  return Array.from((res.last_hidden_state || Object.values(res)[0]).data);
};

// Average of unit-length vectors, as a plain array (what is stored / compared)
const meanVector = (vectors) => {
  const sum = new Array(vectors[0].length).fill(0);
  for (const v of vectors) {
    const n = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
    v.forEach((x, i) => (sum[i] += x / n));
  }
  const n = Math.sqrt(sum.reduce((acc, x) => acc + x * x, 0)) || 1;
  return sum.map((x) => Math.round((x / n) * 1e6) / 1e6);
};

// One voice vector per transcript line; lines under 1 s are too short to judge (null)
const embedSegments = async (audio, segments, modelId) => {
  await loadSpeakerModel(modelId);
  const out = [];
  for (const s of segments) {
    const dur = s.end - s.start;
    if (dur < 1) {
      out.push(null);
      continue;
    }
    // At most 10 s from the middle of the line is plenty to recognize a voice
    const mid = (s.start + s.end) / 2;
    const from = Math.max(0, Math.floor((dur > 10 ? mid - 5 : s.start) * RATE));
    const to = Math.min(audio.length, Math.ceil((dur > 10 ? mid + 5 : s.end) * RATE));
    out.push(await embed(audio.slice(from, to)));
  }
  return out;
};

// Voice profile from a sample: 3-second windows of the parts where the person is speaking
const voiceprintFromSample = async (id, file, modelId) => {
  try {
    const audio = await decode(file);
    const loud = [];
    const win = 3 * RATE;
    for (let from = 0; from + RATE <= audio.length; from += win) {
      const part = audio.subarray(from, Math.min(audio.length, from + win));
      let energy = 0;
      for (let i = 0; i < part.length; i += 16) energy += part[i] * part[i];
      if (Math.sqrt(energy / (part.length / 16)) > 0.01) loud.push(part);
    }
    const speechSec = loud.reduce((s, p) => s + p.length, 0) / RATE;
    if (speechSec < 4) throw new Error("Not enough speech in the sample — read the sentence aloud for about 10 seconds.");
    await loadSpeakerModel(modelId);
    const vectors = [];
    for (const part of loud) vectors.push(await embed(part.slice()));
    parentPort.postMessage({ id, ok: true, embedding: meanVector(vectors), seconds: Math.round(speechSec) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};

parentPort.on("message", async (msg) => {
  if (msg.type === "voiceprint") return voiceprintFromSample(msg.id, msg.file, msg.speakerModel);
  const { id, file, model, language, diarize, speakerModel: speakerModelId, maxSpeakers, threshold } = msg;
  try {
    const audio = await decode(file);
    const seconds = audio.length / RATE;
    if (seconds < 0.5) throw new Error("The recording has no audio track.");

    let peak = 0;
    for (let i = 0; i < audio.length; i += 160) peak = Math.max(peak, Math.abs(audio[i]));
    if (peak < 0.003) {
      throw new Error('The recording is silent. When recording, pick the Google Meet tab and tick "Also share tab audio".');
    }

    if (!asr || loadedModel !== model) {
      asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
      loadedModel = model;
    }

    const lang = !language || language === "auto" ? await detectLanguage(audio) : language;
    const out = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: "transcribe",
      language: lang,
    });
    const segments = cleanSegments(
      (out.chunks || [{ timestamp: [0, seconds], text: out.text }]).map((c, i, all) => {
        const ts = Array.isArray(c.timestamp) ? c.timestamp : [0, null];
        const start = ts[0] ?? 0;
        const next = all[i + 1]?.timestamp?.[0];
        return { text: String(c.text || ""), start, end: ts[1] ?? next ?? seconds };
      })
    );

    // Speaker separation is a bonus: if it fails, the transcript is still returned
    let notice = "";
    let voiceprints = [];
    if (diarize && segments.length) {
      try {
        const embeddings = await embedSegments(audio, segments, speakerModelId);
        const labels = clusterSpeakers(embeddings, segments.map((s) => s.end - s.start), { maxSpeakers, threshold });
        segments.forEach((s, i) => (s.speakerIndex = labels[i]));
        // One voiceprint per speaker (for matching attendees' voice profiles)
        const bySpeaker = new Map();
        labels.forEach((k, i) => embeddings[i] && bySpeaker.set(k, [...(bySpeaker.get(k) || []), embeddings[i]]));
        voiceprints = [...bySpeaker].map(([index, list]) => ({ index, embedding: meanVector(list) }));
      } catch (err) {
        notice = `Speakers could not be separated (${err.message || err}). All lines are under one speaker.`;
      }
    }

    parentPort.postMessage({ id, ok: true, seconds, segments, language: lang, notice, voiceprints });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message || String(err) });
  }
});
