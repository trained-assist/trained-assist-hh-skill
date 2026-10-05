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


describe('review page allows stale drafts in an explicitly confirmed batch', () => {
  it('keeps stale drafts selectable and labels them for batch confirmation', () => {
    const root=dataRoot();writeAtsConfig({vacancy_title:'Vac'});writeHistory(root,{ats_result:{draft_message:'Old draft',verdict:'ПРОПУСТИТЬ',score:9.5}});
    const html=generateReviewPageHtml([neg()],'Vac',USERNAME,'',root,{vacancyId:VACANCY,communicationEnabled:true});
    expect(html).toContain('Старый черновик: обновите его по сценарию перед отправкой.');
    expect(html).toMatch(/class="btn btn-send" data-stale="1" onclick="sendOne/);
    expect(html).not.toMatch(/class="btn btn-send"[^>]* disabled/);
    expect(html).toMatch(/class="card-cb"[^>]*data-stale="1"/);
    expect(html).not.toMatch(/class="card-cb"[^>]* disabled/);
    dropAtsConfig();
  });
});

// Issue #168: the bulk actions call shared helpers (plural, activeTabLabel,
// isHandEdited) that live outside the extracted slice, so the slice alone no
// longer runs. Prepend them to every extracted fragment.
const helperSource = (html) => ['function plural(', 'function activeTabLabel()', 'function markEdited(target)', 'function isHandEdited(i)']
  .map(marker => {
    const s = scriptOf(html), at = s.indexOf(marker), next = s.indexOf('\nfunction ', at + marker.length);
    return s.slice(at, next === -1 ? s.length : next);
  }).join('\n');
const extract = (html, startMarker, endMarker) => {
  const source = scriptOf(html), start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  return helperSource(html) + source.slice(start, end);
};

describe('review page selects score buckets and reports regeneration failures honestly', () => {
  it('rounds displayed fractional scores to the nearest score button', () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'function toggleBucket(n) {', '\nfunction selectAll');
    const selected=[];let checks=0;
    const button={classList:{add(){},remove(){}}};
    const checkboxes=[{dataset:{idx:'1',score:'9.5',stale:'1'},checked:false},{dataset:{idx:'2',score:'9.4',stale:'0'},checked:false}];
    const context={Set,parseInt,parseFloat,Math,activeBuckets:new Set(),done:new Set(),document:{querySelector:()=>button,querySelectorAll:()=>checkboxes},onCheck:()=>checks++};
    vm.runInNewContext(source+';this.toggleBucket=toggleBucket;',context);
    context.toggleBucket(10);
    expect(checkboxes.map(cb=>cb.checked)).toEqual([true,false]);expect(checks).toBe(1);
  });

  it('preserves manual unchecks when selecting another score bucket', () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'function toggleBucket(n) {', '\nfunction selectAll');
    const buttons=new Map([10,9].map(n=>[n,{classList:{add(){},remove(){}}}]));
    const checkboxes=[{dataset:{idx:'1',score:'9.5'},checked:false},{dataset:{idx:'2',score:'9.4'},checked:false}];
    const context={Set,parseInt,parseFloat,Math,activeBuckets:new Set(),done:new Set(),document:{querySelector:(selector)=>buttons.get(Number(selector.match(/data-bucket="(\d+)/)?.[1])),querySelectorAll:()=>checkboxes},onCheck(){}};
    vm.runInNewContext(source+';this.toggleBucket=toggleBucket;',context);
    context.toggleBucket(10);checkboxes[0].checked=false;context.toggleBucket(9);
    expect(checkboxes.map(cb=>cb.checked)).toEqual([false,true]);
  });

  it('confirms and sends selected stale drafts with a per-candidate stale override', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function sendAll() {', '\nfunction standardRejection');
    const cb={dataset:{idx:'3',stale:'1'},checked:true};const button={disabled:false,textContent:''};const card={dataset:{neg:'neg-3'}};const textarea={value:'approved exact text'};
    const calls=[];const completed=[];const confirmations=[];
    const context={document:{querySelector:(selector)=>String(selector).includes('tab-btn')?{textContent:'✉️ Все (2)'}:null,querySelectorAll:()=>[cb],getElementById:(id)=>id==='sendAllBtn'?button:id==='card-3'?card:id==='msg-3'?textarea:null},window:{confirm:(message)=>{confirmations.push(message);return true}},parseInt,hhAction:async(endpoint,payload)=>{calls.push({endpoint,payload});return{ok:true}},markDone:(i)=>{completed.push(i);cb.checked=false},onCheck(){button.disabled=!cb.checked},showToast(){}};
    vm.runInNewContext(source+';this.sendAll=sendAll;',context);
    await context.sendAll();
    // Issue #168: the general scope confirmation comes first, then the stale one.
    expect(confirmations).toHaveLength(2);
    expect(confirmations[0]).toContain('Отправить 1 письмо');
    expect(confirmations[0]).toContain('вкладке');
    expect(confirmations[1]).toContain('устаревший');
    expect(calls).toEqual([{endpoint:'/hh/send',payload:{negotiation_id:'neg-3',message:'approved exact text',force_stale:true}}]);
    expect(completed).toEqual([3]);expect(button.disabled).toBe(true);
  });

  it('does not send when the stale batch confirmation is declined', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function sendAll() {', '\nfunction standardRejection');
    const cb={dataset:{idx:'3',stale:'1'}};const button={disabled:false,textContent:''};let calls=0;
    const context={document:{querySelector:(selector)=>String(selector).includes('tab-btn')?{textContent:'✉️ Все (2)'}:null,querySelectorAll:()=>[cb],getElementById:(id)=>id==='sendAllBtn'?button:id==='card-3'?{dataset:{neg:'neg-3'}}:id==='msg-3'?{value:'draft'}:null},window:{confirm:()=>false},parseInt,hhAction:async()=>{calls++},onCheck(){},showToast(){}};
    vm.runInNewContext(source+';this.sendAll=sendAll;',context);
    await context.sendAll();expect(calls).toBe(0);expect(button.disabled).toBe(false);
  });

  it('asks before retrying a selected draft when the send route discovers staleness', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function sendAll() {', '\nfunction standardRejection');
    const cb={dataset:{idx:'4',stale:'0'},checked:true};const button={disabled:false,textContent:''};const calls=[];const completed=[];let confirmed=0;
    const error=Object.assign(new Error('stale'),{code:'STALE_COMMUNICATION_DRAFT'});
    const context={document:{querySelector:(selector)=>String(selector).includes('tab-btn')?{textContent:'✉️ Все (2)'}:null,querySelectorAll:()=>[cb],getElementById:(id)=>id==='sendAllBtn'?button:id==='card-4'?{dataset:{neg:'neg-4'}}:id==='msg-4'?{value:'approved exact text'}:null},window:{confirm:()=>{confirmed++;return true}},parseInt,hhAction:async(endpoint,payload)=>{calls.push(payload);if(calls.length===1)throw error;return{ok:true}},markDone:(i)=>{completed.push(i);cb.checked=false},onCheck(){},showToast(){}};
    vm.runInNewContext(source+';this.sendAll=sendAll;',context);
    await context.sendAll();
    expect(confirmed).toBe(2);expect(calls).toEqual([
      {negotiation_id:'neg-4',message:'approved exact text',force_stale:false},
      {negotiation_id:'neg-4',message:'approved exact text',force_stale:true},
    ]);expect(completed).toEqual([4]);
  });

  it('submits bulk regeneration to the durable server queue', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function regenerateAll() {', '\nfunction regenerationStorageKey');
    const button={disabled:false,textContent:''};
    const targets=Array.from({length:12},(_,idx)=>({disabled:false,dataset:{idx:String(idx),negid:'neg-'+idx,name:'Candidate',sent:'0'}}));
    let request,polled=0;
    const context={window:{confirm:()=>true},HH_VACANCY_ID:'vac',document:{getElementById:(id)=>id==='regenAllBtn'?button:null,querySelector:(selector)=>String(selector).includes('tab-btn')?{textContent:'✉️ Все (12)'}:null,querySelectorAll:()=>targets},done:new Set(),bulkGenerationActive:false,parseInt,Array,Math,Promise,Date,makeRegenerationRequestKey:()=> 'request-uuid',saveRegenerationState(){},setRegenerationCardState(){},hhAction:async(path,payload)=>{request={path,payload};return{job_id:'job-1'}},pollRegenerationJob:async(saved)=>{polled++;expect(saved.job_id).toBe('job-1')},showToast(){}};
    vm.runInNewContext(source+';this.regenerateAll=regenerateAll;',context);
    const batch=context.regenerateAll();await batch;expect(request.path).toBe('/hh/review-regeneration-start');expect(request.payload.negotiation_ids).toEqual(targets.map(x=>x.dataset.negid));expect(polled).toBe(1);
  });

  it('restores a regenerated legacy card to bulk selection', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function generateOne(', '\nfunction generateRejection');
    const button={disabled:false,textContent:''},textarea={value:'',classList:{add(){},remove(){}},placeholder:''};
    const stale={remove(){}};const sendBtn={disabled:true};const selection={disabled:true,checked:false,dataset:{score:'9.5',autoSelect:'1'}};let checks=0;
    const card={querySelector:(selector)=>selector==='.draft-stale'?stale:selector==='.btn-send'?sendBtn:selector==='.card-cb'?selection:null};
    const panel={replaceChildren(){},append(){}};const funnelStep={style:{},removeAttribute(){},textContent:''};
    const context={document:{getElementById:(id)=>id.startsWith('gen-')?button:id.startsWith('msg-')?textarea:card,querySelector:()=>funnelStep,createElement:()=>({append(){},textContent:''})},window:{HH_GENERATION_TIMEOUT_MS:1},HH_VACANCY_ID:'vac',bulkGenerationActive:false,activeBuckets:new Set([10]),onCheck:()=>checks++,setInterval:()=>1,clearInterval(){},hhAction:async()=>({message:'new draft',communication_steps:{}}),showToast(){},Date,Math};
    context.document.querySelector=(selector)=>selector.includes('funnel-step')?funnelStep:panel;
    vm.runInNewContext(source+';this.generateOne=generateOne;',context);
    expect(await context.generateOne(0,'neg','Candidate',false)).toBe(true);expect(sendBtn.disabled).toBe(false);expect(selection.disabled).toBe(false);expect(selection.checked).toBe(true);expect(checks).toBe(1);
  });

  it('returns failure when a single generation request fails', async () => {
    const html=generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});
    const source=extract(html, 'async function generateOne(', '\nfunction generateRejection');
    const button={disabled:false,textContent:''},textarea={classList:{add(){},remove(){}},placeholder:''};let toast='';
    const context={document:{getElementById:(id)=>id.startsWith('gen-')?button:textarea,querySelector:()=>null},window:{HH_GENERATION_TIMEOUT_MS:1},HH_VACANCY_ID:'vac',bulkGenerationActive:false,setInterval:()=>1,clearInterval(){},hhAction:async()=>{throw new Error('fixture failure')},showToast:(message)=>{toast=message},Date,Math};
    vm.runInNewContext(source+';this.generateOne=generateOne;',context);
    expect(await context.generateOne(0,'neg','Candidate',false)).toBe(false);expect(toast).toContain('fixture failure');expect(button.disabled).toBe(false);
  });
});

describe('issue #168 — bulk actions confirm scope and protect hand edits', () => {
  const bulkPage = () => generateReviewPageHtml([], 'Vac', USERNAME, '', dataRoot(), {});

  it('labels the score buckets as a selection, not as a rating', () => {
    const html = bulkPage();
    expect(html).toContain('Выбрать по баллу');
    expect(html).toContain('aria-label="Выбрать со скором 10"');
    // The old label read as «Балл (округление до целого):» next to bare numbers —
    // the recruiter could take it for «rate these candidates».
    expect(html).not.toContain('Балл (округление до целого)');
  });

  it('states that bulk actions work on the open tab only', () => {
    const html = bulkPage();
    expect(html).toContain('Массовые действия — только на открытой вкладке');
    expect(html).toContain('на вкладке');
  });

  it('confirms the batch send with a recipient count and the tab name', async () => {
    const html = bulkPage();
    const source = extract(html, 'async function sendAll() {', '\nfunction standardRejection');
    const cb = { dataset: { idx: '7', stale: '0' }, checked: true };
    const button = { disabled: false, textContent: '' };
    const confirmations = [];
    let calls = 0;
    const context = {
      document: {
        querySelector: (s) => String(s).includes('tab-btn') ? { textContent: '✉️ Все (2)' } : null,
        querySelectorAll: () => [cb],
        getElementById: (id) => id === 'sendAllBtn' ? button : id === 'card-7' ? { dataset: { neg: 'neg-7' } } : id === 'msg-7' ? { value: 'text' } : null,
      },
      window: { confirm: (m) => { confirmations.push(m); return true; } },
      parseInt, hhAction: async () => { calls++; return { ok: true }; },
      markDone: () => {}, onCheck() {}, showToast() {},
    };
    vm.runInNewContext(source + ';this.sendAll=sendAll;', context);
    await context.sendAll();
    // P0 of #168: letters to real candidates used to leave with no confirmation
    // at all unless a draft was stale.
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain('Отправить 1 письмо');
    expect(confirmations[0]).toContain('✉️ Все (2)');
    expect(confirmations[0]).toContain('Отменить массовую отправку нельзя');
    expect(calls).toBe(1);
  });

  it('sends nothing when the scope confirmation is declined', async () => {
    const html = bulkPage();
    const source = extract(html, 'async function sendAll() {', '\nfunction standardRejection');
    const cb = { dataset: { idx: '7', stale: '0' }, checked: true };
    let calls = 0;
    const context = {
      document: {
        querySelector: (s) => String(s).includes('tab-btn') ? { textContent: '✉️ Все (2)' } : null,
        querySelectorAll: () => [cb],
        getElementById: (id) => id === 'sendAllBtn' ? { disabled: false } : id === 'card-7' ? { dataset: { neg: 'neg-7' } } : id === 'msg-7' ? { value: 'text' } : null,
      },
      window: { confirm: () => false }, parseInt,
      hhAction: async () => { calls++; }, markDone() {}, onCheck() {}, showToast() {},
    };
    vm.runInNewContext(source + ';this.sendAll=sendAll;', context);
    await context.sendAll();
    expect(calls).toBe(0);
  });

  it('confirms before marking every candidate on the tab for rejection', () => {
    const html = bulkPage();
    const source = extract(html, 'function selectRejectAll() {', '\nfunction markDone');
    const boxes = [{ dataset: { idx: '1' }, checked: false }, { dataset: { idx: '2' }, checked: false }];
    const questions = [];
    const context = {
      document: { querySelector: (s) => String(s).includes('tab-btn') ? { textContent: '🔴 Неотвеченные (5)' } : null, querySelectorAll: () => boxes },
      done: new Set(), onCheck() {},
      window: { confirm: (m) => { questions.push(m); return true; } },
      showToast() {},
    };
    vm.runInNewContext(source + ';this.selectRejectAll=selectRejectAll;', context);
    context.selectRejectAll();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Отметить 2 кандидатов');
    expect(questions[0]).toContain('🔴 Неотвеченные (5)');
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);

    // Declining must not mark anybody.
    const declined = [{ dataset: { idx: '1' }, checked: false }, { dataset: { idx: '2' }, checked: false }];
    context.document.querySelectorAll = () => declined;
    context.window.confirm = () => false;
    context.selectRejectAll();
    expect(declined.map((b) => b.checked)).toEqual([false, false]);
  });

  it('confirms queue scope and excludes cards the recruiter edited by hand', async () => {
    const html = bulkPage();
    const source = extract(html, 'async function regenerateAll() {', '\nfunction regenerationStorageKey');
    const button = { disabled: false, textContent: '' };
    const messages = { 'msg-0': { value: 'kept', dataset: {} }, 'msg-1': { value: 'kept', dataset: {} } };
    const targets = ['0', '1'].map((idx) => ({ disabled: false, dataset: { idx, negid: 'neg-' + idx, name: idx === '0' ? 'A' : 'B', sent: '0' }, closest: () => ({ querySelector: () => messages['msg-' + idx] }) }));
    const questions = [];
    let request;
    const context = {
      window: { confirm: (m) => { questions.push(m); return true; } },
      document: {
        getElementById: (id) => id === 'regenAllBtn' ? button : messages[id] || null,
        querySelector: (s) => String(s).includes('tab-btn') ? { textContent: '✉️ Все (2)' } : null,
        querySelectorAll: () => targets,
      },
      done: new Set(), bulkGenerationActive: false, parseInt, Array, Math, Promise, Date,
      HH_VACANCY_ID: 'vac',
      makeRegenerationRequestKey: () => 'request-uuid', isHandEdited: card => messages['msg-' + card.dataset.idx]?.dataset?.edited === '1',
      setRegenerationCardState() {}, saveRegenerationState() {}, pollRegenerationJob: async () => {},
      hhAction: async (endpoint, payload) => { request = { endpoint, payload }; return { job_id: 'job-1' }; },
      showToast() {},
    };
    vm.runInNewContext(source + ';this.regenerateAll=regenerateAll;', context);
    const firstRun = context.regenerateAll();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Поставить в серверную очередь 2 черновика');
    await firstRun;

    // The recruiter hand-writes over one card, then regenerates: that text stays.
    messages['msg-0'].dataset = { edited: '1' };
    await context.regenerateAll();
    expect(questions[1]).toContain('Поставить в серверную очередь 1 черновик');
    expect(questions[1]).toContain('с ручной правкой останутся нетронутыми');
    expect(request.endpoint).toBe('/hh/review-regeneration-start');
    expect(request.payload.negotiation_ids).toEqual(['neg-1']);
  });
});
