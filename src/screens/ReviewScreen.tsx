import MicrophoneHelp from './components/MicrophoneHelp';
import TouchableOpacity from './components/LearnerButton';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import type { ReviewService } from '../review/service';
import { createReviewService } from '../review/factory';
import type { ReviewItemCandidate, EvaluationResult, ReviewDashboardSummary } from '../review/types';
import { getAppDatabase } from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerWeakness } from '../domain/models/learner';
import type { DailyTutorReviewLaunch, DailyTutorLaunchState } from '../daily-tutor';
import {
  DAILY_TUTOR_LAUNCH_IDLE,
  beginStandaloneSession,
  captureDailyTutorLaunch,
  clearDailyTutorReturn,
  endDailyTutorVisit,
  finishDailyTutorWorkflow,
  reportDailyTutorCompletion,
} from '../daily-tutor';
import {
  SQLiteUserProfileRepository,
} from '../data/local/sqlite/repositories';
import {
  createExpoAudioRecorder,
  createExpoTTSProvider,
  type AudioRecorderService,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '../talk-demo';
import {
  ReviewVoiceController,
  type ReviewVoiceStatus,
} from '../review/voice-controller';
import { resolveReviewProviders } from '../review/providers';
import { readReviewLearnerProfile } from '../review/profile-guard';
import { DEMO_REVIEW_NOTICE, selectReviewSessionCandidates } from '../review/demo-items';
import { generateId } from '../shared/id';

// Demo practice cards live in the review package (`demo-items`) and are
// reachable ONLY through explicit Demo Mode — never mixed into a real queue.

/**
 * Demo-Mode-only grading of the pre-built practice cards. Clearly advertised
 * demo practice; the result is never persisted as learner evidence.
 */
function evaluateDemoAnswerLocally(
  candidate: ReviewItemCandidate,
  answer: string,
): EvaluationResult {
  const normUser = answer.trim().toLowerCase();
  const normExpected = candidate.expectedAnswer.trim().toLowerCase();
  if (normUser === normExpected) {
    return {
      result: 'correct',
      feedback: 'Excellent! Your answer matches perfectly.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }
  if (normUser.length > 2 && normExpected.includes(normUser)) {
    return {
      result: 'partial',
      feedback: 'Almost! Check the phrasing or spelling.',
      explanation: candidate.explanation,
      suggestedCorrection: candidate.expectedAnswer,
    };
  }
  return {
    result: 'incorrect',
    feedback: 'Not quite. Check the suggested answer.',
    explanation: candidate.explanation,
    suggestedCorrection: candidate.expectedAnswer,
  };
}

export interface ReviewScreenProps {
  readonly initialDemoMode?: boolean;
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  /** Injectable TTS (existing provider) for listening review items. */
  readonly ttsProvider?: TextToSpeechProvider;
}

/**
 * Daily Tutor handshake params (present ONLY when the Daily Tutor launched
 * this tab through the nested MainTabs route; standalone use of the Review
 * tab never sets them): the activity ref to echo back on REAL completion,
 * plus the optional bounded review subset (kind emphasis + item limit) the
 * existing Review planner is conditioned on.
 */
export default function ReviewScreen(props?: ReviewScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const route = useRoute() as { readonly params?: { readonly dailyTutor?: DailyTutorReviewLaunch } };

  /**
   * ONE-SHOT Daily Tutor launch context. React Navigation keeps params
   * attached to a TAB route, so the `dailyTutor` param is captured ONCE
   * into local state and immediately CONSUMED (cleared from the route).
   * The captured context lives only for that child workflow; a later
   * standalone open of this tab has NO Daily Tutor behavior.
   */
  const [dailyLaunch, setDailyLaunch] = useState<DailyTutorLaunchState<DailyTutorReviewLaunch>>(
    DAILY_TUTOR_LAUNCH_IDLE,
  );
  /** Auto-start guard: at most one auto-start per Daily Tutor activity. */
  const dailyAutoStartedRef = useRef<string | null>(null);
  const routeLaunch = route.params?.dailyTutor;
  useEffect(() => {
    if (!routeLaunch) return;
    setDailyLaunch((current) => captureDailyTutorLaunch(current, { dailyTutor: routeLaunch }).state);
    // A fresh Daily Tutor launch may auto-start its bounded workflow, even
    // when the very same activity is relaunched after an abandoned attempt.
    dailyAutoStartedRef.current = null;
    // ONE-SHOT: consume the launch param from the tab route.
    navigation.setParams({ dailyTutor: undefined });
  }, [routeLaunch, navigation]);
  /** The captured context of the ACTIVE Daily Tutor workflow, if any. */
  const dailyTutorRef = dailyLaunch.active;
  // Leaving the tab ends the Daily Tutor VISIT affordance, but an active
  // workflow keeps its captured ref until its real completion.
  useFocusEffect(
    useCallback(() => {
      return () => {
        setDailyLaunch((current) => clearDailyTutorReturn(current));
      };
    }, []),
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(props?.initialDemoMode ?? false);
  const [hasNoProfile, setHasNoProfile] = useState<boolean>(false);
  const [summary, setSummary] = useState<ReviewDashboardSummary>({
    totalDue: 0,
    dueVocabularyCount: 0,
    dueExpressionCount: 0,
    activeWeaknessCount: 0,
    categories: [],
  });
  const [activeWeaknesses, setActiveWeaknesses] = useState<readonly LearnerWeakness[]>([]);

  // Review Session State: 'dashboard' | 'reviewing' | 'completed'
  const [sessionState, setSessionState] = useState<'dashboard' | 'reviewing' | 'completed'>('dashboard');
  const [sessionCandidates, setSessionCandidates] = useState<readonly ReviewItemCandidate[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [userAnswer, setUserAnswer] = useState<string>('');
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [sessionResults, setSessionResults] = useState<{
    correctCount: number;
    partialCount: number;
    incorrectCount: number;
  }>({ correctCount: 0, partialCount: 0, incorrectCount: 0 });
  // Explicit session-planning error (real mode): never masked with fabricated demo data
  const [sessionError, setSessionError] = useState<string | null>(null);

  const reviewServiceRef = useRef<ReviewService | null>(null);
  const dbAdapterRef = useRef<DatabaseAdapter | null>(null);
  const startTimeRef = useRef<number>(0);
  /** Synchronous invalidation token: leaving an item/session makes its work stale. */
  const sessionGenerationRef = useRef<number>(0);
  const currentIndexRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  /** ONE identity per item attempt: a retry reuses it, a new attempt does not. */
  const attemptIdRef = useRef<string | null>(null);
  /** Synchronous single-flight guard for submission (state updates are async). */
  const submitInFlightRef = useRef<boolean>(false);

  // Voice recording and STT refs and state (the EXISTING Review voice controller)
  const voiceRef = useRef<ReviewVoiceController | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<ReviewVoiceStatus>({
    state: 'idle',
    isRecording: false,
    isTranscribing: false,
    isBusy: false,
    isDisposed: false,
    isAvailable: true,
    transcript: '',
    error: null,
  });
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [sessionEmpty, setSessionEmpty] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ttsRef = useRef<TextToSpeechProvider | null>(props?.ttsProvider ?? null);
  const [isPlayingListening, setIsPlayingListening] = useState<boolean>(false);

  const isRecording = voiceStatus.isRecording;
  const isTranscribing = voiceStatus.isTranscribing;
  const recorderError = voiceStatus.error;

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Terminal: synchronously invalidates every in-flight callback, then
      // tears the shared recorder and playback down best-effort.
      voiceRef.current?.dispose();
      voiceRef.current = null;
      void ttsRef.current?.stop().catch(() => undefined);
    };
  }, []);

  /**
   * Voice provider resolution (the EXISTING honest rules): real speech
   * recognition, explicit Demo Mode, or an honest "unavailable" state. A real
   * review never receives a scripted transcript, and Demo Mode can never
   * persist anything.
   */
  useEffect(() => {
    const providers = resolveReviewProviders({
      isDemo: isDemoMode,
      ...(props?.sttProvider ? { sttProvider: props.sttProvider } : {}),
    });
    const controller = new ReviewVoiceController(
      props?.recorder || createExpoAudioRecorder(),
      providers.sttProvider,
      {
        unavailable: providers.kind === 'unavailable',
        unavailableMessage: providers.voiceUnavailableMessage ?? null,
      },
    );
    voiceRef.current = controller;
    setVoiceStatus(controller.getStatus());
    setVoiceNotice(providers.voiceUnavailableMessage ?? null);

    return () => {
      controller.dispose();
      if (voiceRef.current === controller) {
        voiceRef.current = null;
      }
    };
  }, [isDemoMode, props?.recorder, props?.sttProvider]);

  const [loadAttempt, setLoadAttempt] = useState(0);
  // Initialize DB Adapter and ReviewService
  useEffect(() => {
    let active = true;

    async function init() {
      setLoading(true);
      setError(null);
      try {
        // The CANONICAL application database owns the adapter lifecycle: the
        // Review flow never opens its own connection to the same file.
        const { adapter } = await getAppDatabase();
        dbAdapterRef.current = adapter;

        // Use the composition root factory instead of manually building SQLite repositories!
        const service = createReviewService(adapter, isDemoMode);
        reviewServiceRef.current = service;

        if (active) {
          await loadDashboardMetrics();
        }
      } catch (err) {
        console.error('Failed to initialize SQLite Review repositories:', err);
        if (active) {
          setError('Your saved reviews could not be opened. Nothing was reset or changed. Please try again.');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const loadDashboardMetrics = async (demo = isDemoMode) => {
    if (!reviewServiceRef.current) return;
    try {
      setLoading(true);
      setError(null);
      if (demo) {
        // Demo metrics describe the DEMO queue itself (never learner history).
        const demoItems = selectReviewSessionCandidates({ isDemo: true, planned: [] });
        const demoDue = (kind: ReviewItemCandidate['kind']) =>
          demoItems.filter((item) => item.kind === kind).length;
        setSummary({
          totalDue: demoItems.length,
          dueVocabularyCount: demoDue('vocabulary'),
          dueExpressionCount: demoDue('expression'),
          activeWeaknessCount: demoDue('grammar'),
          categories: [
            { key: 'grammar', label: 'Grammar & Phrasing', dueCount: demoDue('grammar') },
            { key: 'vocabulary', label: 'Vocabulary Recall', dueCount: demoDue('vocabulary') },
            { key: 'expression', label: 'Expressions & Idioms', dueCount: demoDue('expression') },
          ],
        });
        setActiveWeaknesses([]);
        setHasNoProfile(false);
        return;
      }

      const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
      const profileOutcome = await readReviewLearnerProfile(profileRepo);
      if (profileOutcome.status === 'missing') {
        // First launch: no profile yet is a NORMAL state, not a load
        // failure. A previous Demo dashboard must never be relabelled as
        // learner history either.
        setSummary({ totalDue: 0, dueVocabularyCount: 0, dueExpressionCount: 0, activeWeaknessCount: 0, categories: [] });
        setActiveWeaknesses([]);
        setHasNoProfile(true);
        return;
      }
      setHasNoProfile(false);
      const learnerId = profileOutcome.learnerId;

      const dashSummary = await reviewServiceRef.current.getDashboardSummary(learnerId);
      const weaknesses = await reviewServiceRef.current.getActiveWeaknesses(learnerId);

      setSummary(dashSummary);
      setActiveWeaknesses(weaknesses);
    } catch (err) {
      console.error('Error loading review dashboard metrics:', err);
      setError('Could not load your saved reviews. This is not an empty queue. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => {
    if (reviewServiceRef.current && sessionState === 'dashboard') void loadDashboardMetrics();
  }, [sessionState, isDemoMode]));

  /**
   * Mic press. The EXISTING ReviewVoiceController owns the lifecycle: one
   * operation at a time, generation-invalidated callbacks, and a transcript
   * that is only ever offered for review (never auto-submitted, never
   * persisted by itself).
   */
  const handleToggleRecording = async () => {
    const controller = voiceRef.current;
    if (!controller || controller.isDisposed) return;
    const status = await controller.toggleRecording();
    if (!mountedRef.current) return;
    setVoiceStatus(status);
    if (status.transcript) {
      setUserAnswer(status.transcript);
    }
  };

  /** Explicit demo toggle: re-composes the service and the voice path. */
  const enableDemoMode = () => {
    setIsDemoMode(true);
    if (dbAdapterRef.current) {
      reviewServiceRef.current = createReviewService(dbAdapterRef.current, true);
    }
    void loadDashboardMetrics(true);
  };

  const leaveDemoMode = () => {
    setIsDemoMode(false);
    if (dbAdapterRef.current) reviewServiceRef.current = createReviewService(dbAdapterRef.current, false);
    void loadDashboardMetrics(false);
  };

  const handleStartSession = async (
    dailyOptions?: { reviewKind?: 'vocabulary' | 'expression' | 'grammar'; reviewLimit?: number },
  ) => {
    // Synchronous invalidation: nothing from a previous session may land here.
    sessionGenerationRef.current += 1;
    attemptIdRef.current = null;
    voiceRef.current?.reset();
    setSaveError(null);
    setSessionEmpty(null);

    if (isDemoMode) {
      // Explicit Demo Mode only: pre-built practice cards, never persisted.
      setSessionCandidates(selectReviewSessionCandidates({ isDemo: true, planned: [] }));
      setCurrentIndex(0);
      setSessionState('reviewing');
      setUserAnswer('');
      setEvaluation(null);
      setSessionResults({ correctCount: 0, partialCount: 0, incorrectCount: 0 });
      startTimeRef.current = Date.now();
      return;
    }

    if (!reviewServiceRef.current) return;
    try {
      setLoading(true);
      setSessionError(null);
      const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
      const profileOutcome = await readReviewLearnerProfile(profileRepo);
      if (profileOutcome.status === 'missing') {
        // First launch: nothing to review yet — the existing no-profile
        // state, never a "could not load the review queue" error and
        // never fabricated items.
        setHasNoProfile(true);
        return;
      }
      const learnerId = profileOutcome.learnerId;

      // Daily Tutor launch: a BOUNDED subset of the existing review queue
      // (the Daily Tutor plans WHAT; this screen still owns HOW the review
      // session runs). Standalone launches keep the existing defaults.
      const limit = dailyOptions?.reviewLimit;
      const candidates = await reviewServiceRef.current.planSession(
        learnerId,
        dailyOptions
          ? { minItems: 1, maxItems: limit ?? 10, targetItems: limit ?? 10 }
          : undefined,
      );
      const bounded = dailyOptions?.reviewKind
        ? candidates.filter((candidate) => candidate.kind === dailyOptions.reviewKind)
        : candidates;
      // Real mode returns EXACTLY the planner output: pre-built demo cards are
      // unreachable here, and an empty queue stays honestly empty.
      const sessionItems = selectReviewSessionCandidates({ isDemo: false, planned: bounded });
      if (sessionItems.length === 0) {
        setSessionCandidates([]);
        setSessionState('dashboard');
        setSessionEmpty(
          'Nothing is due for review right now. Practise in a conversation and the things you struggled with will appear here.',
        );
        return;
      }

      setSessionCandidates(sessionItems);
      setCurrentIndex(0);
      setSessionState('reviewing');
      setUserAnswer('');
      setEvaluation(null);
      setSessionResults({ correctCount: 0, partialCount: 0, incorrectCount: 0 });
      startTimeRef.current = Date.now();
    } catch (err) {
      console.error('Error planning review session:', err);
      // SQLite/planning failure must never fall back to fabricated demo items:
      // surface an explicit error and stay on the dashboard.
      setSessionError('Could not load the review queue. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Daily Tutor launch: when this screen was opened by the Daily Tutor, start
   * its bounded review session automatically (once per activity). The Review
   * flow itself is completely unchanged — this only triggers the existing
   * start handler with the bounded options.
   */
  useEffect(() => {
    if (!dailyTutorRef || isDemoMode) return;
    if (sessionState !== 'dashboard' || loading || hasNoProfile) return;
    if (!reviewServiceRef.current || !dbAdapterRef.current) return;
    if (dailyAutoStartedRef.current === dailyTutorRef.activityId) return;
    dailyAutoStartedRef.current = dailyTutorRef.activityId;
    void handleStartSession({
      reviewKind: dailyTutorRef.reviewKind,
      reviewLimit: dailyTutorRef.reviewLimit,
    });
    // handleStartSession is intentionally not a dependency: the ref guards
    // above make this effect run at most once per Daily Tutor activity.
  }, [dailyTutorRef, sessionState, loading, hasNoProfile, isDemoMode]);

  /**
   * Play a listening review item through the EXISTING TTS provider.
   * Failure-safe: the exercise and the typed answer are never lost.
   */
  const handlePlayListeningItem = async (text: string) => {
    try {
      if (!ttsRef.current) {
        ttsRef.current = createExpoTTSProvider();
      }
      setIsPlayingListening(true);
      await ttsRef.current.speak(text);
      setIsPlayingListening(false);
    } catch {
      setIsPlayingListening(false);
      setError('Audio playback failed. The item text is shown below — you can still answer.');
    }
  };

  const handleSubmitAnswer = async () => {
    const candidate = sessionCandidates[currentIndex];
    if (!candidate || submitInFlightRef.current) return;

    submitInFlightRef.current = true;
    setIsEvaluating(true);
    setSaveError(null);

    const generation = sessionGenerationRef.current;
    const itemIndex = currentIndex;
    // ONE identity per attempt: a retry (double tap, retry after an error)
    // reuses it so the attempt is recorded exactly once.
    const attemptId = attemptIdRef.current ?? generateId();
    attemptIdRef.current = attemptId;

    const isCurrentAttempt = () =>
      mountedRef.current &&
      sessionGenerationRef.current === generation &&
      currentIndexRef.current === itemIndex;

    try {
      let evalResult: EvaluationResult;
      if (isDemoMode || !reviewServiceRef.current) {
        // Explicit demo practice: local comparison only, nothing persisted.
        evalResult = evaluateDemoAnswerLocally(candidate, userAnswer);
      } else {
        evalResult = await reviewServiceRef.current.evaluateAnswer(candidate, userAnswer);
        if (!isCurrentAttempt()) return;

        const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
        const profile = await profileRepo.get();
        if (!isCurrentAttempt()) return;

        if (profile && profile.id) {
          try {
            await reviewServiceRef.current.recordPracticeResult(
              profile.id,
              candidate,
              userAnswer,
              evalResult,
              undefined,
              { attemptId },
            );
          } catch (err) {
            console.error('Error saving review practice result:', err);
            if (isCurrentAttempt()) {
              // Honest: graded, but NOT saved as progress.
              setSaveError('Your answer was graded, but your progress could not be saved.');
            }
          }
        }
        if (!isCurrentAttempt()) return;
      }

      setEvaluation(evalResult);
      setSessionResults((prev) => {
        if (evalResult.result === 'correct') {
          return { ...prev, correctCount: prev.correctCount + 1 };
        } else if (evalResult.result === 'partial') {
          return { ...prev, partialCount: prev.partialCount + 1 };
        } else {
          return { ...prev, incorrectCount: prev.incorrectCount + 1 };
        }
      });
    } catch (err) {
      console.error('Error evaluating answer:', err);
      if (isCurrentAttempt()) {
        setSaveError('That answer could not be graded. Nothing was recorded — please try again.');
      }
    } finally {
      setIsEvaluating(false);
      submitInFlightRef.current = false;
    }
  };

  const handleNextItem = async () => {
    if (currentIndex + 1 < sessionCandidates.length) {
      // Item change: invalidate the finished item's voice work synchronously so
      // a late transcript can never enter the NEXT item.
      voiceRef.current?.reset();
      attemptIdRef.current = null;
      setSaveError(null);
      setCurrentIndex((prev) => prev + 1);
      setUserAnswer('');
      setEvaluation(null);
    } else {
      // Session finished!
      try {
        if (!isDemoMode && reviewServiceRef.current) {
          const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
          const profile = await profileRepo.get();
          if (profile && profile.id) {
            await reviewServiceRef.current.completeSession(profile.id, {
              startedAt: new Date(startTimeRef.current).toISOString(),
              completedAt: new Date().toISOString(),
              totalItems: sessionCandidates.length,
              correctCount: sessionResults.correctCount,
              partialCount: sessionResults.partialCount,
              incorrectCount: sessionResults.incorrectCount,
              masteredCount: sessionResults.correctCount,
              improvedWeaknessCount: sessionResults.correctCount + sessionResults.partialCount,
              items: [],
            });
          }
        }
      } catch (err) {
        console.error('Error completing session in SQLite:', err);
      }
      // Daily Tutor handshake: report the REAL review completion (real mode
      // only — demo items are never real practice). Exiting early never
      // reaches this point, so an unfinished review never completes. The
      // captured launch is ONE-SHOT: once its workflow really completed and
      // reported, it is consumed — a later session in this tab is standalone.
      if (dailyTutorRef && !isDemoMode) {
        reportDailyTutorCompletion({
          ref: {
            sessionId: dailyTutorRef.sessionId,
            activityId: dailyTutorRef.activityId,
            kind: dailyTutorRef.kind,
          },
          completedAt: new Date().toISOString(),
          itemsPracticed: sessionCandidates.length,
        });
        setDailyLaunch((current) => finishDailyTutorWorkflow(current));
      }
      voiceRef.current?.reset();
      attemptIdRef.current = null;
      setSessionState('completed');
    }
  };

  const handleExitSession = () => {
    // Synchronous invalidation BEFORE anything else: in-flight grading or
    // speech recognition from this session can neither land on the dashboard
    // nor persist as evidence after the learner left.
    sessionGenerationRef.current += 1;
    submitInFlightRef.current = false;
    attemptIdRef.current = null;
    voiceRef.current?.reset();
    setIsEvaluating(false);
    setSaveError(null);
    setSessionEmpty(null);
    setSessionState('dashboard');
    // Leaving the session ends any Daily Tutor visit context — later use of
    // this tab is standalone.
    setDailyLaunch((current) => endDailyTutorVisit(current));
    loadDashboardMetrics();
  };

  if (loading && sessionState === 'dashboard') {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Loading your reviews…</Text>
      </View>
    );
  }

  if (error && sessionState === 'dashboard') {
    return (
      <View style={styles.loadingContainer}>
        <Text accessibilityRole="alert" style={[styles.loadingText, { color: '#DC2626' }]}>{error}</Text>
        <TouchableOpacity onPress={() => setLoadAttempt(n => n + 1)} accessibilityLabel="Try loading reviews again"><Text>Try again</Text></TouchableOpacity>
      </View>
    );
  }

  // 1. DASHBOARD VIEW
  if (sessionState === 'dashboard') {
    return (
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          <Text style={styles.title} id="review_title">Review</Text>
          <Text style={styles.subtitle}>Recall saved language and revisit areas that need practice</Text>
        </View>

        {hasNoProfile && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>
              No learning profile yet. Set up your profile to build your own review queue. Or explicitly choose Demo Mode to try sample cards, not real AI.
            </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Onboarding')}><Text>Set up my learning profile</Text></TouchableOpacity>
            <TouchableOpacity
              style={[styles.startSessionButton, { marginTop: 12, backgroundColor: '#059669' }]}
              onPress={enableDemoMode}
            >
              <Text style={styles.startSessionButtonText}>Try Demo Mode · Not real AI</Text>
            </TouchableOpacity>
          </View>
        )}

        {isDemoMode && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>
              Demo Mode · Not real AI. The cards and counts below are samples, not your learner history.
            </Text>
            <Text style={styles.demoBannerText}>{DEMO_REVIEW_NOTICE}</Text>
            <TouchableOpacity onPress={leaveDemoMode}><Text>Leave Demo Mode · Show my reviews</Text></TouchableOpacity>
          </View>
        )}

        {sessionError && !isDemoMode && (
          <View style={styles.sessionErrorBanner}>
            <Text style={styles.sessionErrorBannerText}>⚠️ {sessionError}</Text>
          </View>
        )}

        {sessionEmpty && !isDemoMode && (
          <View style={styles.emptyQueueBanner}>
            <Text style={styles.emptyQueueBannerText}>🗂️ {sessionEmpty}</Text>
          </View>
        )}

        {/* High-Contrast Due Counter Card */}
        <View style={styles.totalDueCard}>
          <Text style={styles.totalDueNumber}>{summary.totalDue}</Text>
          <Text style={styles.totalDueLabel}>Items due for review</Text>
          <Text style={styles.emptyCardText}>Recall language when it is due, so you can use it again. Reviews come from saved items and evaluated practice.</Text>
          <TouchableOpacity
            style={[
              styles.startSessionButton,
              (hasNoProfile && !isDemoMode) && styles.startSessionButtonDisabled
            ]}
            onPress={() => {
              // A user-started session is NEVER the Daily Tutor workflow:
              // clear any lingering launch context, then start normally.
              setDailyLaunch((current) => beginStandaloneSession(current));
              void handleStartSession();
            }}
            disabled={hasNoProfile && !isDemoMode}
            accessibilityRole="button"
            id="start_review_button"
          >
            <Text style={styles.startSessionButtonText}>
              {(hasNoProfile && !isDemoMode) ? 'Waiting for profile...' : summary.totalDue > 0 ? `Start review (up to ${Math.min(10, summary.totalDue)} items)` : 'Check for due reviews'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Summary Breakdown Grid */}
        <Text style={styles.sectionHeader}>Item Type Breakdown</Text>
        <View style={styles.grid}>
          <View style={styles.gridCard}>
            <Text style={styles.gridCardEmoji}>📝</Text>
            <Text style={styles.gridCardValue}>{summary.dueVocabularyCount}</Text>
            <Text style={styles.gridCardLabel}>Vocabulary</Text>
          </View>
          <View style={styles.gridCard}>
            <Text style={styles.gridCardEmoji}>🗣️</Text>
            <Text style={styles.gridCardValue}>{summary.dueExpressionCount}</Text>
            <Text style={styles.gridCardLabel}>Expressions</Text>
          </View>
          <View style={styles.gridCard}>
            <Text style={styles.gridCardEmoji}>🧠</Text>
            <Text style={styles.gridCardValue}>{summary.activeWeaknessCount}</Text>
            <Text style={styles.gridCardLabel}>Areas to practise</Text>
          </View>
        </View>

        {/* Active Weaknesses List */}
        <Text style={styles.sectionHeader}>Priority practice areas</Text>
        {activeWeaknesses.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyCardText}>
              No priority practice areas are recorded here yet. Saved words, expressions and supported observations from real practice can create future reviews. An empty list is not a measurement of your English level.
            </Text>
          </View>
        ) : (
          activeWeaknesses.map((w, idx) => (
            <View key={w.id || idx} style={styles.weaknessCard}>
              <View style={styles.weaknessHeader}>
                <Text style={styles.weaknessCategory}>{w.notes || (w.type === 'grammar' ? 'Grammar Error' : 'Speaking Error')}</Text>
                <View style={[styles.statusBadge, STATUS_BADGE_STYLES[w.status] ?? styles.statusBadge_observed]}>
                  <Text style={styles.statusBadgeText}>{w.status.replace('_', ' ')}</Text>
                </View>
              </View>
              <Text style={styles.weaknessMeta}>
                Severity: {(w.severity * 100).toFixed(0)}% • Practice count: {w.occurrenceCount}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    );
  }

  // 2. ACTIVE REVIEW PRACTICE SESSION VIEW
  if (sessionState === 'reviewing') {
    const candidate = sessionCandidates[currentIndex];
    if (!candidate) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>No review items available at this moment.</Text>
          <TouchableOpacity style={styles.exitButton} onPress={handleExitSession}>
            <Text style={styles.exitButtonText}>Back to Dashboard</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const progressPercent = ((currentIndex + 1) / sessionCandidates.length) * 100;

    return (
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.practiceContainer}>
        {/* Progress Bar Header */}
        <View style={styles.practiceHeader}>
          <Text style={styles.practiceProgressText}>
            Card {currentIndex + 1} of {sessionCandidates.length}
          </Text>
          <TouchableOpacity style={styles.exitSessionButton} onPress={handleExitSession}>
            <Text style={styles.exitSessionButtonText}>Exit</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
        </View>

        {isDemoMode ? <Text accessibilityLiveRegion="polite" style={styles.demoBannerText}>Demo Mode · Not real AI. These sample answers and feedback are not saved as your learning evidence.</Text> : null}
        {saveError && !isDemoMode && (
          <View style={styles.sessionErrorBanner}>
            <Text style={styles.sessionErrorBannerText}>⚠️ {saveError}</Text>
          </View>
        )}

        {/* Practice Card */}
        <View style={styles.card}>
          <View style={styles.cardTypeRow}>
            <View style={[styles.typeBadge, TYPE_BADGE_STYLES[candidate.kind] ?? styles.typeBadge_vocabulary]}>
              <Text style={styles.typeBadgeText}>
                {candidate.kind.toUpperCase()}
              </Text>
            </View>
            <Text style={styles.exerciseTypeLabel}>
              {candidate.exerciseType?.replace(/_/g, ' ') || 'recall'}
            </Text>
          </View>

          {/* Listening replay control (kind === 'listening'): existing TTS */}
          {candidate.kind === 'listening' && (
            <View style={styles.listeningPlayRow}>
              <TouchableOpacity
                style={styles.listeningPlayButton}
                onPress={() => handlePlayListeningItem(candidate.expectedAnswer)}
                accessibilityLabel="Play listening item"
                accessibilityRole="button"
              >
                <Text style={styles.listeningPlayButtonText}>
                  {isPlayingListening ? '🔊 Playing…' : '▶ Play audio'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Prompt */}
          <Text style={styles.promptText}>{candidate.prompt}</Text>

          {/* Context Clue / Sentence Callout */}
          {candidate.contextSentence && (
            <View style={styles.contextCallout}>
              <Text style={styles.contextText}>{candidate.contextSentence}</Text>
            </View>
          )}

          {/* Definition for vocabulary/expressions */}
          {candidate.definition && (
            <View style={styles.definitionBox}>
              <Text style={styles.definitionLabel}>Definition:</Text>
              <Text style={styles.definitionText}>{candidate.definition}</Text>
            </View>
          )}

          {/* Answer Input Field (when not evaluated yet) */}
          {!evaluation ? (
            <View>
              <View style={styles.inputWrapper}>
                <TextInput accessibilityLabel="Your practice answer"
                  style={styles.answerInput}
                  placeholder={
                    candidate.exerciseType === 'pronunciation_repeat'
                      ? 'Say it aloud with the mic, or type what you said...'
                      : 'Type your answer in English...'
                  }
                  placeholderTextColor="#9CA3AF"
                  value={userAnswer}
                  onChangeText={setUserAnswer}
                  autoCorrect={false}
                  autoCapitalize="none"
                  multiline={candidate.exerciseType === 'sentence_correction' || candidate.exerciseType === 'natural_phrasing'}
                  editable={!isEvaluating && !isRecording && !isTranscribing}
                  id="answer_input_field"
                />
                <TouchableOpacity
                  style={[
                    styles.submitButton,
                    !userAnswer.trim() && styles.submitButtonDisabled,
                  ]}
                  onPress={handleSubmitAnswer}
                  disabled={!userAnswer.trim() || isEvaluating || isRecording || isTranscribing}
                  accessibilityRole="button"
                  accessibilityLabel={isEvaluating ? "Checking answer" : "Submit answer"}
                  id="submit_answer_button"
                >
                  {isEvaluating ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.submitButtonText}>Submit Answer</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* Voice Review Answer Controls */}
              <View style={styles.voiceSection} id="voice_section">
                <Text style={styles.emptyCardText}>Type your answer, or allow microphone access to answer aloud.</Text>
                {/permission/i.test(recorderError ?? '') ? <MicrophoneHelp /> : null}
                {!voiceStatus.isAvailable ? (
                  // Honest unavailable state: no microphone, no invented
                  // transcript and no demo speech on a real review.
                  <View style={styles.voiceUnavailableCard}>
                    <Text style={styles.voiceUnavailableText}>
                      {voiceNotice ?? 'Voice answers are unavailable right now. Type your answer instead.'}
                    </Text>
                  </View>
                ) : (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.micButton,
                        isRecording && styles.micButtonRecording,
                        (isTranscribing || isEvaluating) && styles.micButtonDisabled,
                      ]}
                      onPress={handleToggleRecording}
                      disabled={isTranscribing || isEvaluating}
                      accessibilityRole="button"
                      accessibilityLabel={isTranscribing ? 'Transcribing spoken answer' : isRecording ? 'Stop recording' : 'Record a spoken answer'}
                      id="toggle_recording_button"
                    >
                      <Text style={styles.micButtonText}>
                        {isRecording
                          ? '🛑 Stop Recording'
                          : isTranscribing
                            ? 'Transcribing…'
                            : '🎤 Answer with Voice'}
                      </Text>
                    </TouchableOpacity>
                    {isRecording && (
                      <View style={styles.recordingIndicator}>
                        <View style={styles.pulseDot} />
                        <Text style={styles.recordingText}>Listening... Speak your answer now.</Text>
                      </View>
                    )}
                    {isDemoMode && (
                      <Text style={styles.demoVoiceNotice}>{DEMO_REVIEW_NOTICE}</Text>
                    )}
                    {recorderError && (
                      <Text style={styles.recorderErrorText}>{recorderError}</Text>
                    )}
                  </>
                )}
              </View>
            </View>
          ) : (
            /* Evaluation Result State */
            <View style={styles.evaluationBlock}>
              <View style={[styles.evalResultBanner, styles[`evalResultBanner_${evaluation.result}`]]}>
                <Text style={[styles.evalResultTitle, styles[`evalResultTitle_${evaluation.result}`]]}>
                  {evaluation.result === 'correct'
                    ? '✓ Correct'
                    : evaluation.result === 'partial'
                    ? '⚠ Partly Correct'
                    : '✗ Needs Work'}
                </Text>
                <Text style={styles.evalFeedbackText}>{evaluation.feedback}</Text>
              </View>

              <View style={styles.evalDetailRow}>
                <Text style={styles.evalDetailLabel}>Your answer:</Text>
                <Text style={styles.evalDetailValue}>{userAnswer}</Text>
              </View>

              <View style={styles.evalDetailRow}>
                <Text style={styles.evalDetailLabel}>Recommended phrasing:</Text>
                <Text style={styles.evalDetailCorrection}>{evaluation.suggestedCorrection}</Text>
              </View>

              {evaluation.explanation && (
                <View style={styles.explanationBox}>
                  <Text style={styles.explanationTitle}>Tutor Explanation:</Text>
                  <Text style={styles.explanationText}>{evaluation.explanation}</Text>
                </View>
              )}

              <TouchableOpacity
                style={styles.nextButton}
                onPress={handleNextItem}
                accessibilityRole="button"
                id="next_card_button"
              >
                <Text style={styles.nextButtonText}>
                  {currentIndex + 1 < sessionCandidates.length ? 'Next Card →' : 'Finish Session'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  // 3. PRACTICE SESSION COMPLETION VIEW
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.completionCard}>
        <Text style={styles.completionIcon}>🎓</Text>
        <Text style={styles.completionTitle}>Review complete</Text>
        {isDemoMode ? <Text style={styles.demoBannerText}>Demo Mode · Not real AI. These are sample results, not your learner history.</Text> : null}
        <Text style={styles.completionSubtitle}>
          You finished {sessionCandidates.length} {isDemoMode ? 'sample' : 'review'} cards.
        </Text>

        <View style={styles.scoreRow}>
          <View style={styles.scoreItem}>
            <Text style={[styles.scoreValue, styles.scoreValueCorrect]}>{sessionResults.correctCount}</Text>
            <Text style={styles.scoreLabel}>Correct</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={[styles.scoreValue, styles.scoreValuePartial]}>{sessionResults.partialCount}</Text>
            <Text style={styles.scoreLabel}>Partial</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={[styles.scoreValue, styles.scoreValueIncorrect]}>{sessionResults.incorrectCount}</Text>
            <Text style={styles.scoreLabel}>Needs Work</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.doneButton}
          onPress={handleExitSession}
          accessibilityRole="button"
          id="finish_session_done_button"
        >
          <Text style={styles.doneButtonText}>Back to Review</Text>
        </TouchableOpacity>
        {dailyLaunch.showReturn ? (
          <TouchableOpacity
            style={styles.doneButton}
            onPress={() => {
              setDailyLaunch((current) => endDailyTutorVisit(current));
              navigation.navigate('DailyTutor');
            }}
          >
            <Text style={styles.doneButtonText}>Back to today&apos;s practice</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  practiceContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },
  demoBanner: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  demoBannerText: {
    fontSize: 13,
    color: '#1E40AF',
    lineHeight: 18,
  },
  sessionErrorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  sessionErrorBannerText: {
    fontSize: 13,
    color: '#B91C1C',
    lineHeight: 18,
  },
  emptyQueueBanner: {
    backgroundColor: '#F0F9FF',
    borderWidth: 1,
    borderColor: '#BAE6FD',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  emptyQueueBannerText: {
    fontSize: 13,
    color: '#075985',
    lineHeight: 18,
  },
  totalDueCard: {
    backgroundColor: '#1E3A8A',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#1E3A8A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 3,
  },
  totalDueNumber: {
    fontSize: 48,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 2,
  },
  totalDueLabel: {
    fontSize: 14,
    color: '#93C5FD',
    fontWeight: '600',
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  startSessionButton: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  startSessionButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E3A8A',
  },
  sectionHeader: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 12,
    marginTop: 12,
  },
  grid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  gridCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  gridCardEmoji: {
    fontSize: 20,
    marginBottom: 6,
  },
  gridCardValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 2,
  },
  gridCardLabel: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  emptyCardText: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 18,
    textAlign: 'center',
  },
  weaknessCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  weaknessHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  weaknessCategory: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  statusBadge_observed: { backgroundColor: '#EFF6FF' },
  statusBadge_confirmed: { backgroundColor: '#FEF3C7' },
  statusBadge_active_training: { backgroundColor: '#FEE2E2' },
  statusBadge_relapsed: { backgroundColor: '#FEE2E2' },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#374151',
  },
  weaknessMeta: {
    fontSize: 12,
    color: '#6B7280',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
  },
  loadingText: {
    fontSize: 15,
    color: '#4B5563',
    marginTop: 12,
  },
  practiceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  practiceProgressText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4B5563',
  },
  exitSessionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#E5E7EB',
  },
  exitSessionButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    marginBottom: 20,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#2563EB',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  typeBadge_grammar: { backgroundColor: '#EFF6FF' },
  typeBadge_vocabulary: { backgroundColor: '#ECFDF5' },
  typeBadge_expression: { backgroundColor: '#FFF7ED' },
  typeBadge_pronunciation: {
    backgroundColor: '#EEF4FF',
    borderColor: '#1F4E9C',
  },
  typeBadge_listening: {
    backgroundColor: '#E8F5E9',
    borderColor: '#2E7D32',
  },
  listeningPlayRow: {
    marginTop: 8,
    marginBottom: 4,
  },
  listeningPlayButton: {
    backgroundColor: '#2E7D32',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  listeningPlayButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#374151',
  },
  exerciseTypeLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'capitalize',
  },
  promptText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 14,
  },
  contextCallout: {
    backgroundColor: '#F9FAFB',
    borderLeftWidth: 4,
    borderLeftColor: '#3B82F6',
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  contextText: {
    fontSize: 15,
    fontWeight: '600',
    fontStyle: 'italic',
    color: '#1F2937',
    lineHeight: 22,
  },
  definitionBox: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  definitionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4B5563',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  definitionText: {
    fontSize: 14,
    color: '#111827',
    lineHeight: 20,
  },
  inputWrapper: {
    gap: 12,
    marginTop: 8,
  },
  answerInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 44,
  },
  submitButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  evaluationBlock: {
    marginTop: 12,
    gap: 16,
  },
  evalResultBanner: {
    borderRadius: 10,
    padding: 14,
  },
  evalResultBanner_correct: { backgroundColor: '#ECFDF5' },
  evalResultBanner_partial: { backgroundColor: '#FFFBEB' },
  evalResultBanner_incorrect: { backgroundColor: '#FEE2E2' },
  evalResultTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  evalResultTitle_correct: { color: '#047857' },
  evalResultTitle_partial: { color: '#B45309' },
  evalResultTitle_incorrect: { color: '#B91C1C' },
  evalFeedbackText: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  },
  evalDetailRow: {
    gap: 4,
  },
  evalDetailLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
  },
  evalDetailValue: {
    fontSize: 14,
    color: '#374151',
  },
  evalDetailCorrection: {
    fontSize: 15,
    fontWeight: '700',
    color: '#047857',
  },
  explanationBox: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 12,
  },
  explanationTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 4,
  },
  explanationText: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 18,
  },
  nextButton: {
    backgroundColor: '#111827',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  nextButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  completionCard: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
  },
  completionIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  completionTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 6,
  },
  completionSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 30,
  },
  scoreRow: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 36,
  },
  scoreItem: {
    alignItems: 'center',
    minWidth: 70,
  },
  scoreValue: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 2,
  },
  scoreValueCorrect: { color: '#10B981' },
  scoreValuePartial: { color: '#F59E0B' },
  scoreValueIncorrect: { color: '#EF4444' },
  scoreLabel: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  doneButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    width: '100%',
    maxWidth: 240,
    alignItems: 'center',
  },
  doneButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  exitButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  exitButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 16,
  },
  voiceSection: {
    marginTop: 12,
    alignItems: 'center',
    gap: 8,
  },
  micButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  micButtonRecording: {
    backgroundColor: '#FEE2E2',
    borderColor: '#F87171',
  },
  micButtonDisabled: {
    opacity: 0.6,
  },
  voiceUnavailableCard: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 12,
  },
  voiceUnavailableText: {
    fontSize: 12,
    color: '#4B5563',
    lineHeight: 17,
  },
  demoVoiceNotice: {
    fontSize: 12,
    color: '#1E40AF',
    marginTop: 4,
  },
  micButtonText: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '600',
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  recordingText: {
    fontSize: 12,
    color: '#EF4444',
    fontWeight: '600',
  },
  recorderErrorText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 4,
  },
  startSessionButtonDisabled: {
    backgroundColor: '#9CA3AF',
  },
});

/** Typed lookup for weakness status badge variants (falls back to `observed`). */
const STATUS_BADGE_STYLES: Record<string, ViewStyle> = {
  observed: styles.statusBadge_observed,
  confirmed: styles.statusBadge_confirmed,
  active_training: styles.statusBadge_active_training,
  relapsed: styles.statusBadge_relapsed,
};

/** Typed lookup for review item kind badge variants (falls back to `vocabulary`). */
const TYPE_BADGE_STYLES: Record<string, ViewStyle> = {
  grammar: styles.typeBadge_grammar,
  vocabulary: styles.typeBadge_vocabulary,
  expression: styles.typeBadge_expression,
  pronunciation: styles.typeBadge_pronunciation,
  listening: styles.typeBadge_listening,
};
