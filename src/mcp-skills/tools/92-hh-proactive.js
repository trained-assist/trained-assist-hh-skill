'use strict';
const { tokensRoot, usersRoot } = require('../../data-paths.js');
const { publicPageBase, COLD_SEARCH_ENV } = require('../../hh-publish-domain');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const {
  runProactiveSearch,
  buildScoringPromptText,
  loadSchedule,
  saveSchedule,
  atsConfigHash,
  queriesStorePath,
  loadStoredQueries,
  saveStoredQueries,
  getSearchExclusions,
} = require('../../hh-proactive-search');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

function proactiveHmac(username) {
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(username).digest('hex').slice(0, 16);
}

// `vacancyId` is a plain, non-HMAC'd query param appended alongside the token — same
// pattern as hhReviewUrl (src/hh-quick.js) — so the tab switcher can deep-link into
// the right tab. Omitted (falsy) → no param, unchanged for single-vacancy callers.
function proactiveUrl(username, vacancyId) {
  const base = publicPageBase(username, COLD_SEARCH_ENV, 'https://recruiter-assistant.ru');
  const token = proactiveHmac(username);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

const { latestProactiveFile } = require('../../hh-cold-search-snapshots');

module.exports = {
  isReady: () => USER_ID ? fs.existsSync(path.join(tokensRoot(), USER_ID, 'hh')) : false,
  setupTools: [],
  tools: {
    hh_proactive_search: {
      description: 'ПРЕДПОЧТИТЕЛЬНЫЙ инструмент для «холодный поиск» / «найди кандидатов» / «прогрей базу»: без аргументов запускает поиск+скоринг+публикацию результатов по активной вакансии за один вызов (~30 сек). Использует сохранённые критерии ATS. Предпочитай его перед hh_search_resumes+hh_evaluate_resume — тот путь медленнее и не нужен, кроме случаев кастомного запроса (свои text/area/skill фильтры вне критериев вакансии).',
      inputSchema: { type: 'object', properties: { vacancy_id: { type: 'string', description: 'ID вакансии; не меняет текущую выбранную вакансию' }, area: { type: ['string', 'array', 'null'], items: { type: 'string' }, description: 'ID регионов HH; null — явно без ограничения' } } },
      handler: async (args = {}) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };
        const workDir = path.join(usersRoot(), userId);
        try {
          const result = await runProactiveSearch(userId, workDir, {
            vacancyId: args.vacancy_id,
            ...(Object.prototype.hasOwnProperty.call(args, 'area') ? { area: args.area } : {}),
            proactiveUrl: proactiveUrl(userId),
          });
          // vacancy_id is only known after runProactiveSearch resolves it — rebuild
          // the URL with it so the chat-facing link opens directly on the right tab.
          const url = proactiveUrl(userId, result.vacancy_id);
          // new_count is measured over every candidate found (total_found), not over the
          // top slice shown on the page (count) — «30 found, 185 of them new» read as a bug.
          const total = result.total_found ?? result.count;
          const digest = result.first_run
            ? `\n(первый прогон по вакансии — все ${total} найденных считаются новыми)`
            : (result.new_count > 0
              ? `\n🆕 Новых среди найденных (раньше не попадались): ${result.new_count}.`
              : `\nНовых с прошлого прогона: 0.`);
          return {
            ok: true,
            url,
            count: result.count,
            total_found: result.total_found,
            pass_count: result.pass_count,
            review_count: result.review_count,
            vacancy_title: result.vacancy_title,
            searched_at: result.searched_at,
            new_count: result.new_count,
            total_seen: result.total_seen,
            first_run: result.first_run,
            message: `Найдено ${total} кандидатов${total > result.count ? `, на страницу отобраны лучшие ${result.count}` : ''} (PASS: ${result.pass_count}, REVIEW: ${result.review_count}).${result.ai_enriched ? ' AI-теги и резюме добавлены.' : ''}${digest}\nСтраница с результатами: ${url}\n\nХотите узнать, по каким критериям мы отбирали и оценивали? Скажите «покажи промпт оценки кандидатов».`,
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_proactive_scoring_prompt: {
      description: 'Показывает промпт и логику по которой оцениваются кандидаты при проактивном поиске. Вызывай когда рекрутер спрашивает "как вы подбирали", "покажи критерии", "почему этот кандидат" и т.п.',
      inputSchema: { type: 'object', properties: { vacancy_id: { type: 'string' } } },
      handler: async (args = {}) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        return { text: buildScoringPromptText(userId, args.vacancy_id) };
      },
    },

    hh_proactive_queries: {
      description: 'Показывает и редактирует поисковые фразы проактивного поиска для активной вакансии. action=view — показать текущие фразы и когда сгенерированы; action=update — заменить список (передай queries:[...]); action=reset — удалить сохранённые фразы (регенерация при следующем запуске).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['view', 'update', 'reset'], description: 'Действие: view | update | reset' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Новый список фраз (только для action=update)' },
        },
        required: ['action'],
      },
      handler: async ({ action, queries: newQueries }) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };

        const workDir = path.join(usersRoot(), userId);
        let resolved;
        try { resolved = require('../../hh-cold-search-context').resolveSearchContext(workDir); }
        catch (e) { return { error: e.message }; }
        const { config: atsConfig, vacancyId } = resolved;

        // Must include current exclusions — same as runProactiveSearch — so stale check
        // doesn't false-positive when there are no config changes but comments exist.
        const exclusionsForHash = getSearchExclusions(userId, vacancyId);
        const configHash = atsConfig ? atsConfigHash(atsConfig, exclusionsForHash) : null;
        const storePath = queriesStorePath(userId, vacancyId);

        if (action === 'view') {
          try {
            const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const stale = configHash && data.config_hash !== configHash;
            return {
              vacancy_id: vacancyId,
              queries: data.queries || [],
              generated_at: data.generated_at,
              stale,
              stale_reason: stale ? 'ATS конфиг изменился после генерации — запусти поиск или action=reset для регенерации' : null,
              message: `${(data.queries || []).length} фраз для вакансии ${vacancyId}${stale ? ' (устарели)' : ''}: ${(data.queries || []).map(q => `"${q}"`).join(', ')}`,
            };
          } catch (e) {
            if (e.code === 'ENOENT') return { vacancy_id: vacancyId, queries: [], message: 'Фразы ещё не сгенерированы. Запусти hh_proactive_search.' };
            return { error: e.message };
          }
        }

        if (action === 'update') {
          if (!Array.isArray(newQueries) || newQueries.length === 0) return { error: 'queries[] обязателен и не должен быть пустым для action=update' };
          const validQueries = newQueries.map(q => String(q).trim()).filter(Boolean);
          if (!validQueries.length) return { error: 'Все фразы пустые — ничего не сохранено' };
          saveStoredQueries(userId, vacancyId, validQueries, configHash || 'manual', { manual: true });
          return {
            ok: true,
            vacancy_id: vacancyId,
            queries: validQueries,
            message: `Сохранено ${validQueries.length} фраз для вакансии ${vacancyId}. Следующий запуск poactive поиска будет использовать этот список.`,
          };
        }

        if (action === 'reset') {
          try { fs.unlinkSync(storePath); } catch (e) { if (e.code !== 'ENOENT') return { error: e.message }; }
          return { ok: true, vacancy_id: vacancyId, message: `Фразы сброшены. При следующем запуске hh_proactive_search они будут сгенерированы заново через LLM.` };
        }

        return { error: `Неизвестный action: ${action}` };
      },
    },

    hh_proactive_view: {
      description: 'Открыть страницу с результатами проактивного поиска кандидатов. Возвращает ссылку на веб-страницу с пагинацией, скорингом и AI-оценкой.',
      inputSchema: { type: 'object', properties: { vacancy_id: { type: 'string' } } },
      handler: async (args = {}) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };
        const workDir = path.join(usersRoot(), userId);
        const vacancyId = args.vacancy_id || require('../../hh-cold-search-context').readSearchContext(workDir, 'active_vacancy')?.id;
        if (!vacancyId) return { error: 'Сначала выбери вакансию.' };
        const file = latestProactiveFile(userId, vacancyId);
        if (!file) {
          return { error: 'Результатов поиска нет. Запусти поиск командой hh_proactive_search.' };
        }
        let meta = {};
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          meta = {
            vacancy_title: data.vacancy_title,
            searched_at: data.searched_at,
            count: (data.candidates || []).length,
            pass_count: (data.candidates || []).filter(c => c.tag === 'PASS').length,
            review_count: (data.candidates || []).filter(c => c.tag === 'REVIEW').length,
          };
        } catch {}
        const url = proactiveUrl(userId, vacancyId);
        return {
          url,
          ...meta,
          message: `Страница с ${meta.count || '?'} кандидатами (PASS: ${meta.pass_count || 0}, REVIEW: ${meta.review_count || 0}): ${url}`,
        };
      },
    },

    hh_proactive_schedule: {
      description: 'Управление автопоиском: enable/disable/status. Telegram-уведомления холодного поиска удалены; старые notifications_on/off возвращают это объяснение без изменения расписания.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Вакансия: enable/status — по умолчанию текущая; disable без ID — все вакансии профиля' },
          action: { type: 'string', enum: ['status', 'enable', 'disable', 'notifications_on', 'notifications_off'], description: 'status | enable | disable | notifications_on | notifications_off' },
          interval_hours: { type: 'number', description: 'Интервал запуска в часах (для action=enable, по умолчанию 24)' },
        },
        required: ['action'],
      },
      // Thin wrapper over core's generic cron (agent#1489 S7.1): one job per vacancy
      // running hh_proactive_search. Core owns timing, catch-up and history.
      handler: async ({ action, interval_hours, vacancy_id }) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };

        const workDir = path.join(usersRoot(), userId);
        const cron = require('../../hh-cold-search-cron');
        if (action === 'notifications_off' || action === 'notifications_on') {
          return { ok: true, notifications_enabled: false, retired: true, scope: 'global',
            message: 'Уведомления холодного поиска выключены: функция удалена для всех пользователей. Настройки автопоиска не изменены.' };
        }
        const when = iso => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: cron.TIMEZONE }) + ' МСК' : 'ещё не было';
        const roleNote = role => role === 'primary' ? '' : '\n⚠️ На этом сервере планировщик не активен — задание сохранено, но запускаться не будет.';
        try {
          if (action === 'disable') {
            // Legacy file state is also stopped so no pre-migration runner can pick it up.
            require('../../hh-cold-search-schedule').disableSearches(userId, workDir, vacancy_id);
            await cron.disableColdSearch(userId, vacancy_id);
            return { ok: true, enabled: false, scope: vacancy_id ? 'vacancy' : 'profile',
              message: vacancy_id
                ? 'Автопоиск для этой вакансии выключен. Ручной поиск доступен.'
                : 'Автопоиск выключен для всех вакансий профиля. Ручной поиск доступен.' };
          }
          if (action === 'status' && !vacancy_id) {
            const { jobs, role } = await cron.listColdSearch(userId);
            const enabled = jobs.filter(j => j.enabled);
            return { enabled: enabled.length > 0, notifications_enabled: false, scheduler_role: role,
              enabled_vacancy_ids: enabled.map(j => j.arguments.vacancy_id),
              schedules: Object.fromEntries(jobs.map(j => [j.arguments.vacancy_id, { enabled: j.enabled, schedule: j.schedule,
                next_run: j.next_run_at, last_run: j.last_run_at, last_status: j.last_status }])),
              message: `${enabled.length ? `Автопоиск включён для ${enabled.length} вакансий.` : 'Автопоиск выключен.'} Уведомления холодного поиска удалены.${enabled.length ? roleNote(role) : ''}` };
          }
          const id = vacancy_id || require('../../hh-utils').readHhContext(workDir, 'hh', 'active_vacancy')?.value?.id;
          if (!id) return { error: 'Сначала выбери вакансию.' };

          if (action === 'status') {
            const { jobs, role } = await cron.listColdSearch(userId);
            const job = jobs.find(j => j.name === cron.jobName(id) && j.enabled);
            if (!job) {
              return { enabled: false, notifications_enabled: false,
                message: 'Автоматический проактивный поиск выключен. Запусти action=enable чтобы включить — агент будет сам искать новых кандидатов. Уведомления холодного поиска удалены.' };
            }
            return { enabled: true, notifications_enabled: false, scheduler_role: role, schedule: job.schedule,
              last_run: job.last_run_at, last_status: job.last_status, next_run: job.next_run_at,
              message: `Автопоиск включён (расписание: ${job.schedule}, ${cron.TIMEZONE}).\nПоследний запуск: ${when(job.last_run_at)}${job.last_status ? ` (${job.last_status})` : ''}.\nСледующий: ${when(job.next_run_at)}.${roleNote(role)}` };
          }

          if (action === 'enable') {
            const { job, hours, role } = await cron.enableColdSearch(userId, id, interval_hours);
            return { ok: true, enabled: true, notifications_enabled: false, interval_hours: hours, scheduler_role: role,
              schedule: job.schedule, next_run: job.next_run_at,
              message: `✅ Автопоиск включён — каждые ${hours} ч агент будет искать новых кандидатов. Результаты — на странице холодного поиска.\nСледующий запуск: ${when(job.next_run_at)}.${roleNote(role)}` };
          }
        } catch (e) {
          return { error: `Не удалось обратиться к планировщику агента: ${e.message}` };
        }

        return { error: `Неизвестный action: ${action}` };
      },
    },
  },
};
