// Shared CSV helpers (used by task calendar + task import)

export const parseCSVLine = (line) => {
  const values = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; }
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { values.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  values.push(cur.trim());
  return values;
};

export const normalizeHeader = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// → { headers: [...normalized], rows: [{ line: <1-based line no>, values: [...] }] }
export const readCSV = (text) => {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .split(/\r?\n/);

  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) throw new Error("The CSV file is empty.");

  const headers = parseCSVLine(lines[firstIdx]).map(normalizeHeader);
  const rows = [];
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const values = parseCSVLine(lines[i]);
    // Excel saves empty rows as ",,,,," — those are blank too, not errors
    if (values.every((v) => String(v ?? "").trim() === "")) continue;
    rows.push({ line: i + 1, values });
  }
  return { headers, rows };
};

// Strict YYYY-MM-DD that is also a real calendar day
export const isValidISODate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/* ==================== Flexible dates / times for CSV import ====================
 * People type dates every way (and Excel rewrites them), so accept them all:
 *   2026-11-07 · 2026/11/07 · 07-11-2026 · 07/11/2026 · 07.11.2026 · 7/11/26
 *   7 Nov 2026 · 07-Nov-2026 · Nov 7, 2026 · November 7 2026 · Saturday, 7 November 2026
 *   Excel serial numbers (46333) · ISO with time (2026-11-07T10:30) · "07/11/2026 10:30 AM"
 * Day-first when it is unclear (07/11/2026 = 7 Nov); a number above 12 decides the order.
 */
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad = (n) => String(n).padStart(2, "0");

const buildDate = (y, m, d) => {
  let year = Number(y);
  if (String(y).length <= 2) year += 2000; // 26 → 2026
  const month = Number(m);
  const day = Number(d);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return isValidISODate(iso) ? iso : null;
};

/** "17:00" · "5:30 pm" · "5pm" · "0930" · "9.30" · "10:30:00" → "HH:mm", or null if it is not a time */
export const parseFlexibleTime = (value) => {
  const v = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return "";
  const m = v.match(/^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?(am|pm|a\.m\.|p\.m\.)?$/) || v.match(/^(\d{2})(\d{2})()$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = (m[3] || "").replace(/\./g, "");
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
  } else if (!m[2] && m[0].length <= 2) {
    return null; // a bare "9" is not clearly a time
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
};

/** Any common date (optionally with a time) → { date: "YYYY-MM-DD", time: "HH:mm" | "" }, or null */
export const parseFlexibleDate = (value) => {
  let v = String(value || "").trim();
  if (!v) return null;

  // Excel serial day number (1900 date system)
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400000);
      const d = new Date(ms);
      const frac = serial % 1;
      const mins = Math.round(frac * 1440);
      return { date: d.toISOString().slice(0, 10), time: frac ? `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` : "" };
    }
  }

  // split off a trailing time: "07/11/2026 10:30 AM", "2026-11-07T10:30:00Z"
  let time = "";
  const timeMatch = v.match(/[T\s,]+(\d{1,2}[:.]\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[ap]\.?m\.?)?)\s*(?:z|[+-]\d{2}:?\d{2})?$/i);
  if (timeMatch) {
    const t = parseFlexibleTime(timeMatch[1].replace(/:\d{2}\.\d+/, ""));
    if (t) {
      time = t;
      v = v.slice(0, timeMatch.index).trim();
    }
  }

  // drop a weekday name: "Saturday, 7 November 2026"
  v = v.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");

  let date = null;
  let m;
  if ((m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    date = buildDate(m[1], m[2], m[3]); // 2026-11-07
  } else if ((m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    date = b > 12 && a <= 12 ? buildDate(m[3], a, b) : buildDate(m[3], b, a); // day-first unless clearly month-first
  } else if ((m = v.match(/^(\d{1,2})[-/.\s]+([a-z]+)\.?[-/.,\s]+(\d{2}|\d{4})$/i))) {
    date = MONTHS[m[2].toLowerCase()] ? buildDate(m[3], MONTHS[m[2].toLowerCase()], m[1]) : null; // 7 Nov 2026
  } else if ((m = v.match(/^([a-z]+)\.?[-/.\s]+(\d{1,2}),?[-/.\s]+(\d{2}|\d{4})$/i))) {
    date = MONTHS[m[1].toLowerCase()] ? buildDate(m[3], MONTHS[m[1].toLowerCase()], m[2]) : null; // Nov 7, 2026
  } else if ((m = v.match(/^(\d{4})[-/.\s]+([a-z]+)\.?[-/.\s]+(\d{1,2})$/i))) {
    date = MONTHS[m[2].toLowerCase()] ? buildDate(m[1], MONTHS[m[2].toLowerCase()], m[3]) : null; // 2026-Nov-07
  }
  return date ? { date, time } : null;
};
