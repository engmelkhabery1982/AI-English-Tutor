/**
 * src/adaptive-lessons/speaking.ts
 *
 * Speaking practice for adaptive lessons, built on the EXISTING conversation
 * stack: ConversationEngine → ConversationOrchestrator → ConversationSession →
 * AIProvider. This module adds NO second chat engine, NO second feedback
 * parser and NO second weakness path.
 *
 * HONESTY RULES
 * - When no real AIProvider is configured, `available` is false and NO
 *   evaluation is invented. There is deliberately no silent Demo fallback:
 *   a demo provider would manufacture corrections that never happened.
 * - Provider failures are isolated: the step reports that feedback is
 *   unavailable and stays completable, so an AI outage can never break or
 *   corrupt a lesson plan.
 * - Feedback stays qualitative (the existing correction philosophy:
 *   incorrect / correct-but-unnatural / minor). No scores, bands or ratings.
 */

import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession } from '../conversation-session';
import type { ConversationMode } from '../domain/shared/types';
import type { LearnerModel } from '../learner-model';
import type {
  AIProvider,
  ConversationFeedback,
  ConversationFeedbackCorrection,
} from '../providers/ai';
import { SPEAKING_FEEDBACK_UNAVAILABLE_NOTE } from './prompts';
import type { AdaptiveLessonSpeakingPort, AdaptiveSpeakingFeedback } from './types';

/** Intensive mode is the correction-focused existing conversation mode. */
const DEFAULT_SPEAKING_MODE: ConversationMode = 'intensive';
const DEFAULT_SPEAKING_TOPIC = 'Targeted speaking practice';

/** Existing severity vocabulary, described for a learner (no numbers). */
const SEVERITY_LABELS: Readonly<Record<ConversationFeedbackCorrection['severity'], string>> = {
  incorrect: 'This needs a correction',
  unnatural: 'Understandable, but a native speaker would say it differently',
  minor: 'A small point to polish',
};

/** Qualitative lines describing one real correction (existing shape). */
export function describeCorrection(
  correction: ConversationFeedbackCorrection,
): readonly string[] {
  const lines: string[] = [];
  const label = SEVERITY_LABELS[correction.severity] ?? 'Feedback';
  if (correction.original && correction.improved) {
    lines.push(`${label}: "${correction.original}" → "${correction.improved}"`);
  } else {
    lines.push(label);
  }
  if (correction.explanation) lines.push(correction.explanation);
  return lines;
}

/**
 * Turn a REAL provider response into compact qualitative lines.
 * Provenance is always stated: the lesson never claims a judgment that no
 * provider actually made.
 */
export function buildSpeakingFeedbackLines(
  responseContent: string,
  feedback: ConversationFeedback | null,
): readonly string[] {
  const lines: string[] = [];
  if (feedback?.correction) lines.push(...describeCorrection(feedback.correction));
  if (feedback?.vocabulary?.headword) {
    const meaning = feedback.vocabulary.meaning ? ` — ${feedback.vocabulary.meaning}` : '';
    lines.push(`Worth saving: "${feedback.vocabulary.headword}"${meaning}`);
  }
  if (feedback?.coachingNote) lines.push(feedback.coachingNote);
  if (lines.length === 0) {
    lines.push(
      responseContent.trim().length > 0
        ? responseContent.trim()
        : 'No correction was returned — your answer was taken as clear.',
    );
  }
  return lines;
}

export interface AdaptiveSpeakingPortDeps {
  /** The EXISTING learner model (used by the existing conversation engine). */
  readonly learnerModel: LearnerModel;
  /**
   * A REAL provider (Gemini when a key is configured). When absent the port
   * reports unavailable feedback instead of falling back to a demo provider.
   */
  readonly aiProvider?: AIProvider;
  readonly mode?: ConversationMode;
  readonly topic?: string;
}

/**
 * Compose the speaking port from the existing conversation stack.
 * One short-lived session is created per answer: the lesson step is a single
 * targeted turn, not an open-ended conversation.
 */
export function createConversationSpeakingPort(
  deps: AdaptiveSpeakingPortDeps,
): AdaptiveLessonSpeakingPort {
  const available = Boolean(deps.aiProvider);
  const mode = deps.mode ?? DEFAULT_SPEAKING_MODE;
  const topic = deps.topic ?? DEFAULT_SPEAKING_TOPIC;

  const unavailable = (extra?: string): AdaptiveSpeakingFeedback => ({
    evaluatedBy: 'unavailable',
    correction: null,
    coachingNote: null,
    feedback: null,
    lines: [extra ? `${SPEAKING_FEEDBACK_UNAVAILABLE_NOTE} (${extra})` : SPEAKING_FEEDBACK_UNAVAILABLE_NOTE],
  });

  return {
    available,
    async evaluate({ prompt, answer, mode: requestedMode }) {
      const provider = deps.aiProvider;
      if (!provider) return unavailable();

      const trimmedAnswer = answer.trim();
      if (!trimmedAnswer) {
        return unavailable('no answer was provided');
      }

      try {
        // EXISTING stack — engine builds the coaching-aware system prompt,
        // orchestrator calls the provider, session keeps the turn history.
        const engine = createConversationEngine(deps.learnerModel);
        const orchestrator = createConversationOrchestrator(engine, provider);
        const session = createConversationSession(orchestrator, {
          mode: requestedMode || mode,
          topic,
        });

        const result = await session.send({
          userMessage: `Speaking task: ${prompt}\n\nMy answer: ${trimmedAnswer}`,
        });

        if (!result.ok) {
          return unavailable(result.error?.message ? 'the assistant could not respond' : undefined);
        }

        const feedback = result.feedback ?? null;
        const content = result.response?.content ?? '';
        return {
          evaluatedBy: 'ai',
          reply: content,
          correction: feedback?.correction ?? null,
          coachingNote: feedback?.coachingNote ?? null,
          feedback,
          lines: buildSpeakingFeedbackLines(content, feedback),
        };
      } catch {
        // AI failure must never break the lesson.
        return unavailable('the request failed');
      }
    },
  };
}
