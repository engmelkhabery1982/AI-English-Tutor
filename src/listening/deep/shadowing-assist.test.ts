/**
 * src/listening/deep/shadowing-assist.test.ts
 *
 * Work Order 2 — learner-controlled shadowing assistance (reveal / meaning /
 * replay / save affordance state) is PRESENTATION-ONLY.
 *
 * The tests pair the pure assist reducers with the REAL ShadowingSession to
 * prove the hard requirement: every assist transition leaves the session's
 * attempt counts, automatic support progression and masked visibility
 * completely untouched — revealing the transcript supplements the automatic
 * support logic, it never replaces or resets it, and it is never an attempt.
 */

import { describe, expect, it } from 'vitest';
import {
  ShadowingSession,
} from './shadowing';
import {
  beginMeaningRequest,
  closeMeaning,
  curatedMeaning,
  hideTranscript,
  initialShadowingAssistState,
  meaningFailed,
  meaningLoaded,
  openMeaning,
  readableChunkFor,
  resetAssistForActivity,
  revealTranscript,
  toggleTranscript,
} from './shadowing-assist';

const CHUNK = 'She has been working here since March.';

function makeSession(support: 'full_transcript' | 'partial_transcript' | 'audio_only' = 'audio_only') {
  return new ShadowingSession({
    id: 'shadow-activity-1',
    chunk: CHUNK,
    canonicalWrittenForm: CHUNK,
    baseSupport: support,
  });
}

describe('transcript reveal — assistance, never an attempt', () => {
  it('reveal / hide / toggle are idempotent in the way the UI relies on', () => {
    let state = initialShadowingAssistState();
    expect(state.transcriptRevealed).toBe(false);

    state = revealTranscript(state);
    expect(state.transcriptRevealed).toBe(true);
    const afterFirst = state;
    // Repeated reveal taps change NOTHING (no double counting, no re-render payload).
    expect(revealTranscript(state)).toBe(afterFirst);

    state = hideTranscript(state);
    expect(state.transcriptRevealed).toBe(false);
    // Repeated hide taps are equally inert.
    expect(hideTranscript(state)).toBe(state);

    state = toggleTranscript(state);
    expect(state.transcriptRevealed).toBe(true);
    state = toggleTranscript(state);
    expect(state.transcriptRevealed).toBe(false);
  });

  it('assistUses counts fresh reveals for presentation only', () => {
    let state = initialShadowingAssistState();
    state = revealTranscript(state);
    state = revealTranscript(state);
    expect(state.assistUses).toBe(1);
    state = toggleTranscript(state); // hide
    state = toggleTranscript(state); // reveal again
    expect(state.assistUses).toBe(2);
  });

  it('a manual reveal SUPPLEMENTS the automatic visibility (full chunk wins while open)', () => {
    const session = makeSession('audio_only');
    // Without a reveal the learner reads exactly what the session allows.
    expect(readableChunkFor(session, initialShadowingAssistState())).toBe(session.visibleChunk);
    expect(session.visibleChunk).toBeNull(); // audio_only at this support level

    const revealed = readableChunkFor(session, revealTranscript(initialShadowingAssistState()));
    expect(revealed).toBe(CHUNK);
  });

  it('revealing never mutates the ShadowingSession (counts, support, visibility)', () => {
    const session = makeSession('partial_transcript');
    const visibleBefore = session.visibleChunk;
    const supportBefore = session.support;
    const attemptsBefore = session.attemptCount;
    const replaysBefore = session.replayCount;

    let state = initialShadowingAssistState();
    for (const step of [revealTranscript, openMeaning, closeMeaning, hideTranscript]) {
      state = step(state);
    }

    expect(session.attemptCount).toBe(attemptsBefore);
    expect(session.replayCount).toBe(replaysBefore);
    expect(session.support).toBe(supportBefore);
    expect(session.visibleChunk).toBe(visibleBefore);
  });
});

describe('meaning card — curated first, generated honestly marked', () => {
  it('curated activity explanations are used when present, never invented otherwise', () => {
    expect(curatedMeaning({ explanation: '  It means she started in March and still works here.  ' })).toBe(
      'It means she started in March and still works here.',
    );
    expect(curatedMeaning({ explanation: '   ' })).toBeNull();
    expect(curatedMeaning({})).toBeNull();
    expect(curatedMeaning(null)).toBeNull();
  });

  it('request lifecycle: idle → loading → ready keeps the generated marker', () => {
    let state = initialShadowingAssistState();
    state = openMeaning(state);
    expect(state.meaningVisible).toBe(true);
    state = beginMeaningRequest(state);
    expect(state.meaningStatus).toBe('loading');
    state = meaningLoaded(state, 'It talks about an activity that started in the past and continues now.', true);
    expect(state.meaningStatus).toBe('ready');
    expect(state.meaningIsGenerated).toBe(true);
    expect(state.meaningError).toBeNull();
  });

  it('failure keeps existing text, offers retry, and a retry attempt clears the error', () => {
    let state = meaningLoaded(beginMeaningRequest(initialShadowingAssistState()), 'First explanation.', false);
    state = beginMeaningRequest(state);
    state = meaningFailed(state, 'The tutor could not prepare an explanation right now.');
    expect(state.meaningStatus).toBe('failed');
    expect(state.canRetryMeaning).toBe(true);
    expect(state.meaningText).toBe('First explanation.'); // never destroyed
    expect(state.meaningIsGenerated).toBe(false); // keeps the HONEST label of what stays

    state = beginMeaningRequest(state);
    expect(state.meaningError).toBeNull();
    expect(state.canRetryMeaning).toBe(false);
    expect(state.meaningStatus).toBe('loading');
  });

  it('a totally failed generation defaults to a friendly sentence, not a raw error', () => {
    const failed = meaningFailed(initialShadowingAssistState(), null);
    expect(failed.meaningError).toBeTruthy();
    expect(failed.meaningError).not.toMatch(/error 0x|HTTP|undefined|null/i);
  });
});

describe('activity boundaries — stale assist can never leak', () => {
  it('resetAssistForActivity returns a clean state for the next activity', () => {
    let state = revealTranscript(openMeaning(initialShadowingAssistState()));
    state = meaningLoaded(
      beginMeaningRequest(state),
      'Explanation of the OLD chunk.',
      true,
    );

    const next = resetAssistForActivity();
    expect(next).toEqual(initialShadowingAssistState());
    expect(next.transcriptRevealed).toBe(false);
    expect(next.meaningVisible).toBe(false);
    expect(next.meaningText).toBeNull();
    expect(next.meaningIsGenerated).toBe(false);
    // The old state object itself is untouched (pure reducers).
    expect(state.meaningText).toBe('Explanation of the OLD chunk.');
  });

  it('replay stays practice, assist state stays separate: reveal never records a replay', () => {
    const session = makeSession('full_transcript');
    const state = revealTranscript(initialShadowingAssistState());
    expect(session.replayCount).toBe(0);
    expect(session.attemptCount).toBe(0);
    expect(readableChunkFor(session, state)).toBe(CHUNK);
    // And a REAL replay (playback path) counts as practice, never as an attempt:
    session.recordReplay();
    expect(session.replayCount).toBe(1);
    expect(session.attemptCount).toBe(0);
  });
});
