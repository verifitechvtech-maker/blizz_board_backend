import TelegramLink from "../../models/TelegramLink.js";
import User from "../../models/User.js";
import { esc, sendMessage, telegramEnabled } from "./telegramApi.js";

const ICONS = {
  task_assigned: "🆕",
  task_reassigned: "🔀",
  task_reminder: "⏰",
  task_overdue: "🚨",
  task_status: "🔄",
  task_completed: "🏆",
  task_rework: "🔁",
  task_comment: "💬",
  task_subtask: "🧩",
  task_viewed: "👀",
  support_ticket: "🎫",
  support_reply: "💬",
};

// Every in-app notification (Notification post-save) is also sent to the recipient's Telegram
export const telegramNotificationDoc = async (doc) => {
  if (!telegramEnabled() || !doc?.recipient) return;
  const link = await TelegramLink.findOne({ user: doc.recipient }).lean();
  if (!link) return;
  // Settings → "Telegram notifications" off → nothing sent
  const user = await User.findById(doc.recipient).select("status preferences").lean();
  if (!user || user.status === "Inactive" || user.preferences?.telegramNotifications === false) return;

  const text = `${ICONS[doc.type] || "🔔"} ${esc(doc.message || doc.taskName || "New notification")}`;
  const extra = doc.task
    ? { reply_markup: { inline_keyboard: [[{ text: "📄 Open task", callback_data: `t:${doc.task}` }]] } }
    : {};
  try {
    await sendMessage(link.chatId, text, extra);
  } catch (err) {
    // 403 = the user blocked / deleted the bot → forget the link
    if (err.code === 403) await TelegramLink.deleteOne({ _id: link._id }).catch(() => {});
    else throw err;
  }
};

/* ---------- meetings (MoM) — sent alongside the invitation / reminder / MoM emails ---------- */
const MEETING_HEADINGS = {
  invite: "📅 <b>Meeting invitation</b>",
  updated: "📅 <b>Meeting updated</b>",
  reminder: "⏰ <b>Meeting starts soon</b>",
  mom: "📝 <b>Minutes of Meeting</b>",
};

// Attendees with an app account (by id or email), optionally only some emails; the organizer
// gets reminders too but not their own invitation / MoM
const meetingRecipients = async (meeting, kind, onlyEmails) => {
  const only = Array.isArray(onlyEmails) && onlyEmails.length ? new Set(onlyEmails.map((e) => String(e).toLowerCase())) : null;
  const attendees = (meeting.attendees || []).filter((a) => !only || only.has(String(a.email || "").toLowerCase()));
  const ids = attendees.map((a) => a.userId).filter(Boolean).map(String);
  const emails = attendees.filter((a) => !a.userId && a.email).map((a) => String(a.email).toLowerCase());
  const byEmail = emails.length ? await User.find({ email: { $in: emails } }).select("_id").lean() : [];
  const all = new Set([...ids, ...byEmail.map((u) => String(u._id))]);
  const creator = String(meeting.createdBy?._id || meeting.createdBy || "");
  if (kind === "reminder" && creator && !only) all.add(creator);
  else all.delete(creator);
  return [...all];
};

export const telegramMeetingNotice = async (meeting, kind, { onlyEmails } = {}) => {
  if (!telegramEnabled() || !meeting) return;
  const userIds = await meetingRecipients(meeting, kind, onlyEmails);
  if (!userIds.length) return;
  const links = await TelegramLink.find({ user: { $in: userIds } }).lean();
  if (!links.length) return;
  const muted = new Set(
    (await User.find({ _id: { $in: links.map((l) => l.user) }, $or: [{ status: "Inactive" }, { "preferences.telegramNotifications": false }] }).distinct("_id")).map(String)
  );

  const day = meeting.meetingDate ? new Date(meeting.meetingDate).toISOString().slice(0, 10) : "";
  const time = meeting.startTime ? ` · ${meeting.startTime}${meeting.endTime ? `–${meeting.endTime}` : ""}` : "";
  const link = meeting.videoLink || meeting.googleMeetLink || "";
  const lines = [
    MEETING_HEADINGS[kind] || "📅 <b>Meeting</b>",
    "",
    `<b>${esc(meeting.title)}</b>`,
    `📅 ${day}${time}`,
    meeting.meetingType ? `🏷 ${esc(meeting.meetingType)}` : "",
    link && meeting.meetingType !== "Offline" ? `🎥 Join: ${esc(link)}` : "",
  ];
  if (kind === "mom") {
    const actions = (meeting.actions || []).slice(0, 10);
    if (meeting.decisions) lines.push("", `<b>Decisions</b>\n${esc(String(meeting.decisions).slice(0, 600))}`);
    if (actions.length) {
      lines.push("", "<b>Action plans</b>");
      actions.forEach((a) => lines.push(`• ${esc(a.title)} — <i>${esc(a.owners?.map((o) => o.name).join(", ") || a.owner || "Unassigned")}</i>`));
    }
  }
  const text = lines.filter((l, i, a) => l || a[i - 1]).join("\n").slice(0, 4000);
  const extra = { reply_markup: { inline_keyboard: [[{ text: "📄 Open meeting", callback_data: `m:${meeting._id}` }]] } };

  await Promise.all(
    links
      .filter((l) => !muted.has(String(l.user)))
      .map((l) =>
        sendMessage(l.chatId, text, extra).catch(async (err) => {
          if (err.code === 403) await TelegramLink.deleteOne({ _id: l._id }).catch(() => {});
          else console.error("[telegram] meeting notice:", err.message);
        })
      )
  );
};
