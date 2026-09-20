/**
 * src/learner-agency/types.test.ts
 *
 * Work Order 2 — learner agency contract rules (pure layer).
 *
 * These tests pin the RULES the whole feature must obey, independently of any
 * screen:
 * 1. correction intensity maps onto the EXISTING conversation modes and back;
 * 2. the temporary "fewer corrections for now" override only relaxes the
 *    CURRENT session and never persists anything (it is pure);
 * 3. every help action — including any id a future change adds — must be
 *    explicitly evidence-safe, and hint/example/explain/skip are provider
 *    actions while repeat/slower are playback-only;
 * 4. help control gating matches the Work Order 1 lifecycle rules (a help
 *    request and a learner turn can never run at the same time);
 * 5. assessment coaching helpers are deterministic and NEVER touch evidence
 *    thresholds (they only build strings and classify length);
 * 6. save provenance description is a pure derivation, defaulting honestly to
 *    "Detected from practice" only for NON-manual sources.
 */

import { describe, expect, it } from 'vitest';
import {
  ANSWER_ANYWAY_LABEL,
  ASSESSMENT_PRE_GUIDANCE,
  ASSESSMENT_SPEAKING_GUIDANCE,
  ASSISTANCE_INSTRUCTION_PREFIX,
  CORRECTION_INTENSITY_OPTIONS,
  CORRECTION_INTENSITY_TO_MODE,
  DEFAULT_CORRECTION_INTENSITY,
  HELP_ACTION_DESCRIPTORS,
  HELP_ACTION_IDS,
  HELP_ACTION_PROMPT_INSTRUCTIONS,
  MIN_ASSESSMENT_ANSWER_WORDS,
  MODE_TO_CORRECTION_INTENSITY,
  PROVIDER_HELP_ACTIONS,
  SHORT_ANSWER_NUDGES,
  TEMPORARY_FEWER_CORRECTIONS,
  assessAnswerSubstance,
  buildHelpInstruction,
  describeSaveSource,
  helpActionIsEvidenceSafe,
  isCorrectionIntensity,
  isProviderHelpAction,
  resolveEffectiveConversationMode,
  resolveHelpControls,
  savedItemReviewPrompt,
} from './index';

describe('correction intensity ↔ existing conversation modes', () => {
  it('maps every intensity onto an EXISTING mode (no new mode invented)', () => {
    expect(Object.keys(CORRECTION_INTENSITY_TO_MODE).sort()).toEqual([
      'balanced',
      'intensive',
      'natural',
    ]);
    for (const mode of Object.values(CORRECTION_INTENSITY_TO_MODE)) {
      expect(['natural', 'coach', 'intensive']).toContain(mode);
    }
  });

  it('round-trips intensity → mode → intensity deterministically', () => {
    for (const intensity of ['natural', 'balanced', 'intensive'] as const) {
      const mode = CORRECTION_INTENSITY_TO_MODE[intensity];
      expect(MODE_TO_CORRECTION_INTENSITY[mode]).toBe(intensity);
    }
  });

  it('validates stored values strictly and defaults to balanced', () => {
    expect(isCorrectionIntensity('natural')).toBe(true);
    expect(isCorrectionIntensity('balanced')).toBe(true);
    expect(isCorrectionIntensity('intensive')).toBe(true);
    expect(isCorrectionIntensity('INTENSIVE')).toBe(false);
    expect(isCorrectionIntensity(3)).toBe(false);
    expect(isCorrectionIntensity(undefined)).toBe(false);
    expect(DEFAULT_CORRECTION_INTENSITY).toBe('balanced');
    expect(CORRECTION_INTENSITY_OPTIONS).toHaveLength(3);
  });

  it('temporary "fewer corrections" relaxes ONLY while set, for every intensity', () => {
    for (const intensity of ['natural', 'balanced', 'intensive'] as const) {
      expect(resolveEffectiveConversationMode(intensity, null)).toBe(
        CORRECTION_INTENSITY_TO_MODE[intensity],
      );
      // While the temporary override is active the learner always gets the
      // existing light-correction mode — and it can never make corrections
      // MORE aggressive than the stored preference.
      expect(resolveEffectiveConversationMode(intensity, TEMPORARY_FEWER_CORRECTIONS)).toBe(
        'natural',
      );
    }
  });
});

describe('help actions — evidence safety (the core Work Order 2 rule)', () => {
  it('exposes exactly the eight required actions in stable order', () => {
    expect(HELP_ACTION_IDS).toEqual([
      'dont_know',
      'hint',
      'example',
      'explain',
      'repeat',
      'slower',
      'skip',
      'change_topic',
    ]);
  });

  it('every declared action is evidence-safe', () => {
    for (const id of HELP_ACTION_IDS) {
      expect(helpActionIsEvidenceSafe(id)).toBe(true);
    }
  });

  it('unknown actions are NOT safe by default (fail-closed)', () => {
    expect(helpActionIsEvidenceSafe('submit_answer' as never)).toBe(false);
    expect(helpActionIsEvidenceSafe(('who_knows' as never))).toBe(false);
  });

  it('hint/example/explain are never treated as provider-submitting learner answers', () => {
    // The four provider actions all use the tutor-scaffold instructions; they
    // must never be routed through the learner answer path. Assert the prompt
    // wording keeps that promise for each provider action.
    for (const id of PROVIDER_HELP_ACTIONS) {
      const instruction = HELP_ACTION_PROMPT_INSTRUCTIONS[id];
      expect(typeof instruction).toBe('string');
      expect(instruction.length).toBeGreaterThan(20);
      // Each provider instruction explicitly denies grading/recording for the learner.
      expect(/not|never|nor/i.test(instruction)).toBe(true);
    }
    expect(PROVIDER_HELP_ACTIONS).toContain('hint');
    expect(PROVIDER_HELP_ACTIONS).toContain('example');
    expect(PROVIDER_HELP_ACTIONS).toContain('explain');
    // Repeat/slower are local playback — NO provider action — so a fake
    // "slower" control can never send anything anywhere.
    expect(PROVIDER_HELP_ACTIONS).not.toContain('repeat');
    expect(PROVIDER_HELP_ACTIONS).not.toContain('slower');
    expect(PROVIDER_HELP_ACTIONS).not.toContain('change_topic');
    expect(isProviderHelpAction('repeat')).toBe(false);
  });

  it('buildHelpInstruction is prefixed (identifiable, never shown) and topic-bound', () => {
    const withTopic = buildHelpInstruction('hint', 'travel');
    expect(withTopic.startsWith(ASSISTANCE_INSTRUCTION_PREFIX)).toBe(true);
    expect(withTopic).toContain('travel');
    const withoutTopic = buildHelpInstruction('hint', null);
    expect(withoutTopic.startsWith(ASSISTANCE_INSTRUCTION_PREFIX)).toBe(true);
    expect(withoutTopic).not.toContain('current topic');
    // Pure and deterministic.
    expect(buildHelpInstruction('hint', '  Travel  ')).toBe(buildHelpInstruction('hint', 'Travel'));
  });

  it('descriptors carry the required learner-facing labels', () => {
    const labels = HELP_ACTION_DESCRIPTORS.map((descriptor) => descriptor.label);
    expect(labels).toEqual([
      "I don't know",
      'Hint',
      'Example',
      'Explain',
      'Repeat',
      'Slower',
      'Skip',
      'Change topic',
    ]);
    for (const descriptor of HELP_ACTION_DESCRIPTORS) {
      expect(descriptor.accessibilityLabel.length).toBeGreaterThan(10);
      expect(['provider', 'playback', 'local']).toContain(descriptor.kind);
    }
  });
});

describe('help control gating (lifecycle safety, one source of truth)', () => {
  const base = {
    helpInFlight: false,
    turnInFlight: false,
    isSwitching: false,
    providerAvailable: true,
    hasLastTutorText: true,
    sessionActive: true,
  };

  it('provider help is blocked while help itself is in flight (no stacking)', () => {
    const controls = resolveHelpControls({ ...base, helpInFlight: true });
    expect(controls.providerActionsEnabled).toBe(false);
    expect(controls.skipEnabled).toBe(false);
    expect(controls.changeTopicEnabled).toBe(false);
    // Playback of an existing message stays allowed — it starts no request.
    expect(controls.playbackEnabled).toBe(true);
  });

  it('provider help is blocked while a learner turn is in flight', () => {
    const controls = resolveHelpControls({ ...base, turnInFlight: true });
    expect(controls.providerActionsEnabled).toBe(false);
    // Repeated taps during an in-flight turn cannot duplicate anything:
    // change-topic draft is also blocked while switching.
    expect(controls.changeTopicEnabled).toBe(false);
  });

  it('everything that could corrupt a session switch is blocked while switching', () => {
    const controls = resolveHelpControls({ ...base, isSwitching: true });
    expect(controls.providerActionsEnabled).toBe(false);
    expect(controls.playbackEnabled).toBe(false);
    expect(controls.changeTopicEnabled).toBe(false);
  });

  it('no provider → provider actions off, but change topic stays available (no fake AI)', () => {
    const controls = resolveHelpControls({ ...base, providerAvailable: false });
    expect(controls.providerActionsEnabled).toBe(false);
    expect(controls.skipEnabled).toBe(false);
    expect(controls.changeTopicEnabled).toBe(true);
  });

  it('playback needs an actual last tutor message', () => {
    expect(resolveHelpControls({ ...base, hasLastTutorText: false }).playbackEnabled).toBe(false);
  });

  it('dead session cannot host provider help', () => {
    expect(resolveHelpControls({ ...base, sessionActive: false }).providerActionsEnabled).toBe(
      false,
    );
  });
});

describe('assessment response coaching (presentation only)', () => {
  it('guidance constants are real sentences, not placeholders', () => {
    expect(ASSESSMENT_PRE_GUIDANCE).toContain('2–3 sentences');
    expect(ASSESSMENT_SPEAKING_GUIDANCE).toContain('2–3 sentences');
    expect(ANSWER_ANYWAY_LABEL).toBe('Continue anyway');
    expect(SHORT_ANSWER_NUDGES.length).toBeGreaterThanOrEqual(3);
  });

  it('assessAnswerSubstance is deterministic and threshold-LOCAL only', () => {
    // Empty / punctuation-only → first nudge.
    expect(assessAnswerSubstance('')).toBe(SHORT_ANSWER_NUDGES[0]);
    expect(assessAnswerSubstance('   ')).toBe(SHORT_ANSWER_NUDGES[0]);
    expect(assessAnswerSubstance('...!?')).toBe(SHORT_ANSWER_NUDGES[0]);
    // A full answer gets NO nudge.
    const full =
      'Last weekend I visited my grandmother and we cooked a large dinner together slowly.';
    expect(assessAnswerSubstance(full)).toBeNull();
    // Repeated evaluation of the same text is stable (rotation is by length).
    const short = 'yes i like it';
    expect(assessAnswerSubstance(short)).toBe(assessAnswerSubstance(short));
    // Boundary: exactly the minimum word count is substantive.
    const justEnough = new Array(MIN_ASSESSMENT_ANSWER_WORDS).fill('word').join(' ');
    expect(assessAnswerSubstance(justEnough)).toBeNull();
    const oneShort = new Array(MIN_ASSESSMENT_ANSWER_WORDS - 1).fill('word').join(' ');
    expect(assessAnswerSubstance(oneShort)).not.toBeNull();
  });

  it('never weakens or strengthens the product thresholds — documented here', () => {
    // This coaching constant is a GUIDANCE length only. The real assessment
    // thresholds live in src/onboarding/assessment.ts and this module must
    // not export anything that adjusts them. This expectation pins the guidance
    // value so a redesign cannot silently "help" by lowering the bar.
    expect(MIN_ASSESSMENT_ANSWER_WORDS).toBe(8);
  });
});

describe('save provenance derivation', () => {
  it('manual saves read as "Saved by me"; everything else as detected', () => {
    expect(describeSaveSource('manual_learner').key).toBe('saved_by_me');
    expect(describeSaveSource('detected_practice').key).toBe('detected_from_practice');
    // Legacy rows without the marker: only a NON-manual default label — the
    // item itself still exists, nothing is re-interpreted as a weakness.
    expect(describeSaveSource(undefined).key).toBe('detected_from_practice');
  });

  it('review prompt carries the exact text and a meaning when present', () => {
    const prompt = savedItemReviewPrompt('take a rain check', 'postpone because of rain');
    expect(prompt).toContain('take a rain check');
    expect(prompt).toContain('postpone because of rain');
    expect(savedItemReviewPrompt('x', null)).toContain('"x"');
  });
});
