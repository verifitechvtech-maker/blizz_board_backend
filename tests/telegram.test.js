// Telegram bot — real Express app + in-memory MongoDB + a fake Telegram (nothing leaves the machine).
// Run: npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-only-for-tests";
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SMTP_USER", "SMTP_PASS", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) process.env[k] = "";
process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = "123:fake";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();

const { server } = await import("../src/app.js");
const User = (await import("../src/models/User.js")).default;
const Task = (await import("../src/models/Task.js")).default;
const TelegramLink = (await import("../src/models/TelegramLink.js")).default;
const { setTelegramTransport } = await import("../src/services/telegram/telegramApi.js");
const { handleUpdate } = await import("../src/services/telegram/telegramBot.js");

// ---- fake Telegram: records every call ----
const sent = [];
let nextMessageId = 1;
setTelegramTransport(async (method, params) => {
  sent.push({ method, ...params });
  if (method === "getMe") return { id: 1, username: "task_test_bot" };
  if (method === "sendMessage") return { message_id: nextMessageId++, chat: { id: params.chat_id } };
  return true;
});
const textsTo = (chatId) => sent.filter((m) => String(m.chat_id) === String(chatId) && m.text).map((m) => m.text);
const lastTo = (chatId) => sent.filter((m) => String(m.chat_id) === String(chatId) && m.text).at(-1);
const buttonsOf = (msg) => (msg?.reply_markup?.inline_keyboard || []).flat();

const ADMIN_CHAT = "1001";
const USER_CHAT = "2002";
let updateId = 1;
const say = (chatId, text) =>
  handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId), username: `u${chatId}` }, text } });
const press = (chatId, data, messageId = 1) =>
  handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), data, message: { message_id: messageId, chat: { id: Number(chatId), type: "private" } } } });
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

let base;
const T = {};
const ID = {};
const call = async (method, url, { token, json } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json() };
};
const login = async (email, password) => (await call("POST", "/api/auth/login", { json: { email, password } })).data.data.token;

before(async () => {
  await mongoose.connect(mongod.getUri());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.TELEGRAM_INTERNAL_API_URL = base; // the bot calls this API as the linked user

  const admin = await User.create({ name: "Asha Admin", email: "asha@tg.io", password: "Admin@123", role: "Admin" });
  const user = await User.create({ name: "Ravi User", email: "ravi@tg.io", password: "User@123", role: "User", admin_id: admin._id, createdBy: admin._id });
  ID.admin = String(admin._id);
  ID.user = String(user._id);
  T.admin = await login("asha@tg.io", "Admin@123");
  T.user = await login("ravi@tg.io", "User@123");
});

after(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

describe("Telegram bot", () => {
  test("a chat that is not connected is asked to connect first", async () => {
    await say("9999", "/mytasks");
    assert.match(lastTo("9999").text, /Connect this chat/);
  });

  test("connect with the one-time code from Settings (deep link /start CODE)", async () => {
    const status = await call("GET", "/api/telegram/status", { token: T.user });
    assert.equal(status.data.data.enabled, true);
    assert.equal(status.data.data.linked, false);

    const made = await call("POST", "/api/telegram/link-code", { token: T.user });
    assert.equal(made.status, 200);
    assert.match(made.data.data.deepLink, /^https:\/\/t\.me\/task_test_bot\?start=[A-Z2-9]{8}$/);

    await say(USER_CHAT, "/start WRONGCODE");
    assert.match(lastTo(USER_CHAT).text, /wrong or has expired/);

    await say(USER_CHAT, `/start ${made.data.data.code}`);
    assert.match(lastTo(USER_CHAT).text, /Connected to <b>Ravi User<\/b>/);
    assert.equal((await call("GET", "/api/telegram/status", { token: T.user })).data.data.linked, true);

    // a code works only once
    await say("3003", `/start ${made.data.data.code}`);
    assert.match(lastTo("3003").text, /wrong or has expired/);

    const adminCode = (await call("POST", "/api/telegram/link-code", { token: T.admin })).data.data.code;
    await say(ADMIN_CHAT, `/link ${adminCode.toLowerCase()}`); // typed by hand, any case
    assert.match(lastTo(ADMIN_CHAT).text, /Connected to <b>Asha Admin<\/b>/);
  });

  test("admin creates and assigns a task from Telegram → saved in the app, assignee notified on Telegram", async () => {
    await say(ADMIN_CHAT, "➕ New task");
    assert.match(lastTo(ADMIN_CHAT).text, /task name/);
    await say(ADMIN_CHAT, "Prepare <monthly> report");
    await say(ADMIN_CHAT, "Numbers for October");
    await say(ADMIN_CHAT, "25-12-2030");
    await press(ADMIN_CHAT, "n:time:1700");
    await press(ADMIN_CHAT, "n:pr:2"); // High
    const picker = lastTo(ADMIN_CHAT);
    const ravi = buttonsOf(picker).find((b) => b.text.includes("Ravi User"));
    assert.ok(ravi, "assignee list comes from /api/users/assignable");
    await press(ADMIN_CHAT, ravi.callback_data);
    await press(ADMIN_CHAT, "n:ud");
    assert.match(lastTo(ADMIN_CHAT).text, /Create this task\?[\s\S]*Prepare &lt;monthly&gt; report/);
    await press(ADMIN_CHAT, "n:ok");

    const task = await Task.findOne({ name: "Prepare <monthly> report" }).lean();
    assert.ok(task);
    assert.equal(String(task.assignedTo), ID.user);
    assert.equal(String(task.assignedBy), ID.admin);
    assert.equal(task.priority, "High");
    assert.equal(task.dueTime, "17:00");
    assert.equal(task.description, "Numbers for October");
    ID.task = String(task._id);

    // same in-app notification as the web → also arrives in the assignee's Telegram
    assert.ok(await waitFor(() => textsTo(USER_CHAT).some((t) => /assigned you "Prepare &lt;monthly&gt; report"/.test(t))));
    // and the web app sees it
    const web = await call("GET", `/api/tasks/${ID.task}`, { token: T.user });
    assert.equal(web.status, 200);
  });

  test("assignee works the task from Telegram; assigner approves with a score", async () => {
    await say(USER_CHAT, "/mytasks");
    const list = lastTo(USER_CHAT);
    assert.ok(buttonsOf(list).some((b) => b.callback_data === `t:${ID.task}`));

    await press(USER_CHAT, `t:${ID.task}`);
    const detail = sent.filter((m) => m.method === "editMessageText" && String(m.chat_id) === USER_CHAT).at(-1);
    assert.match(detail.text, /Status: <b>To Do<\/b>/);
    const labels = buttonsOf(detail).map((b) => b.text);
    assert.ok(!labels.some((l) => /Completed|Approve/.test(l)), "the assignee is not offered Completed");

    await press(USER_CHAT, `s:${ID.task}:1`); // In Progress
    await press(USER_CHAT, `s:${ID.task}:2`); // Review
    assert.equal((await Task.findById(ID.task).lean()).status, "Review");
    assert.ok(await waitFor(() => textsTo(ADMIN_CHAT).some((t) => /Review/.test(t))), "assigner hears about it");

    // the assignee cannot complete it — the API's rule shows as a message
    await press(USER_CHAT, `sc:${ID.task}:9`);
    assert.match(lastTo(USER_CHAT).text, /Only the person who assigned this task/);

    await press(ADMIN_CHAT, `s:${ID.task}:3`);
    assert.ok(buttonsOf(sent.filter((m) => String(m.chat_id) === ADMIN_CHAT).at(-1)).some((b) => b.callback_data === `sc:${ID.task}:8`));
    await press(ADMIN_CHAT, `sc:${ID.task}:8`);
    const done = await Task.findById(ID.task).lean();
    assert.equal(done.status, "Completed");
    assert.equal(done.reviewScore, 8);
    assert.equal((await User.findById(ID.user).lean()).points, 8);
  });

  test("rework from Review asks for a reason that reaches the status history", async () => {
    const t = await call("POST", "/api/tasks", { token: T.admin, json: { name: "Fix login page", assignedUser: ID.user } });
    const id = t.data.data.id;
    await call("PATCH", `/api/tasks/${id}/status`, { token: T.user, json: { status: "Review" } });

    await press(ADMIN_CHAT, `s:${id}:1`);
    assert.match(sent.filter((m) => String(m.chat_id) === ADMIN_CHAT).at(-1).text, /reason for rework/);
    await say(ADMIN_CHAT, "Button colour is wrong");
    const task = await Task.findById(id).lean();
    assert.equal(task.status, "In Progress");
    assert.equal(task.reworkCount, 1);
    assert.match(task.statusHistory.at(-1).note, /Button colour is wrong/);
  });

  test("Telegram notifications can be switched off; disconnect from the web app", async () => {
    assert.equal((await call("PUT", "/api/auth/me/preferences", { token: T.user, json: { telegramNotifications: false } })).status, 200);
    const before = textsTo(USER_CHAT).length;
    await call("POST", "/api/tasks", { token: T.admin, json: { name: "Quiet task", assignedUser: ID.user } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(textsTo(USER_CHAT).length, before);

    assert.equal((await call("DELETE", "/api/telegram/link", { token: T.user })).status, 200);
    assert.equal(await TelegramLink.countDocuments({ user: ID.user }), 0);
    await say(USER_CHAT, "/mytasks");
    assert.match(lastTo(USER_CHAT).text, /Connect this chat/);
  });

  test("a deactivated account cannot use the bot", async () => {
    await User.updateOne({ _id: ID.admin }, { status: "Inactive" });
    await say(ADMIN_CHAT, "/mytasks");
    assert.match(lastTo(ADMIN_CHAT).text, /deactivated/);
    await User.updateOne({ _id: ID.admin }, { status: "Active" });
  });
});

describe("Telegram bot — wrong link codes", () => {
  test("5 wrong codes block the chat for an hour, even for a right code", async () => {
    const chat = "4004";
    for (let i = 1; i <= 4; i++) {
      await say(chat, `/link WRONG${i}`);
      assert.match(lastTo(chat).text, new RegExp(`${5 - i} tr(y|ies) left`));
    }
    await say(chat, "/link WRONG5");
    assert.match(lastTo(chat).text, /Too many wrong codes/);
    const good = (await call("POST", "/api/telegram/link-code", { token: T.user })).data.data.code;
    await say(chat, `/start ${good}`);
    assert.match(lastTo(chat).text, /Too many wrong codes/);
    assert.equal(await TelegramLink.countDocuments({ chatId: chat }), 0);
  });
});

describe("Telegram bot — meetings (MoM)", () => {
  const Meeting = () => mongoose.model("Meeting");

  before(async () => {
    await call("PUT", "/api/auth/me/preferences", { token: T.user, json: { telegramNotifications: true } });
    const code = (await call("POST", "/api/telegram/link-code", { token: T.user })).data.data.code;
    await say(USER_CHAT, `/start ${code}`);
    assert.match(lastTo(USER_CHAT).text, /Connected/);
  });

  test("organizer schedules a meeting from Telegram → video link, invitation on the attendee's Telegram", async () => {
    await say(ADMIN_CHAT, "➕ New meeting");
    assert.match(lastTo(ADMIN_CHAT).text, /meeting title/);
    await say(ADMIN_CHAT, "Weekly sync");
    await say(ADMIN_CHAT, "25-12-2030");
    await press(ADMIN_CHAT, "w:start:1000");
    await say(ADMIN_CHAT, "09:00"); // end before start is refused
    assert.match(lastTo(ADMIN_CHAT).text, /end must be after 10:00/);
    await press(ADMIN_CHAT, "w:end:1100");
    await press(ADMIN_CHAT, "w:type:Online");
    const ravi = buttonsOf(lastTo(ADMIN_CHAT)).find((b) => b.text.includes("Ravi User"));
    assert.ok(ravi, "attendees come from /api/meetings/participants");
    await press(ADMIN_CHAT, ravi.callback_data);
    await press(ADMIN_CHAT, "w:ud");
    await say(ADMIN_CHAT, "Status of all projects");
    assert.match(lastTo(ADMIN_CHAT).text, /Schedule this meeting\?[\s\S]*Weekly sync[\s\S]*Ravi User/);
    await press(ADMIN_CHAT, "w:ok");

    const m = await Meeting().findOne({ title: "Weekly sync" }).lean();
    assert.ok(m);
    assert.equal(new Date(m.meetingDate).toISOString().slice(0, 10), "2030-12-25");
    assert.equal(m.startTime, "10:00");
    assert.equal(m.endTime, "11:00");
    assert.equal(m.agenda, "Status of all projects");
    assert.equal(String(m.attendees[0].userId), ID.user);
    assert.ok(m.videoLink.includes("/meet/"), "the server made the video call link");
    ID.meeting = String(m._id);

    assert.ok(await waitFor(() => textsTo(USER_CHAT).some((t) => /Meeting invitation[\s\S]*Weekly sync[\s\S]*Join:/.test(t))));
    assert.ok(!textsTo(ADMIN_CHAT).some((t) => /Meeting invitation/.test(t)), "the organizer is not invited to their own meeting");
  });

  test("attendee adds and ticks points and action plans; no organizer tools", async () => {
    await say(USER_CHAT, "🗓 Meetings");
    assert.ok(buttonsOf(lastTo(USER_CHAT)).some((b) => b.callback_data === `m:${ID.meeting}`));

    await press(USER_CHAT, `m:${ID.meeting}`);
    const view = sent.filter((x) => x.method === "editMessageText" && String(x.chat_id) === USER_CHAT).at(-1);
    assert.match(view.text, /Weekly sync[\s\S]*Join:/);
    assert.ok(!buttonsOf(view).some((b) => /Send MoM|Delete/.test(b.text)), "only the organizer gets these");

    await press(USER_CHAT, `mx:${ID.meeting}:pt`);
    await say(USER_CHAT, "Budget for Q1");
    let m = await Meeting().findById(ID.meeting).lean();
    assert.equal(m.points[0].title, "Budget for Q1");
    await press(USER_CHAT, `mp:${ID.meeting}:${m.points[0]._id}`);
    m = await Meeting().findById(ID.meeting).lean();
    assert.equal(m.points[0].completed, true);

    await press(USER_CHAT, `mx:${ID.meeting}:ac`);
    await say(USER_CHAT, "Send the quote");
    const owner = buttonsOf(lastTo(USER_CHAT)).find((b) => b.text.includes("Ravi User"));
    await press(USER_CHAT, owner.callback_data);
    await press(USER_CHAT, "aa:ud");
    await say(USER_CHAT, "31-12-2030");
    m = await Meeting().findById(ID.meeting).lean();
    assert.equal(m.actions[0].title, "Send the quote");
    assert.equal(String(m.actions[0].owners[0].userId), ID.user);
    assert.equal(new Date(m.actions[0].dueDate).toISOString().slice(0, 10), "2030-12-31");
    assert.equal(m.points[0].completed, true, "saving actions keeps the points");
  });

  test("organizer adds a decision, sends the MoM (reaches Telegram) and completes the meeting", async () => {
    await press(ADMIN_CHAT, `mx:${ID.meeting}:dec`);
    await say(ADMIN_CHAT, "Hire one more designer");
    await press(ADMIN_CHAT, `mx:${ID.meeting}:mom`);
    assert.ok(
      await waitFor(() => textsTo(USER_CHAT).some((t) => /Minutes of Meeting[\s\S]*Hire one more designer[\s\S]*Send the quote/.test(t)))
    );
    await press(ADMIN_CHAT, `mx:${ID.meeting}:done`);
    assert.equal((await Meeting().findById(ID.meeting).lean()).status, "Completed");
  });
});
