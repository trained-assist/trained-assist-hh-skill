import {it,expect} from 'vitest';
import {createRequire} from 'module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
const require=createRequire(import.meta.url);
const {handleHhPublic}=require('../src/hh-routes');
it('HTTP generation uses saved editable plan, Communication state and goal without HH planner or writer on wait',async()=>{
 const keys=['USERS_DIR','AGENT_DATA_DIR','AGENT_TOKENS_ROOT','AGENT_TOKENS_DIR','AGENT_SECRET','HH_COMMUNICATION_ENABLED','COMMUNICATION_API_URL','COMMUNICATION_TOKEN'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-communication-route-'));const calls=[];
 const service=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls.push({url:req.url,input});res.setHeader('Content-Type','application/json');res.setHeader('x-contract-version','v1');
  const out=req.url.endsWith('/state/extract')?{status:'extracted',conversation_revision:input.conversation_revision,state:{summary:'Ждём портфолио',contact_allowed:true,stages:[{stage_id:'portfolio',status:'in_progress',evidence:[]}],requirements:[],open_questions:[],uncertainties:[],next_check_at:null}}:{status:'wait',requires_message:false,goal:null,execution:null,reason:'Кандидат обещал прислать портфолио',conversation_revision:input.conversation_revision};res.end(JSON.stringify(out));
 });await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const host=http.createServer(async(req,res)=>{try{await handleHhPublic(req,new URL(req.url,'http://localhost'),res,{BASE_USERS_DIR:path.join(root,'users'),PORT:0,getSecretsCache:()=>({}),secrets:{}});}catch(e){res.writeHead(500);res.end(e.message);}});await new Promise(r=>host.listen(0,'127.0.0.1',r));
 try{
  process.env.USERS_DIR=path.join(root,'users');process.env.AGENT_DATA_DIR=path.join(root,'data');process.env.AGENT_TOKENS_ROOT=path.join(root,'tokens');process.env.AGENT_TOKENS_DIR=path.join(root,'tokens');process.env.AGENT_SECRET='';process.env.HH_COMMUNICATION_ENABLED='1';process.env.COMMUNICATION_API_URL=`http://127.0.0.1:${service.address().port}`;process.env.COMMUNICATION_TOKEN='fixture-token';
  const dir=path.join(root,'users','alice','contexts','hh');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'ats_config:vac.json'),JSON.stringify({value:{vacancy_id:'vac',required:[],preferred:[],communication_plan:{version:1,stages:[{id:'portfolio',title:'Портфолио',instruction:'Попроси ссылку на портфолио',completion_result:'Ссылка получена',material:'',material_mode:'context'}]}}}));
  const response=await fetch(`http://127.0.0.1:${host.address().port}/hh/generate-message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'alice',negotiation_id:'n1',vacancy_id:'vac',resume_text:'Дизайнер',candidate_name:'Анна'})});const out=await response.json();expect(response.status).toBe(200);expect(out.funnel_action).toBe('wait');expect(out.message).toBe('');expect(calls.map(c=>c.url)).toEqual(['/v1/conversations/state/extract','/v1/conversations/next-goal']);expect(calls[0].input.partner_profile.text).toBe('Дизайнер');expect(calls[1].input.conversation_objective).toContain('Ссылка получена');
  const history=JSON.parse(fs.readFileSync(path.join(root,'data','hh','alice','candidates','n1.json')));expect(history.communication_steps.goal.status).toBe('wait');expect(history.vacancy_id).toBe('vac');
 }finally{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;await new Promise(r=>host.close(r));await new Promise(r=>service.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
