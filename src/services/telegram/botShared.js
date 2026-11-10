import { DateTime } from "luxon";

/* Helpers shared by the task and meeting parts of the bot. */

/* ---------- typed-input sessions (wizards) ---------- */
const sessions = new Map(); // chatId → { flow, step, data, at }
const SESSION_TTL = 30 * 60 * 1000;

export const getSession = (chatId) => {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.at > SESSION_TTL) {
    sessions.delete(chatId);
    return null;
  }
  return s || null;
};
export const setSession = (chatId, s) => sessions.set(chatId, { ...s, at: Date.now() });
export const endSession = (chatId) => sessions.delete(chatId);

export const can = (me, moduleId, action) => Boolean(me.permissions?.[moduleId]?.includes(action));

/* ---------- typed dates and times ---------- */
export const parseDate = (input, zone) => {
  const s = String(input || "").trim().toLowerCase();
  const today = DateTime.now().setZone(zone).startOf("day");
  if (s === "today") return today.toISODate();
  if (s === "tomorrow") return today.plus({ days: 1 }).toISODate();
  for (const fmt of ["yyyy-MM-dd", "dd-MM-yyyy", "dd/MM/yyyy", "d/M/yyyy", "d-M-yyyy", "d/M", "d-M"]) {
    const d = DateTime.fromFormat(s, fmt, { zone });
    if (d.isValid) return d.toISODate();
  }
  return null;
};

export const parseTime = (input) => {
  const m = String(input || "").trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};

// Today / Tomorrow / In 3 days / In 7 days buttons → `${prefix}YYYY-MM-DD`
export const dateButtons = (prefix, zone) => {
  const today = DateTime.now().setZone(zone);
  const b = (text, days) => ({ text, callback_data: `${prefix}${today.plus({ days }).toISODate()}` });
  return [
    [b("Today", 0), b("Tomorrow", 1)],
    [b("In 3 days", 3), b("In 7 days", 7)],
  ];
};

// multi-select people picker (tasks: assignees, meetings: attendees / action owners)
export const PEOPLE_PER_PAGE = 8;
export const peopleKeyboard = ({ people, selected, page = 0 }, prefix, cancelData) => {
  const pages = Math.max(1, Math.ceil(people.length / PEOPLE_PER_PAGE));
  const kb = people.slice(page * PEOPLE_PER_PAGE, (page + 1) * PEOPLE_PER_PAGE).map((u, i) => {
    const idx = page * PEOPLE_PER_PAGE + i;
    const on = selected.includes(String(u._id));
    return [{ text: `${on ? "☑️" : "⬜"} ${u.name}${u.department ? ` · ${u.department}` : ""}`.slice(0, 60), callback_data: `${prefix}:u:${idx}` }];
  });
  const nav = [];
  if (page > 0) nav.push({ text: "◀️", callback_data: `${prefix}:up:${page - 1}` });
  if (page < pages - 1) nav.push({ text: "▶️", callback_data: `${prefix}:up:${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: `✔️ Done (${selected.length})`, callback_data: `${prefix}:ud` }], [{ text: "✖️ Cancel", callback_data: cancelData }]);
  return { inline_keyboard: kb };
};

/* ---------- wrong link codes: 5 tries per chat, then 1 hour blocked ---------- */
const MAX_WRONG_CODES = 5;
const BLOCK_MS = 60 * 60 * 1000;
const wrongCodes = new Map(); // chatId → { count, first }

export const linkBlocked = (chatId) => {
  const w = wrongCodes.get(chatId);
  if (!w) return false;
  if (Date.now() - w.first > BLOCK_MS) {
    wrongCodes.delete(chatId);
    return false;
  }
  return w.count >= MAX_WRONG_CODES;
};
export const noteWrongCode = (chatId) => {
  const w = wrongCodes.get(chatId);
  if (!w || Date.now() - w.first > BLOCK_MS) wrongCodes.set(chatId, { count: 1, first: Date.now() });
  else w.count += 1;
  return MAX_WRONG_CODES - wrongCodes.get(chatId).count; // tries left
};
export const clearWrongCodes = (chatId) => wrongCodes.delete(chatId);
