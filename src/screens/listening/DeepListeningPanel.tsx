import ProviderSettingsLink from '../components/ProviderSettingsLink';
import { useVoiceAppStateGuard } from '../../voice/use-app-state-guard';
import MicrophoneHelp from '../components/MicrophoneHelp';
import TouchableOpacity from '../components/LearnerButton';
/**
 * src/screens/listening/DeepListeningPanel.tsx
 *
 * WP-2 — the deep listening card: long discourse, multi-speaker conversations,
 * connected-speech recognition and shadowing.
 *
 * - Mobile-first and additive: the Phase-1 Listening screen is untouched, and
 *   this panel is only mounted when the learner picks "Deep listening".
 * - Audio always goes through the EXISTING TextToSpeechProvider abstraction and
 *   speed control is offered ONLY when that provider really declares support.
 * - Shadowing reuses the EXISTING recorder + STT + pronunciation path; when
 *   voice capture is unavailable the panel says so and offers no fake capture.
 * - Nothing here shows a score, a percentage, a level or a WPM figure, and the
 *   passage text is never shown before the learner answers.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TextToSpeechProvider } from '../../talk-demo';
import type { SpeechToTextProvider } from '../../providers/stt';
import type { AudioRecorderService } from '../../voice/types';
import type { ListeningEvaluation, ListeningService } from '../../listening';
import {
  DEEP_SPEECH_RATE_LEVELS,
  SPEECH_RATE_LABELS,
  ShadowingSession,
  ShadowingVoiceController,
  SINGLE_VOICE_HONESTY_NOTE,
  activitySpokenText,
  beginPlayback,
  buildSpokenScript,
  beginMeaningRequest,
  closeMeaning,
  curatedMeaning,
  deepAnswerSteps,
  finishPlayback,
  abortPlayback,
  initialShadowingAssistState,
  isDiscourseActivity,
  isMultiSpeakerActivity,
  meaningFailed,
  meaningLoaded,
  openMeaning,
  playShadowingChunk,
  readableChunkFor,
  resetAssistForActivity,
  resolveSpeakerVoiceCapability,
  resolveSpeechRateCapability,
  revealedTranscriptFor,
  speakerSummary,
  speechRateTTSOptions,
  toggleTranscript,
  withSpeechRate,
} from '../../listening';
import {
  createLearnerHelpService,
  createSaveToReviewService,
} from '../../learner-agency';
import type {
  DeepListeningActivity,
  DeepPlaybackState,
  ShadowingAttempt,
  SpeechRateCapability,
} from '../../listening';

export interface DeepListeningPanelProps {
  readonly shadowingOnly?: boolean;
  readonly service: ListeningService;
  /** Injectable EXISTING TTS provider (tests/composition). */
  readonly ttsProvider?: TextToSpeechProvider;
  /** Injectable EXISTING recorder/STT (shadowing only). */
  readonly recorder?: AudioRecorderService;
  readonly stt?: SpeechToTextProvider;
  readonly onExit?: () => void;
}

const ACTIVITY_LABELS: Record<DeepListeningActivity['taskType'], string> = {
  long_discourse: 'Long listening',
  multi_speaker_dialogue: 'Conversation',
  connected_speech: 'How words run together',
  shadowing: 'Shadowing',
};

/** Run the EXISTING TTS provider (never a substitute). */
async function resolveTts(
  injected: TextToSpeechProvider | undefined,
): Promise<TextToSpeechProvider | null> {
  if (injected) return injected;
  try {
    const talkDemo = await import('../../talk-demo');
    return talkDemo.createExpoTTSProvider();
  } catch {
    return null;
  }
}

/**
 * Resolve the EXISTING voice input providers honestly: without a configured
 * speech provider there is NO microphone affordance (never a fake capture).
 */
async function resolveVoiceInput(
  recorder: AudioRecorderService | undefined,
  stt: SpeechToTextProvider | undefined,
): Promise<{ recorder: AudioRecorderService; stt: SpeechToTextProvider } | null> {
  if (recorder && stt) return { recorder, stt };
  try {
    const talkDemo = await import('../../talk-demo');
    if (!stt) {
      const apiKey = talkDemo.getGeminiApiKey();
      if (!apiKey) return null;
      stt = talkDemo.createGeminiSTTProvider({ apiKey });
    }
    return { recorder: recorder ?? talkDemo.createExpoAudioRecorder(), stt };
  } catch {
    return null;
  }
}

export default function DeepListeningPanel(props: DeepListeningPanelProps): React.ReactElement {
  const { service, onExit } = props;

  const [activities, setActivities] = useState<readonly DeepListeningActivity[]>([]);
  const [sourceNote, setSourceNote] = useState<string>('');
  const [activityIndex, setActivityIndex] = useState<number>(0);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [answer, setAnswer] = useState<string>('');
  const [evaluation, setEvaluation] = useState<ListeningEvaluation | null>(null);
  const [playback, setPlayback] = useState<DeepPlaybackState | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [shadowingResult, setShadowingResult] = useState<ShadowingAttempt | null>(null);
  const [speakerNote, setSpeakerNote] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [voicePending, setVoicePending] = useState(false);
  const [completed, setCompleted] = useState<boolean>(false);

  /* ---------------------------------------------------------------- *
   * Work Order 2 — learner-controlled shadowing assistance.
   * Reveal / meaning / save are LOCAL presentation + one manual save call:
   * they never touch ShadowingSession attempts, support progression or any
   * evidence store. A reveal can never complete or fail an attempt.
   * ---------------------------------------------------------------- */
  const [assist, setAssist] = useState(initialShadowingAssistState);
  const [isSavingChunk, setIsSavingChunk] = useState<boolean>(false);
  const [chunkSaveNote, setChunkSaveNote] = useState<string | null>(null);
  const meaningInFlightRef = useRef<boolean>(false);
  const helpServiceRef = useRef<ReturnType<typeof createLearnerHelpService> | null>(null);
  const getHelpService = () => {
    if (!helpServiceRef.current) helpServiceRef.current = createLearnerHelpService();
    return helpServiceRef.current;
  };
  const saveService = useMemo(() => createSaveToReviewService(), []);

  const ttsRef = useRef<TextToSpeechProvider | null>(props.ttsProvider ?? null);
  const capabilityRef = useRef<SpeechRateCapability>(resolveSpeechRateCapability(props.ttsProvider));
  const shadowingTokenRef = useRef<number>(0);
  const controllerRef = useRef<ShadowingVoiceController | null>(null);
  /** The current shadowing practice session (state so the UI really re-renders). */
  const [shadowing, setShadowing] = useState<{
    readonly session: ShadowingSession;
    readonly controller: ShadowingVoiceController;
  } | null>(null);

  useVoiceAppStateGuard({
    onForeground: () => {
      // Read only: the controller already owns background cancellation.
      if (!controllerRef.current?.isBusy) {
        setIsRecording(false);
        setVoicePending(false);
      }
    },
  });

  const activity: DeepListeningActivity | null =
    activityIndex < activities.length ? activities[activityIndex] : null;
  const steps = activity ? deepAnswerSteps(activity) : [];
  const step = stepIndex < steps.length ? steps[stepIndex] : null;

  /** The text the EXISTING TTS speaks for the current activity. */
  const spokenTextFor = useCallback(
    (target: DeepListeningActivity): string => {
      if (isDiscourseActivity(target) && isMultiSpeakerActivity(target)) {
        return buildSpokenScript(
          target,
          resolveSpeakerVoiceCapability(ttsRef.current ?? undefined),
        ).text;
      }
      return activitySpokenText(target);
    },
    [],
  );

  const start = useCallback(async () => {
    if (isStarting) return;
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const tts = ttsRef.current ?? (await resolveTts(props.ttsProvider));
      ttsRef.current = tts;
      capabilityRef.current = resolveSpeechRateCapability(tts);
      const learnerId = await service.resolveLearnerId();
      if (!learnerId) {
        setErrorMessage(
          'No learner profile yet. Open the Talk tab once to set up your profile, then start deep listening.',
        );
        return;
      }
      const planned = await service.startDeepSession(learnerId, {
        // The real capability of the provider the learner actually hears.
        speechRateCapability: capabilityRef.current,
        speechRateLevel: 'natural',
        targetCount: props.shadowingOnly ? 1 : 3,
        ...(props.shadowingOnly ? { taskTypes: ['shadowing'] as const } : {}),
        // Generation is optional and can never block the session.
        allowGeneratedContent: true,
      });
      if (planned.activities.length === 0) {
        setErrorMessage(planned.sourceNote);
        return;
      }
      setActivities(planned.activities);
      setSourceNote(planned.sourceNote);
      setActivityIndex(0);
      setStepIndex(0);
      setCompleted(false);
      setAnswer('');
      setEvaluation(null);
      setShadowingResult(null);
      setPlayback({
        speechRate: planned.plan.speechRate,
        replayCount: 0,
        isPlaying: false,
      });
    } catch {
      setErrorMessage('Deep listening could not be started. Please try again.');
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, props.ttsProvider, props.shadowingOnly, service]);

  // Start exactly once for this mount (the guard keeps the effect safe even
  // though `start` changes identity while it is running).
  const startedRef = useRef<boolean>(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Unmount cleanup: dispose active shadowing controller and stop active TTS
  useEffect(() => {
    return () => {
      shadowingTokenRef.current += 1;
      const activeController = controllerRef.current;
      controllerRef.current = null;
      void activeController?.dispose();
      void ttsRef.current?.stop();
    };
  }, []);

  /**
   * The honest multi-speaker note for the current activity: one synthesized
   * voice is never presented as several real voices.
   */
  useEffect(() => {
    if (!activity || !isDiscourseActivity(activity) || !isMultiSpeakerActivity(activity)) {
      setSpeakerNote(null);
      return;
    }
    const capability = resolveSpeakerVoiceCapability(ttsRef.current ?? undefined);
    setSpeakerNote(capability.distinctVoices ? null : SINGLE_VOICE_HONESTY_NOTE);
  }, [activity]);

  /** Reset the per-activity local practice state (shadowing included). */
  useEffect(() => {
    let active = true;
    const token = (shadowingTokenRef.current += 1);
    // A new activity starts a FRESH assist state: an in-flight meaning request
    // for the old activity is invalidated by the token bump above and its
    // result can never be written onto the new activity's card.
    setAssist(resetAssistForActivity());
    setChunkSaveNote(null);
    meaningInFlightRef.current = false;

    const oldController = controllerRef.current;
    controllerRef.current = null;
    void oldController?.dispose();

    if (!activity || activity.taskType !== 'shadowing') {
      setShadowing(null);
      setIsRecording(false);
      setShadowingResult(null);
      return;
    }

    const session = new ShadowingSession({
      id: activity.id,
      chunk: activity.chunk,
      canonicalWrittenForm: activity.canonicalWrittenForm,
      baseSupport: activity.support,
      maxRepeats: activity.maxRepeats,
    });

    void (async () => {
      let recorder = props.recorder;
      let stt = props.stt;
      if (!recorder || !stt) {
        const resolved = await resolveVoiceInput(props.recorder, props.stt);
        if (resolved) {
          recorder = resolved.recorder;
          stt = resolved.stt;
        }
      }
      if (!active || shadowingTokenRef.current !== token) return;

      const controller = new ShadowingVoiceController(session, {
        ...(recorder ? { recorder } : {}),
        ...(stt ? { stt } : {}),
        submit: (transcript: string, checkStale?: () => boolean) => service.submitShadowingAttempt(session, transcript, { checkStale }),
      });

      controllerRef.current = controller;
      setShadowing({ session, controller });
      setIsRecording(false);
      setShadowingResult(null);
    })();

    return () => {
      active = false;
      shadowingTokenRef.current += 1;
      const c = controllerRef.current;
      controllerRef.current = null;
      void c?.dispose();
    };
  }, [activity, props.recorder, props.stt, service]);

  const handlePlay = async (): Promise<void> => {
    if (!activity || !playback) return;
    try {
      const tts = ttsRef.current ?? (await resolveTts(props.ttsProvider));
      ttsRef.current = tts;
      if (!tts) {
        setErrorMessage('Audio playback is not available right now. Your practice is kept.');
        return;
      }
      setIsPlaying(true);
      if (activity.taskType === 'shadowing') {
        // Shadowing playback is counted by its own session, and a failed play
        // is not even a replay.
        if (!shadowing) return;
        const played = await playShadowingChunk(
          tts,
          shadowing.session,
          speechRateTTSOptions(playback.speechRate),
        );
        if (!played.ok) setErrorMessage(played.message);
        return;
      }
      setPlayback((current) => (current ? beginPlayback(current) : current));
      await tts.speak(spokenTextFor(activity), speechRateTTSOptions(playback.speechRate));
      setPlayback((current) => (current ? finishPlayback(current) : current));
    } catch {
      setPlayback((current) => (current ? abortPlayback(current) : current));
      setErrorMessage(
        'Audio playback failed. Use Replay to try again — your exercise and answer are kept.',
      );
    } finally {
      setIsPlaying(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await ttsRef.current?.stop();
    } catch {
      // Stop failures are harmless.
    } finally {
      setIsPlaying(false);
    }
  };

  const handleSpeechRate = (level: (typeof DEEP_SPEECH_RATE_LEVELS)[number]): void => {
    // A playback change only: it never counts as an attempt or an answer.
    setPlayback((current) =>
      current ? withSpeechRate(current, level, capabilityRef.current) : current,
    );
  };

  const handleCheckAnswer = async (): Promise<void> => {
    if (!activity || !step || isChecking) return;
    setIsChecking(true);
    setErrorMessage(null);
    try {
      const learnerId = await service.resolveLearnerId();
      if (!learnerId) {
        setErrorMessage('No learner profile found yet — the answer was not saved.');
        return;
      }
      const result = await service.evaluateDeepAnswer(
        learnerId,
        activity,
        step.id,
        answer,
        { replayCount: playback?.replayCount ?? 0 },
      );
      if (!result.evaluation) {
        setErrorMessage('This question is not answerable right now. Your practice is kept.');
        return;
      }
      setEvaluation(result.evaluation);
      if (result.persistenceError) {
        setErrorMessage('Your answer and feedback are shown, but saving progress failed this time.');
      }
    } catch {
      setErrorMessage('Checking failed. Your answer is kept — try again.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleShadowingToggle = async (): Promise<void> => {
    const current = shadowing;
    if (!current || voicePending || playback?.isPlaying) return;
    const token = shadowingTokenRef.current;
    setErrorMessage(null);

    if (!current.controller.voiceAvailable) {
      setErrorMessage(
        'Voice capture needs a configured speech provider. You can still read the chunk and repeat it aloud.',
      );
      return;
    }

    setVoicePending(true);
    try {
      if (!isRecording) {
        const started = await current.controller.startRecording();
        if (shadowingTokenRef.current !== token) return;
        if (!('ok' in started) || !started.ok) {
          if ('message' in started) setErrorMessage(started.message);
          return;
        }
        setIsRecording(true);
        return;
      }
      setIsRecording(false);
      const judged = await current.controller.stopAndJudge();
      if (shadowingTokenRef.current !== token) return;
      if ('ok' in judged && judged.ok === false) {
        setErrorMessage(judged.message);
        return;
      }
      setShadowingResult(judged as ShadowingAttempt);
    } catch {
      if (shadowingTokenRef.current !== token) return;
      setIsRecording(false);
      setErrorMessage('That repeat could not be checked. Nothing was saved.');
    } finally {
      if (shadowingTokenRef.current === token) setVoicePending(false);
    }
  };

  /**
   * Work Order 2 — Meaning / explanation. Uses the activity's OWN curated
   * explanation when it has one; otherwise asks the tutor through the shared
   * help service. A failure shows a friendly sentence and keeps everything the
   * learner already has; reading the meaning never counts as performance.
   */
  const handleMeaning = async (): Promise<void> => {
    if (!activity) return;
    const curated = curatedMeaning({ explanation: activity.explanation });
    if (curated !== null) {
      setAssist((current) => meaningLoaded(openMeaning(current), curated, false));
      return;
    }
    if (meaningInFlightRef.current) return;
    if (assist.meaningVisible && assist.meaningStatus === 'ready') {
      setAssist((current) => closeMeaning(current));
      return;
    }
    meaningInFlightRef.current = true;
    const token = shadowingTokenRef.current;
    setAssist((current) => beginMeaningRequest(current));
    try {
      const help = getHelpService();
      if (!help.providerAvailable) {
        setAssist((current) =>
          meaningFailed(
            current,
            'No AI tutor is configured, so this passage cannot be explained automatically. Nothing was invented.',
          ),
        );
        return;
      }
      const result = await help.requestHelp({
        action: 'explain',
        topic: activity.contextTopic ?? null,
        contextText:
          activity.taskType === 'shadowing'
            ? activity.chunk
            : activity.taskType === 'connected_speech'
            ? activity.items.map((item) => item.writtenForm).join(', ')
            : undefined,
        // Stale probe: leaving the activity discards the late answer.
        checkStale: () => shadowingTokenRef.current !== token,
      });
      if (shadowingTokenRef.current !== token) return;
      if (!result.ok) {
        setAssist((current) => meaningFailed(current, result.errorMessage));
        return;
      }
      setAssist((current) => meaningLoaded(current, result.text, true));
    } catch {
      if (shadowingTokenRef.current === token) {
        setAssist((current) =>
          meaningFailed(current, 'The explanation could not be fetched. Your practice is untouched.'),
        );
      }
    } finally {
      meaningInFlightRef.current = false;
    }
  };

  const handleRetryMeaning = (): void => {
    void handleMeaning();
  };

  /**
   * Work Order 2 — save the CURRENT chunk (or a revealed transcript sentence)
   * to Review. Manual, allowed in every state, and completely separate from
   * attempts: saving changes no review status, mastery or evidence.
   */
  const handleSaveToReview = async (
    text: string,
    itemType: 'sentence' | 'word' | 'phrase' | 'collocation' | 'expression',
  ): Promise<void> => {
    if (!activity || isSavingChunk) return;
    const clean = text.trim();
    if (clean.length === 0) return;
    setIsSavingChunk(true);
    setChunkSaveNote(null);
    try {
      const result = await saveService.save({
        learnerId: await service.resolveLearnerId().catch(() => null) ?? '',
        text: clean,
        itemType: itemType === 'expression' ? 'common_expression' : itemType,
        origin: activity.taskType === 'shadowing' ? 'shadowing' : 'listening',
        originRef: activity.id,
        contextSentence: clean,
      });
      if (result.ok) {
        setChunkSaveNote(
          result.reason === 'already_saved'
            ? 'Already in your Review list — nothing was duplicated.'
            : 'Saved to Review. Listening and saving never count as a result.',
        );
      } else if (result.reason === 'no_profile') {
        setChunkSaveNote('Saving needs a learning profile first.');
      } else {
        setChunkSaveNote('Could not save this time. Nothing was changed.');
      }
    } finally {
      setIsSavingChunk(false);
    }
  };

  const handleNext = (): void => {
    setErrorMessage(null);
    setVoicePending(false);
    shadowingTokenRef.current += 1;
    const activeController = controllerRef.current ?? shadowing?.controller;
    controllerRef.current = null;
    void activeController?.dispose();
    void ttsRef.current?.stop();

    if (stepIndex + 1 < steps.length) {
      setStepIndex((index) => index + 1);
      setAnswer('');
      setEvaluation(null);
      return;
    }
    if (activityIndex + 1 < activities.length) {
      setActivityIndex((index) => index + 1);
      setStepIndex(0);
      setAnswer('');
      setEvaluation(null);
      setShadowingResult(null);
      return;
    }
    setCompleted(true);
  };

  /* ---------------------------- render ---------------------------- */

  if (completed) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Practice complete</Text>
        <Text style={styles.body}>
          {activities.length} activities completed. Your feedback is based only on the answers you gave.
        </Text>
        <Text style={styles.note}>{sourceNote}</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={() => void start()}>
          <Text style={styles.primaryButtonText}>Practice again</Text>
        </TouchableOpacity>
        {onExit ? (
          <TouchableOpacity style={styles.secondaryButton} onPress={onExit}>
            <Text style={styles.secondaryButtonText}>{props.shadowingOnly ? 'Back to learning' : 'Back to short exercises'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  if (!activity || !playback) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{props.shadowingOnly ? "Repeat and compare" : "Listening and imitation"}</Text>
        <Text style={styles.body}>
          {props.shadowingOnly ? 'Listen, repeat the phrase, and check the words recognized from your recording.' : 'Longer passages, conversations and repeat-after-the-audio practice.'}
        </Text>
        <TouchableOpacity
          style={[styles.primaryButton, isStarting ? styles.buttonDisabled : null]}
          onPress={() => void start()}
          disabled={isStarting}
          testID="start_deep_listening_button"
          accessibilityRole="button"
          accessibilityLabel={props.shadowingOnly ? "Start repeat and compare practice" : "Start listening and imitation"}
        >
          {isStarting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>{props.shadowingOnly ? "Start repeat and compare" : "Start listening and imitation"}</Text>
          )}
        </TouchableOpacity>
        {isStarting ? <Text accessibilityLiveRegion="polite">Preparing practice…</Text> : null}
        {errorMessage ? <Text accessibilityRole="alert" style={styles.errorText}>{errorMessage}</Text> : null}
      </View>
    );
  }

  const revealed = evaluation ? revealedTranscriptFor(activity) : null;
  const isChoice = Boolean(step?.options && step.options.length > 0);
  const speechRate = playback.speechRate;
  return (
    // The owning screen provides the scrolling container (mobile-first, no
    // nested scroll views).
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.counter}>
          {activityIndex + 1} / {activities.length}
        </Text>
        <Text style={styles.typeLabel}>
          {ACTIVITY_LABELS[activity.taskType]}
          {activity.materialOrigin === 'ai' ? ' · freshly generated' : ''}
        </Text>
      </View>
      <Text style={styles.note}>
        {activity.contentProvenance === 'general'
          ? 'General practice — not personalized.'
          : 'Built from your own saved practice.'}
        {activity.contextTopic ? ` · ${activity.contextTopic}` : ''}
      </Text>

      {isDiscourseActivity(activity) && activity.speakers.length > 0 ? (
        <Text style={styles.speakerLine}>
          {isMultiSpeakerActivity(activity) ? 'Speakers' : 'Speaker'}: {speakerSummary(activity)}
        </Text>
      ) : null}
      {speakerNote ? <Text style={styles.note}>{speakerNote}</Text> : null}

      <View style={styles.playRow}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => void handlePlay()}
          disabled={isPlaying || voicePending || isRecording}
          testID="deep_play_button"
          accessibilityRole="button"
          accessibilityLabel="Play audio"
        >
          <Text style={styles.primaryButtonText}>{isPlaying ? 'Playing…' : '▶ Play'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => void handlePlay()}
          disabled={isPlaying || voicePending || isRecording}
          accessibilityRole="button"
          accessibilityLabel="Replay audio"
        >
          <Text style={styles.secondaryButtonText}>↻ Replay</Text>
        </TouchableOpacity>
        {isPlaying ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => void handleStop()}
            accessibilityRole="button"
            accessibilityLabel="Stop audio"
          >
            <Text style={styles.secondaryButtonText}>■ Stop</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Speed control is offered ONLY when the provider really supports it. */}
      {speechRate.levels.length > 1 ? (
        <View style={styles.speedRow}>
          {DEEP_SPEECH_RATE_LEVELS.map((level) => (
            <TouchableOpacity
              key={level}
              style={[styles.pill, speechRate.level === level ? styles.pillActive : null]}
              onPress={() => handleSpeechRate(level)}
              accessibilityRole="button"
              accessibilityLabel={`Playback speed ${SPEECH_RATE_LABELS[level]}`}
            >
              <Text style={[styles.pillText, speechRate.level === level ? styles.pillTextActive : null]}>
                {SPEECH_RATE_LABELS[level]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <Text style={styles.note}>{speechRate.note}</Text>

      {activity.taskType === 'shadowing' ? (
        <View>
          <Text style={styles.sectionLabel}>Repeat after the audio</Text>
          {!shadowing?.controller.voiceAvailable ? <View><ProviderSettingsLink /><Text accessibilityLiveRegion="polite">Recording needs a configured speech provider. Open Settings → AI provider. Listening alone does not create pronunciation evidence.</Text></View> : null}
          <Text style={styles.note}>Microphone permission lets us hear your repeat. No permission means no recording or spoken evidence.</Text>
          {/permission/i.test(errorMessage ?? '') ? <MicrophoneHelp /> : null}
          {(() => {
            const readable = shadowing ? readableChunkFor(shadowing.session, assist) : null;
            return readable ? (
              <View style={styles.transcriptBox}>
                <Text style={styles.transcriptText}>{readable}</Text>
                {assist.transcriptRevealed && (
                  <Text style={styles.note}>
                    Revealed for you — this is assistance, not an attempt and not a result.
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.note}>
                Listen first: the text is hidden for this level. You can listen as many times as you like,
                or reveal the transcript below to understand it first.
              </Text>
            );
          })()}
          <View style={styles.playRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setAssist((current) => toggleTranscript(current))}
              accessibilityRole="button"
              accessibilityLabel={assist.transcriptRevealed ? 'Hide the transcript again' : 'Reveal the transcript to read while practicing'}
            >
              <Text style={styles.secondaryButtonText}>
                {assist.transcriptRevealed ? 'Hide transcript' : 'Reveal transcript'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => void handleMeaning()}
              disabled={assist.meaningStatus === 'loading'}
              accessibilityRole="button"
              accessibilityLabel="Show what this means"
            >
              <Text style={styles.secondaryButtonText}>
                {assist.meaningStatus === 'loading' ? 'Explaining…' : 'Meaning'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => void handlePlay()}
              disabled={isPlaying || voicePending || isRecording}
              accessibilityRole="button"
              accessibilityLabel="Replay this chunk as often as you like"
            >
              <Text style={styles.secondaryButtonText}>↻ Replay</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() =>
                activity.taskType === 'shadowing'
                  ? void handleSaveToReview(activity.chunk, 'sentence')
                  : undefined
              }
              disabled={isSavingChunk || activity.taskType !== 'shadowing'}
              accessibilityRole="button"
              accessibilityLabel="Save this chunk to Review"
            >
              <Text style={styles.secondaryButtonText}>
                {isSavingChunk ? 'Saving…' : '＋ Save to Review'}
              </Text>
            </TouchableOpacity>
          </View>
          {chunkSaveNote ? <Text style={styles.note}>{chunkSaveNote}</Text> : null}
          {assist.meaningVisible ? (
            <View style={styles.feedbackCard}>
              <Text style={styles.feedbackTitle}>
                {assist.meaningIsGenerated ? 'Tutor explanation (generated, not a dictionary)' : 'What this means'}
              </Text>
              {assist.meaningStatus === 'loading' ? (
                <Text style={styles.note}>The tutor is preparing a short explanation…</Text>
              ) : null}
              {assist.meaningText ? <Text style={styles.feedbackLine}>{assist.meaningText}</Text> : null}
              {assist.meaningStatus === 'failed' && assist.meaningError ? (
                <View>
                  <Text accessibilityRole="alert" style={styles.errorText}>{assist.meaningError}</Text>
                  {assist.canRetryMeaning ? (
                    <TouchableOpacity
                      style={styles.secondaryButton}
                      onPress={handleRetryMeaning}
                      accessibilityRole="button"
                      accessibilityLabel="Try the explanation again"
                    >
                      <Text style={styles.secondaryButtonText}>Try again</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setAssist((current) => closeMeaning(current))}
                accessibilityRole="button"
                accessibilityLabel="Close the meaning card"
              >
                <Text style={styles.secondaryButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => void handleShadowingToggle()}
            disabled={!shadowing?.controller.voiceAvailable || voicePending || Boolean(playback?.isPlaying) || shadowing.session.exhausted}
            accessibilityState={{ busy: voicePending }}
            testID="shadowing_repeat_button"
            accessibilityRole="button"
            accessibilityLabel={voicePending ? 'Processing spoken answer' : isRecording ? 'Stop recording' : 'Record your repeat'}
          >
            <Text style={styles.primaryButtonText}>
              {voicePending ? 'Processing…' : !shadowing?.controller.voiceAvailable ? 'Microphone unavailable' : isRecording ? 'Stop and check' : 'Record my repeat'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.note}>
            Repeats: {shadowing?.session.attemptCount ?? 0} of{' '}
            {shadowing?.session.maxRepeatCount ?? 0} · repeats are practice, not a measurement.
          </Text>
          {shadowingResult ? (
            <View style={styles.feedbackCard}>
              <Text style={styles.feedbackTitle}>
                {shadowingResult.qualitative.replace(/_/g, ' ')}
              </Text>
              {shadowingResult.feedbackLines.map((line, index) => (
                <Text key={index} style={styles.feedbackLine}>
                  • {line}
                </Text>
              ))}
              <Text style={styles.note}>
                Standard written form: {activity.canonicalWrittenForm}
              </Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.nextButton} disabled={voicePending || isRecording || isPlaying} onPress={handleNext}>
            <Text style={styles.nextButtonText}>
              {activityIndex + 1 < activities.length ? 'Next activity' : 'Finish'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View>
          {step ? (
            <View>
              <Text style={styles.sectionLabel}>{step.label}</Text>
              <Text style={styles.questionText}>{step.prompt}</Text>
              {!evaluation ? (
                isChoice ? (
                  <View style={styles.optionsColumn}>
                    {step.options!.map((option) => (
                      <TouchableOpacity
                        key={option}
                        style={[styles.optionButton, answer === option ? styles.optionSelected : null]}
                        onPress={() => setAnswer(option)}
                        accessibilityRole="button"
                        accessibilityLabel={`Option: ${option}`}
                      >
                        <Text style={styles.optionText}>{option}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={[styles.primaryButton, !answer ? styles.buttonDisabled : null]}
                      onPress={() => void handleCheckAnswer()}
                      disabled={!answer || isChecking}
                      testID="deep_check_button"
                      accessibilityRole="button"
                      accessibilityLabel="Check answer"
                    >
                      {isChecking ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.primaryButtonText}>Check answer</Text>
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
                      testID="deep_answer_input"
                    />
                    <TouchableOpacity
                      style={[styles.primaryButton, !answer.trim() ? styles.buttonDisabled : null]}
                      onPress={() => void handleCheckAnswer()}
                      disabled={!answer.trim() || isChecking}
                      testID="deep_check_button"
                      accessibilityRole="button"
                      accessibilityLabel="Check answer"
                    >
                      {isChecking ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.primaryButtonText}>Check answer</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )
              ) : (
                <View style={styles.feedbackCard} testID="deep_feedback">
                  <Text style={styles.feedbackTitle}>
                    {evaluation.result.replace(/_/g, ' ')}
                  </Text>
                  {evaluation.feedbackLines.map((line, index) => (
                    <Text key={index} style={styles.feedbackLine}>
                      • {line}
                    </Text>
                  ))}
                  {revealed ? (
                    <Text style={styles.transcriptText}>{revealed}</Text>
                  ) : null}
                  {revealed ? (
                    <TouchableOpacity
                      style={styles.secondaryButton}
                      onPress={() => void handleSaveToReview(revealed, 'sentence')}
                      disabled={isSavingChunk}
                      accessibilityRole="button"
                      accessibilityLabel="Save a sentence from this transcript to Review"
                    >
                      <Text style={styles.secondaryButtonText}>
                        {isSavingChunk ? 'Saving…' : '＋ Save to Review'}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  {chunkSaveNote ? <Text style={styles.note}>{chunkSaveNote}</Text> : null}
                  <TouchableOpacity style={styles.nextButton} disabled={voicePending || isRecording || isPlaying} onPress={handleNext}>
                    <Text style={styles.nextButtonText}>
                      {stepIndex + 1 < steps.length
                        ? 'Next question'
                        : activityIndex + 1 < activities.length
                          ? 'Next activity'
                          : 'Finish'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : null}
        </View>
      )}

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {onExit ? (
        <TouchableOpacity style={styles.secondaryButton} onPress={onExit}>
          <Text style={styles.secondaryButtonText}>{props.shadowingOnly ? 'Back to learning' : 'Back to short exercises'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Exposed for the deep panel's own tests (kept pure and dependency-free). */
void resolveSpeechRateCapability;

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    margin: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#1F2937', marginBottom: 8 },
  body: { fontSize: 14, color: '#4B5563', lineHeight: 20, marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  counter: { fontSize: 13, color: '#6B7280', fontWeight: '600' },
  typeLabel: { fontSize: 13, color: '#1D4ED8', fontWeight: '700' },
  note: { fontSize: 12, color: '#6B7280', marginTop: 4, marginBottom: 8 },
  speakerLine: { fontSize: 13, color: '#374151', fontWeight: '600', marginTop: 4 },
  playRow: { flexDirection: 'row', gap: 8, marginVertical: 10, flexWrap: 'wrap' },
  speedRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  pillActive: { backgroundColor: '#1D4ED8', borderColor: '#1D4ED8' },
  pillText: { color: '#374151', fontSize: 13 },
  pillTextActive: { color: '#FFFFFF', fontWeight: '600' },
  sectionLabel: { fontSize: 13, color: '#1D4ED8', fontWeight: '700', marginTop: 12 },
  questionText: { fontSize: 15, color: '#1F2937', fontWeight: '600', marginBottom: 10, marginTop: 4 },
  optionsColumn: { gap: 8 },
  optionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  optionSelected: { borderColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  optionText: { fontSize: 14, color: '#1F2937' },
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
  primaryButton: {
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    backgroundColor: '#DBEAFE',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#1D4ED8', fontWeight: '600', fontSize: 14 },
  transcriptBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 8,
  },
  transcriptText: { fontSize: 15, color: '#1F2937', lineHeight: 22, marginTop: 6 },
  feedbackCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginTop: 12,
  },
  feedbackTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1D4ED8',
    textTransform: 'capitalize',
    marginBottom: 8,
  },
  feedbackLine: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 4 },
  nextButton: {
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  nextButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#DC2626', fontSize: 13, marginTop: 10, textAlign: 'center' },
});
