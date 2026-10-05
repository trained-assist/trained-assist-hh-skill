import {it,expect} from 'vitest';import {createRequire} from 'node:module';import {Readable} from 'node:stream';import http from 'node:http';import {execFile} from 'node:child_process';
const require=createRequire(import.meta.url);const {handleHhPublic}=require('../src/hh-routes');const {skillRevision}=require('../src/hh-version');
it('safe invalid POST routes identify the loaded skill revision before credential or model work',async()=>{
 for(const endpoint of ['/hh/ats-config','/hh/generate-message']){const req=Readable.from([Buffer.from('{}')]);req.method='POST';req.headers={};const headers={};let status,body;const res={setHeader(k,v){headers[k.toLowerCase()]=v},writeHead(s){status=s},end(b){body=String(b)}};await handleHhPublic(req,new URL(endpoint,'http://localhost'),res,{getSecretsCache:()=>({}),BASE_USERS_DIR:'/nonexistent-fixture',secrets:{}});expect(status).toBe(400);expect(headers['x-hh-skill-rev']).toBe(skillRevision());expect(JSON.parse(body).error).toBe(endpoint==='/hh/ats-config'?'config required':'missing fields');}
});
it('deployment gate probes the actual browser callback owner and rejects a competing route',async()=>{
 const revision='a'.repeat(40),requests=[];let competing=false;
 const callbackServer=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({owner:'callback',path:req.url,method:req.method,body});
  res.setHeader('X-HH-Skill-Rev',competing&&req.url==='/hh/generate-message'?'b'.repeat(40):revision);
  res.writeHead(400,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:req.url==='/hh/ats-config'?'config required':'missing fields'}));
 });
 await new Promise(resolve=>callbackServer.listen(0,'127.0.0.1',resolve));
 const callbackBase=`http://127.0.0.1:${callbackServer.address().port}`;
 const editorServer=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({owner:'editor',path:req.url,method:req.method,body});
  res.setHeader('X-HH-Skill-Rev',revision);
  if(req.method==='GET')res.end(`<meta name="hh-skill-rev" content="${revision}"><script>const CALLBACK_BASE = ${JSON.stringify(callbackBase)};</script>`);
  else {res.writeHead(401);res.end('The page origin does not handle browser API writes');}
 });
 await new Promise(resolve=>editorServer.listen(0,'127.0.0.1',resolve));
 const run=()=>new Promise(resolve=>execFile(process.execPath,['scripts/verify-deploy.cjs','--rev',revision,'--base',`http://127.0.0.1:${editorServer.address().port}`,'--user','fixture','--token','fixture'],{timeout:10000},(error,stdout,stderr)=>resolve({code:error?.code||0,stdout,stderr})));
 try{
  expect((await run()).code).toBe(0);
  expect(requests.filter(request=>request.owner==='editor').map(request=>request.method)).toEqual(['GET']);
  expect(requests.filter(request=>request.method==='POST').map(({owner,path,body})=>({owner,path,body}))).toEqual([{owner:'callback',path:'/hh/ats-config',body:'{}'},{owner:'callback',path:'/hh/generate-message',body:'{}'}]);
  competing=true;const failure=await run();expect(failure.code).toBe(1);expect(failure.stderr).toContain('/hh/generate-message');
 }finally{await Promise.all([new Promise(resolve=>editorServer.close(resolve)),new Promise(resolve=>callbackServer.close(resolve))]);}
},20000);
