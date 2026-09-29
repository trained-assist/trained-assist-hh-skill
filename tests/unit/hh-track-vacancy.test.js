// Cold search by vacancy id must leave the vacancy in active_vacancies, or its results
// page exists but the /hh/* vacancy picker never lists it (agent 2026-09-29).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { trackVacancy } = require('../../src/hh-proactive-search.js');

let dir;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function list() {
  return JSON.parse(readFileSync(join(dir, 'contexts', 'hh', 'active_vacancies.json'), 'utf8')).value;
}

describe('trackVacancy', () => {
  it('appends an untracked vacancy with its city, keeps the legacy singleton', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hh-track-'));
    mkdirSync(join(dir, 'contexts', 'hh'), { recursive: true });
    writeFileSync(join(dir, 'contexts', 'hh', 'active_vacancy.json'), JSON.stringify({ value: { id: '1', title: 'Old' } }));
    await trackVacancy(dir, '2', { name: 'Инженер-конструктор', area: { id: '1390', name: 'Златоуст' } }, 'x', null);
    expect(list().map(v => [v.id, v.title, v.area?.name])).toEqual([['1', 'Old', undefined], ['2', 'Инженер-конструктор', 'Златоуст']]);
  });

  it('is a no-op for an already tracked vacancy', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hh-track-'));
    mkdirSync(join(dir, 'contexts', 'hh'), { recursive: true });
    const file = join(dir, 'contexts', 'hh', 'active_vacancies.json');
    writeFileSync(file, JSON.stringify({ value: [{ id: '2', title: 'Kept' }] }));
    await trackVacancy(dir, '2', { name: 'New' }, 'x', null);
    expect(list()).toEqual([{ id: '2', title: 'Kept' }]);
  });
});
