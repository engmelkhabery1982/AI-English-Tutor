/**
 * src/voice/coordinator-recovery.test.ts
 *
 * Recovery-contract tests for the voice turn pipeline (Work Order 1, items 3, 4,
 * 6 and 7).
 *
 * What is pinned here
 * - a FAILED TRANSCRIPTION preserves the recording: the learner retries the SAME
 *   audio instead of speaking twice, and a transcription-only capture stays
 *   transcription-only on retry (it can never become a conversation turn);
 * - a FAILED TUTOR REPLY preserves the learner's OWN transcript: an explicit
 *   Retry sends exactly that turn once, "Type instead" hands it over as editable
 *   text, and a transcript that really committed is never sent a second time;
 * - at most ONE short automatic retry, only for transient failures and only while
 *   nothing was committed; quota failures are never replayed automatically;
 * - preserved recovery state is dropped by a new utterance, a session switch,
 *   backgrounding and disposal, so it can never be replayed into another
 *   conversation;
 * - duplicate taps and retries while a turn is unresolved are refused.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createVoiceSessionCoordinator,
  VOICE_NOTHING_TO_RETRY_MESSAGE,
  VOICE_NOTHING_TO_STOP_MESSAGE,
  type VoiceSessionCoordinator,
} from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createDemoTTSProvider } from '../providers/tts/demo';
import type { SpeechToTextProvider, STTAudioInput, STTResult } from '../providers/stt';
import { createTalkSession } from '../talk-demo';
import type { ConversationSession, ConversationSessionResult } from '../conversation-session';

const TRANSCRIPT = 'Yesterday I went to a meeting with my manager.';
const QUOTA_FAILURE: ConversationSessionResult = {
  ok: false,
  error: {
    code: 'unavailable',
    message: 'AI Provider quota exceeded or unavailable.',
    retryable: false,
  },
  history: [],
};

/** An STT provider that counts calls and can fail a chosen number of times. */
function countingSTT(options: {
  readonly transcript?: string;
  readonly failures?: readonly string[];
}): SpeechToTextProvider & { readonly calls: number } {
  const failures = [...(options.failures ?? [])];
  const inner = createDemoSTTProvider({ defaultTranscript: options.transcript ?? TRANSCRIPT });
  const wrapper = {
    id: 'counting-stt',
    calls: 0,
    async transcribe(input: STTAudioInput): Promise<STTResult> {
      wrapper.calls += 1;
      const failure = failures.shift();
      if (failure !== undefined) return { ok: false, error: failure };
      return inner.transcribe(input);
    },
  };
  return wrapper;
}

function compose(options?: {
  readonly stt?: SpeechToTextProvider;
  readonly session?: ConversationSession;
  readonly isMuted?: boolean;
}): {
  coordinator: VoiceSessionCoordinator;
  session: ConversationSession;
} {
  const { session } = options?.session
    ? { session: options.session }
    : createTalkSession({ mode: 'natural' }, { isDemo: true });
  const coordinator = createVoiceSessionCoordinator({
    session,
    recorder: createDemoAudioRecorder(),
    sttProvider: options?.stt ?? createDemoSTTProvider({ defaultTranscript: TRANSCRIPT }),
    ttsProvider: createDemoTTSProvider(),
    ...(options?.isMuted === undefined ? {} : { isMuted: options.isMuted }),
  });
  return { coordinator, session };
}

const learnerTurns = (session: ConversationSession) =>
  session.getHistory().filter((turn) => turn.role === 'user');

describe('voice recovery — a failed transcription preserves the recording', () => {
  it('keeps the recording and offers a transcription retry', async () => {
    const stt = countingSTT({ failures: ['Audio was not clear'] });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('unrecognized_speech');
    expect(session.getHistory()).toEqual([]);
    // Nothing was transcribed, so there is no transcript to preserve…
    expect(coordinator.getStatus().pendingTranscript).toBeNull();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    // …but the recording survived for an explicit retry.
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);
    // A no-speech failure is not transient: it was tried exactly once.
    expect(stt.calls).toBe(1);
  });

  it('transcribes the SAME recording again and commits exactly one learner turn', async () => {
    const stt = countingSTT({ failures: ['Request timed out after 20000ms', 'socket hang up'] });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    const first = await coordinator.stopRecordingAndProcess();
    expect(first.ok).toBe(false);
    // ONE automatic retry already happened (transient), then it stopped.
    expect(stt.calls).toBe(2);

    const retry = await coordinator.retryTranscription();

    expect(retry.ok).toBe(true);
    expect(retry.transcript).toBe(TRANSCRIPT);
    expect(learnerTurns(session)).toHaveLength(1);
    expect(learnerTurns(session)[0]?.content).toBe(TRANSCRIPT);
    // The learner spoke once; the same audio was used for every attempt.
    expect(stt.calls).toBe(3);
    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
    expect(coordinator.getStatus().pendingTranscript).toBeNull();
  });

  it('keeps a transcription-only capture transcription-only on retry', async () => {
    const stt = countingSTT({ failures: ['Audio was not clear'] });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    const first = await coordinator.stopRecordingAndTranscribe();
    expect(first.ok).toBe(false);
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);

    const retry = await coordinator.retryTranscription();

    expect(retry.ok).toBe(true);
    expect(retry.transcript).toBe(TRANSCRIPT);
    // The repeat never entered the conversation: no learner turn, no tutor reply.
    expect(session.getHistory()).toEqual([]);
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
  });

  it('reports honestly when there is nothing preserved to retry', async () => {
    const { coordinator } = compose({ isMuted: true });

    const retry = await coordinator.retryTranscription();

    expect(retry.ok).toBe(false);
    expect(retry.error).toBe(VOICE_NOTHING_TO_RETRY_MESSAGE);
    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
  });

  it('performs exactly ONE automatic retry for a transient failure and no more', async () => {
    const stt = countingSTT({ failures: ['Service unavailable, try again later'] });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    // The single automatic retry succeeded: the learner did nothing and the turn
    // committed exactly once.
    expect(result.ok).toBe(true);
    expect(stt.calls).toBe(2);
    expect(learnerTurns(session)).toHaveLength(1);
  });

  it('never replays a persistent transient failure a third time', async () => {
    const stt = countingSTT({
      failures: ['Network request failed', 'Network request failed', 'Network request failed'],
    });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(stt.calls).toBe(2);
    expect(session.getHistory()).toEqual([]);
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);
  });
});

describe('voice recovery — a failed tutor reply preserves the transcript', () => {
  it('preserves the learner transcript and offers an explicit retry', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    const send = vi.spyOn(session, 'send').mockResolvedValueOnce(QUOTA_FAILURE);

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(result.transcript).toBe(TRANSCRIPT);
    expect(result.failure?.kind).toBe('service_busy');
    expect(result.error).toBe(
      'The tutor service is busy right now. Your answer was not lost. Try again.',
    );
    expect(coordinator.getStatus().pendingTranscript).toBe(TRANSCRIPT);
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(true);
    // A quota failure is NEVER replayed automatically.
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.getHistory()).toEqual([]);
  });

  it('resends the SAME transcript exactly once on an explicit retry', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    // The first send fails honestly; the retry goes through the REAL session so
    // the committed turn is the genuine article.
    const originalSend = session.send.bind(session);
    const sent: string[] = [];
    vi.spyOn(session, 'send').mockImplementation(async (input, onChunk) => {
      sent.push(input.userMessage);
      if (sent.length === 1) return QUOTA_FAILURE;
      return originalSend(input, onChunk);
    });

    await coordinator.startRecording();
    const failed = await coordinator.stopRecordingAndProcess();
    expect(failed.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);

    const retry = await coordinator.retryPendingTurn();

    expect(retry.ok).toBe(true);
    // Exactly one replay, of exactly the learner's own words.
    expect(sent).toEqual([TRANSCRIPT, TRANSCRIPT]);
    expect(learnerTurns(session)).toHaveLength(1);
    expect(learnerTurns(session)[0]?.content).toBe(TRANSCRIPT);
    expect(coordinator.getStatus().pendingTranscript).toBeNull();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
  });

  it('never resends a transcript that already committed', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    const send = vi.spyOn(session, 'send').mockResolvedValueOnce(QUOTA_FAILURE);

    await coordinator.startRecording();
    const failed = await coordinator.stopRecordingAndProcess();
    expect(failed.ok).toBe(false);
    expect(coordinator.getStatus().pendingTranscript).toBe(TRANSCRIPT);

    // The turn really landed after all (an uncertain outcome reported as failure).
    send.mockRestore();
    await session.send({ userMessage: TRANSCRIPT });
    expect(learnerTurns(session)).toHaveLength(1);

    const retry = await coordinator.retryPendingTurn();

    expect(retry.ok).toBe(true);
    expect(retry.transcript).toBe(TRANSCRIPT);
    // Reported as committed WITHOUT a second send: no duplicate learner turn.
    expect(learnerTurns(session)).toHaveLength(1);
    expect(coordinator.getStatus().pendingTranscript).toBeNull();
  });

  it('hands the transcript over as editable text and prevents a second send', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    const send = vi.spyOn(session, 'send').mockResolvedValueOnce(QUOTA_FAILURE);

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    // "Type instead": the learner reviews/edits their own words in the composer.
    expect(coordinator.takePendingTranscript()).toBe(TRANSCRIPT);
    expect(coordinator.getStatus().pendingTranscript).toBeNull();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    expect(coordinator.getStatus().state).not.toBe('error');

    // The same utterance can no longer be sent a second time by a voice retry.
    const retry = await coordinator.retryPendingTurn();
    expect(retry.ok).toBe(false);
    expect(retry.error).toBe(VOICE_NOTHING_TO_RETRY_MESSAGE);
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.getHistory()).toEqual([]);
  });

  it('refuses a retry while the previous turn is still unresolved', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    let release: (value: ConversationSessionResult) => void = () => undefined;
    const gate = new Promise<ConversationSessionResult>((resolve) => {
      release = resolve;
    });
    vi.spyOn(session, 'send').mockImplementation(() => gate);

    await coordinator.startRecording();
    const inFlight = coordinator.stopRecordingAndProcess();

    const refused = await coordinator.retryPendingTurn();
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('Your previous answer is still being processed.');
    expect(coordinator.getStatus().isProcessing).toBe(true);

    release(QUOTA_FAILURE);
    const settled = await inFlight;
    expect(settled.ok).toBe(false);
    expect(coordinator.getStatus().pendingTranscript).toBe(TRANSCRIPT);
  });
});

describe('voice recovery — preserved state never outlives its conversation', () => {
  it('a new utterance supersedes the preserved transcript', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    vi.spyOn(session, 'send').mockResolvedValueOnce(QUOTA_FAILURE);

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(true);

    // The learner chooses to speak again: the preserved turn is dropped so the
    // same utterance can never be committed twice.
    await coordinator.startRecording();

    expect(coordinator.getStatus().pendingTranscript).toBeNull();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
  });

  it('a new utterance supersedes a preserved recording', async () => {
    const stt = countingSTT({ failures: ['Audio was not clear'] });
    const { coordinator } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndTranscribe();
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);

    await coordinator.startRecording();

    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
  });

  it('a session switch clears both preserved states', async () => {
    const stt = countingSTT({ failures: ['Audio was not clear'] });
    const { coordinator, session } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndTranscribe();
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);

    const next = createTalkSession({ mode: 'coach' }, { isDemo: true }).session;
    await coordinator.switchSession(next);

    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    // The retry now honestly reports that nothing is preserved.
    const retry = await coordinator.retryTranscription();
    expect(retry.ok).toBe(false);
    expect(retry.error).toBe(VOICE_NOTHING_TO_RETRY_MESSAGE);
    expect(session.getHistory()).toEqual([]);
  });

  it('backgrounding clears both preserved states', async () => {
    const { coordinator, session } = compose({ isMuted: true });
    vi.spyOn(session, 'send').mockResolvedValueOnce(QUOTA_FAILURE);

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(true);

    coordinator.handleBackground();

    expect(coordinator.getStatus().pendingTranscript).toBeNull();
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
    // The background policy leaves no error on the surface (pinned elsewhere).
    expect(coordinator.getStatus().errorMessage).toBeNull();
  });

  it('disposal clears both preserved states', async () => {
    const stt = countingSTT({ failures: ['Audio was not clear'] });
    const { coordinator } = compose({ stt, isMuted: true });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndTranscribe();
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);

    await coordinator.dispose();

    expect(coordinator.getStatus().canRetryTranscription).toBe(false);
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(false);
    const retry = await coordinator.retryTranscription();
    expect(retry.ok).toBe(false);
  });
});

describe('voice recovery — duplicate taps are refused', () => {
  it('refuses a second stop for the same utterance', async () => {
    const { coordinator, session } = compose({ isMuted: true });

    await coordinator.startRecording();
    const first = await coordinator.stopRecordingAndProcess();
    const second = await coordinator.stopRecordingAndProcess();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toBe(VOICE_NOTHING_TO_STOP_MESSAGE);
    // One utterance = exactly one learner turn.
    expect(learnerTurns(session)).toHaveLength(1);
  });

  it('refuses a stop when nothing is recording', async () => {
    const { coordinator, session } = compose({ isMuted: true });

    const result = await coordinator.stopRecordingAndTranscribe();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(VOICE_NOTHING_TO_STOP_MESSAGE);
    expect(session.getHistory()).toEqual([]);
  });
});
