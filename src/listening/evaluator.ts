/**
 * src/listening/evaluator.ts
 *
 * Deterministic-first listening evaluation (Phase 1).
 *
 * - listen_and_type / missing_word / choices: normalized text comparison.
 * - Open-ended comprehension (listen_and_answer): uses the EXISTING
 *   AIProvider ONLY; if it fails, a conservative local keyword fallback or
 *   'insufficient_evidence' is returned — never a fabricated result.
 * - Internal word-overlap similarity is used ONLY to map into qualitative
 *   categories: it is never persisted as a score, never shown as a
 *   percentage, and never presented as acoustic accuracy.
 */

import type { AIProvider } from '../providers/ai/types';
import type { ConversationRequest } from '../conversation-engine/types';
import type { CoachingContext } from '../learner-model';
import type {
  ListeningEvaluation,
  ListeningExercise,
  ListeningResultCategory,
} from './types';

const QUALITATIVE_CATEGORIES: readonly ListeningResultCategory[] = [
  'understood',
  'mostly_understood',
  'partial',
  'missed_key_meaning',
  'misunderstood',
  'insufficient_evidence',
];

function createNeutralCoachingContext(): CoachingContext {
  return {
    profile: {
      learnerId: '',
      displayName: '',
      currentLevel: 'unknown',
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: [],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

/** Normalize an answer for comparison: lowercase, trimmed, collapsed spaces, no punctuation. */
export function normalizeAnswerText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:"'’`]/g, '')
    .replace(/\s+/g, ' ');
}

/** Internal word-overlap ratio (0..1). NEVER surfaced as a score. */
export function internalWordOverlap(expected: string, actual: string): number {
  const expectedWords = normalizeAnswerText(expected).split(' ').filter(Boolean);
  const actualWords = new Set(normalizeAnswerText(actual).split(' ').filter(Boolean));
  if (expectedWords.length === 0) return actualWords.size === 0 ? 1 : 0;
  let hits = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) hits += 1;
  }
  return hits / expectedWords.length;
}

function matchesExpected(exercise: ListeningExercise, answer: string): boolean {
  const normalized = normalizeAnswerText(answer);
  if (!normalized) return false;
  if (normalized === normalizeAnswerText(exercise.expectedAnswer)) return true;
  for (const alternative of exercise.acceptableAnswers ?? []) {
    if (normalized === normalizeAnswerText(alternative)) return true;
  }
  return false;
}

/** Feedback lines are bounded and never contain percentages or scores. */
function baseFeedback(exercise: ListeningExercise): string[] {
  const lines: string[] = [];
  lines.push(`The sentence was: "${exercise.speakText}"`);
  if (exercise.explanation) lines.push(exercise.explanation);
  return lines;
}

function missedKeyItems(
  exercise: ListeningExercise,
  answer: string,
): string[] {
  const normalizedAnswer = normalizeAnswerText(answer);
  const missed: string[] = [];
  for (const key of exercise.keyItems) {
    const keyWords = normalizeAnswerText(key).split(' ').filter(Boolean);
    const present = keyWords.every((w) => normalizedAnswer.includes(w));
    if (!present) missed.push(key);
  }
  return missed.slice(0, 3);
}

/** Map an internal overlap ratio to a qualitative category (no scores shown). */
function categoryFromOverlap(ratio: number, missedCount: number): ListeningResultCategory {
  if (ratio >= 0.99) return 'understood';
  if (ratio >= 0.7) return missedCount === 0 ? 'mostly_understood' : 'mostly_understood';
  if (ratio >= 0.4) return 'partial';
  return missedCount > 0 && missedCount < 3 ? 'missed_key_meaning' : 'misunderstood';
}

/** Deterministic evaluation for listen_and_type. */
export function evaluateListenAndType(exercise: ListeningExercise, answer: string): ListeningEvaluation {
  const trimmed = answer.trim();
  const revealedTranscript = exercise.speakText;
  if (!trimmed) {
    return {
      result: 'insufficient_evidence',
      feedbackLines: [
        'No answer was typed, so there is not enough evidence to judge comprehension. Try replaying and typing what you catch.',
        ...baseFeedback(exercise),
      ],
      missedItems: [...exercise.keyItems].slice(0, 3),
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }

  if (matchesExpected(exercise, trimmed)) {
    return {
      result: 'understood',
      feedbackLines: ['You typed the sentence exactly as spoken — fully understood.', ...baseFeedback(exercise)],
      missedItems: [],
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }

  const ratio = internalWordOverlap(exercise.speakText, trimmed);
  const missed = missedKeyItems(exercise, trimmed);
  const result = categoryFromOverlap(ratio, missed.length);
  const lines: string[] = [];
  if (result === 'mostly_understood') {
    lines.push('You caught most of the sentence.');
  } else if (result === 'partial') {
    lines.push('You caught parts of the sentence.');
  } else if (result === 'missed_key_meaning') {
    lines.push('You missed a key part of the meaning.');
  } else {
    lines.push('The answer differs clearly from what was spoken.');
  }
  if (missed.length > 0) {
    lines.push(`Missed: ${missed.map((m) => `'${m}'`).join(', ')}.`);
  }
  return {
    result,
    feedbackLines: [...lines, ...baseFeedback(exercise)],
    missedItems: missed,
    revealedTranscript,
    evaluatedBy: 'local',
  };
}

/** Deterministic evaluation for missing_word. */
export function evaluateMissingWord(exercise: ListeningExercise, answer: string): ListeningEvaluation {
  const trimmed = answer.trim();
  const revealedTranscript = exercise.speakText;
  if (!trimmed) {
    return {
      result: 'insufficient_evidence',
      feedbackLines: [
        'No answer was given, so there is not enough evidence to judge this one.',
        ...baseFeedback(exercise),
      ],
      missedItems: [exercise.expectedAnswer],
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }
  if (matchesExpected(exercise, trimmed)) {
    return {
      result: 'understood',
      feedbackLines: [`Correct — the missing word was '${exercise.expectedAnswer}'.`, ...baseFeedback(exercise)],
      missedItems: [],
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }
  return {
    result: 'misunderstood',
    feedbackLines: [
      `The missing word was '${exercise.expectedAnswer}', not '${trimmed}'.`,
      ...baseFeedback(exercise),
    ],
    missedItems: [exercise.expectedAnswer],
    revealedTranscript,
    evaluatedBy: 'local',
  };
}

/** Deterministic exact-choice evaluation (listen_and_choose / expression_in_context with options). */
export function evaluateChoice(exercise: ListeningExercise, answer: string): ListeningEvaluation {
  const trimmed = answer.trim();
  const revealedTranscript = exercise.speakText;
  if (!trimmed) {
    return {
      result: 'insufficient_evidence',
      feedbackLines: ['No option was selected, so there is not enough evidence to judge this one.', ...baseFeedback(exercise)],
      missedItems: exercise.keyItems.slice(0, 3),
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }
  if (matchesExpected(exercise, trimmed)) {
    return {
      result: 'understood',
      feedbackLines: ['Correct — you identified the meaning.', ...baseFeedback(exercise)],
      missedItems: [],
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }
  // Distractors that share no words with the expected answer → misunderstood;
  // overlapping distractors → partial.
  const overlap = internalWordOverlap(exercise.expectedAnswer, trimmed);
  const result: ListeningResultCategory = overlap > 0.3 ? 'partial' : 'misunderstood';
  return {
    result,
    feedbackLines: [
      `You chose '${trimmed}'. The correct meaning was '${exercise.expectedAnswer}'.`,
      ...baseFeedback(exercise),
    ],
    missedItems: exercise.keyItems.slice(0, 3),
    revealedTranscript,
    evaluatedBy: 'local',
  };
}

/**
 * Local fallback for open-ended comprehension (listen_and_answer):
 * conservative keyword mapping — never fabricates understanding.
 */
export function evaluateOpenEndedLocally(exercise: ListeningExercise, answer: string): ListeningEvaluation {
  const trimmed = answer.trim();
  const revealedTranscript = `${exercise.speakText}${exercise.question ? ` — ${exercise.question}` : ''}`;
  if (!trimmed) {
    return {
      result: 'insufficient_evidence',
      feedbackLines: ['No answer was given, so there is not enough evidence to judge comprehension.', ...baseFeedback(exercise)],
      missedItems: exercise.keyItems.slice(0, 3),
      revealedTranscript,
      evaluatedBy: 'unavailable',
    };
  }
  const ratio = internalWordOverlap(exercise.speakText, trimmed);
  const missed = missedKeyItems(exercise, trimmed);
  if (ratio >= 0.5 || (missed.length === 0 && trimmed.length >= 3)) {
    const result: ListeningResultCategory = missed.length === 0 ? 'mostly_understood' : 'partial';
    return {
      result,
      feedbackLines: [
        result === 'mostly_understood'
          ? 'Your answer reflects the statement.'
          : 'Your answer reflects parts of the statement.',
        ...baseFeedback(exercise),
      ],
      missedItems: missed,
      revealedTranscript,
      evaluatedBy: 'local',
    };
  }
  return {
    result: missed.length > 0 ? 'missed_key_meaning' : 'misunderstood',
    feedbackLines: [
      `The answer does not clearly reflect what was said. Key items: ${exercise.keyItems.map((k) => `'${k}'`).join(', ') || 'the main idea'}.`,
      ...baseFeedback(exercise),
    ],
    missedItems: missed.length > 0 ? missed : exercise.keyItems.slice(0, 3),
    revealedTranscript,
    evaluatedBy: 'local',
  };
}

/**
 * Open-ended evaluation through the EXISTING AIProvider. Falls back to the
 * local evaluator on any failure. The AI is explicitly told to return a
 * qualitative category — never a number or percentage.
 */
export async function evaluateWithAI(
  aiProvider: AIProvider,
  exercise: ListeningExercise,
  answer: string,
): Promise<ListeningEvaluation> {
  const revealedTranscript = `${exercise.speakText}${exercise.question ? ` — ${exercise.question}` : ''}`;
  try {
    const request: ConversationRequest = {
      systemPrompt:
        'You are an empathetic English listening tutor. Evaluate comprehension QUALITATIVELY. Strictly return valid JSON.',
      messages: [
        {
          role: 'user',
          content: `The learner heard this spoken statement: "${exercise.speakText}"${
            exercise.question ? `\nComprehension question: "${exercise.question}"` : ''
          }\nKey items it contains: ${exercise.keyItems.join(', ') || 'the main idea'}\nThe learner answered: "${answer}"\n\nJudge ONLY comprehension of what was said. Respond with ONLY valid JSON:\n{\n  "result": "understood" | "mostly_understood" | "partial" | "missed_key_meaning" | "misunderstood" | "insufficient_evidence",\n  "missedItems": ["key words or phrases the learner missed"],\n  "feedback": "one short qualitative sentence"\n}\nDo NOT include numbers, percentages, scores, or ratings.`,
        },
      ],
      mode: 'coach',
      topic: 'Listening comprehension',
      coachingContext: createNeutralCoachingContext(),
    };
    const result = await aiProvider.generate(request);
    if (!result.ok || !result.response?.content) {
      return evaluateOpenEndedLocally(exercise, answer);
    }
    const jsonMatch = result.response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return evaluateOpenEndedLocally(exercise, answer);
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      result?: string;
      missedItems?: unknown;
      feedback?: string;
    };
    const category = QUALITATIVE_CATEGORIES.includes(parsed.result as ListeningResultCategory)
      ? (parsed.result as ListeningResultCategory)
      : null;
    // An AI response without a valid qualitative category is unusable —
    // fall back rather than fabricate.
    if (!category) {
      return evaluateOpenEndedLocally(exercise, answer);
    }
    const missedItems = Array.isArray(parsed.missedItems)
      ? parsed.missedItems.filter((m): m is string => typeof m === 'string').slice(0, 3)
      : [];
    const lines: string[] = [];
    if (parsed.feedback && typeof parsed.feedback === 'string') {
      lines.push(parsed.feedback);
    } else {
      lines.push(
        category === 'understood'
          ? 'Your answer shows you understood the statement.'
          : `Comprehension result: ${category.replace(/_/g, ' ')}.`,
      );
    }
    // Sanity: the AI may never introduce numeric claims into feedback.
    const safeLines = lines.filter((l) => !/\d+\s*%|\b\d+\s*\/\s*10\b/i.test(l));
    return {
      result: category,
      feedbackLines: [...(safeLines.length > 0 ? safeLines : ['Your answer was reviewed.']), ...baseFeedback(exercise)],
      missedItems,
      revealedTranscript,
      evaluatedBy: 'ai',
    };
  } catch {
    // AI failure has a safe local fallback — never a fabricated result.
    return evaluateOpenEndedLocally(exercise, answer);
  }
}

/** Evaluate an exercise with the right strategy for its type. */
export async function evaluateListeningAnswer(
  aiProvider: AIProvider | undefined,
  exercise: ListeningExercise,
  answer: string,
): Promise<ListeningEvaluation> {
  switch (exercise.type) {
    case 'listen_and_type':
      return evaluateListenAndType(exercise, answer);
    case 'missing_word':
      return evaluateMissingWord(exercise, answer);
    case 'listen_and_choose':
    case 'expression_in_context':
      return exercise.options
        ? evaluateChoice(exercise, answer)
        : evaluateOpenEndedLocally(exercise, answer);
    case 'listen_and_answer':
      if (aiProvider) return evaluateWithAI(aiProvider, exercise, answer);
      return evaluateOpenEndedLocally(exercise, answer);
    default:
      return evaluateOpenEndedLocally(exercise, answer);
  }
}

/** Map a listening category onto the EXISTING review qualitative result. */
export function toReviewQualitativeResult(category: ListeningResultCategory): 'correct' | 'partial' | 'incorrect' {
  switch (category) {
    case 'understood':
    case 'mostly_understood':
      return 'correct';
    case 'partial':
    case 'missed_key_meaning':
      return 'partial';
    default:
      return 'incorrect';
  }
}
