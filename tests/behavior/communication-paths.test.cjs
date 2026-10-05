'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {startMcp}=require('../helpers/mcp');
const parse=r=>JSON.parse(r.content[0].text);
test('real MCP generate/regenerate uses explicit B plan, full paginated HH thread and full resume without legacy ladder, then reconciles a mocked HH send',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-comm-mcp-')),user='fixture',workDir=path.join(root,'users',user),calls=[],requests=[];let deliveredText=null;
 const plan={version:1,stages:[{id:'custom',title:'Любое имя',instruction:'Уточнить условия',completion_result:'Условия согласованы',material:'',material_mode:'context'}]};
 const late='Ответ про опыт '+ 'я'.repeat(1700)+'КОНЕЦ ОТВЕТА';
 const fullResume={id:'resume',first_name:'Анна',last_name:'Фикстура',title:'Дизайнер',skill_set:['Figma'],experience:[{company:'Компания',position:'Дизайнер',description:'проект '.repeat(400)+'КОНЕЦ РЕЗЮМЕ'}],education:{primary:[]}};
 const neg={id:'n1',vacancy:{id:'B',name:'Вакансия B'},vacancy_id:'B',resume:{id:'resume',first_name:'Анна'},chat_id:'chat',state:{id:'response'}};
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');requests.push({method:req.method,path:url.pathname,query:url.search});res.setHeader('content-type','application/json');let out;
  if(req.method==='POST'&&url.pathname.startsWith('/v1/')){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls.push({path:url.pathname,input});res.setHeader('x-contract-version','v1');
   if(url.pathname.endsWith('/state/extract'))out={status:'extracted',conversation_revision:input.conversation_revision,state:{summary:'Уточнение условий',contact_allowed:true,stages:[{stage_id:'custom',status:'in_progress',evidence:[]}],requirements:[],open_questions:[],uncertainties:[],next_check_at:null}};
   else if(url.pathname.endsWith('/next-goal'))out={status:'goal_ready',conversation_revision:input.conversation_revision,requires_message:true,execution:{type:'write_message'},goal:{instruction:'Уточнить удобный формат',required_points:[],forbidden_points:[]},reason:'Сохранённый сценарий'};
   else out={status:'generated',context_revision:input.context_revision,message_text:'Подскажите удобный формат работы?'};
  }else if(req.method==='POST'&&url.pathname==='/common/chats/chat/messages'){let raw='';for await(const c of req)raw+=c;const payload=JSON.parse(raw);assert.match(payload.idempotency_key,/^[0-9a-f-]{36}$/);deliveredText=payload.text;out={id:'delivered'};res.statusCode=201;}
  else if(url.pathname==='/negotiations/n1')out=neg;
  else if(url.pathname==='/resumes/resume')out=fullResume;
  else if(url.pathname==='/common/chats/chat/messages')out=url.searchParams.has('start_message_id')?{has_more:false,items:[{id:'old',payload:{text:late},sender_display_info:{role:'APPLICANT'},creation_time:'2026-01-01T00:00:00Z'}]}:{has_more:true,items:[{id:'new',payload:{text:'Какой формат работы?'},sender_display_info:{role:'APPLICANT'},creation_time:'2026-01-02T00:00:00Z'},...(deliveredText?[{id:'delivered',payload:{text:deliveredText},sender_display_info:{role:'EMPLOYER'},creation_time:'2026-01-03T00:00:00Z'}]:[])]};
  else if(url.pathname==='/negotiations/response')out={items:[neg],pages:1};
  else if(url.pathname==='/me')out={id:user,employer:{id:'fixture-employer'}};
  else{res.statusCode=404;out={error:'unexpected fixture endpoint'};}
  res.end(JSON.stringify(out));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const contexts=path.join(workDir,'contexts','hh'),tokens=path.join(root,'tokens',user);fs.mkdirSync(contexts,{recursive:true});fs.mkdirSync(tokens,{recursive:true});fs.writeFileSync(path.join(tokens,'hh'),JSON.stringify({access_token:'fixture-hh',employer_id:'fixture-employer'}));
 const put=(key,value)=>fs.writeFileSync(path.join(contexts,key+'.json'),JSON.stringify({value}));put('active_vacancy',{id:'A'});put('active_vacancies',[{id:'A'},{id:'B'}]);put('ats_config:B',{vacancy_id:'B',vacancy_title:'B',required:[],preferred:[],communication_plan:plan});
 const mcp=await startMcp({userId:user,workDir,env:{HOME:root,TMPDIR:root,NODE_ENV:'test',AGENT_USER_ID:user,USERS_DIR:path.join(root,'users'),AGENT_DATA_DIR:path.join(root,'data'),AGENT_TOKENS_DIR:path.join(root,'tokens'),AGENT_TOKENS_ROOT:path.join(root,'tokens'),HH_API_BASE_URL:base,HH_COMMUNICATION_ENABLED:'true',HH_COMMUNICATION_USERS:user,HH_COMMUNICATION_VACANCIES:'B',COMMUNICATION_API_URL:base,COMMUNICATION_TOKEN:'fixture-communication',LLM_LADDER_TOKEN:'',OPENROUTER_API_KEY:''}});
 try{
  const generated=parse(await mcp.call('tools/call',{name:'hh_generate_message_to_applicant',arguments:{negotiation_id:'n1'}}));assert.equal(generated.message,'Подскажите удобный формат работы?',JSON.stringify(generated));
  assert.deepEqual(calls.map(c=>c.path),['/v1/conversations/state/extract','/v1/conversations/next-goal','/v1/dialogs/next-message']);
  assert.equal(calls[0].input.conversation_history.messages.length,2);assert.equal(calls[0].input.conversation_history.messages[0].text,late);assert.ok(calls[0].input.partner_profile.text.includes('КОНЕЦ РЕЗЮМЕ'));assert.ok(calls[1].input.conversation_objective.includes('Условия согласованы'));
  assert.ok(requests.some(r=>r.path==='/common/chats/chat/messages'&&r.query.includes('start_message_id=new')));
  const historyFile=path.join(root,'data','hh',user,'candidates','n1.json');const h=JSON.parse(fs.readFileSync(historyFile));assert.equal(h.vacancy_id,'B');assert.equal(h.communication_steps.goal.status,'goal_ready');
  delete h.ats_result;delete h.message_draft;fs.writeFileSync(historyFile,JSON.stringify(h));
  const regenerated=parse(await mcp.call('tools/call',{name:'hh_regenerate_messages',arguments:{vacancy_id:'B'}}));assert.equal(regenerated.regenerated,1,JSON.stringify(regenerated));
  const cached=JSON.parse(fs.readFileSync(historyFile));
  cached.ats_result={score:8,verdict:'ПРОПУСТИТЬ',resume_version:1,resume_hash:cached.communication_snapshot.sourceResumeHash,matched:[],gaps:[]};
  delete cached.message_draft;fs.writeFileSync(historyFile,JSON.stringify(cached));
  const beforeBatch=calls.length;
  const batch=parse(await mcp.call('tools/call',{name:'hh_batch_evaluate',arguments:{vacancy_id:'B'}}));
  assert.ok(!batch.error,JSON.stringify(batch));assert.equal(batch.results[0].message_draft.text,'Подскажите удобный формат работы?',JSON.stringify(batch));
  assert.ok(calls.length>beforeBatch,'cached ATS score still permits Communication generation without a local ladder token');
  assert.equal(requests.filter(r=>r.method==='POST'&&!r.path.startsWith('/v1/')).length,0,'no HH message POST');
  const message=batch.results[0].message_draft.text;
  const sent=parse(await mcp.call('tools/call',{name:'hh_send_message',arguments:{negotiation_id:'n1',message}}));
  assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(sent.send_event.provider_message_id,'delivered');assert.equal(sent.send_event.verification,'provider_history');
  const retry=parse(await mcp.call('tools/call',{name:'hh_send_message',arguments:{negotiation_id:'n1',message}}));
  assert.equal(retry.ok,true,JSON.stringify(retry));assert.equal(retry.reconciled,true);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/common/chats/chat/messages').length,1,'retry must not duplicate actual HH POST');
  assert.equal(JSON.parse(fs.readFileSync(historyFile)).communication_send_events[0].provider_message_id,'delivered');

 }finally{await mcp.stop();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
