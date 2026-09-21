import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { AppState, StyleSheet, Text, TextInput, View } from 'react-native';
import TouchableOpacity from '../components/LearnerButton';
import { theme } from '../components/ui/theme';
import { Pill } from '../components/ui/Pill';
import type { LearningTools } from '../../lessons/composition';
import type { StoryLesson, LessonMode } from '../../lessons/types';
import type { InspectionInput } from '../../dictionary/inspector';
import { READ_ALOUD_LIMITATION } from '../../lessons/read-aloud';

const MODE_LABELS: Record<LessonMode, string> = {
  listening: 'Listening',
  reading: 'Reading',
};

/**
 * Shared story lesson panel — listening and reading use the same story model.
 * Visual redesign only: StoryLessonSession owns TTS, real-answer comprehension,
 * assistance markers and completion; ReadAloudPractice owns the existing
 * voice lifecycle + transcript comparison. This panel renders and delegates.
 */
export default function StoryPanel({ tools, lesson, mode, inspect }: { tools: LearningTools; lesson: StoryLesson; mode: LessonMode; inspect: (input: InspectionInput) => void }) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const session = useMemo(() => tools.openLesson(lesson, mode, redraw), [tools, lesson, mode]);
  const readAloud = useMemo(() => tools.readAloud(lesson), [tools, lesson]);
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state !== 'active') { session.stop(); readAloud.reset(); redraw(); } });
    return () => { session.dispose(); readAloud.dispose(); sub.remove(); };
  }, [session, readAloud]);
  useFocusEffect(useCallback(() => () => { session.stop(); readAloud.reset(); }, [session, readAloud]));
  const state = session.snapshot(), voice = readAloud.voice.getStatus();
  const passageLabel = mode === 'listening' && !state.transcriptVisible ? 'Transcript (hidden)' : 'Passage';
  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.lessonTitle}>{lesson.title}</Text>
          <Pill label={MODE_LABELS[mode]} tone="primary" />
        </View>
        <Text style={styles.lessonMeta}>{lesson.difficultyIntent}</Text>
        <Text style={styles.lessonMeta}>
          {lesson.provenance.kind === 'curated' ? 'Built-in authored starter' : `Provider-generated lesson · ${lesson.provenance.providerId}`}
        </Text>
      </View>

      {mode === 'listening' && (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Audio</Text>
          <View style={styles.controlRow}>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={() => void session.play()}
              accessibilityRole="button"
              accessibilityLabel={state.assistance.plays ? 'Replay the listening passage' : 'Play the listening passage'}
            >
              <Text style={styles.controlButtonText}>{state.assistance.plays ? 'Replay' : 'Play listening passage'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.controlOutline, !session.supportsSlower && styles.controlDisabled]}
              disabled={!session.supportsSlower}
              onPress={() => void session.play(true)}
              accessibilityRole="button"
            >
              <Text style={[styles.controlButtonText, styles.controlOutlineText, !session.supportsSlower && styles.controlTextDisabled]}>
                Play slower / repeat
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.controlOutline]}
              onPress={() => session.stop()}
              accessibilityRole="button"
            >
              <Text style={[styles.controlButtonText, styles.controlOutlineText]}>Stop audio</Text>
            </TouchableOpacity>
          </View>
          {!session.supportsSlower && (
            <Text style={styles.metaText}>This voice does not support slower playback.</Text>
          )}
          <View style={styles.playbackRow}>
            <Text style={styles.metaText}>Playback</Text>
            <Pill label={state.playback} tone={state.playback === 'error' ? 'error' : state.playback === 'playing' ? 'primary' : 'neutral'} />
          </View>
          <TouchableOpacity
            style={[styles.controlButton, styles.controlOutline]}
            onPress={() => session.reveal(!state.transcriptVisible)}
            accessibilityRole="button"
          >
            <Text style={[styles.controlButtonText, styles.controlOutlineText]}>
              {state.transcriptVisible ? 'Hide transcript' : 'Reveal transcript (assistance)'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {state.transcriptVisible && (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{passageLabel}</Text>
          <Text style={styles.passageText} selectable>{lesson.passage}</Text>
        </View>
      )}

      {mode === 'reading' && (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => void session.expose().then(() => setNote('Reading interaction saved — not a comprehension result.')).catch(() => setNote('Could not save reading activity. Retry.'))}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>I have read the passage</Text>
        </TouchableOpacity>
      )}

      {state.pendingAnswer && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingText}>
            Pending answer: {state.pendingAnswer.answer}. Retry this same choice to save safely.
          </Text>
        </View>
      )}

      <Text style={styles.assistanceNote}>Assistance never counts as comprehension. Only submitted answers are evidence.</Text>

      {lesson.questions.map(question => {
        const answer = state.answers.find(a => a.questionId === question.id);
        return (
          <View key={question.id} style={styles.questionCard}>
            <Text style={styles.questionPrompt}>{question.prompt}</Text>
            {answer ? (
              <View style={styles.answeredBox}>
                <Text style={styles.feedbackText}>{answer.evaluation.feedbackLines.join('\n')}</Text>
                <View style={styles.playbackRow}>
                  <Text style={styles.metaText}>Result</Text>
                  <Pill label={answer.assisted ? 'Answered with assistance' : 'Answer recorded'} tone={answer.assisted ? 'warning' : 'success'} />
                </View>
              </View>
            ) : (
              question.options.map(option => {
                const optionDisabled = busy || Boolean(state.pendingAnswer && (state.pendingAnswer.questionId !== question.id || state.pendingAnswer.answer !== option));
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.optionButton, optionDisabled && styles.optionDisabled]}
                    disabled={optionDisabled}
                    onPress={() => { setBusy(true); void session.answer(question.id, option).finally(() => setBusy(false)); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Answer: ${option}`}
                  >
                    <Text style={[styles.optionText, optionDisabled && styles.optionTextDisabled]}>{option}</Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        );
      })}

      <TouchableOpacity
        style={[styles.primaryButton, (state.completed || state.answers.length !== lesson.questions.length || busy) && styles.primaryDisabled]}
        disabled={state.completed || state.answers.length !== lesson.questions.length || busy}
        onPress={() => { setBusy(true); void session.complete().finally(() => setBusy(false)); }}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>
          {state.completed ? 'Lesson completed' : `Complete lesson (${state.answers.length} of ${lesson.questions.length} answered)`}
        </Text>
      </TouchableOpacity>

      {state.error && <Text style={styles.alertText} accessibilityRole="alert">{state.error}</Text>}

      <TouchableOpacity
        style={[styles.controlButton, styles.controlOutline, styles.fullWidth]}
        onPress={() => session.revealLanguage(!state.languageVisible)}
        accessibilityRole="button"
      >
        <Text style={[styles.controlButtonText, styles.controlOutlineText]}>
          {state.languageVisible ? 'Hide contextual language' : 'Show contextual language (assistance)'}
        </Text>
      </TouchableOpacity>

      {state.languageVisible && lesson.language.map((item, index) => (
        <View key={item.text} style={styles.card}>
          <Text style={styles.languageText}>{item.text}</Text>
          <Text style={styles.languageMeaning}>{item.meaning}</Text>
          <View style={styles.controlRow}>
            <TouchableOpacity
              style={[styles.controlButton, styles.controlOutline]}
              onPress={() => inspect(session.inspection(item.text, tools.profile?.nativeLanguage ?? 'Arabic'))}
              accessibilityRole="button"
              accessibilityLabel={`Inspect ${item.text}`}
            >
              <Text style={[styles.controlButtonText, styles.controlOutlineText]}>Inspect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.controlOutline]}
              onPress={() => void session.saveLanguage(index).then(result => setNote(result.ok ? result.duplicate ? 'Already saved; existing review unchanged.' : 'Saved for review, not learned.' : 'Could not save. Retry.'))}
              accessibilityRole="button"
              accessibilityLabel={`Save ${item.text} to Review`}
            >
              <Text style={[styles.controlButtonText, styles.controlOutlineText]}>Save to Review</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Unknown language from the passage</Text>
        <TextInput
          accessibilityLabel="Unknown language from passage"
          placeholder="Type/paste unknown words from this passage"
          value={selected}
          onChangeText={setSelected}
          style={styles.input}
          placeholderTextColor={theme.colors.textTertiary}
        />
        <TouchableOpacity
          style={[styles.secondaryButton, (!selected.trim() || !lesson.passage.includes(selected)) && styles.secondaryDisabled]}
          disabled={!selected.trim() || !lesson.passage.includes(selected)}
          onPress={() => inspect(session.inspection(selected, tools.profile?.nativeLanguage ?? 'Arabic'))}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Inspect / translate selected language</Text>
        </TouchableOpacity>
      </View>

      {mode === 'reading' && (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Read aloud</Text>
          <Text style={styles.limitationText}>{READ_ALOUD_LIMITATION}</Text>
          <TouchableOpacity
            style={[styles.primaryButton, (voiceBusy || voice.isBusy || !voice.isAvailable) && styles.primaryDisabled]}
            disabled={voiceBusy || voice.isBusy || !voice.isAvailable}
            onPress={() => { session.stop(); setVoiceBusy(true); void readAloud.toggleRecording().finally(() => { setVoiceBusy(false); redraw(); }); }}
            accessibilityRole="button"
            accessibilityLabel={voice.isRecording ? 'Stop recording and transcribe' : 'Record yourself reading the passage'}
          >
            <Text style={styles.primaryButtonText}>{voice.isRecording ? 'Stop and transcribe' : 'Record this passage'}</Text>
          </TouchableOpacity>
          {!voice.isAvailable && (
            <Text style={styles.metaText}>Speech recognition needs a provider configured in Settings. No scripted transcript is used.</Text>
          )}
          {!!voice.transcript && (
            <View style={styles.transcriptBox}>
              <Text style={styles.metaText}>Recognized transcript</Text>
              <Text style={styles.transcriptText}>{voice.transcript}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.secondaryButton, (voiceBusy || !voice.transcript || voice.isRecording) && styles.secondaryDisabled]}
            disabled={voiceBusy || !voice.transcript || voice.isRecording}
            onPress={() => { setVoiceBusy(true); void readAloud.compare().finally(() => { setVoiceBusy(false); redraw(); }); }}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>Compare transcript with target</Text>
          </TouchableOpacity>
          {readAloud.feedback?.lines.map(line => (
            <Text key={line} style={styles.feedbackLine}>{line}</Text>
          ))}
          {readAloud.error && <Text style={styles.alertText} accessibilityRole="alert">{readAloud.error}</Text>}
          <TouchableOpacity style={styles.ghostButton} onPress={() => { readAloud.reset(); redraw(); }} accessibilityRole="button">
            <Text style={styles.ghostButtonText}>Retry read-aloud</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!note && <Text style={styles.noteText} accessibilityLiveRegion="polite">{note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginTop: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    ...theme.shadows.card,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  lessonTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    flexShrink: 1,
  },
  lessonMeta: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.spacing.sm,
  },
  passageText: {
    fontSize: 15,
    color: theme.colors.textPrimary,
    lineHeight: 24,
  },
  controlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  controlButton: {
    flex: 1,
    minWidth: 120,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  controlButtonText: {
    color: theme.colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  controlOutline: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  controlOutlineText: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  controlDisabled: {
    backgroundColor: theme.colors.neutral[100],
    borderColor: theme.colors.neutral[200],
  },
  controlTextDisabled: {
    color: theme.colors.textTertiary,
  },
  playbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  metaText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 19,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: theme.spacing.md,
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  primaryDisabled: {
    backgroundColor: theme.colors.neutral[300],
    shadowOpacity: 0,
    elevation: 0,
  },
  secondaryButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryDisabled: {
    backgroundColor: theme.colors.neutral[50],
    borderColor: theme.colors.neutral[200],
  },
  ghostButton: {
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  ghostButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  pendingBanner: {
    backgroundColor: theme.colors.warningSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  pendingText: {
    fontSize: 13,
    color: theme.colors.warningDark,
    fontWeight: '600',
    lineHeight: 19,
  },
  assistanceNote: {
    fontSize: 12,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.md,
  },
  questionCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    ...theme.shadows.card,
  },
  questionPrompt: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    lineHeight: 22,
    marginBottom: theme.spacing.sm,
  },
  answeredBox: {
    backgroundColor: theme.colors.neutral[50],
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
  feedbackText: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    lineHeight: 21,
    marginBottom: theme.spacing.sm,
  },
  optionButton: {
    backgroundColor: theme.colors.neutral[50],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  optionDisabled: {
    backgroundColor: theme.colors.neutral[100],
  },
  optionText: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    lineHeight: 20,
  },
  optionTextDisabled: {
    color: theme.colors.textTertiary,
  },
  alertText: {
    fontSize: 13,
    color: theme.colors.error,
    lineHeight: 19,
    marginBottom: theme.spacing.md,
  },
  fullWidth: {
    flex: 1,
    minWidth: 0,
    marginBottom: theme.spacing.md,
  },
  languageText: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  languageMeaning: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    lineHeight: 21,
    marginBottom: theme.spacing.sm,
  },
  input: {
    backgroundColor: theme.colors.neutral[50],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    fontSize: 14,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  },
  transcriptBox: {
    backgroundColor: theme.colors.neutral[50],
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  transcriptText: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    lineHeight: 21,
  },
  feedbackLine: {
    fontSize: 13,
    color: theme.colors.neutral[700],
    lineHeight: 19,
    marginTop: theme.spacing.xs,
  },
  limitationText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 19,
    marginBottom: theme.spacing.sm,
  },
  noteText: {
    fontSize: 13,
    color: theme.colors.successDark,
    fontWeight: '600',
    marginBottom: theme.spacing.lg,
  },
});
