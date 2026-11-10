// Matches the voices found in a recording to the voice profiles that attendees recorded
// themselves (with consent). A speaker gets a name only when its voice is clearly closest to
// one person's profile: above `threshold` AND ahead of the next-best person by `margin`.
// Everyone else stays "Speaker N" for a user to assign — nothing is guessed.

const normalize = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const cosine = (a, b) => {
  const x = normalize(a);
  const y = normalize(b);
  return x.reduce((s, v, i) => s + v * (y[i] || 0), 0);
};

/**
 * @param {{ id: string, embedding: number[] }[]} voiceprints one per detected speaker
 * @param {{ key: string, embedding: number[] }[]} profiles one per person who has a voice profile
 * @returns {{ speakerId: string, key: string, score: number }[]} confident matches only
 */
export const matchVoices = (voiceprints, profiles, { threshold = 0.55, margin = 0.1 } = {}) => {
  const vps = (voiceprints || []).filter((v) => v?.embedding?.length);
  const pps = (profiles || []).filter((p) => p?.embedding?.length);
  if (!vps.length || !pps.length) return [];

  const pairs = [];
  for (const v of vps) {
    const scores = pps.map((p) => ({ key: p.key, score: cosine(v.embedding, p.embedding) })).sort((a, b) => b.score - a.score);
    const [best, second] = scores;
    // Ambiguous between two people → leave it for a human
    if (best.score >= threshold && (!second || best.score - second.score >= margin)) {
      pairs.push({ speakerId: v.id, key: best.key, score: best.score });
    }
  }

  // Several speakers may match the same person: diarization sometimes splits one voice in two
  return pairs;
};
