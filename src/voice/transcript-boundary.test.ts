/**
 * src/voice/transcript-boundary.test.ts
 *
 * Regression tests for the empty-transcript defense in depth (Package 1, B):
 * a missing, empty or whitespace-only transcript must NEVER reach
 * `session.send()`, never create a learner message ("You said: \"\""), never
 * create evidence, and never advance the turn — on ANY coordinator path.
 *
 * The earlier guard (runSpokenTurn) is exercised through the public voice
 * pipeline; the FINAL boundary (submitTranscript, the last point before
 * session.send) is additionally exercised directly so the defense in depth is
 * pinned even for callers that bypass the earlier guard.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_EMPTY_TRANSCRIPT_MESSAGE,
  createVoiceSessionCoordinator,
  type VoiceSessionCoordinator,
} from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { countCommittedLearnerTurns } from '../conversation-session';
import { createTalkSession } from '../talk-demo';
import type { SpeechToTextProvider, STTResult } from '../providers/stt';

function createStubSTT(result: STTResult): SpeechToTextProvider {
  return {
    id: 'stub-stt',
    async transcribe(): Promise<STTResult> {
      return result;
    },
  };
}

function createHarness(stt: SpeechToTextProvider) {
  const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
  const sendSpy = vi.spyOn(session, 'send');
  const coordinator = createVoiceSessionCoordinator({
    session,
    recorder: createDemoAudioRecorder(),
    sttProvider: stt,
    ttsProvider: createDemoTTSProvider(),
  });
  return { session, sendSpy, coordinator };
}

/** Drives the public voice pipeline up to the submission boundary. */
async function spokenTurn(coordinator: VoiceSessionCoordinator) {
  await coordinator.startRecording();
  return coordinator.stopRecordingAndProcess();
}

describe('empty transcript never reaches session.send() — public voice pipeline', () => {
  it('STT success with an EMPTY transcript: no send, no message, no evidence', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: '' }),
    );

    const result = await spokenTurn(coordinator);

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(session.getHistory()).toEqual([]);
    expect(countCommittedLearnerTurns(session)).toBe(0);
    expect(session.getLastFeedback()).toBeNull();
    // The learner returns to a usable state with the recording preserved.
    expect(coordinator.getStatus().state).toBe('error');
    expect(coordinator.getStatus().canRetryTranscription).toBe(true);

    await coordinator.dispose();
  });

  it('STT success with a WHITESPACE-ONLY transcript: no send, no message, no evidence', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: '  \n\t  ' }),
    );

    const result = await spokenTurn(coordinator);

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(session.getHistory()).toEqual([]);
    expect(countCommittedLearnerTurns(session)).toBe(0);
    expect(coordinator.getStatus().state).toBe('error');

    await coordinator.dispose();
  });

  it('STT failure with a MISSING transcript: no send, no message, no evidence', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: false, error: 'No speech detected.' }),
    );

    const result = await spokenTurn(coordinator);

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(session.getHistory()).toEqual([]);
    expect(countCommittedLearnerTurns(session)).toBe(0);
    expect(coordinator.getStatus().recognizedTranscript).toBeNull();

    await coordinator.dispose();
  });

  it('a VALID transcript still flows through to session.send exactly once', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: 'I practice English every day.' }),
    );

    const result = await spokenTurn(coordinator);

    expect(result.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(countCommittedLearnerTurns(session)).toBe(1);

    await coordinator.dispose();
  });
});

describe('FINAL submission boundary (submitTranscript) — defense in depth', () => {
  // The final boundary is the last point before session.send(); these tests
  // call it directly to prove that NO caller — present or future — can commit
  // an empty learner turn through it.
  interface SubmitBoundary {
    submitTranscript(input: {
      readonly transcript: string;
      readonly session: ReturnType<typeof createTalkSession>['session'];
      readonly generation: number;
    }): Promise<{ ok: boolean; error?: string }>;
  }

  function boundaryOf(coordinator: VoiceSessionCoordinator): {
    submit: SubmitBoundary['submitTranscript'];
    generation: number;
  } {
    const anyCoordinator = coordinator as unknown as {
      submitTranscript: SubmitBoundary['submitTranscript'];
      generation: number;
    };
    return {
      submit: anyCoordinator.submitTranscript.bind(coordinator),
      generation: anyCoordinator.generation,
    };
  }

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t '],
  ])('rejects a %s transcript without calling session.send', async (_label, transcript) => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: 'unused' }),
    );
    const { submit, generation } = boundaryOf(coordinator);

    const result = await submit({ transcript, session, generation });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(VOICE_EMPTY_TRANSCRIPT_MESSAGE);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(session.getHistory()).toEqual([]);
    expect(coordinator.getStatus().state).toBe('error');
    expect(coordinator.getStatus().errorMessage).toBe(VOICE_EMPTY_TRANSCRIPT_MESSAGE);

    await coordinator.dispose();
  });

  it('rejects a missing (non-string) transcript without calling session.send', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: 'unused' }),
    );
    const { submit, generation } = boundaryOf(coordinator);

    const result = await submit({
      transcript: undefined as unknown as string,
      session,
      generation,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(VOICE_EMPTY_TRANSCRIPT_MESSAGE);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(session.getHistory()).toEqual([]);

    await coordinator.dispose();
  });

  it('a whitespace-padded VALID transcript is trimmed, committed exactly once', async () => {
    const { session, sendSpy, coordinator } = createHarness(
      createStubSTT({ ok: true, transcript: 'unused' }),
    );
    const { submit, generation } = boundaryOf(coordinator);

    const result = await submit({
      transcript: '  I practice English every day.  ',
      session,
      generation,
    });

    expect(result.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toEqual({
      userMessage: 'I practice English every day.',
    });
    expect(countCommittedLearnerTurns(session)).toBe(1);

    await coordinator.dispose();
  });
});
