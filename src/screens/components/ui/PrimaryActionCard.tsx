import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import TouchableOpacity from '../LearnerButton';
import { theme } from './theme';

interface PrimaryActionCardProps {
  readonly title: string;
  readonly description: string;
  readonly buttonLabel: string;
  readonly onPress: () => void;
  readonly badge?: string;
  readonly badgeTone?: 'primary' | 'success' | 'warning';
  readonly secondaryInfo?: string;
  readonly secondaryPress?: () => void;
  readonly secondaryLabel?: string;
}

export function PrimaryActionCard({
  title,
  description,
  buttonLabel,
  onPress,
  badge,
  badgeTone = 'primary',
  secondaryInfo,
  secondaryPress,
  secondaryLabel,
}: PrimaryActionCardProps) {
  const badgeStyle =
    badgeTone === 'success'
      ? styles.badgeSuccess
      : badgeTone === 'warning'
        ? styles.badgeWarning
        : styles.badgePrimary;
  const badgeTextStyle =
    badgeTone === 'success'
      ? styles.badgeSuccessText
      : badgeTone === 'warning'
        ? styles.badgeWarningText
        : styles.badgePrimaryText;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{title}</Text>
        {badge ? (
          <View style={[styles.badge, badgeStyle]}>
            <Text style={[styles.badgeText, badgeTextStyle]}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.description}>{description}</Text>
      {secondaryInfo ? <Text style={styles.secondaryInfo}>{secondaryInfo}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={onPress}>
        <Text style={styles.buttonText}>{buttonLabel}</Text>
      </TouchableOpacity>
      {secondaryPress && secondaryLabel ? (
        <TouchableOpacity style={styles.secondaryButton} onPress={secondaryPress}>
          <Text style={styles.secondaryButtonText}>{secondaryLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.spacing.xl,
    marginBottom: theme.spacing.md,
    borderWidth: 1.5,
    borderColor: theme.colors.primaryLight,
    ...theme.shadows.cardElevated,
  },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.sm,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    flexShrink: 1,
  },
  badge: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  badgePrimary: {
    backgroundColor: theme.colors.primaryLight,
  },
  badgePrimaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  badgeSuccess: {
    backgroundColor: theme.colors.successSoft,
  },
  badgeSuccessText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.successDark,
  },
  badgeWarning: {
    backgroundColor: theme.colors.warningSoft,
  },
  badgeWarningText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.warningDark,
  },
  description: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    lineHeight: 22,
    marginBottom: theme.spacing.sm,
  },
  secondaryInfo: {
    fontSize: 13,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.sm,
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
    ...theme.shadows.primary,
  },
  buttonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});
