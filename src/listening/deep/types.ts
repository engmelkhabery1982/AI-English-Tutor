/**
 * src/listening/deep/types.ts
 *
 * WP-2 — LISTENING DEPTH: the deep-listening contract.
 *
 * WHAT THIS IS
 * The provider-neutral, QUALITATIVE shape of the deeper listening activities
 * the EXISTING Listening Engine can now plan:
 *
 *   long_discourse            one bounded piece of real discourse (story,
 *                             workplace explanation, meeting excerpt, travel
 *                             situation, process explanation, opinion /
 *                             narrative, professional briefing)
 *   multi_speaker_dialogue    the same, with 2+ structurally labelled speakers
 *   connected_speech          recognition of natural spoken realizations
 *                             against their canonical written form
 *   shadowing                 listen → repeat a short natural chunk, judged
 *                             by the EXISTING STT + pronunciation path
 *
 * WHAT THIS IS NOT
 * - No second listening engine: the owning service stays `ListeningService`,
 *   the evaluator stays `../evaluator`, persistence stays the EXISTING
 *   weakness / review ownership.
 * - No scores of any kind: no comprehension percentage, no CEFR listening
 *   score, no WPM figure, no pronunciation score, no fluency rating.
 * - No fake acoustics: utterances are TEXT that the EXISTING
 *   `TextToSpeechProvider` speaks. Speech-rate levels describe playback
 *   controls that the provider either really supports or does not.
 * - No transcript leakage before the learner answers: the passage is spoken
 *   first and only revealed through the EXISTING evaluation reveal.
 */

import type { ListeningDifficulty, ListeningResultCategory } from '../types';
import type { ProgressionLevel, SupportLevel } from '../../learning-progression/types';

/** The deep activity kinds WP-2 adds on top of the Phase-1 exercise types. */
export type DeepListeningTaskType =
  | 'long_discourse'
  | 'multi_speaker_dialogue'
  | 'connected_speech'
  | 'shadowing';

/** Every deep task type, in stable declaration order. */
export const DEEP_LISTENING_TASK_TYPES: readonly DeepListeningTaskType[] = [
  'long_discourse',
  'multi_speaker_dialogue',
  'connected_speech',
  'shadowing',
] as const;

/**
 * The real-world discourse shapes WP-2 supports. These are bounded
 * descriptors of the material, never claims about the learner.
 */
export type DiscourseKind =
  | 'short_story'
  | 'workplace_explanation'
  | 'meeting_excerpt'
  | 'travel_situation'
  | 'process_explanation'
  | 'opinion_narrative'
  | 'professional_briefing';

/** Every discourse kind, in stable declaration order. */
export const DISCOURSE_KINDS: readonly DiscourseKind[] = [
  'short_story',
  'workplace_explanation',
  'meeting_excerpt',
  'travel_situation',
  'process_explanation',
  'opinion_narrative',
  'professional_briefing',
] as const;

/** Human-readable labels (learner-facing; no metadata). */
export const DISCOURSE_KIND_LABELS: Readonly<Record<DiscourseKind, string>> = {
  short_story: 'Short story',
  workplace_explanation: 'Workplace explanation',
  meeting_excerpt: 'Meeting excerpt',
  travel_situation: 'Travel situation',
  process_explanation: 'Process explanation',
  opinion_narrative: 'Opinion / narrative',
  professional_briefing: 'Professional briefing',
};

/** What a deep comprehension question really asks about the discourse. */
export type ComprehensionQuestionKind =
  | 'main_idea'
  | 'detail'
  | 'sequencing'
  | 'inference'
  | 'speaker_intention'
  | 'vocabulary_in_context';

/** Every question kind, in stable declaration order. */
export const COMPREHENSION_QUESTION_KINDS: readonly ComprehensionQuestionKind[] = [
  'main_idea',
  'detail',
  'sequencing',
  'inference',
  'speaker_intention',
  'vocabulary_in_context',
] as const;

/** Learner-facing labels for the question kinds. */
export const COMPREHENSION_QUESTION_LABELS: Readonly<
  Record<ComprehensionQuestionKind, string>
> = {
  main_idea: 'Main idea',
  detail: 'Important detail',
  sequencing: 'Sequence of events',
  inference: 'What it implies',
  speaker_intention: 'What the speaker meant',
  vocabulary_in_context: 'Word in context',
};

/**
 * Connected-speech categories. `spokenRealization` is a real written
 * respelling of natural speech (e.g. "gonna"), never IPA or invented
 * acoustic notation.
 */
export type ConnectedSpeechCategory =
  | 'contraction'
  | 'reduction'
  | 'linking'
  | 'weak_form'
  | 'elision';

/** Every connected-speech category, in stable declaration order. */
export const CONNECTED_SPEECH_CATEGORIES: readonly ConnectedSpeechCategory[] = [
  'contraction',
  'reduction',
  'linking',
  'weak_form',
  'elision',
] as const;

/** Where a realization is natural. A reduction is NOT universal English. */
export type ConnectedSpeechRegister = 'informal' | 'neutral' | 'formal';

/** Every connected-speech register, in stable declaration order. */
export const CONNECTED_SPEECH_REGISTERS: readonly ConnectedSpeechRegister[] = [
  'informal',
  'neutral',
  'formal',
] as const;

/** The sentence forms a realization may take (honest grammar labels). */
export type ConnectedSpeechForm = 'full_form' | 'contracted_form' | 'reduced_form';

/**
 * How much of a shadowing chunk remains visible to the learner.
 * Support is removed gradually, never instantly, and never claimed to be
 * evidence of ability.
 */
export type ShadowingSupportLevel =
  | 'full_transcript'
  | 'partial_transcript'
  | 'audio_only';

/** Support levels from most to least help (deterministic progression order). */
export const SHADOWING_SUPPORT_ORDER: readonly ShadowingSupportLevel[] = [
  'full_transcript',
  'partial_transcript',
  'audio_only',
] as const;

/** Where the deep material came from (honest provenance of the source). */
export type DeepListeningSource =
  | 'listening_weakness'
  | 'due_vocabulary'
  | 'due_expression'
  | 'general';

/**
 * How personalized the SERVED material really is. Same three honest values
 * the rest of the project already uses; a learner merely HAVING a level is
 * never personalization.
 */
export type DeepMaterialProvenance = 'personalized' | 'mixed' | 'general';

/** How the material was produced. */
export type DeepMaterialOrigin = 'deterministic' | 'ai';

/** One structurally labelled speaker. Labels are content, never voice claims. */
export interface DiscourseSpeaker {
  readonly id: string;
  /** Learner-facing label, e.g. a name or a role ("Maya", "Manager"). */
  readonly label: string;
}

/** One spoken segment of discourse, attributed to exactly one speaker. */
export interface DiscourseSegment {
  readonly id: string;
  /** Must reference an existing `DiscourseSpeaker.id`. */
  readonly speakerId: string;
  /** The text the EXISTING TTS speaks for this segment. */
  readonly text: string;
}

/** One comprehension question whose answer is derivable from the discourse. */
export interface ComprehensionQuestion {
  readonly id: string;
  readonly kind: ComprehensionQuestionKind;
  /** The question the learner hears/reads. Never contains the answer. */
  readonly prompt: string;
  /** Deterministic expected answer; must occur in the discourse. */
  readonly expectedAnswer: string;
  /** Additional accepted answers (deterministic alternatives). */
  readonly acceptableAnswers?: readonly string[];
  /** Options when the question is answered by choosing. */
  readonly options?: readonly string[];
  /**
   * The segments that really contain the evidence for the answer. Never a
   * phantom reference: every id must exist and `detail`-style questions must
   * be answerable from exactly these segments.
   */
  readonly evidenceSegmentIds: readonly string[];
  /** Required for `speaker_intention`: the speaker the question is about. */
  readonly speakerId?: string;
  /** Short learning tip shown with the feedback. */
  readonly explanation?: string;
}

/** One connected-speech recognition item: canonical form vs real realization. */
export interface ConnectedSpeechItem {
  readonly id: string;
  readonly category: ConnectedSpeechCategory;
  /** The standard written form — the canonical meaning the learner must keep. */
  readonly writtenForm: string;
  /** The natural spoken respelling actually used in speech. */
  readonly spokenRealization: string;
  /** Where the realization is natural (register honesty). */
  readonly register: ConnectedSpeechRegister;
  readonly form: ConnectedSpeechForm;
  /** The question the learner answers after hearing the realization. */
  readonly prompt: string;
  /** The correct answer — always the canonical written form. */
  readonly expectedAnswer: string;
  readonly options?: readonly string[];
  /** Why the two forms differ, in plain language. */
  readonly explanation: string;
}

interface DeepActivityBase {
  readonly id: string;
  readonly learnerId: string;
  readonly difficulty: ListeningDifficulty;
  /** Where the material came from (honest source label). */
  readonly source: DeepListeningSource;
  /** How personalized the served material really is. */
  readonly contentProvenance: DeepMaterialProvenance;
  readonly materialOrigin: DeepMaterialOrigin;
  /** The deterministic deep-request key the material was built for. */
  readonly requestKey: string;
  readonly contextTopic?: string;
  readonly explanation?: string;
  /** Items whose recognition this activity checks (bounded). */
  readonly keyItems: readonly string[];
}

/** A long-discourse or multi-speaker activity. */
export interface DiscourseListeningActivity extends DeepActivityBase {
  readonly taskType: 'long_discourse' | 'multi_speaker_dialogue';
  readonly discourseKind: DiscourseKind;
  /** How much support the material provides (from the difficulty profile). */
  readonly supportLevel: SupportLevel;
  readonly speakers: readonly DiscourseSpeaker[];
  readonly segments: readonly DiscourseSegment[];
  readonly questions: readonly ComprehensionQuestion[];
}

/** A connected-speech recognition activity. */
export interface ConnectedSpeechListeningActivity extends DeepActivityBase {
  readonly taskType: 'connected_speech';
  readonly items: readonly ConnectedSpeechItem[];
}

/** A shadowing activity: one short natural chunk the learner repeats. */
export interface ShadowingListeningActivity extends DeepActivityBase {
  readonly taskType: 'shadowing';
  /** The short natural chunk (the EXISTING TTS speaks exactly this). */
  readonly chunk: string;
  /** The standard written form of the chunk (canonical meaning kept). */
  readonly canonicalWrittenForm: string;
  /** How much of the chunk is visible before the first repeat. */
  readonly support: ShadowingSupportLevel;
  /** Bounded repeats (repetition is practice, never evidence by itself). */
  readonly maxRepeats: number;
}

/** Any deep listening activity. */
export type DeepListeningActivity =
  | DiscourseListeningActivity
  | ConnectedSpeechListeningActivity
  | ShadowingListeningActivity;

/**
 * The deterministic bounds one deep request may produce. They are DERIVED
 * from the difficulty profile, never chosen by the model.
 */
export interface DeepListeningBounds {
  readonly minSpeakers: number;
  readonly maxSpeakers: number;
  readonly minSegments: number;
  readonly maxSegments: number;
  readonly maxWordsPerSegment: number;
  readonly maxWords: number;
  readonly minQuestions: number;
  readonly maxQuestions: number;
  readonly minOptions: number;
  readonly maxOptions: number;
  readonly minConnectedSpeechItems: number;
  readonly maxConnectedSpeechItems: number;
  readonly minShadowingChunkWords: number;
  readonly maxShadowingChunkWords: number;
  readonly maxKeyItems: number;
  readonly maxExplanationLength: number;
}

/* ------------------------------------------------------------------ *
 * Small pure readers over the activity shapes
 * ------------------------------------------------------------------ */

/** True for the discourse-shaped activities. */
export function isDiscourseActivity(
  activity: DeepListeningActivity,
): activity is DiscourseListeningActivity {
  return activity.taskType === 'long_discourse' || activity.taskType === 'multi_speaker_dialogue';
}

/** Distinct speakers that actually have content in this discourse. */
export function speakingSpeakerIds(
  activity: DiscourseListeningActivity,
): readonly string[] {
  const ids: string[] = [];
  for (const segment of activity.segments) {
    if (!ids.includes(segment.speakerId)) ids.push(segment.speakerId);
  }
  return ids;
}

/** True when the discourse really contains 2+ distinct speakers with content. */
export function isMultiSpeakerActivity(activity: DiscourseListeningActivity): boolean {
  return speakingSpeakerIds(activity).length >= 2;
}

/** The joined spoken passage (deterministic segment order). */
export function discoursePassage(activity: DiscourseListeningActivity): string {
  return activity.segments.map((segment) => segment.text.trim()).join(' ');
}

/** Segments belonging to one question's evidence, in discourse order. */
export function evidenceSegments(
  activity: DiscourseListeningActivity,
  question: ComprehensionQuestion,
): readonly DiscourseSegment[] {
  return activity.segments.filter((segment) => question.evidenceSegmentIds.includes(segment.id));
}

/** Segments attributed to one speaker. */
export function segmentsForSpeaker(
  activity: DiscourseListeningActivity,
  speakerId: string,
): readonly DiscourseSegment[] {
  return activity.segments.filter((segment) => segment.speakerId === speakerId);
}

/** The learner-facing label of a speaker id, when the speaker exists. */
export function speakerLabel(
  activity: DiscourseListeningActivity,
  speakerId: string,
): string | null {
  return activity.speakers.find((speaker) => speaker.id === speakerId)?.label ?? null;
}

/**
 * The text the EXISTING TTS speaks for one connected-speech item: the real
 * spoken realization, never the canonical written form (otherwise the task
 * would leak its own answer through the audio).
 */
export function connectedSpeechSpokenText(item: ConnectedSpeechItem): string {
  return item.spokenRealization.trim();
}

/** The deterministic spoken text of one deep activity. */
export function activitySpokenText(activity: DeepListeningActivity): string {
  switch (activity.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return discoursePassage(activity);
    case 'connected_speech':
      return activity.items.map(connectedSpeechSpokenText).join(' ');
    case 'shadowing':
      return activity.chunk.trim();
    default:
      return '';
  }
}

/** Qualitative shadowing judgement — never a pronunciation score. */
export type ShadowingQualitativeResult =
  | 'matched'
  | 'close'
  | 'different'
  | 'insufficient_evidence';

/** Re-exported so deep consumers do not need a second import path. */
export type { ListeningDifficulty, ListeningResultCategory, ProgressionLevel };
