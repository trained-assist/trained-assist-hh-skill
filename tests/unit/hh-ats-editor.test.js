// ATS editor page (src/hh-ats-editor-html.js).
//
// Issue #121: renderAll() called renderKnockout() long after the knockout section was
// removed (5dcce7b, #73). The ReferenceError fired during init→loadFromConfig→renderAll,
// which aborted the rest of the render — the required/preferred lists came up empty and
// «Вернуть общий шаблон» looked like a broken network call. A function that is called
// but never defined is a class of bug, not a one-off, so this test walks the whole
// inline script instead of asserting on one name.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { atsEditorHtml } = require('../../src/hh-ats-editor-html.js');

function inlineScript(html) {
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  expect(start, 'page has an inline <script>').toBeGreaterThan(-1);
  expect(end, 'inline <script> is closed').toBeGreaterThan(start);
  return html.slice(start, end);
}

// Identifiers that are legitimately available in a browser without a declaration in
// the inline script (plus the JS keywords the call-like regex can trip over).
const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
  'do', 'else', 'try', 'function', 'await', 'async', 'in', 'of', 'this',
  'fetch', 'parseInt', 'parseFloat', 'isNaN', 'String', 'Number', 'Boolean', 'Array',
  'Object', 'JSON', 'Math', 'Date', 'Promise', 'RegExp', 'Map', 'Set', 'Error',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'alert', 'confirm', 'prompt', 'URL', 'URLSearchParams', 'FormData', 'Blob',
  'encodeURIComponent', 'decodeURIComponent', 'AbortSignal', 'structuredClone',
  'document', 'window', 'location', 'navigator', 'console', 'localStorage',
  'requestAnimationFrame', 'queueMicrotask', 'Intl', 'Symbol',
]);

function calledButUndefined(script) {
  // Strip comments and string literals first: a name inside a label ("Java Developer")
  // or a URL is data, not a call. Without this the guard flags half the template menu.
  const code = script
    // Strings FIRST: a URL like 'https://host' contains a // that a comment-stripper
    // would otherwise read as a line comment and eat the rest of the script.
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const declared = new Set();
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  const missing = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const id = m[1];
    if (declared.has(id) || GLOBALS.has(id)) continue;
    missing.add(id);
  }
  return [...missing];
}

const CONFIG = {
  vacancy_title: 'Менеджер WB',
  vacancy_context: 'детская одежда',
  message_instructions: 'ПРОЦЕСС ОТБОРА',
  pass_threshold: 7.5,
  review_threshold: 5,
  required: [{ name: 'опыт WB', weight: 3 }],
  preferred: [{ name: 'MPStats', weight: 1.5 }],
  test_task: 'сделай X',
};

describe('ATS editor page (#121)', () => {
  const html = atsEditorHtml(CONFIG, ['Скрининг', 'Созвон'], {
    callbackBase: 'https://host/agent',
    username: 'u',
    pageToken: 'tok',
    vacancies: [{ id: '1', title: 'Менеджер WB' }],
    activeVacancyId: '1',
    isLive: true,
  });

  it('inline script declares every function it calls (no renderKnockout-class crash)', () => {
    const script = inlineScript(html);
    expect(calledButUndefined(script)).toEqual([]);
  });

  it('does not call the removed knockout renderer', () => {
    expect(html).not.toMatch(/renderKnockout\s*\(/);
    expect(html).not.toContain('Knockout');
  });

  it('wires «Вернуть общий шаблон» to the template endpoint and renders the picker', () => {
    expect(html).toContain('id="resetInstructionBtn"');
    expect(html).toContain('/hh/message-instructions-template');
    expect(html).toContain('data-testid="vacancy-picker"');
  });

  it('survives a config with no required/preferred at all', () => {
    const bare = atsEditorHtml({}, [], { callbackBase: 'https://host/agent', username: 'u', pageToken: 't' });
    expect(calledButUndefined(inlineScript(bare))).toEqual([]);
  });
});

// Issue #135: on vacancy 138004863 the must-haves were written out by hand inside the
// «Инструкция для сообщений кандидатам» textarea, in a wording that had already drifted
// from the ★ list — so letters asked about things the rubric no longer scored, and no
// edit to the skills would ever reach that text. The writer prompt already receives the
// required criteria from the config (buildCriteriaBlock, src/hh-message-prompts.js); the
// page now shows that list so the instruction field is not used as a second copy of it.
describe('must-haves are shown as injected, not typed into the instruction (#135)', () => {
  const scriptOf = (config) => inlineScript(atsEditorHtml(config, ['Скрининг', 'Интервью'], {
    callbackBase: 'https://host/agent', username: 'u', pageToken: 'tok',
    vacancies: [{ id: '1', title: 'Менеджер WB' }], activeVacancyId: '1',
  }));

  it('renders the auto-injected list from the required criteria, next to the field', () => {
    const html = atsEditorHtml(CONFIG, ['Скрининг', 'Интервью'], {
      callbackBase: 'https://host/agent', username: 'u', pageToken: 'tok',
      vacancies: [{ id: '1', title: 'Менеджер WB' }], activeVacancyId: '1',
    });
    expect(html).toContain('id="autoCriteria"');
    expect(html).toContain('.autocriteria{');
    // The list is read from the ★ criteria array, never from the instruction textarea.
    const s = inlineScript(html);
    expect(s).toMatch(/function renderAutoCriteria\(\)/);
    expect(s).toMatch(/const names = required\.map\(r => r\.name\.trim\(\)\)\.filter\(Boolean\)/);
    // …and the function body never reads the instruction textarea.
    const body = s.slice(s.indexOf('function renderAutoCriteria()'), s.indexOf('function addRequired()'));
    expect(body).not.toContain('fMessageInstructions');
    // Empty ★ list is a fact, not a hole: say so instead of showing nothing.
    expect(scriptOf({})).toMatch(/!names\.length/);
  });

  it('refreshes the shown list whenever the ★ criteria change', () => {
    const s = scriptOf(CONFIG);
    // add / delete / inline edit of a skill, plus the initial render and template switch.
    expect(s.match(/renderAutoCriteria\(\)/g).length).toBeGreaterThanOrEqual(3);
    expect(s).toMatch(/required\[idx\]\[field\] = .*\n\s*updateJsonPreview\(\);\n\s*renderAutoCriteria\(\);/);
  });

  it('tells the recruiter not to list must-haves in the instruction text', () => {
    const html = atsEditorHtml(CONFIG, ['Скрининг', 'Интервью'], {
      callbackBase: 'https://host/agent', username: 'u', pageToken: 'tok',
      vacancies: [{ id: '1', title: 'Менеджер WB' }], activeVacancyId: '1',
    });
    expect(html).toContain('Обязательные требования подставляются автоматически');
    expect(html).toContain('не из этого поля');
    expect(html).not.toContain('Вопросы — только по обязательным требованиям из этого же экрана.');
  });
});

// Issue #126, slice 5: the editor used to REFUSE to save a config without a vacancy
// title / context / required skills. The recruiter only wanted to set the recruiter
// availability — and since no config file existed, the background scorer skipped the
// vacancy and letters froze. Those three became warnings; thresholds and stages stay
// blockers (a config with them is meaningless, not merely thin).
describe('ATS editor validation (issue #126)', () => {
  const editor = (config = {}) => atsEditorHtml(config, ['Скрининг', 'Интервью'], {
    callbackBase: 'https://host/agent', username: 'u', pageToken: 'tok',
    vacancies: [{ id: '1', title: 'Финансовый советник' }], activeVacancyId: '1',
  });
  const scriptOf = (html) => inlineScript(html);

  it('empty title / context / required no longer block the save', () => {
    const s = scriptOf(editor({}));
    expect(s).toContain('const warnings = [];');
    // The three old blockers must NOT be in the errors list any more.
    expect(s).not.toMatch(/errors\.push\('Укажи название вакансии\.'\)/);
    expect(s).not.toMatch(/errors\.push\('Укажи контекст вакансии\.'\)/);
    expect(s).not.toMatch(/errors\.push\('Нужен хотя бы один обязательный навык\.'\)/);
    expect(s).toMatch(/warnings\.push\('Название вакансии не задано/);
    expect(s).toMatch(/warnings\.push\('Контекст вакансии пуст/);
    expect(s).toMatch(/warnings\.push\('Нет обязательных навыков/);
    // Save is gated on errors only, so a thin config saves.
    expect(s).toMatch(/return errors\.length === 0;/);
  });

  it('genuinely broken configs still block: inverted thresholds and empty stages', () => {
    const s = scriptOf(editor({}));
    expect(s).toMatch(/errors\.push\('Pass threshold должен быть выше review threshold\.'\)/);
    expect(s).toMatch(/errors\.push\('Нужно минимум 2 этапа подбора\.'\)/);
    expect(s).toMatch(/errors\.push\('Review threshold: от 0 до pass threshold\.'\)/);
  });

  it('fills blank title/context from HH text but never overwrites what the recruiter typed', () => {
    const withPrefill = atsEditorHtml({ vacancy_title: '', vacancy_context: '' }, ['Скрининг', 'Интервью'], {
      callbackBase: 'https://host/agent', username: 'u', pageToken: 'tok',
      activeVacancyId: '1', prefill: { vacancyTitle: 'Финансовый советник', vacancyContext: 'Private banking, AUM' },
    });
    const s = scriptOf(withPrefill);
    expect(s).toContain('"vacancyTitle":"Финансовый советник"');
    expect(s).toContain('"vacancyContext":"Private banking, AUM"');
    expect(s).toMatch(/if \(t && !t\.value\.trim\(\) && HH_PREFILL\.vacancyTitle\)/);
    expect(s).toMatch(/if \(c && !c\.value\.trim\(\) && HH_PREFILL\.vacancyContext\)/);
  });

  it('survives a page served with no HH prefill at all', () => {
    const bare = atsEditorHtml(null, null, { callbackBase: 'https://host/agent', username: 'u', pageToken: 't' });
    expect(calledButUndefined(inlineScript(bare))).toEqual([]);
    expect(inlineScript(bare)).toContain('"vacancyTitle":""');
  });
});
