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
import { resolveGeminiApiKey } from '../provider-config';
import type { AIProvider } from '../providers/ai';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import {
  createAIProviderError,
  createAIProviderFailure,
  type AIProviderResult,
  type AIStreamCallback,
  type ConversationRequest,
} from '../providers/ai';
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
  resolveTalkTurnControls,
  type TalkTurnControlInput,
  type TalkTurnControls,
} from './turn-controls';
export {
  buildConversationReview,
  deriveConversationSessionId,
  finalizeConversationWithReview,
  replaceConversationWithMemory,
  createConversationMemoryRecorder,
  createConversationMemoryService,
  stripHiddenFeedback,
  CONVERSATION_MEMORY_DEMO_NOTICE,
  CONVERSATION_MEMORY_EMPTY_NOTICE,
  CONVERSATION_MEMORY_FAILED_NOTICE,
  CONVERSATION_REVIEW_TITLE,
  type ConversationFinalizeReason,
  type ConversationMemoryRecorder,
  type ConversationMemoryService,
  type ConversationMemoryServiceOptions,
  type ConversationMemorySnapshot,
  type ConversationMemoryTurn,
  type ConversationReview,
  type OutgoingConversation,
  type ReplaceConversationWithMemoryInput,
  type ReplaceConversationWithMemoryResult,
  type ConversationReviewEvidence,
  type ConversationReviewSection,
  type ConversationReviewSectionId,
  type FinalizeConversationResult,
} from './conversation-memory';
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

/**
 * Which provider is ACTUALLY behind a Talk conversation.
 *
 * - `gemini`      — a real AI provider answered the conversation.
 * - `demo`        — the deterministic offline script, reachable ONLY through an
 *                   explicit Demo Mode request. Never an automatic fallback.
 * - `unavailable` — nothing is configured. NO provider replies at all: the
 *                   conversation cannot produce tutor output, and the learner is
 *                   told that configuration (or explicit Demo Mode) is required.
 */
export type TalkProviderKind = 'gemini' | 'demo' | 'unavailable';

/**
 * Honest description of what kind of tutoring the active conversation is.
 *
 * The Demo provider is a deterministic OFFLINE script kept for explicit demo
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
export const TALK_PROVIDER_UNAVAILABLE_LABEL = 'Real AI unavailable • Configuration required';

/** Shown when the learner asks for real AI but none is configured. */
export const TALK_REAL_AI_UNAVAILABLE_MESSAGE =
  'Real AI conversation is not available right now (no real AI provider is configured). This offline demo can still be used to try the flow, but nothing here is real AI tutoring or personalized feedback.';

/**
 * Shown when NO provider is configured and Demo Mode was not chosen.
 *
 * Nothing is substituted: there is no scripted tutor reply, and the learner is
 * pointed at the honest next step instead.
 */
export const TALK_CONFIGURATION_REQUIRED_MESSAGE =
  'Real AI is not configured on this device, so no tutor replies can be generated. Add an API key in Settings to talk with the real tutor. Nothing scripted is substituted here.';

/** Honest failure text for a conversation with no configured provider. */
export const TALK_AI_CONFIGURATION_REQUIRED_ERROR =
  'No AI provider is configured on this device, so this conversation cannot generate tutor replies. Configure a provider in Settings.';

/**
 * An AI provider that NEVER fabricates anything.
 *
 * Used when no real provider is configured and Demo Mode was not chosen: every
 * request fails honestly instead of returning scripted text. This is the same
 * pattern already used for speech recognition
 * (`createUnavailableSTTProvider`) — the difference being that this one makes
 * it impossible for a tutor reply to exist at all.
 */
export function createUnavailableAIProvider(
  message: string = TALK_AI_CONFIGURATION_REQUIRED_ERROR,
): AIProvider {
  const failure = (): AIProviderResult =>
    createAIProviderFailure(createAIProviderError('unavailable', message, false));

  return {
    id: 'ai-unavailable',
    async generate(_request: ConversationRequest): Promise<AIProviderResult> {
      return failure();
    },
    async generateStream(
      _request: ConversationRequest,
      _onChunk: AIStreamCallback,
    ): Promise<AIProviderResult> {
      return failure();
    },
  };
}

function describeProviderKind(kind: TalkProviderKind): TalkProviderInfo {
  if (kind === 'gemini') {
    return {
      kind,
      isRealAI: true,
      label: TALK_REAL_AI_LABEL,
      allowsPersonalizedFeedback: true,
    };
  }
  if (kind === 'unavailable') {
    return {
      kind,
      isRealAI: false,
      label: TALK_PROVIDER_UNAVAILABLE_LABEL,
      allowsPersonalizedFeedback: false,
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
  /**
   * EXPLICIT Demo Mode. Demo AI is reachable ONLY when the caller asks for it
   * here (or uses `createTalkDemoSession`). Without it, a missing credential
   * yields an honest `unavailable` conversation instead of a scripted one.
   * Takes precedence over a configured key: the caller asked for Demo.
   */
  readonly isDemo?: boolean;
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
 * Speech-to-text provider used when a REAL voice interaction was requested but
 * no real speech recognition is configured: it fails honestly instead of
 * returning a scripted demo transcript that would look like the learner's own
 * speech. Shared with the Review surface, which passes its own wording.
 */
export function createUnavailableSTTProvider(
  message: string = TALK_REAL_STT_UNAVAILABLE_MESSAGE,
): SpeechToTextProvider {
  return {
    id: 'stt-unavailable',
    async transcribe(): Promise<STTResult> {
      return { ok: false, error: message };
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
    } else if (options.providerKind === 'unavailable') {
      // Nothing is configured and Demo Mode was not chosen: no scripted
      // transcript may stand in for the learner's own speech either.
      sttProvider = createUnavailableSTTProvider(
        'Speech recognition is not configured on this device. Configure a provider in Settings.',
      );
    } else {
      // Explicit Demo Mode only — clearly advertised as such by the caller.
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
 * The ONE canonical API-key lookup used by every provider factory in the app
 * (Talk, Review, Listening, Adaptive Lessons, Deep Speaking and the screens
 * that build voice input).
 *
 * Resolution is owned by `src/provider-config` and follows an explicit
 * precedence:
 *   1. injected credential (tests / embedding)
 *   2. runtime credential held in SECURE DEVICE STORAGE (the production path)
 *   3. `EXPO_PUBLIC_GEMINI_API_KEY` — DEVELOPMENT BUILDS ONLY
 *   4. unavailable (null)
 *
 * `EXPO_PUBLIC_*` values are inlined into the compiled JS bundle, so they are
 * never used as production secret storage: in a release build the environment
 * fallback is disabled.
 */
export function getGeminiApiKey(): string | null {
  return resolveGeminiApiKey();
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
 *
 * Provider selection is EXPLICIT — there is no automatic Demo fallback:
 *
 *   options.isDemo === true  → Demo AI (explicit Demo Mode, clearly labelled)
 *   a credential is available → Gemini (real AI)
 *   otherwise                 → `unavailable`: no tutor reply can be produced
 *
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

  // EXPLICIT Demo Mode wins: the caller asked for the offline script.
  if (options?.isDemo === true) {
    const demoProvider = createDemoAIProvider();
    return {
      session: composeSessionWithProvider(sessionConfig, demoProvider, learnerModel ?? undefined),
      providerKind: 'demo',
      providerInfo: describeProviderKind('demo'),
    };
  }

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

  // No real AI provider is configured and Demo Mode was NOT requested. Nothing
  // is substituted: the session is composed on a provider that fails honestly,
  // so no scripted or fabricated tutor reply can ever exist, and the surface
  // reports "configuration required" instead of starting a demo conversation.
  const unavailableProvider = createUnavailableAIProvider();
  return {
    session: composeSessionWithProvider(
      sessionConfig,
      unavailableProvider,
      learnerModel ?? undefined,
    ),
    providerKind: 'unavailable',
    providerInfo: describeProviderKind('unavailable'),
  };
}

/**
 * The REAL coaching composition used by Talk: the canonical application
 * database plus the EXISTING learner model composed on it. Nothing else is
 * needed to make real Gemini conversation adapt to persisted evidence.
 */
export interface TalkCoachingComposition {
  readonly databaseAdapter: DatabaseAdapter;
  readonly learnerModel: LearnerModel;
}

/**
 * Where the tutoring context came from.
 * - 'persisted': the EXISTING learner model on the real app database.
 * - 'demo-fallback': the deterministic demo learner model, used ONLY when no
 *   persisted app data could be composed. Never presented as personalization.
 */
export type TalkCoachingSource = 'persisted' | 'demo-fallback';

export interface TalkCoachingResolution {
  readonly databaseAdapter?: DatabaseAdapter;
  readonly learnerModel?: LearnerModel;
  readonly source: TalkCoachingSource;
}

export interface TalkCoachingResolutionOptions {
  /** Injected adapter (tests / embedding) — composed into the real learner model. */
  readonly databaseAdapter?: DatabaseAdapter;
  /** Injected pre-composed learner model (tests / embedding). */
  readonly learnerModel?: LearnerModel;
  /** Override for the default bootstrap (tests); defaults to the app database. */
  readonly loadDefaultComposition?: () => Promise<TalkCoachingComposition>;
}

/**
 * Compose the Talk coaching context on a given adapter using the EXISTING
 * learner model + repositories. Throws when the adapter cannot back a learner
 * model, so callers fall back EXPLICITLY instead of silently using demo data.
 */
export function createTalkComposition(adapter: DatabaseAdapter): TalkCoachingComposition {
  const learnerModel = createTalkLearnerModel(adapter);
  if (!learnerModel) {
    throw new Error(
      'Persisted learner data could not be composed from the local database.',
    );
  }
  return { databaseAdapter: adapter, learnerModel };
}

// Default composition bootstrap. The dynamic Expo SQLite import and adapter
// lifecycle live HERE — behind composition — never inside UI screens. This
// follows the SAME pattern already used by the adaptive lessons, listening and
// pronunciation modules, on the SAME canonical database file.
let defaultCompositionPromise: Promise<TalkCoachingComposition> | null = null;

/** Compose Talk's coaching context on the default app database (reused). */
export function createDefaultTalkComposition(): Promise<TalkCoachingComposition> {
  if (!defaultCompositionPromise) {
    defaultCompositionPromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createTalkComposition(adapter);
    })().catch((error: unknown) => {
      // Allow a later retry instead of caching a failed bootstrap forever.
      defaultCompositionPromise = null;
      throw error;
    });
  }
  return defaultCompositionPromise;
}

/**
 * Resolves the coaching context Talk must use, in this order:
 * 1. an explicitly injected learner model (tests / embedding),
 * 2. an injected adapter, composed through the existing learner model,
 * 3. the DEFAULT application database composition.
 *
 * Only when no persisted data can be composed at all does it return an explicit
 * 'demo-fallback' resolution — the caller must then say so instead of claiming
 * personalization.
 */
export async function resolveTalkCoaching(
  options: TalkCoachingResolutionOptions = {},
): Promise<TalkCoachingResolution> {
  if (options.learnerModel) {
    return {
      databaseAdapter: options.databaseAdapter,
      learnerModel: options.learnerModel,
      source: 'persisted',
    };
  }

  if (options.databaseAdapter) {
    try {
      const composition = createTalkComposition(options.databaseAdapter);
      return { ...composition, source: 'persisted' };
    } catch {
      return { source: 'demo-fallback' };
    }
  }

  try {
    const load = options.loadDefaultComposition ?? createDefaultTalkComposition;
    const composition = await load();
    return { ...composition, source: 'persisted' };
  } catch {
    return { source: 'demo-fallback' };
  }
}

/**
 * Creates a voice conversation bundle for Talk.
 *
 * - When a real AI provider is configured, the coordinator uses real Gemini STT
 *   and the real AI conversation.
 * - When none is configured, the bundle reports `unavailable` with its
 *   `providerInfo` flag: the surface must state that configuration (or explicit
 *   Demo Mode) is required. There is no automatic Demo fallback.
 * - `requireRealAI` returns `bundle: null` instead of anything that is not real
 *   AI, so a caller that must not present demo output as tutoring can refuse
 *   cleanly.
 */
export function createTalkVoiceSessionBundle(
  config: ConversationSessionConfig,
  options?: CreateTalkSessionOptions & { readonly requireRealAI?: boolean }
): { readonly bundle: TalkSessionBundle | null; readonly realAIUnavailable: boolean } {
  const bundle = createTalkSession(config, options);
  if (options?.requireRealAI && bundle.providerKind !== 'gemini') {
    return { bundle: null, realAIUnavailable: true };
  }
  return { bundle, realAIUnavailable: false };
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
