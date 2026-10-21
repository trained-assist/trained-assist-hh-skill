'use strict';

// Standalone HH worker (#187): the HTTP surface of the HH skill on a host that
// is not the retiring GCP VM.
//
// The skill's route table (src/hh-routes.js) was mounted by the agent's server.
// That server is not coming to this host, so the worker owns the listener and
// delegates the HH paths to the same route table with the same host contract
// (src/hh-worker-host.js). Everything outside the HH paths is not served here:
// the RU edge keeps the login and the vacancy pages, and the agent's own
// surfaces stay where they are.
//
// Routes:
//   /hh/*, /api/hh/*, /calltips-*  — the skill's public routes, then the
//                                      Bearer-gated ones (same order as the
//                                      agent's server);
//   /health                         — liveness plus the revision actually served;
//   /hh-worker/*                    — the worker's own admin API (Bearer-gated).

const http = require('http');
const { createHost } = require('./hh-worker-host');
const { createScheduleStore } = require('./hh-worker-schedule-store');
const { runTick } = require('./hh-worker-tick');
const { syncBoundCredentials } = require('./hh-worker-credentials');
const { skillRevision } = require('./hh-version');

// Same predicate as the agent's server: the HH domain and its call-tips
// siblings. A competing handler for one of these paths would shadow the skill.
const isHhPath = (pathname) => /^\/(?:(?:api\/)?hh\/|calltips-)/.test(pathname);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function createWorker({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const ctx = createHost({ env, fetchImpl, now });
  const store = createScheduleStore({ env, now });
  const { handleHhPublic, handleHhAuthed } = require('./hh-routes');

  const server = http.createServer(async (req, res) => {
    try {
      const raw = new URL(req.url, `http://127.0.0.1:${ctx.PORT}`);
      // The old host published the HH surface under /agent/hh/…; accept that
      // form too so a link written before the cutover keeps working.
      const pathname = raw.pathname.startsWith('/agent/') ? raw.pathname.slice('/agent'.length) : raw.pathname;
      const url = new URL(pathname + raw.search, `http://127.0.0.1:${ctx.PORT}`);

      // A recruiter re-login rotates the credential; the bound copy follows it.
      syncBoundCredentials({ env });

      if (pathname === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'hh-worker',
          revision: skillRevision(),
          scheduler: store.stats(),
        });
      }

      if (pathname.startsWith('/hh-worker/')) {
        const auth = req.headers['authorization'] || '';
        if (!ctx.secrets.AGENT_SECRET || auth !== `Bearer ${ctx.secrets.AGENT_SECRET}`) {
          return json(res, 401, { error: 'unauthorized' });
        }
        if (pathname === '/hh-worker/jobs' && req.method === 'GET') {
          return json(res, 200, store.list({ profileId: url.searchParams.get('profile_id') || '' }));
        }
        if (pathname === '/hh-worker/occurrences' && req.method === 'GET') {
          const state = store.read();
          const occurrences = Object.values(state.occurrences)
            .sort((a, b) => (a.scheduled_at < b.scheduled_at ? 1 : -1))
            .slice(0, 100);
          return json(res, 200, { occurrences });
        }
        if (pathname === '/hh-worker/jobs' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (body.op === 'delete') return json(res, 200, store.remove({ profileId: body.profile_id, name: body.name }));
          if (body.op === 'upsert') {
            return json(res, 200, { job: store.upsert({
              profileId: body.profile_id,
              name: body.name,
              action: body.action,
              schedule: body.schedule,
              timezone: body.timezone,
              arguments: body.arguments,
              enabled: body.enabled,
            }) });
          }
          return json(res, 400, { error: 'unknown op' });
        }
        if (pathname === '/hh-worker/tick' && req.method === 'POST') {
          return json(res, 200, await runTick({ env, store, now }));
        }
        return json(res, 404, { error: 'not found' });
      }

      if (isHhPath(pathname)) {
        const handled = await handleHhPublic(req, url, res, { ...ctx, secrets: ctx.secrets });
        if (handled !== false) return undefined;
        const auth = req.headers['authorization'] || '';
        if (!ctx.secrets.AGENT_SECRET || auth !== `Bearer ${ctx.secrets.AGENT_SECRET}`) {
          return json(res, 401, { error: 'unauthorized' });
        }
        const authed = await handleHhAuthed(req, url, res, { ...ctx, secrets: ctx.secrets });
        if (authed !== false) return undefined;
        return json(res, 404, { error: 'not found' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error('[hh-worker] request failed:', error.message);
      if (!res.headersSent) return json(res, 500, { error: 'internal error' });
      return res.end();
    }
  });

  return { server, ctx, store };
}

module.exports = { createWorker, isHhPath };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8091;
  const host = process.env.HH_WORKER_HOST || '127.0.0.1';
  const { server } = createWorker();
  server.listen(port, host, () => {
    console.log(`[hh-worker] listening on ${host}:${port} rev=${skillRevision()}`);
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref?.(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
