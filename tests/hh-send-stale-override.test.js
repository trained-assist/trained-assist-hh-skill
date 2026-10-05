import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url);
const {handleHhPublic}=require('../src/hh-routes');

it('stale drafts need a per-candidate confirmation, then send once and verify against the exact HH chat',async()=>{
 const keys=['AGENT_DATA_DIR','AGENT_TOKENS_DIR','AGENT_TOKENS_ROOT','AGENT_SECRET','HH_COMMUNICATION_ENABLED','HH_COMMUNICATION_USERS','HH_COMMUNICATION_VACANCIES','USERS_DIR'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-stale-send-'));
 const originalFetch=globalThis.fetch;
 const text='Reviewed stale draft';
 const file=path.join(root,'data','hh','alice','candidates','n1.json');
 let posts=0;
 globalThis.fetch=async(url,options={})=>{
  if(options.method==='POST'){
   posts++;
   return {ok:true,status:201,json:async()=>({id:'sent-1',created_at:'2026-10-05T10:00:00Z'})};
  }
  if(String(url).includes('/common/chats/')) return {ok:true,status:200,json:async()=>({has_more:false,messages:posts?[{id:'sent-1',creation_time:'2026-10-05T10:00:00Z',payload:{text},sender_display_info:{role:'EMPLOYER'}}]:[]})};
  if(String(url).includes('/resumes/')) return {ok:true,status:200,json:async()=>({id:'resume-1',first_name:'Анна',last_name:'Тест'})};
  return {ok:true,status:200,json:async()=>({id:'n1',chat_id:'chat-1',state:{id:'consider'},resume:{id:'resume-1',updated_at:'2026-10-05'}})};
 };
 const call=async(body)=>{
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={};
  let status,raw;const res={setHeader(){},writeHead(s){status=s},end(b){raw=String(b)}};
  await handleHhPublic(req,new URL('/hh/send','http://localhost'),res,{BASE_USERS_DIR:path.join(root,'users'),getSecretsCache:()=>({}),secrets:{}});
  return {status,data:JSON.parse(raw)};
 };
 try{
  process.env.AGENT_DATA_DIR=path.join(root,'data');
  process.env.AGENT_TOKENS_DIR=path.join(root,'tokens');
  process.env.AGENT_TOKENS_ROOT=path.join(root,'tokens');
  process.env.USERS_DIR=path.join(root,'users');
  process.env.AGENT_SECRET='';
  process.env.HH_COMMUNICATION_ENABLED='1';
  delete process.env.HH_COMMUNICATION_USERS;delete process.env.HH_COMMUNICATION_VACANCIES;
  fs.mkdirSync(path.join(root,'tokens','alice'),{recursive:true});
  fs.writeFileSync(path.join(root,'tokens','alice','hh'),JSON.stringify({access_token:'fixture'}),{mode:0o600});
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({
   messages:[],vacancy_id:'vac',communication_snapshot:{history:[],atsConfig:{},resumeText:'old'},
   communication_freshness_sig:'old-signature',ats_result:{draft_message:text},
   communication_steps:{conversation_revision:'r1',message:text,material:{stage_id:'task',hash:'material-1'},state:{state:{contact_allowed:true}},goal:{status:'goal_ready'}},
  }),{mode:0o600});
  const common={username:'alice',negotiation_id:'n1',vacancy_id:'vac',message:text};
  const blocked=await call(common);
  expect(blocked.status).toBe(409);expect(blocked.data.code).toBe('STALE_COMMUNICATION_DRAFT');expect(posts).toBe(0);
  const sent=await call({...common,force_stale:true});
  expect(sent.status).toBe(200);expect(sent.data.ok).toBe(true);expect(posts).toBe(1);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(saved.communication_send_events[0]).toMatchObject({status:'delivered',verification:'provider_history',source:'http_manual_stale_override',provider_message_id:'sent-1'});
  const duplicate=await call({...common,force_stale:true});
  expect(duplicate.status).toBe(200);expect(duplicate.data.reconciled).toBe(true);expect(posts).toBe(1);
 }finally{
  globalThis.fetch=originalFetch;
  for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;
  fs.rmSync(root,{recursive:true,force:true});
 }
});
