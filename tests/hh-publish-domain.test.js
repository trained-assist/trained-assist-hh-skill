/**
 * Per-user publish domain (Cold Search Stage 4).
 *
 * The class defect this replaces: a page-publishing preference was fed into the
 * server-to-server sync call, so a recruiter's own domain silently redirected the
 * agent's own API traffic. These tests pin the separation:
 *   • public page base is per-profile and isolated (one profile's domain never
 *     shows up in another profile's links),
 *   • internal API base ignores every override,
 *   • a domain is validated before anything is written, and a hand-edited file
 *     is treated as "not set" instead of poisoning generated links.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pd = require('../src/hh-publish-domain.js');

let root;
const saved = {};
const KEYS = ['AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'AGENT_PUBLIC_URL', 'HH_PLATFORM_URL',
  'HH_COLD_SEARCH_PUBLIC_URL', 'HH_PUBLIC_API_URL', 'AGENT_SECRET', 'USER_ID', 'PORT'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hh-publish-domain-'));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.AGENT_TOKENS_DIR = join(root, 'agent-tokens');
  process.env.AGENT_TOKENS_ROOT = join(root, 'agent-tokens');
  process.env.AGENT_PUBLIC_URL = 'https://infra.example.test/';
  process.env.USER_ID = 'alice';
});

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe('validation', () => {
  it('accepts a bare origin and drops the trailing slash', () => {
    expect(pd.normalizePublicDomain('https://coldsearch.myagency.ru/')).toBe('https://coldsearch.myagency.ru');
    expect(pd.normalizePublicDomain('  https://coldsearch.myagency.ru  ')).toBe('https://coldsearch.myagency.ru');
  });

  it.each([
    ['', 'empty'],
    ['not a url', 'no scheme / spaces'],
    ['ftp://myagency.ru', 'unsupported scheme'],
    ['javascript:alert(1)', 'unsupported scheme'],
    ['https://user:pass@myagency.ru', 'credentials'],
    ['https://myagency.ru/hh', 'path'],
    ['https://myagency.ru/?a=1', 'query'],
    ['https://myagency.ru#x', 'fragment'],
    ['myagency', 'no dot, not localhost'],
  ])('rejects %j (%s) before anything is written', (input) => {
    expect(() => pd.normalizePublicDomain(input)).toThrow();
  });

  it('does not write a file when validation fails', () => {
    expect(() => pd.savePublishDomain('alice', 'https://myagency.ru/hh')).toThrow();
    expect(existsSync(pd.publishDomainFile('alice'))).toBe(false);
    expect(pd.loadPublishDomain('alice')).toBeNull();
  });

  it('stores it under the profile tokens root with 0600', () => {
    pd.savePublishDomain('alice', 'https://coldsearch.myagency.ru');
    const file = pd.publishDomainFile('alice');
    expect(file.startsWith(join(root, 'agent-tokens'))).toBe(true);
    expect(file.endsWith('alice/hh-publish-domain')).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe('https://coldsearch.myagency.ru');
    // eslint-disable-next-line no-bitwise
    expect(readFileSync(file) && (require('node:fs').statSync(file).mode & 0o777)).toBe(0o600);
  });
});

describe('per-profile isolation', () => {
  it('each profile gets its own domain, an unset profile keeps the platform base', () => {
    pd.savePublishDomain('alice', 'https://alice.example');
    pd.savePublishDomain('bob', 'https://bob.example');
    expect(pd.publicPageBase('alice', pd.COLD_SEARCH_ENV, 'https://platform.example')).toBe('https://alice.example');
    expect(pd.publicPageBase('bob', pd.COLD_SEARCH_ENV, 'https://platform.example')).toBe('https://bob.example');
    expect(pd.publicPageBase('carol', pd.COLD_SEARCH_ENV, 'https://platform.example')).toBe('https://platform.example');
  });

  it('no override → the call site env chain and its own default are unchanged', () => {
    // HH page links still read AGENT_PUBLIC_URL …
    expect(pd.publicPageBase('alice', pd.HH_PAGES_ENV, 'https://platform.example')).toBe('https://infra.example.test');
    // … and the cold-search chain still IGNORES it, as it always did.
    expect(pd.publicPageBase('alice', pd.COLD_SEARCH_ENV, 'https://recruiter-assistant.ru')).toBe('https://recruiter-assistant.ru');
    process.env.HH_COLD_SEARCH_PUBLIC_URL = 'https://cold.example.test/';
    expect(pd.publicPageBase('alice', pd.COLD_SEARCH_ENV, 'https://recruiter-assistant.ru')).toBe('https://cold.example.test');
  });

  it('a hand-edited/garbage override file is treated as "not set", never emitted into a link', () => {
    const dir = join(root, 'agent-tokens', 'dave');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hh-publish-domain'), 'javascript:alert(1)\n');
    expect(pd.loadPublishDomain('dave')).toBeNull();
    expect(pd.publicPageBase('dave', pd.COLD_SEARCH_ENV, 'https://recruiter-assistant.ru')).toBe('https://recruiter-assistant.ru');
    expect(pd.publicPageBase('dave', pd.HH_PAGES_ENV, 'https://platform.example')).toBe('https://infra.example.test');
  });
});

describe('internal API base is never the tenant domain', () => {
  it('ignores every per-user override', () => {
    pd.savePublishDomain('alice', 'https://alice.example');
    expect(pd.internalApiBase()).toBe('https://infra.example.test');
  });

  it('falls back to localhost without AGENT_PUBLIC_URL, like the call sites did', () => {
    delete process.env.AGENT_PUBLIC_URL;
    expect(pd.internalApiBase()).toBe('http://localhost:3001');
    process.env.PORT = '8080';
    expect(pd.internalApiBase()).toBe('http://localhost:8080');
  });
});

describe('generated page links', () => {
  it('HH quick links follow the profile override', () => {
    pd.savePublishDomain('alice', 'https://alice.example');
    const quick = require('../src/hh-quick.js');
    expect(quick.hhAtsEditor('alice')).toContain('https://alice.example/hh/ats-editor?username=alice');
    expect(quick.hhVacancyNew('alice', 'v1')).toContain('https://alice.example/hh/vacancy-new?');
    expect(quick.hhAtsEditor('bob')).toContain('https://infra.example.test/hh/ats-editor?username=bob');
  });

  it('cold-search proactive links follow the profile override', () => {
    process.env.AGENT_SECRET = 'test-secret';
    pd.savePublishDomain('alice', 'https://alice.example');
    const autoscan = require('../src/hh-autoscan.js');
    expect(autoscan.proactiveUrlFor('alice', 'v1')).toContain('https://alice.example/hh/proactive?username=alice');
    expect(autoscan.proactiveUrlFor('bob', 'v1')).toContain('https://recruiter-assistant.ru/hh/proactive?username=bob');
  });
});

describe('hh_set_publish_domain tool', () => {
  const tool = () => require('../src/mcp-skills/tools/90-hh.js').tools.hh_set_publish_domain;

  it('reports the platform base when nothing is set', async () => {
    const res = await tool().handler({});
    expect(res.domain).toBeNull();
    expect(res.source).toBe('default');
  });

  it('saves, reports and clears', async () => {
    expect((await tool().handler({ domain: 'https://alice.example' })).domain).toBe('https://alice.example');
    expect((await tool().handler({})).domain).toBe('https://alice.example');
    expect((await tool().handler({ domain: '   ' })).cleared).toBe(true);
    expect((await tool().handler({})).domain).toBeNull();
  });

  it('returns the validation error and keeps the previous value', async () => {
    await tool().handler({ domain: 'https://alice.example' });
    const res = await tool().handler({ domain: 'https://alice.example/hh' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/пути|только домен/);
    expect(pd.loadPublishDomain('alice')).toBe('https://alice.example');
  });
});
describe('browser API callbacks and deploy gate', () => {
  it('HH callback override survives host localhost default without using tenant page domain', () => {
    expect(pd.browserApiBase({HH_PUBLIC_API_URL:'https://infra.example/agent/',AGENT_PUBLIC_URL:'http://localhost:8080'})).toBe('https://infra.example/agent');
    expect(pd.browserApiBase({AGENT_PUBLIC_URL:'https://host.example/agent'})).toBe('https://host.example/agent');
    expect(pd.browserApiBase({},8080)).toBe('http://localhost:8080');
  });
  it('actual editor and style routes use the pinned browser API override', async () => {
    const {handleHhPublic}=require('../src/hh-routes');
    process.env.HH_PUBLIC_API_URL='https://infra.example/agent';
    process.env.AGENT_PUBLIC_URL='http://localhost:8080';
    for(const endpoint of ['/hh/ats-editor','/hh/style']) {
      const req={method:'GET',headers:{},url:endpoint+'?username=alice&vacancy_id=vac'};
      let html='',status;
      const res={setHeader(){},writeHead(s){status=s;},end(value){html=String(value);}};
      await handleHhPublic(req,new URL(req.url,'https://recruiter.example'),res,{BASE_USERS_DIR:join(root,'users'),PORT:8080,getSecretsCache:()=>({}),secrets:{}});
      expect(status).toBe(200);
      expect(html).toContain('https://infra.example/agent');
      expect(html).not.toContain('http://localhost:8080');
    }
  });
  it('post-deploy gate rejects a public editor with localhost callbacks while allowing local development', () => {
    const {assertBrowserCallback}=require('../scripts/verify-deploy.cjs');
    const html=base=>'const CALLBACK_BASE = '+JSON.stringify(base)+';';
    for(const base of ['http://localhost:8080','http://127.0.0.1:8080','http://[::1]:8080'])expect(()=>assertBrowserCallback(html(base),'https://recruiter.example')).toThrow('HH_PUBLIC_API_URL');
    expect(assertBrowserCallback(html('https://infra.example/agent/'),'https://recruiter.example')).toBe('https://infra.example/agent');
    for(const base of ['https://user:pass@infra.example','https://infra.example?token=fake','https://infra.example#fragment'])expect(()=>assertBrowserCallback(html(base),'https://recruiter.example')).toThrow();
    expect(()=>assertBrowserCallback(html('http://localhost:8080'),'http://localhost:8080')).not.toThrow();
    expect(()=>assertBrowserCallback('<html>error</html>','https://recruiter.example')).toThrow();
  });
});
