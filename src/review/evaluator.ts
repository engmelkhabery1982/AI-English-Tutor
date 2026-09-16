/**
 * src/review/evaluator.ts
 *
 * Local Deterministic Evaluation for simple items (vocabulary recall, fill-the-gap)
 * and AI-Powered / Fallback Evaluation for open-ended exercises (sentence correction, natural phrasing).
 *
 * Strictly qualitative feedback: 'correct' | 'partial' | 'incorrect'. No numeric scores.
 */

import type { AIProvider } from '../domain/providers/ai';
import type { EvaluationResult, QualitativeResult, ReviewItemCandidate } from './types';

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
    // If user text contains the expected correction words
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

  // If expression use: check if user used the expression
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

  // If natural phrasing
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
 * ReviewEvaluator: Evaluates learner answers deterministically or using AI provider.
 */
export class ReviewEvaluator {
  constructor(private readonly aiProvider?: AIProvider) {}

  async evaluate(
    candidate: ReviewItemCandidate,
    userAnswer: string,
  ): Promise<EvaluationResult> {
    // 1. Simple items are always evaluated locally for speed & determinism
    if (
      candidate.exerciseType === 'vocabulary_recall' ||
      candidate.exerciseType === 'fill_the_gap'
    ) {
      return evaluateSimpleItemLocally(candidate, userAnswer);
    }

    // 2. Open-ended items: use AI Provider if available
    if (this.aiProvider) {
      try {
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

        const response = await this.aiProvider.chat(
          [{ role: 'user', content: prompt }],
          { systemPrompt: 'You are an empathetic, expert English tutor evaluating practice exercises. Strictly return valid JSON.' },
        );

        const rawText = response.text?.trim() ?? '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const result: QualitativeResult =
            parsed.result === 'correct' || parsed.result === 'partial'
              ? parsed.result
              : 'incorrect';

          return {
            result,
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'Feedback received.',
            explanation: typeof parsed.explanation === 'string' ? parsed.explanation : candidate.explanation,
            suggestedCorrection:
              typeof parsed.suggestedCorrection === 'string'
                ? parsed.suggestedCorrection
                : candidate.expectedAnswer,
          };
        }
      } catch {
        // Fallback to local evaluation if AI fails or returns invalid format
      }
    }

    // 3. Fallback to local evaluation
    return evaluateOpenEndedLocally(candidate, userAnswer);
  }
}
