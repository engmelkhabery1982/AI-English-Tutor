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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
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
  deepAnswerSteps,
  finishPlayback,
  abortPlayback,
  isDiscourseActivity,
  isMultiSpeakerActivity,
  playShadowingChunk,
  resolveSpeakerVoiceCapability,
  resolveSpeechRateCapability,
  revealedTranscriptFor,
  speakerSummary,
  speechRateTTSOptions,
  withSpeechRate,
  resolveVoiceInput,
} from '../../listening';
export { resolveVoiceInput };
import type {
  DeepListeningActivity,
  DeepPlaybackState,
  ShadowingAttempt,
  SpeechRateCapability,
} from '../../listening';

export interface DeepListeningPanelProps {
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
  const [completed, setCompleted] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'preparing' | 'ready' | 'unavailable'>('idle');

  const ttsRef = useRef<TextToSpeechProvider | null>(props.ttsProvider ?? null);
  const capabilityRef = useRef<SpeechRateCapability>(resolveSpeechRateCapability(props.ttsProvider));
  const generationRef = useRef<number>(0);
  const currentControllerRef = useRef<ShadowingVoiceController | null>(null);
  const voiceDepsRef = useRef<{ recorder: AudioRecorderService; stt: SpeechToTextProvider } | null>(null);

  /** The current shadowing practice session (state so the UI really re-renders). */
  const [shadowing, setShadowing] = useState<{
    readonly session: ShadowingSession;
    readonly controller: ShadowingVoiceController;
  } | null>(null);

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
        targetCount: 3,
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
  }, [isStarting, props.ttsProvider, service]);

  // Start exactly once for this mount (the guard keeps the effect safe even
  // though `start` changes identity while it is running).
  const startedRef = useRef<boolean>(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Clean up all active voice recording and audio playback on unmount.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (currentControllerRef.current) {
        void currentControllerRef.current.dispose();
        currentControllerRef.current = null;
      }
      void ttsRef.current?.stop().catch(() => {});
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
    generationRef.current += 1;
    const token = generationRef.current;

    if (currentControllerRef.current) {
      void currentControllerRef.current.dispose();
      currentControllerRef.current = null;
    }
    void ttsRef.current?.stop().catch(() => {});
    setIsPlaying(false);
    setIsRecording(false);
    setShadowingResult(null);

    if (!activity || activity.taskType !== 'shadowing') {
      setShadowing(null);
      setVoiceStatus('idle');
      return;
    }

    const session = new ShadowingSession({
      id: activity.id,
      chunk: activity.chunk,
      canonicalWrittenForm: activity.canonicalWrittenForm,
      baseSupport: activity.support,
      maxRepeats: activity.maxRepeats,
    });

    // Injected providers take precedence immediately
    if (props.recorder && props.stt) {
      const controller = new ShadowingVoiceController(session, {
        recorder: props.recorder,
        stt: props.stt,
        submit: (transcript: string) => service.submitShadowingAttempt(session, transcript),
      });
      currentControllerRef.current = controller;
      setShadowing({ session, controller });
      setVoiceStatus('ready');
      return;
    }

    // Cached providers
    if (voiceDepsRef.current) {
      const controller = new ShadowingVoiceController(session, {
        recorder: props.recorder ?? voiceDepsRef.current.recorder,
        stt: props.stt ?? voiceDepsRef.current.stt,
        submit: (transcript: string) => service.submitShadowingAttempt(session, transcript),
      });
      currentControllerRef.current = controller;
      setShadowing({ session, controller });
      setVoiceStatus('ready');
      return;
    }

    // Resolve asynchronously
    setVoiceStatus('preparing');
    const placeholderController = new ShadowingVoiceController(session, {
      ...(props.recorder ? { recorder: props.recorder } : {}),
      ...(props.stt ? { stt: props.stt } : {}),
      submit: (transcript: string) => service.submitShadowingAttempt(session, transcript),
    });
    currentControllerRef.current = placeholderController;
    setShadowing({ session, controller: placeholderController });

    void resolveVoiceInput(props.recorder, props.stt).then((resolved) => {
      if (token !== generationRef.current) return;
      if (resolved) {
        voiceDepsRef.current = resolved;
        if (currentControllerRef.current === placeholderController) {
          void placeholderController.dispose();
        }
        const activeController = new ShadowingVoiceController(session, {
          recorder: props.recorder ?? resolved.recorder,
          stt: props.stt ?? resolved.stt,
          submit: (transcript: string) => service.submitShadowingAttempt(session, transcript),
        });
        currentControllerRef.current = activeController;
        setShadowing({ session, controller: activeController });
        setVoiceStatus('ready');
      } else {
        setVoiceStatus('unavailable');
      }
    });

    return () => {
      if (currentControllerRef.current === placeholderController) {
        void placeholderController.dispose();
      }
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
    if (!current) return;
    setErrorMessage(null);
    if (!current.controller.voiceAvailable) {
      if (voiceStatus === 'preparing') {
        setErrorMessage('Voice capture is starting up. Tap again to record.');
      } else {
        setErrorMessage(
          'Voice capture needs a configured speech provider. You can still read the chunk and repeat it aloud.',
        );
      }
      return;
    }
    const token = generationRef.current;
    try {
      if (!isRecording) {
        const started = await current.controller.startRecording();
        if (token !== generationRef.current) return;
        if (!('ok' in started) || !started.ok) {
          if ('message' in started) setErrorMessage(started.message);
          return;
        }
        setIsRecording(true);
        return;
      }
      setIsRecording(false);
      const judged = await current.controller.stopAndJudge();
      if (token !== generationRef.current) return;
      if ('ok' in judged && judged.ok === false) {
        setErrorMessage(judged.message);
        return;
      }
      setShadowingResult(judged as ShadowingAttempt);
    } catch {
      if (token === generationRef.current) {
        setIsRecording(false);
        setErrorMessage('That repeat could not be checked. Nothing was saved.');
      }
    }
  };

  const handleNext = (): void => {
    setErrorMessage(null);
    generationRef.current += 1;
    if (currentControllerRef.current) {
      void currentControllerRef.current.dispose();
      currentControllerRef.current = null;
    }
    void handleStop();
    setIsRecording(false);
    setShadowingResult(null);

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
      return;
    }
    setCompleted(true);
  };

  const handleExit = (): void => {
    generationRef.current += 1;
    if (currentControllerRef.current) {
      void currentControllerRef.current.dispose();
      currentControllerRef.current = null;
    }
    void handleStop();
    setIsRecording(false);
    onExit?.();
  };

  /* ---------------------------- render ---------------------------- */

  if (completed) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Deep listening complete</Text>
        <Text style={styles.body}>
          {activities.length} activities · longer passages, more than one speaker, connected speech
          and shadowing.
        </Text>
        <Text style={styles.note}>{sourceNote}</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={() => void start()}>
          <Text style={styles.primaryButtonText}>Practice again</Text>
        </TouchableOpacity>
        {onExit ? (
          <TouchableOpacity style={styles.secondaryButton} onPress={handleExit}>
            <Text style={styles.secondaryButtonText}>Back to short exercises</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  if (!activity || !playback) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Deep listening</Text>
        <Text style={styles.body}>
          Longer passages, conversations with more than one speaker, connected speech and
          repeat-after-the-audio practice.
        </Text>
        <TouchableOpacity
          style={[styles.primaryButton, isStarting ? styles.buttonDisabled : null]}
          onPress={() => void start()}
          disabled={isStarting}
          testID="start_deep_listening_button"
          accessibilityRole="button"
          accessibilityLabel="Start deep listening"
        >
          {isStarting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>Start deep listening</Text>
          )}
        </TouchableOpacity>
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      </View>
    );
  }

  const revealed = evaluation ? revealedTranscriptFor(activity) : null;
  const isChoice = Boolean(step?.options && step.options.length > 0);
  const speechRate = playback.speechRate;
  const maskedChunk =
    activity.taskType === 'shadowing' ? shadowing?.session.visibleChunk ?? null : null;

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
          disabled={isPlaying}
          testID="deep_play_button"
          accessibilityRole="button"
          accessibilityLabel="Play audio"
        >
          <Text style={styles.primaryButtonText}>{isPlaying ? 'Playing…' : '▶ Play'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => void handlePlay()}
          disabled={isPlaying}
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
          {maskedChunk ? (
            <View style={styles.transcriptBox}>
              <Text style={styles.transcriptText}>{maskedChunk}</Text>
            </View>
          ) : (
            <Text style={styles.note}>
              Listen first: the text is hidden for this level. You can listen as many times as you like.
            </Text>
          )}
          <TouchableOpacity
            style={[styles.primaryButton, voiceStatus === 'preparing' ? styles.buttonDisabled : null]}
            onPress={() => void handleShadowingToggle()}
            disabled={voiceStatus === 'preparing'}
            testID="shadowing_repeat_button"
            accessibilityRole="button"
            accessibilityLabel={isRecording ? 'Stop recording' : 'Record your repeat'}
          >
            <Text style={styles.primaryButtonText}>
              {isRecording
                ? 'Stop and check'
                : voiceStatus === 'preparing'
                  ? 'Preparing voice capture…'
                  : 'Record my repeat'}
            </Text>
          </TouchableOpacity>
          {voiceStatus === 'unavailable' ? (
            <Text style={styles.note}>
              Voice capture is unavailable because speech-to-text is not configured. You can still read the chunk and repeat it aloud.
            </Text>
          ) : null}
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
          <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
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
                    <TextInput
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
                  <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
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
        <TouchableOpacity style={styles.secondaryButton} onPress={handleExit}>
          <Text style={styles.secondaryButtonText}>Back to short exercises</Text>
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
  typeLabel: { fontSize: 13, color: '#1F4E9C', fontWeight: '700' },
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
  pillActive: { backgroundColor: '#1F4E9C', borderColor: '#1F4E9C' },
  pillText: { color: '#374151', fontSize: 13 },
  pillTextActive: { color: '#FFFFFF', fontWeight: '600' },
  sectionLabel: { fontSize: 13, color: '#1F4E9C', fontWeight: '700', marginTop: 12 },
  questionText: { fontSize: 15, color: '#1F2937', fontWeight: '600', marginBottom: 10, marginTop: 4 },
  optionsColumn: { gap: 8 },
  optionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  optionSelected: { borderColor: '#1F4E9C', backgroundColor: '#EEF4FF' },
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
    backgroundColor: '#1F4E9C',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    backgroundColor: '#E5EDFB',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#1F4E9C', fontWeight: '600', fontSize: 14 },
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
    color: '#1F4E9C',
    textTransform: 'capitalize',
    marginBottom: 8,
  },
  feedbackLine: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 4 },
  nextButton: {
    backgroundColor: '#2E7D32',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  nextButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#B91C1C', fontSize: 13, marginTop: 10, textAlign: 'center' },
});
