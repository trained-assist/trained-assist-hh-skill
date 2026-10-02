'use strict';
// Тяжёлые файлы кандидатов → GCS через core /internal/blob/* (#105): скилл не
// тащит GCS-SDK — байты идут на ядро, у которого уже есть ADC и session-blob-store.
// Адрес/секрет — тот же паттерн, что у hh-core-publish.js (AGENT_INTERNAL_URL → PORT → PUBLIC).
function coreBase(env = process.env) {
  if (env.AGENT_INTERNAL_URL) return env.AGENT_INTERNAL_URL.replace(/\/$/, '');
  if (env.PORT) return `http://127.0.0.1:${env.PORT}`;
  return (env.AGENT_PUBLIC_URL || '').replace(/\/$/, '');
}

function query(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
}

function requireEnv(env) {
  const base = coreBase(env);
  if (!base || !env.AGENT_SECRET) {
    return { error: 'GCS-загрузка недоступна из этого окружения (нет адреса ядра или секрета)' };
  }
  return { base };
}

async function uploadDocBytes({ username, candidateId, docId, ext, buffer, contentType }, { env = process.env, fetchImpl = fetch } = {}) {
  const gate = requireEnv(env);
  if (gate.error) return gate;
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: 'пустой файл' };
  // Timeout соразмерен размеру: локальный hop к ядру быстрый, но GCS-запись тяжёлая.
  const timeoutMs = Math.min(300_000, 60_000 + Math.ceil(buffer.length / (1024 * 1024)) * 5_000);
  try {
    const res = await fetchImpl(`${gate.base}/internal/blob/upload?${query({
      username, candidate_id: candidateId, doc_id: docId, ext,
    })}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AGENT_SECRET}`,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `blob upload failed: HTTP ${res.status}` };
    return data;
  } catch (e) {
    return { error: `blob upload failed: ${e.message}` };
  }
}

async function downloadDocBytes({ username, candidateId, docId, ext }, { env = process.env, fetchImpl = fetch } = {}) {
  const gate = requireEnv(env);
  if (gate.error) throw new Error(gate.error);
  let res;
  try {
    res = await fetchImpl(`${gate.base}/internal/blob/download?${query({
      username, candidate_id: candidateId, doc_id: docId, ext,
    })}`, {
      headers: { Authorization: `Bearer ${env.AGENT_SECRET}` },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new Error(`blob download failed: ${e.message}`);
  }
  if (res.status === 404) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || 'BLOB_NOT_FOUND');
    err.code = 'BLOB_NOT_FOUND';
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `blob download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Идемпотентное удаление объекта; старое ядро (404 на роут) — понятная ошибка.
async function deleteDocBytes({ username, candidateId, docId, ext }, { env = process.env, fetchImpl = fetch } = {}) {
  const gate = requireEnv(env);
  if (gate.error) return gate;
  try {
    const res = await fetchImpl(`${gate.base}/internal/blob/delete?${query({
      username, candidate_id: candidateId, doc_id: docId, ext,
    })}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AGENT_SECRET}` },
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    // Роут существует → 200/400/500; 404 = core без этого роута (handleInternal не матчит)
    if (res.status === 404) return { error: 'ядро без /internal/blob/delete — обнови core' };
    if (!res.ok) return { error: data.error || `blob delete failed: HTTP ${res.status}` };
    return data;
  } catch (e) {
    return { error: `blob delete failed: ${e.message}` };
  }
}

module.exports = { coreBase, uploadDocBytes, downloadDocBytes, deleteDocBytes };
