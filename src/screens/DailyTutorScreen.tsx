import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/DailyTutorScreen.tsx
 *
 * Daily AI Tutor Loop — the session hub.
 *
 * This screen is a HUB, not a learning engine: it shows today's persisted
 * session (ordered activities with real statuses), launches the current
 * activity into its EXISTING screen, and applies the real completion
 * handshake results when it regains focus.
 *
 * HONESTY RULES
 * - Progress is count-based only ("2 of 4 activities complete"). No scores,
 *   percentages, XP, streaks, CEFR claims or invented improvement.
 * - The plan's reason is the planner's honest headline (real evidence).
 * - An activity is completed ONLY by the child workflow's real completion —
 *   navigating to a child never completes anything here.
 *
 * RACE GUARDS (synchronous refs, like Talk/DeepSpeaking screens)
 * - `loadTokenRef` + `unmountedRef`: stale async results never write state.
 * - `startingRef` / `skippingRef`: repeated Start/Skip taps are refused
 *   synchronously before any await.
 * - Completion inbox is drained on focus; applying is idempotent in the
 *   service, so double drains are harmless.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import {
  activityKindLabel,
  applyDrainedDailyTutorCompletions,
  buildDailyTutorSessionView,
} from '../daily-tutor';
import type { DailyTutorService } from '../daily-tutor';
import type { DailyTutorSession } from '../daily-tutor';
import { createDefaultDailyTutorService } from '../daily-tutor';

export interface DailyTutorScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: DailyTutorService;
  /** Override for the default composition (tests/embedding). */
  readonly loadService?: () => Promise<DailyTutorService>;
}

type ScreenPhase = 'loading' | 'ready' | 'no-profile' | 'unavailable';

const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  pending: 'Upcoming',
  in_progress: 'Current',
  completed: 'Done',
  skipped: 'Skipped',
};

export default function DailyTutorScreen(props?: DailyTutorScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const serviceRef = useRef<DailyTutorService | null>(props?.service ?? null);
  const [phase, setPhase] = useState<ScreenPhase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<DailyTutorSession | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  const unmountedRef = useRef<boolean>(false);
  /** Bumped for every async screen load: stale results are discarded. */
  const loadTokenRef = useRef<number>(0);
  const startingRef = useRef<boolean>(false);
  const skippingRef = useRef<boolean>(false);

  /** Ensure the shared service exists (injected or the app-wide factory). */
  const ensureService = useCallback(async (): Promise<DailyTutorService | null> => {
    if (serviceRef.current) return serviceRef.current;
    try {
      const service = await (props?.loadService ?? createDefaultDailyTutorService)();
      if (!unmountedRef.current) {
        serviceRef.current = service;
      }
      return service;
    } catch {
      return null;
    }
  }, [props?.loadService]);

  /**
   * Load (or resume) today's session, then apply any child completions that
   * were reported while this screen was away. One token per run so a stale
   * load can never overwrite a newer one.
   */
  const loadSession = useCallback(async (): Promise<void> => {
    const token = (loadTokenRef.current += 1);
    const service = await ensureService();
    if (!service || unmountedRef.current || loadTokenRef.current !== token) {
      if (!service && !unmountedRef.current && loadTokenRef.current === token) {
        setPhase('unavailable');
        setMessage(
          'Your daily practice could not be loaded right now. Nothing was changed.',
        );
      }
      return;
    }
    try {
      // Apply real child completions FIRST (they may finish the session),
      // then read today's session state. The helper is retry-safe: anything
      // that could not be applied stays queued for the next focus.
      await applyDrainedDailyTutorCompletions(service);
      const today = await service.getToday();
      if (unmountedRef.current || loadTokenRef.current !== token) return;
      if (today.status === 'ready') {
        setSession(today.session);
        setPhase('ready');
        setMessage(null);
        return;
      }
      setSession(null);
      setPhase(today.status === 'no-profile' ? 'no-profile' : 'unavailable');
      setMessage(today.message);
    } catch {
      if (unmountedRef.current || loadTokenRef.current !== token) return;
      setSession(null);
      setPhase('unavailable');
      setMessage('Your daily practice could not be loaded right now. Nothing was changed.');
    }
  }, [ensureService]);

  /**
   * Lifecycle guard: mark the screen unmounted on real unmount (pop from
   * the stack) so no stale async result can ever write state afterwards.
   * Pushing a child route on top of this screen does NOT unmount it — the
   * guard never cancels work merely because a child was opened; draining
   * and applying completions is safe either way because the completion
   * inbox is module-scoped, not component state.
   */
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadSession();
    }, [loadSession]),
  );

  /** Start/continue the current activity in its EXISTING screen. */
  const handleStartCurrent = useCallback(async (): Promise<void> => {
    // Synchronous guard: a double tap launches exactly one child activity.
    if (startingRef.current) return;
    const service = serviceRef.current;
    if (!service) return;
    startingRef.current = true;
    setIsBusy(true);
    try {
      const current = session?.activities.find(
        (activity) => activity.status === 'pending' || activity.status === 'in_progress',
      );
      if (!current) return;
      const started = await service.startActivity(current.id);
      // Real unmount during the await: no state write afterwards.
      if (started && !unmountedRef.current) {
        setSession(started);
      }
      const route = await service.getChildRoute(current.id);
      if (unmountedRef.current || !route) return;
      navigation.navigate(route.routeName, route.params);
    } catch {
      // Navigation/launch failure changes nothing; the learner can retry.
      if (!unmountedRef.current) setMessage('Could not open this activity. Try again; no practice was recorded.');
    } finally {
      startingRef.current = false;
      if (!unmountedRef.current) {
        setIsBusy(false);
      }
    }
  }, [navigation, session]);

  /** Skip the current activity (recorded as a skip — never as practice). */
  const handleSkipCurrent = useCallback(async (): Promise<void> => {
    // Synchronous guard: a double tap skips exactly once.
    if (skippingRef.current) return;
    const service = serviceRef.current;
    if (!service) return;
    const current = session?.activities.find(
      (activity) => activity.status === 'pending' || activity.status === 'in_progress',
    );
    if (!current) return;
    skippingRef.current = true;
    setIsBusy(true);
    try {
      const updated = await service.skipActivity(current.id);
      if (updated && !unmountedRef.current) {
        setSession(updated);
      }
    } catch {
      // A failed skip changes nothing.
      if (!unmountedRef.current) setMessage('Could not skip this activity. Your plan is unchanged. Try again.');
    } finally {
      skippingRef.current = false;
      if (!unmountedRef.current) {
        setIsBusy(false);
      }
    }
  }, [session]);

  if (phase === 'loading') {
    return (
      <View style={styles.centeredBox}>
        <ActivityIndicator />
        <Text style={styles.body}>Preparing today’s practice…</Text>
      </View>
    );
  }

  if (phase !== 'ready' || !session) {
    return (
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle}>Daily Tutor</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {phase === 'no-profile' ? 'Set up your learning plan first' : 'Daily practice unavailable'}
          </Text>
          <Text style={styles.body}>
            {message ??
              'Your daily practice could not be loaded right now. Nothing was changed.'}
          </Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void loadSession()}>
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </TouchableOpacity>
          {phase === 'no-profile' ? (
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => navigation.navigate('Onboarding')}
            >
              <Text style={styles.linkText}>Set up my learning plan</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
    );
  }

  const view = buildDailyTutorSessionView(session);
  const current = view.current;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.screenTitle}>Daily Tutor</Text>
      {message ? <Text accessibilityRole="alert" style={styles.body}>{message}</Text> : null}

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Your plan for today</Text>
          <View style={[styles.pill, view.isComplete ? styles.pillDone : styles.pillActive]}>
            <Text style={styles.pillText}>
              {view.isComplete ? 'Complete' : `${view.completedCount}/${view.total}`}
            </Text>
          </View>
        </View>
        <Text style={styles.headline}>{view.headline}</Text>
        <Text style={styles.sourceNote}>
          {view.total} activities · about {session.estimatedMinutes} minutes (estimate) · progress
          is counted, never scored.
        </Text>
        <Text style={styles.progressLine}>{view.progressLabel}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Activities</Text>
        {view.activities.map((activity, index) => {
          const isCurrent = current?.id === activity.id;
          return (
            <View
              key={activity.id}
              style={[styles.activityRow, isCurrent ? styles.activityRowCurrent : null]}
            >
              <Text style={styles.activityIndex}>{index + 1}.</Text>
              <View style={styles.activityBody}>
                <Text style={styles.activityTitle}>{activity.title}</Text>
                <Text style={styles.activityKind}>{activityKindLabel(activity.kind)}</Text>
                <Text style={styles.activityReason}>{activity.reason}</Text>
                {activity.status === 'completed' &&
                activity.practicedItems !== undefined &&
                activity.practicedItems > 0 ? (
                  <Text style={styles.activityDone}>
                    Completed — {activity.practicedItems}{' '}
                    {activity.practicedItems === 1 ? 'item' : 'items'} practised.
                  </Text>
                ) : null}
                {activity.status === 'skipped' ? (
                  <Text style={styles.activitySkipped}>Skipped — not counted as practice.</Text>
                ) : null}
              </View>
              <View style={styles.activityStatusPill}>
                <Text style={styles.activityStatusText}>
                  {ACTIVITY_STATUS_LABELS[activity.status] ?? 'Upcoming'}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {view.isComplete ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>What you did today</Text>
          {view.summaryLines.map((line) => (
            <Text key={line} style={styles.listLine}>
              • {line}
            </Text>
          ))}
          {view.skillsPractised.length > 0 ? (
            <Text style={styles.sourceNote}>
              Practised: {Array.from(new Set(view.skillsPractised)).join(', ')}.
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.card}>
          {current ? (
            <>
              <Text style={styles.sectionTitle}>Up next</Text>
              <Text style={styles.headline}>{current.title}</Text>
              <Text style={styles.activityReason}>{current.reason}</Text>
              <TouchableOpacity
                style={[styles.primaryButton, isBusy ? styles.primaryButtonDisabled : null]}
                disabled={isBusy}
                onPress={() => void handleStartCurrent()}
              >
                <Text style={styles.primaryButtonText}>
                  {current.status === 'in_progress' ? 'Continue activity' : 'Start activity'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.linkButton, isBusy ? styles.primaryButtonDisabled : null]}
                disabled={isBusy}
                onPress={() => void handleSkipCurrent()}
              >
                <Text style={styles.linkText}>Skip this activity</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingBottom: 32 },
  centeredBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  screenTitle: { fontSize: 20, fontWeight: '700', color: '#1c1c1e', marginBottom: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e6e9ef',
  },
  cardHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#1c1c1e' },
  headline: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },
  body: { fontSize: 14, color: '#3a3a3c', marginBottom: 8 },
  sourceNote: { fontSize: 13, color: '#6b6b70' },
  progressLine: { fontSize: 14, fontWeight: '600', color: '#0a7a3d', marginTop: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#8e8e93', marginBottom: 6 },
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  pill: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillActive: { backgroundColor: '#e3f2e6' },
  pillDone: { backgroundColor: '#e3f2e6' },
  pillText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f1f5',
    borderRadius: 6,
  },
  activityRowCurrent: { backgroundColor: '#f7faf8', paddingHorizontal: 8 },
  activityIndex: { fontSize: 14, color: '#8e8e93', marginRight: 8, marginTop: 2 },
  activityBody: { flex: 1 },
  activityTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e' },
  activityKind: { fontSize: 12, color: '#8e8e93', marginTop: 1 },
  activityReason: { fontSize: 13, color: '#6b6b70', marginTop: 2 },
  activityDone: { fontSize: 12, color: '#0a7a3d', marginTop: 4, fontWeight: '600' },
  activitySkipped: { fontSize: 12, color: '#8e8e93', marginTop: 4 },
  activityStatusPill: {
    backgroundColor: '#eef1f6',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    marginLeft: 8,
    marginTop: 2,
  },
  activityStatusText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  linkButton: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontSize: 13, color: '#6b6b70', textDecorationLine: 'underline' },
});
