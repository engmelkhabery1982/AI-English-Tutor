import type { VocabularyCategory } from '../domain/shared/types';
import type { ListeningEvaluation } from '../listening/types';

export type LessonMode = 'listening' | 'reading';
export type LessonLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export interface LessonQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly answer: string;
  readonly explanation: string;
}
export interface LessonLanguage {
  readonly text: string;
  readonly itemType: VocabularyCategory;
  readonly meaning: string;
  readonly context: string;
}
/** Shared listening/reading content; level is content intent, never learner assessment. */
export interface StoryLesson {
  readonly id: string;
  readonly title: string;
  readonly topic: string;
  readonly level: LessonLevel;
  readonly difficultyIntent: string;
  readonly passage: string;
  readonly questions: readonly LessonQuestion[];
  readonly language: readonly LessonLanguage[];
  readonly provenance: { readonly kind: 'curated' | 'ai-generated'; readonly providerId?: string };
}
export interface LessonAnswer {
  readonly questionId: string;
  readonly answer: string;
  readonly evaluation: ListeningEvaluation;
  readonly assisted: boolean;
}
export interface LessonSessionSnapshot {
  readonly lesson: StoryLesson;
  readonly mode: LessonMode;
  readonly transcriptVisible: boolean;
  readonly languageVisible: boolean;
  readonly assistance: { readonly revealed: boolean; readonly plays: number; readonly slowed: boolean };
  readonly playback: 'idle' | 'playing' | 'error';
  readonly answers: readonly LessonAnswer[];
  readonly pendingAnswer: { readonly questionId: string; readonly answer: string } | null;
  readonly completed: boolean;
  readonly error: string | null;
}
