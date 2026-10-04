'use strict';
// Deterministic contract replay: real plan, adapter, cache and history store logic;
// only Communication decisions are scripted. This gate checks orchestration and
// evidence wiring. Semantic model quality is checked separately by live replay.
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {generateCommunicationDraft}=require('../../src/hh-communication-adapter');
const {generateAndStoreCommunication}=require('../../src/hh-communication-runtime');
const {normalizeCommunicationPlan,prepareLegacyPlan}=require('../../src/hh-communication-plan');
const {createStageFromTemplate}=require('../../src/hh-stage-templates');
const MATERIAL='  Гайд WB: https://example.test/wb-guide\n'+('Точное задание, витрина, примеры.\n'.repeat(220))+'  ';
const config={vacancy_id:'138004863',required:[{name:'Работа с рекламой WB',weight:3}],preferred:[],message_instructions:'Не упоминай Ozon; не спрашивай про private banking.',communication_plan:normalizeCommunicationPlan({version:1,stages:[createStageFromTemplate('clarify_experience',{id:'experience'}),createStageFromTemplate('test_task',{id:'exercise',material:MATERIAL}),createStageFromTemplate('interview_invite',{id:'interview'})]})};
function boundary(decision,calls,plan=config.communication_plan){return async(method,input)=>{calls.push({method,input});const revision=input.conversation_revision||input.context_revision;if(method==='state')return {conversation_revision:revision,state:{summary:'Контрактный fixture',contact_allowed:decision.contact!==false,stages:plan.stages.map(s=>({stage_id:s.id,status:decision.stages?.[s.id]?.status||'unknown',evidence:decision.stages?.[s.id]?.evidence||[]})),requirements:decision.requirements||[],open_questions:[],uncertainties:[],next_check_at:decision.next_check_at||null}};if(method==='goal')return {conversation_revision:revision,status:decision.status||'goal_ready',goal:decision.status&&decision.status!=='goal_ready'?null:{instruction:decision.goal||'Продолжить сохранённый сценарий'},execution:decision.execution||null,reason:'Контрактный fixture'};return {context_revision:revision,status:'generated',message_text:decision.message||'Уточните неизвестный опыт с рекламой WB.'};};}
const proof=(id,quote,status='completed')=>({status,evidence:[{source_id:id,quote}]});
test('WB: unknown required → answer → exact task → received/question/submitted → invite/agreement/cancel/terminal',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'recruiting-replay-'));const file=path.join(root,'history.json');let history={messages:[],ats_result:{score:8}};let count=0;
 const append=(role,text)=>{const id='m'+(++count);history.messages.push({id,role,text,timestamp:new Date(100000+count*1000).toISOString()});return id;};
 const run=async decision=>{const calls=[];const result=await generateAndStoreCommunication(history,{atsConfig:config,resumeText:'WB резюме; опыт рекламы пока неизвестен.',now:100000+count*1000,call:boundary(decision,calls)});fs.writeFileSync(file,JSON.stringify(history));history=JSON.parse(fs.readFileSync(file));return {result,calls};};
 try{
 let r=await run({requirements:[{name:'Работа с рекламой WB',status:'unknown',evidence:[]}]});assert.equal(r.result.action,'write_message');assert.equal(r.calls[0].input.state_schema.properties.requirements.items.properties.status.enum.includes('unknown'),true);
 const answer=append('applicant','Настраивал рекламу WB три года.');const experience=proof(answer,'Настраивал рекламу WB три года.');
 r=await run({stages:{experience},execution:{type:'send_material',stage_id:'exercise'}});assert.equal(r.result.message,MATERIAL);assert.deepEqual(r.calls.map(c=>c.method),['state','goal']); // No extra consent/write step.
 const sent=append('employer',MATERIAL);const received=append('applicant','Спасибо, получил задание.');
 r=await run({stages:{experience,exercise:proof(received,'Спасибо, получил задание.','in_progress')},status:'wait'});assert.equal(r.result.message,null);assert.equal(history.communication_steps.state.state.stages[1].status,'in_progress');
 append('applicant','Можно сдать на день позже?');r=await run({stages:{experience,exercise:proof(sent,MATERIAL,'in_progress')},execution:{type:'write_message'},goal:'Ответить на вопрос о сроке по условиям вакансии.',message:'Обсудим срок сдачи.'});assert.equal(r.result.action,'write_message');assert.equal(r.calls.at(-1).input.goal.instruction,'Ответить на вопрос о сроке по условиям вакансии.');
 const submitted=append('applicant','Выполнение: https://example.test/submission');const exercise=proof(submitted,'Выполнение: https://example.test/submission');
 r=await run({stages:{experience,exercise},goal:'Предложить звонок и договориться о времени.',message:'Предлагаю созвониться, когда удобно?'});assert.equal(r.result.action,'write_message');
 const invite=append('employer',r.result.message);r=await run({stages:{experience,exercise,interview:proof(invite,r.result.message,'in_progress')},goal:'Согласовать дату и время.'});assert.equal(history.communication_steps.state.state.stages[2].status,'in_progress');
 const agreement=append('applicant','Согласен 6 октября в 15:00.');const interview=proof(agreement,'Согласен 6 октября в 15:00.');r=await run({stages:{experience,exercise,interview},status:'wait'});assert.equal(r.result.message,null);assert.equal(r.calls.some(c=>c.method==='writer'),false);assert.equal(r.calls.find(c=>c.method==='goal').input.conversation_state.source_speakers[agreement],'partner');
 append('applicant','Отменяю звонок, нужен другой день.');r=await run({stages:{experience,exercise,interview:{status:'in_progress',evidence:[]}},goal:'Согласовать другую дату после отмены.'});assert.equal(r.result.action,'write_message');
 const final=append('applicant','Договорились: 7 октября в 11:00.');r=await run({stages:{experience,exercise,interview:proof(final,'Договорились: 7 октября в 11:00.')},status:'wait'});assert.equal(r.result.message,null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('designer portfolio and edited completion/order/material remain arbitrary editable data',async()=>{
 const stage=createStageFromTemplate('portfolio',{id:'works',instruction:'Запросить мобильные интерфейсы',completion_result:'Получены два примера'});const designer={communication_plan:{version:1,stages:[stage]}};const calls=[];
 const call=async(m,i)=>{calls.push({method:m,input:i});const rev=i.conversation_revision||i.context_revision;return m==='state'?{conversation_revision:rev,state:{summary:'',contact_allowed:true,stages:[{stage_id:'works',status:'unknown',evidence:[]}],requirements:[],open_questions:[],uncertainties:[],next_check_at:null}}:m==='goal'?{conversation_revision:rev,status:'goal_ready',goal:{instruction:'Запросить два примера мобильных интерфейсов'},execution:{type:'write_message'}}:{context_revision:rev,status:'generated',message_text:'Пришлите два примера.'};};
 const a=await generateCommunicationDraft({atsConfig:designer,call});assert.equal(a.action,'write_message');assert.deepEqual(calls[1].input.material_bindings,[]);
 calls.length=0;const edited={communication_plan:{version:1,stages:[{...stage,completion_result:'Получено три примера',material:'Контекст: mobile',title:'Примеры'}]}};await generateCommunicationDraft({atsConfig:edited,previousSteps:a.steps,call});assert.deepEqual(calls.map(c=>c.method),['state','goal','writer']);assert.match(calls[1].input.conversation_objective,/Получено три примера/);
});
test('late decisive history and full resume survive; due wait reuses state but reselects goal',async()=>{
 const calls=[];const resume='Резюме\n'+('длинный текст '.repeat(1500))+'Решающая квалификация WB';const history=Array.from({length:24},(_,i)=>({id:'long'+i,role:'applicant',text:'Полный ответ '+i+' '+('факты '.repeat(150))}));history.push({id:'late',role:'applicant',text:'Ключевой поздний ответ: реклама WB'});
 const decision={status:'wait',next_check_at:new Date(160000).toISOString()};const call=boundary(decision,calls);const a=await generateCommunicationDraft({atsConfig:config,resumeText:resume,history,call,now:100000});assert.equal(calls[0].input.partner_profile.text,resume);assert.equal(calls[0].input.conversation_history.messages.at(-1).text,history.at(-1).text);calls.length=0;await generateCommunicationDraft({atsConfig:config,resumeText:resume,history,call,now:161000,previousSteps:a.steps});assert.deepEqual(calls.map(c=>c.method),['goal']);
});
test('synthetic live-shape legacy migration preserves long task and manual constraints without activation',()=>{
 const legacy={...config,test_task:MATERIAL};delete legacy.communication_plan;const out=prepareLegacyPlan(legacy,['Проверить резюме','Тестовое задание','Созвон']);assert.equal(out.requires_review,true);assert.equal(legacy.communication_plan,undefined);assert.equal(out.plan.stages.find(s=>s.material_mode==='verbatim').material,MATERIAL);assert.equal(out.legacy_source.message_instructions,legacy.message_instructions);assert.throws(()=>normalizeCommunicationPlan(out.plan),{code:'INVALID_COMMUNICATION_PLAN'});const reviewed={...out.plan,stages:out.plan.stages.map(s=>({...s,instruction:s.instruction||'Уточнить факты',completion_result:s.completion_result||'Получен ответ'}))};normalizeCommunicationPlan(reviewed);
});

test('material, order and completion edits are passed as plan data and context-mode material reaches writer',async()=>{
 const first=createStageFromTemplate('portfolio',{id:'first',material:'Контекст первой подборки'}),second=createStageFromTemplate('interview_invite',{id:'second'});
 const original={communication_plan:normalizeCommunicationPlan({version:1,stages:[first,second]})};let calls=[];const a=await generateCommunicationDraft({atsConfig:original,call:boundary({},calls,original.communication_plan)});
 assert.equal(calls.at(-1).input.context.communication_plan.stages[0].material,'Контекст первой подборки');
 const edited={communication_plan:normalizeCommunicationPlan({version:1,stages:[{...second,completion_result:'Получено подтверждение времени и формата'}, {...first,material:'Изменённый контекст работ'}]})};calls=[];
 await generateCommunicationDraft({atsConfig:edited,previousSteps:a.steps,call:boundary({},calls,edited.communication_plan)});assert.deepEqual(calls.map(c=>c.method),['state','goal','writer']);
 const objective=calls[1].input.conversation_objective;assert.ok(objective.indexOf('second')<objective.indexOf('first'));assert.match(objective,/Изменённый контекст работ/);assert.match(objective,/подтверждение времени и формата/);assert.equal(calls.at(-1).input.context.communication_plan.stages[1].material,'Изменённый контекст работ');
});
