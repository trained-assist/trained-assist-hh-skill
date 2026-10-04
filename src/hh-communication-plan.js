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
  'Не повторяй уже сделанное случайно; явная просьба переслать материал допускает повтор. Не выдумывай слоты, даты, условия или содержимое непрочитанных файлов.',
  'После достижения всех результатов сценарий завершён: не выдумывай новые этапы, но отвечай на новые вопросы. Пустой сценарий не задаёт автоматического продвижения.',
  'Сценарий (данные рекрутера):', JSON.stringify(plan),
  'Контекст вакансии и критерии ATS:', JSON.stringify({vacancy_id:config.vacancy_id,vacancy_title:config.vacancy_title,vacancy_context:config.vacancy_context,required:config.required,preferred:config.preferred,interview_config:config.interview_config}),
  'Сохранённые дополнительные инструкции рекрутера (учесть ограничения, не добавлять скрытые этапы):', String(config.message_instructions || ''),
 ].join('\n');
}
// Creates a review-only migration proposal. It never writes or activates a plan.
function prepareLegacyPlan(config = {}, legacyStages = []) {
 if (config.communication_plan) return {plan:normalizeCommunicationPlan(config.communication_plan),requires_review:false,warnings:[]};
 const warnings = ['Это черновик переноса прежних настроек. Проверьте инструкции и результаты этапов перед сохранением.'];
 const titles = (Array.isArray(legacyStages) ? legacyStages : []).map(s=>String(s?.title ?? s)).filter(s=>s.trim());
 const task = typeof config.test_task === 'string' ? config.test_task : '';
 const stages = titles.map((title,index)=>({id:'legacy_'+createHash('sha256').update(JSON.stringify([index,title])).digest('hex').slice(0,24),title,instruction:'Опишите, что нужно сделать на этом этапе.',completion_result:'Опишите результат, после которого этап выполнен.',material:'',material_mode:'context'}));
 // Migration-only mapping proposes a test-material location; not runtime planning.
 if (task.trim()) {
  let stage = stages.find(s=>/тестов|задани/i.test(s.title));
  if (!stage) {stage={id:'legacy_test_task',title:'Тестовое задание'};stages.push(stage);}
  Object.assign(stage,{instruction:'Отправить сохранённое задание и дождаться выполнения; учитывать вопросы и согласованные изменения срока.',completion_result:'Получено выполнение задания. Подтверждение получения само по себе не означает выполнение.',material:task,material_mode:'verbatim'});
 }
 if (config.message_instructions) warnings.push('Прежняя инструкция сохранена отдельно; проверьте ручные ограничения и повторяющиеся вопросы при переносе.');
 return {plan:{version:PLAN_VERSION,stages},requires_review:true,warnings,legacy_source:{stages:titles,test_task:task,message_instructions:config.message_instructions || ''}};
}
// Explicit legacy rollback accessor. New scenario consumers use resolveStageMaterial.
function legacyTestTask(config) { return typeof config?.test_task === 'string' ? config.test_task : ''; }
module.exports = {legacyTestTask,PLAN_VERSION,PlanError,normalizeCommunicationPlan,resolveStageMaterial,buildCommunicationObjective,prepareLegacyPlan,planSignature};
