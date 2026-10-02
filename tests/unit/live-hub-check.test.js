import { describe, it, expect } from 'vitest';
import { navMarkup, undefinedFunctions, checkNav, checkPrompt } from '../../scripts/live-hub-check.cjs';

// Fixtures mirror the shipped page shape: picker block, nav with its scoped <style>.
const NAV_STYLE = `<nav id="hh-hub-nav"><style>#hh-hub-nav .vacancy-picker{min-width:0}</style>`;
const PICKER = `<div class="vacancy-picker" data-testid="vacancy-picker"><select></select></div><!--/vacancy-picker-->`;

function nav({ rows = 2, picker = true, links = true, styleText = '' } = {}) {
  let inner = '';
  if (rows === 2) inner += `<div class="hh-nav-row">${picker ? PICKER : ''}<span class="hh-nav-spacer"></span><details class="hh-nav-settings"></details></div>`;
  if (rows === 2) inner += `<div class="hh-nav-row hh-nav-links">${links ? '<a href="#">Вакансии</a>' : ''}</div>`;
  else inner = `${picker ? PICKER : ''}<details class="hh-nav-settings"></details><a href="#">Вакансии</a>`;
  return `<html><body><style>.vacancy-picker{display:block}</style>${NAV_STYLE}${styleText}</style>${inner}</nav><main></main></body></html>`;
}

describe('navMarkup — the <style> block is what makes the check honest', () => {
  it('strips the nav scope so its CSS selectors cannot be read as markup', () => {
    const html = nav({ rows: 1, picker: false });
    const out = navMarkup(html);
    expect(out).not.toContain('<style>');
    expect(out).toContain('class="hh-nav-settings"');
  });

  it('returns null when the page has no nav at all', () => {
    expect(navMarkup('<html><body>нет навбара</body></html>')).toBe(null);
  });
});

describe('checkNav — hierarchy #121', () => {
  it('passes the fixed layout: picker + settings row above the links row', () => {
    const r = checkNav(nav(), { expectsPicker: true });
    expect(r.pass, r.why).toBe(true);
  });

  it('fails when the picker sits in the body instead of the bar', () => {
    const html = nav({ rows: 2, picker: false });
    const r = checkNav(html, { expectsPicker: true });
    expect(r.pass, r.why).toBe(false);
  });

  it('fails when the picker is duplicated (moved but not cut)', () => {
    const html = nav();
    const r = checkNav(html + '<body><div class="vacancy-picker"></div>', { expectsPicker: true });
    expect(r.pass, r.why).toBe(false);
    expect(r.why).toContain('дублирован');
  });

  it('fails on the pre-#121 layout: one row, links and settings side by side', () => {
    const html = nav({ rows: 1 });
    const r = checkNav(html, { expectsPicker: true });
    expect(r.pass, r.why).toBe(false);
  });

  it('a CSS selector named .vacancy-picker does NOT satisfy the picker check', () => {
    // The exact false positive from the first live probe: selector in <style>, no element.
    const html = `<html><body><nav id="hh-hub-nav"><style>#hh-hub-nav .vacancy-picker{min-width:0}</style>` +
      `<div class="hh-nav-row"><details class="hh-nav-settings"></details></div>` +
      `<div class="hh-nav-row hh-nav-links"><a href="#">Вакансии</a></div></nav></body></html>`;
    const r = checkNav(html, { expectsPicker: true });
    expect(r.pass, r.why).toBe(false);
  });

  it('a page without a picker stays single-row and is not flagged', () => {
    expect(checkNav(nav({ rows: 1, picker: false }), { expectsPicker: false }).pass).toBe(true);
    expect(checkNav(nav({ rows: 2 }), { expectsPicker: false }).pass).toBe(false);
  });
});

describe('undefinedFunctions — the «Failed to fetch» root cause', () => {
  it('flags a call to a function that was never defined', () => {
    const html = `<script>function renderRequired(){} renderRequired(); renderKnockout();</script>`;
    expect(undefinedFunctions(html)).toContain('renderKnockout');
    expect(undefinedFunctions(html)).not.toContain('renderRequired');
  });

  it('does not report JS globals', () => {
    expect(undefinedFunctions('<script>setTimeout(function(){JSON.parse(String(1))}, 1)</script>')).toEqual([]);
  });

  it('a `//` inside https:// does not swallow the calls that follow (strings stripped first)', () => {
    const html = `<script>const u = "https://example.com/x"; gone();</script>`;
    expect(undefinedFunctions(html)).toContain('gone');
  });

  it('names inside strings are not reported as calls', () => {
    const html = `<script>const s = "Java, SQL, Unity, Developer"; function ok(){} ok();</script>`;
    expect(undefinedFunctions(html)).toEqual([]);
  });

  it('passes the real editor template shape', () => {
    const html = `<script>function renderAll(){ renderStages(); }
      const renderStages = () => {}; const esc = x => x; updateJsonPreview(esc());</script>`;
    // renderStages is declared as a const AFTER use — still defined, so not flagged
    expect(undefinedFunctions(html)).not.toContain('renderStages');
    expect(undefinedFunctions(html)).toContain('updateJsonPreview');
  });
});

describe('checkPrompt — must-haves must reach the writer (#122)', () => {
  const build = ({ vacancyContext = '', atsConfig = {} } = {}) =>
    `system\n${vacancyContext}\nОбязательные требования вакансии\n` +
    (atsConfig.required || []).map(c => `- ${c.name}`).join('\n');

  it('passes when every must-have appears in the prompt', () => {
    const cfg = { required: [{ name: 'опыт WB от 2 лет' }], preferred: [] };
    expect(checkPrompt(build, cfg).pass).toBe(true);
  });

  it('fails when the prompt has the heading but an empty criteria list', () => {
    const cfg = { required: [{ name: 'опыт WB от 2 лет' }] };
    expect(checkPrompt(({ atsConfig }) => 'Обязательные требования вакансии\n- (не указано)', cfg).pass).toBe(false);
  });

  it('fails when the block is missing entirely', () => {
    expect(checkPrompt(() => 'system', { required: [] }).pass).toBe(false);
  });

  it('reports the missing must-haves by name', () => {
    const r = checkPrompt(({ atsConfig }) => 'Обязательные требования вакансии',
      { required: [{ name: 'опыт WB' }, { name: 'CTR/ДРР' }] });
    expect(r.why).toContain('опыт WB');
    expect(r.why).toContain('CTR/ДРР');
  });
});