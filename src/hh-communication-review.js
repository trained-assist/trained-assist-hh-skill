'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function communicationReviewHtml(steps){
 if(!steps)return '';
 const state=steps.state?.state||{},goal=steps.goal||{};
 const names={goal_ready:'Подготовить сообщение',wait:'Ждём',do_not_contact:'Контакт запрещён',no_matching_option:'Следующий шаг не определён'};
 const stages=(state.stages||[]).map(s=>`${s.stage_id}: ${s.status}`).join('\n');
 const evidence=(state.stages||[]).flatMap(s=>(s.evidence||[]).map(e=>`${s.stage_id} · ${e.source_id}: ${e.quote}`)).join('\n');
 return `<details class="communication-details"><summary>Состояние и следующий шаг</summary><p>${esc(state.summary||'')}</p><p><strong>${esc(names[goal.status]||goal.status||'')}</strong> ${esc(goal.reason||'')}</p>${goal.goal?.instruction?`<p>${esc(goal.goal.instruction)}</p>`:''}${stages?`<pre>${esc(stages)}</pre>`:''}${evidence?`<details><summary>Подтверждения</summary><pre>${esc(evidence)}</pre></details>`:''}${steps.next_check_at?`<p>Следующая проверка: ${esc(steps.next_check_at)}</p>`:''}</details>`;
}
module.exports={communicationReviewHtml};
