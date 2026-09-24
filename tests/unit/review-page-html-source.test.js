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

  it('90-hh.js source embeds callbackBase/username/agentSecret template vars', () => {
    expect(src).toContain("const CALLBACK_BASE = '${callbackBase}';");
    expect(src).toContain("const HH_USER = '${username}';");
    expect(src).toContain("const HH_SECRET = '${agentSecret}';");
  });

  it('90-hh.js source calls /hh/send and /hh/reject endpoints', () => {
    expect(src).toContain("'/hh/send'");
    expect(src).toContain("'/hh/reject'");
    expect(src).toContain("'Authorization': 'Bearer ' + HH_SECRET");
  });

  it('hh_draft_review_page passes callbackBase from resolveHhPublicBase (Cold Search Stage 4: single resolver, no more inline AGENT_PUBLIC_URL reads)', () => {
    expect(src).toContain('resolveHhPublicBase');
    expect(src).toContain('callbackBase');
    // The old inline `process.env.AGENT_PUBLIC_URL || '<default>'` pattern must be
    // gone from this file — resolveHhPublicBase (src/hh-quick.js) is now the only
    // place that reads it, so a per-username override file can take precedence.
    expect(src).not.toContain('process.env.AGENT_PUBLIC_URL');
  });
});
