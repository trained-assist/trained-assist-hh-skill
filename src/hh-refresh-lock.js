'use strict';
const fs = require('fs');
const {randomUUID} = require('crypto');
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function tryAcquire(file) {
  const owner = {pid:process.pid, id:randomUUID()};
  for (let attempt=0; attempt<2; attempt++) {
    try {
      const fd=fs.openSync(file,'wx',0o600);
      try { fs.writeFileSync(fd,JSON.stringify(owner)); } finally { fs.closeSync(fd); }
      return () => { try { if(JSON.parse(fs.readFileSync(file,'utf8')).id===owner.id)fs.unlinkSync(file); } catch(error) { if(error.code!=='ENOENT')throw error; } };
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      let current; try { current=JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; }
      if(alive(current.pid))return null;
      // A separate cleanup owner prevents removing a newly acquired live lock.
      const cleanup=file+'.cleanup';let fd;
      try { fd=fs.openSync(cleanup,'wx',0o600); } catch { return null; }
      try { const latest=JSON.parse(fs.readFileSync(file,'utf8'));if(latest.id!==current.id||alive(latest.pid))return null;fs.unlinkSync(file); }
      catch(error) { if(error.code!=='ENOENT')return null; }
      finally { fs.closeSync(fd);fs.unlinkSync(cleanup); }
    }
  }
  return null;
}
async function acquireHhRefreshLock(file, timeoutMs=15_000) {
  const deadline=Date.now()+timeoutMs;
  do {
    const release=tryAcquire(file);if(release)return release;
    if(Date.now()>=deadline)break;
    await new Promise(resolve=>setTimeout(resolve,Math.min(50,deadline-Date.now())));
  } while(Date.now()<=deadline);
  const error=new Error('Ожидание обновления авторизации HH превысило лимит. Повторите действие.');
  error.code='HH_REFRESH_BUSY';throw error;
}
module.exports={acquireHhRefreshLock};
