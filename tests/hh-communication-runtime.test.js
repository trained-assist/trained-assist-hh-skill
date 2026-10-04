import {describe,it,expect} from 'vitest';
import {createRequire} from 'module';
const require=createRequire(import.meta.url);
const {freshnessSignature,staleCommunicationDraft,refreshCommunicationHistory}=require('../src/hh-communication-runtime');
describe('Communication runtime freshness',()=>{
 const base={history:[{role:'applicant',text:'Работал 3 года',hh_id:'1'}],atsConfig:{communication_plan:{version:1,stages:[]}},atsResult:{score:8},resumeText:'Полное резюме'};
 it('ignores an exact thank-you acknowledgement, but preserves new facts',()=>{
  expect(freshnessSignature({...base,history:[...base.history,{role:'applicant',text:'Спасибо!'}]})).toBe(freshnessSignature(base));
  expect(freshnessSignature({...base,history:[...base.history,{role:'applicant',text:'Спасибо, но не могу завтра'}]})).not.toBe(freshnessSignature(base));
 });
 it('ignores draft bookkeeping while detecting instruction and actual score changes',()=>{
  expect(freshnessSignature({...base,atsResult:{score:8,draft_message:'other',funnel_action:'write_message'}})).toBe(freshnessSignature(base));
  expect(freshnessSignature({...base,atsConfig:{...base.atsConfig,message_instructions:'Не спрашивать Ozon'}})).not.toBe(freshnessSignature(base));
  const history={messages:base.history,ats_result:{score:9},communication_snapshot:base,communication_freshness_sig:freshnessSignature(base)};
  expect(staleCommunicationDraft(history,base.atsConfig)).toBe(true);
 });
 it('rejects an exact material draft after a canonical resume changes',()=>{
  const snapshot={...base,sourceResumeHash:'resume-before'};
  const history={messages:base.history,ats_result:base.atsResult,communication_snapshot:snapshot,communication_freshness_sig:freshnessSignature(snapshot),communication_steps:{material:{stage_id:'task'},message:'Exact task'}};
  expect(staleCommunicationDraft(history,base.atsConfig,'resume-before')).toBe(false);
  expect(staleCommunicationDraft(history,base.atsConfig,'resume-after')).toBe(true);
 });
 it('prefers current HH chat payloads and merges canonical sender IDs',async()=>{
  const paths=[];const history={messages:[]};
  await refreshCommunicationHistory(history,'neg',async p=>{paths.push(p);return p==='/negotiations/neg'?{chat_id:'chat'}:{items:[{id:'m1',payload:{text:'Новый вопрос'},sender_display_info:{role:'APPLICANT'},created_at:'2026-10-05T00:00:00Z'}]};});
  expect(paths[1]).toContain('/common/chats/chat/messages');expect(history.messages[0]).toMatchObject({hh_id:'m1',role:'applicant',text:'Новый вопрос'});
 });
 it('does not treat malformed HH response as an empty current history',async()=>{
  await expect(refreshCommunicationHistory({messages:[]},'n',async p=>p==='/negotiations/n'?{}:{})).rejects.toThrow('актуальную историю');
 });
});
