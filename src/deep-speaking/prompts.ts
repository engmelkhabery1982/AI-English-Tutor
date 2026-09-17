/**
 * src/deep-speaking/prompts.ts
 *
 * Coaching system-prompt builder + scenario bank + turn-goal instructions
 * for Deep Speaking Practice.
 *
 * This module NEVER calls the AI. It produces text that the EXISTING
 * ConversationEngine's system prompt is augmented with (via a thin decorator
 * in service.ts). No second engine is created.
 */

import type { ConversationMode } from '../domain/shared/types';
import type {
  SpeakingPracticePlan,
  SpeakingPracticeType,
  SpeakingTurnGoal,
  SpeakingTurnGoalKind,
} from './types';

/* ------------------------------------------------------------------ *
 * Scenario bank (small, deterministic, per practice type)
 * ------------------------------------------------------------------ */

export interface SpeakingScenario {
  readonly topic: string;
  readonly scenarioPrompt: string;
}

const SCENARIOS: Readonly<Record<SpeakingPracticeType, readonly SpeakingScenario[]>> = {
  free_conversation: [
    {
      topic: 'Free conversation',
      scenarioPrompt:
        'Start a free conversation about something the learner enjoys or did recently. Open with one warm, open question.',
    },
  ],
  guided_topic: [
    {
      topic: 'Daily routine',
      scenarioPrompt:
        'Start a guided conversation about the learner\'s typical day. Ask one open question to begin.',
    },
    {
      topic: 'Weekend plans',
      scenarioPrompt:
        'Start a guided conversation about what the learner plans to do this weekend. Ask one open question.',
    },
    {
      topic: 'A recent experience',
      scenarioPrompt:
        'Ask the learner to describe a recent experience — something they did, saw, or learned. Start with one open question.',
    },
  ],
  role_play: [
    {
      topic: 'Meeting a new colleague',
      scenarioPrompt:
        'Role-play: you are a new colleague meeting the learner for the first time at work. Introduce yourself briefly and ask one question to start the conversation.',
    },
    {
      topic: 'Ordering at a restaurant',
      scenarioPrompt:
        'Role-play: you are a server at a restaurant and the learner is a customer. Greet them and ask what they would like to order.',
    },
    {
      topic: 'Doctor\'s visit',
      scenarioPrompt:
        'Role-play: you are a doctor and the learner is a patient. Ask the learner what brings them in today.',
    },
  ],
  explain_and_expand: [
    {
      topic: 'Explain a hobby',
      scenarioPrompt:
        'Ask the learner to explain a hobby or activity they enjoy. After their first answer, ask them to elaborate with more detail.',
    },
    {
      topic: 'Describe a project',
      scenarioPrompt:
        'Ask the learner to describe a project they worked on — at work, school, or home. Encourage them to explain what they did and why.',
    },
  ],
  opinion_and_reasoning: [
    {
      topic: 'Working from home',
      scenarioPrompt:
        'Ask the learner for their opinion about working from home versus working in an office. Encourage them to give a reason for their view.',
    },
    {
      topic: 'Learning languages',
      scenarioPrompt:
        'Ask the learner for their opinion about the best way to learn a language. Encourage them to explain why they think so.',
    },
  ],
  problem_solution: [
    {
      topic: 'Solving a scheduling conflict',
      scenarioPrompt:
        'Present a simple scenario: the learner has two important meetings at the same time. Ask how they would handle it.',
    },
    {
      topic: 'Dealing with a missed deadline',
      scenarioPrompt:
        'Present a simple scenario: the learner missed an important deadline. Ask how they would handle the situation and what they would say.',
    },
  ],
  retell_or_summarize: [
    {
      topic: 'Retell a short story',
      scenarioPrompt:
        'Tell the learner a very short story (2–3 sentences about a simple event) and ask them to retell it in their own words.',
    },
    {
      topic: 'Summarize a day',
      scenarioPrompt:
        'Ask the learner to summarize what they did yesterday in a few sentences.',
    },
  ],
  reformulation: [
    {
      topic: 'Reformulation practice',
      scenarioPrompt:
        'Start a short conversation. After the learner answers, if they use an unnatural phrase, ask them to say the same idea in a more natural way. Do not give them the answer before they try.',
    },
  ],
  target_expression_practice: [
    {
      topic: 'Using target expressions',
      scenarioPrompt:
        'Start a conversation that naturally invites the learner to use everyday expressions. After their first answer, encourage them to keep talking.',
    },
  ],
  weakness_retraining: [
    {
      topic: 'Targeted speaking practice',
      scenarioPrompt:
        'Start a conversation that gives the learner natural opportunities to practise a specific area. Ask one open question to begin.',
    },
  ],
};

/** Deterministic scenario selection by hashing (learnerId, now, practiceType). */
export function selectScenario(
  practiceType: SpeakingPracticeType,
  learnerId: string,
  now: string,
): SpeakingScenario {
  const bank = SCENARIOS[practiceType];
  if (bank.length === 1) return bank[0];
  const identity = `${learnerId}:${now}:${practiceType}`;
  const index = hashIndex(identity, bank.length);
  return bank[index];
}

/* ------------------------------------------------------------------ *
 * Turn-goal instructions (coach-facing text appended to system prompt)
 * ------------------------------------------------------------------ */

export const TURN_GOAL_INSTRUCTIONS: Readonly<Record<SpeakingTurnGoalKind, string>> = {
  open:
    'Open the conversation with one short, natural question. Keep it simple and inviting.',
  follow_up:
    'Ask a natural follow-up question based on what the learner just said. Keep the conversation flowing.',
  expand:
    'The learner\'s previous answer was short. Ask ONE focused follow-up that requires elaboration — a reason, an example, the result, what happened next, an alternative, or an explanation. Do not move to a new topic yet.',
  reformulate:
    'Ask the learner to reformulate their previous answer more naturally. Do not provide the answer before they try. Keep it encouraging.',
  target_expression:
    'If it fits naturally, invite the learner to use a target expression in their next answer. Do not force it if the context does not fit.',
  weakness_retraining:
    'Create a natural opportunity for the learner to practise a specific area of difficulty. Do not announce it as a drill — weave it into the conversation.',
  wrap_up:
    'Wrap up the conversation in one or two sentences. Thank the learner for the practice. Do not start a new topic.',
};

/* ------------------------------------------------------------------ *
 * Coaching system-prompt augmentation
 * ------------------------------------------------------------------ */

/**
 * Build the Deep Speaking coaching prompt that AUGMENTS (not replaces)
 * the EXISTING ConversationEngine system prompt. The existing prompt already
 * contains the full CoachingContext (profile, weaknesses, vocabulary, etc.).
 * This augmentation adds the speaking-coach role and turn-level guidance.
 */
export function buildSpeakingCoachingPrompt(
  plan: SpeakingPracticePlan,
  currentTurnGoal: SpeakingTurnGoal,
): string {
  const lines: string[] = [];

  lines.push('=== DEEP SPEAKING COACH ===');
  lines.push('');
  lines.push('You are now acting as a SPEAKING COACH, not just a conversation partner.');
  lines.push('Your goal is to keep the learner speaking, help them expand their answers,');
  lines.push('and create natural opportunities for them to improve.');
  lines.push('');

  lines.push(`Practice type: ${plan.practiceType.replace(/_/g, ' ')}`);
  lines.push(`Topic: ${plan.topic}`);
  lines.push(`Coaching mode: ${plan.coachingMode}`);
  lines.push('');

  if (plan.targetExpressions.length > 0) {
    lines.push('Target expressions to weave in naturally (do NOT list them as a dictionary):');
    for (const expr of plan.targetExpressions) {
      lines.push(`- "${expr.headword}" — ${expr.meaning}`);
    }
    lines.push('');
  }

  if (plan.weaknessTargets.length > 0) {
    lines.push('Areas to give the learner natural practice opportunities:');
    for (const w of plan.weaknessTargets) {
      lines.push(`- ${w.type.replace(/_/g, ' ')}${w.label ? `: "${w.label}"` : ''}`);
    }
    lines.push('');
  }

  if (plan.recentMemoryNote) {
    lines.push(`Recent context: ${plan.recentMemoryNote}`);
    lines.push('');
  }

  lines.push(`Turn goal for your next reply: ${currentTurnGoal.goal.replace(/_/g, ' ')}`);
  lines.push(`Guidance: ${currentTurnGoal.instruction}`);
  lines.push('');

  lines.push('REMINDERS:');
  lines.push('- Ask ONE thing at a time.');
  lines.push('- Keep the learner talking — do not lecture.');
  lines.push('- Correct selectively: only important mistakes or clearly unnatural phrasing.');
  lines.push('- Do not correct every sentence.');
  lines.push('- Do not give long grammar explanations.');
  lines.push('- Do not output scores, percentages, or ratings.');
  lines.push('- Stay conversational and encouraging.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build the tutor opening instruction sent via session.openConversation().
 * This is the "userMessage" for the opening — it is NOT learner speech.
 */
export function buildTutorOpeningMessage(plan: SpeakingPracticePlan): string {
  const parts: string[] = [
    plan.scenarioPrompt,
  ];
  if (plan.targetExpressions.length > 0) {
    parts.push(
      `Try to naturally create opportunities for the learner to use these expressions: ${plan.targetExpressions.map((e) => `"${e.headword}"`).join(', ')}.`,
    );
  }
  if (plan.weaknessTargets.length > 0) {
    parts.push(
      `The learner has been working on: ${plan.weaknessTargets.map((w) => w.label ?? w.type).join(', ')}.`,
    );
  }
  parts.push('Keep your opening short — one or two sentences.');
  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Expansion heuristic (qualitative, no scores)
 * ------------------------------------------------------------------ */

/** Minimum substantive answer length (characters). */
export const MIN_SUBSTANTIVE_CHARS = 40;
/** Minimum substantive answer word count. */
export const MIN_SUBSTANTIVE_WORDS = 8;

/**
 * Qualitative short-answer heuristic: should the next turn goal request
 * expansion? Deterministic, no AI, no score.
 */
export function isShortAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return false; // empty = not an answer
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return trimmed.length < MIN_SUBSTANTIVE_CHARS || wordCount < MIN_SUBSTANTIVE_WORDS;
}

/* ------------------------------------------------------------------ *
 * Reformulation check
 * ------------------------------------------------------------------ */

import type { ConversationFeedback } from '../providers/ai/types';

/**
 * Determine whether reformulation should be activated for the next turn.
 * Only when REAL existing correction evidence is 'incorrect' or 'unnatural'.
 */
export function shouldReformulate(
  feedback: ConversationFeedback | null,
  isRealAI: boolean,
  reformulationsUsed: number,
  maxReformulations: number = 2,
): boolean {
  if (!isRealAI) return false;
  if (!feedback?.correction) return false;
  if (reformulationsUsed >= maxReformulations) return false;
  const severity = feedback.correction.severity;
  return severity === 'incorrect' || severity === 'unnatural';
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Deterministic hash index (same as stableReferenceId pattern). */
function hashIndex(identity: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % length;
}

/** Goal-to-topic mapping for learner-goal-influenced scenario selection. */
export function practiceTypeForGoal(goal: string): SpeakingPracticeType {
  const lower = goal.toLowerCase();
  if (lower.includes('meeting')) return 'role_play';
  if (lower.includes('presentation')) return 'explain_and_expand';
  if (lower.includes('interview')) return 'role_play';
  if (lower.includes('pronunciation')) return 'weakness_retraining';
  if (lower.includes('vocabulary') || lower.includes('expression')) return 'target_expression_practice';
  if (lower.includes('confidence') || lower.includes('fluency')) return 'free_conversation';
  if (lower.includes('listening')) return 'retell_or_summarize';
  if (lower.includes('work') || lower.includes('professional')) return 'problem_solution';
  if (lower.includes('travel')) return 'guided_topic';
  if (lower.includes('everyday')) return 'free_conversation';
  return 'guided_topic';
}

/** Coaching mode for a practice type (may be overridden by preferred mode). */
export function defaultCoachingModeForType(
  practiceType: SpeakingPracticeType,
  preferredModes: readonly ConversationMode[],
): ConversationMode {
  if (practiceType === 'reformulation' || practiceType === 'weakness_retraining') {
    return 'intensive';
  }
  if (preferredModes.length > 0) return preferredModes[0];
  return 'coach';
}
