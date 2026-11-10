import { DateTime } from "luxon";
import { esc } from "./telegramApi.js";

/* Message text + inline keyboards for tasks (pure functions, no I/O). */

export const STATUSES = ["To Do", "In Progress", "Review", "Completed"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];

export const STATUS_ICON = { "To Do": "⚪", "In Progress": "🔵", Review: "🟣", Completed: "✅" };
export const PRIORITY_ICON = { Low: "🟢", Medium: "🟡", High: "🟠", Critical: "🔴" };

// list filters: callback key → status test
export const FILTERS = {
  o: { label: "Open", test: (t) => t.status !== "Completed" },
  t: { label: "To Do", test: (t) => t.status === "To Do" },
  p: { label: "In Progress", test: (t) => t.status === "In Progress" },
  r: { label: "Review", test: (t) => t.status === "Review" },
  c: { label: "Done", test: (t) => t.status === "Completed" },
  a: { label: "All", test: () => true },
};

export const PAGE_SIZE = 8;

const same = (a, b) => Boolean(a && b) && String(a) === String(b);

export const fmtDue = (task, zone) => {
  if (!task.dueDate) return "";
  const d = DateTime.fromISO(task.dueDate, { zone });
  return `${d.toFormat("dd LLL yyyy")}${task.dueTime ? ` ${task.dueTime}` : ""}`;
};

export const isOverdue = (task, zone) => {
  if (!task.dueDate || task.status === "Completed") return false;
  const end = DateTime.fromISO(`${task.dueDate}T${task.dueTime || "23:59"}`, { zone });
  return end < DateTime.now().setZone(zone);
};

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ---------- task list ---------- */
export const renderTaskList = ({ tasks, kind, filter, page, zone }) => {
  const f = FILTERS[filter] || FILTERS.o;
  const shown = tasks.filter(f.test);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = shown.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const title = kind === "b" ? "📤 Tasks I assigned" : "📋 My tasks";

  const lines = [`<b>${title}</b> · ${f.label} (${shown.length})`, ""];
  if (!slice.length) lines.push("<i>Nothing here.</i>");
  slice.forEach((t, i) => {
    const n = p * PAGE_SIZE + i + 1;
    const due = fmtDue(t, zone);
    const who = kind === "b" ? ` · 👤 ${esc(t.assignedUser || "—")}` : "";
    lines.push(
      `${n}. ${STATUS_ICON[t.status] || ""}${PRIORITY_ICON[t.priority] || ""} <b>${esc(cut(t.name, 60))}</b>` +
        `${t.referenceId ? ` <code>${esc(t.referenceId)}</code>` : ""}` +
        `${due ? `\n    📅 ${due}${isOverdue(t, zone) ? " ⚠️ overdue" : ""}` : ""}${who}`
    );
  });
  if (pages > 1) lines.push("", `Page ${p + 1}/${pages}`);

  const keyboard = slice.map((t, i) => [{ text: `${p * PAGE_SIZE + i + 1}. ${cut(t.name, 40)}`, callback_data: `t:${t.id}` }]);
  keyboard.push(
    ["o", "t", "p", "r"].map((k) => ({ text: `${k === filter ? "• " : ""}${FILTERS[k].label}`, callback_data: `l:${kind}:${k}:0` })),
    ["c", "a"].map((k) => ({ text: `${k === filter ? "• " : ""}${FILTERS[k].label}`, callback_data: `l:${kind}:${k}:0` }))
  );
  const nav = [];
  if (p > 0) nav.push({ text: "◀️ Prev", callback_data: `l:${kind}:${filter}:${p - 1}` });
  nav.push({ text: "🔄 Refresh", callback_data: `l:${kind}:${filter}:${p}` });
  if (p < pages - 1) nav.push({ text: "Next ▶️", callback_data: `l:${kind}:${filter}:${p + 1}` });
  keyboard.push(nav);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
};

/* ---------- who may do what (the API still has the final say) ---------- */
export const roleOn = (task, me) => {
  const isAssignee = same(task.assignedTo, me._id);
  const isAssigner = task.assignedBy ? same(task.assignedBy, me._id) : ["SuperAdmin", "Admin", "Manager"].includes(me.role);
  const isManager = isAssigner || ["SuperAdmin", "Admin", "Manager"].includes(me.role);
  const selfAssigned = same(task.assignedBy, task.assignedTo);
  return { isAssignee, isAssigner, isManager, selfAssigned };
};

const statusTargets = (task, me) => {
  const { isAssigner } = roleOn(task, me);
  if (task.status === "Completed") return isAssigner ? ["In Progress"] : [];
  return STATUSES.filter((s) => s !== task.status && (s !== "Completed" || isAssigner));
};

const statusLabel = (task, to, me) => {
  const { isAssigner, selfAssigned } = roleOn(task, me);
  if (task.status === "Completed") return "↩️ Reopen";
  if (to === "Completed") return task.status === "Review" && !selfAssigned ? "✅ Approve" : "✅ Completed";
  if (task.status === "Review" && isAssigner && !selfAssigned) return `🔁 Rework → ${to}`;
  if (to === "Review") return "🟣 Send for review";
  if (to === "In Progress") return "▶️ Start / In Progress";
  return `${STATUS_ICON[to]} ${to}`;
};

/* ---------- one task ---------- */
export const renderTask = ({ task, me, zone, perms }) => {
  const { isManager } = roleOn(task, me);
  const lines = [
    `<b>${esc(task.name)}</b>${task.referenceId ? `  <code>${esc(task.referenceId)}</code>` : ""}`,
    "",
    `${STATUS_ICON[task.status] || ""} Status: <b>${esc(task.status)}</b>`,
    `${PRIORITY_ICON[task.priority] || ""} Priority: ${esc(task.priority)}`,
  ];
  const due = fmtDue(task, zone);
  if (due) lines.push(`📅 Due: ${due}${isOverdue(task, zone) ? " ⚠️ <b>overdue</b>" : ""}`);
  lines.push(`👤 Assigned to: ${esc(task.assignedUser || "—")}`);
  if (task.assignedByName) lines.push(`🧑‍💼 Assigned by: ${esc(task.assignedByName)}`);
  if (task.departments?.length) lines.push(`🏢 ${esc(task.departments.join(", "))}`);
  if (task.taskType && task.taskType !== "standard") lines.push(`🏷 Type: ${esc(task.taskType)}`);
  if (task.reworkCount) lines.push(`🔁 Rework count: ${task.reworkCount}`);
  if (task.reviewScore) lines.push(`⭐ Review score: ${task.reviewScore}/10`);
  if (task.description) lines.push("", esc(cut(task.description, 900)));

  if (task.subtasks?.length) {
    lines.push("", `<b>Subtasks</b> (${task.subtasks.filter((s) => s.completed).length}/${task.subtasks.length})`);
    task.subtasks.slice(0, 15).forEach((s) => lines.push(`${s.completed ? "☑️" : "⬜"} ${esc(cut(s.title, 80))}`));
  }
  if (task.checklist?.length) {
    lines.push("", `<b>Checklist</b> (${task.checklist.filter((c) => c.done).length}/${task.checklist.length})`);
    task.checklist.slice(0, 15).forEach((c) =>
      lines.push(`${c.done ? "☑️" : "⬜"} ${esc(cut(c.desc, 80))}${c.type !== "Check" && c.value ? ` — <i>${esc(c.value)}</i>` : ""}`)
    );
  }
  const last = task.statusHistory?.[task.statusHistory.length - 1];
  if (last?.note) lines.push("", `📝 Last note: <i>${esc(cut(last.note, 300))}</i>`);
  if (task.attachments?.length) lines.push("", `📎 ${task.attachments.length} attachment(s) — open in the web app`);

  const kb = [];
  const targets = statusTargets(task, me);
  for (let i = 0; i < targets.length; i += 2) {
    kb.push(
      targets.slice(i, i + 2).map((to) => ({ text: statusLabel(task, to, me), callback_data: `s:${task.id}:${STATUSES.indexOf(to)}` }))
    );
  }
  task.subtasks?.slice(0, 10).forEach((s) =>
    kb.push([{ text: `${s.completed ? "☑️" : "⬜"} ${cut(s.title, 45)}`, callback_data: `u:${task.id}:${s._id}` }])
  );
  task.checklist?.slice(0, 10).forEach((c) =>
    kb.push([{ text: `${c.done ? "☑️" : "⬜"} ${cut(c.desc, 45)}${c.type !== "Check" ? " ✏️" : ""}`, callback_data: `k:${task.id}:${c._id}` }])
  );
  const tools = [];
  if (isManager && task.status !== "Completed") tools.push({ text: "➕ Subtask", callback_data: `as:${task.id}` });
  if (perms?.tasks?.includes("delete") && isManager) tools.push({ text: "🗑 Delete", callback_data: `dl:${task.id}` });
  if (tools.length) kb.push(tools);
  kb.push([
    { text: "🔄 Refresh", callback_data: `t:${task.id}` },
    { text: "⬅️ My tasks", callback_data: "l:m:o:0" },
  ]);
  return { text: lines.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: kb } };
};

export const scoreKeyboard = (taskId) => ({
  inline_keyboard: [
    [1, 2, 3, 4, 5].map((n) => ({ text: String(n), callback_data: `sc:${taskId}:${n}` })),
    [6, 7, 8, 9, 10].map((n) => ({ text: String(n), callback_data: `sc:${taskId}:${n}` })),
    [{ text: "✖️ Cancel", callback_data: `t:${taskId}` }],
  ],
});
