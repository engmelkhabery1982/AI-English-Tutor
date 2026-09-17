/**
 * src/screens/HomeScreen.tsx
 *
 * Home — the "Today's Practice" entry point for the Adaptive Lessons Engine.
 *
 * This screen is an ENTRY POINT, not a dashboard:
 * - It asks the AdaptiveLessonService for today's plan and shows why the
 *   lesson looks the way it does (focus areas + planned structure).
 * - It states honestly where the content came from: personalized, partly
 *   personalized, or general practice when there is no stored evidence yet.
 * - It never shows scores, percentages, XP, streaks, badges or invented
 *   durations — only real step counts and real focus labels.
 * - It reflects REAL availability: no profile and load failures get their own
 *   honest states instead of a fake lesson.
 *
 * The screen never touches SQLite: it receives an injected service or awaits
 * the shared composition factory (the same instance the lesson screen uses,
 * which is what makes an unfinished lesson recoverable).
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import type { AdaptiveLessonService, AdaptiveTodayPractice } from '../adaptive-lessons';
import { createDefaultAdaptiveLessonService } from '../adaptive-lessons';
import type { OnboardingPrefill, OnboardingService } from '../onboarding';
import { createDefaultOnboardingService } from '../onboarding';

export interface HomeScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: AdaptiveLessonService;
  /** Injectable onboarding service (tests/composition); defaults to the real factory. */
  readonly onboardingService?: OnboardingService;
}

const SOURCE_LABELS: Record<AdaptiveTodayPractice['status'], string> = {
  ready: '',
  'no-profile': 'No profile yet',
  unavailable: 'Unavailable right now',
};

export default function HomeScreen(props?: HomeScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const serviceRef = useRef<AdaptiveLessonService | null>(props?.service ?? null);
  const [practice, setPractice] = useState<AdaptiveTodayPractice | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Onboarding entry point: the EXISTING profile tells Home whether a learning
   * plan still needs to be set up. Read-only — nothing is written from Home.
   */
  const onboardingRef = useRef<OnboardingService | null>(props?.onboardingService ?? null);
  const [prefill, setPrefill] = useState<OnboardingPrefill | null>(null);
  const loadProfileState = useCallback(async () => {
    try {
      if (!onboardingRef.current) {
        onboardingRef.current = await createDefaultOnboardingService();
      }
      const state = await onboardingRef.current.loadPrefill();
      setPrefill(state);
    } catch {
      // The adaptive plan already reports profile problems honestly; Home keeps
      // its onboarding card hidden rather than inventing profile state.
      setPrefill(null);
    }
  }, []);

  const loadPractice = useCallback(async () => {
    try {
      if (!serviceRef.current) {
        serviceRef.current = await createDefaultAdaptiveLessonService();
      }
      setLoadError(null);
      const today = await serviceRef.current.getTodayPractice();
      setPractice(today);
    } catch {
      // Keep any previously loaded plan visible; never fabricate a replacement.
      setLoadError('Could not load your practice for today. Nothing was changed.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadPractice();
      void loadProfileState();
    }, [loadPractice, loadProfileState]),
  );

  const openOnboarding = () => {
    navigation.navigate('Onboarding');
  };

  const openLesson = () => {
    navigation.navigate('AdaptiveLesson');
  };

  /**
   * Speaking practice entry: a voice-first session with the Deep Speaking coach.
   * Home stays an entry point — it never builds the plan or the conversation
   * itself, and it makes no claim about the learner's speaking level.
   */
  const openSpeakingPractice = () => {
    navigation.navigate('DeepSpeaking');
  };

  const renderReady = (today: Extract<AdaptiveTodayPractice, { status: 'ready' }>) => {
    const plan = today.plan;
    const modeLabel =
      plan.sourceMode === 'personalized'
        ? 'Personalized'
        : plan.sourceMode === 'mixed'
          ? 'Partly personalized'
          : 'General practice';

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Today&apos;s Practice</Text>
          <View style={[styles.pill, plan.sourceMode === 'general' ? styles.pillGeneral : styles.pillPersonal]}>
            <Text style={styles.pillText}>{modeLabel}</Text>
          </View>
        </View>

        <Text style={styles.headline}>{today.headline}</Text>
        <Text style={styles.sourceNote}>{plan.sourceNote}</Text>

        {today.resume ? (
          <Text style={styles.resumeLine}>
            ▶ You have an unfinished lesson — step {today.resume.stepNumber} of{' '}
            {today.resume.totalSteps}.
          </Text>
        ) : null}

        {today.focusLines.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Focus</Text>
            {today.focusLines.slice(0, 4).map((line) => (
              <Text key={line} style={styles.listLine}>
                • {line}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Planned structure</Text>
          {today.structureLines.map((line) => (
            <Text key={line} style={styles.listLine}>
              {line}
            </Text>
          ))}
          <Text style={styles.sizeNote}>
            {today.sizeLabel === 'short' ? 'Short lesson' : 'Standard lesson'} · {today.stepCount} steps
          </Text>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={openLesson}>
          <Text style={styles.primaryButtonText}>
            {today.resume ? 'Continue lesson' : 'Start lesson'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderNotReady = (today: Exclude<AdaptiveTodayPractice, { status: 'ready' }>) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Today&apos;s Practice</Text>
        <View style={styles.pill}>
          <Text style={styles.pillText}>{SOURCE_LABELS[today.status]}</Text>
        </View>
      </View>
      <Text style={styles.body}>{today.message}</Text>
      <TouchableOpacity style={styles.secondaryButton} onPress={() => void loadPractice()}>
        <Text style={styles.secondaryButtonText}>Check again</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.linkButton} onPress={() => navigation.navigate('Talk')}>
        <Text style={styles.linkText}>Open Talk to start building your history</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>AI English Tutor</Text>
      <Text style={styles.subtitle}>
        One lesson at a time, chosen from your own practice history.
      </Text>

      {prefill && !prefill.isComplete ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Set up your learning plan</Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>New</Text>
            </View>
          </View>
          <Text style={styles.body}>
            A few questions and a short diagnostic so your practice is built around your goals and
            your real level.
          </Text>
          <Text style={styles.sourceNote}>Still missing: {prefill.missingFields.join(', ')}</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={openOnboarding}>
            <Text style={styles.primaryButtonText}>Start onboarding</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {prefill && prefill.isComplete ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Your learning plan</Text>
            <View style={styles.pillPersonal}>
              <Text style={styles.pillText}>{prefill.currentLevel}</Text>
            </View>
          </View>
          <Text style={styles.body}>
            Target: {prefill.targetLevel} · {prefill.learningGoals.slice(0, 2).join(', ')}
          </Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={openOnboarding}
          >
            <Text style={styles.secondaryButtonText}>Assess my English again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Speaking practice</Text>
          <View style={styles.pill}>
            <Text style={styles.pillText}>Voice</Text>
          </View>
        </View>
        <Text style={styles.body}>
          A longer, voice-first conversation with a speaking coach, built from your own practice
          history. You can stop at any time.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={openSpeakingPractice}>
          <Text style={styles.primaryButtonText}>Start speaking practice</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator />
          <Text style={styles.body}>Preparing today&apos;s practice…</Text>
        </View>
      ) : null}

      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      {!isLoading && practice ? (
        practice.status === 'ready' ? renderReady(practice) : renderNotReady(practice)
      ) : null}

      {!isLoading && !practice && !loadError ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Today&apos;s Practice</Text>
          <Text style={styles.body}>
            Your lesson could not be prepared yet. Nothing was changed.
          </Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void loadPractice()}>
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '700', color: '#1c1c1e', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6b6b70', marginBottom: 16 },
  loadingBox: { paddingVertical: 24, gap: 10, alignItems: 'center' },
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
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#1c1c1e' },
  headline: { fontSize: 15, color: '#1c1c1e', marginBottom: 4 },
  body: { fontSize: 14, color: '#3a3a3c', marginBottom: 8 },
  sourceNote: { fontSize: 13, color: '#6b6b70' },
  resumeLine: { fontSize: 13, color: '#0a7a3d', marginTop: 8, fontWeight: '600' },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#8e8e93', marginBottom: 6 },
  listLine: { fontSize: 14, color: '#3a3a3c', marginBottom: 4 },
  sizeNote: { fontSize: 12, color: '#8e8e93', marginTop: 6 },
  errorText: { fontSize: 13, color: '#b00020', marginBottom: 8 },
  pill: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillPersonal: { backgroundColor: '#e3f2e6' },
  pillGeneral: { backgroundColor: '#f1f1f4' },
  pillText: { fontSize: 12, color: '#3a3a3c', fontWeight: '600' },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
  linkButton: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontSize: 13, color: '#6b6b70', textDecorationLine: 'underline' },
});
