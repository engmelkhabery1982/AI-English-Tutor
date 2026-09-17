/**
 * src/listening/generator.ts
 *
 * Deterministic, bounded listening-exercise planning (Phase 1).
 *
 * Priority order:
 *   1. active listening weaknesses (retraining first)
 *   2. due vocabulary
 *   3. due expressions
 *   4. clearly GENERAL built-in templates (never presented as personalized)
 *
 * No fabricated learner history: weaknesses/vocabulary are read from the
 * existing repositories; when there is no learner data the session is
 * honestly labeled general practice.
 */

import { generateId } from '../shared/id';
import type {
  ExpressionRepository,
  WeaknessRepository,
  VocabularyRepository,
} from '../repositories';
import type {
  ListeningDifficulty,
  ListeningExercise,
  ListeningExerciseType,
} from './types';

/** Phase-1 session bounds: small and finite. */
export const MIN_SESSION_EXERCISES = 5;
export const MAX_SESSION_EXERCISES = 10;
export const DEFAULT_SESSION_TARGET = 8;

/** Bounded reads — never load unlimited learner history. */
export const LISTENING_READ_LIMITS = {
  weaknesses: 100,
  weaknessRetraining: 10,
  dueVocabulary: 10,
  dueExpressions: 10,
  savedVocabulary: 20,
} as const;

/**
 * Deterministic, UUID-shaped reference id for a stable weakness identity
 * (e.g. "word_recognition:deadline"). Same identity → same id, so weakness
 * and review lookups are EXACT, never capped-scan based.
 */
export function stableReferenceId(identity: string): string {
  // FNV-1a 32-bit, mixed into four blocks for a UUID-shaped hex string.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < identity.length; i += 1) {
    const code = identity.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ (code + i)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(0, len);
  const block = (salt: number) => hex((h1 ^ (h2 + salt)) >>> 0, 8).slice(0, 4);
  return [
    hex(h1 >>> 0, 8),
    block(0x9e37),
    block(0x85eb),
    block(0xc2b2),
    hex((h1 + h2) >>> 0, 8).slice(0, 12),
  ].join('-');
}

/** Parse a persisted listening-weakness identity ("word_recognition:deadline"). */
export function parseWeaknessIdentity(notes: string | undefined): {
  kind: string;
  target: string;
} | null {
  if (!notes) return null;
  const idx = notes.indexOf(':');
  if (idx <= 0) return null;
  return { kind: notes.slice(0, idx), target: notes.slice(idx + 1).trim() };
}

interface WeaknessRepoForListening {
  weaknesses: Pick<WeaknessRepository, 'listWeaknesses'>;
}
interface LexicalRepos {
  vocabulary: Pick<VocabularyRepository, 'list' | 'listDue'>;
  expressions?: Pick<ExpressionRepository, 'listDue'>;
}

/** Small, clearly GENERAL practice templates (fallback content — Phase 1). */
interface GeneralTemplate {
  type: ListeningExerciseType;
  difficulty: ListeningDifficulty;
  speakText: string;
  question?: string;
  gappedText?: string;
  options?: readonly string[];
  expectedAnswer: string;
  keyItems: readonly string[];
  meaning?: string;
  explanation: string;
  contextTopic: string;
}

export const GENERAL_TEMPLATES: readonly GeneralTemplate[] = [
  {
    type: 'listen_and_type',
    difficulty: 'easy',
    speakText: 'I usually drink coffee in the morning.',
    expectedAnswer: 'I usually drink coffee in the morning',
    keyItems: ['coffee', 'morning'],
    explanation: 'Tip: listen for the stressed content words — they carry the meaning.',
    contextTopic: 'daily routine',
  },
  {
    type: 'listen_and_choose',
    difficulty: 'easy',
    speakText: 'Could you tell me where the station is?',
    question: 'What did the speaker want?',
    options: [
      'Directions to the station',
      'A ticket for a train trip',
      'The time of the next train',
    ],
    expectedAnswer: 'Directions to the station',
    keyItems: ['where the station is'],
    explanation: "Tip: 'Could you tell me…?' introduces a polite request for information.",
    contextTopic: 'directions',
  },
  {
    type: 'missing_word',
    difficulty: 'easy',
    speakText: 'She bought fresh bread at the bakery.',
    gappedText: 'She bought fresh ___ at the bakery.',
    expectedAnswer: 'bread',
    keyItems: ['bread'],
    explanation: 'Tip: listen for the noun after the adjective — it is usually the key word.',
    contextTopic: 'shopping',
  },
  {
    type: 'listen_and_answer',
    difficulty: 'medium',
    speakText: 'The meeting moved from Monday to Wednesday because the manager was traveling.',
    question: 'Why did the meeting move?',
    expectedAnswer: 'because the manager was traveling',
    keyItems: ['manager', 'traveling'],
    explanation: 'Tip: listen for "because" — the reason usually follows it.',
    contextTopic: 'work',
  },
  {
    type: 'listen_and_type',
    difficulty: 'medium',
    speakText: 'We need to review the contract before signing anything.',
    expectedAnswer: 'We need to review the contract before signing anything',
    keyItems: ['review', 'contract'],
    explanation: 'Tip: contractions like "we need to" often sound like one word.',
    contextTopic: 'business',
  },
  {
    type: 'missing_word',
    difficulty: 'medium',
    speakText: 'The flight was delayed because of heavy fog.',
    gappedText: 'The flight was delayed because of heavy ___.',
    expectedAnswer: 'fog',
    keyItems: ['fog'],
    explanation: 'Tip: listen for the reason phrase at the end of the sentence.',
    contextTopic: 'travel',
  },
  {
    type: 'expression_in_context',
    difficulty: 'medium',
    speakText: 'The plan sounded great at first, but it turned out to be a dead end.',
    question: 'What does "a dead end" mean here?',
    options: [
      'Something with no way forward',
      'A very quiet place',
      'The final part of a plan',
    ],
    expectedAnswer: 'Something with no way forward',
    keyItems: ['a dead end'],
    meaning: 'a situation with no way forward',
    explanation: "Tip: 'a dead end' describes a situation that cannot continue or succeed.",
    contextTopic: 'planning',
  },
  {
    type: 'listen_and_answer',
    difficulty: 'hard',
    speakText: 'Although the prototype impressed the investors, the board rejected the proposal citing budget constraints.',
    question: 'Who rejected the proposal, and why?',
    expectedAnswer: 'the board, citing budget constraints',
    keyItems: ['board', 'budget'],
    explanation: 'Tip: in long sentences, listen for WHO acts and WHY — the subject and the reason.',
    contextTopic: 'professional English',
  },
];

/** Deterministic generic distractors when no saved lexical meanings exist. */
const GENERIC_DISTRACTORS: readonly string[] = [
  'A way to greet someone politely',
  'A type of weather',
  'A place to stay',
];

function buildFromTemplate(
  template: GeneralTemplate,
  learnerId: string,
): ListeningExercise {
  return {
    id: generateId(),
    learnerId,
    type: template.type,
    difficulty: template.difficulty,
    speakText: template.speakText,
    question: template.question,
    gappedText: template.gappedText,
    options: template.options,
    expectedAnswer: template.expectedAnswer,
    keyItems: template.keyItems,
    keyMeaning: template.meaning,
    source: 'general',
    contextTopic: template.contextTopic,
    explanation: template.explanation,
  };
}

/** A short generic sentence containing a target word/phrase (per difficulty). */
function sentenceForTarget(target: string, difficulty: ListeningDifficulty): string {
  const t = target.toLowerCase();
  if (difficulty === 'hard') {
    return `Before we finalize the agreement, could you double-check the ${t} one more time?`;
  }
  if (difficulty === 'medium') {
    return `I think we should discuss the ${t} in our next meeting.`;
  }
  return `Sorry, could you repeat the ${t}? I want to make sure I understood.`;
}

/** Build a retraining exercise from a persisted listening weakness. */
export function buildWeaknessExercise(
  learnerId: string,
  identity: { kind: string; target: string },
): ListeningExercise | null {
  if (!identity.target) return null;
  const referenceId = stableReferenceId(
    `${identity.kind}:${identity.target.toLowerCase()}`,
  );
  const difficulty: ListeningDifficulty =
    identity.target.split(/\s+/).length > 2 ? 'medium' : 'easy';
  const speakText = sentenceForTarget(identity.target, difficulty);

  if (identity.kind === 'word_recognition') {
    const gappedText = speakText.replace(
      new RegExp(`\\b${identity.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      '___',
    );
    return {
      id: generateId(),
      learnerId,
      type: 'missing_word',
      difficulty,
      speakText,
      gappedText: gappedText === speakText ? undefined : gappedText,
      expectedAnswer: identity.target.toLowerCase(),
      keyItems: [identity.target],
      source: 'listening_weakness',
      contextTopic: 'listening retraining',
      weaknessReferenceId: referenceId,
      explanation: `Tip: you missed '${identity.target}' before — listen for it carefully this time.`,
    };
  }

  // expression_recognition / meaning_comprehension / detail_comprehension /
  // connected_speech → listen_and_type of a sentence containing the target.
  return {
    id: generateId(),
    learnerId,
    type: 'listen_and_type',
    difficulty,
    speakText,
    expectedAnswer: speakText,
    keyItems: [identity.target],
    source: 'listening_weakness',
    contextTopic: 'listening retraining',
    weaknessReferenceId: referenceId,
    explanation: `Tip: listen again for '${identity.target}' and type exactly what you hear.`,
  };
}

/** Build a choice exercise from a saved vocabulary item (due first). */
export function buildVocabularyExercise(
  learnerId: string,
  item: { id: string; headword: string; meanings: readonly { definition: string }[] },
  distractors: readonly string[],
): ListeningExercise | null {
  const meaning = item.meanings[0]?.definition;
  if (!meaning) return null;
  return {
    id: generateId(),
    learnerId,
    type: 'listen_and_choose',
    difficulty: 'easy',
    speakText: sentenceForTarget(item.headword, 'easy'),
    question: `What does '${item.headword}' mean here?`,
    options: [meaning, ...distractors.filter((d) => d !== meaning)].slice(0, 3),
    expectedAnswer: meaning,
    keyItems: [item.headword],
    source: 'due_vocabulary',
    lexicalItemId: item.id,
    lexicalItemKind: 'vocabulary',
    contextTopic: 'vocabulary listening',
    explanation: `Tip: '${item.headword}' — ${meaning}`,
  };
}

/** Build an expression-in-context exercise from a saved expression. */
export function buildExpressionExercise(
  learnerId: string,
  item: { id: string; expression: string; meanings: readonly { definition: string }[] },
  distractors: readonly string[],
): ListeningExercise | null {
  const meaning = item.meanings[0]?.definition;
  if (!meaning) return null;
  return {
    id: generateId(),
    learnerId,
    type: 'expression_in_context',
    difficulty: 'medium',
    speakText: sentenceForTarget(item.expression, 'medium'),
    question: `What does '${item.expression}' mean in this sentence?`,
    options: [meaning, ...distractors.filter((d) => d !== meaning)].slice(0, 3),
    expectedAnswer: meaning,
    keyItems: [item.expression],
    keyMeaning: meaning,
    source: 'due_expression',
    lexicalItemId: item.id,
    lexicalItemKind: 'expression',
    contextTopic: 'expression listening',
    explanation: `Tip: '${item.expression}' — ${meaning}`,
  };
}

export interface PlannedSession {
  readonly exercises: readonly ListeningExercise[];
  /** Honest note when the session includes (or is entirely) general content. */
  readonly sourceNote: string;
}

/**
 * Plan ONE bounded listening session (deterministic; no N+1 queries —
 * all reads happen in one bounded parallel batch).
 */
export async function planListeningSession(
  deps: WeaknessRepoForListening & LexicalRepos,
  learnerId: string,
  options?: { difficulty?: ListeningDifficulty; now?: string; targetCount?: number },
): Promise<PlannedSession> {
  const now = options?.now ?? new Date().toISOString();
  const targetCount = Math.min(
    Math.max(options?.targetCount ?? DEFAULT_SESSION_TARGET, 1),
    MAX_SESSION_EXERCISES,
  );

  // ONE bounded parallel batch — no N+1.
  const [weaknessRows, dueVocab, dueExpr, savedVocab] = await Promise.all([
    deps.weaknesses.listWeaknesses(learnerId, LISTENING_READ_LIMITS.weaknesses),
    deps.vocabulary.listDue(learnerId, now, LISTENING_READ_LIMITS.dueVocabulary),
    deps.expressions
      ? deps.expressions.listDue(learnerId, now, LISTENING_READ_LIMITS.dueExpressions)
      : Promise.resolve([]),
    deps.vocabulary.list(learnerId, { limit: LISTENING_READ_LIMITS.savedVocabulary }),
  ]);

  const exercises: ListeningExercise[] = [];

  // 1. Active listening weaknesses (retraining first).
  const listeningWeaknesses = weaknessRows
    .filter((w) => w.type === 'listening' && !w.resolved)
    .slice(0, LISTENING_READ_LIMITS.weaknessRetraining);
  for (const weakness of listeningWeaknesses) {
    if (exercises.length >= targetCount) break;
    const identity = parseWeaknessIdentity(weakness.notes);
    if (!identity) continue;
    const exercise = buildWeaknessExercise(learnerId, identity);
    if (exercise) exercises.push(exercise);
  }

  // 2. Due vocabulary.
  const distractorPool = [
    ...savedVocab
      .map((v) => v.meanings[0]?.definition)
      .filter((d): d is string => Boolean(d)),
    ...GENERIC_DISTRACTORS,
  ];
  for (const item of dueVocab) {
    if (exercises.length >= targetCount) break;
    const exercise = buildVocabularyExercise(learnerId, item, distractorPool);
    if (exercise) exercises.push(exercise);
  }

  // 3. Due expressions.
  for (const item of dueExpr) {
    if (exercises.length >= targetCount) break;
    const exercise = buildExpressionExercise(learnerId, item, distractorPool);
    if (exercise) exercises.push(exercise);
  }

  // 4. Clearly GENERAL fallback templates (deterministic order).
  const templates =
    options?.difficulty
      ? [
          ...GENERAL_TEMPLATES.filter((t) => t.difficulty === options.difficulty),
          ...GENERAL_TEMPLATES.filter((t) => t.difficulty !== options.difficulty),
        ]
      : GENERAL_TEMPLATES;
  for (const template of templates) {
    if (exercises.length >= targetCount) break;
    exercises.push(buildFromTemplate(template, learnerId));
  }

  const hasPersonalContent = exercises.some((e) => e.source !== 'general');
  const sourceNote = hasPersonalContent
    ? 'Includes practice from your own words, expressions and listening history.'
    : 'General practice — not personalized. Save words in Talk or Vocabulary to get personalized listening practice.';

  return { exercises: exercises.slice(0, MAX_SESSION_EXERCISES), sourceNote };
}
