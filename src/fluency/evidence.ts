/**
 * src/fluency/evidence.ts
 *
 * WP-3 repetition evidence: deterministic detection + honest comparison.
 *
 * RULES
 * - DETERMINISTIC: every detector is a pure function of (transcript, task).
 *   Same text + same task always yields the same evidence.
 * - NO NUMERIC FLUENCY RATING: the comparison produces descriptive evidence
 *   lines plus a bounded set of allowed qualitative claims, each emitted ONLY
 *   when directly supported by real structured evidence. There is no
 *   percentage, no score, no rating, no "improved N%" — anywhere.
 * - LENGTH IS DESCRIPTIVE ONLY: word counts may be reported as what they
 *   are, but a longer answer is never rated better and length never feeds
 *   any claim or the support policy.
 * - DEMO HONESTY: attempts whose feedback was not produced by a real AI tutor
 *   are flagged untrusted. Untrusted attempts are COUNTED (the attempt really
 *   happened) but never compared evaluatively and never feed de-scaffolding.
 * - PRONUNCIATION: qualitative lines from the EXISTING engine pass through
 *   verbatim (bounded). When unavailable, pronunciation is omitted — never
 *   invented, never scored.
 * - READ-ONLY: this module persists nothing. LearningPersistenceService (used
 *   only by the existing speaking service, once per committed turn) remains
 *   the sole mutation owner, so comparison can never double-count evidence.
 */

import type { IsoDate } from '../domain/shared/types';
import type { ConversationFeedback } from '../providers/ai/types';
import type {
  FluencyAttemptEvidence,
  FluencyComparison,
  FluencyCorrectionPresence,
  FluencySupportLevel,
  FluencyTargetExpression,
  FluencyTask,
  FluencyTaskPoint,
} from './types';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** Maximum pronunciation lines carried into a comparison (verbatim). */
export const MAX_COMPARISON_PRONUNCIATION_LINES = 2;

/* ------------------------------------------------------------------ *
 * Normalization (shared by every detector — one rule, everywhere)
 * ------------------------------------------------------------------ */

/**
 * Normalize learner text for deterministic matching: lowercase, collapse
 * punctuation/whitespace to single spaces, trim. Matching is intentionally
 * simple substring matching over this form — explainable, never AI-judged.
 */
export function normalizeEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Descriptive word count only (never a quality signal by itself). */
export function countEvidenceWords(text: string): number {
  const normalized = normalizeEvidenceText(text);
  if (normalized.length === 0) return 0;
  return normalized.split(' ').length;
}

/* ------------------------------------------------------------------ *
 * Deterministic detectors
 * ------------------------------------------------------------------ */

/**
 * Target expressions found in the transcript. A target counts as used when
 * its normalized form appears in the normalized transcript. Deterministic:
 * same transcript + same targets always yields the same list (catalog order).
 */
export function detectTargetExpressions(
  transcript: string,
  targets: readonly FluencyTargetExpression[],
): readonly string[] {
  const normalized = ` ${normalizeEvidenceText(transcript)} `;
  const used: string[] = [];
  for (const target of targets) {
    const needle = normalizeEvidenceText(target.expression);
    if (needle.length === 0) continue;
    if (normalized.includes(` ${needle} `) || normalized.includes(` ${needle}'`)) {
      used.push(target.expression);
    }
  }
  return used;
}

/**
 * Task-point ids covered by the transcript. A point counts as covered when
 * ANY of its keywords is found (normalized substring match). Deterministic:
 * same transcript + same points always yields the same list (catalog order).
 */
export function detectTaskPoints(
  transcript: string,
  points: readonly FluencyTaskPoint[],
): readonly string[] {
  const normalized = ` ${normalizeEvidenceText(transcript)} `;
  const covered: string[] = [];
  for (const point of points) {
    const hit = point.keywords.some((keyword) => {
      const needle = normalizeEvidenceText(keyword);
      if (needle.length === 0) return false;
      return (
        normalized.includes(` ${needle} `) ||
        normalized.includes(` ${needle}'`) ||
        normalized.includes(` ${needle}`)
      );
    });
    if (hit) covered.push(point.id);
  }
  return covered;
}

/** Severity rank for comparison (higher = more severe). Pure. */
export function rankCorrectionSeverity(
  severity: 'incorrect' | 'unnatural' | 'minor' | null,
): number {
  switch (severity) {
    case 'incorrect':
      return 3;
    case 'unnatural':
      return 2;
    case 'minor':
      return 1;
    case null:
      return 0;
  }
}

/** Human word for a severity (learner-facing, qualitative). */
function severityWord(severity: 'incorrect' | 'unnatural' | 'minor'): string {
  switch (severity) {
    case 'incorrect':
      return 'important';
    case 'unnatural':
      return 'naturalness';
    case 'minor':
      return 'small';
  }
}

/* ------------------------------------------------------------------ *
 * Attempt evidence assembly (pure — the caller owns commitment checks)
 * ------------------------------------------------------------------ */

export interface BuildAttemptEvidenceInput {
  readonly attemptNumber: number;
  readonly task: FluencyTask;
  /** The committed learner transcript (exactly as submitted). */
  readonly transcript: string;
  /** Structured feedback of the committed turn (null when absent). */
  readonly feedback: ConversationFeedback | null;
  /** False for demo/offline attempts (feedback was never real). */
  readonly isRealAI: boolean;
  /**
   * Real qualitative pronunciation lines from the EXISTING engine for this
   * attempt (empty/omitted when pronunciation was unavailable).
   */
  readonly pronunciationLines?: readonly string[];
  readonly now: IsoDate;
}

/**
 * Assemble structured evidence for ONE committed attempt. Pure.
 *
 * Honesty: when `isRealAI` is false the correction is ignored (demo feedback
 * is scripted, not real tutoring) and the evidence is flagged untrusted, so
 * downstream comparison and de-scaffolding can never treat it as real.
 */
export function buildAttemptEvidence(
  input: BuildAttemptEvidenceInput,
): FluencyAttemptEvidence {
  const trusted = input.isRealAI;
  const correction = input.feedback?.correction;
  const presence: FluencyCorrectionPresence =
    trusted && correction && correction.original && correction.improved
      ? { present: true, severity: correction.severity }
      : { present: false };
  const pronunciationLines = trusted
    ? (input.pronunciationLines ?? []).filter((line) => line.trim().length > 0)
    : [];
  return {
    attemptNumber: input.attemptNumber,
    taskId: input.task.id,
    transcript: input.transcript,
    wordCount: countEvidenceWords(input.transcript),
    pointsCovered: detectTaskPoints(input.transcript, input.task.taskPoints),
    targetExpressionsUsed: trusted
      ? detectTargetExpressions(input.transcript, input.task.targetExpressions)
      : [],
    correction: presence,
    pronunciationLines,
    trusted,
    committedAt: input.now,
  };
}

/** True when the attempt covered every required task point. Pure. */
export function isTaskCompleted(
  evidence: FluencyAttemptEvidence,
  task: FluencyTask,
): boolean {
  if (task.taskPoints.length === 0) return true;
  return evidence.pointsCovered.length >= task.taskPoints.length;
}

export interface CompareAttemptsOptions {
  /** Support the previous attempt ran with (for the "less support" claim). */
  readonly previousSupport: FluencySupportLevel;
  /** Support the current attempt ran with. */
  readonly currentSupport: FluencySupportLevel;
  readonly now: IsoDate;
}

/* ------------------------------------------------------------------ *
 * Repetition comparison (real structured evidence only)
 * ------------------------------------------------------------------ */

/**
 * Compare two consecutive committed attempts of the SAME task.
 *
 * The output is evidence lines plus ONLY these allowed claims, each gated:
 * - "more complete"            ← strictly more task points covered;
 * - "fewer corrections"        ← previous had a correction, current has none;
 * - "target expression used"   ← expression detected in the current attempt;
 * - "less prompting needed"    ← current ran with less support AND completed.
 *
 * Untrusted (demo) attempts are never compared evaluatively: the output is an
 * honest notice instead. Length appears only as a descriptive line, never as
 * a better/worse judgment. Pure.
 */
export function compareAttempts(
  task: FluencyTask,
  previous: FluencyAttemptEvidence,
  current: FluencyAttemptEvidence,
  options: CompareAttemptsOptions,
): FluencyComparison {
  const base = {
    taskId: task.id,
    previousAttempt: previous.attemptNumber,
    currentAttempt: current.attemptNumber,
    generatedAt: options.now,
  };

  if (previous.taskId !== task.id || current.taskId !== task.id) {
    return {
      ...base,
      lines: ['These attempts belong to different tasks, so they are not compared.'],
      hasEvidence: false,
    };
  }

  // Demo/offline honesty: scripted feedback is not real evidence, so attempts
  // backed by it are counted but never compared evaluatively.
  if (!previous.trusted || !current.trusted) {
    return {
      ...base,
      lines: [
        'Offline demo attempts are not compared: nothing here is real AI feedback.',
      ],
      hasEvidence: false,
    };
  }

  const lines: string[] = [];
  const totalPoints = task.taskPoints.length;
  const previousCovered = previous.pointsCovered.length;
  const currentCovered = current.pointsCovered.length;

  // 1. Task-point coverage (descriptive evidence).
  if (totalPoints > 0) {
    lines.push(
      `This attempt covered ${currentCovered} of ${totalPoints} key points ` +
        `(previous attempt: ${previousCovered} of ${totalPoints}).`,
    );
  }

  // 2. Correction presence (descriptive evidence, qualitative only).
  const previousSeverity = previous.correction.present
    ? previous.correction.severity
    : null;
  const currentSeverity = current.correction.present
    ? current.correction.severity
    : null;
  if (currentSeverity === null && previousSeverity === null) {
    lines.push('Neither attempt needed a correction.');
  } else if (currentSeverity === null) {
    lines.push('This attempt needed no correction.');
  } else if (previousSeverity === null) {
    lines.push(
      `This attempt had one ${severityWord(currentSeverity)} correction to look at.`,
    );
  } else if (rankCorrectionSeverity(currentSeverity) < rankCorrectionSeverity(previousSeverity)) {
    lines.push('This attempt had a lighter correction than the previous one.');
  } else {
    lines.push('Both attempts had a correction to look at.');
  }

  // 3. Target expressions used in THIS attempt (deterministic detection).
  for (const expression of current.targetExpressionsUsed) {
    lines.push(`You used "${expression}" in this attempt.`);
  }

  // 4. Length — DESCRIPTIVE ONLY. Never better/worse, never a claim.
  lines.push(
    `This answer was ${current.wordCount} words; the previous one was ${previous.wordCount} words.`,
  );

  // 5. Pronunciation — real qualitative lines pass through verbatim; when the
  // engine produced nothing, pronunciation is omitted (never invented).
  for (const line of current.pronunciationLines.slice(
    0,
    MAX_COMPARISON_PRONUNCIATION_LINES,
  )) {
    lines.push(line);
  }

  // ---- Allowed claims (each strictly gated on the evidence above) ----
  const claims: string[] = [];
  if (totalPoints > 0 && currentCovered > previousCovered) {
    claims.push('More complete: you covered more of the key points this time.');
  }
  if (previousSeverity !== null && currentSeverity === null) {
    claims.push('Fewer corrections were needed this time.');
  }
  for (const expression of current.targetExpressionsUsed) {
    if (!previous.targetExpressionsUsed.includes(expression)) {
      claims.push(`Target expression used successfully: "${expression}".`);
    }
  }
  if (
    isTaskCompleted(current, task) &&
    supportRank(options.currentSupport) > supportRank(options.previousSupport)
  ) {
    claims.push('Less prompting needed: you completed the task with less support.');
  }

  return { ...base, lines: [...lines, ...claims], hasEvidence: true };
}

/** Support rank (higher = less support). Pure. */
function supportRank(level: FluencySupportLevel): number {
  switch (level) {
    case 'guided':
      return 0;
    case 'supported':
      return 1;
    case 'independent':
      return 2;
  }
}
