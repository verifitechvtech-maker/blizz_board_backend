import "dotenv/config";
import nodemailer from "nodemailer";
import { telegramMeetingNotice } from "./telegram/telegramNotify.js";

const port = Number(process.env.SMTP_PORT || 587);
const timeZone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";

// Tests: nothing leaves the machine — messages are captured instead
const isTest = process.env.NODE_ENV === "test";
export const capturedMeetingEmails = [];

const transporter = isTest ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port,
  secure: port === 465,
  auth: {
    user: process.env.SMTP_USER?.trim(),
    pass: process.env.SMTP_PASS?.trim().replace(/\s+/g, ""),
  },
});

const BRAND = {
  name: "Task Management System",
  primary: "#17365D",
  accent: "#2563EB",
  background: "#F3F6FA",
  text: "#263445",
  muted: "#64748B",
};

const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const getRecipients = (meeting) => [
  ...new Set(
    (meeting.attendees || [])
      .map((attendee) => attendee.email?.trim().toLowerCase())
      .filter(Boolean)
  ),
];

// "14:30" → "2:30 PM"
const to12h = (hhmm) => {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

const minutesBetween = (a, b) => {
  const [ah, am] = String(a).split(":").map(Number);
  const [bh, bm] = String(b).split(":").map(Number);
  const d = bh * 60 + bm - (ah * 60 + am);
  return Number.isFinite(d) && d > 0 ? d : 0;
};

const durationText = (mins) =>
  !mins ? "" : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;

// Discussion points: new checklist (points) or the older free-text field
const getPoints = (meeting) => {
  const list = (meeting.points || [])
    .map((p) => ({ title: String(p.title || "").trim(), completed: Boolean(p.completed) }))
    .filter((p) => p.title);
  if (list.length) return list;
  return String(meeting.discussionPoints || "")
    .split(/\n+/)
    .map((t) => ({ title: t.replace(/^[-*•\d.)\s]+/, "").trim(), completed: false }))
    .filter((p) => p.title);
};

// Action plans: new (owners) or older actionItems
const getActions = (meeting) => {
  const list = (meeting.actions || []).map((a) => ({
    title: a.title,
    owners: (a.owners || []).map((o) => o.name).filter(Boolean).join(", ") || a.owner || "Unassigned",
    due: a.dueDate ? new Date(a.dueDate).toLocaleDateString("en-IN", { timeZone, dateStyle: "medium" }) : "",
    status: a.completed ? "Completed" : "Pending",
  }));
  if (list.length) return list;
  return (meeting.actionItems || []).map((a) => ({
    title: a.task || "Task",
    owners: a.assignedTo || "Unassigned",
    due: a.dueDate ? new Date(a.dueDate).toLocaleDateString("en-IN", { timeZone, dateStyle: "medium" }) : "",
    status: a.status || "Pending",
  }));
};

const getMeetingDetails = (meeting) => {
  const date = new Date(meeting.meetingDate);

  const dateText = Number.isNaN(date.getTime())
    ? String(meeting.meetingDate || "")
    : date.toLocaleDateString("en-IN", {
        timeZone,
        dateStyle: "full",
    });

  const start = to12h(meeting.startTime);
  const end = to12h(meeting.endTime);
  const mins = minutesBetween(meeting.startTime, meeting.endTime);

  return {
    title: meeting.title || "Meeting",
    dateText,
    time: start
      ? `${start}${end ? ` – ${end}` : ""}${mins ? ` (${durationText(mins)})` : ""}`
      : "Time not set",
    attendees: (meeting.attendees || []).map((a) => a.name || a.email).filter(Boolean),
    departments: (meeting.departments || []).filter(Boolean),
    points: getPoints(meeting),
    actions: getActions(meeting),
    // built-in video call link (older meetings: their Google Meet link)
    link: meeting.videoLink || meeting.googleMeetLink || "",
    linkLabel: meeting.videoLink ? "Video call" : "Google Meet",
    agenda: meeting.agenda || "",
    location: meeting.location || "",
    meetingType: meeting.meetingType || "Online",
  };
};

const emailLayout = (heading, subtitle, content) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.background};
  font-family:Arial,Helvetica,sans-serif;color:${BRAND.text};">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
    style="background:${BRAND.background};padding:30px 12px;">
    <tr>
      <td align="center">

        <table role="presentation" width="600" cellspacing="0"
          cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;
          border-radius:12px;overflow:hidden;">

          <tr>
            <td style="background:${BRAND.primary};padding:28px 30px;">
              <p style="margin:0 0 12px;color:#BFDBFE;font-size:12px;
                font-weight:bold;letter-spacing:1.5px;">
                ${escapeHtml(BRAND.name.toUpperCase())}
              </p>
              <h1 style="margin:0;color:#ffffff;font-size:25px;
                line-height:1.35;">${escapeHtml(heading)}</h1>
              <p style="margin:10px 0 0;color:#DBEAFE;font-size:14px;
                line-height:1.7;">${escapeHtml(subtitle)}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 30px;">
              ${content}
            </td>
          </tr>

          <tr>
            <td style="padding:20px 30px;background:#F8FAFC;
              border-top:1px solid #E2E8F0;">
              <p style="margin:0;color:${BRAND.muted};font-size:12px;
                line-height:1.7;">
                This email was sent by ${escapeHtml(BRAND.name)}.
                Please contact your meeting organizer if you have questions.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

const detailRow = (label, value) => `
  <tr>
    <td style="padding:12px 14px;border-bottom:1px solid #E8EDF4;
      color:${BRAND.muted};font-size:13px;width:115px;vertical-align:top;">
      ${escapeHtml(label)}
    </td>
    <td style="padding:12px 14px;border-bottom:1px solid #E8EDF4;
      color:${BRAND.text};font-size:14px;font-weight:600;
      line-height:1.6;vertical-align:top;">
      ${escapeHtml(value || "Not specified")}
    </td>
  </tr>`;

const meetingCard = (details) => `
  <h2 style="margin:0 0 16px;font-size:20px;line-height:1.4;">
    ${escapeHtml(details.title)}
  </h2>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
    style="border:1px solid #E2E8F0;border-radius:8px;
    border-collapse:separate;overflow:hidden;">
    ${detailRow("Date", details.dateText)}
    ${detailRow("Time", `${details.time} (${timeZone})`)}
    ${detailRow("Meeting type", details.meetingType)}
    ${details.departments?.length ? detailRow("Departments", details.departments.join(", ")) : ""}
    ${details.attendees?.length ? detailRow("Attendees", details.attendees.join(", ")) : ""}
    ${
      details.location
        ? detailRow("Location", details.location)
        : ""
    }
  </table>`;

const agendaSection = (agenda) => `
  <div style="margin-top:24px;">
    <h3 style="margin:0 0 8px;font-size:15px;">Meeting agenda</h3>
    <div style="padding:14px 16px;background:#F8FAFC;
      border-left:3px solid ${BRAND.accent};border-radius:4px;
      font-size:14px;line-height:1.8;white-space:pre-wrap;">
      ${escapeHtml(agenda || "No agenda provided.")}
    </div>
  </div>`;

const pointsSection = (points, heading = "Discussion points") => `
  <div style="margin-top:24px;">
    <h3 style="margin:0 0 10px;font-size:15px;">${escapeHtml(heading)}</h3>
    ${
      points.length
        ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
            style="border-collapse:collapse;">
            ${points.map((p, i) => `
              <tr>
                <td style="width:30px;padding:8px 0;vertical-align:top;">
                  <span style="display:inline-block;width:22px;height:22px;line-height:22px;
                    text-align:center;border-radius:50%;background:#EFF6FF;color:${BRAND.accent};
                    font-size:12px;font-weight:bold;">${i + 1}</span>
                </td>
                <td style="padding:8px 0;font-size:14px;line-height:1.6;border-bottom:1px solid #EEF2F7;">
                  ${escapeHtml(p.title)}${p.completed ? ` <span style="color:#16A34A;font-size:12px;font-weight:bold;">✓ done</span>` : ""}
                </td>
              </tr>`).join("")}
          </table>`
        : `<p style="margin:0;font-size:13px;color:${BRAND.muted};">No discussion points added yet.</p>`
    }
  </div>`;

const actionsSection = (actions) => !actions.length ? "" : `
  <div style="margin-top:24px;">
    <h3 style="margin:0 0 10px;font-size:15px;">Action plans</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
      style="border-collapse:collapse;border:1px solid #E2E8F0;">
      <tr style="background:#F1F5F9;">
        <th align="left" style="padding:9px;font-size:12px;">Action</th>
        <th align="left" style="padding:9px;font-size:12px;">Owner(s)</th>
        <th align="left" style="padding:9px;font-size:12px;">Due</th>
        <th align="left" style="padding:9px;font-size:12px;">Status</th>
      </tr>
      ${actions.map((a) => `
        <tr>
          <td style="padding:9px;border-top:1px solid #E2E8F0;font-size:13px;line-height:1.5;">${escapeHtml(a.title)}</td>
          <td style="padding:9px;border-top:1px solid #E2E8F0;font-size:13px;">${escapeHtml(a.owners)}</td>
          <td style="padding:9px;border-top:1px solid #E2E8F0;font-size:13px;">${escapeHtml(a.due || "—")}</td>
          <td style="padding:9px;border-top:1px solid #E2E8F0;font-size:13px;">${escapeHtml(a.status)}</td>
        </tr>`).join("")}
    </table>
  </div>`;

const textPoints = (points) =>
  points.length ? points.map((p, i) => `${i + 1}. ${p.title}${p.completed ? " (done)" : ""}`).join("\n") : "No discussion points added yet.";

const textActions = (actions) =>
  actions.map((a, i) => `${i + 1}. ${a.title} — Owner(s): ${a.owners}${a.due ? ` — Due: ${a.due}` : ""} — ${a.status}`).join("\n");

const JOIN_EARLY = Number(process.env.MEETING_JOIN_EARLY_MINUTES || 15);
const JOIN_LATE = Number(process.env.MEETING_JOIN_LATE_MINUTES || 30);

const joinButton = (link, label = "Video call") => link ? `
  <table role="presentation" cellspacing="0" cellpadding="0"
    style="margin:24px 0;">
    <tr>
      <td align="center" bgcolor="${BRAND.accent}"
        style="border-radius:7px;">
        <a href="${escapeHtml(link)}"
          style="display:inline-block;padding:14px 25px;color:#ffffff;
          font-size:14px;font-weight:bold;text-decoration:none;
          border-radius:7px;">
          Join ${label === "Google Meet" ? "Google Meet" : "video call"} &rarr;
        </a>
      </td>
    </tr>
  </table>
  ${label === "Google Meet" ? "" : `<p style="font-size:12px;color:${BRAND.muted};line-height:1.7;margin:-10px 0 10px;">
    The link opens ${JOIN_EARLY} minutes before the start and works until ${JOIN_LATE} minutes after the end.
    Sign in with this email's account to join.
  </p>`}
  <p style="font-size:12px;color:${BRAND.muted};line-height:1.7;">
    If the button does not work, copy and paste this link into your browser:<br>
    <a href="${escapeHtml(link)}" style="color:${BRAND.accent};
      word-break:break-all;">${escapeHtml(link)}</a>
  </p>` : `
  <p style="margin-top:20px;padding:14px;background:#FFF7ED;
    color:#9A3412;border-radius:6px;font-size:13px;">
    The meeting link is not available yet. Please contact the organizer.
  </p>`;

const sendToAttendees = async (meeting, subject, text, html, onlyEmails = null) => {
  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim().replace(/\s+/g, "");

  if (!isTest && (!smtpUser || !smtpPass)) {
    return {
      sent: false,
      sentCount: 0,
      failedCount: 0,
      reason: "Gmail SMTP credentials are missing from .env",
    };
  }

  const only = Array.isArray(onlyEmails) && onlyEmails.length ? new Set(onlyEmails.map((e) => String(e).toLowerCase())) : null;
  const recipients = getRecipients(meeting).filter((email) => !only || only.has(email));

  if (!recipients.length) {
    return {
      sent: false,
      sentCount: 0,
      failedCount: 0,
      reason: "No attendee email addresses were provided",
    };
  }

  const results = await Promise.allSettled(
    recipients.map(async (email) => {
      const info = await transporter.sendMail({
        from: `"${BRAND.name}" <${smtpUser || "no-reply@Blizzboard.local"}>`,
        to: email,
        subject,
        text,
        html,
      });
      if (isTest) capturedMeetingEmails.push({ to: email, subject, text, html });

      console.log(
        `Email accepted by SMTP for ${email}: ${info.messageId}`
      );

      return info;
    })
  );

  let sentCount = 0;
  let failedCount = 0;

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sentCount += 1;
    } else {
      failedCount += 1;
      console.error("Attendee email delivery failed:", {
        recipient: recipients[index],
        code: result.reason?.code,
        responseCode: result.reason?.responseCode,
        message: result.reason?.message,
      });
    }
  });

  return {
    sent: failedCount === 0 && sentCount > 0,
    sentCount,
    failedCount,
    reason: failedCount
      ? "One or more attendee emails failed; check backend logs"
      : undefined,
  };
};

export const sendMeetingInvitation = async (meeting, options = {}) => {
  const details = getMeetingDetails(meeting);
  // same invitation on Telegram for attendees who connected the bot
  telegramMeetingNotice(meeting, options.updated ? "updated" : "invite", { onlyEmails: options.onlyEmails })
    .catch((err) => console.error("[telegram]", err.message));
  // updated = date / time changed → everyone gets the new details (same link)
  const subject = `${options.updated ? "Meeting Updated" : "Meeting Invitation"}: ${details.title}`;

  const text = [
    `You are invited to: ${details.title}`,
    `Date: ${details.dateText}`,
    `Time: ${details.time} (${timeZone})`,
    `Type: ${details.meetingType}`,
    details.attendees.length ? `Attendees: ${details.attendees.join(", ")}` : "",
    `${details.linkLabel}: ${details.link || "Not available"}`,
    `\nDiscussion points:\n${textPoints(details.points)}`,
    details.actions.length ? `\nAction plans:\n${textActions(details.actions)}` : "",
    details.agenda ? `\nAgenda: ${details.agenda}` : "",
  ].filter(Boolean).join("\n");

  const content = `
    <p style="margin:0 0 20px;font-size:14px;line-height:1.8;">
      Hello,
    </p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.8;">
      You are invited to attend the following meeting. Please review
      the details below and join at the scheduled time.
    </p>
    ${meetingCard(details)}
    ${joinButton(details.link, details.linkLabel)}
    ${pointsSection(details.points, "Discussion points")}
    ${actionsSection(details.actions)}
    ${details.agenda ? agendaSection(details.agenda) : ""}
    <p style="margin-top:24px;font-size:14px;line-height:1.8;">
      We look forward to your participation.
    </p>`;

  return sendToAttendees(
    meeting,
    subject,
    text,
    emailLayout(
      options.updated ? "Your meeting was updated" : "You're invited to a meeting",
      "Meeting details and joining information",
      content
    ),
    options.onlyEmails
  );
};

// options.auto = the reminder job (it sends Telegram itself, once per start time)
export const sendMeetingReminder = async (meeting, options = {}) => {
  const details = getMeetingDetails(meeting);
  if (!options.auto) telegramMeetingNotice(meeting, "reminder").catch((err) => console.error("[telegram]", err.message));
  const subject = `Meeting Reminder: ${details.title}`;

  const text = [
    `Reminder: ${details.title} starts soon.`,
    `Date: ${details.dateText}`,
    `Time: ${details.time} (${timeZone})`,
    `${details.linkLabel}: ${details.link || "Not available"}`,
    `\nDiscussion points:\n${textPoints(details.points)}`,
  ].join("\n");

  const content = `
    <p style="margin:0 0 20px;font-size:14px;line-height:1.8;">
      Hello,
    </p>
    <p style="margin:0 0 22px;padding:15px;background:#EFF6FF;
      border-left:3px solid ${BRAND.accent};border-radius:5px;
      font-size:14px;line-height:1.8;">
      This is a friendly reminder that your meeting is coming up.
      Please be ready to join on time.
    </p>
    ${meetingCard(details)}
    ${joinButton(details.link, details.linkLabel)}
    ${pointsSection(details.points, "Discussion points")}`;

  return sendToAttendees(
    meeting,
    subject,
    text,
    emailLayout(
      "Your meeting starts soon",
      "A friendly reminder about your upcoming meeting",
      content
    )
  );
};

export const sendMomEmail = async (meeting) => {
  const details = getMeetingDetails(meeting);
  telegramMeetingNotice(meeting, "mom").catch((err) => console.error("[telegram]", err.message));
  const decisions = meeting.decisions || "";
  const subject = `Minutes of Meeting: ${details.title}`;

  const text = [
    `Minutes of Meeting: ${details.title}`,
    `Date: ${details.dateText}`,
    `Time: ${details.time} (${timeZone})`,
    details.attendees.length ? `Attendees: ${details.attendees.join(", ")}` : "",
    details.agenda ? `Agenda: ${details.agenda}` : "",
    `Discussion points:\n${textPoints(details.points)}`,
    decisions ? `Decisions:\n${decisions}` : "",
    `Action plans:\n${details.actions.length ? textActions(details.actions) : "No action plans recorded."}`,
    `${details.linkLabel}: ${details.link || "Not available"}`,
  ].filter(Boolean).join("\n\n");

  const content = `
    ${meetingCard(details)}
    ${details.agenda ? agendaSection(details.agenda) : ""}
    ${pointsSection(details.points, "Discussion points")}
    ${decisions ? `
    <div style="margin-top:24px;">
      <h3 style="margin:0 0 10px;font-size:16px;">Decisions made</h3>
      <div style="padding:14px;background:#F0FDF4;border-left:3px solid #16A34A;
        border-radius:4px;font-size:14px;line-height:1.8;white-space:pre-wrap;">
        ${escapeHtml(decisions)}
      </div>
    </div>` : ""}
    ${details.actions.length ? actionsSection(details.actions) : `
    <p style="margin-top:20px;font-size:13px;color:${BRAND.muted};">No action plans recorded.</p>`}
    ${joinButton(details.link, details.linkLabel)}`;

  return sendToAttendees(
    meeting,
    subject,
    text,
    emailLayout(
      "Minutes of Meeting",
      "Meeting summary, decisions, and next steps",
      content
    )
  );
};
