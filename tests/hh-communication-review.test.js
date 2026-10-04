import {describe,it,expect} from 'vitest';
import {createRequire} from 'module';
const require=createRequire(import.meta.url);
const {communicationReviewHtml}=require('../src/hh-communication-review');
describe('Recruiter Communication review',()=>{
 it('shows saved state, goal, evidence, and due check with escaped text',()=>{
  const html=communicationReviewHtml({state:{state:{summary:'<script>bad</script>',stages:[{stage_id:'portfolio',status:'completed',evidence:[{source_id:'msg-1',quote:'Портфолио https://example.com'}]}]}},goal:{status:'wait',reason:'Ответ завтра'},next_check_at:'2026-10-06T09:00:00Z'});
  expect(html).toContain('Ждём');expect(html).toContain('portfolio: completed');expect(html).toContain('msg-1');expect(html).toContain('2026-10-06');expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
 });
 it('does not invent state for a legacy candidate',()=>expect(communicationReviewHtml(null)).toBe(''));
});
