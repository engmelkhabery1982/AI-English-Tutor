/**
 * src/review/demo-items.ts
 *
 * The pre-built practice cards that back the EXPLICIT, visibly advertised
 * Demo Mode of the Review surface.
 *
 * Integrity rules encoded here (and enforced by the callers):
 *   - Demo cards are reachable ONLY through `selectReviewSessionCandidates`
 *     with `isDemo: true`; the real planner output is never mixed with them.
 *   - They carry the demo learner id, so no repository call can ever persist
 *     them as real learner evidence.
 *   - They are generated per call (fresh due dates), never stored.
 */

import type { ReviewItemCandidate } from './types';

/** Learner id used by demo cards ONLY — never a real learner identity. */
export const DEMO_REVIEW_LEARNER_ID = 'demo-user';

/** Shown wherever demo cards are practised: demo practice is practice only. */
export const DEMO_REVIEW_NOTICE =
  'Demo practice is not saved as your learning evidence.';

export interface DemoReviewItemSeed {
  readonly id: string;
  readonly kind: ReviewItemCandidate['kind'];
  readonly exerciseType: ReviewItemCandidate['exerciseType'];
  readonly referenceId: string;
  readonly prompt: string;
  readonly contextSentence?: string;
  readonly definition?: string;
  readonly expectedAnswer: string;
  readonly explanation: string;
  readonly severity?: number;
  readonly status: ReviewItemCandidate['status'];
  readonly reviewCount: number;
}

const DEMO_SEEDS: readonly DemoReviewItemSeed[] = [
  {
    id: 'demo-1',
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: 'weakness-1',
    prompt: 'Correct the grammatical error in this sentence:',
    contextSentence: 'She walk to school every day.',
    expectedAnswer: 'She walks to school every day.',
    explanation: 'Singular subjects (she, he, it) require the singular verb form ending in -s.',
    severity: 0.7,
    status: 'confirmed',
    reviewCount: 2,
  },
  {
    id: 'demo-2',
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: 'weakness-2',
    prompt: 'Correct the grammatical error in this sentence:',
    contextSentence: 'I am interested on learning English.',
    expectedAnswer: 'I am interested in learning English.',
    explanation: 'The adjective "interested" is paired with the preposition "in", not "on".',
    severity: 0.5,
    status: 'observed',
    reviewCount: 1,
  },
  {
    id: 'demo-3',
    kind: 'vocabulary',
    exerciseType: 'vocabulary_recall',
    referenceId: 'vocab-1',
    prompt: 'What word matches this definition?',
    definition: 'A sudden, intuitive perception of or insight into the reality or essential meaning of something.',
    expectedAnswer: 'Epiphany',
    explanation: 'An epiphany is a moment of sudden revelation or insight.',
    status: 'active_training',
    reviewCount: 1,
  },
  {
    id: 'demo-4',
    kind: 'vocabulary',
    exerciseType: 'fill_the_gap',
    referenceId: 'vocab-2',
    prompt: 'Fill in the blank with the appropriate word:',
    contextSentence: 'The _____ plants survived the harsh winter.',
    definition: 'Able to withstand or recover quickly from difficult conditions.',
    expectedAnswer: 'resilient',
    explanation: 'Resilient means able to withstand or recover quickly from difficult conditions.',
    status: 'active_training',
    reviewCount: 2,
  },
  {
    id: 'demo-5',
    kind: 'expression',
    exerciseType: 'expression_use',
    referenceId: 'expr-1',
    prompt: 'Complete or paraphrase this sentence using the expression "Bite the bullet":',
    contextSentence: 'Bite the bullet',
    definition: 'Face a difficult situation with courage and resign oneself to it.',
    expectedAnswer: 'bite the bullet',
    explanation: 'To bite the bullet means to accept a difficult or inevitable situation with fortitude.',
    status: 'active_training',
    reviewCount: 0,
  },
];

/** Fresh demo cards (deterministic content, current due date). */
export function createDemoReviewItems(
  now: string = new Date().toISOString(),
): readonly ReviewItemCandidate[] {
  return DEMO_SEEDS.map((seed) => ({
    id: seed.id,
    learnerId: DEMO_REVIEW_LEARNER_ID,
    kind: seed.kind,
    exerciseType: seed.exerciseType,
    referenceId: seed.referenceId,
    prompt: seed.prompt,
    ...(seed.contextSentence ? { contextSentence: seed.contextSentence } : {}),
    ...(seed.definition ? { definition: seed.definition } : {}),
    expectedAnswer: seed.expectedAnswer,
    alternativeAnswers: [],
    explanation: seed.explanation,
    dueAt: now,
    ...(seed.severity === undefined ? {} : { severity: seed.severity }),
    status: seed.status,
    consecutiveCorrect: 0,
    reviewCount: seed.reviewCount,
  }));
}

export interface ReviewSessionSelectionOptions {
  readonly isDemo: boolean;
  /** The real planner output for the current learner. */
  readonly planned: readonly ReviewItemCandidate[];
  /** Injectable clock (tests); defaults to now. */
  readonly now?: string;
}

/**
 * The single place where the session's cards are chosen.
 *
 * Real mode returns EXACTLY the planner's candidates — an empty queue stays
 * empty and no hard-coded card can appear as learner evidence. Demo cards are
 * returned only while Demo Mode is explicitly enabled on the surface.
 */
export function selectReviewSessionCandidates(
  options: ReviewSessionSelectionOptions,
): readonly ReviewItemCandidate[] {
  if (!options.isDemo) {
    return options.planned;
  }
  return createDemoReviewItems(options.now);
}
