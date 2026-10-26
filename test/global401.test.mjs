import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { detect } from '../dist/index.js';

// Simulates a provider with a GLOBAL auth middleware: every path answers 401,
// even ones that do not exist. Only /v1/chat/completions is real.
let server;
let base;
let hits;

before(async () => {
  hits = [];
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${new URL(req.url, 'http://x').pathname}`);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

test('keyed probe against global-auth host stops at primary candidate', async () => {
  const r = await detect(base, { apiKey: 'k', dialects: ['openai-chat'] });
  const chat = r.probes.find((p) => p.dialect === 'openai-chat');
  assert.equal(chat.probedUrl, `${base}/chat/completions`);
  // early-exit: only the primary candidate should have been hit for this dialect
  const chatHits = hits.filter((h) => h.includes('chat/completions'));
  assert.equal(chatHits.length, 1);
});
