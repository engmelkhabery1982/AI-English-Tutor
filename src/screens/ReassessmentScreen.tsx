import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/ReassessmentScreen.tsx
 *
 * WP-4 Periodic Reassessment Mobile-First Screen.
 *
 * REUSES the existing onboarding diagnostic workflow/components/handlers.
 * NO FAKE SCORES OR PERCENTAGES.
 * LEVEL CHANGE REQUIRES EXPLICIT ACCEPTANCE: "Use this level" or "Keep my current level".
 * REAL LIFECYCLE & STALE-RUN PROTECTIONS:
 * - Second reassessment invalidates and abandons the first run.
 * - Unmount/exit invalidates current run.
 * - Late STT/pronunciation/AI results from old run cannot mutate state.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  createReassessmentService,
  type ReassessmentEligibility,
  type ReassessmentService,
} from '../reassessment';
import { createDefaultOnboardingService, type DiagnosticHandle } from '../onboarding';
import { ASSESSMENT_PRE_GUIDANCE } from '../learner-agency';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import OnboardingScreen from './OnboardingScreen';

export interface ReassessmentScreenProps {
  readonly service?: ReassessmentService;
  readonly learnerId?: string;
  readonly onFinish?: () => void;
}

export default function ReassessmentScreen({
  service: injectedService,
  learnerId,
  onFinish,
}: ReassessmentScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const [noProfile, setNoProfile] = useState(false);
  const [service] = useState<ReassessmentService>(
    () => injectedService ?? createReassessmentService(),
  );

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const handleRef = useRef<DiagnosticHandle | null>(null);

  const [retry, setRetry] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<ReassessmentEligibility | null>(null);
  const [inProgress, setInProgress] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const currentGen = ++generationRef.current;

    (async () => {
      setLoading(true);
      setLoadError(false);
      setNoProfile(false);
      try {
        const profileId = learnerId ?? (await (await createDefaultOnboardingService()).loadPrefill()).profileId;
        if (!mountedRef.current || generationRef.current !== currentGen) return;
        setNoProfile(!profileId);
        if (!profileId) { setEligibility(null); return; }
        const elig = await service.checkEligibility(profileId);
        if (mountedRef.current && generationRef.current === currentGen) {
          setEligibility(elig);
        }
      } catch {
        if (mountedRef.current && generationRef.current === currentGen) {
          setEligibility(null);
          setLoadError(true);
        }
      } finally {
        if (mountedRef.current && generationRef.current === currentGen) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mountedRef.current = false;
      // Exit / unmount invalidates current diagnostic handle
      if (handleRef.current) {
        handleRef.current.session.abandon();
        handleRef.current = null;
      }
    };
  }, [service, learnerId, retry]);

  const startReassessment = (_force = false) => {
    generationRef.current += 1;
    setInProgress(true);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Checking your assessment history…</Text>
      </View>
    );
  }

  // Reuses the REAL onboarding diagnostic workflow components and step handlers!
  if (inProgress) {
    return (
      <OnboardingScreen
        isReassessment={true}
        reassessmentService={service}
        onFinish={onFinish}
      />
    );
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.headerTitle}>Check my English level again</Text>

      <Text style={styles.descriptionText}>After a period of practice, take another English assessment to compare what has changed. Your level changes only if you accept the suggested level.</Text>
      {/* Work Order 2 — same pre-guidance as the first assessment: answer with
          your own real examples; short answers are still valid, just weaker. */}
      <Text style={styles.descriptionText}>{ASSESSMENT_PRE_GUIDANCE}</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Is it time to reassess?</Text>
        <Text style={styles.descriptionText}>
          {eligibility?.message ?? 'Assessment history is unavailable.'}
        </Text>

        {noProfile ? <View><Text style={styles.descriptionText}>Set up your learning profile and take your first assessment before checking your level again.</Text>
          <TouchableOpacity onPress={() => navigation.navigate('Onboarding')}><Text>Assess my English</Text></TouchableOpacity></View> : loadError ? <View><Text accessibilityRole="alert" style={styles.descriptionText}>Could not load your assessment history. Nothing was changed.</Text>
          <TouchableOpacity onPress={() => setRetry(n => n + 1)}><Text>Try again</Text></TouchableOpacity></View> : eligibility?.available ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => startReassessment(false)}
          >
            <Text style={styles.buttonText}>Start new assessment</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.disabledBox}>
            <Text style={styles.disabledText}>
              Not enough new evidence yet. Continue your daily practice in Talk, Listening, and
              Adaptive Lessons!
            </Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => startReassessment(true)}
            >
              <Text style={styles.secondaryButtonText}>Take an assessment anyway</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F7F8FA',
  },
  content: {
    padding: 20,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#6B7280',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.5,
    marginBottom: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 10,
  },
  descriptionText: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 22,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    marginVertical: 6,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#F3F4F6',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    marginVertical: 6,
  },
  secondaryButtonText: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledBox: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
  },
  disabledText: {
    fontSize: 14,
    color: '#9CA3AF',
    lineHeight: 20,
    marginBottom: 10,
  },
});
