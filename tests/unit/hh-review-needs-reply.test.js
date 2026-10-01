// Regression tests for the /hh/review tab classification («Неотвеченные» / «Молчат»).
//
// Bug: needs_reply treated `counters.messages <= 1` as "the candidate's cover
// letter only, we never wrote" and short-circuited BEFORE looking at the local
// history. HH counts only real chat messages there (the cover letter is not
// counted), so a candidate we had already answered reported messages=1 and landed
// in «Неотвеченные» forever — even though we were the ones waiting for a reply.
// Live case (30.09, vacancy 137012564): Родченко Александр, we sent one message,
// HH counters.messages=1, page showed him as «Неотвеченные» instead of «Молчат».

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateReviewPageHtml } = require('../../src/hh-review-page-html');

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hh-needs-reply-'));

// Writes local history the way syncHhMessagesToHistory does: only messages HH
// confirmed (hh_id present), one entry per delivered message.
function seedHistory(root, username, negId, messages) {
  const candDir = path.join(root, 'hh', username, 'candidates');
  fs.mkdirSync(candDir, { recursive: true });
  fs.writeFileSync(path.join(candDir, `${negId}.json`), JSON.stringify({
    messages,
    ats_result: null,
    last_hh_message_at: Date.parse('2026-09-30T14:30:53+03:00'),
  }));
}

const neg = (over = {}) => ({
  id: '5616135821',
  created_at: '2026-09-30T14:09:32+03:00',
  updated_at: '2026-09-30T14:30:53+03:00',
  counters: { unread_messages: 0, messages: 1 },
  has_updates: false,
  resume: { first_name: 'Александр', last_name: 'Родченко', title: 'Финансовый советник' },
  _state: 'consider',
  ...over,
});

const render = (root, username, negotiations) =>
  generateReviewPageHtml(negotiations, 'Финансовый советник', username, '', root, { vacancyId: '137012564' });

const cardCount = (html, tab) => {
  const panel = html.slice(html.indexOf(`id="tab-${tab}"`));
  const end = panel.indexOf('<div id="tab-');
  const body = end === -1 ? panel : panel.slice(0, end);
  return (body.match(/class="card"/g) || []).length;
};

describe('review page: candidate we already answered is «Молчат», not «Неотвеченные»', () => {
  it('one message in HH = our own message, not an unanswered cover letter', () => {
    const root = mkTmp();
    const username = 'needs-reply-u1';
    seedHistory(root, username, '5616135821', [
      { hh_id: '15678813198', role: 'employer', text: 'Здравствуйте, Александр!', timestamp: '2026-09-30T14:30:53+03:00' },
    ]);
    try {
      const html = render(root, username, [neg()]);
      expect(cardCount(html, 'waiting')).toBe(0);
      expect(cardCount(html, 'silent')).toBe(1);
      expect(html).toContain('Родченко');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the candidate replying last puts them back into «Неотвеченные»', () => {
    const root = mkTmp();
    const username = 'needs-reply-u2';
    seedHistory(root, username, '5616135821', [
      { hh_id: '15678813198', role: 'employer', text: 'Здравствуйте, Александр!', timestamp: '2026-09-30T14:30:53+03:00' },
      { hh_id: '15678814000', role: 'applicant', text: 'здравствуйте', timestamp: '2026-09-30T15:02:00+03:00' },
    ]);
    try {
      const html = render(root, username, [neg({ counters: { unread_messages: 0, messages: 2 } })]);
      expect(cardCount(html, 'waiting')).toBe(1);
      expect(cardCount(html, 'silent')).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a fresh response with no chat at all still needs an answer', () => {
    const root = mkTmp();
    const username = 'needs-reply-u3';
    try {
      const html = render(root, username, [neg({
        id: '5617225520',
        counters: { unread_messages: 0, messages: 0 },
        has_updates: true,
        resume: { first_name: 'Татьяна', last_name: 'Майскова', title: 'Финансовый советник' },
      })]);
      expect(cardCount(html, 'waiting')).toBe(1);
      expect(cardCount(html, 'nocontact')).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unread message wins over any local history', () => {
    const root = mkTmp();
    const username = 'needs-reply-u4';
    seedHistory(root, username, '5616135821', [
      { hh_id: '15678813198', role: 'employer', text: 'Здравствуйте, Александр!', timestamp: '2026-09-30T14:30:53+03:00' },
    ]);
    try {
      const html = render(root, username, [neg({ counters: { unread_messages: 1, messages: 2 } })]);
      expect(cardCount(html, 'waiting')).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('HH knows about more messages than we stored → history is stale, recruiter looks', () => {
    const root = mkTmp();
    const username = 'needs-reply-u5';
    seedHistory(root, username, '5616135821', [
      { hh_id: '15678813198', role: 'employer', text: 'Здравствуйте, Александр!', timestamp: '2026-09-30T14:30:53+03:00' },
    ]);
    try {
      // counters.messages=2 (HH side is ahead), local history still holds our message
      // only → we cannot know who spoke last, so it must not be filed as «Молчат».
      const html = render(root, username, [neg({ counters: { unread_messages: 0, messages: 2 } })]);
      expect(cardCount(html, 'waiting')).toBe(1);
      expect(cardCount(html, 'silent')).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});