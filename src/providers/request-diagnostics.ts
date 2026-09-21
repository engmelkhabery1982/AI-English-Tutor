/**
 * src/providers/request-diagnostics.ts
 *
 * Lightweight INTERNAL provider request / quota diagnostics (development and
 * debug only) — the same spirit as the Package 1 voice timings
 * (src/voice/timings.ts).
 *
 * Records one in-memory entry per provider request (STT, tutor text
 * generation, TTS, dictionary inspection, lesson / listening / review
 * generation) with:
 * - request type, provider id, model id (when known),
 * - start/end timestamps and duration,
 * - success/failure with the classified failure kind,
 * - whether the failure was a rate-limit / quota (429) failure,
 * - automatic-retry occurrences per request type (one retry maximum — see
 *   src/shared/safe-retry.ts),
 * - token usage ONLY when the provider itself returns it.
 *
 * Deliberately minimal and private:
 * - no API key, no transcript, no audio, no message/prompt content, no PII,
 * - no network, no analytics backend, no persistence — one small in-memory
 *   ring buffer that is gone when the app restarts,
 * - inactive unless the app runs in development (`__DEV__`) or a debugger
 *   explicitly opts in (`globalThis.__REQUEST_DIAGNOSTICS__` /
 *   setRequestDiagnosticsEnabled).
 */

/** Which kind of provider work a counted request performs. */
export type RequestDiagnosticsType =
  | 'stt'
  | 'tutor_text'
  | 'tts'
  | 'dictionary'
  | 'lesson_generation'
  | 'listening_generation'
  | 'review_generation'
  | 'other';

/** Provider-reported token usage (only when the provider returns it). */
export interface RequestDiagnosticsUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** One counted provider request. Never contains payload content. */
export interface RequestDiagnosticsEntry {
  readonly id: number;
  readonly type: RequestDiagnosticsType;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  /** null while the request is still in flight. */
  readonly ok: boolean | null;
  /** Classified failure kind (see providers/failures) or null on success. */
  readonly failureKind: string | null;
  /** True when the failure was a rate-limit / quota (429) failure. */
  readonly rateLimited: boolean;
  /** Token usage, only when the provider returned it. */
  readonly usage: RequestDiagnosticsUsage | null;
}

/** Aggregate counters per request type (development/debug readout). */
export interface RequestDiagnosticsSummary {
  readonly type: RequestDiagnosticsType;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly rateLimited: number;
  readonly automaticRetries: number;
}

/** Handle from beginRequestDiagnostics; opaque to callers. */
export interface RequestDiagnosticsHandle {
  readonly id: number;
  readonly type: RequestDiagnosticsType;
}

/** How a counted request ended. */
export interface RequestDiagnosticsOutcome {
  readonly ok: boolean;
  readonly failureKind?: string | null;
  readonly rateLimited?: boolean;
  readonly usage?: RequestDiagnosticsUsage | null;
}

type MutableEntry = {
  -readonly [K in keyof RequestDiagnosticsEntry]: RequestDiagnosticsEntry[K];
};

/** Bound the diagnostic buffer: it is a rolling window, not a log archive. */
const MAX_ENTRIES = 200;

const entries: MutableEntry[] = [];
const automaticRetries = new Map<RequestDiagnosticsType, number>();
let nextId = 1;
let override: boolean | null = null;

function detectEnabled(): boolean {
  if (override !== null) return override;
  const g = globalThis as { __DEV__?: unknown; __REQUEST_DIAGNOSTICS__?: unknown };
  return g.__REQUEST_DIAGNOSTICS__ === true || g.__DEV__ === true;
}

/**
 * Explicit override (debugging/tests). `null` restores the default detection
 * (`__DEV__` or the global opt-in flag).
 */
export function setRequestDiagnosticsEnabled(enabled: boolean | null): void {
  override = enabled;
}

/** Empties the diagnostic buffer and retry counters. */
export function resetRequestDiagnostics(): void {
  entries.length = 0;
  automaticRetries.clear();
  nextId = 1;
}

/** The recorded requests, oldest first (empty while diagnostics are off). */
export function getRequestDiagnosticsLog(): readonly RequestDiagnosticsEntry[] {
  return entries;
}

/**
 * Starts counting ONE provider request. Returns null while diagnostics are
 * disabled (all calls then stay cheap no-ops); never throws, never blocks.
 */
export function beginRequestDiagnostics(input: {
  readonly type: RequestDiagnosticsType;
  readonly providerId?: string | null;
  readonly model?: string | null;
}): RequestDiagnosticsHandle | null {
  if (!detectEnabled()) return null;
  const id = nextId++;
  entries.push({
    id,
    type: input.type,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    ok: null,
    failureKind: null,
    rateLimited: false,
    usage: null,
  });
  while (entries.length > MAX_ENTRIES) entries.shift();
  return { id, type: input.type };
}

/** Completes a counted request. No-op for a null handle; never throws. */
export function finishRequestDiagnostics(
  handle: RequestDiagnosticsHandle | null,
  outcome: RequestDiagnosticsOutcome,
): void {
  if (!handle) return;
  const entry = entries.find((candidate) => candidate.id === handle.id);
  // The entry may already have rolled out of the bounded buffer.
  if (!entry) return;
  const endedAt = Date.now();
  entry.endedAt = endedAt;
  entry.durationMs = endedAt - entry.startedAt;
  entry.ok = outcome.ok;
  entry.failureKind = outcome.ok ? null : (outcome.failureKind ?? 'unknown');
  entry.rateLimited = outcome.rateLimited === true;
  entry.usage = outcome.usage ?? null;
}

/**
 * Notes ONE automatic retry for a request type (src/shared/safe-retry allows
 * at most one). Counted even when the retried entry itself is not retained.
 */
export function noteAutomaticRetry(type: RequestDiagnosticsType): void {
  if (!detectEnabled()) return;
  automaticRetries.set(type, (automaticRetries.get(type) ?? 0) + 1);
}

/** Per-type aggregate counters, including retry-only types. */
export function getRequestDiagnosticsSummary(): readonly RequestDiagnosticsSummary[] {
  const summaries = new Map<
    RequestDiagnosticsType,
    { total: number; succeeded: number; failed: number; rateLimited: number }
  >();
  for (const entry of entries) {
    const current = summaries.get(entry.type) ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    };
    current.total += 1;
    if (entry.ok === true) current.succeeded += 1;
    if (entry.ok === false) current.failed += 1;
    if (entry.rateLimited) current.rateLimited += 1;
    summaries.set(entry.type, current);
  }
  for (const type of automaticRetries.keys()) {
    if (!summaries.has(type)) {
      summaries.set(type, { total: 0, succeeded: 0, failed: 0, rateLimited: 0 });
    }
  }
  return [...summaries.entries()].map(([type, counts]) => ({
    type,
    ...counts,
    automaticRetries: automaticRetries.get(type) ?? 0,
  }));
}
