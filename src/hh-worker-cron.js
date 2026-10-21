'use strict';

// Five-field cron for the standalone HH worker (#187).
//
// The cold-search schedules that used to live in the retiring agent's generic cron
// are evaluated here, in the timezone they were written in (Europe/Moscow), with
// the semantics the old scheduler had: one occurrence per (job, minute), a lease
// that keeps two ticks from running the same job at once, and missed runs
// coalesced into one instead of a backlog storm.
//
// Why a home-grown parser: the skill ships no runtime dependencies, and the
// schedule set is small and fully known (five fields, `*`, numbers, ranges,
// `*/step` and lists). A wrong match here would run a search on the wrong
// minute, so the parser is strict: anything it does not understand throws
// instead of silently matching nothing.

const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'dayOfWeek', min: 0, max: 7 },
];

function parseField(raw, { min, max }, label) {
  const spec = String(raw == null ? '' : raw).trim();
  if (!spec) throw new Error(`Пустое поле cron: ${label}`);
  const values = new Set();
  let any = false;
  for (const part of spec.split(',')) {
    const chunk = part.trim();
    if (!chunk) throw new Error(`Пустое поле cron: ${label}`);
    const [rangePart, stepPart] = chunk.split('/');
    if (stepPart != null && !/^\d+$/.test(stepPart.trim())) throw new Error(`Некорректный шаг cron (${label}): ${chunk}`);
    const step = stepPart == null ? 1 : Number(stepPart.trim());
    if (step < 1) throw new Error(`Некорректный шаг cron (${label}): ${chunk}`);
    let from;
    let to;
    if (rangePart === '*') {
      from = min;
      to = max;
      any = true;
    } else if (/^\d+$/.test(rangePart)) {
      from = Number(rangePart);
      to = stepPart == null ? from : max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!range) throw new Error(`Некорректное поле cron (${label}): ${chunk}`);
      from = Number(range[1]);
      to = Number(range[2]);
    }
    if (from < min || to > max || from > to) throw new Error(`Значение вне диапазона в поле cron (${label}): ${chunk}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values, any };
}

// `0` and `7` both mean Sunday in the legacy tables we inherited.
function normalizeWeekday(values) {
  const out = new Set();
  for (const value of values) out.add(value === 7 ? 0 : value);
  return out;
}

function parseCron(expression) {
  const parts = String(expression == null ? '' : expression).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Ожидалось 5 полей cron, получено ${parts.length}: ${expression}`);
  const parsed = {};
  FIELDS.forEach((field, index) => {
    const result = parseField(parts[index], field, field.key);
    parsed[field.key] = field.key === 'dayOfWeek'
      ? { values: normalizeWeekday(result.values), any: result.any }
      : result;
  });
  // Vixie semantics: when both day fields are restricted the job runs on either
  // of them, otherwise the restricted one wins.
  parsed.dayOfMonthOrWeek = !parsed.dayOfMonth.any && !parsed.dayOfWeek.any;
  return parsed;
}

// Local wall-clock parts of an instant in a named zone. Europe/Moscow has had a
// fixed +03:00 offset since 2014, but the lookup goes through Intl so a future
// zone change cannot silently shift every schedule.
const formatterCache = new Map();
function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return formatterCache.get(timeZone);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  };
}

function matches(cron, parts) {
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;
  const dayOfMonth = cron.dayOfMonth.values.has(parts.day);
  const dayOfWeek = cron.dayOfWeek.values.has(parts.weekday);
  if (cron.dayOfMonthOrWeek) return dayOfMonth || dayOfWeek;
  if (!cron.dayOfMonth.any) return dayOfMonth;
  if (!cron.dayOfWeek.any) return dayOfWeek;
  return true;
}

function startOfMinute(ms) {
  return Math.floor(ms / 60_000) * 60_000;
}

// Every minute boundary in (from, to] whose local time matches the cron.
// The window is walked minute by minute: a schedule set of this size costs
// nothing, and it keeps the "one occurrence per minute" rule exact.
function dueMinutes(expression, fromMs, toMs, timeZone = 'Europe/Moscow') {
  const cron = parseCron(expression);
  const out = [];
  let cursor = startOfMinute(fromMs) + 60_000;
  if (cursor <= startOfMinute(fromMs)) cursor = startOfMinute(fromMs) + 60_000;
  const limit = startOfMinute(toMs);
  while (cursor <= limit) {
    if (matches(cron, zonedParts(new Date(cursor), timeZone))) out.push(new Date(cursor).toISOString());
    cursor += 60_000;
  }
  return out;
}

// Next matching minute strictly after `fromMs`, or null within the look-ahead.
function nextRun(expression, fromMs, timeZone = 'Europe/Moscow', lookAheadMinutes = 60 * 24 * 366) {
  const cron = parseCron(expression);
  let cursor = startOfMinute(fromMs) + 60_000;
  for (let step = 0; step < lookAheadMinutes; step++) {
    if (matches(cron, zonedParts(new Date(cursor), timeZone))) return new Date(cursor).toISOString();
    cursor += 60_000;
  }
  return null;
}

module.exports = { parseCron, parseField, zonedParts, matches, dueMinutes, nextRun, startOfMinute };
