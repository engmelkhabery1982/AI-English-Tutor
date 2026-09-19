/**
 * src/reassessment/service.ts
 *
 * WP-4 Periodic Reassessment & Evidence Symmetry Service.
 *
 * REUSES the existing onboarding diagnostic engine and aggregator.
 * DOES NOT create a second diagnostic or placement engine.
 * DOES NOT silently replace current level: level update requires explicit user acceptance.
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
  type AppDatabaseLifecycleToken,
} from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { LearnerModel } from '../learner-model';
import type { ConversationMode } from '../domain/shared/types';
import type { LearnerStrength, LearnerWeakness } from '../domain/models/learner';
import type { DiagnosticHandle, DiagnosticLevelDecision, DiagnosticResult, OnboardingService } from '../onboarding';
import { createOnboardingServiceOn } from '../onboarding';
import { nowIso } from '../shared/time';
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
  let activeHandle: DiagnosticHandle | null = null;
  /**
   * Database lifecycle the DEFAULT composition below was resolved on. Anything
   * composed from the canonical database is dropped when that database starts a
   * NEW lifecycle, so this service can never keep reading/writing through a
   * closed connection. Explicitly injected dependencies are the caller's and
   * are used exactly as given.
   */
  let resolvedLifecycle: AppDatabaseLifecycleToken | null = null;

  async function resolveDependencies() {
    const hasInjectedComposition = Boolean(deps.adapter || deps.onboardingService);
    if (!hasInjectedComposition) {
      const lifecycle = appDatabaseLifecycleToken();
      if (resolvedLifecycle !== lifecycle) {
        // First resolution, or a close/reopen happened: recompose on the
        // CURRENT shared adapter instead of the previous connection.
        resolvedLifecycle = lifecycle;
        adapterInstance = null;
        onboardingInstance = null;
        historyRepoInstance = deps.historyRepository ?? null;
        successRecorderInstance = deps.successRecorder ?? null;
      }
    }

    if (!adapterInstance && !onboardingInstance) {
      // Precedence: an explicitly injected adapter/onboarding service first,
      // then the CANONICAL application database owner (one shared adapter for
      // every feature; never a second connection to the same file).
      adapterInstance = (await getAppDatabase()).adapter;
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
      const weaknesses = await weaknessRepo.listWeaknesses(learnerId);

      const totalEvidenceCount = strengths.length + weaknesses.length;

      if (history.length === 0) {
        if (totalEvidenceCount < 3) {
          return {
            available: false,
            reason: 'insufficient_evidence',
            message: 'Not enough practice evidence collected yet.',
            newEvidenceCount: totalEvidenceCount,
          };
        }

        return {
          available: true,
          reason: 'sufficient_evidence',
          message: 'Initial reassessment available based on accumulated practice evidence.',
          newEvidenceCount: totalEvidenceCount,
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

      if (activeHandle) {
        activeHandle.session.abandon();
        activeHandle = null;
      }

      const handle = await resolved.onboarding.beginDiagnostic(options);
      activeHandle = handle;
      return handle;
    },

    async finishReassessment(handle) {
      const resolved = await resolveDependencies();
      if (!resolved.onboarding) {
        throw new Error('Onboarding service unavailable');
      }

      const snapshot = handle.session.snapshot();
      const recordId = `reassess_${snapshot.learnerId}_${snapshot.startedAt}`;

      // Check if a record for this exact handle run was already saved (retry / duplicate finish safety)
      if (resolved.historyRepo) {
        const existingRecord = await resolved.historyRepo.getById(recordId);
        if (existingRecord) {
          let outcomeResult = await resolved.onboarding.buildResult(handle);
          if (!outcomeResult) {
            outcomeResult = await resolved.onboarding.finishDiagnostic(handle);
          }
          const report = generateAbilityChangeReport({
            strengths: [],
            weaknesses: [],
            currentResult: outcomeResult,
            previousRecord: existingRecord,
          });
          return { result: outcomeResult, record: existingRecord, report };
        }
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
          id: recordId,
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
          generatedAt: result.generatedAt ?? nowIso(),
        });
      }

      return { result, record, report };
    },

    async acceptReassessmentLevel(recordId) {
      const resolved = await resolveDependencies();
      if (!resolved.historyRepo || !resolved.adapter) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      const existingRecord = await resolved.historyRepo.getById(recordId);
      if (!existingRecord) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      if (existingRecord.decision === 'accepted') {
        return {
          updated: false,
          currentLevel: existingRecord.acceptedLevel ?? existingRecord.proposedLevel,
          reason: 'already-accepted',
        };
      }
      if (existingRecord.decision === 'kept') {
        return {
          updated: false,
          currentLevel: existingRecord.previousLevel,
          reason: 'kept',
        };
      }

      if (existingRecord.status !== 'estimated' || existingRecord.proposedLevel === 'unknown') {
        return { updated: false, currentLevel: existingRecord.previousLevel, reason: 'not-estimated' };
      }

      const updateResult = await resolved.historyRepo.acceptAndApplyLevel(
        recordId,
        existingRecord.proposedLevel,
      );

      if (!updateResult.updated) {
        return {
          updated: false,
          currentLevel: updateResult.record?.acceptedLevel ?? updateResult.record?.previousLevel ?? 'unknown',
          reason: updateResult.record?.decision === 'kept' ? 'kept' : 'already-accepted',
        };
      }



      if (deps.learnerModel) {
        try {
          await deps.learnerModel.refresh();
        } catch {
          // ignore
        }
      }

      return {
        updated: true,
        currentLevel: existingRecord.proposedLevel,
        reason: 'accepted',
      };
    },

    async keepCurrentLevel(recordId) {
      const resolved = await resolveDependencies();
      if (!resolved.historyRepo || !resolved.adapter) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      const existingRecord = await resolved.historyRepo.getById(recordId);
      if (!existingRecord) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }

      if (existingRecord.decision === 'kept') {
        return { updated: false, currentLevel: existingRecord.previousLevel, reason: 'kept' };
      }
      if (existingRecord.decision === 'accepted') {
        return {
          updated: false,
          currentLevel: existingRecord.acceptedLevel ?? existingRecord.proposedLevel,
          reason: 'already-accepted',
        };
      }

      const updateResult = await resolved.historyRepo.keepCurrentLevel(recordId);

      if (!updateResult.updated) {
        return {
          updated: false,
          currentLevel: updateResult.record?.previousLevel ?? 'unknown',
          reason: updateResult.record?.decision === 'accepted' ? 'already-accepted' : 'kept',
        };
      }

      return {
        updated: false,
        currentLevel: existingRecord.previousLevel,
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
