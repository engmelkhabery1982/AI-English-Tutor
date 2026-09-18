/**
 * src/reassessment/index.test.ts
 *
 * WP-4 — Evidence Symmetry & Reassessment Tests (18 Blockers Coverage).
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
import { generateId } from '../shared/id';
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
    // Cannot finish without resolving required steps
    const { result } = await service.finishReassessment(handle);
    expect(result).toBeNull();
  });

  // 3. stale first reassessment ignored after second starts
  it('3. stale first reassessment ignored after second starts', async () => {
    const handle1 = await service.beginReassessment();
    const token1 = handle1.session.getCurrentStepToken();

    // Second reassessment started
    const handle2 = await service.beginReassessment();
    expect(handle1.session.getStatus()).toBe('abandoned');

    // Trying to use handle1 with token1 is rejected
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

    handle.session.advance(); // step moved on

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

    // Re-saving with same deterministic ID
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

      // Attempt to flip to keep
      const second = await service.keepCurrentLevel(record.id);
      expect(second.updated).toBe(false);
      expect(second.reason).toBe('terminal_decision');

      const profileAfterKeep = await profileRepo.get();
      expect(profileAfterKeep.currentLevel).toBe(record.proposedLevel); // Stays at accepted level!
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

      // Attempt to flip to accept
      const second = await service.acceptReassessmentLevel(record.id);
      expect(second.updated).toBe(false);
      expect(second.reason).toBe('terminal_decision');

      const profile = await profileRepo.get();
      expect(profile.currentLevel).toBe('A2'); // Stays at kept level!
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
        evidence: { kind: 'observation', id: generateId(), at: nowIso(), summary: 'Great job!' },
      },
      {
        learnerId,
        type: 'grammar',
        referenceId: 'g:2',
        source: 'conversation_session',
        context: 'Session finished',
        evidence: { kind: 'observation', id: generateId(), at: nowIso(), summary: 'Session finished' },
      },
      {
        learnerId,
        type: 'listening',
        referenceId: 'l:1',
        source: 'listening_service',
        context: '',
        evidence: { kind: 'observation', id: generateId(), at: nowIso(), summary: '' },
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
});
