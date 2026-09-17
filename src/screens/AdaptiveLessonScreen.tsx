/**
 * src/screens/AdaptiveLessonScreen.tsx
 *
 * Mobile-first Adaptive Lesson execution (Phase 1).
 *
 * Flow: lesson overview (why + structure) → Start Lesson → step by step →
 * wrap-up → session summary.
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
 *
 * The screen never touches SQLite: it receives an injected AdaptiveLessonService
 * or awaits the composition factory (which owns the adapter bootstrap).
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

import type {
  AdaptiveLessonProgress,
  AdaptiveLessonService,
  AdaptiveLessonSession,
  AdaptiveLessonStep,
  AdaptiveLessonStepMaterial,
  AdaptiveLessonSummary,
  AdaptiveTodayPractice,
} from '../adaptive-lessons';
import { createDefaultAdaptiveLessonService } from '../adaptive-lessons';
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

export default function AdaptiveLessonScreen(props?: AdaptiveLessonScreenProps) {
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
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const serviceRef = useRef<AdaptiveLessonService | null>(props?.service ?? null);
  const ttsRef = useRef<TextToSpeechProvider | null>(props?.ttsProvider ?? null);
  const recorderRef = useRef<AudioRecorderService | null>(props?.recorder ?? null);
  const sttRef = useRef<SpeechToTextProvider | null>(props?.sttProvider ?? null);

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
      }
    } catch {
      setErrorMessage('The lesson summary could not be saved. Your practice itself was kept.');
    } finally {
      setIsBusy(false);
    }
  }, [syncProgress]);

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

  const handlePlay = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        if (!ttsRef.current) {
          // EXISTING voice stack, lazily composed (no second TTS provider).
          const { createExpoTTSProvider } = await import('../talk-demo');
          ttsRef.current = createExpoTTSProvider();
        }
        setIsPlaying(true);
        await ttsRef.current.speak(text);
      } catch {
        setNotice('Audio playback failed. You can still answer by reading or typing.');
      } finally {
        setIsPlaying(false);
      }
    },
    [],
  );

  /** Voice input is offered ONLY when a real STT provider is configured. */
  const ensureVoiceInput = useCallback(async (): Promise<boolean> => {
    if (sttRef.current && recorderRef.current) return true;
    try {
      const { createExpoAudioRecorder, createGeminiSTTProvider, getGeminiApiKey } = await import(
        '../talk-demo'
      );
      const apiKey = getGeminiApiKey();
      // No silent demo fallback: without a real provider there is no mic button.
      if (!apiKey) return false;
      sttRef.current = createGeminiSTTProvider({ apiKey });
      recorderRef.current = createExpoAudioRecorder();
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleToggleRecording = useCallback(async () => {
    const ready = await ensureVoiceInput();
    if (!ready || !recorderRef.current || !sttRef.current) {
      setNotice('Voice capture needs a configured speech provider. You can type your answer instead.');
      return;
    }
    if (isRecording) {
      try {
        const result = await recorderRef.current.stopRecording();
        setIsRecording(false);
        const sttResult = await sttRef.current.transcribe({
          uri: result.uri,
          base64: result.base64,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
        });
        if (sttResult.ok && sttResult.transcript) {
          setAnswer(sttResult.transcript);
        } else {
          setNotice(sttResult.error || 'Speech could not be transcribed. You can type instead.');
        }
      } catch {
        setIsRecording(false);
        setNotice('Voice capture failed. You can type your answer instead.');
      }
      return;
    }
    try {
      const hasPermissions = await recorderRef.current.hasPermissions();
      if (!hasPermissions) {
        const granted = await recorderRef.current.requestPermissions();
        if (!granted) {
          setNotice('Microphone permission was denied. You can type your answer instead.');
          return;
        }
      }
      await recorderRef.current.startRecording();
      setIsRecording(true);
      setNotice(null);
    } catch {
      setNotice('Recording could not start. You can type your answer instead.');
    }
  }, [ensureVoiceInput, isRecording]);

  /* ------------------------- per-kind submissions ------------------------ */

  const handleSubmitReview = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'review' || !currentStep || isBusy) return;
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
      if (outcome.result.kind === 'review') {
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
      }
      setSession(outcome.session);
      syncProgress();
    } catch {
      setErrorMessage('That answer could not be checked right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, currentStep, isBusy, itemIndex, material, syncProgress]);

  const handleSubmitListening = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'listening' || !currentStep || isBusy) return;
    const exercise: ListeningExercise | undefined = material.exercises[itemIndex];
    if (!exercise) return;
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const outcome = await service.submitListeningAnswer(exercise.id, answer, currentStep.id);
      if (!outcome || outcome.result.kind === 'none') {
        setErrorMessage(outcome?.result.kind === 'none' ? outcome.result.message : 'Could not check that answer.');
        return;
      }
      if (outcome.result.kind === 'listening') {
        const evaluation = outcome.result.evaluation;
        const lines: string[] = [
          LISTENING_RESULT_LABELS[evaluation.result] ?? evaluation.result,
          ...evaluation.feedbackLines,
        ];
        if (evaluation.revealedTranscript) lines.push(`Heard: "${evaluation.revealedTranscript}"`);
        setItemFeedback({
          lines,
          detail: evaluation.evaluatedBy === 'unavailable'
            ? 'This answer could not be evaluated right now.'
            : outcome.result.persistenceError
              ? 'Checked, but it could not be saved to your history.'
              : undefined,
        });
      }
      setSession(outcome.session);
      syncProgress();
    } catch {
      setErrorMessage('That answer could not be checked right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, currentStep, isBusy, itemIndex, material, syncProgress]);

  const handleSubmitPronunciation = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || material?.kind !== 'pronunciation' || !currentStep || isBusy) return;
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
      if (outcome.result.kind === 'pronunciation') {
        setItemFeedback({
          lines: outcome.result.lines,
          detail: outcome.result.unavailable
            ? 'Not evaluated — pronunciation analysis was unavailable for this attempt.'
            : outcome.result.observationsDetected > 0
              ? `${outcome.result.observationsDetected} observation(s) added to your pronunciation history.`
              : 'No new pronunciation observation was needed for this attempt.',
        });
      } else if (outcome.result.kind === 'none') {
        setNotice(outcome.result.message);
      }
      setSession(outcome.session);
      syncProgress();
    } catch {
      setErrorMessage('That attempt could not be analyzed right now. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, currentStep, isBusy, material, syncProgress]);

  const handleSubmitSpeaking = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
    if (!answer.trim()) {
      setNotice('Type or record an answer first.');
      return;
    }
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const outcome = await service.submitSpeakingAnswer(answer, currentStep.id);
      if (!outcome) return;
      if (outcome.result.kind === 'speaking') {
        setItemFeedback({
          lines: outcome.result.feedback.lines,
          detail:
            outcome.result.feedback.evaluatedBy === 'unavailable'
              ? 'Not evaluated — no AI feedback was available for this answer.'
              : outcome.result.feedback.reply,
        });
      } else if (outcome.result.kind === 'none') {
        setNotice(outcome.result.message);
      }
      setSession(outcome.session);
      syncProgress();
    } catch {
      setErrorMessage('Your answer could not be sent. Nothing was saved.');
    } finally {
      setIsBusy(false);
    }
  }, [answer, currentStep, isBusy, syncProgress]);

  const handleCompleteStep = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
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
  }, [currentStep, finishLesson, isBusy, openStep, session, syncProgress]);

  /** Move to the next item inside a step, or complete the step. */
  const handleNextItem = useCallback(() => {
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
  }, [handleCompleteStep, itemIndex, material]);

  const handleSkipStep = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || !currentStep || isBusy) return;
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
  }, [currentStep, finishLesson, isBusy, openStep, session, syncProgress]);

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
        {candidate.exerciseType === 'pronunciation_repeat' ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => void handlePlay(candidate.expectedAnswer)}
            disabled={isPlaying}
          >
            <Text style={styles.secondaryButtonText}>
              {isPlaying ? 'Playing…' : 'Play the target'}
            </Text>
          </TouchableOpacity>
        ) : null}
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
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() =>
            void handlePlay(
              exercise.question ? `${exercise.speakText} ${exercise.question}` : exercise.speakText,
            )
          }
          disabled={isPlaying}
        >
          <Text style={styles.secondaryButtonText}>{isPlaying ? 'Playing…' : 'Play audio'}</Text>
        </TouchableOpacity>
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
          placeholder="Type what you hear"
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
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => void handlePlay(material.target)}
          disabled={isPlaying}
        >
          <Text style={styles.secondaryButtonText}>{isPlaying ? 'Playing…' : 'Play the target'}</Text>
        </TouchableOpacity>
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
        {!itemFeedback ? (
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void handleToggleRecording()}>
            <Text style={styles.secondaryButtonText}>
              {isRecording ? 'Stop recording' : 'Use microphone'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const renderSpeakingMaterial = () => {
    if (material?.kind !== 'speaking') return null;
    return (
      <View>
        <Text style={styles.prompt}>{material.prompt}</Text>
        {material.note ? <Text style={styles.honestNote}>{material.note}</Text> : null}
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={answer}
          onChangeText={setAnswer}
          placeholder="Type your answer, or use the microphone"
          placeholderTextColor="#9a9a9e"
          editable={!itemFeedback}
          multiline
        />
        {!itemFeedback ? (
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void handleToggleRecording()}>
            <Text style={styles.secondaryButtonText}>{isRecording ? 'Stop recording' : 'Use microphone'}</Text>
          </TouchableOpacity>
        ) : null}
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
              {itemFeedback.lines.map((line) => (
                <Text key={line} style={styles.feedbackLine}>
                  {line}
                </Text>
              ))}
              {itemFeedback.detail ? (
                <Text style={styles.feedbackDetail}>{itemFeedback.detail}</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {notice ? <Text style={styles.honestNote}>{notice}</Text> : null}

        {material.kind === 'unavailable' || material.kind === 'wrap_up' ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => void handleCompleteStep()}
            disabled={isBusy}
          >
            <Text style={styles.primaryButtonText}>
              {material.kind === 'wrap_up' ? 'Finish lesson' : 'Continue'}
            </Text>
          </TouchableOpacity>
        ) : itemFeedback ? (
          <TouchableOpacity style={styles.primaryButton} onPress={handleNextItem} disabled={isBusy}>
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
            disabled={isBusy}
          >
            <Text style={styles.primaryButtonText}>
              {material.kind === 'speaking' ? 'Send answer' : 'Check answer'}
            </Text>
          </TouchableOpacity>
        )}

        {showSkip ? (
          <TouchableOpacity style={styles.linkButton} onPress={() => void handleSkipStep()} disabled={isBusy}>
            <Text style={styles.linkButtonText}>Skip this step</Text>
          </TouchableOpacity>
        ) : null}
        {showSkip ? (
          <Text style={styles.honestNote}>
            Skipping is recorded as a skip — it does not count as practice and changes nothing.
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
  feedbackLine: { fontSize: 14, color: '#1c1c1e', marginBottom: 4 },
  feedbackDetail: { fontSize: 13, color: '#4a4a4e', marginTop: 4 },
});
