/**
 * src/screens/DeepSpeakingScreen.tsx
 *
 * Deep Speaking Practice / Speaking Coach (Phase 1) screen.
 *
 * PHASES: loading → plan_overview → practicing → finalizing → summary.
 *
 * REUSE CONTRACT (no duplicate systems)
 * - The SpeakingPracticeService owns planning, the conversation stack
 *   (ConversationEngine → ConversationOrchestrator → ConversationSession),
 *   learning persistence and conversation memory.
 * - Voice is the EXISTING stack: `createTalkVoiceCoordinator` over the session
 *   the service returned. Recording is transcribed with
 *   `stopRecordingAndTranscribe()` (never submits a turn itself) and the turn is
 *   submitted through the service, so ONE pipeline owns every learner turn.
 * - The turn controls and the voice lifecycle come from the existing
 *   `resolveTalkTurnControls` / `describeVoiceTurn` helpers — this screen adds no
 *   second state machine.
 *
 * HONESTY RULES
 * - No scores, percentages, XP, stars, streaks or CEFR claims anywhere: the
 *   summary shows real counts and the qualitative sections the service produced.
 * - Feedback is shown ONLY when it is real (a real AI provider produced it). The
 *   offline demo tutor never presents invented corrections, and it says that
 *   nothing is being saved.
 * - The plan overview shows the REAL personalization source reported by the
 *   planner (personalized / partly personalized / general practice).
 *
 * RACE GUARDS (synchronous refs, like TalkScreen/OnboardingScreen)
 * - `startingRef` / `completingRef` / `turnInFlightRef`: one start, one
 *   finalization, one learner turn at a time — refusals happen before any await.
 * - `sessionTokenRef`: a replaced/teardown session's late results never write
 *   into the new one.
 * - `turnTokenRef`: a stale AI/STT result never overwrites a newer turn.
 * - `restartTokenRef`: a "Practise again" started during finalization invalidates
 *   the in-flight summary.
 * - `unmountedRef`: nothing is written after unmount; leaving finalizes the
 *   conversation once (through the service) and disposes the voice work.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import type { ConversationSession, ConversationTurn } from '../conversation-session';
import type { ConversationFeedback } from '../providers/ai';
import type { DailyTutorActivityRef } from '../daily-tutor';
import { reportDailyTutorCompletion } from '../daily-tutor';
import {
  createTalkVoiceCoordinator,
  describeVoiceTurn,
  resolveTalkTurnControls,
  type AudioRecorderService,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
  type VoiceSessionCoordinator,
  type VoiceStatus,
} from '../talk-demo';
import {
  FINISH_BLOCKED_MESSAGE,
  createDefaultSpeakingService,
  resolveFinishAvailability,
  type FinishAvailability,
  type SpeakingPracticePlan,
  type SpeakingPracticeProgress,
  type SpeakingPracticeSeed,
  type SpeakingPracticeService,
  type SpeakingPracticeSource,
  type SpeakingPracticeSummary,
  type SpeakingPracticeType,
  type SpeakingProfessionalScenario,
} from '../deep-speaking';

/** One started practice session (the service's own handle shape). */
type StartedPractice = Awaited<ReturnType<SpeakingPracticeService['startPractice']>>;

export type DeepSpeakingPhase =
  | 'loading'
  | 'plan_overview'
  | 'practicing'
  | 'finalizing'
  | 'summary';

export interface DeepSpeakingScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: SpeakingPracticeService;
  /** Override for the default composition (tests/embedding). */
  readonly loadService?: () => Promise<SpeakingPracticeService>;
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly initialMuted?: boolean;
  /** Seed for the very first plan (used by the adaptive-lesson entry point). */
  readonly seed?: SpeakingPracticeSeed;
  /** Optional preferred practice type for the first plan. */
  readonly practiceType?: SpeakingPracticeType;
  /** Additive: Professional English scenario content for the first plan. */
  readonly professionalScenario?: SpeakingProfessionalScenario;
  /** Route params (when pushed through the navigator with a seed). */
  readonly route?: {
    readonly params?: {
      readonly seed?: SpeakingPracticeSeed;
      readonly practiceType?: SpeakingPracticeType;
      readonly professionalScenario?: SpeakingProfessionalScenario;
      /**
       * Daily Tutor completion handshake ref. Present ONLY when the Daily
       * Tutor launched this practice; standalone use never sets it and is
       * completely unchanged.
       */
      readonly dailyTutor?: DailyTutorActivityRef;
    };
  };
}

const SOURCE_LABELS: Readonly<Record<SpeakingPracticeSource, string>> = {
  personalized: 'Personalized',
  mixed: 'Partly personalized',
  general: 'General practice',
};

const PRACTICE_TYPE_LABELS: Readonly<Record<SpeakingPracticeType, string>> = {
  free_conversation: 'Free conversation',
  guided_topic: 'Guided topic',
  role_play: 'Role play',
  explain_and_expand: 'Explain and expand',
  opinion_and_reasoning: 'Opinion and reasoning',
  problem_solution: 'Problem and solution',
  retell_or_summarize: 'Retell or summarize',
  reformulation: 'Reformulation',
  target_expression_practice: 'Target expression practice',
  weakness_retraining: 'Focused retraining',
};

const FOCUS_AREA_LABELS: Readonly<Record<string, string>> = {
  weakness: 'Correction focus',
  vocabulary: 'Vocabulary',
  expression: 'Expressions',
  goal: 'Your goal',
  scenario: 'Situation',
  fluency: 'Fluency',
};

const VOICE_IDLE_STATUS: VoiceStatus = {
  state: 'idle',
  elapsedSeconds: 0,
  recognizedTranscript: null,
  errorMessage: null,
  isMuted: false,
  isSpeaking: false,
  canRecord: false,
  canStopRecording: false,
  canSendText: true,
};

export default function DeepSpeakingScreen(props?: DeepSpeakingScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const seed = props?.seed ?? props?.route?.params?.seed;
  const professionalScenario =
    props?.professionalScenario ?? props?.route?.params?.professionalScenario;
  const preferredPracticeType = props?.practiceType ?? props?.route?.params?.practiceType;
  // Daily Tutor handshake: present only when the Daily Tutor launched this
  // practice. The real completion report happens in handleCompletePractice —
  // navigating here (or going back early) never completes anything.
  const dailyTutorRef = props?.route?.params?.dailyTutor;

  const [phase, setPhaseState] = useState<DeepSpeakingPhase>('loading');
  const [plan, setPlan] = useState<SpeakingPracticePlan | null>(null);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<SpeakingPracticeSummary | null>(null);
  const [progress, setProgress] = useState<SpeakingPracticeProgress | null>(null);
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [inputText, setInputText] = useState<string>('');
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastFeedback, setLastFeedback] = useState<ConversationFeedback | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isRealAI, setIsRealAI] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(VOICE_IDLE_STATUS);

  const phaseRef = useRef<DeepSpeakingPhase>('loading');
  const serviceRef = useRef<SpeakingPracticeService | null>(props?.service ?? null);
  const handleRef = useRef<StartedPractice | null>(null);
  const sessionRef = useRef<ConversationSession | null>(null);
  const coordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const voiceStatusRef = useRef<VoiceStatus>(VOICE_IDLE_STATUS);
  const unmountedRef = useRef<boolean>(false);
  const startingRef = useRef<boolean>(false);
  const completingRef = useRef<boolean>(false);
  const turnInFlightRef = useRef<boolean>(false);
  /** Bumped when the active session is installed/replaced/closed. */
  const sessionTokenRef = useRef<number>(0);
  /** Bumped for every learner turn: a stale AI/STT result is discarded. */
  const turnTokenRef = useRef<number>(0);
  /** Bumped when a new plan/practice starts: an old finalization is discarded. */
  const restartTokenRef = useRef<number>(0);

  const updatePhase = useCallback((next: DeepSpeakingPhase): void => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  /**
   * The CURRENT liveness of every learner operation, read synchronously from
   * refs + state. It is the single input of the finish rule below, so the button
   * and the handler can never disagree.
   */
  const readLiveness = useCallback(
    (): Parameters<typeof resolveFinishAvailability>[0] => ({
      voiceState: voiceStatusRef.current.state,
      isVoiceProcessing: voiceStatusRef.current.isProcessing === true,
      isSubmitting,
      isOpening,
      isTurnInFlight: turnInFlightRef.current,
      // The service is the authority on its own in-flight learner turn.
      isServiceTurnActive: serviceRef.current?.hasActiveLearnerTurn() === true,
    }),
    [isOpening, isSubmitting],
  );

  /* ----------------------------- planning ----------------------------- */

  const loadPlan = useCallback(
    async (token: number): Promise<void> => {
      const service = serviceRef.current;
      if (!service) return;
      try {
        const result = await service.planPractice({
          ...(seed ? { seed } : {}),
          ...(preferredPracticeType ? { practiceType: preferredPracticeType } : {}),
          ...(professionalScenario ? { professionalScenario } : {}),
        });
        if (unmountedRef.current || restartTokenRef.current !== token) return;
        if (result.status === 'planned') {
          setPlan(result.plan);
          setPlanMessage(null);
          updatePhase('plan_overview');
          return;
        }
        setPlan(null);
        setPlanMessage(result.message);
        updatePhase('loading');
      } catch (error) {
        if (unmountedRef.current || restartTokenRef.current !== token) return;
        setPlan(null);
        setPlanMessage(
          error instanceof Error
            ? error.message
            : 'Your speaking practice could not be prepared. Nothing was changed.',
        );
        updatePhase('loading');
      }
    },
    [preferredPracticeType, professionalScenario, seed, updatePhase],
  );

  useEffect(() => {
    let active = true;
    const token = restartTokenRef.current;
    void (async () => {
      try {
        const service =
          serviceRef.current ??
          (await (props?.loadService ?? createDefaultSpeakingService)());
        if (!active || unmountedRef.current || restartTokenRef.current !== token) {
          return;
        }
        serviceRef.current = service;
        await loadPlan(token);
      } catch (error) {
        if (!active || unmountedRef.current) return;
        setPlan(null);
        setPlanMessage(
          error instanceof Error
            ? error.message
            : 'Speaking practice is unavailable right now.',
        );
        updatePhase('loading');
      }
    })();
    return () => {
      active = false;
    };
  }, [loadPlan, props?.loadService, updatePhase]);

  /* --------------------------- voice teardown -------------------------- */

  const disposeVoice = useCallback(async (): Promise<void> => {
    const coordinator = coordinatorRef.current;
    coordinatorRef.current = null;
    if (coordinator) {
      // Stops the recorder and any playback and invalidates late voice results.
      await coordinator.dispose();
    }
  }, []);

  /* ---------------------------- start practice ------------------------- */

  const handleStartPractice = useCallback(async (): Promise<void> => {
    const service = serviceRef.current;
    const currentPlan = plan;
    if (!service || !currentPlan) return;
    // Synchronous guard: a double tap starts exactly one practice.
    if (startingRef.current || phaseRef.current === 'practicing') return;
    startingRef.current = true;
    setErrorMessage(null);
    setIsOpening(true);
    updatePhase('practicing');

    try {
      const started = await service.startPractice(currentPlan);
      if (unmountedRef.current) return;
      handleRef.current = started;
      sessionRef.current = started.conversationSession;
      const sessionToken = (sessionTokenRef.current += 1);
      setIsRealAI(started.isRealAI);

      const coordinator = createTalkVoiceCoordinator({
        session: started.conversationSession,
        providerKind: started.providerKind,
        isMuted: props?.initialMuted ?? false,
        ...(props?.recorder ? { recorder: props.recorder } : {}),
        ...(props?.sttProvider ? { sttProvider: props.sttProvider } : {}),
        ...(props?.ttsProvider ? { ttsProvider: props.ttsProvider } : {}),
      });
      coordinator.subscribe((status) => {
        // A replaced/closed session's status must never drive the new session.
        if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
        voiceStatusRef.current = status;
        setVoiceStatus(status);
        if (status.errorMessage) setErrorMessage(status.errorMessage);
      });
      coordinatorRef.current = coordinator;

      const result = await service.openConversation((chunk: string) => {
        if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
        setStreamingText((previous) => (previous ?? '') + chunk);
      });

      // Stale guard: the practice was closed/restarted while the tutor opened.
      if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;

      setHistory(started.conversationSession.getHistory());
      setProgress(service.getProgress());
      setStreamingText(null);
      setIsOpening(false);

      if (!result.ok) {
        setErrorMessage(
          result.error?.message ||
            'The tutor could not start the conversation. Please try again.',
        );
        return;
      }

      const openingText = started.conversationSession.getHistory().at(-1)?.content ?? '';
      if (openingText.trim().length > 0 && !coordinator.getStatus().isMuted) {
        // Speak the REAL tutor turn. The microphone is never opened automatically.
        void coordinator.speakResponse(openingText);
      }
    } catch (error) {
      if (unmountedRef.current) return;
      // Starting failed: nothing is running, so the learner is returned to the
      // plan (with the honest reason) instead of an empty practice screen.
      setIsOpening(false);
      updatePhase('plan_overview');
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'The speaking practice could not be started. Please try again.',
      );
    } finally {
      startingRef.current = false;
    }
  }, [plan, props?.initialMuted, props?.recorder, props?.sttProvider, props?.ttsProvider, updatePhase]);

  /* --------------------------- learner turns --------------------------- */

  /**
   * ONE learner turn through the service (which owns the existing session,
   * the existing feedback persistence and the real turn count).
   */
  const runLearnerTurn = useCallback(
    async (message: string, options?: { readonly restoreInput?: string }): Promise<void> => {
      const service = serviceRef.current;
      const handle = handleRef.current;
      const session = sessionRef.current;
      const coordinator = coordinatorRef.current;
      if (!service || !handle || !session) return;
      // Synchronous guard: a double submit can never produce two turns.
      if (turnInFlightRef.current || phaseRef.current !== 'practicing') return;

      const token = (turnTokenRef.current += 1);
      const sessionToken = sessionTokenRef.current;
      turnInFlightRef.current = true;
      setIsSubmitting(true);
      setErrorMessage(null);
      setStreamingText('');
      setLastTranscript(null);

      try {
        // No recording may overlap the reply being played.
        if (coordinator) await coordinator.stopSpeaking();

        const result = await service.sendLearnerTurn(message, (chunk: string) => {
          if (
            unmountedRef.current ||
            turnTokenRef.current !== token ||
            sessionTokenRef.current !== sessionToken
          ) {
            return;
          }
          setStreamingText((previous) => (previous ?? '') + chunk);
        });

        // Stale guard: an old session's result never writes into a new one.
        if (
          unmountedRef.current ||
          turnTokenRef.current !== token ||
          sessionTokenRef.current !== sessionToken ||
          sessionRef.current !== session
        ) {
          return;
        }

        setHistory(session.getHistory());
        setProgress(service.getProgress());
        // Selective REAL feedback only: the offline demo never shows invented
        // corrections and is never treated as real evidence.
        setLastFeedback(handle.isRealAI ? session.getLastFeedback() : null);

        if (!result.ok) {
          if (options?.restoreInput) setInputText(options.restoreInput);
          setErrorMessage(
            result.error?.message || 'The tutor could not reply. Please try again.',
          );
          return;
        }

        const tutorText = session.getHistory().at(-1)?.content ?? '';
        const status = coordinator?.getStatus();
        if (coordinator && tutorText.trim().length > 0 && !(status?.isMuted ?? false)) {
          void coordinator.speakResponse(tutorText);
        }
      } catch (error) {
        if (unmountedRef.current || turnTokenRef.current !== token) return;
        if (options?.restoreInput) setInputText(options.restoreInput);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Your turn could not be completed. Please try again.',
        );
      } finally {
        if (turnTokenRef.current === token) {
          turnInFlightRef.current = false;
          setIsSubmitting(false);
          setStreamingText(null);
        }
      }
    },
    [],
  );

  const handleToggleRecording = useCallback(async (): Promise<void> => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || phaseRef.current !== 'practicing') return;
    if (turnInFlightRef.current || startingRef.current) return;
    const status = coordinator.getStatus();

    if (status.state === 'recording') {
      // Transcribe only: the turn itself goes through the service pipeline.
      const token = (turnTokenRef.current += 1);
      const sessionToken = sessionTokenRef.current;
      turnInFlightRef.current = true;
      setIsSubmitting(true);
      setErrorMessage(null);
      setStreamingText('');
      try {
        const voice = await coordinator.stopRecordingAndTranscribe();
        if (
          unmountedRef.current ||
          turnTokenRef.current !== token ||
          sessionTokenRef.current !== sessionToken
        ) {
          return;
        }
        if (!voice.ok) {
          setErrorMessage(
            voice.error || 'Your speech could not be transcribed. Please try again.',
          );
          return;
        }
        const transcript = (voice.transcript ?? '').trim();
        if (transcript.length === 0) {
          setErrorMessage('No speech was recognized. Please try again, or type your answer.');
          return;
        }
        setLastTranscript(transcript);
        turnInFlightRef.current = false;
        setIsSubmitting(false);
        await runLearnerTurn(transcript);
      } finally {
        if (turnTokenRef.current === token) {
          turnInFlightRef.current = false;
          setIsSubmitting(false);
          setStreamingText(null);
        }
      }
      return;
    }

    if (!status.canRecord) return;
    setErrorMessage(null);
    // Barge-in: the coordinator stops and awaits tutor playback before the
    // microphone opens, so recording and TTS never overlap.
    await coordinator.startRecording();
  }, [runLearnerTurn]);

  const handleSendTyped = useCallback(async (): Promise<void> => {
    const message = inputText.trim();
    if (message.length === 0) return;
    if (turnInFlightRef.current || phaseRef.current !== 'practicing') return;
    setInputText('');
    await runLearnerTurn(message, { restoreInput: message });
  }, [inputText, runLearnerTurn]);

  /* ------------------------------ complete ----------------------------- */

  const handleCompletePractice = useCallback(async (): Promise<void> => {
    // Synchronous guard: a double tap finalizes once (the service is idempotent
    // as well, so the two layers agree).
    if (completingRef.current || phaseRef.current === 'finalizing') return;
    const service = serviceRef.current;
    if (!service) return;

    // SYNCHRONOUS REFUSAL — before anything else, in particular BEFORE any voice
    // teardown: disposing the voice coordinator abandons the conversation
    // session, so finishing while a typed turn / STT / AI reply / tutor opening
    // is still in flight could destroy the learner's own turn. The operation in
    // flight is always allowed to settle through its own path first.
    const liveness = resolveFinishAvailability(readLiveness());
    if (!liveness.allowed) {
      if (liveness.reason) setErrorMessage(liveness.reason);
      return;
    }

    const token = restartTokenRef.current;
    completingRef.current = true;
    // Any late UI write of an already-settled turn is now stale by definition.
    turnTokenRef.current += 1;
    setIsSubmitting(false);
    setStreamingText(null);
    setErrorMessage(null);
    // The phase change blocks every new learner turn synchronously, so nothing
    // can start between this guard and the teardown below.
    updatePhase('finalizing');

    try {
      // No learner operation is in flight (guaranteed above), so closing the
      // voice work here cannot cancel one: it only stops playback/recorder and
      // invalidates late voice results.
      await disposeVoice();
      const completed = await service.completePractice();
      if (unmountedRef.current || restartTokenRef.current !== token) return;
      setSummary(completed);
      setProgress(null);
      setHistory([]);
      setLastFeedback(null);
      updatePhase('summary');
      // Daily Tutor handshake: report the REAL completion (the child's own
      // summary) — never on open, and only when launched by the Daily Tutor.
      // The real learner-turn count travels with it; a zero-turn finish is
      // reported honestly as such and completes nothing.
      if (dailyTutorRef) {
        reportDailyTutorCompletion({
          ref: dailyTutorRef,
          completedAt: completed.generatedAt,
          itemsPracticed: completed.learnerTurns,
        });
      }
    } catch (error) {
      if (unmountedRef.current || restartTokenRef.current !== token) return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Your practice could not be finished. Nothing was lost.',
      );
      updatePhase('practicing');
    } finally {
      completingRef.current = false;
    }
  }, [disposeVoice, readLiveness, updatePhase]);

  const handlePracticeAgain = useCallback(async (): Promise<void> => {
    // Invalidate any in-flight finalization/summary from the previous practice.
    const token = (restartTokenRef.current += 1);
    const service = serviceRef.current;
    completingRef.current = false;
    turnInFlightRef.current = false;
    turnTokenRef.current += 1;
    sessionTokenRef.current += 1;
    await disposeVoice();
    try {
      // Idempotent: a completed session is never finalized twice.
      await service?.dispose();
    } catch {
      // Disposal failures are non-destructive.
    }
    if (unmountedRef.current || restartTokenRef.current !== token) return;

    handleRef.current = null;
    sessionRef.current = null;
    setIsRealAI(false);
    setSummary(null);
    setProgress(null);
    setHistory([]);
    setLastFeedback(null);
    setLastTranscript(null);
    setStreamingText(null);
    setInputText('');
    setErrorMessage(null);
    setIsOpening(false);
    setVoiceStatus(VOICE_IDLE_STATUS);
    voiceStatusRef.current = VOICE_IDLE_STATUS;
    await loadPlan(token);
  }, [disposeVoice, loadPlan]);

  /* ------------------------------ teardown ----------------------------- */

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      // Every in-flight result is invalidated before anything else runs.
      turnTokenRef.current += 1;
      sessionTokenRef.current += 1;
      restartTokenRef.current += 1;
      const coordinator = coordinatorRef.current;
      coordinatorRef.current = null;
      void coordinator?.dispose();
      const service = serviceRef.current;
      // Leaving finalizes a conversation that holds real learner turns, exactly
      // once, through the existing memory pipeline; empty/demo sessions are
      // never stored (the service decides).
      void service?.dispose();
    };
  }, []);

  /* ------------------------------- render ------------------------------ */

  // The EXISTING voice-turn description drives the microphone label/hint.
  const micStatus = describeVoiceTurn(voiceStatus, isSubmitting || isOpening);
  // ONE rule decides both the button state and the handler's refusal, so the two
  // can never disagree: while a learner operation is in flight, finishing is
  // refused and the learner is told why instead of losing their turn.
  const finishAvailability: FinishAvailability =
    phase === 'practicing' ? resolveFinishAvailability(readLiveness()) : { allowed: false, reason: null };
  const turnControls = resolveTalkTurnControls({
    voiceStatus,
    inputText,
    isOpening,
    isSending: isSubmitting,
    isSwitching: false,
    isPreparing: phase === 'loading',
  });
  const practiceRunning = phase === 'practicing';
  const showStreaming = isSubmitting && streamingText !== null;
  const isOfflineDemo = practiceRunning && !isRealAI;

  if (phase === 'loading') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Speaking practice</Text>
        {isLoadingPlan(planMessage) ? (
          <View style={styles.card}>
            <ActivityIndicator />
            <Text style={styles.body}>Preparing your speaking practice…</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Speaking practice is not ready</Text>
            <Text style={styles.body}>{planMessage}</Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                const token = (restartTokenRef.current += 1);
                void loadPlan(token);
              }}
            >
              <Text style={styles.secondaryButtonText}>Check again</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    );
  }

  if (phase === 'plan_overview' && plan) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Speaking practice</Text>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{PRACTICE_TYPE_LABELS[plan.practiceType]}</Text>
            <View
              style={[
                styles.pill,
                plan.source === 'general' ? styles.pillGeneral : styles.pillPersonal,
              ]}
            >
              <Text style={styles.pillText}>{SOURCE_LABELS[plan.source]}</Text>
            </View>
          </View>
          <Text style={styles.headline}>{plan.topic}</Text>
          <Text style={styles.body}>{plan.scenarioPrompt}</Text>
          <Text style={styles.sourceNote}>{plan.sourceNote}</Text>
        </View>

        {plan.focusAreas.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>What we will work on</Text>
            {plan.focusAreas.map((focus) => (
              <Text key={`${focus.area}:${focus.detail}`} style={styles.listLine}>
                • {FOCUS_AREA_LABELS[focus.area] ?? focus.area}: {focus.detail}
              </Text>
            ))}
          </View>
        ) : null}

        {plan.targetExpressions.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>
              {plan.professionalScenario
                ? 'Target expressions'
                : 'Expressions from your own vocabulary'}
            </Text>
            {plan.targetExpressions.map((item) => (
              <View key={item.itemId} style={styles.listBlock}>
                <Text style={styles.listLineStrong}>{item.headword}</Text>
                <Text style={styles.listLine}>{item.meaning}</Text>
                <Text style={styles.sizeNote}>{item.reason}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {plan.weaknessTargets.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Areas to retrain</Text>
            {plan.weaknessTargets.map((target) => (
              <View key={target.weaknessId} style={styles.listBlock}>
                <Text style={styles.listLineStrong}>{target.type}</Text>
                <Text style={styles.sizeNote}>{target.reason}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>How this practice runs</Text>
          <Text style={styles.listLine}>
            • Target: about {plan.targetTurns} learner turns (you can stop earlier, and the coach
            never goes past {plan.hardMaxTurns}).
          </Text>
          {plan.recentMemoryNote ? (
            <Text style={styles.listLine}>• {plan.recentMemoryNote}</Text>
          ) : null}
        </View>

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => void handleStartPractice()}
        >
          <Text style={styles.primaryButtonText}>Start speaking practice</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.linkButton}
          onPress={() => {
            const token = (restartTokenRef.current += 1);
            void loadPlan(token);
          }}
        >
          <Text style={styles.linkText}>Plan a different practice</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (phase === 'finalizing') {
    return (
      <View style={styles.centeredBox}>
        <ActivityIndicator />
        <Text style={styles.body}>Finishing your practice…</Text>
      </View>
    );
  }

  if (phase === 'summary') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Practice summary</Text>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>What happened</Text>
            {summary ? (
              <View style={styles.pill}>
                <Text style={styles.pillText}>{SOURCE_LABELS[summary.source]}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.body}>
            {summary
              ? `You completed ${summary.learnerTurns} learner turn${
                  summary.learnerTurns === 1 ? '' : 's'
                } with the tutor (${summary.tutorTurns} tutor ${
                  summary.tutorTurns === 1 ? 'reply' : 'replies'
                }).`
              : 'This practice is finished.'}
          </Text>
          {summary ? <Text style={styles.sourceNote}>{summary.notice}</Text> : null}
          {plan?.professionalScenario ? (
            <Text style={styles.sourceNote}>
              Professional scenario: {plan.professionalScenario.title}
            </Text>
          ) : null}
        </View>

        {summary
          ? summary.sections.map((section) => (
              <View key={section.id} style={styles.card}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item) => (
                  <Text key={item} style={styles.listLine}>
                    • {item}
                  </Text>
                ))}
              </View>
            ))
          : null}

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => void handlePracticeAgain()}
        >
          <Text style={styles.primaryButtonText}>Practise again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.linkButton} onPress={() => navigation.goBack()}>
          <Text style={styles.linkText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (!plan) return null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{PRACTICE_TYPE_LABELS[plan.practiceType]}</Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>{SOURCE_LABELS[plan.source]}</Text>
            </View>
          </View>
          <Text style={styles.body}>{plan.topic}</Text>
          {progress ? (
            <Text style={styles.progressLine}>
              {isOpening ? 'Preparing the conversation…' : progress.label}
            </Text>
          ) : null}
          <Text style={styles.sizeNote}>
            Real turn count only · no scores or levels are measured here.
          </Text>
        </View>

        {isOfflineDemo ? (
          <View style={styles.demoBox}>
            <Text style={styles.demoText}>
              Offline demo tutor: replies are not real practice and nothing from this session is
              saved.
            </Text>
          </View>
        ) : null}

        <View style={styles.card}>
          {history.length === 0 && !showStreaming ? (
            <Text style={styles.body}>
              {isOpening
                ? 'The coach is opening the conversation…'
                : 'Tap the microphone and answer the coach.'}
            </Text>
          ) : null}
          {history.map((turn, index) => (
            <View
              key={`${turn.role}-${index}`}
              style={turn.role === 'user' ? styles.userTurn : styles.tutorTurn}
            >
              <Text style={styles.turnRole}>
                {turn.role === 'user' ? 'You' : 'Coach'}
              </Text>
              <Text style={styles.turnText}>{turn.content}</Text>
            </View>
          ))}
          {showStreaming ? (
            <View style={styles.tutorTurn}>
              <Text style={styles.turnRole}>Coach</Text>
              <Text style={styles.turnText}>{streamingText}</Text>
            </View>
          ) : null}
          {lastTranscript ? (
            <Text style={styles.transcriptLine}>You said: “{lastTranscript}”</Text>
          ) : null}
        </View>

        {lastFeedback?.correction ? (
          <View style={styles.feedbackBox}>
            <Text style={styles.sectionTitle}>Useful correction</Text>
            <Text style={styles.feedbackLine}>
              “{lastFeedback.correction.original}” → “{lastFeedback.correction.improved}”
            </Text>
            {lastFeedback.correction.explanation ? (
              <Text style={styles.feedbackDetail}>{lastFeedback.correction.explanation}</Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{micStatus.label}</Text>
          <Text style={styles.sizeNote}>{micStatus.hint}</Text>
          <TouchableOpacity
            style={[styles.micButton, turnControls.micDisabled ? styles.micButtonDisabled : null]}
            disabled={turnControls.micDisabled}
            onPress={() => void handleToggleRecording()}
          >
            <Text style={styles.micButtonText}>
              {voiceStatus.state === 'recording' ? 'Stop and send' : 'Tap to speak'}
            </Text>
          </TouchableOpacity>

          <View style={styles.controlRow}>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={() => coordinatorRef.current?.toggleMute()}
            >
              <Text style={styles.controlButtonText}>
                {voiceStatus.isMuted ? 'Unmute coach' : 'Mute coach'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.controlButton}
              disabled={voiceStatus.state === 'idle'}
              onPress={() => void coordinatorRef.current?.replayLastResponse()}
            >
              <Text style={styles.controlButtonText}>Replay</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.controlButton}
              disabled={!voiceStatus.isSpeaking}
              onPress={() => void coordinatorRef.current?.stopSpeaking()}
            >
              <Text style={styles.controlButtonText}>Stop speaking</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={[styles.input, styles.inputMultiline]}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Or type your answer"
            placeholderTextColor="#9a9a9e"
            editable={!isSubmitting && !isOpening}
            multiline
          />
          <TouchableOpacity
            style={[
              styles.secondaryButton,
              turnControls.sendDisabled ? styles.micButtonDisabled : null,
            ]}
            disabled={turnControls.sendDisabled}
            onPress={() => void handleSendTyped()}
          >
            <Text style={styles.secondaryButtonText}>Send answer</Text>
          </TouchableOpacity>
        </View>

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        <TouchableOpacity
          style={[
            styles.completeButton,
            finishAvailability.allowed ? null : styles.completeButtonDisabled,
          ]}
          disabled={!finishAvailability.allowed}
          onPress={() => void handleCompletePractice()}
        >
          <Text style={styles.completeButtonText}>Finish practice</Text>
        </TouchableOpacity>
        {!finishAvailability.allowed ? (
          <Text style={styles.sizeNote}>
            {finishAvailability.reason ?? FINISH_BLOCKED_MESSAGE}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** True while the plan itself is still being produced (no honest message yet). */
function isLoadingPlan(planMessage: string | null): boolean {
  return planMessage === null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingBottom: 32 },
  centeredBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  },
  screenTitle: { fontSize: 20, fontWeight: '700', color: '#1c1c1e', marginBottom: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e6e9ef',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#1c1c1e' },
  headline: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },
  body: { fontSize: 14, color: '#3a3a3c', marginBottom: 8 },
  sourceNote: { fontSize: 13, color: '#6b6b70' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#8e8e93', marginBottom: 6 },
  listBlock: { marginBottom: 10 },
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  listLineStrong: { fontSize: 14, fontWeight: '600', color: '#1c1c1e' },
  sizeNote: { fontSize: 12, color: '#8e8e93', marginTop: 2 },
  progressLine: { fontSize: 14, fontWeight: '600', color: '#0a7a3d', marginTop: 4 },
  pill: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillPersonal: { backgroundColor: '#e3f2e6' },
  pillGeneral: { backgroundColor: '#f1f1f4' },
  pillText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  userTurn: {
    backgroundColor: '#eef4ff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  tutorTurn: {
    backgroundColor: '#f7f8fa',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  turnRole: { fontSize: 11, fontWeight: '700', color: '#8e8e93', marginBottom: 2 },
  turnText: { fontSize: 14, color: '#1c1c1e' },
  transcriptLine: { fontSize: 13, color: '#4a4a4e', fontStyle: 'italic', marginTop: 4 },
  feedbackBox: {
    backgroundColor: '#f3f7f4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#dce7df',
  },
  feedbackLine: { fontSize: 14, color: '#1c1c1e', marginBottom: 4 },
  feedbackDetail: { fontSize: 13, color: '#4a4a4e', marginTop: 2 },
  demoBox: {
    backgroundColor: '#fff8e6',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#f0e2bf',
  },
  demoText: { fontSize: 13, color: '#7a5b00' },
  micButton: {
    backgroundColor: '#0b6b3a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  micButtonDisabled: { opacity: 0.45 },
  micButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  controlRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  controlButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  controlButtonText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    color: '#1c1c1e',
    backgroundColor: '#fbfcfe',
    marginTop: 12,
    minHeight: 44,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top' },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  completeButton: {
    borderWidth: 1,
    borderColor: '#0b6b3a',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  completeButtonDisabled: { opacity: 0.45 },
  completeButtonText: { color: '#0b6b3a', fontSize: 15, fontWeight: '700' },
  linkButton: { alignItems: 'center', paddingVertical: 12 },
  linkText: { fontSize: 13, color: '#6b6b70', textDecorationLine: 'underline' },
  errorText: { fontSize: 13, color: '#b00020', marginBottom: 8 },
});
