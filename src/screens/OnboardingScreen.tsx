import MicrophoneHelp from './components/MicrophoneHelp';
import TouchableOpacity from './components/LearnerButton';
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
  View,
} from 'react-native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';

import type { CefrLevel, ConversationMode } from '../domain/shared/types';
import {
  ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE,
  ASSESSMENT_SHORT_ANSWER_MESSAGE,
  createAssessmentAnswerController,
  createDefaultOnboardingService,
  describeConfidence,
  describeEstimate,
  LEARNING_GOAL_OPTIONS,
  NATIVE_LANGUAGE_OPTIONS,
  type AssessmentAnswerController,
  type AssessmentAnswerPurpose,
  type AssessmentAnswerState,
  type DiagnosticHandle,
  type DiagnosticResult,
  type DiagnosticStepId,
  type ListeningExercise,
  type OnboardingPrefill,
  type OnboardingService,
} from '../onboarding';
import { countCommittedLearnerTurns } from '../conversation-session';
import {
  ASSESSMENT_PRE_GUIDANCE,
  ASSESSMENT_SPEAKING_GUIDANCE,
  ANSWER_ANYWAY_LABEL,
  assessAnswerSubstance,
} from '../learner-agency';
import {
  createTalkVoiceCoordinator,
  type TalkProviderKind,
  type VoiceTurnOutcome,
} from '../talk-demo';
import type { ReassessmentService, ReassessmentRecord, QualitativeChangeReport } from '../reassessment';
import type { VoiceSessionCoordinator, VoiceStatus } from '../voice';

export interface OnboardingScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: OnboardingService;
  readonly reassessmentService?: ReassessmentService;
  readonly isReassessment?: boolean;
  readonly onFinish?: () => void;
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
  const [pronunciationReady, setPronunciationReady] = useState<boolean>(false);
  /**
   * Work Order 2 — assessment RESPONSE COACHING (presentation-level only):
   * when the learner tries to continue a speaking part too early, they are
   * asked to expand FIRST, and may then explicitly "Continue anyway". This can
   * never change the state machine's transitions, evidence counts or the
   * assessment thresholds, and it never auto-fills or fabricates content.
   */
  const [coachingNudge, setCoachingNudge] = useState<string | null>(null);
  const coachingOverrideRef = useRef<boolean>(false);
  const coachingTurnsRef = useRef<number>(0);
  /**
   * The step a voice turn was started for. Captured when the microphone OPENS, so
   * a result that arrives after the flow moved on can never be recorded against
   * the step that is current by then.
   */
  const pendingPurposeRef = useRef<'speaking' | 'language_use' | 'pronunciation'>('speaking');
  /** The diagnostic step TOKEN captured when that recording started. */
  const pendingStepTokenRef = useRef<number | null>(null);
  /**
   * ONE integrity rule: diagnostic step navigation is blocked while ANY answer /
   * evaluation / evidence operation for the current step is unresolved. This is a
   * SYNCHRONOUS ref (not the `busy` render state), so a fast repeated press cannot
   * slip through before a rerender.
   */
  const diagnosticOperationInFlightRef = useRef<boolean>(false);
  /** Re-entrancy guards: a double press can never submit/advance twice. */
  const micInFlightRef = useRef<boolean>(false);
  const answerInFlightRef = useRef<boolean>(false);
  const continueInFlightRef = useRef<boolean>(false);
  /** The listening evaluation currently running (re-entrancy + token binding). */
  const listeningInFlightRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  // Listening step.
  const [exercise, setExercise] = useState<ListeningExercise | null>(null);
  const [listeningNote, setListeningNote] = useState<string | null>(null);
  const [listeningAnswer, setListeningAnswer] = useState<string>('');

  // Result.
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [decisionLine, setDecisionLine] = useState<string | null>(null);
  const [reassessmentRecord, setReassessmentRecord] = useState<ReassessmentRecord | null>(null);
  const [reassessmentReport, setReassessmentReport] = useState<QualitativeChangeReport | null>(null);

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

  // ── leaving the screen: abandon the diagnostic FIRST, then stop voice work
  useEffect(
    () => () => {
      // Abandon before anything else: a late STT/AI result must not be able to
      // mutate the diagnostic evidence after the learner left the screen.
      mountedRef.current = false;
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
    const service = await getService().catch(() => null);
    if (!service) {
      setErrorMessage('Your learning profile is unavailable right now. Nothing was changed.');
      setPhase('error');
      setBusy(false);
      return;
    }

    // The learner's own preferences are saved HERE — before the diagnostic runs.
    try {
      await service.saveProfileDraft({
        displayName,
        ...(nativeLanguage ? { nativeLanguage } : {}),
        targetLevel: targetLevel ?? 'unknown',
        learningGoals: goals,
        preferredModes: modes,
      });
    } catch {
      setErrorMessage(
        'Your learning preferences could not be saved, so the assessment was not started. Nothing was changed.',
      );
      setPhase('error');
      setBusy(false);
      return;
    }

    // From here the preferences ARE saved: a startup failure says exactly that
    // (the saved preferences are never rolled back), and it never claims the
    // profile was untouched.
    try {
      const handle = props?.isReassessment && props?.reassessmentService
        ? await props.reassessmentService.beginReassessment()
        : await service.beginDiagnostic();
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
      setErrorMessage('Your learning preferences were saved, but the assessment could not start.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, [
    displayName,
    getService,
    goals,
    modes,
    nativeLanguage,
    props?.createCoordinator,
    targetLevel,
  ]);

  /**
   * Absorbs a TRANSCRIPTION-ONLY pronunciation repeat: the real transcript is
   * scored by the EXISTING pronunciation service and recorded against the captured
   * step token only. A failed transcription records nothing — no fabricated sample.
   */
  const absorbPronunciationTranscript = useCallback(
    async (handle: DiagnosticHandle, transcript: string, stepToken: number | null) => {
      await serviceRef.current?.recordPronunciation(
        handle,
        transcript,
        handle.pronunciationTask.sentence,
        stepToken === null
          ? { transcriptFromVoice: true }
          : { stepToken, transcriptFromVoice: true },
      );
    },
    [],
  );

  /**
   * Absorbs a spoken CONVERSATION turn: evidence comes ONLY from what the
   * conversation really committed (a failed turn contributes nothing) and is
   * recorded against the step the turn STARTED in. Shared by the first attempt and
   * by every explicit learner Retry, so a retry can never take a weaker path.
   */
  const absorbSpokenTurn = useCallback(
    async (
      handle: DiagnosticHandle,
      purpose: AssessmentAnswerPurpose,
      stepToken: number | null,
      outcome: VoiceTurnOutcome,
    ) => {
      // AWAIT the absorption BEFORE reading the evidence snapshot: the committed
      // voice turn must really be counted first.
      await handle.speaking.observeCommittedHistory({ purpose });
      if (!mountedRef.current) return;
      const token = stepToken ?? handle.session.getCurrentStepToken();
      const expectedStep = purpose === 'language_use' ? 'language_use' : 'speaking';
      if (handle.session.getCurrentStepId() === expectedStep) {
        if (purpose === 'language_use') {
          handle.session.recordLanguageUse(handle.speaking.getLanguageUseEvidence(), token);
        } else {
          handle.session.recordSpeaking(handle.speaking.getSpeakingEvidence(), token);
        }
      }
      if (!outcome.ok) {
        // Already learner-safe and classified by the coordinator; the raw
        // provider detail stays in the logs.
        if (outcome.technical) console.error('Assessment voice turn failure:', outcome.technical);
        setTurnError(outcome.error ?? 'That turn could not be completed. Nothing was recorded.');
      }
      setTurns(handle.conversation.getHistory().length);
    },
    [],
  );

  /** Mic press — never auto-opens the microphone; the learner is in control. */
  const pressMic = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const handle = handleRef.current;
    if (!coordinator || !handle || micInFlightRef.current) return;
    micInFlightRef.current = true;
    setTurnError(null);
    try {
      const status = coordinator.getStatus();
      if (status.state === 'recording') {
        setBusy(true);
        try {
          // Purpose AND step token were captured when this recording STARTED.
          const purpose = pendingPurposeRef.current;
          const stepToken = pendingStepTokenRef.current;

          // The recorded voice operation is unresolved until the very end of
          // this block: for pronunciation that includes the PronunciationEngine
          // analysis AFTER STT; for conversation it includes the awaited
          // evidence absorption and the DiagnosticSession record.
          diagnosticOperationInFlightRef.current = true;
          try {
          if (purpose === 'pronunciation') {
            // TRANSCRIPTION-ONLY: the repeat never enters the ConversationSession
            // (no learner turn, no tutor reply, no feedback, no vocabulary, no
            // conversational TTS). The real transcript is compared with the known
            // target sentence by the EXISTING PronunciationEngine.
            const result = await coordinator.stopRecordingAndTranscribe();
            if (!mountedRef.current) return; // left the screen: discard the transcript
            if (!result.ok || !result.transcript) {
              if (result.technical) console.error('Pronunciation transcription failure:', result.technical);
              setTurnError(result.error ?? 'That sentence could not be transcribed. Nothing was recorded.');
              return;
            }
            await absorbPronunciationTranscript(handle, result.transcript, stepToken);
          } else {
            // The EXISTING coordinator committed the turn through the EXISTING
            // session; the diagnostic only absorbs what was really committed,
            // and records it against the step the turn was STARTED in. A failed
            // turn preserves the recording/transcript for an explicit Retry.
            const outcome = await coordinator.stopRecordingAndProcess();
            if (!mountedRef.current) return;
            await absorbSpokenTurn(handle, purpose, stepToken, outcome);
          }

          setTurns(handle.conversation.getHistory().length);
          } finally {
            // The operation is resolved: navigation is allowed again.
            diagnosticOperationInFlightRef.current = false;
          }
        } finally {
          setBusy(false);
        }
        return;
      }
      // Capture the purpose AND the step token BEFORE the microphone opens.
      const step = handle.session.getCurrentStepId();
      pendingPurposeRef.current =
        step === 'pronunciation' ? 'pronunciation' : step === 'language_use' ? 'language_use' : 'speaking';
      pendingStepTokenRef.current = handle.session.getCurrentStepToken();
      await coordinator.startRecording();
    } finally {
      micInFlightRef.current = false;
    }
  }, [absorbPronunciationTranscript, absorbSpokenTurn]);

  /**
   * The typed-answer commit controller (Work Order 1, bug #1). It OWNS the answer
   * box, so:
   * - the learner's text is cleared ONLY after the answer really committed;
   * - a failure keeps the EXACT typed answer, shows one classified learner-safe
   *   sentence and offers Retry (the learner may edit first);
   * - a failed submission records no evidence and counts no committed turn;
   * - a repeated tap can never commit twice (synchronous in-flight guard plus a
   *   committed-turn verification before any replay).
   * The commit itself still goes through the EXISTING service/session path.
   */
  const answerController = useMemo<AssessmentAnswerController>(
    () =>
      createAssessmentAnswerController({
        captureStep: () => {
          const handle = handleRef.current;
          if (!handle) return null;
          // The step AND its token are captured at submission start: a late
          // answer can never become evidence for the next diagnostic step.
          const id = handle.session.getCurrentStepId();
          if (id !== 'speaking' && id !== 'language_use') return null;
          return { stepId: id, stepToken: handle.session.getCurrentStepToken() };
        },
        currentPurpose: () =>
          handleRef.current?.session.getCurrentStepId() === 'language_use'
            ? 'language_use'
            : 'speaking',
        observeCommittedLearnerTurns: () => {
          const handle = handleRef.current;
          return handle ? countCommittedLearnerTurns(handle.conversation) : 0;
        },
        commit: async ({ answer, purpose, step }) => {
          const handle = handleRef.current;
          const service = serviceRef.current;
          if (!handle || !service) {
            return {
              ok: false,
              errorMessage:
                'The assessment is not running, so that answer was not sent. Nothing was recorded.',
            };
          }
          answerInFlightRef.current = true;
          diagnosticOperationInFlightRef.current = true;
          setBusy(true);
          setTurnError(null);
          try {
            const onLanguageUse = purpose === 'language_use';
            const learnerTurnsBefore = countCommittedLearnerTurns(handle.conversation);
            // Text submission goes through the SERVICE (same existing session
            // path), which awaits the committed turn and records its own evidence.
            const outcome = onLanguageUse
              ? await service.recordLanguageUseAnswer(handle, answer)
              : await service.recordSpeakingAnswer(handle, answer);
            if (!mountedRef.current) {
              return { ok: false, errorMessage: 'That answer could not be sent.' };
            }
            if (!outcome.ok) {
              // The turn really committed but produced no evidence yet (for
              // example a very short answer). Honest and actionable — and never a
              // reason to send the same answer a second time.
              if (countCommittedLearnerTurns(handle.conversation) > learnerTurnsBefore) {
                setTurnError(ASSESSMENT_SHORT_ANSWER_MESSAGE);
                setTurns(handle.conversation.getHistory().length);
                return { ok: true };
              }
              return { ok: false, errorMessage: outcome.errorMessage ?? null };
            }
            // Re-record evidence for the CAPTURED step only (the state machine
            // refuses stale tokens anyway).
            if (handle.session.getCurrentStepId() === step.stepId) {
              if (onLanguageUse) {
                handle.session.recordLanguageUse(
                  handle.speaking.getLanguageUseEvidence(),
                  step.stepToken,
                );
              } else {
                handle.session.recordSpeaking(handle.speaking.getSpeakingEvidence(), step.stepToken);
              }
            } else {
              setTurnError(ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE);
            }
            setTurns(handle.conversation.getHistory().length);
            return { ok: true };
          } finally {
            answerInFlightRef.current = false;
            diagnosticOperationInFlightRef.current = false;
            setBusy(false);
          }
        },
        onFailure: ({ failure }) => {
          // Raw provider detail is diagnostic only: it never reaches the learner.
          if (failure.technical) console.error('Assessment answer failure:', failure.technical);
        },
      }),
    [],
  );
  const [answerState, setAnswerState] = useState<AssessmentAnswerState>(() =>
    answerController.getState(),
  );
  useEffect(() => answerController.subscribe(setAnswerState), [answerController]);

  /** Manual text fallback — the SAME existing conversation path. */
  const submitTextAnswer = useCallback(async () => {
    await answerController.submit();
  }, [answerController]);

  /** Explicit learner Retry of the preserved (possibly edited) typed answer. */
  const retryTextAnswer = useCallback(async () => {
    await answerController.retry();
  }, [answerController]);

  /**
   * Explicit learner Retry of a PRESERVED transcript: the learner's own words are
   * sent again without re-recording, and evidence is absorbed by the same path. A
   * transcript that already committed is never sent twice (the coordinator
   * verifies the committed history before replaying).
   */
  const retryPendingVoiceTurn = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const handle = handleRef.current;
    if (!coordinator || !handle || micInFlightRef.current) return;
    const purpose = pendingPurposeRef.current;
    if (purpose === 'pronunciation') return; // a preserved transcript is a conversation turn only
    micInFlightRef.current = true;
    diagnosticOperationInFlightRef.current = true;
    setBusy(true);
    setTurnError(null);
    try {
      const outcome = await coordinator.retryPendingTurn();
      if (!mountedRef.current) return;
      await absorbSpokenTurn(handle, purpose, pendingStepTokenRef.current, outcome);
    } finally {
      diagnosticOperationInFlightRef.current = false;
      micInFlightRef.current = false;
      setBusy(false);
    }
  }, [absorbSpokenTurn]);

  /**
   * Explicit learner Retry of a PRESERVED RECORDING after a failed transcription:
   * the same audio is transcribed again on the SAME contract (transcription-only
   * stays transcription-only), so a pronunciation repeat can never become a
   * conversation turn and no transcript is fabricated.
   */
  const retryPreservedRecording = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const handle = handleRef.current;
    if (!coordinator || !handle || micInFlightRef.current) return;
    micInFlightRef.current = true;
    diagnosticOperationInFlightRef.current = true;
    setBusy(true);
    setTurnError(null);
    try {
      const purpose = pendingPurposeRef.current;
      const stepToken = pendingStepTokenRef.current;
      const outcome = await coordinator.retryTranscription();
      if (!mountedRef.current) return;
      if (purpose === 'pronunciation') {
        if (!outcome.ok || !outcome.transcript) {
          if (outcome.technical) console.error('Pronunciation retry failure:', outcome.technical);
          setTurnError(
            outcome.error ?? 'That sentence could not be transcribed. Nothing was recorded.',
          );
          return;
        }
        await absorbPronunciationTranscript(handle, outcome.transcript, stepToken);
        return;
      }
      await absorbSpokenTurn(handle, purpose, stepToken, outcome);
    } finally {
      diagnosticOperationInFlightRef.current = false;
      micInFlightRef.current = false;
      setBusy(false);
    }
  }, [absorbPronunciationTranscript, absorbSpokenTurn]);

  /**
   * "Type instead": the preserved transcript moves into the answer box so the
   * learner can review and edit it before sending. Taking it clears the
   * coordinator's preserved turn, so the same utterance can never be sent twice.
   */
  const useTranscriptAsText = useCallback(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    const transcript = coordinator.takePendingTranscript();
    if (!transcript) return;
    setTurnError(null);
    answerController.setDraft(transcript);
  }, [answerController]);

  /**
   * Continue to the next step. The state machine owns the transition; this
   * handler refuses while a voice answer for the CURRENT step is still in
   * flight, and it can never advance twice from a repeated press.
   */
  const continueStep = useCallback(async () => {
    const handle = handleRef.current;
    const service = serviceRef.current;
    if (!handle || !service || continueInFlightRef.current) return;
    setTurnError(null);

    // ONE integrity rule: no step change while any answer/evaluation/evidence
    // operation for the CURRENT step is unresolved — including work that keeps
    // running after the voice coordinator returned to idle (pronunciation
    // analysis, listening evaluation) and typed answers.
    if (
      diagnosticOperationInFlightRef.current ||
      micInFlightRef.current ||
      answerInFlightRef.current ||
      listeningInFlightRef.current
    ) {
      setTurnError('Wait for your answer to finish before continuing.');
      return;
    }

    // Any current voice work for this step blocks navigation too: permission
    // prompt, recording, transcription, the tutor thinking, or the tutor speaking.
    const voice = coordinatorRef.current?.getStatus();
    if (
      voice &&
      (voice.isProcessing ||
        voice.isSwitching ||
        voice.state === 'requesting_permission' ||
        voice.state === 'recording' ||
        voice.state === 'transcribing' ||
        voice.state === 'sending' ||
        voice.state === 'speaking')
    ) {
      setTurnError('Wait for your answer to finish before continuing.');
      return;
    }

    continueInFlightRef.current = true;
    try {
      const current = handle.session.getCurrentStepId();

      if (current === 'speaking') {
        if (handle.speaking.getSpeakingEvidence().committedLearnerTurns === 0) {
          setTurnError('Say at least one answer before continuing.');
          return;
        }
      }

      if (current === 'pronunciation' && !handle.session.snapshot().evidence.pronunciation) {
        // No real observation was produced: the part is honestly marked
        // unavailable instead of being silently treated as assessed.
        handle.session.markPronunciationUnavailable(
          'No pronunciation observations were recorded in this session.',
          handle.session.getCurrentStepToken(),
        );
      }

      if (current === 'summary') {
        // The service refuses to finish an incomplete/abandoned diagnostic.
        handle.session.markSummaryDone(handle.session.getCurrentStepToken());
        setBusy(true);
        try {
          if (props?.isReassessment && props?.reassessmentService) {
            const outcome = await props.reassessmentService.finishReassessment(handle);
            if (!outcome.result) {
              setTurnError('The assessment is not complete yet, so no result was produced.');
              return;
            }
            if (!mountedRef.current) return;
            setResult(outcome.result);
            setReassessmentRecord(outcome.record);
            setReassessmentReport(outcome.report);
            setPhase('result');
          } else {
            const finished = await service.finishDiagnostic(handle);
            if (!finished) {
              setTurnError('The assessment is not complete yet, so no result was produced.');
              return;
            }
            if (!mountedRef.current) return;
            setResult(finished);
            setPhase('result');
          }
        } finally {
          setBusy(false);
        }
        return;
      }

      handle.session.advance();
      setStepId(handle.session.getCurrentStepId());
    } finally {
      continueInFlightRef.current = false;
    }
  }, []);

  /**
   * Work Order 2 — coaching gate in front of `continueStep` for the speaking
   * parts. It prompts for expansion ONCE per answer flow when the learner's
   * latest turn is too short to carry much evidence; the learner can then
   * explicitly continue anyway. Thresholds, evidence recording and the state
   * machine itself are untouched — this wrapper never records anything.
   */
  const handleContinueWithCoaching = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (handle && (stepId === 'speaking' || stepId === 'language_use') && !coachingOverrideRef.current) {
      const history = handle.conversation.getHistory();
      const learnerTurns = history.filter((turn) => turn.role === 'user').length;
      if (learnerTurns > 0) {
        const last = [...history].reverse().find((turn) => turn.role === 'user');
        const nudge = assessAnswerSubstance(last?.content ?? '');
        if (nudge !== null) {
          setCoachingNudge(
            `${nudge} Substantive answers give the check something real to work with — and nothing is invented if you stop here.`,
          );
          return;
        }
      }
    }
    setCoachingNudge(null);
    await continueStep();
  }, [continueStep, stepId]);

  const handleCoachingContinueAnyway = useCallback(async (): Promise<void> => {
    coachingOverrideRef.current = true;
    setCoachingNudge(null);
    await continueStep();
  }, [continueStep]);

  /**
   * A new step or a newly committed answer restarts the coaching gate: the
   * learner's LATEST wording is what gets evaluated next, and an override from
   * an earlier gate never leaks into a later part of the flow.
   */
  useEffect(() => {
    coachingOverrideRef.current = false;
    if (coachingTurnsRef.current !== turns) {
      coachingTurnsRef.current = turns;
      setCoachingNudge(null);
    }
  }, [stepId, turns]);

  /** The listening task is planned when the step becomes current. */
  useEffect(() => {
    if (phase !== 'diagnostic' || stepId !== 'listening') return;
    const handle = handleRef.current;
    if (!handle || exercise) return;
    let active = true;
    // Planning the (single) listening task is an unresolved operation for this
    // step: navigating away before it settles would skip the step silently.
    diagnosticOperationInFlightRef.current = true;
    void (async () => {
      const service = serviceRef.current;
      if (!service) {
        diagnosticOperationInFlightRef.current = false;
        return;
      }
      try {
        const planned = await service.startListeningTask(handle);
        if (!active) return;
        if (planned.status === 'ready') {
          setExercise(planned.exercise);
          setListeningNote(null);
        } else {
          // Unavailable infrastructure is stated plainly — never a learner error.
          setListeningNote(planned.message);
        }
      } finally {
        if (active) diagnosticOperationInFlightRef.current = false;
      }
    })();
    return () => {
      active = false;
    };
  }, [exercise, phase, stepId]);

  /**
   * The pronunciation step analyses ONLY the learner's repeat of the dedicated
   * target sentence (captured by the mic press in this step). It never judges
   * ordinary conversation text, and it never claims acoustic analysis.
   */
  useEffect(() => {
    if (phase !== 'diagnostic' || stepId !== 'pronunciation') return;
    const handle = handleRef.current;
    if (!handle) return;
    const evidence = handle.session.snapshot().evidence.pronunciation;
    setPronunciationReady(evidence !== null);
  }, [phase, stepId]);

  const submitListeningAnswer = useCallback(async () => {
    const handle = handleRef.current;
    const service = serviceRef.current;
    if (!handle || !service || !exercise) return;
    const answer = listeningAnswer.trim();
    if (!answer) return;
    // A double press is refused, so the existing ListeningService can never be
    // asked to evaluate (and persist) the same task twice.
    if (listeningInFlightRef.current) return;

    listeningInFlightRef.current = true;
    diagnosticOperationInFlightRef.current = true;
    setBusy(true);
    try {
      // The listening step token is captured BEFORE evaluation starts, so the
      // evidence is recorded against the step this answer belonged to — a late
      // result from a changed step is refused by the state machine.
      const stepToken = handle.session.getCurrentStepToken();
      // The captured token travels with the call: the EXISTING ListeningService
      // stays the persistence owner, and the diagnostic evidence can only land on
      // the step this answer was given in.
      const outcome = await service.recordListeningAnswer(handle, exercise, answer, { stepToken });
      if (!mountedRef.current) return;
      setListeningNote(outcome.message);
      if (!outcome.ok) {
        setTurnError(outcome.message);
      }
    } finally {
      listeningInFlightRef.current = false;
      diagnosticOperationInFlightRef.current = false;
      setBusy(false);
    }
  }, [exercise, listeningAnswer]);

  const acceptLevel = useCallback(async () => {
    if (!result) return;
    if (props?.isReassessment && props?.reassessmentService && reassessmentRecord) {
      const decision = await props.reassessmentService.acceptReassessmentLevel(reassessmentRecord.id);
      setDecisionLine(
        decision.updated
          ? `Saved. Your working level is now ${decision.currentLevel}.`
          : decision.reason === 'already-accepted'
            ? `Your level is already ${decision.currentLevel}.`
            : `Working level kept at ${decision.currentLevel}.`,
      );
      return;
    }
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
  }, [result, props, reassessmentRecord]);

  const keepLevel = useCallback(async () => {
    if (props?.isReassessment && props?.reassessmentService && reassessmentRecord) {
      const decision = await props.reassessmentService.keepCurrentLevel(reassessmentRecord.id);
      setDecisionLine(`Kept your current level (${decision.currentLevel}). Nothing was changed.`);
      return;
    }
    const service = serviceRef.current;
    if (!service) return;
    const decision = await service.keepCurrentLevel();
    setDecisionLine(`Kept your current level (${decision.currentLevel}). Nothing was changed.`);
  }, [props, reassessmentRecord]);

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
      {reassessmentReport ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Qualitative Ability Change Summary</Text>
          <Text style={styles.listLine}>{reassessmentReport.overallSummary}</Text>
          {reassessmentReport.domains.map((d) => (
            <Text key={d.domain} style={styles.listLine}>
              • {d.domain.toUpperCase()} [{d.status}]: {d.summary}
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
            onPress={() => navigation.navigate('MainTabs', { screen: 'Home' })}
          >
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      )}

      {decisionLine ? <Text style={styles.savedLine}>{decisionLine}</Text> : null}

      <TouchableOpacity
        style={styles.linkButton}
        onPress={() => navigation.navigate('MainTabs', { screen: 'Home' })}
      >
        <Text style={styles.linkText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  );

  // Presentation follows the existing coordinator; no independent voice lifecycle.
  const assessmentInputBusy = busy || answerState.isSubmitting ||
    voiceStatus?.state === 'recording' ||
    voiceStatus?.state === 'transcribing' || voiceStatus?.state === 'sending' ||
    voiceStatus?.state === 'requesting_permission';
  const assessmentMicLabel = voiceStatus?.state === 'recording' ? 'Stop recording'
    : busy ? 'Processing…'
    : voiceStatus?.state === 'requesting_permission' ? 'Waiting for microphone permission…'
    : voiceStatus?.canRecord ? (stepId === 'pronunciation' ? 'Repeat it' : 'Record answer') : 'Microphone unavailable';

  /**
   * ONE failure surface for the TYPED answer (Work Order 1, item 1): the exact
   * answer stays in the box, the learner reads one classified learner-safe
   * sentence, and Retry is explicit. Nothing here fabricates a result.
   */
  const renderAnswerFailure = () => {
    if (answerState.phase !== 'failed' || !answerState.learnerMessage) return null;
    return (
      <View style={styles.recoveryBox}>
        <Text style={styles.errorText}>{answerState.learnerMessage}</Text>
        <Text style={styles.muted}>
          Your answer is still in the box. You can edit it, then send it again.
        </Text>
        {answerState.retryAvailable ? (
          <TouchableOpacity
            style={styles.primaryButton}
            disabled={assessmentInputBusy}
            onPress={() => void retryTextAnswer()}
            accessibilityLabel="Retry sending my typed answer"
          >
            <Text style={styles.primaryButtonText}>Retry</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  /**
   * ONE recovery surface for VOICE failures (Work Order 1, item 6): it offers only
   * the actions that match what actually survived — resend the preserved
   * transcript, review it as text, or transcribe the preserved recording again. It
   * never invents a transcript, and `allowTypeInstead` keeps a transcription-only
   * pronunciation repeat out of the typed-answer path.
   */
  const renderVoiceRecovery = (options: { readonly allowTypeInstead: boolean }) => {
    const preservedTranscript =
      voiceStatus?.canRetryPendingTurn === true ? (voiceStatus?.pendingTranscript ?? null) : null;
    const canRetranscribe =
      preservedTranscript === null && voiceStatus?.canRetryTranscription === true;
    if (!preservedTranscript && !canRetranscribe) return null;
    return (
      <View style={styles.recoveryBox}>
        {preservedTranscript ? (
          <>
            <Text style={styles.muted}>
              Your answer was transcribed, but the tutor could not reply. Nothing was lost.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              disabled={assessmentInputBusy}
              onPress={() => void retryPendingVoiceTurn()}
              accessibilityLabel="Send my transcribed answer again"
            >
              <Text style={styles.primaryButtonText}>Send it again</Text>
            </TouchableOpacity>
            {options.allowTypeInstead ? (
              <TouchableOpacity
                style={styles.secondaryButton}
                disabled={assessmentInputBusy}
                onPress={() => useTranscriptAsText()}
                accessibilityLabel="Review my transcribed answer as text"
              >
                <Text style={styles.secondaryButtonText}>Type instead</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}
        {canRetranscribe ? (
          <>
            <Text style={styles.muted}>
              That recording could not be transcribed, so nothing was recorded. You can try the
              same recording again instead of speaking twice.
            </Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              disabled={assessmentInputBusy}
              onPress={() => void retryPreservedRecording()}
              accessibilityLabel="Transcribe my last recording again"
            >
              <Text style={styles.secondaryButtonText}>Try my last recording again</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    );
  };

  // ── render helpers for the diagnostic steps
  const renderSpeakingStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      <Text style={styles.muted} accessibilityLiveRegion="polite">
        {ASSESSMENT_PRE_GUIDANCE}
      </Text>
      <Text style={styles.body}>{SPEAKING_PROMPT}</Text>
      <Text style={styles.muted}>{ASSESSMENT_SPEAKING_GUIDANCE}</Text>
      <Text style={styles.muted}>
        Tap the microphone and answer out loud, or type your answer below.
      </Text>
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.micButton, voiceStatus?.state === 'recording' ? styles.micButtonOn : null]}
          disabled={busy || (!voiceStatus?.canRecord && voiceStatus?.state !== 'recording')}
          accessibilityLabel={assessmentMicLabel}
          accessibilityHint="Records a spoken assessment answer; requires microphone permission"
          onPress={() => void pressMic()}
        >
          <Text style={styles.micButtonText}>
            {assessmentMicLabel}
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
      {renderVoiceRecovery({ allowTypeInstead: true })}
      <TextInput accessibilityLabel="Your typed assessment answer"
        style={styles.input}
        placeholder="Or type your answer"
        value={answerState.draft}
        onChangeText={answerController.setDraft}
        multiline
        editable={!answerState.isSubmitting}
      />
      <TouchableOpacity style={styles.secondaryButton} disabled={assessmentInputBusy || !answerState.draft.trim()} onPress={() => void submitTextAnswer()} accessibilityLabel="Send typed answer">
        <Text style={styles.secondaryButtonText}>
          {answerState.isSubmitting ? 'Sending…' : 'Send typed answer'}
        </Text>
      </TouchableOpacity>
      {renderAnswerFailure()}
      <Text style={styles.muted}>Turns recorded: {turns}</Text>
      {coachingNudge ? (
        <View style={styles.section}>
          <Text accessibilityRole="alert" style={styles.body}>{coachingNudge}</Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => void handleCoachingContinueAnyway()}
            accessibilityLabel="Finish this part with the answers given so far"
          >
            <Text style={styles.secondaryButtonText}>{ANSWER_ANYWAY_LABEL}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <TouchableOpacity style={styles.primaryButton} disabled={assessmentInputBusy} onPress={() => void handleContinueWithCoaching()}>
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
          <TextInput accessibilityLabel="Your listening answer"
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
      <TouchableOpacity style={styles.primaryButton} disabled={assessmentInputBusy} onPress={() => void continueStep()}>
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
            disabled={busy || (!voiceStatus?.canRecord && voiceStatus?.state !== 'recording')}
          accessibilityLabel={assessmentMicLabel}
          accessibilityHint="Records a spoken assessment answer; requires microphone permission"
          onPress={() => void pressMic()}
          >
            <Text style={styles.micButtonText}>
              {assessmentMicLabel}
            </Text>
          </TouchableOpacity>
        </View>
        {renderVoiceRecovery({ allowTypeInstead: true })}
        <TextInput accessibilityLabel="Your typed assessment answer"
          style={styles.input}
          placeholder="Or type your answer"
          value={answerState.draft}
          onChangeText={answerController.setDraft}
          multiline
          editable={!answerState.isSubmitting}
        />
        <TouchableOpacity style={styles.secondaryButton} disabled={assessmentInputBusy || !answerState.draft.trim()} onPress={() => void submitTextAnswer()} accessibilityLabel="Send typed answer">
          <Text style={styles.secondaryButtonText}>
            {answerState.isSubmitting ? 'Sending…' : 'Send typed answer'}
          </Text>
        </TouchableOpacity>
        {renderAnswerFailure()}
        {coachingNudge ? (
          <View style={styles.section}>
            <Text accessibilityRole="alert" style={styles.body}>{coachingNudge}</Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => void handleCoachingContinueAnyway()}
              accessibilityLabel="Finish this part with the answers given so far"
            >
              <Text style={styles.secondaryButtonText}>{ANSWER_ANYWAY_LABEL}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity style={styles.primaryButton} disabled={assessmentInputBusy} onPress={() => void handleContinueWithCoaching()}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderPronunciationStep = () => {
    const handle = handleRef.current;
    const task = handle?.pronunciationTask;
    const evidence = handle?.session.snapshot().evidence.pronunciation ?? null;
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{stepTitle}</Text>
        <Text style={styles.body}>
          Listen to this sentence, then say it back in your own voice.
        </Text>
        {task ? (
          <View style={styles.targetBox}>
            <Text style={styles.targetText}>{task.sentence}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            if (task) void coordinatorRef.current?.speakResponse(task.sentence);
          }}
        >
          <Text style={styles.secondaryButtonText}>Play the sentence</Text>
        </TouchableOpacity>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.micButton, voiceStatus?.state === 'recording' ? styles.micButtonOn : null]}
            disabled={busy || (!voiceStatus?.canRecord && voiceStatus?.state !== 'recording')}
          accessibilityLabel={assessmentMicLabel}
          accessibilityHint="Records a spoken assessment answer; requires microphone permission"
          onPress={() => void pressMic()}
          >
            <Text style={styles.micButtonText}>
              {assessmentMicLabel}
            </Text>
          </TouchableOpacity>
        </View>
        {voiceStatus?.recognizedTranscript ? (
          <Text style={styles.muted}>You said: {voiceStatus.recognizedTranscript}</Text>
        ) : null}
        {voiceStatus?.errorMessage ? (
          <Text style={styles.errorText}>{voiceStatus.errorMessage}</Text>
        ) : null}
        {renderVoiceRecovery({ allowTypeInstead: false })}

        {evidence ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>What we noticed</Text>
            {evidence.noteLines.map((line) => (
              <Text key={line} style={styles.listLine}>
                • {line}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={styles.muted}>
            {pronunciationReady
              ? 'No pronunciation observations were recorded yet. Repeat the sentence, or continue — this part is optional.'
              : 'This part is optional and is left out of your result if nothing is observed.'}
          </Text>
        )}

        <TouchableOpacity style={styles.primaryButton} disabled={assessmentInputBusy} onPress={() => void continueStep()}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderSummaryStep = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{stepTitle}</Text>
      <Text style={styles.body}>
        That is everything. Your result is based only on what really happened in this session.
      </Text>
      <TouchableOpacity style={styles.primaryButton} disabled={assessmentInputBusy} onPress={() => void continueStep()}>
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
        A few questions, then a short English assessment. Your existing profile is kept.
      </Text>
      {prefill?.hasExistingData ? (
        <Text style={styles.muted}>
          Prefilled from your profile — change only what you want to change.
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>Your name</Text>
      <TextInput accessibilityLabel="Your name"
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
            accessibilityState={{ selected: nativeLanguage === option.code }}
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
            accessibilityState={{ selected: targetLevel === level }}
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
            accessibilityState={{ selected: goals.includes(option.label) }}
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
            accessibilityState={{ selected: modes.includes(mode.id) }}
            onPress={() => toggleMode(mode.id)}
          >
            <Text style={styles.chipText}>{mode.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryButton} disabled={busy} onPress={() => void startDiagnostic()}>
        <Text style={styles.primaryButtonText}>Start the assessment</Text>
      </TouchableOpacity>
      <Text style={styles.muted}>
        Your learning preferences are saved when you start the assessment. Your current working
        level changes only if you accept the estimate at the end.
      </Text>
    </View>
  );

  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Assess my English</Text>
      <Text style={styles.subtitle}>
        A short conversation-based assessment. It is an estimate for your training, not an official
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
          <Text style={styles.muted}>Allow microphone access to give spoken answers. Without permission, no spoken evidence is recorded.</Text>
          {/permission/i.test(voiceStatus?.errorMessage ?? turnError ?? '') ? <MicrophoneHelp /> : null}
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
  /** Groups a failure notice with its explicit recovery actions. */
  recoveryBox: { marginTop: 4, marginBottom: 12, gap: 10 },
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
  targetBox: {
    backgroundColor: '#f0f5ff',
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  targetText: { fontSize: 15, color: '#1c1c1e', fontWeight: '600' },
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
