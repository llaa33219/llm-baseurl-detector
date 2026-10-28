/** API dialects the detector can identify. */
export type DialectId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-generate'
  | 'typesafe-systemone';

/** How confident the probe verdict is. */
export type ProbeStatus =
  | 'supported' // endpoint exists and accepts this dialect's request shape
  | 'likely' // signals point to support, but could not be fully confirmed (e.g. auth wall)
  | 'not-found' // server clearly says the route does not exist
  | 'unknown'; // could not determine (network error, unexpected response, ...)

export interface DialectProbe {
  dialect: DialectId | 'models-list';
  /** URL that was actually probed. */
  probedUrl: string;
  status: ProbeStatus;
  /** HTTP status code of the probe response, if a response was received. */
  httpStatus?: number;
  /** One-line human explanation of the verdict. */
  detail: string;
  /** Raw signal codes, useful for programmatic consumers. */
  signals: string[];
}

export interface DetectionResult {
  /** Normalized input base URL (trailing slash trimmed). */
  baseUrl: string;
  probes: DialectProbe[];
  /**
   * Dialects with status 'supported' or 'likely', with the best-guess full
   * endpoint URL — POST directly to this (raw request form).
   */
  endpoints: Partial<Record<DialectId, string>>;
  /**
   * Same dialects, but as the **SDK base URL** form: what you paste into an
   * SDK's baseURL field (the SDK appends its own path). Derived by stripping
   * the dialect's endpoint suffix from `endpoints`.
   */
  sdkBaseUrls: Partial<Record<DialectId, string>>;
  /** GET {base}/models result, present only when opts.probeModels was on. */
  modelsList?: {
    reachable: boolean;
    httpStatus?: number;
    /** first few model ids, when the list endpoint answered with an OpenAI-shaped list */
    sampleModels?: string[];
    detail: string;
  };
  /** Total wall time of the detection in ms. */
  durationMs: number;
}

export interface DetectOptions {
  /** Also probe GET {base}/models — the OpenAI model-list endpoint. Off by default. */
  probeModels?: boolean;
  /**
   * Send a second, shape-mismatched probe (missing required field) when the first
   * probe hits a generic auth wall. Some providers validate the body BEFORE auth,
   * which reveals the dialect keyless. Default true.
   */
  fingerprintProbes?: boolean;
  /** API key sent with probes. Without one, expect 401/403-driven verdicts. */
  apiKey?: string;
  /** Extra headers merged into every probe request. */
  headers?: Record<string, string>;
  /** Model id used in probe payloads. Default 'gpt-4o-mini' or per-dialect override. */
  model?: string;
  /** Per-dialect model override. */
  models?: Partial<Record<DialectId, string>>;
  /** Per-probe timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Max concurrent probes. Default 6. */
  concurrency?: number;
  /** Restrict probing to these dialects. Default: all. */
  dialects?: DialectId[];
  /** Extra candidate URL paths to try, appended per dialect after built-ins. */
  extraPaths?: Partial<Record<DialectId, string[]>>;
}
