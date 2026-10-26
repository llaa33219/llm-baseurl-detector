import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { detect } from '../dist/index.js';

/**
 * Mock provider server:
 *  - /v1/chat/completions        -> 401 without auth, 400 model-error with auth
 *  - /v1/responses               -> 404 plain (no such route)
 *  - /anthropic/v1/messages      -> 401 without auth (anthropic-style mount)
 *  - /spa-only                   -> 200 HTML fallback for ANY path under /spa-only
 */
let server;
let base;

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const authed = req.headers.authorization === 'Bearer good-key' || req.headers['x-api-key'] === 'good-key';

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!authed) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing bearer token' } }));
        return;
      }
      const body = JSON.parse(await readBody(req));
      if (body.model !== 'test-model') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-mock', choices: [] }));
      return;
    }

    if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
      return;
    }

    if (url.pathname.startsWith('/spa-only')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>app</body></html>');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

test('detects openai-chat as supported with correct key + model', async () => {
  const r = await detect(base, { apiKey: 'good-key', model: 'test-model' });
  const chat = r.probes.find((p) => p.dialect === 'openai-chat');
  assert.equal(chat.status, 'supported');
  assert.equal(chat.httpStatus, 200);
  assert.equal(r.endpoints['openai-chat'], `${base}/chat/completions`);
});

test('detects auth wall as likely without apiKey', async () => {
  const r = await detect(base, { dialects: ['openai-chat'] });
  const chat = r.probes.find((p) => p.dialect === 'openai-chat');
  assert.equal(chat.status, 'likely');
  assert.equal(chat.httpStatus, 401);
});

test('model-hint 400 with wrong model is likely', async () => {
  const r = await detect(base, { apiKey: 'good-key', dialects: ['openai-chat'] });
  const chat = r.probes.find((p) => p.dialect === 'openai-chat');
  assert.equal(chat.status, 'likely');
  assert.ok(chat.signals.includes('model-hint'));
});

test('plain 404 is not-found for responses dialect', async () => {
  const r = await detect(base, { apiKey: 'good-key', dialects: ['openai-responses'] });
  const resp = r.probes.find((p) => p.dialect === 'openai-responses');
  assert.equal(resp.status, 'not-found');
  assert.ok(!('openai-responses' in r.endpoints));
});

test('finds anthropic dialect mounted at sibling /anthropic path', async () => {
  const r = await detect(base, { dialects: ['anthropic-messages'] });
  const a = r.probes.find((p) => p.dialect === 'anthropic-messages');
  assert.equal(a.status, 'supported'); // dialect-shaped anthropic error envelope at the auth wall
  assert.ok(a.probedUrl.includes('/anthropic'), `expected anthropic mount, got ${a.probedUrl}`);
});

test('SPA fallback 200 HTML is not mistaken for a real endpoint', async () => {
  const r = await detect(`http://127.0.0.1:${server.address().port}/spa-only`, { dialects: ['openai-chat'] });
  assert.equal(r.probes[0].status, 'unknown');
  assert.ok(r.probes[0].signals.includes('catch-all-suspected'));
  assert.ok(!('openai-chat' in r.endpoints));
});

test('rejects non-http input', async () => {
  await assert.rejects(() => detect('not-a-url'), /absolute http/);
});




test('dialect-shaped 401 envelope upgrades anthropic to supported', async () => {
  const anthropicServer = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'x-api-key header is required' },
      request_id: 'req_mock' }));
  });
  await new Promise((r) => anthropicServer.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${anthropicServer.address().port}/v1`;
    const r = await detect(u, { dialects: ['anthropic-messages'] });
    assert.equal(r.probes[0].status, 'supported');
    assert.ok(r.probes[0].signals.includes('error-shape-match'));
  } finally {
    anthropicServer.close();
  }
});

test('generic 401 envelope stays likely for anthropic', async () => {
  const generic = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"unauthorized"}}');
  });
  await new Promise((r) => generic.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${generic.address().port}/v1`;
    const r = await detect(u, { dialects: ['anthropic-messages'] });
    assert.equal(r.probes[0].status, 'likely');
  } finally {
    generic.close();
  }
});

test('keyless global-auth: anthropic dialect finds its sibling mount via error shape', async () => {
  // mimics api.minimax.io: global 401 everywhere EXCEPT /anthropic/* which answers
  // with the anthropic error envelope (401 + type:error) and /v1/chat/completions
  // which answers a generic openai-ish 401.
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/anthropic')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'login fail' } }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"unauthorized"}}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['anthropic-messages'] });
    assert.equal(r.probes[0].status, 'supported');
    assert.ok(r.probes[0].probedUrl.startsWith(`http://127.0.0.1:${srv.address().port}/anthropic`),
      `expected anthropic mount to win, got ${r.probes[0].probedUrl}`);
  } finally {
    srv.close();
  }
});

test('typesafe: {detail} auth envelope upgrades to supported; success shape verified', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const authed = req.headers.authorization === 'Bearer ts-key';
    if (path === '/v1/systemone' && req.method === 'POST') {
      if (!authed) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: { error_type: 'authentication_error', message: 'Must supply an API key!' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-latest',
        answers: { echo: { type: 'noul', noul: 0.98 } },
        usage: { input_tokens: 120, output_tokens: 12 } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not Found' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${srv.address().port}`;
  try {
    // keyless: 401 with {detail} envelope -> supported
    const r1 = await detect(u, { dialects: ['typesafe-systemone'] });
    assert.equal(r1.probes[0].status, 'supported');
    assert.equal(r1.probes[0].probedUrl, `${u}/v1/systemone`);
    // keyed: 200 with {model, answers, usage.input_tokens} -> supported
    const r2 = await detect(u, { apiKey: 'ts-key', dialects: ['typesafe-systemone'] });
    assert.equal(r2.probes[0].status, 'supported');
  } finally {
    srv.close();
  }
});

test('responses: reasoning-only output (minimax-style partial) is supported', async () => {
  const srv = http.createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // real capture: reasoning model hit max_output_tokens before any message item
      res.end(JSON.stringify({
        id: 'resp_x', object: 'response', status: 'incomplete',
        output: [{ type: 'reasoning', summary: [] }], output_text: null,
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 203, output_tokens: 16, total_tokens: 219 } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await detect(`http://127.0.0.1:${srv.address().port}/v1`, {
      dialects: ['openai-responses'] });
    assert.equal(r.probes[0].status, 'supported');
  } finally {
    srv.close();
  }
});

test('chat: minimax-style base_resp wrapper accepted as openai-chat', async () => {
  const srv = http.createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', model: 'MiniMax-M3.1-Flash',
        choices: [{ finish_reason: 'length', index: 0, message: { content: '', role: 'assistant' } }],
        base_resp: { status_code: 0, status_msg: '' } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await detect(`http://127.0.0.1:${srv.address().port}/v1`, {
      dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'supported');
  } finally {
    srv.close();
  }
});

test('path-echo 404 (spring-style) is NOT a model-hint', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        timestamp: '2026-10-25', status: 404, error: 'Not Found',
        path: '/v4/v1beta/models/x:generateContent', // mentions "models" -> naive sniff would upgrade
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await detect(`http://127.0.0.1:${srv.address().port}/v1`, {
      dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'not-found');
  } finally {
    srv.close();
  }
});

test('generic-envelope 400 is unknown, dialect-shaped 400 is likely', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/v1/chat/completions') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 500, msg: '系统异常', success: false } }));
      return;
    }
    if (path === '/v1/models/gemini-2.5-flash:generateContent') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, message: '...', status: 'INVALID_ARGUMENT' } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    const chat = (await detect(u, { dialects: ['openai-chat'] })).probes[0];
    assert.equal(chat.status, 'unknown');
    const gemini = (await detect(u, { dialects: ['gemini-generate'] })).probes[0];
    assert.equal(gemini.status, 'likely');
    assert.ok(gemini.signals.includes('error-shape-match'));
  } finally {
    srv.close();
  }
});

test('probeModels: OpenAI-shaped list is parsed, sample models returned', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-a', object: 'model', created: 1, owned_by: 'x' },
          { id: 'gpt-b', object: 'model', created: 1, owned_by: 'x' },
        ] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'], probeModels: true });
    assert.equal(r.modelsList?.reachable, true);
    assert.deepEqual(r.modelsList?.sampleModels, ['gpt-a', 'gpt-b']);
    // default off
    const r2 = await detect(u, { dialects: ['openai-chat'] });
    assert.equal(r2.modelsList, undefined);
  } finally {
    srv.close();
  }
});

test('fingerprint probe: validate-before-auth upgrades generic 401 to supported', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* fallthrough */ }
        // validate-first provider: missing `messages` -> 400 even without auth
        if (parsed && !('messages' in parsed)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Field required', type: 'invalid_request_error', param: 'messages', code: 400 } }));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing api key', type: 'authentication_error', code: 401 } }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'supported');
    assert.ok(r.probes[0].signals.includes('validate-before-auth'));
    // disabling fingerprint probes falls back to likely
    const r2 = await detect(u, { dialects: ['openai-chat'], fingerprintProbes: false });
    assert.equal(r2.probes[0].status, 'likely');
  } finally {
    srv.close();
  }
});

test('fingerprint probe: auth-first provider (same 401 for broken body) stays likely', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'missing api key', type: 'authentication_error', code: 401 } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'likely');
  } finally {
    srv.close();
  }
});

test('probeModels: truncated/large list salvages leading model ids', async () => {
  // 126KB+ list, no top-level object field (novita-style)
  const big = { data: Array.from({ length: 500 }, (_, i) => ({ id: `novita/model-${i}`, object: 'model', created: 1, owned_by: 'x', pricing: { a: 1, b: 2 } })) };
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(big));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'], probeModels: true });
    assert.equal(r.modelsList?.reachable, true);
    assert.ok((r.modelsList?.sampleModels?.length ?? 0) > 0);
    assert.equal(r.modelsList?.sampleModels?.[0], 'novita/model-0');
  } finally {
    srv.close();
  }
});


test('fingerprint: same-status body change with field-level validation upgrades to supported', async () => {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* fallthrough */ }
        if (parsed && !('messages' in parsed)) {
          // same 401 status, but body now mentions the missing field (xai/engy style)
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Field required', type: 'invalid_request_error', param: 'messages', code: 401 } }));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing api key', type: 'authentication_error', code: 401 } }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'supported');
    assert.ok(r.probes[0].signals.includes('fingerprint-confirmed'));
  } finally {
    srv.close();
  }
});

test('fingerprint: same-status request_id-only diff does NOT upgrade', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    res.writeHead(401, { 'content-type': 'application/json' });
    // body differs only by request_id each call
    res.end(JSON.stringify({ error: { message: 'missing api key', request_id: `req_${n}` } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const r = await detect(u, { dialects: ['openai-chat'] });
    assert.equal(r.probes[0].status, 'likely');
  } finally {
    srv.close();
  }
});
