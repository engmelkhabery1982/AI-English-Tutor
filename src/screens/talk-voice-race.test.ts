/**
 * src/screens/talk-voice-race.test.ts
 *
 * Source contracts for the Talk session-transition / mic race fixes
 * (Package 1, A). The repository has no React Native renderer (see
 * src/test-setup.ts), so — like reliability-contracts.test.ts — these tests
 * pin the wiring in the screen source. The runtime behavior of the queued
 * intent itself is covered by src/voice/mic-intent.test.ts and
 * src/voice/mic-race.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TALK = readFileSync(join(__dirname, 'TalkScreen.tsx'), 'utf8');

const startConversationBody = TALK.slice(
  TALK.indexOf('const startConversation = useCallback'),
  TALK.indexOf('const topicEditable'),
);
const micHandlerBody = TALK.slice(
  TALK.indexOf('const handleToggleRecording = async () => {'),
  TALK.indexOf('const handleRetryVoiceTurn = async () => {'),
);

describe('Talk mic race — synchronous transition guard', () => {
  it('guards the mic handler with the synchronous switching ref, not only React state', () => {
    // The synchronous mirror is checked inside the mic handler…
    expect(micHandlerBody).toContain('if (coordinatorIsSwitchingRef.current) {');
    // …BEFORE any session work happens in the handler.
    expect(micHandlerBody.indexOf('coordinatorIsSwitchingRef.current')).toBeLessThan(
      micHandlerBody.indexOf('sessionRef.current'),
    );
    // The old async-only guard is gone: React state can be stale in this handler.
    expect(TALK).not.toContain('if (!session || isSwitching) return;');
  });

  it('serializes mic actions: at most one in flight (rapid taps)', () => {
    expect(micHandlerBody).toContain('if (micActionInFlightRef.current) return;');
    expect(micHandlerBody).toContain('micActionInFlightRef.current = true;');
    expect(micHandlerBody).toContain('micActionInFlightRef.current = false;');
  });

  it('reads the live coordinator status for the record/stop branch decision', () => {
    expect(micHandlerBody).toContain('const status = coordinator.getStatus();');
    expect(micHandlerBody).toContain("if (status.state === 'recording') {");
    expect(micHandlerBody).toContain('} else if (status.canRecord) {');
  });
});

describe('Talk mic race — queued mic intent during a transition', () => {
  it('queues exactly ONE intent bound to the active switch token, with a visible message', () => {
    expect(micHandlerBody).toContain('micIntentRef.current.queue(switchTokenRef.current);');
    expect(micHandlerBody).toContain('setErrorMessage(TALK_MIC_QUEUED_MESSAGE);');
    expect(TALK).toContain(
      "'Just a moment — recording will start as soon as your conversation is ready.'",
    );
  });

  it('executes the queued intent only when the owning transition installs its session', () => {
    expect(startConversationBody).toContain('micIntentRef.current.consume(switchToken)');
    expect(startConversationBody).toContain(
      'void startRecordingTurn(bundle.session, bundle.providerKind);',
    );
  });

  it('a newer transition drops a pending intent instead of running it on a stale session', () => {
    // Cleared at the start of every transition…
    expect(startConversationBody).toContain('micIntentRef.current.clear();');
    // …and on the not-installed path.
    expect(startConversationBody.indexOf('micIntentRef.current.clear();')).toBeLessThan(
      startConversationBody.indexOf('return null;'),
    );
  });
});

describe('Talk mic race — stale transition cannot install Conversation Review', () => {
  it('revalidates the switch token BEFORE installing review/session UI', () => {
    const revalidateAt = startConversationBody.indexOf(
      'if (switchToken !== switchTokenRef.current) {',
    );
    const reviewAt = startConversationBody.indexOf('setConversationReview(outcome.review);');
    const coordinatorAt = startConversationBody.indexOf(
      'getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);',
    );
    const sessionInstallAt = startConversationBody.indexOf('sessionRef.current = bundle.session;');
    expect(revalidateAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);
    expect(revalidateAt).toBeLessThan(reviewAt);
    expect(revalidateAt).toBeLessThan(coordinatorAt);
    expect(revalidateAt).toBeLessThan(sessionInstallAt);
  });

  it('keeps the existing not-installed guard ahead of every installation too', () => {
    const notInstalledAt = startConversationBody.indexOf('if (!outcome.installed) {');
    expect(notInstalledAt).toBeGreaterThan(-1);
    expect(notInstalledAt).toBeLessThan(
      startConversationBody.indexOf('setConversationReview(outcome.review);'),
    );
  });
});
