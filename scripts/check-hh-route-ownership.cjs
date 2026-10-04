'use strict';
const fs=require('node:fs');
const path=require('node:path');
function violations(source){
 const comments=[];require('acorn').parse(source,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true,onComment:(_block,_text,start,end)=>comments.push([start,end])});
 let code=source;for(const [start,end] of comments.reverse())code=code.slice(0,start)+' '.repeat(end-start)+code.slice(end);
 const errors=[];
 for(const match of code.matchAll(/(?:url|parsedUrl)\.pathname\s*(?:===?|!==?|\.startsWith\s*\(|\.match\s*\(|\.includes\s*\()\s*(['"`])([^'"`\n]+)\1/g))if(/^\/(?:api\/)?hh(?:\/|$)/.test(match[2]))errors.push('Конкурирующий HH обработчик: '+match[2]);
 if(!/isHhPath\(url\.pathname\)[\s\S]{0,100}handleHhPublic\(/.test(code))errors.push('Нет канонического public делегирования HH');
 if(!/isHhPath\(url\.pathname\)[\s\S]{0,100}handleHhAuthed\(/.test(code))errors.push('Нет канонического authenticated делегирования HH');
 return errors;
}
if(require.main===module){const dir=process.argv[2]||process.env.HH_AGENT_DIR;if(!dir){console.error('Usage: node scripts/check-hh-route-ownership.cjs <agent-dir>');process.exit(2);}const errors=violations(fs.readFileSync(path.join(dir,'src/server.js'),'utf8'));if(errors.length){console.error(errors.join('\n'));process.exit(1);}console.log('HH routes: canonical delegation, no competing handlers');}
module.exports={violations};
