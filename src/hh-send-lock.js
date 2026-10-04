'use strict';
const fs=require('fs');
const path=require('path');
const {randomUUID,createHash}=require('crypto');
const {dataRoot}=require('./data-paths');
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function acquireCandidateSendLock(username,negotiationId){
 const dir=path.join(dataRoot(),'hh',String(username),'locks');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const key=createHash('sha256').update(String(negotiationId)).digest('hex');
 const file=path.join(dir,key+'.send.lock'),owner={pid:process.pid,id:randomUUID()};
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(owner));}finally{fs.closeSync(fd);}return ()=>{try{const current=JSON.parse(fs.readFileSync(file,'utf8'));if(current.id===owner.id)fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}};}
  catch(e){if(e.code!=='EEXIST')throw e;
   let current;try{current=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}
   if(alive(current.pid))return null;
   // One cleanup owner prevents two contenders deleting a freshly acquired lock.
   const cleanup=file+'.cleanup';let fd;
   try{fd=fs.openSync(cleanup,'wx',0o600);}catch{return null;}
   try{const latest=JSON.parse(fs.readFileSync(file,'utf8'));if(latest.id!==current.id||alive(latest.pid))return null;fs.unlinkSync(file);}
   catch(e){if(e.code!=='ENOENT')return null;}
   finally{fs.closeSync(fd);fs.unlinkSync(cleanup);}
  }
 }
 return null;
}
module.exports={acquireCandidateSendLock};
