'use strict';
const {generateCommunicationDraft,communicationEnabled,signature}=require('./hh-communication-adapter');
const {CommunicationError}=require('./hh-communication-client');
function scoringFacts(ats={}) { const out={...ats}; for(const k of Object.keys(out)) if(k.startsWith('draft_')||k.startsWith('funnel_')||k==='communication_steps')delete out[k]; return out; }
function meaningfulMessages(messages=[]) { return messages.filter(m=>!(m.role==='applicant'&&/^(?:спасибо(?: большое)?|благодарю|thanks|thank you)[.!\s]*$/iu.test(String(m.text||'').trim()))); }
function freshnessInput(input) { return {...input,history:meaningfulMessages(input.history),atsResult:scoringFacts(input.atsResult)}; }
function freshnessSignature(input){return signature(freshnessInput(input));}
function staleCommunicationDraft(history,atsConfig,currentResumeHash=null){ const snap=history.communication_snapshot; if(!snap)return false; if(currentResumeHash && snap.sourceResumeHash && currentResumeHash!==snap.sourceResumeHash)return true; return freshnessSignature({...snap,history:history.messages||[],atsConfig,atsResult:scoringFacts(history.ats_result)})!==history.communication_freshness_sig; }
async function generateAndStoreCommunication(history,input={}){
 const snapshot={...input,sourceResumeHash:input.sourceResumeHash||history.ats_result?.resume_hash||null,history:history.messages||[],atsResult:scoringFacts(history.ats_result)};
 const result=await generateCommunicationDraft({...snapshot,previousSteps:history.communication_steps});
 if(input.atsConfig?.vacancy_id)history.vacancy_id=String(input.atsConfig.vacancy_id);
 history.communication_steps=result.steps;history.communication_snapshot=snapshot;history.communication_freshness_sig=freshnessSignature(snapshot);
 history.ats_result=history.ats_result||{};history.ats_result.funnel_action=result.action;history.ats_result.funnel_reason=result.reason;
 if(result.message)history.ats_result.draft_message=result.message;else delete history.ats_result.draft_message;
 delete history.ats_result.draft_warning;
 return result;
}
function messageTextWithAttachments(message){
 const raw=typeof message.payload?.text==='string'?message.payload.text:(typeof message.text==='string'?message.text:'');
 const attachments=Array.isArray(message.payload?.attachments)?message.payload.attachments:(Array.isArray(message.attachments)?message.attachments:[]);
 if(!attachments.length)return raw;
 const names=attachments.map(a=>{const name=a?.file_name||a?.filename||a?.name;return typeof name==='string'&&name.trim()?name:'файл';});
 const marker='[Вложения: '+names.join('; ')+'; содержимое не прочитано, доступность не проверена]';
 return raw?raw+'\n'+marker:marker;
}
async function refreshCommunicationHistory(history,negotiationId,request){
 const negotiation=await request(`/negotiations/${negotiationId}`);
 const messages=[];
 // HH chat pagination: https://api.hh.ru/openapi/en/redoc — limit<=50, order=prev, start_message_id.
 const chatId=negotiation.chat_id;
 let cursor=null;const seenCursors=new Set();
 for(let page=0;page<1000;page++){
  const chatQuery=new URLSearchParams({limit:'50',order:'prev'});if(cursor)chatQuery.set('start_message_id',cursor);
  const endpoint=chatId?`/common/chats/${encodeURIComponent(chatId)}/messages?${chatQuery}`:`/negotiations/${negotiationId}/messages?per_page=100&page=${page}`;
  const data=await request(endpoint);
  const items=data?.items||data?.messages;
  if(!Array.isArray(items))throw new Error('HH не подтвердил актуальную историю диалога.');
  messages.push(...items.map(m=>chatId?{id:m.id,text:messageTextWithAttachments(m),created_at:m.creation_time||m.created_at||m.timestamp,author:{participant_type:String(m.sender_display_info?.role||'').toUpperCase()==='APPLICANT'?'applicant':'employer'}}:{...m,text:messageTextWithAttachments(m)}));
  if(chatId){
   if(!data.has_more)break;
   const next=items[0]?.id!=null?String(items[0].id):'';
   if(!next||seenCursors.has(next))throw new CommunicationError('HH_HISTORY_INCOMPLETE','HH не подтвердил полную историю: курсор отсутствует или повторился.');
   seenCursors.add(next);cursor=next;
  }else if(page >= (data.pages||1)-1||items.length===0)break;
  if(page===999)throw new CommunicationError('HH_HISTORY_INCOMPLETE','HH история превышает безопасный предел страниц.');
 }
 const canonical=new Map(messages.filter(m=>m.id!=null&&typeof m.text==='string').map(m=>[String(m.id),m]));
 const updated={...history,messages:(history.messages||[]).map(m=>{const remote=canonical.get(String(m.hh_id));return remote?{...m,text:remote.text,timestamp:remote.created_at||m.timestamp,role:remote.author?.participant_type==='applicant'?'applicant':'employer'}:m;})};
 history.messages=require('./hh-history').mergeHhMessages(updated,messages).messages;
 return negotiation;
}
function communicationEnabledFor(username,vacancyId){
 if(!vacancyId){try{const fs=require('fs'),path=require('path'),{usersRoot}=require('./data-paths');vacancyId=JSON.parse(fs.readFileSync(path.join(usersRoot(),String(username),'contexts','hh','active_vacancy.json'),'utf8'))?.value?.id;}catch{}}
 return communicationEnabled(process.env,{username:String(username),vacancyId:vacancyId?String(vacancyId):null});
}
function contactForbidden(history){return history?.communication_steps?.state?.state?.contact_allowed===false||history?.communication_steps?.goal?.status==='do_not_contact';}
module.exports={contactForbidden,communicationEnabled,communicationEnabledFor,generateAndStoreCommunication,staleCommunicationDraft,freshnessSignature,scoringFacts,refreshCommunicationHistory};
