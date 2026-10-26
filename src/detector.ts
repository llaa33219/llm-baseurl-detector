/** Extract hostname safely; undefined for unparseable input. */
function hostOf(u: string): string | undefined {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
import { buildProbeResult, sendProbe, type ProbeRequest } from './probe.js';
import type {
  DetectionResult,
  DetectOptions,
  DialectId,
  DialectProbe,
  ProbeStatus,
} from './types.js';

const ALL_DIALECTS: DialectId[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini-generate',
  'typesafe-systemone',
];

const DEFAULT_MODELS: Record<DialectId, string> = {
  'openai-chat': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o-mini',
  // claude-haiku-5-5 is the current-generation id (2026); haiku-4-5 nears retirement
  'anthropic-messages': 'claude-haiku-5-5',
  'gemini-generate': 'gemini-2.5-flash',
  'typesafe-systemone': 'jev-latest',
};

/** Path layouts worth probing for a given input base, derived from the provider DB. */
function candidateUrls(
  inputBase: string,
  dialect: DialectId,
  model: string,
): string[] {
  const base = inputBase.replace(/\/+$/, '');
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  switch (dialect) {
    case 'openai-chat':
      push(`${base}/chat/completions`);
      // observed in the wild: some hosts mount openai surface under /openai
      push(`${base}/openai/chat/completions`);
      push(`${base}/openai/v1/chat/completions`);
      break;
    case 'openai-responses':
      push(`${base}/responses`);
      push(`${base}/openai/responses`);
      push(`${base}/openai/v1/responses`);
      break;
    case 'anthropic-messages':
      push(`${base}/v1/messages`); // anthropic-style base without /v1
      push(`${base}/messages`); // base already includes /v1
      push(`${base}/anthropic/v1/messages`); // providers that mount anthropic under /anthropic
      break;
    case 'gemini-generate':
      push(`${base}/models/${model}:generateContent`);
      push(`${base}/v1beta/models/${model}:generateContent`);
      push(`${base}/v1/models/${model}:generateContent`);
      break;
    case 'typesafe-systemone':
      push(`${base}/v1/systemone`);
      push(`${base}/systemone`);
      break;
  }
  // common alternate mount points seen across providers
  for (const b of alternateBases(base)) {
    switch (dialect) {
      case 'openai-chat':
        push(`${b}/chat/completions`);
        break;
      case 'openai-responses':
        push(`${b}/responses`);
        break;
      case 'anthropic-messages':
        push(`${b}/v1/messages`);
        push(`${b}/messages`);
        break;
      case 'gemini-generate':
        push(`${b}/models/${model}:generateContent`);
        break;
      case 'typesafe-systemone':
        push(`${b}/v1/systemone`);
        break;
    }
  }
  return urls;
}

/**
 * Sibling mount points to try in addition to the given base itself.
 * Pattern alternates derived from the input base.
 * (e.g. zhipu serves chat at /api/paas/v4, responses at /api/v1, anthropic at
 * /api/anthropic — pattern alternates alone never find those).
 */
function alternateBases(base: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u !== base && !out.includes(u)) out.push(u);
  };
  const bare = base.replace(/\/(v1|v2|v3|openai|anthropic|api\/v1|api\/paas\/v4|compatible-mode\/v1)$/, '');
  if (bare !== base) {
    push(bare);
    push(`${bare}/anthropic`);
    push(`${bare}/api/v1`);
    push(`${bare}/openai`);
    push(`${bare}/v1`);
  } else {
    push(`${base}/v1`);
    push(`${base}/v2`);
    push(`${base}/anthropic`);
    push(`${base}/api/v1`);
    push(`${base}/openai`);
  }
  return out;
}

function buildRequest(
  dialect: DialectId,
  url: string,
  model: string,
  apiKey: string | undefined,
  extraHeaders: Record<string, string> | undefined,
  fingerprint = false,
): ProbeRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'llm-baseurl-detector/0.1',
    ...(extraHeaders ?? {}),
  };
  if (apiKey) {
    if (dialect === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['authorization'] = `Bearer ${apiKey}`;
    } else if (dialect === 'gemini-generate') {
      headers['authorization'] = `Bearer ${apiKey}`;
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers['authorization'] = `Bearer ${apiKey}`;
    }
  }
  if (dialect === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
  }
  let body: string | undefined;
  switch (dialect) {
    case 'openai-chat':
      body = fingerprint
        ? JSON.stringify({ model }) // omit `messages`: auth-first providers 401,
        // validate-first providers answer 400 {param:"messages"} — revealing the dialect
        : JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          });
      break;
    case 'openai-responses':
      body = fingerprint
        ? JSON.stringify({ model }) // omit `input`
        : JSON.stringify({ model, input: 'ping', max_output_tokens: 64 });
      break;
    case 'anthropic-messages':
      body = fingerprint
        ? JSON.stringify({ model, max_tokens: 1 }) // omit `messages`
        : JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          });
      break;
    case 'gemini-generate':
      body = fingerprint
        ? JSON.stringify({}) // omit `contents`
        : JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] });
      break;
    case 'typesafe-systemone':
      // real System One wire format (verified against api.typesafe.ai openapi 0.2.0):
      // {model, state, questions} — no messages/input/max_tokens
      body = JSON.stringify({
        model,
        state: 'ping',
        questions: { echo: { type: 'noul', instructions: 'Reply to the ping.' } },
      });
      break;
  }
  return { url, method: 'POST', headers, body };
}

/**
 * Does a 2xx body actually look like this dialect's response?
 * Guards against SPA fallbacks / echo proxies answering 200 for any path.
 */
export function verifyDialectBody(dialect: DialectId, snippet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snippet);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  switch (dialect) {
    case 'openai-chat':
      return (
        o.object === 'chat.completion' ||
        Array.isArray(o.choices) ||
        // minimax-style: openai-compatible surface that still wraps in its native
        // {id, model, base_resp} envelope
        ('base_resp' in o && typeof o.model === 'string')
      );
    case 'openai-responses': {
      // wire shape (spec): object:"response" + output[] + status. output_text is an
      // SDK-only convenience property — do NOT rely on it.
      if (o.object === 'response') return true;
      if (Array.isArray(o.output) && typeof o.status === 'string') return true;
      // minimax-style partial: reasoning models with tiny max_output_tokens can return
      // output:[] with only reasoning — no message item, no output_text. The dialect
      // is still Responses if status + usage.input_tokens are present.
      const usage = o.usage as Record<string, unknown> | undefined;
      return (
        typeof o.status === 'string' &&
        'incomplete_details' in o &&
        typeof usage === 'object' &&
        usage !== null &&
        'input_tokens' in usage
      );
    }
    case 'anthropic-messages':
      return o.type === 'message' || (typeof o.role === 'string' && 'content' in o);
    case 'gemini-generate':
      // native GenerateContentResponse: candidates[] (+ usageMetadata/modelVersion/responseId).
      // note: prompt-blocked responses have NO candidates (promptFeedback.blockReason instead).
      return (
        'candidates' in o ||
        'modelVersion' in o ||
        'responseId' in o ||
        'usageMetadata' in o
      );
    case 'typesafe-systemone': {
      // SystemOneResponse: exactly {model, answers, usage:{input_tokens, output_tokens}}
      const usage = o.usage as Record<string, unknown> | undefined;
      return (
        'answers' in o &&
        typeof o.model === 'string' &&
        typeof usage === 'object' &&
        usage !== null &&
        'input_tokens' in usage
      );
    }
  }
}

/**
 * Does an ERROR body look like this dialect's error envelope?
 * Strong discriminator at auth walls: Anthropic-compatible surfaces always answer
 * {"type":"error","error":{"type":...}} — even for nonexistent routes — so seeing
 * that shape means the dialect is really implemented, not just globally auth-gated.
 */
export function verifyDialectErrorBody(dialect: DialectId, snippet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snippet);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  switch (dialect) {
    case 'anthropic-messages': {
      const err = o.error as Record<string, unknown> | undefined;
      if (!(o.type === 'error' && typeof err === 'object' && err !== null && typeof err.type === 'string')) {
        return false;
      }
      // Restrict to Anthropic's documented error.type vocabulary. Providers like
      // minimax emit the same outer {type:error,error:{type}} envelope with a
      // provider-specific type ("authorized_error") on NON-anthropic routes — that
      // is not an anthropic dialect signal. Anthropic's own types (docs.claude.com
      // /en/api/errors): authentication_error, invalid_request_error, not_found_error,
      // permission_error, rate_limit_error, overloaded_error, api_error, billing_error,
      // timeout_error. Third-party anthropic-compatible surfaces reuse these.
      const t = String(err.type);
      return /^(authentication|invalid_request|not_found|permission|rate_limit|overloaded|api|billing|timeout|request_too_large|conflict)_error$/.test(t);
    }
    case 'openai-chat':
    case 'openai-responses': {
      // {error: {message, type, ...}} — shared by chat/responses; weaker than the
      // anthropic envelope, so NOT used to upgrade auth walls to supported.
      const err = o.error as Record<string, unknown> | undefined;
      return typeof err === 'object' && err !== null && typeof err.message === 'string';
    }
    case 'gemini-generate': {
      // google.rpc envelope: {error: {code: number, message, status: UPPER_SNAKE}}
      const err = o.error as Record<string, unknown> | undefined;
      return (
        typeof err === 'object' &&
        err !== null &&
        typeof err.code === 'number' &&
        typeof err.status === 'string'
      );
    }
    case 'typesafe-systemone':
      // FastAPI-style {detail} envelope: object w/ error_type (400/401/403/415/429/529),
      // bare string (404/405), or validation array (422). All dialect-specific.
      return 'detail' in o;
  }
}

const STATUS_RANK: Record<ProbeStatus, number> = {
  supported: 3,
  likely: 2,
  unknown: 1,
  'not-found': 0,
};

/** Run probes with bounded concurrency, early-exiting a dialect once 'supported'. */
async function probeDialect(
  inputBase: string,
  dialect: DialectId,
  opts: Required<Pick<DetectOptions, 'timeoutMs' | 'concurrency'>> & DetectOptions,
  seededUrls: string[],
  skipAlternates: boolean,
): Promise<DialectProbe> {
  const model = opts.models?.[dialect] ?? opts.model ?? DEFAULT_MODELS[dialect];
  const primary = [
    ...seededUrls,
    ...candidateUrls(inputBase, dialect, model),
    ...(opts.extraPaths?.[dialect] ?? []).map((p) =>
      p.startsWith('http') ? p : `${inputBase.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`,
    ),
  ];
  const alternates = skipAlternates
    ? []
    : candidateUrls(inputBase, dialect, model).filter((u) => !primary.includes(u));
  const urls = [...primary, ...alternates].filter((u, i, a) => a.indexOf(u) === i);

  // Probe strictly in candidate order (primary first), one at a time.
  // Keyless probes keep going while the verdict is weak (a global-auth 401 on the
  // primary route says nothing about alternate mounts); a strong verdict
  // (supported, or a keyed likely) stops early.
  const fingerprintOn = opts.fingerprintProbes !== false && !opts.apiKey;
  let best: DialectProbe | undefined;
  for (const url of urls) {
    const req = buildRequest(dialect, url, model, opts.apiKey, opts.headers);
    const res = await sendProbe(req, opts.timeoutMs);
    let probe = buildProbeResult(
      dialect,
      url,
      res,
      !!opts.apiKey,
      (snip) => verifyDialectBody(dialect, snip),
      (snip) => verifyDialectErrorBody(dialect, snip),
    );
    // Keyless fingerprint: a generic auth wall may just be the host's global auth.
    // Retry with a shape-mismatched body — if the provider validates the body BEFORE
    // auth, the error changes (400/validation), proving the dialect route is real.
    if (
      fingerprintOn &&
      probe.status === 'likely' &&
      probe.signals.includes('auth-wall') &&
      !probe.signals.includes('error-shape-match')
    ) {
      const freq = buildRequest(dialect, url, model, undefined, opts.headers, true);
      const fres = await sendProbe(freq, opts.timeoutMs);
      if (fres.ok && fres.status !== undefined && fres.status !== probe.httpStatus) {
        // status changed when we broke the body -> validation ran before auth.
        probe = {
          ...probe,
          status: 'supported',
          httpStatus: fres.status,
          detail: `validate-before-auth: breaking the body changed HTTP ${probe.httpStatus} -> ${fres.status}, so the ${dialect} route really exists`,
          signals: [...probe.signals, 'validate-before-auth', 'fingerprint-confirmed'],
        };
      } else if (
        fres.ok &&
        fres.status === probe.httpStatus &&
        (fres.bodySnippet ?? '') !== (res.bodySnippet ?? '')
      ) {
        // same status but the body changed in a way that mentions a request field:
        // the server validated the body before auth, proving the route exists.
        // request_id / timestamp -only diffs do NOT count.
        const diff = (fres.bodySnippet ?? '').toLowerCase();
        // Must name a REQUEST BODY field, not an auth credential. "API key is
        // required" is an auth message, not body validation — exclude it.
        // Patterns verified against a 203-provider keyless sweep (Oct 2026).
        const mentionsField =
          /"param"\s*:\s*"(messages|input|contents|model|state|questions|max_tokens)"/.test(diff) ||
          /["'`](messages|input|contents|state|questions|max_tokens)["'`]?\s+(field\s+)?(is\s+)?(required|missing|cannot be empty)/.test(diff) ||
          /(missing|required|cannot be empty|expected|field required( at)?)[^a-z]{0,12}["'`]?(messages|input|contents|state|questions|max_tokens)["'`]?/.test(diff) ||
          /"loc"\s*:\s*\[\s*"body"\s*,\s*"(messages|input|contents|state|questions)"/.test(diff); // pydantic/fastapi 422
        if (mentionsField) {
          probe = {
            ...probe,
            status: 'supported',
            detail: `validate-before-auth: body change revealed field-level validation at HTTP ${fres.status}, so the ${dialect} route really exists`,
            signals: [...probe.signals, 'validate-before-auth', 'fingerprint-confirmed'],
          };
        }
      }
      // NOTE: a bare same-status body difference is NOT enough — per-request values
      // like request_id differ on every call even when the provider never inspected
      // the body. Only a status change or field-level validation language proves
      // validate-before-auth.
    }
    if (!best || STATUS_RANK[probe.status] > STATUS_RANK[best.status]) best = probe;
    if (probe.status === 'supported') break;
    if (opts.apiKey && probe.status === 'likely') break;
  }
  return (
    best ?? {
      dialect,
      probedUrl: '',
      status: 'unknown',
      detail: 'no candidate URLs generated',
      signals: [],
    }
  );
}

/** Pull model ids out of a (possibly truncated) OpenAI-style {data:[{id}]} body. */
function extractModelIds(snippet: string): string[] | undefined {
  // fast path: well-formed body
  try {
    const parsed = JSON.parse(snippet) as Record<string, unknown>;
    const data = parsed?.data;
    if (Array.isArray(data)) {
      const ids = data
        .map((m) => (typeof m === 'object' && m !== null ? String((m as Record<string, unknown>).id ?? '') : ''))
        .filter(Boolean);
      if (ids.length > 0) return ids.slice(0, 5);
    }
  } catch {
    /* truncated or not json — fall through to the lenient scan */
  }
  // lenient: a truncated model list still starts with {"data":[{"id":"..."}...];
  // scrape leading ids without needing valid JSON at the cut point.
  if (!/"data"\s*:\s*\[\s*\{/.test(snippet)) return undefined;
  const ids = [...snippet.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return ids.length > 0 ? [...new Set(ids)].slice(0, 5) : undefined;
}

/** Probe GET {base}/models — the OpenAI model-list endpoint. */
async function probeModelsList(
  inputBase: string,
  opts: DetectOptions & { timeoutMs: number },
): Promise<NonNullable<DetectionResult['modelsList']>> {
  const url = `${inputBase.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {
    'user-agent': 'llm-baseurl-detector/0.1',
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`;
  // model lists can be 100KB+; read generously, then salvage truncated JSON below
  const res = await sendProbe({ url, method: 'GET', headers }, opts.timeoutMs, 512 * 1024);
  if (!res.ok) {
    return { reachable: false, detail: `request failed: ${res.error ?? 'network error'}` };
  }
  const code = res.status ?? 0;
  if (code >= 200 && code < 300) {
    const ids = extractModelIds(res.bodySnippet ?? '');
    return {
      reachable: true,
      httpStatus: code,
      sampleModels: ids,
      detail: ids
        ? `OpenAI-shaped model list with ${ids.length}+ models`
        : 'HTTP 2xx but not an OpenAI-shaped {object:"list", data:[...]} body',
    };
  }
  if (code === 401 || code === 403) {
    return { reachable: true, httpStatus: code, detail: 'model list exists behind auth' };
  }
  return { reachable: false, httpStatus: code, detail: `HTTP ${code}` };
}

/**
 * Detect which LLM API dialects a base URL supports.
 *
 * @param baseUrl e.g. "https://api.example.com/v1"
 * @param options see {@link DetectOptions}
 */
export async function detect(baseUrl: string, options: DetectOptions = {}): Promise<DetectionResult> {
  const started = Date.now();
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`baseUrl must be an absolute http(s) URL, got: ${baseUrl}`);
  }
  const timeoutMs = options.timeoutMs === undefined ? 8000 : Number(options.timeoutMs);
  const concurrency = options.concurrency === undefined ? 6 : Number(options.concurrency);
  let dialects = options.dialects ?? ALL_DIALECTS;



  // Dialects are probed sequentially. Once any dialect is confirmed at the primary
  // mount, later dialects skip alternate mounts — a catch-all 200/JSON path (seen on
  // real hosts, e.g. zhipu answering 200 {code:500} for unknown routes) must not get
  // the chance to win a dialect that clearly lives elsewhere. Dialects with a strong
  // error envelope (anthropic/gemini/typesafe) keep their alternates: a global 401
  // on the primary says nothing about them, and their envelope can confirm the real
  // mount even keyless.
  const STRONG_ENVELOPE: ReadonlySet<DialectId> = new Set([
    'anthropic-messages',
    'gemini-generate',
    'typesafe-systemone',
  ]);
  const confirmedElsewhere = () =>
    probes.some((p) => p.status === 'supported' || p.status === 'likely');
  const probes: DialectProbe[] = new Array(dialects.length);
  let cursor = 0;
  const pool = Math.max(1, concurrency);
  const worker = async (): Promise<void> => {
    while (cursor < dialects.length) {
      const i = cursor++;
      const dialect = dialects[i];
      const seeded: string[] = [];
      const skipAlternates = confirmedElsewhere() && !STRONG_ENVELOPE.has(dialect);
      probes[i] = await probeDialect(
        normalized,
        dialect,
        { timeoutMs, concurrency, ...options },
        seeded,
        skipAlternates,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, dialects.length) }, worker));

  const endpoints: DetectionResult['endpoints'] = {};
  for (const p of probes) {
    if (p.dialect === 'models-list') continue;
    if (p.status === 'supported' || p.status === 'likely') {
      endpoints[p.dialect] = p.probedUrl;
    }
  }

  const modelsList = options.probeModels
    ? await probeModelsList(normalized, { ...options, timeoutMs })
    : undefined;

  return {
    baseUrl: normalized,
    probes,
    endpoints,
    modelsList,
    durationMs: Date.now() - started,
  };
}
