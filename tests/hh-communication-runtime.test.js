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
 it('reads older HH chat pages with cursor so an earlier key answer is preserved',async()=>{
  const paths=[];const history={messages:[]};
  await refreshCommunicationHistory(history,'n',async endpoint=>{paths.push(endpoint);if(endpoint==='/negotiations/n')return {chat_id:'chat'};const cursor=new URL(endpoint,'http://fixture').searchParams.get('start_message_id');return cursor?{messages:[{id:'old',payload:{text:'Портфолио https://example.com'},sender_display_info:{role:'APPLICANT'},creation_time:'2026-10-01T10:00:00Z'}],has_more:false}:{messages:[{id:'recent',payload:{text:'Спасибо'},sender_display_info:{role:'APPLICANT'},creation_time:'2026-10-05T10:00:00Z'}],has_more:true};});
  expect(paths[1]).toContain('limit=50&order=prev');expect(paths[2]).toContain('start_message_id=recent');expect(history.messages.map(m=>m.text)).toContain('Портфолио https://example.com');expect(history.messages.find(m=>m.hh_id==='old').timestamp).toBe('2026-10-01T10:00:00Z');
 });
 it('updates an edited canonical HH message with the same ID and invalidates the snapshot',async()=>{
  const snapshot={...base,history:[{hh_id:'answer',role:'applicant',text:'Могу завтра',timestamp:'2026-10-05T10:00:00Z'}]};
  const history={messages:snapshot.history,ats_result:base.atsResult,communication_snapshot:snapshot,communication_freshness_sig:freshnessSignature(snapshot)};
  await refreshCommunicationHistory(history,'n',async endpoint=>endpoint==='/negotiations/n'?{chat_id:'chat'}:{messages:[{id:'answer',payload:{text:'Не могу завтра'},creation_time:'2026-10-05T10:00:00Z',sender_display_info:{role:'APPLICANT'}}],has_more:false});
  expect(history.messages).toHaveLength(1);expect(history.messages[0].text).toBe('Не могу завтра');expect(staleCommunicationDraft(history,base.atsConfig)).toBe(true);
 });
 it('retains attachment-only portfolio metadata through adapter history without fetching or claiming to read files',async()=>{
  const history={messages:[]};const paths=[];
  await refreshCommunicationHistory(history,'n',async endpoint=>{paths.push(endpoint);if(endpoint==='/negotiations/n')return {chat_id:'chat'};return {messages:[{id:'file-message',payload:{attachments:[{filename:'portfolio.pdf',url:'https://fixture.invalid/private-file'}]},creation_time:'2026-10-05T10:00:00Z',sender_display_info:{role:'APPLICANT'}}],has_more:false};});
  const {normalizedHistory}=require('../src/hh-communication-adapter');const adapted=normalizedHistory(history.messages);
  expect(adapted[0].text).toContain('portfolio.pdf');expect(adapted[0].text).toContain('содержимое не прочитано, доступность не проверена');expect(adapted[0].speaker).toBe('partner');expect(paths).toHaveLength(2);expect(paths.every(p=>!p.includes('private-file'))).toBe(true);
 });
 it('preserves attachment metadata on canonical message edits, including legacy attachment-only messages',async()=>{
  const history={messages:[{hh_id:'file-message',role:'applicant',text:'old marker'}]};
  await refreshCommunicationHistory(history,'n',async endpoint=>endpoint==='/negotiations/n'?{}:{items:[{id:'file-message',text:'Обновлённое портфолио',attachments:[{}],author:{participant_type:'applicant'}}]});
  expect(history.messages).toHaveLength(1);expect(history.messages[0].text).toContain('Обновлённое портфолио');expect(history.messages[0].text).toContain('[Вложения: файл; содержимое не прочитано');
 });
 it('rejects repeating HH chat cursor instead of silently accepting truncated history',async()=>{
  const history={messages:[{role:'applicant',text:'Keep previous snapshot'}]};
  await expect(refreshCommunicationHistory(history,'n',async endpoint=>endpoint==='/negotiations/n'?{chat_id:'chat'}:{messages:[{id:'same',payload:{text:'Latest'},sender_display_info:{role:'APPLICANT'}}],has_more:true})).rejects.toMatchObject({code:'HH_HISTORY_INCOMPLETE'});
  expect(history.messages).toEqual([{role:'applicant',text:'Keep previous snapshot'}]);
 });
 it('does not treat malformed HH response as an empty current history',async()=>{
  await expect(refreshCommunicationHistory({messages:[]},'n',async p=>p==='/negotiations/n'?{}:{})).rejects.toThrow('актуальную историю');
 });
});
