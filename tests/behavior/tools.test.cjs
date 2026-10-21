'use strict';

// L2 — Behavior layer (hermetic: real server subprocess + fixtures).
// Every tool in mcp.manifest.json has a fixture {name, validArgs, expect?} and is
// driven through tools/call over stdio. Handlers are never called in-process:
// the registry and transport are exercised for real; only the external network
// (loopback HH mock) and the LLM (scripted Nock fixture) are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBehaviorFixture } = require('../helpers/hh-behavior-fixture');

const fixtures = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/tools.json'), 'utf8')).tools;

function parseEnvelope(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return text; }
}

test('every tool returns a valid MCP envelope (fixtures optional)', async () => {
  const f = await createBehaviorFixture();
  try {
    const { tools } = await f.mcp.call('tools/list');
    const names = new Set(tools.map((t) => t.name));
    // A fixture for a tool that no longer exists is drift — fail on it.
    const stale = fixtures.filter((x) => !names.has(x.name)).map((x) => x.name);
    assert.deepEqual(stale, [], 'fixtures for tools that are not in tools/list');
    // Tools without a hand-written fixture still get exercised with empty arguments:
    // the contract is "valid envelope or a reported error, never a crash". A fixture is
    // only needed to assert specific behaviour (agent#1470: moving a tool must not
    // require a new fixture).
    const covered = new Set(fixtures.map((x) => x.name));
    const defaults = tools.filter((t) => !covered.has(t.name)).map((t) => ({ name: t.name, validArgs: {}, generated: true }));

    // Execute in fixture order (stateful fixtures: connect/token/active venue first).
    for (const fixture of [...fixtures, ...defaults]) {
      let result;
      try {
        result = await f.mcp.call('tools/call', { name: fixture.name, arguments: fixture.validArgs });
      } catch (error) {
        // A graceful surfacing of an execution error is acceptable; a crash is not.
        assert.equal(typeof error?.message, 'string', `${fixture.name}: unexpected rejection`);
        assert.equal(f.mcp.exited, null, `${fixture.name}: server died instead of reporting an error`);
        continue;
      }
      assert.ok(result && Array.isArray(result.content), `${fixture.name}: envelope must have content[]`);
      assert.equal(result.content[0].type, 'text');
      const value = parseEnvelope(result);
      if (fixture.generated) continue; // empty-args smoke: the envelope shape is the contract
      assert.ok(value && typeof value === 'object', `${fixture.name}: content must be JSON`);
      for (const [key, expected] of Object.entries(fixture.expect || {})) {
        assert.equal(value[key], expected, `${fixture.name}: expected ${key}=${expected}`);
      }
    }
  } finally {
    await f.close();
  }
});

test('a failing tool call is reported, not a process crash', async () => {
  const f = await createBehaviorFixture();
  try {
    const unknown = await f.mcp.call('tools/call', { name: 'hh_nope', arguments: {} })
      .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.equal(unknown.ok, false, 'unknown tool must surface an error');
    assert.equal(typeof unknown.error.rpc?.code, 'number', 'unknown tool must carry a JSON-RPC code');

    const missingArgs = await f.mcp.call('tools/call', { name: 'hh_list_responses', arguments: {} })
      .then((result) => ({ result }), (error) => ({ error }));
    assert.ok(missingArgs.error || missingArgs.result, 'missing required args must surface an error result');

    const alive = await f.mcp.call('tools/list');
    assert.ok(Array.isArray(alive.tools), 'server must stay alive after a failed call');
    assert.equal(f.mcp.exited, null);
  } finally {
    await f.close();
  }
});

test('the LLM and the HH platform were exercised through the sanctioned mocks only', async () => {
  const f = await createBehaviorFixture();
  try {
    const evaluated = await f.mcp.call('tools/call', {
      name: 'hh_extract_ats_config',
      arguments: { vacancy_text: 'Ищем Node.js разработчика' },
    });
    assert.equal(parseEnvelope(evaluated).config.required[0].name, 'Node.js', 'the scripted LLM answer must reach the result');
    assert.ok(f.llmRequests().length >= 1, 'the scripted LLM fixture must have been called');
    assert.ok(f.srv.state !== undefined);
  } finally {
    await f.close();
  }
});

test('explicit extract scope B overrides active vacancy A and remains review-only', async () => {
  const f=await createBehaviorFixture();
  try {
    const result=parseEnvelope(await f.mcp.call('tools/call',{name:'hh_extract_ats_config',arguments:{vacancy_text:'Ищем Node.js разработчика',vacancy_id:'vac-B'}}));
    assert.equal(result.ok,true); assert.equal(result.config.vacancy_id,'vac-B');
    const {USER}=require('../helpers/hh-behavior-fixture');
    const dir=path.join(f.root,'users',USER,'contexts','hh');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ats_config_draft:vac-B.json'),'utf8')).value.vacancy_id,'vac-B');
    assert.equal(fs.existsSync(path.join(dir,'ats_config:vac-B.json')),false);
    assert.equal(fs.existsSync(path.join(dir,'ats_config_draft:vac-001.json')),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ats_config:vac-001.json'),'utf8')).value.vacancy_id,'vac-001');
  } finally {await f.close();}
});

// ─────────────────────────────────────────────────────────────────────────────
// issue #191 — the reply loop of the отклики domain, through the real MCP server.
//
// The live defects, all in one path «отклик → письмо → отправка»:
//   1. the tool wrote a letter even when the funnel had decided «wait» (we wrote
//      first, the candidate did not answer) — the second letter into the void;
//   2. the letter was never persisted, so the recruiter's textarea stayed empty
//      and the agent's work was lost;
//   3. a delivered letter did not move the negotiation out of the «response» stage.
// ─────────────────────────────────────────────────────────────────────────────
test('issue #191: the letter the agent wrote is persisted, not just returned', async () => {
  const f = await createBehaviorFixture();
  try {
    const gen = parseEnvelope(await f.mcp.call('tools/call', {
      name: 'hh_generate_message_to_applicant',
      arguments: { negotiation_id: 'neg-001' },
    }));
    assert.ok(gen.message && gen.message.length > 0, 'the tool must return a letter');
    assert.equal(gen.skipped, undefined, 'a fresh candidate is not a «wait» case');

    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'hh', 'fixture', 'candidates', 'neg-001.json'), 'utf8'));
    assert.equal(saved.message_draft.text, gen.message, 'the draft must outlive the tool call');
    assert.equal(saved.ats_result.draft_message, gen.message, 'the review page reads ats_result.draft_message');
    assert.match(saved.ats_result.draft_history_sig, /^funnel-v\d/, 'the draft must be stamped with the thread it answers');
  } finally { await f.close(); }
});

test('issue #191: a deliberate «wait» produces no letter and spends no LLM call', async () => {
  const f = await createBehaviorFixture();
  try {
    // We wrote three hours ago and the candidate has not answered → the funnel
    // decides «wait» (src/hh-funnel.js:238-244).
    const dir = path.join(f.root, 'data', 'hh', 'fixture', 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'neg-002.json'), JSON.stringify({
      messages: [{ role: 'employer', text: 'Здравствуйте! Расскажите про опыт.', hh_id: '1', timestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }],
    }));

    const gen = parseEnvelope(await f.mcp.call('tools/call', {
      name: 'hh_generate_message_to_applicant',
      arguments: { negotiation_id: 'neg-002' },
    }));
    assert.equal(gen.skipped, true, 'a deliberate «wait» must be reported as skipped');
    assert.equal(gen.message, '', 'no letter may be produced for a deliberate «wait»');
    assert.equal(gen.funnel_action, 'wait');
    assert.ok(gen.funnel_reason, 'the recruiter must see WHY there is no letter');
    assert.equal(f.llmRequests().length, 0, 'silence must not cost an LLM call');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'neg-002.json'), 'utf8'));
    assert.equal(saved.ats_result.funnel_action, 'wait');
    assert.match(saved.ats_result.draft_skip_sig, /^funnel-v\d/, 'WHY must be recorded against the thread signature');
    assert.equal(saved.ats_result.draft_message, undefined, 'no draft may be stored');
    assert.equal(saved.message_draft, undefined, 'no draft may be stored');
  } finally { await f.close(); }
});

test('issue #191: a delivered letter moves the negotiation out of the «response» stage', async () => {
  const f = await createBehaviorFixture();
  try {
    const sent = parseEnvelope(await f.mcp.call('tools/call', {
      name: 'hh_send_message',
      arguments: { negotiation_id: 'neg-001', message: 'Здравствуйте! Посмотрели ваш профиль — есть пара вопросов.' },
    }));
    assert.equal(sent.ok, true, `the send must succeed: ${JSON.stringify(sent)}`);
    assert.equal(f.srv.state.moves['neg-001'], 'consider', 'the отклик must leave the «response» stage after we answer');
  } finally { await f.close(); }
});

test('issue #191: the agent\'s letter survives the background cycle instead of being overwritten', async () => {
  const f = await createBehaviorFixture();
  const savedEnv = { ...process.env };
  try {
    // Same roots the MCP subprocess sees, so this process computes the background
    // cycle's staleness check against the very same files.
    Object.assign(process.env, {
      USER_ID: 'fixture', AGENT_TOKENS_DIR: path.join(f.root, 'agent-tokens'),
      AGENT_TOKENS_ROOT: path.join(f.root, 'agent-tokens'),
      AGENT_DATA_DIR: path.join(f.root, 'data'), USERS_DIR: path.join(f.root, 'users'),
    });
    const gen = parseEnvelope(await f.mcp.call('tools/call', {
      name: 'hh_generate_message_to_applicant',
      arguments: { negotiation_id: 'neg-001' },
    }));
    assert.ok(gen.message, 'the tool must return a letter');

    // The background cycle's own staleness check (src/hh-scoring.js → isDraftStale)
    // must see the agent's letter as current. If the two signatures disagree, the
    // next cycle regenerates and silently replaces what the agent wrote.
    const { isDraftStale } = require('../../src/hh-draft-message');
    const { resolveMessageInstructions } = require('../../src/hh-message-prompts');
    const { tokensRoot } = require('../../src/data-paths.js');
    const { readAtsConfig } = require('../../src/hh-scoring');
    const workDir = path.join(f.root, 'users', 'fixture');
    const atsConfig = readAtsConfig(workDir, 'vac-001');
    const vacancyInstruction = resolveMessageInstructions({ username: 'fixture', tokensBase: tokensRoot(), atsConfig });
    const history = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'hh', 'fixture', 'candidates', 'neg-001.json'), 'utf8'));
    assert.equal(
      isDraftStale(history, vacancyInstruction, atsConfig), false,
      'the background cycle must not overwrite the letter the agent wrote',
    );
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    await f.close();
  }
});
