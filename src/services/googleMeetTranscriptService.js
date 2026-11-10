// Pulls a finished meeting's transcript (and recording link) from the Google Meet REST API.
// Google only creates these for Google Workspace organizers who turned on
// Transcripts / Recording inside the Meet call. Personal Gmail accounts get none.
import { google } from "googleapis";

export class MeetTranscriptError extends Error {
  constructor(message, status = 400, code = "MEET_TRANSCRIPT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const meetingCodeFromLink = (link) =>
  String(link || "").match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1]?.toLowerCase() || null;

const getMeet = () => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new MeetTranscriptError("Google is not connected on the server (credentials missing in .env).", 503, "GOOGLE_NOT_CONNECTED");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.meet({ version: "v2", auth });
};

const explainGoogleError = (err) => {
  const status = err?.response?.status || err?.code;
  const reason = JSON.stringify(err?.response?.data || err?.message || "");
  if (status === 403 && /scope|insufficient/i.test(reason)) {
    return new MeetTranscriptError(
      'The connected Google account has not allowed Meet access yet. Re-run "npm run google:token" on the server and update GOOGLE_REFRESH_TOKEN.',
      403,
      "GOOGLE_SCOPE_MISSING"
    );
  }
  if (status === 403) {
    return new MeetTranscriptError(
      "Google refused access to this meeting's records. Only the organizer's Google account can read them.",
      403,
      "GOOGLE_FORBIDDEN"
    );
  }
  return new MeetTranscriptError(`Google Meet API error: ${err?.message || "unknown error"}`, 502, "GOOGLE_ERROR");
};

/**
 * @param {string} meetLink  https://meet.google.com/abc-defg-hij
 * @param {object} meetClient optional (tests inject a fake)
 * @returns {{ entries: Array, recordingUrl: string }}
 */
export const fetchGoogleMeetTranscript = async (meetLink, meetClient) => {
  const code = meetingCodeFromLink(meetLink);
  if (!code) throw new MeetTranscriptError("This meeting has no Google Meet link.", 400, "NO_MEET_LINK");

  const meet = meetClient || getMeet();
  try {
    const records = (await meet.conferenceRecords.list({ filter: `space.meeting_code = "${code}"` })).data
      .conferenceRecords || [];
    if (!records.length) {
      throw new MeetTranscriptError(
        "Google has no record of this call yet. Transcripts appear a few minutes after the meeting ends, and only for Google Workspace accounts with transcription turned on in Meet.",
        404,
        "NO_CONFERENCE"
      );
    }

    const entries = [];
    let recordingUrl = "";
    const names = new Map();

    const speakerName = async (participant) => {
      if (!participant) return "Speaker";
      if (names.has(participant)) return names.get(participant);
      let name = "Speaker";
      try {
        const p = (await meet.conferenceRecords.participants.get({ name: participant })).data;
        name = p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || "Speaker";
      } catch {
        /* keep generic name */
      }
      names.set(participant, name);
      return name;
    };

    // Oldest call first (a meeting link can be reused)
    for (const record of [...records].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))) {
      const recs = (await meet.conferenceRecords.recordings.list({ parent: record.name })).data.recordings || [];
      const done = recs.find((r) => r.driveDestination?.exportUri);
      if (done) recordingUrl = done.driveDestination.exportUri;

      const transcripts = (await meet.conferenceRecords.transcripts.list({ parent: record.name })).data.transcripts || [];
      for (const t of transcripts) {
        let pageToken;
        do {
          const page = (await meet.conferenceRecords.transcripts.entries.list({ parent: t.name, pageSize: 100, pageToken })).data;
          for (const e of page.transcriptEntries || []) {
            if (!e.text) continue;
            entries.push({ speaker: await speakerName(e.participant), text: e.text, at: e.startTime ? new Date(e.startTime) : null });
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
    }

    if (!entries.length && !recordingUrl) {
      throw new MeetTranscriptError(
        "The call was found, but Google created no transcript. Turn on Activities → Transcripts during the meeting (requires a Google Workspace account).",
        404,
        "NO_TRANSCRIPT"
      );
    }
    entries.sort((a, b) => (a.at && b.at ? a.at - b.at : 0));
    return { entries, recordingUrl };
  } catch (err) {
    if (err instanceof MeetTranscriptError) throw err;
    throw explainGoogleError(err);
  }
};
