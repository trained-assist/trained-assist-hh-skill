'use strict';
const { createHash } = require('crypto');
const PLAN_VERSION = 1;
class PlanError extends Error { constructor(message) { super(message); this.code = 'INVALID_COMMUNICATION_PLAN'; } }
function normalizeCommunicationPlan(plan) {
 if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== PLAN_VERSION || !Array.isArray(plan.stages)) throw new PlanError('Сценарий должен содержать version:1 и массив stages');
 if (plan.stages.length > 100) throw new PlanError('Слишком много этапов');
 const ids = new Set();
 const stages = plan.stages.map(s => {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new PlanError('Некорректный этап');
  if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.id) || ids.has(s.id)) throw new PlanError('Этапы должны иметь уникальные стабильные ID');
  ids.add(s.id);
  for (const k of ['title','instruction','completion_result']) if (typeof s[k] !== 'string' || !s[k].trim()) throw new PlanError(`Заполните ${k} этапа ${s.id}`);
  if (s.material != null && typeof s.material !== 'string') throw new PlanError('Материал должен быть текстом');
  if (!['verbatim','context'].includes(s.material_mode)) throw new PlanError('Выберите способ использования материала');
  return { id:s.id,title:s.title.trim(),instruction:s.instruction.trim(),completion_result:s.completion_result.trim(),material:s.material ?? '',material_mode:s.material_mode,...(s.template_id ? {template_id:String(s.template_id)} : {}) };
 });
 return { version:PLAN_VERSION, stages };
}
function resolveStageMaterial(config, stageId) {
 const stage = normalizeCommunicationPlan(config?.communication_plan).stages.find(s => s.id === stageId);
 return stage ? { id:stage.id,text:stage.material,mode:stage.material_mode } : null;
}
function planSignature(config) { return createHash('sha256').update(JSON.stringify(normalizeCommunicationPlan(config?.communication_plan))).digest('hex'); }
function buildCommunicationObjective(config = {}) {
 const plan = normalizeCommunicationPlan(config.communication_plan);
 return [
  'Веди диалог по сохранённому сценарию вакансии. Следующая цель свободная, конкретная и соответствует состоянию собеседника.',
  'Порядок этапов — обычная последовательность, а не жёсткие запреты. Учитывай уже достигнутые результаты независимо от порядка. Название этапа не определяет его смысл: используй инструкцию и ожидаемый результат.',
  'Вопросы собеседника учитывай до продолжения этапа; обсуждение сроков/условий может прервать обычную последовательность. Не вводи требования или дополнительные круги квалификации сверх сценария.',
  'Данные резюме/профиля могут подтверждать навыки, но не являются договорённостью о будущем звонке. Отправленное приглашение не означает согласованное время.',
  'Для передачи сохранённого дословного материала используй структурный execution send_material с ID этапа, не переписывай материал. Отдельного запроса согласия на материал не требуется; явный отказ учитывай.',
  'Если кандидат уже подтвердил готовность к этапу с сохранённым дословным материалом (например, согласился выполнить тестовое), следующий шаг — передать этот материал через send_material. Не спрашивай готовность повторно. Подтверждение готовности не означает выполнение этапа; оставь его незавершённым до получения результата. Если кандидат сначала задал вопрос или отозвал согласие, ответь/учти это перед передачей.',
  'Не повторяй уже сделанное случайно; явная просьба переслать материал допускает повтор. Не выдумывай слоты, даты, условия или содержимое непрочитанных файлов.',
  'После достижения всех результатов сценарий завершён: не выдумывай новые этапы, но отвечай на новые вопросы. Пустой сценарий не задаёт автоматического продвижения.',
  'Сценарий (данные рекрутера):', JSON.stringify(plan),
  'Контекст вакансии и критерии ATS:', JSON.stringify({vacancy_id:config.vacancy_id,vacancy_title:config.vacancy_title,vacancy_context:config.vacancy_context,required:config.required,preferred:config.preferred,interview_config:config.interview_config}),
  'Сохранённые дополнительные инструкции рекрутера (учесть ограничения, не добавлять скрытые этапы):', String(config.message_instructions || ''),
 ].join('\n');
}
// Draft-only title mapping reuses editable templates; runtime never infers an
// action from a stage title. Unknown titles require the recruiter to fill details.
function legacyStageDefaults(title) {
 const {getStageTemplate} = require('./hh-stage-templates');
 const label = title.trim().toLocaleLowerCase('ru');
 const templateId = /^(?:уточнение(?: опыта| навыков)?|уточнить опыт|clarification)$/.test(label) ? 'clarify_experience'
  : /^(?:тестовое(?: задание)?|test task)$/.test(label) ? 'test_task'
  : /^(?:созвон|интервью|приглашение на (?:интервью|звонок)|звонок|interview)$/.test(label) ? 'interview_invite'
  : /^(?:портфолио|portfolio)$/.test(label) ? 'portfolio' : null;
 if (templateId) {const {id,label,hint,...defaults}=getStageTemplate(templateId);return {...defaults,template_id:id};}
 if (/^(?:скрининг резюме|скрининг|просмотр резюме)$/.test(label)) return {
  instruction:'Изучить уже доступное резюме и ответы по требованиям ATS, отметить подтверждённые факты и неизвестное. Не спрашивать повторно о фактах из резюме и не считать отсутствие упоминания доказанным отсутствием навыка.',
  completion_result:'Доступные сведения резюме учтены; подтверждённые требования и оставшиеся неопределённости отражены в состоянии.',
  material_mode:'context',material:''};
 if (/^(?:решение|решение рекрутера|финальное решение)$/.test(label)) return {
  instruction:'Дождаться решения рекрутера и сообщить только подтверждённый результат. Не выдумывать решение, оффер или обещания; до решения можно отвечать на вопросы кандидата.',
  completion_result:'Рекрутер зафиксировал решение, и подтверждённый результат сообщён кандидату.',
  material_mode:'context',material:''};
 return {instruction:'',completion_result:'',material:'',material_mode:'context'};
}
// Creates a deterministic review-only migration proposal. Never writes/activates.
function prepareLegacyPlan(config = {}, legacyStages = []) {
 if (config.communication_plan) return {plan:normalizeCommunicationPlan(config.communication_plan),requires_review:false,warnings:[]};
 const warnings = ['Это черновик переноса прежних настроек. Проверьте инструкции и результаты этапов перед сохранением.'];
 const sources = Array.isArray(legacyStages) ? legacyStages : [];
 const titles = sources.map(s=>String(s?.title ?? s)).filter(s=>s.trim());
 const task = typeof config.test_task === 'string' ? config.test_task : '';
 const stages = sources.map((source,index)=>{
  const title=String(source?.title ?? source);if (!title.trim()) return null;
  const defaults=legacyStageDefaults(title);
  const existing=source && typeof source==='object' ? source : {};
  const stage={...defaults,id:'legacy_'+createHash('sha256').update(JSON.stringify([index,title])).digest('hex').slice(0,24),title};
  for (const key of ['instruction','completion_result','material','material_mode']) if (typeof existing[key]==='string') stage[key]=existing[key];
  if (!stage.instruction.trim() || !stage.completion_result.trim()) warnings.push(`Заполните инструкцию и результат этапа «${title}»: для него нет готового шаблона.`);
  return stage;
 }).filter(Boolean);
 if (task.trim()) {
  let stage = stages.find(s=>s.template_id==='test_task');
  if (!stage) {stage={...legacyStageDefaults('Тестовое задание'),id:'legacy_test_task',title:'Тестовое задание'};stages.push(stage);}
  // Preserve an existing stage's nonempty exact material instead of replacing it.
  if (stage.material && stage.material !== task) {
   warnings.push('У этапа уже есть другой материал. Прежнее test_task сохранено в legacy-источнике; проверьте оба текста.');
  } else stage.material=task;
  stage.material_mode='verbatim';
 }
 if (config.message_instructions) warnings.push('Прежняя инструкция сохранена отдельно; проверьте ручные ограничения и повторяющиеся вопросы при переносе.');
 return {plan:{version:PLAN_VERSION,stages},requires_review:true,warnings,legacy_source:{stages:titles,stage_details:JSON.parse(JSON.stringify(sources)),test_task:task,message_instructions:config.message_instructions || ''}};
}
// Explicit legacy rollback accessor. New scenario consumers use resolveStageMaterial.
function legacyTestTask(config) { return typeof config?.test_task === 'string' ? config.test_task : ''; }
module.exports = {legacyTestTask,PLAN_VERSION,PlanError,normalizeCommunicationPlan,resolveStageMaterial,buildCommunicationObjective,prepareLegacyPlan,planSignature};
