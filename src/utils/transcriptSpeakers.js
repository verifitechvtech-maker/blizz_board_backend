// Keeps transcript.speakers and the lines' speaker names in step.
// Every line gets a speakerId; a speaker's display name is its assigned attendee name,
// otherwise its label ("Speaker 1", or the name Google / the imported file gave).
// A label is linked to an attendee automatically only when it IS that attendee's name
// (e.g. Google Meet transcripts) — voices are never matched to people.

const norm = (s) => String(s || "").trim().toLowerCase();

export const speakerDisplayName = (sp) => (sp?.name || sp?.label || "Speaker").slice(0, 80);

const nextId = (speakers) => {
  const max = speakers.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/^S/, "")) || 0), 0);
  return `S${max + 1}`;
};

const linkByName = (speaker, attendees) => {
  if (speaker.name || !speaker.label) return speaker;
  const a = (attendees || []).find((x) => norm(x.name) && norm(x.name) === norm(speaker.label));
  return a ? { ...speaker, name: a.name, userId: a.userId || null, email: a.email || "", matchedBy: "name" } : speaker;
};

/**
 * Give every entry a speakerId, (re)build the speaker list and write display names onto the entries.
 * @param {object[]} entries transcript lines (plain objects)
 * @param {object[]} existing current transcript.speakers (kept: assignments survive appends)
 * @param {object[]} attendees meeting.attendees
 */
export const buildSpeakers = (entries, existing = [], attendees = []) => {
  const speakers = (existing || []).map((s) => ({
    id: s.id, label: s.label || "", name: s.name || "", userId: s.userId || null, email: s.email || "",
    matchedBy: s.matchedBy || "", matchScore: s.matchScore ?? null,
  }));
  const byId = new Map(speakers.map((s) => [s.id, s]));

  const out = entries.map((e) => {
    let sp = e.speakerId ? byId.get(e.speakerId) : null;
    if (!sp) {
      const label = String(e.speaker || "Speaker").trim().slice(0, 80) || "Speaker";
      sp = speakers.find((s) => norm(s.label) === norm(label) || (s.name && norm(s.name) === norm(label)));
      if (!sp) {
        sp = { id: e.speakerId && !byId.has(e.speakerId) ? e.speakerId : nextId(speakers), label, name: "", userId: null, email: "" };
        speakers.push(sp);
        byId.set(sp.id, sp);
      }
    }
    return { ...e, speakerId: sp.id };
  });

  const used = new Set(out.map((e) => e.speakerId));
  const finalSpeakers = speakers.filter((s) => used.has(s.id)).map((s) => linkByName(s, attendees));
  return { entries: applySpeakers(out, finalSpeakers), speakers: finalSpeakers };
};

/**
 * For API responses: a plain meeting object whose transcript lines carry the CURRENT name of
 * their speaker (looked up by speakerId in transcript.speakers), so a saved assignment always
 * wins over whatever label is stored on the line. Voice data is removed.
 */
export const withSpeakerNames = (meeting) => {
  const t = meeting?.transcript;
  if (!t) return meeting;
  const { voiceprints, ...rest } = t; // voice data stays on the server
  if (!rest.entries?.length || !rest.speakers?.length) return { ...meeting, transcript: rest };
  return { ...meeting, transcript: { ...rest, entries: applySpeakers(rest.entries, rest.speakers) } };
};

/** Write each speaker's display name onto its lines. */
export const applySpeakers = (entries, speakers) => {
  const byId = new Map((speakers || []).map((s) => [s.id, s]));
  return entries.map((e) => (byId.has(e.speakerId) ? { ...e, speaker: speakerDisplayName(byId.get(e.speakerId)) } : e));
};
