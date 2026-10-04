'use strict';
function stageMetrics(response,{cached=false,elapsedMs=null}={}) {
 const generation=response?.generation||{},usage=response?.usage||{};
 const attempts=cached?0:(Number.isFinite(generation.attempts)?generation.attempts:null);
 return {usage_scope:cached?'cache':'reported_response',cache_hit:cached,model:generation.model||null,attempts,retries:attempts===null?null:Math.max(0,attempts-1),latency_ms:cached?0:(elapsedMs??response?.timing?.total_ms??null),usage:cached?{source:'cache',input_tokens:0,output_tokens:0}:usage,cost_usd:cached?0:(Number.isFinite(usage.cost_usd)?usage.cost_usd:null)};
}
function chainMetrics(events=[]) {
 const sum=key=>events.every(e=>Number.isFinite(e[key]))?events.reduce((n,e)=>n+e[key],0):null;
 const tokens=key=>events.every(e=>(e.attempts===0||e.attempts===1)&&Number.isFinite(e.usage?.[key]))?events.reduce((n,e)=>n+e.usage[key],0):null;
 return {stages:events,latency_ms:sum('latency_ms'),attempts:sum('attempts'),retries:sum('retries'),input_tokens:tokens('input_tokens'),output_tokens:tokens('output_tokens'),cost_usd:sum('cost_usd'),cost_source:events.every(e=>Number.isFinite(e.cost_usd))?'reported':'not_reported'};
}
module.exports={stageMetrics,chainMetrics};
