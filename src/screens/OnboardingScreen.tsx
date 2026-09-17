/**
 * src/screens/OnboardingScreen.tsx
 *
 * Personalized Onboarding & Diagnostic Assessment (Phase 1) — the learner-facing
 * flow.
 *
 * The screen is a VIEW over the domain service: the profile write, the diagnostic
 * progression, the evidence and the level decision all live in
 * src/onboarding (state machine + service) — never in React side effects.
 *
 * Voice-first, with the manual text fallback kept: the tutor prompt may be
 * spoken through the EXISTING voice coordinator over the SAME ConversationSession
 * (mic → existing STT → existing engine → existing TTS). There is no automatic
 * always-listening microphone and no second voice coordinator.
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
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';

import type { CefrLevel, ConversationMode } from '../domain/shared/types';
import {
  createDefaultOnboardingService,
  describeConfidence,
  describeEstimate,
  LEARNING_GOAL_OPTIONS,
  NATIVE_LANGUAGE_OPTIONS,
  type DiagnosticHandle,
  type DiagnosticResult,
  type DiagnosticStepId,
  type ListeningExercise,
  type OnboardingPrefill,
  type OnboardingService,
} from '../onboarding';
import { createTalkVoiceCoordinator, type TalkProviderKind } from '../talk-demo';
import type { VoiceSessionCoordinator, VoiceStatus } from '../voice';

export interface OnboardingScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: OnboardingService;
  /** Injectable coordinator factory (tests); defaults to the existing factory. */
  readonly createCoordinator?: (input: {
    readonly session: DiagnosticHandle['conversation'];
    readonly providerKind: TalkProviderKind;
  }) => VoiceSessionCoordinator;
}

type Phase = 'loading' | 'error' | 'profile' | 'diagnostic' | 'result';

const TARGET_LEVELS: readonly CefrLevel[] = ['A2', 'B1', 'B2', 'C1'];
const PRACTICE_MODES: readonly { readonly id: ConversationMode; readonly label: string }[] = [
  { id: 'natural', label: 'Natural conversation' },
  { id: 'coach', label: 'Coach me as we talk' },
  { id: 'intensive', label: 'Drill my weak spots' },
];

const STEP_TITLES: Record<DiagnosticStepId, string> = {
  profile: 'Your goals',
  speaking: 'Speaking',
  listening: 'Listening',
  language_use: 'Natural phrasing',
  pronunciation: 'Pronunciation',
  summary: 'Your result',
};

/** Spoken prompts the tutor uses during the speaking part (bounded). */
const SPEAKING_PROMPT = 'Tell me a little about yourself and what you do.';

export default function OnboardingScreen(props?: OnboardingScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const serviceRef = useRef<OnboardingService | null>(props?.service ?? null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [prefill, setPrefill] = useState<OnboardingPrefill | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Profile draft (prefilled from the existing profile; nothing overwritten silently).
  const [displayName, setDisplayName] = useState<string>('');
  const [nativeLanguage, setNativeLanguage] = useState<string | null>(null);
  const [targetLevel, setTargetLevel] = useState<CefrLevel | null>(null);
  const [goals, setGoals] = useState<readonly string[]>([]);
  const [modes, setModes] = useState<readonly ConversationMode[]>([]);

  // Diagnostic state.
  const handleRef = useRef<DiagnosticHandle | null>(null);
  const coordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const unsubscribeVoiceRef = useRef<(() => void) | null>(null);
  const [stepId, setStepId] = useState<DiagnosticStepId>('profile');
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [turns, setTurns] = useState<number>(0);
  const [textAnswer, setTextAnswer] = useState<string>('');

  // Listening step.
  const [exercise, setExercise] = useState<ListeningExercise | null>(null);
  const [listeningNote, setListeningNote] = useState<string | null>(null);
  const [listeningAnswer, setListeningAnswer] = useState<string>('');

  // Result.
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [decisionLine, setDecisionLine] = useState<string | null>(null);

  const getService = useCallback(async (): Promise<OnboardingService> => {
    if (serviceRef.current) return serviceRef.current;
    const service = await createDefaultOnboardingService();
    serviceRef.current = service;
    return service;
  }, []);

  // ── load: prefill the learner's OWN existing profile (no silent overwrite)
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const service = await getService();
        const loaded = await service.loadPrefill();
        if (!active) return;
        setPrefill(loaded);
        setDisplayName(loaded.displayName);
        setNativeLanguage(loaded.nativeLanguage);
        setTargetLevel(loaded.targetLevel === 'unknown' ? null : loaded.targetLevel);
        setGoals(loaded.learningGoals);
        setModes(loaded.preferredModes);
        setPhase('profile');
      } catch {
        if (!active) return;
        setErrorMessage('Your learning profile is unavailable right now. Nothing was changed.');
        setPhase('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [getService]);

  // ── leaving the screen: stop voice work, never fake completion
  useEffect(
    () => () => {
      const handle = handleRef.current;
      if (handle && handle.session.getStatus() === 'in_progress') {
        // An interrupted diagnostic is abandoned: it can never be reported as
        // completed and no level is produced from a partial conversation.
        handle.session.abandon();
      }
      unsubscribeVoiceRef.current?.();
      unsubscribeVoiceRef.current = null;
      const coordinator = coordinatorRef.current;
      coordinatorRef.current = null;
      void coordinator?.dispose();
    },
    [],
  );

  const toggleGoal = (label: string) =>
    setGoals((current) =>
      current.includes(label) ? current.filter((goal) => goal !== label) : [...current, label],
    );

  const toggleMode = (mode: ConversationMode) =>
    setModes((current) =>
      current.includes(mode) ? current.filter((entry) => entry !== mode) : [...current, mode],
    );

  // ── profile step → speaking step (the flow itself lives in the service)
  const startDiagnostic = useCallback(async () => {
    setBusy(true);
    setTurnError(null);
    try {
      const service = await getService();
      await service.saveProfileDraft({
        displayName,
        ...(nativeLanguage ? { nativeLanguage } : {}),
        targetLevel: targetLevel ?? 'unknown',
        learningGoals: goals,
        preferredModes: modes,
      });
      const handle = await service.beginDiagnostic();
      handleRef.current = handle;
      const token = handle.session.getCurrentStepToken();
      handle.session.markProfileStepDone(token);
      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
      const factory =
        props?.createCoordinator ??
        ((input: { session: DiagnosticHandle['conversation']; providerKind: TalkProviderKind }) =>
          createTalkVoiceCoordinator({
            session: input.session,
            providerKind: input.providerKind,
          }));
      const coordinator = factory({
        session: handle.conversation,
        providerKind: handle.providerKind,
      });
      coordinatorRef.current = coordinator;
      setVoiceStatus(coordinator.getStatus());
      unsubscribeVoiceRef.current?.();
      unsubscribeVoiceRef.current = coordinator.subscribe(setVoiceStatus);
      setPhase('diagnostic');
    } catch {
      setErrorMessage('The assessment could not start. Your profile was not changed.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, [displayName, getService, goals, modes, nativeLanguage, props?.createCoordinator, targetLevel]);

  /** Mic press — never auto-opens the microphone; the learner is in control. */
  const pressMic = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const handle = handleRef.current;
    if (!coordinator || !handle) return;
    setTurnError(null);
    if (coordinator.getStatus().state === 'recording') {
      setBusy(true);
      try {
        const outcome = await coordinator.stopRecordingAndProcess();
        // The EXISTING coordinator committed the turn through the EXISTING
        // session; the diagnostic only absorbs what was really committed.
        handle.speaking.observeCommittedHistory({
          purpose: handle.session.getCurrentStepId() === 'language_use' ? 'language_use' : 'speaking',
        });
        setTurns(handle.conversation.getHistory().length);
        if (!outcome.ok) {
          setTurnError(outcome.error ?? 'That turn could not be completed. Nothing was recorded.');
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    await coordinator.startRecording();
  }, []);

  /** Manual text fallback — the SAME existing conversation path. */
  const submitTextAnswer = useCallback(async () => {
    const handle = handleRef.current;
    const service = serviceRef.current;
    const answer = textAnswer.trim();
    if (!handle || !service || !answer) return;
    setBusy(true);
    setTurnError(null);
    try {
      const onLanguageUse = handle.session.getCurrentStepId() === 'language_use';
      const outcome = onLanguageUse
        ? await service.recordLanguageUseAnswer(handle, answer)
        : await service.recordSpeakingAnswer(handle, answer);
      if (!outcome.ok) {
        setTurnError(outcome.errorMessage ?? 'That answer could not be evaluated. Nothing was recorded.');
      }
      setTextAnswer('');
      setTurns(handle.conversation.getHistory().length);
    } finally {
      setBusy(false);
    }
  }, [textAnswer]);

  /** Continue to the next step (the state machine owns the transition). */
  const continueStep = useCallback(async () => {
    const handle = handleRef.current;
    const service = serviceRef.current;
    if (!handle || !service) return;
    setTurnError(null);
    const current = handle.session.getCurrentStepId();

    if (current === 'speaking') {
      if (handle.speaking.getSpeakingEvidence().committedLearnerTurns === 0) {
        setTurnError('Say at least one answer before continuing.');
        return;
      }
      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
      return;
    }

    if (current === 'listening') {
      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
      return;
    }

    if (current === 'language_use') {
      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
      return;
    }

    if (current === 'pronunciation') {
      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
      return;
    }

    if (current === 'summary') {
      // The service refuses to finish an incomplete/abandoned diagnostic.
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());
      setBusy(true);
      try {
        const finished = await service.finishDiagnostic(handle);
        if (!finished) {
          setTurnError('The assessment is not complete yet, so no result was produced.');
          return;
        }
        setResult(finished);
        setPhase('result');
      } finally {
        setBusy(false);
      }
    }
  }, []);

  /** The listening task is planned when the step becomes current. */
  useEffect(() => {
    if (phase !== 'diagnostic' || stepId !== 'listening') return;
    const handle = handleRef.current;
    if (!handle || exercise) return;
    let active = true;
    void (async () => {
      const service = serviceRef.current;
      if (!service) return;
      const planned = await service.startListeningTask(handle);
      if (!active) return;
      if (planned.status === 'ready') {
        setExercise(planned.exercise);
        setListeningNote(null);
      } else {
        // Unavailable infrastructure is stated plainly — never a learner error.
        setListeningNote(planned.message);
      }
    })();
    return () => {
      active = false;
    };
  }, [exercise, phase, stepId]);

  /** Pronunciation is analysed once, from a REAL spoken turn (or omitted). */
  useEffect(() => {
    if (phase !== 'diagnostic' || stepId !== 'pronunciation') return;
    const handle = handleRef.current;
    if (!handle) return;
    let active = true;
    void (async () => {
      const service = serviceRef.current;
      if (!service) return;
      const spoken = [...handle.conversation.getHistory()]
        .reverse()
        .find((turn) => turn.role === 'user');
      if (!spoken?.content.trim()) {
        handle.session.markPronunciationUnavailable(
          'No spoken turn was recorded, so pronunciation was not assessed.',
          handle.session.getCurrentStepToken(),
        );
        return;
      }
      await service.recordPronunciation(handle, spoken.content);
      if (active) setTurns(handle.conversation.getHistory().length);
    })();
    return () => {
      active = false;
    };
  }, [phase, stepId]);

  const submitListeningAnswer = useCallback(async () => {
    const handle = handleRef.current;
    const service = serviceRef.current;
    if (!handle || !service || !exercise) return;
    const answer = listeningAnswer.trim();
    if (!answer) return;
    setBusy(true);
    try {
      const outcome = await service.recordListeningAnswer(handle, exercise, answer);
      setListeningNote(outcome.message);
    } finally {
      setBusy(false);
    }
  }, [exercise, listeningAnswer]);

  const acceptLevel = useCallback(async () => {
    if (!result) return;
    const service = serviceRef.current;
    if (!service) return;
    const decision = await service.acceptEstimatedLevel(result.estimate);
    setDecisionLine(
      decision.reason === 'accepted'
        ? `Saved. Your working level is now ${decision.currentLevel}.`
        : decision.reason === 'already-accepted'
          ? `Your level is already ${decision.currentLevel}.`
          : 'That level could not be saved. Nothing was changed.',
    );
  }, [result]);

  const keepLevel = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    const decision = await service.keepCurrentLevel();
    setDecisionLine(`Kept your current level (${decision.currentLevel}). Nothing was changed.`);
  }, []);

  const stepTitle = useMemo(() => STEP_TITLES[stepId], [stepId]);

  // ── result: compact, qualitative, no gamification
  const renderResult = (resultValue: DiagnosticResult) => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Your result</Text>
      <Text style={styles.headline}>{describeEstimate(resultValue.estimate)}</Text>
      {resultValue.estimate.status === 'estimated' ? (
        <Text style={styles.muted}>{describeConfidence(resultValue.estimate.confidence)}</Text>
      ) : null}
      {resultValue.estimate.basis.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What this is based on</Text>
          {resultValue.estimate.basis.map((line) => (
            <Text key={line} style={styles.listLine}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}

      {resultValue.strengths.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What you handled well</Text>
          {resultValue.strengths.map((line) => (
            <Text key={line} style={styles.listLine}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}

      {resultValue.focusAreas.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Areas to practice</Text>
          {resultValue.focusAreas.map((line) => (
            <Text key={line} style={styles.listLine}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Speaking</Text>
        <Text style={styles.body}>{resultValue.speakingLine}</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Listening</Text>
        <Text style={styles.body}>{resultValue.listeningLine}</Text>
      </View>
      {resultValue.pronunciationLines ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pronunciation</Text>
          {resultValue.pronunciationLines.map((line) => (
            <Text key={line} style={styles.listLine}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recommended focus</Text>
        <Text style={styles.body}>{resultValue.recommendedFocus}</Text>
      </View>

      {resultValue.notices.length > 0 ? (
        <View style={styles.section}>
          {resultValue.notices.map((line) => (
            <Text key={line} style={styles.notice}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {resultValue.estimate.status === 'estimated' ? (
        <View style={styles.section}>
          <Text style={styles.body}>
            Your practice will follow this working level only if you accept it. Your current level
            stays {resultValue.profile.currentLevel} unless you choose otherwise.
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => void acceptLevel()}>
            <Text style={styles.primaryButtonText}>Use this level</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void keepLevel()}>
            <Text style={styles.secondaryButtonText}>Keep my current level</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.body}>
            Your current level stays {resultValue.profile.currentLevel}. Keep practising and the
            picture will become clearer.
          </Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate('MainTabs')}
          >
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      )}

      {decisionLine ? <Text style={styles.savedLine}>{decisionLine}</Text> : null}

      <TouchableOpacity
        style={styles.linkButton}
        onPress={() => navigation.navigate('MainTabs')}
      >
        <Text style={styles.linkText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  );

  // ── render helpers for the diagnostic steps
  const renderSpeakingStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      <Text style={styles.body}>{SPEAKING_PROMPT}</Text>
      <Text style={styles.muted}>
        Tap the microphone and answer out loud, or type your answer below.
      </Text>
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.micButton, voiceStatus?.state === 'recording' ? styles.micButtonOn : null]}
          onPress={() => void pressMic()}
        >
          <Text style={styles.micButtonText}>
            {voiceStatus?.state === 'recording' ? 'Stop' : 'Speak'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => void coordinatorRef.current?.speakResponse(SPEAKING_PROMPT)}
        >
          <Text style={styles.secondaryButtonText}>Hear the question</Text>
        </TouchableOpacity>
      </View>
      {voiceStatus?.recognizedTranscript ? (
        <Text style={styles.muted}>You said: {voiceStatus.recognizedTranscript}</Text>
      ) : null}
      {voiceStatus?.errorMessage ? (
        <Text style={styles.errorText}>{voiceStatus.errorMessage}</Text>
      ) : null}
      <TextInput
        style={styles.input}
        placeholder="Type your answer (fallback)"
        value={textAnswer}
        onChangeText={setTextAnswer}
        multiline
      />
      <TouchableOpacity style={styles.secondaryButton} onPress={() => void submitTextAnswer()}>
        <Text style={styles.secondaryButtonText}>Send typed answer</Text>
      </TouchableOpacity>
      <Text style={styles.muted}>Turns recorded: {turns}</Text>
      <TouchableOpacity style={styles.primaryButton} onPress={() => void continueStep()}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  const renderListeningStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      {exercise ? (
        <>
          <Text style={styles.body}>Listen, then answer with what you understood.</Text>
          {exercise.question ? <Text style={styles.body}>{exercise.question}</Text> : null}
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => void coordinatorRef.current?.speakResponse(exercise.speakText)}
          >
            <Text style={styles.secondaryButtonText}>Play the passage</Text>
          </TouchableOpacity>
          {exercise.options && exercise.options.length > 0 ? (
            <View style={styles.section}>
              {exercise.options.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={styles.optionButton}
                  onPress={() => setListeningAnswer(option)}
                >
                  <Text style={styles.optionText}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <TextInput
            style={styles.input}
            placeholder="Your answer"
            value={listeningAnswer}
            onChangeText={setListeningAnswer}
          />
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void submitListeningAnswer()}>
            <Text style={styles.secondaryButtonText}>Check my answer</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={styles.muted}>
          {listeningNote ?? 'Preparing a listening task…'}
        </Text>
      )}
      {listeningNote && exercise ? <Text style={styles.savedLine}>{listeningNote}</Text> : null}
      <TouchableOpacity style={styles.primaryButton} onPress={() => void continueStep()}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  const renderLanguageUseStep = () => {
    const handle = handleRef.current;
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{stepTitle}</Text>
        <Text style={styles.body}>{handle?.languageUseTask.prompt ?? 'Say it your own way.'}</Text>
        <Text style={styles.muted}>Answer in your own words — there is no single correct version.</Text>
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.micButton, voiceStatus?.state === 'recording' ? styles.micButtonOn : null]}
            onPress={() => void pressMic()}
          >
            <Text style={styles.micButtonText}>
              {voiceStatus?.state === 'recording' ? 'Stop' : 'Speak'}
            </Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.input}
          placeholder="Type your answer (fallback)"
          value={textAnswer}
          onChangeText={setTextAnswer}
          multiline
        />
        <TouchableOpacity style={styles.secondaryButton} onPress={() => void submitTextAnswer()}>
          <Text style={styles.secondaryButtonText}>Send typed answer</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.primaryButton} onPress={() => void continueStep()}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderPronunciationStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      <Text style={styles.body}>
        We listened to your spoken answer and noted what was clear.
      </Text>
      {handleRef.current?.session.snapshot().evidence.pronunciation ? (
        handleRef.current.session.snapshot().evidence.pronunciation?.noteLines.map((line) => (
          <Text key={line} style={styles.listLine}>
            • {line}
          </Text>
        ))
      ) : (
        <Text style={styles.muted}>
          No pronunciation observations were recorded, so this part is left out of your result.
        </Text>
      )}
      <TouchableOpacity style={styles.primaryButton} onPress={() => void continueStep()}>
        <Text style={styles.primaryButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  const renderSummaryStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      <Text style={styles.body}>
        That is everything. Your result is based only on what really happened in this session.
      </Text>
      <TouchableOpacity style={styles.primaryButton} onPress={() => void continueStep()}>
        <Text style={styles.primaryButtonText}>See my result</Text>
      </TouchableOpacity>
    </View>
  );

  const renderDiagnostic = () => {
    switch (stepId) {
      case 'speaking':
        return renderSpeakingStep();
      case 'listening':
        return renderListeningStep();
      case 'language_use':
        return renderLanguageUseStep();
      case 'pronunciation':
        return renderPronunciationStep();
      case 'summary':
      default:
        return renderSummaryStep();
    }
  };

  const renderProfile = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Set up your learning plan</Text>
      <Text style={styles.body}>
        A few questions, then a short diagnostic conversation. Your existing profile is kept.
      </Text>
      {prefill?.hasExistingData ? (
        <Text style={styles.muted}>
          Prefilled from your profile — change only what you want to change.
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>Your name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="What should the tutor call you?"
      />

      <Text style={styles.sectionTitle}>Native language</Text>
      <View style={styles.chipRow}>
        {NATIVE_LANGUAGE_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.code}
            style={[styles.chip, nativeLanguage === option.code ? styles.chipOn : null]}
            onPress={() => setNativeLanguage(option.code)}
          >
            <Text style={styles.chipText}>{option.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Target level</Text>
      <View style={styles.chipRow}>
        {TARGET_LEVELS.map((level) => (
          <TouchableOpacity
            key={level}
            style={[styles.chip, targetLevel === level ? styles.chipOn : null]}
            onPress={() => setTargetLevel(level)}
          >
            <Text style={styles.chipText}>{level}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>What do you want English for?</Text>
      <View style={styles.chipRow}>
        {LEARNING_GOAL_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.id}
            style={[styles.chip, goals.includes(option.label) ? styles.chipOn : null]}
            onPress={() => toggleGoal(option.label)}
          >
            <Text style={styles.chipText}>{option.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>How do you like to practise?</Text>
      <View style={styles.chipRow}>
        {PRACTICE_MODES.map((mode) => (
          <TouchableOpacity
            key={mode.id}
            style={[styles.chip, modes.includes(mode.id) ? styles.chipOn : null]}
            onPress={() => toggleMode(mode.id)}
          >
            <Text style={styles.chipText}>{mode.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryButton} onPress={() => void startDiagnostic()}>
        <Text style={styles.primaryButtonText}>Start the diagnostic</Text>
      </TouchableOpacity>
      <Text style={styles.muted}>
        Takes a few minutes. Nothing on your profile changes unless you accept it at the end.
      </Text>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Assess my English</Text>
      <Text style={styles.subtitle}>
        A short conversation-based diagnostic. It is an estimate for your training, not an official
        exam result.
      </Text>

      {phase === 'loading' ? (
        <View style={styles.card}>
          <ActivityIndicator />
          <Text style={styles.body}>Loading your profile…</Text>
        </View>
      ) : null}

      {phase === 'error' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Not available right now</Text>
          <Text style={styles.body}>{errorMessage ?? 'Please try again later.'}</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setPhase('profile')}>
            <Text style={styles.secondaryButtonText}>Back to my profile</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {phase === 'profile' ? renderProfile() : null}

      {phase === 'diagnostic' ? (
        <>
          {busy ? <Text style={styles.muted}>Working…</Text> : null}
          {turnError ? <Text style={styles.errorText}>{turnError}</Text> : null}
          {renderDiagnostic()}
        </>
      ) : null}

      {phase === 'result' && result ? renderResult(result) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '700', color: '#1c1c1e', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6b6b70', marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e6e9ef',
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#1c1c1e', marginBottom: 8 },
  headline: { fontSize: 16, color: '#1c1c1e', marginBottom: 4, fontWeight: '600' },
  body: { fontSize: 14, color: '#3a3a3c', marginBottom: 8 },
  muted: { fontSize: 13, color: '#6b6b70', marginBottom: 8 },
  section: { marginTop: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#8e8e93', marginBottom: 6, marginTop: 8 },
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  notice: { fontSize: 12, color: '#8a6d3b', marginBottom: 4 },
  savedLine: { fontSize: 13, color: '#0a7a3d', fontWeight: '600', marginTop: 8 },
  errorText: { fontSize: 13, color: '#b00020', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#d7dbe3',
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    color: '#1c1c1e',
    marginTop: 8,
    marginBottom: 8,
    minHeight: 44,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#d7dbe3',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
  },
  chipOn: { borderColor: '#007AFF', backgroundColor: '#e8f1ff' },
  chipText: { fontSize: 13, color: '#3a3a3c' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 6, marginBottom: 6 },
  micButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  micButtonOn: { backgroundColor: '#b00020' },
  micButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  optionButton: {
    borderWidth: 1,
    borderColor: '#d7dbe3',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  optionText: { fontSize: 14, color: '#1c1c1e' },
  linkButton: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontSize: 13, color: '#6b6b70', textDecorationLine: 'underline' },
});
