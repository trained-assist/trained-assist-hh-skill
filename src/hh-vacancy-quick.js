'use strict';
// HH vacancy-creation quick flow — moved from core src/runner/intent-engine.js (agent#1470).
// Core keeps the ORDER of its quick-answer checks and calls in at the same points:
//   vacancyCollectingAnswer — first, so collecting mode wins over every other intent;
//   newJobAnswer            — at the «новая вакансия» slot;
//   vacancyAsyncAnswer      — in the async section (generation / landing page / HH draft).
// The sync hooks return { answer } when they decided (answer null = hand over to the
// async section / Claude) and undefined when they do not apply. The async hook returns
// the reply text or undefined. Host services (hhConnected, the publish-intent
// classifier) come from core via ctx.
const { readVacancyState, initVacancyState, appendVacancyMessage, writeVacancyState,
  generateVacancyFromMessages, publishVacancyPage, publishToHH, getMissingFields } = require('./hh-vacancy');
const { VACANCY_HH_PUBLISH_INTENT, VACANCY_PREP_DRAFT_INTENT } = require('./hh-intents');

const NEW_JOB_INTENT            = /новая вакансия|new job post|\/new_job_post|создать вакансию|добавить вакансию|создай вакансию/i;
const VACANCY_DONE_INTENT       = /^всё$|^все$|^готово$|^хватит$|^достаточно$|^запускай$|^стоп, всё$|^всё, запускай$|^ок, всё$/i;
const VACANCY_CANCEL_INTENT     = /отмен.{0,20}вакансии|отмен.{0,20}созда|выйт.{0,15}режим|стоп.{0,10}вакансия|сброс.{0,15}вакансии|\/cancel_vacancy/i;
const VACANCY_PUBLISH_PAGE_INTENT = /публику[йе].{0,20}страниц|опубликуй.{0,20}(?:страниц|лендинг)|создай.{0,20}(?:страниц.{0,20}вакансии|лендинг)|сгенерир.{0,20}страниц|сделай.{0,20}страниц.{0,20}вакансии|страниц.{0,30}(?:вакансии.{0,30})?(?:сгенерир|создай|опубликуй|сделай)|страниц.{0,20}готов/i;

function vacancyCollectingAnswer(task, { workDir, isPingOrHelp = false } = {}) {
  if (!workDir) return undefined;
  const vs = readVacancyState(workDir);
  if (vs?.status === 'generating') {
    // Already running an Anthropic API call — block new messages to prevent concurrent generation
    return { answer: '⏳ Генерирую вакансию, подожди немного...' };
  }
  if (vs?.status === 'collecting') {
    // Cancel — let user escape collecting mode
    if (VACANCY_CANCEL_INTENT.test(task)) {
      writeVacancyState(workDir, { ...vs, status: 'cancelled' });
      return { answer: '❌ Создание вакансии отменено. Чтобы начать заново — скажи «новая вакансия».' };
    }
    if (VACANCY_DONE_INTENT.test(task.trim())) {
      // Mark as generating; runQuickAnswer async section will call Anthropic API
      writeVacancyState(workDir, { ...vs, status: 'generating' });
      return { answer: null }; // fall through to async handler
    }
    // Skip other quick-answer patterns while collecting (except ping/help)
    if (!isPingOrHelp) {
      const count = appendVacancyMessage(workDir, task);
      const countLabel = count === 1 ? 'блок' : count < 5 ? 'блока' : 'блоков';
      return { answer: `✅ Принял (${count} ${countLabel}). Ещё что-нибудь? Или скажи «всё» — начну генерировать.\nЧтобы отменить: «отмени создание вакансии».` };
    }
  }
  return undefined;
}

function newJobAnswer(task, { workDir } = {}) {
  if (!NEW_JOB_INTENT.test(task)) return undefined;
  if (!workDir) return { answer: 'Не удалось определить рабочую директорию. Попробуй ещё раз.' };
  const existingVs = readVacancyState(workDir);
  if (existingVs && !['cancelled', 'hh_draft'].includes(existingVs.status)) {
    return { answer: `⚠️ Уже есть активная вакансия (статус: ${existingVs.status}). Чтобы отменить её и начать новую — скажи «отмени создание вакансии».` };
  }
  initVacancyState(workDir);
  return { answer: [
    '📋 Создаём новую вакансию!',
    '',
    'Кидай всё что есть — черновики, требования, заметки со звонков, переговоры с клиентом. Можно кусками, можно всё сразу.',
    '',
    'Когда всё скинешь — скажи «всё».',
  ].join('\n') };
}

async function vacancyAsyncAnswer(task, { userId, workDir, openrouterKey, hhConnected, classifyPublish = async () => false } = {}) {
  // Vacancy generation — triggered when collecting mode is done ("всё" set status → "generating")
  if (workDir && openrouterKey) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating' && vs.messages?.length > 0) {
      const r = await generateVacancyFromMessages(workDir, vs.messages, openrouterKey, userId).catch(e => {
        console.error('[vacancy] generation error:', e.message);
        writeVacancyState(workDir, { ...vs, status: 'collecting' }); // rollback so user can retry
        return '⚠️ Ошибка при генерации вакансии. Попробуй ещё раз — скажи «всё» когда будешь готов.';
      });
      if (r) return r;
    }
  }

  // Publish vacancy landing page — regex fast-path OR Haiku fallback when draft exists
  if (workDir && userId && hhConnected) {
    const wantsPage = VACANCY_PUBLISH_PAGE_INTENT.test(task)
      || await classifyPublish(task);

    if (wantsPage) {
      const vs = readVacancyState(workDir);
      if (vs?.draft) {
        const r = await publishVacancyPage(workDir, vs.draft, vs.vacancy_id, userId).then(url => {
          const missing = getMissingFields(vs.draft);
          const missingNote = missing.length
            ? `\n\n📋 Уточни, чтобы дополнить страницу:\n${missing.join('\n')}`
            : '';
          return [
            '🌐 Страница вакансии опубликована!',
            '',
            url,
            missingNote,
            '',
            'Когда рекрутер даст правки — скажи что изменить, пересоздам страницу.',
            'Готово публиковать на HH? Скажи «опубликуй черновик на HH».',
          ].join('\n');
        }).catch(e => {
          console.error('[vacancy] publish page error (→ Claude):', e.message);
          const vsE = readVacancyState(workDir);
          if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
          return null; // let Claude see the error in its context and handle it
        });
        if (r) return r;
      }
      if (!readVacancyState(workDir)?.draft) {
        return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
      }
    }
  }

  // Fast-path: "подготовь черновик вакансии на HH" — when data is already known or being provided
  // Workflow: draft_ready → push to HH immediately; else → start single-shot collecting mode
  if (workDir && userId && hhConnected && VACANCY_PREP_DRAFT_INTENT.test(task)) {
    const vsp = readVacancyState(workDir);
    if (vsp?.status === 'draft_ready' && vsp.draft) {
      const rp = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
        const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
        return [
          `✅ Черновик вакансии сохранён на HeadHunter!`,
          '',
          `🆔 Draft ID: ${hhId}`,
          `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
          areaNote,
          '',
          'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
        ].filter(Boolean).join('\n');
      }).catch(e => {
        console.error('[vacancy] HH publish error (→ Claude):', e.message);
        const vsE = readVacancyState(workDir);
        if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
        return null; // let Claude see the error in its context and handle it
      });
      if (rp) return rp;
    }
    if (vsp?.status === 'collecting') return '⏳ Уже собираем данные для вакансии. Кидай текст — когда всё готово, скажи «всё».';
    if (vsp?.status === 'generating') return '⏳ Уже генерирую черновик вакансии, подожди немного...';
    if (!vsp || ['cancelled', 'hh_draft'].includes(vsp.status)) {
      initVacancyState(workDir);
      return [
        '📋 Готовлю черновик вакансии для HeadHunter!',
        '',
        'Скинь всё что есть: текст с сайта, описание должности, требования, условия.',
        'Можно одним большим куском — всё прочитаю.',
        '',
        'Когда отправишь — скажи «всё», сгенерирую вакансию и выложу черновик на HH.',
      ].join('\n');
    }
  }

  // Publish vacancy as HH draft
  if (workDir && userId && hhConnected && VACANCY_HH_PUBLISH_INTENT.test(task)) {
    const vs2 = readVacancyState(workDir);
    if (!vs2?.draft) {
      return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
    }
    const r2 = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
      const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
      return [
        `✅ Черновик вакансии сохранён на HeadHunter!`,
        '',
        `🆔 Draft ID: ${hhId}`,
        `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
        areaNote,
        '',
        'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
      ].filter(Boolean).join('\n');
    }).catch(e => {
      console.error('[vacancy] HH publish error (→ Claude):', e.message);
      const vsE = readVacancyState(workDir);
      if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
      return null; // let Claude see the error in its context and handle it
    });
    if (r2) return r2;
  }
  return undefined;
}

module.exports = {
  vacancyCollectingAnswer, newJobAnswer, vacancyAsyncAnswer,
  NEW_JOB_INTENT, VACANCY_DONE_INTENT, VACANCY_CANCEL_INTENT, VACANCY_PUBLISH_PAGE_INTENT,
};
