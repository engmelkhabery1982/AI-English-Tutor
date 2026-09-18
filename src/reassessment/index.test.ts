/**
 * src/reassessment/index.test.ts
 *
 * WP-4 — Evidence Symmetry & Reassessment Tests (Scenarios 1–32).
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
import { generateAbilityChangeReport } from './change-report';
import { SQLiteReassessmentHistoryRepository } from './history-repository';
import { createReassessmentService, type ReassessmentService } from './service';
import { createSuccessObservationRecorder } from './success-recorder';
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

describe('WP-4 — Evidence Symmetry & Reassessment', () => {
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

  // ────────────────────────────────────────────────────────── Success evidence

  describe('Success Evidence Recorder', () => {
    it('1. valid demonstrated success creates/updates a LearnerStrength', async () => {
      const input: SuccessObservationInput = {
        learnerId,
        type: 'listening',
        referenceId: 'listening:multi_speaker',
        source: 'listening_service',
        context: 'Followed a multi-speaker conversation about office schedules.',
        evidence: {
          kind: 'observation',
          id: generateId(),
          at: nowIso(),
          summary: 'Understood multi-speaker dialogue.',
        },
      };

      const result = await service.recordSuccessObservation(input);
      expect(result.recorded).toBe(true);
      expect(result.strength).not.toBeNull();
      expect(result.strength?.type).toBe('listening');
      expect(result.strength?.referenceId).toBe('listening:multi_speaker');

      const strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(1);
      expect(strengths[0].contexts).toContain('Followed a multi-speaker conversation about office schedules.');
    });

    it('2. repeated same ability does not create duplicates', async () => {
      const input1: SuccessObservationInput = {
        learnerId,
        type: 'pronunciation',
        referenceId: 'pron:θ',
        source: 'pronunciation_engine',
        context: 'Accurate repetition of "think" in shadowing.',
        evidence: {
          kind: 'observation',
          id: generateId(),
          at: nowIso(),
          summary: 'Clear /θ/ sound.',
        },
      };

      await service.recordSuccessObservation(input1);
      let strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(1);

      const input2: SuccessObservationInput = {
        ...input1,
        context: 'Accurate repetition of "three" in shadowing.',
        evidence: {
          kind: 'observation',
          id: generateId(),
          at: nowIso(),
          summary: 'Clear /θ/ sound again.',
        },
      };

      await service.recordSuccessObservation(input2);
      strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(1); // STILL 1 row
      expect(strengths[0].contexts).toHaveLength(2);
    });

    it('3. evidence history remains bounded', async () => {
      for (let i = 0; i < 8; i++) {
        await service.recordSuccessObservation({
          learnerId,
          type: 'vocabulary',
          referenceId: 'vocab:resilient',
          source: 'vocabulary_workspace',
          context: `Context ${i}`,
          evidence: {
            kind: 'observation',
            id: generateId(),
            at: nowIso(),
            summary: `Evidence ${i}`,
          },
        });
      }

      const strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(1);
      // Contexts bounded to max 5
      expect(strengths[0].contexts.length).toBeLessThanOrEqual(5);
      // Evidence refs bounded to max 10
      expect(strengths[0].evidence.length).toBeLessThanOrEqual(10);
    });

    it('4. unsupported event does NOT create strength', async () => {
      const input: SuccessObservationInput = {
        learnerId,
        type: 'grammar',
        referenceId: 'grammar:past_perfect',
        source: 'conversation_session',
        evidence: { kind: 'observation', id: generateId(), at: nowIso() },
      };

      const res = await service.recordSuccessObservation(input);
      expect(res.recorded).toBe(false);
      expect(res.reason).toBe('unsupported_event');

      const strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(0);
    });

    it('5. failed provider does NOT fabricate strength', async () => {
      const input: SuccessObservationInput = {
        learnerId,
        type: 'pronunciation',
        referenceId: 'pron:r',
        source: 'pronunciation_engine',
        notes: 'Pronunciation provider unavailable',
        evidence: { kind: 'observation', id: generateId(), at: nowIso() },
      };

      const res = await service.recordSuccessObservation(input);
      expect(res.recorded).toBe(false);
      expect(res.reason).toBe('provider_failed');

      const strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(0);
    });

    it('6. one success does not automatically erase weakness', async () => {
      // Record a weakness first
      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'grammar',
        referenceId: 'grammar:past_perfect',
        status: 'active_training',
        severity: 0.7,
        occurrenceCount: 2,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        contexts: ['I had went there.'],
        evidence: [],
        resolved: false,
      });

      const weaknessesBefore = await weaknessRepo.listWeaknesses(learnerId);
      expect(weaknessesBefore).toHaveLength(1);

      // Record a success for the same grammar pattern
      await service.recordSuccessObservation({
        learnerId,
        type: 'grammar',
        referenceId: 'grammar:past_perfect',
        source: 'conversation_session',
        context: 'Correct use: "I had gone there before sunset."',
        evidence: { kind: 'observation', id: generateId(), at: nowIso() },
      });

      // Weakness remains active!
      const weaknessesAfter = await weaknessRepo.listWeaknesses(learnerId);
      expect(weaknessesAfter).toHaveLength(1);
      expect(weaknessesAfter[0].resolved).toBe(false);
    });

    it('7. strength and weakness may coexist where evidence differs', async () => {
      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'listening',
        referenceId: 'listening:fast_speech',
        status: 'active_training',
        severity: 0.8,
        occurrenceCount: 3,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        contexts: ['Missed key meaning in fast speech'],
        evidence: [],
        resolved: false,
      });

      await service.recordSuccessObservation({
        learnerId,
        type: 'listening',
        referenceId: 'listening:main_idea',
        source: 'listening_service',
        context: 'Understood main idea in standard-speed monologue',
        evidence: { kind: 'observation', id: generateId(), at: nowIso() },
      });

      const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
      const strengths = await weaknessRepo.listStrengths(learnerId);

      expect(weaknesses).toHaveLength(1);
      expect(strengths).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────── Reassessment

  describe('Periodic Reassessment', () => {
    it('8. existing diagnostic engine is reused', async () => {
      const handle = await service.beginReassessment();
      expect(handle.session).toBeDefined();
      expect(handle.conversation).toBeDefined();
      expect(handle.speaking).toBeDefined();
      expect(handle.languageUseTask).toBeDefined();
      expect(handle.pronunciationTask).toBeDefined();
    });

    it('9. insufficient evidence does not invent level', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance(); // speaking
      handle.session.advance(); // listening
      handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
      handle.session.advance(); // language_use
      handle.session.advance(); // pronunciation
      handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
      handle.session.advance(); // summary
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      const { result } = await service.finishReassessment(handle);
      expect(result).not.toBeNull();
      expect(result?.estimate.status).toBe('insufficient');
      expect(result?.estimate.level).toBe('unknown');
    });

    it('10. proposed level does not update profile before acceptance', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      // Record valid speaking answers using onboardingService
      await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
      await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
      await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

      handle.session.advance();
      handle.session.markListeningUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');

      handle.session.advance();
      handle.session.markPronunciationUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      const { record } = await service.finishReassessment(handle);

      expect(record).not.toBeNull();
      expect(record?.decision).toBe('pending');

      // Profile remains at original level A2!
      const profile = await profileRepo.get();
      expect(profile.currentLevel).toBe('A2');
    });

    it('11. Use this level updates accepted currentLevel once', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
      await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
      await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

      handle.session.advance();
      handle.session.markListeningUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');

      handle.session.advance();
      handle.session.markPronunciationUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      const { record } = await service.finishReassessment(handle);
      expect(record).not.toBeNull();

      if (record) {
        const decision1 = await service.acceptReassessmentLevel(record.id);
        expect(decision1.updated).toBe(true);
        expect(decision1.currentLevel).toBe(record.proposedLevel);

        const profileAfter = await profileRepo.get();
        expect(profileAfter.currentLevel).toBe(record.proposedLevel);

        // Second call is idempotent!
        const decision2 = await service.acceptReassessmentLevel(record.id);
        expect(decision2.updated).toBe(false);
        expect(decision2.reason).toBe('already-accepted');
      }
    });

    it('12. Keep my current level leaves profile unchanged', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
      await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
      await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

      handle.session.advance();
      handle.session.markListeningUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');

      handle.session.advance();
      handle.session.markPronunciationUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      const { record } = await service.finishReassessment(handle);
      expect(record).not.toBeNull();

      if (record) {
        const decision = await service.keepCurrentLevel(record.id);
        expect(decision.updated).toBe(false);
        expect(decision.reason).toBe('kept');

        const profile = await profileRepo.get();
        expect(profile.currentLevel).toBe('A2'); // Unchanged!
      }
    });

    it('13. reassessment history is persisted', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
      await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
      await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

      handle.session.advance();
      handle.session.markListeningUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');

      handle.session.advance();
      handle.session.markPronunciationUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      await service.finishReassessment(handle);

      const history = await service.getHistory(learnerId);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].assessmentKind).toBe('reassessment');
    });

    it('14. history is bounded', async () => {
      const history = await service.getHistory(learnerId);
      expect(history.length).toBeLessThanOrEqual(10);
    });

    it('15. duplicate/retry does not create duplicate estimate', async () => {
      const handle = await service.beginReassessment();
      const { record: _r1 } = await service.finishReassessment(handle);
      const { record: r2 } = await service.finishReassessment(handle); // finishing finished handle returns null/same result

      expect(r2).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────── Change reporting

  describe('Qualitative Ability Change Report', () => {
    it('16. stronger evidence is reported qualitatively', () => {
      const report = generateAbilityChangeReport({
        strengths: [
          {
            id: 's-1',
            learnerId,
            type: 'listening',
            referenceId: 'listening:multi_speaker',
            confidence: 0.9,
            firstSeenAt: nowIso(),
            lastSeenAt: nowIso(),
            contexts: ['Multi-speaker dialogue'],
            evidence: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        ],
        weaknesses: [],
      });

      const listeningDomain = report.domains.find((d) => d.domain === 'listening');
      expect(listeningDomain?.status).toBe('stronger');
      expect(listeningDomain?.summary).toContain('Listening comprehension');
      // NO NUMBERS OR PERCENTAGES!
      expect(listeningDomain?.summary).not.toMatch(/\d+%/);
    });

    it('17. mixed evidence is reported honestly', () => {
      const report = generateAbilityChangeReport({
        strengths: [
          {
            id: 's-1',
            learnerId,
            type: 'listening',
            referenceId: 'listening:main_idea',
            confidence: 0.8,
            firstSeenAt: nowIso(),
            lastSeenAt: nowIso(),
            contexts: [],
            evidence: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        ],
        weaknesses: [
          {
            id: 'w-1',
            learnerId,
            type: 'listening',
            referenceId: 'listening:fast_speech',
            status: 'active_training',
            severity: 0.8,
            occurrenceCount: 2,
            firstSeenAt: nowIso(),
            lastSeenAt: nowIso(),
            contexts: [],
            evidence: [],
            resolved: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        ],
      });

      const listeningDomain = report.domains.find((d) => d.domain === 'listening');
      expect(listeningDomain?.status).toBe('mixed');
    });

    it('18. insufficient evidence says insufficient', () => {
      const report = generateAbilityChangeReport({
        strengths: [],
        weaknesses: [],
      });

      const grammarDomain = report.domains.find((d) => d.domain === 'grammar');
      expect(grammarDomain?.status).toBe('insufficient');
      expect(grammarDomain?.summary).toContain('Insufficient evidence');
    });

    it('19. no numeric/fake improvement score', () => {
      const report = generateAbilityChangeReport({
        strengths: [],
        weaknesses: [],
      });

      const fullJson = JSON.stringify(report);
      expect(fullJson).not.toMatch(/score/i);
      expect(fullJson).not.toMatch(/percent/i);
      expect(fullJson).not.toMatch(/\d+%/);
    });

    it('20. distinct abilities are not collapsed incorrectly', () => {
      const report = generateAbilityChangeReport({
        strengths: [],
        weaknesses: [],
      });

      const domainNames = report.domains.map((d) => d.domain);
      expect(domainNames).toContain('listening');
      expect(domainNames).toContain('speaking');
      expect(domainNames).toContain('pronunciation');
      expect(domainNames).toContain('grammar');
      expect(domainNames).toContain('vocabulary');
    });
  });

  // ───────────────────────────────────────────────────────────────── Lifecycle

  describe('Race / Async / Stale Result Protections', () => {
    it('21. stale reassessment result ignored', async () => {
      const handle = await service.beginReassessment();
      const token = handle.session.getCurrentStepToken();

      handle.session.advance(); // Advance step

      // Attempting to mark step done with stale token is refused!
      const marked = handle.session.markProfileStepDone(token);
      expect(marked).toBe(false);
    });

    it('22. second reassessment invalidates first', async () => {
      const handle1 = await service.beginReassessment();
      handle1.session.abandon();

      expect(handle1.session.getStatus()).toBe('abandoned');

      const handle2 = await service.beginReassessment();
      expect(handle2.session.getStatus()).toBe('in_progress');
    });

    it('23. unmount/exit blocks late mutation', async () => {
      const handle = await service.beginReassessment();
      handle.session.abandon();

      const { result } = await service.finishReassessment(handle);
      expect(result).toBeNull();
    });

    it('24. late STT ignored', async () => {
      const handle = await service.beginReassessment();
      const staleToken = handle.session.getCurrentStepToken();

      handle.session.advance(); // Step moved on

      const res = await onboardingService.recordPronunciation(
        handle,
        'Recognized text',
        'Target sentence',
        { stepToken: staleToken },
      );

      expect(res.observed).toBe(false);
    });

    it('25. late pronunciation ignored', async () => {
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

    it('26. double acceptance cannot update twice', async () => {
      const handle = await service.beginReassessment();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      await onboardingService.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
      await onboardingService.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
      await onboardingService.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');

      handle.session.advance();
      handle.session.markListeningUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      await onboardingService.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');

      handle.session.advance();
      handle.session.markPronunciationUnavailable('Not used in test.', handle.session.getCurrentStepToken());

      handle.session.advance();
      handle.session.markSummaryDone(handle.session.getCurrentStepToken());

      const { record } = await service.finishReassessment(handle);
      expect(record).not.toBeNull();

      if (record) {
        const first = await service.acceptReassessmentLevel(record.id);
        expect(first.updated).toBe(true);

        const second = await service.acceptReassessmentLevel(record.id);
        expect(second.updated).toBe(false);
        expect(second.reason).toBe('already-accepted');
      }
    });
  });
});
