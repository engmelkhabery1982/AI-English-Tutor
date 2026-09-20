/**
 * src/learner-agency/help-service.test.ts
 *
 * Work Order 2 — provider-backed help for surfaces WITHOUT a live session
 * (shadowing meaning etc.), tested with a FAKE provider behind the REAL
 * engine + orchestrator stack.
 *
 * Pinned:
 * - unconfigured → one honest configuration message and NO invented text;
 * - Demo only when EXPLICITLY requested, never as an automatic substitute;
 * - provider failures surface the WO1 friendly message — raw provider detail
 *   never leaks into the learner-facing string — and a safe retry is offered;
 * - a late result for a stale request is DISCARDED (the surface keeps what the
 *   learner already sees) — this is the stale-help-blocked requirement;
 * - the request built for the provider contains the action instruction and the
 *   asked-about language, bounded history, and NOTHING of the learner as an
 *   answer (the service has no learner-answer path at all).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Force "no configured key" so availability rules are deterministic.
vi.mock('../provider-config', () => ({
  resolveGeminiApiKey: () => null,
}));

type CapturedRequest = {
  mode: string;
  topic?: string;
  messages: { role: string; content: string }[];
};

function lastUserContent(request: CapturedRequest): string {
  const userMessages = request.messages.filter((m) => m.role === 'user');
  return userMessages[userMessages.length - 1]?.content ?? '';
}

function makeProvider(
  behavior:
    | { kind: 'text'; content: string }
    | { kind: 'error'; error: { code: string; message: string; retryable: boolean } }
    | { kind: 'throw'; raw: string },
  capture?: (request: CapturedRequest) => void,
) {
  return {
    id: 'fake-help-provider',
    async generate(request: CapturedRequest) {
      capture?.(request);
      if (behavior.kind === 'throw') throw new Error(behavior.raw);
      if (behavior.kind === 'error') return { ok: false as const, error: behavior.error };
      return { ok: true as const, response: { content: behavior.content } };
    },
  };
}

describe('learner help service', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('without any provider configuration there is NO fabricated help text', async () => {
    const { createLearnerHelpService, HELP_CONFIGURATION_REQUIRED_MESSAGE } = await import(
      './help-service'
    );
    const service = createLearnerHelpService();
    expect(service.providerAvailable).toBe(false);
    const result = await service.requestHelp({ action: 'hint' });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.errorMessage).toBe(HELP_CONFIGURATION_REQUIRED_MESSAGE);
    expect(result.retryable).toBe(false);
  });

  it('Demo Mode is used ONLY when explicitly requested', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    expect(createLearnerHelpService({ isDemo: true }).providerAvailable).toBe(true);
    // Never automatic: with no key and no explicit demo there is no provider.
    expect(createLearnerHelpService({}).providerAvailable).toBe(false);
  });

  it('a successful hint returns the provider text and asks the right thing', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    let captured: CapturedRequest | null = null;
    const service = createLearnerHelpService({
      provider: makeProvider({ kind: 'text', content: 'Think about weather words.' }, (r) => {
        captured = r;
      }) as never,
    });
    const result = await service.requestHelp({
      action: 'hint',
      mode: 'natural',
      topic: 'weather',
      contextText: 'It is pouring outside.',
      history: [{ role: 'assistant', content: 'How is the weather today?' }],
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Think about weather words.');
    expect(captured).not.toBeNull();
    const asked = lastUserContent(captured as unknown as CapturedRequest);
    // The help instruction is the ONLY thing sent as this 'turn' — it names the
    // hint request and carries the language being asked about.
    expect(asked).toContain('hint');
    expect(asked).toContain('It is pouring outside.');
    expect((captured as unknown as CapturedRequest).mode).toBe('natural');
  });

  it('intensity maps onto the EXISTING modes for the provider request', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    const seen: string[] = [];
    for (const mode of ['natural', 'balanced', 'intensive'] as const) {
      const service = createLearnerHelpService({
        provider: makeProvider({ kind: 'text', content: 'ok' }, (r) =>
          seen.push(r.mode),
        ) as never,
      });
      await service.requestHelp({ action: 'explain', mode });
    }
    expect(seen).toEqual(['natural', 'coach', 'intensive']);
  });

  it('provider failures show ONE friendly sentence, never raw provider text', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    const rawDetail = 'HTTP 503 {"error":{"message":"project QUOTA exceeded at googleapis.com"}}';
    const service = createLearnerHelpService({
      provider: makeProvider({
        kind: 'error',
        error: { code: 'unavailable', message: rawDetail, retryable: true },
      }) as never,
    });
    const result = await service.requestHelp({ action: 'example' });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.errorMessage).not.toContain('googleapis');
    expect(result.errorMessage).not.toContain('503');
    expect(typeof result.errorMessage).toBe('string');
    expect((result.errorMessage ?? '').length).toBeGreaterThan(10);
    expect(result.retryable).toBe(true);
  });

  it('an empty tutor reply is honest failure with retry, never a fabricated explanation', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    const service = createLearnerHelpService({
      provider: makeProvider({ kind: 'text', content: '   ' }) as never,
    });
    const result = await service.requestHelp({ action: 'explain' });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.retryable).toBe(true);
  });

  it('a stale result is discarded silently (late help can never overwrite fresh UI)', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    const service = createLearnerHelpService({
      provider: makeProvider({ kind: 'text', content: 'LATE explanation' }) as never,
    });
    const result = await service.requestHelp({
      action: 'explain',
      checkStale: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.errorMessage).toBeNull();
    expect(result.discardedStale).toBe(true);
  });

  it('a provider exception is classified, and staleness still wins for late results', async () => {
    const { createLearnerHelpService } = await import('./help-service');
    const service = createLearnerHelpService({
      provider: makeProvider({ kind: 'throw', raw: 'socket hang up ECONNRESET' }) as never,
    });
    const fresh = await service.requestHelp({ action: 'hint', checkStale: () => false });
    expect(fresh.ok).toBe(false);
    expect(fresh.discardedStale).toBe(false);
    expect(fresh.errorMessage).not.toContain('ECONNRESET');
    expect(fresh.errorMessage).not.toContain('socket');
    const late = await service.requestHelp({ action: 'hint', checkStale: () => true });
    expect(late.discardedStale).toBe(true);
    expect(late.errorMessage).toBeNull();
  });
});
