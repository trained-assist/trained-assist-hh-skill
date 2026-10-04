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
const { execSync } = require('child_process');

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

function readGitHead() {
  try {
    return execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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

module.exports = { skillRevision, isSha, revisionMetaTag };
