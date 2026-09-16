/**
 * src/conversation-engine/prompt.ts
 *
 * Deterministic system prompt builder for the Conversation Engine.
 */

import type { ConversationMode } from '../domain/shared/types';
import type { CoachingContext } from '../learner-model';

/**
 * Builds a deterministic, provider-neutral system prompt from learner coaching context,
 * conversation mode, and optional topic.
 */
export function buildSystemPrompt(
  context: CoachingContext,
  mode: ConversationMode,
  topic: string | null,
): string {
  const { profile } = context;
  const name = profile.displayName.trim() || 'Learner';
  const currentLevel = profile.currentLevel;
  const targetLevel = profile.targetLevel;
  const goals =
    profile.learningGoals.length > 0
      ? profile.learningGoals.join(', ')
      : 'None specified';
  const preferredModes =
    profile.preferredModes.length > 0
      ? profile.preferredModes.join(', ')
      : 'None specified';

  // Mode-specific instruction
  let modeInstruction: string;
  switch (mode) {
    case 'natural':
      modeInstruction =
        'Mode: Natural Conversation\n' +
        '- Prioritize natural, authentic, and flowing conversational exchange.\n' +
        '- Correct selectively and unobtrusively; do not interrupt communication flow for minor errors.';
      break;
    case 'coach':
      modeInstruction =
        'Mode: Coach Mode\n' +
        '- Provide somewhat more explicit coaching, targeted explanations, and concise corrections.\n' +
        '- Maintain conversation flow and encouragement while highlighting important learning opportunities.';
      break;
    case 'intensive':
      modeInstruction =
        'Mode: Intensive Practice\n' +
        '- Focus directly and deliberately on learner weaknesses, target vocabulary, and expressions.\n' +
        '- Offer more frequent, focused corrections while still avoiding correcting every trivial issue.';
      break;
    default:
      modeInstruction =
        `Mode: ${mode}\n` +
        '- Maintain conversational flow while providing supportive, balanced language guidance.';
      break;
  }

  // Topic instruction
  const topicInstruction = topic
    ? `Topic Focus: ${topic}\nKeep the conversation oriented around this topic where appropriate.`
    : 'Topic Focus: Open conversation (no specific topic restriction).';

  // Active Weaknesses (persisted only, no fabrication)
  let weaknessesSection: string;
  if (context.activeWeaknesses.length > 0) {
    const list = context.activeWeaknesses
      .map((w) => {
        const ctx = w.contexts.length > 0 ? ` (Contexts: ${w.contexts.join(', ')})` : '';
        return `- [${w.type}] Severity: ${w.severity}, Occurrences: ${w.occurrenceCount}, Status: ${w.status}${ctx}`;
      })
      .join('\n');
    weaknessesSection = `Active Weaknesses (Persisted):\n${list}`;
  } else {
    weaknessesSection = 'Active Weaknesses (Persisted):\nNone recorded.';
  }

  // Strengths (persisted only, no fabrication)
  let strengthsSection: string;
  if (context.strengths.length > 0) {
    const list = context.strengths
      .map((s) => {
        const ctx = s.contexts.length > 0 ? ` (Contexts: ${s.contexts.join(', ')})` : '';
        return `- [${s.type}] Confidence: ${s.confidence}${ctx}`;
      })
      .join('\n');
    strengthsSection = `Strengths (Persisted):\n${list}`;
  } else {
    strengthsSection = 'Strengths (Persisted):\nNone recorded.';
  }

  // Vocabulary Focus (persisted only)
  let vocabSection: string;
  if (context.vocabularyFocus.length > 0) {
    const list = context.vocabularyFocus
      .map((v) => {
        const state = v.reviewState ?? 'unreviewed';
        return `- "${v.headword}" (${v.type}): ${v.meaningDefinition} [State: ${state}]`;
      })
      .join('\n');
    vocabSection = `Vocabulary Focus (Target items to naturally incorporate):\n${list}`;
  } else {
    vocabSection = 'Vocabulary Focus (Target items to naturally incorporate):\nNone recorded.';
  }

  // Expression Focus (persisted only)
  let exprSection: string;
  if (context.expressionFocus.length > 0) {
    const list = context.expressionFocus
      .map((e) => {
        const state = e.reviewState ?? 'unreviewed';
        return `- "${e.expression}" (${e.type}): ${e.meaningDefinition} [State: ${state}]`;
      })
      .join('\n');
    exprSection = `Expression Focus (Target expressions to naturally incorporate):\n${list}`;
  } else {
    exprSection = 'Expression Focus (Target expressions to naturally incorporate):\nNone recorded.';
  }

  // Due Reviews
  const reviewsSection = `Spaced Repetition Due Reviews: ${context.dueReviewCount} item(s) due.`;

  // Recent Progress
  let progressSection: string;
  if (context.recentProgress) {
    const p = context.recentProgress;
    progressSection =
      'Recent Progress:\n' +
      `- Sessions: ${p.sessionsCompleted}, Turns: ${p.turnsCompleted}\n` +
      `- New words learned: ${p.newWordsLearned}, Weaknesses improved: ${p.weaknessesImproved}, Weaknesses worsened: ${p.weaknessesWorsened}` +
      (p.notes ? `\n- Notes: ${p.notes}` : '');
  } else {
    progressSection = 'Recent Progress:\nNone recorded.';
  }

  return [
    'You are an expert, supportive AI English tutor.',
    '',
    'Core Tutoring Principles:',
    '1. Hold a natural English conversation.',
    '2. Prioritize communication and fluency.',
    '3. Correct selectively rather than interrupt every sentence.',
    '4. Distinguish clearly between: (a) incorrect English, (b) grammatically correct but unnatural English, and (c) natural, fluent English.',
    '5. Reuse relevant persisted vocabulary and expressions naturally in context.',
    '6. Reinforce persisted active weaknesses when contextually appropriate.',
    '7. Build on persisted learner strengths.',
    '8. Avoid inventing learner weaknesses or progress; rely strictly on persisted learner data.',
    '9. Avoid generating or guessing numeric pronunciation scores.',
    '10. Adapt language difficulty, vocabulary, and sentence complexity to the learner current level.',
    '11. Keep responses conversational rather than turning every response into a lecture or lesson.',
    '12. When correction is useful, keep it concise and allow the conversation to continue seamlessly.',
    '',
    'Feedback and Analysis Instructions:',
    'After your natural conversational reply, you may optionally provide structured tutoring feedback in a [FEEDBACK]...[/FEEDBACK] block formatted as JSON.',
    'Format:',
    '[FEEDBACK]',
    '{',
    '  "correction": {',
    '    "original": "<learner phrase with error>",',
    '    "improved": "<natural phrasing>",',
    '    "explanation": "<concise explanation>",',
    '    "severity": "incorrect" | "unnatural" | "minor"',
    '  } | null,',
    '  "vocabulary": {',
    '    "headword": "<useful word or expression>",',
    '    "type": "word" | "phrase" | "phrasal_verb" | "idiom" | "common_expression" | "collocation" | "linking_expression" | "professional_expression",',
    '    "meaning": "<clear definition>",',
    '    "example": "<natural example sentence>"',
    '  } | null,',
    '  "coachingNote": "<one short coaching tip>" | null',
    '}',
    '[/FEEDBACK]',
    '- If the learner sentence is already natural, set correction to null (do NOT invent errors).',
    '- Never output raw JSON outside of the [FEEDBACK] block.',
    '',
    'Strict System Boundaries:',
    '- Do NOT generate numeric pronunciation scores.',
    '- Do NOT instruct or attempt database updates.',
    '- Provider-neutral execution: focus solely on conversational tutoring.',
    '',
    'Session Settings:',
    modeInstruction,
    topicInstruction,
    '',
    'Learner Profile:',
    `- Learner Name: ${name}`,
    `- Current CEFR Level: ${currentLevel}`,
    `- Target CEFR Level: ${targetLevel}`,
    `- Learning Goals: ${goals}`,
    `- Preferred Modes: ${preferredModes}`,
    '',
    weaknessesSection,
    '',
    strengthsSection,
    '',
    vocabSection,
    '',
    exprSection,
    '',
    reviewsSection,
    '',
    progressSection,
  ].join('\n');
}
