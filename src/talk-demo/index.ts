/**
 * src/talk-demo/index.ts
 *
 * Composition factory wiring the conversation stack:
 * DemoLearnerModel -> ConversationEngine -> (GeminiAIProvider | DemoAIProvider) -> ConversationOrchestrator -> ConversationSession
 */

import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import {
  createConversationSession,
  type ConversationMode,
  type ConversationSession,
  type ConversationSessionConfig,
  type ConversationSessionResult,
  type ConversationTurn,
} from '../conversation-session';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteConversationRepository,
  SQLiteExpressionRepository,
  SQLiteMistakeRepository,
  SQLiteProgressRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createLearnerModel, type LearnerModel } from '../learner-model';
import type { AIProvider } from '../providers/ai';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import {
  createDemoSTTProvider,
  createGeminiSTTProvider,
  type SpeechToTextProvider,
  type STTAudioInput,
  type STTResult,
} from '../providers/stt';
import {
  createDemoTTSProvider,
  createExpoTTSProvider,
  sanitizeTextForTTS,
  type TextToSpeechProvider,
  type TTSOptions,
} from '../providers/tts';
import {
  createDemoAudioRecorder,
  createExpoAudioRecorder,
  createVoiceSessionCoordinator,
  describeVoiceTurn,
  VoiceSessionCoordinator,
  type AudioRecorderService,
  type AudioRecordingResult,
  type VoiceState,
  type VoiceStatus,
  type VoiceStatusListener,
  type VoiceTurnPhase,
  type VoiceTurnView,
} from '../voice';
import { createDemoLearnerModel } from './demo-learner-model';
import {
  createVocabularyPersistenceService,
  type VocabularyPersistenceOptions,
} from './vocabulary-persistence';
export { createDemoLearnerModel } from './demo-learner-model';
export {
  createVocabularyPersistenceService,
  type VocabularyPersistenceOptions,
} from './vocabulary-persistence';
export {
  createLearningPersistenceService,
} from './learning-persistence';
export {
  createDemoSTTProvider,
  createGeminiSTTProvider,
  createDemoTTSProvider,
  createExpoTTSProvider,
  createDemoAudioRecorder,
  createExpoAudioRecorder,
  createVoiceSessionCoordinator,
  VoiceSessionCoordinator,
  sanitizeTextForTTS,
  describeVoiceTurn,
};
export type {
  SpeechToTextProvider,
  STTAudioInput,
  STTResult,
  TextToSpeechProvider,
  TTSOptions,
  AudioRecorderService,
  AudioRecordingResult,
  VoiceState,
  VoiceStatus,
  VoiceStatusListener,
  VoiceTurnPhase,
  VoiceTurnView,
};
export type {
  ConversationMode,
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
  ConversationTurn,
};

export type {
  ConversationFeedback,
  ConversationFeedbackCorrection,
  ConversationFeedbackVocabulary,
} from '../providers/ai';

export type TalkProviderKind = 'gemini' | 'demo';

/**
 * Honest description of what kind of tutoring the active conversation is.
 *
 * The Demo provider is a deterministic OFFLINE script kept for demo/offline
 * use. It is not real AI tutoring, it cannot adapt to the learner, and nothing
 * it produces may be presented as genuine personalized AI feedback. Every
 * surface that renders tutor output must read these flags instead of assuming
 * an AI tutor is present.
 */
export interface TalkProviderInfo {
  readonly kind: TalkProviderKind;
  /** True only when a REAL AI provider answered this conversation. */
  readonly isRealAI: boolean;
  /** Learner-facing sentence stating exactly what is producing replies. */
  readonly label: string;
  /** True when tutor replies may be attributed to real AI feedback. */
  readonly allowsPersonalizedFeedback: boolean;
}

export const TALK_REAL_AI_LABEL = 'Gemini • Real AI tutor';
export const TALK_DEMO_LABEL = 'Offline demo • Not real AI';

/** Shown when the learner tries to start a real voice conversation offline. */
export const TALK_REAL_AI_UNAVAILABLE_MESSAGE =
  'Real AI conversation is not available right now (no real AI provider is configured). This offline demo can still be used to try the flow, but nothing here is real AI tutoring or personalized feedback.';

function describeProviderKind(kind: TalkProviderKind): TalkProviderInfo {
  if (kind === 'gemini') {
    return {
      kind,
      isRealAI: true,
      label: TALK_REAL_AI_LABEL,
      allowsPersonalizedFeedback: true,
    };
  }
  return {
    kind,
    isRealAI: false,
    label: TALK_DEMO_LABEL,
    allowsPersonalizedFeedback: false,
  };
}

export interface TalkSessionBundle {
  readonly session: ConversationSession;
  readonly providerKind: TalkProviderKind;
  /** Honest capability description for the active provider. */
  readonly providerInfo: TalkProviderInfo;
}

export interface CreateTalkSessionOptions extends VocabularyPersistenceOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional adapter used to compose the REAL learner model (persisted coaching
   * context). Without it the deterministic demo learner model is used, and the
   * bundle honestly reports that coaching is not backed by real learner data.
   */
  readonly databaseAdapter?: DatabaseAdapter;
  /**
   * Pre-composed learner model (existing system) used by the existing
   * ConversationEngine. Lets the caller refresh the persisted coaching context
   * before the first turn instead of composing a second model instance.
   */
  readonly learnerModel?: LearnerModel;
}

export interface CreateVoiceCoordinatorOptions {
  readonly session: ConversationSession;
  readonly providerKind: TalkProviderKind;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly isMuted?: boolean;
}

/**
 * Creates a VoiceSessionCoordinator for a ConversationSession.
 * Wires real Gemini STT and Expo TTS/audio when in Gemini mode,
 * or Demo providers when in Demo mode or when custom providers are supplied.
 */
/**
 * Honest failure text for a real conversation that has no real speech
 * recognition available. Nothing is fabricated in its place.
 */
export const TALK_REAL_STT_UNAVAILABLE_MESSAGE =
  'Real speech recognition is unavailable, so your speech could not be transcribed. Check the real AI provider configuration and try again.';

/**
 * Speech-to-text provider used when a REAL conversation was requested but no
 * real speech recognition is configured: it fails honestly instead of returning
 * a scripted demo transcript that would look like the learner's own speech.
 */
function createUnavailableSTTProvider(): SpeechToTextProvider {
  return {
    id: 'stt-unavailable',
    async transcribe(): Promise<STTResult> {
      return { ok: false, error: TALK_REAL_STT_UNAVAILABLE_MESSAGE };
    },
  };
}

export function createTalkVoiceCoordinator(
  options: CreateVoiceCoordinatorOptions
): VoiceSessionCoordinator {
  const key = options.apiKey?.trim() || getGeminiApiKey();

  let sttProvider = options.sttProvider;
  if (!sttProvider) {
    if (options.providerKind === 'gemini' && key) {
      sttProvider = createGeminiSTTProvider({
        apiKey: key,
        fetchImpl: options.fetchImpl,
      });
    } else if (options.providerKind === 'gemini') {
      // Real conversation requested but no real STT is available: the learner
      // is told honestly instead of having a scripted transcript heard as if it
      // were their own speech.
      sttProvider = createUnavailableSTTProvider();
    } else {
      // Offline demo only — clearly advertised as such by the caller.
      sttProvider = createDemoSTTProvider();
    }
  }

  const ttsProvider = options.ttsProvider || createExpoTTSProvider();
  const recorder = options.recorder || createExpoAudioRecorder();

  return createVoiceSessionCoordinator({
    session: options.session,
    recorder,
    sttProvider,
    ttsProvider,
    isMuted: options.isMuted ?? false,
  });
}

/**
 * Resolves the active Gemini API key from environment or explicit parameter.
 */
export function getGeminiApiKey(): string | null {
  const envKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  if (typeof envKey === 'string' && envKey.trim().length > 0) {
    return envKey.trim();
  }
  return null;
}

/**
 * Internal helper to compose the session stack around a given AIProvider.
 *
 * The EXISTING ConversationEngine reads the LearnerModel on every turn. When a
 * database adapter is available, the REAL learner model (persisted profile,
 * weaknesses, vocabulary, expressions, progress) is used so the tutor can adapt
 * to genuine stored evidence. The deterministic demo learner model remains the
 * fallback when no real state is available — it never invents learner history.
 */
function composeSessionWithProvider(
  config: ConversationSessionConfig,
  provider: AIProvider,
  learnerModel?: LearnerModel
): ConversationSession {
  const model = learnerModel ?? createDemoLearnerModel();
  const engine = createConversationEngine(model);
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, config);
}

/**
 * Build the EXISTING learner model on the given adapter (real persisted
 * coaching context). Returns null when no real state can be composed, in which
 * case the deterministic demo learner model is used instead — no learner
 * history is ever invented.
 */
export function createTalkLearnerModel(adapter: DatabaseAdapter): LearnerModel | null {
  try {
    return createLearnerModel({
      profile: new SQLiteUserProfileRepository(adapter),
      conversations: new SQLiteConversationRepository(adapter),
      mistakes: new SQLiteMistakeRepository(adapter),
      pronunciation: new SQLitePronunciationRepository(adapter),
      weaknesses: new SQLiteWeaknessRepository(adapter),
      vocabulary: new SQLiteVocabularyRepository(adapter),
      expressions: new SQLiteExpressionRepository(adapter),
      review: new SQLiteReviewRepository(adapter),
      lessons: { get: async () => null, list: async () => [] },
      exercises: { get: async () => null, list: async () => [] },
      progress: new SQLiteProgressRepository(adapter),
    });
  } catch {
    return null;
  }
}

/**
 * Creates an end-to-end runnable ConversationSession bundle.
 * Uses Gemini AI Provider when an API key is available, falling back to Demo AI Provider.
 * Connects vocabulary saving to SQLite local persistence via existing repository layer.
 */
export function createTalkSession(
  config: ConversationSessionConfig,
  options?: CreateTalkSessionOptions
): TalkSessionBundle {
  const persistenceService = createVocabularyPersistenceService({
    vocabularyRepository: options?.vocabularyRepository,
    userProfileRepository: options?.userProfileRepository,
    databaseAdapter: options?.databaseAdapter,
    learnerId: options?.learnerId,
  });

  const sessionConfig: ConversationSessionConfig = {
    ...config,
    onSaveVocabulary: async (vocab) => {
      const savedItem = await persistenceService.saveVocabulary(vocab);
      if (!savedItem) {
        throw new Error('Vocabulary persistence failed or no learner profile exists');
      }
      if (config.onSaveVocabulary) {
        await config.onSaveVocabulary(vocab);
      }
    },
  };

  const key = options?.apiKey?.trim() || getGeminiApiKey();
  const learnerModel =
    options?.learnerModel ??
    (options?.databaseAdapter ? createTalkLearnerModel(options.databaseAdapter) : null);

  if (key) {
    const provider = createGeminiAIProvider({
      apiKey: key,
      fetchImpl: options?.fetchImpl,
    });
    return {
      session: composeSessionWithProvider(sessionConfig, provider, learnerModel ?? undefined),
      providerKind: 'gemini',
      providerInfo: describeProviderKind('gemini'),
    };
  }

  // No real AI provider is configured: the deterministic offline demo session
  // is returned but is explicitly flagged as NOT real AI tutoring.
  const provider = createDemoAIProvider();
  return {
    session: composeSessionWithProvider(sessionConfig, provider, learnerModel ?? undefined),
    providerKind: 'demo',
    providerInfo: describeProviderKind('demo'),
  };
}

/**
 * Creates a voice conversation bundle for Talk.
 *
 * - When a real AI provider is configured, the coordinator uses real Gemini STT
 *   and the real AI conversation.
 * - When none is configured, the honest offline demo is returned with its
 *   `providerInfo` flag so the UI can state plainly that this is not real AI.
 * - `requireRealAI` returns `session: null` instead of the offline demo, so a
 *   caller that must not present demo output as tutoring can refuse cleanly.
 */
export function createTalkVoiceSessionBundle(
  config: ConversationSessionConfig,
  options?: CreateTalkSessionOptions & { readonly requireRealAI?: boolean }
): { readonly bundle: TalkSessionBundle | null; readonly realAIUnavailable: boolean } {
  const key = options?.apiKey?.trim() || getGeminiApiKey();
  if (!key && options?.requireRealAI) {
    return { bundle: null, realAIUnavailable: true };
  }
  return {
    bundle: createTalkSession(config, options),
    realAIUnavailable: false,
  };
}

/**
 * Creates a ConversationSession that ALWAYS uses the local DemoAIProvider,
 * completely independent of any environment variables, API keys, or network availability.
 * Does not require SQLite persistence.
 */
export function createTalkDemoSession(
  config: ConversationSessionConfig
): ConversationSession {
  const provider = createDemoAIProvider();
  return composeSessionWithProvider(config, provider);
}
