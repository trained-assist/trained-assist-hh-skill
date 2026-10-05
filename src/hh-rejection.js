const fs = require('fs');
const { randomUUID } = require('node:crypto');

// Employer-side rejection reason. `discard_vacancy_closed` is reserved for a
// vacancy that is actually being closed (hh_bulk_reject). Rejecting a candidate
// on a still-open vacancy MUST use `discard_by_employer` ("Не подходит"): the
// closed-vacancy reason tells the candidate the vacancy is closed while it keeps
// accepting responses, and HH can treat that as abuse of the reason.
const REJECT_REASON_ACTION = 'discard_by_employer';

// Single source of truth for the standard rejection text. The review page renders
// it into every ОТКЛОНИТЬ card and the server/client both rebuild it from here, so
// a rejection can never fall back to an LLM draft (invitations, "[Имя]" placeholders,
// wrong-name greetings) that one click would send.
const REJECTION_GREETING = 'Спасибо за отклик и уделённое время. Мы изучили ваше резюме и решили продолжить с другими кандидатами. Желаем успехов в поиске работы!';

function standardRejectionText(firstName) {
  const name = String(firstName || '').trim();
  return (name ? name + ', здравствуйте! ' : 'Здравствуйте! ') + REJECTION_GREETING;
}

// Persist each external step: a retry must never resend a delivered message.
async function sendRejection({ historyFile, message, send, discard, refresh, retryUncertain = false }) {
  const read = () => fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : { messages: [] };
  const save = (operation, sentMessage, sent) => {
    const history = read();
    history.rejection_operation = operation;
    if (sentMessage) {
      // hh-history keeps this single even though a rejection is also mirrored by the
      // next HH sync — see src/hh-history.js for why an id-less copy used to double.
      const { appendLocalMessage } = require('./hh-history');
      history.messages = appendLocalMessage(history, {
        role: 'employer', text: sentMessage,
        hhId: sent?.id ?? null, timestamp: sent?.created_at || null,
      });
      const last = [...history.messages].reverse().find(m => m.text === sentMessage);
      if (last) last.type = 'rejection';
    }
    const tmp = historyFile + '.rejection.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, historyFile);
  };
  const previous = read().rejection_operation;
  if (previous?.status === 'done') return { ok: true };
  if (previous?.status === 'discarding') {
    return { ok: false, error: 'Результат предыдущего запроса ещё не подтверждён. Проверьте переписку и статус на HH; повторное сообщение не отправлено.' };
  }
  let operation = {
    message: previous?.status === 'message_sent' ? previous.message : message,
    idempotency_key: ['message_sent', 'sending', 'unknown'].includes(previous?.status) ? previous.idempotency_key : randomUUID(),
    created_at: previous?.created_at || new Date().toISOString(),
    status: previous?.status === 'sending' || previous?.status === 'unknown' ? previous.status : 'sending',
  };
  const findDelivered = async () => {
    if (typeof refresh !== 'function') return null;
    try {
      const result = await refresh();
      const messages = Array.isArray(result) ? result : result?.messages || [];
      const created = Date.parse(operation.created_at || '') || 0;
      return [...messages].reverse().find(item => item.role === 'employer' && item.text === operation.message
        && (Date.parse(item.timestamp || '') || 0) >= created && item.hh_id != null) || null;
    } catch { return null; }
  };
  let alreadyDelivered = previous?.status === 'message_sent';
  if (['sending', 'unknown'].includes(previous?.status)) {
    const remote = await findDelivered();
    if (remote) {
      operation.status = 'message_sent';
      operation.provider_message_id = String(remote.hh_id);
      save(operation, operation.message, { id: remote.hh_id, created_at: remote.timestamp });
      alreadyDelivered = true;
    } else if (!retryUncertain) {
      return { ok: false, error: 'Результат предыдущего запроса ещё не подтверждён. Проверьте переписку HH; автоматический повтор заблокирован.' };
    }
  }
  if (!alreadyDelivered && previous?.status !== 'message_sent') {
    operation.status = 'sending';
    save(operation); // Persist the stable HH idempotency key before POST.
    let sent = null;
    try { sent = await send(operation.message, operation.idempotency_key); }
    catch (e) {
      // A duplicate idempotency UUID or transport failure can mean HH already sent.
      const remote = retryUncertain || Number(e.status) === 409 ? await findDelivered() : null;
      if (remote) {
        operation.status = 'message_sent';
        operation.provider_message_id = String(remote.hh_id);
        save(operation, operation.message, { id: remote.hh_id, created_at: remote.timestamp });
        alreadyDelivered = true;
      } else {
        const definiteClientError = (Number(e.status) >= 400 && Number(e.status) < 500 && Number(e.status) !== 409) || /^HH 4\d\d:/.test(String(e.message || ''));
        operation.status = definiteClientError ? 'failed' : 'unknown';
        save(operation);
        return { ok: false, error: operation.status === 'unknown'
          ? 'Доставка сообщения не подтверждена. Проверьте переписку HH; повтор безопасно использует прежний ключ.'
          : 'Сообщение не отправлено: ' + e.message };
      }
    }
    if (!alreadyDelivered) {
      const providerId = sent?.id ?? sent?.message?.id;
      const remote = providerId == null ? await findDelivered() : null;
      if (providerId == null && typeof refresh === 'function' && !remote) {
        operation.status = 'unknown';
        save(operation);
        return { ok: false, error: 'HH не подтвердил сообщение в актуальной переписке. Перевод в отказ не выполнен.' };
      }
      operation.status = 'message_sent';
      operation.provider_message_id = providerId == null ? (remote ? String(remote.hh_id) : null) : String(providerId);
      save(operation, operation.message, sent || (remote ? { id: remote.hh_id, created_at: remote.timestamp } : null));
    }
  }
  operation.status = 'discarding';
  save(operation);
  try {
    await discard();
    operation.status = 'done';
    save(operation);
    return { ok: true };
  } catch (e) {
    operation.status = 'message_sent';
    save(operation);
    return { ok: false, message_sent: true, error: 'Сообщение отправлено, но перевод в отказ на HH не подтверждён. Повтор кнопки повторит только перевод в отказ. ' + e.message };
  }
}

module.exports = { sendRejection, REJECT_REASON_ACTION, REJECTION_GREETING, standardRejectionText };
