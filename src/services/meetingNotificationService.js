import {
  createGoogleMeetEvent,
  updateGoogleMeetEvent,
  cancelGoogleMeetEvent,
  resetGoogleStatusCache,
} from "./googleCalendarService.js";
import { sendMeetingInvitation } from "./meetingEmailService.js";
import User from "../models/User.js";

// The creator's own email → they are a Google guest too, so they join with their own account
const creatorEmails = async (meeting) => {
  const id = meeting.createdBy?._id || meeting.createdBy;
  if (!id) return [];
  const user = await User.findById(id).select("email").lean();
  return user?.email ? [user.email] : [];
};

/**
 * Make sure the meeting has a REAL Google Meet link, then email the invitation.
 * A link without googleEventId was typed / randomly generated (old UI) and is replaced.
 * An existing event gets its guest list / time brought up to date (same link).
 * options.resend → send the invitation again even if it was sent before.
 */
export const createMeetAndSendInvitation = async (meeting, options = {}) => {
  let linkCreated = false;
  let googleWarning = null;
  const extra = await creatorEmails(meeting);

  if (meeting.googleMeetLink && meeting.googleEventId) {
    try {
      await updateGoogleMeetEvent(meeting, extra);
    } catch (err) {
      if (err.code === "GOOGLE_EVENT_MISSING") {
        // Deleted in Google Calendar → create a new event (and link) below
        meeting.googleEventId = "";
        meeting.googleMeetLink = "";
      } else {
        // Google unreachable: the existing link still works — email it, but say the guest list wasn't updated
        googleWarning = `Google guest list not updated: ${err.message}`;
      }
    }
  }

  if (!meeting.googleMeetLink || !meeting.googleEventId) {
    const event = await createGoogleMeetEvent(meeting, extra); // throws a clear GoogleConnectionError
    resetGoogleStatusCache();

    meeting.googleEventId = event.id;
    meeting.googleMeetLink = event.meetLink;
    linkCreated = true;

    // Save the link before attempting email delivery.
    await meeting.save();
  }

  let invitationSent = false;
  let emailWarning = null;

  if (!meeting.invitationSentAt || options.resend || linkCreated) {
    const result = await sendMeetingInvitation(meeting);

    if (result.sent) {
      meeting.invitationSentAt = new Date();
      invitationSent = true;
      if (result.failedCount) emailWarning = `${result.failedCount} invitation email(s) failed`;
    } else {
      emailWarning = result.reason || "Invitation email was not sent";
    }

    await meeting.save();
  }

  return {
    googleMeetLink: meeting.googleMeetLink,
    linkCreated,
    invitationSent,
    emailWarning: [emailWarning, googleWarning].filter(Boolean).join("; ") || null,
  };
};

/**
 * After a meeting is edited: update its Google event (guests, time, title) so newly added
 * attendees are invited and can join with their own account. Same Meet link.
 * Returns { synced, added, removed } — throws GoogleConnectionError on Google problems.
 */
export const syncGoogleMeetEvent = async (meeting) => {
  if (!meeting.googleEventId) return { synced: false, added: [], removed: [] };
  const result = await updateGoogleMeetEvent(meeting, await creatorEmails(meeting));
  return { synced: true, added: result.added, removed: result.removed };
};

/** Meeting deleted → cancel its Google event so the link stops being a live invitation. */
export const cancelMeetingEvent = (meeting) => cancelGoogleMeetEvent(meeting.googleEventId);
