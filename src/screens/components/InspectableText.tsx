/**
 * src/screens/components/InspectableText.tsx
 *
 * ONE shared contextual-inspection surface for learner-facing educational
 * text (story passages, listening transcripts, conversation messages).
 *
 * Interaction (Package 2, C/D — smallest safe fallback, no fake native
 * selection): every word is a tap region. Tapping a word selects it and
 * reveals an explicit contextual action row ("Look up …" / "Translate the
 * whole sentence"). Only that action opens Dictionary & Translate, prefilled
 * through the pure helpers in ./inspectable-text. Nothing is inspected — and
 * no provider request is made — until the learner confirms the action.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TouchableOpacity from './LearnerButton';
import {
  buildInspectionPrefill,
  splitInspectableSentences,
  tokenizeInspectableSentence,
  type InspectionPrefillParam,
} from './inspectable-text';

export interface InspectableTextProps {
  /** The visible source passage. */
  readonly text: string;
  readonly textStyle?: object;
  /** Called when the learner confirms the contextual action. */
  readonly onInspect: (prefill: InspectionPrefillParam) => void;
  /** Translation target (learner native language where known). */
  readonly targetLanguage: string;
  /** Optional source identity carried into the prefill (e.g. lesson id). */
  readonly sourceRef?: string;
  readonly accessibilityLabel?: string;
}

export default function InspectableText({
  text,
  textStyle,
  onInspect,
  targetLanguage,
  sourceRef,
  accessibilityLabel,
}: InspectableTextProps) {
  const [selection, setSelection] = useState<{
    readonly selectedText: string;
    readonly sentence: string;
  } | null>(null);

  const sentences = splitInspectableSentences(text);

  return (
    <View>
      <View accessibilityLabel={accessibilityLabel}>
        {sentences.map((sentence) => (
          <Text key={sentence} style={[styles.sentence, textStyle]}>
            {tokenizeInspectableSentence(sentence).map((token, index) => (
              <Text
                key={`${sentence.slice(0, 12)}-${index}-${token.display}`}
                onPress={
                  token.lookup.length > 0
                    ? () => setSelection({ selectedText: token.lookup, sentence })
                    : undefined
                }
                style={
                  token.lookup.length > 0 && selection?.selectedText === token.lookup
                    ? styles.tokenSelected
                    : styles.token
                }
              >
                {token.display}
                {index < tokenizeInspectableSentence(sentence).length - 1 ? ' ' : ''}
              </Text>
            ))}
            {'\n'}
          </Text>
        ))}
      </View>

      {selection && (
        <View style={styles.actionRow}>
          <Text style={styles.actionLabel} numberOfLines={1}>
            “{selection.selectedText}”
          </Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() =>
              onInspect(
                buildInspectionPrefill({
                  selectedText: selection.selectedText,
                  sentence: selection.sentence,
                  fullText: text,
                  targetLanguage,
                  ...(sourceRef ? { sourceRef } : {}),
                }),
              )
            }
            accessibilityRole="button"
            accessibilityLabel={`Look up the meaning of ${selection.selectedText}`}
          >
            <Text style={styles.actionButtonText}>Meaning / Translate</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButtonSecondary}
            onPress={() =>
              onInspect(
                buildInspectionPrefill({
                  selectedText: selection.sentence,
                  sentence: selection.sentence,
                  fullText: text,
                  targetLanguage,
                  itemType: 'sentence',
                  ...(sourceRef ? { sourceRef } : {}),
                }),
              )
            }
            accessibilityRole="button"
            accessibilityLabel="Translate the whole sentence"
          >
            <Text style={styles.actionButtonTextSecondary}>Whole sentence</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionDismiss}
            onPress={() => setSelection(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss the look up actions"
          >
            <Text style={styles.actionDismissText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sentence: {
    fontSize: 15,
    lineHeight: 24,
    color: '#1F2937',
  },
  token: {
    fontSize: 15,
    color: '#1F2937',
  },
  tokenSelected: {
    fontSize: 15,
    color: '#1D4ED8',
    backgroundColor: '#DBEAFE',
    textDecorationLine: 'underline',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  actionLabel: {
    flex: 1,
    minWidth: 80,
    fontSize: 14,
    fontWeight: '700',
    color: '#1E3A8A',
  },
  actionButton: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  actionButtonSecondary: {
    borderWidth: 1.5,
    borderColor: '#2563EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  actionButtonTextSecondary: {
    color: '#2563EB',
    fontSize: 13,
    fontWeight: '700',
  },
  actionDismiss: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  actionDismissText: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '700',
  },
});
