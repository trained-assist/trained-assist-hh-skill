'use strict';

// Materialize mcp.manifest.json for the commit currently checked out. The
// pinned `revision` is a real, existing commit (a file cannot embed the SHA of
// the commit that contains it) — the L1 contract layer treats it as "the
// approved revision", not necessarily HEAD.
//
// Usage:
//   node scripts/build-mcp-manifest.cjs          # write mcp.manifest.json
//   node scripts/build-mcp-manifest.cjs --check  # fail if the file is stale
//   node scripts/build-mcp-manifest.cjs --revision <sha>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO_ROOT, buildConfig } = require('./mcp-artifact');

function currentRevision() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const revFlag = args.indexOf('--revision');

const file = path.join(REPO_ROOT, 'mcp.manifest.json');
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
// In --check mode keep the pinned revision: a file cannot embed the SHA of the
// commit that contains it, so the committed revision is an ancestor by design.
const revision = revFlag >= 0 ? args[revFlag + 1]
  : (check && existing) ? existing.sources[0].revision
    : currentRevision();

if (!/^[a-f0-9]{40}$/.test(String(revision))) {
  console.error('Cannot resolve a 40-hex revision (pass --revision <sha> outside a git checkout)');
  process.exit(2);
}

const next = JSON.stringify(buildConfig({ revision }), null, 2) + '\n';

if (check) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== next) {
    console.error('mcp.manifest.json is stale — run: node scripts/build-mcp-manifest.cjs');
    process.exit(1);
  }
  console.log('mcp.manifest.json is up to date');
} else {
  fs.writeFileSync(file, next);
  console.log(`wrote mcp.manifest.json (revision ${revision})`);
}
