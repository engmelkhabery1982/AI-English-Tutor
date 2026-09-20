/**
 * src/providers/failures.ts
 *
 * THE ONE centralized provider-failure classification + learner-message path.
 *
 * Every learner-facing surface (Talk, the diagnostic assessment, fluency
 * practice, the voice coordinator) maps a provider/transport failure through
 * this module before rendering anything. Nothing else is allowed to invent
 * learner error text from a provider response.
 *
 * GUARANTEES
 * - A learner NEVER sees: raw JSON, a provider response body, a stack trace,
 *   technical API diagnostics, quota objects, HTTP status text or internal
 *   exception wording. `ProviderFailure.message` always comes from the bounded
 *   catalog below, or is an app-owned sentence that is already learner-safe.
 * - Technical detail is preserved separately (`ProviderFailure.technical`) for
 *   logs/diagnostics only, truncated and redacted. It must never be rendered.
 * - Retry semantics are explicit and conservative:
 *     `retryable`     → an EXPLICIT learner Retry may help,
 *     `autoRetryable` → ONE short automatic retry is safe (transient failures
 *                       only: service busy / timeout / interrupted connection).
 *   Quota (429) failures are NEVER auto-retried, and a failure that may have
 *   committed a learner turn is never auto-retried here — that decision belongs
 *   to `runWithSafeRetry()` (src/shared/safe-retry.ts), which additionally
 *   verifies that nothing was committed.
 *
 * This module is pure: no I/O, no clock, no provider dependency, no React.
 */

/** What kind of failure the learner hit (bounded, provider-neutral). */
export type ProviderFailureKind =
  /** HTTP 429 / quota exhausted. */
  | 'rate_limited'
  /** HTTP 503 / 5xx / provider overloaded. */
  | 'service_busy'
  /** The request was stopped by our own timeout. */
  | 'timeout'
  /** No/interrupted connection (offline, DNS, socket, fetch failure). */
  | 'network'
  /** The configured credential was rejected (401/403, invalid key). */
  | 'invalid_credentials'
  /** Nothing is configured, so no provider could answer. */
  | 'not_configured'
  /** The provider answered, but the payload could not be read. */
  | 'malformed_response'
  /** Speech-to-text heard no usable speech. */
  | 'unrecognized_speech'
  /** The provider refused the content (safety/block filters). */
  | 'blocked'
  /** Our OWN conversation lifecycle cancelled the work (replaced/closed). */
  | 'replaced'
  /** Anything else: honest, non-technical, retryable once by the learner. */
  | 'unknown';

/**
 * Which learner surface the message is written for. It only changes wording
 * ("speech service" vs "tutor"), never the classification or retry policy.
 */
export type ProviderFailureSurface =
  | 'speech'
  | 'tutor'
  | 'practice'
  | 'assessment'
  | 'generic';

/** Longest raw detail kept for logs (never rendered). */
const TECHNICAL_DETAIL_LIMIT = 240;
/** A learner sentence longer than this is treated as a raw provider payload. */
const LEARNER_SAFE_LENGTH_LIMIT = 180;

/**
 * The learner-facing catalog. Concise, actionable, and always stating whether
 * the learner's own work survived ("your answer was not lost").
 */
export const PROVIDER_FAILURE_MESSAGES: Readonly<
  Record<ProviderFailureKind, Readonly<Record<ProviderFailureSurface, string>>>
> = {
  rate_limited: {
    speech:
      'The speech service has reached its current usage limit. Your answer was not lost. Try again in a minute.',
    tutor:
      'The AI service has reached its current usage limit. Your answer was not lost. Try again in a minute.',
    practice:
      'The AI service has reached its current usage limit. Your practice was not lost. Try again in a minute.',
    assessment:
      'The AI service has reached its current usage limit. Your answer was not lost. Try again in a minute.',
    generic:
      'The AI service has reached its current usage limit. Your answer was not lost. Try again in a minute.',
  },
  service_busy: {
    speech: 'The speech service is busy right now. Your answer was not lost. Try again.',
    tutor: 'The tutor service is busy right now. Your answer was not lost. Try again.',
    practice: 'The tutor service is busy right now. Your practice was not lost. Try again.',
    assessment: 'The tutor service is busy right now. Your answer was not lost. Try again.',
    generic: 'The AI service is busy right now. Your answer was not lost. Try again.',
  },
  timeout: {
    speech:
      'Transcribing your speech took too long and was stopped. Nothing was recorded. Try again.',
    tutor:
      'The tutor took too long to answer and the request was stopped. Your answer was not lost. Try again.',
    practice:
      'The tutor took too long to answer and the request was stopped. Your practice was not lost. Try again.',
    assessment:
      'The tutor took too long to answer and the request was stopped. Your answer was not lost. Try again.',
    generic: 'The request took too long and was stopped. Your answer was not lost. Try again.',
  },
  network: {
    speech:
      'Your connection was interrupted, so your speech was not transcribed. Your answer was not lost.',
    tutor: 'Your connection was interrupted. Your answer was not lost.',
    practice: 'Your connection was interrupted. Your practice was not lost.',
    assessment: 'Your connection was interrupted. Your answer was not lost.',
    generic: 'Your connection was interrupted. Your answer was not lost.',
  },
  invalid_credentials: {
    speech:
      'Your AI provider key was rejected, so your speech could not be transcribed. Check the key in Settings. Your answer was not lost.',
    tutor:
      'Your AI provider key was rejected, so the tutor could not answer. Check the key in Settings. Your answer was not lost.',
    practice:
      'Your AI provider key was rejected, so this practice could not run. Check the key in Settings.',
    assessment:
      'Your AI provider key was rejected, so this answer could not be evaluated. Check the key in Settings. Your answer was not lost.',
    generic:
      'Your AI provider key was rejected. Check the key in Settings. Your answer was not lost.',
  },
  not_configured: {
    speech:
      'Speech recognition is not configured on this device, so your speech could not be transcribed. Add your AI provider key in Settings.',
    tutor:
      'No AI provider is configured on this device, so the tutor cannot answer. Add your AI provider key in Settings.',
    practice:
      'No AI provider is configured on this device, so this practice cannot start. Add your AI provider key in Settings.',
    assessment:
      'No AI provider is configured on this device, so this answer cannot be evaluated. Add your AI provider key in Settings.',
    generic:
      'No AI provider is configured on this device. Add your AI provider key in Settings.',
  },
  malformed_response: {
    speech:
      'The speech service sent back something that could not be read. Nothing was recorded. Try again.',
    tutor:
      'The tutor reply could not be read. Your answer was not lost. Try again.',
    practice:
      'The tutor reply could not be read. Your practice was not lost. Try again.',
    assessment:
      'The tutor reply could not be read, so this answer was not evaluated. Your answer was not lost. Try again.',
    generic: 'The AI reply could not be read. Your answer was not lost. Try again.',
  },
  unrecognized_speech: {
    speech:
      'I could not hear clear speech in that recording. Nothing was recorded. Try again, or type your answer.',
    tutor:
      'I could not hear clear speech in that recording. Nothing was recorded. Try again, or type your answer.',
    practice:
      'I could not hear clear speech in that recording. Nothing was counted. Try again, or type your answer.',
    assessment:
      'I could not hear clear speech in that recording. Nothing was recorded. Try again, or type your answer.',
    generic:
      'I could not hear clear speech in that recording. Nothing was recorded. Try again, or type your answer.',
  },
  blocked: {
    speech:
      'The speech service declined to process that audio. Nothing was recorded. Try again, or type your answer.',
    tutor:
      'The AI service declined to answer that request. Your answer was not lost. Try rephrasing it.',
    practice:
      'The AI service declined to answer that request. Your practice was not lost. Try rephrasing it.',
    assessment:
      'The AI service declined to answer that request. Your answer was not lost. Try rephrasing it.',
    generic:
      'The AI service declined to answer that request. Your answer was not lost. Try rephrasing it.',
  },
  replaced: {
    speech:
      'That turn was not sent because the conversation changed. Nothing was added to the new conversation.',
    tutor:
      'That turn was not sent because the conversation changed. Nothing was added to the new conversation.',
    practice:
      'That attempt was not counted because the task changed. Nothing was added to the new task.',
    assessment:
      'That answer was not recorded because the assessment step changed. Nothing was recorded.',
    generic:
      'That request was stopped because the conversation changed. Nothing was added.',
  },
  unknown: {
    speech: 'Your speech could not be processed this time. Nothing was recorded. Try again.',
    tutor: 'The tutor could not answer this time. Your answer was not lost. Try again.',
    practice: 'This practice step did not work this time. Nothing was lost. Try again.',
    assessment: 'That answer could not be evaluated this time. Nothing was recorded. Try again.',
    generic: 'That did not work this time. Your answer was not lost. Try again.',
  },
};

/**
 * One classified failure: the learner-safe message plus everything a caller
 * needs to decide recovery. `technical` is for logs/diagnostics ONLY.
 */
export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  /** Learner-safe, catalog-owned (or already-safe app-owned) sentence. */
  readonly message: string;
  readonly surface: ProviderFailureSurface;
  /** True when an EXPLICIT learner Retry may succeed. */
  readonly retryable: boolean;
  /**
   * True when ONE short automatic retry is allowed for this failure class.
   * Callers must still verify that no learner turn was committed.
   */
  readonly autoRetryable: boolean;
  /** True when the learner's own input survived (never re-record/re-type). */
  readonly inputPreserved: boolean;
  /** True when this is a configuration problem (point at Settings). */
  readonly needsConfiguration: boolean;
  /** Diagnostic detail for logs. NEVER render this to the learner. */
  readonly technical: string | null;
  /** HTTP status when one was genuinely observed (never guessed). */
  readonly httpStatus: number | null;
}

/** Anything a caller may hand to the classifier. */
export interface ProviderFailureInput {
  /** Provider/transport error text (may be raw; it is never rendered as-is). */
  readonly message?: string | null;
  /** Provider-neutral error code (e.g. AIProviderErrorCode) when available. */
  readonly code?: string | null;
  /** HTTP status observed by the caller (never inferred from a message alone). */
  readonly httpStatus?: number | null;
  readonly surface?: ProviderFailureSurface;
  /** The provider's own retryable flag, honoured for transient classes. */
  readonly retryable?: boolean;
  /**
   * Result-shaped failures (STTResult, execution results) carry the failure under
   * `error` — a string or an AIProviderError-like object — instead of `message`.
   * Accepting it here keeps ONE classification path for every boundary.
   */
  readonly error?:
    | string
    | { readonly message?: string | null; readonly code?: string | null }
    | null;
}

/** Transient classes: ONE short automatic retry is safe for these only. */
const AUTO_RETRYABLE_KINDS: readonly ProviderFailureKind[] = [
  'service_busy',
  'timeout',
  'network',
];

/** Classes that mean "the app is not configured correctly", not "try again". */
const CONFIGURATION_KINDS: readonly ProviderFailureKind[] = [
  'invalid_credentials',
  'not_configured',
];

/** Classes where the learner's own answer/transcript was never at risk. */
const INPUT_PRESERVED_KINDS: readonly ProviderFailureKind[] = [
  'rate_limited',
  'service_busy',
  'timeout',
  'network',
  'invalid_credentials',
  'not_configured',
  'malformed_response',
  'blocked',
  'replaced',
  'unknown',
];

/** Provider error codes (AIProviderErrorCode and friends) → failure kind. */
const CODE_KINDS: Readonly<Record<string, ProviderFailureKind>> = {
  rate_limit: 'rate_limited',
  ratelimit: 'rate_limited',
  quota: 'rate_limited',
  unavailable: 'service_busy',
  service_unavailable: 'service_busy',
  overloaded: 'service_busy',
  timeout: 'timeout',
  deadline_exceeded: 'timeout',
  network: 'network',
  network_error: 'network',
  offline: 'network',
  authentication: 'invalid_credentials',
  unauthenticated: 'invalid_credentials',
  permission_denied: 'invalid_credentials',
  invalid_api_key: 'invalid_credentials',
  not_configured: 'not_configured',
  invalid_request: 'malformed_response',
  malformed: 'malformed_response',
  parse_error: 'malformed_response',
  no_speech: 'unrecognized_speech',
  unrecognized_speech: 'unrecognized_speech',
  blocked: 'blocked',
  safety: 'blocked',
  cancelled: 'replaced',
  canceled: 'replaced',
  replaced: 'replaced',
};

/** Text that means "the app is not configured", never "the service is busy". */
const NOT_CONFIGURED_PATTERN =
  /not configured|configuration required|no (?:ai )?provider is configured|configure a provider|provider configuration/i;

/** Microphone permission is a device permission, never a provider credential. */
const MICROPHONE_PERMISSION_PATTERN = /microphone (?:permission|access)|record audio permission/i;

interface TextRule {
  readonly kind: ProviderFailureKind;
  readonly pattern: RegExp;
}

/**
 * Ordered text rules. They exist because several providers (STT above all)
 * only hand back a string, so the classification has to read it — but the
 * learner never sees the string itself, only the catalog message.
 */
const TEXT_RULES: readonly TextRule[] = [
  // Our own conversation lifecycle (intentional replacement/cancellation).
  { kind: 'replaced', pattern: /conversation (?:was )?(?:replaced|changed|closed)/i },
  { kind: 'replaced', pattern: /turn was discarded|was discarded\./i },
  { kind: 'replaced', pattern: /already in progress|is changing\. please try again/i },
  // Quota / rate limit.
  { kind: 'rate_limited', pattern: /\b429\b|quota|rate[ _-]?limit|resource_exhausted|too many requests/i },
  // Overloaded / unavailable service.
  { kind: 'service_busy', pattern: /\b50[0-9]\b|overloaded|service unavailable|temporarily unavailable|try again later/i },
  // Timeouts (our AbortController or the transport's own).
  { kind: 'timeout', pattern: /timed? ?out|timeout|aborterror|aborted|deadline/i },
  // Connection problems.
  { kind: 'network', pattern: /network|failed to fetch|fetch failed|load failed|econnreset|econnrefused|enotfound|etimedout|socket hang up|offline|connection (?:was )?(?:interrupted|reset|closed)|no internet/i },
  // Credential problems (microphone permission is checked before the rules run).
  { kind: 'invalid_credentials', pattern: /\b40[13]\b|api[_ -]?key|invalid credential|unauthoriz|unauthenticat|permission[_ ]denied|forbidden|access denied/i },
  // Nothing configured.
  { kind: 'not_configured', pattern: NOT_CONFIGURED_PATTERN },
  // Speech recognition heard nothing usable.
  { kind: 'unrecognized_speech', pattern: /no speech|could not (?:be )?recogni[sz]e|couldn't hear|not clear|silent|too short|audio (?:was not|is not) clear|unintelligible/i },
  // Malformed payloads.
  { kind: 'malformed_response', pattern: /malformed|invalid json|json\.parse|empty candidates|no text content|could not be (?:read|parsed)|unexpected token|not valid json/i },
  // Content blocks.
  { kind: 'blocked', pattern: /blocked|safety filter|prohibited_content|recitation|blockreason/i },
];

/** Text that proves a message is a raw/technical payload, not a learner line. */
const TECHNICAL_MARKERS: readonly RegExp[] = [
  /[{}\[\]]/, // JSON / structured payload
  /\bHTTP\b/i,
  /status\s*(?:code)?\s*[:#]?\s*\d{3}/i,
  /\b\d{3}\s*(?:error|status)\b/i,
  /at\s+(?:async\s+)?[A-Za-z0-9_$.]+\s*\(/, // stack frame
  /\bat\s+Object\.|\bat\s+Module\./,
  /\b(?:TypeError|SyntaxError|RangeError|ReferenceError|AbortError|Error):/,
  /quota|rate[ _-]?limit|resource_exhausted/i,
  /\bapi[_ -]?key\b|x-goog|authorization|bearer\b/i,
  /generativelanguage\.googleapis\.com|https?:\/\//i,
  /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN)\b/,
  /\bundefined\b|\bnull\b|\bNaN\b/,
  /candidates|promptfeedback|usageMetadata|finishReason|blockReason/i,
  /\bexception\b|\bstack trace\b/i,
  /\n/,
];

function normalizeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** Extracts a genuinely present HTTP status from raw text (never guesses). */
function detectHttpStatus(text: string): number | null {
  const explicit =
    /(?:status(?:\s*code)?|http)\D{0,12}(\d{3})/i.exec(text) ?? /status\s+(\d{3})/i.exec(text);
  if (explicit?.[1]) {
    const status = Number(explicit[1]);
    if (status >= 100 && status <= 599) return status;
  }
  return null;
}

function kindFromHttpStatus(status: number): ProviderFailureKind | null {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'invalid_credentials';
  if (status === 408) return 'timeout';
  if (status >= 500 && status <= 599) return 'service_busy';
  if (status === 400 || status === 404 || status === 422) return 'malformed_response';
  return null;
}

/**
 * True when a message is already safe to show a learner: short, single-line,
 * no payload/stack/credential/quota markers, no HTTP status text.
 */
export function isLearnerSafeMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > LEARNER_SAFE_LENGTH_LIMIT) return false;
  return !TECHNICAL_MARKERS.some((marker) => marker.test(trimmed));
}

/**
 * Reduces raw detail to a bounded, single-line, credential-free string for
 * logs/diagnostics. It is NEVER rendered to a learner.
 */
export function toTechnicalDetail(
  text: string | null | undefined,
  apiKey?: string | null,
): string | null {
  if (!text) return null;
  let detail = text.replace(/\s+/g, ' ').trim();
  if (apiKey && apiKey.trim().length > 0) {
    detail = detail.split(apiKey.trim()).join('[REDACTED]');
  }
  // Defensive redaction of anything that looks like a long secret token.
  detail = detail.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[REDACTED]');
  if (detail.length === 0) return null;
  return detail.length > TECHNICAL_DETAIL_LIMIT
    ? `${detail.slice(0, TECHNICAL_DETAIL_LIMIT)}…`
    : detail;
}

function classifyKind(
  text: string,
  code: string | null,
  httpStatus: number | null,
): ProviderFailureKind {
  // 1. A real HTTP status is the strongest evidence we have.
  const fromStatus = httpStatus === null ? null : kindFromHttpStatus(httpStatus);
  if (fromStatus) return fromStatus;

  // 2. A structured provider code, with two honest corrections:
  //    - microphone permission is a DEVICE permission, not a credential;
  //    - code 'unavailable' is used both for a busy service AND for "nothing is
  //      configured", and those need opposite recovery (Retry vs Settings).
  if (code) {
    const mapped = CODE_KINDS[code];
    if (mapped) {
      if (mapped === 'invalid_credentials' && MICROPHONE_PERMISSION_PATTERN.test(text)) {
        return 'unknown';
      }
      if (mapped === 'service_busy' && NOT_CONFIGURED_PATTERN.test(text)) {
        return 'not_configured';
      }
      return mapped;
    }
  }

  // 3. Otherwise read the text — but only to pick a catalog message.
  if (MICROPHONE_PERMISSION_PATTERN.test(text)) return 'unknown';
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return 'unknown';
}

/**
 * Kinds whose wording is owned by the APP itself (conversation lifecycle,
 * configuration notices, honest domain sentences). For these an already-safe
 * message is kept verbatim: the catalog must not flatten honest app wording into
 * generic provider text. Every other kind is a provider/transport class, and the
 * catalog message wins so a raw payload can never reach the learner.
 */
const APP_OWNED_WORDING_KINDS: readonly ProviderFailureKind[] = [
  'replaced',
  'not_configured',
  'unknown',
];

/**
 * Classifies ANY provider/transport failure into one bounded, learner-safe
 * description. Accepts a plain string, an AIProviderError-shaped object, an
 * STTResult-shaped object or an explicit input record.
 */
export function classifyProviderFailure(
  input: ProviderFailureInput | string | null | undefined,
  surface: ProviderFailureSurface = 'generic',
): ProviderFailure {
  const raw =
    typeof input === 'string'
      ? { message: input }
      : (input ?? {});
  const nested = typeof raw.error === 'string' ? { message: raw.error } : (raw.error ?? null);
  const text = (raw.message ?? nested?.message ?? '').toString();
  const requestedSurface = raw.surface ?? surface;
  const code = normalizeCode(raw.code ?? nested?.code ?? null);
  const httpStatus =
    typeof raw.httpStatus === 'number' && raw.httpStatus > 0
      ? raw.httpStatus
      : detectHttpStatus(text);

  const kind = classifyKind(text, code, httpStatus);
  const safeText = text.trim();
  /**
   * Which sentence the learner gets:
   * - app-owned wording kinds (conversation lifecycle, configuration notices,
   *   honest domain sentences) keep their own text when it is already safe;
   * - every provider/transport class uses the catalog, so a raw payload, a
   *   quota object or an HTTP status line can never be rendered.
   */
  const message =
    APP_OWNED_WORDING_KINDS.includes(kind) && isLearnerSafeMessage(safeText)
      ? safeText
      : PROVIDER_FAILURE_MESSAGES[kind][requestedSurface];

  /**
   * Retry policy. A provider that explicitly reports "not retryable" is
   * authoritative (e.g. the honest no-provider-configured failure), and our own
   * lifecycle cancellations, content blocks and configuration problems are never
   * retried automatically.
   */
  const neverRetry =
    kind === 'replaced' || kind === 'blocked' || CONFIGURATION_KINDS.includes(kind);
  const retryable = neverRetry || raw.retryable === false ? false : true;

  return {
    kind,
    message,
    surface: requestedSurface,
    retryable,
    autoRetryable: retryable && AUTO_RETRYABLE_KINDS.includes(kind),
    inputPreserved: INPUT_PRESERVED_KINDS.includes(kind),
    needsConfiguration: CONFIGURATION_KINDS.includes(kind),
    technical: toTechnicalDetail(safeText),
    httpStatus,
  };
}

/**
 * The ONLY string a learner-facing surface may render for a failure.
 *
 * Use it even when the failure text looks harmless: it guarantees raw provider
 * payloads can never leak through a path nobody re-audited.
 */
export function learnerMessageForFailure(
  input: ProviderFailureInput | string | null | undefined,
  surface: ProviderFailureSurface = 'generic',
): string {
  return classifyProviderFailure(input, surface).message;
}

/** True when ONE short automatic retry is allowed for this failure class. */
export function isTransientProviderFailure(
  failure: ProviderFailure | ProviderFailureKind,
): boolean {
  const kind = typeof failure === 'string' ? failure : failure.kind;
  return AUTO_RETRYABLE_KINDS.includes(kind);
}

/** True when the learner must be pointed at Settings, not at Retry. */
export function isConfigurationFailure(
  failure: ProviderFailure | ProviderFailureKind,
): boolean {
  const kind = typeof failure === 'string' ? failure : failure.kind;
  return CONFIGURATION_KINDS.includes(kind);
}

/** True when our OWN lifecycle cancelled the work (intentional replacement). */
export function isReplacementFailure(
  failure: ProviderFailure | ProviderFailureKind,
): boolean {
  const kind = typeof failure === 'string' ? failure : failure.kind;
  return kind === 'replaced';
}
