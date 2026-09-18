import React, { useEffect, useState, useRef } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import type { ReviewService } from '../review/service';
import { createReviewService } from '../review/factory';
import type { ReviewItemCandidate, EvaluationResult, ReviewDashboardSummary } from '../review/types';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerWeakness } from '../domain/models/learner';
import type { DailyTutorActivityRef } from '../daily-tutor';
import { reportDailyTutorCompletion } from '../daily-tutor';
import {
  SQLiteUserProfileRepository,
} from '../data/local/sqlite/repositories';
import {
  createExpoAudioRecorder,
  createDemoSTTProvider,
  createGeminiSTTProvider,
  createExpoTTSProvider,
  getGeminiApiKey,
  type AudioRecorderService,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '../talk-demo';

// Fallback Mock items for immediate demo / offline practice out of the box
const MOCK_ITEMS: readonly ReviewItemCandidate[] = [
  {
    id: 'demo-1',
    learnerId: 'demo-user',
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: 'weakness-1',
    prompt: 'Correct the grammatical error in this sentence:',
    contextSentence: 'She walk to school every day.',
    expectedAnswer: 'She walks to school every day.',
    explanation: 'Singular subjects (she, he, it) require the singular verb form ending in -s.',
    dueAt: new Date().toISOString(),
    severity: 0.7,
    status: 'confirmed',
    consecutiveCorrect: 0,
    reviewCount: 2,
  },
  {
    id: 'demo-2',
    learnerId: 'demo-user',
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: 'weakness-2',
    prompt: 'Correct the grammatical error in this sentence:',
    contextSentence: 'I am interested on learning English.',
    expectedAnswer: 'I am interested in learning English.',
    explanation: 'The adjective "interested" is paired with the preposition "in", not "on".',
    dueAt: new Date().toISOString(),
    severity: 0.5,
    status: 'observed',
    consecutiveCorrect: 0,
    reviewCount: 1,
  },
  {
    id: 'demo-3',
    learnerId: 'demo-user',
    kind: 'vocabulary',
    exerciseType: 'vocabulary_recall',
    referenceId: 'vocab-1',
    prompt: 'What word matches this definition?',
    definition: 'A sudden, intuitive perception of or insight into the reality or essential meaning of something.',
    expectedAnswer: 'Epiphany',
    explanation: 'An epiphany is a moment of sudden revelation or insight.',
    dueAt: new Date().toISOString(),
    status: 'active_training',
    consecutiveCorrect: 0,
    reviewCount: 1,
  },
  {
    id: 'demo-4',
    learnerId: 'demo-user',
    kind: 'vocabulary',
    exerciseType: 'fill_the_gap',
    referenceId: 'vocab-2',
    prompt: 'Fill in the blank with the appropriate word:',
    contextSentence: 'The _____ plants survived the harsh winter.',
    definition: 'Able to withstand or recover quickly from difficult conditions.',
    expectedAnswer: 'resilient',
    explanation: 'Resilient means able to withstand or recover quickly from difficult conditions.',
    dueAt: new Date().toISOString(),
    status: 'active_training',
    consecutiveCorrect: 0,
    reviewCount: 2,
  },
  {
    id: 'demo-5',
    learnerId: 'demo-user',
    kind: 'expression',
    exerciseType: 'expression_use',
    referenceId: 'expr-1',
    prompt: 'Complete or paraphrase this sentence using the expression "Bite the bullet":',
    contextSentence: 'Bite the bullet',
    definition: 'Face a difficult situation with courage and resign oneself to it.',
    expectedAnswer: 'bite the bullet',
    explanation: 'To bite the bullet means to accept a difficult or inevitable situation with fortitude.',
    dueAt: new Date().toISOString(),
    status: 'active_training',
    consecutiveCorrect: 0,
    reviewCount: 0,
  }
];

export interface ReviewScreenProps {
  readonly initialDemoMode?: boolean;
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  /** Injectable TTS (existing provider) for listening review items. */
  readonly ttsProvider?: TextToSpeechProvider;
}

/**
 * Daily Tutor handshake params (present ONLY when the Daily Tutor launched
 * this screen; standalone use of the Review tab never sets them):
 * - the activity ref to echo back on REAL completion,
 * - an optional bounded review subset (kind emphasis + item limit).
 */
interface DailyTutorReviewParams extends DailyTutorActivityRef {
  readonly reviewKind?: 'vocabulary' | 'expression' | 'grammar';
  readonly reviewLimit?: number;
}

export default function ReviewScreen(props?: ReviewScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const route = useRoute() as { readonly params?: { readonly dailyTutor?: DailyTutorReviewParams } };
  const dailyTutorRef = route.params?.dailyTutor;
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

  // Voice recording and STT refs and state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const sttRef = useRef<SpeechToTextProvider | null>(null);
  const ttsRef = useRef<TextToSpeechProvider | null>(props?.ttsProvider ?? null);
  const [isPlayingListening, setIsPlayingListening] = useState<boolean>(false);

  useEffect(() => {
    recorderRef.current = props?.recorder || createExpoAudioRecorder();
    const apiKey = getGeminiApiKey();
    sttRef.current = props?.sttProvider || (apiKey ? createGeminiSTTProvider({ apiKey }) : createDemoSTTProvider());
  }, [props?.recorder, props?.sttProvider]);

  // Initialize DB Adapter and ReviewService
  useEffect(() => {
    let active = true;

    async function init() {
      try {
        const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
        const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
        await adapter.init();
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
          setError('Local storage unavailable. Failed to initialize review database.');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      active = false;
    };
  }, []);

  const loadDashboardMetrics = async () => {
    if (!reviewServiceRef.current) return;
    try {
      setLoading(true);
      if (isDemoMode) {
        setSummary({
          totalDue: 5,
          dueVocabularyCount: 2,
          dueExpressionCount: 1,
          activeWeaknessCount: 2,
          categories: [
            { key: 'grammar', label: 'Grammar & Phrasing', dueCount: 2 },
            { key: 'vocabulary', label: 'Vocabulary Recall', dueCount: 2 },
            { key: 'expression', label: 'Expressions & Idioms', dueCount: 1 },
          ],
        });
        setActiveWeaknesses([]);
        setHasNoProfile(false);
        return;
      }

      const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
      const profile = await profileRepo.get();
      if (!profile || !profile.id) {
        setHasNoProfile(true);
        return;
      }
      setHasNoProfile(false);
      const learnerId = profile.id;

      const dashSummary = await reviewServiceRef.current.getDashboardSummary(learnerId);
      const weaknesses = await reviewServiceRef.current.getActiveWeaknesses(learnerId);

      setSummary(dashSummary);
      setActiveWeaknesses(weaknesses);
    } catch (err) {
      console.error('Error loading review dashboard metrics:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRecording = async () => {
    if (!recorderRef.current || !sttRef.current) return;

    if (isRecording) {
      try {
        const result = await recorderRef.current.stopRecording();
        setIsRecording(false);
        setRecorderError(null);

        const sttRes = await sttRef.current.transcribe({
          uri: result.uri,
          base64: result.base64,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
        });

        if (sttRes.ok && sttRes.transcript) {
          // Voice transcript populates answer text box only, allowing manual correction
          setUserAnswer(sttRes.transcript);
        } else {
          setRecorderError(sttRes.error || 'Failed to transcribe speech.');
        }
      } catch (err) {
        console.error('Error stopping voice recording:', err);
        setRecorderError(err instanceof Error ? err.message : 'Error transcribing audio.');
        setIsRecording(false);
      }
    } else {
      try {
        setRecorderError(null);
        const hasPerms = await recorderRef.current.hasPermissions();
        if (!hasPerms) {
          const granted = await recorderRef.current.requestPermissions();
          if (!granted) {
            setRecorderError('Microphone permissions denied.');
            return;
          }
        }
        await recorderRef.current.startRecording();
        setIsRecording(true);
      } catch (err) {
        console.error('Error starting voice recording:', err);
        setRecorderError(err instanceof Error ? err.message : 'Failed to start recording.');
        setIsRecording(false);
      }
    }
  };

  const handleStartSession = async (
    dailyOptions?: { reviewKind?: 'vocabulary' | 'expression' | 'grammar'; reviewLimit?: number },
  ) => {
    if (isDemoMode) {
      setSessionCandidates(MOCK_ITEMS);
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
      const profile = await profileRepo.get();
      if (!profile || !profile.id) {
        setHasNoProfile(true);
        return;
      }
      const learnerId = profile.id;

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
      // A real empty queue stays genuinely empty — pre-built cards are only for explicit Demo Mode.
      setSessionCandidates(bounded);

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
  const dailyAutoStartedRef = useRef<string | null>(null);
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
    if (!candidate || isEvaluating) return;

    try {
      setIsEvaluating(true);

      let evalResult: EvaluationResult;
      if (isDemoMode || !reviewServiceRef.current) {
        // Evaluate locally
        const normUser = userAnswer.trim().toLowerCase();
        const normExpected = candidate.expectedAnswer.trim().toLowerCase();
        if (normUser === normExpected) {
          evalResult = {
            result: 'correct',
            feedback: 'Excellent! Your answer matches perfectly.',
            explanation: candidate.explanation,
            suggestedCorrection: candidate.expectedAnswer,
          };
        } else if (normUser.length > 2 && normExpected.includes(normUser)) {
          evalResult = {
            result: 'partial',
            feedback: 'Almost! Check the phrasing or spelling.',
            explanation: candidate.explanation,
            suggestedCorrection: candidate.expectedAnswer,
          };
        } else {
          evalResult = {
            result: 'incorrect',
            feedback: 'Not quite. Check the suggested answer.',
            explanation: candidate.explanation,
            suggestedCorrection: candidate.expectedAnswer,
          };
        }
      } else {
        // Real database/AI evaluation
        evalResult = await reviewServiceRef.current.evaluateAnswer(candidate, userAnswer);

        // Record practice result in SQLite persistence
        const profileRepo = new SQLiteUserProfileRepository(dbAdapterRef.current!);
        const profile = await profileRepo.get();
        if (profile && profile.id) {
          await reviewServiceRef.current.recordPracticeResult(
            profile.id,
            candidate,
            userAnswer,
            evalResult
          );
        }
      }

      setEvaluation(evalResult);

      // Update session metrics tally
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
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleNextItem = async () => {
    if (currentIndex + 1 < sessionCandidates.length) {
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
      // reaches this point, so an unfinished review never completes.
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
      }
      setSessionState('completed');
    }
  };

  const handleExitSession = () => {
    setSessionState('dashboard');
    loadDashboardMetrics();
  };

  if (loading && sessionState === 'dashboard') {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Loading adaptive review system...</Text>
      </View>
    );
  }

  if (error && sessionState === 'dashboard') {
    return (
      <View style={styles.loadingContainer}>
        <Text style={[styles.loadingText, { color: '#DC2626' }]}>{error}</Text>
      </View>
    );
  }

  // 1. DASHBOARD VIEW
  if (sessionState === 'dashboard') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          <Text style={styles.title} id="review_title">Adaptive Review</Text>
          <Text style={styles.subtitle}>Spaced repetition practice & weakness retraining</Text>
        </View>

        {hasNoProfile && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>
              👤 No active learner profile found. Please complete a conversation first, or click below to enable Demo Mode for instant practice!
            </Text>
            <TouchableOpacity
              style={[styles.startSessionButton, { marginTop: 12, backgroundColor: '#059669' }]}
              onPress={() => {
                setIsDemoMode(true);
                loadDashboardMetrics();
              }}
            >
              <Text style={styles.startSessionButtonText}>Enable Practice Demo Mode</Text>
            </TouchableOpacity>
          </View>
        )}

        {isDemoMode && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>
              💡 Demo Mode active: No historical learning data found yet. Start practice below using pre-loaded high-quality review cards!
            </Text>
          </View>
        )}

        {sessionError && !isDemoMode && (
          <View style={styles.sessionErrorBanner}>
            <Text style={styles.sessionErrorBannerText}>⚠️ {sessionError}</Text>
          </View>
        )}

        {/* High-Contrast Due Counter Card */}
        <View style={styles.totalDueCard}>
          <Text style={styles.totalDueNumber}>{summary.totalDue}</Text>
          <Text style={styles.totalDueLabel}>Items Due for Retraining</Text>
          <TouchableOpacity
            style={[
              styles.startSessionButton,
              (hasNoProfile && !isDemoMode) && styles.startSessionButtonDisabled
            ]}
            onPress={() => void handleStartSession()}
            disabled={hasNoProfile && !isDemoMode}
            accessibilityRole="button"
            id="start_review_button"
          >
            <Text style={styles.startSessionButtonText}>
              {(hasNoProfile && !isDemoMode) ? 'Waiting for profile...' : `Start Practice Session (${Math.min(10, summary.totalDue || 5)} Items)`}
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
            <Text style={styles.gridCardLabel}>Active Weaknesses</Text>
          </View>
        </View>

        {/* Active Weaknesses List */}
        <Text style={styles.sectionHeader}>Current Priority Weaknesses</Text>
        {activeWeaknesses.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyCardText}>
              🎉 Great job! You have no outstanding grammatical weaknesses. Any errors spotted during conversation practice will appear here automatically.
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
      <ScrollView style={styles.container} contentContainerStyle={styles.practiceContainer}>
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
                <TextInput
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
                  id="answer_input_field"
                />
                <TouchableOpacity
                  style={[
                    styles.submitButton,
                    !userAnswer.trim() && styles.submitButtonDisabled,
                  ]}
                  onPress={handleSubmitAnswer}
                  disabled={!userAnswer.trim() || isEvaluating}
                  accessibilityRole="button"
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
                <TouchableOpacity
                  style={[
                    styles.micButton,
                    isRecording && styles.micButtonRecording,
                  ]}
                  onPress={handleToggleRecording}
                  accessibilityRole="button"
                  id="toggle_recording_button"
                >
                  <Text style={styles.micButtonText}>
                    {isRecording ? '🛑 Stop Recording' : '🎤 Answer with Voice'}
                  </Text>
                </TouchableOpacity>
                {isRecording && (
                  <View style={styles.recordingIndicator}>
                    <View style={styles.pulseDot} />
                    <Text style={styles.recordingText}>Listening... Speak your answer now.</Text>
                  </View>
                )}
                {recorderError && (
                  <Text style={styles.recorderErrorText}>{recorderError}</Text>
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
    <View style={styles.container}>
      <View style={styles.completionCard}>
        <Text style={styles.completionIcon}>🎓</Text>
        <Text style={styles.completionTitle}>Session Completed!</Text>
        <Text style={styles.completionSubtitle}>
          You finished practicing {sessionCandidates.length} personalized cards.
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
          <Text style={styles.doneButtonText}>Return to Dashboard</Text>
        </TouchableOpacity>
        {dailyTutorRef ? (
          <TouchableOpacity
            style={styles.doneButton}
            onPress={() => navigation.navigate('DailyTutor')}
          >
            <Text style={styles.doneButtonText}>Back to today&apos;s practice</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
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
    fontSize: 11,
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
    fontSize: 10,
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
    fontSize: 10,
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
    fontSize: 11,
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
    fontSize: 11,
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
