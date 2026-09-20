/**
 * src/conversation-session/assistance.test.ts
 *
 * Work Order 2 — learner help INSIDE a live conversation session
 * (`requestAssistance`) plus the session-local correction override
 * (`setModeOverride`), tested against the real session implementation with a
 * mocked orchestrator.
 *
 * The lifecycle rules under test are exactly the Work Order 1 guarantees,
 * extended to help:
 * - help commits ONLY a tutor turn: learner answer counts never move;
 * - help strips feedback at the source: it can never be recorded as learner
 *   correction evidence, and it never disturbs the last real feedback;
 * - a help request racing a learner turn LOSES to the learner turn;
 * - a dead (abandoned/replaced) session discards help;
 * - provider failures write nothing;
 * - `setModeOverride` changes only how the next prompt is built — it never
 *   recreates the session, bumps versions, or touches getConfig().
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConversationExecutionResult, ConversationOrchestrator } from '../conversation-orchestrator';
import type { ConversationRequestInput } from '../conversation-engine';
import { CONVERSATION_ASSISTANCE_DISCARDED_MESSAGE, countCommittedLearnerTurns, createConversationSession } from './index';

function okResult(content: string, feedback?: unknown): ConversationExecutionResult {
  return {
    ok: true,
    request: { systemPrompt: '', messages: [], mode: 'natural', topic: 'travel' } as never,
    response: { content, feedback: feedback ?? null } as never,
  };
}

function mockOrchestrator(
  impl?: (input: ConversationRequestInput) => Promise<ConversationExecutionResult>,
) {
  return {
    execute: vi.fn(
      impl ??
        (async () => okResult('Here is a small hint — no answer is given.')),
    ),
  } as unknown as ConversationOrchestrator & { execute: ReturnType<typeof vi.fn> };
}

describe('requestAssistance — tutor-only help in a live session', () => {
  it('commits an assistant-only turn and never counts a learner turn', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'coach', topic: 'travel' });

    // A real learner turn first, so the count matters.
    await session.send({ userMessage: 'I go to work by bus.' });
    const learnerTurnsBefore = countCommittedLearnerTurns(session);

    const result = await session.requestAssistance!({
      userMessage: '[LEARNER_HELP_REQUEST] give a hint',
    });

    expect(result.ok).toBe(true);
    const history = session.getHistory();
    expect(history[history.length - 1]).toEqual({
      role: 'assistant',
      content: 'Here is a small hint — no answer is given.',
    });
    expect(countCommittedLearnerTurns(session)).toBe(learnerTurnsBefore);
    // The help instruction itself never appears as a user message.
    expect(history.some((turn) => turn.role === 'user' && turn.content.includes('LEARNER_HELP_REQUEST'))).toBe(false);
  });

  it('strips feedback at the source and leaves the last real feedback untouched', async () => {
    const fakeFeedback = {
      overallAssessment: 'Good attempt',
      vocabulary: { headword: 'bus', type: 'word', meaning: 'a vehicle', example: 'I take the bus.' },
    };
    const orchestrator = mockOrchestrator(async () => okResult('answer one', fakeFeedback));
    const session = createConversationSession(orchestrator, { mode: 'coach' });

    const turn = await session.send({ userMessage: 'I go by bus.' });
    expect(turn.feedback).not.toBeNull();
    const lastBefore = session.getLastFeedback();

    const helpOrchestrator = mockOrchestrator(async () => okResult('hint here', fakeFeedback));
    const helpSession = createConversationSession(helpOrchestrator, { mode: 'coach' });
    const help = await helpSession.requestAssistance!({ userMessage: '[LEARNER_HELP_REQUEST] hint' });
    expect(help.ok).toBe(true);
    expect(help.feedback).toBeNull();
    // Even the committed RESPONSE object had feedback stripped at the source.
    expect((help as { response?: { feedback?: unknown } }).response?.feedback).toBeNull();
    // And the real learner feedback on the OTHER session path stays intact.
    expect(session.getLastFeedback()).toBe(lastBefore);
    expect(session.getLastFeedback()).not.toBeNull();
  });

  it('an empty help instruction is rejected before any provider call', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'coach' });
    const result = await session.requestAssistance!({ userMessage: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_request');
    expect(orchestrator.execute).not.toHaveBeenCalled();
    expect(session.getHistory()).toHaveLength(0);
  });

  it('help on a dead (abandoned) session is discarded with no writes', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'coach' });
    session.abandon!();
    const result = await session.requestAssistance!({ userMessage: 'hint please' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  it('a learner turn that lands while help is in flight wins: the late help is discarded', async () => {
    let releaseHelp: ((value: ConversationExecutionResult) => void) | null = null;
    const orchestrator = {
      execute: vi.fn((input: ConversationRequestInput) => {
        if (input.userMessage.includes('HELP')) {
          return new Promise<ConversationExecutionResult>((resolve) => {
            releaseHelp = resolve;
          });
        }
        return Promise.resolve(okResult('Tutor reply to the learner turn.'));
      }),
    } as unknown as ConversationOrchestrator & { execute: ReturnType<typeof vi.fn> };

    const session = createConversationSession(orchestrator, { mode: 'coach' });
    const pendingHelp = session.requestAssistance!({ userMessage: 'HELP: hint' });

    // The learner answers for real while help is still in flight.
    await session.send({ userMessage: 'My real answer.' });

    releaseHelp!(okResult('LATE scaffold that must be dropped.'));
    const result = await pendingHelp;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled');
      expect(result.error.message).toBe(CONVERSATION_ASSISTANCE_DISCARDED_MESSAGE);
      expect(result.error.retryable).toBe(true);
    }
    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Tutor reply to the learner turn.');
    // Nothing late was ever appended.
    expect(history.some((turn) => turn.content.includes('LATE scaffold'))).toBe(false);
  });

  it('provider failure during help records nothing and keeps history as it was', async () => {
    const orchestrator = {
      execute: vi.fn(async () => ({
        ok: false,
        error: { code: 'unavailable', message: 'provider offline', retryable: true },
      })),
    } as unknown as ConversationOrchestrator & { execute: ReturnType<typeof vi.fn> };
    const session = createConversationSession(orchestrator, { mode: 'coach' });
    await session.send({ userMessage: 'My answer.' });
    const before = session.getHistory();

    const failed = await session.requestAssistance!({ userMessage: 'hint' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.retryable).toBe(true);
    expect(session.getHistory()).toEqual(before);
  });
});

describe('setModeOverride — temporary correction change inside one live session', () => {
  it('changes only the mode of subsequent requests and never the config', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'intensive', topic: 'work' });

    await session.send({ userMessage: 'first' });
    expect(orchestrator.execute.mock.calls[0][0].mode).toBe('intensive');

    session.setModeOverride!('natural');
    await session.send({ userMessage: 'second' });
    expect(orchestrator.execute.mock.calls[1][0].mode).toBe('natural');

    // The session identity is untouched: same history, no recreation, config intact.
    expect(session.getConfig().mode).toBe('intensive');
    expect(session.getHistory()).toHaveLength(4);

    session.setModeOverride!(null);
    await session.send({ userMessage: 'third' });
    expect(orchestrator.execute.mock.calls[2][0].mode).toBe('intensive');
  });

  it('the override also applies to help requests and to openings (all request builders)', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'intensive' });
    session.setModeOverride!('natural');
    await session.openConversation!({ userMessage: 'open' });
    await session.requestAssistance!({ userMessage: 'hint' });
    const modes = orchestrator.execute.mock.calls.map((call: unknown[]) => (call[0] as { mode: string }).mode);
    expect(modes).toEqual(['natural', 'natural']);
  });

  it('an override alone never invalidates history or commits turns', async () => {
    const orchestrator = mockOrchestrator();
    const session = createConversationSession(orchestrator, { mode: 'coach' });
    await session.send({ userMessage: 'real turn' });
    const historyBefore = session.getHistory();
    session.setModeOverride!('natural');
    session.setModeOverride!('intensive');
    session.setModeOverride!(null);
    expect(session.getHistory()).toEqual(historyBefore);
    expect(countCommittedLearnerTurns(session)).toBe(1);
    expect(session.isAbandoned!()).toBe(false);
  });
});
