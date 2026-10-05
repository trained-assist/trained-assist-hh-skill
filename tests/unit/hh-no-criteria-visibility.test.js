// Issue #126, slices 3+4 — the recruiter pressed "✦ Сгенерировать", nothing changed, and
// nothing said why. Two classes behind it:
//   3. the page swallowed the failing request — the button simply reset;
//   4. the real cause (no ATS criteria → the background loop skips the vacancy → letters
//      freeze) was invisible, and there was no way to fix it from the page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// USERS_DIR must point at a temp root BEFORE the page module is loaded: it resolves the
// profile root once, at import time (src/data-paths.js). Isolated CI sets its own temp
// root, but a bare `vitest run` would otherwise read the real ~/users.
const usersRootForTest = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-126-users-'));
process.env.USERS_DIR = usersRootForTest;

const require = createRequire(import.meta.url);
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');

const dataRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hh-126-data-'));
const USERNAME = 'crit-u';
const VACANCY = '137012564';
const neg = () => ({
  id: '5610867713', created_at: '2026-09-28T10:00:00+03:00', updated_at: '2026-10-02T10:00:00+03:00',
  counters: { unread_messages: 0, messages: 5 }, has_updates: false,
  resume: { first_name: 'Леван', last_name: 'Бахтадзе' }, _state: 'response',
});

const scriptOf = (html) => html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

function writeAtsConfig(value) {
  const dir = path.join(usersRootForTest, USERNAME, 'contexts', 'hh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ats_config:${VACANCY}.json`), JSON.stringify({ value, updated_at: new Date().toISOString() }));
}
function writeHistory(root, value) { const dir=path.join(root,'hh',USERNAME,'candidates');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`${neg().id}.json`),JSON.stringify(value)); }
function dropAtsConfig() {
  const f = path.join(usersRootForTest, USERNAME, 'contexts', 'hh', `ats_config:${VACANCY}.json`);
  if (fs.existsSync(f)) fs.rmSync(f);
}

afterAll(() => fs.rmSync(usersRootForTest, { recursive: true, force: true }));

describe('review page says WHY letters stop updating (issue #126, slice 4)', () => {
  it('a vacancy without criteria shows the banner and a one-click way to fix it', () => {
    dropAtsConfig();
    const html = generateReviewPageHtml([neg()], 'Финансовый советник', USERNAME, '', dataRoot(), { vacancyId: VACANCY });
    expect(html).toContain('id="no-ats-banner"');
    expect(html).toMatch(/Письма этой вакансии не обновляются/);
    // The fix has to be reachable from the page, not only from chat. The extraction
    // itself runs in the editor: the public edge only proxies part of the HH routes,
    // so a fetch straight from this page would be 401 before reaching the agent.
    expect(html).toMatch(/\/hh\/ats-editor\?username=[^"]*&extract=1/);
    expect(html).toMatch(/Собрать критерии из текста вакансии/);
  });

  it('the banner disappears once criteria exist — it is not a permanent nag', () => {
    writeAtsConfig({ vacancy_title: 'Финансовый советник', vacancy_context: 'ctx', required: [{ name: 'AUM', weight: 2 }] });
    const html = generateReviewPageHtml([neg()], 'Финансовый советник', USERNAME, '', dataRoot(), { vacancyId: VACANCY });
    expect(html).not.toContain('id="no-ats-banner"');
    dropAtsConfig();
  });
});

describe('review page stops swallowing generation failures (issue #126, slice 3)', () => {
  it('a failed generation shows the error text instead of silently resetting the button', () => {
    dropAtsConfig();
    const html = generateReviewPageHtml([neg()], 'Финансовый советник', USERNAME, 'https://hh.test', dataRoot(), { vacancyId: VACANCY });
    const s = scriptOf(html);
    const catchBlock = s.slice(s.indexOf('async function generateOne'));
    // The old code caught, reset the button, and said nothing — the recruiter read it as
    // "nothing changed" and pressed it again.
    expect(catchBlock).toMatch(/catch\(e\)/);
    expect(catchBlock).toMatch(/showToast\('❌ Ошибка генерации: '/);
    expect(catchBlock).toMatch(/no_ats_config/);
  });
});


describe('review page marks legacy drafts as stale', () => {
  it('prevents sending and bulk selection until a current scenario draft exists', () => {
    const root=dataRoot();writeAtsConfig({vacancy_title:'Vac'});writeHistory(root,{ats_result:{draft_message:'Old draft',verdict:'ПРОПУСТИТЬ',score:9.5}});
    const html=generateReviewPageHtml([neg()],'Vac',USERNAME,'',root,{vacancyId:VACANCY,communicationEnabled:true});
    expect(html).toContain('Старый черновик: обновите его по сценарию перед отправкой.');
    expect(html).toMatch(/class="btn btn-send"[^>]* disabled/);
    expect(html).toMatch(/class="card-cb"[^>]* disabled/);
    dropAtsConfig();
  });
});

describe('review page selects score buckets and reports regeneration failures honestly', () => {
  it('rounds displayed fractional scores to the nearest score button', () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=scriptOf(html), start=source.indexOf('function toggleBucket(n) {'), end=source.indexOf('\nfunction selectAll',start);
    const selected=[];let checks=0;
    const button={classList:{add(){},remove(){}}};
    const checkboxes=[{dataset:{idx:'1',score:'9.5'},checked:false},{dataset:{idx:'2',score:'9.4'},checked:false}];
    const context={Set,parseInt,parseFloat,Math,activeBuckets:new Set(),done:new Set(),document:{querySelector:()=>button,querySelectorAll:()=>checkboxes},onCheck:()=>checks++};
    vm.runInNewContext(source.slice(start,end)+';this.toggleBucket=toggleBucket;',context);
    context.toggleBucket(10);
    expect(checkboxes.map(cb=>cb.checked)).toEqual([true,false]);expect(checks).toBe(1);
  });

  it('does not report failed bulk generation as a green success', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=scriptOf(html), start=source.indexOf('async function regenerateAll() {'), end=source.indexOf('\nasync function generateOne',start);
    const button={disabled:false,textContent:''},target={disabled:false,dataset:{idx:'0',negid:'neg',name:'Candidate',sent:'0'}};let toast='';
    const context={document:{getElementById:()=>button,querySelectorAll:()=>[target]},done:new Set(),parseInt,Array,Math,Promise,generateOne:async()=>false,showToast:(message)=>{toast=message}};
    vm.runInNewContext(source.slice(start,end)+';this.regenerateAll=regenerateAll;',context);
    await context.regenerateAll();expect(toast).toContain('Не удалось: 1');expect(toast).not.toContain('✅');expect(button.disabled).toBe(false);
  });

  it('returns failure when a single generation request fails', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=scriptOf(html), start=source.indexOf('async function generateOne('), end=source.indexOf('\nfunction generateRejection',start);
    const button={disabled:false,textContent:''},textarea={classList:{add(){},remove(){}},placeholder:''};let toast='';
    const context={document:{getElementById:(id)=>id.startsWith('gen-')?button:textarea,querySelector:()=>null},window:{HH_GENERATION_TIMEOUT_MS:1},HH_VACANCY_ID:'vac',setInterval:()=>1,clearInterval(){},hhAction:async()=>{throw new Error('fixture failure')},showToast:(message)=>{toast=message},Date,Math};
    vm.runInNewContext(source.slice(start,end)+';this.generateOne=generateOne;',context);
    expect(await context.generateOne(0,'neg','Candidate',false)).toBe(false);expect(toast).toContain('fixture failure');expect(button.disabled).toBe(false);
  });
});
