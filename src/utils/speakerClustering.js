// Groups transcript segments by voice: each segment has a speaker embedding (a vector from
// the WeSpeaker model) and segments whose voices are close enough get the same speaker number.
// Only says "these lines were spoken by the same voice" — never who that person is.

const normalize = (v) => {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

const makeCluster = (vec, dur) => ({ sum: Float32Array.from(vec), dur, centroid: Float32Array.from(vec) });

const addTo = (c, vec, dur) => {
  for (let i = 0; i < vec.length; i += 1) c.sum[i] += vec[i];
  c.dur += dur;
  c.centroid = normalize(c.sum);
};

const mostSimilarPair = (clusters) => {
  let best = { sim: -Infinity, a: -1, b: -1 };
  for (let a = 0; a < clusters.length; a += 1) {
    for (let b = a + 1; b < clusters.length; b += 1) {
      const sim = dot(clusters[a].centroid, clusters[b].centroid);
      if (sim > best.sim) best = { sim, a, b };
    }
  }
  return best;
};

const nearest = (clusters, vec) => {
  let best = 0;
  let bestSim = -Infinity;
  clusters.forEach((c, i) => {
    const sim = dot(c.centroid, vec);
    if (sim > bestSim) {
      bestSim = sim;
      best = i;
    }
  });
  return best;
};

/**
 * @param {(ArrayLike<number>|null)[]} embeddings one per segment (null = too short to judge)
 * @param {number[]} durations seconds of speech per segment
 * @param {{ threshold?: number, maxSpeakers?: number, minSpeakerSec?: number }} options
 * @returns {number[]} speaker number per segment (0, 1, 2… in order of first appearance)
 */
export const clusterSpeakers = (embeddings, durations = [], { threshold = 0.5, maxSpeakers = 10, minSpeakerSec = 2 } = {}) => {
  const vecs = embeddings.map((e) => (e && e.length ? normalize(e) : null));
  const dur = (i) => Math.max(0, Number(durations[i]) || 0);
  if (!vecs.some(Boolean)) return embeddings.map(() => 0);

  // 1) one pass: join the closest voice, or start a new one
  const clusters = [];
  vecs.forEach((v, i) => {
    if (!v) return;
    const k = clusters.length ? nearest(clusters, v) : -1;
    if (k >= 0 && dot(clusters[k].centroid, v) >= threshold) addTo(clusters[k], v, dur(i));
    else clusters.push(makeCluster(v, dur(i)));
  });

  // 2) merge voices that turned out to be the same, and stay within maxSpeakers
  const merge = (a, b) => {
    addTo(clusters[a], clusters[b].sum, clusters[b].dur);
    clusters[a].centroid = normalize(clusters[a].sum);
    clusters.splice(b, 1);
  };
  for (;;) {
    if (clusters.length < 2) break;
    const { sim, a, b } = mostSimilarPair(clusters);
    if (sim >= threshold || clusters.length > Math.max(1, maxSpeakers)) merge(a, b);
    else break;
  }

  // 3) a "voice" heard for only a moment is usually noise / a cough → fold it into its nearest voice
  for (;;) {
    if (clusters.length < 2) break;
    const tiny = clusters.findIndex((c) => c.dur < minSpeakerSec);
    if (tiny < 0) break;
    const [c] = clusters.splice(tiny, 1);
    addTo(clusters[nearest(clusters, c.centroid)], c.sum, c.dur);
  }

  // 4) final assignment to the nearest voice
  const raw = vecs.map((v) => (v ? nearest(clusters, v) : -1));

  // Segments too short to judge take the speaker of the line before (or after) them
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] >= 0) continue;
    const prev = raw.slice(0, i).reverse().find((x) => x >= 0);
    raw[i] = prev ?? raw.slice(i + 1).find((x) => x >= 0) ?? 0;
  }

  // 5) number speakers in order of first appearance
  const order = new Map();
  return raw.map((k) => {
    if (!order.has(k)) order.set(k, order.size);
    return order.get(k);
  });
};
