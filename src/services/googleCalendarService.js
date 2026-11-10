import { google } from "googleapis";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

const timeZone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";

// Clear, user-facing reason when Google can't be used
export class GoogleConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.status = 503;
    this.code = code;
  }
}

export const explainGoogleCalendarError = (err) => {
  if (err instanceof GoogleConnectionError) return err;
  const data = err?.response?.data || {};
  const reason = `${data.error || ""} ${data.error_description || ""} ${err?.message || ""}`;
  if (/invalid_grant|expired or revoked/i.test(reason)) {
    return new GoogleConnectionError(
      "The Google connection has expired, so no Google Meet link could be created. An administrator must reconnect Google (run \"npm run google:token\" in the backend folder).",
      "GOOGLE_RECONNECT"
    );
  }
  if (/invalid_client|unauthorized_client/i.test(reason)) {
    return new GoogleConnectionError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env are not valid.", "GOOGLE_CLIENT_INVALID");
  }
  if (/insufficient|scope/i.test(reason) || err?.response?.status === 403) {
    return new GoogleConnectionError(
      "The connected Google account did not allow Calendar access. Reconnect Google (npm run google:token).",
      "GOOGLE_SCOPE"
    );
  }
  return new GoogleConnectionError(`Google Calendar error: ${err?.message || "unknown error"}`, "GOOGLE_ERROR");
};

const getCalendar = () => {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_REFRESH_TOKEN
  ) {
    throw new GoogleConnectionError(
      "Google is not connected (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing in .env).",
      "GOOGLE_NOT_CONNECTED"
    );
  }

  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });

  return google.calendar({
    version: "v3",
    auth,
  });
};

export const getMeetingStartDate = (meeting) => {
  const date = new Date(meeting.meetingDate);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid meeting date");
  }

  const dateString = date.toISOString().slice(0, 10);
  const startTime = meeting.startTime || "09:00";

  const start = DateTime.fromISO(
    `${dateString}T${startTime}`,
    { zone: timeZone }
  );

  if (!start.isValid) {
    throw new Error("Invalid meeting start time");
  }

  return start;
};

export const createGoogleMeetEvent = async (meeting, extraEmails = []) => {
  try {
    return await createGoogleMeetEventRaw(meeting, extraEmails);
  } catch (err) {
    throw explainGoogleCalendarError(err);
  }
};

// Cheap health check (no event is created): can we get an access token + read the calendar?
let statusCache = { at: 0, value: null };
export const checkGoogleConnection = async () => {
  if (statusCache.value && Date.now() - statusCache.at < 2 * 60 * 1000) return statusCache.value;
  let value;
  try {
    const calendar = getCalendar();
    // Allowed by the calendar.events scope the app requests (calendarList is not)
    await calendar.events.list({ calendarId: "primary", maxResults: 1 });
    value = { ok: true };
  } catch (err) {
    const e = explainGoogleCalendarError(err);
    value = { ok: false, code: e.code, message: e.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
};
export const resetGoogleStatusCache = () => {
  statusCache = { at: 0, value: null };
};

// Who Google emails about the event: "all" (default) sends Google Calendar invitations /
// updates / cancellations to every guest; "externalOnly" or "none" via GOOGLE_SEND_UPDATES.
const sendUpdates = () =>
  ["all", "externalOnly", "none"].includes(process.env.GOOGLE_SEND_UPDATES) ? process.env.GOOGLE_SEND_UPDATES : "all";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/i;

/** Valid, de-duplicated guest emails: the meeting's attendees + extra people (the creator). */
export const guestEmails = (meeting, extraEmails = []) => [
  ...new Set(
    [...(meeting.attendees || []).map((a) => a?.email), ...extraEmails]
      .map((email) => String(email || "").trim().toLowerCase())
      .filter((email) => EMAIL.test(email))
  ),
];

const eventTimes = (meeting) => {
  const start = getMeetingStartDate(meeting);
  const end = meeting.endTime
    ? DateTime.fromISO(`${start.toISODate()}T${meeting.endTime}`, { zone: timeZone })
    : start.plus({ hours: 1 });
  if (!end.isValid || end <= start) {
    throw new Error("Meeting end time must be after start time");
  }
  return {
    start: { dateTime: start.toISO(), timeZone },
    end: { dateTime: end.toISO(), timeZone },
  };
};

const meetLinkOf = (event) => {
  const link =
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri ||
    "";
  return MEET_LINK.test(link) ? link : "";
};

const isGone = (err) => [404, 410].includes(err?.response?.status || err?.code);

const createGoogleMeetEventRaw = async (meeting, extraEmails) => {
  const calendar = getCalendar();

  const response = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: sendUpdates(),
    requestBody: {
      summary: meeting.title,
      description: meeting.agenda || "",
      ...eventTimes(meeting),
      // Every invited person is a guest of the event → they join the Meet with their OWN
      // Google account (the one with this email) without waiting to be admitted.
      attendees: guestEmails(meeting, extraEmails).map((email) => ({ email })),
      guestsCanSeeOtherGuests: true,
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: {
            type: "hangoutsMeet",
          },
        },
      },
    },
  });

  let event = response.data;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const meetLink = meetLinkOf(event);
    if (meetLink) {
      return { id: event.id, meetLink };
    }
    if (event.conferenceData?.createRequest?.status?.statusCode === "failure") break;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const refreshed = await calendar.events.get({
      calendarId: "primary",
      eventId: event.id,
    });

    event = refreshed.data;
  }

  // No usable link → remove the half-made event (guests must not get an invitation without a link)
  await calendar.events.delete({ calendarId: "primary", eventId: event.id, sendUpdates: "none" }).catch(() => {});
  throw new GoogleConnectionError(
    "Google Calendar could not create a Google Meet conference for this meeting. Check that Google Meet is enabled for the connected Google account, then try “Send invitation” again.",
    "GOOGLE_MEET_FAILED"
  );
};

/**
 * Bring the existing Google event in line with the meeting: title, agenda, time and the
 * guest list (new attendees are invited, removed ones are taken off). Keeps the same Meet link.
 * Throws code GOOGLE_EVENT_MISSING when the event was deleted in Google.
 */
export const updateGoogleMeetEvent = async (meeting, extraEmails = []) => {
  try {
    const calendar = getCalendar();
    let current;
    try {
      current = (await calendar.events.get({ calendarId: "primary", eventId: meeting.googleEventId })).data;
    } catch (err) {
      if (isGone(err)) throw new GoogleConnectionError("The Google Calendar event no longer exists.", "GOOGLE_EVENT_MISSING");
      throw err;
    }
    if (current.status === "cancelled") {
      throw new GoogleConnectionError("The Google Calendar event was cancelled.", "GOOGLE_EVENT_MISSING");
    }

    // Keep each remaining guest's RSVP; add new guests; drop people no longer invited
    const wanted = guestEmails(meeting, extraEmails);
    const existing = new Map((current.attendees || []).map((a) => [String(a.email || "").toLowerCase(), a]));
    const attendees = wanted.map((email) => existing.get(email) || { email });
    // The organizer (connected Google account) stays on the event if Google listed it
    for (const a of current.attendees || []) {
      if (a.organizer && !wanted.includes(String(a.email).toLowerCase())) attendees.push(a);
    }

    const updated = (
      await calendar.events.patch({
        calendarId: "primary",
        eventId: meeting.googleEventId,
        sendUpdates: sendUpdates(),
        requestBody: {
          summary: meeting.title,
          description: meeting.agenda || "",
          ...eventTimes(meeting),
          attendees,
          guestsCanSeeOtherGuests: true,
          guestsCanInviteOthers: false,
          guestsCanModify: false,
        },
      })
    ).data;

    const added = wanted.filter((email) => !existing.has(email));
    const removed = [...existing.keys()].filter((email) => !wanted.includes(email) && !existing.get(email).organizer);
    return { id: updated.id, meetLink: meetLinkOf(updated) || meeting.googleMeetLink, added, removed };
  } catch (err) {
    throw explainGoogleCalendarError(err);
  }
};

/** Cancel the Google event (guests get Google's cancellation). Already-deleted events are fine. */
export const cancelGoogleMeetEvent = async (eventId) => {
  if (!eventId) return;
  try {
    await getCalendar().events.delete({ calendarId: "primary", eventId, sendUpdates: sendUpdates() });
  } catch (err) {
    if (isGone(err)) return;
    throw explainGoogleCalendarError(err);
  }
};
