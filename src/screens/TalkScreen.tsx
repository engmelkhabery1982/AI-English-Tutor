import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerModel } from '../learner-model';
import type { PronunciationEngine } from '../pronunciation';
import { createDefaultPronunciationEngine } from '../pronunciation';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  createTalkSession,
  createTalkVoiceCoordinator,
  createLearningPersistenceService,
  resolveTalkCoaching,
  resolveTalkTurnControls,
  TALK_REAL_AI_UNAVAILABLE_MESSAGE,
  describeVoiceTurn,
  type AudioRecorderService,
  type ConversationFeedback,
  type ConversationFeedbackVocabulary,
  type ConversationMode,
  type ConversationSession,
  type ConversationTurn,
  type SpeechToTextProvider,
  type TalkCoachingComposition,
  type TalkCoachingResolution,
  type TalkCoachingSource,
  type TalkProviderInfo,
  type TalkProviderKind,
  type VoiceTurnPhase,
  type TextToSpeechProvider,
  type VoiceSessionCoordinator,
  type VoiceStatus,
} from '../talk-demo';

/** Short pause before the tutor opens, so a topic being typed is not cut off. */
const TUTOR_OPENING_DELAY_MS = 400;

const MODES: { readonly key: ConversationMode; readonly label: string }[] = [
  { key: 'natural', label: 'Natural' },
  { key: 'coach', label: 'Coach' },
  { key: 'intensive', label: 'Intensive' },
];

export interface TalkScreenProps {
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly initialMuted?: boolean;
  /** Injectable pronunciation engine (defaults to the real composition). */
  readonly pronunciationEngine?: PronunciationEngine;
  /**
   * Optional local database adapter used to compose the REAL learner model so
   * the existing ConversationEngine can adapt to persisted coaching context.
   * When absent, Talk resolves the canonical application database composition
   * itself (see `loadCoachingComposition`).
   */
  readonly databaseAdapter?: DatabaseAdapter;
  /** Pre-composed real learner model (tests / embedding). */
  readonly learnerModel?: LearnerModel;
  /**
   * Override for the default (real app database) coaching composition. Defaults
   * to `createDefaultTalkComposition()`, so the ROUTED Talk screen always talks
   * to the same canonical local database as the rest of the app.
   */
  readonly loadCoachingComposition?: () => Promise<TalkCoachingComposition>;
}

/**
 * Instruction sent through the EXISTING conversation path to obtain a real
 * tutor opening turn. It is never committed as a learner turn and is never
 * shown or spoken to the learner — only the tutor's real reply is.
 */
export function buildTutorOpeningMessage(topic: string): string {
  const trimmed = topic.trim();
  return trimmed
    ? `Begin the conversation now inside the topic "${trimmed}": greet me briefly and ask one natural question to get me talking.`
    : 'Begin the conversation now: greet me briefly and open one natural everyday topic with a single question to get me talking.';
}

export default function TalkScreen(props?: TalkScreenProps) {
  const [mode, setMode] = useState<ConversationMode>('natural');
  const [topic, setTopic] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastFeedback, setLastFeedback] = useState<ConversationFeedback | null>(null);
  const [savedWords, setSavedWords] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [providerKind, setProviderKind] = useState<TalkProviderKind>('demo');
  const [providerInfo, setProviderInfo] = useState<TalkProviderInfo | null>(null);
  const [isOpening, setIsOpening] = useState<boolean>(false);
  /**
   * Incremented once a NEW conversation session is actually installed and active
   * (drives the tutor opening). It is deliberately bumped AFTER the atomic
   * session switch settles, so the opening always runs against the live session
   * — never against the session that is still being replaced.
   */
  const [sessionEpoch, setSessionEpoch] = useState<number>(0);
  /** Resolved coaching context; null while the real composition is loading. */
  const [coachingSource, setCoachingSource] = useState<TalkCoachingSource | null>(null);
  /** A session switch is running: no learner turn may start until it settles. */
  const [isSwitching, setIsSwitching] = useState<boolean>(false);

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    state: 'idle',
    elapsedSeconds: 0,
    recognizedTranscript: null,
    errorMessage: null,
    isMuted: props?.initialMuted ?? false,
    isSpeaking: false,
    canRecord: true,
    canStopRecording: false,
    canSendText: true,
  });

  const [pronunciationLines, setPronunciationLines] = useState<readonly string[] | null>(null);

  const sessionRef = useRef<ConversationSession | null>(null);
  const voiceCoordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const providerInfoRef = useRef<TalkProviderInfo | null>(null);
  /** In-flight refresh of the persisted coaching context for the live session. */
  const learnerRefreshRef = useRef<Promise<void> | null>(null);
  /** Invalidates in-flight opening attempts when the conversation changes. */
  const openingTokenRef = useRef<number>(0);
  /** Mode+topic identity of the conversation currently composed. */
  const conversationIdentityRef = useRef<string>('');
  /** Resolved real coaching composition (persisted learner evidence). */
  const coachingRef = useRef<TalkCoachingResolution | null>(null);
  /** Guards concurrent session switches: only the newest one may install. */
  const switchTokenRef = useRef<number>(0);
  /** Mirror of `isSwitching` for async callbacks that must not re-enter. */
  const coordinatorIsSwitchingRef = useRef<boolean>(false);
  const pronunciationEngineRef = useRef<PronunciationEngine | null>(
    props?.pronunciationEngine ?? null,
  );
  const scrollViewRef = useRef<ScrollView | null>(null);

  // Pronunciation analysis is secondary to the conversation: compose the
  // engine lazily and never let it break the talk flow.
  useEffect(() => {
    if (pronunciationEngineRef.current) return;
    let active = true;
    createDefaultPronunciationEngine()
      .then((engine) => {
        if (active) pronunciationEngineRef.current = engine;
      })
      .catch(() => {
        // Analysis stays unavailable; conversation is unaffected.
      });
    return () => {
      active = false;
    };
  }, []);

  const runPronunciationAnalysis = async () => {
    const engine = pronunciationEngineRef.current;
    if (!engine) return;
    try {
      const spokenTurn = [...sessionRef.current?.getHistory() ?? []]
        .reverse()
        .find((turn) => turn.role === 'user');
      const transcript = spokenTurn?.content?.trim();
      setPronunciationLines(null);
      if (!transcript) return;

      const outcome = await engine.analyzeSpokenTurn({ transcript, mode });
      setPronunciationLines(outcome?.feedbackLines?.length ? outcome.feedbackLines : null);
    } catch {
      // Non-destructive: pronunciation analysis must never fail the turn.
      setPronunciationLines(null);
    }
  };

  // Initialize or retrieve the active voice coordinator
  const getOrCreateVoiceCoordinator = useCallback(
    (
      currentSession: ConversationSession,
      currentProviderKind: TalkProviderKind
    ): VoiceSessionCoordinator => {
      if (!voiceCoordinatorRef.current) {
        const coordinator = createTalkVoiceCoordinator({
          session: currentSession,
          providerKind: currentProviderKind,
          isMuted: props?.initialMuted ?? false,
          recorder: props?.recorder,
          sttProvider: props?.sttProvider,
          ttsProvider: props?.ttsProvider,
        });
        coordinator.subscribe((status) => {
          setVoiceStatus(status);
          if (status.errorMessage) {
            setErrorMessage(status.errorMessage);
          }
          if (status.state === 'speaking') {
            // The reply is committed and now only being played: the pending
            // "turn" is finished, so the learner can interrupt and speak.
            setIsSending(false);
            setStreamingText(null);
          }
        });
        voiceCoordinatorRef.current = coordinator;
      }
      return voiceCoordinatorRef.current;
    },
    [
      props?.initialMuted,
      props?.recorder,
      props?.sttProvider,
      props?.ttsProvider,
    ],
  );

  /**
   * Starts a NEW conversation identity: cancels any active voice work (recording
   * / in-flight STT or AI work / playback), builds the session stack for the
   * requested mode+topic, and resets all conversation state.
   *
   * Cancelling first is what makes mode changes and New Chat safe: the old
   * session's late results are invalidated by the coordinator generation and by
   * the opening token below, so they can never land in the replacement session.
   */
  const startConversation = useCallback(
    async (
      targetMode: ConversationMode,
      targetTopic: string,
    ): Promise<ConversationSession | null> => {
      const switchToken = (switchTokenRef.current += 1);
      // Any tutor opening of the previous conversation is invalidated at once.
      openingTokenRef.current += 1;
      conversationIdentityRef.current = `${targetMode}::${targetTopic.trim()}`;
      setIsOpening(false);
      setIsSwitching(true);
      coordinatorIsSwitchingRef.current = true;

      const coaching = coachingRef.current;
      const learnerModel = coaching?.learnerModel ?? null;

      // Refresh the persisted coaching context for the new conversation so the
      // existing ConversationEngine sees current weaknesses, due vocabulary,
      // level, goals and progress.
      learnerRefreshRef.current = learnerModel
        ? learnerModel.refresh().catch(() => undefined)
        : null;

      const bundle = createTalkSession(
        {
          mode: targetMode,
          topic: targetTopic.trim() || undefined,
        },
        {
          databaseAdapter: coaching?.databaseAdapter,
          learnerModel: learnerModel ?? undefined,
        },
      );

      const coordinator = voiceCoordinatorRef.current;
      if (coordinator) {
        // ATOMIC switch: the old conversation's recorder/playback cleanup is
        // awaited BEFORE the new session becomes active, and every cleanup write
        // is generation guarded — an older reset can never clobber this session.
        const installed = await coordinator.switchSession(bundle.session);
        if (installed !== bundle.session) {
          // Superseded (or the screen was disposed): the newer operation owns the
          // coordinator and will settle the switch state itself.
          return null;
        }
      } else {
        getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
      }

      // A newer switch superseded this one: install nothing. The newer switch
      // owns the switch flag and will clear it when it settles.
      if (switchToken !== switchTokenRef.current) {
        return null;
      }

      sessionRef.current = bundle.session;
      providerInfoRef.current = bundle.providerInfo;
      setProviderKind(bundle.providerKind);
      setProviderInfo(bundle.providerInfo);

      setHistory([]);
      setLastFeedback(null);
      setSavedWords({});
      setStreamingText(null);
      setInputText('');
      setErrorMessage(null);
      setPronunciationLines(null);
      setIsSending(false);
      setIsSwitching(false);
      coordinatorIsSwitchingRef.current = false;
      // Only now is the replacement session live: the tutor opening may run.
      setSessionEpoch((prev) => prev + 1);

      return bundle.session;
    },
    [getOrCreateVoiceCoordinator],
  );

  /**
   * Resolve the coaching context BEFORE the first conversation is composed.
   *
   * The routed Talk screen passes no adapter, so this resolves the canonical
   * application database composition: real Gemini conversation then adapts to
   * the learner's persisted profile, weaknesses, vocabulary and progress through
   * the EXISTING ConversationEngine. The demo learner model is used only when no
   * persisted data can be composed at all, and that is surfaced honestly.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      const resolution = await resolveTalkCoaching({
        databaseAdapter: props?.databaseAdapter,
        learnerModel: props?.learnerModel,
        loadDefaultComposition: props?.loadCoachingComposition,
      });
      if (!active) return;
      coachingRef.current = resolution;
      setCoachingSource(resolution.source);
    })();
    return () => {
      active = false;
    };
    // Injected adapters/models are fixed for the lifetime of the screen.
  }, [props?.databaseAdapter, props?.learnerModel, props?.loadCoachingComposition]);

  /**
   * Best-effort wait for the persisted coaching context refresh so the very
   * first turn already sees real learner evidence. Never blocks the turn on
   * failure: the conversation always proceeds.
   */
  const ensureLearnerContext = async (): Promise<void> => {
    const pending = learnerRefreshRef.current;
    if (!pending) return;
    try {
      await pending;
    } catch {
      // Refresh is best-effort; the conversation continues regardless.
    }
  };

  // Fresh conversation whenever the mode or the (empty-history) topic changes —
  // the same rule as before, funnelled through startConversation so the previous
  // voice work is always cancelled safely. The identity guard keeps a single
  // composition per identity (no duplicate session/opening).
  useEffect(() => {
    if (coachingSource === null) {
      // Still resolving the REAL persisted coaching context: composing now would
      // silently fall back to the demo learner model.
      return;
    }
    const identity = `${mode}::${topic.trim()}`;
    if (history.length === 0 && conversationIdentityRef.current !== identity) {
      void startConversation(mode, topic);
    }
  }, [mode, topic, history.length, coachingSource, startConversation]);

  const topicEditable = history.length === 0 && !isSending && !isOpening;

  // Tutor-led opening turn: obtained through the EXISTING conversation/AI path.
  // Only attempted when a REAL AI provider is answering; offline demo mode never
  // fabricates a personalized opening.
  useEffect(() => {
    const session = sessionRef.current;
    const openConversation = session?.openConversation?.bind(session);
    if (!session || !openConversation || session.getHistory().length > 0) {
      return;
    }
    if (!providerInfoRef.current?.allowsPersonalizedFeedback) {
      setIsOpening(false);
      return;
    }

    const token = openingTokenRef.current;
    let cancelled = false;

    const runOpening = async (): Promise<void> => {
      // A session switch (New Chat / mode change) owns the coordinator now.
      if (coordinatorIsSwitchingRef.current) {
        return;
      }
      // Stale guard: the learner kept editing the topic, or the conversation was
      // replaced — this opening must not run at all.
      if (cancelled || openingTokenRef.current !== token || sessionRef.current !== session) {
        return;
      }
      // The learner already started talking or typing: their turn leads.
      const voiceState = voiceCoordinatorRef.current?.getStatus().state;
      if (voiceState && voiceState !== 'idle' && voiceState !== 'error' && voiceState !== 'speaking') {
        return;
      }
      if (session.getHistory().length > 0) {
        return;
      }

      setIsOpening(true);
      setStreamingText('');

      try {
        await ensureLearnerContext();
        const result = await openConversation(
          { userMessage: buildTutorOpeningMessage(topic) },
          (chunk: string) => {
            if (openingTokenRef.current === token && sessionRef.current === session) {
              setStreamingText((prev) => (prev ?? '') + chunk);
            }
          },
        );

        // Stale guard: a replaced session must never receive this opening.
        if (cancelled || openingTokenRef.current !== token || sessionRef.current !== session) {
          return;
        }

        setHistory(session.getHistory());
        setIsOpening(false);
        setStreamingText(null);

        if (!result.ok) {
          if (result.error.code === 'cancelled') {
            // The learner started the conversation first (typed/spoken turn), so
            // the stale opening was discarded by the session itself: keep their
            // turn and stay silent instead of showing a false error.
            return;
          }
          setErrorMessage(
            result.error.message ||
              'The tutor could not start the conversation. Please try again.',
          );
          return;
        }

        const openingText = session.getHistory().at(-1)?.content ?? '';
        const coordinator = voiceCoordinatorRef.current;
        if (openingText.trim().length > 0 && coordinator && !coordinator.getStatus().isMuted) {
          // Speak the real tutor turn. Never auto-opens the microphone.
          void coordinator.speakResponse(openingText);
        }
      } catch {
        if (cancelled || openingTokenRef.current !== token || sessionRef.current !== session) {
          return;
        }
        setIsOpening(false);
        setStreamingText(null);
        setErrorMessage('The tutor could not start the conversation. Please try again.');
      }
    };

    // Short debounce so the tutor does not greet the learner mid-typing while
    // they are still entering a topic.
    const timer = setTimeout(() => {
      void runOpening();
    }, TUTOR_OPENING_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionEpoch]);

  // Clean up voice coordinator when component unmounts: stops the recorder and
  // any playback, and discards late voice results.
  useEffect(() => {
    return () => {
      void voiceCoordinatorRef.current?.dispose();
    };
  }, []);

  // Record feedback evidence in background
  useEffect(() => {
    if (lastFeedback) {
      const learningPersistence = createLearningPersistenceService();
      learningPersistence.recordFeedbackEvidence(lastFeedback).catch((err) => {
        console.error('Failed to persist learning feedback:', err);
      });
    }
  }, [lastFeedback]);

  // Handle mode switch: drops the current conversation state; the conversation
  // effect then composes a fresh session in the new mode, which cancels any
  // active recording/playback and starts the tutor's opening turn.
  const handleSelectMode = (newMode: ConversationMode) => {
    if (newMode === mode) return;
    // Cancels any in-flight tutor opening; the conversation effect then performs
    // the atomic session switch for the new mode.
    setIsOpening(false);
    setMode(newMode);
    setLastFeedback(null);
    setSavedWords({});
    setStreamingText(null);
    setErrorMessage(null);
    setPronunciationLines(null);
    setHistory([]);
  };

  // Handle New / Clear conversation: cancels active voice work, then starts a
  // brand-new conversation with the tutor's real opening turn.
  const handleNewConversation = () => {
    // New Chat cancels the active voice work and the tutor opening atomically:
    // the previous conversation's recorder/playback cleanup is awaited before
    // the replacement session becomes active.
    setIsOpening(false);
    void startConversation(mode, topic);
  };

  // Handle save vocabulary item
  const handleSaveVocabulary = async (vocab: ConversationFeedbackVocabulary) => {
    if (!sessionRef.current || !vocab.headword) return;
    const saved = await sessionRef.current.saveVocabularyItem(vocab);
    if (saved) {
      setSavedWords((prev) => ({ ...prev, [vocab.headword.toLowerCase()]: true }));
    }
  };

  // Handle microphone press — the single primary action of a turn.
  const handleToggleRecording = async () => {
    if (isOpening || isSending) {
      // The tutor is opening the conversation / composing a reply: nothing to
      // record yet. The learner stays in control once the turn completes.
      return;
    }
    // No active conversation yet (still preparing or switching): nothing to do.
    const session = sessionRef.current;
    if (!session || isSwitching) return;
    const coordinator = getOrCreateVoiceCoordinator(session, providerKind);

    if (voiceStatus.state === 'recording') {
      setIsSending(true);
      setStreamingText('');
      setErrorMessage(null);

      // One utterance = at most one submitted turn: the coordinator guards this
      // internally as well, so a double tap cannot send the audio twice.
      await ensureLearnerContext();
      const res = await coordinator.stopRecordingAndProcess((chunk: string) => {
        setStreamingText((prev) => (prev ?? '') + chunk);
      });

      // A late result from a session that has since been replaced must never
      // touch the replacement conversation.
      if (sessionRef.current !== session) {
        setIsSending(false);
        setStreamingText(null);
        return;
      }

      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());
      setIsSending(false);
      setStreamingText(null);

      if (!res.ok && res.error) {
        setErrorMessage(res.error);
      }

      // Analyze pronunciation once per spoken turn (never blocks the flow).
      await runPronunciationAnalysis();
    } else if (voiceStatus.canRecord) {
      setErrorMessage(null);
      // Barge-in: the coordinator stops and awaits tutor playback internally
      // before the microphone opens.
      await coordinator.startRecording();
    }
  };

  // Handle stop speaking
  const handleStopSpeaking = async () => {
    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.stopSpeaking();
    }
  };

  // Handle replay response aloud
  const handleReplayResponse = async () => {
    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.replayLastResponse();
    }
  };

  // Handle mute toggle
  const handleToggleMute = () => {
    if (voiceCoordinatorRef.current) {
      voiceCoordinatorRef.current.toggleMute();
    }
  };

  // Handle send message with streaming (typed)
  const handleSendMessage = async () => {
    const trimmedMessage = inputText.trim();
    if (!trimmedMessage || isSending || !voiceStatus.canSendText) {
      return;
    }

    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.stopSpeaking();
    }

    setIsSending(true);
    setErrorMessage(null);
    setInputText('');
    setStreamingText('');

    // Optimistically add user message to history
    const userTurn: ConversationTurn = { role: 'user', content: trimmedMessage };
    setHistory((prev) => [...prev, userTurn]);

    const targetSession = sessionRef.current;
    if (!targetSession || isSwitching) {
      return;
    }

    try {
      await ensureLearnerContext();
      const session = targetSession;
      // Never race the tutor opening: it must finish or be invalidated first.
      if (isOpening) {
        setInputText(trimmedMessage);
        return;
      }
      const result = await session.send(
        { userMessage: trimmedMessage },
        (chunk: string) => {
          if (sessionRef.current === session) {
            setStreamingText((prev) => (prev ?? '') + chunk);
          }
        }
      );

      // Stale guard: a replaced session's result must not appear in the new one.
      if (sessionRef.current !== session) {
        return;
      }

      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());

      if (!result.ok) {
        // The turn was not accepted: nothing was added to the conversation, so
        // the learner keeps their text and can retry.
        setHistory(session.getHistory());
        setInputText(trimmedMessage);
        setErrorMessage(
          result.error.message || 'The tutor returned an error. Please try again.'
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred while sending.';
      const session = sessionRef.current;
      if (session) {
        setHistory(session.getHistory());
      }
      setInputText(trimmedMessage);
      setErrorMessage(message);
    } finally {
      setIsSending(false);
      setStreamingText(null);
    }
  };

  const isPreparing = coachingSource === null;
  // One place decides whether a learner turn may start right now: while the
  // tutor opening is in flight, while a switch is running, or while a turn is
  // being processed, neither the microphone nor the composer is available.
  const turnControls = resolveTalkTurnControls({
    voiceStatus,
    inputText,
    isOpening,
    isSending,
    isSwitching,
    isPreparing,
  });
  const isSendDisabled = turnControls.sendDisabled;
  const isGemini = providerKind === 'gemini';
  const isRealAI = providerInfo?.isRealAI ?? isGemini;
  const providerLabel = providerInfo?.label ?? (isGemini ? 'Gemini • Online' : 'Local Demo • Offline');

  // Learner-facing turn phase, derived from the EXISTING voice status model.
  const turnView = describeVoiceTurn(voiceStatus, isSending || isOpening);
  const isOfflineDemo = !isRealAI;
  // Honest coaching status: personalization is claimed ONLY when the real
  // persisted learner model is in use.
  const usesDemoLearnerModel = coachingSource === 'demo-fallback';
  const turnPhase: VoiceTurnPhase = turnView.phase;
  const micLabel =
    turnPhase === 'recording'
      ? 'Stop recording and send your turn'
      : turnPhase === 'speaking'
      ? 'Interrupt the tutor and speak'
      : 'Tap to speak';

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTextGroup}>
          <Text style={styles.title}>Talk</Text>
          <View style={styles.providerBadgeContainer}>
            <View
              style={[
                styles.statusDot,
                isRealAI ? styles.statusDotGemini : styles.statusDotDemo,
              ]}
            />
            <Text style={styles.subtitle}>{providerLabel}</Text>
          </View>
        </View>
        <View style={styles.headerButtonsGroup}>
          <TouchableOpacity
            style={[styles.muteButton, voiceStatus.isMuted && styles.muteButtonActive]}
            onPress={handleToggleMute}
            accessibilityLabel={voiceStatus.isMuted ? 'Unmute voice playback' : 'Mute voice playback'}
            accessibilityRole="button"
          >
            <Text style={styles.muteButtonText}>
              {voiceStatus.isMuted ? '🔇 Muted' : '🔊 Voice'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.newChatButton}
            onPress={handleNewConversation}
            accessibilityLabel="New Conversation"
            accessibilityRole="button"
          >
            <Text style={styles.newChatButtonText}>New Chat</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Config Bar */}
      <View style={styles.configContainer}>
        <View style={styles.modeSelector}>
          {MODES.map((item) => {
            const isActive = mode === item.key;
            return (
              <TouchableOpacity
                key={item.key}
                style={[styles.modeButton, isActive && styles.modeButtonActive]}
                onPress={() => handleSelectMode(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Text
                  style={[
                    styles.modeButtonText,
                    isActive && styles.modeButtonTextActive,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TextInput
          style={[styles.topicInput, !topicEditable && styles.topicInputLocked]}
          placeholder="Optional topic (e.g. Travel, Job Interview)"
          placeholderTextColor="#9CA3AF"
          value={topic}
          onChangeText={(text) => {
            setTopic(text);
          }}
          editable={topicEditable}
        />
        {history.length > 0 && (
          <Text style={styles.topicLockedHelperText}>
            Start a new chat to change the topic.
          </Text>
        )}

        {/*
          Provider honesty: offline demo output is never presented as real AI
          tutoring. The notice is explicit and stays visible for the whole
          conversation.
        */}
        {isOfflineDemo && (
          <View style={styles.offlineNotice}>
            <Text style={styles.offlineNoticeText}>
              {TALK_REAL_AI_UNAVAILABLE_MESSAGE}
            </Text>
          </View>
        )}

        {/*
          Honest coaching status: with real AI but no persisted learner data, the
          tutor cannot adapt to the learner's saved progress — so it says so
          instead of implying personalization.
        */}
        {isRealAI && usesDemoLearnerModel && (
          <View style={styles.offlineNotice}>
            <Text style={styles.offlineNoticeText}>
              Personalized coaching is unavailable: your saved learner data could
              not be loaded, so replies are not adapted to your progress yet.
            </Text>
          </View>
        )}
      </View>

      {/* Chat Area */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() => {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {history.length === 0 ? (
          <View style={styles.emptyState}>
            {isPreparing || isOpening ? (
              <View style={styles.openingContainer}>
                <ActivityIndicator size="small" color="#2563EB" />
                <Text style={styles.emptyStateTitle}>
                  {isPreparing ? 'Loading your progress…' : 'Your tutor is starting…'}
                </Text>
              </View>
            ) : (
              <Text style={styles.emptyStateTitle}>
                {isOfflineDemo ? 'Offline demo conversation' : 'Your tutor will start'}
              </Text>
            )}
            <Text style={styles.emptyStateDescription}>
              {isPreparing
                ? 'Preparing your tutor with your saved level, weaknesses, vocabulary and progress before the conversation begins.'
                : isOfflineDemo
                ? 'No real AI tutor is available, so replies come from the offline demo script. You can still try the flow, but nothing here is real AI conversation or personalized feedback.'
                : 'Pick a mode and an optional topic — your tutor opens the conversation. Then just tap the microphone and talk naturally.'}
            </Text>
            <View style={styles.suggestionsContainer}>
              <TouchableOpacity
                style={styles.suggestionPill}
                onPress={() => setInputText('Hello')}
              >
                <Text style={styles.suggestionText}>Say "Hello"</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.suggestionPill}
                onPress={() => setInputText('I went to meeting yesterday')}
              >
                <Text style={styles.suggestionText}>Say "I went to meeting yesterday"</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          history.map((turn, index) => {
            const isUser = turn.role === 'user';
            const isLastTurn = index === history.length - 1;
            const isLastAssistant = !isUser && isLastTurn;

            return (
              <View key={`${index}-${turn.role}`} style={styles.turnContainer}>
                <View
                  style={[
                    styles.messageWrapper,
                    isUser ? styles.userMessageWrapper : styles.assistantMessageWrapper,
                  ]}
                >
                  <Text style={styles.roleLabel}>
                    {isUser ? 'You' : isRealAI ? 'AI Tutor' : 'Offline Demo (not real AI)'}
                  </Text>
                  <View
                    style={[
                      styles.bubble,
                      isUser ? styles.userBubble : styles.assistantBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.messageText,
                        isUser ? styles.userMessageText : styles.assistantMessageText,
                      ]}
                    >
                      {turn.content}
                    </Text>
                  </View>
                  {isLastAssistant && (
                    <View style={styles.assistantVoiceActions}>
                      <TouchableOpacity
                        style={styles.replayButton}
                        onPress={handleReplayResponse}
                        accessibilityLabel="Replay tutor response aloud"
                        accessibilityRole="button"
                      >
                        <Text style={styles.replayButtonText}>🔊 Replay</Text>
                      </TouchableOpacity>
                      {voiceStatus.isSpeaking && (
                        <TouchableOpacity
                          style={styles.replayStopButton}
                          onPress={handleStopSpeaking}
                          accessibilityLabel="Stop audio response"
                          accessibilityRole="button"
                        >
                          <Text style={styles.replayStopButtonText}>■ Stop</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>

                {/* Pronunciation note (compact, evidence-based, mode-aware) */}
                {isLastAssistant && pronunciationLines && pronunciationLines.length > 0 && (
                  <View style={styles.pronunciationContainer} testID="pronunciation-note">
                    <Text style={styles.pronunciationTitle}>🎙️ Pronunciation note</Text>
                    {pronunciationLines.map((line, index) => (
                      <Text key={index} style={styles.pronunciationLine}>
                        • {line}
                      </Text>
                    ))}
                  </View>
                )}

                {/* Feedback Panel (rendered under the latest assistant response) */}
                {isLastAssistant && lastFeedback && (
                  <View style={styles.feedbackContainer}>
                    {/* Correction Card */}
                    {lastFeedback.correction && (
                      <View style={styles.feedbackCard}>
                        <View style={styles.feedbackCardHeader}>
                          <Text style={styles.feedbackCardTitle}>Grammar & Phrasing</Text>
                          <View
                            style={[
                              styles.severityPill,
                              lastFeedback.correction.severity === 'incorrect'
                                ? styles.severityPillIncorrect
                                : styles.severityPillMinor,
                            ]}
                          >
                            <Text
                              style={[
                                styles.severityPillText,
                                lastFeedback.correction.severity === 'incorrect'
                                  ? styles.severityPillTextIncorrect
                                  : styles.severityPillTextMinor,
                              ]}
                            >
                              {lastFeedback.correction.severity}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.feedbackOriginalText}>
                          "{lastFeedback.correction.original}"
                        </Text>
                        <Text style={styles.feedbackImprovedText}>
                          → {lastFeedback.correction.improved}
                        </Text>
                        <Text style={styles.feedbackExplanationText}>
                          {lastFeedback.correction.explanation}
                        </Text>
                      </View>
                    )}

                    {/* Vocabulary Card */}
                    {lastFeedback.vocabulary && (
                      <View style={styles.feedbackCard}>
                        <View style={styles.feedbackCardHeader}>
                          <View style={styles.vocabHeaderLeft}>
                            <Text style={styles.feedbackCardTitle}>Key Vocabulary</Text>
                            <View style={styles.categoryPill}>
                              <Text style={styles.categoryPillText}>
                                {lastFeedback.vocabulary.type.replace(/_/g, ' ')}
                              </Text>
                            </View>
                          </View>
                          <TouchableOpacity
                            style={[
                              styles.saveVocabButton,
                              savedWords[lastFeedback.vocabulary.headword.toLowerCase()] &&
                                styles.saveVocabButtonSaved,
                            ]}
                            onPress={() =>
                              lastFeedback.vocabulary &&
                              handleSaveVocabulary(lastFeedback.vocabulary)
                            }
                            accessibilityRole="button"
                          >
                            <Text
                              style={[
                                styles.saveVocabButtonText,
                                savedWords[lastFeedback.vocabulary.headword.toLowerCase()] &&
                                  styles.saveVocabButtonTextSaved,
                              ]}
                            >
                              {savedWords[lastFeedback.vocabulary.headword.toLowerCase()]
                                ? '✓ Saved'
                                : '+ Save Word'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.vocabHeadword}>
                          {lastFeedback.vocabulary.headword}
                        </Text>
                        <Text style={styles.vocabMeaning}>
                          {lastFeedback.vocabulary.meaning}
                        </Text>
                        {lastFeedback.vocabulary.example ? (
                          <Text style={styles.vocabExample}>
                            "{lastFeedback.vocabulary.example}"
                          </Text>
                        ) : null}
                      </View>
                    )}

                    {/* Coaching Note */}
                    {lastFeedback.coachingNote && (
                      <View style={styles.coachingNoteCard}>
                        <Text style={styles.coachingNoteLabel}>Tutor Tip</Text>
                        <Text style={styles.coachingNoteText}>
                          {lastFeedback.coachingNote}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })
        )}

        {/* In-flight streaming message bubble */}
        {isSending && (
          <View style={styles.turnContainer}>
            <View style={[styles.messageWrapper, styles.assistantMessageWrapper]}>
              <Text style={styles.roleLabel}>
                {isRealAI ? 'AI Tutor' : 'Offline Demo (not real AI)'}
              </Text>
              <View style={[styles.bubble, styles.assistantBubble]}>
                {streamingText && streamingText.length > 0 ? (
                  <Text style={[styles.messageText, styles.assistantMessageText]}>
                    {streamingText}
                  </Text>
                ) : (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#2563EB" />
                    <Text style={styles.loadingText}>Thinking…</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Error Notice */}
        {errorMessage && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}
      </ScrollView>

      {/*
        Voice-first turn status: one obvious phase (Your turn / Listening… /
        Transcribing… / Thinking… / Tutor speaking…) plus the primary action.
        No hidden state, no extra control management.
      */}
      <View style={styles.turnStatusBar} accessibilityLiveRegion="polite">
        <View style={styles.turnStatusLeft}>
          {turnPhase === 'recording' && <View style={styles.recordingDot} />}
          {(turnPhase === 'transcribing' || turnPhase === 'thinking') && (
            <ActivityIndicator size="small" color="#2563EB" />
          )}
          {turnPhase === 'speaking' && <Text style={styles.turnStatusIcon}>🔊</Text>}
          {turnPhase === 'ready' && <Text style={styles.turnStatusIcon}>🎤</Text>}
          {turnPhase === 'error' && <Text style={styles.turnStatusIcon}>⚠️</Text>}
          <Text
            style={[
              styles.turnStatusLabel,
              turnPhase === 'recording' && styles.turnStatusLabelActive,
              turnPhase === 'error' && styles.turnStatusLabelError,
            ]}
            numberOfLines={2}
          >
            {turnPhase === 'recording'
              ? `${turnView.label} (${voiceStatus.elapsedSeconds}s)`
              : turnView.label}
          </Text>
        </View>
        {turnPhase === 'speaking' && (
          <TouchableOpacity
            style={styles.stopSpeakingButton}
            onPress={handleStopSpeaking}
            accessibilityLabel="Stop speaking"
            accessibilityRole="button"
          >
            <Text style={styles.stopSpeakingButtonText}>Stop</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.turnHint}>{turnView.hint}</Text>
      {voiceStatus.recognizedTranscript &&
        (voiceStatus.state === 'sending' ||
          turnPhase === 'speaking' ||
          voiceStatus.state === 'idle') &&
        voiceStatus.state !== 'transcribing' &&
        voiceStatus.state !== 'recording' && (
          <Text style={styles.voiceBannerTranscript} numberOfLines={1}>
            You said: "{voiceStatus.recognizedTranscript}"
          </Text>
        )}

      {/* Message Composer */}
      <View style={styles.composerContainer}>
        <TouchableOpacity
          style={[
            styles.micButton,
            // The microphone is the obvious primary action whenever the learner
            // holds the turn (never while the tutor is opening or replying).
            turnControls.microphoneIsPrimary && styles.micButtonPrimary,
            voiceStatus.state === 'recording' && styles.micButtonRecording,
            voiceStatus.state === 'transcribing' && styles.micButtonTranscribing,
            voiceStatus.state === 'speaking' && styles.micButtonSpeaking,
            !voiceStatus.canRecord &&
              voiceStatus.state !== 'recording' &&
              styles.micButtonDisabled,
          ]}
          onPress={handleToggleRecording}
          disabled={turnControls.micDisabled}
          accessibilityRole="button"
          accessibilityLabel={micLabel}
          accessibilityHint={turnView.hint}
          accessibilityState={{ busy: turnPhase === 'transcribing' || turnPhase === 'thinking' }}
        >
          {turnPhase === 'transcribing' || turnPhase === 'thinking' ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text
              style={[
                styles.micButtonText,
                voiceStatus.state === 'recording' && styles.micButtonTextRecording,
                voiceStatus.state === 'speaking' && styles.micButtonTextSpeaking,
              ]}
            >
              {turnPhase === 'recording' || turnPhase === 'speaking' ? '⏹' : '🎤'}
            </Text>
          )}
        </TouchableOpacity>

        <TextInput
          style={[
            styles.composerInput,
            !voiceStatus.canSendText && styles.composerInputDisabled,
          ]}
          placeholder={
            turnPhase === 'recording'
              ? 'Listening to your speech…'
              : turnPhase === 'transcribing'
              ? 'Transcribing audio…'
              : isOfflineDemo
              ? 'Type a message (offline demo, not real AI)…'
              : 'Or type your reply in English…'
          }
          placeholderTextColor="#9CA3AF"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={1000}
          editable={!isSending && !isOpening && voiceStatus.canSendText}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            isSendDisabled && styles.sendButtonDisabled,
          ]}
          onPress={handleSendMessage}
          disabled={isSendDisabled}
          accessibilityLabel="Send message"
          accessibilityRole="button"
        >
          <Text
            style={[
              styles.sendButtonText,
              isSendDisabled && styles.sendButtonTextDisabled,
            ]}
          >
            Send
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  offlineNotice: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  offlineNoticeText: {
    fontSize: 12,
    lineHeight: 17,
    color: '#92400E',
    fontWeight: '500',
  },
  openingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  turnStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 2,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
  },
  turnStatusLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  turnStatusIcon: {
    fontSize: 14,
  },
  turnStatusLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  turnStatusLabelActive: {
    color: '#DC2626',
  },
  turnStatusLabelError: {
    color: '#B91C1C',
  },
  turnHint: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontSize: 12,
    color: '#6B7280',
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  headerTextGroup: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  providerBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusDotGemini: {
    backgroundColor: '#10B981',
  },
  statusDotDemo: {
    backgroundColor: '#9CA3AF',
  },
  subtitle: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
  },
  newChatButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  newChatButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  configContainer: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    gap: 8,
  },
  modeSelector: {
    flexDirection: 'row',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    padding: 3,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  modeButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  modeButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#4B5563',
  },
  modeButtonTextActive: {
    fontWeight: '600',
    color: '#1D4ED8',
  },
  topicInput: {
    height: 36,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#111827',
  },
  topicInputLocked: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
    color: '#6B7280',
  },
  topicLockedHelperText: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: -2,
    marginHorizontal: 2,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    gap: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  emptyStateTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  emptyStateDescription: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  suggestionsContainer: {
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    maxWidth: 320,
  },
  suggestionPill: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  suggestionText: {
    fontSize: 13,
    color: '#2563EB',
    fontWeight: '500',
  },
  turnContainer: {
    marginBottom: 8,
    width: '100%',
  },
  messageWrapper: {
    marginBottom: 4,
    maxWidth: '85%',
  },
  userMessageWrapper: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  assistantMessageWrapper: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  roleLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 3,
    marginHorizontal: 4,
  },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: '#2563EB',
    borderBottomRightRadius: 2,
  },
  assistantBubble: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderBottomLeftRadius: 2,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  assistantMessageText: {
    color: '#1F2937',
  },
  pronunciationContainer: {
    backgroundColor: '#EEF4FF',
    borderColor: '#C9DAF8',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  pronunciationTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1F4E9C',
    marginBottom: 4,
  },
  pronunciationLine: {
    fontSize: 13,
    color: '#2C3E50',
    lineHeight: 18,
  },
  feedbackContainer: {
    marginTop: 8,
    gap: 8,
    width: '100%',
  },
  feedbackCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
  },
  feedbackCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  feedbackCardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  severityPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  severityPillIncorrect: {
    backgroundColor: '#FEE2E2',
  },
  severityPillMinor: {
    backgroundColor: '#FEF3C7',
  },
  severityPillText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  severityPillTextIncorrect: {
    color: '#DC2626',
  },
  severityPillTextMinor: {
    color: '#D97706',
  },
  feedbackOriginalText: {
    fontSize: 13,
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
    marginBottom: 2,
  },
  feedbackImprovedText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
    marginBottom: 4,
  },
  feedbackExplanationText: {
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 17,
  },
  vocabHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  categoryPill: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  categoryPillText: {
    fontSize: 11,
    color: '#4B5563',
    textTransform: 'capitalize',
  },
  saveVocabButton: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  saveVocabButtonSaved: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  saveVocabButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  saveVocabButtonTextSaved: {
    color: '#059669',
  },
  vocabHeadword: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  vocabMeaning: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
    marginBottom: 4,
  },
  vocabExample: {
    fontSize: 12,
    fontStyle: 'italic',
    color: '#6B7280',
  },
  coachingNoteCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
    padding: 10,
  },
  coachingNoteLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  coachingNoteText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  loadingText: {
    fontSize: 13,
    color: '#6B7280',
  },
  errorContainer: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  errorText: {
    fontSize: 13,
    color: '#B91C1C',
  },
  composerContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
  },
  sendButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#2563EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  sendButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  sendButtonTextDisabled: {
    color: '#9CA3AF',
  },
  headerButtonsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  muteButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  muteButtonActive: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  muteButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4B5563',
  },
  assistantVoiceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  replayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  replayButtonText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#4B5563',
  },
  replayStopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#FEE2E2',
  },
  replayStopButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#DC2626',
  },
  voiceBanner: {
    backgroundColor: '#EFF6FF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DBEAFE',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  voiceBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  voiceBannerText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1D4ED8',
    flex: 1,
  },
  voiceBannerTranscript: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1E40AF',
    fontStyle: 'italic',
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  stopSpeakingButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#DBEAFE',
  },
  stopSpeakingButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micButtonPrimary: {
    backgroundColor: '#DBEAFE',
    borderColor: '#93C5FD',
  },
  micButtonRecording: {
    backgroundColor: '#DC2626',
    borderColor: '#B91C1C',
  },
  micButtonTranscribing: {
    backgroundColor: '#2563EB',
    borderColor: '#1D4ED8',
  },
  micButtonSpeaking: {
    backgroundColor: '#059669',
    borderColor: '#047857',
  },
  micButtonDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
  },
  micButtonText: {
    fontSize: 18,
  },
  micButtonTextRecording: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  micButtonTextSpeaking: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  composerInputDisabled: {
    backgroundColor: '#F3F4F6',
    color: '#6B7280',
  },
});
