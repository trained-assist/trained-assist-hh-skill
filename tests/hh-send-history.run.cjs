'use strict';
/**
 * Local negotiation history must never hold the same message twice.
 *
 * The bug this locks down (01.10.2026, recruiter report): /hh/send wrote the message
 * locally with no `hh_id`, syncHhMessagesToHistory deduped only by `hh_id`, so the next
 * sync appended the very same message a second time. Every outbound message looked like
 * two sends in «История диалога», the «N от нас» counter was doubled, and the guard read
 * that inflated history and blocked legitimate messages with repeated_intro.
 *
 * Covers: src/hh-history.js (dedupe/merge/append), the /hh/send write path,
 * the rejection write path, and the guard's use of the history.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dedupeMessages, mergeHhMessages, appendLocalMessage, DEDUPE_WINDOW_MS } = require('../src/hh-history');

let pass = 0, fail = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const INTRO = 'Здравствуйте, Элла! Меня зовут Владимир, я рекрутер агентства HR Stalker.';

test('local echo + HH mirror of the same send collapse into one entry', () => {
  // Exactly the pair observed on prod (5616135821.json).
  const history = { messages: [
    { hh_id: null, role: 'employer', text: INTRO, timestamp: '2026-09-30T11:30:53.646Z' },
    { hh_id: '15678813198', role: 'employer', text: INTRO, timestamp: '2026-09-30T14:30:53+0300' },
  ] };
  const out = dedupeMessages(history.messages);
  assert.strictEqual(out.length, 1, 'must collapse to one entry');
  assert.strictEqual(out[0].hh_id, '15678813198', 'keeps the id HH confirmed');
});

test('re-syncing the same HH thread adds nothing (idempotent)', () => {
  const hhMsgs = [{ id: 101, text: INTRO, created_at: '2026-09-30T14:30:53+0300', author: { participant_type: 'employer' } }];
  const first = mergeHhMessages({ messages: [] }, hhMsgs);
  assert.strictEqual(first.added, 1);
  const second = mergeHhMessages({ messages: first.messages }, hhMsgs);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.messages.length, 1);
});

test('appendLocalMessage without hh_id is not re-added by the next sync', () => {
  // /hh/send when HH returns no id (mocked transports, older HH responses).
  const appended = appendLocalMessage({ messages: [] }, { role: 'employer', text: INTRO });
  assert.strictEqual(appended.length, 1);
  const hhMsgs = [{ id: 999, text: INTRO, created_at: new Date(Date.parse(appended[0].timestamp) + 3000).toISOString(), author: { participant_type: 'employer' } }];
  const merged = mergeHhMessages({ messages: appended }, hhMsgs);
  assert.strictEqual(merged.messages.length, 1, 'sync must not double the message');
  assert.strictEqual(merged.messages[0].hh_id, 999);
});

test('the candidate answering twice in a row is NOT collapsed', () => {
  const msgs = [
    { hh_id: '1', role: 'applicant', text: 'да', timestamp: '2026-09-30T10:00:00+0300' },
    { hh_id: '2', role: 'applicant', text: 'да', timestamp: '2026-09-30T10:00:40+0300' },
  ];
  assert.strictEqual(dedupeMessages(msgs).length, 2, 'different ids = different events');
});

test('same text repeated by the recruiter much later stays two entries', () => {
  const msgs = [
    { hh_id: null, role: 'employer', text: 'Добрый день!', timestamp: '2026-09-01T10:00:00Z' },
    { hh_id: null, role: 'employer', text: 'Добрый день!', timestamp: '2026-09-30T10:00:00Z' },
  ];
  assert.strictEqual(dedupeMessages(msgs).length, 2, 'outside the dedupe window = real repeat');
  const near = [
    { hh_id: null, role: 'employer', text: 'Добрый день!', timestamp: '2026-09-30T10:00:00Z' },
    { hh_id: null, role: 'employer', text: 'Добрый день!', timestamp: new Date(Date.parse('2026-09-30T10:00:00Z') + DEDUPE_WINDOW_MS - 1000).toISOString() },
  ];
  assert.strictEqual(dedupeMessages(near).length, 1, 'inside the window = the same event');
});

test('whitespace/nbsp/case differences still dedupe (HH re-renders text)', () => {
  const msgs = [
    { hh_id: null, role: 'employer', text: 'Здравствуйте,  Элла!\n\nМеня зовут Владимир.', timestamp: '2026-09-30T11:30:53.646Z' },
    { hh_id: '7', role: 'employer', text: 'Здравствуйте, Элла! Меня зовут Владимир.', timestamp: '2026-09-30T14:30:53+0300' },
  ];
  assert.strictEqual(dedupeMessages(msgs).length, 1);
});

test('roles are not mixed: same text from both sides stays two entries', () => {
  const msgs = [
    { role: 'employer', text: 'спасибо', timestamp: '2026-09-30T10:00:00Z' },
    { role: 'applicant', text: 'спасибо', timestamp: '2026-09-30T10:00:10Z' },
  ];
  assert.strictEqual(dedupeMessages(msgs).length, 2);
});

test('corrupted history heals on the next sync instead of growing', () => {
  const history = { messages: [
    { hh_id: null, role: 'employer', text: INTRO, timestamp: '2026-09-30T11:30:53.646Z' },
    { hh_id: '15678813198', role: 'employer', text: INTRO, timestamp: '2026-09-30T14:30:53+0300' },
    { hh_id: '15678813199', role: 'applicant', text: 'здравствуйте, да', timestamp: '2026-09-30T15:03:57+0300' },
  ] };
  const merged = mergeHhMessages(history, []);
  assert.strictEqual(merged.messages.length, 2, 'the duplicate is dropped even with nothing new from HH');
  assert.deepStrictEqual(merged.messages.map(m => m.role), ['employer', 'applicant']);
});

test('sendRejection persists the delivered message once (rejection path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-rej-'));
  try {
    const historyFile = path.join(dir, 'n1.json');
    const { sendRejection } = require('../src/hh-rejection');
    let sent = null;
    const res = await sendRejection({
      historyFile, message: 'Элла, здравствуйте! Спасибо за отклик.',
      send: async text => { sent = text; return { id: '4242', created_at: '2026-09-30T11:54:10+0300' }; },
      discard: async () => {},
    });
    assert.strictEqual(res.ok, true);
    const stored = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    const mine = stored.messages.filter(m => m.text === 'Элла, здравствуйте! Спасибо за отклик.');
    assert.strictEqual(mine.length, 1, 'one local copy');
    assert.strictEqual(mine[0].hh_id, '4242', 'id from HH is stored');
    assert.strictEqual(mine[0].type, 'rejection', 'type survives the rewrite');
    // and the HH mirror of the same rejection must not duplicate it
    const merged = mergeHhMessages(stored, [{ id: '4242', text: sent, created_at: '2026-09-30T11:54:11+0300', author: { participant_type: 'employer' } }]);
    assert.strictEqual(merged.messages.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('guard judges a de-duplicated history (no phantom repeats)', async () => {
  const { bullshitGuard } = require('../src/hh-bullshit-guard');
  const doubled = [
    { role: 'employer', text: INTRO, timestamp: '2026-09-11T08:38:49+0300' },
    { role: 'employer', text: INTRO, timestamp: '2026-09-11T08:38:49+0300' },
    { role: 'applicant', text: 'Откажусь', timestamp: '2026-09-14T01:10:14+0300' },
    { role: 'applicant', text: 'Откажусь', timestamp: '2026-09-14T01:10:14+0300' },
  ];
  let prompt = null;
  const res = await bullshitGuard('Спасибо за ответ! Готовы обсудить детали.', doubled, {
    apiKey: 'test',
    llmCall: async (_key, messages) => {
      prompt = messages[0].content;
      return '{"repeated_question":false,"repeated_intro":false,"template_garbage":false,"reason":null}';
    },
  });
  assert.strictEqual(res.ok, true);
  assert.ok(prompt, 'guard must run the semantic check');
  const occurrences = (prompt.match(new RegExp(INTRO.slice(0, 25), 'g')) || []).length;
  assert.strictEqual(occurrences, 1, 'the doubled intro must reach the model once, not twice');
});

(async () => {
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('  ok  ' + c.name); }
    catch (e) { fail++; console.error('FAIL  ' + c.name + '\n      ' + e.message); }
  }
  console.log(`\nhh-send-history: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
