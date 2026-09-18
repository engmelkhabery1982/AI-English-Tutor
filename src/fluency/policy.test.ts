/**
 * src/fluency/policy.test.ts
 *
 * WP-3 pure-policy tests: task catalog, de-scaffolding policy, repetition
 * evidence and the clarification/repair policy.
 *
 * These modules are PURE (no I/O, no AI, no clock, no randomness), so every
 * test pins exact behavior: bounds, determinism, honesty gates and the
 * absolute ban on numeric fluency improvement claims.
 */

import { describe, it, expect } from 'vitest';

import type { CefrLevelInput } from '../domain/shared/types';
import type { ConversationFeedback } from '../providers/ai/types';
import type { FluencySupportLevel } from './types';

import {
  MAX_ROUNDS_PER_TASK,
  MAX_SEQUENCING_PHRASES,
  MAX_TASK_POINTS,
  MAX_TASK_TARGET_EXPRESSIONS,
  REPAIR_PRACTICE_LABEL,
  buildFluencyOpeningInstruction,
  cuesForSupport,
  getFluencyTask,
  getTransferTask,
  listFluencyTasks,
  repeatPromptFor,
} from './tasks';
import {
  CONSECUTIVE_STRONG_REQUIRED,
  SUPPORT_LEVELS,
  initialSupportLevel,
  isStrongAttempt,
  resolveSupportLevel,
  stepDownSupport,
} from './support-policy';
import {
  buildAttemptEvidence,
  compareAttempts,
  countEvidenceWords,
  detectTargetExpressions,
  detectTaskPoints,
  isTaskCompleted,
  normalizeEvidenceText,
  rankCorrectionSeverity,
} from './evidence';
import {
  INSUFFICIENT_WORD_COUNT,
  MAX_REPAIR_SUPPORT_MOVES,
  REPAIR_SUPPORT_MOVES,
  evaluateRepairTrigger,
  repairSupportFor,
} from './repair-policy';

const NOW = '2026-09-18T10:00:00.000Z';

const TASK_ID = 'describe-work-problem';

function testTask() {
  const task = getFluencyTask(TASK_ID);
  if (!task) throw new Error('test task missing from catalog');
  return task;
}

function correctionFeedback(
  severity: 'incorrect' | 'unnatural' | 'minor',
): ConversationFeedback {
  return {
    correction: {
      original: 'I have went',
      improved: 'I went',
      explanation: 'Use the past simple here.',
      severity,
    },
  };
}

/* Banned numeric-improvement vocabulary: must never appear in comparisons. */
const BANNED_IMPROVEMENT_PATTERNS: readonly RegExp[] = [
  /\d+\s*%/,
  /improved\s+\d/i,
  /improvement\s+of\s+\d/i,
  /fluency\s+(score|rating|percent|percentage|level\s+\d)/i,
  /\bscore\b/i,
  /\brating\b/i,
  /%.*fluency|fluency.*%/i,
  /\bXP\b/,
  /\bstreak\b/i,
  /\bstars?\b/i,
];

function expectNoNumericImprovement(lines: readonly string[]): void {
  const text = lines.join('\n');
  for (const pattern of BANNED_IMPROVEMENT_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
}

/* ------------------------------------------------------------------ *
 * Task catalog
 * ------------------------------------------------------------------ */

describe('fluency task catalog', () => {
  it('exposes a stable, bounded task for every kind', () => {
    const tasks = listFluencyTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.id.trim().length).toBeGreaterThan(0);
      expect(task.prompt.trim().length).toBeGreaterThan(0);
      expect(task.taskPoints.length).toBeGreaterThan(0);
      expect(task.taskPoints.length).toBeLessThanOrEqual(MAX_TASK_POINTS);
      expect(task.targetExpressions.length).toBeLessThanOrEqual(
        MAX_TASK_TARGET_EXPRESSIONS,
      );
      expect(task.sequencingPhrases.length).toBeLessThanOrEqual(
        MAX_SEQUENCING_PHRASES,
      );
      expect(task.learningTarget.trim().length).toBeGreaterThan(0);
    }
    expect(listFluencyTasks('repetition').length).toBeGreaterThan(0);
    expect(listFluencyTasks('monologue').length).toBeGreaterThan(0);
    expect(listFluencyTasks('repair').length).toBeGreaterThan(0);
  });

  it('keeps stable task identity (same id every lookup)', () => {
    expect(getFluencyTask(TASK_ID)?.id).toBe(TASK_ID);
    expect(getFluencyTask(TASK_ID)).toBe(getFluencyTask(TASK_ID));
    expect(getFluencyTask('no-such-task')).toBeNull();
  });

  it('bounds repetition rounds', () => {
    expect(MAX_ROUNDS_PER_TASK).toBeGreaterThanOrEqual(3);
    expect(MAX_ROUNDS_PER_TASK).toBeLessThanOrEqual(6);
  });

  it('keeps the same learning target across a transfer variant', () => {
    const task = getFluencyTask('explain-project-delay');
    if (!task) throw new Error('transfer source task missing');
    const transfer = getTransferTask(task);
    expect(transfer).not.toBeNull();
    expect(transfer?.id).not.toBe(task.id);
    expect(transfer?.learningTarget).toBe(task.learningTarget);
    // A task without a transfer variant honestly reports none.
    expect(getTransferTask(testTask())).toBeNull();
  });

  it('builds a tutor opening without scores, ratings or fake misunderstanding', () => {
    for (const task of listFluencyTasks()) {
      const instruction = buildFluencyOpeningInstruction(task);
      expect(instruction).toContain(task.prompt);
      expectNoNumericImprovement([instruction]);
      // "Misunderstand" may only appear inside the honesty guard that FORBIDS
      // faking it — the tutor is never asked to fake misunderstanding.
      const withoutGuard = instruction
        .toLowerCase()
        .split('never pretend to misunderstand something clear.')
        .join('');
      expect(withoutGuard).not.toContain('misunderstand');
      expect(withoutGuard).not.toContain('pretend');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Support cues (bounded by support level)
 * ------------------------------------------------------------------ */

describe('fluency support cues', () => {
  it('guided monologue exposes bounded cues (never a full script)', () => {
    const task = getFluencyTask('tell-recent-story');
    if (!task) throw new Error('monologue task missing');
    const cues = cuesForSupport(task, 'guided');
    expect(cues.taskOnly).toBe(false);
    expect(cues.openingIdea).toBe(task.openingIdea);
    expect(cues.taskPoints.length).toBeGreaterThan(0);
    expect(cues.taskPoints.length).toBeLessThanOrEqual(MAX_TASK_POINTS);
    expect(cues.targetExpressions.length).toBeLessThanOrEqual(
      MAX_TASK_TARGET_EXPRESSIONS,
    );
    expect(cues.sequencingPhrases.length).toBeLessThanOrEqual(
      MAX_SEQUENCING_PHRASES,
    );
    expect(cues.closingPrompt).toBe(task.closingPrompt);
  });

  it('supported shows fewer cues; independent shows the task only', () => {
    const task = testTask();
    const supported = cuesForSupport(task, 'supported');
    expect(supported.taskOnly).toBe(false);
    expect(supported.openingIdea).toBeNull();
    expect(supported.targetExpressions).toEqual([]);
    expect(supported.sequencingPhrases).toEqual([]);
    expect(supported.taskPoints.length).toBeGreaterThan(0);

    const independent = cuesForSupport(task, 'independent');
    expect(independent.taskOnly).toBe(true);
    expect(independent.openingIdea).toBeNull();
    expect(independent.taskPoints).toEqual([]);
    expect(independent.targetExpressions).toEqual([]);
    expect(independent.sequencingPhrases).toEqual([]);
    expect(independent.closingPrompt).toBeNull();
  });

  it('repeat prompts are deterministic per round and support level', () => {
    const task = testTask();
    const a = repeatPromptFor(task, 2, 'guided');
    const b = repeatPromptFor(task, 2, 'guided');
    expect(b).toEqual(a);
    expect(a.taskId).toBe(task.id);
    expect(a.nextAttemptNumber).toBe(2);
    expect(repeatPromptFor(task, 3, 'independent').text).not.toBe(
      repeatPromptFor(task, 2, 'guided').text,
    );
    expectNoNumericImprovement([a.text]);
  });
});

/* ------------------------------------------------------------------ *
 * De-scaffolding policy (pure, deterministic, bounded)
 * ------------------------------------------------------------------ */

describe('fluency de-scaffolding policy', () => {
  const LEVELS: readonly CefrLevelInput[] = [
    'unknown',
    'A1',
    'A2',
    'B1',
    'B2',
    'C1',
    'C2',
  ];

  it('starts guided for beginners and supported for higher levels (never independent)', () => {
    expect(initialSupportLevel('unknown')).toBe('guided');
    expect(initialSupportLevel('A1')).toBe('guided');
    expect(initialSupportLevel('A2')).toBe('guided');
    expect(initialSupportLevel('B1')).toBe('supported');
    expect(initialSupportLevel('C2')).toBe('supported');
    for (const level of LEVELS) {
      expect(initialSupportLevel(level)).not.toBe('independent');
    }
  });

  it('steps down exactly one level at a time (independent is the floor)', () => {
    expect(stepDownSupport('guided')).toBe('supported');
    expect(stepDownSupport('supported')).toBe('independent');
    expect(stepDownSupport('independent')).toBe('independent');
  });

  it('recognizes a strong attempt only when completed with no worse than a minor correction', () => {
    expect(
      isStrongAttempt({ completed: true, correctionSeverity: null }),
    ).toBe(true);
    expect(
      isStrongAttempt({ completed: true, correctionSeverity: 'minor' }),
    ).toBe(true);
    expect(
      isStrongAttempt({ completed: true, correctionSeverity: 'unnatural' }),
    ).toBe(false);
    expect(
      isStrongAttempt({ completed: true, correctionSeverity: 'incorrect' }),
    ).toBe(false);
    expect(
      isStrongAttempt({ completed: false, correctionSeverity: null }),
    ).toBe(false);
  });

  it('never decreases support because of one success', () => {
    expect(CONSECUTIVE_STRONG_REQUIRED).toBeGreaterThan(1);
    const level = resolveSupportLevel({
      learnerLevel: 'B1',
      attemptNumber: 2,
      priorSupport: 'guided',
      isRealAI: true,
      failed: false,
      consecutiveStrongAttempts: 1,
    });
    expect(level).toBe('guided');
  });

  it('decreases support across consecutive strong attempts', () => {
    expect(
      resolveSupportLevel({
        learnerLevel: 'B1',
        attemptNumber: 2,
        priorSupport: 'guided',
        isRealAI: true,
        failed: false,
        consecutiveStrongAttempts: 2,
      }),
    ).toBe('supported');
    expect(
      resolveSupportLevel({
        learnerLevel: 'B1',
        attemptNumber: 4,
        priorSupport: 'supported',
        isRealAI: true,
        failed: false,
        consecutiveStrongAttempts: 3,
      }),
    ).toBe('independent');
  });

  it('does not decrease support on a failed attempt', () => {
    expect(
      resolveSupportLevel({
        learnerLevel: 'B1',
        attemptNumber: 3,
        priorSupport: 'guided',
        isRealAI: true,
        failed: true,
        consecutiveStrongAttempts: 5,
      }),
    ).toBe('guided');
  });

  it('never de-scaffolds on demo/offline attempts', () => {
    expect(
      resolveSupportLevel({
        learnerLevel: 'B1',
        attemptNumber: 3,
        priorSupport: 'guided',
        isRealAI: false,
        failed: false,
        consecutiveStrongAttempts: 5,
      }),
    ).toBe('guided');
  });

  it('is deterministic: same inputs always give the same support level', () => {
    const input = {
      learnerLevel: 'B1' as CefrLevelInput,
      attemptNumber: 3,
      priorSupport: 'supported' as FluencySupportLevel,
      isRealAI: true,
      failed: false,
      consecutiveStrongAttempts: 2,
    };
    const first = resolveSupportLevel(input);
    for (let i = 0; i < 25; i += 1) {
      expect(resolveSupportLevel({ ...input })).toBe(first);
    }
  });

  it('stays bounded over the whole input grid', () => {
    const priors: readonly FluencySupportLevel[] = SUPPORT_LEVELS;
    for (const learnerLevel of LEVELS) {
      for (const priorSupport of priors) {
        for (const attemptNumber of [1, 2, 3, 5]) {
          for (const isRealAI of [true, false]) {
            for (const failed of [true, false]) {
              for (const consecutiveStrongAttempts of [0, 1, 2, 4]) {
                const level = resolveSupportLevel({
                  learnerLevel,
                  attemptNumber,
                  priorSupport,
                  isRealAI,
                  failed,
                  consecutiveStrongAttempts,
                });
                expect(SUPPORT_LEVELS).toContain(level);
              }
            }
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Deterministic evidence detection
 * ------------------------------------------------------------------ */

describe('fluency evidence detection', () => {
  it('normalizes text deterministically', () => {
    expect(normalizeEvidenceText('  Hello,   WORLD! ')).toBe('hello world');
    expect(normalizeEvidenceText('')).toBe('');
    expect(normalizeEvidenceText('In the end...')).toBe('in the end');
  });

  it('counts words descriptively', () => {
    expect(countEvidenceWords('one two three')).toBe(3);
    expect(countEvidenceWords('  ')).toBe(0);
    expect(countEvidenceWords('Hello, world!')).toBe(2);
  });

  it('detects target-expression usage deterministically', () => {
    const task = testTask();
    const transcript =
      'We had to DEAL WITH a server problem. It took a while to figure out, but in the end it worked.';
    const first = detectTargetExpressions(transcript, task.targetExpressions);
    const second = detectTargetExpressions(transcript, task.targetExpressions);
    expect(second).toEqual(first);
    expect(first).toEqual(['deal with', 'figure out', 'in the end']);
    // Case-insensitive, punctuation-tolerant.
    expect(
      detectTargetExpressions('In the end, we won.', task.targetExpressions),
    ).toEqual(['in the end']);
    // Partial words never match.
    expect(
      detectTargetExpressions('I deal withx nothing.', task.targetExpressions),
    ).toEqual([]);
    expect(detectTargetExpressions('', task.targetExpressions)).toEqual([]);
  });

  it('detects task-point coverage deterministically', () => {
    const task = testTask();
    const transcript =
      'We had a difficult problem. I called the team and we fixed it. In the end I learned a lot.';
    const first = detectTaskPoints(transcript, task.taskPoints);
    expect(detectTaskPoints(transcript, task.taskPoints)).toEqual(first);
    expect(first).toEqual(['problem', 'action', 'outcome']);
    expect(detectTaskPoints('Hello there.', task.taskPoints)).toEqual([]);
  });

  it('ranks correction severity without inventing numbers for learners', () => {
    expect(rankCorrectionSeverity('incorrect')).toBeGreaterThan(
      rankCorrectionSeverity('unnatural'),
    );
    expect(rankCorrectionSeverity('unnatural')).toBeGreaterThan(
      rankCorrectionSeverity('minor'),
    );
    expect(rankCorrectionSeverity('minor')).toBeGreaterThan(
      rankCorrectionSeverity(null),
    );
  });

  it('builds trusted evidence for real attempts, untrusted for demo', () => {
    const task = testTask();
    const real = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: 'We had a problem and we fixed it in the end.',
      feedback: correctionFeedback('minor'),
      isRealAI: true,
      pronunciationLines: ['Stress the second syllable in "decide".'],
      now: NOW,
    });
    expect(real.trusted).toBe(true);
    expect(real.correction).toEqual({ present: true, severity: 'minor' });
    expect(real.pronunciationLines).toEqual([
      'Stress the second syllable in "decide".',
    ]);
    expect(real.targetExpressionsUsed).toEqual(['in the end']);

    const demo = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: 'We had a problem and we fixed it in the end.',
      feedback: correctionFeedback('incorrect'),
      isRealAI: false,
      pronunciationLines: ['Anything at all.'],
      now: NOW,
    });
    // Demo feedback is scripted: ignored, never trusted, never scored.
    expect(demo.trusted).toBe(false);
    expect(demo.correction).toEqual({ present: false });
    expect(demo.targetExpressionsUsed).toEqual([]);
    expect(demo.pronunciationLines).toEqual([]);
    // The attempt itself still counts (real transcript, real count).
    expect(demo.wordCount).toBeGreaterThan(0);
    expect(demo.transcript).toContain('problem');
  });

  it('omits pronunciation when unavailable (never invents it)', () => {
    const task = testTask();
    const evidence = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: 'We fixed the problem.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    expect(evidence.pronunciationLines).toEqual([]);
  });

  it('judges task completion from covered points only', () => {
    const task = testTask();
    const full = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript:
        'We had a difficult problem. I called the team and we fixed it. In the end I learned a lot.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    expect(isTaskCompleted(full, task)).toBe(true);
    const partial = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: 'We had a problem.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    expect(isTaskCompleted(partial, task)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Repetition comparison (real structured evidence only)
 * ------------------------------------------------------------------ */

describe('fluency repetition comparison', () => {
  // Attempt 1: thin answer with an important correction.
  const FIRST_TRANSCRIPT = 'We had a problem at work with the server.';
  // Attempt 2: fuller answer, no correction, target expression reused.
  const SECOND_TRANSCRIPT =
    'We had a difficult problem with the server. I called the team and we ' +
    'figured it out together. In the end it worked and I learned a lot.';

  function attempts() {
    const task = testTask();
    const previous = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: FIRST_TRANSCRIPT,
      feedback: correctionFeedback('incorrect'),
      isRealAI: true,
      now: NOW,
    });
    const current = buildAttemptEvidence({
      attemptNumber: 2,
      task,
      transcript: SECOND_TRANSCRIPT,
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    return { task, previous, current };
  }

  it('uses real structured evidence (points, correction, expressions)', () => {
    const { task, previous, current } = attempts();
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expect(comparison.taskId).toBe(task.id);
    expect(comparison.previousAttempt).toBe(1);
    expect(comparison.currentAttempt).toBe(2);
    expect(comparison.hasEvidence).toBe(true);
    const text = comparison.lines.join('\n');
    // Descriptive evidence lines.
    expect(text).toContain('3 of 3 key points');
    expect(text).toContain('needed no correction');
    expect(text).toContain('in the end');
    // Allowed claims, each directly supported.
    expect(text).toContain('More complete');
    expect(text).toContain('Fewer corrections');
    expect(text).toContain('Target expression used successfully');
  });

  it('never fabricates a numeric fluency improvement', () => {
    const { task, previous, current } = attempts();
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expectNoNumericImprovement(comparison.lines);
    // No hidden numeric field anywhere in the payload either.
    const payload = JSON.stringify(comparison);
    expect(payload).not.toMatch(/\d+\s*%/);
    expect(payload.toLowerCase()).not.toContain('score');
    expect(payload.toLowerCase()).not.toContain('rating');
  });

  it('never rates a longer answer automatically better', () => {
    const task = testTask();
    // Short attempt that completes the task; long attempt that rambles.
    const shortStrong = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript:
        'We had a difficult problem. I called support and we fixed it. In the end I learned a lot.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    const longWeak = buildAttemptEvidence({
      attemptNumber: 2,
      task,
      transcript:
        'Well you know it was like a really very long day and things were ' +
        'happening all over the place and everybody was talking and talking ' +
        'about stuff and more stuff and other stuff too and then there was ' +
        'even more talking about lots of different things again and again ' +
        'without ever really getting to any point at all whatsoever.',
      feedback: correctionFeedback('incorrect'),
      isRealAI: true,
      now: NOW,
    });
    expect(longWeak.wordCount).toBeGreaterThan(shortStrong.wordCount * 2);
    const comparison = compareAttempts(task, shortStrong, longWeak, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    const text = comparison.lines.join('\n');
    // Length appears only as a descriptive line.
    expect(text).toContain(
      `This answer was ${longWeak.wordCount} words; the previous one was ${shortStrong.wordCount} words.`,
    );
    // No better/worse judgment tied to length, and no false "more complete".
    expect(text.toLowerCase()).not.toContain('better');
    expect(text.toLowerCase()).not.toContain('worse');
    expect(text).not.toContain('More complete');
    expect(text).not.toContain('Fewer corrections');
    expectNoNumericImprovement(comparison.lines);
  });

  it('emits "less prompting needed" only with less support AND completion', () => {
    const { task, previous, current } = attempts();
    expect(isTaskCompleted(current, task)).toBe(true);
    const withLess = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'supported',
      now: NOW,
    });
    expect(withLess.lines.join('\n')).toContain('Less prompting needed');

    const sameSupport = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expect(sameSupport.lines.join('\n')).not.toContain('Less prompting needed');

    // Incomplete task with less support: no such claim.
    const incomplete = buildAttemptEvidence({
      attemptNumber: 2,
      task,
      transcript: 'We had a problem.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    expect(isTaskCompleted(incomplete, task)).toBe(false);
    const notCompleted = compareAttempts(task, previous, incomplete, {
      previousSupport: 'guided',
      currentSupport: 'supported',
      now: NOW,
    });
    expect(notCompleted.lines.join('\n')).not.toContain('Less prompting needed');
  });

  it('passes real pronunciation lines through verbatim (bounded)', () => {
    const { task, previous } = attempts();
    const current = buildAttemptEvidence({
      attemptNumber: 2,
      task,
      transcript: SECOND_TRANSCRIPT,
      feedback: null,
      isRealAI: true,
      pronunciationLines: [
        'Stress the second syllable in "decide".',
        'Link "turned out" smoothly.',
        'A third line that must be cut by the bound.',
      ],
      now: NOW,
    });
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expect(comparison.lines).toContain('Stress the second syllable in "decide".');
    expect(comparison.lines).toContain('Link "turned out" smoothly.');
    expect(comparison.lines).not.toContain(
      'A third line that must be cut by the bound.',
    );
  });

  it('omits pronunciation when the engine produced nothing', () => {
    const { task, previous, current } = attempts();
    expect(current.pronunciationLines).toEqual([]);
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expectNoNumericImprovement(comparison.lines);
    expect(comparison.hasEvidence).toBe(true);
  });

  it('refuses to compare attempts from different tasks', () => {
    const task = testTask();
    const other = getFluencyTask('tell-recent-story');
    if (!other) throw new Error('second task missing');
    const previous = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: FIRST_TRANSCRIPT,
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    const current = buildAttemptEvidence({
      attemptNumber: 1,
      task: other,
      transcript: 'Something happened last week.',
      feedback: null,
      isRealAI: true,
      now: NOW,
    });
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expect(comparison.hasEvidence).toBe(false);
    expect(comparison.lines.join('\n')).toContain('different tasks');
  });

  it('never compares demo attempts evaluatively (honest notice instead)', () => {
    const task = testTask();
    const previous = buildAttemptEvidence({
      attemptNumber: 1,
      task,
      transcript: FIRST_TRANSCRIPT,
      feedback: null,
      isRealAI: false,
      now: NOW,
    });
    const current = buildAttemptEvidence({
      attemptNumber: 2,
      task,
      transcript: SECOND_TRANSCRIPT,
      feedback: null,
      isRealAI: false,
      now: NOW,
    });
    const comparison = compareAttempts(task, previous, current, {
      previousSupport: 'guided',
      currentSupport: 'guided',
      now: NOW,
    });
    expect(comparison.hasEvidence).toBe(false);
    const text = comparison.lines.join('\n');
    expect(text).toContain('Offline demo attempts are not compared');
    expect(text).not.toContain('More complete');
    expect(text).not.toContain('Fewer corrections');
    expectNoNumericImprovement(comparison.lines);
  });

  it('is deterministic: same attempts always give the same comparison', () => {
    const { task, previous, current } = attempts();
    const options = {
      previousSupport: 'guided' as FluencySupportLevel,
      currentSupport: 'guided' as FluencySupportLevel,
      now: NOW,
    };
    const first = compareAttempts(task, previous, current, options);
    for (let i = 0; i < 10; i += 1) {
      expect(compareAttempts(task, previous, current, { ...options })).toEqual(first);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Clarification / repair policy
 * ------------------------------------------------------------------ */

describe('fluency repair policy', () => {
  it('requires actual evidence or an explicit repair scenario', () => {
    // Rich, corrected-free real content: no trigger.
    const denied = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'We had a difficult problem and we fixed it in the end.',
      wordCount: 12,
      pointsCoveredCount: 3,
      correctionSeverity: null,
      isRealAI: true,
      repairExercise: false,
      attemptNumber: 1,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('no-evidence');
    expect(denied.prompt).toBeNull();
    expect(denied.scripted).toBe(false);
  });

  it('triggers on actually insufficient content', () => {
    const decision = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'It broke.',
      wordCount: 2,
      pointsCoveredCount: 0,
      correctionSeverity: null,
      isRealAI: true,
      repairExercise: false,
      attemptNumber: 1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('insufficient-content');
    expect(decision.scripted).toBe(false);
    expect(decision.prompt).toContain('another way');
  });

  it('triggers on existing structured correction evidence', () => {
    for (const severity of ['incorrect', 'unnatural'] as const) {
      const decision = evaluateRepairTrigger({
        surface: 'fluency',
        transcript: 'A reasonably long answer that still got corrected by the tutor.',
        wordCount: 12,
        pointsCoveredCount: 2,
        correctionSeverity: severity,
        isRealAI: true,
        repairExercise: false,
        attemptNumber: 1,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('real-correction');
      expect(decision.scripted).toBe(false);
    }
    // A minor correction alone is not a repair trigger.
    const minor = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'A reasonably long answer with a tiny slip in it today.',
      wordCount: 11,
      pointsCoveredCount: 2,
      correctionSeverity: 'minor',
      isRealAI: true,
      repairExercise: false,
      attemptNumber: 1,
    });
    expect(minor.allowed).toBe(false);
  });

  it('never triggers on demo evidence (nothing real exists)', () => {
    const decision = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'It broke.',
      wordCount: 2,
      pointsCoveredCount: 0,
      correctionSeverity: 'incorrect',
      isRealAI: false,
      repairExercise: false,
      attemptNumber: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no-evidence');
  });

  it('identifies scripted misunderstanding as deliberate practice', () => {
    const decision = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'A perfectly clear answer about the route to the office.',
      wordCount: 11,
      pointsCoveredCount: 3,
      correctionSeverity: null,
      isRealAI: true,
      repairExercise: true,
      attemptNumber: 2,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('repair-exercise');
    expect(decision.scripted).toBe(true);
    expect(decision.practiceLabel).toBe(REPAIR_PRACTICE_LABEL);
    expect(decision.practiceLabel).toContain('on purpose');
    expect(decision.prompt).not.toBeNull();
  });

  it('never fakes misunderstanding in ordinary Talk (deterministic denial)', () => {
    for (let i = 0; i < 50; i += 1) {
      const decision = evaluateRepairTrigger({
        surface: 'talk',
        transcript: 'It broke.',
        wordCount: 2,
        pointsCoveredCount: 0,
        correctionSeverity: 'incorrect',
        isRealAI: true,
        repairExercise: true,
        attemptNumber: i + 1,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('talk-never-fakes');
      expect(decision.prompt).toBeNull();
    }
  });

  it('rotates scripted prompts deterministically (never randomly)', () => {
    const first = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'Clear answer.',
      wordCount: 3,
      pointsCoveredCount: 1,
      correctionSeverity: null,
      isRealAI: true,
      repairExercise: true,
      attemptNumber: 1,
    });
    const repeat = evaluateRepairTrigger({
      surface: 'fluency',
      transcript: 'Clear answer.',
      wordCount: 3,
      pointsCoveredCount: 1,
      correctionSeverity: null,
      isRealAI: true,
      repairExercise: true,
      attemptNumber: 1,
    });
    expect(repeat.prompt).toBe(first.prompt);
  });

  it('keeps strategy support bounded and contextual', () => {
    expect(REPAIR_SUPPORT_MOVES.length).toBeGreaterThan(0);
    expect(MAX_REPAIR_SUPPORT_MOVES).toBeLessThanOrEqual(3);
    const guided = repairSupportFor('repair', 'guided');
    expect(guided.length).toBeGreaterThan(0);
    expect(guided.length).toBeLessThanOrEqual(MAX_REPAIR_SUPPORT_MOVES);
    // Never dumped: other tasks and lower support show nothing proactively.
    expect(repairSupportFor('monologue', 'guided')).toEqual([]);
    expect(repairSupportFor('repair', 'supported')).toEqual([]);
    expect(repairSupportFor('repair', 'independent')).toEqual([]);
    expect(INSUFFICIENT_WORD_COUNT).toBeGreaterThan(0);
  });
});
