/**
 * src/screens/learner-agency-surfaces.test.ts
 *
 * Work Order 2 — wiring contract for the screens.
 *
 * Following this repository's established source-contract pattern (see
 * product-ux.test.ts), these tests read the actual screen sources and pin the
 * SCOPE RULES that must survive any future visual redesign (the planned Bolt
 * rebuild may re-skin everything, but these invariants must not regress):
 *
 * 1. Talk exposes ALL EIGHT help actions with real handlers;
 * 2. help NEVER submits a learner answer — its handler contains no path to
 *    `session.send`/`sendStream`, and goes through `requestAssistance`;
 * 3. the temporary "fewer corrections for now" control is session-local
 *    (`setModeOverride`), persisted intensity goes through the preferences
 *    service, and starting/switching a conversation clears both;
 * 4. there is no fake speed control: Slower consults the real TTS capability;
 * 5. change-topic is explicit (open draft → apply), never per keystroke;
 * 6. Save to Review on every surface uses the ONE reusable service and reports
 *    honest per-save notes; the shadowing assist buttons cannot submit an
 *    attempt;
 * 7. assessment coaching wraps Continue, offers an explicit "Continue
 *    anyway", and the product thresholds in src/onboarding/assessment.ts are
 *    NOT weakened.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const read = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), 'utf8');

/** Extract a balanced-brace function body starting at the first `{`. */
function extractFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `expected "${declaration}" to exist`).toBeGreaterThanOrEqual(0);
  let i = source.indexOf('{', start);
  let depth = 0;
  const from = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${declaration}`);
}

describe('TalkScreen — learner agency wiring (contract)', () => {
  const source = read('src/screens/TalkScreen.tsx');

  it('offers every required help action through the shared descriptors', () => {
    expect(source).toContain('HELP_ACTION_DESCRIPTORS');
    expect(source).toContain('handleHelpAction(descriptor.id)');
    // The eight labels exist via the shared descriptor list — assert the
    // single-source contract instead of duplicating strings here.
    const types = read('src/learner-agency/types.ts');
    for (const label of [
      "I don't know",
      'Hint',
      'Example',
      'Explain',
      'Repeat',
      'Slower',
      'Skip',
      'Change topic',
    ]) {
      expect(types).toContain(label);
    }
  });

  it('help can never submit a learner answer: requestAssistance only', () => {
    const body = extractFunctionBody(source, 'const handleHelpAction = useCallback');
    expect(body).toContain('requestAssistance');
    expect(body).toContain('buildHelpInstruction');
    expect(body).not.toContain('session.send(');
    expect(body).not.toContain('sendStream');
    expect(body).not.toContain('sendMessage(');
    // Guard against double-taps and against using a dead session.
    expect(body).toContain('helpInFlightRef.current');
  });

  it('repeated/late help cannot corrupt state: token + mounted + session guards', () => {
    const body = extractFunctionBody(source, 'const handleHelpAction = useCallback');
    expect(body).toContain('helpTokenRef.current');
    expect(body).toContain('mountedRef.current');
    // Dismissing help invalidates the in-flight result.
    const dismiss = extractFunctionBody(source, 'const dismissHelpPanel');
    expect(dismiss).toContain('helpTokenRef.current');
  });

  it('Slower uses the REAL speech-rate capability, never a fake control', () => {
    const body = extractFunctionBody(source, 'const handleHelpAction = useCallback');
    expect(body).toContain('resolveSpeechRateCapability');
    expect(body).toContain('planSpeechRate');
  });

  it('change topic is explicit — an applied draft, not per-keystroke recreation', () => {
    expect(source).toContain('setTopicChangeOpen(true)');
    const apply = extractFunctionBody(source, 'const handleApplyTopic');
    // Applying goes through the EXISTING single atomic start path, is guarded
    // against in-flight turns, and closes the draft.
    expect(apply).toContain('startConversation');
    expect(apply).toContain('isSending || isOpening || isSwitching');
    expect(apply).toContain('setTopicChangeOpen(false)');
    const helpBody = extractFunctionBody(source, 'const handleHelpAction = useCallback');
    expect(helpBody).toContain("action === 'change_topic'");
    expect(helpBody).toContain('setTopicChangeOpen(true)');
    // No provider call happens just from opening the draft.
    const openSegment = source.slice(
      source.indexOf("action === 'change_topic'"),
      source.indexOf("action === 'change_topic'") + 120,
    );
    expect(openSegment).toContain('return;');
  });

  it('temporary fewer-corrections is session-local and intensity persists via the preferences service', () => {
    expect(source).toContain('createCorrectionPreferencesService');
    expect(source).toContain('setModeOverride');
    const toggle = extractFunctionBody(source, 'const handleToggleFewerCorrections');
    expect(toggle).toContain('setModeOverride');
    expect(toggle).not.toContain('createConversationSession');
    // A new/switched conversation clears both temporary and stored overrides.
    const start = source.slice(source.indexOf('const startConversation'));
    expect(start.slice(0, 9000)).toContain('setModeOverride?.(null)');
    expect(start.slice(0, 9000)).toContain('setFewerCorrectionsNow(false)');
  });

  it('Save to Review is wired to the ONE reusable service with honest notes', () => {
    expect(source).toContain('createSaveToReviewService');
    expect(source).toContain('review-save-note');
    const save = source.slice(
      source.indexOf('const handleSaveToReview'),
      source.indexOf('const handleToggleFewerCorrections'),
    );
    expect(save).toContain('double-tap protection');
    expect(save).toContain('meaningIsGenerated: true');
    // Saving never routes through feedback/evidence writes.
    expect(save).not.toContain('recordWeakness');
    expect(save).not.toContain('upsertWeakness');
  });
});

describe('DeepListeningPanel — shadowing assist wiring (contract)', () => {
  const source = read('src/screens/listening/DeepListeningPanel.tsx');

  it('exposes reveal / meaning / replay / save assist controls', () => {
    expect(source).toContain('toggleTranscript');
    expect(source).toContain('readableChunkFor');
    expect(source).toContain('curatedMeaning');
    expect(source).toContain('Save to Review');
    expect(source).toContain('Replay');
  });

  it('assist buttons can NEVER submit a shadowing attempt (one submit path only)', () => {
    // Exactly one real submission path exists in the whole panel: the
    // voice-flow submit port. Reveal/meaning/replay/save must not add one.
    const occurrences = source.split('submitShadowingAttempt(').length - 1;
    expect(occurrences).toBe(1);
    const revealIndex = source.indexOf('toggleTranscript(current)');
    expect(revealIndex).toBeGreaterThanOrEqual(0);
    const submitIndex = source.indexOf('submitShadowingAttempt(');
    // The reveal wiring is presentation; the submit port precedes it and is
    // the single attempt channel.
    expect(submitIndex).toBeLessThan(revealIndex);
  });

  it('meaning generation is stale-guarded and honestly labelled when generated', () => {
    expect(source).toContain('beginMeaningRequest');
    expect(source).toContain('meaningLoaded');
    expect(source).toContain('meaningFailed');
    expect(source).toContain('checkStale');
    expect(source).toContain('generated, not a dictionary');
    expect(source).toContain('shadowingTokenRef.current');
  });

  it('activity changes reset assist state (no leak of reveal/meaning onto the next activity)', () => {
    expect(source).toContain('resetAssistForActivity()');
  });

  it('the manual reveal supplements automatic support: readable text goes through readableChunkFor', () => {
    expect(source).toContain('readableChunkFor(shadowing.session, assist)');
  });

  it('saving uses the shared service and works for both shadowing chunks and revealed transcripts', () => {
    expect(source).toContain('createSaveToReviewService');
    const save = extractFunctionBody(source, 'const handleSaveToReview');
    expect(save).not.toContain('submitShadowingAttempt');
    expect(save).not.toContain('recordWeakness');
  });
});

describe('assessment coaching surfaces (contract)', () => {
  it('Onboarding shows pre-guidance + speaking guidance and gates Continue', () => {
    const source = read('src/screens/OnboardingScreen.tsx');
    expect(source).toContain('ASSESSMENT_PRE_GUIDANCE');
    expect(source).toContain('ASSESSMENT_SPEAKING_GUIDANCE');
    expect(source).toContain('assessAnswerSubstance');
    expect(source).toContain('ANSWER_ANYWAY_LABEL');
    expect(source).toContain('handleContinueWithCoaching');
    expect(source).toContain('handleCoachingContinueAnyway');
    // Coaching wraps Continue on BOTH speaking parts; other steps keep the
    // raw continue path (no behavior change outside the speaking parts).
    const coaching = extractFunctionBody(source, 'const handleContinueWithCoaching = useCallback');
    expect(coaching).toContain("stepId === 'speaking'");
    expect(coaching).toContain("stepId === 'language_use'");
    expect(coaching).toContain('await continueStep()');
    // The wrapper itself records NOTHING (it cannot touch evidence).
    expect(coaching).not.toContain('recordSpeaking');
    expect(coaching).not.toContain('recordLanguageUse');
    expect(coaching).not.toContain('observeCommittedHistory');
    // An override never leaks across steps/answers.
    const reset = extractFunctionBody(source, 'const handleCoachingContinueAnyway = useCallback');
    expect(reset).toContain('coachingOverrideRef.current = true');
    const effect = source.slice(
      source.indexOf('A new step or a newly committed answer restarts'),
      source.indexOf('A new step or a newly committed answer restarts') + 700,
    );
    expect(effect).toContain('coachingOverrideRef.current = false');
  });

  it('Reassessment shows the same pre-guidance before the speaking parts', () => {
    const source = read('src/screens/ReassessmentScreen.tsx');
    expect(source).toContain('ASSESSMENT_PRE_GUIDANCE');
  });

  it('product thresholds in the assessment core are NOT weakened by coaching', () => {
    const source = read('src/onboarding/assessment.ts');
    expect(source).toContain('export const MIN_SPEAKING_TURNS_FOR_ESTIMATE = 3;');
    expect(source).toContain('const CONNECTED_TURNS = 3;');
    expect(source).toContain('const SUSTAINED_TURNS = 6;');
    expect(source).toContain('const STRONG_COVERAGE_TURNS = 5;');
    // And the coaching module is not even referenced by the assessment core:
    // the evidence path cannot import UI-side coaching helpers.
    expect(source).not.toContain('learner-agency');
    expect(source).not.toContain('assessAnswerSubstance');
  });
});

describe('settings + review + listening + vocabulary exposure (contract)', () => {
  it('SettingsScreen offers the three intensities through the preferences service', () => {
    const source = read('src/screens/SettingsScreen.tsx');
    expect(source).toContain('Correction intensity');
    expect(source).toContain('CORRECTION_INTENSITY_OPTIONS');
    expect(source).toContain('createCorrectionPreferencesService');
    expect(source).toContain('settings-intensity-${option.key}');
    // No numeric grammar score anywhere in this card.
    const card = source.slice(source.indexOf('Correction intensity'));
    expect(card.slice(0, 1800)).not.toMatch(/score/i);
  });

  it('Review feedback exposes Save to Review for any result (also correct ones) and skips demo cards', () => {
    const source = read('src/screens/ReviewScreen.tsx');
    expect(source).toContain('Save to Review');
    expect(source).toContain('createSaveToReviewService');
    expect(source).toContain("origin: 'review_feedback'");
    // Demo sample content is never pushed into the real review store.
    const saveGate = source.slice(
      source.indexOf('const handleSaveFromFeedback'),
      source.indexOf('const handleSaveFromFeedback') + 400,
    );
    expect(saveGate).toContain('isDemoMode');
  });

  it('Listening offers a save of the revealed transcript independent of the answer outcome', () => {
    const source = read('src/screens/ListeningScreen.tsx');
    expect(source).toContain('Save sentence to Review');
    expect(source).toContain('createSaveToReviewService');
    expect(source).toContain("origin: 'listening'");
    // The save button lives in the feedback card itself — outside the
    // missed-items-only block — so correct answers can save too.
    const buttonIndex = source.indexOf('＋ Save sentence to Review');
    const missedBlockIndex = source.indexOf('missedItems.length > 0');
    expect(buttonIndex).toBeGreaterThan(missedBlockIndex);
  });

  it('Vocabulary details read provenance from the shared derivation', () => {
    const source = read('src/screens/VocabularyScreen.tsx');
    expect(source).toContain('describeSaveSource');
    expect(source).toContain('includes AI-generated text');
    expect(source).toContain('In context');
  });
});
