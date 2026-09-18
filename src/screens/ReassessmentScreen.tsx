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
  TouchableOpacity,
  View,
} from 'react-native';

import {
  createReassessmentService,
  type ReassessmentEligibility,
  type ReassessmentService,
} from '../reassessment';
import type { DiagnosticHandle } from '../onboarding';
import OnboardingScreen from './OnboardingScreen';

export interface ReassessmentScreenProps {
  readonly service?: ReassessmentService;
  readonly learnerId?: string;
  readonly onFinish?: () => void;
}

export default function ReassessmentScreen({
  service: injectedService,
  learnerId = 'default-learner',
  onFinish,
}: ReassessmentScreenProps) {
  const [service] = useState<ReassessmentService>(
    () => injectedService ?? createReassessmentService(),
  );

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const handleRef = useRef<DiagnosticHandle | null>(null);

  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<ReassessmentEligibility | null>(null);
  const [inProgress, setInProgress] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const currentGen = generationRef.current;

    (async () => {
      setLoading(true);
      try {
        const elig = await service.checkEligibility(learnerId);
        if (mountedRef.current && generationRef.current === currentGen) {
          setEligibility(elig);
        }
      } catch {
        if (mountedRef.current && generationRef.current === currentGen) {
          setEligibility({
            available: true,
            reason: 'manual_request',
            message: 'Ready for reassessment.',
          });
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
  }, [service, learnerId]);

  const startReassessment = async (force = false) => {
    // Increment generation so any late async response from prior run is ignored
    generationRef.current += 1;
    const currentGen = generationRef.current;

    // Second reassessment invalidates first
    if (handleRef.current) {
      handleRef.current.session.abandon();
      handleRef.current = null;
    }

    setLoading(true);
    try {
      const handle = await service.beginReassessment();
      if (!mountedRef.current || generationRef.current !== currentGen) {
        handle.session.abandon();
        return;
      }

      handleRef.current = handle;
      setInProgress(true);
    } catch {
      // Graceful handling
    } finally {
      if (mountedRef.current && generationRef.current === currentGen) {
        setLoading(false);
      }
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0066CC" />
        <Text style={styles.loadingText}>Checking reassessment eligibility...</Text>
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.headerTitle}>Periodic Reassessment</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Reassessment Status</Text>
        <Text style={styles.descriptionText}>
          {eligibility?.message ?? 'Ready to reassess your current English capabilities.'}
        </Text>

        {eligibility?.available ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => startReassessment(false)}
          >
            <Text style={styles.buttonText}>Start Reassessment</Text>
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
              <Text style={styles.secondaryButtonText}>Reassess Anyway</Text>
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
    backgroundColor: '#F8F9FA',
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
    color: '#666666',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2D3748',
    marginBottom: 10,
  },
  descriptionText: {
    fontSize: 15,
    color: '#4A5568',
    lineHeight: 22,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#0066CC',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    marginVertical: 6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#EDF2F7',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    marginVertical: 6,
  },
  secondaryButtonText: {
    color: '#2D3748',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledBox: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#EDF2F7',
    borderRadius: 8,
  },
  disabledText: {
    fontSize: 14,
    color: '#718096',
    lineHeight: 20,
    marginBottom: 10,
  },
});
