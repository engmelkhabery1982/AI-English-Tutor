/**
 * src/screens/reliability-contracts.test.ts
 *
 * Source contracts for the reliability work (Work Order 1).
 *
 * The RN test setup in this repository has no renderer (see src/test-setup.ts),
 * so — exactly like src/screens/product-ux.test.ts — these tests pin the
 * *wiring* of the fixed failure modes in the screen sources: which owner holds
 * learner input, where errors are classified, which recovery actions exist, and
 * which raw-detail paths must never be rendered.
 *
 * Each contract names the bug it keeps shut.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

const ONBOARDING = read(join('OnboardingScreen.tsx'));
const TALK = read(join('TalkScreen.tsx'));
const FLUENCY = read(join('FluencyPracticeScreen.tsx'));

const SCREENS: readonly [string, string][] = [
  ['OnboardingScreen', ONBOARDING],
  ['TalkScreen', TALK],
  ['FluencyPracticeScreen', FLUENCY],
];

/** Every mention of raw diagnostic detail must be a log line, never JSX. */
function technicalMentions(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\btechnical\b/.test(line))
    .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'));
}

describe('reliability contracts — raw provider detail never reaches the learner', () => {
  it.each(SCREENS)('%s logs technical detail instead of rendering it', (_name, source) => {
    const mentions = technicalMentions(source);
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line).toContain('console.error');
      expect(line).not.toContain('<Text');
      expect(line).not.toMatch(/set(TurnError|ErrorMessage|LoadMessage|StartFailure)/);
    }
  });

  it.each(SCREENS)(
    '%s routes learner-facing failure text through the ONE provider-failure path',
    (_name, source) => {
      // Either the classifier itself, or the single owner that classifies for this
      // surface (the assessment's typed-answer commit controller).
      expect(
        /classifyProviderFailure|learnerMessageForFailure|createAssessmentAnswerController/.test(
          source,
        ),
      ).toBe(true);
    },
  );

  it('TalkScreen no longer surfaces the raw provider message', () => {
    expect(TALK).not.toContain("result.error.message || 'The tutor returned an error");
    expect(TALK).toContain("learnerMessageForFailure(result.error, 'tutor')");
  });

  it('OnboardingScreen no longer surfaces the raw assessment failure text', () => {
    expect(ONBOARDING).not.toContain('setTurnError(outcome.errorMessage ??');
    // The typed answer failure text comes from the commit controller, which
    // classifies through the catalog.
    expect(ONBOARDING).toContain('createAssessmentAnswerController');
    expect(ONBOARDING).toContain('answerState.learnerMessage');
  });

  it('FluencyPracticeScreen no longer surfaces the raw attempt failure text', () => {
    expect(FLUENCY).not.toContain('setErrorMessage(result.errorMessage)');
    expect(FLUENCY).toContain("classifyProviderFailure(result.errorMessage ?? null, 'practice')");
  });
});

describe('reliability contracts — assessment typed answer (bug: text cleared before commit)', () => {
  it('binds the answer box to the commit controller, not to a loose state', () => {
    expect(ONBOARDING).toContain('value={answerState.draft}');
    expect(ONBOARDING).toContain('onChangeText={answerController.setDraft}');
    // The old unconditional clear is gone: nothing empties the box on failure.
    expect(ONBOARDING).not.toContain("setTextAnswer('')");
    expect(ONBOARDING).not.toContain('const [textAnswer, setTextAnswer]');
  });

  it('keeps the answer editable while a failure is shown and offers an explicit Retry', () => {
    expect(ONBOARDING).toContain('await answerController.submit();');
    expect(ONBOARDING).toContain('await answerController.retry();');
    expect(ONBOARDING).toContain('accessibilityLabel="Retry sending my typed answer"');
    expect(ONBOARDING).toContain('Your answer is still in the box. You can edit it, then send it again.');
  });

  it('keeps evidence absorption bound to committed history and captured step tokens', () => {
    expect(ONBOARDING).toContain('await handle.speaking.observeCommittedHistory({ purpose });');
    expect(ONBOARDING).toContain('stepToken: handle.session.getCurrentStepToken()');
    expect(ONBOARDING).toContain('countCommittedLearnerTurns(handle.conversation)');
    // A turn that committed but produced no evidence says so honestly instead of
    // pretending nothing happened (and instead of resending the same answer).
    expect(ONBOARDING).toContain('ASSESSMENT_SHORT_ANSWER_MESSAGE');
  });

  it('gives voice failures explicit recovery in the assessment too', () => {
    expect(ONBOARDING).toContain('accessibilityLabel="Send my transcribed answer again"');
    expect(ONBOARDING).toContain('accessibilityLabel="Review my transcribed answer as text"');
    expect(ONBOARDING).toContain('accessibilityLabel="Transcribe my last recording again"');
    // A pronunciation repeat is transcription-only: never offered as typed text.
    expect(ONBOARDING).toContain('renderVoiceRecovery({ allowTypeInstead: false })');
    expect(ONBOARDING).toContain('renderVoiceRecovery({ allowTypeInstead: true })');
  });
});

describe('reliability contracts — Talk conversation identity (bug: "conversation was replaced")', () => {
  it('composes from the APPLIED topic, never from the typed draft', () => {
    expect(TALK).toContain('resolveConversationIdentity({');
    expect(TALK).toContain('void startConversation(mode, appliedTopic);');
    // The old per-keystroke composition is gone.
    expect(TALK).not.toContain('void startConversation(mode, topic);\n    }');
    expect(TALK).not.toContain('`${mode}::${topic.trim()}`');
  });

  it('keeps the identity stable while any turn work is unresolved', () => {
    expect(TALK).toContain('turnInFlight: isSending || isOpening || isSwitching || voiceBusy');
    expect(TALK).toMatch(/voiceStatus\.state === 'recording'/);
    expect(TALK).toMatch(/voiceStatus\.state === 'transcribing'/);
    expect(TALK).toMatch(/voiceStatus\.isProcessing/);
  });

  it('offers an explicit Apply for a drafted topic', () => {
    expect(TALK).toContain('const handleApplyTopic = () => {');
    expect(TALK).toContain('hasUnappliedTopicDraft');
    expect(TALK).toContain('accessibilityLabel="Start the conversation with this topic"');
    // …and never applies while a turn is in flight.
    expect(TALK).toContain('if (isSending || isOpening || isSwitching) return; // never replace mid-turn');
  });

  it('recovers a conversation that was closed underneath the surface', () => {
    // Both turn entry points check the session before starting work.
    expect(TALK.match(/isConversationReusable\(session\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(TALK).toContain('TALK_CONVERSATION_RESTARTED_MESSAGE');
    expect(TALK).toContain('TALK_CONVERSATION_RESTARTED_MIC_MESSAGE');
  });

  it('preserves the typed message until it really commits', () => {
    // A replacement no longer empties the composer.
    const startConversation = TALK.slice(
      TALK.indexOf('const startConversation = useCallback'),
      TALK.indexOf('const topicEditable'),
    );
    expect(startConversation).not.toContain("setInputText('')");
    expect(startConversation).toContain('The composer draft is deliberately PRESERVED');
    // Every non-committing send path restores the learner's own text.
    expect(TALK.match(/setInputText\(trimmedMessage\)/g)?.length).toBeGreaterThanOrEqual(3);
    // …and an explicit Retry resends exactly that message.
    expect(TALK).toContain('const handleRetryMessage = async () => {');
    expect(TALK).toContain('accessibilityLabel="Retry sending my message"');
    // A retry verifies the commit state first, so it cannot duplicate a turn.
    expect(TALK).toContain('countCommittedLearnerTurns(session) > retryBaselineRef.current');
    // A double tap is refused synchronously.
    expect(TALK).toContain('sendInFlightRef.current');
  });

  it('offers voice recovery actions on the Talk surface', () => {
    expect(TALK).toContain('voiceStatus.canRetryPendingTurn');
    expect(TALK).toContain('voiceStatus.canRetryTranscription');
    expect(TALK).toContain('coordinator.retryPendingTurn(');
    expect(TALK).toContain('coordinator.retryTranscription(');
    expect(TALK).toContain('coordinator.takePendingTranscript()');
    expect(TALK).toContain('accessibilityLabel="Type my transcribed answer instead"');
  });
});

describe('reliability contracts — fluency practice start (bug: practice does not start)', () => {
  it('reports a failed start as an actionable, classified failure with Retry', () => {
    expect(FLUENCY).toContain('setStartFailure({');
    expect(FLUENCY).toContain('accessibilityLabel="Retry starting this practice task"');
    expect(FLUENCY).toContain('void handleStartTask(startFailure.taskId)');
    expect(FLUENCY).toContain('isConfigurationFailure(failure)');
    expect(FLUENCY).toContain('Nothing was counted and no practice session was left open.');
  });

  it('never swallows the real reason for a failed start', () => {
    expect(FLUENCY).not.toContain("'This task could not be started. Please try again.'");
    expect(FLUENCY).toContain('} catch (err: unknown) {');
    expect(FLUENCY).toContain("console.error('Fluency task start failed:', failure.technical)");
  });

  it('keeps a typed answer when it cannot be sent', () => {
    // The guards run BEFORE the composer is cleared.
    const typed = FLUENCY.slice(
      FLUENCY.indexOf('const handleSendTyped = useCallback'),
      FLUENCY.indexOf('/* ------------------------------ repeat ---'),
    );
    expect(typed.indexOf('turnInFlightRef.current')).toBeLessThan(typed.indexOf("setInputText('')"));
    expect(typed).toContain('phaseRef.current !== ');
    // Every non-counted attempt restores the learner's own words.
    expect(FLUENCY).toContain('await runAttempt(message, { restoreInput: message });');
    expect(FLUENCY.match(/if \(options\?\.restoreInput\) setInputText\(options\.restoreInput\);/g)?.length)
      .toBeGreaterThanOrEqual(3);
  });

  it('lets the learner retry the same recording instead of speaking twice', () => {
    expect(FLUENCY).toContain('coordinator.retryTranscription()');
    expect(FLUENCY).toContain('accessibilityLabel="Transcribe my last recording again"');
    expect(FLUENCY).toContain('voiceStatus.canRetryTranscription');
  });

  it('keeps attempt counting exactly-once (no duplicate sessions, no silent reset)', () => {
    expect(FLUENCY).toContain('await service.submitAttempt({');
    expect(FLUENCY).toContain('turnTokenRef.current !== token');
    expect(FLUENCY).toContain('sessionTokenRef.current !== sessionToken');
    expect(FLUENCY).toContain('startingRef.current = true;');
  });
});
