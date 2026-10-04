'use strict';

// Which revision of THIS repo the running code came from.
//
// The agent host (trained-assist-agent) already does this for itself in
// src/release-info.js: it reads `.release-sha` from the release root and falls back
// to `git rev-parse HEAD`. The HH skill had no equivalent, so a stale skill checkout
// was invisible — the recruiter's pages kept being served from an old revision while
// the agent release looked current, and nothing reported the mismatch.
//
// Same resolution order as the host: an explicit `.release-sha` next to this file
// wins (a deploy that records it), else the git HEAD of the checkout the code was
// loaded from. In production the skill is reached through
// <release>/trained-assist-hh-skill -> the live checkout, and deploy.sh resets that
// checkout BEFORE restarting the service, so its HEAD is the revision actually served.

const fs = require('fs');
const path = require('path');

const SHA_RE = /^[0-9a-f]{40}$/;

function readReleaseFile() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', '.release-sha'), 'utf8').trim();
    if (v) return v;
  } catch {
    // not a release build
  }
  return null;
}

// Read git HEAD without spawning. src/ is forbidden from requiring child_process
// (tests/guards: quick-action tools never launch Claude), so the revision is parsed
// out of .git by hand. Covers the shapes that matter here: a normal checkout, a
// worktree/submodule (.git is a `gitdir:` file), a detached HEAD, loose refs and
// packed-refs. Anything unreadable yields '' — the caller then omits the marker
// rather than asserting a revision it cannot back up.
const SHA = /^[0-9a-f]{40}$/;

function gitDir(base) {
  const dot = path.join(base, '.git');
  try {
    // A worktree/submodule keeps .git as a `gitdir:` file; a normal checkout is a dir.
    if (fs.statSync(dot).isFile()) {
      const first = fs.readFileSync(dot, 'utf8').trim();
      if (first.startsWith('gitdir:')) return first.slice('gitdir:'.length).trim();
    }
    return dot;
  } catch {
    return null; // no .git at all
  }
}

function readPackedRef(dir, ref) {
  try {
    for (const line of fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n')) {
      const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
      if (m && m[2] === ref) return m[1];
    }
  } catch { /* no packed-refs */ }
  return null;
}

// A ref is looked for in the given dir, then — for a linked worktree, whose own
// gitdir holds only per-worktree refs — in the common dir its `commondir` file points
// at. Without this a worktree resolves to nothing and silently drops the marker.
function resolveRef(dir, ref) {
  try {
    const loose = fs.readFileSync(path.join(dir, ref), 'utf8').trim();
    if (SHA.test(loose)) return loose;
  } catch { /* packed, or not here */ }
  const packed = readPackedRef(dir, ref);
  if (packed) return packed;
  try {
    const common = fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim();
    return resolveRef(path.resolve(dir, common), ref);
  } catch {
    return null;
  }
}

// base defaults to the directory this module lives in; tests pass a fixture repo.
function readGitHead(base = path.join(__dirname, '..')) {
  const dir = gitDir(base);
  if (!dir) return '';
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;                       // detached HEAD
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return '';
    return resolveRef(dir, ref) || '';
  } catch {
    return '';
  }
}

// '' when the revision cannot be determined (no git, not a release). Callers must
// render that as unknown rather than guessing — a wrong SHA is worse than none.
function skillRevision() {
  return readReleaseFile() || readGitHead() || '';
}

function isSha(v) {
  return SHA_RE.test(String(v || ''));
}

// <meta> tag for the page <head>. Absent entirely when unknown: an empty content
// attribute would assert a revision the page cannot back up.
function revisionMetaTag() {
  const sha = skillRevision();
  return isSha(sha) ? `\n<meta name="hh-skill-rev" content="${sha}">` : '';
}

module.exports = { skillRevision, isSha, revisionMetaTag, readGitHead };
