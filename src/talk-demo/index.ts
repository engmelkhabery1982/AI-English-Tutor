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
  VoiceSessionCoordinator,
  type AudioRecorderService,
  type AudioRecordingResult,
  type VoiceState,
  type VoiceStatus,
  type VoiceStatusListener,
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

export interface TalkSessionBundle {
  readonly session: ConversationSession;
  readonly providerKind: TalkProviderKind;
}

export interface CreateTalkSessionOptions extends VocabularyPersistenceOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
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
    } else {
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
 */
function composeSessionWithProvider(
  config: ConversationSessionConfig,
  provider: AIProvider
): ConversationSession {
  const learnerModel = createDemoLearnerModel();
  const engine = createConversationEngine(learnerModel);
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, config);
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

  if (key) {
    const provider = createGeminiAIProvider({
      apiKey: key,
      fetchImpl: options?.fetchImpl,
    });
    return {
      session: composeSessionWithProvider(sessionConfig, provider),
      providerKind: 'gemini',
    };
  }

  const provider = createDemoAIProvider();
  return {
    session: composeSessionWithProvider(sessionConfig, provider),
    providerKind: 'demo',
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
