// src/hh-vacancy-quick.js — vacancy-creation quick flow called by core's intent-engine
// (trained-assist-agent#1470). Core owns the ordering; these hooks own the domain logic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vq = require('../../src/hh-vacancy-quick.js');
const { readVacancyState } = require('../../src/hh-vacancy.js');

let wd;
beforeEach(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-vq-')); });
afterEach(() => fs.rmSync(wd, { recursive: true, force: true }));

describe('hh-vacancy-quick', () => {
  it('does not apply without collecting state or a new-job request', () => {
    expect(vq.vacancyCollectingAnswer('привет', { workDir: wd })).toBeUndefined();
    expect(vq.newJobAnswer('привет', { workDir: wd })).toBeUndefined();
  });

  it('new job → collecting → append → done hands over to the async section', () => {
    expect(vq.newJobAnswer('новая вакансия', { workDir: wd }).answer).toMatch(/Создаём новую вакансию/);
    expect(vq.newJobAnswer('новая вакансия', { workDir: wd }).answer).toMatch(/Уже есть активная вакансия/);
    expect(vq.vacancyCollectingAnswer('Senior Go, удалёнка', { workDir: wd }).answer).toMatch(/Принял \(1 блок\)/);
    expect(vq.vacancyCollectingAnswer('/ping', { workDir: wd, isPingOrHelp: true })).toBeUndefined();
    expect(vq.vacancyCollectingAnswer('всё', { workDir: wd })).toEqual({ answer: null });
    expect(readVacancyState(wd).status).toBe('generating');
    expect(vq.vacancyCollectingAnswer('ещё', { workDir: wd }).answer).toMatch(/Генерирую вакансию/);
  });

  it('cancel leaves collecting mode', () => {
    vq.newJobAnswer('новая вакансия', { workDir: wd });
    expect(vq.vacancyCollectingAnswer('отмени создание вакансии', { workDir: wd }).answer).toMatch(/отменено/);
    expect(readVacancyState(wd).status).toBe('cancelled');
  });

  it('async: page publish without a draft asks to create a vacancy first', async () => {
    const r = await vq.vacancyAsyncAnswer('опубликуй страницу вакансии', { userId: 'u', workDir: wd, hhConnected: true });
    expect(r).toMatch(/Нет готового черновика/);
    expect(await vq.vacancyAsyncAnswer('привет', { userId: 'u', workDir: wd, hhConnected: true })).toBeUndefined();
  });
});
