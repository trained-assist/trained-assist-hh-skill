import {it,expect} from 'vitest';
import {createRequire} from 'module';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);const {acquireCandidateSendLock}=require('../src/hh-send-lock');
it('one concurrent sender owns candidate lock until async operation completes',async()=>{
 const old=process.env.AGENT_DATA_DIR,root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-send-lock-'));process.env.AGENT_DATA_DIR=root;
 try{let finish;const wait=new Promise(r=>finish=r);let winners=0;const sender=async()=>{const release=acquireCandidateSendLock('alice','n1');if(!release)return 'SEND_IN_PROGRESS';try{winners++;await wait;return 'sent';}finally{release();}};const first=sender();expect(await sender()).toBe('SEND_IN_PROGRESS');expect(winners).toBe(1);finish();expect(await first).toBe('sent');const release=acquireCandidateSendLock('alice','n1');expect(typeof release).toBe('function');release();expect(fs.readdirSync(path.join(root,'hh','alice','locks'))).toEqual([]);}
 finally{old===undefined?delete process.env.AGENT_DATA_DIR:process.env.AGENT_DATA_DIR=old;fs.rmSync(root,{recursive:true,force:true});}
});
it('recovers only confirmed dead PID; never expires a live process by age',()=>{
 const old=process.env.AGENT_DATA_DIR,root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-send-lock-'));process.env.AGENT_DATA_DIR=root;
 try{const dir=path.join(root,'hh','alice','locks');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,createHash('sha256').update('n1').digest('hex')+'.send.lock');fs.writeFileSync(file,JSON.stringify({pid:process.pid,id:'live',created_at:0}),{mode:0o600});expect(acquireCandidateSendLock('alice','n1')).toBe(null);fs.writeFileSync(file,JSON.stringify({pid:2147483647,id:'dead'}),{mode:0o600});const release=acquireCandidateSendLock('alice','n1');expect(typeof release).toBe('function');release();expect(fs.existsSync(file)).toBe(false);}
 finally{old===undefined?delete process.env.AGENT_DATA_DIR:process.env.AGENT_DATA_DIR=old;fs.rmSync(root,{recursive:true,force:true});}
});
it('serializes separate OS processes recovering a dead owner and retains the new live lock',async()=>{
 const {fork}=await import('node:child_process');const root=fs.mkdtempSync(path.join(os.tmpdir(),'hh-send-lock-process-'));const worker=path.join(root,'worker.cjs');
 const lockModule=require.resolve('../src/hh-send-lock');fs.writeFileSync(worker,`const {acquireCandidateSendLock}=require(${JSON.stringify(lockModule)});const release=acquireCandidateSendLock('alice','n1');process.send({acquired:!!release});if(release)process.on('message',()=>{release();process.exit(0)});else process.exit(0);`);
 const dir=path.join(root,'hh','alice','locks');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,createHash('sha256').update('n1').digest('hex')+'.send.lock');fs.writeFileSync(file,JSON.stringify({pid:2147483647,id:'dead-owner'}),{mode:0o600});
 const children=[];const start=()=>{const child=fork(worker,[],{env:{...process.env,AGENT_DATA_DIR:root},stdio:['ignore','ignore','ignore','ipc']});children.push(child);return child;};const first=start();
 try{const firstState=await new Promise(r=>first.once('message',r));expect(firstState.acquired).toBe(true);const second=start();const secondState=await new Promise(r=>second.once('message',r));expect(secondState.acquired).toBe(false);expect(JSON.parse(fs.readFileSync(file)).pid).toBe(first.pid);const exited=new Promise(r=>first.once('exit',r));first.send('release');await exited;expect(fs.existsSync(file)).toBe(false);}
 finally{for(const c of children)if(c.exitCode===null)c.kill();fs.rmSync(root,{recursive:true,force:true});}
});
