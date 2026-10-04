import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
const require=createRequire(import.meta.url);const {generateDraftMessages}=require('../src/hh-scoring');
async function exercise(changeDuringWriter=false){
 const keys=['USERS_DIR','AGENT_DATA_DIR','AGENT_TOKENS_DIR','AGENT_TOKENS_ROOT','HH_API_BASE_URL','HH_COMMUNICATION_ENABLED','HH_COMMUNICATION_USERS','HH_COMMUNICATION_VACANCIES','COMMUNICATION_API_URL','COMMUNICATION_TOKEN'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-background-communication-')),calls=[];const workDir=path.join(root,'users','alice'),tokens=path.join(root,'tokens','alice'),histFile=path.join(root,'data','hh','alice','candidates','n1.json');
 const config={vacancy_id:'B',required:[],preferred:[],communication_plan:{version:1,stages:[{id:'works',title:'Примеры',instruction:'Получить работы',completion_result:'Получены работы',material:'',material_mode:'context'}]}};
 let newInbound=false;
 const resume={id:'resume1',first_name:'Анна',title:'Дизайнер',experience:[{position:'Дизайнер',description:'Полный профиль '+('опыт '.repeat(400))+'Решающая квалификация'}]};
 const service=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=raw?JSON.parse(raw):null;calls.push({url:req.url,method:req.method,input});res.setHeader('Content-Type','application/json');let out;
  if(req.url==='/resumes/resume1')out=resume;
  else if(req.url==='/negotiations/n1')out={id:'n1',chat_id:'c1',resume};
  else if(req.url.startsWith('/common/chats/'))out=req.url.includes('start_message_id=recent')?{messages:[{id:'early',payload:{text:'Портфолио '+('детали '.repeat(100))+'https://example.test/works'},sender_display_info:{role:'APPLICANT'},creation_time:'2026-10-01T00:00:00Z'}],has_more:false}:{messages:[{id:'recent',payload:{text:newInbound?'Новый вопрос о сроках?':'Спасибо'},sender_display_info:{role:'APPLICANT'},creation_time:'2026-10-05T00:00:00Z'}],has_more:true};
  else {res.setHeader('x-contract-version','v1');if(req.url.endsWith('/state/extract'))out={conversation_revision:input.conversation_revision,state:{summary:'Работы получены',contact_allowed:true,stages:[{stage_id:'works',status:'completed',evidence:[{source_id:'early',quote:'https://example.test/works'}]}],requirements:[],open_questions:[],uncertainties:[],next_check_at:null}};
   else if(req.url.endsWith('/next-goal'))out={conversation_revision:input.conversation_revision,status:'goal_ready',goal:{instruction:'Ответить о следующем шаге'},execution:{type:'write_message'}};
   else {if(changeDuringWriter)fs.writeFileSync(path.join(tokens,'hh-message-style'),'Изменённый стиль',{mode:0o600});out={context_revision:input.context_revision,status:'generated',message_text:'Спасибо за работы, вернусь с обратной связью.'};}
  }res.end(JSON.stringify(out));
 });await new Promise(r=>service.listen(0,'127.0.0.1',r));
 try{
  Object.assign(process.env,{USERS_DIR:path.join(root,'users'),AGENT_DATA_DIR:path.join(root,'data'),AGENT_TOKENS_DIR:path.join(root,'tokens'),AGENT_TOKENS_ROOT:path.join(root,'tokens'),HH_API_BASE_URL:`http://127.0.0.1:${service.address().port}`,HH_COMMUNICATION_ENABLED:'1',HH_COMMUNICATION_USERS:'alice',HH_COMMUNICATION_VACANCIES:'B',COMMUNICATION_API_URL:`http://127.0.0.1:${service.address().port}`,COMMUNICATION_TOKEN:'fixture'});
  fs.mkdirSync(path.join(workDir,'contexts','hh'),{recursive:true});fs.writeFileSync(path.join(workDir,'contexts','hh','ats_config:B.json'),JSON.stringify({value:config}));fs.mkdirSync(tokens,{recursive:true});fs.writeFileSync(path.join(tokens,'hh'),JSON.stringify({access_token:'fixture'}),{mode:0o600});fs.mkdirSync(path.dirname(histFile),{recursive:true});fs.writeFileSync(histFile,JSON.stringify({messages:[],ats_result:{draft_message:'Прежний черновик'}}));
  const count=await generateDraftMessages([{id:'n1',resume,_resume_status:'full'}],'alice',workDir,{vacancyId:'B'});const saved=JSON.parse(fs.readFileSync(histFile));
  expect(calls.filter(c=>!c.url.startsWith('/v1/')).every(c=>c.method==='GET')).toBe(true);expect(calls.find(c=>c.url.includes('/state/extract')).input.partner_profile.text).toContain('Решающая квалификация');expect(calls.find(c=>c.url.includes('/state/extract')).input.conversation_history.messages.some(m=>m.id==='early'&&m.text.endsWith('https://example.test/works'))).toBe(true);
  if(changeDuringWriter){expect(count).toBe(0);expect(saved.ats_result.draft_message).toBe('Прежний черновик');expect(saved.communication_steps).toBeUndefined();}
  else {expect(count).toBe(1);expect(saved.communication_steps.goal.status).toBe('goal_ready');expect(saved.ats_result.draft_message).toContain('Спасибо за работы');const before=calls.length;expect(await generateDraftMessages([{id:'n1',resume,_resume_status:'full'}],'alice',workDir,{vacancyId:'B'})).toBe(0);expect(calls.slice(before).every(c=>!c.url.startsWith('/v1/'))).toBe(true);expect(calls.length).toBeGreaterThan(before);newInbound=true;const modelBefore=calls.filter(c=>c.url.startsWith('/v1/')).length;expect(await generateDraftMessages([{id:'n1',resume,_resume_status:'full'}],'alice',workDir,{vacancyId:'B'})).toBe(1);expect(calls.filter(c=>c.url.startsWith('/v1/')).length).toBe(modelBefore+3);expect(JSON.parse(fs.readFileSync(histFile)).messages.some(m=>m.text==='Новый вопрос о сроках?')).toBe(true);}
 }finally{for(const[k,v]of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;await new Promise(r=>service.close(r));fs.rmSync(root,{recursive:true,force:true});}
}
it('background generates without ATS score from full profile/cursor history and reuses unchanged cached draft',()=>exercise());
it('background cannot overwrite a draft when recruiter style changes during writer',()=>exercise(true));
