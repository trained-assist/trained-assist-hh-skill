'use strict';

// Single owner of the local negotiation history file (dataDir/hh/<user>/candidates/<neg>.json).
//
// Why this module exists: the same message used to be written twice — /hh/send appended
// it locally with no `hh_id`, then syncHhMessagesToHistory added the very same message
// again on the next sync (it only deduped by `hh_id`). The recruiter saw every outbound
// message twice in «История диалога», the «N от нас» counter was doubled, and the guard
// — which reads this history — started reporting repeated_intro/repeated_question for
// intros that had in fact been sent once. Every writer goes through here now.
//
// Matching rule: same hh_id wins; otherwise same role + same normalized text inside
// DEDUPE_WINDOW_MS. The window is generous (15 min) because the local echo and the HH
// record differ by seconds at most, and a recruiter legitimately repeating the exact
// same sentence hours later is not the same event.

const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function normText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeOf(msg) {
  const t = Date.parse(msg?.timestamp || '');
  return Number.isFinite(t) ? t : null;
}

// Collapses duplicates in place-order, keeping the canonical entry: the one that
// carries `hh_id` (it is the record HH itself confirmed). Returns a new array.
function dedupeMessages(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const kept = [];
  for (const msg of list) {
    if (!msg) continue;
    const key = normText(msg.text);
    const t = timeOf(msg);
    const twinIdx = kept.findIndex(prev => {
      if ((prev.role || 'employer') !== (msg.role || 'employer')) return false;
      // Two entries HH itself confirmed under different ids are two real messages,
      // however identical their text — never collapse those.
      if (prev.hh_id && msg.hh_id && String(prev.hh_id) !== String(msg.hh_id)) return false;
      if (normText(prev.text) !== key) return false;
      const pt = timeOf(prev);
      if (pt == null || t == null) return true; // undated: same text = same event
      return Math.abs(pt - t) <= DEDUPE_WINDOW_MS;
    });
    if (twinIdx === -1) { kept.push(msg); continue; }
    // Prefer the entry HH confirmed; otherwise keep the earlier one and fill gaps.
    const prev = kept[twinIdx];
    const prevHasId = !!prev.hh_id, msgHasId = !!msg.hh_id;
    if (msgHasId && !prevHasId) kept[twinIdx] = { ...prev, ...msg, hh_id: msg.hh_id };
    else if (!prevHasId && !msgHasId && t != null && (timeOf(prev) == null || t < timeOf(prev))) kept[twinIdx] = msg;
  }
  return kept;
}

// Merge messages HH returned for a negotiation into the local history.
// Returns { messages, added } — `messages` is deduped, so an already-corrupted file
// heals itself on the next sync instead of growing a third copy.
function mergeHhMessages(history, hhMessages) {
  const current = dedupeMessages(history?.messages || []);
  const byId = new Set(current.map(m => m.hh_id).filter(Boolean));
  const out = current.slice();
  let added = 0;
  for (const m of hhMessages || []) {
    if (!m || !m.text) continue;
    if (m.id != null && byId.has(m.id)) continue;
    out.push({
      hh_id: m.id ?? null,
      role: m.author?.participant_type === 'applicant' ? 'applicant' : 'employer',
      text: m.text,
      timestamp: m.created_at,
    });
    if (m.id != null) byId.add(m.id);
    added++;
  }
  return { messages: dedupeMessages(out), added };
}

// Local echo of a message we just delivered. `hhId`/`createdAt` come from HH's response
// when available; the dedupe below makes the entry safe to write even without them.
function appendLocalMessage(history, { role = 'employer', text, hhId = null, timestamp = null } = {}) {
  const messages = dedupeMessages(history?.messages || []);
  messages.push({ hh_id: hhId, role, text, timestamp: timestamp || new Date().toISOString() });
  return dedupeMessages(messages);
}

module.exports = { dedupeMessages, mergeHhMessages, appendLocalMessage, normText, DEDUPE_WINDOW_MS };
