// Small timezone-safe calendar helpers. Dates are validated and handled as
// YYYY-MM-DD strings/UTC dates; no local timezone shifts are allowed.

export const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isValidDateString(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [, y, m, d] = value.match(ISO_DATE_RE);
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export function parseISODate(value) {
  if (!isValidDateString(value)) {
    throw new RangeError(`Invalid ISO calendar date: ${String(value)}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function compareISODate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monthKeyFromDate(value) {
  if (typeof value !== 'string' || value.length < 7 || !MONTH_RE.test(value.slice(0, 7))) {
    throw new RangeError(`Invalid date for month key: ${String(value)}`);
  }
  return value.slice(0, 7);
}

export function compareMonth(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addMonths(month, delta) {
  const match = MONTH_RE.exec(month);
  if (!match) throw new RangeError(`Invalid month: ${month}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function enumerateMonths(start, end) {
  if (!MONTH_RE.test(start) || !MONTH_RE.test(end) || compareMonth(start, end) > 0) {
    throw new RangeError(`Invalid month range: ${start}..${end}`);
  }
  const out = [];
  let cur = start;
  // Range is short for this workbench, but cap defensively.
  for (let i = 0; i < 1200 && compareMonth(cur, end) <= 0; i += 1) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

export function monthDistance(fromMonth, toMonth) {
  const a = MONTH_RE.exec(fromMonth);
  const b = MONTH_RE.exec(toMonth);
  if (!a || !b) throw new RangeError(`Invalid months: ${fromMonth}, ${toMonth}`);
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

const MS_PER_DAY = 86_400_000;

export function daysBetween(fromDate, toDate) {
  return Math.round((parseISODate(toDate) - parseISODate(fromDate)) / MS_PER_DAY);
}

export function formatMonthIndex(month, indexValue) {
  return month;
}
