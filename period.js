// Budget periods ("months") that start on a configurable day.
//
// A period is identified by the "YYYY-MM" of the calendar month it STARTS in. With startDay 25,
// "2026-11" runs 25 Nov – 24 Dec. With startDay 1 a period is exactly the calendar month.
// A startDay past a month's end uses that month's last day (31 → 28/29 in February).
//
// Pure functions on ISO date strings; all date math is done in UTC so DST never shifts a day.

const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, "0");
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const toUTC = iso => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const startDayIn = (y, m, startDay) => Math.min(startDay, daysInMonth(y, m));

export const DEFAULT_START_DAY = 1;
export const isValidStartDay = v => Number.isInteger(v) && v >= 1 && v <= 31;
export const normalizeStartDay = v => (isValidStartDay(Number(v)) ? Number(v) : DEFAULT_START_DAY);

export const isPeriodKey = key => /^\d{4}-(0[1-9]|1[0-2])$/.test(key);

export function shiftPeriod(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const addDays = (iso, n) => fromUTC(toUTC(iso) + n * DAY_MS);
export const daysBetween = (fromIso, toIso) => Math.round((toUTC(toIso) - toUTC(fromIso)) / DAY_MS);

// { start, end, days }: inclusive ISO bounds of the period
export function periodRange(key, startDay) {
  const [y, m] = key.split("-").map(Number);
  const start = `${key}-${pad(startDayIn(y, m, startDay))}`;
  const [ny, nm] = shiftPeriod(key, 1).split("-").map(Number);
  const end = fromUTC(Date.UTC(ny, nm - 1, startDayIn(ny, nm, startDay)) - DAY_MS);
  return { start, end, days: daysBetween(start, end) + 1 };
}

// Key of the period containing the ISO date
export function periodOf(iso, startDay) {
  const [y, m, d] = iso.split("-").map(Number);
  const key = `${y}-${pad(m)}`;
  return d >= startDayIn(y, m, startDay) ? key : shiftPeriod(key, -1);
}

export const inPeriod = (iso, range) => iso >= range.start && iso <= range.end;

// The date a monthly item due on `dayOfMonth` falls on within the period.
// Clamped to the period's end for the rare day a short February skips (e.g. startDay 31, day 28).
export function dateInPeriod(key, dayOfMonth, startDay) {
  const range = periodRange(key, startDay);
  const [y, m] = key.split("-").map(Number);
  const inStartMonth = `${key}-${pad(Math.min(dayOfMonth, daysInMonth(y, m)))}`;
  if (inStartMonth >= range.start) return inStartMonth;
  const next = shiftPeriod(key, 1);
  const [ny, nm] = next.split("-").map(Number);
  const inNextMonth = `${next}-${pad(Math.min(dayOfMonth, daysInMonth(ny, nm)))}`;
  return inNextMonth <= range.end ? inNextMonth : range.end;
}
