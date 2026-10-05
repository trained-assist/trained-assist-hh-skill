// generateReviewHtml — callback URL embedded in generated page source.
// Ported from trained-assist-agent's tests/unit/hh-server-endpoints.test.js
// (issue #942 step 11a: main repo dropped its now-duplicate copy of 90-hh.js,
// this coverage moved here since it's this repo's file being asserted on).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join as pathJoin } from 'path';
import { fileURLToPath } from 'node:url';

describe('generateReviewHtml source — callback embedding', () => {
  const src = readFileSync(
    pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'mcp-skills', 'tools', '90-hh.js'),
    'utf8',
  );

  it('90-hh.js source embeds callbackBase/username/per-user page token (never the master secret)', () => {
    expect(src).toContain("const CALLBACK_BASE = '${callbackBase}';");
    expect(src).toContain("const HH_USER = '${username}';");
    expect(src).toContain("const HH_PAGE_TOKEN = '${pageToken}';");
    expect(src).not.toContain("'${agentSecret}'");
  });

  it('90-hh.js source calls /hh/send and /hh/reject endpoints', () => {
    expect(src).toContain("'/hh/send'");
    expect(src).toContain("'/hh/reject'");
    expect(src).toContain("token: HH_PAGE_TOKEN");
    expect(src).not.toContain('HH_SECRET');
  });

  // Changed requirement: the review page callback is a PAGE link, so it follows the
  // per-user publish domain (public page base), not AGENT_PUBLIC_URL read inline.
  // The old assertion pinned the literal env name and would have passed a
  // regression that fed the tenant domain into the server-to-server sync call.
  it('hh_draft_review_page passes callbackBase from the public page base', () => {
    expect(src).toContain('publicPageBase(USER_ID, HH_PAGES_ENV');
    expect(src).toContain('callbackBase');
    // …while the internal sync call stays on the internal base.
    expect(src).toContain('const agentBase = internalApiBase();');
  });
});

describe('review page — explicit single-candidate stale draft override', () => {
  const page = readFileSync(
    pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'hh-review-page-html.js'),
    'utf8',
  );

  it('keeps stale drafts individually sendable and confirms the exact manual override', () => {
    expect(page).toContain("sendOne(this,${i},'${esc(c.negotiation_id)}',false,this.dataset.stale==='1')");
    expect(page).toContain('if (forceStale && !window.confirm(');
    expect(page).toContain('force_stale: !!forceStale');
    expect(page).toContain("e.code === 'STALE_COMMUNICATION_DRAFT'");
    expect(page).toContain("send.dataset.stale = '0'");
    expect(page).toContain('error.code = data.code');
    expect(page).toContain('error.communication_stage = data.communication_stage');
    expect(page).toContain('error.request_id = data.request_id');
    expect(page).toContain('Не хватает подтверждённого контекста:');
    expect(page).not.toContain("c.draft_is_stale ? ' disabled title=");
  });

  it('keeps stale drafts score-selectable and requires confirmation before bulk override', () => {
    expect(page).toContain('data-stale="${c.draft_is_stale ? \'1\' : \'0\'}"');
    expect(page).toContain("У ' + staleWithMessage.length + ' выбранных кандидатов черновик помечен как устаревший");
    expect(page).toContain("force_stale: cb.dataset.stale === '1'");
    expect(page).toContain("if (bucket === n) cb.checked = activeBuckets.has(n)");
  });
});

// The re-send guard after a delivered message is a 15-second visible countdown on the
// send button (recruiter report 01.10: the card used to freeze grey with no way to tell
// a temporary block from a dead page). Pinned here so a test override in the browser
// suite can never quietly become the shipped value.
describe('generateReviewHtml source — re-send cooldown', () => {
  const src = readFileSync(
    pathJoin(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'hh-review-page-html.js'),
    'utf8',
  );

  it('ships a 15-second cooldown', () => {
    expect(src).toMatch(/const SEND_COOLDOWN_MS = 15000;/);
  });

  it('counts the cooldown down on the button instead of freezing the card', () => {
    expect(src).toContain('startSendCooldown');
    expect(src).toContain("btn.textContent = '✓ Отправлено · ' + left + 'с'");
    // No silent freeze: a sent card stays interactive (only .skipped is inert).
    expect(src).toMatch(/\.card\.done\{[^}]*opacity/);
    expect(src).not.toMatch(/\.card\.done\{[^}]*pointer-events:none/);
  });
});
