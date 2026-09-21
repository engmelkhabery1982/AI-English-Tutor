import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import TouchableOpacity from '../LearnerButton';
import { theme } from './theme';

interface PillProps {
  readonly label: string;
  readonly tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'error';
}

export function Pill({ label, tone = 'neutral' }: PillProps) {
  const style =
    tone === 'primary'
      ? styles.pillPrimary
      : tone === 'success'
        ? styles.pillSuccess
        : tone === 'warning'
          ? styles.pillWarning
          : tone === 'error'
            ? styles.pillError
            : styles.pillNeutral;
  const textStyle =
    tone === 'primary'
      ? styles.pillPrimaryText
      : tone === 'success'
        ? styles.pillSuccessText
        : tone === 'warning'
          ? styles.pillWarningText
          : tone === 'error'
            ? styles.pillErrorText
            : styles.pillNeutralText;

  return (
    <View style={[styles.base, style]}>
      <Text style={[styles.text, textStyle]}>{label}</Text>
    </View>
  );
}

interface SegmentedControlProps {
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
}

export function SegmentedControl({ options, selectedKey, onSelect }: SegmentedControlProps) {
  return (
    <View style={styles.segmentContainer}>
      {options.map((option) => {
        const active = option.key === selectedKey;
        return (
          <TouchableOpacity
            key={option.key}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onSelect(option.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
  pillNeutral: {
    backgroundColor: theme.colors.neutral[100],
  },
  pillNeutralText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.neutral[600],
  },
  pillPrimary: {
    backgroundColor: theme.colors.primaryLight,
  },
  pillPrimaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  pillSuccess: {
    backgroundColor: theme.colors.successSoft,
  },
  pillSuccessText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.successDark,
  },
  pillWarning: {
    backgroundColor: theme.colors.warningSoft,
  },
  pillWarningText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.warningDark,
  },
  pillError: {
    backgroundColor: theme.colors.errorSoft,
  },
  pillErrorText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.errorDark,
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.radius.md,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderRadius: theme.radius.sm,
  },
  segmentActive: {
    backgroundColor: theme.colors.surface,
    ...theme.shadows.card,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  segmentTextActive: {
    color: theme.colors.primary,
  },
});
