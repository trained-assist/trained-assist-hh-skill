// #86 — портрет вакансии через агента/бота: интент, quick-ответ, prompt-domain.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { HH_PORTRAIT_INTENT, HH_FUNNEL_INTENT, HH_REVIEW_PAGE_INTENT } = require('../../src/hh-intents.js');
const quick = require('../../src/hh-quick.js');
const { emptyPortrait, writePortrait } = require('../../src/hh-portrait.js');

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hh-portrait-bot-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function putCtx(key, value) {
  const dir = join(workDir, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ value }));
}

describe('HH_PORTRAIT_INTENT', () => {
  it('catches read-only gauge phrasings', () => {
    for (const msg of [
      'покажи портрет',
      'что там с портретом вакансии?',
      'полнота портрета',
      'сколько заполнен портрет',
      'чего не хватает по вакансии?',
      '/hh_portrait',
    ]) {
      expect(HH_PORTRAIT_INTENT.test(msg), msg).toBe(true);
    }
  });

  it('does NOT catch extraction — that goes through the full session into hh_portrait_extract', () => {
    for (const msg of [
      'собери портрет из этой переписки',
      'вот текст вакансии, сделай портрет',
      'дополни портрет данными клиента',
    ]) {
      expect(HH_PORTRAIT_INTENT.test(msg), msg).toBe(false);
    }
  });

  it('does not steal other intents', () => {
    expect(HH_PORTRAIT_INTENT.test('сколько откликов')).toBe(false);
    expect(HH_PORTRAIT_INTENT.test('покажи кандидатов')).toBe(false);
    expect(HH_FUNNEL_INTENT.test('покажи портрет')).toBe(false);
    expect(HH_REVIEW_PAGE_INTENT.test('полнота портрета')).toBe(false);
  });
});

describe('hhPortraitGauge', () => {
  it('returns null when there is no portrait (falls through to the full session)', () => {
    putCtx('active_vacancy', { id: 'V1', title: 'Маркетолог' });
    expect(quick.hhPortraitGauge('u', workDir)).toBeNull();
  });

  it('renders gauge, per-section fill, missing list and the web link', () => {
    putCtx('active_vacancy', { id: 'V1', title: 'Маркетолог' });
    const p = emptyPortrait();
    p.vacancy.title = 'Маркетолог';
    p.requirements.hard_skills = ['SEO карточек'];
    writePortrait(workDir, 'V1', p);

    const out = quick.hhPortraitGauge('alice', workDir);
    expect(out).toBeTruthy();
    expect(out).toContain('Портрет вакансии «Маркетолог»');
    expect(out).toContain('— Hard skills');
    expect(out).toContain('Чего не хватает');
    expect(out).toContain('100% · 1/1 — Hard skills'); // заполненный разрез
    expect(out).toContain('Полное название компании'); // незаполненное поле в нехватке
    expect(out).toContain('/hh/vacancy-new?username=alice');
    expect(out).toContain('vacancy_id=V1');
    // строки разрезов: «  NN% · filled/total — label»
    expect(out).toMatch(/^\s*\d+% · \d+\/\d+ — /m);
  });

  it('falls back to the draft portrait when no vacancy is active', () => {
    const p = emptyPortrait();
    p.vacancy.title = 'Черновик';
    writePortrait(workDir, 'draft', p);
    const out = quick.hhPortraitGauge('alice', workDir);
    expect(out).toContain('«Черновик»');
    expect(out).not.toContain('vacancy_id='); // draft не тащится в ссылку
  });
});

describe('prompt-domain hh.md', () => {
  it('instructs the agent on the portrait workflow', () => {
    const file = new URL('../../src/prompt-domains/hh.md', import.meta.url);
    const text = readFileSync(file, 'utf8');
    expect(existsSync(file.pathname)).toBe(true);
    expect(text).toContain('hh_portrait_extract');
    expect(text).toContain('hh_portrait_completeness');
    expect(text).toContain('hh_portrait_update');
    expect(text).toContain('hh_portrait_to_ats');
    expect(text).toMatch(/never silently save under `draft`/);
  });
});
