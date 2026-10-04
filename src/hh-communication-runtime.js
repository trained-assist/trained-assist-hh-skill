'use strict';
const {generateCommunicationDraft,communicationEnabled,signature}=require('./hh-communication-adapter');
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
async function refreshCommunicationHistory(history,negotiationId,request){
 const negotiation=await request(`/negotiations/${negotiationId}`);
 const messages=[];
 const chatId=negotiation.chat_id;
 for(let page=0;page<1000;page++){
  const endpoint=chatId?`/common/chats/${encodeURIComponent(chatId)}/messages?per_page=100&page=${page}`:`/negotiations/${negotiationId}/messages?per_page=100&page=${page}`;
  const data=await request(endpoint);
  const items=data?.items||data?.messages;
  if(!Array.isArray(items))throw new Error('HH не подтвердил актуальную историю диалога.');
  messages.push(...items.map(m=>chatId?{id:m.id,text:m.payload?.text||m.text,created_at:m.created_at||m.timestamp,author:{participant_type:String(m.sender_display_info?.role||'').toUpperCase()==='APPLICANT'?'applicant':'employer'}}:m));
  if(page >= (data.pages||1)-1||items.length===0)break;
  if(page===999)throw new Error('HH история превышает безопасный предел страниц.');
 }
 history.messages=require('./hh-history').mergeHhMessages(history,messages).messages;
 return negotiation;
}
function communicationEnabledFor(username,vacancyId){
 if(!vacancyId){try{const fs=require('fs'),path=require('path'),{usersRoot}=require('./data-paths');vacancyId=JSON.parse(fs.readFileSync(path.join(usersRoot(),String(username),'contexts','hh','active_vacancy.json'),'utf8'))?.value?.id;}catch{}}
 return communicationEnabled(process.env,{username:String(username),vacancyId:vacancyId?String(vacancyId):null});
}
function contactForbidden(history){return history?.communication_steps?.state?.state?.contact_allowed===false||history?.communication_steps?.goal?.status==='do_not_contact';}
module.exports={contactForbidden,communicationEnabled,communicationEnabledFor,generateAndStoreCommunication,staleCommunicationDraft,freshnessSignature,scoringFacts,refreshCommunicationHistory};
