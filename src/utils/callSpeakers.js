/* =========================================================
   Name transcript speakers from the video call itself.
   Each participant's browser reports when THEIR OWN microphone is speaking (callActivity).
   A transcript speaker (S1, S2…) gets the name of the participant who was talking during
   most of that speaker's lines — only when the evidence is clear. No guessing from voices.
========================================================= */

export const CALL_MATCH_SHARE = 0.5;  // the person must cover at least half of the speaker's talk time
export const CALL_MATCH_LEAD = 1.5;   // …and clearly more than anyone else

/**
 * speakers: [{ id, name, matchedBy… }]   entries: [{ speakerId, offsetSec, endSec }]
 * activity: [{ userId, name, start, end }] recordingStart: Date
 * people: [{ userId, name, email }] (attendees + organizer) — for the email
 * Speakers already named by hand or by voice profile keep their name.
 * Returns { speakers, matched }.
 */
export const nameSpeakersByCall = (speakers, entries, activity, recordingStart, people = []) => {
  const t0 = recordingStart ? new Date(recordingStart).getTime() : NaN;
  if (!Number.isFinite(t0) || !activity?.length) return { speakers, matched: 0 };

  const spans = activity.map((a) => ({
    userId: String(a.userId || ""),
    name: a.name || "",
    start: new Date(a.start).getTime(),
    end: new Date(a.end).getTime(),
  })).filter((a) => a.userId && a.end > a.start);

  const totals = new Map(); // speakerId → { talk, byUser: Map(userId → ms) }
  for (const e of entries || []) {
    if (!Number.isFinite(e.offsetSec)) continue;
    const s = t0 + e.offsetSec * 1000;
    const end = t0 + (Number.isFinite(e.endSec) && e.endSec > e.offsetSec ? e.endSec : e.offsetSec + 2) * 1000;
    const row = totals.get(e.speakerId) || { talk: 0, byUser: new Map() };
    row.talk += end - s;
    for (const a of spans) {
      const overlap = Math.min(end, a.end) - Math.max(s, a.start);
      if (overlap > 0) row.byUser.set(a.userId, (row.byUser.get(a.userId) || 0) + overlap);
    }
    totals.set(e.speakerId, row);
  }

  const nameOf = new Map(spans.map((a) => [a.userId, a.name]));
  const personOf = new Map(people.filter((p) => p.userId).map((p) => [String(p.userId), p]));
  let matched = 0;
  const out = speakers.map((sp) => {
    if (sp.name && sp.matchedBy !== "call") return sp; // manual / voice / name from the file stay
    const row = totals.get(sp.id);
    const ranked = row ? [...row.byUser.entries()].sort((a, b) => b[1] - a[1]) : [];
    const [best, second] = ranked;
    const clear =
      best && row.talk > 0 && best[1] / row.talk >= CALL_MATCH_SHARE && (!second || best[1] >= second[1] * CALL_MATCH_LEAD);
    if (!clear) return sp.matchedBy === "call" ? { ...sp, name: "", userId: null, email: "", matchedBy: "", matchScore: null } : sp;
    matched += 1;
    const person = personOf.get(best[0]);
    return {
      ...sp,
      name: person?.name || nameOf.get(best[0]) || sp.label,
      userId: best[0],
      email: person?.email || "",
      matchedBy: "call",
      matchScore: Math.round((best[1] / row.talk) * 100) / 100,
    };
  });
  return { speakers: out, matched };
};

// Attendees + organizer (name / email for the matched user id)
export const callPeople = (meeting) => [
  ...(meeting.attendees || []).map((a) => ({ userId: a.userId, name: a.name, email: a.email })),
  ...(meeting.createdBy?._id ? [{ userId: meeting.createdBy._id, name: meeting.createdBy.name, email: meeting.createdBy.email }] : []),
];
