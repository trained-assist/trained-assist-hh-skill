'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const {
  runProactiveSearch,
  buildScoringPromptText,
  buildProactiveDigest,
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
  const base = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const token = proactiveHmac(username);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

const { latestProactiveFile } = require('../../hh-cold-search-snapshots');

function readChatId(username) {
  try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', String(username), '.chatid'), 'utf8').trim() || null; }
  catch { return null; }
}

function buildNotifyChat(username) {
  return async (info) => {
    const chatId = readChatId(username);
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!chatId || !botToken) return;
    const text = buildProactiveDigest({
      vacancyTitle: info.vacancyTitle,
      newCount: info.newCount,
      totalNewCount: info.totalNewCount,
      totalSeen: info.totalSeen,
      newCandidates: info.newCandidates,
      threshold: info.threshold,
      url: info.proactiveUrl,
    });
    const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
    await fetch(`${tgBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  };
}

module.exports = {
  isReady: () => USER_ID ? fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'hh')) : false,
  setupTools: [],
  tools: {
    hh_proactive_search: {
      description: 'ПРЕДПОЧТИТЕЛЬНЫЙ инструмент для «холодный поиск» / «найди кандидатов» / «прогрей базу»: без аргументов запускает поиск+скоринг+публикацию результатов по активной вакансии за один вызов (~30 сек). Использует сохранённые критерии ATS. Предпочитай его перед hh_search_resumes+hh_evaluate_resume — тот путь медленнее и не нужен, кроме случаев кастомного запроса (свои text/area/skill фильтры вне критериев вакансии).',
      inputSchema: { type: 'object', properties: { vacancy_id: { type: 'string', description: 'ID вакансии; не меняет текущую выбранную вакансию' }, area: { type: ['string', 'array', 'null'], items: { type: 'string' }, description: 'ID регионов HH; null — явно без ограничения' } } },
      handler: async (args = {}) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };
        const workDir = path.join(process.env.USERS_DIR || path.join(os.homedir(), 'users'), userId);
        try {
          const result = await runProactiveSearch(userId, workDir, {
            vacancyId: args.vacancy_id,
            ...(Object.prototype.hasOwnProperty.call(args, 'area') ? { area: args.area } : {}),
            proactiveUrl: proactiveUrl(userId),
            notifyChat: buildNotifyChat(userId),
          });
          // vacancy_id is only known after runProactiveSearch resolves it — rebuild
          // the URL with it so the chat-facing link opens directly on the right tab.
          const url = proactiveUrl(userId, result.vacancy_id);
          const digest = (result.new_count > 0)
            ? `\n🆕 Из них новых (не показывались ранее): ${result.new_count}.`
            : (result.first_run ? `\n(первый прогон — все ${result.count} считаются новыми)` : `\nНовых с прошлого прогона: 0.`);
          return {
            ok: true,
            url,
            count: result.count,
            pass_count: result.pass_count,
            review_count: result.review_count,
            vacancy_title: result.vacancy_title,
            searched_at: result.searched_at,
            new_count: result.new_count,
            total_seen: result.total_seen,
            first_run: result.first_run,
            message: `Найдено ${result.count} кандидатов (PASS: ${result.pass_count}, REVIEW: ${result.review_count}).${result.ai_enriched ? ' AI-теги и резюме добавлены.' : ''}${digest}\nСтраница с результатами: ${url}\n\nХотите узнать, по каким критериям мы отбирали и оценивали? Скажите «покажи промпт оценки кандидатов».`,
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

        const workDir = path.join(process.env.USERS_DIR || path.join(os.homedir(), 'users'), userId);
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
          saveStoredQueries(userId, vacancyId, validQueries, configHash || 'manual');
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
        const workDir = path.join(process.env.USERS_DIR || path.join(os.homedir(), 'users'), userId);
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
      description: 'Независимое управление автопоиском и Telegram: notifications_off/notifications_on выключают/включают ТОЛЬКО уведомления, поиск продолжается. disable/enable останавливают/запускают поиск, сохраняя настройки уведомлений. Без vacancy_id отключение и уведомления применяются ко всему профилю, выбор вакансии не нужен. status показывает оба состояния.',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Вакансия: enable/status — по умолчанию текущая; disable без ID — все вакансии профиля' },
          action: { type: 'string', enum: ['status', 'enable', 'disable', 'notifications_on', 'notifications_off'], description: 'status | enable | disable | notifications_on | notifications_off' },
          interval_hours: { type: 'number', description: 'Интервал запуска в часах (для action=enable, по умолчанию 24)' },
          notify_threshold: { type: 'number', description: 'Минимальная оценка кандидата (0-100%, нормализовано под критерии вакансии) для попадания в Telegram-уведомление о новых кандидатах. 0 (по умолчанию) — уведомлять обо всех новых, без фильтра. Задаётся вместе с action=enable.' },
        },
        required: ['action'],
      },
      handler: async ({ action, interval_hours, notify_threshold, vacancy_id }) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };

        const workDir = path.join(process.env.USERS_DIR || path.join(os.homedir(), 'users'), userId);
        const { getSchedules, updateSchedule, disableSearches, setNotifications, deliveryEnabled } = require('../../hh-cold-search-schedule');
        if (action === 'notifications_off' || action === 'notifications_on') {
          const enabled = action === 'notifications_on';
          setNotifications(userId, workDir, enabled, vacancy_id);
          return { ok: true, notifications_enabled: enabled, scope: vacancy_id ? 'vacancy' : 'profile',
            message: `Уведомления холодного поиска в Telegram ${enabled ? 'включены' : 'выключены'}. Настройки автопоиска не изменены.` };
        }
        if (action === 'disable') {
          disableSearches(userId, workDir, vacancy_id);
          return { ok: true, enabled: false, scope: vacancy_id ? 'vacancy' : 'profile',
            message: vacancy_id
              ? 'Автопоиск и уведомления для этой вакансии выключены. Ручной поиск доступен.'
              : 'Автопоиск и уведомления холодного поиска выключены для всех вакансий профиля. Ручной поиск доступен.' };
        }
        if (action === 'status' && !vacancy_id) {
          const schedules = getSchedules(userId, workDir);
          const enabled = Object.entries(schedules).filter(([, s]) => s.enabled && !s.archived).map(([id]) => id);
          return { enabled: enabled.length > 0, notifications_enabled: deliveryEnabled(userId, workDir), enabled_vacancy_ids: enabled, schedules,
            message: `${enabled.length ? `Автопоиск включён для ${enabled.length} вакансий.` : 'Автопоиск выключен.'} Уведомления по умолчанию: ${deliveryEnabled(userId, workDir) ? 'включены' : 'выключены'}.` };
        }
        const id = vacancy_id || require('../../hh-utils').readHhContext(workDir, 'hh', 'active_vacancy')?.value?.id;
        if (!id) return { error: 'Сначала выбери вакансию.' };
        const schedule = getSchedules(userId, workDir)[id] || {};
        const persist = () => updateSchedule(userId, workDir, id, schedule);

        if (action === 'status') {
          if (!schedule.enabled) {
            return {
              enabled: false,
              notifications_enabled: deliveryEnabled(userId, workDir, id),
              message: 'Автоматический проактивный поиск выключен. Запусти action=enable чтобы включить — агент будет сам искать новых кандидатов. Уведомления управляются отдельно.',
            };
          }
          const hours = schedule.interval_hours || 24;
          const threshold = schedule.notify_threshold || 0;
          const nextRunTs = schedule.last_run
            ? new Date(new Date(schedule.last_run).getTime() + hours * 3600000).toISOString()
            : '~10 мин после старта сервера';
          return {
            enabled: true,
            notifications_enabled: deliveryEnabled(userId, workDir, id),
            interval_hours: hours,
            notify_threshold: threshold,
            last_run: schedule.last_run || null,
            next_run: nextRunTs,
            message: `Автопоиск включён. Уведомления: ${deliveryEnabled(userId, workDir, id) ? 'включены' : 'выключены'}. Интервал: каждые ${hours} ч.\n${threshold > 0 ? `Порог уведомлений: ≥${threshold}% — слабее не присылаем.` : 'Порог уведомлений не задан — уведомляем обо всех новых кандидатах.'}\nПоследний запуск: ${schedule.last_run || 'ещё не было'}.\nСледующий: ${nextRunTs}.`,
          };
        }

        if (action === 'enable') {
          const hours = interval_hours && interval_hours > 0 ? interval_hours : (schedule.interval_hours || 24);
          const threshold = (notify_threshold !== undefined && notify_threshold !== null)
            ? Math.max(0, Math.min(100, Number(notify_threshold) || 0))
            : (schedule.notify_threshold || 0);
          schedule.enabled = true;
          schedule.interval_hours = hours;
          schedule.notify_threshold = threshold;
          persist();
          return {
            ok: true,
            enabled: true,
            notifications_enabled: deliveryEnabled(userId, workDir, id),
            interval_hours: hours,
            notify_threshold: threshold,
            message: `✅ Автопоиск включён — каждые ${hours} ч агент будет искать новых кандидатов. Уведомления в Telegram: ${deliveryEnabled(userId, workDir, id) ? 'включены' : 'выключены'}.${threshold > 0 ? ` В уведомление попадут только кандидаты с оценкой ≥${threshold}%.` : ''} Первый запуск в течение 30 мин.\n\n⚠️ Это встроенный планировщик агента — он НЕ появится в списке cron_list (там только внешние Cloud Scheduler задачи). Проверить статус: hh_proactive_schedule action=status.`,
          };
        }

        return { error: `Неизвестный action: ${action}` };
      },
    },
  },
};
