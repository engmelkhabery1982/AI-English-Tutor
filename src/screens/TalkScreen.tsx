import { SafeAreaView } from 'react-native-safe-area-context';
import type { VocabularyCategory } from '../domain/shared/types';
import MicrophoneHelp from './components/MicrophoneHelp';
import TouchableOpacity from './components/LearnerButton';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerModel } from '../learner-model';
import type { PronunciationEngine } from '../pronunciation';
import { createDefaultPronunciationEngine } from '../pronunciation';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { countCommittedLearnerTurns } from '../conversation-session';
import { MicIntentQueue } from '../voice/mic-intent';
import {
  resolveSpeechRateCapability,
  planSpeechRate,
  speechRateTTSOptions,
} from '../listening';
import {
  HELP_ACTION_DESCRIPTORS,
  TEMPORARY_FEWER_CORRECTIONS,
  buildHelpInstruction,
  helpActionIsEvidenceSafe,
  isProviderHelpAction,
  resolveHelpControls,
  resolveEffectiveConversationMode,
  CORRECTION_INTENSITY_TO_MODE,
  MODE_TO_CORRECTION_INTENSITY,
  createSaveToReviewService,
  createCorrectionPreferencesService,
  type CorrectionIntensity,
  type HelpActionId,
  type SaveToReviewService,
} from '../learner-agency';
import {
  finalizeConversationWithReview,
  hasUnappliedTopicDraft,
  isConversationReusable,
  learnerMessageForFailure,
  normalizeTopicDraft,
  replaceConversationWithMemory,
  resolveConversationIdentity,
  TALK_CONVERSATION_RESTARTED_MESSAGE,
  TALK_CONVERSATION_RESTARTED_MIC_MESSAGE,
  createConversationMemoryRecorder,
  createConversationMemoryService,
  type ConversationMemoryService,
  createTalkSession,
  createTalkVoiceCoordinator,
  createLearningPersistenceService,
  resolveTalkCoaching,
  CONVERSATION_REVIEW_TITLE,
  resolveTalkTurnControls,
  TALK_REAL_AI_UNAVAILABLE_MESSAGE,
  TALK_CONFIGURATION_REQUIRED_MESSAGE,
  describeVoiceTurn,
  type AudioRecorderService,
  type ConversationFeedback,
  type ConversationFeedbackVocabulary,
  type ConversationMode,
  type ConversationSession,
  type ConversationTurn,
  type SpeechToTextProvider,
  type ConversationMemoryRecorder,
  type ConversationReview,
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

/**
 * Shown when the learner taps the microphone while a conversation/session
 * transition is running. The tap is NOT lost: exactly one mic intent is queued
 * and executes as soon as the new conversation is installed.
 */
export const TALK_MIC_QUEUED_MESSAGE =
  'Just a moment — recording will start as soon as your conversation is ready.';

/**
 * Correction-intensity chips (Work Order 2). The KEYS are the EXISTING
 * ConversationMode values the engine already honors — only the learner-facing
 * labels changed to the intensity wording. The selection persists through the
 * existing profile preferences service; the temporary "fewer corrections for
 * now" control is session-local and never touches these chips.
 */
const MODES: { readonly key: ConversationMode; readonly label: string }[] = [
  { key: 'natural', label: 'Natural / light' },
  { key: 'coach', label: 'Balanced' },
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
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const [mode, setMode] = useState<ConversationMode>('natural');
  /**
   * The topic DRAFT the learner is typing. It is deliberately NOT the identity of
   * the composed conversation: a draft never replaces a conversation by itself
   * (that per-keystroke replacement is what produced "this conversation was
   * replaced before the turn finished").
   */
  const [topic, setTopic] = useState<string>('');
  /** The topic the ACTIVE conversation was really composed with. */
  const [appliedTopic, setAppliedTopic] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastFeedback, setLastFeedback] = useState<ConversationFeedback | null>(null);
  const [savedWords, setSavedWords] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /**
   * The learner's OWN message of a typed turn that did NOT commit. Preserved so an
   * explicit Retry resends exactly that text (never a re-typed guess) and so it can
   * never be committed twice.
   */
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  /**
   * Resolved provider identity. `null` until the composition settles, so the
   * surface never claims a provider state it has not established yet.
   */
  const [providerKind, setProviderKind] = useState<TalkProviderKind | null>(null);
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
  /** Post-conversation review of the conversation that just ended (or null). */
  const [conversationReview, setConversationReview] = useState<ConversationReview | null>(null);

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

  /* ---------------------------------------------------------------- *
   * Work Order 2 — learner agency state.
   * Help actions are SCREEN state + session-local: no help path may ever
   * submit a learner turn, create evidence, or disturb the WO1 lifecycle.
   * ---------------------------------------------------------------- */
  /** The provider help reply currently shown in the help panel (streamed). */
  const [helpText, setHelpText] = useState<string | null>(null);
  /** The help action currently running (drives chip busy state). */
  const [activeHelpAction, setActiveHelpAction] = useState<HelpActionId | null>(null);
  /** Friendly, already-classified help failure text (never raw provider data). */
  const [helpError, setHelpError] = useState<string | null>(null);
  /** Action that can be safely retried after a help failure. */
  const [helpRetryAction, setHelpRetryAction] = useState<HelpActionId | null>(null);
  /** Honest notice shown with the help row (e.g. slower not supported). */
  const [helpNote, setHelpNote] = useState<string | null>(null);
  /** The TEMPORARY "fewer corrections for now" override (never persisted). */
  const [fewerCorrectionsNow, setFewerCorrectionsNow] = useState<boolean>(false);
  /** Explicit "change topic" mode: unlocks the topic draft for a new session. */
  const [topicChangeOpen, setTopicChangeOpen] = useState<boolean>(false);
  /** Items saved to review from this screen (presentation mirror). */
  const [reviewSaves, setReviewSaves] = useState<Record<string, boolean>>({});
  /** Friendly result line for save attempts (success or honest failure). */
  const [reviewSaveNote, setReviewSaveNote] = useState<string | null>(null);
  const [isSavingReview, setIsSavingReview] = useState<boolean>(false);

  /** Synchronous double-tap guard for provider help requests. */
  const helpInFlightRef = useRef<boolean>(false);
  /** Invalidates late help replies when the conversation changes or unmounts. */
  const helpTokenRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  /** Persisted correction intensity (null while unresolved — never guessed). */
  const correctionIntensityRef = useRef<CorrectionIntensity | null>(null);
  const loadedPreferenceRef = useRef<boolean>(false);
  /** Save to Review runs on the SAME adapter as the rest of the screen. */
  const saveServiceRef = useRef<{
    readonly adapter: DatabaseAdapter | null | undefined;
    readonly service: SaveToReviewService;
  } | null>(null);

  const getSaveService = useCallback((): SaveToReviewService => {
    const adapter = coachingRef.current?.databaseAdapter ?? props?.databaseAdapter;
    const current = saveServiceRef.current;
    if (current && current.adapter === adapter) return current.service;
    const service = createSaveToReviewService({ databaseAdapter: adapter ?? undefined });
    saveServiceRef.current = { adapter, service };
    return service;
  }, [props?.databaseAdapter]);

  const getCorrectionPreferences = useCallback(() => {
    return createCorrectionPreferencesService({
      databaseAdapter: coachingRef.current?.databaseAdapter ?? props?.databaseAdapter,
    });
  }, [props?.databaseAdapter]);

  const sessionRef = useRef<ConversationSession | null>(null);
  const voiceCoordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const providerInfoRef = useRef<TalkProviderInfo | null>(null);
  /** In-flight refresh of the persisted coaching context for the live session. */
  const learnerRefreshRef = useRef<Promise<void> | null>(null);
  /** Invalidates in-flight opening attempts when the conversation changes. */
  const openingTokenRef = useRef<number>(0);
  /** Mode+topic identity of the conversation currently composed. */
  const conversationIdentityRef = useRef<string>('');
  /**
   * Committed learner turns observed when the current retryable message failed.
   * A Retry verifies this first: a message that really committed is never sent
   * again, so one tap can never produce two learner turns.
   */
  const retryBaselineRef = useRef<number>(0);
  /** Synchronous in-flight guard for typed sends (a double tap cannot duplicate). */
  const sendInFlightRef = useRef<boolean>(false);
  /** Resolved real coaching composition (persisted learner evidence). */
  const coachingRef = useRef<TalkCoachingResolution | null>(null);
  /** Guards concurrent session switches: only the newest one may install. */
  const switchTokenRef = useRef<number>(0);
  /** Mirror of `isSwitching` for async callbacks that must not re-enter. */
  const coordinatorIsSwitchingRef = useRef<boolean>(false);
  /**
   * Synchronous guard for the mic handler: at most ONE mic action (start or
   * stop) may be in flight, so rapid repeated taps can never open two recorders
   * or submit one utterance twice from the screen side.
   */
  const micActionInFlightRef = useRef<boolean>(false);
  /**
   * ONE queued mic intent for the session-transition race: a tap that arrives
   * while a transition is running is kept here (bound to that transition's
   * switch token) and executed when — and ONLY when — that same transition
   * installs its new session. A newer transition clears it; a stale transition
   * can never consume it.
   */
  const micIntentRef = useRef<MicIntentQueue>(new MicIntentQueue());
  /**
   * Conversation Learning Memory: the recorder owns the stable identity of the
   * ACTIVE conversation, so persistence is exactly-once regardless of rerenders.
   */
  const memoryRecorderRef = useRef<ConversationMemoryRecorder | null>(null);
  /** Real qualitative pronunciation evidence of the active conversation. */
  const pronunciationLinesRef = useRef<readonly string[] | null>(null);
  /** Mirror of `conversationReview !== null` for async callbacks. */
  const reviewOpenRef = useRef<boolean>(false);
  /**
   * Learner-facing conversation memory service (existing SQLite repositories),
   * bound to whichever real adapter is in use so the app never opens a second
   * database connection for conversation memory.
   */
  const memoryServiceRef = useRef<{
    readonly adapter?: DatabaseAdapter;
    readonly service: ConversationMemoryService;
  } | null>(null);
  const getMemoryService = useCallback((): ConversationMemoryService => {
    const adapter = coachingRef.current?.databaseAdapter ?? props?.databaseAdapter;
    const current = memoryServiceRef.current;
    if (current && current.adapter === adapter) {
      return current.service;
    }
    const service = createConversationMemoryService({ databaseAdapter: adapter });
    memoryServiceRef.current = { adapter, service };
    return service;
  }, [props?.databaseAdapter]);
  const pronunciationEngineRef = useRef<PronunciationEngine | null>(
    props?.pronunciationEngine ?? null,
  );
  const scrollViewRef = useRef<ScrollView | null>(null);

  // Work Order 2 — unmount safety for help requests: late provider replies
  // are dropped (the token invalidation + session identity check below), and
  // nothing may write screen state into an unmounted surface.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      helpTokenRef.current += 1;
      helpInFlightRef.current = false;
    };
  }, []);

  /**
   * Work Order 2 — load the persisted correction intensity ONCE when the real
   * coaching composition settles. A stored choice only adopts itself while no
   * conversation is running (a live conversation is never re-composed by a
   * background preference read); the temporary override is never persisted.
   */
  useEffect(() => {
    if (loadedPreferenceRef.current || coachingSource === null) return;
    loadedPreferenceRef.current = true;
    let active = true;
    void (async () => {
      const result = await getCorrectionPreferences().load();
      if (!active) return;
      correctionIntensityRef.current = result.intensity;
      if (result.origin === 'stored') {
        const target = CORRECTION_INTENSITY_TO_MODE[result.intensity];
        setMode((prev) => (prev === target ? prev : target));
      }
    })();
    return () => {
      active = false;
    };
  }, [coachingSource, getCorrectionPreferences]);

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
      const lines = outcome?.feedbackLines?.length ? outcome.feedbackLines : null;
      pronunciationLinesRef.current = lines;
      setPronunciationLines(lines);
      // Real qualitative evidence only: recorded for the post-conversation
      // review, never persisted as a new conversation turn.
      memoryRecorderRef.current?.notePronunciationLines(lines);
    } catch {
      // Non-destructive: pronunciation analysis must never fail the turn.
      pronunciationLinesRef.current = null;
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
   * Finalizes ONE conversation (the session that is being replaced) through the
   * existing conversation repository and derives its qualitative review from
   * real evidence only. Local SQLite, fast, and never destructive: a persistence
   * failure leaves the live conversation untouched and reports honestly.
   */
  const endConversation = useCallback(
    async (
      session: ConversationSession,
      recorder: ConversationMemoryRecorder,
      isRealAI: boolean,
    ): Promise<ConversationReview | null> => {
      try {
        // One tested pipeline: persist exactly once, then derive the review
        // from the persisted evidence (demo is never stored).
        return await finalizeConversationWithReview({
          session,
          recorder,
          isRealAI,
          service: getMemoryService(),
        });
      } catch {
        // Conversation memory must never make New Chat / mode change fail.
        return null;
      }
    },
    [getMemoryService],
  );

  /**
   * The ONE mic-open action, shared by a direct tap and by the execution of a
   * mic intent queued during a session transition. Callers own their own
   * re-entry guards; the coordinator itself enforces every lifecycle rule (at
   * most one recorder start, no start while switching, barge-in ordering).
   */
  const startRecordingTurn = useCallback(
    async (session: ConversationSession, kind: TalkProviderKind): Promise<void> => {
      if (kind === 'unavailable') return;
      const coordinator = getOrCreateVoiceCoordinator(session, kind);
      setErrorMessage(null);
      // Barge-in: the coordinator stops and awaits tutor playback internally
      // before the microphone opens.
      await coordinator.startRecording();
    },
    [getOrCreateVoiceCoordinator],
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
      // A mic intent queued for an EARLIER transition belonged to that
      // transition: this newer one owns the surface now, and the learner's
      // queued tap must never start a recording on a session they moved past.
      micIntentRef.current.clear();
      // The composed identity AND the applied topic are set together, so the
      // identity effect sees one stable identity for this conversation and never
      // composes a second one for the same mode+topic.
      conversationIdentityRef.current = `${targetMode}::${normalizeTopicDraft(targetTopic)}`;
      setAppliedTopic(normalizeTopicDraft(targetTopic));
      setIsOpening(false);
      setIsSwitching(true);
      coordinatorIsSwitchingRef.current = true;

      // CONVERSATION LEARNING MEMORY: capture the outgoing conversation BEFORE
      // the replacement begins. Its memory snapshot is taken only AFTER the
      // atomic switch has abandoned it (see replaceConversationWithMemory), so
      // in-flight STT/AI work of the old conversation can never enter memory.
      const outgoingSession = sessionRef.current;
      const outgoingRecorder = memoryRecorderRef.current;
      const outgoingIsRealAI = providerInfoRef.current?.isRealAI ?? false;

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
      // ATOMIC replacement ordered for memory integrity:
      //   abandon + invalidate the OLD session -> await recorder/TTS teardown ->
      //   finalize the OLD conversation from its now-stable committed history ->
      //   derive its review. The replacement is activated by this screen only
      //   afterwards, so review generation can never corrupt it.
      const outcome = await replaceConversationWithMemory({
        nextSession: bundle.session,
        service: getMemoryService(),
        outgoing:
          outgoingSession && outgoingRecorder
            ? {
                session: outgoingSession,
                recorder: outgoingRecorder,
                isRealAI: outgoingIsRealAI,
              }
            : null,
        ...(coordinator
          ? { switchSession: (next: ConversationSession) => coordinator.switchSession(next) }
          : {}),
      });
      if (!outcome.installed) {
        // Superseded (or the screen was disposed): the newer operation owns the
        // coordinator and will settle the switch state itself. Nothing is
        // installed here — no session UI, no Conversation Review — and a queued
        // mic intent can never execute into a session that was not activated.
        micIntentRef.current.clear();
        return null;
      }

      // SWITCH-TOKEN REVALIDATION runs BEFORE anything is installed. A
      // superseded transition must never open the Conversation Review, replace
      // the current session UI, or consume a mic intent: the newer switch owns
      // the switch flag and will clear it when it settles.
      if (switchToken !== switchTokenRef.current) {
        return null;
      }

      if (!coordinator) {
        getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
      }
      if (outcome.review && outcome.review.hasEvidence) {
        setConversationReview(outcome.review);
      }

      sessionRef.current = bundle.session;
      providerInfoRef.current = bundle.providerInfo;
      setProviderKind(bundle.providerKind);
      setProviderInfo(bundle.providerInfo);
      // A NEW conversation identity gets its OWN memory recorder, so evidence
      // can never be attributed to the wrong conversation.
      memoryRecorderRef.current = createConversationMemoryRecorder();
      pronunciationLinesRef.current = null;

      setHistory([]);
      setLastFeedback(null);
      setSavedWords({});
      setStreamingText(null);
      // The composer draft is deliberately PRESERVED across a replacement: an
      // uncommitted message belongs to the learner, not to the old conversation,
      // and clearing it here is how typed answers used to vanish.
      setErrorMessage(null);
      setPronunciationLines(null);
      setIsSending(false);
      setIsSwitching(false);
      coordinatorIsSwitchingRef.current = false;
      // Work Order 2: a replaced conversation also ends its help panel, its
      // topic-change draft and its TEMPORARY correction override. The stored
      // preference survives; the "for now" override never crosses a session.
      helpTokenRef.current += 1;
      helpInFlightRef.current = false;
      setHelpText(null);
      setActiveHelpAction(null);
      setHelpError(null);
      setHelpRetryAction(null);
      setHelpNote(null);
      setTopicChangeOpen(false);
      setFewerCorrectionsNow(false);
      setReviewSaves({});
      setReviewSaveNote(null);
      // Re-apply nothing: a fresh session starts on the real chip mode, and any
      // in-flight help for the OLD session is invalidated by the token above.
      bundle.session.setModeOverride?.(null);
      // Only now is the replacement session live: the tutor opening may run.
      setSessionEpoch((prev) => prev + 1);

      // A mic tap that arrived DURING this transition executes now, on the
      // freshly installed session: one intent, one execution. `consume()`
      // only matches THIS switch's token, so a superseded transition can never
      // execute it and a newer transition has already cleared it.
      if (micIntentRef.current.consume(switchToken)) {
        void startRecordingTurn(bundle.session, bundle.providerKind);
      }

      return bundle.session;
    },
    [endConversation, getOrCreateVoiceCoordinator, startRecordingTurn],
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

  /**
   * Composes a fresh conversation when — and ONLY when — the identity rules in
   * src/talk-demo/conversation-identity.ts say so:
   * - the typed topic is a DRAFT (`appliedTopic` is the composed one), so typing
   *   can no longer replace a conversation per keystroke;
   * - nothing is replaced while a learner/tutor turn, a switch or voice work is
   *   unresolved, so an in-flight turn always keeps a stable session identity;
   * - a live conversation (committed history) is replaced only explicitly.
   * The composition itself stays the ONE existing atomic path (startConversation).
   */
  useEffect(() => {
    const voiceBusy =
      voiceStatus.isProcessing === true ||
      voiceStatus.state === 'recording' ||
      voiceStatus.state === 'transcribing' ||
      voiceStatus.state === 'sending' ||
      voiceStatus.state === 'requesting_permission';
    const decision = resolveConversationIdentity({
      mode,
      appliedTopic,
      composedIdentity:
        conversationIdentityRef.current.length > 0 ? conversationIdentityRef.current : null,
      historyLength: history.length,
      turnInFlight: isSending || isOpening || isSwitching || voiceBusy,
      // Still resolving the REAL persisted coaching context: composing now would
      // silently fall back to the demo learner model.
      coachingResolved: coachingSource !== null,
    });
    if (decision.action === 'compose') {
      void startConversation(mode, appliedTopic);
    }
  }, [
    appliedTopic,
    coachingSource,
    history.length,
    isOpening,
    isSending,
    isSwitching,
    mode,
    startConversation,
    voiceStatus.isProcessing,
    voiceStatus.state,
  ]);

  // Work Order 2: "Change topic" explicitly unlocks the topic DRAFT mid-run —
  // it still takes effect only through the one Apply path below (the Work
  // Order 1 rule "a draft never replaces a conversation per keystroke" stays).
  const topicEditable =
    (history.length === 0 || topicChangeOpen) && !isSending && !isOpening && !isSwitching;
  /** True while the typed topic differs from the conversation it would start. */
  const topicDraftPending =
    topicEditable && hasUnappliedTopicDraft(topic, appliedTopic);

  /**
   * Explicit Apply: the learner decides when a typed topic becomes a conversation.
   * This is the preferred path (draft topic + explicit Start/Apply) and the reason
   * an in-flight turn is never replaced by typing.
   */
  const handleApplyTopic = () => {
    const draft = normalizeTopicDraft(topic);
    if (!hasUnappliedTopicDraft(draft, appliedTopic)) return;
    if (isSending || isOpening || isSwitching) return; // never replace mid-turn
    setTopicChangeOpen(false);
    setAppliedTopic(draft);
    void startConversation(mode, draft);
  };

  /** Cancel an opened topic change: the live conversation stays exactly as it is. */
  const handleCancelTopicChange = () => {
    setTopicChangeOpen(false);
  };

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
        if (
          openingText.trim().length > 0 &&
          coordinator &&
          !coordinator.getStatus().isMuted &&
          // Never talk over the post-conversation review.
          !reviewOpenRef.current
        ) {
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
  // any playback, and discards late voice results. A conversation that already
  // holds committed learner turns is finalized (best effort, exactly once) so
  // leaving Talk does not lose real learning memory. Empty/demo conversations
  // are never stored.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      const recorder = memoryRecorderRef.current;
      const isRealAI = providerInfoRef.current?.isRealAI ?? false;
      // Leaving Talk is terminal: the ACTIVE session must stop accepting work
      // IMMEDIATELY. dispose() enforces this synchronously (it abandons the
      // active session before its first await) and only then stops the recorder
      // and playback, so an AI/STT result resolving during teardown can never
      // commit a stale turn, feedback or vocabulary into a dead conversation.
      const disposed = voiceCoordinatorRef.current?.dispose() ?? Promise.resolve();
      // Belt-and-braces (idempotent) for the no-coordinator path: no voice work
      // ever started, but a typed turn could still be in flight.
      session?.abandon?.();
      if (session && recorder && recorder.hasCommittedLearnerTurn(session)) {
        void disposed.then(() => {
          // Recording and playback are stopped: only now is the committed
          // history stable enough to snapshot and finalize it.
          void endConversation(session, recorder, isRealAI);
        });
      }
    };
  }, [endConversation]);

  // Record feedback evidence in background.
  //
  // Ownership is deliberately split:
  // - Conversation Learning Memory only ACCUMULATES the committed feedback for the
  //   post-conversation review (no weakness/review mutation here).
  // - The EXISTING LearningPersistenceService remains the single owner of
  //   weakness/mistake/review mutation, so a correction is never counted twice.
  // - Offline demo tutoring is never written into real learner memory.
  useEffect(() => {
    if (!lastFeedback) return;
    memoryRecorderRef.current?.noteFeedback(lastFeedback);
    // Real learner memory only: providerInfoRef is the live provider identity.
    if (!(providerInfoRef.current?.isRealAI ?? false)) return;
    const learningPersistence = createLearningPersistenceService(
      coachingRef.current?.databaseAdapter,
    );
    learningPersistence.recordFeedbackEvidence(lastFeedback).catch((err) => {
      console.error('Failed to persist learning feedback:', err);
    });
  }, [lastFeedback, providerInfo]);

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
    // A new conversation also ends the temporary override and any help panel.
    setFewerCorrectionsNow(false);
    helpTokenRef.current += 1;
    helpInFlightRef.current = false;
    setHelpText(null);
    setHelpError(null);
    setHelpRetryAction(null);
    setHelpNote(null);
    // Work Order 2 — the chip IS the persisted correction-intensity choice:
    // store it through the existing profile preferences (best effort: a storage
    // failure never blocks the conversation, and nothing here is invented).
    const intensity = MODE_TO_CORRECTION_INTENSITY[newMode];
    correctionIntensityRef.current = intensity;
    void getCorrectionPreferences()
      .save(intensity)
      .catch(() => undefined);
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

  // Handle save vocabulary item (existing session save path is preserved).
  const handleSaveVocabulary = async (vocab: ConversationFeedbackVocabulary) => {
    if (!sessionRef.current || !vocab.headword) return;
    const saved = await sessionRef.current.saveVocabularyItem(vocab);
    if (saved) {
      setSavedWords((prev) => ({ ...prev, [vocab.headword.toLowerCase()]: true }));
    }
  };

  /**
   * Work Order 2 — Save to Review for ANY language item from this surface.
   * Independent of tutor-detected mistakes: a correctly-answered word can be
   * saved, and saving only means "I want to learn/review this" (the reusable
   * service enforces the no-evidence rules at its own boundary).
   */
  const handleSaveToReview = async (input: {
    readonly text: string;
    readonly itemType: VocabularyCategory;
    readonly meaning?: string;
    readonly example?: string;
  }): Promise<void> => {
    if (!input || input.text.trim().length === 0) return;
    if (isSavingReview) return; // double-tap protection
    setIsSavingReview(true);
    setReviewSaveNote(null);
    try {
      const service = getSaveService();
      const result = await service.save({
        // Talk resolves the single learner profile inside the service.
        learnerId: '',
        text: input.text.trim(),
        itemType: input.itemType,
        origin: 'talk',
        ...(input.meaning ? { selectedMeaning: input.meaning } : {}),
        ...(input.example ? { example: input.example } : {}),
        contextSentence: sessionRef.current?.getHistory().at(-1)?.content,
        // Tutor wording on this surface is provider language: mark it.
        meaningIsGenerated: true,
      });
      if (result.ok) {
        const key = input.text.trim().toLowerCase();
        setReviewSaves((prev) => ({ ...prev, [key]: true }));
        setReviewSaveNote(
          result.reason === 'already_saved'
            ? 'Already in your Review list — nothing was duplicated.'
            : result.reviewQueued
            ? 'Saved to Review. It waits there for practice; it is not marked learned.'
            : 'Saved. Review scheduling is unavailable right now, but the item is kept.',
        );
      } else if (result.reason === 'no_profile') {
        setReviewSaveNote('Saving needs a learning profile. Set one up in Talk and try again.');
      } else {
        setReviewSaveNote('Could not save this right now. Nothing was changed — please try again.');
      }
    } finally {
      setIsSavingReview(false);
    }
  };

  /**
   * Work Order 2 — the temporary "fewer corrections for now" control.
   *
   * It NEVER changes the composed conversation identity (no session is
   * recreated mid-conversation) and NEVER persists: it only sets the live
   * session's local mode override to the existing light-correction behavior
   * for subsequent turns. Turning it off restores the chosen chip mode.
   */
  const handleToggleFewerCorrections = () => {
    const next = !fewerCorrectionsNow;
    setFewerCorrectionsNow(next);
    const intensity =
      correctionIntensityRef.current ?? MODE_TO_CORRECTION_INTENSITY[mode];
    const effective = resolveEffectiveConversationMode(
      intensity,
      next ? TEMPORARY_FEWER_CORRECTIONS : null,
    );
    sessionRef.current?.setModeOverride?.(effective === mode ? null : effective);
  };

  /**
   * Work Order 2 — learner help action over the conversation.
   *
   * Every provider-backed help goes through the session's assistance path:
   * the hidden instruction never becomes a learner turn, the tutor's reply is
   * appended as a tutor turn only, feedback/weakness persistence is never
   * reached, and a reply that lands after the learner answered or after the
   * conversation was replaced is DISCARDED, never applied.
   */
  const handleHelpAction = useCallback(
    async (action: HelpActionId): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;
      if (action === 'change_topic') {
        setTopicChangeOpen(true);
        return;
      }
      if (action === 'repeat') {
        // Replay ONLY — never a new attempt.
        if (voiceCoordinatorRef.current) {
          await voiceCoordinatorRef.current.replayLastResponse();
        }
        return;
      }
      if (action === 'slower') {
        const provider = voiceCoordinatorRef.current?.getPlaybackProvider();
        const capability = resolveSpeechRateCapability(provider);
        const plan = planSpeechRate('slower', capability);
        setHelpNote(plan.rate === null ? plan.note : null);
        if (voiceCoordinatorRef.current) {
          await voiceCoordinatorRef.current.replayLastResponse(speechRateTTSOptions(plan));
        }
        return;
      }
      if (!isProviderHelpAction(action) || !helpActionIsEvidenceSafe(action)) return;
      if (helpInFlightRef.current || isSending || isSwitching || isOpening) return;
      if (providerKind === null || providerKind === 'unavailable') {
        setHelpError(
          'Help needs a configured tutor. Add a key in Settings — nothing scripted is invented in its place.',
        );
        return;
      }

      const boundSession = session;
      // A conversation closed underneath this surface (background policy)
      // cannot host help: the learner is told the truth instead of having a
      // session silently regenerated by a help tap.
      if (!isConversationReusable(boundSession)) {
        setHelpNote(TALK_CONVERSATION_RESTARTED_MESSAGE);
        return;
      }
      // Help NEVER falls back to `send`: sending the hidden instruction as a
      // learner message would fabricate a learner turn. Without the
      // assistance path, help is simply unavailable here.
      if (typeof boundSession.requestAssistance !== 'function') {
        setHelpNote('Help is unavailable for this conversation. Start a new chat to try again.');
        return;
      }

      helpInFlightRef.current = true;
      const token = (helpTokenRef.current += 1);
      setActiveHelpAction(action);
      setHelpError(null);
      setHelpRetryAction(null);
      setHelpNote(null);
      setHelpText('');
      try {
        const result = await boundSession.requestAssistance!({
          userMessage: buildHelpInstruction(action, appliedTopic || null),
        });
        // Stale guards: same token AND the same live session. A replaced
        // conversation must never receive the late help.
        if (
          !mountedRef.current ||
          helpTokenRef.current !== token ||
          sessionRef.current !== boundSession
        ) {
          return;
        }
        if (!result.ok) {
          setHelpText(null);
          if (result.error.code === 'cancelled') {
            // The learner's own turn won the race: say nothing, change nothing.
            return;
          }
          const safe = learnerMessageForFailure(result.error, 'tutor');
          setHelpError(safe);
          if (result.error.retryable === true) setHelpRetryAction(action);
          return;
        }
        // Keep the visible transcript aligned with the session (tutor-only add)
        // and CLEAR any previous feedback card: help is not correction context.
        setHistory(boundSession.getHistory());
        setLastFeedback(null);
        // The help reply now lives in the conversation as a tutor turn; close
        // the panel's busy state instead of duplicating the same text.
        setHelpText(null);
      } catch (err: unknown) {
        if (!mountedRef.current || helpTokenRef.current !== token) return;
        const safe = learnerMessageForFailure(
          err instanceof Error ? { message: err.message } : null,
          'tutor',
        );
        setHelpText(null);
        setHelpError(safe);
        setHelpRetryAction(action);
        if (err instanceof Error) console.error('Talk help action failed:', err.message);
      } finally {
        if (helpTokenRef.current === token) {
          helpInFlightRef.current = false;
          setActiveHelpAction((prev) => (prev === action ? null : prev));
        }
      }
    },
    [appliedTopic, isSending, isSwitching, isOpening, providerKind],
  );

  /** Retry uses the SAME one-shot rules; it cannot run twice at once. */
  const handleRetryHelp = useCallback((): void => {
    if (!helpRetryAction) return;
    void handleHelpAction(helpRetryAction);
  }, [handleHelpAction, helpRetryAction]);

  const dismissHelpPanel = useCallback((): void => {
    helpTokenRef.current += 1; // an in-flight help is dropped, not applied late
    helpInFlightRef.current = false;
    setHelpText(null);
    setHelpError(null);
    setHelpRetryAction(null);
    setHelpNote(null);
    setActiveHelpAction(null);
  }, []);

  // Handle microphone press — the single primary action of a turn.
  const handleToggleRecording = async () => {
    // Rapid-tap protection: at most ONE mic action (start or stop) at a time,
    // so repeated taps can never open two recorders or submit one utterance
    // twice from the screen side.
    if (micActionInFlightRef.current) return;
    // SYNCHRONOUS transition guard. `coordinatorIsSwitchingRef` is the
    // authoritative mirror of `isSwitching`, set and cleared inside the same
    // synchronous steps of startConversation — unlike the React state it can
    // never be stale inside this handler. A tap during an active transition
    // queues exactly ONE mic intent (bound to that transition's switch token)
    // which executes when the transition installs its new session; it is never
    // lost, never doubled, and never run against the outgoing session.
    if (coordinatorIsSwitchingRef.current) {
      micIntentRef.current.queue(switchTokenRef.current);
      setErrorMessage(TALK_MIC_QUEUED_MESSAGE);
      return;
    }
    if (isOpening || isSending) {
      // The tutor is opening the conversation / composing a reply: nothing to
      // record yet. The learner stays in control once the turn completes.
      return;
    }
    if (providerKind === null || providerKind === 'unavailable') {
      // The provider identity is not established yet, or nothing is configured:
      // no turn may start, and no reply can exist.
      return;
    }
    // No active conversation yet (still preparing): nothing to do.
    let session = sessionRef.current;
    if (!session) return;

    micActionInFlightRef.current = true;
    try {
      // DEAD-SESSION RECOVERY: the conversation on screen may have been closed
      // underneath this surface (the background policy abandons the active
      // session). Recording into it could only produce a discarded turn, so a fresh
      // conversation with the SAME identity is composed first and the learner is
      // told plainly what happened — nothing is silently reset.
      if (!isConversationReusable(session)) {
        const recovered = await startConversation(mode, appliedTopic);
        if (!recovered) {
          setErrorMessage(TALK_CONVERSATION_RESTARTED_MIC_MESSAGE);
          return;
        }
        session = recovered;
        setErrorMessage(TALK_CONVERSATION_RESTARTED_MIC_MESSAGE);
      }
      const coordinator = getOrCreateVoiceCoordinator(session, providerKind);
      // The branch decision reads the coordinator's LIVE status, not the
      // possibly-stale React mirror: after any await above, only the
      // coordinator knows whether a recording is really active.
      const status = coordinator.getStatus();

      if (status.state === 'recording') {
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
          // Already ONE classified learner-safe sentence; the raw provider detail
          // stays in the logs and the preserved transcript/recording drives the
          // recovery actions rendered below.
          if (res.technical) console.error('Talk voice turn failure:', res.technical);
          setErrorMessage(res.error);
          return;
        }

        // Analyze pronunciation once per spoken turn (never blocks the flow).
        await runPronunciationAnalysis();
      } else if (status.canRecord) {
        await startRecordingTurn(session, providerKind);
      }
    } finally {
      micActionInFlightRef.current = false;
    }
  };

  /**
   * Explicit learner Retry of a PRESERVED voice transcript (Work Order 1, item 6):
   * the learner's own words are sent again without re-recording, through the SAME
   * coordinator path, so the turn either commits exactly once or fails honestly
   * again with the transcript still preserved.
   */
  const handleRetryVoiceTurn = async () => {
    const coordinator = voiceCoordinatorRef.current;
    const session = sessionRef.current;
    if (!coordinator || !session || isSending || isSwitching || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setIsSending(true);
    setStreamingText('');
    setErrorMessage(null);
    try {
      const res = await coordinator.retryPendingTurn((chunk: string) => {
        setStreamingText((prev) => (prev ?? '') + chunk);
      });
      // A late result from a replaced session must never touch the new one.
      if (sessionRef.current !== session) return;
      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());
      if (!res.ok) {
        if (res.technical) console.error('Talk voice retry failure:', res.technical);
        if (res.error) setErrorMessage(res.error);
        return;
      }
      await runPronunciationAnalysis();
    } finally {
      setIsSending(false);
      setStreamingText(null);
      sendInFlightRef.current = false;
    }
  };

  /**
   * Explicit learner Retry of a PRESERVED RECORDING after a failed transcription:
   * the same audio is transcribed again, so the learner never has to speak twice,
   * and nothing is fabricated when it fails again.
   */
  const handleRetryTranscription = async () => {
    const coordinator = voiceCoordinatorRef.current;
    const session = sessionRef.current;
    if (!coordinator || !session || isSending || isSwitching || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setIsSending(true);
    setStreamingText('');
    setErrorMessage(null);
    try {
      const res = await coordinator.retryTranscription((chunk: string) => {
        setStreamingText((prev) => (prev ?? '') + chunk);
      });
      if (sessionRef.current !== session) return;
      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());
      if (!res.ok) {
        if (res.technical) console.error('Talk transcription retry failure:', res.technical);
        if (res.error) setErrorMessage(res.error);
        return;
      }
      await runPronunciationAnalysis();
    } finally {
      setIsSending(false);
      setStreamingText(null);
      sendInFlightRef.current = false;
    }
  };

  /**
   * "Type instead": the preserved transcript moves into the composer so the
   * learner can review and edit it before sending. Taking it clears the
   * coordinator's preserved turn, so the same utterance can never be sent twice.
   */
  const handleUseTranscriptAsText = () => {
    const coordinator = voiceCoordinatorRef.current;
    if (!coordinator) return;
    const transcript = coordinator.takePendingTranscript();
    if (!transcript) return;
    setErrorMessage(null);
    setInputText(transcript);
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

  /**
   * Sends ONE typed learner message through the EXISTING conversation session.
   *
   * Reliability contract (Work Order 1):
   * - the composer is cleared only once the turn is really dispatched, and the
   *   learner's EXACT text is restored on every path that does not commit it
   *   (including the paths that used to return early and lose it);
   * - a failure shows ONE classified learner-safe sentence — never a raw provider
   *   payload, stack trace or quota object — and preserves the message so an
   *   explicit Retry resends exactly that text;
   * - a conversation that was closed underneath this surface is detected BEFORE
   *   the turn starts and recovered with the SAME identity, so the learner no
   *   longer reads "this conversation was replaced before the turn finished";
   * - a repeated tap can never commit the same message twice (synchronous
   *   in-flight guard, plus a committed-turn check before any replay).
   */
  const sendLearnerMessage = useCallback(
    async (rawMessage: string): Promise<void> => {
      const trimmedMessage = rawMessage.trim();
      if (!trimmedMessage) return;
      // Synchronous guards FIRST: nothing is mutated before them, so an early
      // return can never leave the surface stuck in "sending" or lose the draft.
      if (sendInFlightRef.current || isSending || isSwitching) return;
      if (!voiceStatus.canSendText) return;
      if (providerKind === null || providerKind === 'unavailable') {
        // No provider is configured (or not yet established): a message must not
        // be sent into nothing.
        return;
      }

      let session = sessionRef.current;
      if (!session) return;

      sendInFlightRef.current = true;
      /** Calm notice kept when a closed conversation had to be replaced first. */
      let restartNotice: string | null = null;
      try {
        // DEAD-SESSION RECOVERY: the conversation this surface still shows may
        // have been closed underneath it (the background policy abandons the
        // active session). A turn sent into it could only be discarded, so a
        // fresh conversation with the SAME identity is composed first and the
        // learner keeps their message.
        if (!isConversationReusable(session)) {
          const recovered = await startConversation(mode, appliedTopic);
          if (!recovered) {
            setInputText(trimmedMessage);
            setErrorMessage(TALK_CONVERSATION_RESTARTED_MESSAGE);
            return;
          }
          session = recovered;
          restartNotice = TALK_CONVERSATION_RESTARTED_MESSAGE;
          setInputText(trimmedMessage);
        }

        if (voiceCoordinatorRef.current) {
          await voiceCoordinatorRef.current.stopSpeaking();
        }

        setIsSending(true);
        setErrorMessage(null);
        setInputText('');
        setStreamingText('');
        // Commit state observed BEFORE the turn: an explicit Retry verifies
        // against it, so a message that really landed is never sent twice.
        retryBaselineRef.current = countCommittedLearnerTurns(session);
        setRetryMessage(null);

        // Optimistically add user message to history
        const userTurn: ConversationTurn = { role: 'user', content: trimmedMessage };
        setHistory((prev) => [...prev, userTurn]);

        await ensureLearnerContext();
        // Never race the tutor opening: it must finish or be invalidated first.
        if (isOpening) {
          setInputText(trimmedMessage);
          if (restartNotice) setErrorMessage(restartNotice);
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
        // That turn never committed, so the learner's text comes back.
        if (sessionRef.current !== session) {
          setInputText(trimmedMessage);
          setRetryMessage(null);
          setErrorMessage(
            result.ok ? restartNotice : learnerMessageForFailure(result.error, 'tutor'),
          );
          return;
        }

        setHistory(session.getHistory());
        setLastFeedback(session.getLastFeedback());

        if (!result.ok) {
          // The turn was not accepted: nothing was added to the conversation, so
          // the learner keeps their text, reads one safe sentence and gets an
          // explicit Retry.
          setHistory(session.getHistory());
          setInputText(trimmedMessage);
          setRetryMessage(trimmedMessage);
          const learnerMessage = learnerMessageForFailure(result.error, 'tutor');
          setErrorMessage(learnerMessage);
          if (result.error?.message && result.error.message !== learnerMessage) {
            // Raw provider detail is diagnostic only: it is never rendered.
            console.error('Talk turn failure:', result.error.message);
          }
          return;
        }

        if (restartNotice) setErrorMessage(restartNotice);
      } catch (err: unknown) {
        const current = sessionRef.current;
        if (current) {
          setHistory(current.getHistory());
        }
        // An unexpected throw still preserves the learner's own message.
        setInputText(trimmedMessage);
        setRetryMessage(trimmedMessage);
        const learnerMessage = learnerMessageForFailure(
          err instanceof Error ? { message: err.message } : null,
          'tutor',
        );
        setErrorMessage(learnerMessage);
        if (err instanceof Error && err.message !== learnerMessage) {
          console.error('Talk turn threw:', err.message);
        }
      } finally {
        setIsSending(false);
        setStreamingText(null);
        sendInFlightRef.current = false;
      }
    },
    [
      appliedTopic,
      isOpening,
      isSending,
      isSwitching,
      mode,
      providerKind,
      startConversation,
      voiceStatus.canSendText,
    ],
  );

  // Handle send message with streaming (typed)
  const handleSendMessage = () => sendLearnerMessage(inputText);

  /**
   * Explicit learner Retry of a message that did NOT commit. It resends the
   * learner's own preserved text through the SAME path, and first verifies the
   * committed learner-turn count: a message that really landed is shown as
   * committed instead of being sent a second time.
   */
  const handleRetryMessage = async () => {
    const message = retryMessage;
    if (!message || isSending || isSwitching || sendInFlightRef.current) return;
    const session = sessionRef.current;
    if (session && countCommittedLearnerTurns(session) > retryBaselineRef.current) {
      // The turn really committed after all: report the truth, resend nothing.
      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());
      setRetryMessage(null);
      setErrorMessage(null);
      return;
    }
    setRetryMessage(null);
    await sendLearnerMessage(message);
  };

  reviewOpenRef.current = conversationReview !== null;

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
  const isGemini = providerKind === 'gemini';
  const isRealAI = providerInfo?.isRealAI ?? isGemini;
  /**
   * EXPLICIT Demo Mode only. There is no automatic Demo fallback, so this is
   * true only when the learner/caller actually asked for the offline script.
   */
  const isOfflineDemo = providerKind === 'demo';
  /**
   * Nothing is configured and Demo Mode was not chosen: no tutor reply can be
   * generated at all. The surface must say so and must not start a turn.
   */
  const isProviderUnavailable = providerKind === 'unavailable';
  const providerLabel =
    providerInfo?.label ??
    (providerKind === null
      ? 'Checking provider…'
      : isGemini
      ? 'Gemini • Online'
      : isOfflineDemo
      ? 'Demo Mode • Not real AI'
      : 'Real AI unavailable • Configuration required');
  const isSendDisabled = turnControls.sendDisabled || isProviderUnavailable;

  // Work Order 2 — one place decides when help actions may run (pure, tested
  // in src/learner-agency): never concurrently with a learner/tutor turn or a
  // session switch, and never against a closed conversation.
  const voiceBusyForHelp =
    voiceStatus.isProcessing === true ||
    voiceStatus.state === 'recording' ||
    voiceStatus.state === 'transcribing' ||
    voiceStatus.state === 'requesting_permission';
  const hasLastTutorText = history.some((turn) => turn.role === 'assistant' && turn.content.trim().length > 0);
  const helpControls = resolveHelpControls({
    helpInFlight: activeHelpAction !== null,
    turnInFlight: isSending || isOpening || voiceBusyForHelp,
    isSwitching,
    providerAvailable: providerKind === 'gemini' || providerKind === 'demo',
    hasLastTutorText,
    sessionActive: sessionRef.current !== null,
  });

  // Learner-facing turn phase, derived from the EXISTING voice status model.
  const turnView = describeVoiceTurn(voiceStatus, isSending || isOpening);
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

        <TextInput accessibilityLabel="Conversation topic"
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
          A typed topic is a DRAFT: the learner applies it explicitly. This is what
          stops per-keystroke conversation replacement (and the "conversation was
          replaced before the turn finished" failure it caused).
        */}
        {topicDraftPending && (
          <TouchableOpacity
            style={styles.topicApplyButton}
            onPress={handleApplyTopic}
            accessibilityRole="button"
            accessibilityLabel="Start the conversation with this topic"
          >
            <Text style={styles.topicApplyButtonText}>
              {topicChangeOpen ? 'Start a new chat with this topic' : 'Start with this topic'}
            </Text>
          </TouchableOpacity>
        )}
        {topicChangeOpen && history.length > 0 && (
          <TouchableOpacity
            style={styles.topicApplyButton}
            onPress={handleCancelTopicChange}
            accessibilityRole="button"
            accessibilityLabel="Keep the current conversation and close the topic change"
          >
            <Text style={styles.topicApplyButtonText}>Keep this conversation</Text>
          </TouchableOpacity>
        )}

        {/*
          Work Order 2 — learner agency row. REAL actions only:
          provider-backed help goes through the conversation's non-committing
          assistance path; Repeat/Slower are playback; Change topic opens the
          explicit draft flow. None of them can submit a learner answer or
          create evidence.
        */}
        <View style={styles.helpRow} testID="learner-help-row">
          {HELP_ACTION_DESCRIPTORS.map((descriptor) => {
            const isProvider = isProviderHelpAction(descriptor.id);
            const disabled = descriptor.id === 'change_topic'
              ? !helpControls.changeTopicEnabled
              : descriptor.kind === 'playback'
              ? !helpControls.playbackEnabled
              : isProvider
              ? !helpControls.providerActionsEnabled
              : !helpControls.changeTopicEnabled;
            const busy = activeHelpAction === descriptor.id;
            return (
              <TouchableOpacity
                key={descriptor.id}
                style={[styles.helpChip, disabled && styles.helpChipDisabled]}
                onPress={() => void handleHelpAction(descriptor.id)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={descriptor.accessibilityLabel}
                accessibilityState={{ disabled, busy }}
              >
                <Text style={[styles.helpChipText, disabled && styles.helpChipTextDisabled]}>
                  {busy ? '…' : descriptor.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {/* Temporary, session-only correction relief (never persisted). */}
        <TouchableOpacity
          style={[styles.fewerCorrectionsChip, fewerCorrectionsNow && styles.fewerCorrectionsChipActive]}
          onPress={handleToggleFewerCorrections}
          accessibilityRole="button"
          accessibilityState={{ selected: fewerCorrectionsNow }}
          accessibilityLabel="Fewer corrections for now (this conversation only)"
        >
          <Text style={styles.fewerCorrectionsText}>
            {fewerCorrectionsNow ? '✓ Fewer corrections for now' : 'Fewer corrections for now'}
          </Text>
        </TouchableOpacity>

        {/*
          Provider honesty. Two distinct states, neither of which is ever
          substituted for the other:
          - no provider configured and Demo not chosen → configuration required,
            with no tutor reply of any kind;
          - explicit Demo Mode → the offline script, labelled as not real AI.
          The notice stays visible for the whole conversation.
        */}
        {isProviderUnavailable && (
          <View style={styles.offlineNotice}>
            <Text style={styles.offlineNoticeText}>{TALK_CONFIGURATION_REQUIRED_MESSAGE}</Text>
            <TouchableOpacity
              style={styles.offlineNoticeAction}
              onPress={() => navigation.navigate('Settings')}
              accessibilityRole="button"
              accessibilityLabel="Open Settings to configure a provider"
            >
              <Text style={styles.offlineNoticeActionText}>Open provider settings</Text>
            </TouchableOpacity>
          </View>
        )}
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
                {isProviderUnavailable
                  ? 'Real AI is not configured'
                  : isOfflineDemo
                  ? 'Offline demo conversation'
                  : 'Your tutor will start'}
              </Text>
            )}
            <Text style={styles.emptyStateDescription}>
              {isPreparing
                ? 'Preparing your tutor with your saved level, weaknesses, vocabulary and progress before the conversation begins.'
                : isProviderUnavailable
                ? 'No AI provider is configured, so this conversation cannot generate tutor replies. Add an API key in Settings — nothing scripted or demo is substituted for a real tutor.'
                : isOfflineDemo
                ? 'You chose Demo Mode, so replies come from the offline demo script. You can still try the flow, but nothing here is real AI conversation or personalized feedback.'
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
                      {/* Work Order 2 — honest slower replay (playback only,
                          never an attempt; degrades with a visible note when
                          the provider cannot change speed). */}
                      <TouchableOpacity
                        style={styles.replayButton}
                        onPress={() => void handleHelpAction('slower')}
                        accessibilityLabel="Replay the tutor message more slowly"
                        accessibilityRole="button"
                      >
                        <Text style={styles.replayButtonText}>🐢 Slower</Text>
                      </TouchableOpacity>
                      {/* Work Order 2 — universal manual save of the tutor's
                          example sentence, valid whatever the learner answered. */}
                      <TouchableOpacity
                        style={[
                          styles.replayButton,
                          reviewSaves[`bubble-${index}`] && styles.saveVocabButtonSaved,
                        ]}
                        onPress={() =>
                          void (async () => {
                            const sentences = turn.content
                              .split(/(?<=[.!?])\s+/)
                              .map((part) => part.trim())
                              .filter((part) => part.length > 0);
                            const first = sentences[0] ?? turn.content.trim();
                            if (!first) return;
                            await handleSaveToReview({ text: first, itemType: 'sentence' });
                            setReviewSaves((prev) => ({ ...prev, [`bubble-${index}`]: true }));
                          })()
                        }
                        disabled={isSavingReview}
                        accessibilityLabel="Save this sentence to Review"
                        accessibilityRole="button"
                      >
                        <Text style={styles.replayButtonText}>
                          {reviewSaves[`bubble-${index}`] ? '✓ In Review' : '＋ Save to Review'}
                        </Text>
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
                            onPress={() => {
                              const vocab = lastFeedback.vocabulary;
                              if (!vocab) return;
                              // Work Order 2: the learner's tap is a MANUAL save
                              // through the one reusable service (it marks
                              // "Saved by me" and queues Review without touching
                              // any mastery/evidence state). The existing
                              // session-save path stays for in-memory mirroring.
                              void handleSaveToReview({
                                text: vocab.headword,
                                itemType: vocab.type,
                                meaning: vocab.meaning,
                                example: vocab.example,
                              });
                              void handleSaveVocabulary(vocab);
                            }}
                            accessibilityLabel="Save this word to Review"
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

        {/* ---------------------------------------------------------- *
         * Work Order 2 — learner help panel (evidence-free assistance).
         * Busy state, honest failure sentence, learner-safe retry, and a
         * visible dismiss. Nothing here can submit a learner answer.
         * ---------------------------------------------------------- */}
        {(activeHelpAction !== null || helpText !== null || helpError !== null || helpNote !== null) && (
          <View style={styles.helpCard} testID="learner-help-panel" accessibilityLiveRegion="polite">
            <Text style={styles.helpCardTitle}>
              {activeHelpAction
                ? 'Your tutor is helping…'
                : helpError
                ? 'Help did not arrive'
                : helpNote
                ? 'Playback note'
                : 'Tutor help'}
            </Text>
            {helpText !== null && helpText.length === 0 && activeHelpAction !== null && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color="#2563EB" />
                <Text style={styles.loadingText}>
                  {activeHelpAction === 'dont_know'
                    ? 'The tutor is preparing a small clue for you…'
                    : activeHelpAction === 'skip'
                    ? 'The tutor is preparing the next question…'
                    : 'The tutor is preparing help…'}
                </Text>
              </View>
            )}
            {helpText !== null && helpText.length > 0 && (
              <Text style={styles.helpCardText}>{helpText}</Text>
            )}
            {helpError !== null && (
              <View>
                <Text accessibilityRole="alert" style={styles.helpCardError}>
                  {helpError}
                </Text>
                {helpRetryAction !== null && (
                  <TouchableOpacity
                    style={styles.helpCardAction}
                    onPress={handleRetryHelp}
                    accessibilityLabel="Ask the tutor for this help again"
                    accessibilityRole="button"
                  >
                    <Text style={styles.helpCardActionText}>Try again</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            {helpNote !== null && <Text style={styles.helpCardNote}>{helpNote}</Text>}
            <TouchableOpacity
              style={styles.helpCardDismiss}
              onPress={dismissHelpPanel}
              accessibilityLabel="Dismiss the help panel"
              accessibilityRole="button"
            >
              <Text style={styles.helpCardDismissText}>Close</Text>
            </TouchableOpacity>
          </View>
        )}

        {reviewSaveNote !== null && (
          <Text style={styles.reviewSaveNote} testID="review-save-note">
            {reviewSaveNote}
          </Text>
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
            {/*
              Recovery is explicit and matches what really survived:
              - a typed message that did not commit → Retry resends exactly it;
              - a transcript that survived a failed tutor reply → send it again or
                review it as text (never a fabricated transcript);
              - a recording that survived a failed transcription → transcribe the
                SAME audio again instead of speaking twice.
            */}
            {retryMessage ? (
              <TouchableOpacity
                style={styles.errorAction}
                onPress={() => void handleRetryMessage()}
                disabled={isSending || isSwitching}
                accessibilityRole="button"
                accessibilityLabel="Retry sending my message"
              >
                <Text style={styles.errorActionText}>Retry</Text>
              </TouchableOpacity>
            ) : null}
            {voiceStatus.canRetryPendingTurn ? (
              <View style={styles.errorActionRow}>
                <TouchableOpacity
                  style={styles.errorAction}
                  onPress={() => void handleRetryVoiceTurn()}
                  disabled={isSending || isSwitching}
                  accessibilityRole="button"
                  accessibilityLabel="Send my transcribed answer again"
                >
                  <Text style={styles.errorActionText}>Send it again</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.errorAction}
                  onPress={handleUseTranscriptAsText}
                  disabled={isSending || isSwitching}
                  accessibilityRole="button"
                  accessibilityLabel="Type my transcribed answer instead"
                >
                  <Text style={styles.errorActionText}>Type instead</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {voiceStatus.canRetryTranscription ? (
              <TouchableOpacity
                style={styles.errorAction}
                onPress={() => void handleRetryTranscription()}
                disabled={isSending || isSwitching}
                accessibilityRole="button"
                accessibilityLabel="Transcribe my last recording again"
              >
                <Text style={styles.errorActionText}>Try my last recording again</Text>
              </TouchableOpacity>
            ) : null}
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
      {/permission|microphone access/i.test(errorMessage ?? voiceStatus.errorMessage ?? '') ? <MicrophoneHelp /> : null}
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
          disabled={turnControls.micDisabled || isProviderUnavailable}
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

        <TextInput accessibilityLabel="Your reply in English"
          style={[
            styles.composerInput,
            !voiceStatus.canSendText && styles.composerInputDisabled,
          ]}
          placeholder={
            turnPhase === 'recording'
              ? 'Listening to your speech…'
              : turnPhase === 'transcribing'
              ? 'Transcribing audio…'
              : isProviderUnavailable
              ? 'Configure a provider in Settings to talk…'
              : isOfflineDemo
              ? 'Type a message (offline demo, not real AI)…'
              : 'Or type your reply in English…'
          }
          placeholderTextColor="#9CA3AF"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={1000}
          editable={!isSending && !isOpening && voiceStatus.canSendText && !isProviderUnavailable}
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

      {/*
        Post-conversation review: compact, qualitative and evidence-only. It
        never shows a score, mastery or engagement metric, and it never saves
        anything on its own.
      */}
      <Modal
        visible={conversationReview !== null && conversationReview.hasEvidence}
        transparent
        animationType="fade"
        onRequestClose={() => setConversationReview(null)}
      >
        <SafeAreaView style={styles.reviewBackdrop}>
          <View style={styles.reviewCard}>
            <Text style={styles.reviewTitle}>{CONVERSATION_REVIEW_TITLE}</Text>
            <Text style={styles.reviewSubtitle}>
              {conversationReview?.topic
                ? `Topic: ${conversationReview.topic}`
                : `Mode: ${conversationReview?.mode ?? 'natural'}`}
            </Text>
            <Text style={styles.reviewNotice}>{conversationReview?.notice}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.reviewScroll} contentContainerStyle={styles.reviewScrollContent}>
              {(conversationReview?.sections ?? []).map((section) => (
                <View key={section.id} style={styles.reviewSection}>
                  <Text style={styles.reviewSectionTitle}>{section.title}</Text>
                  {section.items.map((item, index) => (
                    <Text key={`${section.id}-${index}`} style={styles.reviewItem}>
                      • {item}
                    </Text>
                  ))}
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.reviewButton}
              onPress={() => setConversationReview(null)}
              accessibilityRole="button"
              accessibilityLabel="Start new conversation"
            >
              <Text style={styles.reviewButtonText}>Start new conversation</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
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
  offlineNoticeAction: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  offlineNoticeActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400E',
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
    color: '#DC2626',
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
    paddingTop: 14,
    paddingBottom: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  headerTextGroup: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.3,
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
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  emptyStateDescription: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  suggestionsContainer: {
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    maxWidth: 320,
  },
  suggestionPill: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  suggestionText: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '600',
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
    borderRadius: 16,
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
    borderColor: '#F3F4F6',
    borderBottomLeftRadius: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
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
    backgroundColor: '#EFF6FF',
    borderColor: '#DBEAFE',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  pronunciationTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
    marginBottom: 4,
  },
  pronunciationLine: {
    fontSize: 13,
    color: '#1F2937',
    lineHeight: 18,
  },
  feedbackContainer: {
    marginTop: 8,
    gap: 8,
    width: '100%',
  },
  feedbackCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
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
    color: '#DC2626',
  },
  /** One explicit recovery action inside the failure notice. */
  errorAction: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  errorActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#DC2626',
  },
  /** Explicit "apply this drafted topic" action (no per-keystroke replacement). */
  topicApplyButton: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  topicApplyButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
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
    borderColor: '#DC2626',
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

  reviewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  reviewCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    maxHeight: '80%',
  },
  reviewTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  reviewSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: '#6B7280',
  },
  reviewNotice: {
    marginTop: 10,
    fontSize: 12,
    color: '#4B5563',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  reviewScroll: {
    marginTop: 12,
  },
  reviewScrollContent: {
    paddingBottom: 6,
  },
  reviewSection: {
    marginBottom: 14,
  },
  reviewSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2563EB',
    marginBottom: 4,
  },
  reviewItem: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
    marginBottom: 2,
  },
  reviewButton: {
    marginTop: 8,
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  reviewButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  // Work Order 2 — minimal, functional controls (no visual redesign).
  helpRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  helpChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  helpChipDisabled: {
    opacity: 0.45,
  },
  helpChipText: {
    fontSize: 12,
    color: '#1F2937',
    fontWeight: '600',
  },
  helpChipTextDisabled: {
    color: '#6B7280',
  },
  fewerCorrectionsChip: {
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  fewerCorrectionsChipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#EFF6FF',
  },
  fewerCorrectionsText: {
    fontSize: 12,
    color: '#334155',
  },
  helpCard: {
    marginVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    padding: 12,
  },
  helpCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1D4ED8',
    marginBottom: 6,
  },
  helpCardText: {
    fontSize: 14,
    color: '#1E3A8A',
    lineHeight: 20,
  },
  helpCardError: {
    fontSize: 14,
    color: '#DC2626',
    lineHeight: 20,
  },
  helpCardNote: {
    fontSize: 12,
    color: '#475569',
    marginTop: 4,
  },
  helpCardAction: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderRadius: 8,
    backgroundColor: '#2563EB',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  helpCardActionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  helpCardDismiss: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  helpCardDismissText: {
    fontSize: 12,
    color: '#1D4ED8',
    textDecorationLine: 'underline',
  },
  reviewSaveNote: {
    fontSize: 12,
    color: '#047857',
    marginTop: 6,
  },
});
