import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import TouchableOpacity from '../components/LearnerButton';
import { theme } from '../components/ui/theme';
import { SectionHeader } from '../components/ui/SectionHeader';
import { Pill } from '../components/ui/Pill';
import { InspectorController } from '../../dictionary/inspector-controller';
import { inspectionSaveInput, type InspectionInput, type InspectionType } from '../../dictionary/inspector';
import type { LearningTools } from '../../lessons/composition';

const TYPES: readonly InspectionType[] = ['word','phrase','idiom','collocation','expression','sentence','short_text'];

/**
 * Dictionary & Translate panel — meaning / translate / rephrase for one
 * selected word, phrase, idiom, expression, sentence or short text.
 *
 * Learner-facing name: "Dictionary & Translate" (the internal domain remains
 * the language inspector). Visual hierarchy only: the InspectorController
 * still owns input retention, single-flight inspection, retry policy and
 * invalidation, and saving still uses the existing WO2 save service via
 * `tools.save` ("I want to review this"). No capability was removed — the
 * full original text, item type and target language live behind "More
 * options" (progressive disclosure).
 */
export default function InspectorPanel({ tools, initial }: { tools: LearningTools; initial?: InspectionInput }) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const controller = useMemo(() => new InspectorController(() => tools.provider, initial ?? { originalText: '', selectedText: '', itemType: 'word', targetLanguage: tools.profile?.nativeLanguage ?? 'Arabic' }, redraw), [tools, initial]);
  const [saveNote, setSaveNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  useEffect(() => () => controller.dispose(), [controller]);
  useFocusEffect(useCallback(() => () => controller.cancel(), [controller]));
  const state = controller.snapshot(), input = state.input;
  const edit = (patch: Partial<InspectionInput>) => { controller.edit({ ...input, ...patch }); setSaveNote(''); };
  /**
   * Primary action. When the learner only typed/pasted the item itself (no
   * separate passage), the item becomes its own source passage — the selected
   * text itself is NEVER rewritten.
   */
  const lookup = () => {
    if (!input.selectedText.trim() || state.status === 'loading') return;
    if (!input.originalText.trim()) controller.edit({ ...input, originalText: input.selectedText });
    void controller.inspect();
  };
  return (
    <View style={styles.root}>
      <SectionHeader title="Dictionary & Translate" subtitle="Look up a word, phrase, expression, or sentence in context. Explanations are provider-generated — not authoritative dictionary truth." />

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Word, phrase, or sentence</Text>
        <TextInput
          accessibilityLabel="Selected language"
          placeholder="What do you want to understand? e.g. break the ice"
          value={input.selectedText}
          onChangeText={selectedText => edit({ selectedText })}
          style={styles.input}
          placeholderTextColor={theme.colors.textTertiary}
        />

        <Text style={styles.fieldLabel}>Where did you see it? (optional)</Text>
        <TextInput
          accessibilityLabel="Source context"
          placeholder="The sentence or situation it appeared in"
          value={input.context ?? ''}
          multiline
          maxLength={4000}
          onChangeText={context => edit({ context })}
          style={[styles.input, styles.inputContext]}
          placeholderTextColor={theme.colors.textTertiary}
        />

        <TouchableOpacity
          style={styles.primaryButton}
          disabled={state.status === 'loading' || !input.selectedText.trim()}
          onPress={lookup}
          accessibilityRole="button"
          accessibilityLabel="Look up and translate the selected text"
        >
          <Text style={styles.primaryButtonText}>{state.status === 'loading' ? 'Looking up…' : 'Look up / Translate'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.moreOptionsToggle}
          onPress={() => setMoreOptionsOpen(open => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: moreOptionsOpen }}
          accessibilityLabel="More lookup options"
        >
          <Text style={styles.moreOptionsToggleText}>{moreOptionsOpen ? '▾ Hide more options' : '▸ More options (passage, item type, language)'}</Text>
        </TouchableOpacity>

        {moreOptionsOpen && (
          <View>
            <Text style={styles.fieldLabel}>Original text (full passage)</Text>
            <TextInput
              accessibilityLabel="Original text"
              placeholder="Paste the full original text (up to 4,000 characters)"
              value={input.originalText}
              multiline
              maxLength={4000}
              onChangeText={originalText => edit({ originalText, selectedText: originalText })}
              style={[styles.input, styles.inputMultiline]}
              placeholderTextColor={theme.colors.textTertiary}
            />

            <Text style={styles.fieldLabel}>Item type</Text>
            <View style={styles.chipRow}>
              {TYPES.map(itemType => {
                const active = input.itemType === itemType;
                return (
                  <TouchableOpacity
                    key={itemType}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => edit({ itemType })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{itemType.replace('_', ' ')}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Translation language</Text>
            <TextInput
              accessibilityLabel="Translation language"
              value={input.targetLanguage}
              onChangeText={targetLanguage => edit({ targetLanguage })}
              style={styles.input}
              placeholderTextColor={theme.colors.textTertiary}
            />
          </View>
        )}

        {state.failure && (
          <Text style={styles.alertText} accessibilityRole="alert">
            {state.failure.message} Your original text is kept.
          </Text>
        )}
        {state.canRetry && (
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void controller.inspect()} accessibilityRole="button">
            <Text style={styles.secondaryButtonText}>Retry inspection</Text>
          </TouchableOpacity>
        )}
      </View>

      {state.result && (
        <View style={styles.resultRoot}>
          <SectionHeader title="Meaning & translation" />
          <View style={styles.card}>
            <Text style={styles.provenance}>
              Provider-generated explanation · {state.result.provenance.providerId} · Not authoritative dictionary truth
            </Text>
            <Text style={styles.resultLabel}>In context</Text>
            <Text style={styles.resultBody}>{state.result.contextualMeaning}</Text>
            <View style={styles.resultRow}>
              <Text style={styles.resultLabel}>Translation</Text>
              <Text style={styles.resultBody}>{state.result.translation}</Text>
            </View>
            <View style={styles.resultRow}>
              <Text style={styles.resultLabel}>Rephrase</Text>
              <Text style={styles.resultBody}>{state.result.rephrase}</Text>
            </View>
            <View style={styles.resultRow}>
              <Text style={styles.resultLabel}>Natural alternatives</Text>
              <Text style={styles.resultBody}>{state.result.alternatives.join(' / ')}</Text>
            </View>
          </View>

          {state.result.meanings.map(meaning => {
            const contextual = meaning.id === state.result?.contextualSenseId;
            return (
              <View key={meaning.id} style={styles.meaningCard}>
                <View style={styles.meaningHeader}>
                  <Text style={styles.meaningTitle}>{contextual ? 'Contextual sense' : 'Other common sense'}</Text>
                  {contextual ? <Pill label="In your text" tone="primary" /> : null}
                </View>
                <Text style={styles.resultBody}>{meaning.meaning}</Text>
                <Text style={styles.resultBody}>{meaning.translation}</Text>
                <Text style={styles.metaText}>{meaning.usage} · {meaning.register}</Text>
                {meaning.examples.map(example => (
                  <Text key={example} style={styles.exampleText}>{example}</Text>
                ))}
                <TouchableOpacity
                  style={styles.secondaryButton}
                  disabled={saving || !tools.profile}
                  onPress={() => {
                    if (!state.result || !tools.profile || saving) return;
                    setSaving(true);
                    void tools.save.save(inspectionSaveInput(tools.profile.id, state.result, meaning.id)).then(result => setSaveNote(result.ok ? result.duplicate ? 'Already saved. The existing meaning and review schedule were kept.' : result.reviewQueued ? 'Saved to Review — not marked learned.' : 'Saved. Review queue could not be updated; find it in Vocabulary.' : 'Could not save. Create a profile or retry.')).finally(() => setSaving(false));
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Save this meaning to Review</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      )}

      {!!saveNote && <Text style={styles.noteText} accessibilityLiveRegion="polite">{saveNote}</Text>}
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
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.spacing.xs,
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
  inputMultiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  inputContext: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  moreOptionsToggle: {
    paddingVertical: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  moreOptionsToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  chip: {
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: {
    backgroundColor: theme.colors.primary,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.neutral[600],
  },
  chipTextActive: {
    color: theme.colors.white,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
    marginTop: theme.spacing.sm,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  alertText: {
    fontSize: 13,
    color: theme.colors.error,
    lineHeight: 19,
    marginBottom: theme.spacing.sm,
  },
  resultRoot: {
    marginTop: theme.spacing.xs,
  },
  provenance: {
    fontSize: 12,
    color: theme.colors.textTertiary,
    lineHeight: 17,
    marginBottom: theme.spacing.md,
  },
  resultLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.spacing.xs,
    marginTop: theme.spacing.sm,
  },
  resultBody: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    lineHeight: 21,
  },
  resultRow: {
    marginTop: theme.spacing.md,
  },
  meaningCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    ...theme.shadows.card,
  },
  meaningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  meaningTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  metaText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  },
  exampleText: {
    fontSize: 13,
    color: theme.colors.neutral[600],
    fontStyle: 'italic',
    marginTop: theme.spacing.xs,
  },
  noteText: {
    fontSize: 13,
    color: theme.colors.successDark,
    fontWeight: '600',
    marginBottom: theme.spacing.lg,
  },
});
