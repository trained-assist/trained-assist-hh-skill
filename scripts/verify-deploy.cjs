'use strict';

// Post-deploy gate: prove the hub is serving the revision you meant to deploy.
//
// The failure this exists for is silent and was expensive. deploy.sh defaults its target
// to `git rev-parse HEAD`, so a checkout left on a stale branch deploys that branch while
// the release notes say "deployed main". Nothing compared the two. The recruiter's pages
// then came from an old skill revision and the only symptom was a broken button.
//
// The pages now carry <meta name="hh-skill-rev"> (src/hh-version.js), so the served
// revision is observable. This script compares it against the commit you intended and
// exits non-zero on a mismatch — run it immediately after deploy.sh.
//
// Usage:
//   node scripts/verify-deploy.cjs --rev <full-sha> \
//     [--base https://136-65-7-197.sslip.io/agent] [--user u] [--token t]
//
// Env equivalents: DEPLOY_EXPECT_REV, HH_HUB_BASE, HH_HUB_USER, HH_HUB_TOKEN.
// --rev also accepts `origin/main` / `main` and resolves it against the local checkout.

const fs = require('node:fs');
const path = require('node:path');

function arg(name, env) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] || '';
}

const SHA = /^[0-9a-f]{40}$/;

// Resolve a symbolic target to a full SHA using the local checkout. No spawning: the
// same .git shapes as src/hh-version.js, because a deploy box may be a worktree.
function resolveTarget(target) {
  if (SHA.test(target)) return target;
  const ref = target.trim();
  const base = path.resolve(__dirname, '..');
  const read = p => fs.readFileSync(p, 'utf8').trim();
  try {
    const dot = path.join(base, '.git');
    const dir = fs.statSync(dot).isFile()
      ? read(dot).replace(/^gitdir:\s*/, '')
      : dot;
    const head = read(path.join(dir, 'HEAD'));
    if (SHA.test(head)) return head;
    const want = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!want) return '';
    const loose = path.join(dir, want);
    if (fs.existsSync(loose) && SHA.test(read(loose))) return read(loose);
    for (const line of read(path.join(dir, 'packed-refs')).split('\n')) {
      const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
      if (m && m[2] === ref) return m[1];
    }
  } catch { /* not resolvable locally */ }
  return '';
}

async function main() {
  const target = arg('rev', 'DEPLOY_EXPECT_REV');
  const base = (arg('base', 'HH_HUB_BASE') || 'http://localhost:8080').replace(/\/$/, '');
  const user = arg('user', 'HH_HUB_USER');
  const token = arg('token', 'HH_HUB_TOKEN');

  if (!target) {
    console.error('verify-deploy: нужен --rev <sha|origin/main> (или DEPLOY_EXPECT_REV)');
    process.exit(2);
  }
  if (!user || !token) {
    console.error('verify-deploy: нужны --user и --token (или HH_HUB_USER / HH_HUB_TOKEN)');
    process.exit(2);
  }

  const expected = resolveTarget(target);
  if (!expected) {
    console.error(`verify-deploy: не удалось разрешить цель «${target}» в SHA (нужен локальный чекаут)`);
    process.exit(2);
  }

  const url = `${base}/hh/ats-editor?${new URLSearchParams({ username: user, token, vacancy_id: '0' })}`;
  let html;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    html = await res.text();
    if (res.status !== 200) {
      console.error(`verify-deploy: страница отдаёт HTTP ${res.status} — проверь base/токен`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`verify-deploy: не достучаться до ${base} (${e.message})`);
    process.exit(2);
  }

  const m = html.match(/<meta name="hh-skill-rev" content="([0-9a-f]{40})">/);
  const short = h => h.slice(0, 12);

  if (!m) {
    console.error('verify-deploy: ✗ на странице нет <meta name="hh-skill-rev">');
    console.error('  Прод отдаётся не из этого репозитория, либо ревизию не удалось определить.');
    console.error('  Цель: ' + short(expected));
    process.exit(1);
  }
  if (m[1] !== expected) {
    console.error(`verify-deploy: ✗ расхождение ревизий`);
    console.error(`  отдаётся : ${m[1]}`);
    console.error(`  цель     : ${expected}`);
    console.error('  Прод отдаёт не тот коммит. Проверь, что deploy.sh запущен с');
    console.error('  DEPLOY_TARGET_COMMIT=$(git rev-parse origin/main), а не с HEAD устаревшей ветки.');
    process.exit(1);
  }

  console.log(`verify-deploy: ✓ прод отдаёт ${short(m[1])} — совпадает с целью ${short(expected)}`);
}

main().catch(e => { console.error('verify-deploy:', e.message); process.exit(2); });
