'use strict';
const {createHash,randomUUID}=require('node:crypto');
const digest=text=>createHash('sha256').update(String(text)).digest('hex');
class SendOutcomeError extends Error {
 constructor(message,code='SEND_OUTCOME_UNKNOWN'){super(message);this.code=code;}
}
function sendIdentity(history,message){
 const steps=history.communication_steps||{},material=steps.message===message?steps.material:null;
 const messageHash=digest(message),revision=steps.conversation_revision||history.communication_freshness_sig||null;
 return {message_hash:messageHash,context_revision:revision,operation_key:digest(JSON.stringify([messageHash,revision])),...(material?{stage_id:material.stage_id,material_hash:messageHash,material_revision:material.hash}:{}),resend_requested:steps.goal?.execution?.resend_requested===true};
}
function canonicalDelivery(history,message,event){
 const known=new Set(event.baseline_provider_ids||[]);
 return (history.messages||[]).find(m=>m.role==='employer'&&m.text===message&&m.hh_id!=null&&!known.has(String(m.hh_id)));
}
function deliveredResult(event,reconciled=false){return {sent:{id:event.provider_message_id,created_at:event.provider_created_at||event.verified_at},event,reconciled};}
async function confirm(history,message,event,{refresh,persist}){
 try{await refresh();}
 catch(error){event.status='uncertain';event.verification='provider_refresh_failed';event.last_error_code=error.code||'HH_REFRESH_FAILED';await persist();throw new SendOutcomeError('HH не подтвердил исход предыдущей отправки. Повтор пока заблокирован.');}
 const remote=canonicalDelivery(history,message,event);
 if(!remote){event.status='uncertain';event.verification='not_found_in_provider_history';event.last_checked_at=new Date().toISOString();await persist();throw new SendOutcomeError('В актуальной истории HH нет подтверждения отправки. Не повторяйте автоматически: исход требует проверки.');}
 Object.assign(event,{status:'delivered',verification:'provider_history',provider_message_id:String(remote.hh_id),provider_created_at:remote.timestamp||null,verified_at:new Date().toISOString()});
 delete event.last_error_code;await persist();return deliveredResult(event,true);
}
async function reconcilePendingSend({history,message,refresh,persist}){
 const identity=sendIdentity(history,message),events=Array.isArray(history.communication_send_events)?history.communication_send_events:[];
 // A crash between POST and response leaves a persisted pending operation. Its
 // outcome must be reconciled before freshness checks or another POST.
 const pending=[...events].reverse().find(e=>e.message_hash===identity.message_hash&&['pending','uncertain'].includes(e.status));
 if(pending){
  try{return {...await confirm(history,message,pending,{refresh,persist}),delivered:true};}
  catch(error){
   // A current HH chat API retry can safely reuse this operation's idempotency key.
   // Return the still-uncertain event to the caller; legacy callers remain blocked.
   if(pending.status==='uncertain'&&pending.verification==='not_found_in_provider_history')return {uncertain:true,event:pending};
   throw error;
  }
 }
 const delivered=[...events].reverse().find(e=>e.status==='delivered'&&(e.operation_key===identity.operation_key||(identity.material_hash&&e.stage_id===identity.stage_id&&e.material_hash===identity.material_hash&&!identity.resend_requested)));
 return delivered?{...deliveredResult(delivered,true),delivered:true}:null;
}
async function performCommunicationSend({history,message,send,refresh,persist,source='manual',retryUncertain=false}){
 const prior=await reconcilePendingSend({history,message,refresh,persist});if(prior?.delivered)return prior;
 const identity=sendIdentity(history,message);
 const event=prior?.uncertain?prior.event:{version:1,id:randomUUID(),...identity,source,status:'pending',created_at:new Date().toISOString(),baseline_provider_ids:(history.messages||[]).filter(m=>m.role==='employer'&&m.hh_id!=null).map(m=>String(m.hh_id))};
 if(prior?.uncertain&&!retryUncertain)throw new SendOutcomeError('HH не подтвердил исход предыдущей отправки. Повтор пока заблокирован.');
 history.communication_send_events=Array.isArray(history.communication_send_events)?history.communication_send_events:[];
 if(!history.communication_send_events.includes(event))history.communication_send_events.push(event);
 event.status='pending';event.attempts=(event.attempts||0)+1;event.last_attempt_at=new Date().toISOString();await persist(); // Must precede POST; retries retain HH's idempotency key.
 let sent;
 try{sent=await send(event);}
 catch(error){event.status='uncertain';event.verification='transport_error';event.last_error_code=error.code||'HH_SEND_FAILED';await persist();return confirm(history,message,event,{refresh,persist});}
 const providerId=sent?.id??sent?.message?.id;
 if(providerId==null||!String(providerId).trim())return confirm(history,message,event,{refresh,persist});
 Object.assign(event,{status:'delivered',verification:'provider_ack',provider_message_id:String(providerId),provider_created_at:sent.created_at||sent.message?.created_at||null,verified_at:new Date().toISOString()});
 await persist();
 // Positive provider ID proves the send; try to verify the full canonical text
 // without converting a delivered message into an error on refresh outage.
 try{await refresh();const remote=canonicalDelivery(history,message,event);if(remote){event.verification='provider_history';event.provider_created_at=remote.timestamp||event.provider_created_at;}else event.verification='provider_ack_history_pending';}
 catch(error){event.verification='provider_ack_refresh_failed';event.refresh_error_code=error.code||'HH_REFRESH_FAILED';}
 await persist();return {sent,event,reconciled:false};
}
module.exports={SendOutcomeError,sendIdentity,reconcilePendingSend,performCommunicationSend};
