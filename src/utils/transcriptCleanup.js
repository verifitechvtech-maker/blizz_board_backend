// Tidies Whisper output: removes sound / filler tags and the repetition loops small Whisper
// models produce ("I'm going to … I'm going to …", "Amma, amma, amma"), and drops a line
// that only repeats the line before it.

const TAGS = /[[(](music|silence|blank_audio|beep|noise|applause|laughter|inaudible|unintelligible|indistinct|crosstalk)[\])]/gi;

const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Drop a piece that is the same as the one right before it
const dedupe = (pieces) => pieces.filter((p, i) => !key(p) || i === 0 || key(p) !== key(pieces[i - 1]));

export const cleanSegmentText = (text) => {
  let t = String(text || "").replace(TAGS, " ").replace(/\s+/g, " ").trim();
  // sentences ("…. …? …!" incl. Hindi danda), then comma-separated phrases inside them
  t = dedupe(t.split(/(?<=[.!?।])\s+/))
    .map((sentence) => dedupe(sentence.split(/,\s*/)).join(", "))
    .join(" ");
  return t.trim();
};

/** segments: [{ text, start, end, … }] → cleaned, empty and back-to-back duplicate lines removed */
export const cleanSegments = (segments) => {
  const out = [];
  for (const s of segments) {
    const text = cleanSegmentText(s.text);
    if (!key(text)) continue;
    const prev = out[out.length - 1];
    if (prev && key(prev.text) === key(text)) {
      prev.end = Math.max(prev.end ?? 0, s.end ?? 0); // same words again → extend the previous line
      continue;
    }
    out.push({ ...s, text });
  }
  return out;
};
