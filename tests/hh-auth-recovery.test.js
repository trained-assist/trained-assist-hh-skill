import {it,expect,afterEach,vi} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url);
const {hhFetch,hhPost,hhApiError,isHhAuthError}=require('../src/hh-utils');
const {createHhNegotiations}=require('../src/hh-negotiations');
const auth={description:'Unrecognized authorization',errors:[{value:'token_expired',type:'oauth'}]};
afterEach(()=>vi.unstubAllGlobals());
it.each([auth,{errors:[{value:'token_expired',type:'oauth'}]}])('preserves structured auth403 details',async data=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:403,json:async()=>data})));
 await expect(hhFetch('/negotiations/n',{access_token:'old'})).rejects.toMatchObject({status:403,provider_error:data,code:'HH_REAUTH_REQUIRED'});
});
it('permission403 and genericoauth403 do not request reconnect',()=>{
 for(const data of [{description:'Forbidden'},{errors:[{type:'oauth',value:'forbidden'}]},{description:'No resume database access'}])expect(isHhAuthError(hhApiError(403,'/resumes',data))).toBe(false);
 expect(isHhAuthError(new Error('HH API 403: /negotiations — token-expired'))).toBe(true);
});
it.each([true,false])('negotiations refreshes actualauth exactlyonce even when retry remains rejected (%s)',async success=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-auth-retry-'));const refresh=vi.fn(async()=> 'fresh');
 const calls=[];vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{calls.push(options.headers.Authorization);if(options.headers.Authorization==='Bearer old'||!success)return {ok:false,status:403,json:async()=>auth};return {ok:true,json:async()=>({items:[],pages:1})};}));
 const api=createHhNegotiations({refreshHhToken:refresh,getSecretsCache:()=>({})});
 try{const operation=api.getHhNegotiationsWithCache(root,'alice','vac','old',{force:true});if(success)expect((await operation).negotiations).toEqual([]);else await expect(operation).rejects.toMatchObject({code:'HH_REAUTH_REQUIRED'});expect(refresh).toHaveBeenCalledTimes(1);expect(calls.filter(x=>x==='Bearer old')).toHaveLength(6);expect(calls.filter(x=>x==='Bearer fresh')).toHaveLength(6);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
it('negotiations does not rotate credentials for permission403',async()=>{
 const refresh=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:403,json:async()=>({description:'Forbidden'})})));
 const api=createHhNegotiations({refreshHhToken:refresh,getSecretsCache:()=>({})});await expect(api.getHhNegotiationsWithCache('/nonexistent','alice','vac','old',{force:true})).rejects.toMatchObject({code:'HH_API_ERROR'});expect(refresh).not.toHaveBeenCalled();
});
it('messagePOST authentication failure is not automatically replayed',async()=>{
 const fetch=vi.fn(async()=>({ok:false,status:403,json:async()=>auth}));vi.stubGlobal('fetch',fetch);await expect(hhPost('/negotiations/n/messages',{access_token:'old'},{message:'fixture'})).rejects.toMatchObject({code:'HH_REAUTH_REQUIRED',method:'POST'});expect(fetch).toHaveBeenCalledTimes(1);
});
it('sync route returns actionable auth error and frontend displays its body',async()=>{
 const {Readable}=require('node:stream');const {handleHhPublic}=require('../src/hh-routes');const vm=require('node:vm');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-auth-sync-'));const keys=['AGENT_TOKENS_ROOT','AGENT_TOKENS_DIR','AGENT_SECRET'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{process.env.AGENT_TOKENS_ROOT=root;process.env.AGENT_TOKENS_DIR=root;process.env.AGENT_SECRET='';fs.mkdirSync(path.join(root,'alice'),{recursive:true});fs.writeFileSync(path.join(root,'alice','hh'),JSON.stringify({access_token:'fake'}));const users=path.join(root,'users');fs.mkdirSync(path.join(users,'alice','contexts','hh'),{recursive:true});fs.writeFileSync(path.join(users,'alice','contexts','hh','active_vacancies.json'),JSON.stringify({value:[{id:'vac'}]}));
 const req=Readable.from([Buffer.from(JSON.stringify({username:'alice',vacancy_id:'vac'}))]);req.method='POST';req.headers={};let status,body;
 await handleHhPublic(req,new URL('/hh/sync-negotiations','http://fixture'),{setHeader(){},writeHead(s){status=s},end(b){body=JSON.parse(b)}},{BASE_USERS_DIR:users,getSecretsCache:()=>({}),getHhNegotiationsWithCache:async()=>{throw hhApiError(403,'/negotiations',auth)}});
 expect(status).toBe(401);expect(body).toMatchObject({code:'HH_REAUTH_REQUIRED',reauth_required:true});expect(body.error).toContain('Подключите HH заново');
 const source=fs.readFileSync(require.resolve('../src/hh-review-page-html'),'utf8');const start=source.indexOf('async function syncNow()');const end=source.indexOf('\nfunction showToast',start);const button={};let toast;const scope={document:{getElementById:()=>button},CALLBACK_BASE:'http://fixture',HH_USER:'alice',HH_VACANCY_ID:'vac',HH_PAGE_TOKEN:'fake',fetch:async()=>({ok:false,status:401,json:async()=>body}),showToast:t=>{toast=t},location:{reload(){throw new Error('must not reload')}}};vm.createContext(scope);vm.runInContext(source.slice(start,end)+';this.syncNow=syncNow;',scope);await scope.syncNow();expect(toast).toContain(body.error);expect(button.disabled).toBe(false);
 }finally{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});}
});
it('concurrent refresh requests share one rotation and safeGET reuses its persisted result',async()=>{
 const {refreshHhToken,hhFetchWithRefresh}=require('../src/hh-utils');const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-auth-singleflight-'));const keys=['AGENT_TOKENS_ROOT','AGENT_TOKENS_DIR'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{process.env.AGENT_TOKENS_ROOT=root;process.env.AGENT_TOKENS_DIR=root;fs.mkdirSync(path.join(root,'alice'));fs.writeFileSync(path.join(root,'alice','hh'),JSON.stringify({access_token:'old',refresh_token:'rotate'}));let rotations=0;vi.stubGlobal('fetch',vi.fn(async(url,options)=>{if(String(url).includes('/oauth/token')){rotations++;await new Promise(r=>setTimeout(r,5));return {ok:true,json:async()=>({access_token:'fresh',refresh_token:'rotated'})};}return options.headers.Authorization==='Bearer old'?{ok:false,status:403,json:async()=>auth}:{ok:true,json:async()=>({id:'me'})};}));const secrets={HH_CLIENT_ID:'fake',HH_CLIENT_SECRET:'fake'};expect(await Promise.all([refreshHhToken('alice',secrets),refreshHhToken('alice',secrets)])).toEqual(['fresh','fresh']);const token={access_token:'old'};expect(await hhFetchWithRefresh('/me',token,'alice',secrets)).toEqual({id:'me'});expect(token.access_token).toBe('fresh');expect(rotations).toBe(1);
 }finally{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});}
});
it('two actual processes share one rotating OAuth credential',async()=>{
 const {execFile}=require('node:child_process');const {promisify}=require('node:util');const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-auth-processes-'));
 try{fs.mkdirSync(path.join(root,'alice'));fs.writeFileSync(path.join(root,'alice','hh'),JSON.stringify({access_token:'old',refresh_token:'rotate'}));const count=path.join(root,'rotations');const code=`const fs=require('fs');global.fetch=async()=>{fs.appendFileSync(process.env.ROTATION_COUNT,'rotation\\n');await new Promise(r=>setTimeout(r,100));return{json:async()=>({access_token:'fresh',refresh_token:'rotated'})}};require(${JSON.stringify(require.resolve('../src/hh-utils'))}).refreshHhToken('alice',{HH_CLIENT_ID:'fake',HH_CLIENT_SECRET:'fake'},'old').then(value=>{if(value!=='fresh')process.exit(2)}).catch(()=>process.exit(3));`;const env={...process.env,AGENT_TOKENS_ROOT:root,AGENT_TOKENS_DIR:root,ROTATION_COUNT:count};const run=()=>promisify(execFile)(process.execPath,['-e',code],{env,timeout:10000});await Promise.all([run(),run()]);expect(fs.readFileSync(count,'utf8').trim().split('\n')).toHaveLength(1);expect(fs.existsSync(path.join(root,'alice','hh.refresh.lock'))).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
},15000);
it('refresh lock recovers a dead owner and times out rather than stealing a live lock',async()=>{
 const {acquireHhRefreshLock}=require('../src/hh-refresh-lock');const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-refresh-lock-'));const file=path.join(root,'hh.refresh.lock');
 try{fs.writeFileSync(file,JSON.stringify({pid:2147483647,id:'dead'}));const release=await acquireHhRefreshLock(file,200);expect(JSON.parse(fs.readFileSync(file,'utf8')).pid).toBe(process.pid);await expect(acquireHhRefreshLock(file,30)).rejects.toMatchObject({code:'HH_REFRESH_BUSY'});release();expect(fs.existsSync(file)).toBe(false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
