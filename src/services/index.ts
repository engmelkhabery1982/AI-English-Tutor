/**
 * src/services/index.ts
 *
 * Service layer: thin orchestrators that wire providers to engines.
 *
 * These are placeholders. The real ConversationService and
 * LearningService will be implemented once their dependencies
 * (repositories, learner model) exist.
 */

import type { AIProvider } from '../domain/providers/ai';
import type { SpeechToTextProvider } from '../domain/providers/stt';
import type { TextToSpeechProvider } from '../domain/providers/tts';
import type { PronunciationProvider } from '../domain/providers/pronunciation';

/**
 * Provider bundle. The app selects concrete providers at runtime,
 * but the UI and engines only ever depend on these interfaces.
 */
export interface ProviderBundle {
  readonly ai: AIProvider;
  readonly stt: SpeechToTextProvider;
  readonly tts: TextToSpeechProvider;
  readonly pronunciation: PronunciationProvider;
}

/**
 * ConversationService placeholder.
 *
 * Future responsibilities:
 * - manage conversation sessions
 * - route learner audio -> STT -> AI -> TTS
 * - apply correction/coaching based on mode
 * - persist turns via ConversationRepository
 */
export interface ConversationService {
  readonly providers: ProviderBundle;
}

/**
 * LearningService placeholder.
 *
 * Future responsibilities:
 * - analyze turns for mistakes / weaknesses / strengths
 * - update the Learner Model
 * - recommend adaptive activities
 * - schedule spaced repetition
 */
export interface LearningService {
  readonly providers: ProviderBundle;
}