'use strict';
/**
 * Issue #202 — two live defects of the auto-flow (vacancy 138336566, 22.10.2026):
 *
 *  1. The MCP send path (hh_send_message) never ran the letter guard, so candidates
 *     received ".", "отправил" and a completely empty message (neg 5665252424,
 *     5665911042, 5651089991, 5670741266, 5670778186) while the send log counted
 *     them as delivered. The web path (src/hh-routes.js) always ran it.
 *
 *  2. Nothing told the writer WHERE the materials live: the ATS config had no
 *     materials link, the prompt had no materials block — so the model picked a
 *     link itself (a public GitHub repository in prod) for the 12 candidates who
 *     explicitly asked for the technical description, and refused 3 others.
 *
 * Covers: src/hh-bullshit-guard.js (quickMessageCheck), src/hh-message-prompts.js
 * (buildMaterialsBlock / buildMessageSystemPrompt), src/hh-draft-message.js
 * (buildDraftUserMessage) and the MCP send handler in
 * src/mcp-skills/tools/90-hh.js — the last one at source level, because calling the
 * handler for real needs HH credentials and a network round-trip.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { quickMessageCheck } = require('../src/hh-bullshit-guard');
const { buildMaterialsBlock, buildMessageSystemPrompt } = require('../src/hh-message-prompts');
const { buildDraftUserMessage } = require('../src/hh-draft-message');

const ROOT = path.resolve(__dirname, '..');
const DRIVE = 'https://drive.google.com/drive/folders/1ZFIjyqVXyKS3Eqyc63bGukExJzrkUwnw?usp=sharing';

let pass = 0, fail = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ── 1. The deterministic gate ─────────────────────────────────────────────────

test('an empty message is blocked', () => {
  const res = quickMessageCheck('', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.empty, true);
});

test('a whitespace-only message is blocked', () => {
  const res = quickMessageCheck('   \n  ', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.empty, true);
});

test('a lone dot is blocked (live case neg 5665252424)', () => {
  const res = quickMessageCheck('.', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.service_word, true);
});

test('"написал" is blocked (live case neg 5646598283)', () => {
  const res = quickMessageCheck('написал', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.service_word, true);
});

test('"отправил" is blocked (live case neg 5651089991)', () => {
  const res = quickMessageCheck('отправил', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.service_word, true);
});

test('an unresolved placeholder is blocked', () => {
  const res = quickMessageCheck('Здравствуйте, {имя}!', []);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.placeholder, true);
});

test('an exact repeat of an earlier letter is blocked', () => {
  const history = [{ role: 'employer', text: 'Здравствуйте! Выслал материалы.' }];
  const res = quickMessageCheck('Здравствуйте!  Выслал материалы.', history);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.checks.exact_duplicate, true);
});

test('a real letter passes the gate', () => {
  const res = quickMessageCheck('Здравствуйте, Вера! Документы продублировал отдельной папкой — там техническое описание с рецептурой.', []);
  assert.strictEqual(res.ok, true);
});

test('a short but meaningful reply passes the gate', () => {
  const res = quickMessageCheck('Благодарю, до связи!', []);
  assert.strictEqual(res.ok, true);
});

test('a service word inside a real letter does not block it', () => {
  const res = quickMessageCheck('Здравствуйте! Я написал вам вчера, а письмо осталось без ответа — продублирую.', []);
  assert.strictEqual(res.ok, true);
});

test('a deliberate greeting is not treated as junk (tool contract)', () => {
  // fixtures/tools.json expects hh_send_message("Здравствуйте!") to succeed.
  const res = quickMessageCheck('Здравствуйте!', []);
  assert.strictEqual(res.ok, true);
});

// ── 2. The materials channel ──────────────────────────────────────────────────

test('the materials block carries the link from the ATS config', () => {
  const block = buildMaterialsBlock({ materials_url: DRIVE });
  assert.ok(block.includes(DRIVE), 'the link must reach the prompt');
  assert.ok(block.includes('## Материалы'));
});

test('the materials block states the link is the only channel', () => {
  const block = buildMaterialsBlock({ materials_url: DRIVE });
  assert.ok(/единственн/i.test(block), 'the block must call the link the only channel');
  assert.ok(/НЕ отказ/i.test(block), 'asking for materials must not be a refusal');
});

test('an unset materials link is a fact, not a hole', () => {
  const block = buildMaterialsBlock({});
  assert.ok(/не задана/i.test(block));
  assert.ok(/не выдумывай/i.test(block), 'the writer must not invent a link');
});

test('the system prompt always carries the materials block', () => {
  const prompt = buildMessageSystemPrompt({ atsConfig: { materials_url: DRIVE } });
  assert.ok(prompt.includes(DRIVE), 'the prompt must carry the materials link');
  const empty = buildMessageSystemPrompt({ atsConfig: {} });
  assert.ok(empty.includes('## Материалы'), 'the block must be present even without a link');
});

test('the draft user message carries the materials link', () => {
  const msg = buildDraftUserMessage({ messageType: 'reply', materialsUrl: DRIVE, materialsNote: 'рецептура и расчёты' });
  assert.ok(msg.includes(DRIVE), 'the writer must see the link next to the thread');
  assert.ok(msg.includes('рецептура и расчёты'));
});

test('the draft user message without a link forbids inventing one', () => {
  const msg = buildDraftUserMessage({ messageType: 'reply' });
  assert.ok(/НЕ отказ/i.test(msg), 'asking for materials must not be a refusal');
  assert.ok(/не выдумывай/i.test(msg));
});

// ── 3. The MCP send path must actually call the gate ──────────────────────────

test('hh_send_message runs the deterministic gate before posting', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-skills', 'tools', '90-hh.js'), 'utf8');
  const start = source.indexOf('hh_send_message: {');
  assert.ok(start > 0, 'hh_send_message must exist');
  const end = source.indexOf('hh_batch_evaluate: {', start);
  const block = source.slice(start, end > 0 ? end : start + 8000);
  assert.ok(/quickMessageCheck\(/.test(block), 'the send handler must run quickMessageCheck');
  assert.ok(/EMPTY_MESSAGE/.test(block), 'the handler must answer with a readable error code');
  const gateAt = block.indexOf('quickMessageCheck(');
  const postAt = block.indexOf('performCommunicationSend(');
  assert.ok(gateAt > 0 && postAt > gateAt, 'the gate must run BEFORE the message is posted');
});

test('the ATS editor can store the materials link', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'hh-ats-editor-html.js'), 'utf8');
  assert.ok(source.includes("getElementById('fMaterialsUrl')"), 'the editor needs a materials field');
  assert.ok(/materials_url:/.test(source), 'the editor must save materials_url into the config');
});

(async () => {
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('  ok  ' + c.name); }
    catch (e) { fail++; console.error('FAIL  ' + c.name + '\n      ' + e.message); }
  }
  console.log(`\nhh-send-guard-materials: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
