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
  TouchableOpacity,
  View,
} from 'react-native';
import type { TextToSpeechProvider } from '../talk-demo';
import type { ListeningService } from '../listening';
import { createDefaultListeningService } from '../listening';
import type {
  ListeningDifficulty,
  ListeningEvaluation,
  ListeningExercise,
} from '../listening';

export interface ListeningScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: ListeningService;
  /** Injectable TTS (existing provider abstraction). */
  readonly ttsProvider?: TextToSpeechProvider;
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
  const [session, setSession] = useState<SessionState | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [answer, setAnswer] = useState<string>('');
  const [evaluation, setEvaluation] = useState<ListeningEvaluation | null>(null);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [replayCount, setReplayCount] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<ListeningDifficulty>('easy');
  const [savedItems, setSavedItems] = useState<readonly string[]>([]);
  const [sessionDone, setSessionDone] = useState<boolean>(false);
  const [problemCount, setProblemCount] = useState<number>(0);

  const serviceRef = useRef<ListeningService | null>(props?.service ?? null);
  const ttsRef = useRef<TextToSpeechProvider | null>(props?.ttsProvider ?? null);
  const resultsRef = useRef<{ problems: number; understood: number }>({
    problems: 0,
    understood: 0,
  });

  useEffect(() => {
    if (serviceRef.current) return;
    let active = true;
    createDefaultListeningService()
      .then((service) => {
        if (active) serviceRef.current = service;
      })
      .catch(() => {
        if (active) setErrorMessage('Listening practice could not be loaded. Please try again.');
      });
    return () => {
      active = false;
    };
  }, []);

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
      const result = await service.startSession(learner, { difficulty });
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

  const resetExerciseState = () => {
    setAnswer('');
    setEvaluation(null);
    setReplayCount(0);
    setSavedItems([]);
  };

  /** Play/replay via the EXISTING TTS provider. Failure-safe: the exercise is never lost. */
  const handlePlay = async () => {
    if (!currentExercise) return;
    try {
      if (!ttsRef.current) {
        const { createExpoTTSProvider } = await import('../talk-demo');
        ttsRef.current = createExpoTTSProvider();
      }
      setIsPlaying(true);
      await ttsRef.current.speak(
        currentExercise.question
          ? `${currentExercise.speakText} ${currentExercise.question}`
          : currentExercise.speakText,
      );
      setIsPlaying(false);
      setReplayCount((count) => count + 1);
    } catch {
      setIsPlaying(false);
      setErrorMessage(
        'Audio playback failed. Use Replay to try again — your exercise and answer are kept.',
      );
    }
  };

  const handleStop = async () => {
    try {
      await ttsRef.current?.stop();
    } catch {
      // Stop failures are harmless.
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
  };

  // ---------- Empty / start state ----------
  if (!session || !currentExercise) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.centerContent}>
        <Text style={styles.title}>🎧 Listening</Text>
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

        <TouchableOpacity
          style={[styles.startButton, isStarting && styles.startButtonDisabled]}
          onPress={startSession}
          disabled={isStarting}
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

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
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
          <TouchableOpacity style={styles.startButton} onPress={startSession}>
            <Text style={styles.startButtonText}>Practice again</Text>
          </TouchableOpacity>
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
    <ScrollView style={styles.container} contentContainerStyle={styles.practiceContent}>
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
            <TextInput
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
  container: { flex: 1, backgroundColor: '#F5F7FB' },
  centerContent: { alignItems: 'center', justifyContent: 'center', padding: 24, flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '700', color: '#1F2937', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#4B5563', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  difficultyRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  difficultyPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  difficultyPillActive: { backgroundColor: '#1F4E9C', borderColor: '#1F4E9C' },
  difficultyPillText: { color: '#374151', fontSize: 13, textTransform: 'capitalize' },
  difficultyPillTextActive: { color: '#FFFFFF', fontWeight: '600' },
  startButton: {
    backgroundColor: '#1F4E9C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  startButtonDisabled: { opacity: 0.6 },
  startButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  practiceContent: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  counter: { fontSize: 13, color: '#6B7280', fontWeight: '600' },
  typeLabel: { fontSize: 13, color: '#1F4E9C', fontWeight: '700' },
  sourceNote: { fontSize: 12, color: '#6B7280', marginTop: 2, marginBottom: 10 },
  playRow: { flexDirection: 'row', gap: 8, marginVertical: 12 },
  playButton: {
    backgroundColor: '#1F4E9C',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  playButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  replayButton: {
    backgroundColor: '#E5EDFB',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  stopButton: {
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  replayButtonText: { color: '#1F4E9C', fontWeight: '600', fontSize: 14 },
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
  optionButtonSelected: { borderColor: '#1F4E9C', backgroundColor: '#EEF4FF' },
  optionText: { fontSize: 14, color: '#1F2937' },
  optionTextSelected: { color: '#1F4E9C', fontWeight: '600' },
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
    backgroundColor: '#1F4E9C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
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
    color: '#1F4E9C',
    textTransform: 'capitalize',
    marginBottom: 8,
  },
  feedbackLine: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 4 },
  saveRow: { marginTop: 10, gap: 6 },
  saveItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveItemLabel: { fontSize: 13, color: '#1F2937', fontWeight: '600', flexShrink: 1 },
  saveChip: {
    backgroundColor: '#EEF4FF',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#C9DAF8',
  },
  saveChipDone: { opacity: 0.6 },
  saveChipText: { fontSize: 12, color: '#1F4E9C', fontWeight: '600' },
  nextButton: {
    backgroundColor: '#2E7D32',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  nextButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#B91C1C', fontSize: 13, marginTop: 10, textAlign: 'center' },
  summaryTitle: { fontSize: 22, fontWeight: '700', color: '#1F2937', marginBottom: 8 },
  summaryLine: { fontSize: 14, color: '#4B5563', marginBottom: 8 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    margin: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
});
