/**
 * src/reassessment/service.ts
 *
 * WP-4 Periodic Reassessment & Evidence Symmetry Service.
 *
 * REUSES the existing onboarding diagnostic engine and aggregator.
 * DOES NOT create a second diagnostic or placement engine.
 * DOES NOT silently replace current level: level update requires explicit user acceptance.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { LearnerModel } from '../learner-model';
import type { DiagnosticHandle, DiagnosticLevelDecision, DiagnosticResult, OnboardingService } from '../onboarding';
import { createOnboardingServiceOn } from '../onboarding';
import type { ConversationMode } from '../domain/shared/types';
import type { LearnerStrength, LearnerWeakness } from '../domain/models/learner';
import { generateAbilityChangeReport } from './change-report';
import {
  SQLiteReassessmentHistoryRepository,
  type ReassessmentHistoryRepository,
} from './history-repository';
import {
  createSuccessObservationRecorder,
  type SuccessObservationRecorder,
} from './success-recorder';
import type {
  QualitativeChangeReport,
  ReassessmentEligibility,
  ReassessmentRecord,
  SuccessObservationInput,
  SuccessObservationResult,
} from './types';

export interface ReassessmentServiceDeps {
  readonly adapter?: DatabaseAdapter;
  readonly onboardingService?: OnboardingService;
  readonly historyRepository?: ReassessmentHistoryRepository;
  readonly successRecorder?: SuccessObservationRecorder;
  readonly learnerModel?: LearnerModel;
}

export interface ReassessmentService {
  readonly successRecorder: SuccessObservationRecorder;

  checkEligibility(learnerId: string, options?: { force?: boolean }): Promise<ReassessmentEligibility>;

  beginReassessment(options?: {
    readonly mode?: ConversationMode;
    readonly topic?: string;
  }): Promise<DiagnosticHandle>;

  finishReassessment(
    handle: DiagnosticHandle,
  ): Promise<{
    readonly result: DiagnosticResult | null;
    readonly record: ReassessmentRecord | null;
    readonly report: QualitativeChangeReport;
  }>;

  acceptReassessmentLevel(recordId: string): Promise<DiagnosticLevelDecision>;
  keepCurrentLevel(recordId: string): Promise<DiagnosticLevelDecision>;

  getHistory(learnerId: string): Promise<readonly ReassessmentRecord[]>;
  getQualitativeReport(learnerId: string): Promise<QualitativeChangeReport>;

  recordSuccessObservation(input: SuccessObservationInput): Promise<SuccessObservationResult>;
}

export function createReassessmentService(
  deps: ReassessmentServiceDeps = {},
): ReassessmentService {
  let adapterInstance = deps.adapter ?? null;
  let onboardingInstance = deps.onboardingService ?? null;
  let historyRepoInstance = deps.historyRepository ?? null;
  let successRecorderInstance = deps.successRecorder ?? null;

  async function resolveDependencies() {
    if (!adapterInstance && !onboardingInstance) {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      adapterInstance = adapter;
    }

    if (!onboardingInstance && adapterInstance) {
      onboardingInstance = createOnboardingServiceOn(adapterInstance);
    }

    if (!historyRepoInstance && adapterInstance) {
      historyRepoInstance = new SQLiteReassessmentHistoryRepository(adapterInstance);
    }

    if (!successRecorderInstance && adapterInstance) {
      const weaknessRepo = new SQLiteWeaknessRepository(adapterInstance);
      successRecorderInstance = createSuccessObservationRecorder(weaknessRepo);
    }

    return {
      adapter: adapterInstance,
      onboarding: onboardingInstance,
      historyRepo: historyRepoInstance,
      successRecorder: successRecorderInstance,
    };
  }

  const defaultSuccessRecorder: SuccessObservationRecorder = {
    async recordSuccessObservation(input) {
      const resolved = await resolveDependencies();
      if (resolved.successRecorder) {
        return resolved.successRecorder.recordSuccessObservation(input);
      }
      return { recorded: false, strength: null, reason: 'provider_failed' };
    },
  };

  return {
    successRecorder: defaultSuccessRecorder,

    async checkEligibility(learnerId, options) {
      if (options?.force) {
        return {
          available: true,
          reason: 'manual_request',
          message: 'Reassessment requested by learner.',
        };
      }

      const resolved = await resolveDependencies();
      if (!resolved.historyRepo || !resolved.adapter) {
        return {
          available: true,
          reason: 'manual_request',
          message: 'Ready for reassessment.',
        };
      }

      const history = await resolved.historyRepo.listHistory(learnerId, 1);
      const weaknessRepo = new SQLiteWeaknessRepository(resolved.adapter);
      const strengths = await weaknessRepo.listStrengths(learnerId);

      if (history.length === 0) {
        // Brand new / no previous reassessment record
        return {
          available: true,
          reason: 'sufficient_evidence',
          message: 'Initial reassessment available.',
        };
      }

      const last = history[0];
      const newEvidenceCount = strengths.filter(
        (s) => s.lastSeenAt > last.createdAt,
      ).length;

      if (newEvidenceCount >= 2) {
        return {
          available: true,
          reason: 'sufficient_evidence',
          message: 'Sufficient new practice evidence collected for reassessment.',
          newEvidenceCount,
        };
      }

      return {
        available: false,
        reason: 'insufficient_evidence',
        message: 'Not enough new evidence yet.',
        newEvidenceCount,
      };
    },

    async beginReassessment(options) {
      const resolved = await resolveDependencies();
      if (!resolved.onboarding) {
        throw new Error('Onboarding service unavailable for reassessment');
      }
      return resolved.onboarding.beginDiagnostic(options);
    },

    async finishReassessment(handle) {
      const resolved = await resolveDependencies();
      if (!resolved.onboarding) {
        throw new Error('Onboarding service unavailable');
      }

      const result = await resolved.onboarding.finishDiagnostic(handle);
      if (!result) {
        return {
          result: null,
          record: null,
          report: {
            overallSummary: 'Diagnostic was not completed.',
            domains: [],
            hasSufficientEvidence: false,
          },
        };
      }

      // Read current strengths and weaknesses for qualitative change report
      let strengths: LearnerStrength[] = [];
      let weaknesses: LearnerWeakness[] = [];
      let previousRecord: ReassessmentRecord | null = null;

      if (resolved.adapter) {
        const weaknessRepo = new SQLiteWeaknessRepository(resolved.adapter);
        strengths = [...(await weaknessRepo.listStrengths(result.learnerId))];
        weaknesses = [...(await weaknessRepo.listWeaknesses(result.learnerId))];
      }
      if (resolved.historyRepo) {
        previousRecord = await resolved.historyRepo.getLatest(result.learnerId);
      }

      const report = generateAbilityChangeReport({
        strengths,
        weaknesses,
        currentResult: result,
        previousRecord,
      });

      let record: ReassessmentRecord | null = null;
      if (resolved.historyRepo) {
        record = await resolved.historyRepo.saveRecord({
          learnerId: result.learnerId,
          assessmentKind: 'reassessment',
          status: result.estimate.status,
          proposedLevel: result.estimate.level,
          previousLevel: result.profile.currentLevel,
          confidence: result.estimate.confidence,
          decision: 'pending',
          acceptedLevel: null,
          basis: result.estimate.basis,
          qualitativeSummary: report,
          generatedAt: result.generatedAt,
        });
      }

      return { result, record, report };
    },

    async acceptReassessmentLevel(recordId) {
      const resolved = await resolveDependencies();
      if (!resolved.historyRepo || !resolved.adapter) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      const record = await resolved.historyRepo.getById(recordId);
      if (!record) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      // Exactly-once acceptance check
      if (record.decision === 'accepted') {
        return {
          updated: false,
          currentLevel: record.acceptedLevel ?? record.proposedLevel,
          reason: 'already-accepted',
        };
      }

      if (record.status !== 'estimated' || record.proposedLevel === 'unknown') {
        return { updated: false, currentLevel: record.previousLevel, reason: 'not-estimated' };
      }

      const profileRepo = new SQLiteUserProfileRepository(resolved.adapter);
      await profileRepo.update({ currentLevel: record.proposedLevel });

      await resolved.historyRepo.updateDecision(
        recordId,
        'accepted',
        record.proposedLevel,
      );

      if (deps.learnerModel) {
        try {
          await deps.learnerModel.refresh();
        } catch {
          // ignore
        }
      }

      return {
        updated: true,
        currentLevel: record.proposedLevel,
        reason: 'accepted',
      };
    },

    async keepCurrentLevel(recordId) {
      const resolved = await resolveDependencies();
      if (!resolved.historyRepo || !resolved.adapter) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      const record = await resolved.historyRepo.getById(recordId);
      if (!record) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      if (record.decision === 'kept') {
        return { updated: false, currentLevel: record.previousLevel, reason: 'kept' };
      }

      await resolved.historyRepo.updateDecision(recordId, 'kept', record.previousLevel);

      const profileRepo = new SQLiteUserProfileRepository(resolved.adapter);
      const profile = await profileRepo.get();

      return {
        updated: false,
        currentLevel: profile?.currentLevel ?? record.previousLevel,
        reason: 'kept',
      };
    },

    async getHistory(learnerId) {
      const resolved = await resolveDependencies();
      if (!resolved.historyRepo) return [];
      return resolved.historyRepo.listHistory(learnerId);
    },

    async getQualitativeReport(learnerId) {
      const resolved = await resolveDependencies();
      let strengths: LearnerStrength[] = [];
      let weaknesses: LearnerWeakness[] = [];
      let previousRecord: ReassessmentRecord | null = null;

      if (resolved.adapter) {
        const weaknessRepo = new SQLiteWeaknessRepository(resolved.adapter);
        strengths = [...(await weaknessRepo.listStrengths(learnerId))];
        weaknesses = [...(await weaknessRepo.listWeaknesses(learnerId))];
      }

      if (resolved.historyRepo) {
        previousRecord = await resolved.historyRepo.getLatest(learnerId);
      }

      return generateAbilityChangeReport({
        strengths,
        weaknesses,
        previousRecord,
      });
    },

    async recordSuccessObservation(input) {
      return defaultSuccessRecorder.recordSuccessObservation(input);
    },
  };
}
