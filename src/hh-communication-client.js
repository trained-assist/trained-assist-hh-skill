'use strict';
const path = require('path');
const {tokensRoot}=require('./data-paths');
const {readCredentialFileSafe}=require('./hh-utils');
const ROUTES={state:'/v1/conversations/state/extract',goal:'/v1/conversations/next-goal',writer:'/v1/dialogs/next-message'};
class CommunicationError extends Error {constructor(code,message,status=null){super(message);this.code=code;this.status=status;}}
function communicationEnabled(env=process.env,scope=null){
 if(!/^(1|true|on|yes)$/i.test(env.HH_COMMUNICATION_ENABLED || ''))return false;
 const values=key=>String(env[key] || '').split(',').map(v=>v.trim()).filter(Boolean);
 const users=values('HH_COMMUNICATION_USERS'),vacancies=values('HH_COMMUNICATION_VACANCIES');
 if(!users.length&&!vacancies.length)return true;
 if(!scope || typeof scope!=='object')return false;
 if(users.length&&!users.includes(String(scope.username || '')))return false;
 if(vacancies.length&&!vacancies.includes(String(scope.vacancyId ?? scope.vacancy_id ?? '')))return false;
 return true;
}
function communicationToken(){return process.env.COMMUNICATION_TOKEN || readCredentialFileSafe(path.join(tokensRoot(),'communication','token'));}
async function callCommunication(method,input,{baseUrl=process.env.COMMUNICATION_API_URL,token=communicationToken(),fetchImpl=fetch,timeoutMs=45000}={}) {
 if (!ROUTES[method]) throw new CommunicationError('INVALID_METHOD','Неизвестный метод Communication');
 if (!baseUrl || !token) throw new CommunicationError('COMMUNICATION_NOT_CONFIGURED','Communication endpoint/token не настроены');
 let url;try {url=new URL(ROUTES[method],baseUrl);}catch{throw new CommunicationError('COMMUNICATION_NOT_CONFIGURED','Некорректный endpoint Communication');}
 if (url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new CommunicationError('COMMUNICATION_NOT_CONFIGURED','Для Communication нужен HTTPS');
 let response;
 try {response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(timeoutMs)});}
 catch(e){throw new CommunicationError(e.name==='TimeoutError'?'COMMUNICATION_TIMEOUT':'COMMUNICATION_UNAVAILABLE','Communication не ответил');}
 let out;try {out=await response.json();}catch{throw new CommunicationError('COMMUNICATION_INVALID_RESPONSE','Communication вернул некорректный JSON',response.status);}
 if(!out || typeof out!=='object' || Array.isArray(out))throw new CommunicationError('COMMUNICATION_INVALID_RESPONSE','Communication вернул некорректную форму ответа',response.status);
 if(!response.ok || out.error) throw new CommunicationError(out.error?.code || 'COMMUNICATION_UNAVAILABLE','Ошибка Communication: '+(out.error?.code || response.status),response.status);
 const version=response.headers.get('x-contract-version') || out.generation?.contract_version;
 if(version!=='v1')throw new CommunicationError('COMMUNICATION_VERSION_MISMATCH','Несовместимая версия контракта Communication');
 const expected=method==='writer'?input.context_revision:input.conversation_revision;
 const actual=method==='writer'?out.context_revision:out.conversation_revision;
 if(expected!==actual)throw new CommunicationError('STALE_CONVERSATION','Communication вернул другую ревизию снимка');
 return out;
}
module.exports={CommunicationError,communicationEnabled,communicationToken,callCommunication,ROUTES};
