#!/usr/bin/env node
import { detect } from './detector.js';
import type { DialectId } from './types.js';

function usage(): never {
  console.error(`Usage: llm-baseurl-detect <baseUrl> [options]

Options:
  --api-key <key>        API key sent with probes (Bearer / x-api-key)
  --model <id>           model id used in probe payloads
  --timeout <ms>         per-probe timeout (default 8000)
  --dialects <a,b,c>     restrict dialects (openai-chat,openai-responses,anthropic-messages,gemini-generate,typesafe-systemone)
  --models               also probe GET {base}/models (OpenAI model list)
  --json                 print raw JSON result
  -h, --help             show this help`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage();

let baseUrl: string | undefined;
let apiKey: string | undefined;
let model: string | undefined;
let timeoutMs: number | undefined;
let dialects: DialectId[] | undefined;
let probeModels = false;
let asJson = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case '--api-key':
      apiKey = args[++i];
      break;
    case '--model':
      model = args[++i];
      break;
    case '--timeout':
      timeoutMs = Number(args[++i]);
      break;
    case '--dialects':
      dialects = (args[++i] ?? '').split(',').map((s) => s.trim()) as DialectId[];
      break;
    case '--models':
      probeModels = true;
      break;
    case '--json':
      asJson = true;
      break;
    default:
      if (a.startsWith('--')) {
        console.error(`unknown option: ${a}`);
        usage();
      }
      if (baseUrl) {
        console.error('only one baseUrl argument is allowed');
        usage();
      }
      baseUrl = a;
  }
}
if (!baseUrl) usage();

const result = await detect(baseUrl, { apiKey, model, timeoutMs, dialects, probeModels });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Base URL: ${result.baseUrl}`);
  console.log('\nDialect probes:');
  for (const p of result.probes) {
    const status =
      p.status === 'supported' ? 'SUPPORTED' :
      p.status === 'likely' ? 'likely   ' :
      p.status === 'not-found' ? 'not-found' : 'unknown  ';
    console.log(`  [${status}] ${p.dialect.padEnd(20)} ${p.probedUrl}`);
    console.log(`             ${p.httpStatus ? `HTTP ${p.httpStatus} — ` : ''}${p.detail}`);
  }
  if (result.modelsList) {
    const m = result.modelsList;
    console.log(`\nModel list (GET ${result.baseUrl}/models): ${m.reachable ? 'reachable' : 'not reachable'}${m.httpStatus ? ` — HTTP ${m.httpStatus}` : ''} — ${m.detail}`);
    if (m.sampleModels?.length) console.log(`  sample: ${m.sampleModels.join(', ')}`);
  }
  const found = Object.entries(result.endpoints);
  console.log('\nDetected endpoints:');
  if (found.length === 0) console.log('  (none)');
  for (const [d, url] of found) console.log(`  ${d}: ${url}`);
  console.log(`\n(${result.durationMs}ms)`);
}
