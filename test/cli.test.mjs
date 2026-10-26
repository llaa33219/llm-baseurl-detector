import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/chat/completions') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"auth"}');
      return;
    }
    res.writeHead(404);
    res.end('{"error":"nope"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

test('CLI prints human-readable report and exits 0', async () => {
  const { stdout } = await execFileP('node', [
    'dist/cli.js',
    `http://127.0.0.1:${port}/v1`,
    '--timeout', '3000',
    '--dialects', 'openai-chat,openai-responses',
  ]);
  assert.match(stdout, /Base URL:/);
  assert.match(stdout, /openai-chat/);
  assert.match(stdout, /likely/);
  assert.match(stdout, /not-found/);
});

test('CLI --json emits parseable JSON', async () => {
  const { stdout } = await execFileP('node', [
    'dist/cli.js',
    `http://127.0.0.1:${port}/v1`,
    '--timeout', '3000',
    '--dialects', 'openai-chat',
    '--json',
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.probes[0].dialect, 'openai-chat');
  assert.equal(parsed.probes[0].status, 'likely');
});
