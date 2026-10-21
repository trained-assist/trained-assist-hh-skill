'use strict';
// The worker's own cron evaluation (#187): the schedules the retiring agent ran
// are evaluated here now, so the parser and the timezone handling are covered
// by tests rather than by a live search that runs at the wrong minute.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCron, zonedParts, dueMinutes, nextRun } = require('../src/hh-worker-cron');

test('a five field expression parses into its fields', () => {
  const cron = parseCron('23,53 * * * *');
  assert.deepEqual([...cron.minute.values].sort((a, b) => a - b), [23, 53]);
  assert.equal(cron.hour.any, true);
  assert.equal(cron.dayOfMonthOrWeek, false);
});

test('minute and hour fields are read as they were written', () => {
  const cron = parseCron('41 10 * * *');
  assert.deepEqual([...cron.minute.values], [41]);
  assert.deepEqual([...cron.hour.values], [10]);
});

test('a step field expands to its multiples', () => {
  const cron = parseCron('*/15 * * * *');
  assert.deepEqual([...cron.minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
});

test('sunday is both 0 and 7', () => {
  const cron = parseCron('0 3 * * 7');
  assert.ok(cron.dayOfWeek.values.has(0));
  assert.ok(!cron.dayOfWeek.values.has(7));
  const both = parseCron('0 3 * * 0,7');
  assert.deepEqual([...both.dayOfWeek.values], [0]);
});

test('a broken expression throws instead of matching nothing', () => {
  assert.throws(() => parseCron('every day'), /5 полей/);
  assert.throws(() => parseCron('60 * * * *'), /вне диапазона/);
  assert.throws(() => parseCron('*/0 * * * *'), /шаг/);
});

test('Europe/Moscow is UTC+3 for the local parts', () => {
  const parts = zonedParts(new Date('2026-10-22T06:17:00Z'), 'Europe/Moscow');
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 17);
  assert.equal(parts.day, 22);
  assert.equal(parts.month, 10);
});

test('a daily job is due at its Moscow minute', () => {
  const due = dueMinutes('41 10 * * *', Date.parse('2026-10-22T00:00:00Z'), Date.parse('2026-10-23T00:00:00Z'), 'Europe/Moscow');
  assert.deepEqual(due, ['2026-10-22T07:41:00.000Z']);
});

test('two minutes of an hour are both due', () => {
  const due = dueMinutes('23,53 * * * *', Date.parse('2026-10-22T06:00:00Z'), Date.parse('2026-10-22T08:00:00Z'), 'Europe/Moscow');
  assert.deepEqual(due, [
    '2026-10-22T06:23:00.000Z',
    '2026-10-22T06:53:00.000Z',
    '2026-10-22T07:23:00.000Z',
    '2026-10-22T07:53:00.000Z',
  ]);
});

test('the next run is strictly in the future', () => {
  const next = nextRun('41 10 * * *', Date.parse('2026-10-22T07:41:00Z'), 'Europe/Moscow');
  assert.equal(next, '2026-10-23T07:41:00.000Z');
});
