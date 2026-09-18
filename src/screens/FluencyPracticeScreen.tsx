/**
 * src/screens/FluencyPracticeScreen.tsx
 *
 * WP-3 deliberate fluency practice screen (task repetition, sustained
 * monologue, clarification/repair, progressive de-scaffolding).
 *
 * PHASES: loading → task_pick → practicing → finalizing → summary.
 *
 * REUSE CONTRACT (no duplicate systems)
 * - The FluencyPracticeService owns task state, attempts, support level,
 *   comparison and repair — and itself runs on the EXISTING
 *   SpeakingPracticeService (ConversationEngine → ConversationOrchestrator →
 *   ConversationSession), conversation memory and learning persistence.
 * - Voice is the EXISTING stack: `createTalkVoiceCoordinator` over the
 *   session the service exposes. Recording is transcribed with
 *   `stopRecordingAndTranscribe()` (never submits a turn itself) and the
 *   attempt is submitted through the fluency service, so ONE pipeline owns
 *   every learner attempt. The microphone is explicit push-to-talk: it never
 *   opens by itself and there is no always-listening behavior.
 * - Turn controls and the voice lifecycle come from the existing
 *   `resolveTalkTurnControls` / `describeVoiceTurn` helpers — this screen
 *   adds no second state machine.
 *
 * HONESTY RULES
 * - No scores, percentages, XP, stars, streaks, points or level claims
 *   anywhere: the screen shows the task, the attempt count, the allowed
 *   support cues, concise real feedback, evidence lines and support words
 *   (Guided / Supported / Independent) only.
 * - Feedback and comparisons are shown ONLY when real (a real AI provider
 *   produced them). Offline demo practice says plainly that attempts are
 *   counted but nothing is compared or saved.
 * - Scripted repair prompts are always shown with their deliberate-practice
 *   label, never as a genuine failure to understand.
 *
 * RACE GUARDS (synchronous refs, like DeepSpeakingScreen)
 * - `startingRef` / `completingRef` / `turnInFlightRef`: one start, one
 *   finalization, one attempt at a time — refusals happen before any await.
 * - `sessionTokenRef`: a replaced/teardown session's late results never write
 *   into the new one.
 * - `turnTokenRef`: a stale AI/STT result never overwrites a newer attempt.
 * - `restartTokenRef`: a "Practise again" started during finalization
 *   invalidates the in-flight summary.
 * - `unmountedRef`: nothing is written after unmount; leaving closes the
 *   practice once (through the service) and disposes the voice work.
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
import {
  createDefaultFluencyService,
  repairSupportFor,
  type FluencyAttemptResult,
  type FluencyComparison,
  type FluencyCues,
  type FluencyPracticeService,
  type FluencyRepairDecision,
  type FluencyRepeatPrompt,
  type FluencySessionSnapshot,
  type FluencySummary,
  type FluencySupportLevel,
  type FluencyTask,
  type FluencyTaskKind,
} from '../fluency';
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

export type FluencyPracticePhase =
  | 'loading'
  | 'task_pick'
  | 'practicing'
  | 'finalizing'
  | 'summary';

export interface FluencyPracticeScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: FluencyPracticeService;
  /** Override for the default composition (tests/embedding). */
  readonly loadService?: () => Promise<FluencyPracticeService>;
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly initialMuted?: boolean;
  /** Pre-selected task id (deep link / embedding); otherwise the learner picks. */
  readonly initialTaskId?: string;
}

const KIND_LABELS: Readonly<Record<FluencyTaskKind, string>> = {
  repetition: 'Repeat for fluency',
  monologue: 'Sustained speaking',
  repair: 'Repair practice',
};

const SUPPORT_LABELS: Readonly<Record<FluencySupportLevel, string>> = {
  guided: 'Guided',
  supported: 'Supported',
  independent: 'Independent',
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

const FINISH_BLOCKED =
  'Your attempt is still in progress, so it is not counted yet. Finish once it settles — nothing will be lost.';

export default function FluencyPracticeScreen(props?: FluencyPracticeScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  const [phase, setPhaseState] = useState<FluencyPracticePhase>('loading');
  const [tasks, setTasks] = useState<readonly FluencyTask[]>([]);
  const [task, setTask] = useState<FluencyTask | null>(null);
  const [snapshot, setSnapshot] = useState<FluencySessionSnapshot | null>(null);
  const [cues, setCues] = useState<FluencyCues | null>(null);
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [inputText, setInputText] = useState<string>('');
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastFeedback, setLastFeedback] = useState<ConversationFeedback | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [comparison, setComparison] = useState<FluencyComparison | null>(null);
  const [repair, setRepair] = useState<FluencyRepairDecision | null>(null);
  const [repeatPrompt, setRepeatPrompt] = useState<FluencyRepeatPrompt | null>(null);
  const [summary, setSummary] = useState<FluencySummary | null>(null);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isPreparing, setIsPreparing] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(VOICE_IDLE_STATUS);

  const phaseRef = useRef<FluencyPracticePhase>('loading');
  const serviceRef = useRef<FluencyPracticeService | null>(props?.service ?? null);
  const sessionRef = useRef<ConversationSession | null>(null);
  const coordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const voiceStatusRef = useRef<VoiceStatus>(VOICE_IDLE_STATUS);
  const unmountedRef = useRef<boolean>(false);
  const startingRef = useRef<boolean>(false);
  const completingRef = useRef<boolean>(false);
  const turnInFlightRef = useRef<boolean>(false);
  /** Bumped when the active session is installed/replaced/closed. */
  const sessionTokenRef = useRef<number>(0);
  /** Bumped for every attempt: a stale AI/STT result is discarded. */
  const turnTokenRef = useRef<number>(0);
  /** Bumped when a new task/practice starts: an old summary is discarded. */
  const restartTokenRef = useRef<number>(0);

  const updatePhase = useCallback((next: FluencyPracticePhase): void => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  /* ----------------------------- load ----------------------------- */

  useEffect(() => {
    let active = true;
    const token = restartTokenRef.current;
    void (async () => {
      try {
        const service =
          serviceRef.current ??
          (await (props?.loadService ?? createDefaultFluencyService)());
        if (!active || unmountedRef.current || restartTokenRef.current !== token) {
          return;
        }
        serviceRef.current = service;
        setTasks(service.listTasks());
        setLoadMessage(null);
        const preselected = props?.initialTaskId
          ? service.findTask(props.initialTaskId)
          : null;
        if (preselected) {
          setTask(preselected);
        }
        updatePhase('task_pick');
      } catch (error) {
        if (!active || unmountedRef.current) return;
        setTasks([]);
        setLoadMessage(
          error instanceof Error
            ? error.message
            : 'Fluency practice is unavailable right now.',
        );
        updatePhase('loading');
      }
    })();
    return () => {
      active = false;
    };
  }, [props?.loadService, props?.initialTaskId, updatePhase]);

  /* --------------------------- voice teardown -------------------------- */

  const disposeVoice = useCallback(async (): Promise<void> => {
    const coordinator = coordinatorRef.current;
    coordinatorRef.current = null;
    if (coordinator) {
      await coordinator.dispose();
    }
  }, []);

  /* ---------------------------- start task ------------------------- */

  const handleStartTask = useCallback(
    async (taskId: string): Promise<void> => {
      const service = serviceRef.current;
      if (!service) return;
      if (startingRef.current) return;
      startingRef.current = true;
      setErrorMessage(null);
      setIsPreparing(true);
      setRepeatPrompt(null);
      setComparison(null);
      setRepair(null);
      setLastFeedback(null);
      setLastTranscript(null);
      setHistory([]);
      updatePhase('practicing');

      const sessionToken = (sessionTokenRef.current += 1);
      turnTokenRef.current += 1;
      restartTokenRef.current += 1;
      turnInFlightRef.current = false;
      completingRef.current = false;

      await disposeVoice();

      try {
        const started = await service.startTask(taskId);
        if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
        const session = service.getConversationSession();
        if (!session) {
          throw new Error('The speaking session could not be prepared.');
        }
        sessionRef.current = session;
        setTask(started.task);
        setSnapshot(service.getSnapshot());
        setCues(service.getCues());

        const coordinator = createTalkVoiceCoordinator({
          session,
          providerKind: started.isRealAI ? 'gemini' : 'demo',
          isMuted: props?.initialMuted ?? false,
          ...(props?.recorder ? { recorder: props.recorder } : {}),
          ...(props?.sttProvider ? { sttProvider: props.sttProvider } : {}),
          ...(props?.ttsProvider ? { ttsProvider: props.ttsProvider } : {}),
        });
        coordinator.subscribe((status) => {
          if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
          voiceStatusRef.current = status;
          setVoiceStatus(status);
          if (status.errorMessage) setErrorMessage(status.errorMessage);
        });
        coordinatorRef.current = coordinator;

        setHistory(session.getHistory());
        setSnapshot(service.getSnapshot());
        setIsPreparing(false);

        const openingText = session.getHistory().at(-1)?.content ?? '';
        if (openingText.trim().length > 0 && !coordinator.getStatus().isMuted) {
          void coordinator.speakResponse(openingText);
        }
      } catch (error) {
        if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
        setIsPreparing(false);
        updatePhase('task_pick');
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'This task could not be started. Please try again.',
        );
      } finally {
        startingRef.current = false;
      }
    },
    [
      disposeVoice,
      props?.initialMuted,
      props?.recorder,
      props?.sttProvider,
      props?.ttsProvider,
      updatePhase,
    ],
  );

  /* --------------------------- attempts --------------------------- */

  /**
   * ONE learner attempt through the fluency service (which owns the existing
   * session, the attempt count, the comparison and the repair decision).
   */
  const runAttempt = useCallback(
    async (transcript: string, options?: { readonly restoreInput?: string }): Promise<void> => {
      const service = serviceRef.current;
      const session = sessionRef.current;
      const coordinator = coordinatorRef.current;
      if (!service || !session) return;
      if (turnInFlightRef.current || phaseRef.current !== 'practicing') return;

      const token = (turnTokenRef.current += 1);
      const sessionToken = sessionTokenRef.current;
      turnInFlightRef.current = true;
      setIsSubmitting(true);
      setErrorMessage(null);
      setStreamingText('');
      setLastTranscript(null);

      try {
        if (coordinator) await coordinator.stopSpeaking();

        const result: FluencyAttemptResult = await service.submitAttempt({
          transcript,
          onChunk: (chunk: string) => {
            if (
              unmountedRef.current ||
              turnTokenRef.current !== token ||
              sessionTokenRef.current !== sessionToken
            ) {
              return;
            }
            setStreamingText((previous) => (previous ?? '') + chunk);
          },
        });

        if (
          unmountedRef.current ||
          turnTokenRef.current !== token ||
          sessionTokenRef.current !== sessionToken ||
          sessionRef.current !== session
        ) {
          return;
        }

        setHistory(session.getHistory());
        setSnapshot(service.getSnapshot());
        setCues(service.getCues());

        if (!result.ok) {
          if (options?.restoreInput) setInputText(options.restoreInput);
          if (result.reason !== 'stale') {
            setErrorMessage(result.errorMessage);
          }
          return;
        }

        setLastTranscript(result.evidence.transcript);
        setLastFeedback(result.feedback);
        setComparison(result.comparison);
        setRepair(result.repair);
        setRepeatPrompt(null);

        const status = coordinator?.getStatus();
        if (coordinator && result.tutorReply.trim().length > 0 && !(status?.isMuted ?? false)) {
          // TTS failure never touches the committed attempt (service state
          // is already final for this attempt).
          void coordinator.speakResponse(result.tutorReply).catch(() => undefined);
        }
      } catch (error) {
        if (unmountedRef.current || turnTokenRef.current !== token) return;
        if (options?.restoreInput) setInputText(options.restoreInput);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Your attempt could not be completed. Please try again.',
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
        turnInFlightRef.current = false;
        setIsSubmitting(false);
        await runAttempt(transcript);
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
    await coordinator.startRecording();
  }, [runAttempt]);

  const handleSendTyped = useCallback(async (): Promise<void> => {
    const message = inputText.trim();
    if (message.length === 0) return;
    if (turnInFlightRef.current || phaseRef.current !== 'practicing') return;
    setInputText('');
    await runAttempt(message, { restoreInput: message });
  }, [inputText, runAttempt]);

  /* ------------------------------ repeat ----------------------------- */

  const handleRepeat = useCallback((): void => {
    const service = serviceRef.current;
    if (!service || turnInFlightRef.current || phaseRef.current !== 'practicing') return;
    try {
      const prompt = service.requestRepeat();
      setRepeatPrompt(prompt);
      setSnapshot(service.getSnapshot());
      setCues(service.getCues());
      setErrorMessage(null);
      // The acknowledged feedback stays visible; the repeat prompt invites
      // the next round of the SAME task.
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'A repetition cannot start right now.',
      );
    }
  }, []);

  /* ------------------------------ transfer ---------------------------- */

  const handleTransfer = useCallback(async (): Promise<void> => {
    const service = serviceRef.current;
    if (!service || turnInFlightRef.current || phaseRef.current !== 'practicing') return;
    if (startingRef.current) return;
    startingRef.current = true;
    setErrorMessage(null);
    setIsPreparing(true);

    const sessionToken = (sessionTokenRef.current += 1);
    turnTokenRef.current += 1;
    restartTokenRef.current += 1;
    turnInFlightRef.current = false;
    completingRef.current = false;

    await disposeVoice();

    try {
      const started = await service.startTransfer();
      if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
      if (!started) {
        setErrorMessage('This task has no transfer variant. You can finish instead.');
        setIsPreparing(false);
        return;
      }
      const session = service.getConversationSession();
      if (!session) {
        throw new Error('The speaking session could not be prepared.');
      }
      sessionRef.current = session;
      const coordinator = createTalkVoiceCoordinator({
        session,
        providerKind: started.isRealAI ? 'gemini' : 'demo',
        isMuted: props?.initialMuted ?? false,
        ...(props?.recorder ? { recorder: props.recorder } : {}),
        ...(props?.sttProvider ? { sttProvider: props.sttProvider } : {}),
        ...(props?.ttsProvider ? { ttsProvider: props.ttsProvider } : {}),
      });
      coordinator.subscribe((status) => {
        if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
        voiceStatusRef.current = status;
        setVoiceStatus(status);
        if (status.errorMessage) setErrorMessage(status.errorMessage);
      });
      coordinatorRef.current = coordinator;
      setTask(started.task);
      setSnapshot(service.getSnapshot());
      setCues(service.getCues());
      setHistory(session.getHistory());
      setComparison(null);
      setRepair(null);
      setRepeatPrompt(null);
      setLastFeedback(null);
      setLastTranscript(null);

      const openingText = session.getHistory().at(-1)?.content ?? '';
      if (openingText.trim().length > 0 && !coordinator.getStatus().isMuted) {
        void coordinator.speakResponse(openingText);
      }
    } catch (error) {
      if (unmountedRef.current || sessionTokenRef.current !== sessionToken) return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not prepare the transfer task. Please try again.',
      );
    } finally {
      setIsPreparing(false);
      startingRef.current = false;
    }
  }, [
    disposeVoice,
    props?.initialMuted,
    props?.recorder,
    props?.sttProvider,
    props?.ttsProvider,
  ]);

  /* ------------------------------ complete ----------------------------- */

  const handleCompletePractice = useCallback(async (): Promise<void> => {
    if (completingRef.current || phaseRef.current === 'finalizing') return;
    const service = serviceRef.current;
    if (!service) return;

    // SYNCHRONOUS REFUSAL before any teardown: finishing must never destroy
    // an in-flight attempt or recording.
    const voiceBusy =
      voiceStatusRef.current.isProcessing === true ||
      voiceStatusRef.current.state === 'recording' ||
      voiceStatusRef.current.state === 'transcribing' ||
      voiceStatusRef.current.state === 'sending' ||
      voiceStatusRef.current.state === 'requesting_permission';
    if (isSubmitting || turnInFlightRef.current || service.hasActiveAttempt() || voiceBusy) {
      setErrorMessage(FINISH_BLOCKED);
      return;
    }

    const token = restartTokenRef.current;
    completingRef.current = true;
    turnTokenRef.current += 1;
    setIsSubmitting(false);
    setStreamingText(null);
    setErrorMessage(null);
    updatePhase('finalizing');

    try {
      await disposeVoice();
      const completed = await service.complete();
      if (unmountedRef.current || restartTokenRef.current !== token) return;
      setSummary(completed);
      setSnapshot(null);
      setHistory([]);
      setLastFeedback(null);
      setComparison(null);
      setRepair(null);
      updatePhase('summary');
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
  }, [disposeVoice, isSubmitting, updatePhase]);

  const handlePracticeAgain = useCallback(async (): Promise<void> => {
    const token = (restartTokenRef.current += 1);
    const service = serviceRef.current;
    completingRef.current = false;
    turnInFlightRef.current = false;
    turnTokenRef.current += 1;
    sessionTokenRef.current += 1;
    await disposeVoice();
    try {
      await service?.dispose();
    } catch {
      // Disposal failures are non-destructive.
    }
    if (unmountedRef.current || restartTokenRef.current !== token) return;

    sessionRef.current = null;
    setSummary(null);
    setSnapshot(null);
    setHistory([]);
    setTask(null);
    setCues(null);
    setLastFeedback(null);
    setLastTranscript(null);
    setComparison(null);
    setRepair(null);
    setRepeatPrompt(null);
    setStreamingText(null);
    setInputText('');
    setErrorMessage(null);
    setVoiceStatus(VOICE_IDLE_STATUS);
    voiceStatusRef.current = VOICE_IDLE_STATUS;
    // A disposed fluency service cannot start new tasks: compose is owned by
    // the caller, so "again" needs a fresh service. When the service was
    // injected (tests/embedding) the caller re-injects; otherwise reload.
    if (!props?.service) {
      serviceRef.current = null;
      try {
        const fresh = await (props?.loadService ?? createDefaultFluencyService)();
        if (unmountedRef.current || restartTokenRef.current !== token) return;
        serviceRef.current = fresh;
        setTasks(fresh.listTasks());
      } catch (error) {
        if (unmountedRef.current || restartTokenRef.current !== token) return;
        setLoadMessage(
          error instanceof Error
            ? error.message
            : 'Fluency practice is unavailable right now.',
        );
        updatePhase('loading');
        return;
      }
    } else {
      setTasks(service?.listTasks() ?? []);
    }
    updatePhase('task_pick');
  }, [disposeVoice, props?.loadService, props?.service, updatePhase]);

  /* ------------------------------ teardown ----------------------------- */

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      turnTokenRef.current += 1;
      sessionTokenRef.current += 1;
      restartTokenRef.current += 1;
      const coordinator = coordinatorRef.current;
      coordinatorRef.current = null;
      void coordinator?.dispose();
      const service = serviceRef.current;
      void service?.dispose();
    };
  }, []);

  /* ------------------------------- render ------------------------------ */

  const micStatus = describeVoiceTurn(voiceStatus, isSubmitting || isPreparing);
  const turnControls = resolveTalkTurnControls({
    voiceStatus,
    inputText,
    isOpening: isPreparing,
    isSending: isSubmitting,
    isSwitching: false,
    isPreparing: phase === 'loading',
  });
  const showStreaming = isSubmitting && streamingText !== null;
  const isOfflineDemo =
    phase === 'practicing' && snapshot !== null && !snapshot.isRealAI;
  const repairMoves =
    task && snapshot
      ? repairSupportFor(task.kind, snapshot.supportLevel)
      : [];

  if (phase === 'loading') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Fluency practice</Text>
        {loadMessage === null ? (
          <View style={styles.card}>
            <ActivityIndicator />
            <Text style={styles.body}>Preparing your fluency practice…</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Fluency practice is not ready</Text>
            <Text style={styles.body}>{loadMessage}</Text>
          </View>
        )}
      </ScrollView>
    );
  }

  if (phase === 'task_pick') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Fluency practice</Text>
        <Text style={styles.subtitle}>
          Repeat the same speaking task, sustain longer answers, and practise
          recovering when communication breaks down.
        </Text>
        {tasks.map((entry) => (
          <View key={entry.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{entry.title}</Text>
              <View style={styles.pill}>
                <Text style={styles.pillText}>{KIND_LABELS[entry.kind]}</Text>
              </View>
            </View>
            <Text style={styles.body}>{entry.prompt}</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => void handleStartTask(entry.id)}
            >
              <Text style={styles.primaryButtonText}>Start this task</Text>
            </TouchableOpacity>
          </View>
        ))}
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
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
    const trajectory = (summary?.supportTrajectory ?? [])
      .map((level) => SUPPORT_LABELS[level])
      .join(' → ');
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Practice summary</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>What happened</Text>
          <Text style={styles.body}>
            {summary
              ? `You completed ${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'} of “${summary.taskTitle}”.`
              : 'This practice is finished.'}
          </Text>
          {trajectory.length > 0 ? (
            <Text style={styles.body}>Support: {trajectory}.</Text>
          ) : null}
          {summary ? <Text style={styles.sourceNote}>{summary.notice}</Text> : null}
        </View>

        {(summary?.comparisons ?? []).map((entry) => (
          <View key={`${entry.previousAttempt}-${entry.currentAttempt}`} style={styles.card}>
            <Text style={styles.sectionTitle}>
              Attempt {entry.currentAttempt} compared with attempt {entry.previousAttempt}
            </Text>
            {entry.lines.map((line) => (
              <Text key={line} style={styles.listLine}>
                • {line}
              </Text>
            ))}
          </View>
        ))}

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

  if (!task || !snapshot) return null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{task.title}</Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>{SUPPORT_LABELS[snapshot.supportLevel]}</Text>
            </View>
          </View>
          <Text style={styles.headline}>{task.prompt}</Text>
          <Text style={styles.progressLine}>
            Attempt {snapshot.attemptNumber + 1}
            {snapshot.attemptNumber > 0
              ? ` · ${snapshot.attemptNumber} completed`
              : ' · first try'}
          </Text>
          {repeatPrompt ? (
            <Text style={styles.repeatLine}>{repeatPrompt.text}</Text>
          ) : null}
        </View>

        {isOfflineDemo ? (
          <View style={styles.demoBox}>
            <Text style={styles.demoText}>
              Offline demo tutor: attempts are counted, but nothing is compared
              or saved.
            </Text>
          </View>
        ) : null}

        {cues && !cues.taskOnly ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Support for this attempt</Text>
            {cues.openingIdea ? (
              <Text style={styles.listLine}>• Start: {cues.openingIdea}</Text>
            ) : null}
            {cues.taskPoints.map((point) => (
              <Text key={point.id} style={styles.listLine}>
                • Cover: {point.label}
              </Text>
            ))}
            {cues.targetExpressions.map((expression) => (
              <Text key={expression.expression} style={styles.listLine}>
                • Try: “{expression.expression}” — {expression.meaning}
              </Text>
            ))}
            {cues.sequencingPhrases.length > 0 ? (
              <Text style={styles.listLine}>
                • Link ideas: {cues.sequencingPhrases.join(' ')}
              </Text>
            ) : null}
            {cues.closingPrompt ? (
              <Text style={styles.listLine}>• Finish: {cues.closingPrompt}</Text>
            ) : null}
            {repairMoves.map((move) => (
              <Text key={move.id} style={styles.listLine}>
                • {move.label}: “{move.examples[0]}”
              </Text>
            ))}
          </View>
        ) : null}

        {repair && repair.allowed && repair.prompt ? (
          <View style={styles.repairBox}>
            <Text style={styles.sectionTitle}>Clarification</Text>
            {repair.scripted && repair.practiceLabel ? (
              <Text style={styles.repairLabel}>{repair.practiceLabel}</Text>
            ) : (
              <Text style={styles.repairLabel}>
                The tutor needs clarification — this is real guidance for your next attempt.
              </Text>
            )}
            <Text style={styles.body}>{repair.prompt}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          {history.length === 0 && !showStreaming ? (
            <Text style={styles.body}>
              {isPreparing
                ? 'The coach is opening the task…'
                : 'Tap the microphone and begin the task.'}
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

        {comparison && comparison.lines.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>
              Attempt {comparison.currentAttempt} compared with attempt{' '}
              {comparison.previousAttempt}
            </Text>
            {comparison.lines.map((line) => (
              <Text key={line} style={styles.listLine}>
                • {line}
              </Text>
            ))}
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
            editable={!isSubmitting && !isPreparing}
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

        <TouchableOpacity style={styles.repeatButton} onPress={handleRepeat}>
          <Text style={styles.repeatButtonText}>Repeat this task</Text>
        </TouchableOpacity>

        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={[styles.completeButton, styles.bottomHalf]}
            onPress={() => void handleTransfer()}
          >
            <Text style={styles.completeButtonText}>Transfer task</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.completeButton, styles.bottomHalf]}
            onPress={() => void handleCompletePractice()}
          >
            <Text style={styles.completeButtonText}>Finish practice</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
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
  screenTitle: { fontSize: 20, fontWeight: '700', color: '#1c1c1e', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#3a3a3c', marginBottom: 12 },
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
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  sizeNote: { fontSize: 12, color: '#8e8e93', marginTop: 2 },
  progressLine: { fontSize: 14, fontWeight: '600', color: '#0a7a3d', marginTop: 4 },
  repeatLine: { fontSize: 14, fontStyle: 'italic', color: '#0a5a2d', marginTop: 6 },
  pill: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
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
  repairBox: {
    backgroundColor: '#eef4ff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#c9d8f5',
  },
  repairLabel: { fontSize: 13, color: '#1c3f7a', marginBottom: 4 },
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
  repeatButton: {
    backgroundColor: '#0b6b3a',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  repeatButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  bottomRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  bottomHalf: { flex: 1 },
  completeButton: {
    borderWidth: 1,
    borderColor: '#0b6b3a',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  completeButtonText: { color: '#0b6b3a', fontSize: 15, fontWeight: '700' },
  linkButton: { alignItems: 'center', paddingVertical: 12 },
  linkText: { fontSize: 13, color: '#6b6b70', textDecorationLine: 'underline' },
  errorText: { fontSize: 13, color: '#b00020', marginBottom: 8 },
});
