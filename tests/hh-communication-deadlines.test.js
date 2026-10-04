import {it,expect} from 'vitest';import {createRequire} from 'node:module';import fs from 'node:fs';import vm from 'node:vm';
const require=createRequire(import.meta.url);const {callCommunication}=require('../src/hh-communication-client');const {generateReviewPageHtml}=require('../src/hh-review-page-html');
it('each Communication method allows fallback within a bounded 90-second transport budget',async()=>{
 const timeout=AbortSignal.timeout,deadlines=[];AbortSignal.timeout=ms=>{deadlines.push(ms);return timeout(ms);};
 try{for(const method of ['state','goal','writer']){const key=method==='writer'?'context_revision':'conversation_revision';await callCommunication(method,{[key]:'r1'},{baseUrl:'https://fixture.invalid',token:'fixture',fetchImpl:async(_url,opts)=>{expect(opts.signal).toBeInstanceOf(AbortSignal);return {ok:true,headers:{get:()=> 'v1'},json:async()=>({[key]:'r1'})};}});}expect(deadlines).toEqual([90000,90000,90000]);}finally{AbortSignal.timeout=timeout;}
});
it('transport timeout produces a typed error instead of continuing indefinitely',async()=>{
 await expect(callCommunication('state',{conversation_revision:'r'},{baseUrl:'https://fixture.invalid',token:'fixture',timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason));})})).rejects.toMatchObject({code:'COMMUNICATION_TIMEOUT'});
});
it('review generation has its own full pipeline deadline and reports timeout without claiming a send',async()=>{
 const html=generateReviewPageHtml([],'Fixture','alice','',undefined,{});expect(html).toContain('window.HH_GENERATION_TIMEOUT_MS = 210000');expect(html).toContain('}, window.HH_GENERATION_TIMEOUT_MS)');expect(html).toContain('finally { clearInterval(progressTimer); }');
 const source=html.slice(html.indexOf('async function hhAction('),html.indexOf('\nfunction ',html.indexOf('async function hhAction(')));
 const context={window:{HH_ACTION_TIMEOUT_MS:45000},CALLBACK_BASE:'',HH_USER:'alice',HH_PAGE_TOKEN:'fixture',AbortController,setTimeout,clearTimeout,fetch:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error);})),Error,TypeError,SyntaxError};vm.createContext(context);vm.runInContext(source,context);
 await expect(context.hhAction('/hh/generate-message',{},5)).rejects.toThrow('Сообщение кандидату не отправлялось');
});
