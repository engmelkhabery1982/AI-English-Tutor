import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import TouchableOpacity from '../LearnerButton';
import { theme } from './theme';

interface PracticeCardProps {
  readonly title: string;
  readonly description: string;
  readonly onPress: () => void;
  readonly icon?: string;
  readonly badge?: string;
  readonly testID?: string;
}

export function PracticeCard({
  title,
  description,
  onPress,
  icon,
  badge,
  testID,
}: PracticeCardProps) {
  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={description}
      testID={testID}
    >
      {icon ? <Text style={styles.icon}>{icon}</Text> : null}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          {badge ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.description}>{description}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    ...theme.shadows.card,
  },
  icon: {
    fontSize: 22,
    marginRight: theme.spacing.md,
  },
  body: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  badge: {
    backgroundColor: theme.colors.primaryLight,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  description: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 19,
  },
  chevron: {
    fontSize: 24,
    color: theme.colors.neutral[300],
    marginLeft: theme.spacing.sm,
  },
});
