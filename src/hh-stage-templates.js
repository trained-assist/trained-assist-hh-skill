'use strict';

// Stage templates for the editable hiring scenario (epic #142, issue #145).
//
// A template is a DRAFT the recruiter copies into the vacancy's communication_plan.
// Once copied, the stage belongs to that vacancy: it carries its own stable id, and a
// later catalog edit can never reach back into a saved plan. Nothing here inspects a
// stage title, template_id or position to decide what an execution means — a test task
// renamed to «Задание по Excel» behaves exactly like the one still called «Тестовое».
// Deciding how a stage is executed is the Communication goal contract's job (#146/#149),
// not this catalog's.

const MATERIAL_MODES = ['verbatim', 'context'];

// Field text comes from the #142 table «Шаблоны этапов». It is written for a recruiter to
// read, so it is deliberately explicit about what "done" means — «получил»/«спасибо» is
// not a completed test task, one sent invite is not an agreed time.
const STAGE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'clarify_experience',
    label: 'Уточнение опыта',
    hint: 'Уточнить неизвестные обязательные требования',
    title: 'Уточнение опыта',
    instruction:
      'Уточнить неизвестные обязательные требования ATS; учитывать резюме и предыдущие ответы, не устраивать дополнительный круг вопросов по preferred.',
    completion_result:
      'Неизвестные обязательные требования уточнены; ответы и остающиеся неопределённости отражены в состоянии.',
    material: '',
    material_mode: 'context',
  }),
  Object.freeze({
    id: 'test_task',
    label: 'Тестовое задание',
    hint: 'Отправить задание и дождаться выполнения',
    title: 'Тестовое задание',
    instruction:
      'Отправить сохранённое задание и дождаться выполнения; учитывать вопросы и согласованные изменения срока.',
    completion_result:
      'Получено выполнение задания; «получил»/«спасибо» сами по себе не означают выполнение.',
    material: '',
    material_mode: 'verbatim',
  }),
  Object.freeze({
    id: 'portfolio',
    label: 'Портфолио',
    hint: 'Запросить ссылку или релевантные примеры работ',
    title: 'Портфолио',
    instruction:
      'Попросить ссылку или примеры релевантных работ, если их ещё нет.',
    completion_result:
      'Получено портфолио или релевантные примеры работ.',
    material: '',
    material_mode: 'context',
  }),
  Object.freeze({
    id: 'interview_invite',
    label: 'Приглашение на интервью / звонок',
    hint: 'Предложить разговор и согласовать время',
    title: 'Приглашение на интервью / звонок',
    instruction:
      'Предложить разговор и согласовать удобные дату и время; использовать известную доступность.',
    completion_result:
      'Есть договорённость о дате и времени звонка/интервью.',
    material: '',
    material_mode: 'context',
  }),
]);

function clone(value) {
  return value && typeof value === 'object' ? { ...value } : value;
}

function normalizeMaterialMode(mode) {
  return MATERIAL_MODES.includes(mode) ? mode : 'context';
}

/**
 * Stage ids only have to be unique inside one plan and stable afterwards: a rename or a
 * reorder must not change them, because send events and goal material_bindings refer to
 * the id. Time prefix keeps ids from two stages added in the same millisecond apart, the
 * random suffix keeps a restored/merged plan from colliding.
 */
function newStageId() {
  return `stg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The catalog as fresh objects — a caller editing the result cannot corrupt the source. */
function stageTemplates() {
  return STAGE_TEMPLATES.map(t => ({ ...t }));
}

function getStageTemplate(id) {
  const found = STAGE_TEMPLATES.find(t => t.id === id);
  return found ? { ...found } : null;
}

/**
 * One stage with every field of the schema present. `material` is stored verbatim (no
 * trimming): it is the exact text a candidate must receive, and trailing spaces/line
 * breaks are part of it.
 */
function createStage(fields = {}, opts = {}) {
  const idFactory = opts.idFactory || newStageId;
  const templateId = fields.template_id ? String(fields.template_id) : '';
  const stage = {
    id: String(fields.id || idFactory()),
    title: String(fields.title || '').trim(),
    instruction: String(fields.instruction || '').trim(),
    completion_result: String(fields.completion_result || '').trim(),
    material: fields.material == null ? '' : String(fields.material),
    material_mode: normalizeMaterialMode(fields.material_mode),
  };
  if (templateId) stage.template_id = templateId;
  return stage;
}

/**
 * Copy a catalog template into a NEW stage. The copy gets its own id, so adding the same
 * template twice yields two independently editable stages — and editing either one never
 * touches the catalog or its sibling.
 */
function createStageFromTemplate(templateId, overrides = {}, opts = {}) {
  const template = getStageTemplate(templateId);
  if (!template) throw new Error(`Unknown stage template: ${templateId}`);
  const { id, label, hint, ...fields } = template;
  return createStage({ ...fields, ...overrides, template_id: id }, opts);
}

/** A stage with no template behind it. Empty text is not invented, not defaulted. */
function createBlankStage(overrides = {}, opts = {}) {
  return createStage({ ...overrides }, opts);
}

module.exports = {
  MATERIAL_MODES,
  STAGE_TEMPLATES,
  stageTemplates,
  getStageTemplate,
  newStageId,
  createStage,
  createStageFromTemplate,
  createBlankStage,
};