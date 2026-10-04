'use strict';

// L3 — Guards: cross-origin calls must be answerable cross-origin.
//
// The recruiter's pages are served from the recruiter's own domain while CALLBACK_BASE
// points at AGENT_PUBLIC_URL, so every route a page fetch()es is a CROSS-ORIGIN request.
// The browser then discards any response without Access-Control-Allow-Origin — including
// a perfectly correct 200 — and the page sees `TypeError: Failed to fetch`.
//
// That is not hypothetical: GET /hh/message-instructions-template shipped without the
// header and «Вернуть общий шаблон» failed with exactly that message (#135). The same
// omission then sat live on POST /hh/response-state, which star/archive from the review
// page. Both were invisible to every other layer: the browser specs call the HTML
// generators directly and stub the endpoints with page.route(), so no test ever saw a
// real cross-origin response.
//
// This guard derives the call set from the page sources themselves instead of a
// hand-kept list, so a NEW cross-origin fetch cannot silently skip the header.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const ROUTES = path.join(SRC, 'hh-routes.js');

const routeSource = fs.readFileSync(ROUTES, 'utf8');

// Split the flat route table into per-route blocks. Each `if (req.method === …)` guard
// opens a block that ends where the next one starts.
function routeBlocks() {
  const starts = [...routeSource.matchAll(/\nif \(req\.method === '(GET|POST|OPTIONS)'[^\n]*?url\.pathname === '([^']+)'/g)];
  return starts.map((m, i) => {
    const from = m.index + 1;
    const to = i + 1 < starts.length ? starts[i + 1].index : routeSource.length;
    return { verb: m[1], path: m[2], body: routeSource.slice(from, to) };
  });
}

// Routes a page reaches cross-origin. Three source shapes, all absolute-origin fetches
// (never same-origin navigation — a plain <a href> or location.reload() to /hh/… needs
// no header):
//   CALLBACK_BASE + '/hh/…'                     editor / proactive pages
//   hhAction('/hh/…')                            review page
//   '${callbackBase}/hh/…'                       style page (server-side interpolation)
function crossOriginCallTargets() {
  const SHAPES = [
    /CALLBACK_BASE\s*\+\s*'(\/hh\/[a-z0-9-]+)'/g,
    /hhAction\(\s*'(\/hh\/[a-z0-9-]+)'/g,
    /'\$\{callbackBase\}(\/hh\/[a-z0-9-]+)'/g,
  ];
  const targets = new Map();
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('-html.js') || f === 'hh-nav.js')) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const shape of SHAPES) {
      for (const m of text.matchAll(shape)) {
        if (!targets.has(m[1])) targets.set(m[1], new Set());
        targets.get(m[1]).add(file);
      }
    }
  }
  return targets;
}

test('every cross-origin fetch target has a route that answers with CORS', () => {
  const blocks = routeBlocks();
  const missing = [];
  for (const [route, callers] of crossOriginCallTargets()) {
    const block = blocks.find(b => b.path === route && b.verb !== 'OPTIONS');
    if (!block) { missing.push(`${route} — fetched by ${[...callers].join(', ')} but no route serves it`); continue; }
    if (!/Access-Control-Allow-Origin/.test(block.body)) {
      missing.push(`${route} — fetched cross-origin by ${[...callers].join(', ')} but its route sets no Access-Control-Allow-Origin`);
    }
  }
  assert.deepEqual(missing, [], `\n${missing.join('\n')}\n`);
});

test('every cross-origin fetch target answers the CORS preflight', () => {
  const preflight = routeBlocks().find(b => b.verb === 'OPTIONS');
  assert.ok(preflight, 'the OPTIONS handler must exist');
  const missing = [];
  for (const route of crossOriginCallTargets().keys()) {
    if (!preflight.body.includes(`'${route}'`)) missing.push(`${route} — not in the OPTIONS allowlist`);
  }
  assert.deepEqual(missing, [], `\n${missing.join('\n')}\n`);
});

test('the guard actually finds cross-origin calls (it must not pass by seeing nothing)', () => {
  const targets = crossOriginCallTargets();
  assert.ok(targets.size >= 12, `expected the page sources to expose 12+ cross-origin targets, saw ${targets.size}`);
  assert.ok(targets.has('/hh/message-instructions-template'), 'the #135 regression route must be in the derived set');
});
