import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/HomeScreen.tsx
 *
 * Home — the "What should I do next?" entry point.
 * Visual redesign only — all existing service contracts remain intact.
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
import { theme } from './components/ui/theme';
import { AppHeader } from './components/ui/AppHeader';
import { SectionHeader } from './components/ui/SectionHeader';
import { PracticeCard } from './components/ui/PracticeCard';
import { Pill } from './components/ui/Pill';
import { EmptyState, ErrorState } from './components/ui/States';

import type { AdaptiveLessonService, AdaptiveTodayPractice } from '../adaptive-lessons';
import { createDefaultAdaptiveLessonService } from '../adaptive-lessons';
import type { OnboardingPrefill, OnboardingService } from '../onboarding';
import { createDefaultOnboardingService } from '../onboarding';
import type { DailyTutorHomeCard, DailyTutorService } from '../daily-tutor';
import { buildDailyTutorHomeCard, createDefaultDailyTutorService } from '../daily-tutor';

export interface HomeScreenProps {
  readonly service?: AdaptiveLessonService;
  readonly onboardingService?: OnboardingService;
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
      setLoadError('Could not load your practice for today. Nothing was changed.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const dailyTutorRef = useRef<DailyTutorService | null>(props?.dailyTutorService ?? null);
  const [dailyCard, setDailyCard] = useState<DailyTutorHomeCard | null>(null);
  const [dailyUnavailable, setDailyUnavailable] = useState<string | null>(null);
  const [dailyLoading, setDailyLoading] = useState<boolean>(true);
  const loadDailyTutor = useCallback(async () => {
    try {
      setDailyLoading(true);
      if (!dailyTutorRef.current) {
        dailyTutorRef.current = await createDefaultDailyTutorService();
      }
      const today = await dailyTutorRef.current.getToday();
      if (today.status === 'ready') {
        setDailyCard(buildDailyTutorHomeCard(today.session));
        setDailyUnavailable(null);
        return;
      }
      setDailyCard(null);
      setDailyUnavailable(today.message);
    } catch {
      setDailyUnavailable(
        'Your daily practice could not be loaded right now. Nothing was changed.',
      );
    } finally {
      setDailyLoading(false);
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

  const dailyLabel =
    dailyCard?.state === 'completed'
      ? 'Done'
      : dailyCard?.state === 'in_progress'
        ? 'In progress'
        : 'Ready';
  const dailyLabelTone =
    dailyCard?.state === 'completed'
      ? 'success'
      : 'primary';

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
          <Pill label={modeLabel} tone={plan.sourceMode === 'general' ? 'neutral' : 'primary'} />
        </View>

        <Text style={styles.headline}>{today.headline}</Text>
        <Text style={styles.sourceNote}>{plan.sourceNote}</Text>

        {today.resume ? (
          <View style={styles.resumeBanner}>
            <Text style={styles.resumeText}>
              You have an unfinished lesson — step {today.resume.stepNumber} of{' '}
              {today.resume.totalSteps}.
            </Text>
          </View>
        ) : null}

        {today.focusLines.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.label}>Focus</Text>
            {today.focusLines.slice(0, 2).map((line) => (
              <Text key={line} style={styles.listLine}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.sizeNote}>
          {today.sizeLabel === 'short' ? 'Short lesson' : 'Standard lesson'} · {today.stepCount} steps
        </Text>

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
        <Pill label={SOURCE_LABELS[today.status]} tone="neutral" />
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
    <ScrollView
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <AppHeader title="AI English Tutor" subtitle="Your daily practice, tailored to you" />

      {/*
        1. TOP PRIMARY AREA — exactly ONE dominant CTA answering "what should
        I do now?". Profile not ready → set up/assess (nothing else competes);
        profile ready → the real next activity from the Daily Tutor.
      */}
      {prefill && !prefill.isComplete ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Set up your learning plan</Text>
          <Text style={styles.body}>
            Choose your goals and take a short English assessment so your tutor can adapt.
          </Text>
          <TouchableOpacity style={styles.setupPrimaryButton} onPress={openOnboarding} testID="home-primary-cta">
            <Text style={styles.primaryButtonText}>Assess my English</Text>
          </TouchableOpacity>
        </View>
      ) : dailyLoading && !dailyCard ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Preparing your daily practice…</Text>
        </View>
      ) : dailyCard ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Daily Tutor</Text>
            <Pill label={dailyLabel} tone={dailyLabelTone as 'primary' | 'success'} />
          </View>
          <Text style={styles.headline}>{dailyCard.headline}</Text>
          <Text style={styles.body}>
            {dailyCard.progressLabel} · built from your own practice history
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={openDailyTutor} testID="home-primary-cta">
            <Text style={styles.primaryButtonText}>{dailyCard.buttonLabel}</Text>
          </TouchableOpacity>
        </View>
      ) : dailyUnavailable ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Daily Tutor</Text>
            <Pill label="Not ready" tone="neutral" />
          </View>
          <Text style={styles.body}>{dailyUnavailable}</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void loadDailyTutor()}>
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* 2. CORE PRACTICE — the daily actions, immediately visible. */}
      <SectionHeader title="Practice" subtitle="Practise and review · Choose a skill to focus on" />

      <PracticeCard
        title="Talk · Open conversation"
        description="Speak freely with your tutor, or type your answer"
        onPress={() => navigation.navigate('Talk')}
        icon="💬"
        testID="home-talk-card"
      />
      <PracticeCard
        title="Listening"
        description="Listen, replay, and reveal the transcript"
        onPress={() => navigation.navigate('Listening')}
        icon="🎧"
        testID="home-listening-card"
      />
      <PracticeCard
        title="Review"
        description="Recall saved language and practise what's due"
        onPress={() => navigation.navigate('Review')}
        icon="🔁"
        testID="home-review-card"
      />

      {/* 3. NEXT FOCUS — ONE concise evidence-based recommendation. The
          adaptive lesson appears ONLY here (no duplicated prominence). */}
      <SectionHeader title="Next focus" subtitle="Built from your real practice history" />

      {isLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Preparing today's practice…</Text>
        </View>
      ) : null}

      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => void loadPractice()}
        />
      ) : null}

      {!isLoading && practice ? (
        practice.status === 'ready' ? renderReady(practice) : renderNotReady(practice)
      ) : null}

      {!isLoading && !practice && !loadError ? (
        <EmptyState
          icon="📋"
          title="Adaptive lesson"
          message="Your lesson could not be prepared yet. Nothing was changed."
          actionLabel="Check again"
          onAction={() => void loadPractice()}
        />
      ) : null}

      {/* 4. LEARNING TOOLS — secondary entries. */}
      <SectionHeader title="Learning tools" />

      <PracticeCard
        title="Learning tools"
        description="Dictionary & Translate, reading stories, and read aloud"
        onPress={() => navigation.navigate('LearningTools')}
        icon="🛠️"
        testID="home-learning-tools-card"
      />
      {PRACTICE_LINKS.filter((link) => link.route === 'Vocabulary').map((link) => (
        <PracticeCard
          key={link.route}
          title={link.title}
          description={link.description}
          onPress={() => navigation.navigate(link.route)}
          testID={`home-skill-${link.route}`}
        />
      ))}

      {/* 5. MORE SKILLS — secondary/specialized entries, lower priority. */}
      <SectionHeader title="More skills" />
      {PRACTICE_LINKS.map((link) =>
        link.route === 'Vocabulary' ? null : (
          <PracticeCard
            key={link.route}
            title={link.title}
            description={link.description}
            onPress={() => navigation.navigate(link.route)}
            testID={`home-skill-${link.route}`}
          />
        ),
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingBottom: theme.spacing.xxxl,
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
  onboardingCard: {
    backgroundColor: theme.colors.primarySoft,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.primaryLight,
  },
  setupPrimaryButton: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    ...theme.shadows.primary,
  },
  cardHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.sm,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    flexShrink: 1,
  },
  headline: {
    fontSize: 15,
    color: theme.colors.textPrimary,
    marginBottom: 4,
    lineHeight: 21,
  },
  body: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    marginBottom: theme.spacing.sm,
    lineHeight: 22,
  },
  sourceNote: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  resumeBanner: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.successSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
  },
  resumeText: {
    fontSize: 13,
    color: theme.colors.successDark,
    fontWeight: '600',
  },
  section: {
    marginTop: theme.spacing.md,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  listLine: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    marginBottom: 4,
    lineHeight: 20,
  },
  sizeNote: {
    fontSize: 12,
    color: theme.colors.textTertiary,
    marginTop: 6,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: 10,
  },
  loadingText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },
  primaryButton: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    marginTop: theme.spacing.sm,
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
  linkButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 4,
  },
  linkText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
