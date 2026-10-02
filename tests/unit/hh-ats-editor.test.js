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
