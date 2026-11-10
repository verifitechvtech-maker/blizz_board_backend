import { DateTime } from "luxon";
import { appApi } from "./appApi.js";
import { editOrSend, esc, sendMessage, tg } from "./telegramApi.js";
import { can, dateButtons, endSession, getSession, parseDate, parseTime, peopleKeyboard, setSession } from "./botShared.js";

/* =========================================================
   MoM (meetings) in the Telegram bot — through /api/meetings as the
   linked user, so access rules, invitation emails, video links and
   the MoM email are exactly the web app's.
========================================================= */

const zone = () => process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
const PAGE_SIZE = 8;
const STATUS_ICON = { Scheduled: "🗓", Ongoing: "🟢", Completed: "✅", Cancelled: "❌" };

export const MEETING_CALLBACKS = ["ml", "m", "mp", "ma", "mx", "w", "aa"];
export const MEETING_FLOWS = ["newmeeting", "mpoint", "maction", "mdecision"];

const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const dayOf = (m) => (m.meetingDate ? String(m.meetingDate).slice(0, 10) : "");
const fmtDay = (iso) => (iso ? DateTime.fromISO(iso, { zone: zone() }).toFormat("ccc, dd LLL yyyy") : "");
const fmtTime = (m) => (m.startTime ? `${m.startTime}${m.endTime ? `–${m.endTime}` : ""}` : "");
const isOrganizer = (m, me) =>
  String(m.createdBy?._id || m.createdBy) === me._id || ["Admin", "SuperAdmin"].includes(me.role);
const isUpcoming = (m) =>
  !["Completed", "Cancelled"].includes(m.status) && dayOf(m) >= DateTime.now().setZone(zone()).toISODate();
const linkOf = (m) => m.videoLink || m.googleMeetLink || "";

const noAccess = (chatId) => sendMessage(chatId, "🔒 Your role cannot use Meetings (MoM).");

/* ---------- list ---------- */
const FILTERS = {
  u: { label: "Upcoming", test: isUpcoming },
  p: { label: "Past", test: (m) => !isUpcoming(m) },
  a: { label: "All", test: () => true },
};

export const showMeetings = async (chatId, messageId, me, filter = "u", page = 0) => {
  if (!can(me, "communication", "view")) return noAccess(chatId);
  const { data } = await appApi(me._id, "GET", "/api/meetings");
  const f = FILTERS[filter] || FILTERS.u;
  let shown = data.filter(f.test);
  // upcoming: soonest first; past / all: newest first (API order)
  if (filter === "u") shown = shown.sort((x, y) => `${dayOf(x)}${x.startTime}`.localeCompare(`${dayOf(y)}${y.startTime}`));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = shown.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const lines = [`<b>🗓 Meetings</b> · ${f.label} (${shown.length})`, ""];
  if (!slice.length) lines.push("<i>No meetings here.</i>");
  slice.forEach((m, i) => {
    lines.push(
      `${p * PAGE_SIZE + i + 1}. ${STATUS_ICON[m.status] || ""} <b>${esc(cut(m.title, 60))}</b>\n    📅 ${fmtDay(dayOf(m))}${fmtTime(m) ? ` · ${fmtTime(m)}` : ""} · ${esc(m.meetingType)}`
    );
  });
  if (pages > 1) lines.push("", `Page ${p + 1}/${pages}`);

  const kb = slice.map((m, i) => [{ text: `${p * PAGE_SIZE + i + 1}. ${cut(m.title, 40)}`, callback_data: `m:${m._id}` }]);
  kb.push(Object.entries(FILTERS).map(([k, v]) => ({ text: `${k === filter ? "• " : ""}${v.label}`, callback_data: `ml:${k}:0` })));
  const nav = [];
  if (p > 0) nav.push({ text: "◀️ Prev", callback_data: `ml:${filter}:${p - 1}` });
  nav.push({ text: "🔄 Refresh", callback_data: `ml:${filter}:${p}` });
  if (p < pages - 1) nav.push({ text: "Next ▶️", callback_data: `ml:${filter}:${p + 1}` });
  kb.push(nav);
  if (can(me, "communication", "create")) kb.push([{ text: "➕ New meeting", callback_data: "w:new" }]);
  return editOrSend(chatId, messageId, lines.join("\n"), { reply_markup: { inline_keyboard: kb } });
};

/* ---------- one meeting ---------- */
const getMeeting = async (me, id) => (await appApi(me._id, "GET", `/api/meetings/${id}`)).data;

export const showMeeting = async (chatId, messageId, me, id, notice = "") => {
  const m = await getMeeting(me, id);
  const org = isOrganizer(m, me);
  const canEdit = can(me, "communication", "edit");

  const lines = [
    `${STATUS_ICON[m.status] || ""} <b>${esc(m.title)}</b>`,
    "",
    `📅 ${fmtDay(dayOf(m))}${fmtTime(m) ? ` · ${fmtTime(m)}` : ""} (${esc(zone())})`,
    `🏷 ${esc(m.meetingType)} · ${esc(m.status)}`,
  ];
  if (m.location) lines.push(`📍 ${esc(m.location)}`);
  if (linkOf(m) && m.meetingType !== "Offline") lines.push(`🎥 Join: ${esc(linkOf(m))}`);
  if (m.createdBy?.name) lines.push(`🧑‍💼 Organizer: ${esc(m.createdBy.name)}`);
  if (m.attendees?.length) lines.push(`👥 ${esc(cut(m.attendees.map((a) => a.name).join(", "), 400))}`);
  if (m.agenda) lines.push("", `<b>Agenda</b>\n${esc(cut(m.agenda, 600))}`);
  if (m.points?.length) {
    lines.push("", `<b>Discussion points</b> (${m.points.filter((x) => x.completed).length}/${m.points.length})`);
    m.points.slice(0, 15).forEach((x) => lines.push(`${x.completed ? "☑️" : "⬜"} ${esc(cut(x.title, 90))}`));
  }
  if (m.actions?.length) {
    lines.push("", `<b>Action plans</b> (${m.actions.filter((x) => x.completed).length}/${m.actions.length})`);
    m.actions.slice(0, 15).forEach((x) => {
      const owners = x.owners?.length ? x.owners.map((o) => o.name).join(", ") : x.owner || "Unassigned";
      const due = x.dueDate ? ` · 📅 ${String(x.dueDate).slice(0, 10)}` : "";
      lines.push(`${x.completed ? "☑️" : "⬜"} ${esc(cut(x.title, 80))} — <i>${esc(owners)}</i>${due}`);
    });
  }
  if (m.decisions) lines.push("", `<b>Decisions</b>\n${esc(cut(m.decisions, 600))}`);
  if (m.notes) lines.push("", `<b>Notes</b>\n${esc(cut(m.notes, 500))}`);
  if (m.momEmailSentAt) lines.push("", `📧 MoM emailed ${DateTime.fromISO(new Date(m.momEmailSentAt).toISOString()).setZone(zone()).toFormat("dd LLL HH:mm")}`);

  const kb = [];
  if (canEdit) {
    m.points?.slice(0, 10).forEach((x) =>
      kb.push([{ text: `${x.completed ? "☑️" : "⬜"} ${cut(x.title, 45)}`, callback_data: `mp:${m._id}:${x._id}` }])
    );
    m.actions?.slice(0, 10).forEach((x) =>
      kb.push([{ text: `${x.completed ? "☑️" : "⬜"} 🎯 ${cut(x.title, 42)}`, callback_data: `ma:${m._id}:${x._id}` }])
    );
    if (m.status !== "Cancelled") {
      kb.push([
        { text: "➕ Point", callback_data: `mx:${m._id}:pt` },
        { text: "➕ Action plan", callback_data: `mx:${m._id}:ac` },
      ]);
    }
  }
  if (org && canEdit && m.status !== "Cancelled") {
    kb.push([
      { text: "📝 Decisions", callback_data: `mx:${m._id}:dec` },
      ...(can(me, "communication", "create") ? [{ text: "📧 Send MoM", callback_data: `mx:${m._id}:mom` }] : []),
    ]);
    const row = [];
    if (m.status === "Scheduled" && can(me, "communication", "create")) row.push({ text: "🔔 Reminder", callback_data: `mx:${m._id}:rem` });
    if (m.status !== "Completed") row.push({ text: "✅ Completed", callback_data: `mx:${m._id}:done` });
    if (m.status === "Scheduled") row.push({ text: "❌ Cancel", callback_data: `mx:${m._id}:cancel` });
    if (row.length) kb.push(row);
  }
  if (org && can(me, "communication", "delete")) kb.push([{ text: "🗑 Delete meeting", callback_data: `mx:${m._id}:del` }]);
  kb.push([
    { text: "🔄 Refresh", callback_data: `m:${m._id}` },
    { text: "⬅️ Meetings", callback_data: "ml:u:0" },
  ]);
  return editOrSend(chatId, messageId, `${notice ? `${notice}\n\n` : ""}${lines.join("\n")}`.slice(0, 4090), {
    reply_markup: { inline_keyboard: kb },
  });
};

// points / actions are saved whole (as the web form does), keeping every row's _id
const savePoints = (me, m, points) =>
  appApi(me._id, "PUT", `/api/meetings/${m._id}`, { points: points.map(({ _id, title, completed }) => ({ _id, title, completed })) });
const saveActions = (me, m, actions) =>
  appApi(me._id, "PUT", `/api/meetings/${m._id}`, {
    actions: actions.map(({ _id, title, owners, owner, dueDate, completed }) => ({ _id, title, owners, owner, dueDate, completed })),
  });

const cancelBtn = (id) => ({ inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `m:${id}` }]] });

/* ---------- new meeting wizard ---------- */
export const startNewMeeting = async (chatId, me) => {
  if (!can(me, "communication", "create")) return sendMessage(chatId, "🔒 Your role cannot schedule meetings.");
  const s = { flow: "newmeeting", step: "title", data: {} };
  setSession(chatId, s);
  return askMeetingStep(chatId, me, s);
};

const W_CANCEL = [{ text: "✖️ Cancel", callback_data: "w:x" }];
const plusMinutes = (hhmm, n) => DateTime.fromFormat(hhmm, "HH:mm").plus({ minutes: n }).toFormat("HH:mm");

const askMeetingStep = (chatId, me, s) => {
  const d = s.data;
  switch (s.step) {
    case "title":
      return sendMessage(chatId, "🗓 <b>New meeting</b>\n\nSend the <b>meeting title</b>:", { reply_markup: { inline_keyboard: [W_CANCEL] } });
    case "date":
      return sendMessage(chatId, "📅 <b>Date?</b> Tap one or type a date (e.g. <code>25-12-2026</code>):", {
        reply_markup: { inline_keyboard: [...dateButtons("w:date:", zone()), W_CANCEL] },
      });
    case "start":
      return sendMessage(chatId, "⏰ <b>Start time?</b> Tap one or type <code>HH:mm</code>:", {
        reply_markup: {
          inline_keyboard: [
            ["10:00", "11:00", "14:00", "16:00"].map((t) => ({ text: t, callback_data: `w:start:${t.replace(":", "")}` })),
            W_CANCEL,
          ],
        },
      });
    case "end":
      return sendMessage(chatId, "⏱ <b>End time?</b> Tap one or type <code>HH:mm</code>:", {
        reply_markup: {
          inline_keyboard: [
            [30, 60, 90].map((n) => ({ text: `${n} min (${plusMinutes(d.startTime, n)})`, callback_data: `w:end:${plusMinutes(d.startTime, n).replace(":", "")}` })),
            [{ text: "No end time", callback_data: "w:end:none" }],
            W_CANCEL,
          ],
        },
      });
    case "type":
      return sendMessage(chatId, "🎥 <b>Meeting type?</b> Online meetings get a private video call link.", {
        reply_markup: {
          inline_keyboard: [
            ["Online", "Offline", "Hybrid"].map((t) => ({ text: t, callback_data: `w:type:${t}` })),
            W_CANCEL,
          ],
        },
      });
    case "people":
      return sendMessage(chatId, "👥 <b>Who is invited?</b> Tap to select, then Done:", { reply_markup: peopleKeyboard(d.pick, "w", "w:x") });
    case "agenda":
      return sendMessage(chatId, "📝 Send the <b>agenda</b> (or skip):", {
        reply_markup: { inline_keyboard: [[{ text: "⏭ Skip", callback_data: "w:skip" }], W_CANCEL] },
      });
    case "confirm": {
      const names = d.pick.people.filter((u) => d.pick.selected.includes(String(u._id))).map((u) => u.name);
      return sendMessage(
        chatId,
        [
          "<b>Schedule this meeting?</b>",
          "",
          `🗓 <b>${esc(d.title)}</b>`,
          `📅 ${fmtDay(d.meetingDate)} · ${d.startTime}${d.endTime ? `–${d.endTime}` : ""}`,
          `🎥 ${d.meetingType}`,
          `👥 ${esc(names.join(", ") || "Nobody invited yet")}`,
          d.agenda ? `📝 ${esc(cut(d.agenda, 400))}` : "",
          "",
          d.meetingType !== "Offline" ? "<i>The invitation with the video link is emailed to everyone invited.</i>" : "",
        ].filter((l, i, a) => l || a[i - 1]).join("\n"),
        { reply_markup: { inline_keyboard: [[{ text: "✅ Schedule", callback_data: "w:ok" }], W_CANCEL] } }
      );
    }
    default:
      return null;
  }
};

const nextMeetingStep = async (chatId, me, s, step) => {
  s.step = step;
  if (step === "people" && !s.data.pick) {
    const { data } = await appApi(me._id, "GET", "/api/meetings/participants");
    s.data.pick = { people: (data || []).filter((u) => String(u._id) !== me._id), selected: [], page: 0 };
    if (!s.data.pick.people.length) s.step = "agenda";
  }
  setSession(chatId, s);
  return askMeetingStep(chatId, me, s);
};

const createMeetingFromWizard = async (chatId, messageId, me, s) => {
  const d = s.data;
  const attendees = d.pick.people
    .filter((u) => d.pick.selected.includes(String(u._id)))
    .map((u) => ({ name: u.name, email: u.email || "", userId: u._id, department: u.department || "" }));
  const res = await appApi(me._id, "POST", "/api/meetings", {
    title: d.title,
    meetingDate: d.meetingDate,
    startTime: d.startTime,
    endTime: d.endTime || "",
    meetingType: d.meetingType,
    attendees,
    departments: [...new Set(attendees.map((a) => a.department).filter(Boolean))],
    agenda: d.agenda || "",
    status: "Scheduled",
    points: [],
    actions: [],
  });
  endSession(chatId);
  const info = res.integration || {};
  const lines = [`✅ ${esc(res.message || "Meeting scheduled")}`];
  if (info.videoLink) lines.push(`🎥 ${esc(info.videoLink)}`);
  if (info.invitationSent) lines.push("📧 Invitation emailed to the attendees.");
  else if (info.warning) lines.push(`⚠️ ${esc(info.warning)}`);
  return editOrSend(chatId, messageId, lines.join("\n"), {
    reply_markup: { inline_keyboard: [[{ text: "📄 Open meeting", callback_data: `m:${res.data._id}` }]] },
  });
};

/* ---------- typed text in a meeting flow ---------- */
export const onMeetingText = async (chatId, me, s, text) => {
  if (s.flow === "newmeeting") {
    const d = s.data;
    if (s.step === "title") {
      if (!text) return sendMessage(chatId, "Please send the meeting title.");
      d.title = text.slice(0, 200);
      return nextMeetingStep(chatId, me, s, "date");
    }
    if (s.step === "date") {
      const day = parseDate(text, zone());
      if (!day) return sendMessage(chatId, "❌ I could not read that date. Try <code>25-12-2026</code>.");
      d.meetingDate = day;
      return nextMeetingStep(chatId, me, s, "start");
    }
    if (s.step === "start" || s.step === "end") {
      const t = parseTime(text);
      if (!t) return sendMessage(chatId, "❌ Use <code>HH:mm</code>, e.g. <code>15:30</code>.");
      if (s.step === "start") {
        d.startTime = t;
        return nextMeetingStep(chatId, me, s, "end");
      }
      if (t <= d.startTime) return sendMessage(chatId, `❌ The end must be after ${d.startTime}.`);
      d.endTime = t;
      return nextMeetingStep(chatId, me, s, "type");
    }
    if (s.step === "agenda") {
      d.agenda = text.slice(0, 3000);
      return nextMeetingStep(chatId, me, s, "confirm");
    }
    return sendMessage(chatId, "Please use the buttons above (or /cancel).");
  }

  if (s.flow === "mpoint") {
    endSession(chatId);
    const m = await getMeeting(me, s.meetingId);
    await savePoints(me, m, [...(m.points || []), { title: text.slice(0, 300), completed: false }]);
    return showMeeting(chatId, null, me, s.meetingId, "✅ Point added");
  }
  if (s.flow === "mdecision") {
    endSession(chatId);
    const m = await getMeeting(me, s.meetingId);
    const decisions = [m.decisions, text.slice(0, 3000)].filter(Boolean).join("\n");
    await appApi(me._id, "PUT", `/api/meetings/${s.meetingId}`, { decisions });
    return showMeeting(chatId, null, me, s.meetingId, "✅ Decision added");
  }
  if (s.flow === "maction") {
    if (s.step === "title") {
      s.data.title = text.slice(0, 300);
      s.step = "owners";
      const { data } = await appApi(me._id, "GET", "/api/meetings/participants");
      s.data.pick = { people: data || [], selected: [], page: 0 };
      setSession(chatId, s);
      return sendMessage(chatId, "👤 <b>Who owns it?</b> Tap to select, then Done:", { reply_markup: peopleKeyboard(s.data.pick, "aa", `m:${s.meetingId}`) });
    }
    if (s.step === "due") {
      const day = parseDate(text, zone());
      if (!day) return sendMessage(chatId, "❌ I could not read that date. Try <code>25-12-2026</code>.");
      return saveActionFromWizard(chatId, null, me, s, day);
    }
    return sendMessage(chatId, "Please use the buttons above (or /cancel).");
  }
  return null;
};

const saveActionFromWizard = async (chatId, messageId, me, s, dueDate) => {
  endSession(chatId);
  const owners = s.data.pick.people
    .filter((u) => s.data.pick.selected.includes(String(u._id)))
    .map((u) => ({ userId: u._id, name: u.name, email: u.email || "" }));
  const m = await getMeeting(me, s.meetingId);
  await saveActions(me, m, [
    ...(m.actions || []),
    { title: s.data.title, owners, owner: owners.map((o) => o.name).join(", ") || "Unassigned", dueDate: dueDate || null, completed: false },
  ]);
  return showMeeting(chatId, messageId, me, s.meetingId, "✅ Action plan added");
};

/* ---------- picker buttons (shared by both wizards) ---------- */
const pickerPress = async (chatId, messageId, s, prefix, action, value, cancelData) => {
  const pick = s.data.pick;
  if (action === "u") {
    const u = pick.people[Number(value)];
    if (u) {
      const id = String(u._id);
      pick.selected = pick.selected.includes(id) ? pick.selected.filter((x) => x !== id) : [...pick.selected, id];
    }
  } else if (action === "up") {
    pick.page = Number(value) || 0;
  }
  setSession(chatId, s);
  return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: peopleKeyboard(pick, prefix, cancelData) }).catch(() => {});
};

/* ---------- button presses ---------- */
export const onMeetingCallback = async (chatId, messageId, me, kind, [a, b, c]) => {
  if (!can(me, "communication", "view")) return noAccess(chatId);

  if (kind === "ml") return showMeetings(chatId, messageId, me, a, b);
  if (kind === "m") {
    endSession(chatId);
    return showMeeting(chatId, messageId, me, a);
  }

  if (kind === "mp" || kind === "ma") {
    const m = await getMeeting(me, a);
    const list = kind === "mp" ? m.points || [] : m.actions || [];
    const row = list.find((x) => String(x._id) === b);
    if (!row) return showMeeting(chatId, messageId, me, a, "That row was removed");
    row.completed = !row.completed;
    await (kind === "mp" ? savePoints(me, m, list) : saveActions(me, m, list));
    return showMeeting(chatId, messageId, me, a);
  }

  if (kind === "mx") {
    const id = a;
    const confirm = (text, yes) =>
      editOrSend(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: `mx:${id}:${yes}` }, { text: "No", callback_data: `m:${id}` }]] },
      });
    switch (b) {
      case "pt":
        setSession(chatId, { flow: "mpoint", meetingId: id });
        return sendMessage(chatId, "💬 Send the <b>discussion point</b>:", { reply_markup: cancelBtn(id) });
      case "ac":
        setSession(chatId, { flow: "maction", step: "title", meetingId: id, data: {} });
        return sendMessage(chatId, "🎯 Send the <b>action plan</b> (what needs to be done):", { reply_markup: cancelBtn(id) });
      case "dec":
        setSession(chatId, { flow: "mdecision", meetingId: id });
        return sendMessage(chatId, "📝 Send the <b>decision</b> to add:", { reply_markup: cancelBtn(id) });
      case "mom": {
        const res = await appApi(me._id, "POST", `/api/meetings/${id}/send-mom`);
        return showMeeting(chatId, messageId, me, id, `📧 ${esc(res.message || "MoM sent")}`);
      }
      case "rem": {
        const res = await appApi(me._id, "POST", `/api/meetings/${id}/send-reminder`);
        return showMeeting(chatId, messageId, me, id, `🔔 ${esc(res.message || "Reminder sent")}`);
      }
      case "done":
        await appApi(me._id, "PUT", `/api/meetings/${id}`, { status: "Completed" });
        return showMeeting(chatId, messageId, me, id, "✅ Marked completed");
      case "cancel":
        return confirm("❌ <b>Cancel this meeting?</b> The video call link stops working.", "cancely");
      case "cancely":
        await appApi(me._id, "PUT", `/api/meetings/${id}`, { status: "Cancelled" });
        return showMeeting(chatId, messageId, me, id, "❌ Meeting cancelled");
      case "del":
        return confirm("🗑 <b>Delete this meeting?</b> Its recording, transcript and files are removed too.", "dely");
      case "dely":
        await appApi(me._id, "DELETE", `/api/meetings/${id}`);
        return editOrSend(chatId, messageId, "🗑 Meeting deleted.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Meetings", callback_data: "ml:u:0" }]] } });
      default:
        return null;
    }
  }

  if (kind === "aa") {
    const s = getSession(chatId);
    if (s?.flow !== "maction") return editOrSend(chatId, messageId, "This form has expired. Open the meeting again.");
    if (a === "u" || a === "up") return pickerPress(chatId, messageId, s, "aa", a, b, `m:${s.meetingId}`);
    if (a === "ud" && s.step === "owners") {
      s.step = "due";
      setSession(chatId, s);
      return editOrSend(chatId, messageId, "📅 <b>Due date?</b> Tap one or type a date:", {
        reply_markup: {
          inline_keyboard: [...dateButtons("aa:due:", zone()), [{ text: "No due date", callback_data: "aa:due:none" }], [{ text: "✖️ Cancel", callback_data: `m:${s.meetingId}` }]],
        },
      });
    }
    if (a === "due" && s.step === "due") return saveActionFromWizard(chatId, messageId, me, s, b === "none" ? null : b);
    return null;
  }

  if (kind === "w") {
    if (a === "new") return startNewMeeting(chatId, me);
    if (a === "x") {
      endSession(chatId);
      return editOrSend(chatId, messageId, "✖️ New meeting cancelled.");
    }
    const s = getSession(chatId);
    if (s?.flow !== "newmeeting") return editOrSend(chatId, messageId, "This form has expired. Start again with /newmeeting.");
    const d = s.data;
    const done = (label) => editOrSend(chatId, messageId, label);

    if (a === "date" && s.step === "date") {
      d.meetingDate = b;
      await done(`📅 ${fmtDay(b)}`);
      return nextMeetingStep(chatId, me, s, "start");
    }
    if (a === "start" && s.step === "start") {
      d.startTime = `${b.slice(0, 2)}:${b.slice(2)}`;
      await done(`⏰ Starts ${d.startTime}`);
      return nextMeetingStep(chatId, me, s, "end");
    }
    if (a === "end" && s.step === "end") {
      d.endTime = b === "none" ? "" : `${b.slice(0, 2)}:${b.slice(2)}`;
      await done(`⏱ ${d.endTime ? `Ends ${d.endTime}` : "No end time"}`);
      return nextMeetingStep(chatId, me, s, "type");
    }
    if (a === "type" && s.step === "type") {
      d.meetingType = ["Online", "Offline", "Hybrid"].includes(b) ? b : "Online";
      await done(`🎥 ${d.meetingType}`);
      return nextMeetingStep(chatId, me, s, "people");
    }
    if (s.step === "people") {
      if (a === "ud") {
        await done(`👥 ${d.pick.selected.length} invited`);
        return nextMeetingStep(chatId, me, s, "agenda");
      }
      return pickerPress(chatId, messageId, s, "w", a, b, "w:x");
    }
    if (a === "skip" && s.step === "agenda") {
      await done("📝 No agenda");
      return nextMeetingStep(chatId, me, s, "confirm");
    }
    if (a === "ok" && s.step === "confirm") return createMeetingFromWizard(chatId, messageId, me, s);
  }
  return null;
};
