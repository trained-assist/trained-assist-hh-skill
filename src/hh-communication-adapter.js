'use strict';
const {createHash}=require('crypto');
const {normalizeCommunicationPlan,buildCommunicationObjective,resolveStageMaterial}=require('./hh-communication-plan');
const {callCommunication,CommunicationError,communicationEnabled}=require('./hh-communication-client');
const {stageMetrics,chainMetrics}=require('./hh-communication-metrics');
const VERSION='hh-state-goal-v1';
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v;}
function signature(v){return createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');}
function normalizedHistory(messages=[]){
 const list=Array.isArray(messages)?messages:messages?.messages || [];
 const seen=new Set();
 return list.map((m,i)=>({...m,_position:i})).filter(m=>m&&typeof m.text==='string'&&m.text.trim()).sort((a,b)=>{
  const x=Date.parse(a.timestamp||''),y=Date.parse(b.timestamp||'');return Number.isFinite(x)&&Number.isFinite(y)?x-y||a._position-b._position:a._position-b._position;
 }).map(m=>{
  const original=m.hh_id ?? m.id;
  let id=original!=null?String(original):'local-'+signature({role:m.role,text:m.text,timestamp:m.timestamp}).slice(0,24);
  if(seen.has(id))id+='-'+m._position;seen.add(id);
  return {id,speaker:m.role==='employer'?'sender':m.role==='applicant'?'partner':(['sender','partner','other'].includes(m.speaker)?m.speaker:'other'),text:m.text,...(m.timestamp?{timestamp:String(m.timestamp)}:{})};
 });
}
function obj(properties,required=Object.keys(properties)){return {type:'object',additionalProperties:false,required,properties};}
function arr(items){return {type:'array',items};}
function stateSchema(plan,history){
 const ids=[...history.map(m=>m.id),'profile','context'];
 const evidence=obj({source_id:{type:'string',enum:ids},quote:{type:'string'}});
 const stage=obj({stage_id:{type:'string',...(plan.stages.length?{enum:plan.stages.map(s=>s.id)}:{})},status:{type:'string',enum:['unknown','in_progress','completed']},evidence:arr(evidence)});
 return obj({summary:{type:'string'},contact_allowed:{type:'boolean'},stages:arr(stage),requirements:arr(obj({name:{type:'string'},status:{type:'string',enum:['unknown','confirmed','absent']},evidence:arr(evidence)})),open_questions:arr(obj({question:{type:'string'},source_id:{type:'string',enum:ids}})),uncertainties:arr({type:'string'}),next_check_at:{type:['string','null']}});
}
function assertState(state,plan,history,profile,context){
 if(!state || typeof state!=='object' || typeof state.contact_allowed!=='boolean' || !Array.isArray(state.stages)||!Array.isArray(state.requirements)||!Array.isArray(state.open_questions)||!Array.isArray(state.uncertainties))throw new CommunicationError('STATE_REJECTED','Некорректная форма состояния');
 const sources=new Map(history.map(m=>[m.id,m.text]));const sourceText=v=>typeof v==='string'?v:JSON.stringify(v)+'\n'+Object.values(v || {}).map(sourceText).join('\n');sources.set('profile',sourceText(profile));sources.set('context',sourceText(context));
 const stageIds=new Set();
 for(const s of state.stages){
  if(!plan.stages.some(p=>p.id===s.stage_id)||stageIds.has(s.stage_id)||!['unknown','in_progress','completed'].includes(s.status)||!Array.isArray(s.evidence))throw new CommunicationError('STATE_REJECTED','Некорректная привязка результата этапа');
  stageIds.add(s.stage_id);
  if(s.status==='completed'&&!s.evidence.length)throw new CommunicationError('STATE_REJECTED','Результат этапа не подтверждён источниками');
 }
 if(stageIds.size!==plan.stages.length)throw new CommunicationError('STATE_REJECTED','Не все этапы отражены в состоянии');
 for(const entry of [...state.stages,...state.requirements]) for(const e of entry.evidence || []){
  if(!sources.has(e.source_id)||typeof e.quote!=='string'||!e.quote.trim()||!sources.get(e.source_id).includes(e.quote))throw new CommunicationError('STATE_REJECTED','Источник факта не подтверждает цитату');
 }
 for(const q of state.open_questions)if(!sources.has(q.source_id))throw new CommunicationError('STATE_REJECTED','Источник вопроса отсутствует');
}
function snapshotInput({history=[],resumeText='',candidateName='',atsConfig={},atsResult={},senderProfile={},context={}}){
 return {history:normalizedHistory(history),profile:{format:'text',text:resumeText,...(candidateName?{name:candidateName}:{})},atsConfig,atsResult,senderProfile,context};
}
function conversationRevision(input){return signature(snapshotInput(input));}
async function generateCommunicationDraft(options={}){
 const {atsConfig={},atsResult={},senderProfile={},context={},resumeText='',candidateName='',history=[],communicationStyle='Деловой, вежливый и краткий тон.',language='ru',previousSteps=null,now=Date.now(),call=callCommunication,forceGoal=null}=options;
 if(!atsConfig.communication_plan)throw new CommunicationError('PLAN_REVIEW_REQUIRED','Сохраните проверенный сценарий найма в редакторе вакансии перед генерацией.');
 const events=[];
 const invoke=async(method,input)=>{const started=Date.now();try{const response=await call(method,input);events.push({stage:method,...stageMetrics(response,{elapsedMs:Date.now()-started})});return response;}catch(e){e.communication_stage=method;e.communication_metrics=chainMetrics([...events,{stage:method,error_code:e.code||'COMMUNICATION_FAILED',attempts:e.provider_attempts??null,retries:Number.isInteger(e.provider_attempts)?Math.max(0,e.provider_attempts-1):null,latency_ms:Date.now()-started,usage:{},cost_usd:null}]);throw e;}};
 const cached=(method,response)=>{events.push({stage:method,...stageMetrics(response,{cached:true})});return response;};
 const plan=normalizeCommunicationPlan(atsConfig.communication_plan);
 const snapshot=snapshotInput(options), revision=signature(snapshot), thread=snapshot.history;
 const profile=snapshot.profile, ctx={...context,factual_context:context,vacancy_context:atsConfig.vacancy_context,interview_config:atsConfig.interview_config,required:atsConfig.required,preferred:atsConfig.preferred,ats_result:atsResult,saved_recruiter_instructions:atsConfig.message_instructions || ''};
 const schema=stateSchema(plan,thread);
 const stateInput={evidence_source_refs:{profile:'/partner_profile',context:'/context/factual_context'},conversation_revision:revision,conversation_history:{format:'messages',messages:thread},partner_profile:profile,sender_profile:senderProfile,context:ctx,communication_plan:plan,state_schema:schema,options:{language},extraction_instructions:'Определи результаты каждого переданного этапа по его инструкции и completion_result. Верни все stage_id ровно по одному. Учитывай результаты, достигнутые вне обычного порядка, и последующие отмены/исправления. Статус completed требует дословной цитаты и реального source_id: message ID, profile или context. Для source_id=context допустимы только фактические данные context.factual_context: остальные поля context (ATS, инструкции, требования, условия вакансии) описывают критерии и намерения, не доказанные события. План описывает намерения, не доказанные события. Не путай получение задания с выполнением, отправленное приглашение с договорённостью о времени; не считаешь недоступный материал прочитанным. Наличие ссылки не подтверждает доступность или просмотр её содержимого: такие результаты требуют отдельного фактического свидетельства. contact_allowed=false только при явном запрете контакта, «пишите завтра» сохраняет контакт. next_check_at — известный срок следующего действия, иначе null.'};
 const stateSig=signature({version:VERSION,input:stateInput});
 const validPrevious=previousSteps?.version===VERSION;
 let stateResponse;
 if(validPrevious&&previousSteps.state_sig===stateSig)stateResponse=cached('state',previousSteps.state);
 else stateResponse=await invoke('state',stateInput);
 const state=stateResponse.state;
 try {
  if(stateResponse.conversation_revision!==revision)throw new CommunicationError('STALE_CONVERSATION','Извлечённое состояние относится к другому снимку');
  assertState(state,plan,thread,profile,context);
 } catch(error) {
  error.communication_stage='state';
  if(typeof stateResponse.request_id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(stateResponse.request_id))error.request_id=stateResponse.request_id;
  error.communication_metrics=chainMetrics(events);
  throw error;
 }
 const bindings=plan.stages.filter(s=>s.material_mode==='verbatim'&&s.material.trim()).map(s=>({stage_id:s.id}));
 const sourceSpeakers=Object.fromEntries([...thread.map(m=>[m.id,m.speaker]),['profile','partner'],['context','other']]);
 const goalState={...state,source_speakers:sourceSpeakers};
 const actorPolicy='Автор каждого источника указан в conversation_state.source_speakers: sender — рекрутер, partner — кандидат, other — внешний контекст. Определяй, кто предложил условие и от кого нужен следующий ответ, по автору evidence.source_id, а не по пассивной формулировке summary. Не ожидай подтверждения от стороны, которая уже предложила условие. Не спрашивай автора предложения, подходит ли ему его же условие, и не проси повторять уже данное. Если возможность sender исполнить предложенное условие неизвестна, цель и сообщение — принять предложение к сведению и честно обозначить необходимость проверки своей возможности. Не выдавай это за подтверждение доступности, не выдумывай согласие и не переноси проверку собственной возможности на partner. Подтверждай условие только при известных фактах о возможности sender. Предложение одной стороны не является двусторонней договорённостью.';
 const baseObjective=buildCommunicationObjective(atsConfig)+'\n'+actorPolicy;
 const objective=baseObjective+'\nАктуальное время: '+new Date(now).toISOString();
 const goalSig=signature({version:VERSION,stateSig,state:goalState,sourceSpeakers,objective:baseObjective,bindings,forceGoal});
 const next=Date.parse(previousSteps?.next_check_at || state.next_check_at || '');
 const waitExpired=validPrevious&&(['wait','no_matching_option'].includes(previousSteps.goal?.status)||previousSteps.writer?.status==='no_message_needed') && (Number.isFinite(next)?now>=next:now-Date.parse(previousSteps.computed_at)>=60000);
 let goalResponse;
 if(state.contact_allowed===false)goalResponse={status:'do_not_contact',requires_message:false,goal:null,execution:null,reason:'Явный запрет контакта',conversation_revision:revision};
 else if(forceGoal)goalResponse={status:'goal_ready',requires_message:true,goal:forceGoal,execution:null,reason:'Явное действие рекрутера',conversation_revision:revision};
 else if(validPrevious&&previousSteps.goal_sig===goalSig&&!waitExpired)goalResponse=cached('goal',previousSteps.goal);
 else goalResponse=await invoke('goal',{conversation_revision:revision,conversation_state:goalState,conversation_objective:objective,material_bindings:bindings,language});
 if(goalResponse.conversation_revision!==revision)throw new CommunicationError('STALE_CONVERSATION','Цель относится к другому снимку');
 if(!['goal_ready','wait','no_matching_option','do_not_contact'].includes(goalResponse.status))throw new CommunicationError('GOAL_REJECTED','Неизвестный исход выбора цели');
 const style=typeof communicationStyle==='string'?{instructions:communicationStyle.trim() || 'Деловой, вежливый и краткий тон.'}:communicationStyle;
 const steps={version:VERSION,state:stateResponse,state_sig:stateSig,goal:goalResponse,goal_sig:goalSig,computed_at:new Date(now).toISOString(),next_check_at:state.next_check_at || (['wait','no_matching_option'].includes(goalResponse.status)?new Date(now+60000).toISOString():null),conversation_revision:revision,contract_version:'v1',source_speakers:sourceSpeakers,metrics:chainMetrics(events)};
 if(goalResponse.status!=='goal_ready')return {message:null,action:goalResponse.status,reason:goalResponse.reason,steps,revision};
 if(!goalResponse.goal?.instruction?.trim())throw new CommunicationError('GOAL_REJECTED','Пустая цель');
 let message,action='write_message';
 if(goalResponse.execution?.type==='send_material'){
  const material=resolveStageMaterial(atsConfig,goalResponse.execution.stage_id);
  if(!material||material.mode!=='verbatim'||!material.text.trim())throw new CommunicationError('INVALID_MATERIAL_BINDING','Цель ссылается на недоступный дословный материал');
  if(thread.some(m=>m.speaker==='sender'&&m.text===material.text)&&goalResponse.execution.resend_requested!==true&&!options.resendMaterial){steps.duplicate_material=true;return {message:null,action:'wait',reason:'Этот материал уже отправлен; повтор возможен по запросу кандидата.',steps,revision};}
  message=material.text;action='send_material';steps.material={stage_id:material.id,hash:signature(material.text)};
 }else{
  if(goalResponse.execution!=null&&goalResponse.execution.type!=='write_message')throw new CommunicationError('GOAL_REJECTED','Неизвестная операция исполнения');
  const draftSig=signature({goalSig,goal:goalResponse.goal,style,language,context:ctx,senderProfile});steps.draft_sig=draftSig;
  if(validPrevious&&previousSteps.draft_sig===draftSig&&previousSteps.writer?.status==='no_message_needed'&&now<Date.parse(previousSteps.next_check_at)){
   steps.writer=cached('writer',previousSteps.writer);steps.metrics=chainMetrics(events);steps.next_check_at=previousSteps.next_check_at;
   return {message:null,action:'wait',reason:previousSteps.writer.reason,steps,revision};
  }
  if(validPrevious&&previousSteps.draft_sig===draftSig&&typeof previousSteps.message==='string'){message=previousSteps.message;steps.writer=cached('writer',previousSteps.writer);steps.metrics=chainMetrics(events);}
  else{
   const written=await invoke('writer',{context_revision:revision,goal:goalResponse.goal,communication_style:style,language,conversation_history:{format:'messages',messages:thread},partner_profile:profile,sender_profile:senderProfile,context:{...ctx,communication_plan:plan,conversation_state:goalState,source_actor_policy:actorPolicy},constraints:{preserve_links:true,forbidden_claims:['Не выдумывать слоты, имена, требования, условия и сроки.']}});
   if(written.context_revision!==revision)throw new CommunicationError('STALE_CONVERSATION','Черновик относится к другому снимку');
   if(written.status==='needs_context'){
    const error=new CommunicationError('NEEDS_CONTEXT',written.reason || 'Для черновика не хватает подтверждённого контекста');
    error.missing_fields=Array.isArray(written.missing_fields)?written.missing_fields:[];
    steps.writer=written;steps.metrics=chainMetrics(events);steps.missing_fields=error.missing_fields;error.steps=steps;error.metrics=steps.metrics;error.communication_metrics=steps.metrics;throw error;
   }
   if(written.status==='no_message_needed'){
    steps.writer=written;steps.metrics=chainMetrics(events);steps.next_check_at=state.next_check_at || new Date(now+60000).toISOString();
    return {message:null,action:'wait',reason:written.reason,steps,revision};
   }
   if(written.status!=='generated'||typeof written.message_text!=='string'||!written.message_text.trim())throw new CommunicationError('WRITER_REJECTED','Communication не создал черновик');
   message=written.message_text;steps.writer=written;steps.metrics=chainMetrics(events);
  }
 }
 steps.message=message;
 return {message,action,reason:goalResponse.reason || goalResponse.goal.instruction,steps,revision};
}
module.exports={VERSION,signature,normalizedHistory,stateSchema,conversationRevision,generateCommunicationDraft,communicationEnabled};
