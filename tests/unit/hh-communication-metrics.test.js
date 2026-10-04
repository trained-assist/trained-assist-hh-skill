import {it,expect} from 'vitest';
import {createRequire} from 'module';
const {stageMetrics,chainMetrics}=createRequire(import.meta.url)('../../src/hh-communication-metrics');
it('records real reported usage retries latency without inventing provider costs',()=>{const a=stageMetrics({generation:{model:'fixture',attempts:1},usage:{input_tokens:100,output_tokens:20},timing:{total_ms:25}});const m=chainMetrics([a]);expect(m).toMatchObject({attempts:1,retries:0,latency_ms:25,input_tokens:100,output_tokens:20,cost_usd:null,cost_source:'not_reported'});});
it('cached state and goal do not bill prior calls again',()=>{const a=stageMetrics({generation:{attempts:2},usage:{input_tokens:50},timing:{total_ms:10}},{cached:true});expect(chainMetrics([a])).toMatchObject({attempts:0,retries:0,input_tokens:0,output_tokens:0,cost_usd:0,latency_ms:0});});
it('repair attempts do not misreport final response usage as complete total',()=>{expect(chainMetrics([stageMetrics({generation:{attempts:2},usage:{input_tokens:50,output_tokens:10}})])).toMatchObject({attempts:2,retries:1,input_tokens:null,output_tokens:null,cost_usd:null});});
