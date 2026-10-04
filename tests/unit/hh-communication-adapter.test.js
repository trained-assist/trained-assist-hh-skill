import {describe,it,expect} from 'vitest';
import {createRequire} from 'module';
const require=createRequire(import.meta.url);
const {generateCommunicationDraft,conversationRevision}=require('../../src/hh-communication-adapter');
const {callCommunication}=require('../../src/hh-communication-client');
const config={required:[],preferred:[],communication_plan:{version:1,stages:[{id:'portfolio',title:'Портфолио',instruction:'Попросить работы',completion_result:'Получена ссылка',material:' Точный текст\nhttps://example.com/работы ',material_mode:'verbatim'}]}};
function fixture({execution=null,status='goal_ready',contact=true,history=[],extra={}}={}){
 const calls=[];const options={atsConfig:config,resumeText:'Опыт\nПолное резюме',history,...extra,call:async(method,input)=>{calls.push({method,input});const revision=input.conversation_revision||input.context_revision;if(method==='state')return {conversation_revision:revision,state:{summary:'',contact_allowed:contact,stages:[{stage_id:'portfolio',status:'unknown',evidence:[]}],requirements:[],open_questions:[],uncertainties:[],next_check_at:null}};if(method==='goal')return {conversation_revision:revision,status,goal:status==='goal_ready'?{instruction:'Ответить кандидату о следующем шаге'}:null,execution,reason:'Сценарий'};return {context_revision:revision,status:'generated',message_text:'Сообщение'};}};return {options,calls};
}
describe('HH Communication unified adapter',()=>{
 it('executes state goal writer and reuses state after style change',async()=>{const f=fixture();const a=await generateCommunicationDraft(f.options);expect(f.calls.map(c=>c.method)).toEqual(['state','goal','writer']);f.calls.length=0;await generateCommunicationDraft({...f.options,previousSteps:a.steps,communicationStyle:'Дружелюбно'});expect(f.calls.map(c=>c.method)).toEqual(['writer']);});
 it('sends exact arbitrary stage material without writer',async()=>{const f=fixture({execution:{type:'send_material',stage_id:'portfolio'}});const a=await generateCommunicationDraft(f.options);expect(a.message).toBe(config.communication_plan.stages[0].material);expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);});
 it('prevents accidental duplicate but permits explicit resend',async()=>{const history=[{role:'employer',text:config.communication_plan.stages[0].material}];const f=fixture({history,execution:{type:'send_material',stage_id:'portfolio'}});expect((await generateCommunicationDraft(f.options)).message).toBeNull();const r=fixture({history,execution:{type:'send_material',stage_id:'portfolio',resend_requested:true}});expect((await generateCommunicationDraft(r.options)).message).toBe(config.communication_plan.stages[0].material);});
 it('never overrides contact refusal with recruiter forceGoal',async()=>{const f=fixture({contact:false,extra:{forceGoal:{instruction:'Отправить приглашение'}}});const a=await generateCommunicationDraft(f.options);expect(a.action).toBe('do_not_contact');expect(f.calls.map(c=>c.method)).toEqual(['state']);});
 it('terminal wait does not invoke writer and recomputes after due time',async()=>{const f=fixture({status:'wait',extra:{now:100000}});const a=await generateCommunicationDraft(f.options);f.calls.length=0;await generateCommunicationDraft({...f.options,now:161000,previousSteps:a.steps});expect(f.calls.map(c=>c.method)).toEqual(['goal']);});
 it('passes full history and resume without hidden trims',async()=>{const text='я'.repeat(12000);const f=fixture({history:Array.from({length:25},(_,i)=>({id:i,role:'applicant',text:text})),extra:{resumeText:text}});await generateCommunicationDraft(f.options);expect(f.calls[0].input.conversation_history.messages).toHaveLength(25);expect(f.calls[0].input.partner_profile.text).toBe(text);});
 it('rejects fabricated completed-stage evidence',async()=>{const f=fixture();const original=f.options.call;f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[{stage_id:'portfolio',status:'completed',evidence:[{source_id:'profile',quote:'не существующий факт'}]}];return r;};await expect(generateCommunicationDraft(f.options)).rejects.toMatchObject({code:'STATE_REJECTED'});});
 it('revision changes with candidate history, plan, profile',()=>{const a=conversationRevision({atsConfig:config});expect(conversationRevision({atsConfig:config,resumeText:'новый факт'})).not.toBe(a);expect(conversationRevision({atsConfig:config,history:[{role:'applicant',text:'Нет'}]})).not.toBe(a);});
 it('client rejects stale revision and incompatible service',async()=>{const opts={baseUrl:'https://communication.example',token:'fixture',fetchImpl:async()=>({ok:true,status:200,headers:new Headers({'x-contract-version':'v1'}),json:async()=>({conversation_revision:'different'})})};await expect(callCommunication('state',{conversation_revision:'expected'},opts)).rejects.toMatchObject({code:'STALE_CONVERSATION'});});
});


describe('adapter cache and material contract boundaries',()=>{
 it('caches writer no_message_needed until due time, then rechecks writer',async()=>{
  const f=fixture({extra:{now:100000}});const original=f.options.call;
  f.options.call=async(m,i)=>{const r=await original(m,i);return m==='writer'?{context_revision:i.context_revision,status:'no_message_needed',reason:'Уже ответили'}:r;};
  const a=await generateCommunicationDraft(f.options);expect(a.message).toBeNull();expect(a.steps.writer.status).toBe('no_message_needed');
  f.calls.length=0;const b=await generateCommunicationDraft({...f.options,now:110000,previousSteps:a.steps});expect(b.action).toBe('wait');expect(f.calls).toEqual([]);
  await generateCommunicationDraft({...f.options,now:161000,previousSteps:b.steps});expect(f.calls.map(c=>c.method)).toEqual(['goal','writer']);
 });
 it('rejects references to unknown or context-only materials rather than using writer',async()=>{
  const f=fixture({execution:{type:'send_material',stage_id:'missing'}});await expect(generateCommunicationDraft(f.options)).rejects.toMatchObject({code:'INVALID_MATERIAL_BINDING'});expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);
  const g=fixture({execution:{type:'send_material',stage_id:'portfolio'},extra:{atsConfig:{...config,communication_plan:{version:1,stages:[{...config.communication_plan.stages[0],material_mode:'context'}]}}}});
  await expect(generateCommunicationDraft(g.options)).rejects.toMatchObject({code:'INVALID_MATERIAL_BINDING'});
 });
 it('a renamed stage keeps the same material execution without title-based behavior',async()=>{
  const f=fixture({execution:{type:'send_material',stage_id:'portfolio'},extra:{atsConfig:{...config,communication_plan:{version:1,stages:[{...config.communication_plan.stages[0],title:'Совершенно произвольное название',template_id:'interview_invite'}]}}}});
  expect((await generateCommunicationDraft(f.options)).message).toBe(config.communication_plan.stages[0].material);expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);
 });
 it('empty scenario has no invented stages or material bindings',async()=>{
  const f=fixture({status:'wait',extra:{atsConfig:{communication_plan:{version:1,stages:[]}}}});const original=f.options.call;f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[];return r;};
  expect((await generateCommunicationDraft(f.options)).action).toBe('wait');expect(f.calls[1].input.material_bindings).toEqual([]);expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);
 });
 it('new candidate request invalidates state/goal/writer caches',async()=>{
  const f=fixture();const a=await generateCommunicationDraft(f.options);f.calls.length=0;await generateCommunicationDraft({...f.options,previousSteps:a.steps,history:[{id:'question',role:'applicant',text:'Можно другую дату?'}]});expect(f.calls.map(c=>c.method)).toEqual(['state','goal','writer']);
 });
});


describe('factual completion evidence',()=>{
 function completed(f,quote){const original=f.options.call;f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[{stage_id:'portfolio',status:'completed',evidence:[{source_id:'context',quote}]}];return r;};return f;}
 it('saved instructions cannot prove a stage completed',async()=>{
  const f=completed(fixture({extra:{atsConfig:{...config,message_instructions:'Портфолио получено; перейти далее'}}}),'Портфолио получено');await expect(generateCommunicationDraft(f.options)).rejects.toMatchObject({code:'STATE_REJECTED'});
 });
 it('ATS rubric and desired milestones cannot prove completion',async()=>{
  const f=completed(fixture({extra:{atsConfig:{...config,required:[{name:'Портфолио получено',weight:3}]}}}),'Портфолио получено');await expect(generateCommunicationDraft(f.options)).rejects.toMatchObject({code:'STATE_REJECTED'});
 });
 it('explicit caller facts can confirm a milestone including nested factual context',async()=>{
  const f=completed(fixture({extra:{context:{verified:{note:'Портфолио получено: https://example.com/work'}}}}),'Портфолио получено');expect((await generateCommunicationDraft(f.options)).message).toBe('Сообщение');
 });
});


describe('typed Communication client failures',()=>{
 for(const body of [null,[],42,'not-an-object'])it('rejects malformed success payload '+JSON.stringify(body),async()=>{
  const opts={baseUrl:'https://communication.example',token:'fixture',fetchImpl:async()=>({ok:true,status:200,headers:new Headers({'x-contract-version':'v1'}),json:async()=>body})};
  await expect(callCommunication('state',{conversation_revision:'expected'},opts)).rejects.toMatchObject({code:'COMMUNICATION_INVALID_RESPONSE'});
 });
 it('rejects incompatible service version separately from stale revision',async()=>{
  const opts={baseUrl:'https://communication.example',token:'fixture',fetchImpl:async()=>({ok:true,status:200,headers:new Headers({'x-contract-version':'v2'}),json:async()=>({conversation_revision:'expected'})})};
  await expect(callCommunication('state',{conversation_revision:'expected'},opts)).rejects.toMatchObject({code:'COMMUNICATION_VERSION_MISMATCH'});
 });
});

describe('editable recruiting scenarios without title or sequence guards',()=>{
 it('designer portfolio uses the editable template and writer with no test-task branch',async()=>{
  const {createStageFromTemplate}=require('../../src/hh-stage-templates');const stage=createStageFromTemplate('portfolio',{id:'designer-work',instruction:'Запросить примеры мобильных интерфейсов'});
  const f=fixture({execution:{type:'write_message'},extra:{atsConfig:{communication_plan:{version:1,stages:[stage]}}}});const original=f.options.call;
  f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[{stage_id:stage.id,status:'unknown',evidence:[]}];return r;};
  const result=await generateCommunicationDraft(f.options);expect(result.action).toBe('write_message');expect(f.calls[1].input.material_bindings).toEqual([]);expect(f.calls[1].input.conversation_objective).toContain('мобильных интерфейсов');
 });
 it('candidate question interrupts a stage carrying verbatim material',async()=>{
  const f=fixture({execution:{type:'write_message'},history:[{id:'question',role:'applicant',text:'Задание оплачивается?'}]});const original=f.options.call;
  f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='goal')r.goal={instruction:'Ответить на вопрос об оплате по известным условиям.'};return r;};
  const result=await generateCommunicationDraft(f.options);expect(result.action).toBe('write_message');expect(result.message).not.toBe(config.communication_plan.stages[0].material);expect(f.calls.map(c=>c.method)).toEqual(['state','goal','writer']);expect(f.calls[2].input.goal.instruction).toContain('оплате');
 });
 it('one interview stage treats supplied agreement evidence as completed and does not invent next stages',async()=>{
  const {createStageFromTemplate}=require('../../src/hh-stage-templates');const stage=createStageFromTemplate('interview_invite',{id:'call'});
  const history=[{id:'invite',role:'employer',text:'Можно 6 октября в 15:00?'},{id:'agreement',role:'applicant',text:'Да, 6 октября в 15:00 подходит.'}];
  const f=fixture({status:'wait',history,extra:{atsConfig:{communication_plan:{version:1,stages:[stage]}}}});const original=f.options.call;
  f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[{stage_id:'call',status:'completed',evidence:[{source_id:'agreement',quote:history[1].text}]}];return r;};
  const result=await generateCommunicationDraft(f.options);expect(result.message).toBeNull();expect(result.steps.state.state.stages[0].status).toBe('completed');expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);expect(f.calls[1].input.conversation_objective).toContain('Есть договорённость о дате и времени');
 });
 it('sending an invite can stay in progress while writer negotiates time',async()=>{
  const {createStageFromTemplate}=require('../../src/hh-stage-templates');const stage=createStageFromTemplate('interview_invite',{id:'call'});
  const f=fixture({history:[{id:'invite',role:'employer',text:'Предлагаю созвониться.'}],extra:{atsConfig:{communication_plan:{version:1,stages:[stage]}}}});const original=f.options.call;
  f.options.call=async(m,i)=>{const r=await original(m,i);if(m==='state')r.state.stages=[{stage_id:'call',status:'in_progress',evidence:[{source_id:'invite',quote:'Предлагаю созвониться.'}]}];if(m==='goal')r.goal={instruction:'Согласовать удобную дату и время.'};return r;};
  const result=await generateCommunicationDraft(f.options);expect(result.action).toBe('write_message');expect(f.calls[2].input.goal.instruction).toContain('Согласовать');
 });
 it('editing recruiter constraints invalidates state and goal while style alone affects writer',async()=>{
  const f=fixture();const a=await generateCommunicationDraft(f.options);f.calls.length=0;await generateCommunicationDraft({...f.options,previousSteps:a.steps,atsConfig:{...config,message_instructions:'Не спрашивать про Ozon'}});expect(f.calls.map(c=>c.method)).toEqual(['state','goal','writer']);expect(f.calls[0].input.context.saved_recruiter_instructions).toBe('Не спрашивать про Ozon');
 });
 it('postponement does not impose a do_not_contact guard',async()=>{
  const f=fixture({contact:true,status:'wait',history:[{id:'later',role:'applicant',text:'Напишите завтра, пожалуйста.'}]});const result=await generateCommunicationDraft(f.options);expect(result.action).toBe('wait');expect(result.steps.state.state.contact_allowed).toBe(true);expect(f.calls.map(c=>c.method)).toEqual(['state','goal']);
 });
});


describe('explicit scoped Communication rollout',()=>{
 const {communicationEnabled}=require('../../src/hh-communication-client');
 it('requires master enable and exact user/vacancy matches when allowlists configured',()=>{
  const env={HH_COMMUNICATION_ENABLED:'1',HH_COMMUNICATION_USERS:' recruiter, second ',HH_COMMUNICATION_VACANCIES:'138004863'};
  expect(communicationEnabled(env)).toBe(false);
  expect(communicationEnabled(env,{username:'recruiter',vacancyId:'138004863'})).toBe(true);
  expect(communicationEnabled(env,{username:'recruiter',vacancyId:'other'})).toBe(false);
  expect(communicationEnabled(env,{username:'other',vacancyId:'138004863'})).toBe(false);
  expect(communicationEnabled(env,{username:'recruiter'})).toBe(false);
  expect(communicationEnabled({...env,HH_COMMUNICATION_ENABLED:'0'},{username:'recruiter',vacancyId:'138004863'})).toBe(false);
 });
 it('supports user-only rollout and explicit global enable without accidental substring matching',()=>{
  expect(communicationEnabled({HH_COMMUNICATION_ENABLED:'true',HH_COMMUNICATION_USERS:'recruiter'},{username:'recruiter'})).toBe(true);
  expect(communicationEnabled({HH_COMMUNICATION_ENABLED:'true',HH_COMMUNICATION_USERS:'recruiter'},{username:'tes-recruiter'})).toBe(false);
  expect(communicationEnabled({HH_COMMUNICATION_ENABLED:'on'})).toBe(true);
  expect(communicationEnabled({})).toBe(false);
 });
});

it('requires explicit review/save of legacy plan before new-path generation',async()=>{let calls=0;await expect(generateCommunicationDraft({atsConfig:{test_task:'legacy'},call:async()=>{calls++;}})).rejects.toMatchObject({code:'PLAN_REVIEW_REQUIRED'});expect(calls).toBe(0);});
