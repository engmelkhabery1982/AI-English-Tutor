import type { LearnerStrength } from '../domain/models/learner';
import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/ProgressScreen.tsx
 *
 * Real Progress Dashboard.
 *
 * A mobile-first, read-only dashboard over the learner's persisted data:
 * count-based overview, learning status from the authoritative
 * meaning.review buckets, weakness lifecycle groups, review status with a
 * "Review now" action into the existing Review flow, a merged recent
 * activity timeline, honest count-based trends, and recent progress
 * records (count fields only — legacy numeric skill-score fields are
 * never promoted into the UI).
 *
 * Composition lives behind the progress-dashboard factory: this screen
 * imports no database types, instantiates no adapters, executes no SQL,
 * and never fabricates learner ids.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import { theme } from './components/ui/theme';
import {
  createDefaultProgressDashboardService,
  DEFAULT_WINDOW,
  resolveReviewNowAction,
  WINDOW_LABELS,
  type DashboardWindow,
  type ProgressDashboardService,
  type ProgressDashboardSnapshot,
} from '../progress-dashboard';

interface ProgressScreenProps {
  /** Injectable composition (defaults to the real local-database composition). */
  readonly service?: ProgressDashboardService;
}

const WINDOW_OPTIONS: readonly DashboardWindow[] = ['7d', '30d', 'all'];

const TYPE_LABELS: Record<string, string> = {
  grammar: 'Grammar',
  pronunciation: 'Pronunciation',
  vocabulary: 'Vocabulary',
  listening: 'Listening',
  fluency: 'Fluency',
  natural_expression: 'Natural expression',
  confidence: 'Confidence',
};

const GROUP_BADGE_STYLES: Record<string, ViewStyle> = {};

const ACTIVITY_ICONS: Record<string, string> = {
  session: '💬',
  vocabulary: '📖',
  expression: '🗣️',
  weakness: '🧩',
  review: '🔁',
  progress: '📈',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ProgressScreen(props?: ProgressScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  const [strengths, setStrengths] = useState<readonly LearnerStrength[] | null>(null);
  const [strengthsError, setStrengthsError] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasNoProfile, setHasNoProfile] = useState<boolean>(false);
  const [snapshot, setSnapshot] = useState<ProgressDashboardSnapshot | null>(null);
  const [window, setWindow] = useState<DashboardWindow>(DEFAULT_WINDOW);

  const serviceRef = useRef<ProgressDashboardService | null>(props?.service ?? null);
  const initialLoadDoneRef = useRef<boolean>(false);

  useEffect(() => {
    let active = true;

    async function init() {
      if (serviceRef.current) {
        await loadDashboard(false);
        return;
      }
      try {
        // Composition (adapter bootstrap, repositories) lives behind the
        // dashboard factory — the screen owns no database state.
        const service = await createDefaultProgressDashboardService();
        if (!active) return;
        serviceRef.current = service;

        if (active) {
          await loadDashboard(false);
        }
      } catch (err) {
        console.error('Failed to initialize Progress dashboard:', err);
        if (active) {
          setLoadError('Local storage unavailable. Could not open your progress dashboard.');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      active = false;
    };
  }, []);

  // Refresh whenever the tab gains focus so changes from Talk, Review,
  // and the Vocabulary Workspace appear automatically.
  useFocusEffect(
    useCallback(() => {
      if (initialLoadDoneRef.current && serviceRef.current) {
        loadDashboard(true);
      }
    }, []),
  );

  const loadDashboard = async (quiet: boolean, selectedWindow: DashboardWindow = window) => {
    try {
      if (!serviceRef.current) serviceRef.current = await createDefaultProgressDashboardService();
      const service = serviceRef.current;
      if (quiet) {
        initialLoadDoneRef.current = true;
      } else {
        setLoading(true);
      }
      setLoadError(null);

      const learnerId = await service.getActiveLearnerId();
      if (!learnerId) {
        setHasNoProfile(true);
        setSnapshot(null);
        setLoading(false);
        initialLoadDoneRef.current = true;
        return;
      }
      setHasNoProfile(false);

      const nextSnapshot = await service.loadDashboard(learnerId, { window: selectedWindow });
      setSnapshot(nextSnapshot);
      try {
        setStrengths(await service.loadStrengths(learnerId));
        setStrengthsError(false);
      } catch {
        setStrengths(null);
        setStrengthsError(true);
      }
    } catch (err) {
      console.error('Error loading progress dashboard:', err);
      // Keep any previously loaded data visible; never fabricate replacements.
      setLoadError('Could not load your progress. Nothing was changed.');
    } finally {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  };

  const handleSelectWindow = (next: DashboardWindow) => {
    setWindow(next);
    loadDashboard(true, next);
  };

  const handleRetry = () => {
    loadDashboard(false);
  };

  const handleReviewNow = () => {
    // Reuse the EXISTING Review flow (Review tab). This dashboard stays
    // read-only: navigating marks nothing as reviewed.
    navigation.navigate('Review');
  };

  // ---------- SECTION RENDERERS ----------

  const renderSectionTitle = (title: string) => (
    <Text style={styles.sectionTitle}>{title}</Text>
  );

  const renderOverview = () => {
    const { overview, aggregatesExact } = snapshot!;
    const cards: { value: number; label: string }[] = [
      { value: overview.sessionsCompleted, label: 'Sessions completed' },
      { value: overview.conversationTurns, label: 'Conversation turns' },
      { value: overview.vocabularySaved, label: 'Words saved' },
      { value: overview.expressionsSaved, label: 'Expressions saved' },
      { value: overview.reviewsDue, label: 'Reviews due' },
      { value: overview.activeWeaknesses, label: 'Areas to practise' },
    ];
    return (
      <View style={styles.card}>
        <View style={styles.overviewGrid}>
          {cards.map((card) => (
            <View key={card.label} style={styles.overviewCell}>
              <Text style={styles.overviewValue}>{card.value}</Text>
              <Text style={styles.overviewLabel}>{card.label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.allTimeNote}>
          {aggregatesExact
            ? 'All-time totals from your saved learning data'
            : 'Totals from your most recent saved learning data'}
        </Text>
      </View>
    );
  };

  const renderLearningStatus = () => {
    const { vocabularyStatus, expressionStatus } = snapshot!;
    const rows = [
      { label: 'Vocabulary', status: vocabularyStatus },
      { label: 'Expressions', status: expressionStatus },
    ];
    return (
      <View style={styles.card}>
        {rows.map((row) => (
          <View key={row.label} style={styles.lexicalRow}>
            <Text style={styles.lexicalLabel}>{row.label}</Text>
            <View style={styles.lexicalCounts}>
              <Text style={[styles.lexicalCount, styles.countDue]}>Due {row.status.due}</Text>
              <Text style={[styles.lexicalCount, styles.countLearning]}>
                Learning {row.status.learning}
              </Text>
              <Text style={[styles.lexicalCount, styles.countFamiliar]}>
                Familiar {row.status.familiar}
              </Text>
              <Text style={[styles.lexicalCount, styles.countMastered]}>
                Mastered {row.status.mastered}
              </Text>
            </View>
          </View>
        ))}
        <Text style={styles.cardFootnote}>
          {vocabularyStatus.total + expressionStatus.total === 0
            ? 'No vocabulary or expressions saved yet.'
            : 'From your saved words and expressions'}
        </Text>
      </View>
    );
  };

  const renderReviewStatus = () => {
    const { reviewStatus } = snapshot!;
    const action = resolveReviewNowAction(reviewStatus);
    return (
      <View style={styles.card}>
        {reviewStatus.dueCount > 0 ? (
          <Text style={styles.reviewDueLine}>
            🔁 {reviewStatus.dueCount} {reviewStatus.dueCount === 1 ? 'review' : 'reviews'} due now
          </Text>
        ) : (
          <Text style={styles.reviewCaughtUp}>✓ No reviews due right now.</Text>
        )}

        {reviewStatus.upcoming.length > 0 && (
          <View style={styles.subList}>
            {reviewStatus.upcoming.map((item) => (
              <View key={item.id} style={styles.subRow}>
                <Text style={styles.subRowMain} numberOfLines={1}>
                  {item.prompt}
                </Text>
                <Text style={styles.subRowMeta}>due {formatDate(item.dueAt)}</Text>
              </View>
            ))}
          </View>
        )}

        {reviewStatus.recentlyReviewed.length > 0 && (
          <View style={styles.subList}>
            <Text style={styles.subListTitle}>Recently reviewed</Text>
            {reviewStatus.recentlyReviewed.map((item) => (
              <View key={item.id} style={styles.subRow}>
                <Text style={styles.subRowMain} numberOfLines={1}>
                  {item.kind} · {item.lastResult ? item.lastResult : 'reviewed'}
                </Text>
                <Text style={styles.subRowMeta}>{formatDate(item.lastReviewAt)}</Text>
              </View>
            ))}
          </View>
        )}

        {action === 'navigate-review' ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleReviewNow}
            accessibilityRole="button"
            id="review_now_button"
          >
            <Text style={styles.primaryButtonText}>Review now</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.caughtUpBox} id="review_caught_up_box">
            <Text style={styles.caughtUpText}>You're caught up. 🎉</Text>
          </View>
        )}
      </View>
    );
  };

  const renderWeaknesses = () => {
    const { weaknessGroups, weaknessCards } = snapshot!;
    const total = weaknessCards.length;
    return (
      <View style={styles.card}>
        {total === 0 ? (
          <Text style={styles.emptyInlineText}>No active weaknesses recorded.</Text>
        ) : (
          <>
            <View style={styles.groupRow}>
              {weaknessGroups.map((group) => (
                <View
                  key={group.group}
                  style={[
                    styles.groupBadge,
                    GROUP_BADGE_STYLES[group.group],
                    group.count === 0 && styles.groupBadgeEmpty,
                  ]}
                >
                  <Text style={styles.groupBadgeText}>
                    {group.label}: {group.count}
                  </Text>
                </View>
              ))}
            </View>
            {weaknessCards.map((card) => (
              <View key={card.id} style={styles.weaknessCard}>
                <View style={styles.weaknessHeader}>
                  <Text style={styles.weaknessType}>{TYPE_LABELS[card.type] ?? card.type}</Text>
                  <Text style={styles.weaknessStatus}>{card.status.replace('_', ' ')}</Text>
                </View>
                {!!card.notes && <Text style={styles.weaknessNotes}>{card.notes}</Text>}
                <Text style={styles.weaknessMeta}>
                  Seen {card.occurrenceCount} {card.occurrenceCount === 1 ? 'time' : 'times'} ·
                  last {formatDate(card.lastSeenAt)}
                </Text>
                {card.latestEvidence?.summary && (
                  <Text style={styles.weaknessEvidence} numberOfLines={2}>
                    {card.latestEvidence.summary}
                  </Text>
                )}
              </View>
            ))}
          </>
        )}
      </View>
    );
  };

  const renderRecentActivity = () => {
    const { recentActivity } = snapshot!;
    if (recentActivity.length === 0) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyInlineText}>
            No learning activity in this period yet. Keep talking with your tutor and your progress
            will appear here.
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.card}>
        {recentActivity.map((event) => (
          <View key={event.id} style={styles.activityRow}>
            <Text style={styles.activityIcon}>{ACTIVITY_ICONS[event.kind] ?? '•'}</Text>
            <View style={styles.activityBody}>
              <Text style={styles.activityTitle}>{event.title}</Text>
              {!!event.detail && <Text style={styles.activityDetail}>{event.detail}</Text>}
            </View>
            <Text style={styles.activityTime}>{formatDateTime(event.at)}</Text>
          </View>
        ))}
      </View>
    );
  };

  const renderTrends = () => {
    const { trends } = snapshot!;
    const totalInTrends = trends.reduce((sum, bucket) => sum + bucket.total, 0);
    if (totalInTrends === 0) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyInlineText}>
            No activity trend data for this period yet.
          </Text>
        </View>
      );
    }
    const max = Math.max(...trends.map((bucket) => bucket.total));
    return (
      <View style={styles.card}>
        {trends.map((bucket) => (
          <View key={bucket.label + bucket.rangeStart} style={styles.trendRow}>
            <Text style={styles.trendLabel}>{bucket.label}</Text>
            <View style={styles.trendBarTrack}>
              <View
                style={[styles.trendBarFill, { width: `${Math.round((bucket.total / max) * 100)}%` }]}
              />
            </View>
            <Text style={styles.trendValue}>{bucket.total}</Text>
          </View>
        ))}
        <Text style={styles.cardFootnote}>
          Activity counts only (sessions · saved words & expressions · reviews). Activity volume is
          not a measure of improvement — see learning status and weakness states for that.
        </Text>
      </View>
    );
  };

  const renderRecentProgress = () => {
    const { recentProgress } = snapshot!;
    if (recentProgress.length === 0) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyInlineText}>No progress records yet.</Text>
        </View>
      );
    }
    return (
      <View style={styles.card}>
        {recentProgress.map((record) => (
          <View key={record.recordedAt} style={styles.progressRow}>
            <Text style={styles.progressDate}>{formatDate(record.recordedAt)}</Text>
            <Text style={styles.progressCounts}>
              {record.sessionsCompleted} sessions · {record.turnsCompleted} turns ·{' '}
              {record.newWordsLearned} new words
              {record.weaknessesImproved > 0 ? ` · ${record.weaknessesImproved} weaknesses improved` : ''}
              {record.weaknessesWorsened > 0 ? ` · ${record.weaknessesWorsened} needing work` : ''}
            </Text>
            {!!record.notes && <Text style={styles.progressNotes}>{record.notes}</Text>}
          </View>
        ))}
      </View>
    );
  };

  const renderWindowSelector = () => (
    <View style={styles.windowRow}>
      {WINDOW_OPTIONS.map((option) => (
        <TouchableOpacity
          key={option}
          style={[styles.windowChip, window === option && styles.windowChipActive]}
          onPress={() => handleSelectWindow(option)}
          accessibilityRole="button"
        >
          <Text style={[styles.windowChipText, window === option && styles.windowChipTextActive]}>
            {WINDOW_LABELS[option]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const renderNoProfile = () => (
    <View style={styles.emptyCard} id="no_profile_state">
      <Text style={styles.emptyCardEmoji}>👤</Text>
      <Text style={styles.emptyCardTitle}>No learner profile yet</Text>
      <Text style={styles.emptyCardText}>
        Start a conversation in Talk — your progress will appear here automatically.
      </Text>
    </View>
  );

  const renderEmptyDashboard = () => (
    <View style={styles.emptyCard} id="empty_dashboard_state">
      <Text style={styles.emptyCardEmoji}>📊</Text>
      <Text style={styles.emptyCardTitle}>No learning activity yet</Text>
      <Text style={styles.emptyCardText}>
        Keep talking with your tutor and your progress will appear here.
      </Text>
    </View>
  );

  const isEmptyDashboard = (snap: ProgressDashboardSnapshot): boolean =>
    snap.overview.sessionsCompleted === 0 &&
    snap.overview.conversationTurns === 0 &&
    snap.overview.vocabularySaved === 0 &&
    snap.overview.expressionsSaved === 0 &&
    snap.overview.activeWeaknesses === 0 &&
    snap.recentActivity.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} id="progress_title">
          Progress
        </Text>
        <Text style={styles.subtitle}>What you've actually been doing</Text>
      </View>

      {loading && !snapshot ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingText}>Loading your progress...</Text>
        </View>
      ) : hasNoProfile ? (
        renderNoProfile()
      ) : loadError && !snapshot ? (
        <View style={styles.errorContainer} id="load_error_state">
          <Text style={styles.errorText}>⚠️ {loadError}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={handleRetry}
            accessibilityRole="button"
            id="retry_load_button"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : snapshot ? (
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Your English level</Text>
            <Text style={styles.emptyInlineText}>After some practice, take a new assessment to compare what has changed. Your working level changes only when you accept it.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.navigate('Reassessment')}
              accessibilityLabel="Check my English level again">
              <Text style={styles.primaryButtonText}>Check my English level again</Text>
            </TouchableOpacity>
          </View>
          {renderWindowSelector()}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Demonstrated strengths</Text>
            <Text style={styles.emptyInlineText}>Based on saved successful practice, across your learning history — not a score or a level.</Text>
            {strengthsError ? <Text accessibilityRole="alert">Could not load strengths. Try refreshing your progress.</Text>
              : strengths === null ? <Text>Strength information is unavailable.</Text>
              : strengths.length === 0 ? <Text>No strengths recorded yet. Successfully evaluated practice can create these records over time.</Text>
              : strengths.map(strength => <View key={strength.id} style={styles.progressRow}>
                <Text style={styles.progressDate}>{strength.type.replace(/_/g, ' ')} · demonstrated in practice</Text>
                {strength.notes ? <Text style={styles.progressNotes}>{strength.notes}</Text> : null}
                {strength.contexts.length ? <Text style={styles.progressCounts}>{strength.contexts.join(' · ')}</Text> : null}
                <Text style={styles.progressNotes}>Last observed: {formatDate(strength.lastSeenAt)}</Text>
              </View>)}
          </View>

          {loadError && (
            <View style={styles.inlineErrorBanner} id="refresh_error_banner">
              <Text style={styles.errorText}>⚠️ {loadError}</Text>
            </View>
          )}

          {isEmptyDashboard(snapshot) ? (
            renderEmptyDashboard()
          ) : (
            <>
              {renderSectionTitle('Overview')}
              {renderOverview()}

              {renderSectionTitle('Learning status')}
              {renderLearningStatus()}

              {renderSectionTitle('Review')}
              {renderReviewStatus()}

              {renderSectionTitle('Areas being trained')}
              {renderWeaknesses()}

              {renderSectionTitle(
                snapshot.window === 'all' ? 'Recent activity (all time)' : `Recent activity (${WINDOW_LABELS[snapshot.window].toLowerCase()})`,
              )}
              {renderRecentActivity()}

              {renderSectionTitle('Activity trend')}
              {renderTrends()}

              {renderSectionTitle('Progress records')}
              {renderRecentProgress()}
            </>
          )}

          {loading && (
            <View style={styles.refreshingRow}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.refreshingText}>Refreshing…</Text>
            </View>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderLight,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: theme.colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: 4,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#B91C1C',
    textAlign: 'center',
    marginBottom: 12,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  inlineErrorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  windowRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginBottom: 14,
    gap: 8,
  },
  windowChip: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  windowChipActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  windowChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  windowChipTextActive: {
    color: '#FFFFFF',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 6,
    marginBottom: 8,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    ...theme.shadows.card,
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  overviewCell: {
    width: '33.33%',
    alignItems: 'center',
    paddingVertical: 8,
  },
  overviewValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
  },
  overviewLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    fontWeight: '600',
    textAlign: 'center',
  },
  allTimeNote: {
    marginTop: 6,
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  lexicalRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  lexicalLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  lexicalCounts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  lexicalCount: {
    fontSize: 12,
    fontWeight: '700',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
    color: '#374151',
  },
  countDue: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
  },
  countLearning: {
    backgroundColor: '#EFF6FF',
    color: '#1E40AF',
  },
  countFamiliar: {
    backgroundColor: '#FEF3C7',
    color: '#92400E',
  },
  countMastered: {
    backgroundColor: '#D1FAE5',
    color: '#065F46',
  },
  cardFootnote: {
    marginTop: 8,
    fontSize: 12,
    color: '#9CA3AF',
  },
  reviewDueLine: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  reviewCaughtUp: {
    fontSize: 13,
    color: '#065F46',
    fontWeight: '600',
  },
  subList: {
    marginTop: 10,
  },
  subListTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  subRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  subRowMain: {
    fontSize: 12,
    color: '#374151',
    flexShrink: 1,
    marginRight: 8,
  },
  subRowMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  primaryButton: {
    marginTop: 12,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  caughtUpBox: {
    marginTop: 12,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
  },
  caughtUpText: {
    color: '#065F46',
    fontSize: 13,
    fontWeight: '600',
  },
  groupRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  groupBadge: {
    backgroundColor: '#EEF2FF',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  groupBadgeEmpty: {
    opacity: 0.5,
  },
  groupBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#3730A3',
  },
  weaknessCard: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 10,
  },
  weaknessHeader: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  weaknessType: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  weaknessStatus: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1E40AF',
    textTransform: 'uppercase',
  },
  weaknessNotes: {
    marginTop: 4,
    fontSize: 12,
    color: '#374151',
  },
  weaknessMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#9CA3AF',
  },
  weaknessEvidence: {
    marginTop: 4,
    fontSize: 12,
    color: '#6B7280',
    fontStyle: 'italic',
  },
  emptyInlineText: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  activityRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  activityIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  activityBody: {
    flex: 1,
  },
  activityTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  activityDetail: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 1,
  },
  activityTime: {
    fontSize: 12,
    color: '#9CA3AF',
    marginLeft: 8,
  },
  trendRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'center',
    paddingVertical: 4,
  },
  trendLabel: {
    width: 64,
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  trendBarTrack: {
    flex: 1,
    height: 10,
    backgroundColor: '#F3F4F6',
    borderRadius: 5,
    overflow: 'hidden',
  },
  trendBarFill: {
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 5,
  },
  trendValue: {
    width: 28,
    fontSize: 12,
    color: '#374151',
    fontWeight: '700',
    textAlign: 'right',
  },
  progressRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  progressDate: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  progressCounts: {
    marginTop: 2,
    fontSize: 12,
    color: '#374151',
  },
  progressNotes: {
    marginTop: 2,
    fontSize: 12,
    color: '#6B7280',
    fontStyle: 'italic',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginTop: 20,
    marginHorizontal: 20,
  },
  emptyCardEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  emptyCardText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
  },
  refreshingRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  refreshingText: {
    fontSize: 12,
    color: '#6B7280',
  },
});

// Weakness presentation-group badge variants (grouped by lifecycle).
GROUP_BADGE_STYLES.needs_attention = styles.groupBadge;
GROUP_BADGE_STYLES.improving = styles.groupBadge;
GROUP_BADGE_STYLES.stable_mastered = styles.groupBadge;
GROUP_BADGE_STYLES.relapsed = styles.groupBadge;
