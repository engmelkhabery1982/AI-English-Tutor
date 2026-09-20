import TouchableOpacity from './components/LearnerButton';
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
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import { PRACTICE_LINKS } from '../navigation/learner-journey';

import type { AdaptiveLessonService, AdaptiveTodayPractice } from '../adaptive-lessons';
import { createDefaultAdaptiveLessonService } from '../adaptive-lessons';
import type { OnboardingPrefill, OnboardingService } from '../onboarding';
import { createDefaultOnboardingService } from '../onboarding';
import type { DailyTutorHomeCard, DailyTutorService } from '../daily-tutor';
import { buildDailyTutorHomeCard, createDefaultDailyTutorService } from '../daily-tutor';

export interface HomeScreenProps {
  /** Injectable service (tests/composition); defaults to the real factory. */
  readonly service?: AdaptiveLessonService;
  /** Injectable onboarding service (tests/composition); defaults to the real factory. */
  readonly onboardingService?: OnboardingService;
  /** Injectable Daily Tutor service (tests/composition); defaults to the real factory. */
  readonly dailyTutorService?: DailyTutorService;
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

  /**
   * DAILY TUTOR — the primary recommended action on Home. Loading is a
   * local, deterministic repository read (plus a bounded learner-model
   * refresh only when today's plan does not exist yet): no AI calls happen
   * merely to render this card.
   */
  const dailyTutorRef = useRef<DailyTutorService | null>(props?.dailyTutorService ?? null);
  const [dailyCard, setDailyCard] = useState<DailyTutorHomeCard | null>(null);
  const [dailyUnavailable, setDailyUnavailable] = useState<string | null>(null);
  const loadDailyTutor = useCallback(async () => {
    try {
      if (!dailyTutorRef.current) {
        dailyTutorRef.current = await createDefaultDailyTutorService();
      }
      const today = await dailyTutorRef.current.getToday();
      if (today.status === 'ready') {
        setDailyCard(buildDailyTutorHomeCard(today.session));
        setDailyUnavailable(null);
        return;
      }
      // Honest states only: no fabricated card, no invented session.
      setDailyCard(null);
      setDailyUnavailable(today.message);
    } catch {
      // Keep any previously loaded card; never fabricate a replacement.
      setDailyUnavailable(
        'Your daily practice could not be loaded right now. Nothing was changed.',
      );
    }
  }, []);

  const openDailyTutor = () => {
    navigation.navigate('DailyTutor');
  };

  useFocusEffect(
    useCallback(() => {
      void loadDailyTutor();
      void loadPractice();
      void loadProfileState();
    }, [loadDailyTutor, loadPractice, loadProfileState]),
  );

  const openOnboarding = () => {
    navigation.navigate('Onboarding');
  };

  const openLesson = () => {
    navigation.navigate('AdaptiveLesson');
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
          <Text style={styles.cardTitle}>Adaptive lesson</Text>
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

        <TouchableOpacity style={styles.secondaryButton} onPress={openLesson}>
          <Text style={styles.secondaryButtonText}>
            {today.resume ? 'Continue adaptive lesson' : 'Open adaptive lesson'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderNotReady = (today: Exclude<AdaptiveTodayPractice, { status: 'ready' }>) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Adaptive lesson</Text>
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
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>AI English Tutor</Text>
      <Text style={styles.subtitle}>
        Start with Daily Tutor for your guided daily practice. Or choose a specific skill below.
      </Text>

      {!dailyCard && !dailyUnavailable ? <Text accessibilityLiveRegion="polite">Loading Daily Tutor…</Text> : null}
      {dailyCard && dailyUnavailable ? <Text accessibilityRole="alert">{dailyUnavailable} Showing the last loaded plan.</Text> : null}
      {dailyCard ? (
        <View style={[styles.card, styles.dailyCard]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Daily Tutor</Text>
            <View style={[styles.pill, dailyCard.state === 'completed' ? styles.pillPersonal : null]}>
              <Text style={styles.pillText}>
                {dailyCard.state === 'new'
                  ? 'Ready'
                  : dailyCard.state === 'in_progress'
                    ? 'In progress'
                    : 'Done'}
              </Text>
            </View>
          </View>
          <Text style={styles.headline}>{dailyCard.headline}</Text>
          <Text style={styles.sourceNote}>
            {dailyCard.progressLabel} · built from your own practice history, planned locally.
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={openDailyTutor}>
            <Text style={styles.primaryButtonText}>{dailyCard.buttonLabel}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!dailyCard && dailyUnavailable ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Daily Tutor</Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>Not ready</Text>
            </View>
          </View>
          <Text style={styles.body}>{dailyUnavailable}</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void loadDailyTutor()}>
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Practise and review</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.navigate('LearningTools')} accessibilityLabel="Language inspector, stories and next practice">
          <Text style={styles.secondaryButtonText}>Learning tools · Inspect, read, listen and read aloud</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.navigate('Talk')}
          accessibilityLabel="Talk — open conversation" accessibilityHint="Speak or type to your tutor">
          <Text style={styles.secondaryButtonText}>Talk · Open conversation</Text>
        </TouchableOpacity>
        <Text style={styles.body}>Speak freely with your tutor, or type your answer.</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.navigate('Review')}
          accessibilityLabel="Review — revisit what is due">
          <Text style={styles.secondaryButtonText}>Review · Revisit what is due</Text>
        </TouchableOpacity>
        <Text style={styles.body}>Recall saved language and practise areas that need attention.</Text>
      </View>

      {prefill && !prefill.isComplete ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Set up your learning plan</Text>
          <Text style={styles.body}>Choose your goals and take a short English assessment.</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={openOnboarding}>
            <Text style={styles.secondaryButtonText}>Assess my English</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Choose a skill</Text>
        {PRACTICE_LINKS.map((link) => (
          <TouchableOpacity key={link.route} style={styles.practiceLink}
            onPress={() => navigation.navigate(link.route)} accessibilityLabel={link.title}
            accessibilityHint={link.description}>
            <Text style={styles.secondaryButtonText}>{link.title} →</Text>
            <Text style={styles.body}>{link.description}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator />
          <Text style={styles.body}>Preparing today&apos;s practice…</Text>
        </View>
      ) : null}

      {loadError ? <View><Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
        <TouchableOpacity onPress={() => void loadPractice()}><Text>Try loading your lesson again</Text></TouchableOpacity></View> : null}

      {!isLoading && practice ? (
        practice.status === 'ready' ? renderReady(practice) : renderNotReady(practice)
      ) : null}

      {!isLoading && !practice && !loadError ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Adaptive lesson</Text>
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
  /** The primary recommended action gets a slightly stronger presence. */
  dailyCard: {
    borderColor: '#cfe3d6',
    borderWidth: 2,
  },
  cardHeader: {
    flexDirection: 'row', flexWrap: 'wrap',
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
  practiceLink: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e6e9ef', gap: 4 },
  secondaryButton: {
    marginVertical: 8, paddingHorizontal: 12,
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
