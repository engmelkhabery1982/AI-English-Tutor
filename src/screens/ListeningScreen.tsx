import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/ListeningScreen.tsx
 *
 * Mobile-first Listening practice (Phase 1).
 *
 * Flow: Start practice → exercise card → Play/Replay (EXISTING TTS) →
 * answer (typed or choice) → Check Answer → qualitative feedback →
 * transcript reveal → Save Word/Expression when relevant → Next → summary.
 *
 * - No comprehension scores, percentages, bands, XP or streaks — qualitative
 *   results only.
 * - The exercise text is NOT shown before the first answer; it is revealed
 *   in the feedback (transcript reveal).
 * - Audio always goes through the EXISTING TextToSpeechProvider abstraction;
 *   no second voice stack.
 * - The screen never touches SQLite: it receives an injected service or
 *   awaits the composition factory.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import type { TextToSpeechProvider } from '../talk-demo';
import type { ListeningService } from '../listening';
import { createDefaultListeningService } from '../listening';
import type {
  ListeningDifficulty,
  ListeningEvaluation,
  ListeningExercise,
} from '../listening';
import type { SpeechToTextProvider } from '../providers/stt';
import type { AudioRecorderService } from '../voice/types';
import DeepListeningPanel from './listening/DeepListeningPanel';
import type { DailyTutorActivityRef, DailyTutorLaunchState } from '../daily-tutor';
import {
  DAILY_TUTOR_LAUNCH_IDLE,
  beginStandaloneSession,
  captureDailyTutorLaunch,
  clearDailyTutorReturn,
  endDailyTutorVisit,
  finishDailyTutorWorkflow,
  reportDailyTutorCompletion,
} from '../daily-tutor';
import { TTSController } from '../voice/tts-controller';
import { useVoiceAppStateGuard } from '../voice/use-app-state-guard';
import { createSaveToReviewService } from '../learner-agency';

export interface ListeningScreenProps {
  readonly initialPractice?: 'pronunciation' | 'shadowing';
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: ListeningService;
  /** Injectable TTS (existing provider abstraction). */
  readonly ttsProvider?: TextToSpeechProvider;
  /** WP-2: injectable EXISTING recorder/STT, used only by deep shadowing. */
  readonly recorder?: AudioRecorderService;
  readonly stt?: SpeechToTextProvider;
}

const TYPE_LABELS: Record<ListeningExercise['type'], string> = {
  listen_and_type: 'Listen & type',
  listen_and_answer: 'Listen & answer',
  listen_and_choose: 'Listen & choose',
  missing_word: 'Find the missing word',
  expression_in_context: 'Expression in context',
};

const SOURCE_LABELS: Record<ListeningExercise['source'], string> = {
  listening_weakness: 'Retraining a listening problem',
  due_vocabulary: 'From your vocabulary',
  due_expression: 'From your expressions',
  general: 'General practice',
};

const DIFFICULTIES: readonly ListeningDifficulty[] = ['easy', 'medium', 'hard'];

interface SessionState {
  readonly exercises: readonly ListeningExercise[];
  readonly sourceNote: string;
}

export default function ListeningScreen(props?: ListeningScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const route = useRoute() as { readonly params?: { readonly dailyTutor?: DailyTutorActivityRef } };

  /**
   * ONE-SHOT Daily Tutor launch context. React Navigation keeps params
   * attached to a TAB route, so the `dailyTutor` param is captured ONCE
   * into local state and immediately CONSUMED (cleared from the route).
   * The captured context lives only for that child workflow; a later
   * standalone open of this tab has NO Daily Tutor behavior.
   */
  const [dailyLaunch, setDailyLaunch] = useState<DailyTutorLaunchState<DailyTutorActivityRef>>(
    DAILY_TUTOR_LAUNCH_IDLE,
  );
  /** Auto-start guard: at most one auto-start per Daily Tutor activity. */
  const dailyAutoStartedRef = useRef<string | null>(null);
  const routeLaunch = route.params?.dailyTutor;
  // Background policy – stop TTS safely, no fake completion, idle on foreground
  useVoiceAppStateGuard({
    invalidate: () => {
      try {
        ttsControllerRef.current?.invalidate();
      } catch {}
      setIsPlaying(false);
    },
  });
  useEffect(() => {
    if (!routeLaunch) return;
    setDailyLaunch((current) => captureDailyTutorLaunch(current, { dailyTutor: routeLaunch }).state);
    // A fresh Daily Tutor launch may auto-start its workflow, even when the
    // very same activity is relaunched after an abandoned attempt.
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
  const [session, setSession] = useState<SessionState | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [answer, setAnswer] = useState<string>('');
  const [evaluation, setEvaluation] = useState<ListeningEvaluation | null>(null);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [replayCount, setReplayCount] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Start-failure visibility: measure the setup screen's Start area so a
  // failure can be scrolled into view without manual scrolling.
  const setupScrollRef = useRef<ScrollView | null>(null);
  const startAreaY = useRef(0);
  const [difficulty, setDifficulty] = useState<ListeningDifficulty>('easy');
  const [savedItems, setSavedItems] = useState<readonly string[]>([]);
  const [sessionDone, setSessionDone] = useState<boolean>(false);
  const [problemCount, setProblemCount] = useState<number>(0);
  /**
   * WP-2: short (Phase 1) or deep listening. Deep mode is additive — it cannot
   * be entered while a Daily Tutor workflow is active, so that flow keeps its
   * existing Phase-1 behaviour exactly.
   */
  const [mode, setMode] = useState<'short' | 'deep'>(props?.initialPractice ? 'deep' : 'short');

  const serviceRef = useRef<ListeningService | null>(props?.service ?? null);
  const ttsRef = useRef<TextToSpeechProvider | null>(props?.ttsProvider ?? null);
  const ttsControllerRef = useRef<TTSController | null>(null);
  const resultsRef = useRef<{ problems: number; understood: number }>({
    problems: 0,
    understood: 0,
  });
  /** Drives the Daily Tutor auto-start once the shared service exists. */
  const [serviceReady, setServiceReady] = useState<boolean>(props?.service !== undefined);

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (serviceRef.current) return;
    setErrorMessage(null);
    let active = true;
    createDefaultListeningService()
      .then((service) => {
        if (active) {
          serviceRef.current = service;
          setServiceReady(true);
        }
      })
      .catch(() => {
        if (active) setErrorMessage('Listening practice could not be loaded. Please try again.');
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const currentExercise: ListeningExercise | null =
    session && currentIndex < session.exercises.length
      ? session.exercises[currentIndex]
      : null;

  const startSession = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || isStarting) return;
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const learner = await service.resolveLearnerId();
      if (!learner) {
        setSession(null);
        setErrorMessage(
          'No learner profile yet. Open the Talk tab once to set up your profile, then start listening practice.',
        );
        return;
      }
      // This is the real exercise-serving path, so it opts in to ONE bounded
      // generated exercise per session; generation never blocks the session
      // (the engine falls back to its deterministic material immediately).
      const result = await service.startSession(learner, {
        difficulty,
        allowGeneratedContent: true,
      });
      if (result.exercises.length === 0) {
        setSession(null);
        setErrorMessage(result.sourceNote);
      } else {
        resultsRef.current = { problems: 0, understood: 0 };
        setSession({ exercises: result.exercises, sourceNote: result.sourceNote });
        setCurrentIndex(0);
        setSessionDone(false);
        setProblemCount(0);
        resetExerciseState();
      }
    } catch {
      setErrorMessage('Could not start a practice session. Please try again.');
    } finally {
      setIsStarting(false);
    }
  }, [difficulty, isStarting]);

  // Start-failure visibility: keep the failure AND the Start action in the
  // viewport — when a start fails on the setup screen, scroll the alert area
  // into view instead of leaving the learner hunting for it. Selections
  // (difficulty, mode, previous lesson) are intentionally untouched by any
  // error path, so a retry after a recoverable failure starts unchanged.
  useEffect(() => {
    if (!errorMessage || session || sessionDone || mode !== 'short') return;
    setupScrollRef.current?.scrollTo({
      y: Math.max(0, startAreaY.current - 24),
      animated: true,
    });
  }, [errorMessage, session, sessionDone, mode]);

  /**
   * A user-started session is NEVER the Daily Tutor workflow: clear any
   * lingering launch context (no auto-start, no completion report, no
   * return affordance), then start through the existing handler.
   */
  const handleStartSession = useCallback(() => {
    setDailyLaunch((current) => beginStandaloneSession(current));
    void startSession();
  }, [startSession]);

  /**
   * Daily Tutor launch: when this screen was opened by the Daily Tutor, start
   * the existing listening session automatically (once per activity). The
   * Listening Engine remains the owner of the session — this only triggers
   * the existing start handler.
   */
  useEffect(() => {
    if (!dailyTutorRef) return;
    if (!serviceReady || session || sessionDone) return;
    if (dailyAutoStartedRef.current === dailyTutorRef.activityId) return;
    dailyAutoStartedRef.current = dailyTutorRef.activityId;
    void startSession();
  }, [dailyTutorRef, serviceReady, session, sessionDone, startSession]);

  const resetExerciseState = () => {
    setAnswer('');
    setEvaluation(null);
    setReplayCount(0);
    setSavedItems([]);
  };

  useEffect(() => {
    return () => {
      try {
        ttsControllerRef.current?.dispose();
      } catch {}
      ttsControllerRef.current = null;
    };
  }, []);

  /** Play/replay via the EXISTING TTS provider hardened by TTSController. */
  const handlePlay = async () => {
    if (!currentExercise) return;
    let doneFired = false;
    try {
      if (!ttsRef.current) {
        const { createExpoTTSProvider } = await import('../talk-demo');
        ttsRef.current = createExpoTTSProvider();
      }
      if (!ttsControllerRef.current) {
        ttsControllerRef.current = new TTSController(ttsRef.current);
      }
      setIsPlaying(true);
      await ttsControllerRef.current.speak(
        currentExercise.question
          ? `${currentExercise.speakText} ${currentExercise.question}`
          : currentExercise.speakText,
        {
          onDone: () => {
            doneFired = true;
            setIsPlaying(false);
            setReplayCount((count) => count + 1);
          },
          onError: () => {
            doneFired = true;
            setIsPlaying(false);
            setErrorMessage(
              'Audio playback failed. Use Replay to try again — your exercise and answer are kept.',
            );
          },
        },
      );
      if (!doneFired) {
        setIsPlaying(false);
        setReplayCount((count) => count + 1);
      }
    } catch {
      if (!doneFired) setIsPlaying(false);
      setErrorMessage(
        'Audio playback failed. Use Replay to try again — your exercise and answer are kept.',
      );
    }
  };

  const handleStop = async () => {
    try {
      await ttsControllerRef.current?.stop();
    } catch {
      // Stop failures are harmless – idempotent
    } finally {
      setIsPlaying(false);
    }
  };

  const handleCheckAnswer = async () => {
    const service = serviceRef.current;
    if (!service || !currentExercise || isEvaluating) return;
    setIsEvaluating(true);
    setErrorMessage(null);
    try {
      const learner = await service.resolveLearnerId();
      if (!learner) {
        setEvaluation({
          result: 'insufficient_evidence',
          feedbackLines: ['No learner profile found yet — the answer was not saved.'],
          missedItems: [],
          revealedTranscript: currentExercise.speakText,
          evaluatedBy: 'unavailable',
        });
        return;
      }
      const { evaluation, persistenceError } = await service.evaluateAnswer(
        learner,
        currentExercise,
        answer,
        { replayCount },
      );
      setEvaluation(evaluation);
      if (persistenceError) {
        setErrorMessage('Your answer and feedback are shown, but saving progress failed this time.');
      }
      if (
        evaluation.result === 'understood' ||
        evaluation.result === 'mostly_understood'
      ) {
        resultsRef.current.understood += 1;
      } else if (evaluation.result !== 'insufficient_evidence') {
        resultsRef.current.problems += 1;
        setProblemCount((c) => c + 1);
      }
    } catch {
      setErrorMessage('Evaluation failed. Your answer is kept — try checking again.');
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleSave = async (item: string, asExpression: boolean) => {
    const service = serviceRef.current;
    if (!service || !currentExercise) return;
    try {
      const learner = await service.resolveLearnerId();
      if (!learner) {
        setErrorMessage('No learner profile found yet — nothing was saved.');
        return;
      }
      // HONEST save semantics: only a REAL meaning carried by the exercise
      // (e.g. the item's known meaning) is stored as the definition — the
      // listening sentence is stored as a usage example, never as a
      // definition, and no placeholder meaning is ever invented.
      const knownMeaning =
        currentExercise.keyMeaning ??
        (currentExercise.source === 'due_vocabulary' ? currentExercise.expectedAnswer : undefined);
      const exampleText = evaluation?.revealedTranscript ?? currentExercise.speakText;
      const saveOptions = { meaning: knownMeaning, exampleText };
      const result = asExpression
        ? await service.saveExpression(learner, item, saveOptions)
        : await service.saveVocabulary(learner, item, saveOptions);
      if (result) {
        setSavedItems((prev) => [...prev, `${asExpression ? 'expr' : 'word'}:${item}`]);
        if (!knownMeaning) {
          setErrorMessage(
            `Saved '${item}' without a definition — you can add one in the Vocabulary tab.`,
          );
        }
      }
    } catch {
      setErrorMessage('Saving failed. Please try again.');
    }
  };

  /**
   * Work Order 2 — always-available manual save of the revealed transcript
   * sentence, valid after ANY result (a correct answer may still be worth
   * keeping). Goes through the ONE reusable Save to Review service; it never
   * changes review status, mastery or evidence.
   */
  const [reviewSaveNote, setReviewSaveNote] = useState<string | null>(null);
  const [isSavingToReview, setIsSavingToReview] = useState<boolean>(false);
  const reviewSaveServiceRef = React.useRef(createSaveToReviewService());

  const handleSaveRevealedToReview = async (): Promise<void> => {
    const sentence = (evaluation?.revealedTranscript ?? currentExercise?.speakText ?? '').trim();
    if (sentence.length === 0 || isSavingToReview) return;
    setIsSavingToReview(true);
    setReviewSaveNote(null);
    try {
      const result = await reviewSaveServiceRef.current.save({
        learnerId: '',
        text: sentence,
        itemType: 'sentence',
        origin: 'listening',
        originRef: currentExercise?.id,
        contextSentence: sentence,
      });
      if (result.ok) {
        setReviewSaveNote(
          result.reason === 'already_saved'
            ? 'Already in your Review list — nothing was duplicated.'
            : 'Saved to Review. Saving does not count as practice.',
        );
      } else if (result.reason === 'no_profile') {
        setReviewSaveNote('Saving needs a learning profile first.');
      } else {
        setReviewSaveNote('Could not save this time. Nothing was changed.');
      }
    } finally {
      setIsSavingToReview(false);
    }
  };

  const handleNext = async () => {
    if (!session) return;
    if (currentIndex + 1 < session.exercises.length) {
      setCurrentIndex((i) => i + 1);
      resetExerciseState();
      setErrorMessage(null);
      return;
    }
    // Session finished → record REAL counts in existing progress records.
    setSessionDone(true);
    const service = serviceRef.current;
    if (service) {
      try {
        const learner = await service.resolveLearnerId();
        if (learner) {
          await service.recordSessionCompleted(learner, {
            exercisesCompleted: session.exercises.length,
            problemResults: resultsRef.current.problems,
            understoodResults: resultsRef.current.understood,
          });
        }
      } catch {
        // Non-destructive: the summary is still shown.
      }
    }
    // Daily Tutor handshake: report the REAL listening completion with the
    // real exercise count. Exiting mid-session never reaches this point, so
    // an unfinished listening activity never completes. The captured launch
    // is ONE-SHOT: once its workflow really completed and reported, it is
    // consumed — a later session in this tab is standalone.
    if (dailyTutorRef) {
      reportDailyTutorCompletion({
        ref: dailyTutorRef,
        completedAt: new Date().toISOString(),
        itemsPracticed: session.exercises.length,
      });
      setDailyLaunch((current) => finishDailyTutorWorkflow(current));
    }
  };

  // ---------- Empty / start state ----------
  if (!session || !currentExercise) {
    // WP-2 deep mode: its own scroll container, so the Phase-1 layout below is
    // untouched (and no scroll view is nested inside another one).
    if (mode === 'deep' && !dailyTutorRef) {
      return (
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.deepContent}>
          <Text style={styles.title}>{props?.initialPractice === 'pronunciation' ? 'Pronunciation' : props?.initialPractice === 'shadowing' ? 'Shadowing' : 'Listening and imitation'}</Text>
          <Text style={styles.subtitle}>{props?.initialPractice === 'pronunciation'
            ? 'Focus on saying the target phrase clearly. Your recorded speech is transcribed and compared with the target by the pronunciation processor — not judged by generic AI opinion. This is word-level feedback, not acoustic or phoneme scoring.'
            : 'Listen to the model, imitate the phrase, then compare what was recognized. Shadowing uses the same word-level pronunciation processing, with a listening-and-imitation focus.'}</Text>
          <TouchableOpacity
            style={styles.secondaryButtonRow}
            onPress={() => props?.initialPractice ? navigation.goBack() : setMode('short')}
            accessibilityRole="button"
            accessibilityLabel={props?.initialPractice ? "Back to learning" : "Back to short exercises"}
          >
            <Text style={styles.difficultyPillText}>{props?.initialPractice ? "← Back to learning" : "← Short exercises"}</Text>
          </TouchableOpacity>
          {serviceReady && serviceRef.current ? (
            <DeepListeningPanel
              service={serviceRef.current}
              shadowingOnly={Boolean(props?.initialPractice)}
              onExit={() => props?.initialPractice ? navigation.goBack() : setMode('short')}
              onInspectText={(prefill) => navigation.navigate('LearningTools', { inspect: prefill })}
              {...(props?.ttsProvider ? { ttsProvider: props.ttsProvider } : {})}
              {...(props?.recorder ? { recorder: props.recorder } : {})}
              {...(props?.stt ? { stt: props.stt } : {})}
            />
          ) : (
            <View><Text accessibilityLiveRegion="polite" style={styles.subtitle}>{errorMessage ?? 'Loading listening practice…'}</Text>
              {errorMessage ? <TouchableOpacity onPress={() => setLoadAttempt(n => n + 1)}><Text>Try again</Text></TouchableOpacity> : null}</View>
          )}
        </ScrollView>
      );
    }
    return (
      <ScrollView ref={setupScrollRef} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.centerContent}>
        <Text style={styles.title}>🎧 Listening</Text>
        {!dailyTutorRef ? (
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.difficultyPill, mode === 'short' && styles.difficultyPillActive]}
              onPress={() => setMode('short')}
              accessibilityRole="button"
              accessibilityLabel="Short listening exercises"
            >
              <Text
                style={[
                  styles.difficultyPillText,
                  mode === 'short' && styles.difficultyPillTextActive,
                ]}
              >
                Short exercises
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.difficultyPill, mode === 'deep' && styles.difficultyPillActive]}
              onPress={() => setMode('deep')}
              testID="deep_listening_tab"
              accessibilityRole="button"
              accessibilityLabel="Deep listening practice"
            >
              <Text
                style={[
                  styles.difficultyPillText,
                  mode === 'deep' && styles.difficultyPillTextActive,
                ]}
              >
                Listening & imitation
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!dailyTutorRef ? <View>
          <TouchableOpacity onPress={() => navigation.navigate('Shadowing')} accessibilityHint="Listen, imitate and compare your spoken words"><Text style={styles.difficultyPillText}>Shadowing · Listen and imitate →</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Pronunciation')}><Text style={styles.difficultyPillText}>Pronunciation · Repeat and compare →</Text></TouchableOpacity>
        </View> : null}
        {!serviceReady ? <Text accessibilityLiveRegion="polite">{errorMessage ?? 'Loading listening practice…'}</Text> : null}
        {!serviceReady && errorMessage ? <TouchableOpacity onPress={() => setLoadAttempt(n => n + 1)}><Text>Try again</Text></TouchableOpacity> : null}
        <Text style={styles.subtitle}>
          Short listening exercises. Play the audio, answer what you understood, and get
          qualitative feedback — no scores, just real comprehension practice.
        </Text>

        <View style={styles.difficultyRow}>
          {DIFFICULTIES.map((level) => (
            <TouchableOpacity
              key={level}
              style={[styles.difficultyPill, difficulty === level && styles.difficultyPillActive]}
              onPress={() => setDifficulty(level)}
              accessibilityRole="button"
              accessibilityLabel={`Difficulty ${level}`}
            >
              <Text
                style={[
                  styles.difficultyPillText,
                  difficulty === level && styles.difficultyPillTextActive,
                ]}
              >
                {level}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Start area: a start failure renders IMMEDIATELY ABOVE the Start
            button as an announced alert — adjacent to the action, in view. */}
        <View onLayout={(event) => { startAreaY.current = event.nativeEvent.layout.y; }}>
          {errorMessage ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {errorMessage}
            </Text>
          ) : null}
          <TouchableOpacity
            style={[styles.startButton, isStarting && styles.startButtonDisabled]}
            onPress={handleStartSession}
            disabled={isStarting || !serviceReady}
            testID="start_listening_button"
            accessibilityRole="button"
            accessibilityLabel="Start listening practice"
          >
            {isStarting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.startButtonText}>Start practice</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ---------- Session summary ----------
  if (sessionDone) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.summaryTitle}>Session complete</Text>
          <Text style={styles.summaryLine}>
            {session.exercises.length} exercises · {resultsRef.current.understood} clearly
            understood · {problemCount} to retrain later
          </Text>
          <Text style={styles.sourceNote}>{session.sourceNote}</Text>
          <TouchableOpacity style={styles.startButton} onPress={handleStartSession}>
            <Text style={styles.startButtonText}>Practice again</Text>
          </TouchableOpacity>
          {dailyLaunch.showReturn ? (
            <TouchableOpacity
              style={styles.startButton}
              onPress={() => {
                setDailyLaunch((current) => endDailyTutorVisit(current));
                navigation.navigate('DailyTutor');
              }}
            >
              <Text style={styles.startButtonText}>Back to today&apos;s practice</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  const isChoice =
    (currentExercise.type === 'listen_and_choose' ||
      currentExercise.type === 'expression_in_context') &&
    currentExercise.options &&
    currentExercise.options.length > 0;

  // ---------- Active exercise ----------
  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.practiceContent}>
      <View style={styles.headerRow}>
        <Text style={styles.counter}>
          {currentIndex + 1} / {session.exercises.length}
        </Text>
        <Text style={styles.typeLabel}>{TYPE_LABELS[currentExercise.type]}</Text>
      </View>
      <Text style={styles.sourceNote}>
        {SOURCE_LABELS[currentExercise.source]}
        {currentExercise.source === 'general' ? ' — not personalized' : ''}
      </Text>

      {/* Play / Replay / Stop — existing TTS. Text stays hidden before the first answer. */}
      <View style={styles.playRow}>
        <TouchableOpacity
          style={styles.playButton}
          onPress={handlePlay}
          disabled={isPlaying}
          testID="play_audio_button"
          accessibilityRole="button"
          accessibilityLabel="Play audio"
        >
          <Text style={styles.playButtonText}>{isPlaying ? '🔊 Playing…' : '▶ Play'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.replayButton} onPress={handlePlay} disabled={isPlaying}>
          <Text style={styles.replayButtonText}>↻ Replay</Text>
        </TouchableOpacity>
        {isPlaying ? (
          <TouchableOpacity style={styles.stopButton} onPress={handleStop}>
            <Text style={styles.replayButtonText}>■ Stop</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {currentExercise.gappedText ? (
        <View style={styles.gapBox}>
          <Text style={styles.gapText}>{currentExercise.gappedText}</Text>
        </View>
      ) : null}
      {!isChoice && !currentExercise.gappedText && currentExercise.question ? (
        <Text style={styles.questionText}>{currentExercise.question}</Text>
      ) : null}

      {/* Answer: options (choice) or typed input */}
      {!evaluation ? (
        isChoice ? (
          <View style={styles.optionsColumn}>
            {currentExercise.options!.map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.optionButton, answer === option && styles.optionButtonSelected]}
                onPress={() => setAnswer(option)}
                accessibilityRole="button"
                accessibilityLabel={`Option: ${option}`}
              >
                <Text style={[styles.optionText, answer === option && styles.optionTextSelected]}>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.checkButton, !answer && styles.checkButtonDisabled]}
              onPress={handleCheckAnswer}
              disabled={!answer || isEvaluating}
              testID="check_answer_button"
              accessibilityRole="button"
              accessibilityLabel="Check answer"
            >
              {isEvaluating ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.checkButtonText}>Check Answer</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View>
            <TextInput accessibilityLabel="Type what you understood…"
              style={styles.answerInput}
              placeholder="Type what you understood…"
              placeholderTextColor="#9CA3AF"
              value={answer}
              onChangeText={setAnswer}
              multiline
              autoCorrect={false}
              testID="listening_answer_input"
            />
            <TouchableOpacity
              style={[styles.checkButton, !answer.trim() && styles.checkButtonDisabled]}
              onPress={handleCheckAnswer}
              disabled={!answer.trim() || isEvaluating}
              testID="check_answer_button"
              accessibilityRole="button"
              accessibilityLabel="Check answer"
            >
              {isEvaluating ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.checkButtonText}>Check Answer</Text>
              )}
            </TouchableOpacity>
          </View>
        )
      ) : (
        /* ---------- Qualitative feedback + transcript reveal ---------- */
        <View style={styles.feedbackCard} testID="listening_feedback">
          <Text style={styles.feedbackResult}>{evaluation.result.replace(/_/g, ' ')}</Text>
          {evaluation.feedbackLines.map((line, index) => (
            <Text key={index} style={styles.feedbackLine}>
              • {line}
            </Text>
          ))}
          {evaluation.missedItems.length > 0 ? (
            <View style={styles.saveRow}>
              {evaluation.missedItems.map((item) => {
                const wordKey = `word:${item}`;
                const exprKey = `expr:${item}`;
                const savedAsWord = savedItems.includes(wordKey);
                const savedAsExpr = savedItems.includes(exprKey);
                return (
                  <View key={item} style={styles.saveItemRow}>
                    <Text style={styles.saveItemLabel}>{item}</Text>
                    <TouchableOpacity
                      style={[styles.saveChip, savedAsWord && styles.saveChipDone]}
                      onPress={() => handleSave(item, false)}
                      disabled={savedAsWord}
                    >
                      <Text style={styles.saveChipText}>
                        {savedAsWord ? 'Saved ✓' : 'Save word'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.saveChip, savedAsExpr && styles.saveChipDone]}
                      onPress={() => handleSave(item, true)}
                      disabled={savedAsExpr}
                    >
                      <Text style={styles.saveChipText}>
                        {savedAsExpr ? 'Saved ✓' : 'Save expression'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          ) : null}
          <View style={styles.saveRow}>
            <TouchableOpacity
              style={[styles.saveChip, isSavingToReview && styles.saveChipDone]}
              onPress={() => void handleSaveRevealedToReview()}
              disabled={isSavingToReview}
              accessibilityRole="button"
              accessibilityLabel="Save this sentence to Review — allowed after any answer, correct or not"
            >
              <Text style={styles.saveChipText}>
                {isSavingToReview ? 'Saving…' : '＋ Save sentence to Review'}
              </Text>
            </TouchableOpacity>
          </View>
          {reviewSaveNote ? (
            <Text style={styles.feedbackLine}>{reviewSaveNote}</Text>
          ) : null}
          <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
            <Text style={styles.nextButtonText}>
              {currentIndex + 1 < session.exercises.length ? 'Next' : 'Finish'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F8FA' },
  centerContent: { alignItems: 'center', justifyContent: 'center', padding: 24, flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '800', color: '#111827', letterSpacing: -0.5, marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 22, marginBottom: 20 },
  difficultyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  deepContent: { padding: 16, paddingBottom: 40 },
  secondaryButtonRow: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#DBEAFE',
    marginBottom: 8,
  },
  difficultyPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  difficultyPillActive: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  difficultyPillText: { color: '#374151', fontSize: 13, textTransform: 'capitalize' },
  difficultyPillTextActive: { color: '#FFFFFF', fontWeight: '600' },
  startButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  startButtonDisabled: { opacity: 0.6 },
  startButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  practiceContent: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' },
  counter: { fontSize: 13, color: '#6B7280', fontWeight: '600' },
  typeLabel: { fontSize: 13, color: '#2563EB', fontWeight: '700' },
  sourceNote: { fontSize: 12, color: '#6B7280', marginTop: 2, marginBottom: 10 },
  playRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  playButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  playButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  replayButton: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  stopButton: {
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  replayButtonText: { color: '#2563EB', fontWeight: '600', fontSize: 14 },
  gapBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 10,
  },
  gapText: { fontSize: 15, color: '#1F2937', lineHeight: 22 },
  questionText: { fontSize: 15, color: '#1F2937', fontWeight: '600', marginBottom: 10 },
  optionsColumn: { gap: 8 },
  optionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  optionButtonSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  optionText: { fontSize: 14, color: '#1F2937' },
  optionTextSelected: { color: '#2563EB', fontWeight: '600' },
  answerInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    padding: 14,
    minHeight: 90,
    textAlignVertical: 'top',
    fontSize: 15,
    color: '#1F2937',
    marginBottom: 12,
  },
  checkButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  checkButtonDisabled: { opacity: 0.5 },
  checkButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  feedbackCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  feedbackResult: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2563EB',
    textTransform: 'capitalize',
    marginBottom: 8,
  },
  feedbackLine: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 4 },
  saveRow: { marginTop: 10, gap: 6 },
  saveItemRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  saveItemLabel: { fontSize: 13, color: '#1F2937', fontWeight: '600', flexShrink: 1 },
  saveChip: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  saveChipDone: { opacity: 0.6 },
  saveChipText: { fontSize: 12, color: '#2563EB', fontWeight: '600' },
  nextButton: {
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  nextButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#DC2626', fontSize: 13, marginTop: 10, textAlign: 'center' },
  summaryTitle: { fontSize: 22, fontWeight: '700', color: '#1F2937', marginBottom: 8 },
  summaryLine: { fontSize: 14, color: '#4B5563', marginBottom: 8 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    margin: 16,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
});
