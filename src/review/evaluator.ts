/**
 * src/review/evaluator.ts
 *
 * Local Deterministic Evaluation for simple items (vocabulary recall, fill-the-gap)
 * and AI-Powered / Fallback Evaluation for open-ended exercises (sentence correction, natural phrasing).
 *
 * Strictly qualitative feedback: 'correct' | 'partial' | 'incorrect'. No numeric scores.
 */

import type { AIProvider } from '../providers/ai/types';
import type { EvaluationResult, QualitativeResult, ReviewItemCandidate } from './types';
import type { ConversationRequest } from '../conversation-engine/types';
import type { CoachingContext } from '../learner-model';

/** Clean and normalize a string for deterministic comparison */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/^["'«“]+|["'»”]+$/g, '') // remove surrounding quotes
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?’]/g, '') // strip punctuation
    .replace(/\s+/g, ' '); // collapse whitespace
}

/** Compute Levenshtein distance between two strings */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return dp[m][n];
}

/** Check if user answer is a close typo to target */
function isCloseTypo(user: string, target: string): boolean {
  if (target.length >= 4 && Math.abs(user.length - target.length) <= 1) {
    return levenshteinDistance(user, target) <= 1;
  }
  return false;
}

function createNeutralReviewCoachingContext(): CoachingContext {
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

/**
 * Evaluates simple items locally with deterministic logic.
 */
export function evaluateSimpleItemLocally(
  candidate: ReviewItemCandidate,
  userAnswer: string,
): EvaluationResult {
  const normUser = normalizeText(userAnswer);
  const normExpected = normalizeText(candidate.expectedAnswer);
  const alternatives = (candidate.alternativeAnswers ?? []).map(normalizeText);

  if (!normUser) {
    return {
      result: 'incorrect',
      feedback: 'No answer provided.',
      explanation: candidate.explanation ?? 'Try to complete the exercise.',
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  // Exact match
  if (normUser === normExpected || alternatives.includes(normUser)) {
    return {
      result: 'correct',
      feedback: 'Correct! Well done.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  // Check for minor typo
  if (isCloseTypo(normUser, normExpected) || alternatives.some((alt) => isCloseTypo(normUser, alt))) {
    return {
      result: 'partial',
      feedback: 'Almost there! Watch the spelling or word form.',
      explanation: `Expected: "${candidate.expectedAnswer}".`,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  return {
    result: 'incorrect',
    feedback: 'Not quite.',
    explanation: candidate.explanation ?? `Expected: "${candidate.expectedAnswer}".`,
    suggestedCorrection: candidate.expectedAnswer,
  };
}

/**
 * Fallback deterministic evaluation for open-ended items when AI provider is not available.
 */
export function evaluateOpenEndedLocally(
  candidate: ReviewItemCandidate,
  userAnswer: string,
): EvaluationResult {
  const normUser = normalizeText(userAnswer);
  const normExpected = normalizeText(candidate.expectedAnswer);
  const alternatives = (candidate.alternativeAnswers ?? []).map(normalizeText);

  if (!normUser) {
    return {
      result: 'incorrect',
      feedback: 'No answer provided.',
      explanation: candidate.explanation ?? 'Please provide an answer to practice.',
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  // Exact match
  if (normUser === normExpected || alternatives.includes(normUser)) {
    return {
      result: 'correct',
      feedback: 'Excellent! That is natural and grammatically correct.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  // If sentence correction: check if user fixed the mistake pattern
  if (candidate.exerciseType === 'sentence_correction') {
    const expectedWords = normExpected.split(' ').filter((w) => w.length > 2);
    const matchedCount = expectedWords.filter((w) => normUser.includes(w)).length;
    const matchRatio = expectedWords.length > 0 ? matchedCount / expectedWords.length : 0;

    if (matchRatio >= 0.8) {
      return {
        result: 'correct',
        feedback: 'Great correction! Your sentence is grammatically sound.',
        explanation: candidate.explanation,
        suggestedCorrection: candidate.expectedAnswer,
      };
    }

    if (matchRatio >= 0.5) {
      return {
        result: 'partial',
        feedback: 'Partially correct. You addressed part of the mistake.',
        explanation: candidate.explanation ?? `A more natural correction is: "${candidate.expectedAnswer}".`,
        suggestedCorrection: candidate.expectedAnswer,
      };
    }

    return {
      result: 'incorrect',
      feedback: 'Needs work. The mistake was not fully resolved.',
      explanation: candidate.explanation ?? `Expected: "${candidate.expectedAnswer}".`,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  if (candidate.exerciseType === 'expression_use') {
    const expr = normalizeText(candidate.contextSentence ?? candidate.expectedAnswer);
    if (expr && normUser.includes(expr)) {
      return {
        result: 'correct',
        feedback: 'Great job using the expression appropriately!',
        explanation: candidate.explanation,
        suggestedCorrection: candidate.expectedAnswer,
      };
    }
  }

  if (candidate.exerciseType === 'natural_phrasing') {
    if (isCloseTypo(normUser, normExpected)) {
      return {
        result: 'partial',
        feedback: 'Almost there! A slight phrasing or spelling difference.',
        explanation: candidate.explanation,
        suggestedCorrection: candidate.expectedAnswer,
      };
    }
  }

  return {
    result: 'partial',
    feedback: 'Good effort! Compare your answer with the suggested phrasing.',
    explanation: candidate.explanation ?? `Recommended phrasing: "${candidate.expectedAnswer}".`,
    suggestedCorrection: candidate.expectedAnswer,
  };
}

/**
 * Qualitative evaluation for pronunciation repeat practice (Phase 1).
 *
 * Evidence is transcript-derived: the existing recorder/STT path produced
 * `userAnswer`. We compare it to the expected target text and report
 * whether the attempt was RECOGNIZABLE — never an acoustic score or
 * "phoneme accuracy". Feedback stays qualitative.
 */
export function evaluatePronunciationRepeatLocally(
  candidate: ReviewItemCandidate,
  userAnswer: string,
): EvaluationResult {
  const normUser = normalizeText(userAnswer);
  if (!normUser) {
    return {
      result: 'incorrect',
      feedback: 'No speech was captured. Insufficient evidence — try recording again.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  const normExpected = normalizeText(candidate.expectedAnswer);
  if (normUser === normExpected) {
    return {
      result: 'correct',
      feedback: 'Correct enough — the target was clearly recognizable. Keep practicing it aloud.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  // Word-level overlap: how much of the target was recognizable.
  const expectedWords = normExpected.split(' ').filter((w) => w.length > 1);
  const matchedCount = expectedWords.filter((w) => normUser.includes(w)).length;
  const matchRatio = expectedWords.length > 0 ? matchedCount / expectedWords.length : 0;

  if (matchRatio >= 0.8) {
    return {
      result: 'correct',
      feedback: 'Correct enough — nearly the whole target was recognizable in your attempt.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  if (matchRatio >= 0.4) {
    return {
      result: 'partial',
      feedback: 'Improved — parts of the target were recognizable, parts were still unclear. Say it slowly once more.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  return {
    result: 'incorrect',
    feedback: 'Still unclear — the attempt did not closely match the target text yet. Listen, then repeat slowly.',
    explanation: candidate.explanation,
    suggestedCorrection: candidate.expectedAnswer,
  };
}

/**
 * Qualitative local evaluation for listening practice review items
 * (Phase 1). The expected response is a word/phrase/meaning the learner
 * had to recognize by listening; comparison is normalized text only.
 * No comprehension percentage, band, or score is ever produced.
 */
export function evaluateListeningPracticeLocally(
  candidate: ReviewItemCandidate,
  userAnswer: string,
): EvaluationResult {
  const normUser = normalizeText(userAnswer);
  if (!normUser) {
    return {
      result: 'incorrect',
      feedback: 'No answer was given. Insufficient evidence — replay the item and try once more.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  const normExpected = normalizeText(candidate.expectedAnswer);
  if (normUser === normExpected) {
    return {
      result: 'correct',
      feedback: 'Correct — you recognized the target clearly.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }

  const expectedWords = normExpected.split(' ').filter((w) => w.length > 1);
  const matchedCount = expectedWords.filter((w) => normUser.includes(w)).length;
  const matchRatio = expectedWords.length > 0 ? matchedCount / expectedWords.length : 0;

  if (matchRatio >= 0.8) {
    return {
      result: 'correct',
      feedback: 'Correct enough — the key words were recognized in your answer.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }
  if (matchRatio >= 0.4) {
    return {
      result: 'partial',
      feedback: 'Partial — parts of the meaning were recognized, parts are still unclear. Listen again.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }
  return {
    result: 'incorrect',
    feedback: 'Still unclear — the answer did not reflect the target yet. Replay it slowly and listen for the key words.',
    explanation: candidate.explanation,
    suggestedCorrection: candidate.expectedAnswer,
  };
}

/**
 * ReviewEvaluator: Evaluates learner answers deterministically or using AI provider.
 */
export class ReviewEvaluator {
  constructor(private readonly aiProvider?: AIProvider) {}

  async evaluate(
    candidate: ReviewItemCandidate,
    userAnswer: string,
    coachingContext?: CoachingContext,
  ): Promise<EvaluationResult> {
    if (
      candidate.exerciseType === 'vocabulary_recall' ||
      candidate.exerciseType === 'fill_the_gap'
    ) {
      return evaluateSimpleItemLocally(candidate, userAnswer);
    }

    // Phase 1 pronunciation practice is always evaluated locally from the
    // transcript (qualitative). No numeric score, no acoustic claims.
    if (candidate.exerciseType === 'pronunciation_repeat') {
      return evaluatePronunciationRepeatLocally(candidate, userAnswer);
    }

    // Phase 1 listening practice is always evaluated locally (qualitative
    // recognition). No comprehension score, no fabricated understanding.
    if (candidate.exerciseType === 'listening_practice') {
      return evaluateListeningPracticeLocally(candidate, userAnswer);
    }

    if (this.aiProvider) {
      try {
        const systemPrompt = 'You are an empathetic, expert English tutor evaluating practice exercises. Strictly return valid JSON.';
        const prompt = `You are evaluating an English learner's answer in a review session.
Exercise type: ${candidate.exerciseType}
Prompt: ${candidate.prompt}
Context: ${candidate.contextSentence ?? candidate.definition ?? 'N/A'}
Expected answer: ${candidate.expectedAnswer}
Learner's answer: "${userAnswer}"

Evaluate the answer. You MUST respond with ONLY a valid JSON object matching this schema:
{
  "result": "correct" | "partial" | "incorrect",
  "feedback": "string (short encouraging qualitative feedback)",
  "explanation": "string (clear explanation of the grammar or vocabulary point)",
  "suggestedCorrection": "string (natural standard English phrasing)"
}
Important: Do NOT include any numbers, ratings, or percentages. Only qualitative feedback.`;

        const request: ConversationRequest = {
          systemPrompt,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          mode: 'coach',
          topic: 'Review Evaluation',
          coachingContext: coachingContext ?? createNeutralReviewCoachingContext(),
        };

        const resultObj = await this.aiProvider.generate(request);
        if (resultObj.ok && resultObj.response && resultObj.response.content) {
          const rawText = resultObj.response.content.trim();
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const resultValue: QualitativeResult =
              parsed.result === 'correct' || parsed.result === 'partial'
                ? parsed.result
                : 'incorrect';

            return {
              result: resultValue,
              feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'Feedback received.',
              explanation: typeof parsed.explanation === 'string' ? parsed.explanation : candidate.explanation,
              suggestedCorrection:
                typeof parsed.suggestedCorrection === 'string'
                  ? parsed.suggestedCorrection
                  : candidate.expectedAnswer,
            };
          }
        }
      } catch {
        // Fallback to local evaluation if AI fails or returns invalid format
      }
    }

    return evaluateOpenEndedLocally(candidate, userAnswer);
  }
}
