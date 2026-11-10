// Integration tests — real Express app + throwaway in-memory MongoDB.
// Never touches the database in .env.   Run: npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.JWT_SECRET = "test-secret-only-for-tests";
// Never talk to the real Google account / mailbox from tests (.env would load them)
// real services from .env (email, Cloudinary, task inbox, Render flags) are never used by tests
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SMTP_USER", "SMTP_PASS", "CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "TASK_INBOX_ENABLED", "RENDER"]) process.env[k] = "";
process.env.NODE_ENV = "test";
// Throwaway push keys (dotenv never overrides these), pushes go to a fake sender below
{
  const webpush = (await import("web-push")).default;
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:test@example.test";
}

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri(); // in case anything reads it

const { server } = await import("../src/app.js");
// Never run the real Whisper model in tests (individual tests install their own fakes)
const { setTranscriber } = await import("../src/services/transcriptionService.js");
setTranscriber(async () => ({ seconds: 1, segments: [{ text: "test", start: 0 }] }));
const User = (await import("../src/models/User.js")).default;
const Task = (await import("../src/models/Task.js")).default;
const { UPLOAD_DIR } = await import("../src/controllers/taskController.js");
const { sentMessages } = await import("../src/services/accountEmailService.js");
const Meeting = () => mongoose.model("Meeting");

let base;
const createdFiles = [];

const call = async (method, url, { token, json, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(base + url, { method, headers, body });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
};

const login = async (email, password) => {
  const r = await call("POST", "/api/auth/login", { json: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.data.token;
};

// Latest one-time verification token emailed to this address
const tokenFor = (email) => {
  const msg = [...sentMessages].reverse().find((m) => m.to === email.toLowerCase() && /verify-email\//.test(m.text));
  return msg?.text.match(/verify-email\/([a-f0-9]{64})/)?.[1];
};

// What a new user does: open the email link (password shown once), then log in
const activate = async (email, password) => {
  const r = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor(email) } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.password, password, "revealed password matches the admin-set one");
  return login(email, password);
};

const csvForm = (text, name = "tasks.csv") => {
  const f = new FormData();
  f.append("file", new Blob([text], { type: "text/csv" }), name);
  return f;
};

const T = {}; // tokens
const ID = {}; // ids

before(async () => {
  await mongoose.connect(mongod.getUri());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  await User.create({
    name: "Root", email: "root@test.io", password: "Root@123", role: "SuperAdmin",
  });
  T.super = await login("ROOT@test.io ", "Root@123"); // email is case/space-insensitive
});

after(async () => {
  for (const f of createdFiles) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  const { RECORDING_DIR } = await import("../src/controllers/meetingMediaController.js");
  for (const m of await mongoose.model("Meeting").find({ "recordingFile.filename": { $ne: null } }).lean()) {
    if (m.recordingFile?.filename) fs.rmSync(path.join(RECORDING_DIR, m.recordingFile.filename), { force: true });
  }
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

describe("Super Admin login + dashboard data", () => {
  test("login returns role and full permissions; /me refreshes them", async () => {
    const me = await call("GET", "/api/auth/me", { token: T.super });
    assert.equal(me.status, 200);
    assert.equal(me.data.data.role, "SuperAdmin");
    assert.ok(me.data.data.permissions.users.includes("assign"));
    assert.equal(me.data.data.password, undefined);
  });

  test("SuperAdmin creates two Admins (two organizations)", async () => {
    for (const k of ["A", "B"]) {
      const r = await call("POST", "/api/admins", {
        token: T.super,
        json: { name: `Admin ${k}`, email: `admin${k}@test.io`, password: "Admin@123", companyName: `Company ${k}` },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ID[`admin${k}`] = r.data.data._id;
      T[`admin${k}`] = await activate(`admin${k}@test.io`, "Admin@123");
    }
  });

  test("SuperAdmin can create a member inside a chosen organization", async () => {
    const r = await call("POST", "/api/users", {
      token: T.super,
      json: { name: "Bob B", email: "bob@test.io", password: "User@123", role: "User", department: "Sales", adminId: ID.adminB },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(String(r.data.data.admin_id), ID.adminB);
    ID.bob = r.data.data._id;
    T.bob = await activate("bob@test.io", "User@123");
  });

  test("SuperAdmin dashboard endpoints return real admins with org counts", async () => {
    const admins = await call("GET", "/api/admins", { token: T.super });
    assert.equal(admins.status, 200);
    assert.equal(admins.data.count, 2);
    const b = admins.data.data.find((a) => a._id === ID.adminB);
    assert.equal(b.members, 1);
    const users = await call("GET", "/api/users", { token: T.super });
    assert.equal(users.status, 200);
    assert.ok(users.data.data.every((u) => u.role !== "SuperAdmin"));
  });

  test("Admins cannot reach SuperAdmin-only APIs", async () => {
    assert.equal((await call("GET", "/api/admins", { token: T.adminA })).status, 403);
    assert.equal((await call("POST", "/api/admins", { token: T.adminA, json: { name: "x", email: "x@x.io", password: "123456" } })).status, 403);
    assert.equal((await call("GET", "/api/permissions/admins", { token: T.adminA })).status, 403);
  });
});

describe("User roles", () => {
  test("Admin creates Manager and Team Member — role is saved", async () => {
    const m = await call("POST", "/api/users", {
      token: T.adminA,
      json: { name: "Mia Manager", email: "mia@test.io", password: "User@123", role: "Manager", department: "Development" },
    });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    assert.equal(m.data.data.role, "Manager");
    ID.mia = m.data.data._id;

    for (const [key, name, email, dept] of [
      ["alice", "Alice", "alice@test.io", "Development"],
      ["dan", "Dan", "dan@test.io", "Development"],
      ["sam", "Sam Sales", "sam@test.io", "Sales"],
    ]) {
      const r = await call("POST", "/api/users", {
        token: T.adminA,
        json: { name, email, password: "User@123", role: "User", department: dept },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ID[key] = r.data.data._id;
    }
    T.mia = await activate("mia@test.io", "User@123");
    T.alice = await activate("alice@test.io", "User@123");
    T.dan = await activate("dan@test.io", "User@123");

    const list = await call("GET", "/api/users", { token: T.adminA });
    const roles = Object.fromEntries(list.data.data.map((u) => [u.email, u.role]));
    assert.deepEqual(roles, { "mia@test.io": "Manager", "alice@test.io": "User", "dan@test.io": "User", "sam@test.io": "User" });
    assert.ok(!list.data.data.some((u) => u.email === "bob@test.io"), "Admin A must not see Admin B's users");
  });

  test("invalid / escalating role assignments are rejected", async () => {
    const asSuper = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Evil", email: "evil@test.io", password: "User@123", role: "SuperAdmin" },
    });
    assert.equal(asSuper.status, 403);
    const asAdmin = await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { role: "Admin" } });
    assert.equal(asAdmin.status, 403);
    const bogus = await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { role: "Wizard" } });
    assert.equal(bogus.status, 403);
    const self = await call("PUT", `/api/users/${ID.mia}`, { token: T.mia, json: { role: "Admin" } });
    assert.equal(self.status, 403);
  });

  test("role change persists on the correct record", async () => {
    const r = await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { role: "Manager" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await User.findById(ID.dan)).role, "Manager");
    assert.equal((await User.findById(ID.alice)).role, "User");
    const back = await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { role: "User" } });
    assert.equal(back.status, 200);
  });

  test("cross-organization user management is blocked", async () => {
    assert.equal((await call("PUT", `/api/users/${ID.bob}`, { token: T.adminA, json: { name: "hacked" } })).status, 403);
    assert.equal((await call("DELETE", `/api/users/${ID.bob}`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/users/${ID.bob}`, { token: T.adminA })).status, 403);
  });

  test("Team Members cannot list or manage users", async () => {
    assert.equal((await call("GET", "/api/users", { token: T.alice })).status, 403);
    assert.equal((await call("POST", "/api/users", { token: T.alice, json: {} })).status, 403);
  });
});

describe("Tasks — create with attachments, edit, delete, permissions", () => {
  test("Admin creates a task with files (multipart) assigned to Alice", async () => {
    const f = new FormData();
    f.append("name", "Write spec");
    f.append("department", "Development");
    f.append("assignedUser", "Alice");
    f.append("dueDate", "2030-01-15");
    f.append("subtasks", JSON.stringify([{ title: "outline" }]));
    f.append("recurring", "false");
    f.append("files", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), "spec.pdf");
    f.append("files", new Blob(["a,b\n1,2"], { type: "text/csv" }), "data.csv");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const t = r.data.data;
    ID.task = t.id;
    assert.equal(t.assignedUser, "Alice");
    assert.equal(t.attachments.length, 2);
    assert.equal(t.subtasks.length, 1);
    t.attachments.forEach((a) => createdFiles.push(a.filename));
    ID.file = t.attachments[0].filename;
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, ID.file)), "file stored on disk, not in MongoDB");
  });

  test("unsupported file type is rejected with 400", async () => {
    const f = new FormData();
    f.append("name", "Bad file");
    f.append("files", new Blob(["MZ"]), "virus.exe");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /not a supported file type/);
  });

  test("empty files are rejected with 400", async () => {
    const f = new FormData();
    f.append("name", "Empty file");
    f.append("files", new Blob([]), "empty.pdf");
    const r = await call("POST", "/api/tasks", { token: T.adminA, form: f });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /is empty/);
  });

  test("attachments persist and download only for authorized users", async () => {
    const list = await call("GET", "/api/tasks", { token: T.alice });
    const t = list.data.data.find((x) => x.id === ID.task);
    assert.equal(t.attachments.length, 2);
    const ok = await call("GET", `/api/tasks/attachments/${ID.file}`, { token: T.alice });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-disposition"), /spec\.pdf/);
    assert.equal((await call("GET", `/api/tasks/attachments/${ID.file}`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/tasks/attachments/${ID.file}`)).status, 401);
    assert.equal((await fetch(`${base}/uploads/tasks/${ID.file}`)).status, 404, "no public static access");
  });

  test("Admin edits the task — resending the same assignee is not a reassignment", async () => {
    const r = await call("PATCH", `/api/tasks/${ID.task}`, {
      token: T.adminA,
      json: { name: "Write spec v2", assignedUser: "Alice", priority: "High", attachments: [{ filename: ID.file }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.name, "Write spec v2");
    assert.equal(r.data.data.attachments.length, 1, "removed attachment dropped");
    const fresh = await Task.findById(ID.task);
    assert.equal(fresh.priority, "High");
  });

  test("assignee (not creator) cannot edit or delete, but can update status", async () => {
    const edit = await call("PATCH", `/api/tasks/${ID.task}`, { token: T.alice, json: { name: "mine now" } });
    assert.equal(edit.status, 403);
    const del = await call("DELETE", `/api/tasks/${ID.task}`, { token: T.alice });
    assert.equal(del.status, 403);
    const st = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "In Progress" } });
    assert.equal(st.status, 200);
  });

  test("review flow: only the assigner completes (score + message to assignee) or sends back for rework", async () => {
    const Notification = (await import("../src/models/Notification.js")).default;
    const User = (await import("../src/models/User.js")).default;
    const task = await Task.findById(ID.task);
    const assigner = String(task.assignedBy);
    const tokenOf = { [String((await User.findOne({ email: "alice@test.io" }))._id)]: T.alice };
    assert.ok(!tokenOf[assigner], "task assigned by someone other than Alice");
    const assignerToken = T.adminA;
    const before = (await User.findOne({ email: "alice@test.io" })).points || 0;

    // assignee can't complete — not even from Review
    let r = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "Completed" } });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "ASSIGNER_ONLY");
    // assigner can't skip Review
    r = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "Completed" } });
    assert.equal(r.status, 409);

    // assignee → Review; assigner sends it back for rework with a reason
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "Review" } })).status, 200);
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "Completed" } })).status, 403);
    r = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "In Progress", note: "Add the summary" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.rework, true);
    assert.equal(r.data.data.reworkCount, 1);
    const rework = await Notification.findOne({ task: ID.task, type: "task_rework" });
    assert.ok(rework && /Add the summary/.test(rework.message), "assignee told what to rework");

    // back to Review → assigner approves → points + score in the message
    await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "Review" } });
    // approving needs a score 1–10 from the assigner
    r = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "Completed" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "SCORE_REQUIRED");
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "Completed", score: 11 } })).status, 400);
    r = await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "Completed", score: 8 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = await Task.findById(ID.task);
    const reward = 8; // points = the score the assigner gave
    assert.equal(t.reviewScore, 8);
    assert.equal(r.data.data.reviewScore, 8);
    assert.equal(r.data.score, before + reward);
    assert.equal(t.pointsAwarded, reward);
    assert.equal(r.data.celebration.earned, reward);
    assert.equal(r.data.celebrateFor, String(t.assignedTo));
    assert.ok(r.data.celebration.newBadges.some((b) => b.key === "first_win"), "first completed task → First Win badge");
    const done = await Notification.findOne({ task: ID.task, type: "task_completed" });
    assert.ok(done && done.message.includes("8/10") && done.message.includes(`total score is now ${before + reward}`), done?.message);
    assert.ok(done.celebration && done.celebration.score === before + reward, "notification carries the win screen data");

    const board = await call("GET", "/api/tasks/scoreboard", { token: T.alice });
    assert.equal(board.status, 200, JSON.stringify(board.data));
    assert.equal(board.data.data.me.points, before + reward);
    assert.ok(board.data.data.me.badges.find((b) => b.key === "first_win").earned);
    assert.ok(board.data.data.leaderboard.some((row) => row.name && row.level?.name), "leaderboard with levels");
    assert.ok(!board.data.data.leaderboard.some((row) => row.name === "Bob"), "other organization not on the leaderboard");

    // assignee can't reopen; assigner reopening takes the reward back
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}/status`, { token: T.alice, json: { status: "In Progress" } })).status, 403);
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}/status`, { token: assignerToken, json: { status: "In Progress" } })).status, 200);
    assert.equal((await User.findOne({ email: "alice@test.io" })).points || 0, before);
  });

  test("subtasks: assigner assigns (with who assigned it), assignee ticks, moves within a shared task", async () => {
    const Notification = (await import("../src/models/Notification.js")).default;
    // shared task for Alice + Dan, created by the Admin
    const g = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Launch prep", assignedUsers: [ID.alice, ID.dan], subtasks: [{ title: "Draft plan" }] } });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    const copies = await Task.find({ name: "Launch prep" });
    assert.equal(copies.length, 2);
    const aliceTask = copies.find((t) => String(t.assignedTo) === ID.alice);
    const danTask = copies.find((t) => String(t.assignedTo) === ID.dan);
    assert.ok(aliceTask.subtasks[0].assignedByName, "creation records who assigned the subtask");

    // assigner gives Alice a subtask → she is notified
    const subtaskForm = new FormData();
    subtaskForm.append("title", "Book the room");
    subtaskForm.append("dueDate", "2030-01-15");
    subtaskForm.append("attachments", new Blob(["room details"], { type: "text/plain" }), "room.txt");
    let r = await call("POST", `/api/tasks/${aliceTask._id}/subtasks`, { token: T.adminA, form: subtaskForm });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const sub = r.data.data[0].subtasks.find((x) => x.title === "Book the room");
    assert.ok(sub.assignedByName && sub.assignedAt);
    assert.equal(sub.dueDate, "2030-01-15");
    assert.equal(sub.attachments.length, 1);
    createdFiles.push(sub.attachments[0].filename);
    assert.equal((await call("GET", `/api/tasks/attachments/${sub.attachments[0].filename}`, { token: T.alice })).status, 200);
    assert.ok(await Notification.findOne({ recipient: ID.alice, type: "task_subtask" }));

    // the assignee can't assign or move, but can tick her own
    assert.equal((await call("POST", `/api/tasks/${aliceTask._id}/subtasks`, { token: T.alice, json: { title: "x" } })).status, 403);
    assert.equal((await call("PATCH", `/api/tasks/${aliceTask._id}/subtasks/${sub._id}`, { token: T.alice, json: { moveTo: String(danTask._id) } })).status, 403);
    r = await call("PATCH", `/api/tasks/${aliceTask._id}/subtasks/${sub._id}`, { token: T.alice, json: { completed: true } });
    assert.equal(r.status, 200);
    assert.ok(r.data.data[0].subtasks.find((x) => x._id === sub._id).completed);
    const deliverable = new FormData();
    deliverable.append("attachments", new Blob(["finished plan"], { type: "text/plain" }), "plan.txt");
    r = await call("PATCH", `/api/tasks/${aliceTask._id}/subtasks/${sub._id}`, { token: T.alice, form: deliverable });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const updatedSub = r.data.data[0].subtasks.find((x) => x._id === sub._id);
    assert.equal(updatedSub.attachments.length, 2);
    createdFiles.push(updatedSub.attachments[1].filename);
    // Dan can't tick Alice's subtask
    assert.equal((await call("PATCH", `/api/tasks/${aliceTask._id}/subtasks/${sub._id}`, { token: T.dan, json: { completed: false } })).status, 404);

    // assigner moves it to Dan
    r = await call("PATCH", `/api/tasks/${aliceTask._id}/subtasks/${sub._id}`, { token: T.adminA, json: { moveTo: String(danTask._id) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!(await Task.findById(aliceTask._id)).subtasks.some((x) => x.title === "Book the room"));
    assert.ok((await Task.findById(danTask._id)).subtasks.some((x) => x.title === "Book the room" && !x.completed));
    // not to an unrelated task
    assert.equal((await call("PATCH", `/api/tasks/${danTask._id}/subtasks/${(await Task.findById(danTask._id)).subtasks[0]._id}`, { token: T.adminA, json: { moveTo: ID.task } })).status, 400);

    await Task.deleteMany({ name: "Launch prep" });
  });

  test("other organization cannot see, edit or delete the task", async () => {
    assert.equal((await call("PATCH", `/api/tasks/${ID.task}`, { token: T.adminB, json: { name: "x" } })).status, 404);
    assert.equal((await call("DELETE", `/api/tasks/${ID.task}`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/tasks/${ID.task}`, { token: T.bob })).status, 404);
  });

  test("Team Member creates, edits and deletes his OWN task; cannot assign others", async () => {
    const c = await call("POST", "/api/tasks", { token: T.alice, json: { name: "Personal todo", assignedUser: ID.alice } });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const e = await call("PATCH", `/api/tasks/${c.data.data.id}`, { token: T.alice, json: { description: "updated" } });
    assert.equal(e.status, 200);
    const d = await call("DELETE", `/api/tasks/${c.data.data.id}`, { token: T.alice });
    assert.equal(d.status, 200);
    const other = await call("POST", "/api/tasks", { token: T.alice, json: { name: "For Sam", assignedUser: "Sam Sales" } });
    assert.equal(other.status, 403);
  });

  test("same-named user in another organization does not break assignment", async () => {
    await call("POST", "/api/users", {
      token: T.adminB, json: { name: "Alice", email: "alice.b@test.io", password: "User@123", role: "User", department: "Development" },
    });
    const r = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Name clash", assignedUser: "Alice", department: "Development" } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(String(r.data.data.assignedTo), ID.alice);
  });

  test("assigning a user from another org or another department is refused", async () => {
    const cross = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "x", assignedUser: ID.bob } });
    assert.equal(cross.status, 403);
    const dept = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "x", assignedUser: ID.sam, department: "Development" } });
    assert.equal(dept.status, 400);
    assert.match(dept.data.message, /not in the "Development" department/);
  });

  test("Admin deletes the task and its files are removed", async () => {
    const r = await call("DELETE", `/api/tasks/${ID.task}`, { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(await Task.findById(ID.task), null);
    assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, ID.file)));
  });
});

describe("Task Bank assignment", () => {
  test("assign creates a real task for the selected user", async () => {
    const item = await call("POST", "/api/taskbank", {
      token: T.adminA,
      json: { title: "Code review", description: "Review the PR", department: "Development", priority: "High" },
    });
    assert.equal(item.status, 201);
    ID.bank = item.data.data._id;

    const r = await call("POST", `/api/taskbank/${ID.bank}/assign`, {
      token: T.adminA, json: { assignedUser: ID.alice, dueDate: "2030-02-01" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.data.lastAssignedTo, "Alice");
    assert.equal(r.data.data.usageCount, 1);

    const mine = await call("GET", "/api/tasks", { token: T.alice });
    const t = mine.data.data.find((x) => x.name === "Code review");
    assert.ok(t, "task visible in the assignee's task list");
    assert.equal(t.assignedUser, "Alice");
    assert.equal(t.dueDate, "2030-02-01");
    assert.equal(String(t.sourceTemplate), ID.bank);

    const reload = await call("GET", "/api/taskbank", { token: T.adminA });
    assert.equal(reload.data.data.find((i) => i._id === ID.bank).lastAssignedTo, "Alice");
  });

  test("missing, foreign and wrong-department users are rejected", async () => {
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: {} })).status, 400);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: { assignedUser: ID.bob } })).status, 403);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminA, json: { assignedUser: ID.sam } })).status, 400);
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.adminB, json: { assignedUser: ID.bob } })).status, 404);
  });

  test("reassign moves the SAME task to another user (no duplicate) and emails both", async () => {
    const before = await Task.countDocuments({ sourceTemplate: ID.bank });
    const r = await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.lastAssignedTo, "Dan");
    assert.equal(await Task.countDocuments({ sourceTemplate: ID.bank }), before, "no new task");
    const t = await Task.findOne({ sourceTemplate: ID.bank });
    assert.equal(String(t.assignedTo), ID.dan);
    const until = Date.now() + 3000;
    while (
      Date.now() < until &&
      !(sentMessages.some((m) => m.to === "dan@test.io" && /Task reassigned to you: Code review/.test(m.subject)) &&
        sentMessages.some((m) => m.to === "alice@test.io" && /Task reassigned: Code review → Dan/.test(m.subject)))
    ) {
      await new Promise((x) => setTimeout(x, 25));
    }
    assert.ok(sentMessages.some((m) => m.to === "dan@test.io" && /Task reassigned to you: Code review/.test(m.subject)));
    assert.ok(sentMessages.some((m) => m.to === "alice@test.io" && /Task reassigned: Code review → Dan/.test(m.subject)));

    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } })).status, 400, "same person");
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.bob } })).status, 403, "other org user");
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminB, json: { assignedUser: ID.bob } })).status, 404, "other org template");
    const fresh = await call("POST", "/api/taskbank", { token: T.adminA, json: { title: "Never assigned", description: "x", department: "Development" } });
    const na = await call("POST", `/api/taskbank/${fresh.data.data._id}/reassign`, { token: T.adminA, json: { assignedUser: ID.dan } });
    assert.equal(na.status, 400);
    // back to Alice so later tests keep their assumptions
    await call("POST", `/api/taskbank/${ID.bank}/reassign`, { token: T.adminA, json: { assignedUser: ID.alice } });
  });

  test("Team Member without taskbank.assign cannot assign; seed is SuperAdmin-only", async () => {
    assert.equal((await call("POST", `/api/taskbank/${ID.bank}/assign`, { token: T.alice, json: { assignedUser: ID.alice } })).status, 403);
    assert.equal((await call("GET", "/api/taskbank/seed")).status, 401);
    assert.equal((await call("GET", "/api/taskbank/seed", { token: T.adminA })).status, 403);
  });
});

describe("Calendar CSV import", () => {
  const csv = [
    "Title,Date,Time,Department,Assignee,Status,Priority,Description",
    "Deploy,2030-03-10,10:30,Development,Alice,Pending,High,Ship it",
    "No date,,09:00,Development,Alice,Pending,Low,",
    "Bad date,2030-02-30,09:00,Development,Alice,Pending,Low,",
    "Ghost,2030-03-11,09:00,Development,Nobody,Pending,Low,",
    "Deploy,2030-03-10,10:30,Development,Alice,Pending,High,dup in file",
    "Bad prio,2030-03-12,09:00,Development,Alice,Pending,Urgent,",
  ].join("\n");

  test("preview validates rows without saving", async () => {
    const before = await Task.countDocuments();
    const r = await call("POST", "/api/tasks/import?preview=true", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.summary, { total: 6, valid: 1, invalid: 4, duplicates: 1 });
    assert.equal(await Task.countDocuments(), before);
  });

  test("import saves valid rows; re-import is detected as duplicate", async () => {
    const r = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.imported, 1);
    const t = await Task.findOne({ name: "Deploy" });
    assert.equal(t.dueTime, "10:30");
    assert.equal(String(t.assignedTo), ID.alice);
    assert.equal(String(t.admin_id), ID.adminA);

    const again = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(again.status, 400);
    assert.equal(again.data.summary.duplicates, 2);
  });

  test("empty, header-only, malformed and non-CSV files are rejected", async () => {
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("Title,Date\n") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("foo,bar\n1,2") })).status, 400);
    assert.equal((await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm("x", "x.txt") })).status, 400);
  });

  test("Team Member (no calendar.import) cannot import", async () => {
    assert.equal((await call("POST", "/api/tasks/import", { token: T.alice, form: csvForm(csv) })).status, 403);
  });
});

describe("Role-based permissions (backend managed)", () => {
  test("Admin loads role config with real user counts", async () => {
    const r = await call("GET", "/api/permissions/roles", { token: T.adminA });
    assert.equal(r.status, 200);
    const user = r.data.data.roles.find((x) => x.role === "User");
    assert.equal(user.users, 3);
    assert.equal(user.isCustomized, false);
  });

  test("revoking a permission takes effect immediately", async () => {
    assert.equal((await call("GET", "/api/taskbank", { token: T.alice })).status, 200);
    const cfg = await call("GET", "/api/permissions/roles", { token: T.adminA });
    const perms = cfg.data.data.roles.find((x) => x.role === "User").permissions;
    perms.taskbank = [];
    const save = await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: perms } });
    assert.equal(save.status, 200, JSON.stringify(save.data));
    assert.equal((await call("GET", "/api/taskbank", { token: T.alice })).status, 403);
    const me = await call("GET", "/api/auth/me", { token: T.alice });
    assert.deepEqual(me.data.data.permissions.taskbank, []);
    // Admin B's users are unaffected (organization isolation)
    assert.equal((await call("GET", "/api/taskbank", { token: T.bob })).status, 200);
  });

  test("SuperAdmin restricts an Admin; the Admin cannot grant what he lacks", async () => {
    const all = (await call("GET", "/api/permissions/admins", { token: T.super })).data.data.find((a) => a._id === ID.adminA).permissions;
    const restricted = { ...all, reports: [] };
    const r = await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: restricted } });
    assert.equal(r.status, 200);

    assert.equal((await call("GET", "/api/reports/summary", { token: T.adminA })).status, 403);
    // Members inherit the cap
    assert.equal((await call("GET", "/api/reports/summary", { token: T.mia })).status, 403);

    const grant = await call("PUT", "/api/permissions/roles/Manager", {
      token: T.adminA, json: { permissions: { ...restricted, reports: ["view"] } },
    });
    assert.equal(grant.status, 403);

    // restore
    await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: all } });
    assert.equal((await call("GET", "/api/reports/summary", { token: T.adminA })).status, 200);
  });

  test("members cannot edit role permissions", async () => {
    assert.equal((await call("PUT", "/api/permissions/roles/User", { token: T.mia, json: { permissions: {} } })).status, 403);
  });
});

describe("Email verification + admin-set passwords", () => {
  test("new account cannot log in before verifying; email never contains the password", async () => {
    const r = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Vera", email: "vera@test.io", password: "Vera@1234", role: "User", department: "Development" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.emailSent, true);
    const blocked = await call("POST", "/api/auth/login", { json: { email: "vera@test.io", password: "Vera@1234" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, "EMAIL_NOT_VERIFIED");
    const mail = [...sentMessages].reverse().find((m) => m.to === "vera@test.io");
    assert.ok(!mail.text.includes("Vera@1234"), "password is not in the email");
    const stored = await User.findOne({ email: "vera@test.io" }).select("+pendingPasswordEnc").lean();
    assert.ok(stored.pendingPasswordEnc && !stored.pendingPasswordEnc.includes("Vera@1234"), "stored encrypted");
    ID.vera = String(stored._id);
  });

  test("verification link reveals the password once, then it is destroyed", async () => {
    const token = tokenFor("vera@test.io");
    const first = await call("POST", "/api/auth/verify-email", { json: { token } });
    assert.equal(first.status, 200);
    assert.equal(first.data.data.password, "Vera@1234");
    assert.equal(first.data.data.visibleForSeconds, 30);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const again = await call("POST", "/api/auth/verify-email", { json: { token } });
    assert.equal(again.status, 404, "link is single-use");
    const stored = await User.findById(ID.vera).select("+pendingPasswordEnc").lean();
    assert.equal(stored.pendingPasswordEnc, null);
    T.vera = await login("vera@test.io", "Vera@1234");
    assert.equal((await call("POST", "/api/auth/verify-email", { json: { token: "abc" } })).status, 400);
  });

  test("expired link is refused", async () => {
    await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Late", email: "late@test.io", password: "Late@1234", role: "User", department: "Development" },
    });
    await User.updateOne({ email: "late@test.io" }, { verificationExpires: new Date(Date.now() - 1000) });
    const r = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("late@test.io") } });
    assert.equal(r.status, 410);
    // admin resends → new working link
    const late = await User.findOne({ email: "late@test.io" });
    const resend = await call("POST", `/api/users/${late._id}/resend-verification`, { token: T.adminA });
    assert.equal(resend.status, 200, JSON.stringify(resend.data));
    const ok = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("late@test.io") } });
    assert.equal(ok.data.data.password, "Late@1234");
  });

  test("forgot password → request + email to the user's Admin → admin sets new password", async () => {
    const r = await call("POST", "/api/auth/forgot-password", { json: { email: "vera@test.io" } });
    assert.equal(r.status, 200);
    const unknown = await call("POST", "/api/auth/forgot-password", { json: { email: "nobody@test.io" } });
    assert.equal(unknown.data.message, r.data.message, "same answer for unknown emails");
    await call("POST", "/api/auth/forgot-password", { json: { email: "vera@test.io" } }); // duplicate ignored

    const notice = [...sentMessages].reverse().find((m) => m.to === "admina@test.io");
    assert.match(notice.subject, /Password reset requested by Vera/);

    const listA = await call("GET", "/api/password-requests", { token: T.adminA });
    assert.equal(listA.data.count, 1);
    assert.equal((await call("GET", "/api/password-requests", { token: T.adminB })).data.count, 0, "other org can't see it");
    assert.equal((await call("GET", "/api/password-requests", { token: T.alice })).status, 403);

    const set = await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminA, json: { password: "Fresh@5678" } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.equal((await call("GET", "/api/password-requests", { token: T.adminA })).data.count, 0, "request completed");

    const reveal = await call("POST", "/api/auth/verify-email", { json: { token: tokenFor("vera@test.io") } });
    assert.equal(reveal.data.data.password, "Fresh@5678");
    await login("vera@test.io", "Fresh@5678");
  });

  test("only the user's own administrator can set passwords", async () => {
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminB, json: { password: "Hack@1234" } })).status, 403);
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.alice, json: { password: "Hack@1234" } })).status, 403);
    assert.equal((await call("POST", `/api/users/${ID.vera}/set-password`, { token: T.adminA, json: { password: "123" } })).status, 400);
  });

  test("Admin's forgot-password request goes to the SuperAdmin", async () => {
    await call("POST", "/api/auth/forgot-password", { json: { email: "adminB@test.io" } });
    const list = await call("GET", "/api/password-requests", { token: T.super });
    assert.ok(list.data.data.some((x) => x.user.email === "adminb@test.io"));
    const notice = [...sentMessages].reverse().find((m) => m.to === "root@test.io");
    assert.match(notice.subject, /Admin B/);
  });
});

describe("Task email notifications + reminders", () => {
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const mailsTo = (email, rx) => sentMessages.filter((m) => m.to === email && rx.test(m.subject));
  let svc;
  let taskId;
  let deadline;

  before(async () => {
    svc = await import("../src/services/taskNotificationService.js");
  });

  test("assigning a task emails the assignee and adds a dashboard notification", async () => {
    const r = await call("POST", "/api/tasks", {
      token: T.adminA,
      json: { name: "Notify me", assignedUser: ID.dan, department: "Development", dueDate: "2031-03-10", dueTime: "15:00" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    taskId = r.data.data.id;
    assert.ok(await waitFor(() => mailsTo("dan@test.io", /New task assigned: Notify me/).length === 1), "assignment email");
    const n = await call("GET", "/api/notifications", { token: T.dan });
    assert.ok(n.data.data.some((x) => x.type === "task_assigned" && x.taskName === "Notify me"));
    deadline = svc.deadlineOf(await Task.findById(taskId));
    assert.equal(deadline.toISOString(), "2031-03-10T09:30:00.000Z", "15:00 Asia/Kolkata");
  });

  test("reminder 1 at 3h, reminder 2 at 1h, each sent once", async () => {
    const at = (ms) => new Date(deadline.getTime() + ms);
    const H = 3600 * 1000;
    assert.deepEqual(await svc.runTaskReminderSweep(at(-4 * H)), { reminder3h: 0, reminder1h: 0, overdue: 0 });
    assert.equal((await svc.runTaskReminderSweep(at(-2.5 * H))).reminder3h, 1);
    assert.equal((await svc.runTaskReminderSweep(at(-2.4 * H))).reminder3h, 0, "not repeated");
    assert.equal((await svc.runTaskReminderSweep(at(-0.5 * H))).reminder1h, 1);
    assert.equal(mailsTo("dan@test.io", /Reminder 1: "Notify me" is due in 3 hours/).length, 1);
    assert.equal(mailsTo("dan@test.io", /Reminder 2: "Notify me" is due in 1 hour/).length, 1);
  });

  test("deadline reached while not started → alert to user AND the assigner", async () => {
    const r = await svc.runTaskReminderSweep(new Date(deadline.getTime() + 60 * 1000));
    assert.equal(r.overdue, 1);
    assert.equal(mailsTo("dan@test.io", /Deadline reached: please start "Notify me"/).length, 1);
    assert.equal(mailsTo("admina@test.io", /Dan has not started "Notify me"/).length, 1);
    assert.equal((await svc.runTaskReminderSweep(new Date(deadline.getTime() + 5 * 60 * 1000))).overdue, 0, "once only");
    const n = await call("GET", "/api/notifications", { token: T.adminA });
    assert.ok(n.data.data.some((x) => x.type === "task_overdue" && x.actorName === "Dan"));
  });

  test("started tasks get no reminders; old missed deadlines are not alerted", async () => {
    const started = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Already going", assignedUser: ID.dan, dueDate: "2031-04-01", dueTime: "12:00" },
    });
    await call("PATCH", `/api/tasks/${started.data.data.id}/status`, { token: T.dan, json: { status: "In Progress" } });
    const old = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Long overdue", assignedUser: ID.dan, dueDate: "2031-04-01", dueTime: "12:00" },
    });
    const d = svc.deadlineOf(await Task.findById(old.data.data.id));
    const r1 = await svc.runTaskReminderSweep(new Date(d.getTime() - 2 * 3600 * 1000));
    assert.equal(r1.reminder3h, 1, "only the not-started task");
    const r2 = await svc.runTaskReminderSweep(new Date(d.getTime() + 5 * 3600 * 1000));
    assert.equal(r2.overdue, 0, "missed more than 2h ago → no alert");
  });

  test("status change emails the assigner and shows who changed it on their dashboard", async () => {
    const r = await call("PATCH", `/api/tasks/${taskId}/status`, { token: T.dan, json: { status: "In Progress" } });
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => mailsTo("admina@test.io", /Dan moved "Notify me" to In Progress/).length === 1));
    const n = await call("GET", "/api/notifications?type=task_status", { token: T.adminA });
    const item = n.data.data.find((x) => x.taskName === "Notify me");
    assert.equal(item.actorName, "Dan");
    assert.equal(item.fromStatus, "To Do");
    assert.equal(item.toStatus, "In Progress");
    assert.ok(n.data.unread >= 1);
    // only my own notifications; mark read
    const other = await call("GET", "/api/notifications?type=task_status", { token: T.adminB });
    assert.ok(!other.data.data.some((x) => x.taskName === "Notify me"));
    assert.equal((await call("PATCH", `/api/notifications/${item._id}/read`, { token: T.adminB })).status, 404);
    assert.equal((await call("PATCH", `/api/notifications/${item._id}/read`, { token: T.adminA })).status, 200);
    assert.equal((await call("PATCH", "/api/notifications/read-all", { token: T.adminA })).status, 200);
    assert.equal((await call("GET", "/api/notifications", { token: T.adminA })).data.unread, 0);
  });

  test("reassigning emails the new AND the previous assignee", async () => {
    const t = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Hand over", assignedUser: ID.dan, department: "Development" },
    });
    await waitFor(() => mailsTo("dan@test.io", /New task assigned: Hand over/).length === 1);

    const r = await call("PATCH", `/api/tasks/${t.data.data.id}`, {
      token: T.adminA, json: { assignedUser: ID.alice },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(await waitFor(() => mailsTo("alice@test.io", /Task reassigned to you: Hand over/).length === 1), "new assignee");
    assert.ok(await waitFor(() => mailsTo("dan@test.io", /Task reassigned: Hand over → Alice/).length === 1), "previous assignee");
    assert.equal(mailsTo("alice@test.io", /New task assigned: Hand over/).length, 0, "no duplicate plain assignment email");
    const n = await call("GET", "/api/notifications", { token: T.dan });
    assert.ok(n.data.data.some((x) => x.type === "task_reassigned" && /no longer assigned to you/.test(x.message)));

    // saving the form with the same assignee is NOT a reassignment
    const before = sentMessages.length;
    await call("PATCH", `/api/tasks/${t.data.data.id}`, { token: T.adminA, json: { assignedUser: ID.alice, description: "x" } });
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(sentMessages.slice(before).filter((m) => /reassigned/i.test(m.subject)).length, 0);

    // Manager can reassign too; unassigning tells the previous person
    await call("PATCH", `/api/tasks/${t.data.data.id}`, { token: T.mia, json: { assignedUser: "" } });
    assert.ok(await waitFor(() => mailsTo("alice@test.io", /you were removed from Hand over/).length === 1), "removed notice");
  });

  test("users who turned off email notifications still get dashboard notifications only", async () => {
    await call("PUT", "/api/auth/me/preferences", { token: T.dan, json: { emailNotifications: false } });
    const before = sentMessages.length;
    await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Quiet task", assignedUser: ID.dan } });
    await waitFor(async () => (await call("GET", "/api/notifications", { token: T.dan })).data.data.some((x) => x.taskName === "Quiet task"));
    assert.equal(sentMessages.slice(before).filter((m) => m.to === "dan@test.io").length, 0);
    await call("PUT", "/api/auth/me/preferences", { token: T.dan, json: { emailNotifications: true } });
  });
});

describe("Task updates from the assignment email (no login)", () => {
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const mailTo = (email, rx) => [...sentMessages].reverse().find((m) => m.to === email && rx.test(m.subject));
  const linkToken = (mail) => mail?.text.match(/task-action\/([^\s?]+)/)?.[1];
  let taskId;
  let token;

  test("the assignment email carries a task link; the page shows the task and what can be done", async () => {
    const r = await call("POST", "/api/tasks", {
      token: T.adminA, json: { name: "Email flow", assignedUser: ID.dan, department: "Development", dueDate: "2031-05-01" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    taskId = r.data.data.id;
    assert.ok(await waitFor(() => Boolean(mailTo("dan@test.io", /New task assigned: Email flow/))));
    const mail = mailTo("dan@test.io", /New task assigned: Email flow/);
    token = decodeURIComponent(linkToken(mail));
    assert.ok(token, "link in the text email");
    assert.match(mail.html, /Start working/);
    assert.match(mail.html, /Send for review/);

    const page = await call("GET", `/api/task-email/${token}`);
    assert.equal(page.status, 200, JSON.stringify(page.data));
    assert.equal(page.data.data.name, "Email flow");
    assert.equal(page.data.data.assignee, "Dan");
    assert.deepEqual(page.data.data.options, ["In Progress", "Review"]);
  });

  test("the email token is not a login token; bad tokens never answer 401", async () => {
    assert.equal((await call("GET", "/api/auth/me", { token })).status, 401);
    assert.equal((await call("GET", "/api/task-email/not-a-token")).status, 410);
  });

  test("opening the page tells the assigner once and shows 'seen' in the app", async () => {
    assert.equal((await call("POST", `/api/task-email/${token}/view`)).status, 200);
    assert.equal((await call("POST", `/api/task-email/${token}/view`)).status, 200);
    const n = await call("GET", "/api/notifications", { token: T.adminA });
    assert.equal(n.data.data.filter((x) => x.type === "task_viewed" && x.taskName === "Email flow").length, 1);
    const t = await call("GET", `/api/tasks/${taskId}`, { token: T.adminA });
    assert.ok(t.data.data.emailViewedAt, "seen time in the app");
  });

  test("status updates from the email follow the app rules and reach the assigner", async () => {
    const done = await call("POST", `/api/task-email/${token}/status`, { json: { status: "Completed" } });
    assert.equal(done.status, 409, "Completed stays with the assigner's review");

    const r = await call("POST", `/api/task-email/${token}/status`, { json: { status: "In Progress", note: "on it" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.status, "In Progress");
    assert.ok(await waitFor(() => Boolean(mailTo("admina@test.io", /Dan moved "Email flow" to In Progress/))), "assigner emailed");
    const n = await call("GET", "/api/notifications?type=task_status", { token: T.adminA });
    assert.ok(n.data.data.some((x) => x.taskName === "Email flow" && x.toStatus === "In Progress" && x.actorName === "Dan"));

    const t = await call("GET", `/api/tasks/${taskId}`, { token: T.adminA });
    assert.equal(t.data.data.status, "In Progress");
    assert.ok(t.data.data.emailUpdatedAt);
    assert.equal(t.data.data.statusHistory.at(-1).note, "Updated from email: on it");

    assert.equal((await call("POST", `/api/task-email/${token}/status`, { json: { status: "Review" } })).status, 200);
    const waiting = await call("POST", `/api/task-email/${token}/status`, { json: { status: "In Progress" } });
    assert.equal(waiting.status, 409, "in Review → waiting for the assigner");
    assert.deepEqual(waiting.data.data.options, []);
  });

  test("after reassignment the old email link stops working", async () => {
    await call("PATCH", `/api/tasks/${taskId}`, { token: T.adminA, json: { assignedUser: ID.alice } });
    assert.equal((await call("GET", `/api/task-email/${token}`)).status, 403);
    assert.equal((await call("POST", `/api/task-email/${token}/status`, { json: { status: "In Progress" } })).status, 403);
  });
});

describe("Settings", () => {
  test("profile and preferences persist; protected fields ignored", async () => {
    const r = await call("PUT", "/api/auth/me", {
      token: T.alice, json: { name: "Alice Wonder", phone: "9876543210", bio: "hi", department: "Sales", role: "Admin" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const me = await call("GET", "/api/auth/me", { token: T.alice });
    assert.equal(me.data.data.name, "Alice Wonder");
    assert.equal(me.data.data.department, "Development", "members cannot move themselves to another department");
    assert.equal(me.data.data.role, "User");

    const p = await call("PUT", "/api/auth/me/preferences", { token: T.alice, json: { taskReminders: false, timezone: "Europe/London" } });
    assert.equal(p.status, 200);
    const again = await call("GET", "/api/auth/me", { token: T.alice });
    assert.equal(again.data.data.preferences.taskReminders, false);
    assert.equal(again.data.data.preferences.timezone, "Europe/London");
    assert.equal((await call("PUT", "/api/auth/me/preferences", { token: T.alice, json: { timezone: "Mars" } })).status, 400);
  });

  test("password change validates current password", async () => {
    const bad = await call("PUT", "/api/auth/change-password", { token: T.alice, json: { currentPassword: "nope", newPassword: "Next@123" } });
    assert.equal(bad.status, 400);
    const ok = await call("PUT", "/api/auth/change-password", { token: T.alice, json: { currentPassword: "User@123", newPassword: "Next@123" } });
    assert.equal(ok.status, 200);
    T.alice = await login("alice@test.io", "Next@123");
  });
});

describe("Organization isolation — MoM meetings and support tickets", () => {
  test("meetings are visible only inside the creator's organization", async () => {
    const Meeting = (await import("../src/models/Meeting.js")).default;
    const m = await Meeting.create({ title: "Org A sync", meetingDate: new Date("2030-01-01"), createdBy: ID.adminA });
    const listA = await call("GET", "/api/meetings", { token: T.adminA });
    assert.ok(listA.data.data.some((x) => x._id === String(m._id)), "same-org admin sees it");
    const listB = await call("GET", "/api/meetings", { token: T.adminB });
    assert.ok(!listB.data.data.some((x) => x._id === String(m._id)), "other org does not");
    assert.equal((await call("GET", `/api/meetings/${m._id}`, { token: T.bob })).status, 404);
    assert.equal((await call("DELETE", `/api/meetings/${m._id}`, { token: T.adminB })).status, 404);
    assert.ok(await Meeting.findById(m._id), "not deleted by other org");
    const all = await call("GET", "/api/meetings", { token: T.super });
    assert.ok(all.data.data.some((x) => x._id === String(m._id)), "SuperAdmin sees all");
  });

  test("meetings: only the creator, invited attendees and the org admin; only creator / admin delete", async () => {
    const m = await call("POST", "/api/meetings", { token: T.dan, json: {
      title: "Dan's 1:1", meetingDate: "2031-09-01", meetingType: "Offline",
      attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }],
    } });
    const id = m.data.data._id;
    const sees = async (token) => (await call("GET", "/api/meetings", { token })).data.data.some((x) => x._id === id);
    assert.equal(await sees(T.dan), true, "creator");
    assert.equal(await sees(T.alice), true, "invited attendee");
    assert.equal(await sees(T.adminA), true, "org admin");
    assert.equal(await sees(T.mia), false, "same org (Manager), not invited");
    assert.equal(await sees(T.adminB), false, "other org");
    assert.equal((await call("GET", `/api/meetings/${id}`, { token: T.mia })).status, 404);
    assert.equal((await call("GET", `/api/meetings/${id}/transcript`, { token: T.mia })).status, 404);
    assert.equal((await call("PUT", `/api/meetings/${id}`, { token: T.mia, json: { title: "x" } })).status, 404);
    assert.equal((await call("GET", `/api/meetings/${id}`, { token: T.alice })).status, 200);

    // An attendee added by email only (no account link) also sees it
    await call("PUT", `/api/meetings/${id}`, { token: T.dan, json: { attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }, { name: "Mia", email: "mia@test.io" }] } });
    assert.equal(await sees(T.mia), true, "invited by email");

    assert.equal((await call("DELETE", `/api/meetings/${id}`, { token: T.alice })).status, 403, "attendee cannot delete");
    assert.equal((await call("DELETE", `/api/meetings/${id}`, { token: T.dan })).status, 200, "creator deletes");
  });

  test("tickets: owner + own org admin only", async () => {
    const t = await call("POST", "/api/support/tickets", { token: T.alice, json: { subject: "Help", message: "Broken" } });
    assert.equal(t.status, 201);
    const id = t.data.data.id;
    assert.equal((await call("GET", `/api/support/tickets/${id}`, { token: T.adminB })).status, 404);
    assert.equal((await call("DELETE", `/api/support/tickets/${id}`, { token: T.bob })).status, 404);
    assert.equal((await call("PATCH", `/api/support/tickets/${id}`, { token: T.adminB, json: { status: "Closed" } })).status, 404);
    assert.equal((await call("GET", `/api/support/tickets/${id}`, { token: T.adminA })).status, 200);
    const stats = await call("GET", "/api/support/tickets/stats", { token: T.adminB });
    assert.equal(stats.data.data.total, 0, "stats are org-scoped");
    assert.equal((await call("PATCH", `/api/support/tickets/${id}`, { token: T.adminA, json: { status: "Resolved" } })).status, 200);
    assert.equal((await call("POST", "/api/support/faqs", { token: T.alice, json: { question: "q", answer: "a" } })).status, 403);
  });
});

describe("MoM — points, action plans, multiple users, recording, transcript", () => {
  let mid;

  test("discussion points, action plans (multiple owners) and members are saved", async () => {
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Sprint review", meetingDate: "2031-02-01", meetingType: "Offline",
        departments: ["Development"], recording: true, transcription: true,
        attendees: [
          { name: "Alice", email: "alice@test.io", userId: ID.alice },
          { name: "Dan", email: "dan@test.io", userId: ID.dan },
        ],
        points: [{ title: "Velocity dropped" }, { title: "Release plan", completed: true }],
        actions: [{
          title: "Fix flaky tests",
          owners: [{ userId: ID.alice, name: "Alice", email: "alice@test.io" }, { userId: ID.dan, name: "Dan" }],
          owner: "Alice, Dan", dueDate: "2031-02-05",
        }],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    mid = r.data.data._id;
    const g = await call("GET", `/api/meetings/${mid}`, { token: T.alice });
    const m = g.data.data;
    assert.equal(m.points.length, 2);
    assert.equal(m.points[1].completed, true);
    assert.equal(m.actions[0].owners.length, 2);
    assert.deepEqual(m.departments, ["Development"]);
    assert.equal(m.recording, true);
    assert.equal(m.transcription, true);
    assert.equal(m.attendees.length, 2);
  });

  test("participants list = my organization only", async () => {
    const r = await call("GET", "/api/meetings/participants", { token: T.alice });
    assert.equal(r.status, 200);
    const emails = r.data.data.map((u) => u.email);
    assert.ok(emails.includes("dan@test.io") && emails.includes("admina@test.io"));
    assert.ok(!emails.includes("bob@test.io"), "other org excluded");
  });

  test("recording upload → stream (with range) → org isolation → delete", async () => {
    const f = new FormData();
    f.append("durationSec", "42");
    f.append("recording", new Blob([Buffer.alloc(2048, 7)], { type: "video/webm" }), "meeting.webm");
    const up = await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: f });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.data.durationSec, 42);

    const res = await fetch(`${base}/api/meetings/${mid}/recording`, {
      headers: { Authorization: `Bearer ${T.dan}`, Range: "bytes=0-99" },
    });
    assert.equal(res.status, 206, "seekable stream");
    assert.equal((await res.arrayBuffer()).byteLength, 100);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`, { token: T.adminB })).status, 404);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`)).status, 401);

    // browser-style codec label and generic octet-stream are both accepted
    const codec = new FormData();
    codec.append("recording", new Blob([Buffer.alloc(64, 1)], { type: "video/webm;codecs=vp9,opus" }), "meeting.webm");
    assert.equal((await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: codec })).status, 201);
    const generic = new FormData();
    generic.append("recording", new Blob([Buffer.alloc(64, 1)], { type: "application/octet-stream" }), "meeting.webm");
    const g2 = await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: generic });
    assert.equal(g2.status, 201);
    assert.equal(g2.data.data.mimetype, "video/webm");

    const bad = new FormData();
    bad.append("recording", new Blob(["x"], { type: "application/pdf" }), "x.pdf");
    assert.equal((await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: bad })).status, 400);

    const del = await call("DELETE", `/api/meetings/${mid}/recording`, { token: T.adminA });
    assert.equal(del.status, 200);
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`, { token: T.adminA })).status, 404);
  });

  test("transcript import (Google Meet export) shows speakers; live lines append", async () => {
    const imp = await call("POST", `/api/meetings/${mid}/transcript/import`, {
      token: T.adminA, json: { text: "Transcript\n00:00:05\nAlice: Hello everyone\nDan: Status is green" },
    });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.deepEqual(imp.data.data.transcript.entries.map((e) => e.speaker), ["Alice", "Dan"]);

    await call("PUT", `/api/meetings/${mid}/transcript`, {
      token: T.adminA, json: { source: "live", entries: [{ speaker: "Admin A", text: "First live line", at: new Date().toISOString() }] },
    });
    const app2 = await call("PUT", `/api/meetings/${mid}/transcript`, {
      token: T.adminA, json: { source: "live", append: true, entries: [{ speaker: "Admin A", text: "Second" }] },
    });
    assert.equal(app2.data.data.transcript.entries.length, 2);
    assert.equal(app2.data.data.transcript.source, "live");

    assert.equal((await call("POST", `/api/meetings/${mid}/transcript/import`, { token: T.adminA, json: { text: "  " } })).status, 400);
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript`, { token: T.adminB, json: { entries: [{ text: "x" }] } })).status, 404);
  });

  test("Google Meet transcript fetch (fake Meet API) + clear message without a Meet link", async () => {
    const { app } = await import("../src/app.js");
    await Meeting().updateOne({ _id: mid }, { googleMeetLink: "https://meet.google.com/abc-defg-hij" });
    app.set("meetClient", {
      conferenceRecords: {
        list: async ({ filter }) => ({ data: { conferenceRecords: filter.includes("abc-defg-hij") ? [{ name: "conferenceRecords/c1", startTime: "2031-02-01T10:00:00Z" }] : [] } }),
        recordings: { list: async () => ({ data: { recordings: [{ driveDestination: { exportUri: "https://drive.google.com/rec1" } }] } }) },
        transcripts: {
          list: async () => ({ data: { transcripts: [{ name: "conferenceRecords/c1/transcripts/t1" }] } }),
          entries: { list: async () => ({ data: { transcriptEntries: [
            { participant: "conferenceRecords/c1/participants/p1", text: "Let's begin", startTime: "2031-02-01T10:01:00Z" },
            { participant: "conferenceRecords/c1/participants/p2", text: "Ready", startTime: "2031-02-01T10:01:05Z" },
          ] } }) },
        },
        participants: { get: async ({ name }) => ({ data: { signedinUser: { displayName: name.endsWith("p1") ? "Priya" : "Ravi" } } }) },
      },
    });
    const r = await call("POST", `/api/meetings/${mid}/transcript/google`, { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.data.transcript.entries.map((e) => `${e.speaker}: ${e.text}`), ["Priya: Let's begin", "Ravi: Ready"]);
    assert.equal(r.data.data.googleRecordingUrl, "https://drive.google.com/rec1");
    app.set("meetClient", undefined);

    const noLink = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "No link", meetingDate: "2031-02-02", meetingType: "Offline" } });
    const r2 = await call("POST", `/api/meetings/${noLink.data.data._id}/transcript/google`, { token: T.adminA });
    assert.equal(r2.status, 400);
    assert.equal(r2.data.code, "NO_MEET_LINK");
  });

  test("generic meeting update cannot overwrite recording/transcript", async () => {
    await call("PUT", `/api/meetings/${mid}`, { token: T.adminA, json: { transcript: { entries: [] }, recordingFile: { filename: "../../x" } } });
    const g = await call("GET", `/api/meetings/${mid}`, { token: T.adminA });
    assert.equal(g.data.data.transcript.entries.length, 2);
  });
});

describe("MoM — video call link (WebRTC) + invitation", () => {
  test("integration status: video is built in; email problems are explained", async () => {
    const r = await call("GET", "/api/meetings/integration-status", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(r.data.data.video.ok, true);
    assert.equal(r.data.data.email.ok, false);
  });

  test("an online meeting gets its own private video link; resending keeps the same link", async () => {
    const r = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Online sync", meetingDate: "2031-03-01", startTime: "10:00" } });
    assert.equal(r.status, 201);
    assert.match(r.data.integration.videoLink, /\/meet\/[A-Za-z0-9_-]{22}$/);
    assert.equal(r.data.data.videoLink, r.data.integration.videoLink);
    const retry = await call("POST", `/api/meetings/${r.data.data._id}/send-invitation`, { token: T.adminA });
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.data.videoLink, r.data.integration.videoLink);
  });

  test("client-supplied (fake) links are ignored", async () => {
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: { title: "Fake link", meetingDate: "2031-03-02", meetingType: "Offline", googleMeetLink: "https://meet.google.com/abc-defg-hij", videoLink: "https://evil.example/x", videoRoomId: "mine" },
    });
    assert.equal(r.data.data.googleMeetLink, "");
    assert.equal(r.data.data.videoLink, "");
    assert.equal(r.data.data.videoRoomId, "");
  });

  test("expired Google token is explained as 'reconnect Google'", async () => {
    const { explainGoogleCalendarError } = await import("../src/services/googleCalendarService.js");
    const e = explainGoogleCalendarError({ response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
    assert.equal(e.code, "GOOGLE_RECONNECT");
    assert.equal(e.status, 503);
    assert.match(e.message, /npm run google:token/);
  });
});

describe("MoM — transcript from the recording (local Whisper)", () => {
  const poll = async (id, token, until) => {
    const end = Date.now() + 4000;
    let last;
    while (Date.now() < end) {
      last = (await call("GET", `/api/meetings/${id}/transcript`, { token })).data.data.transcript;
      if (until(last)) return last;
      await new Promise((r) => setTimeout(r, 30));
    }
    return last;
  };
  const upload = (id, token) => {
    const f = new FormData();
    f.append("durationSec", "12");
    f.append("recording", new Blob([Buffer.alloc(4096, 3)], { type: "video/webm" }), "meeting.webm");
    return call("POST", `/api/meetings/${id}/recording`, { token, form: f });
  };

  test("uploading a recording (transcription on) creates the transcript automatically", async () => {
    const { setTranscriber } = await import("../src/services/transcriptionService.js");
    setTranscriber(async () => ({ seconds: 12, segments: [{ text: "Welcome everyone", start: 0 }, { text: "Let's review the sprint", start: 4.2 }] }));
    const m = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Whisper sync", meetingDate: "2031-06-01", startTime: "10:00", meetingType: "Offline", transcription: true, recording: true } });
    const id = m.data.data._id;
    const up = await upload(id, T.adminA);
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.transcribing, true);
    const t = await poll(id, T.adminA, (x) => x?.status === "done");
    assert.equal(t.status, "done");
    assert.equal(t.source, "whisper");
    assert.deepEqual(t.entries.map((e) => [e.text, e.offsetSec]), [["Welcome everyone", 0], ["Let's review the sprint", 4.2]]);
    ID.whisperMeeting = id;
  });

  test("failure is reported on the meeting; manual re-run works; guards", async () => {
    const { setTranscriber } = await import("../src/services/transcriptionService.js");
    setTranscriber(async () => { throw new Error("The recording is silent."); });
    const r = await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminA });
    assert.equal(r.status, 202);
    const failed = await poll(ID.whisperMeeting, T.adminA, (x) => x?.status === "failed");
    assert.match(failed.error, /silent/);

    setTranscriber(async () => ({ seconds: 3, segments: [{ text: "Second try", start: 0 }] }));
    await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminA });
    const ok = await poll(ID.whisperMeeting, T.adminA, (x) => x?.status === "done");
    assert.equal(ok.entries[0].text, "Second try");

    const noRec = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "No rec", meetingDate: "2031-06-02", meetingType: "Offline" } });
    assert.equal((await call("POST", `/api/meetings/${noRec.data.data._id}/transcript/whisper`, { token: T.adminA })).status, 400);
    assert.equal((await call("POST", `/api/meetings/${ID.whisperMeeting}/transcript/whisper`, { token: T.adminB })).status, 404);
  });
});

describe("MoM — transcription language and speakers", () => {
  const poll = async (id, token, until) => {
    const end = Date.now() + 4000;
    let last;
    while (Date.now() < end) {
      last = (await call("GET", `/api/meetings/${id}/transcript`, { token })).data.data.transcript;
      if (until(last)) return last;
      await new Promise((r) => setTimeout(r, 30));
    }
    return last;
  };
  const upload = (id, token, language) => {
    const f = new FormData();
    if (language) f.append("language", language);
    f.append("durationSec", "12");
    f.append("recording", new Blob([Buffer.alloc(4096, 3)], { type: "audio/mpeg" }), "call.mp3");
    return call("POST", `/api/meetings/${id}/recording`, { token, form: f });
  };
  let mid;

  test("language list, English default, validation on create / update / upload", async () => {
    const l = await call("GET", "/api/meetings/transcription-languages", { token: T.alice });
    assert.equal(l.status, 200);
    assert.equal(l.data.data.default, "en");
    const codes = l.data.data.languages.map((x) => x.code);
    for (const c of ["en", "ta", "hi", "te", "ml", "kn"]) assert.ok(codes.includes(c), c);

    const m = await call("POST", "/api/meetings", { token: T.adminA, json: {
      title: "Lang sync", meetingDate: "2031-07-01", meetingType: "Offline", transcription: true, recording: true,
      attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }, { name: "Dan", email: "dan@test.io", userId: ID.dan }],
    } });
    mid = m.data.data._id;
    assert.equal(m.data.data.transcriptionLanguage, "en");
    assert.equal((await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Bad", meetingDate: "2031-07-01", meetingType: "Offline", transcriptionLanguage: "xx" } })).status, 400);
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript/language`, { token: T.adminA, json: { language: "klingon" } })).status, 400);
    const ok = await call("PUT", `/api/meetings/${mid}/transcript/language`, { token: T.adminA, json: { language: "auto" } });
    assert.equal(ok.data.data.transcriptionLanguage, "auto");
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript/language`, { token: T.adminB, json: { language: "ta" } })).status, 404);
    assert.equal((await upload(mid, T.adminA, "zz")).status, 400);
  });

  test("uploaded audio is transcribed in the chosen language, split by speaker", async () => {
    const { setTranscriber } = await import("../src/services/transcriptionService.js");
    let seen;
    setTranscriber(async (file, options) => {
      seen = options;
      return { seconds: 9, language: "ta", segments: [
        { text: "Vanakkam", start: 0, end: 2, speakerIndex: 0 },
        { text: "Hello", start: 2, end: 4, speakerIndex: 1 },
        { text: "Let's start", start: 4, end: 6, speakerIndex: 0 },
      ] };
    });
    const up = await upload(mid, T.adminA, "ta");
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const t = await poll(mid, T.adminA, (x) => x?.status === "done");
    assert.equal(seen.language, "ta");
    assert.equal(seen.maxSpeakers, 3);
    assert.equal(t.language, "ta");
    assert.deepEqual(t.entries.map((e) => [e.speaker, e.speakerId, e.offsetSec, e.endSec]), [
      ["Speaker 1", "S1", 0, 2], ["Speaker 2", "S2", 2, 4], ["Speaker 1", "S1", 4, 6],
    ]);
    assert.deepEqual(t.speakers.map((s) => s.label), ["Speaker 1", "Speaker 2"]);

    // re-run with auto-detect → detected language is kept
    await call("POST", `/api/meetings/${mid}/transcript/whisper`, { token: T.adminA, json: { language: "auto" } });
    const t2 = await poll(mid, T.adminA, (x) => x?.status === "done" && x.language === "auto");
    assert.equal(seen.language, "auto");
    assert.equal(t2.detectedLanguage, "ta");
    assert.equal((await call("POST", `/api/meetings/${mid}/transcript/whisper`, { token: T.adminA, json: { language: "nope" } })).status, 400);
  });

  test("assigning attendees renames every line; unassign restores the label; guards", async () => {
    const r = await call("PUT", `/api/meetings/${mid}/transcript/speakers`, { token: T.adminA, json: { speakers: [
      { id: "S1", name: "Alice", userId: ID.alice }, { id: "S2", name: "Dan", userId: ID.dan },
    ] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.data.transcript.entries.map((e) => e.speaker), ["Alice", "Dan", "Alice"]);
    assert.equal(r.data.data.transcript.speakers[0].email, "alice@test.io");
    const again = (await call("GET", `/api/meetings/${mid}`, { token: T.alice })).data.data.transcript;
    assert.deepEqual(again.entries.map((e) => e.speaker), ["Alice", "Dan", "Alice"]);

    // Every read path shows the mapped name — even if a line still has an old label stored
    await Meeting().updateOne({ _id: mid }, { $set: { "transcript.entries.1.speaker": "Speaker 2" } });
    const byId = (await call("GET", `/api/meetings/${mid}`, { token: T.alice })).data.data.transcript;
    const list = (await call("GET", "/api/meetings", { token: T.alice })).data.data.find((x) => x._id === mid).transcript;
    const tr = (await call("GET", `/api/meetings/${mid}/transcript`, { token: T.alice })).data.data.transcript;
    for (const t of [byId, list, tr]) assert.deepEqual(t.entries.map((e) => e.speaker), ["Alice", "Dan", "Alice"]);

    const back = await call("PUT", `/api/meetings/${mid}/transcript/speakers`, { token: T.adminA, json: { speakers: [{ id: "S2", name: "" }] } });
    assert.deepEqual(back.data.data.transcript.entries.map((e) => e.speaker), ["Alice", "Speaker 2", "Alice"]);
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript/speakers`, { token: T.adminA, json: { speakers: [{ id: "S9", name: "X" }] } })).status, 400);
    assert.equal((await call("PUT", `/api/meetings/${mid}/transcript/speakers`, { token: T.adminB, json: { speakers: [{ id: "S1", name: "X" }] } })).status, 404);
  });

  test("editing a line: text, speaker, split to a new speaker, conflict guard", async () => {
    const url = `/api/meetings/${mid}/transcript/entries`;
    const e = await call("PATCH", `${url}/1`, { token: T.adminA, json: { text: "Hello all", speakerId: "S1", original: "Hello" } });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    const line = e.data.data.transcript.entries[1];
    assert.deepEqual([line.text, line.speaker, line.edited], ["Hello all", "Alice", true]);
    const split = await call("PATCH", `${url}/2`, { token: T.adminA, json: { speakerId: "new" } });
    assert.equal(split.data.data.transcript.entries[2].speaker, "Speaker 3");
    assert.equal((await call("PATCH", `${url}/1`, { token: T.adminA, json: { text: "x", original: "stale" } })).status, 409);
    assert.equal((await call("PATCH", `${url}/1`, { token: T.adminA, json: { text: "  " } })).status, 400);
    assert.equal((await call("PATCH", `${url}/99`, { token: T.adminA, json: { text: "x" } })).status, 404);
    assert.equal((await call("PATCH", `${url}/0`, { token: T.adminA, json: { speakerId: "S42" } })).status, 400);
  });

  test("imported / Google names that match an attendee are linked; others stay as labels", async () => {
    const imp = await call("POST", `/api/meetings/${mid}/transcript/import`, { token: T.adminA, json: { text: "Alice: Hi\nGuest: Hello\nAlice: Bye" } });
    const t = imp.data.data.transcript;
    assert.deepEqual(t.entries.map((e) => e.speakerId), ["S1", "S2", "S1"]);
    assert.equal(String(t.speakers[0].userId), ID.alice);
    assert.equal(t.speakers[1].name, "");
  });
});

describe("MoM — speaker names from voice profiles", () => {
  const poll = async (id, token, until) => {
    const end = Date.now() + 4000;
    let last;
    while (Date.now() < end) {
      last = (await call("GET", `/api/meetings/${id}/transcript`, { token })).data.data.transcript;
      if (until(last)) return last;
      await new Promise((r) => setTimeout(r, 30));
    }
    return last;
  };
  const sample = (consent = "1") => {
    const f = new FormData();
    f.append("consent", consent);
    f.append("sample", new Blob([Buffer.alloc(2048, 1)], { type: "audio/webm" }), "voice.webm");
    return f;
  };
  const ALICE = [1, 0, 0, 0], DAN = [0, 1, 0, 0], STRANGER = [0, 0, 1, 0];
  let mid;

  test("record / read / delete my voice profile (consent required, vector never returned)", async () => {
    const svc = await import("../src/services/transcriptionService.js");
    svc.setVoiceprinter(async () => ({ embedding: ALICE, seconds: 9 }));
    assert.equal((await call("POST", "/api/meetings/voice-profile", { token: T.alice, form: sample("0") })).status, 400);
    const r = await call("POST", "/api/meetings/voice-profile", { token: T.alice, form: sample() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.enrolled, true);
    const g = await call("GET", "/api/meetings/voice-profile", { token: T.alice });
    assert.deepEqual([g.data.data.enrolled, g.data.data.seconds], [true, 9]);
    assert.equal(JSON.stringify(g.data).includes("embedding"), false);
    assert.equal((await call("GET", "/api/meetings/voice-profile", { token: T.dan })).data.data.enrolled, false);

    svc.setVoiceprinter(async () => { throw new Error("Not enough speech in the sample"); });
    const bad = await call("POST", "/api/meetings/voice-profile", { token: T.dan, form: sample() });
    assert.equal(bad.status, 422);
    assert.match(bad.data.message, /Not enough speech/);
    const leftovers = (await import("node:fs")).readdirSync((await import("../src/controllers/meetingMediaController.js")).RECORDING_DIR).filter((f) => f.startsWith("voice-"));
    assert.deepEqual(leftovers, [], "voice samples are deleted after processing");
  });

  test("transcription names the speakers whose voice matches an attendee's profile", async () => {
    const svc = await import("../src/services/transcriptionService.js");
    svc.setTranscriber(async () => ({
      seconds: 9,
      segments: [
        { text: "Good morning, everyone.", start: 0, end: 3, speakerIndex: 0 },
        { text: "Let us start the meeting.", start: 3, end: 6, speakerIndex: 1 },
        { text: "Agenda first.", start: 6, end: 9, speakerIndex: 0 },
      ],
      voiceprints: [{ index: 0, embedding: [0.97, 0.05, 0.1, 0] }, { index: 1, embedding: [0.1, 0.95, 0.05, 0] }],
    }));
    const m = await call("POST", "/api/meetings", { token: T.adminA, json: {
      title: "Voice sync", meetingDate: "2031-08-01", meetingType: "Offline", transcription: true, recording: true,
      attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }, { name: "Dan", email: "dan@test.io", userId: ID.dan }],
    } });
    mid = m.data.data._id;
    const f = new FormData();
    f.append("recording", new Blob([Buffer.alloc(4096, 3)], { type: "audio/mpeg" }), "call.mp3");
    await call("POST", `/api/meetings/${mid}/recording`, { token: T.adminA, form: f });
    const t = await poll(mid, T.adminA, (x) => x?.status === "done");
    // Alice has a profile → named; Dan has none → stays "Speaker 2"
    assert.deepEqual(t.entries.map((e) => e.speaker), ["Alice", "Speaker 2", "Alice"]);
    assert.equal(t.speakers[0].matchedBy, "voice");
    assert.equal(t.voiceprints, undefined, "voice data is not sent to the browser");
    const list = (await call("GET", "/api/meetings", { token: T.adminA })).data.data.find((x) => x._id === mid);
    assert.equal(list.transcript.voiceprints, undefined);
  });

  test("“Recognize speakers” after someone records a profile; manual names are kept", async () => {
    const svc = await import("../src/services/transcriptionService.js");
    svc.setVoiceprinter(async () => ({ embedding: DAN, seconds: 10 }));
    await call("POST", "/api/meetings/voice-profile", { token: T.dan, form: sample() });
    const r = await call("POST", `/api/meetings/${mid}/transcript/identify`, { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.data.transcript.entries.map((e) => e.speaker), ["Alice", "Dan", "Alice"]);
    assert.equal(r.data.data.transcript.voiceprints, undefined);

    // A name chosen by hand wins over the voice match
    await call("PUT", `/api/meetings/${mid}/transcript/speakers`, { token: T.adminA, json: { speakers: [{ id: "S1", name: "Guest Speaker" }] } });
    const again = await call("POST", `/api/meetings/${mid}/transcript/identify`, { token: T.adminA });
    assert.deepEqual(again.data.data.transcript.entries.map((e) => e.speaker), ["Guest Speaker", "Dan", "Guest Speaker"]);

    // Deleting a profile → that person is no longer recognized on the next run
    await call("DELETE", "/api/meetings/voice-profile", { token: T.dan });
    const after = await call("POST", `/api/meetings/${mid}/transcript/identify`, { token: T.adminA });
    assert.equal(after.data.data.transcript.entries[1].speaker, "Speaker 2");
  });

  test("voice matching: threshold and ambiguity guard", async () => {
    const { matchVoices } = await import("../src/utils/voiceMatch.js");
    const profiles = [{ key: "a", embedding: ALICE }, { key: "d", embedding: DAN }];
    assert.deepEqual(matchVoices([{ id: "S1", embedding: [0.9, 0.1, 0, 0] }], profiles).map((m) => m.key), ["a"]);
    assert.deepEqual(matchVoices([{ id: "S1", embedding: STRANGER }], profiles), [], "unknown voice → not named");
    assert.deepEqual(matchVoices([{ id: "S1", embedding: [1, 0.95, 0, 0] }], profiles), [], "between two people → not named");
  });
});

describe("Whisper output cleanup", () => {
  test("drops tags and repetition loops, merges a repeated line", async () => {
    const { cleanSegmentText, cleanSegments } = await import("../src/utils/transcriptCleanup.js");
    assert.equal(cleanSegmentText("(inaudible) I'm not sure what I'm going to do."), "I'm not sure what I'm going to do.");
    assert.equal(cleanSegmentText("I'm going to get a Tamil language. I'm going to get a Tamil language."), "I'm going to get a Tamil language.");
    assert.equal(cleanSegmentText("அம்மா, அம்மா, அம்மா, அம்மா"), "அம்மா");
    assert.equal(cleanSegmentText("[BLANK_AUDIO] [Music]"), "");
    const out = cleanSegments([
      { text: "(inaudible)", start: 0, end: 30 },
      { text: "Hello team.", start: 30, end: 33 },
      { text: "hello team", start: 33, end: 35 },
      { text: "Next item.", start: 35, end: 38 },
    ]);
    assert.deepEqual(out.map((s) => [s.text, s.start, s.end]), [["Hello team.", 30, 35], ["Next item.", 35, 38]]);
  });
});

describe("speaker clustering", () => {
  test("groups similar voices, keeps order of appearance, fills short lines", async () => {
    const { clusterSpeakers } = await import("../src/utils/speakerClustering.js");
    const a = [1, 0.1, 0], b = [0, 1, 0.1], a2 = [0.95, 0.15, 0.05];
    assert.deepEqual(clusterSpeakers([b, a, null, a2, b], [3, 3, 0.5, 3, 3]), [0, 1, 1, 1, 0]);
    assert.deepEqual(clusterSpeakers([a, b, a2], [3, 3, 3], { maxSpeakers: 1 }), [0, 0, 0]);
    assert.deepEqual(clusterSpeakers([a, b, a2], [3, 0.5, 3]), [0, 0, 0], "a voice heard for < 2 s is folded in");
    assert.deepEqual(clusterSpeakers([null, null], [1, 1]), [0, 0]);
  });
});

describe("MoM invitation email content", () => {
  test("invitation shows time, attendees, discussion points, action plans and the Meet link", async () => {
    const { sendMeetingInvitation, sendMomEmail, capturedMeetingEmails } = await import("../src/services/meetingEmailService.js");
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Planning", meetingDate: "2031-05-06", startTime: "14:30", endTime: "15:45", meetingType: "Offline",
        departments: ["Development"],
        attendees: [{ name: "Alice", email: "alice@test.io" }, { name: "Dan", email: "dan@test.io" }],
        points: [{ title: "Budget for Q3" }, { title: "Hiring plan", completed: true }],
        actions: [{ title: "Draft budget", owners: [{ name: "Alice" }, { name: "Dan" }], dueDate: "2031-05-10" }],
      },
    });
    const meeting = await Meeting().findById(r.data.data._id);
    meeting.googleMeetLink = "https://meet.google.com/abc-defg-hij";
    const before = capturedMeetingEmails.length;
    const res = await sendMeetingInvitation(meeting);
    assert.equal(res.sentCount, 2);
    const mail = capturedMeetingEmails.slice(before).find((m) => m.to === "alice@test.io");
    for (const expected of ["2:30 PM – 3:45 PM (1 h 15 min)", "Alice, Dan", "1. Budget for Q3", "2. Hiring plan (done)", "Draft budget — Owner(s): Alice, Dan", "https://meet.google.com/abc-defg-hij"]) {
      assert.ok(mail.text.includes(expected), `text contains "${expected}"\n${mail.text}`);
    }
    for (const expected of ["Discussion points", "Budget for Q3", "Action plans", "Join Google Meet", "Development"]) {
      assert.ok(mail.html.includes(expected), `html contains "${expected}"`);
    }
    await sendMomEmail(meeting);
    const mom = capturedMeetingEmails.find((m) => /^Minutes of Meeting: Planning/.test(m.subject));
    assert.ok(mom.text.includes("1. Budget for Q3") && mom.text.includes("Draft budget"));
  });
});

describe("In-app Google reconnect", () => {
  test("only admins get a sign-in link; it returns to GOOGLE_REDIRECT_URI with a one-time state", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/oauth2callback";
    try {
      assert.equal((await call("POST", "/api/google/connect-url", { token: T.alice })).status, 403);
      const r = await call("POST", "/api/google/connect-url", { token: T.adminA });
      assert.equal(r.status, 200);
      const url = new URL(r.data.data.url);
      assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:5000/oauth2callback");
      assert.match(url.searchParams.get("scope"), /calendar\.events/);
      const state = url.searchParams.get("state");
      assert.ok(state && state.length >= 32);

      // forged / unknown state → back to the app with an error, nothing saved
      const forged = await fetch(`${base}/oauth2callback?state=nope&code=x`, { redirect: "manual" });
      assert.equal(forged.status, 302);
      assert.match(forged.headers.get("location"), /dashboard\/mom\?google=error/);
      // user cancelled at Google
      const cancelled = await fetch(`${base}/oauth2callback?state=${state}&error=access_denied`, { redirect: "manual" });
      assert.match(cancelled.headers.get("location"), /access_denied/);
      // state is single-use
      const reused = await fetch(`${base}/oauth2callback?state=${state}&code=x`, { redirect: "manual" });
      assert.match(decodeURIComponent(reused.headers.get("location")), /expired/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = "";
      process.env.GOOGLE_CLIENT_SECRET = "";
    }
  });
});

describe("Support tickets reach the Super Admin", () => {
  const waitMail = async (to, rx) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (sentMessages.some((m) => m.to === to && rx.test(m.subject))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  let tid;

  test("raising a ticket emails the Super Admin; dashboard list shows who/which org", async () => {
    const r = await call("POST", "/api/support/tickets", {
      token: T.dan, json: { subject: "Cannot upload file", category: "Tasks", priority: "High", message: "Upload fails" },
    });
    assert.equal(r.status, 201);
    tid = r.data.data.id;
    assert.ok(await waitMail("root@test.io", /New support ticket TKT-\d+: Cannot upload file/));

    const all = await call("GET", "/api/support/tickets?scope=all", { token: T.super });
    const t = all.data.data.find((x) => x._id === tid);
    assert.equal(t.raisedBy.name, "Dan");
    assert.equal(t.organization, "Company A");

    assert.ok(!(await call("GET", "/api/support/tickets?scope=all", { token: T.adminB })).data.data.some((x) => x._id === tid), "other org can't see it");
    const own = await call("GET", "/api/support/tickets", { token: T.alice });
    assert.ok(!own.data.data.some((x) => x._id === tid), "users only see their own");
    const stats = await call("GET", "/api/support/tickets/stats?scope=all", { token: T.super });
    assert.ok(stats.data.data.open >= 1);
  });

  test("Super Admin replies → In Progress, user emailed and sees the reply", async () => {
    const r = await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.super, json: { message: "Try a file under 10 MB" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.status, "In Progress");
    assert.ok(await waitMail("dan@test.io", /Reply on TKT-\d+/));
    const mine = await call("GET", "/api/support/tickets", { token: T.dan });
    const t = mine.data.data.find((x) => x._id === tid);
    assert.equal(t.responses[0].message, "Try a file under 10 MB");
    assert.equal(t.responses[0].byRole, "SuperAdmin");
  });

  test("status change emails the user; user reply reopens a resolved ticket", async () => {
    const r = await call("PATCH", `/api/support/tickets/${tid}`, { token: T.super, json: { status: "Resolved" } });
    assert.equal(r.status, 200);
    assert.ok(await waitMail("dan@test.io", /is now Resolved/));
    const back = await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.dan, json: { message: "Still failing" } });
    assert.equal(back.data.data.status, "Open");
    assert.equal((await call("POST", `/api/support/tickets/${tid}/reply`, { token: T.alice, json: { message: "x" } })).status, 404, "not my ticket");
    assert.equal((await call("PATCH", `/api/support/tickets/${tid}`, { token: T.alice, json: { status: "Closed" } })).status, 404);
  });
});

describe("Real-time notifications (Socket.IO)", () => {
  test("assigned user receives notification:new instantly; others don't; ticket reaches Super Admin live", async () => {
    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const waitEvent = (sock, event, pred, ms = 3000) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        sock.on(event, (p) => {
          if (pred(p)) { clearTimeout(t); resolve(p); }
        });
      });

    const dan = await open(T.dan);
    const bob = await open(T.bob);
    const root = await open(T.super);
    try {
      const gotDan = waitEvent(dan, "notification:new", (n) => n.taskName === "Live task");
      const gotBob = waitEvent(bob, "notification:new", (n) => n.taskName === "Live task", 800);
      await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Live task", assignedUser: ID.dan } });
      const n = await gotDan;
      assert.ok(n, "Dan received it in real time");
      assert.equal(n.type, "task_assigned");
      assert.equal(await gotBob, null, "other organization got nothing");

      const gotRoot = waitEvent(root, "notification:new", (x) => x.type === "support_ticket");
      await call("POST", "/api/support/tickets", { token: T.dan, json: { subject: "Live ticket", message: "help" } });
      const t = await gotRoot;
      assert.ok(t && /Live ticket/.test(t.message), "Super Admin got the ticket live");

      assert.equal(await new Promise((r) => {
        const s = connect(base, { auth: { token: "bad" }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => { s.close(); r("connected"); });
        s.on("connect_error", () => { s.close(); r("refused"); });
      }), "refused", "bad token cannot listen");
    } finally {
      dan.close(); bob.close(); root.close();
    }
  });
});

describe("Companies, per-Admin overview, custom roles", () => {
  test("Admin creation needs a company name; only SuperAdmin creates Admins", async () => {
    const r = await call("POST", "/api/admins", { token: T.super, json: { name: "No Co", email: "noco@test.io", password: "Admin@123" } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /Company name/);
    const admins = await call("GET", "/api/admins", { token: T.super });
    assert.equal(admins.data.data.find((a) => a._id === ID.adminA).companyName, "Company A");
    assert.equal((await call("POST", "/api/users", { token: T.adminA, json: { name: "x", email: "x2@test.io", password: "123456", role: "Admin", companyName: "Y" } })).status, 403);
  });

  test("Super Admin overview of Admin A contains ONLY Admin A's organization", async () => {
    const a = await call("GET", `/api/admins/${ID.adminA}/overview`, { token: T.super });
    assert.equal(a.status, 200);
    const emails = a.data.data.members.map((m) => m.email);
    assert.ok(emails.includes("alice@test.io") && !emails.includes("bob@test.io"));
    const tasksA = await Task.countDocuments({ admin_id: ID.adminA, isTaskBank: { $ne: true } });
    assert.equal(a.data.data.stats.tasks.total, tasksA);
    assert.equal(a.data.data.admin.companyName, "Company A");
    assert.ok(a.data.data.admin.createdAt);
    const b = await call("GET", `/api/admins/${ID.adminB}/overview`, { token: T.super });
    assert.ok(!b.data.data.members.some((m) => m.email === "alice@test.io"));
    assert.equal((await call("GET", `/api/admins/${ID.adminA}/overview`, { token: T.adminA })).status, 403);
  });

  test("custom roles: create, assign to a user, own permissions, isolation, delete guard", async () => {
    const c = await call("POST", "/api/custom-roles", { token: T.adminA, json: { name: "Consultant", baseRole: "User", description: "External" } });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    ID.consultant = c.data.data._id;
    assert.equal((await call("POST", "/api/custom-roles", { token: T.adminA, json: { name: "consultant" } })).status, 409, "case-insensitive duplicate");

    const u = await call("POST", "/api/users", {
      token: T.adminA, json: { name: "Cora", email: "cora@test.io", password: "User@123", department: "Development", customRoleId: ID.consultant },
    });
    assert.equal(u.status, 201, JSON.stringify(u.data));
    ID.cora = u.data.data._id;
    const list = await call("GET", "/api/users", { token: T.adminA });
    assert.equal(list.data.data.find((x) => x.email === "cora@test.io").customRoleName, "Consultant");

    // Admin B cannot use Admin A's role
    assert.equal((await call("POST", "/api/users", { token: T.adminB, json: { name: "Z", email: "z@test.io", password: "User@123", customRoleId: ID.consultant } })).status, 400);
    assert.ok(!(await call("GET", "/api/custom-roles", { token: T.adminB })).data.data.some((r) => r._id === ID.consultant));

    // Own permissions: only task viewing
    const perms = { tasks: ["view"], taskbank: [], users: [], calendar: [], reports: [], communication: [], chat: ["view"], support: [], settings: ["view"] };
    assert.equal((await call("PUT", `/api/permissions/custom-roles/${ID.consultant}`, { token: T.adminA, json: { permissions: perms } })).status, 200);
    T.cora = await activate("cora@test.io", "User@123");
    const me = await call("GET", "/api/auth/me", { token: T.cora });
    assert.deepEqual(me.data.data.permissions.tasks, ["view"]);
    assert.equal((await call("POST", "/api/tasks", { token: T.cora, json: { name: "nope" } })).status, 403);
    const roles = await call("GET", "/api/permissions/roles", { token: T.adminA });
    assert.ok(roles.data.data.roles.some((r) => r.label === "Consultant" && r.users === 1));

    assert.equal((await call("DELETE", `/api/custom-roles/${ID.consultant}`, { token: T.adminA })).status, 409, "in use");
    assert.equal((await call("POST", "/api/custom-roles", { token: T.alice, json: { name: "Hack" } })).status, 403);
  });
});

describe("Imports (Tasks page + Task Bank)", () => {
  test("Task Bank CSV import: preview, duplicates, commit, permission", async () => {
    const csv = "Title,Description,Category,Priority,Tags\nOnboard vendor,Collect docs,Ops,High,a; b\nOnboard vendor,dup,Ops,High,\nNo desc,,Ops,Low,\nBad prio,x,Ops,Urgent,\nCode review,already exists,Dev,Low,\n";
    const pv = await call("POST", "/api/taskbank/import?preview=true", { token: T.adminA, form: csvForm(csv) });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.deepEqual(pv.data.summary, { total: 5, valid: 1, invalid: 2, duplicates: 2 });
    const ok = await call("POST", "/api/taskbank/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(ok.data.imported, 1);
    const items = await call("GET", "/api/taskbank", { token: T.adminA });
    const it = items.data.data.find((x) => x.title === "Onboard vendor");
    assert.deepEqual(it.tags, ["a", "b"]);
    assert.ok(!(await call("GET", "/api/taskbank", { token: T.adminB })).data.data.some((x) => x.title === "Onboard vendor"), "isolated");
    assert.equal((await call("POST", "/api/taskbank/import", { token: T.dan, form: csvForm(csv) })).status, 403);
  });

  test("Tasks page import works with tasks.import (Manager) and is refused without it", async () => {
    const csv = "Title,Date\nManager import,2031-07-01\n";
    assert.equal((await call("POST", "/api/tasks/import?preview=true", { token: T.mia, form: csvForm(csv) })).status, 200);
    assert.equal((await call("POST", "/api/tasks/import?preview=true", { token: T.dan, form: csvForm(csv) })).status, 403);
  });
});

describe("Chat: groups, attachments, permissions", () => {
  test("create group with org members only; members message; outsiders can't read", async () => {
    const g = await call("POST", "/api/chat/groups", { token: T.adminA, json: { name: "Dev Team", memberIds: [ID.alice, ID.dan, ID.bob] } });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ID.group = g.data.conversation._id;
    const memberEmails = g.data.conversation.participants.map((p) => p.email);
    assert.ok(memberEmails.includes("alice@test.io") && !memberEmails.includes("bob@test.io"), "other org dropped");

    const m = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "Hello group 👋" } });
    assert.equal(m.status, 201);
    const read = await call("GET", `/api/chat/${ID.group}/messages`, { token: T.dan });
    assert.ok(read.data.messages.some((x) => x.text === "Hello group 👋"), "emoji saved");
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.bob })).status, 403);
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.mia })).status, 403, "same org, not a member");
    const convs = await call("GET", "/api/chat/conversations", { token: T.dan });
    assert.ok(convs.data.conversations.some((c) => c._id === ID.group && c.name === "Dev Team"));
  });

  test("group management: admin adds/removes; plain member cannot; leave", async () => {
    const add = await call("PATCH", `/api/chat/groups/${ID.group}`, { token: T.adminA, json: { addMemberIds: [ID.mia], removeMemberIds: [ID.dan] } });
    assert.equal(add.status, 200);
    const ids = add.data.conversation.participants.map((p) => p._id);
    assert.ok(ids.includes(ID.mia) && !ids.includes(ID.dan));
    assert.equal((await call("GET", `/api/chat/${ID.group}/messages`, { token: T.dan })).status, 403, "removed member loses access");
    // Team Members don't have chat.manage_members by default
    assert.equal((await call("PATCH", `/api/chat/groups/${ID.group}`, { token: T.alice, json: { name: "x" } })).status, 403);
    // Team Members can't create groups by default
    assert.equal((await call("POST", "/api/chat/groups", { token: T.alice, json: { name: "x", memberIds: [ID.mia] } })).status, 403);
    assert.equal((await call("POST", `/api/chat/groups/${ID.group}/leave`, { token: T.mia })).status, 200);
  });

  test("disappearing messages: group admin toggles, members can't, messages expire and are swept", async () => {
    // plain member (Alice) can't change it; invalid duration refused
    assert.equal((await call("PUT", `/api/chat/${ID.group}/disappearing`, { token: T.alice, json: { seconds: 86400 } })).status, 403);
    assert.equal((await call("PUT", `/api/chat/${ID.group}/disappearing`, { token: T.adminA, json: { seconds: 5 } })).status, 400);

    const on = await call("PUT", `/api/chat/${ID.group}/disappearing`, { token: T.adminA, json: { seconds: 3600 } });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.conversation.disappearAfter, 3600);
    assert.ok(on.data.message.system && /turned on disappearing/.test(on.data.message.text));

    const m = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "secret soon gone" } });
    assert.equal(m.status, 201);
    const left = new Date(m.data.message.expiresAt).getTime() - Date.now();
    assert.ok(left > 3500e3 && left <= 3600e3, "expires in ~1 hour");

    // pretend the hour passed → hidden at once, then deleted by the sweep
    const { default: Message } = await import("../src/models/Message.js");
    await Message.updateOne({ _id: m.data.message._id }, { expiresAt: new Date(Date.now() - 1000) });
    const read = await call("GET", `/api/chat/${ID.group}/messages`, { token: T.alice });
    assert.ok(!read.data.messages.some((x) => x.text === "secret soon gone"), "expired message hidden");
    assert.ok(read.data.messages.some((x) => x.text === "Hello group 👋"), "older messages untouched");
    const { sweepExpiredMessages } = await import("../src/jobs/chatExpiryJob.js");
    assert.ok((await sweepExpiredMessages()) >= 1);
    assert.equal(await Message.countDocuments({ _id: m.data.message._id }), 0);

    // a file in a disappearing message → message deleted, file kept in the chat file backup
    const f = new FormData();
    f.append("files", new Blob(["%PDF-1.4 keep me"], { type: "application/pdf" }), "keep.pdf");
    const fm = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: f });
    assert.equal(fm.status, 201, JSON.stringify(fm.data));
    await Message.updateOne({ _id: fm.data.message._id }, { expiresAt: new Date(Date.now() - 1000) });
    await sweepExpiredMessages();
    assert.equal(await Message.countDocuments({ _id: fm.data.message._id }), 0, "message deleted");

    const mine = await call("GET", "/api/chat/backup?search=keep", { token: T.alice });
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    const rec = mine.data.data.find((r) => r.name === "keep.pdf");
    assert.ok(rec && rec.location === "backup", "file listed as backed up");
    assert.equal(mine.data.canDelete, false);
    const dl = await call("GET", `/api/chat/backup/${rec._id}/download`, { token: T.adminA });
    assert.equal(dl.status, 200, "admin can download the backed-up file");
    assert.equal((await call("GET", `/api/chat/backup/${rec._id}/download`, { token: T.bob })).status, 404, "other org can't");
    assert.equal((await call("GET", "/api/chat/backup?search=keep", { token: T.bob })).data.data.length, 0);
    assert.equal((await call("DELETE", `/api/chat/backup/${rec._id}`, { token: T.alice })).status, 403);
    assert.equal((await call("DELETE", `/api/chat/backup/${rec._id}`, { token: T.adminA })).status, 200);

    const off = await call("PUT", `/api/chat/${ID.group}/disappearing`, { token: T.adminA, json: { seconds: 0 } });
    assert.equal(off.data.conversation.disappearAfter, 0);
    const kept = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "stays" } });
    assert.equal(kept.data.message.expiresAt, null);
  });

  test("attachments: upload, member download, outsider blocked, type/size checks, permission", async () => {
    const f = new FormData();
    f.append("text", "see file");
    f.append("files", new Blob(["%PDF-1.4 hi"], { type: "application/pdf" }), "plan.pdf");
    const m = await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: f });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    const file = m.data.message.attachments[0];
    assert.equal(file.name, "plan.pdf");
    const dl = await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.adminA });
    assert.equal(dl.status, 200);
    assert.equal((await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.bob })).status, 404);
    assert.equal((await call("GET", `/api/chat/attachments/${file.filename}`, { token: T.dan })).status, 404, "left the group");

    const bad = new FormData();
    bad.append("files", new Blob(["MZ"]), "x.exe");
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: bad })).status, 400);

    // revoke chat.upload for Team Members → file messages refused, text still works
    const cfg = await call("GET", "/api/permissions/roles", { token: T.adminA });
    const userPerms = cfg.data.data.roles.find((r) => r.role === "User").permissions;
    await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: { ...userPerms, chat: ["view", "send", "download"] } } });
    const f2 = new FormData();
    f2.append("files", new Blob(["x"], { type: "text/plain" }), "a.txt");
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, form: f2 })).status, 403);
    assert.equal((await call("POST", `/api/chat/${ID.group}/messages`, { token: T.alice, json: { text: "text ok" } })).status, 201);
    await call("PUT", "/api/permissions/roles/User", { token: T.adminA, json: { permissions: userPerms } });

    const { CHAT_UPLOAD_DIR } = await import("../src/controllers/chatGroupController.js");
    fs.rmSync(path.join(CHAT_UPLOAD_DIR, file.filename), { force: true });
  });
});

describe("Individual reports", () => {
  test("per-person counts, filters and isolation", async () => {
    const r = await call("GET", "/api/reports/individual", { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const people = r.data.data.people;
    assert.ok(people.some((p) => p.email === "alice@test.io") && !people.some((p) => p.email === "bob@test.io"));
    const dan = people.find((p) => p.email === "dan@test.io");
    const danTasks = await Task.find({ assignedTo: ID.dan, isTaskBank: { $ne: true } }).lean();
    assert.equal(dan.assigned, danTasks.length);
    assert.equal(dan.completed, danTasks.filter((t) => t.status === "Completed").length);
    assert.equal(dan.inProgress, danTasks.filter((t) => t.status === "In Progress").length);

    const one = await call("GET", `/api/reports/individual?userId=${ID.dan}`, { token: T.adminA });
    assert.equal(one.data.data.people.length, 1);
    assert.equal(one.data.data.tasks.length, danTasks.length);
    // every task carries its full detail for the task-wise report
    for (const t of one.data.data.tasks) {
      for (const k of ["name", "status", "timeliness", "history", "comments", "subtasks", "checklist", "assignedAt"]) {
        assert.ok(k in t, `task detail has ${k}`);
      }
      if (t.status === "Completed") assert.equal(typeof t.daysTaken, "number");
    }
    assert.ok("personSummary" in one.data.data);
    const role = await call("GET", "/api/reports/individual?role=Manager", { token: T.adminA });
    assert.ok(role.data.data.people.every((p) => p.role === "Manager"));
    const cons = await call("GET", `/api/reports/individual?role=custom:${ID.consultant}`, { token: T.adminA });
    assert.deepEqual(cons.data.data.people.map((p) => p.roleLabel), ["Consultant"]);
    assert.equal((await call("GET", `/api/reports/individual?userId=${ID.bob}`, { token: T.adminA })).data.data.people.length, 0, "other org user hidden");
    assert.equal((await call("GET", "/api/reports/individual", { token: T.alice })).status, 403);
  });
});

describe("Activity (Admin / SuperAdmin)", () => {
  test("logins, page views and actions are logged; only admins can read them, per organization", async () => {
    await login("dan@test.io", "User@123");
    await login("dan@test.io", "wrong-password").catch(() => {});
    await call("POST", "/api/activity/view", { token: T.dan, json: { page: "/dashboard/tasks", label: "Tasks" } });
    const task = await Task.findOne({ assignedTo: ID.dan, isTaskBank: { $ne: true } }).lean();
    await call("POST", `/api/tasks/${task._id}/comments`, { token: T.dan, json: { text: "activity check" } });
    await call("POST", "/api/activity/logout", { token: T.dan });
    await new Promise((r) => setTimeout(r, 300)); // logs are written after the response

    const users = await call("GET", "/api/activity/users", { token: T.adminA });
    assert.equal(users.status, 200, JSON.stringify(users.data));
    const dan = users.data.data.find((u) => u.email === "dan@test.io");
    assert.ok(dan.lastLoginAt && dan.lastSeenAt, "last login + last seen saved");
    assert.equal(dan.lastPage, "Tasks");
    assert.ok(dan.logins7d >= 1 && dan.failed7d >= 1 && dan.actions7d >= 1);
    assert.equal(dan.lastAction.action, "Commented on a task");
    assert.ok(!users.data.data.some((u) => u.email === "bob@test.io"), "other organization hidden");

    const logs = await call("GET", `/api/activity/logs?userId=${ID.dan}`, { token: T.adminA });
    const types = logs.data.data.map((l) => l.type);
    for (const k of ["login", "login_failed", "page_view", "action", "logout"]) assert.ok(types.includes(k), `log has ${k}`);
    const only = await call("GET", `/api/activity/logs?userId=${ID.dan}&type=action`, { token: T.adminA });
    assert.ok(only.data.data.every((l) => l.type === "action"));

    assert.equal((await call("GET", "/api/activity/logs", { token: T.adminB || T.bob })).data.data?.some?.((l) => l.userEmail === "dan@test.io") || false, false);
    assert.equal((await call("GET", "/api/activity/users", { token: T.dan })).status, 403);
    assert.equal((await call("GET", "/api/activity/logs", { token: T.alice })).status, 403);
    const sup = await call("GET", "/api/activity/users", { token: T.super });
    assert.ok(sup.data.data.some((u) => u.email === "bob@test.io") && sup.data.data.some((u) => u.email === "dan@test.io"));
  });
});

describe("Individual access (per person)", () => {
  test("Admin sees each member with role and effective permissions; outsiders are hidden", async () => {
    const r = await call("GET", "/api/permissions/users", { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cora = r.data.data.users.find((u) => u._id === ID.cora);
    assert.equal(cora.roleLabel, "Consultant");
    assert.equal(cora.hasOverride, false);
    assert.deepEqual(cora.permissions.tasks, ["view"]);
    assert.ok(!r.data.data.users.some((u) => u.email === "bob@test.io" || u.role === "Admin"));
    assert.equal((await call("GET", "/api/permissions/users", { token: T.alice })).status, 403);
  });

  test("override grants and revokes for one person only; reset returns to the role", async () => {
    const before = (await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions;
    const perms = { ...before, tasks: ["view", "create"], chat: [] };
    const r = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { permissions: perms } });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    const me = (await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions;
    assert.deepEqual(me.tasks.sort(), ["create", "view"]);
    assert.deepEqual(me.chat, []);
    assert.equal((await call("GET", "/api/chat/conversations", { token: T.cora })).status, 403, "chat revoked");
    const list = (await call("GET", "/api/permissions/users", { token: T.adminA })).data.data.users;
    assert.equal(list.find((u) => u._id === ID.cora).hasOverride, true);
    assert.deepEqual(list.find((u) => u._id === ID.cora).rolePermissions.tasks, ["view"], "role itself unchanged");

    // Other people with the same base role are not affected
    assert.ok((await call("GET", "/api/auth/me", { token: T.dan })).data.data.permissions.chat.includes("view"));

    const reset = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { reset: true } });
    assert.equal(reset.status, 200);
    assert.deepEqual((await call("GET", "/api/auth/me", { token: T.cora })).data.data.permissions.tasks, ["view"]);
  });

  test("cannot exceed the Admin's own access, target other orgs or Admins", async () => {
    const all = (await call("GET", "/api/permissions/admins", { token: T.super })).data.data.find((a) => a._id === ID.adminA).permissions;
    await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: { ...all, reports: [] } } });
    try {
      const over = await call("PUT", `/api/permissions/users/${ID.cora}`, { token: T.adminA, json: { permissions: { ...all, reports: ["view"] } } });
      assert.equal(over.status, 403);
    } finally {
      await call("PUT", `/api/permissions/admins/${ID.adminA}`, { token: T.super, json: { permissions: all } });
    }
    assert.equal((await call("PUT", `/api/permissions/users/${ID.bob}`, { token: T.adminA, json: { permissions: {} } })).status, 404, "other org");
    assert.equal((await call("PUT", `/api/permissions/users/${ID.adminA}`, { token: T.adminA, json: { permissions: {} } })).status, 404, "admins excluded");
    assert.equal((await call("PUT", "/api/permissions/users/nope", { token: T.adminA, json: { reset: true } })).status, 400);
  });
});

describe("Regression — MoM and charts", () => {
  test("meetings list still works for members and admins", async () => {
    assert.equal((await call("GET", "/api/meetings", { token: T.alice })).status, 200);
    assert.equal((await call("GET", "/api/meetings", { token: T.adminA })).status, 200);
  });

  test("report summary (charts) still loads", async () => {
    const r = await call("GET", "/api/reports/summary", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true);
  });

  test("task stats still load", async () => {
    const r = await call("GET", "/api/tasks/stats", { token: T.adminA });
    assert.equal(r.status, 200);
    assert.ok(r.data.data.total >= 1);
  });
});

describe("Push notifications", () => {
  const sent = [];
  const Notification = () => mongoose.model("Notification");
  const waitFor = async (check) => {
    for (let i = 0; i < 50 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
  };
  const sub = (n) => ({ endpoint: `https://push.example.test/sub-${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });

  before(async () => {
    const { setPushSender } = await import("../src/services/pushService.js");
    setPushSender(async (subscription, body) => {
      if (subscription.endpoint.endsWith("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
    });
  });

  test("public key needs login and is returned", async () => {
    assert.equal((await call("GET", "/api/push/public-key")).status, 401);
    const r = await call("GET", "/api/push/public-key", { token: T.alice });
    assert.equal(r.status, 200);
    assert.equal(r.data.publicKey, process.env.VAPID_PUBLIC_KEY);
  });

  test("subscribe validates the subscription", async () => {
    const bad = await call("POST", "/api/push/subscribe", { token: T.alice, json: { subscription: { endpoint: "http://x", keys: {} } } });
    assert.equal(bad.status, 400);
    const ok = await call("POST", "/api/push/subscribe", { token: T.alice, json: { subscription: sub("a1") } });
    assert.equal(ok.status, 200);
  });

  test("every new notification is pushed to the recipient's browsers", async () => {
    sent.length = 0;
    const me = (await call("GET", "/api/auth/me", { token: T.alice })).data.data;
    await Notification().create({ recipient: me._id, type: "task_assigned", taskName: "Push test", message: "You have a new task: Push test" });
    await waitFor(() => sent.length > 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, sub("a1").endpoint);
    assert.equal(sent[0].payload.title, "New task assigned");
    assert.equal(sent[0].payload.url, "/dashboard/tasks");
    assert.match(sent[0].payload.body, /Push test/);
  });

  test("dead subscriptions are removed; Settings off stops pushes; unsubscribe works", async () => {
    const PushSubscription = mongoose.model("PushSubscription");
    const me = (await call("GET", "/api/auth/me", { token: T.alice })).data.data;
    await call("POST", "/api/push/subscribe", { token: T.alice, json: { subscription: sub("gone") } });

    sent.length = 0;
    await Notification().create({ recipient: me._id, type: "task_reminder", message: "Reminder" });
    await waitFor(() => sent.length > 0);
    await waitFor(() => false); // let the 410 cleanup finish
    assert.equal(await PushSubscription.countDocuments({ endpoint: sub("gone").endpoint }), 0, "410 subscription deleted");

    await User.updateOne({ _id: me._id }, { "preferences.desktopNotifications": false });
    sent.length = 0;
    await Notification().create({ recipient: me._id, type: "task_reminder", message: "Muted" });
    await waitFor(() => false);
    assert.equal(sent.length, 0, "muted in Settings");
    await User.updateOne({ _id: me._id }, { "preferences.desktopNotifications": true });

    const un = await call("POST", "/api/push/unsubscribe", { token: T.alice, json: { endpoint: sub("a1").endpoint } });
    assert.equal(un.status, 200);
    assert.equal(await PushSubscription.countDocuments({ user: me._id }), 0);
  });
});

describe("Monthly Task — targets and daily progress", () => {
  let svc;
  let thisMonth; // { year, month } in the users' time zone (Asia/Kolkata by default)
  let today;
  let day1; // first day of this month (may be today)
  let groupTasks; // alice's and dan's copies
  const pad = (n) => String(n).padStart(2, "0");
  const mkMonthly = (json) =>
    call("POST", "/api/tasks", {
      token: T.adminA,
      json: { name: "Calls", department: "Development", taskType: "monthly", ...json },
    });
  const progress = (token, id) => call("GET", `/api/tasks/${id}/monthly`, { token });
  const save = (token, id, date, json) => call("PUT", `/api/tasks/${id}/monthly/${date}`, { token, json });
  const copyOf = (list, userId) => list.find((t) => String(t.assignedTo) === String(userId));
  const shift = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  before(async () => {
    svc = await import("../src/services/monthlyTaskService.js");
    today = svc.todayIn("Asia/Kolkata");
    const [y, m] = today.split("-").map(Number);
    thisMonth = { year: y, month: m };
    day1 = `${y}-${pad(m)}-01`;
  });

  test("a task cannot be created without an assigned user (any task type)", async () => {
    const plain = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Nobody's task" } });
    assert.equal(plain.status, 400);
    assert.equal(plain.data.code, "ASSIGNEE_REQUIRED");
    const monthly = await mkMonthly({ monthly: { ...thisMonth, target: 10 } });
    assert.equal(monthly.status, 400);
    assert.match(monthly.data.message, /at least one user/);
    const ghost = await mkMonthly({ assignedUsers: ["No Such Person"], monthly: { ...thisMonth, target: 10 } });
    assert.equal(ghost.status, 400, "an invalid user is not an assignment");
  });

  test("target, dates and method are validated", async () => {
    for (const monthly of [
      { ...thisMonth },
      { ...thisMonth, target: 0 },
      { ...thisMonth, target: -5 },
      { ...thisMonth, target: 2.5 },
      { ...thisMonth, target: "abc" },
      { year: thisMonth.year, month: 13, target: 10 },
      { ...thisMonth, target: 10, trackingMethod: "slider" },
      { ...thisMonth, target: 10, trackingMethod: "checkbox", unitPerCheck: 0 },
      { startDate: "2026-10-10", endDate: "2026-10-01", target: 10 },
      { startDate: "2026-02-30", endDate: "2026-03-05", target: 10 },
      { startDate: "2026-01-01", endDate: "2027-06-01", target: 10 },
      { startDate: "2026-10-01", target: 10 },
    ]) {
      const r = await mkMonthly({ assignedUser: ID.alice, monthly });
      assert.equal(r.status, 400, JSON.stringify(monthly));
    }
  });

  test("starting and end date: only those days are listed, due on the end date", async () => {
    const start = shift(today, -3);
    const end = shift(today, 6);
    const r = await mkMonthly({ assignedUser: ID.alice, monthly: { startDate: start, endDate: end, target: 50 } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const t = r.data.data;
    assert.equal(t.dueDate, end);
    assert.equal(t.monthly.startDate, start);
    assert.equal(t.monthly.endDate, end);
    assert.equal(t.monthly.totalDays, 10);
    const p = await progress(T.alice, t.id);
    assert.deepEqual(p.data.data.days.map((d) => d.date), Array.from({ length: 10 }, (_, i) => shift(start, i)));
    assert.equal((await save(T.adminA, t.id, shift(start, -1), { count: 1 })).status, 400, "before the start");
  });

  test("creating for several users gives each a separate copy (whole month by default)", async () => {
    const r = await mkMonthly({ assignedUsers: [ID.alice, ID.dan], monthly: { ...thisMonth, target: 100 } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    groupTasks = r.data.data;
    assert.equal(groupTasks.length, 2);
    const lastDay = svc.daysInMonth(thisMonth.year, thisMonth.month);
    for (const t of groupTasks) {
      assert.equal(t.taskType, "monthly");
      assert.equal(t.dueDate, `${thisMonth.year}-${pad(thisMonth.month)}-${pad(lastDay)}`);
      assert.deepEqual(
        { target: t.monthly.target, total: t.monthly.totalCompleted, remaining: t.monthly.remaining, percent: t.monthly.percent },
        { target: 100, total: 0, remaining: 100, percent: 0 }
      );
    }
  });

  test("review-approved tasks accumulate in the assignee's monthly table", async () => {
    const approveTask = async (name) => {
      const created = await call("POST", "/api/tasks", {
        token: T.adminA,
        json: { name, department: "Development", assignedUser: ID.alice, dueDate: shift(today, 1) },
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const taskId = created.data.data.id;
      assert.equal((await call("PATCH", `/api/tasks/${taskId}/status`, { token: T.alice, json: { status: "In Progress" } })).status, 200);
      assert.equal((await call("PATCH", `/api/tasks/${taskId}/status`, { token: T.alice, json: { status: "Review" } })).status, 200);
      const approved = await call("PATCH", `/api/tasks/${taskId}/status`, { token: T.adminA, json: { status: "Completed", score: 7 } });
      assert.equal(approved.status, 200, JSON.stringify(approved.data));
    };

    const monthlyTask = copyOf(groupTasks, ID.alice);
    await approveTask("Monthly approval count one");
    let response = await progress(T.alice, monthlyTask.id);
    assert.equal(response.data.data.approvedTaskCount, 1);
    assert.equal(response.data.data.days.find((day) => day.date === today).approvedTaskCount, 1);

    await approveTask("Monthly approval count two");
    response = await progress(T.alice, monthlyTask.id);
    assert.equal(response.data.data.approvedTaskCount, 2);
    assert.equal(response.data.data.days.find((day) => day.date === today).approvedTaskCount, 2);
  });

  test("every date is listed and an empty day counts as 0", async () => {
    const mine = copyOf(groupTasks, ID.alice);
    const r = await progress(T.alice, mine.id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.days.length, svc.daysInMonth(thisMonth.year, thisMonth.month));
    assert.ok(r.data.data.days.every((d) => d.count === 0 && d.checked === false && d.entered === false));
    assert.equal(r.data.data.editMode, "today");
    assert.equal((await progress(T.adminA, mine.id)).data.data.editMode, "creator");
  });

  test("the assignee adds only today's count; the creator can correct earlier days", async () => {
    const mine = copyOf(groupTasks, ID.alice);
    let r = await save(T.alice, mine.id, today, { count: 10, remarks: "today" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.data.monthly.totalCompleted, 10);

    if (today > day1) {
      const past = await save(T.alice, mine.id, day1, { count: 5 });
      assert.equal(past.status, 403);
      assert.equal(past.data.code, "TODAY_ONLY");
      // the creator fixes an earlier day; the entry still belongs to Alice
      r = await save(T.adminA, mine.id, day1, { count: 15 });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.data.monthly.totalCompleted, 25);
      assert.equal(r.data.data.monthly.remaining, 75);
      assert.equal(r.data.data.monthly.percent, 25);
      const row = await mongoose.model("MonthlyProgress").findOne({ task: mine.id, date: day1 }).lean();
      assert.equal(String(row.user), String(ID.alice));
      assert.equal(String(row.updatedBy), String(ID.adminA));
    }

    // saving the same date again replaces it — no duplicate rows
    r = await save(T.alice, mine.id, today, { count: 12 });
    assert.equal(await mongoose.model("MonthlyProgress").countDocuments({ task: mine.id, date: today }), 1);
    const expected = today > day1 ? 27 : 12;
    assert.equal(r.data.data.monthly.totalCompleted, expected);
    assert.equal(r.data.data.days.find((d) => d.date === today).remarks, "today");
    const one = await call("GET", `/api/tasks/${mine.id}`, { token: T.alice });
    assert.equal(one.data.data.monthly.totalCompleted, expected);
    // over the target: remaining stays 0, percent caps at 100
    r = await save(T.alice, mine.id, today, { count: 500 });
    assert.equal(r.data.data.monthly.remaining, 0);
    assert.equal(r.data.data.monthly.percent, 100);
    r = await save(T.alice, mine.id, today, { count: 12 });
    assert.equal(r.data.data.monthly.totalCompleted, expected);
  });

  test("invalid counts and dates are rejected", async () => {
    const mine = copyOf(groupTasks, ID.alice);
    for (const count of [-1, 1.5, "ten", null, undefined]) {
      assert.equal((await save(T.alice, mine.id, today, { count })).status, 400, `count ${count}`);
    }
    const otherMonth = thisMonth.month === 1 ? `${thisMonth.year - 1}-12-15` : `${thisMonth.year}-${pad(thisMonth.month - 1)}-15`;
    assert.equal((await save(T.adminA, mine.id, otherMonth, { count: 1 })).status, 400, "outside the task's dates");
    assert.equal((await save(T.adminA, mine.id, `${thisMonth.year}-${pad(thisMonth.month)}-32`, { count: 1 })).status, 400);
    assert.equal((await save(T.adminA, mine.id, "yesterday", { count: 1 })).status, 400);
  });

  test("nobody else can change progress — enforced by the API", async () => {
    const alices = copyOf(groupTasks, ID.alice);
    const dans = copyOf(groupTasks, ID.dan);

    // Dan cannot write (or even see) Alice's copy
    assert.equal((await save(T.dan, alices.id, today, { count: 99 })).status, 404);
    // a Manager who did not create the task can read but not write
    const asManager = await progress(T.mia, alices.id);
    assert.equal(asManager.status, 200);
    assert.equal(asManager.data.data.canEdit, false);
    const mgrWrite = await save(T.mia, alices.id, today, { count: 99 });
    assert.equal(mgrWrite.status, 403);
    assert.equal(mgrWrite.data.code, "ASSIGNEE_ONLY");
    // another organization cannot see it at all
    assert.equal((await progress(T.bob, alices.id)).status, 404);
    assert.equal((await save(T.bob, alices.id, today, { count: 99 })).status, 404);

    // a user id in the body is ignored — the entry belongs to the task's assignee
    const r = await save(T.dan, dans.id, today, { count: 4, user: ID.alice, userId: ID.alice });
    assert.equal(r.status, 200);
    const rows = await mongoose.model("MonthlyProgress").find({ task: dans.id }).lean();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].user), String(ID.dan));

    // each person's totals stay separate
    assert.equal((await progress(T.dan, dans.id)).data.data.monthly.totalCompleted, 4);
    const alice = await progress(T.alice, alices.id);
    assert.notEqual(alice.data.data.monthly.totalCompleted, 4);
    assert.ok(alice.data.data.days.every((d) => d.count !== 99));
  });

  test("checkbox tracking: a tick adds its units, untick takes them away", async () => {
    const r = await mkMonthly({
      assignedUser: ID.alice,
      monthly: { ...thisMonth, target: 20, trackingMethod: "checkbox", unitPerCheck: 2 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const id = r.data.data.id;
    assert.equal((await save(T.alice, id, today, { count: 5 })).status, 400, "checkbox tasks take checked, not count");
    let s = await save(T.alice, id, today, { checked: true });
    assert.equal(s.status, 200);
    assert.equal(s.data.data.monthly.totalCompleted, 2);
    assert.equal(s.data.data.monthly.percent, 10);
    s = await save(T.alice, id, today, { checked: false });
    assert.equal(s.data.data.monthly.totalCompleted, 0);
    assert.equal(s.data.data.days.find((d) => d.date === today).checked, false);
    const numberTask = copyOf(groupTasks, ID.alice);
    assert.equal((await save(T.alice, numberTask.id, today, { checked: true })).status, 400);
  });

  test("future dates cannot be filled in", async () => {
    const r = await mkMonthly({ assignedUser: ID.alice, monthly: { startDate: shift(today, 1), endDate: shift(today, 5), target: 5 } });
    assert.equal(r.status, 201);
    const s = await save(T.adminA, r.data.data.id, shift(today, 1), { count: 1 });
    assert.equal(s.status, 400);
    assert.match(s.data.message, /future/);
  });

  test("last month's entries stay intact when a new month's task starts", async () => {
    const prev = thisMonth.month === 1 ? { year: thisMonth.year - 1, month: 12 } : { year: thisMonth.year, month: thisMonth.month - 1 };
    const old = await mkMonthly({ assignedUser: ID.alice, monthly: { ...prev, target: 30 } });
    const oldId = old.data.data.id;
    assert.equal((await save(T.adminA, oldId, `${prev.year}-${pad(prev.month)}-05`, { count: 7 })).status, 200);
    await save(T.adminA, oldId, `${prev.year}-${pad(prev.month)}-06`, { count: 3 });

    const fresh = await mkMonthly({ assignedUser: ID.alice, monthly: { ...thisMonth, target: 30 } });
    assert.equal(fresh.status, 201);
    assert.equal((await progress(T.alice, fresh.data.data.id)).data.data.monthly.totalCompleted, 0);

    const before = await progress(T.alice, oldId);
    assert.equal(before.data.data.monthly.totalCompleted, 10);
    assert.equal(before.data.data.days.length, svc.daysInMonth(prev.year, prev.month));
    assert.equal(before.data.data.days.find((d) => d.date.endsWith("-05")).count, 7);
  });

  test("the creator edits target and dates; totals follow the dates; completed tasks are locked", async () => {
    const mine = copyOf(groupTasks, ID.alice);
    const bad = await call("PATCH", `/api/tasks/${mine.id}`, { token: T.adminA, json: { monthly: { target: 0 } } });
    assert.equal(bad.status, 400);
    const badRange = await call("PATCH", `/api/tasks/${mine.id}`, { token: T.adminA, json: { monthly: { startDate: today, endDate: shift(today, -1) } } });
    assert.equal(badRange.status, 400);

    // shrink the dates to today only → only today's entry counts (the others stay saved)
    let ok = await call("PATCH", `/api/tasks/${mine.id}`, {
      token: T.adminA,
      json: { monthly: { target: 50, startDate: today, endDate: today }, dueDate: "2099-01-01" },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.data.monthly.target, 50);
    assert.equal(ok.data.data.monthly.totalCompleted, 12);
    assert.equal(ok.data.data.dueDate, today, "due date follows the end date");
    // back to the whole month → earlier entries count again
    const lastDay = svc.daysInMonth(thisMonth.year, thisMonth.month);
    ok = await call("PATCH", `/api/tasks/${mine.id}`, {
      token: T.adminA,
      json: { monthly: { startDate: day1, endDate: `${thisMonth.year}-${pad(thisMonth.month)}-${pad(lastDay)}` } },
    });
    assert.equal(ok.data.data.monthly.totalCompleted, today > day1 ? 27 : 12);

    const unassign = await call("PATCH", `/api/tasks/${mine.id}`, { token: T.adminA, json: { assignedUser: "" } });
    assert.equal(unassign.status, 400);

    await Task.updateOne({ _id: mine.id }, { status: "Completed" });
    assert.equal((await save(T.alice, mine.id, today, { count: 1 })).status, 409);
    assert.equal((await save(T.adminA, mine.id, today, { count: 1 })).status, 409);
    assert.equal((await progress(T.alice, mine.id)).data.data.canEdit, false);
  });

  test("standard tasks still work and have no monthly data; deleting removes daily entries", async () => {
    const std = await call("POST", "/api/tasks", { token: T.adminA, json: { name: "Normal one", assignedUser: ID.alice, dueDate: "2031-01-01" } });
    assert.equal(std.status, 201);
    assert.equal(std.data.data.taskType, "standard");
    assert.equal(std.data.data.monthly, null);
    assert.equal((await progress(T.alice, std.data.data.id)).status, 400);

    const dans = copyOf(groupTasks, ID.dan);
    assert.equal((await call("DELETE", `/api/tasks/${dans.id}`, { token: T.adminA })).status, 200);
    assert.equal(await mongoose.model("MonthlyProgress").countDocuments({ task: dans.id }), 0);
  });
});

describe("Task reference IDs from the department code", () => {
  const mkDept = (token, json) => call("POST", "/api/departments", { token, json });
  const mkTask = (json) => call("POST", "/api/tasks", { token: T.adminA, json: { dueDate: "2031-01-01", ...json } });
  let ff;

  test("a department gets the code you give it, or one made from its name", async () => {
    const r = await mkDept(T.adminA, { name: "Finance Flow", refPrefix: "ff" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ff = r.data.data;
    assert.equal(ff.refPrefix, "FF");
    assert.equal(ff.nextReferenceId, "FF1");

    const auto = await mkDept(T.adminA, { name: "Quality Control" });
    assert.equal(auto.data.data.refPrefix, "QC");

    assert.equal((await mkDept(T.adminA, { name: "Bad Code", refPrefix: "F1" })).status, 400);
    assert.equal((await mkDept(T.adminA, { name: "Clash", refPrefix: "FF" })).status, 409);
    // another organization can use the same code
    assert.equal((await mkDept(T.adminB, { name: "Their Finance", refPrefix: "FF" })).status, 201);
  });

  test("tasks are numbered FF1, FF2…; one ID for every copy; a typed ID is ignored", async () => {
    await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { department: "Finance Flow" } });
    await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { department: "Finance Flow" } });
    try {
      const one = await mkTask({ name: "Ledger", department: "Finance Flow", assignedUser: ID.alice, referenceId: "HACK-9" });
      assert.equal(one.status, 201, JSON.stringify(one.data));
      assert.equal(one.data.data.referenceId, "FF1");
      const group = await mkTask({ name: "Audit", department: "Finance Flow", assignedUsers: [ID.alice, ID.dan] });
      assert.deepEqual(group.data.data.map((t) => t.referenceId), ["FF2", "FF2"]);
      const three = await mkTask({ name: "Payroll", department: "Finance Flow", assignedUser: ID.dan });
      assert.equal(three.data.data.referenceId, "FF3");

      const list = await call("GET", "/api/departments", { token: T.adminA });
      assert.equal(list.data.data.find((d) => d.name === "Finance Flow").nextReferenceId, "FF4");

      // changing the code: new tasks use it; old IDs stay; going back never repeats a number
      let p = await call("PATCH", `/api/departments/${ff._id}`, { token: T.adminA, json: { refPrefix: "FIN" } });
      assert.equal(p.status, 200, JSON.stringify(p.data));
      assert.equal((await mkTask({ name: "Tax", department: "Finance Flow", assignedUser: ID.dan })).data.data.referenceId, "FIN1");
      p = await call("PATCH", `/api/departments/${ff._id}`, { token: T.adminA, json: { refPrefix: "FF" } });
      assert.equal(p.data.data.nextReferenceId, "FF4");
      assert.equal((await call("PATCH", `/api/departments/${ff._id}`, { token: T.adminA, json: { refPrefix: "QC" } })).status, 409);
      assert.equal((await call("PATCH", `/api/departments/${ff._id}`, { token: T.adminB, json: { refPrefix: "ZZ" } })).status, 404, "other org");
      assert.equal((await call("PATCH", `/api/departments/${ff._id}`, { token: T.alice, json: { refPrefix: "ZZ" } })).status, 403);
    } finally {
      await call("PUT", `/api/users/${ID.alice}`, { token: T.adminA, json: { department: "Development" } });
      await call("PUT", `/api/users/${ID.dan}`, { token: T.adminA, json: { department: "Development" } });
    }
  });
});

describe("Reference IDs for older tasks", () => {
  test("tasks without an ID get their department's next one; shared copies share it; re-running changes nothing", async () => {
    const { backfillReferenceIds } = await import("../src/services/referenceIdService.js");
    const dept = (await call("POST", "/api/departments", { token: T.adminA, json: { name: "Legacy Ops", refPrefix: "LO" } })).data.data;
    const base = { admin_id: ID.adminA, department: "Legacy Ops", assignedBy: ID.adminA, referenceId: "" };
    const group = new mongoose.Types.ObjectId();
    const [solo, a, b] = await Task.create([
      { ...base, name: "Old solo", assignedTo: ID.alice },
      { ...base, name: "Old shared", assignedTo: ID.alice, taskGroupId: group },
      { ...base, name: "Old shared", assignedTo: ID.dan, taskGroupId: group },
    ]);
    // no department on the task → the assignee's department is used
    const noDept = await Task.create({ ...base, name: "No dept", department: "", assignedTo: ID.alice });
    await User.updateOne({ _id: ID.alice }, { department: "Legacy Ops" });
    try {
      await backfillReferenceIds();
      const ids = Object.fromEntries(
        (await Task.find({ _id: { $in: [solo._id, a._id, b._id, noDept._id] } }).lean()).map((t) => [String(t._id), t.referenceId])
      );
      const num = (id) => Number(ids[String(id)].replace(/^LO/, ""));
      assert.match(ids[String(solo._id)], /^LO\d+$/);
      assert.equal(num(a._id), num(solo._id) + 1, "numbered oldest first");
      assert.equal(ids[String(b._id)], ids[String(a._id)], "copies of one task share the ID");
      assert.match(ids[String(noDept._id)], /^LO\d+$/, "no department → the assignee's department");
      assert.ok(num(noDept._id) > num(a._id));

      const before = ids[String(solo._id)];
      await backfillReferenceIds();
      assert.equal((await Task.findById(solo._id)).referenceId, before, "second run keeps existing IDs");
      const list = await call("GET", "/api/departments", { token: T.adminA });
      const highest = Math.max(...(await Task.find({ referenceId: /^LO\d+$/ }).lean()).map((t) => Number(t.referenceId.slice(2))));
      assert.equal(list.data.data.find((d) => d._id === dept._id).nextReferenceId, `LO${highest + 1}`);
    } finally {
      await User.updateOne({ _id: ID.alice }, { department: "Development" });
    }
  });
});

describe("Create Task — departments, Task IDs, rework reference, workload", () => {
  const mk = (json, token = T.adminA) => call("POST", "/api/tasks", { token, json: { dueDate: "2031-05-01", ...json } });
  let original;

  before(async () => {
    await call("POST", "/api/departments", { token: T.adminA, json: { name: "Design", refPrefix: "DSN" } });
    await call("POST", "/api/departments", { token: T.adminA, json: { name: "Marketing", refPrefix: "MKT" } });
  });

  test("a task can have several departments; the first is the primary and gives the Task ID", async () => {
    // Alice works in Development, so it is one of the selected departments
    const r = await mk({ name: "Launch page", departments: ["Design", "marketing", "Design", "Development"], assignedUser: ID.alice });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    original = r.data.data;
    assert.deepEqual(original.departments, ["Design", "Marketing", "Development"], "deduplicated, real names");
    assert.equal(original.department, "Design");
    assert.ok(original.departmentIds.length >= 2, "ids of the known departments");
    assert.match(original.referenceId, /^DSN\d+$/);

    // edit: change the selection
    const e = await call("PATCH", `/api/tasks/${original.id}`, { token: T.adminA, json: { departments: ["Marketing", "Development"] } });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.deepEqual(e.data.data.departments, ["Marketing", "Development"]);
    assert.equal(e.data.data.referenceId, original.referenceId, "Task ID never changes");
    // the list filter matches any selected department
    const list = await call("GET", "/api/tasks?department=Marketing", { token: T.adminA });
    assert.ok(list.data.data.some((t) => t.id === original.id));
  });

  test("assignees must belong to one of the selected departments", async () => {
    const r = await mk({ name: "Wrong dept", departments: ["Design", "Marketing"], assignedUser: ID.sam });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /any of these departments: Design, Marketing/);
  });

  test("every task gets a unique Task ID — even without a department code; typed IDs are ignored", async () => {
    const a = await mk({ name: "No dept 1", assignedUser: ID.alice, referenceId: "DSN1" });
    const b = await mk({ name: "No dept 2", assignedUser: ID.alice });
    assert.match(a.data.data.referenceId, /^TSK-\d+$/);
    assert.match(b.data.data.referenceId, /^TSK-\d+$/);
    assert.notEqual(a.data.data.referenceId, b.data.data.referenceId);
    const edit = await call("PATCH", `/api/tasks/${a.data.data.id}`, { token: T.adminA, json: { referenceId: "HACKED" } });
    assert.equal(edit.data.data.referenceId, a.data.data.referenceId, "Task ID cannot be edited");
  });

  test("CSV import ignores any Task ID in the file and generates one automatically", async () => {
    const csv = `title,date,referenceId\nAuto ref one,2031-06-01,${original.referenceId}\nAuto ref two,2031-06-02,NEW-77\n`;
    const r = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const [one, two] = await Promise.all([Task.findOne({ name: "Auto ref one" }), Task.findOne({ name: "Auto ref two" })]);
    assert.ok(one.referenceId && two.referenceId, "IDs generated");
    assert.notEqual(one.referenceId, original.referenceId);
    assert.notEqual(two.referenceId, "NEW-77");
    assert.notEqual(one.referenceId, two.referenceId);
  });

  test("CSV import reads dates in any format and saves start + end dates", async () => {
    const csv = [
      "Title,Start Date,Start Time,End Date,End Time",
      "Flex one,01/11/2031,9:00 AM,05/11/2031,5 pm",
      "Flex two,1 Nov 2031,,Nov 7 2031,",
      "Flex three,,,2031-11-08 14:15,",
      "Flex bad,10/11/2031,,05/11/2031,",
      "Flex junk,,,someday,",
    ].join("\n");
    const r = await call("POST", "/api/tasks/import", { token: T.adminA, form: csvForm(csv) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.imported, 3);
    const errs = r.data.rows.map((row) => (row.errors || []).join(" "));
    assert.match(errs[3], /after the End Date/);
    assert.match(errs[4], /not a date/);
    const one = await Task.findOne({ name: "Flex one" });
    assert.equal(one.startDate.toISOString().slice(0, 10), "2031-11-01");
    assert.equal(one.startTime, "09:00");
    assert.equal(one.dueDate.toISOString().slice(0, 10), "2031-11-05");
    assert.equal(one.dueTime, "17:00");
    const two = await Task.findOne({ name: "Flex two" });
    assert.equal(two.startDate.toISOString().slice(0, 10), "2031-11-01");
    assert.equal(two.dueDate.toISOString().slice(0, 10), "2031-11-07");
    const three = await Task.findOne({ name: "Flex three" });
    assert.equal(three.startDate, null);
    assert.equal(three.dueTime, "14:15");
  });

  test("rework tasks must reference an original task; it is stored with its details", async () => {
    const missing = await mk({ name: "Redo", taskType: "rework", departments: ["Design", "Development"], assignedUser: ID.alice });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, "REWORK_REFERENCE_REQUIRED");

    const opts = await call("GET", `/api/tasks/reference-options?search=${original.referenceId}`, { token: T.adminA });
    assert.equal(opts.status, 200);
    const pick = opts.data.data.find((o) => o.referenceId === original.referenceId);
    assert.ok(pick, "searchable by Task ID");
    assert.equal(pick.name, "Launch page");

    const r = await mk({ name: "Redo launch page", taskType: "rework", reworkOf: pick.id, departments: ["Design", "Development"], assignedUser: ID.alice });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.data.taskType, "rework");
    assert.equal(r.data.data.reworkOf.referenceId, original.referenceId);
    assert.equal(r.data.data.reworkOf.name, "Launch page");
    assert.notEqual(r.data.data.referenceId, original.referenceId, "own Task ID stays separate");

    // optional on a normal task; another organization's task can't be referenced
    const normal = await mk({ name: "Follow-up", reworkOf: pick.id, assignedUser: ID.alice });
    assert.equal(normal.status, 201);
    assert.equal(normal.data.data.reworkOf.referenceId, original.referenceId);
    const other = await call("POST", "/api/tasks", { token: T.adminB, json: { name: "x", taskType: "rework", reworkOf: pick.id, assignedUser: ID.bob, dueDate: "2031-01-01" } });
    assert.equal(other.status, 400);
    assert.equal((await call("GET", "/api/tasks/reference-options", { token: T.adminB })).data.data.some((o) => o.id === pick.id), false);
  });

  test("workload comes from the employee's real tasks", async () => {
    const before = (await call("GET", `/api/tasks/workload/${ID.sam}`, { token: T.adminA })).data.data;
    await mk({ name: "Overdue critical", priority: "Critical", dueDate: "2020-01-01", assignedUser: ID.sam });
    const done = await mk({ name: "Finished", priority: "Low", assignedUser: ID.sam });
    await Task.updateOne({ _id: done.data.data.id }, { status: "Completed" });
    const r = await call("GET", `/api/tasks/workload/${ID.sam}`, { token: T.adminA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const w = r.data.data;
    assert.equal(w.total, before.total + 2);
    assert.equal(w.completed, before.completed + 1);
    assert.equal(w.overdue, before.overdue + 1);
    assert.equal(w.pending, before.pending + 1);
    assert.equal(w.points, before.points + 4 + 2, "Critical (4) + overdue (2); completed adds nothing");
    assert.ok(["Low", "Medium", "High"].includes(w.status));

    assert.equal((await call("GET", `/api/tasks/workload/${ID.bob}`, { token: T.adminA })).status, 404, "other organization");
    assert.equal((await call("GET", `/api/tasks/workload/${ID.dan}`, { token: T.alice })).status, 403, "a member can't see others");
    assert.equal((await call("GET", `/api/tasks/workload/${ID.alice}`, { token: T.alice })).status, 200, "but can see their own");
  });

  test("a Manager sees tasks in any of their department's selections", async () => {
    // Mia manages Development
    const r = await mk({ name: "Cross-team", departments: ["Design", "Development"], assignedUser: ID.alice });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const list = await call("GET", "/api/tasks", { token: T.mia });
    assert.ok(list.data.data.some((t) => t.id === r.data.data.id));
  });
});

describe("Rework Task IDs from the original task", () => {
  const mk = (json) => call("POST", "/api/tasks", { token: T.adminA, json: { dueDate: "2031-07-01", ...json } });
  let original;
  let devCode;

  before(async () => {
    await call("POST", "/api/departments", { token: T.adminA, json: { name: "Tech Ops", refPrefix: "TECH" } });
    const dev = await call("POST", "/api/departments", { token: T.adminA, json: { name: "Development", refPrefix: "DEV" } });
    devCode = dev.status === 201
      ? "DEV"
      : (await call("GET", "/api/departments", { token: T.adminA })).data.data.find((d) => d.name === "Development").refPrefix;
    await User.updateOne({ _id: ID.dan }, { department: "Tech Ops" });
    original = (await mk({ name: "Server patch", departments: ["Tech Ops"], assignedUser: ID.dan, description: "Patch the servers", priority: "High" })).data.data;
  });
  after(async () => {
    await User.updateOne({ _id: ID.dan }, { department: "Development" });
  });

  test("the reference list carries what the form needs to fill itself", async () => {
    const opts = await call("GET", `/api/tasks/reference-options?search=${original.referenceId}`, { token: T.adminA });
    const o = opts.data.data.find((x) => x.id === original.id);
    assert.deepEqual(o.assigneeIds, [String(ID.dan)]);
    assert.equal(o.description, "Patch the servers");
    assert.equal(o.priority, "High");
    assert.deepEqual(o.departments, ["Tech Ops"]);
  });

  test("same person → ORIGINAL-1, -2…; new person → ORIGINAL-<their dept code>1", async () => {
    assert.match(original.referenceId, /^TECH\d+$/);
    const ref = original.referenceId;

    const preview = await call("GET", `/api/tasks/rework-id-preview?reworkOf=${original.id}&userIds=${ID.dan},${ID.alice}`, { token: T.adminA });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const byUser = Object.fromEntries(preview.data.data.people.map((p) => [p.userId, p]));
    assert.equal(byUser[ID.dan].referenceId, `${ref}-1`);
    assert.equal(byUser[ID.dan].sameAssignee, true);
    assert.equal(byUser[ID.alice].referenceId, `${ref}-${devCode}1`);
    assert.equal(byUser[ID.alice].sameAssignee, false);

    const r1 = await mk({ name: "Redo patch", taskType: "rework", reworkOf: original.id, departments: ["Tech Ops"], assignedUser: ID.dan });
    assert.equal(r1.status, 201, JSON.stringify(r1.data));
    assert.equal(r1.data.data.referenceId, `${ref}-1`);
    const r2 = await mk({ name: "Redo patch again", taskType: "rework", reworkOf: original.id, departments: ["Tech Ops"], assignedUser: ID.dan });
    assert.equal(r2.data.data.referenceId, `${ref}-2`);

    // one rework for both: each person gets their own ID
    const both = await mk({ name: "Joint redo", taskType: "rework", reworkOf: original.id, departments: ["Tech Ops", "Development"], assignedUsers: [ID.dan, ID.alice] });
    assert.equal(both.status, 201, JSON.stringify(both.data));
    const ids = Object.fromEntries(both.data.data.map((t) => [String(t.assignedTo), t.referenceId]));
    assert.equal(ids[ID.dan], `${ref}-3`);
    assert.equal(ids[ID.alice], `${ref}-${devCode}1`);

    // the preview never reserves numbers
    const again = await call("GET", `/api/tasks/rework-id-preview?reworkOf=${original.id}&userIds=${ID.alice}`, { token: T.adminA });
    assert.equal(again.data.data.people[0].referenceId, `${ref}-${devCode}2`);

    // a normal task that only mentions the original keeps a normal ID
    const normal = await mk({ name: "Note", reworkOf: original.id, departments: ["Tech Ops"], assignedUser: ID.dan });
    assert.match(normal.data.data.referenceId, /^TECH\d+$/);
    assert.equal((await call("GET", `/api/tasks/rework-id-preview?reworkOf=${original.id}&userIds=${ID.dan}`, { token: T.adminB })).status, 404);
  });
});

describe("Standard task — start / end and the chosen reminder", () => {
  const mk = (json) => call("POST", "/api/tasks", { token: T.adminA, json: { name: "Shift", assignedUser: ID.alice, ...json } });

  test("start and end are saved; the start must come before the end", async () => {
    const r = await mk({ startDate: "2031-10-31", startTime: "09:00", dueDate: "2031-10-31", dueTime: "16:00" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.data.startDate, "2031-10-31");
    assert.equal(r.data.data.startTime, "09:00");
    assert.equal(r.data.data.reminder, null);

    const backwards = await mk({ startDate: "2031-11-02", dueDate: "2031-10-31" });
    assert.equal(backwards.status, 400);
    assert.match(backwards.data.message, /before the end/);
    assert.equal((await mk({ startDate: "2031-10-31", startTime: "25:00", dueDate: "2031-11-01" })).status, 400);
    assert.equal((await mk({ startDate: "2031-02-30", dueDate: "2031-03-01" })).status, 400);
  });

  test("reminder options work out the right time; custom needs a time", async () => {
    const { startOf, deadlineOf } = await import("../src/services/taskNotificationService.js");
    const base = { startDate: "2031-10-31", startTime: "09:00", dueDate: "2031-11-02", dueTime: "16:00" };
    const atStart = await mk({ ...base, reminder: { option: "at_start" } });
    assert.equal(atStart.status, 201, JSON.stringify(atStart.data));
    assert.equal(new Date(atStart.data.data.reminder.at).getTime(), startOf(base).getTime());
    const dayBefore = await mk({ ...base, reminder: { option: "before_1d" } });
    assert.equal(new Date(dayBefore.data.data.reminder.at).getTime(), deadlineOf(base).getTime() - 24 * 3600 * 1000);

    assert.equal((await mk({ ...base, reminder: { option: "custom" } })).status, 400);
    assert.equal((await mk({ ...base, reminder: { option: "sometime" } })).status, 400);
    assert.equal((await mk({ dueDate: "2031-11-02", reminder: { option: "at_start" } })).status, 400, "no start date");
    const custom = await mk({ ...base, reminder: { option: "custom", customAt: "2031-11-01T10:30" } });
    assert.equal(custom.status, 201);
    assert.equal(custom.data.data.reminder.customAt, "2031-11-01T10:30");

    // moving the end moves a "before the end" reminder too
    const moved = await call("PATCH", `/api/tasks/${dayBefore.data.data.id}`, { token: T.adminA, json: { dueDate: "2031-11-05" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(
      new Date(moved.data.data.reminder.at).getTime(),
      deadlineOf({ dueDate: "2031-11-05", dueTime: "16:00" }).getTime() - 24 * 3600 * 1000
    );
    const off = await call("PATCH", `/api/tasks/${custom.data.data.id}`, { token: T.adminA, json: { reminder: { option: "none" } } });
    assert.equal(off.data.data.reminder, null);
  });

  test("the reminder is sent once, at its time, to the assignee", async () => {
    const { runChosenReminderSweep } = await import("../src/services/taskNotificationService.js");
    const r = await mk({ name: "Remind me", dueDate: "2031-12-10", reminder: { option: "custom", customAt: "2031-12-09T10:00" } });
    const at = new Date(r.data.data.reminder.at);
    assert.equal(await runChosenReminderSweep(new Date(at.getTime() - 60 * 1000)), 0, "not yet");
    assert.ok((await runChosenReminderSweep(new Date(at.getTime() + 60 * 1000))) >= 1);
    assert.equal(await runChosenReminderSweep(new Date(at.getTime() + 2 * 60 * 1000)), 0, "only once");
    const n = await call("GET", "/api/notifications", { token: T.alice });
    assert.ok(n.data.data.some((x) => x.type === "task_reminder" && /Reminder: "Remind me"/.test(x.message)));
  });
});

describe("Named reminders (title + date & time)", () => {
  test("saved, validated, edited and each sent once", async () => {
    const { runChosenReminderSweep } = await import("../src/services/taskNotificationService.js");
    const bad = await call("POST", "/api/tasks", {
      token: T.adminA,
      json: { name: "R", assignedUser: ID.alice, dueDate: "2031-12-20", reminders: [{ title: "", customAt: "2031-12-19T10:00" }] },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.message, /Give reminder 1 a title/);
    assert.equal((await call("POST", "/api/tasks", {
      token: T.adminA,
      json: { name: "R", assignedUser: ID.alice, dueDate: "2031-12-20", reminders: [{ title: "x", customAt: "soon" }] },
    })).status, 400);

    const r = await call("POST", "/api/tasks", {
      token: T.adminA,
      json: {
        name: "Client deck",
        assignedUser: ID.alice,
        dueDate: "2031-12-20",
        reminders: [
          { title: "Call the client", customAt: "2031-12-18T10:00" },
          { title: "Send the draft", customAt: "2031-12-19T15:30" },
        ],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const [first, second] = r.data.data.reminders;
    assert.equal(first.title, "Call the client");

    const t1 = new Date(first.at);
    assert.ok((await runChosenReminderSweep(new Date(t1.getTime() + 60000))) >= 1);
    assert.equal(await runChosenReminderSweep(new Date(t1.getTime() + 120000)), 0, "sent once");
    const n = await call("GET", "/api/notifications", { token: T.alice });
    assert.ok(n.data.data.some((x) => /Reminder: Call the client — task "Client deck"/.test(x.message)));

    // editing keeps the sent one as sent, a changed one goes out again
    const e = await call("PATCH", `/api/tasks/${r.data.data.id}`, {
      token: T.adminA,
      json: { reminders: [{ _id: first._id, title: first.title, customAt: first.customAt }, { _id: second._id, title: "Send the final draft", customAt: second.customAt }] },
    });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.ok(e.data.data.reminders[0].sentAt, "unchanged reminder stays sent");
    assert.equal(e.data.data.reminders[1].sentAt, null);
    assert.equal(e.data.data.reminders[1].title, "Send the final draft");
  });
});

describe("MoM video call room (WebRTC)", () => {
  let room;
  let meetingId;

  // a meeting that is open right now (started 5 minutes ago, ends in 30)
  const nowSlot = async () => {
    const { DateTime: DT } = await import("luxon");
    const zone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
    const start = DT.now().setZone(zone).minus({ minutes: 5 });
    const end = start.plus({ minutes: 35 });
    return { meetingDate: start.toISODate(), startTime: start.toFormat("HH:mm"), endTime: end.toFormat("HH:mm") };
  };

  before(async () => {
    const slot = await nowSlot();
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: { title: "Daily stand-up", ...slot, attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    meetingId = r.data.data._id;
    room = r.data.data.videoRoomId;
  });

  test("invited people see the room; others don't", async () => {
    const ok = await call("GET", `/api/meetings/room/${room}`, { token: T.alice });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.data.title, "Daily stand-up");
    assert.equal(ok.data.data.state, "open");
    assert.ok(ok.data.data.iceServers.length >= 1);
    assert.equal(ok.data.data.transcript, undefined, "no private meeting data");
    assert.equal((await call("GET", `/api/meetings/room/${room}`, { token: T.dan })).status, 404, "not invited");
    assert.equal((await call("GET", `/api/meetings/room/${room}`, { token: T.adminB })).status, 404, "other organization");
    assert.equal((await call("GET", `/api/meetings/room/nope`, { token: T.alice })).status, 404);
  });

  test("the link only opens around the scheduled time", async () => {
    const { roomState, meetingWindow } = await import("../src/services/videoRoomService.js");
    const m = { meetingDate: new Date("2031-05-10"), startTime: "10:00", endTime: "11:00", status: "Scheduled" };
    const w = meetingWindow(m);
    assert.equal(w.opensAt.getTime(), w.start.getTime() - 15 * 60000);
    assert.equal(w.closesAt.getTime(), w.end.getTime() + 30 * 60000);
    assert.equal(roomState(m, new Date(w.opensAt.getTime() - 1000)), "early");
    assert.equal(roomState(m, new Date(w.opensAt.getTime() + 1000)), "open");
    assert.equal(roomState(m, new Date(w.closesAt.getTime() + 1000)), "ended");
    assert.equal(roomState({ ...m, status: "Cancelled" }, w.start), "cancelled");
    // no end time → 1 hour
    const noEnd = meetingWindow({ ...m, endTime: "" });
    assert.equal(noEnd.end.getTime() - noEnd.start.getTime(), 60 * 60000);
  });

  test("signaling: join, see each other, relay offers only inside the room, leave", async () => {
    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const join = (s, roomId) => new Promise((resolve) => s.emit("meet:join", { roomId }, resolve));
    const next = (s, event) => new Promise((resolve) => s.once(event, resolve));

    const admin = await open(T.adminA);
    const alice = await open(T.alice);
    const dan = await open(T.dan);
    try {
      const a = await join(admin, room);
      assert.equal(a.ok, true, JSON.stringify(a));
      assert.deepEqual(a.peers, []);

      const joined = next(admin, "meet:peer-joined");
      const b = await join(alice, room);
      assert.equal(b.ok, true);
      assert.equal(b.peers.length, 1);
      assert.equal((await joined).name, "Alice Wonder");

      // relay an offer from Alice to the admin
      const got = next(admin, "meet:signal");
      alice.emit("meet:signal", { to: admin.id, description: { type: "offer", sdp: "v=0" } });
      const sig = await got;
      assert.equal(sig.from, alice.id);
      assert.equal(sig.description.type, "offer");

      // an outsider can't join or inject signals
      const refused = await join(dan, room);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "NOT_FOUND");
      let leaked = false;
      admin.once("meet:signal", () => (leaked = true));
      dan.emit("meet:signal", { to: admin.id, description: { type: "offer", sdp: "x" } });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(leaked, false);

      const meeting = await mongoose.model("Meeting").findById(meetingId).lean();
      assert.equal(meeting.status, "Ongoing", "first join starts the meeting");

      const left = next(admin, "meet:peer-left");
      alice.emit("meet:leave");
      assert.equal((await left).socketId, alice.id);

      // a meeting in the future is not open yet
      const later = await call("POST", "/api/meetings", { token: T.adminA, json: { title: "Later", meetingDate: "2031-06-01", startTime: "10:00" } });
      const early = await join(admin, later.data.data.videoRoomId);
      assert.equal(early.code, "TOO_EARLY");

      // deleting the meeting ends the call for everyone in it
      const ended = next(admin, "meet:ended");
      await call("DELETE", `/api/meetings/${meetingId}`, { token: T.adminA });
      assert.match((await ended).reason, /deleted/);
    } finally {
      admin.close();
      alice.close();
      dan.close();
    }
  });
});

describe("Task checklist (Desc · Type · Employee)", () => {
  test("rows are saved, validated, ticked / answered, and kept when the task is edited", async () => {
    const mk = (checklist) => call("POST", "/api/tasks", { token: T.adminA, json: { name: "Audit room", assignedUser: ID.alice, dueDate: "2031-09-01", checklist } });
    assert.equal((await mk([{ desc: "", type: "Check" }])).status, 400);
    assert.equal((await mk([{ desc: "x", type: "Slider" }])).status, 400);
    assert.equal((await mk([{ desc: "x", employee: ID.bob }])).status, 400, "employee from another organization");

    const r = await mk([
      { desc: "Lights off", type: "Check", employee: ID.dan },
      { desc: "Temperature", type: "Number" },
      { desc: "Notes", type: "Text" },
    ]);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const [light, temp] = r.data.data.checklist;
    assert.equal(light.employee.name, "Dan");
    assert.equal(light.done, false);

    const tick = await call("PATCH", `/api/tasks/${r.data.data.id}/checklist/${light._id}`, { token: T.alice, json: { done: true } });
    assert.equal(tick.status, 200, JSON.stringify(tick.data));
    assert.equal(tick.data.data.checklist[0].done, true);
    assert.equal((await call("PATCH", `/api/tasks/${r.data.data.id}/checklist/${temp._id}`, { token: T.alice, json: { value: "warm" } })).status, 400);
    const num = await call("PATCH", `/api/tasks/${r.data.data.id}/checklist/${temp._id}`, { token: T.alice, json: { value: "22.5" } });
    assert.equal(num.data.data.checklist[1].value, "22.5");
    assert.equal((await call("PATCH", `/api/tasks/${r.data.data.id}/checklist/${light._id}`, { token: T.bob, json: { done: false } })).status, 404, "other organization");

    // edit: keep row 1 (stays ticked), drop the others, add one
    const e = await call("PATCH", `/api/tasks/${r.data.data.id}`, {
      token: T.adminA,
      json: { checklist: [{ _id: light._id, desc: "Lights off", type: "Check", employee: ID.dan }, { desc: "Door locked", type: "Check" }] },
    });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.equal(e.data.data.checklist.length, 2);
    assert.equal(e.data.data.checklist[0].done, true);
    assert.equal(e.data.data.checklist[1].done, false);
  });
});

describe("Task Bank — files on repository items", () => {
  test("upload with a new item, download, carry onto assigned tasks, and keep shared files safe", async () => {
    const f = new FormData();
    f.append("title", "Onboarding pack");
    f.append("description", "Send the welcome documents");
    f.append("department", "Development");
    f.append("files", new Blob(["%PDF-1.4 handbook"], { type: "application/pdf" }), "handbook.pdf");
    const r = await call("POST", "/api/taskbank", { token: T.adminA, form: f });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const item = r.data.data;
    assert.equal(item.attachments.length, 1);
    const file = item.attachments[0];
    createdFiles.push(file.filename);
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, file.filename)));

    const dl = await call("GET", file.url, { token: T.adminA });
    assert.equal(dl.status, 200);
    assert.equal((await call("GET", file.url, { token: T.adminB })).status, 404, "other organization");

    const bad = new FormData();
    bad.append("title", "x");
    bad.append("description", "y");
    bad.append("files", new Blob(["MZ"]), "tool.exe");
    assert.equal((await call("POST", "/api/taskbank", { token: T.adminA, form: bad })).status, 400);

    // assigning gives the task the same file; deleting that task keeps the file for the template
    const a = await call("POST", `/api/taskbank/${item._id || item.id}/assign`, { token: T.adminA, json: { assignedUser: ID.alice } });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    const task = await call("GET", `/api/tasks/${a.data.tasks[0].id}`, { token: T.alice });
    assert.equal(task.data.data.attachments[0].filename, file.filename);
    assert.equal((await call("GET", `/api/tasks/attachments/${file.filename}`, { token: T.alice })).status, 200);
    await call("DELETE", `/api/tasks/${a.data.tasks[0].id}`, { token: T.adminA });
    assert.ok(fs.existsSync(path.join(UPLOAD_DIR, file.filename)), "template still uses it");

    // edit: drop the file → it is removed from disk
    const e = new FormData();
    e.append("title", "Onboarding pack");
    e.append("description", "Send the welcome documents");
    e.append("keepAttachments", "[]");
    const up = await call("PUT", `/api/taskbank/${item._id || item.id}`, { token: T.adminA, form: e });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.data.attachments.length, 0);
    assert.equal(fs.existsSync(path.join(UPLOAD_DIR, file.filename)), false);
  });
});

describe("WebRTC ICE servers (STUN / TURN)", () => {
  const saved = {};
  const keys = ["STUN_URLS", "TURN_URLS", "TURN_URL", "TURN_SECRET", "TURN_USERNAME", "TURN_CREDENTIAL", "WEBRTC_FORCE_RELAY"];
  before(() => keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
  after(() => keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

  test("Google STUN servers by default; no TURN until configured", async () => {
    const { iceServers, GOOGLE_STUN_SERVERS } = await import("../src/services/videoRoomService.js");
    const list = iceServers({ _id: "u1" });
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].urls, GOOGLE_STUN_SERVERS);
    assert.equal(GOOGLE_STUN_SERVERS.length, 5);
  });

  test("TURN with a shared secret gives each user a short-lived password (secret never sent)", async () => {
    const crypto = await import("node:crypto");
    const { iceServers, TURN_TTL_SECONDS } = await import("../src/services/videoRoomService.js");
    process.env.TURN_URLS = "turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp";
    process.env.TURN_SECRET = "s3cret";
    const now = Date.UTC(2031, 0, 1);
    const turn = iceServers({ _id: "user42" }, now)[1];
    assert.deepEqual(turn.urls, ["turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"]);
    assert.equal(turn.username, `${now / 1000 + TURN_TTL_SECONDS}:user42`);
    assert.equal(turn.credential, crypto.createHmac("sha1", "s3cret").update(turn.username).digest("base64"));
    assert.ok(!JSON.stringify(turn).includes("s3cret"));

    delete process.env.TURN_SECRET;
    process.env.TURN_USERNAME = "provider-user";
    process.env.TURN_CREDENTIAL = "provider-pass";
    assert.equal(iceServers({ _id: "x" })[1].username, "provider-user");

    process.env.WEBRTC_FORCE_RELAY = "true";
    const { iceTransportPolicy } = await import("../src/services/videoRoomService.js");
    assert.equal(iceTransportPolicy(), "relay");
  });
});

describe("Transcript speakers named from the video call", () => {
  test("a speaker gets the name of the person whose microphone was talking — only when clear", async () => {
    const { nameSpeakersByCall } = await import("../src/utils/callSpeakers.js");
    const t0 = new Date("2031-01-01T10:00:00Z");
    const at = (s) => new Date(t0.getTime() + s * 1000);
    const activity = [
      { userId: "a1", name: "Alice", start: at(0), end: at(10) },
      { userId: "d1", name: "Dan", start: at(10.5), end: at(20) },
      { userId: "a1", name: "Alice", start: at(30), end: at(32) },
      { userId: "d1", name: "Dan", start: at(30), end: at(32) }, // both talking at once
    ];
    const entries = [
      { speakerId: "S1", offsetSec: 1, endSec: 9 },
      { speakerId: "S2", offsetSec: 11, endSec: 19 },
      { speakerId: "S3", offsetSec: 30, endSec: 32 },
    ];
    const speakers = ["S1", "S2", "S3", "S4"].map((id) => ({ id, label: `Speaker ${id.slice(1)}`, name: "", matchedBy: "" }));
    speakers.push({ id: "S5", label: "Speaker 5", name: "Mia", matchedBy: "manual" });
    const { speakers: out, matched } = nameSpeakersByCall(speakers, entries, activity, t0, [{ userId: "a1", name: "Alice Wonder", email: "alice@test.io" }]);
    const by = Object.fromEntries(out.map((s) => [s.id, s]));
    assert.equal(by.S1.name, "Alice Wonder");
    assert.equal(by.S1.email, "alice@test.io");
    assert.equal(by.S1.matchedBy, "call");
    assert.equal(by.S2.name, "Dan");
    assert.equal(by.S3.name, "", "two people at once → not guessed");
    assert.equal(by.S4.name, "", "no lines → unnamed");
    assert.equal(by.S5.name, "Mia", "a name chosen by hand is kept");
    assert.equal(matched, 2);
    assert.equal(nameSpeakersByCall(speakers, entries, activity, null).matched, 0, "no in-call recording → nothing");
  });

  test("the call stores who talked when, and only the organizer can record", async () => {
    const { DateTime } = await import("luxon");
    const zone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
    const start = DateTime.now().setZone(zone).minus({ minutes: 5 });
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Talk test",
        meetingDate: start.toISODate(),
        startTime: start.toFormat("HH:mm"),
        endTime: start.plus({ minutes: 40 }).toFormat("HH:mm"),
        attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }],
      },
    });
    const room = r.data.data.videoRoomId;
    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const emit = (s, ev, data) => new Promise((resolve) => s.emit(ev, data, resolve));
    const admin = await open(T.adminA);
    const alice = await open(T.alice);
    try {
      assert.equal((await emit(admin, "meet:join", { roomId: room })).canRecord, true);
      assert.equal((await emit(alice, "meet:join", { roomId: room })).canRecord, false);
      assert.equal((await emit(alice, "meet:recording", { on: true })).ok, false, "attendees can't record");

      const notice = new Promise((resolve) => alice.once("meet:recording", resolve));
      const rec = await emit(admin, "meet:recording", { on: true });
      assert.equal(rec.ok, true);
      assert.equal((await notice).on, true, "everyone is told the call is recorded");

      alice.emit("meet:speaking", { on: true });
      await new Promise((res) => setTimeout(res, 400));
      alice.emit("meet:speaking", { on: false });
      await new Promise((res) => setTimeout(res, 200));

      const m = await mongoose.model("Meeting").findById(r.data.data._id).select("+callActivity callRecording").lean();
      assert.ok(m.callRecording.startedAt, "recording start stamped by the server");
      assert.equal(m.callActivity.length, 1);
      assert.equal(String(m.callActivity[0].userId), String(ID.alice));
      assert.ok(new Date(m.callActivity[0].end) - new Date(m.callActivity[0].start) >= 250);
      // not leaked in the normal meeting API
      const g = await call("GET", `/api/meetings/${r.data.data._id}`, { token: T.adminA });
      assert.equal(g.data.data.callActivity, undefined);
    } finally {
      admin.close();
      alice.close();
    }
  });
});

describe("Video call live transcript with each person's name", () => {
  test("captions are saved under the speaker's own account and shown in MoM after the call", async () => {
    const { DateTime } = await import("luxon");
    const zone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
    const start = DateTime.now().setZone(zone).minus({ minutes: 5 });
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Caption test",
        meetingDate: start.toISODate(),
        startTime: start.toFormat("HH:mm"),
        endTime: start.plus({ minutes: 40 }).toFormat("HH:mm"),
        attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }],
      },
    });
    const mid = r.data.data._id;
    const room = r.data.data.videoRoomId;
    const info = await call("GET", `/api/meetings/room/${room}`, { token: T.alice });
    assert.equal(info.data.data.speechLang, "en-IN");

    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const emit = (s, ev, data) => new Promise((resolve) => s.emit(ev, data, resolve));
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const admin = await open(T.adminA);
    const alice = await open(T.alice);
    try {
      const j = await emit(admin, "meet:join", { roomId: room });
      assert.ok(j.transcribing, "every call starts with the transcript on");
      await emit(alice, "meet:join", { roomId: room });

      // anyone in the call can switch it off — nothing is saved while it is off
      const offNotice = new Promise((res) => admin.once("meet:transcription", res));
      assert.equal((await emit(alice, "meet:transcription", { on: false })).ok, true, "attendees can switch it too");
      const n = await offNotice;
      assert.equal(n.on, false);
      assert.equal(n.by, "Alice Wonder", "everyone sees who switched it");
      alice.emit("meet:caption", { text: "while it was off", final: true });
      await wait(150);
      const turnedOn = new Promise((res) => alice.once("meet:transcription", res));
      assert.equal((await emit(admin, "meet:transcription", { on: true })).ok, true);
      assert.equal((await turnedOn).on, true);

      const live = new Promise((res) => admin.once("meet:caption", res));
      alice.emit("meet:caption", { text: "Good morning everyone", final: true, name: "Somebody Else" });
      const seen = await live;
      assert.equal(seen.name, "Alice Wonder", "name from the account, not the message");
      alice.emit("meet:caption", { text: "still talk", final: false });
      admin.emit("meet:caption", { text: "Morning Alice, let's start", final: true });
      await wait(300);

      const t = await call("GET", `/api/meetings/${mid}/transcript`, { token: T.adminA });
      assert.equal(t.status, 200);
      const tr = t.data.data.transcript || t.data.data;
      assert.equal(tr.source, "live");
      assert.deepEqual(tr.entries.map((e) => e.text), ["Good morning everyone", "Morning Alice, let's start"], "interim text and pre-switch lines are not saved");
      assert.equal(tr.entries[0].speaker, "Alice Wonder");
      assert.notEqual(tr.entries[1].speaker, "Alice Wonder");
      assert.equal(tr.speakers.length, 2);
      assert.ok(tr.speakers.every((s) => s.userId && s.matchedBy === "call"));

      // a transcript from another source is never mixed with captions
      await mongoose.model("Meeting").updateOne({ _id: mid }, { "transcript.source": "whisper" });
      const warned = new Promise((res) => alice.once("meet:caption-error", res));
      alice.emit("meet:caption", { text: "not saved", final: true });
      assert.match((await warned).message, /not saved/);
      const after = await mongoose.model("Meeting").findById(mid).lean();
      assert.equal(after.transcript.entries.length, 2);
    } finally {
      admin.close();
      alice.close();
    }
  });
});

describe("Video call transcript from each person's own microphone (server Whisper)", () => {
  test("a participant's speech clip becomes a line under their account and reaches everyone", async () => {
    const { DateTime } = await import("luxon");
    const zone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";
    const start = DateTime.now().setZone(zone).minus({ minutes: 5 });
    const r = await call("POST", "/api/meetings", {
      token: T.adminA,
      json: {
        title: "Clip test",
        meetingDate: start.toISODate(),
        startTime: start.toFormat("HH:mm"),
        endTime: start.plus({ minutes: 40 }).toFormat("HH:mm"),
        attendees: [{ name: "Alice", email: "alice@test.io", userId: ID.alice }],
      },
    });
    const room = r.data.data.videoRoomId;
    const clip = () => {
      const f = new FormData();
      f.append("audio", new Blob(["fake-opus"], { type: "audio/webm" }), "speech.webm");
      f.append("durationSec", "2");
      return f;
    };
    const { io: connect } = await import("socket.io-client");
    const open = (token) =>
      new Promise((resolve, reject) => {
        const s = connect(base, { auth: { token }, transports: ["websocket"], forceNew: true });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
      });
    const emit = (s, ev, data) => new Promise((resolve) => s.emit(ev, data, resolve));

    // not in the call yet → refused
    assert.equal((await call("POST", `/api/meet/${room}/caption`, { token: T.alice, form: clip() })).status, 403);
    const admin = await open(T.adminA);
    const alice = await open(T.alice);
    try {
      await emit(admin, "meet:join", { roomId: room });
      await emit(alice, "meet:join", { roomId: room });

      const heard = new Promise((res) => admin.once("meet:caption", res));
      const sent = await call("POST", `/api/meet/${room}/caption`, { token: T.alice, form: clip() });
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      assert.ok(sent.data.data.text, "the (fake) transcriber's text");
      const cap = await heard;
      assert.equal(cap.text, sent.data.data.text);
      assert.equal(cap.name, "Alice Wonder");
      assert.equal(cap.userId, String(ID.alice));

      const m = await mongoose.model("Meeting").findById(r.data.data._id).lean();
      assert.equal(m.transcript.source, "live");
      assert.equal(m.transcript.entries.at(-1).speaker, "Alice Wonder");
      assert.equal(String(m.transcript.speakers.find((s) => s.id === m.transcript.entries.at(-1).speakerId).userId), String(ID.alice));

      // someone outside the meeting can't post into it
      assert.equal((await call("POST", `/api/meet/${room}/caption`, { token: T.dan, form: clip() })).status, 404);
      // transcript off → nothing is accepted
      await emit(admin, "meet:transcription", { on: false });
      const off = await call("POST", `/api/meet/${room}/caption`, { token: T.alice, form: clip() });
      assert.equal(off.status, 409);
      assert.equal(off.data.code, "TRANSCRIPT_OFF");
    } finally {
      admin.close();
      alice.close();
    }
  });
});

describe("Call transcript via a whisper.cpp server (Meetily's engine)", () => {
  test("clips go to WHISPER_SERVER_URL /inference as 16 kHz WAV when it is set", async () => {
    const http = await import("node:http");
    const { transcribeClip } = await import("../src/services/callTranscriptService.js");
    const { spawnSync } = await import("node:child_process");
    const ffmpeg = (await import("ffmpeg-static")).default;
    const os = await import("node:os");

    // a real 1-second webm clip for ffmpeg to convert
    const clip = path.join(os.tmpdir(), `clip-test-${Date.now()}.webm`);
    spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", clip]);
    assert.ok(fs.existsSync(clip));

    let got = null;
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        got = { url: req.url, body: Buffer.concat(chunks).toString("latin1") };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ text: " Hello from whisper.cpp " }));
      });
    });
    await new Promise((r) => srv.listen(0, r));
    process.env.WHISPER_SERVER_URL = `http://127.0.0.1:${srv.address().port}/`;
    try {
      const text = await transcribeClip(clip, "en");
      assert.equal(text, "Hello from whisper.cpp");
      assert.equal(got.url, "/inference");
      assert.match(got.body, /name="response_format"[\s\S]*json/);
      assert.match(got.body, /name="language"[\s\S]*en/);
      assert.match(got.body, /RIFF.{4}WAVE/, "sent as WAV");
      assert.equal(fs.existsSync(clip), false, "clip removed after use");
    } finally {
      delete process.env.WHISPER_SERVER_URL;
      srv.close();
    }
  });
});
