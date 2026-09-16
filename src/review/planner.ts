/**
 * src/review/planner.ts
 *
 * Adaptive Review Queue Planner:
 * Generates deterministic, bounded review sessions (8-12 items)
 * prioritized by due dates, weakness severity, and balanced item types.
 */

import type {
  AppRepositories,
} from '../repositories';
import type {
  GrammarMistake,
  LearnerWeakness,
} from '../domain/models/learner';
import type {
  VocabularyItem,
  ExpressionItem,
} from '../domain/models/vocabulary';
import type {
  ReviewItem,
} from '../domain/models/learning';
import type {
  ReviewExerciseType,
  ReviewItemCandidate,
  ReviewPlannerOptions,
} from './types';
import { generateId } from '../shared/id';

/** Calculate priority score for sorting candidates deterministically */
function computeCandidatePriority(candidate: ReviewItemCandidate, nowMs: number): number {
  let score = 0;

  // 1. Due date urgency (overdue items get highest priority)
  const dueMs = Date.parse(candidate.dueAt);
  if (!isNaN(dueMs)) {
    if (dueMs <= nowMs) {
      const hoursOverdue = (nowMs - dueMs) / (1000 * 60 * 60);
      score += 100 + Math.min(50, hoursOverdue * 2);
    } else {
      const hoursUntilDue = (dueMs - nowMs) / (1000 * 60 * 60);
      score += Math.max(0, 50 - hoursUntilDue);
    }
  }

  // 2. Weakness severity (0.0 to 1.0)
  if (candidate.severity !== undefined) {
    score += candidate.severity * 60;
  }

  // 3. Status priority
  switch (candidate.status) {
    case 'relapsed':
      score += 50;
      break;
    case 'active_training':
      score += 40;
      break;
    case 'confirmed':
      score += 30;
      break;
    case 'repeated':
      score += 20;
      break;
    case 'observed':
      score += 10;
      break;
    default:
      break;
  }

  // 4. Low consecutive correct items need more practice
  score += Math.max(0, (4 - candidate.consecutiveCorrect) * 5);

  return score;
}

/** Convert a GrammarMistake / Weakness to ReviewItemCandidate */
function mistakeToCandidate(
  mistake: GrammarMistake,
  weakness?: LearnerWeakness,
): ReviewItemCandidate {
  const isFullSentence = mistake.pattern.includes(' ') && mistake.pattern.length > 15;
  const exerciseType: ReviewExerciseType = isFullSentence
    ? 'sentence_correction'
    : 'natural_phrasing';

  const prompt = exerciseType === 'sentence_correction'
    ? `Correct the grammatical error in this sentence:`
    : `Express this more naturally:`;

  return {
    id: generateId(),
    learnerId: mistake.learnerId,
    kind: 'grammar',
    exerciseType,
    referenceId: weakness?.id ?? mistake.id,
    prompt,
    contextSentence: mistake.pattern,
    expectedAnswer: mistake.correction,
    alternativeAnswers: [],
    explanation: mistake.explanation,
    dueAt: weakness?.updatedAt ?? mistake.lastSeenAt,
    severity: weakness?.severity ?? (mistake.severity === 'major' ? 0.8 : mistake.severity === 'moderate' ? 0.5 : 0.3),
    status: weakness?.status ?? 'observed',
    consecutiveCorrect: 0,
    reviewCount: mistake.occurrenceCount ?? 1,
  };
}

/** Convert a VocabularyItem to ReviewItemCandidate */
function vocabularyToCandidate(
  item: VocabularyItem,
  nowIso: string,
): ReviewItemCandidate | null {
  const meaning = item.meanings[0];
  if (!meaning) return null;

  if (meaning.review?.nextReviewAt && meaning.review.nextReviewAt > nowIso) {
    return null;
  }

  const example = meaning.examples?.[0];
  const hasExample = example && example.text.toLowerCase().includes(item.headword.toLowerCase());

  if (hasExample) {
    // Fill the gap exercise
    const gapRegex = new RegExp(`\\b${item.headword}\\b`, 'gi');
    const gappedSentence = example.text.replace(gapRegex, '_____');

    return {
      id: generateId(),
      learnerId: item.learnerId,
      kind: 'vocabulary',
      exerciseType: 'fill_the_gap',
      referenceId: item.id,
      prompt: `Fill in the blank with the appropriate word:`,
      contextSentence: gappedSentence,
      definition: meaning.definition,
      expectedAnswer: item.headword,
      alternativeAnswers: item.synonyms ?? [],
      explanation: meaning.usageNotes?.[0] ?? meaning.definition,
      dueAt: meaning.review?.nextReviewAt ?? nowIso,
      status: 'active_training',
      consecutiveCorrect: meaning.review?.consecutiveCorrect ?? 0,
      reviewCount: meaning.review?.reviewCount ?? 0,
    };
  }

  // Vocabulary recall exercise
  return {
    id: generateId(),
    learnerId: item.learnerId,
    kind: 'vocabulary',
    exerciseType: 'vocabulary_recall',
    referenceId: item.id,
    prompt: `What word matches this definition? (${meaning.partOfSpeech ?? 'word'})`,
    definition: meaning.definition,
    contextSentence: meaning.examples?.[0]?.text,
    expectedAnswer: item.headword,
    alternativeAnswers: item.synonyms ?? [],
    explanation: meaning.definition,
    dueAt: meaning.review?.nextReviewAt ?? nowIso,
    status: 'active_training',
    consecutiveCorrect: meaning.review?.consecutiveCorrect ?? 0,
    reviewCount: meaning.review?.reviewCount ?? 0,
  };
}

/** Convert an ExpressionItem to ReviewItemCandidate */
function expressionToCandidate(
  item: ExpressionItem,
  nowIso: string,
): ReviewItemCandidate | null {
  const meaning = item.meanings?.[0];
  if (item.review?.nextReviewAt && item.review.nextReviewAt > nowIso) {
    return null;
  }

  return {
    id: generateId(),
    learnerId: item.learnerId,
    kind: 'expression',
    exerciseType: 'expression_use',
    referenceId: item.id,
    prompt: `Use this expression naturally or complete the sentence:`,
    contextSentence: item.expression,
    definition: meaning?.definition,
    expectedAnswer: item.expression,
    alternativeAnswers: item.naturalAlternatives ?? [],
    explanation: meaning?.definition,
    dueAt: item.review?.nextReviewAt ?? nowIso,
    status: 'active_training',
    consecutiveCorrect: item.review?.consecutiveCorrect ?? 0,
    reviewCount: item.review?.reviewCount ?? 0,
  };
}

/** Convert a ReviewItem from review_items table to ReviewItemCandidate */
function reviewItemToCandidate(item: ReviewItem): ReviewItemCandidate {
  let exerciseType: ReviewExerciseType = 'vocabulary_recall';
  if (item.kind === 'grammar') {
    exerciseType = 'sentence_correction';
  } else if (item.kind === 'expression') {
    exerciseType = 'expression_use';
  } else if (item.prompt.includes('___') || (item.contextTopic && item.contextTopic.includes('gap'))) {
    exerciseType = 'fill_the_gap';
  }

  return {
    id: item.id,
    learnerId: item.learnerId,
    kind: item.kind,
    exerciseType,
    referenceId: item.referenceId,
    prompt: item.prompt,
    contextTopic: item.contextTopic,
    expectedAnswer: item.expectedResponse ?? item.prompt,
    alternativeAnswers: [],
    dueAt: item.dueAt,
    consecutiveCorrect: item.consecutiveCorrect,
    reviewCount: item.reviewCount,
    easeFactor: item.easeFactor,
  };
}

/**
 * ReviewPlanner
 * Generates an adaptive, balanced, bounded review session.
 */
export class ReviewPlanner {
  constructor(private readonly repos: AppRepositories) {}

  async planSession(
    learnerId: string,
    options?: ReviewPlannerOptions,
  ): Promise<readonly ReviewItemCandidate[]> {
    const minItems = options?.minItems ?? 8;
    const maxItems = options?.maxItems ?? 12;
    const targetItems = options?.targetItems ?? 10;
    const nowIso = options?.now ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    // 1. Gather existing due items from review_items table
    const dueReviews = await this.repos.review.listDue(learnerId, nowIso, maxItems * 2);
    const candidates: ReviewItemCandidate[] = dueReviews.map(reviewItemToCandidate);

    // 2. Gather active weaknesses and mistakes
    const [weaknesses, mistakes] = await Promise.all([
      this.repos.weaknesses.listWeaknesses(learnerId, 100),
      this.repos.mistakes.listMistakes(learnerId, { resolved: false, limit: 20 }),
    ]);

    const activeWeaknesses = weaknesses.filter((w) => !w.resolved);

    // Map mistakes to weaknesses
    for (const mistake of mistakes) {
      const matchingWeakness = activeWeaknesses.find(
        (w) => w.referenceId === mistake.id,
      );
      // Avoid duplicates if referenceId already in candidate list
      const alreadyIncluded = candidates.some((c) => c.referenceId === (matchingWeakness?.id ?? mistake.id));
      if (!alreadyIncluded) {
        candidates.push(mistakeToCandidate(mistake, matchingWeakness));
      }
    }

    // 3. Gather due vocabulary and expressions if candidate pool is under maxItems
    if (candidates.length < maxItems * 2) {
      const [vocabList, exprList] = await Promise.all([
        this.repos.vocabulary.list(learnerId, { limit: 20 }),
        this.repos.expressions.list(learnerId, { limit: 20 }),
      ]);

      for (const vocab of vocabList) {
        const candidate = vocabularyToCandidate(vocab, nowIso);
        if (candidate && !candidates.some((c) => c.referenceId === vocab.id)) {
          candidates.push(candidate);
        }
      }

      for (const expr of exprList) {
        const candidate = expressionToCandidate(expr, nowIso);
        if (candidate && !candidates.some((c) => c.referenceId === expr.id)) {
          candidates.push(candidate);
        }
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    // 4. Sort all candidates deterministically by priority score
    candidates.sort((a, b) => {
      const scoreA = computeCandidatePriority(a, nowMs);
      const scoreB = computeCandidatePriority(b, nowMs);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return a.id.localeCompare(b.id);
    });

    // 5. Balance item types (interleave grammar, vocabulary, expressions)
    const grammarPool = candidates.filter((c) => c.kind === 'grammar');
    const vocabPool = candidates.filter((c) => c.kind === 'vocabulary');
    const exprPool = candidates.filter((c) => c.kind === 'expression');
    const otherPool = candidates.filter((c) => !['grammar', 'vocabulary', 'expression'].includes(c.kind));

    const balanced: ReviewItemCandidate[] = [];
    let idx = 0;
    while (
      balanced.length < maxItems &&
      (grammarPool.length > 0 || vocabPool.length > 0 || exprPool.length > 0 || otherPool.length > 0)
    ) {
      if (grammarPool.length > 0 && idx % 3 === 0) {
        balanced.push(grammarPool.shift()!);
      } else if (vocabPool.length > 0 && idx % 3 === 1) {
        balanced.push(vocabPool.shift()!);
      } else if (exprPool.length > 0 && idx % 3 === 2) {
        balanced.push(exprPool.shift()!);
      } else if (grammarPool.length > 0) {
        balanced.push(grammarPool.shift()!);
      } else if (vocabPool.length > 0) {
        balanced.push(vocabPool.shift()!);
      } else if (exprPool.length > 0) {
        balanced.push(exprPool.shift()!);
      } else if (otherPool.length > 0) {
        balanced.push(otherPool.shift()!);
      }
      idx++;
    }

    // 6. Enforce bounds:
    // If available items >= minItems (8), bound to between minItems and maxItems (target 10).
    // If available items < minItems, return all available items without inventing false data.
    const boundedCount = Math.min(
      maxItems,
      Math.max(minItems, Math.min(targetItems, balanced.length)),
    );

    return balanced.slice(0, boundedCount);
  }
}
