/**
 * src/screens/AdaptiveLessonScreen.tsx
 *
 * Mobile-first Adaptive Lesson execution (Phase 2: voice-first).
 *
 * Flow: lesson overview (why + structure) → Start Lesson → step by step →
 * wrap-up → session summary.
 *
 * VOICE-FIRST EXECUTION (Phase 2)
 * - Tutor prompts are spoken through the EXISTING TextToSpeechProvider.
 * - Answers are recorded through the EXISTING recorder, transcribed by the
 *   EXISTING STT provider, shown to the learner and submitted through the
 *   EXISTING AdaptiveLessonService method that owns the item (which delegates
 *   to ReviewService / ListeningService / the conversation stack / the
 *   PronunciationEngine). This screen never evaluates anything itself.
 * - The lifecycle is explicit (Tap to speak → Listening… → Transcribing… →
 *   Checking… → Playing feedback…) and overlapping work is refused: TTS is
 *   stopped before the microphone opens, and text stays available as fallback.
 * - The state machine and the routing live in ../adaptive-lessons/voice, so
 *   this screen only renders and delegates.
 *
 * HONESTY RULES ENFORCED IN THE UI
 * - Every step shows its human-readable reason. General fallback steps are
 *   badged "General practice" and never presented as personalized.
 * - No scores, percentages, bands, XP, streaks, badges or invented durations
 *   are rendered — only real counts ("3 of 5 lesson steps", "2 review items").
 * - Skipping says plainly that it is not counted as practice.
 * - When a sub-system has nothing real to serve, the step shows the honest
 *   "nothing to practice right now" message instead of fake content.
 * - Speaking feedback is only shown when a real AI provider answered; the
 *   screen never invents an evaluation and never falls back to a demo model.
 * - A failed voice action says so and submits nothing: the learner can retry
 *   or type. Listening exercises are only ever played through their own audio;
 *   the hidden transcript is revealed by the existing engine after answering.
 *
 * The screen never touches SQLite: it receives an injected AdaptiveLessonService
 * or awaits the composition factory (which owns the adapter bootstrap).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type {
  AdaptiveLessonProgress,
  AdaptiveLessonService,
  AdaptiveLessonSession,
  AdaptiveLessonStep,
  AdaptiveLessonStepMaterial,
  AdaptiveLessonSubmitOutcome,
  AdaptiveLessonSummary,
  AdaptiveTodayPractice,
} from '../adaptive-lessons';
import { createDefaultAdaptiveLessonService } from '../adaptive-lessons';
import type { DailyTutorActivityRef } from '../daily-tutor';
import { reportDailyTutorCompletion } from '../daily-tutor';
import { buildSpeakingSeed } from '../deep-speaking';
import { useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import {
  createAdaptiveLessonVoiceController,
  isAdaptiveVoiceWorkActive,
  resolveAdaptiveSpeechOutputProvider,
  resolveAdaptiveVoiceInputProviders,
  resolveAdaptiveVoiceTarget,
  VOICE_NAVIGATION_BLOCKED_MESSAGE,
  voiceTargetKey,
} from '../adaptive-lessons/voice';
import type {
  AdaptiveLessonVoiceController,
  AdaptiveVoiceStatus,
  AdaptiveVoiceTarget,
} from '../adaptive-lessons/voice';
import type { EvaluationResult, ReviewItemCandidate } from '../review/types';
import type { ListeningEvaluation, ListeningExercise } from '../listening/types';
import type {
  AudioRecorderService,
  SpeechToTextProvider,
  TextToSpeechProvider,
} from '../talk-demo';

export interface AdaptiveLessonScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: AdaptiveLessonService;
  /** Injectable TTS — the EXISTING provider abstraction (no second voice stack). */
  readonly ttsProvider?: TextToSpeechProvider;
  /** Injectable recorder + STT for speaking/pronunciation voice input. */
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  /** Route params (when pushed through the navigator by the Daily Tutor). */
  readonly route?: {
    readonly params?: {
      /**
       * Daily Tutor completion handshake ref. Present ONLY when the Daily
       * Tutor launched this lesson; standalone use never sets it and is
       * completely unchanged.
       */
      readonly dailyTutor?: DailyTutorActivityRef;
    };
  };
}

type Phase = 'loading' | 'overview' | 'running' | 'complete';

interface ItemFeedback {
  readonly lines: readonly string[];
  readonly detail?: string;
}

const RESULT_LABELS: Record<EvaluationResult['result'], string> = {
  correct: 'Correct',
  partial: 'Partly there',
  incorrect: 'Needs work',
};

const LISTENING_RESULT_LABELS: Record<ListeningEvaluation['result'], string> = {
  understood: 'Understood',
  mostly_understood: 'Mostly understood',
  partial: 'Partial',
  missed_key_meaning: 'Missed the key meaning',
  misunderstood: 'Misunderstood',
  insufficient_evidence: 'Not enough evidence',
};

const VOICE_NOT_READY_NOTICE =
  'Voice answers are not available right now. You can type your answer instead.';

export default function AdaptiveLessonScreen(props?: AdaptiveLessonScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  // Daily Tutor handshake: present only when the Daily Tutor launched this
  // lesson. The real completion report happens in finishLesson — opening this
  // screen never completes anything.
  const dailyTutorRef = props?.route?.params?.dailyTutor;
  const [phase, setPhase] = useState<Phase>('loading');
  const [practice, setPractice] = useState<AdaptiveTodayPractice | null>(null);
  const [session, setSession] = useState<AdaptiveLessonSession | null>(null);
  const [material, setMaterial] = useState<AdaptiveLessonStepMaterial | null>(null);
  const [progress, setProgress] = useState<AdaptiveLessonProgress | null>(null);
  const [summary, setSummary] = useState<AdaptiveLessonSummary | null>(null);
  const [answer, setAnswer] = useState<string>('');
  const [itemIndex, setItemIndex] = useState<number>(0);
  const [itemFeedback, setItemFeedback] = useState<ItemFeedback | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<AdaptiveVoiceStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const serviceRef = useRef<AdaptiveLessonService | null>(props?.service ?? null);
  const voiceRef = useRef<AdaptiveLessonVoiceController | null>(null);
  const voiceBuildRef = useRef<Promise<AdaptiveLessonVoiceController | null> | null>(null);
  const voiceUnsubscribeRef = useRef<(() => void) | null>(null);
  const voiceTargetRef = useRef<AdaptiveVoiceTarget | null>(null);

  /** Which EXISTING submission path the item on screen uses. */
  const voiceTarget = useMemo(
    () => resolveAdaptiveVoiceTarget(material, itemIndex),
    [material, itemIndex],
  );

  /* ------------------------- service bootstrap ------------------------- */

  useEffect(() => {
    if (serviceRef.current) return;
    let active = true;
    createDefaultAdaptiveLessonService()
      .then((service) => {
        if (active) serviceRef.current = service;
      })
      .catch(() => {
        if (active) {
          setErrorMessage('Your adaptive lesson could not be loaded. Nothing was changed.');
          setPhase('overview');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const syncProgress = useCallback(() => {
    const service = serviceRef.current;
    if (!service) return;
    setProgress(service.getProgress());
  }, []);

  const openStep = useCallback(
    async (targetSession: AdaptiveLessonSession) => {
      const service = serviceRef.current;
      if (!service) return;
      setIsBusy(true);
      setErrorMessage(null);
      setNotice(null);
      try {
        const stepMaterial = await service.prepareStep();
        setMaterial(stepMaterial);
        setSession(service.getCurrentSession() ?? targetSession);
        setAnswer('');
        setItemIndex(0);
        setItemFeedback(null);
        syncProgress();
        setPhase('running');
      } catch {
        setErrorMessage('This step could not be prepared. You can skip it and continue.');
      } finally {
        setIsBusy(false);
      }
    },
    [syncProgress],
  );

  const finishLesson = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    setIsBusy(true);
    try {
      const finished = await service.completeLesson();
      if (finished) {
        setSummary(finished.summary);
        setSession(finished.session);
        syncProgress();
        setPhase('complete');
        // Daily Tutor handshake: report the REAL completion (the lesson's own
        // summary), only when the Daily Tutor launched this lesson. The real
        // practiced-item count travels with it; a zero-practice finish is
        // reported honestly as such and completes nothing.
        if (dailyTutorRef) {
          reportDailyTutorCompletion({
            ref: dailyTutorRef,
            completedAt: finished.summary.completedAt,
            itemsPracticed: finished.summary.itemsPracticed,
          });
        }
      }
    } catch {
      setErrorMessage('The lesson summary could not be saved. Your practice itself was kept.');
    } finally {
      setIsBusy(false);
    }
  }, [dailyTutorRef, syncProgress]);

  /** Load Today's Practice (or resume an unfinished in-memory lesson). */
  const loadPractice = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    setPhase('loading');
    setErrorMessage(null);
    try {
      const resumable = service.getCurrentSession();
      if (resumable) {
        setSession(resumable);
        syncProgress();
        await openStep(resumable);
        return;
      }
      const today = await service.getTodayPractice();
      setPractice(today);
      setPhase('overview');
    } catch {
      setErrorMessage('Your adaptive lesson could not be prepared. Nothing was changed.');
      setPhase('overview');
    }
  }, [openStep, syncProgress]);

  useEffect(() => {
    if (!serviceRef.current) {
      // Wait for the composition factory (or the injected service) to exist.
      const timer = setInterval(() => {
        if (serviceRef.current) {
          clearInterval(timer);
          void loadPractice();
        }
      }, 60);
      return () => clearInterval(timer);
    }
    void loadPractice();
    return undefined;
  }, [loadPractice]);

  /* ---------------------- voice-first execution ----------------------- */

  /**
   * Build the voice controller lazily on the EXISTING providers.
   *
   * No new voice stack and no demo fallback: with no real speech provider the
   * controller reports that voice input is unavailable and the learner keeps
   * the text fallback — nothing is ever fabricated.
   */
  const ensureVoiceController = useCallback(async (): Promise<AdaptiveLessonVoiceController | null> => {
    const service = serviceRef.current;
    if (!service) return null;
    if (voiceRef.current) return voiceRef.current;
    if (voiceBuildRef.current) return voiceBuildRef.current;

    let input: { recorder: AudioRecorderService; stt: SpeechToTextProvider } | null = null;
    if (props?.recorder && props?.sttProvider) {
      input = { recorder: props.recorder, stt: props.sttProvider };
    } else {
      try {
        const talkDemo = await import('../talk-demo');
        input = resolveAdaptiveVoiceInputProviders({
          getApiKey: () => talkDemo.getGeminiApiKey(),
          createRecorder: () => props?.recorder ?? talkDemo.createExpoAudioRecorder(),
          createStt: (apiKey) => talkDemo.createGeminiSTTProvider({ apiKey }),
        });
      } catch {
        input = null;
      }
    }

    let tts: TextToSpeechProvider | null = props?.ttsProvider ?? null;
    if (!tts) {
      try {
        const talkDemo = await import('../talk-demo');
        tts = resolveAdaptiveSpeechOutputProvider(() => talkDemo.createExpoTTSProvider());
      } catch {
        tts = null;
      }
    }

    const build = (async () => {
      const controller = createAdaptiveLessonVoiceController({
        service,
        ...(input ? { recorder: input.recorder, stt: input.stt } : {}),
        ...(tts ? { tts } : {}),
      });
      controller.setTarget(voiceTargetRef.current);
      voiceRef.current = controller;
      setVoiceStatus(controller.getStatus());
      voiceUnsubscribeRef.current = controller.subscribe(setVoiceStatus);
      return controller;
    })();

    voiceBuildRef.current = build;
    try {
      return await build;
    } finally {
      voiceBuildRef.current = null;
    }
  }, [props?.recorder, props?.sttProvider, props?.ttsProvider]);

  /**
   * Keep the controller pointed at the item on screen, and build it as soon as
   * a voice-capable item appears so the voice affordance (and the honest
   * availability of the speech providers) is known before the first tap.
   */
  useEffect(() => {
    voiceTargetRef.current = voiceTarget;
    voiceRef.current?.setTarget(voiceTarget);
    if (voiceTarget && !voiceRef.current) {
      void ensureVoiceController();
    }
  }, [ensureVoiceController, voiceTarget]);

  /**
   * True while the learner's own voice answer is being recorded, transcribed or
   * checked — derived from the controller's real lifecycle.
   */
  const voiceWorkActive = voiceStatus !== null && isAdaptiveVoiceWorkActive(voiceStatus);

  /**
   * Refuse any action that would change the current item/step while a voice
   * answer is in flight: the learner must finish it (or cancel the recording)
   * first. The handlers are guarded — not only the buttons — so a press that
   * slips through React's render timing still cannot move the lesson on.
   */
  const voiceNavigationAllowed = useCallback((): boolean => {
    if (!isAdaptiveVoiceWorkActive(voiceRef.current?.getStatus() ?? null)) return true;
    setNotice(VOICE_NAVIGATION_BLOCKED_MESSAGE);
    return false;
  }, []);

  /** Leaving the lesson must never leave audio playing or a microphone open. */
  useEffect(
    () => () => {
      voiceUnsubscribeRef.current?.();
      voiceUnsubscribeRef.current = null;
      const controller = voiceRef.current;
      voiceRef.current = null;
      if (controller) void controller.dispose();
    },
    [],
  );

  /**
   * Map an outcome from the OWNING engine to the visible feedback. Shared by
   * the text path and the voice path so both show exactly the same result.
   */
  const applyOutcome = useCallback(
    (outcome: AdaptiveLessonSubmitOutcome | null) => {
      if (!outcome) return;
      switch (outcome.result.kind) {
        case 'review': {
          const evaluation = outcome.result.evaluation;
          const lines: string[] = [RESULT_LABELS[evaluation.result] ?? evaluation.result];
          if (evaluation.feedback) lines.push(evaluation.feedback);
          setItemFeedback({
            lines,
            detail: [
              evaluation.suggestedCorrection ? `Try: ${evaluation.suggestedCorrection}` : null,
              evaluation.explanation ?? null,
              outcome.result.persistenceError
                ? 'This answer was checked, but it could not be saved to your history.'
                : null,
            ]
              .filter((entry): entry is string => Boolean(entry))
              .join('\n'),
          });
          break;
        }
        case 'listening': {
          const evaluation = outcome.result.evaluation;
          const lines: string[] = [
            LISTENING_RESULT_LABELS[evaluation.result] ?? evaluation.result,
            ...evaluation.feedbackLines,
          ];
          // The transcript is revealed only now — after a real answer.
          if (evaluation.revealedTranscript) lines.push(`Heard: "${evaluation.revealedTranscript}"`);
          setItemFeedback({
            lines,
            detail: evaluation.evaluatedBy === 'unavailable'
              ? 'This answer could not be evaluated right now.'
              : outcome.result.persistenceError
                ? 'Checked, but it could not be saved to your history.'
                : undefined,
          });
          break;
        }
        case 'pronunciation': {
          setItemFeedback({
            lines: outcome.result.lines,
            detail: outcome.result.unavailable
              ? 'Not evaluated — pronunciation analysis was unavailable for this attempt.'
              : outcome.result.observationsDetected > 0
                ? `${outcome.result.observationsDetected} observation(s) added to your pronunciation history.`
                : 'No new pronunciation observation was needed for this attempt.',
          });
          break;
        }
        case 'speaking': {
          setItemFeedback({
            lines: outcome.result.feedback.lines,
            detail:
              outcome.result.feedback.evaluatedBy === 'unavailable'
                ? 'Not evaluated — no AI feedback was available for this answer.'
                : outcome.result.feedback.reply,
          });
          break;
        }
        case 'none':
        default:
          setNotice(outcome.result.message);
          break;
      }
      setSession(outcome.session);
      syncProgress();
    },
    [syncProgress],
  );

  /* ------------------------------ actions ------------------------------ */

  const handleStart = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || isBusy) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const started = await service.startLesson();
      if (started.status !== 'started' || !started.session) {
        setErrorMessage(started.message);
        setPhase('overview');
        return;
      }
      setSession(started.session);
      await openStep(started.session);
    } catch {
      setErrorMessage('The lesson could not start. Nothing was changed.');
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, openStep]);

  const currentStep: AdaptiveLessonStep | null = (() => {
    if (!session || !material) return null;
    return session.plan.steps.find((step) => step.id === material.step.id) ?? null;
  })();

  /** Play / replay the task audio through the EXISTING TTS provider. */
  const handlePlayPrompt = useCallback(async () => {
    const controller = await ensureVoiceController();
    if (!controller) {
      setNotice('Audio playback is not available right now. You can still read the task.');
      return;
    }
    setNotice(null);
    const result = await controller.playPrompt();
    if (!result.ok) setNotice(result.message);
  }, [ensureVoiceController]);

  /**
   * Primary voice action: tap to speak, tap again to send.
   * A voice failure (permission, recording, transcription, unavailable
   * provider) submits nothing and leaves the learner free to retry or type.
   */
  const handleVoiceAnswer = useCallback(async () => {
    const controller = await ensureVoiceController();
    if (!controller) {
      setNotice(VOICE_NOT_READY_NOTICE);
      return;
    }
    setErrorMessage(null);
    if (controller.getStatus().state === 'recording') {
      setNotice(null);
      // Remember which item this answer belongs to: a result that arrives after
      // the lesson moved on must never be shown as the new item's feedback.
      const requestedKey = voiceTargetRef.current ? voiceTargetKey(voiceTargetRef.current) : null;
      const result = await controller.stopRecordingAndSubmit();
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      const activeKey = voiceTargetRef.current ? voiceTargetKey(voiceTargetRef.current) : null;
      if (requestedKey !== activeKey) {
        // The controller already refused to submit anything for the new item;
        // only the session snapshot is refreshed, never stale feedback.
        if (result.outcome) {
          setSession(result.outcome.session);
          syncProgress();
        }
        setNotice(
          'That answer was for the previous item, so it was not counted here. Nothing was saved.',
        );
        return;
      }
      // The transcript is shown to the learner and the feedback comes from the
      // owning engine; nothing is invented here.
      setAnswer(result.transcript);
      applyOutcome(result.outcome);
      return;
    }
    const started = await controller.startRecording();
    if (!started.ok) setNotice(started.message);
  }, [applyOutcome, ensureVoiceController]);

  /**
   * Explicitly abandon the current recording. The learner must always be able
   * to get back to text without sending anything.
   */
  const handleCancelVoiceAnswer = useCallback(async () => {
    const controller = voiceRef.current;
    if (!controller) return;
    await controller.cancelRecording();
    setNotice('Recording cancelled — nothing was sent.');
  }, []);

  /** Speak the feedback that the owning engine already produced. */
  const handlePlayFeedback = useCallback(async () => {
    if (!itemFeedback) return;
    const controller = await ensureVoiceController();
    if (!controller) {
      setNotice('Audio playback is not available right now. You can read the feedback below.');
      return;
    }
    const result = await controller.speakFeedback(itemFeedback.lines);
    if (!result.ok) setNotice(result.message);
  }, [ensureVoiceController, itemFeedback]);

  /* ------------------------- per-kind submissions ------------------------ */

  const handleSubmitReview = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'review' || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    const candidate: ReviewItemCandidate | undefined = material.candidates[itemIndex];
    if (!candidate) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const outcome = await service.submitReviewAnswer(candidate.id, answer, currentStep.id);
      if (!outcome || outcome.result.kind === 'none') {
        setErrorMessage(outcome?.result.kind === 'none' ? outcome.result.message : 'Could not check that answer.');
        return;
      }
      applyOutcome(outcome);
    } catch {
      setErrorMessage('That answer could not be checked right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, applyOutcome, currentStep, isBusy, itemIndex, material, voiceNavigationAllowed]);

  const handleSubmitListening = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'listening' || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    const exercise: ListeningExercise | undefined = material.exercises[itemIndex];
    if (!exercise) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      // The replay count from the voice layer is preserved where the existing
      // API supports it: the same counter the voice submission uses is passed
      // here, so a typed answer still records how often the audio was played.
      const replayCount = voiceRef.current?.getStatus().replayCount;
      const outcome = await service.submitListeningAnswer(
        exercise.id,
        answer,
        currentStep.id,
        replayCount,
      );
      if (!outcome || outcome.result.kind === 'none') {
        setErrorMessage(outcome?.result.kind === 'none' ? outcome.result.message : 'Could not check that answer.');
        return;
      }
      applyOutcome(outcome);
    } catch {
      setErrorMessage('That answer could not be checked right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, applyOutcome, currentStep, isBusy, itemIndex, material, voiceNavigationAllowed]);

  const handleSubmitPronunciation = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'pronunciation' || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    if (!answer.trim()) {
      setNotice('Say the target, then type or record what you said.');
      return;
    }
    setIsBusy(true);
    setErrorMessage(null);
    try {
      // The EXISTING engine decides what counts as evidence — qualitative only.
      const outcome = await service.submitPronunciationAttempt(answer, currentStep.id);
      if (!outcome) return;
      if (outcome.result.kind === 'none') {
        setNotice(outcome.result.message);
        setSession(outcome.session);
        syncProgress();
        return;
      }
      applyOutcome(outcome);
    } catch {
      setErrorMessage('That attempt could not be analyzed right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, applyOutcome, currentStep, isBusy, material, syncProgress, voiceNavigationAllowed]);

  const handleSubmitSpeaking = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    if (!answer.trim()) {
      setNotice('Type or record an answer first.');
      return;
    }
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const outcome = await service.submitSpeakingAnswer(answer, currentStep.id);
      if (!outcome) return;
      if (outcome.result.kind === 'none') {
        setNotice(outcome.result.message);
        setSession(outcome.session);
        syncProgress();
        return;
      }
      applyOutcome(outcome);
    } catch {
      setErrorMessage('Your answer could not be sent. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, applyOutcome, currentStep, isBusy, syncProgress, voiceNavigationAllowed]);

  const handleCompleteStep = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      await service.completeStep(currentStep.id);
      syncProgress();
      const afterProgress = service.getProgress();
      if (afterProgress?.isComplete) {
        await finishLesson();
        return;
      }
      await openStep(session ?? (service.getCurrentSession() as AdaptiveLessonSession));
    } catch {
      setErrorMessage('This step could not be completed. You can skip it and continue.');
    } finally {
      setIsBusy(false);
    }
  }, [currentStep, finishLesson, isBusy, openStep, session, syncProgress, voiceNavigationAllowed]);

  /** Move to the next item inside a step, or complete the step. */
  const handleNextItem = useCallback(() => {
    if (!voiceNavigationAllowed()) return;
    if (material?.kind === 'review' && itemIndex + 1 < material.candidates.length) {
      setItemIndex(itemIndex + 1);
      setAnswer('');
      setItemFeedback(null);
      return;
    }
    if (material?.kind === 'listening' && itemIndex + 1 < material.exercises.length) {
      setItemIndex(itemIndex + 1);
      setAnswer('');
      setItemFeedback(null);
      return;
    }
    void handleCompleteStep();
  }, [handleCompleteStep, itemIndex, material, voiceNavigationAllowed]);

  const handleSkipStep = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
    if (!voiceNavigationAllowed()) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      // A skip is recorded as a skip: no counts, no weakness change, no review.
      await service.skipStep(currentStep.id);
      syncProgress();
      const afterProgress = service.getProgress();
      if (afterProgress?.isComplete) {
        await finishLesson();
        return;
      }
      await openStep(session ?? (service.getCurrentSession() as AdaptiveLessonSession));
    } catch {
      setErrorMessage('This step could not be skipped.');
    } finally {
      setIsBusy(false);
    }
  }, [currentStep, finishLesson, isBusy, openStep, session, syncProgress, voiceNavigationAllowed]);

  const handleRetry = useCallback(() => {
    void loadPractice();
  }, [loadPractice]);

  /* ------------------------------ rendering ----------------------------- */

  /**
   * Provenance chip. A step planned from one persisted weakness may only claim
   * "From your history" while the item actually served is that target; when the
   * service honestly degraded the step, the chip says so instead.
   */
  const renderBadge = (step: AdaptiveLessonStep) => {
    const degraded = material?.kind === 'review' && material.targetMatched === false;
    const fromHistory = step.personalized && !degraded;
    return (
      <View style={[styles.pill, fromHistory ? styles.pillPersonal : styles.pillGeneral]}>
        <Text style={styles.pillText}>
          {fromHistory
            ? 'From your history'
            : degraded
              ? 'Other real practice'
              : 'General practice'}
        </Text>
      </View>
    );
  };

  /**
   * Voice controls for the current item: play the task (EXISTING TTS) and the
   * one primary voice answer action, which always shows its real state.
   */
  const renderVoiceControls = () => {
    const target = voiceTarget;
    if (!target) return null;
    const status = voiceStatus;
    const choiceBased = target.kind === 'listening' && target.choiceBased;
    const playLabel =
      target.kind === 'listening'
        ? status && status.replayCount > 0
          ? 'Replay'
          : 'Play audio'
        : target.kind === 'pronunciation'
          ? 'Play the target'
          : 'Play prompt';
    // One answer per item: once the owning engine has judged this item, the
    // learner moves on with the step buttons instead of answering again.
    const voiceAnswerAvailable = !choiceBased && !itemFeedback;
    const micDisabled =
      isBusy ||
      !status ||
      status.state === 'transcribing' ||
      status.state === 'submitting' ||
      (status.state !== 'recording' && !status.canStartRecording);
    const playDisabled = isBusy || !status || !status.canPlayPrompt;

    return (
      <View>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => void handlePlayPrompt()}
          disabled={playDisabled}
        >
          <Text style={styles.secondaryButtonText}>{playLabel}</Text>
        </TouchableOpacity>
        {voiceAnswerAvailable ? (
          <TouchableOpacity
            style={styles.voiceButton}
            onPress={() => void handleVoiceAnswer()}
            disabled={micDisabled}
          >
            <Text style={styles.voiceButtonText}>
              {status ? status.label : 'Tap to speak'}
            </Text>
          </TouchableOpacity>
        ) : null}
        {status?.state === 'recording' ? (
          <TouchableOpacity style={styles.linkButton} onPress={() => void handleCancelVoiceAnswer()}>
            <Text style={styles.linkButtonText}>Cancel voice answer</Text>
          </TouchableOpacity>
        ) : null}
        {status && status.state !== 'idle' && status.hint ? (
          <Text style={styles.voiceHint}>{status.hint}</Text>
        ) : null}
        {choiceBased ? (
          <Text style={styles.honestNote}>
            This exercise is answered by choosing an option, so listening stays
            choice-based.
          </Text>
        ) : !status || !status.voiceInputAvailable ? (
          <Text style={styles.honestNote}>
            Spoken answers need a configured speech provider. You can type your
            answer below instead.
          </Text>
        ) : null}
      </View>
    );
  };

  const renderOverview = () => {
    if (!practice || practice.status !== 'ready') {
      return (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Today&apos;s Practice</Text>
          <Text style={styles.body}>
            {practice ? practice.message : (errorMessage ?? 'Your lesson could not be prepared.')}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={handleRetry} disabled={isBusy}>
            <Text style={styles.primaryButtonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const plan = practice.plan;
    return (
      <View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Today&apos;s Practice</Text>
          <Text style={styles.headline}>{practice.headline}</Text>
          <View style={styles.pillRow}>
            <View style={[styles.pill, plan.sourceMode === 'general' ? styles.pillGeneral : styles.pillPersonal]}>
              <Text style={styles.pillText}>
                {plan.sourceMode === 'personalized'
                  ? 'Personalized'
                  : plan.sourceMode === 'mixed'
                    ? 'Partly personalized'
                    : 'General practice'}
              </Text>
            </View>
            <View style={styles.pill}>
              <Text style={styles.pillText}>
                {plan.sizeLabel === 'short' ? 'Short lesson' : 'Standard lesson'} · {practice.stepCount} steps
              </Text>
            </View>
          </View>
          <Text style={styles.sourceNote}>{plan.sourceNote}</Text>
        </View>

        {practice.focusLines.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Focus</Text>
            {practice.focusLines.map((line) => (
              <Text key={line} style={styles.listLine}>
                • {line}
              </Text>
            ))}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Planned structure</Text>
          {plan.steps.map((step, index) => (
            <View key={step.id} style={styles.structureRow}>
              <Text style={styles.structureIndex}>{index + 1}.</Text>
              <View style={styles.structureBody}>
                <Text style={styles.structureTitle}>{step.title}</Text>
                <Text style={styles.structureReason}>{step.reason.message}</Text>
              </View>
            </View>
          ))}
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={handleStart} disabled={isBusy}>
          <Text style={styles.primaryButtonText}>
            {practice.resume ? `Continue lesson (step ${practice.resume.stepNumber} of ${practice.resume.totalSteps})` : 'Start lesson'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderReviewMaterial = () => {
    if (material?.kind !== 'review') return null;
    const candidate = material.candidates[itemIndex];
    if (!candidate) return null;
    return (
      <View>
        <Text style={styles.itemCounter}>
          Item {itemIndex + 1} of {material.candidates.length}
        </Text>
        {material.note ? <Text style={styles.honestNote}>{material.note}</Text> : null}
        <Text style={styles.prompt}>{candidate.prompt}</Text>
        {candidate.contextSentence ? (
          <Text style={styles.context}>&ldquo;{candidate.contextSentence}&rdquo;</Text>
        ) : null}
        {candidate.definition ? <Text style={styles.context}>{candidate.definition}</Text> : null}
        {renderVoiceControls()}
        <TextInput
          style={styles.input}
          value={answer}
          onChangeText={setAnswer}
          placeholder="Type your answer"
          placeholderTextColor="#9a9a9e"
          editable={!itemFeedback}
          multiline
        />
      </View>
    );
  };

  const renderListeningMaterial = () => {
    if (material?.kind !== 'listening') return null;
    const exercise = material.exercises[itemIndex];
    if (!exercise) return null;
    const options = exercise.options ?? [];
    return (
      <View>
        <Text style={styles.itemCounter}>
          Exercise {itemIndex + 1} of {material.exercises.length}
        </Text>
        <Text style={styles.sourceNote}>{material.sourceNote}</Text>
        {renderVoiceControls()}
        {/* The hidden transcript is never shown or spoken before answering. */}
        {exercise.gappedText ? <Text style={styles.prompt}>{exercise.gappedText}</Text> : null}
        {exercise.question ? <Text style={styles.prompt}>{exercise.question}</Text> : null}
        {options.length > 0 && !itemFeedback
          ? options.map((option) => (
              <TouchableOpacity
                key={option}
                style={styles.optionButton}
                onPress={() => setAnswer(option)}
              >
                <Text style={styles.optionText}>{option}</Text>
              </TouchableOpacity>
            ))
          : null}
        <TextInput
          style={styles.input}
          value={answer}
          onChangeText={setAnswer}
          placeholder="Type what you hear, or tap to speak"
          placeholderTextColor="#9a9a9e"
          editable={!itemFeedback}
          multiline
        />
      </View>
    );
  };

  const renderPronunciationMaterial = () => {
    if (material?.kind !== 'pronunciation') return null;
    return (
      <View>
        <Text style={styles.prompt}>Listen and repeat: &ldquo;{material.target}&rdquo;</Text>
        {material.issueLabel ? <Text style={styles.context}>{material.issueLabel}</Text> : null}
        {material.wordExamples.length > 0 ? (
          <Text style={styles.honestNote}>From your history: {material.wordExamples.join(', ')}</Text>
        ) : null}
        {renderVoiceControls()}
        {material.note ? <Text style={styles.honestNote}>{material.note}</Text> : null}
        <TextInput
          style={styles.input}
          value={answer}
          onChangeText={setAnswer}
          placeholder="Say it, then type or record what you said"
          placeholderTextColor="#9a9a9e"
          editable={!itemFeedback}
          multiline
        />
      </View>
    );
  };

  /**
   * OPTIONAL deeper path: start a full Deep Speaking practice on THIS speaking
   * step's own material. The inline speaking step above is unchanged and still
   * works on its own — including when Deep Speaking is unavailable.
   */
  const openFullSpeakingPractice = useCallback(() => {
    if (material?.kind !== 'speaking') return;
    // The seed carries the REAL practice target when the step has one (a word,
    // expression or phrase). The step title is only a display label and is never
    // used as a learning target; when the step has no real target text, the
    // step's own prompt is used, and a step with neither starts a general plan.
    const seed = buildSpeakingSeed({
      stepId: material.step.id,
      targetText: material.step.targetText,
      prompt: material.prompt,
    });
    try {
      navigation.navigate('DeepSpeaking', seed ? { seed } : undefined);
      setNotice(null);
    } catch {
      // No Deep Speaking route in this composition: the inline step stays usable.
      setNotice(
        'Full speaking practice is not available here. You can keep practising in this step.',
      );
    }
  }, [material, navigation]);

  const renderSpeakingMaterial = () => {
    if (material?.kind !== 'speaking') return null;
    return (
      <View>
        <Text style={styles.prompt}>{material.prompt}</Text>
        {material.note ? <Text style={styles.honestNote}>{material.note}</Text> : null}
        {renderVoiceControls()}
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={answer}
          onChangeText={setAnswer}
          placeholder="Type your answer, or tap to speak"
          placeholderTextColor="#9a9a9e"
          editable={!itemFeedback}
          multiline
        />
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={openFullSpeakingPractice}
          disabled={itemFeedback !== null}
        >
          <Text style={styles.secondaryButtonText}>Start full speaking practice</Text>
        </TouchableOpacity>
        <Text style={styles.honestNote}>
          A longer voice-first session with the speaking coach. This step also works on its own.
        </Text>
      </View>
    );
  };

  const renderRunning = () => {
    if (!material || !currentStep) {
      return (
        <View style={styles.card}>
          <Text style={styles.body}>This step is not ready yet.</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={handleRetry} disabled={isBusy}>
            <Text style={styles.primaryButtonText}>Reload lesson</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const stepNumber = session
      ? session.plan.steps.findIndex((step) => step.id === currentStep.id) + 1
      : 1;
    const totalSteps = session?.plan.steps.length ?? 0;
    // An unavailable step has nothing to practice, so it is not "skipped"
    // either: it keeps its honest unavailable status.
    const showSkip =
      currentStep.type !== 'wrap_up' && !itemFeedback && material.kind !== 'unavailable';
    // Recording / transcribing / checking: the lesson must not move on (and the
    // handlers above refuse it too, independently of this render).
    const voiceBusy = voiceWorkActive;

    return (
      <View>
        <View style={styles.card}>
          <Text style={styles.stepCounter}>
            Step {stepNumber} of {totalSteps}
          </Text>
          <Text style={styles.cardTitle}>{currentStep.title}</Text>
          {progress ? <Text style={styles.body}>{progress.label}</Text> : null}
          {renderBadge(currentStep)}
          <Text style={styles.reason}>Why: {currentStep.reason.message}</Text>
        </View>

        <View style={styles.card}>
          {material.kind === 'review' ? renderReviewMaterial() : null}
          {material.kind === 'listening' ? renderListeningMaterial() : null}
          {material.kind === 'pronunciation' ? renderPronunciationMaterial() : null}
          {material.kind === 'speaking' ? renderSpeakingMaterial() : null}

          {material.kind === 'wrap_up' ? (
            <View>
              {material.lines.map((line) => (
                <Text key={line} style={styles.listLine}>
                  • {line}
                </Text>
              ))}
            </View>
          ) : null}

          {material.kind === 'unavailable' ? (
            <View>
              <Text style={styles.body}>{material.message}</Text>
              <Text style={styles.honestNote}>
                Nothing was counted for this step. Continuing only moves you to
                the next step — it is not recorded as completed practice.
              </Text>
            </View>
          ) : null}

          {itemFeedback ? (
            <View style={styles.feedbackBox}>
              {voiceStatus?.transcript ? (
                <Text style={styles.transcriptLine}>
                  You said: &ldquo;{voiceStatus.transcript}&rdquo;
                </Text>
              ) : null}
              {itemFeedback.lines.map((line) => (
                <Text key={line} style={styles.feedbackLine}>
                  {line}
                </Text>
              ))}
              {itemFeedback.detail ? (
                <Text style={styles.feedbackDetail}>{itemFeedback.detail}</Text>
              ) : null}
              {voiceStatus?.speechOutputAvailable ? (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => void handlePlayFeedback()}
                  disabled={isBusy || voiceStatus.speakingFeedback || !voiceStatus.canSpeakFeedback}
                >
                  <Text style={styles.secondaryButtonText}>
                    {voiceStatus.speakingFeedback ? 'Playing feedback…' : 'Hear feedback'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>

        {notice ? <Text style={styles.honestNote}>{notice}</Text> : null}

        {material.kind === 'unavailable' || material.kind === 'wrap_up' ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => void handleCompleteStep()}
            disabled={isBusy || voiceBusy}
          >
            <Text style={styles.primaryButtonText}>
              {material.kind === 'wrap_up' ? 'Finish lesson' : 'Continue'}
            </Text>
          </TouchableOpacity>
        ) : itemFeedback ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleNextItem}
            disabled={isBusy || voiceBusy}
          >
            <Text style={styles.primaryButtonText}>
              {(material.kind === 'review' && itemIndex + 1 < material.candidates.length) ||
              (material.kind === 'listening' && itemIndex + 1 < material.exercises.length)
                ? 'Next item'
                : 'Complete step'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => {
              if (material.kind === 'review') void handleSubmitReview();
              else if (material.kind === 'listening') void handleSubmitListening();
              else if (material.kind === 'pronunciation') void handleSubmitPronunciation();
              else void handleSubmitSpeaking();
            }}
            disabled={isBusy || voiceBusy}
          >
            <Text style={styles.primaryButtonText}>
              {voiceBusy
                ? 'Voice answer in progress…'
                : material.kind === 'speaking'
                  ? 'Send answer'
                  : 'Check answer'}
            </Text>
          </TouchableOpacity>
        )}

        {showSkip ? (
          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => void handleSkipStep()}
            disabled={isBusy || voiceBusy}
          >
            <Text style={styles.linkButtonText}>Skip this step</Text>
          </TouchableOpacity>
        ) : null}
        {showSkip ? (
          <Text style={styles.honestNote}>
            {voiceBusy
              ? VOICE_NAVIGATION_BLOCKED_MESSAGE
              : 'Skipping is recorded as a skip — it does not count as practice and changes nothing.'}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderComplete = () => (
    <View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Lesson complete</Text>
        {(summary?.lines ?? []).map((line) => (
          <Text key={line} style={styles.listLine}>
            • {line}
          </Text>
        ))}
        {summary && !summary.persistedProgress && summary.itemsPracticed > 0 ? (
          <Text style={styles.honestNote}>
            Your practice could not be saved to your progress history right now.
            The practice itself was still recorded by each engine.
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => {
          setSummary(null);
          setMaterial(null);
          setSession(null);
          void loadPractice();
        }}
        disabled={isBusy}
      >
        <Text style={styles.primaryButtonText}>Back to Today&apos;s Practice</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {phase === 'loading' ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator />
          <Text style={styles.body}>Preparing your lesson from your own practice history…</Text>
        </View>
      ) : null}
      {errorMessage && phase !== 'loading' ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {phase === 'overview' ? renderOverview() : null}
      {phase === 'running' ? renderRunning() : null}
      {phase === 'complete' ? renderComplete() : null}
      {isBusy && phase !== 'loading' ? <ActivityIndicator style={styles.spinner} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  loadingBox: { paddingVertical: 40, gap: 12, alignItems: 'center' },
  spinner: { marginTop: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e6e9ef',
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#1c1c1e', marginBottom: 6 },
  headline: { fontSize: 15, color: '#1c1c1e', marginBottom: 8 },
  body: { fontSize: 14, color: '#3a3a3c', marginBottom: 6 },
  sourceNote: { fontSize: 13, color: '#6b6b70', marginTop: 6 },
  reason: { fontSize: 13, color: '#3a3a3c', marginTop: 8, fontStyle: 'italic' },
  honestNote: { fontSize: 12, color: '#6b6b70', marginTop: 8 },
  errorText: { fontSize: 13, color: '#b00020', marginBottom: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  pill: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  pillPersonal: { backgroundColor: '#e3f2e6' },
  pillGeneral: { backgroundColor: '#f1f1f4' },
  pillText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  structureRow: { flexDirection: 'row', marginBottom: 10 },
  structureIndex: { fontSize: 14, color: '#8e8e93', width: 22 },
  structureBody: { flex: 1 },
  structureTitle: { fontSize: 14, fontWeight: '600', color: '#1c1c1e' },
  structureReason: { fontSize: 12, color: '#6b6b70', marginTop: 2 },
  stepCounter: { fontSize: 12, color: '#8e8e93', marginBottom: 2 },
  itemCounter: { fontSize: 12, color: '#8e8e93', marginBottom: 6 },
  prompt: { fontSize: 15, color: '#1c1c1e', marginBottom: 8 },
  context: { fontSize: 14, color: '#3a3a3c', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    color: '#1c1c1e',
    backgroundColor: '#fbfcfe',
    minHeight: 44,
  },
  inputMultiline: { minHeight: 90, textAlignVertical: 'top' },
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
    paddingVertical: 9,
    alignItems: 'center',
    marginBottom: 8,
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  voiceButton: {
    backgroundColor: '#0b6b3a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  voiceButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  voiceHint: { fontSize: 12, color: '#0b6b3a', marginBottom: 6 },
  optionButton: {
    borderWidth: 1,
    borderColor: '#d8dce3',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 6,
    backgroundColor: '#fbfcfe',
  },
  optionText: { fontSize: 14, color: '#1c1c1e' },
  linkButton: { alignItems: 'center', paddingVertical: 10, marginTop: 6 },
  linkButtonText: { fontSize: 14, color: '#6b6b70', textDecorationLine: 'underline' },
  feedbackBox: {
    backgroundColor: '#f3f7f4',
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#dce7df',
  },
  transcriptLine: { fontSize: 13, color: '#4a4a4e', marginBottom: 6, fontStyle: 'italic' },
  feedbackLine: { fontSize: 14, color: '#1c1c1e', marginBottom: 4 },
  feedbackDetail: { fontSize: 13, color: '#4a4a4e', marginTop: 4 },
});
