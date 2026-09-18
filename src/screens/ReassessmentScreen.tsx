/**
 * src/screens/ReassessmentScreen.tsx
 *
 * WP-4 Periodic Reassessment Mobile-First Screen.
 *
 * REUSES the existing onboarding diagnostic flow and components.
 * NO FAKE SCORES OR PERCENTAGES.
 * LEVEL CHANGE REQUIRES EXPLICIT ACCEPTANCE: "Use this level" or "Keep my current level".
 */

import React, { useEffect, useState } from 'react';
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
  type ReassessmentRecord,
  type ReassessmentService,
  type QualitativeChangeReport,
} from '../reassessment';
import {
  describeConfidence,
  describeEstimate,
  type DiagnosticHandle,
  type DiagnosticResult,
} from '../onboarding';

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

  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<ReassessmentEligibility | null>(null);
  const [handle, setHandle] = useState<DiagnosticHandle | null>(null);
  const [inProgress, setInProgress] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [record, setRecord] = useState<ReassessmentRecord | null>(null);
  const [report, setReport] = useState<QualitativeChangeReport | null>(null);
  const [decisionOutcome, setDecisionOutcome] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const elig = await service.checkEligibility(learnerId);
        if (active) {
          setEligibility(elig);
        }
      } catch {
        if (active) {
          setEligibility({
            available: true,
            reason: 'manual_request',
            message: 'Ready for reassessment.',
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [service, learnerId]);

  const startReassessment = async () => {
    setLoading(true);
    try {
      const h = await service.beginReassessment();
      setHandle(h);
      setInProgress(true);
    } catch {
      // Handle error gracefully
    } finally {
      setLoading(false);
    }
  };

  const finishReassessment = async () => {
    if (!handle) return;
    setLoading(true);
    try {
      const outcome = await service.finishReassessment(handle);
      setResult(outcome.result);
      setRecord(outcome.record);
      setReport(outcome.report);
      setInProgress(false);
    } catch {
      setInProgress(false);
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptLevel = async () => {
    if (!record) return;
    setLoading(true);
    try {
      const res = await service.acceptReassessmentLevel(record.id);
      if (res.updated) {
        setDecisionOutcome(`Working level updated to ${res.currentLevel}.`);
      } else if (res.reason === 'already-accepted') {
        setDecisionOutcome(`Level ${res.currentLevel} already accepted.`);
      } else {
        setDecisionOutcome(`Level kept at ${res.currentLevel}.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeepLevel = async () => {
    if (!record) return;
    setLoading(true);
    try {
      const res = await service.keepCurrentLevel(record.id);
      setDecisionOutcome(`Current level retained (${res.currentLevel}).`);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0066CC" />
        <Text style={styles.loadingText}>Loading reassessment...</Text>
      </View>
    );
  }

  if (result && record && report) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.headerTitle}>Reassessment Complete</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Proposed Working Level</Text>
          <Text style={styles.levelBadge}>{result.estimate.level}</Text>
          <Text style={styles.confidenceText}>
            {describeConfidence(result.estimate.confidence)}
          </Text>
          <Text style={styles.descriptionText}>
            {describeEstimate(result.estimate)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Qualitative Ability Change Summary</Text>
          <Text style={styles.overallSummary}>{report.overallSummary}</Text>

          {report.domains.map((d) => (
            <View key={d.domain} style={styles.domainRow}>
              <Text style={styles.domainName}>
                {d.domain.toUpperCase()}: <Text style={styles.domainStatus}>[{d.status}]</Text>
              </Text>
              <Text style={styles.domainSummary}>{d.summary}</Text>
            </View>
          ))}
        </View>

        {decisionOutcome ? (
          <View style={styles.outcomeCard}>
            <Text style={styles.outcomeText}>{decisionOutcome}</Text>

            {onFinish && (
              <TouchableOpacity style={styles.primaryButton} onPress={onFinish}>
                <Text style={styles.buttonText}>Continue</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.primaryButton} onPress={handleAcceptLevel}>
              <Text style={styles.buttonText}>Use this level ({result.estimate.level})</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={handleKeepLevel}>
              <Text style={styles.secondaryButtonText}>
                Keep my current level ({result.profile.currentLevel})
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    );
  }

  if (inProgress && handle) {
    return (
      <View style={styles.container}>
        <Text style={styles.headerTitle}>Diagnostic Reassessment in Progress</Text>
        <Text style={styles.descriptionText}>
          Step: {handle.session.getCurrentStepId()}
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={finishReassessment}>
          <Text style={styles.buttonText}>Finish Reassessment</Text>
        </TouchableOpacity>
      </View>
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
          <TouchableOpacity style={styles.primaryButton} onPress={startReassessment}>
            <Text style={styles.buttonText}>Start Reassessment</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.disabledBox}>
            <Text style={styles.disabledText}>
              Not enough new evidence yet. Continue your daily practice in Talk, Listening, and
              Adaptive Lessons!
            </Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => startReassessment()}>
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
  levelBadge: {
    fontSize: 32,
    fontWeight: '800',
    color: '#0066CC',
    marginVertical: 6,
  },
  confidenceText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#4A5568',
    marginBottom: 8,
  },
  descriptionText: {
    fontSize: 15,
    color: '#4A5568',
    lineHeight: 22,
    marginBottom: 12,
  },
  overallSummary: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A202C',
    marginBottom: 14,
  },
  domainRow: {
    marginBottom: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#EDF2F7',
  },
  domainName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#2B6CB0',
  },
  domainStatus: {
    fontSize: 13,
    fontWeight: '600',
    color: '#718096',
  },
  domainSummary: {
    fontSize: 14,
    color: '#4A5568',
    marginTop: 4,
  },
  actionRow: {
    marginTop: 10,
    gap: 12,
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
  outcomeCard: {
    backgroundColor: '#EBF8FF',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#BEE3F8',
    alignItems: 'center',
  },
  outcomeText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#2B6CB0',
    marginBottom: 12,
  },
});
