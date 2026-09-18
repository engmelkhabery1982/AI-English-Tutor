/**
 * src/fluency/tasks.ts
 *
 * WP-3 speaking-task catalog: deliberate, bounded, deterministic.
 *
 * RULES
 * - PURE: no I/O, no AI call, no clock read, no randomness. Identical input
 *   always yields identical output.
 * - STABLE IDENTITY: every task has a fixed `id` that never changes across
 *   repetitions. Repetition rounds reference the SAME id.
 * - BOUNDED: at most MAX_TASK_POINTS points, MAX_TASK_TARGET_EXPRESSIONS
 *   target expressions, MAX_SEQUENCING_PHRASES sequencing phrases per task.
 * - SUPPORT, NOT SCRIPTS: cues are an opening idea, points, useful
 *   expressions, sequencing phrases and a closing prompt. There is deliberately
 *   no full model answer anywhere in this catalog.
 * - TRANSFER: a transfer variant changes ONE dimension (the context) and keeps
 *   the SAME learning target, so practice transfers instead of memorizing.
 */

import type {
  FluencyCues,
  FluencyRepeatPrompt,
  FluencySupportLevel,
  FluencyTask,
  FluencyTaskKind,
} from './types';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** Maximum task points per task (the catalog uses 2-3). */
export const MAX_TASK_POINTS = 3;
/** Maximum target expressions per task. */
export const MAX_TASK_TARGET_EXPRESSIONS = 3;
/** Maximum sequencing phrases per task. */
export const MAX_SEQUENCING_PHRASES = 4;
/** Maximum repetition rounds per task practice (bounded automaticity). */
export const MAX_ROUNDS_PER_TASK = 5;

/* ------------------------------------------------------------------ *
 * Repair practice label (honesty: scripted misunderstanding is labeled)
 * ------------------------------------------------------------------ */

/**
 * Shown by the UI whenever a repair prompt comes from a deliberate
 * repair-exercise scenario, so scripted misunderstanding is never presented
 * as a genuine failure to understand.
 */
export const REPAIR_PRACTICE_LABEL =
  'Repair practice: the tutor asks for clarification on purpose in this exercise.';

/* ------------------------------------------------------------------ *
 * Catalog (stable ids — never rename an id once practiced)
 * ------------------------------------------------------------------ */

const TASKS: readonly FluencyTask[] = [
  {
    id: 'describe-work-problem',
    kind: 'repetition',
    title: 'Describe a difficult problem you solved',
    prompt: 'Describe a difficult problem you solved at work.',
    taskPoints: [
      {
        id: 'problem',
        label: 'What the problem was',
        keywords: ['problem', 'issue', 'wrong', 'difficult', 'trouble', 'challenge'],
      },
      {
        id: 'action',
        label: 'What you did about it',
        keywords: ['decided', 'called', 'fixed', 'talked', 'asked', 'tried', 'changed', 'made', 'did'],
      },
      {
        id: 'outcome',
        label: 'What happened in the end',
        keywords: ['result', 'solved', 'fixed', 'worked', 'end', 'finally', 'after', 'learned'],
      },
    ],
    targetExpressions: [
      { expression: 'deal with', meaning: 'to handle or manage a problem or situation.' },
      { expression: 'figure out', meaning: 'to find an answer or solution by thinking.' },
      { expression: 'in the end', meaning: 'finally, after everything happened.' },
    ],
    openingIdea: 'Start with when and where it happened.',
    sequencingPhrases: ['First,', 'Then,', 'After that,', 'In the end,'],
    closingPrompt: 'Finish with what you learned from it.',
    learningTarget: 'narrate a past work problem: situation, action, outcome',
  },
  {
    id: 'explain-project-delay',
    kind: 'repetition',
    title: 'Explain a project delay to your manager',
    prompt: 'Explain a project delay to your manager.',
    taskPoints: [
      {
        id: 'cause',
        label: 'Why the project is delayed',
        keywords: ['because', 'delay', 'late', 'reason', 'caused', 'problem', 'issue'],
      },
      {
        id: 'impact',
        label: 'What the delay affects',
        keywords: ['affect', 'deadline', 'schedule', 'plan', 'launch', 'delivery', 'impact'],
      },
      {
        id: 'next-steps',
        label: 'What you will do next',
        keywords: ['will', 'plan', 'next', 'fix', 'priorit', 'going to', 'ensure', 'update'],
      },
    ],
    targetExpressions: [
      { expression: 'run behind schedule', meaning: 'to be later than the planned timetable.' },
      { expression: 'keep you updated', meaning: 'to continue giving someone new information.' },
    ],
    openingIdea: 'Start with the current status in one sentence.',
    sequencingPhrases: ['To begin with,', 'The reason is', 'This means', 'Going forward,'],
    closingPrompt: 'Finish with when you will update them next.',
    transferTaskId: 'explain-supplier-delay',
    learningTarget: 'explain a delay professionally: cause, impact, next steps',
  },
  {
    id: 'explain-supplier-delay',
    kind: 'repetition',
    title: 'Explain a supplier delay to a client',
    prompt: 'Explain a supplier delay to a client.',
    taskPoints: [
      {
        id: 'cause',
        label: 'Why the delivery is delayed',
        keywords: ['because', 'delay', 'late', 'reason', 'caused', 'supplier', 'problem'],
      },
      {
        id: 'impact',
        label: 'What the delay affects',
        keywords: ['affect', 'deadline', 'schedule', 'order', 'delivery', 'shipment', 'impact'],
      },
      {
        id: 'next-steps',
        label: 'What you will do next',
        keywords: ['will', 'plan', 'next', 'fix', 'priorit', 'going to', 'ensure', 'update'],
      },
    ],
    targetExpressions: [
      { expression: 'run behind schedule', meaning: 'to be later than the planned timetable.' },
      { expression: 'keep you updated', meaning: 'to continue giving someone new information.' },
    ],
    openingIdea: 'Start with the current status in one sentence.',
    sequencingPhrases: ['To begin with,', 'The reason is', 'This means', 'Going forward,'],
    closingPrompt: 'Finish with when you will update them next.',
    learningTarget: 'explain a delay professionally: cause, impact, next steps',
  },
  {
    id: 'tell-recent-story',
    kind: 'monologue',
    title: 'Tell a story about something recent',
    prompt: 'Tell a story about something interesting that happened to you recently.',
    taskPoints: [
      {
        id: 'setting',
        label: 'When and where it happened',
        keywords: ['yesterday', 'last', 'week', 'morning', 'evening', 'when', 'where', 'ago'],
      },
      {
        id: 'events',
        label: 'What happened, step by step',
        keywords: ['then', 'after', 'next', 'suddenly', 'because', 'so', 'when'],
      },
      {
        id: 'ending',
        label: 'How it ended',
        keywords: ['finally', 'end', 'after', 'felt', 'learned', 'funny', 'happy', 'result'],
      },
    ],
    targetExpressions: [
      { expression: 'out of the blue', meaning: 'suddenly and unexpectedly.' },
      { expression: 'turned out', meaning: 'happened in a particular way in the end.' },
    ],
    openingIdea: 'Start with when and where it happened.',
    sequencingPhrases: ['At first,', 'Then,', 'Suddenly,', 'In the end,'],
    closingPrompt: 'Finish with how it ended or how you felt.',
    learningTarget: 'sustain a coherent personal story: setting, events, ending',
  },
  {
    id: 'opinion-remote-work',
    kind: 'monologue',
    title: 'Give your opinion about remote work',
    prompt: 'Give your opinion about working from home versus working in an office.',
    taskPoints: [
      {
        id: 'view',
        label: 'Your opinion',
        keywords: ['think', 'believe', 'opinion', 'prefer', 'better', 'favour', 'favor', 'feel'],
      },
      {
        id: 'reason',
        label: 'A reason for your view',
        keywords: ['because', 'reason', 'since', 'example', 'focus', 'time', 'commute', 'flexib'],
      },
      {
        id: 'other-side',
        label: 'One point for the other side',
        keywords: ['however', 'although', 'but', 'other', 'side', 'lonely', 'distract', 'team'],
      },
    ],
    targetExpressions: [
      { expression: 'in my view', meaning: 'a phrase to introduce your opinion.' },
      { expression: 'on the other hand', meaning: 'a phrase to introduce a contrasting point.' },
    ],
    openingIdea: 'Start with your overall opinion in one sentence.',
    sequencingPhrases: ['In my view,', 'For example,', 'On the other hand,', 'Overall,'],
    closingPrompt: 'Finish with a one-sentence summary of your view.',
    learningTarget: 'present an opinion with a reason and a balanced point',
  },
  {
    id: 'explain-known-process',
    kind: 'monologue',
    title: 'Explain a process you know well',
    prompt: 'Explain a process you know well, step by step, so someone else could follow it.',
    taskPoints: [
      {
        id: 'first-step',
        label: 'How it starts',
        keywords: ['first', 'start', 'begin', 'need', 'prepare'],
      },
      {
        id: 'middle-steps',
        label: 'The middle steps in order',
        keywords: ['then', 'next', 'after', 'while', 'until', 'careful'],
      },
      {
        id: 'finish',
        label: 'How you know it is done',
        keywords: ['finally', 'finish', 'done', 'check', 'ready', 'end'],
      },
    ],
    targetExpressions: [
      { expression: 'make sure', meaning: 'to take care that something happens.' },
      { expression: 'step by step', meaning: 'one small action after another.' },
    ],
    openingIdea: 'Start with what the process is for.',
    sequencingPhrases: ['First,', 'Next,', 'After that,', 'Finally,'],
    closingPrompt: 'Finish with how you check the result.',
    learningTarget: 'explain an ordered process with clear steps',
  },
  {
    id: 'repair-giving-directions',
    kind: 'repair',
    title: 'Repair practice: explain directions clearly',
    prompt: 'Explain how to get from your home to your workplace.',
    taskPoints: [
      {
        id: 'start',
        label: 'Where you start',
        keywords: ['home', 'start', 'leave', 'station', 'street', 'first'],
      },
      {
        id: 'route',
        label: 'The way, step by step',
        keywords: ['turn', 'left', 'right', 'straight', 'past', 'then', 'next', 'station', 'bus', 'train'],
      },
      {
        id: 'destination',
        label: 'How you recognise the destination',
        keywords: ['arrive', 'reach', 'opposite', 'next to', 'building', 'see', 'end'],
      },
    ],
    targetExpressions: [
      { expression: 'what I mean is', meaning: 'a phrase to clarify what you just said.' },
      { expression: 'in other words', meaning: 'a phrase to say the same thing differently.' },
    ],
    openingIdea: 'Start with where you begin the journey.',
    sequencingPhrases: ['First,', 'Then,', 'After that,', 'Finally,'],
    closingPrompt: 'Finish with what the destination looks like.',
    repairContract: {
      isRepairExercise: true,
      practiceLabel: REPAIR_PRACTICE_LABEL,
      learnerGoal: 'practise clarification, paraphrasing and checking understanding',
    },
    learningTarget: 'give clear directions and repair misunderstanding',
  },
];

/* ------------------------------------------------------------------ *
 * Accessors (pure)
 * ------------------------------------------------------------------ */

/** All tasks, optionally filtered by kind (stable catalog order). */
export function listFluencyTasks(kind?: FluencyTaskKind): readonly FluencyTask[] {
  if (!kind) return TASKS;
  return TASKS.filter((task) => task.kind === kind);
}

/** Find a task by its stable id (null when unknown — never throws). */
export function getFluencyTask(taskId: string): FluencyTask | null {
  return TASKS.find((task) => task.id === taskId) ?? null;
}

/**
 * The transfer variant of a task (a RELATED context with the SAME learning
 * target), or null when the task has none.
 */
export function getTransferTask(task: FluencyTask): FluencyTask | null {
  if (!task.transferTaskId) return null;
  const transfer = getFluencyTask(task.transferTaskId);
  // A transfer variant must preserve the learning target; a catalog entry
  // that changed it is treated as absent rather than mislabeled.
  if (!transfer || transfer.learningTarget !== task.learningTarget) return null;
  return transfer;
}

/* ------------------------------------------------------------------ *
 * Support cues (bounded by support level — deterministic)
 * ------------------------------------------------------------------ */

/**
 * Cues actually shown for an attempt at a support level.
 *
 * - guided:      full support (opening idea, points, expressions,
 *                sequencing phrases, closing prompt).
 * - supported:   fewer cues (points + closing prompt only).
 * - independent: the task only (no cues).
 *
 * Deterministic, bounded, and never larger than the catalog bounds.
 */
export function cuesForSupport(
  task: FluencyTask,
  level: FluencySupportLevel,
): FluencyCues {
  switch (level) {
    case 'guided':
      return {
        openingIdea: task.openingIdea,
        taskPoints: task.taskPoints.slice(0, MAX_TASK_POINTS),
        targetExpressions: task.targetExpressions.slice(0, MAX_TASK_TARGET_EXPRESSIONS),
        sequencingPhrases: task.sequencingPhrases.slice(0, MAX_SEQUENCING_PHRASES),
        closingPrompt: task.closingPrompt,
        taskOnly: false,
      };
    case 'supported':
      return {
        openingIdea: null,
        taskPoints: task.taskPoints.slice(0, MAX_TASK_POINTS),
        targetExpressions: [],
        sequencingPhrases: [],
        closingPrompt: task.closingPrompt,
        taskOnly: false,
      };
    case 'independent':
      return {
        openingIdea: null,
        taskPoints: [],
        targetExpressions: [],
        sequencingPhrases: [],
        closingPrompt: null,
        taskOnly: true,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Repeat prompts (deterministic — same round, same support, same text)
 * ------------------------------------------------------------------ */

/**
 * The task-layer prompt for the next repetition round of the SAME task.
 * This is practice guidance shown by the UI — it is not AI output and it
 * never claims a measured improvement.
 */
export function repeatPromptFor(
  task: FluencyTask,
  nextAttemptNumber: number,
  level: FluencySupportLevel,
): FluencyRepeatPrompt {
  const attempt = Math.max(2, Math.floor(nextAttemptNumber));
  let text: string;
  if (attempt === 2) {
    text = 'Same task — tell it again, a little more clearly and directly.';
  } else if (level === 'independent') {
    text = 'Same task, no cues this time — just tell it in your own words.';
  } else {
    text = 'Tell it once more with less support.';
  }
  return { taskId: task.id, nextAttemptNumber: attempt, supportLevel: level, text };
}

/**
 * Opening instruction sent to the tutor through the EXISTING
 * session.openConversation() when a fluency task starts. It frames the SAME
 * task the learner sees (so the tutor's opening matches the task prompt) and
 * — for monologue tasks — asks the tutor not to interrupt with extra
 * questions. It never asks for scores, ratings or fake misunderstanding.
 */
export function buildFluencyOpeningInstruction(task: FluencyTask): string {
  const parts: string[] = [
    `Speaking task practice. The learner's task is: "${task.prompt}"`,
    'Keep your opening short — one or two sentences that invite them to begin the task.',
  ];
  if (task.kind === 'monologue') {
    parts.push(
      'After they answer, reply once: acknowledge briefly and ask at most one natural follow-up. ' +
        'Do not fire several questions at them and do not interrupt their answer.',
    );
  }
  if (task.kind === 'repair' && task.repairContract) {
    parts.push(
      'This is a declared clarification exercise: when their meaning is genuinely unclear, ' +
        'ask one honest clarification question (for example "Do you mean…?" or "Could you explain that another way?"). ' +
        'Never pretend to misunderstand something clear.',
    );
  }
  return parts.join(' ');
}
