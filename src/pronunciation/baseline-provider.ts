/**
 * src/pronunciation/baseline-provider.ts
 *
 * Phase 1 baseline PronunciationProvider.
 *
 * HONEST SCOPE: this provider performs NO acoustic analysis. The current
 * stack has no pronunciation-scoring capability, so this provider derives
 * qualitative observations ONLY from comparing the speech-to-text
 * transcript against a known expected target text (transcript comparison
 * and STT-substitution evidence).
 *
 * - Without an expected target there is no honest basis for a diagnosis,
 *   so it returns `insufficientEvidence` instead of inventing one.
 * - Transcript mismatch is NEVER reported as "phoneme accuracy".
 * - No audio, mouth/tongue, or acoustic data is ever invented.
 */

import type {
  PronunciationAnalysis,
  PronunciationAnalysisInput,
  PronunciationObservation,
  PronunciationProvider,
} from './types';

/** Normalize text for comparison: lowercase, trimmed, punctuation stripped. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'’]/g, '')
    .replace(/\s+/g, ' ');
}

/** Levenshtein distance for close-substitution detection. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

/** Maximum observations returned per analysis (keep feedback compact). */
const MAX_OBSERVATIONS = 5;

/**
 * Deterministic baseline provider: transcript-derived evidence only.
 */
export function createTranscriptComparisonPronunciationProvider(): PronunciationProvider {
  return {
    id: 'transcript-comparison-baseline',

    async analyze(input: PronunciationAnalysisInput): Promise<PronunciationAnalysis> {
      const transcript = input.transcript.trim();
      const expected = input.expectedText?.trim();

      // Without a known target, a transcript alone cannot honestly ground a
      // pronunciation diagnosis. Say so instead of fabricating one.
      if (!transcript || !expected) {
        return {
          provider: this.id,
          evidenceLevel: 'transcript_comparison',
          observations: [],
          insufficientEvidence: true,
          notes: !transcript
            ? 'No transcript was available for this turn, so pronunciation could not be judged.'
            : 'No target text is associated with this turn, so pronunciation could not be judged from the transcript alone.',
        };
      }

      const normTranscript = normalizeForComparison(transcript);
      const expectedWords = normalizeForComparison(expected).split(' ').filter((w) => w.length > 0);
      const spokenWords = normTranscript.split(' ').filter((w) => w.length > 0);
      const remainingSpoken = [...spokenWords];

      const observations: PronunciationObservation[] = [];
      let recognizedCount = 0;

      for (const expectedWord of expectedWords) {
        const exactIdx = remainingSpoken.indexOf(expectedWord);
        if (exactIdx !== -1) {
          remainingSpoken.splice(exactIdx, 1);
          recognizedCount += 1;
          continue;
        }

        if (observations.length >= MAX_OBSERVATIONS) continue;

        // Ending dropped/changed: stem recognized without a common suffix.
        const stem = expectedWord.replace(/(ed|d|s|es|ing)$/, '');
        const stemIdx =
          stem.length >= 3 ? remainingSpoken.findIndex((w) => w === stem) : -1;
        if (stemIdx !== -1) {
          remainingSpoken.splice(stemIdx, 1);
          recognizedCount += 1;
          observations.push({
            type: 'ending',
            target: expectedWord,
            observed: remainingSpoken.length >= 0 ? stem : undefined,
            description: `The transcript shows "${stem}" where the target has "${expectedWord}" — the word ending may not be clearly pronounced.`,
            evidence: 'stt_substitution',
            confidence: 'medium',
            coachingHint: `Try keeping the full ending: say "${expectedWord}" slowly and hold the final part.`,
          });
          continue;
        }

        // Close substitution: likely a mispronounced word.
        const closeIdx = remainingSpoken.findIndex(
          (w) =>
            w.length >= 4 &&
            expectedWord.length >= 4 &&
            Math.abs(w.length - expectedWord.length) <= 2 &&
            levenshtein(w, expectedWord) <= 2,
        );
        if (closeIdx !== -1) {
          const observed = remainingSpoken[closeIdx];
          remainingSpoken.splice(closeIdx, 1);
          observations.push({
            type: 'word_pronunciation',
            target: expectedWord,
            observed,
            description: `The transcript shows "${observed}" where the target is "${expectedWord}" — the word may not be fully clear.`,
            evidence: 'stt_substitution',
            confidence: 'medium',
            coachingHint: `Practice saying "${expectedWord}" clearly and slowly.`,
          });
          continue;
        }

        // Not recognized at all.
        observations.push({
          type: 'word_pronunciation',
          target: expectedWord,
          description: `"${expectedWord}" was not recognizable in the transcript of this attempt.`,
          evidence: 'transcript_comparison',
          confidence: 'low',
          coachingHint: `Listen to "${expectedWord}" and repeat it slowly, word by word.`,
        });
      }

      // Words spoken that are not in the target at all (rhythm/extra content).
      if (observations.length < MAX_OBSERVATIONS && remainingSpoken.length > expectedWords.length) {
        observations.push({
          type: 'rhythm',
          description:
            'The attempt contained noticeably more words than the target — try matching the target phrasing.',
          evidence: 'transcript_comparison',
          confidence: 'low',
          coachingHint: 'Repeat only the target phrase, at a steady pace.',
        });
      }

      const matchRatio = expectedWords.length > 0 ? recognizedCount / expectedWords.length : 0;
      const overallIntelligibility =
        observations.length === 0 && matchRatio >= 0.99
          ? 'clear'
          : matchRatio >= 0.6
            ? 'partially_clear'
            : 'unclear';

      return {
        provider: this.id,
        evidenceLevel: 'transcript_comparison',
        observations,
        overallIntelligibility,
        notes:
          'Transcript-derived evidence only — speech recognition comparison against the target. No acoustic analysis was performed.',
      };
    },
  };
}
