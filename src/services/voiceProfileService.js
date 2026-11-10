// Names transcript speakers from voice profiles. Only the meeting's own attendees (and its
// organizer) are considered, only people who recorded a voice profile themselves, and only
// confident matches are used. Names a user chose by hand are never replaced.
import User from "../models/User.js";
import { matchVoices } from "../utils/voiceMatch.js";

export const VOICE_MATCH_THRESHOLD = () => Number(process.env.VOICE_MATCH_THRESHOLD) || 0.55;

// Attendees with an app account + the organizer → [{ key, name, email, userId, embedding }]
const candidateProfiles = async (meeting) => {
  const people = new Map();
  for (const a of meeting.attendees || []) {
    if (a.userId) people.set(String(a.userId), { name: a.name, email: a.email || "" });
  }
  if (meeting.createdBy) {
    const id = String(meeting.createdBy._id || meeting.createdBy);
    if (!people.has(id)) people.set(id, null); // name taken from the user record below
  }
  if (!people.size) return [];

  const users = await User.find({ _id: { $in: [...people.keys()] }, "voiceProfile.updatedAt": { $ne: null } })
    .select("name email +voiceProfile.embedding")
    .lean();
  return users
    .filter((u) => u.voiceProfile?.embedding?.length)
    .map((u) => {
      const attendee = people.get(String(u._id));
      return {
        key: String(u._id),
        userId: u._id,
        name: attendee?.name || u.name,
        email: attendee?.email || u.email || "",
        embedding: u.voiceProfile.embedding,
      };
    });
};

/**
 * @param {object[]} speakers transcript.speakers (plain)
 * @param {{ id: string, embedding: number[] }[]} voiceprints transcript.voiceprints
 * @param {object} meeting needs attendees + createdBy
 * @returns {Promise<{ speakers: object[], matched: number, profiles: number }>}
 */
export const nameSpeakersByVoice = async (speakers, voiceprints, meeting) => {
  const profiles = await candidateProfiles(meeting);
  // Speakers a user named by hand (or that already carry a real name) are left alone
  const open = new Set(speakers.filter((s) => !s.name || s.matchedBy === "voice").map((s) => s.id));
  const matches = matchVoices((voiceprints || []).filter((v) => open.has(v.id)), profiles, { threshold: VOICE_MATCH_THRESHOLD() });
  const byKey = new Map(profiles.map((p) => [p.key, p]));
  const bySpeaker = new Map(matches.map((m) => [m.speakerId, m]));

  const next = speakers.map((s) => {
    if (!open.has(s.id)) return s;
    const m = bySpeaker.get(s.id);
    if (!m) return s.matchedBy === "voice" ? { ...s, name: "", userId: null, email: "", matchedBy: "", matchScore: null } : s;
    const p = byKey.get(m.key);
    return { ...s, name: p.name, userId: p.userId, email: p.email, matchedBy: "voice", matchScore: Math.round(m.score * 100) / 100 };
  });
  return { speakers: next, matched: matches.length, profiles: profiles.length };
};
