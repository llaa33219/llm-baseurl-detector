import type { DialectId, DialectProbe, ProbeStatus } from './types.js';

export interface ProbeRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface ProbeResponse {
  ok: boolean;
  status?: number;
  /** First chunk of the response body, best-effort. */
  bodySnippet?: string;
  /** Content-Type header value, lowercased. */
  contentType?: string;
  error?: string;
}

const SNIPPET_LIMIT = 4096; // large enough for reasoning-first Responses payloads
const MODELS_SNIPPET_LIMIT = 65536; // model lists can be tens of KB

export async function sendProbe(
  req: ProbeRequest,
  timeoutMs: number,
  bodyLimit = SNIPPET_LIMIT,
): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    let bodySnippet: string | undefined;
    try {
      const text = await res.text();
      bodySnippet = text.slice(0, bodyLimit);
    } catch {
      bodySnippet = undefined;
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    return { ok: true, status: res.status, bodySnippet, contentType };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : err.message
        : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

const MODEL_404_HINT = /model/;

/**
 * Classify a probe response for an LLM dialect endpoint.
 *
 * Key insight: many providers route unknown paths to a SPA fallback or a plain 404,
 * while a real LLM route that rejects the *model* still mentions "model" in the body.
 */
export function classify(
  res: ProbeResponse,
  dialect: DialectId,
  hadAuth: boolean,
  verifyBody: (snippet: string) => boolean,
  verifyErrorBody: (snippet: string) => boolean,
): { status: ProbeStatus; detail: string; signals: string[] } {
  const signals: string[] = [];
  if (!res.ok) {
    return {
      status: 'unknown',
      detail: `request failed: ${res.error ?? 'network error'}`,
      signals: ['network-error'],
    };
  }
  const code = res.status ?? 0;
  const body = (res.bodySnippet ?? '').toLowerCase();
  const mentionsModel = MODEL_404_HINT.test(body);

  if (code >= 200 && code < 300) {
    signals.push('2xx');
    const snippet = res.bodySnippet ?? '';
    const isJson = (res.contentType ?? '').includes('json');
    if (verifyBody(snippet)) {
      signals.push('shape-match');
      return {
        status: 'supported',
        detail: `endpoint accepted the probe and returned the dialect's response shape (HTTP ${code})`,
        signals,
      };
    }
    if (isJson) {
      signals.push('2xx-unusual-shape');
      return {
        status: 'unknown',
        detail: 'HTTP 2xx JSON but not the expected response shape — likely a catch-all route (seen on real hosts answering 200 for unknown paths)',
        signals,
      };
    }
    // catch-all fallback (SPA HTML, proxies that answer 200 for any path, ...)
    signals.push('catch-all-suspected');
    return {
      status: 'unknown',
      detail: 'HTTP 2xx non-JSON — likely a catch-all/fallback page, not a real LLM route',
      signals,
    };
  }
  if (code === 401 || code === 403) {
    signals.push('auth-wall');
    // Dialect-shaped error envelope on the auth wall is a strong signal:
    // e.g. Anthropic always answers {"type":"error","error":{"type":"authentication_error"}},
    // even for nonexistent routes — so when the ERROR shape matches the dialect,
    // an auth wall alone is enough to call the dialect supported.
    // openai-chat/openai-responses share a weak envelope ({error:{message}}) that
    // gateways/proxies also emit — too weak to confirm a dialect on its own.
    const strongShape =
      dialect === 'anthropic-messages' ||
      dialect === 'gemini-generate' ||
      dialect === 'typesafe-systemone';
    const dialectShapedError = strongShape && verifyErrorBody(res.bodySnippet ?? '');
    if (dialectShapedError) {
      signals.push('error-shape-match');
      return {
        status: 'supported',
        detail: hadAuth
          ? "dialect's error envelope on the auth wall — dialect confirmed (key invalid for this host/plan)"
          : "dialect's error envelope on the auth wall — dialect confirmed",
        signals,
      };
    }
    return {
      status: 'likely',
      detail: hadAuth
        ? 'auth rejected despite supplied key (key invalid for this host/plan, or route protected differently)'
        : 'auth wall (generic envelope) — route probably exists; pass apiKey to confirm',
      signals,
    };
  }
  if (code === 404) {
    // A gateway/SPA 404 that embeds the whole request path (e.g. spring-boot's
    // {timestamp,status,error,path:"...models/x:generateContent"}) mentions "model"
    // WITHOUT being a real LLM route. Require the dialect's error envelope for the
    // model-hint upgrade.
    const routeMentionsModel = mentionsModel && verifyErrorBody(res.bodySnippet ?? '');
    if (routeMentionsModel) {
      signals.push('404-model-hint');
      return {
        status: 'likely',
        detail: 'HTTP 404 but body mentions "model" — likely a real route rejecting the probe model id',
        signals,
      };
    }
    signals.push('404');
    return { status: 'not-found', detail: 'route does not exist', signals };
  }
  if (code === 405) {
    signals.push('405');
    // A bare 405 is ambiguous: frameworks return it for unknown routes whose path
    // prefix collides with a real one (anthropic answers 405 for POST
    // /v1/models/x:generateContent because /v1/models exists for GET only).
    // Only a dialect-shaped envelope makes it meaningful.
    if (verifyErrorBody(res.bodySnippet ?? '')) {
      signals.push('error-shape-match');
      return {
        status: 'likely',
        detail: 'method rejected with the dialect’s error envelope — route family exists, exact path/method may differ',
        signals,
      };
    }
    return {
      status: 'unknown',
      detail: 'HTTP 405 with a generic body — cannot distinguish route-exists from prefix-collision',
      signals,
    };
  }
  if (code === 400 || code === 422) {
    signals.push(`http-${code}`);
    if (mentionsModel) {
      signals.push('model-hint');
      return {
        status: 'likely',
        detail: `HTTP ${code} mentioning "model" — route exists, probe model id probably wrong`,
        signals,
      };
    }
    if (verifyErrorBody(res.bodySnippet ?? '')) {
      // dialect-shaped validation error (e.g. gemini's google.rpc INVALID_ARGUMENT)
      signals.push('error-shape-match');
      return {
        status: 'likely',
        detail: 'route exists and rejected the probe with the dialect’s validation-error envelope',
        signals,
      };
    }
    return {
      status: 'unknown',
      detail: `HTTP ${code} with a generic body — cannot tell route-rejection from a gateway error`,
      signals,
    };
  }
  if (code === 429) {
    signals.push('429');
    return { status: 'likely', detail: 'rate limited — route exists', signals };
  }
  if (code >= 500) {
    signals.push('5xx');
    return { status: 'unknown', detail: 'server error — cannot determine', signals };
  }
  return {
    status: 'unknown',
    detail: 'unexpected status',
    signals: [`http-${code}`],
  };
}

/** Build the verdict record for one probe attempt. */
export function buildProbeResult(
  dialect: DialectId,
  url: string,
  res: ProbeResponse,
  hadAuth: boolean,
  verifyBody: (snippet: string) => boolean,
  verifyErrorBody: (snippet: string) => boolean,
): DialectProbe {
  const c = classify(res, dialect, hadAuth, verifyBody, verifyErrorBody);
  return {
    dialect,
    probedUrl: url,
    status: c.status,
    httpStatus: res.status,
    detail: c.detail,
    signals: c.signals,
  };
}
