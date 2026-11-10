import crypto from "crypto";
import TelegramLink, { TelegramLinkCode } from "../../models/TelegramLink.js";
import User from "../../models/User.js";
import { appApi, AppApiError } from "./appApi.js";
import { answerCallback, editOrSend, esc, getBotInfo, sendMessage, tg, telegramEnabled } from "./telegramApi.js";
import { PRIORITIES, PRIORITY_ICON, STATUSES, renderTask, renderTaskList, roleOn, scoreKeyboard } from "./taskViews.js";
import {
  can, clearWrongCodes, dateButtons, endSession, getSession, linkBlocked, noteWrongCode,
  parseDate, parseTime, peopleKeyboard, setSession,
} from "./botShared.js";
import { MEETING_CALLBACKS, MEETING_FLOWS, onMeetingCallback, onMeetingText, showMeetings, startNewMeeting } from "./meetingBot.js";

/* =========================================================
   Telegram bot — long polling (works on localhost, no public URL needed).
   Every action goes through the app's REST API as the linked user
   (see appApi.js), so the web app shows the change at once.
========================================================= */

export const hashLinkCode = (code) =>
  crypto.createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");

const MENU = {
  keyboard: [
    [{ text: "📋 My tasks" }, { text: "📤 Assigned by me" }],
    [{ text: "➕ New task" }, { text: "📊 My stats" }],
    [{ text: "🗓 Meetings" }, { text: "➕ New meeting" }],
    [{ text: "❓ Help" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const HELP = [
  "<b>What I can do</b>",
  "📋 /mytasks — tasks assigned to you; open one to change status, tick subtasks and checklists",
  "📤 /assigned — tasks you assigned to others; approve them or send them back for rework",
  "➕ /newtask — create and assign a task",
  "📊 /stats — your task counts and points",
  "🗓 /meetings — your meetings (MoM): join link, points, action plans; organizers send the MoM",
  "➕ /newmeeting — schedule a meeting and invite people",
  "✖️ /cancel — stop what you are typing",
  "🚪 /logout — disconnect this Telegram from your account",
  "",
  "You also get your app notifications here (new tasks, reminders, reviews, meeting invitations…).",
  "Everything you do here shows in the web app straight away.",
].join("\n");

const NOT_LINKED = [
  "👋 <b>Welcome!</b> Connect this chat to your Task Management account first:",
  "",
  "1. Log in to the web app",
  "2. Open <b>Settings → Notifications → Telegram</b>",
  "3. Tap <b>Connect Telegram</b> (or send me the code shown there: <code>/link CODE</code>)",
].join("\n");

/* ---------- who is this chat ---------- */
const linkedUser = async (chatId) => {
  const link = await TelegramLink.findOne({ chatId: String(chatId) }).lean();
  if (!link) return null;
  const user = await User.findById(link.user).select("_id status").lean();
  if (!user) {
    await TelegramLink.deleteOne({ _id: link._id });
    return null;
  }
  return user;
};

// Fresh profile + permissions from the API (same as the web app's /api/auth/me)
const loadMe = async (userId) => {
  const { data } = await appApi(userId, "GET", "/api/auth/me");
  return { ...data, _id: String(data._id), zone: data.preferences?.timezone || "Asia/Kolkata" };
};

/* ---------- linking ---------- */
const linkWithCode = async (msg, code) => {
  const chatId = String(msg.chat.id);
  if (linkBlocked(chatId)) {
    return sendMessage(chatId, "🔒 Too many wrong codes. Try again in an hour.");
  }
  const entry = await TelegramLinkCode.findOneAndDelete({ codeHash: hashLinkCode(code), expiresAt: { $gt: new Date() } });
  if (!entry) {
    const left = noteWrongCode(chatId);
    return sendMessage(
      chatId,
      left > 0
        ? `❌ That code is wrong or has expired (${left} ${left === 1 ? "try" : "tries"} left). Make a new one in <b>Settings → Notifications → Telegram</b>.`
        : "🔒 Too many wrong codes. Try again in an hour."
    );
  }
  clearWrongCodes(chatId);
  const user = await User.findById(entry.user).select("name status emailVerified").lean();
  if (!user || user.status === "Inactive" || user.emailVerified === false) {
    return sendMessage(chatId, "❌ This account cannot use the bot (inactive or not verified). Contact your admin.");
  }
  // one chat ↔ one account: drop older links of this chat and of this user
  await TelegramLink.deleteMany({ $or: [{ chatId }, { user: user._id }] });
  await TelegramLink.create({
    user: user._id,
    chatId,
    username: msg.from?.username || "",
    firstName: msg.from?.first_name || "",
  });
  await TelegramLinkCode.deleteMany({ user: user._id });
  return sendMessage(chatId, `✅ Connected to <b>${esc(user.name)}</b>.\n\n${HELP}`, { reply_markup: MENU });
};

/* ---------- task lists / detail ---------- */
const showList = async (chatId, messageId, me, kind = "m", filter = "o", page = 0) => {
  const url = kind === "m" ? `/api/tasks?assignedTo=${me._id}` : "/api/tasks";
  const { data } = await appApi(me._id, "GET", url);
  const tasks =
    kind === "m"
      ? data
      : data.filter((t) => String(t.assignedBy) === me._id && String(t.assignedTo) !== me._id);
  const view = renderTaskList({ tasks, kind, filter, page: Number(page) || 0, zone: me.zone });
  return editOrSend(chatId, messageId, view.text, { reply_markup: view.reply_markup });
};

const showTask = async (chatId, messageId, me, taskId, notice = "") => {
  const { data: task } = await appApi(me._id, "GET", `/api/tasks/${taskId}`);
  const view = renderTask({ task, me, zone: me.zone, perms: me.permissions });
  return editOrSend(chatId, messageId, `${notice ? `${notice}\n\n` : ""}${view.text}`.slice(0, 4090), {
    reply_markup: view.reply_markup,
  });
};

const changeStatus = async (chatId, messageId, me, taskId, status, extra = {}) => {
  const res = await appApi(me._id, "PATCH", `/api/tasks/${taskId}/status`, { status, ...extra });
  return showTask(chatId, messageId, me, taskId, `✅ ${esc(res.message || "Status updated")}`);
};

const showStats = async (chatId, me) => {
  const [{ data: s }, { data: board }] = await Promise.all([
    appApi(me._id, "GET", "/api/tasks/stats"),
    appApi(me._id, "GET", "/api/tasks/scoreboard"),
  ]);
  const mine = board?.me || {};
  const text = [
    `<b>📊 ${esc(me.name)}</b> · ${esc(me.role)}`,
    "",
    `⭐ Points: <b>${mine.points ?? me.points ?? 0}</b>${mine.level ? ` · ${esc(mine.level.icon || "")} ${esc(mine.level.name || "")}` : ""}`,
    `🏁 Tasks completed: ${mine.completed ?? 0}`,
    "",
    "<b>Tasks you can see</b>",
    `⚪ To Do: ${s.todo}`,
    `🔵 In Progress: ${s.progress}`,
    `🟣 Review: ${s.review}`,
    `✅ Completed: ${s.completed}`,
    `Σ Total: ${s.total}`,
  ].join("\n");
  return sendMessage(chatId, text);
};

/* ---------- new task wizard ---------- */
const CANCEL_ROW = [{ text: "✖️ Cancel", callback_data: "n:x" }];

const askStep = async (chatId, me, s) => {
  const d = s.data;
  if (s.step === "name") return sendMessage(chatId, "➕ <b>New task</b>\n\nSend the <b>task name</b>:", { reply_markup: { inline_keyboard: [CANCEL_ROW] } });
  if (s.step === "desc")
    return sendMessage(chatId, "Send a <b>description</b> (or skip):", {
      reply_markup: { inline_keyboard: [[{ text: "⏭ Skip", callback_data: "n:skip" }], CANCEL_ROW] },
    });
  if (s.step === "due")
    return sendMessage(chatId, "📅 <b>Due date?</b> Tap one or type a date (e.g. <code>25-12-2026</code>):", {
      reply_markup: {
        inline_keyboard: [
          ...dateButtons("n:due:", me.zone),
          [{ text: "No deadline", callback_data: "n:due:none" }],
          CANCEL_ROW,
        ],
      },
    });
  if (s.step === "time")
    return sendMessage(chatId, "⏰ <b>Due time?</b> Tap one or type <code>HH:mm</code>:", {
      reply_markup: {
        inline_keyboard: [
          ["10:00", "13:00", "17:00", "18:00"].map((t) => ({ text: t, callback_data: `n:time:${t.replace(":", "")}` })),
          [{ text: "No time", callback_data: "n:time:none" }],
          CANCEL_ROW,
        ],
      },
    });
  if (s.step === "priority")
    return sendMessage(chatId, "⚡ <b>Priority?</b>", {
      reply_markup: {
        inline_keyboard: [
          PRIORITIES.map((p, i) => ({ text: `${PRIORITY_ICON[p]} ${p}`, callback_data: `n:pr:${i}` })),
          CANCEL_ROW,
        ],
      },
    });
  if (s.step === "assignee") return sendMessage(chatId, "👤 <b>Assign to</b> (tap to select, one or more):", { reply_markup: assigneeKeyboard(s) });
  if (s.step === "confirm") {
    const names = d.users.filter((u) => d.selected.includes(String(u._id))).map((u) => u.name);
    const text = [
      "<b>Create this task?</b>",
      "",
      `📝 <b>${esc(d.name)}</b>`,
      d.description ? esc(d.description.slice(0, 500)) : "<i>No description</i>",
      `📅 ${d.dueDate ? `${d.dueDate}${d.dueTime ? ` ${d.dueTime}` : ""}` : "No deadline"}`,
      `${PRIORITY_ICON[d.priority]} ${d.priority}`,
      `👤 ${esc(names.join(", "))}`,
    ].join("\n");
    return sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Create", callback_data: "n:ok" }], CANCEL_ROW] },
    });
  }
  return null;
};

const assigneeKeyboard = (s) =>
  peopleKeyboard({ people: s.data.users, selected: s.data.selected, page: s.data.upage || 0 }, "n", "n:x");

const startNewTask = async (chatId, me) => {
  if (!can(me, "tasks", "create")) return sendMessage(chatId, "🔒 Your role cannot create tasks.");
  const s = { flow: "newtask", step: "name", data: {} };
  setSession(chatId, s);
  return askStep(chatId, me, s);
};

const nextStep = async (chatId, me, s, step) => {
  s.step = step;
  if (step === "assignee" && !s.data.users) {
    const { data } = await appApi(me._id, "GET", "/api/users/assignable");
    s.data.users = data || [];
    s.data.selected = [];
    if (!s.data.users.length) {
      endSession(chatId);
      return sendMessage(chatId, "❌ There is nobody you can assign tasks to.");
    }
    // only yourself available (no tasks.assign) → no need to pick
    if (s.data.users.length === 1 && String(s.data.users[0]._id) === me._id) {
      s.data.selected = [String(s.data.users[0]._id)];
      s.step = "confirm";
    }
  }
  setSession(chatId, s);
  return askStep(chatId, me, s);
};

const createFromWizard = async (chatId, messageId, me, s) => {
  const d = s.data;
  const picked = d.users.filter((u) => d.selected.includes(String(u._id)));
  // all assignees in one department → the task belongs to it (as the web form defaults to)
  const depts = [...new Set(picked.map((u) => u.department).filter(Boolean))];
  const body = {
    name: d.name,
    description: d.description || "",
    priority: d.priority,
    assignedUser: d.selected,
    ...(d.dueDate ? { dueDate: d.dueDate, dueTime: d.dueTime || "" } : {}),
    ...(depts.length === 1 && picked.every((u) => u.department) ? { departments: depts } : {}),
  };
  const res = await appApi(me._id, "POST", "/api/tasks", body);
  endSession(chatId);
  const created = Array.isArray(res.data) ? res.data : [res.data];
  return editOrSend(chatId, messageId, `✅ ${esc(res.message || "Task created")}`, {
    reply_markup: {
      inline_keyboard: created.slice(0, 10).map((t) => [{ text: `📄 ${t.assignedUser || t.name}`.slice(0, 60), callback_data: `t:${t.id}` }]),
    },
  });
};

/* ---------- text messages ---------- */
const onText = async (msg, me) => {
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();
  const s = getSession(chatId);

  if (s?.flow === "newtask") {
    if (s.step === "name") {
      if (!text) return sendMessage(chatId, "Please send the task name.");
      s.data.name = text.slice(0, 200);
      return nextStep(chatId, me, s, "desc");
    }
    if (s.step === "desc") {
      s.data.description = text.slice(0, 3000);
      return nextStep(chatId, me, s, "due");
    }
    if (s.step === "due") {
      const day = parseDate(text, me.zone);
      if (!day) return sendMessage(chatId, "❌ I could not read that date. Try <code>25-12-2026</code> or <code>2026-12-25</code>.");
      s.data.dueDate = day;
      return nextStep(chatId, me, s, "time");
    }
    if (s.step === "time") {
      const t = parseTime(text);
      if (!t) return sendMessage(chatId, "❌ Use <code>HH:mm</code>, e.g. <code>17:30</code>.");
      s.data.dueTime = t;
      return nextStep(chatId, me, s, "priority");
    }
    return sendMessage(chatId, "Please use the buttons above (or /cancel).");
  }

  if (s && MEETING_FLOWS.includes(s.flow)) return onMeetingText(chatId, me, s, text);

  if (s?.flow === "note") {
    endSession(chatId);
    return changeStatus(chatId, null, me, s.taskId, s.status, { note: text.slice(0, 1000) });
  }
  if (s?.flow === "subtask") {
    endSession(chatId);
    await appApi(me._id, "POST", `/api/tasks/${s.taskId}/subtasks`, { title: text.slice(0, 300) });
    return showTask(chatId, null, me, s.taskId, "✅ Subtask added");
  }
  if (s?.flow === "ckval") {
    endSession(chatId);
    await appApi(me._id, "PATCH", `/api/tasks/${s.taskId}/checklist/${s.itemId}`, { value: text.slice(0, 300) });
    return showTask(chatId, null, me, s.taskId, "✅ Checklist updated");
  }

  return sendMessage(chatId, "Choose an option from the menu below, or send /help.", { reply_markup: MENU });
};

/* ---------- commands ---------- */
const COMMANDS = {
  "/mytasks": (chatId, me) => showList(chatId, null, me, "m"),
  "📋 my tasks": (chatId, me) => showList(chatId, null, me, "m"),
  "/assigned": (chatId, me) => showList(chatId, null, me, "b"),
  "📤 assigned by me": (chatId, me) => showList(chatId, null, me, "b"),
  "/newtask": (chatId, me) => startNewTask(chatId, me),
  "➕ new task": (chatId, me) => startNewTask(chatId, me),
  "/stats": (chatId, me) => showStats(chatId, me),
  "/meetings": (chatId, me) => showMeetings(chatId, null, me),
  "🗓 meetings": (chatId, me) => showMeetings(chatId, null, me),
  "/newmeeting": (chatId, me) => startNewMeeting(chatId, me),
  "➕ new meeting": (chatId, me) => startNewMeeting(chatId, me),
  "📊 my stats": (chatId, me) => showStats(chatId, me),
  "/help": (chatId) => sendMessage(chatId, HELP, { reply_markup: MENU }),
  "❓ help": (chatId) => sendMessage(chatId, HELP, { reply_markup: MENU }),
  "/menu": (chatId) => sendMessage(chatId, "Main menu 👇", { reply_markup: MENU }),
  "/start": (chatId, me) => sendMessage(chatId, `👋 Hi <b>${esc(me.name)}</b>!\n\n${HELP}`, { reply_markup: MENU }),
  "/logout": async (chatId) => {
    await TelegramLink.deleteOne({ chatId });
    return sendMessage(chatId, "🚪 Disconnected. Your account no longer receives updates here.", {
      reply_markup: { remove_keyboard: true },
    });
  },
};

const onMessage = async (msg) => {
  const chatId = String(msg.chat.id);
  if (msg.chat.type !== "private") {
    return sendMessage(chatId, "Please talk to me in a private chat.");
  }
  const text = String(msg.text || "").trim();
  if (!text) return sendMessage(chatId, "I only understand text messages for now.");
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@\w+$/, "").toLowerCase(); // "/start@MyBot" → "/start"

  if (cmd === "/cancel") {
    endSession(chatId);
    return sendMessage(chatId, "✖️ Cancelled.", { reply_markup: MENU });
  }
  if ((cmd === "/start" || cmd === "/link") && args[0]) return linkWithCode(msg, args[0]);

  const user = await linkedUser(chatId);
  if (!user) return sendMessage(chatId, NOT_LINKED);
  if (user.status === "Inactive") return sendMessage(chatId, "🔒 Your account is deactivated. Contact your admin.");

  const me = await loadMe(user._id);
  const handler = COMMANDS[cmd] || COMMANDS[text.toLowerCase()];
  if (handler) {
    endSession(chatId); // a menu command abandons any half-typed wizard
    return handler(chatId, me);
  }
  return onText(msg, me);
};

/* ---------- button presses ---------- */
const onCallback = async (cq) => {
  const chatId = String(cq.message?.chat?.id || "");
  const messageId = cq.message?.message_id;
  const [kind, a, b, c] = String(cq.data || "").split(":");

  const user = await linkedUser(chatId);
  if (!user) {
    await answerCallback(cq.id);
    return sendMessage(chatId, NOT_LINKED);
  }
  if (user.status === "Inactive") return answerCallback(cq.id, "Your account is deactivated", true);
  const me = await loadMe(user._id);
  await answerCallback(cq.id);

  if (MEETING_CALLBACKS.includes(kind)) return onMeetingCallback(chatId, messageId, me, kind, [a, b, c]);

  switch (kind) {
    case "l":
      return showList(chatId, messageId, me, a, b, c);
    case "t":
      return showTask(chatId, messageId, me, a);

    case "s": {
      const status = STATUSES[Number(b)];
      if (!status) return null;
      const { data: task } = await appApi(me._id, "GET", `/api/tasks/${a}`);
      const { isAssigner, selfAssigned } = roleOn(task, me);
      if (status === "Completed" && !selfAssigned) {
        return editOrSend(chatId, messageId, `⭐ <b>${esc(task.name)}</b>\n\nGive a score from 1 to 10 to approve it:`, {
          reply_markup: scoreKeyboard(a),
        });
      }
      if (task.status === "Review" && isAssigner && !selfAssigned && ["To Do", "In Progress"].includes(status)) {
        setSession(chatId, { flow: "note", taskId: a, status });
        return editOrSend(chatId, messageId, `🔁 <b>${esc(task.name)}</b>\n\nSend the <b>reason for rework</b> (the assignee will see it):`, {
          reply_markup: { inline_keyboard: [[{ text: "Send without a reason", callback_data: `nn:${a}:${b}` }], [{ text: "✖️ Cancel", callback_data: `t:${a}` }]] },
        });
      }
      return changeStatus(chatId, messageId, me, a, status);
    }
    case "nn":
      endSession(chatId);
      return changeStatus(chatId, messageId, me, a, STATUSES[Number(b)]);
    case "sc":
      return changeStatus(chatId, messageId, me, a, "Completed", { score: Number(b) });

    case "u": {
      const { data: task } = await appApi(me._id, "GET", `/api/tasks/${a}`);
      const sub = task.subtasks.find((x) => String(x._id) === b);
      if (!sub) return showTask(chatId, messageId, me, a, "Subtask not found");
      await appApi(me._id, "PATCH", `/api/tasks/${a}/subtasks/${b}`, { completed: !sub.completed });
      return showTask(chatId, messageId, me, a);
    }
    case "k": {
      const { data: task } = await appApi(me._id, "GET", `/api/tasks/${a}`);
      const item = task.checklist.find((x) => String(x._id) === b);
      if (!item) return showTask(chatId, messageId, me, a, "Checklist row not found");
      if (item.type === "Check") {
        await appApi(me._id, "PATCH", `/api/tasks/${a}/checklist/${b}`, { done: !item.done });
        return showTask(chatId, messageId, me, a);
      }
      setSession(chatId, { flow: "ckval", taskId: a, itemId: b });
      return sendMessage(chatId, `✏️ <b>${esc(item.desc)}</b>\n\nSend the ${item.type === "Number" ? "number" : "answer"}:`, {
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `t:${a}` }]] },
      });
    }
    case "as":
      setSession(chatId, { flow: "subtask", taskId: a });
      return sendMessage(chatId, "🧩 Send the <b>subtask title</b>:", {
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `t:${a}` }]] },
      });
    case "dl":
      return editOrSend(chatId, messageId, "🗑 <b>Delete this task?</b> This cannot be undone.", {
        reply_markup: { inline_keyboard: [[{ text: "Yes, delete", callback_data: `dy:${a}` }, { text: "No", callback_data: `t:${a}` }]] },
      });
    case "dy":
      await appApi(me._id, "DELETE", `/api/tasks/${a}`);
      return editOrSend(chatId, messageId, "🗑 Task deleted.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Tasks I assigned", callback_data: "l:b:o:0" }]] } });

    case "n":
      return onWizardButton(chatId, messageId, me, a, b);
    default:
      return null;
  }
};

const onWizardButton = async (chatId, messageId, me, action, value) => {
  if (action === "x") {
    endSession(chatId);
    return editOrSend(chatId, messageId, "✖️ New task cancelled.");
  }
  const s = getSession(chatId);
  if (s?.flow !== "newtask") return editOrSend(chatId, messageId, "This form has expired. Start again with /newtask.");
  const done = (label) => editOrSend(chatId, messageId, label); // freeze the answered step

  if (action === "skip" && s.step === "desc") {
    await done("Description: <i>none</i>");
    return nextStep(chatId, me, s, "due");
  }
  if (action === "due" && s.step === "due") {
    if (value === "none") {
      await done("📅 No deadline");
      return nextStep(chatId, me, s, "priority");
    }
    s.data.dueDate = value;
    await done(`📅 Due: ${value}`);
    return nextStep(chatId, me, s, "time");
  }
  if (action === "time" && s.step === "time") {
    s.data.dueTime = value === "none" ? "" : `${value.slice(0, 2)}:${value.slice(2)}`;
    await done(`⏰ ${s.data.dueTime || "No time"}`);
    return nextStep(chatId, me, s, "priority");
  }
  if (action === "pr" && s.step === "priority") {
    s.data.priority = PRIORITIES[Number(value)] || "Medium";
    await done(`${PRIORITY_ICON[s.data.priority]} Priority: ${s.data.priority}`);
    return nextStep(chatId, me, s, "assignee");
  }
  if (s.step === "assignee") {
    if (action === "u") {
      const u = s.data.users[Number(value)];
      if (u) {
        const id = String(u._id);
        s.data.selected = s.data.selected.includes(id) ? s.data.selected.filter((x) => x !== id) : [...s.data.selected, id];
      }
    } else if (action === "up") {
      s.data.upage = Number(value) || 0;
    } else if (action === "ud") {
      if (!s.data.selected.length) return null;
      await done("👤 Assignees selected");
      return nextStep(chatId, me, s, "confirm");
    }
    setSession(chatId, s);
    return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: assigneeKeyboard(s) }).catch(() => {});
  }
  if (action === "ok" && s.step === "confirm") return createFromWizard(chatId, messageId, me, s);
  return null;
};

/* ---------- one update, errors shown to the user ---------- */
export const handleUpdate = async (update) => {
  const chatId = String(update.message?.chat?.id || update.callback_query?.message?.chat?.id || "");
  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (err) {
    if (err instanceof AppApiError) {
      if (err.status === 401) await TelegramLink.deleteOne({ chatId });
      if (chatId) await sendMessage(chatId, `⚠️ ${esc(err.message)}`).catch(() => {});
    } else {
      console.error("[telegram]", err);
      if (chatId) await sendMessage(chatId, "⚠️ Something went wrong. Please try again.").catch(() => {});
    }
  }
};

/* ---------- long polling ---------- */
let running = false;

const pollLoop = async () => {
  let offset = 0;
  while (running) {
    try {
      const updates = await tg(
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
        { timeoutMs: 40000 }
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (err) {
      // 409 = another copy of the server is polling with the same token
      const wait = err.code === 409 ? 30000 : 5000;
      if (err.name !== "TimeoutError") console.error("[telegram] polling:", err.message);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
};

export const startTelegramBot = async () => {
  if (!telegramEnabled()) {
    if (process.env.NODE_ENV !== "test") console.log("ℹ️  Telegram bot off (set TELEGRAM_BOT_TOKEN in .env to turn it on)");
    return;
  }
  if (running) return;
  try {
    const info = await getBotInfo();
    await tg("deleteWebhook", { drop_pending_updates: false });
    await tg("setMyCommands", {
      commands: [
        { command: "mytasks", description: "Tasks assigned to me" },
        { command: "assigned", description: "Tasks I assigned" },
        { command: "newtask", description: "Create and assign a task" },
        { command: "stats", description: "My counts and points" },
        { command: "meetings", description: "My meetings (MoM)" },
        { command: "newmeeting", description: "Schedule a meeting" },
        { command: "cancel", description: "Stop the current form" },
        { command: "help", description: "What I can do" },
        { command: "logout", description: "Disconnect this Telegram" },
      ],
    });
    running = true;
    console.log(`✅ Telegram bot @${info.username} running (long polling)`);
    pollLoop();
  } catch (err) {
    console.error("❌ Telegram bot could not start:", err.message);
  }
};

export const stopTelegramBot = () => {
  running = false;
};
