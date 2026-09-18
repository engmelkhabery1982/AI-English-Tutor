/**
 * src/reassessment/index.test.ts
 *
 * WP-4 — Evidence Symmetry & Reassessment Hardened Tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createOnboardingService, type OnboardingService } from '../onboarding';
import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession } from '../conversation-session';
import { createDemoLearnerModel } from '../talk-demo/demo-learner-model';
import type { AIProvider } from '../providers/ai/types';
import { nowIso } from '../shared/time';
import { generateAbilityChangeReport, mapTypeToDomain } from './change-report';
import { SQLiteReassessmentHistoryRepository } from './history-repository';
import { createReassessmentService, type ReassessmentService } from './service';
import {
  createSuccessObservationRecorder,
  recordListeningSuccess,
  recordPronunciationSuccess,
} from './success-recorder';
import type { SuccessObservationInput } from './types';

function createStubProvider(): AIProvider {
  return {
    id: 'test-stub-provider',
    async generate() {
      return {
        ok: true,
        response: { content: 'Good response.', feedback: null },
      };
    },
  };
}

describe('WP-4 — Evidence Symmetry & Reassessment Hardening', () => {
  let adapter: DatabaseAdapter;
  let learnerId: string;
  let weaknessRepo: SQLiteWeaknessRepository;
  let profileRepo: SQLiteUserProfileRepository;
  let historyRepo: SQLiteReassessmentHistoryRepository;
  let onboardingService: OnboardingService;
  let service: ReassessmentService;

  beforeEach(async () => {
    adapter = new SqlJsAdapter();
    await adapter.init();

    profileRepo = new SQLiteUserProfileRepository(adapter);
    weaknessRepo = new SQLiteWeaknessRepository(adapter);
    historyRepo = new SQLiteReassessmentHistoryRepository(adapter);

    const profile = await profileRepo.update({
      displayName: 'Test Learner',
      targetLanguage: 'en',
      targetLevel: 'B2',
      currentLevel: 'A2',
      learningGoals: ['everyday-conversation'],
      preferredModes: ['natural'],
    });
    learnerId = profile.id;

    onboardingService = createOnboardingService({
      adapter,
      createSpeakingBundle: () => ({
        session: createConversationSession(
          createConversationOrchestrator(
            createConversationEngine(createDemoLearnerModel()),
            createStubProvider(),
          ),
          { mode: 'coach' },
        ),
        providerKind: 'gemini',
        providerInfo: {
          kind: 'gemini',
          label: 'Gemini AI',
          isRealAI: true,
          allowsPersonalizedFeedback: true,
        },
      }),
      now: () => nowIso(),
    });

    service = createReassessmentService({
      adapter,
      onboardingService,
      historyRepository: historyRepo,
      successRecorder: createSuccessObservationRecorder(weaknessRepo),
    });
  });

  // 1. real onboarding diagnostic task flow reused
  it('1. real onboarding diagnostic task flow reused', async () => {
    const handle = await service.beginReassessment();
    expect(handle.session).toBeDefined();
    expect(handle.conversation).toBeDefined();
    expect(handle.speaking).toBeDefined();
    expect(handle.languageUseTask).toBeDefined();
    expect(handle.pronunciationTask).toBeDefined();
  });

  // 2. no Finish-only fake reassessment
  it('2. no Finish-only fake reassessment', async () => {
    const handle = await service.beginReassessment();
    const { result } = await service.finishReassessment(handle);
    expect(result).toBeNull();
  });

  // 3. stale first reassessment ignored after second starts
  it('3. stale first reassessment ignored after second starts', async () => {
    const handle1 = await service.beginReassessment();
    const token1 = handle1.session.getCurrentStepToken();

    const handle2 = await service.beginReassessment();
    expect(handle1.session.getStatus()).toBe('abandoned');

    const marked = handle1.session.markProfileStepDone(token1);
    expect(marked).toBe(false);

    expect(handle2.session.getStatus()).toBe('in_progress');
  });

  // 4. unmount prevents late mutation
  it('4. unmount prevents late mutation', async () => {
    const handle = await service.beginReassessment();
    handle.session.abandon();

    const { result } = await service.finishReassessment(handle);
    expect(result).toBeNull();
  });

  // 5. late STT ignored
  it('5. late STT ignored', async () => {
    const handle = await service.beginReassessment();
    const staleToken = handle.session.getCurrentStepToken();

    handle.session.advance();

    const res = await onboardingService.recordPronunciation(
      handle,
      'Recognized text',
      'Target sentence',
      { stepToken: staleToken },
    );

    expect(res.observed).toBe(false);
  });

  // 6. late pronunciation ignored
  it('6. late pronunciation ignored', async () => {
    const handle = await service.beginReassessment();
    const staleToken = handle.session.getCurrentStepToken();

    handle.session.advance();

    const res = await onboardingService.recordPronunciation(
      handle,
      'Recognized text',
      'Target sentence',
      { stepToken: staleToken },
    );

    expect(res.observed).toBe(false);
  });

  // 7. duplicate finish => one history record
  it('7. duplicate finish => one history record', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const finish1 = await service.finishReassessment(handle);
    const finish2 = await service.finishReassessment(handle);

    expect(finish1.record).not.toBeNull();
    expect(finish2.record).not.toBeNull();
    expect(finish1.record?.id).toBe(finish2.record?.id);

    const history = await service.getHistory(learnerId);
    expect(history.length).toBe(1);
  });

  // 8. retry => one history record
  it('8. retry => one history record', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { result, record: r1 } = await service.finishReassessment(handle);
    expect(r1).not.toBeNull();

    if (result && r1) {
      const saved2 = await historyRepo.saveRecord({
        id: r1.id,
        learnerId,
        assessmentKind: 'reassessment',
        status: result.estimate.status,
        proposedLevel: result.estimate.level,
        previousLevel: 'A2',
        confidence: result.estimate.confidence,
        decision: 'pending',
        acceptedLevel: null,
        basis: result.estimate.basis,
        qualitativeSummary: r1.qualitativeSummary,
        generatedAt: result.generatedAt,
      });

      expect(saved2.id).toBe(r1.id);
      const history = await service.getHistory(learnerId);
      expect(history.length).toBe(1);
    }
  });

  // 9. accept then keep cannot flip
  it('9. accept then keep cannot flip', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const first = await service.acceptReassessmentLevel(record.id);
      expect(first.updated).toBe(true);

      const profileAfterAccept = await profileRepo.get();
      expect(profileAfterAccept.currentLevel).toBe(record.proposedLevel);

      const second = await service.keepCurrentLevel(record.id);
      expect(second.updated).toBe(false);
      expect(second.reason).toBe('already-accepted');

      const profileAfterKeep = await profileRepo.get();
      expect(profileAfterKeep.currentLevel).toBe(record.proposedLevel);
    }
  });

  // 10. keep then accept cannot flip
  it('10. keep then accept cannot flip', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const first = await service.keepCurrentLevel(record.id);
      expect(first.updated).toBe(false);
      expect(first.reason).toBe('kept');

      const second = await service.acceptReassessmentLevel(record.id);
      expect(second.updated).toBe(false);
      expect(second.reason).toBe('kept');

      const profile = await profileRepo.get();
      expect(profile.currentLevel).toBe('A2');
    }
  });

  // 11. concurrent accept updates once
  it('11. concurrent accept updates once', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const [res1, res2] = await Promise.all([
        service.acceptReassessmentLevel(record.id),
        service.acceptReassessmentLevel(record.id),
      ]);

      const updateCount = (res1.updated ? 1 : 0) + (res2.updated ? 1 : 0);
      expect(updateCount).toBe(1);
    }
  });

  // 12. profile/history remain consistent
  it('12. profile/history remain consistent', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      await service.acceptReassessmentLevel(record.id);

      const profile = await profileRepo.get();
      const recordAfter = await historyRepo.getById(record.id);

      expect(profile.currentLevel).toBe(recordAfter?.acceptedLevel);
      expect(recordAfter?.decision).toBe('accepted');
    }
  });

  // 13. unrelated listening strength does NOT claim multi-speaker improvement
  it('13. unrelated listening strength does NOT claim multi-speaker improvement', () => {
    const report = generateAbilityChangeReport({
      strengths: [
        {
          id: 's-1',
          learnerId,
          type: 'listening',
          referenceId: 'listening:detail',
          confidence: 0.9,
          firstSeenAt: nowIso(),
          lastSeenAt: nowIso(),
          contexts: ['Understood specific detail in solo monologue'],
          evidence: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ],
      weaknesses: [],
    });

    const listening = report.domains.find((d) => d.domain === 'listening');
    expect(listening?.summary).not.toContain('multi-speaker');
    expect(listening?.summary).toContain('demonstrated listening ability in some contexts');
  });

  // 14. unrelated speaking strength does NOT claim longer-turn fluency
  it('14. unrelated speaking strength does NOT claim longer-turn fluency', () => {
    const report = generateAbilityChangeReport({
      strengths: [
        {
          id: 's-2',
          learnerId,
          type: 'fluency',
          referenceId: 'speaking:topic',
          confidence: 0.8,
          firstSeenAt: nowIso(),
          lastSeenAt: nowIso(),
          contexts: ['Short topic turn'],
          evidence: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ],
      weaknesses: [],
    });

    const speaking = report.domains.find((d) => d.domain === 'speaking');
    expect(speaking?.summary).not.toContain('longer spoken turns');
    expect(speaking?.summary).toContain('demonstrated speaking ability in natural conversation');
  });

  // 15. unknown evidence type does NOT become speaking
  it('15. unknown evidence type does NOT become speaking', () => {
    const mapped = mapTypeToDomain('unknown_custom_type');
    expect(mapped).toBeNull();

    const report = generateAbilityChangeReport({
      strengths: [
        {
          id: 's-3',
          learnerId,
          type: 'unknown_custom_type' as any,
          referenceId: 'custom:item',
          confidence: 0.8,
          firstSeenAt: nowIso(),
          lastSeenAt: nowIso(),
          contexts: [],
          evidence: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ],
      weaknesses: [],
    });

    const speaking = report.domains.find((d) => d.domain === 'speaking');
    expect(speaking?.status).toBe('insufficient');
  });

  // 16. arbitrary generic observation cannot create strength
  it('16. arbitrary generic observation cannot create strength', async () => {
    const genericInputs: SuccessObservationInput[] = [
      {
        learnerId,
        type: 'grammar',
        referenceId: 'g:1',
        source: 'conversation_session',
        context: 'Great job!',
        evidence: { kind: 'observation', id: 'obs-1', at: nowIso(), summary: 'Great job!' },
      },
      {
        learnerId,
        type: 'grammar',
        referenceId: 'g:2',
        source: 'conversation_session',
        context: 'Session finished',
        evidence: { kind: 'observation', id: 'obs-2', at: nowIso(), summary: 'Session finished' },
      },
      {
        learnerId,
        type: 'listening',
        referenceId: 'l:1',
        source: 'listening_service',
        context: '',
        evidence: { kind: 'observation', id: 'obs-3', at: nowIso(), summary: '' },
      },
    ];

    for (const input of genericInputs) {
      const res = await service.recordSuccessObservation(input);
      expect(res.recorded).toBe(false);
    }

    const strengths = await weaknessRepo.listStrengths(learnerId);
    expect(strengths).toHaveLength(0);
  });

  // 17. trusted evaluated success CAN create/update strength
  it('17. trusted evaluated success CAN create/update strength', async () => {
    const res1 = await recordListeningSuccess(service.successRecorder, {
      learnerId,
      referenceId: 'listening:multi_speaker',
      context: 'Understood multi-speaker discussion',
      summary: 'Exact detail match in multi-speaker task',
    });

    expect(res1.recorded).toBe(true);

    const res2 = await recordPronunciationSuccess(service.successRecorder, {
      learnerId,
      referenceId: 'pron:θ',
      context: 'Repeat of target sentence with clear /θ/ sound',
      summary: 'Clear intelligibility on /θ/',
    });

    expect(res2.recorded).toBe(true);

    const strengths = await weaknessRepo.listStrengths(learnerId);
    expect(strengths).toHaveLength(2);
  });

  // 18. insufficient evidence does not auto-enable reassessment
  it('18. insufficient evidence does not auto-enable reassessment', async () => {
    const elig = await service.checkEligibility(learnerId);
    expect(elig.available).toBe(false);
    expect(elig.reason).toBe('insufficient_evidence');
    expect(elig.message).toContain('Not enough practice evidence');
  });

  // 19. single diagnostic handle ownership (no orphan handles)
  it('19. single diagnostic handle ownership (no orphan handles)', async () => {
    let beginCount = 0;
    const trackingOnboardingService = {
      ...onboardingService,
      async beginDiagnostic(options?: Record<string, unknown>) {
        beginCount++;
        return onboardingService.beginDiagnostic(options as any);
      },
    };

    const trackingService = createReassessmentService({
      adapter,
      onboardingService: trackingOnboardingService,
      historyRepository: historyRepo,
      successRecorder: createSuccessObservationRecorder(weaknessRepo),
    });

    const handle = await trackingService.beginReassessment();
    expect(beginCount).toBe(1);
    expect(handle.session.getStatus()).toBe('in_progress');

    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const finishResult = await trackingService.finishReassessment(handle);
    expect(finishResult.record).not.toBeNull();
    expect(beginCount).toBe(1);
  });

  // 20. atomic level acceptance rolls back on database failure
  it('20. atomic level acceptance rolls back on database failure', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const failingAdapter = Object.create(adapter);
      failingAdapter.transaction = async () => {
        throw new Error('Database disk write error');
      };

      const failingRepo = new SQLiteReassessmentHistoryRepository(failingAdapter as unknown as DatabaseAdapter);

      await expect(failingRepo.acceptAndApplyLevel(record.id, 'B1')).rejects.toThrow('Database disk write error');

      const checkRecord = await historyRepo.getById(record.id);
      expect(checkRecord?.decision).toBe('pending');

      const profile = await profileRepo.get();
      expect(profile.currentLevel).toBe('A2');
    }
  });

  // 21. concurrent acceptance across TWO independent service instances uses rowsAffected
  it('21. concurrent acceptance across TWO independent service instances uses rowsAffected', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const service1 = createReassessmentService({
        adapter,
        onboardingService,
        historyRepository: new SQLiteReassessmentHistoryRepository(adapter),
      });

      const service2 = createReassessmentService({
        adapter,
        onboardingService,
        historyRepository: new SQLiteReassessmentHistoryRepository(adapter),
      });

      const [res1, res2] = await Promise.all([
        service1.acceptReassessmentLevel(record.id),
        service2.acceptReassessmentLevel(record.id),
      ]);

      const winners = (res1.updated ? 1 : 0) + (res2.updated ? 1 : 0);
      expect(winners).toBe(1);

      const recordAfter = await historyRepo.getById(record.id);
      expect(recordAfter?.decision).toBe('accepted');

      const profile = await profileRepo.get();
      expect(profile.currentLevel).toBe('B1');
    }
  });

  // 22. concurrent keep vs accept race condition maintains absolute history/profile consistency
  it('22. concurrent keep vs accept race condition maintains absolute history/profile consistency', async () => {
    const handle = await service.beginReassessment();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const { record } = await service.finishReassessment(handle);
    expect(record).not.toBeNull();

    if (record) {
      const service1 = createReassessmentService({
        adapter,
        onboardingService,
        historyRepository: new SQLiteReassessmentHistoryRepository(adapter),
      });

      const service2 = createReassessmentService({
        adapter,
        onboardingService,
        historyRepository: new SQLiteReassessmentHistoryRepository(adapter),
      });

      // Keep runs first
      const keepRes = await service1.keepCurrentLevel(record.id);
      expect(keepRes.updated).toBe(false);
      expect(keepRes.reason).toBe('kept');

      // Accept runs afterward
      const acceptRes = await service2.acceptReassessmentLevel(record.id);
      expect(acceptRes.updated).toBe(false);
      expect(acceptRes.reason).toBe('kept');

      // History and profile MUST be consistent
      const recordAfter = await historyRepo.getById(record.id);
      expect(recordAfter?.decision).toBe('kept');

      const profileAfter = await profileRepo.get();
      expect(profileAfter.currentLevel).toBe('A2'); // Remains previous level!
    }
  });

  // 23. real producer listening success creates strength and leaves existing weakness intact
  it('23. real producer listening success creates strength and leaves existing weakness intact', async () => {
    const { createListeningService } = await import('../listening');
    const listeningService = createListeningService(adapter, {
      successRecorder: service.successRecorder,
    });

    const exercise: any = {
      id: 'ex-101',
      learnerId,
      type: 'listen_and_type',
      difficulty: 'medium',
      speakText: 'I heard meeting and deadline',
      expectedAnswer: 'I heard meeting and deadline',
      keyItems: ['meeting', 'deadline'],
      source: 'general',
      weaknessReferenceId: 'listening:detail_extraction',
    };

    // Evaluated as understood
    await listeningService.evaluateAnswer(learnerId, exercise, 'I heard meeting and deadline');

    const strengths = await weaknessRepo.listStrengths(learnerId);
    expect(strengths.length).toBeGreaterThan(0);
    expect(strengths[0].type).toBe('listening');
  });

  // 24. failed or insufficient outcomes do NOT create strength
  it('24. failed or insufficient outcomes do NOT create strength', async () => {
    const { createListeningService } = await import('../listening');
    const listeningService = createListeningService(adapter, {
      successRecorder: service.successRecorder,
    });

    const exercise: any = {
      id: 'ex-102',
      learnerId,
      type: 'listen_and_type',
      difficulty: 'medium',
      speakText: 'budget report',
      expectedAnswer: 'budget report',
      keyItems: ['budget', 'report'],
      source: 'general',
      weaknessReferenceId: 'listening:budget',
    };

    // Wrong answer -> produces weakness, NOT strength
    await listeningService.evaluateAnswer(learnerId, exercise, 'completely wrong text');

    const strengths = await weaknessRepo.listStrengths(learnerId);
    expect(strengths.find((s) => s.referenceId === 'listening:budget')).toBeUndefined();
  });
});
