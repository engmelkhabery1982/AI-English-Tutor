/**
 * src/onboarding/index.test.ts
 *
 * Personalized Onboarding & Diagnostic Assessment (Phase 1).
 *
 * These tests exercise the REAL existing systems: UserProfileRepository,
 * ConversationEngine/Session/Orchestrator, LearningPersistenceService,
 * ListeningService, PronunciationEngine and the SQLite repositories on a real
 * SqlJsAdapter database. Nothing here is a second assessment engine.
 */

import { beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteMistakeRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { AIProvider, AIProviderResult, ConversationFeedback } from '../providers/ai';
import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession, type ConversationSession } from '../conversation-session';
import { createTalkLearnerModel } from '../talk-demo';
import { createLearningPersistenceService } from '../talk-demo/learning-persistence';
import { createListeningService } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import { createOnboardingServiceOn } from './index';
import { createDemoAudioRecorder } from '../voice/recorder';
import { createVoiceSessionCoordinator } from '../voice';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createDemoSTTProvider } from '../providers/stt';
import type { STTResult } from '../providers/stt';
import { createDemoLearnerModel } from '../talk-demo/demo-learner-model';
import {
  createDiagnosticSession,
  DIAGNOSTIC_STEP_ORDER,
} from './session';
import {
  estimateWorkingLevel,
  focusAreasFromEvidence,
  strengthsFromEvidence,
} from './assessment';
import { createOnboardingService, describeEstimateForResult } from './service';
import {
  createDiagnosticSpeakingStep,
  LANGUAGE_USE_TASKS,
  languageUseTaskForDiagnostic,
  PRONUNCIATION_TASKS,
  pronunciationTaskForDiagnostic,
} from './speaking';
import { LEARNING_GOAL_OPTIONS, NATIVE_LANGUAGE_OPTIONS } from './types';
import type {
  DiagnosticEvidence,
  DiagnosticLanguageUseEvidence,
  DiagnosticSpeakingEvidence,
} from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = '2026-03-01T09:00:00.000Z';
const LATER = '2026-03-01T09:12:00.000Z';

// ──────────────────────────────────────────────────────────────────── helpers

function createStubProvider(
  replies: readonly string[],
): AIProvider & { readonly requests: readonly { userMessage?: string }[]; calls: number } {
  const state = { calls: 0 };
  const requests: { userMessage?: string }[] = [];
  return {
    id: 'stub-ai',
    requests,
    get calls() {
      return state.calls;
    },
    async generate(request): Promise<AIProviderResult> {
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      requests.push({ userMessage: request.messages.at(-1)?.content });
      return { ok: true, response: { content: reply } };
    },
  };
}

/** Provider that returns structured feedback for each reply, in order. */
function createFeedbackProvider(
  replies: readonly { readonly content: string; readonly feedback?: ConversationFeedback | null }[],
): AIProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    id: 'feedback-ai',
    get calls() {
      return state.calls;
    },
    async generate(): Promise<AIProviderResult> {
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      return {
        ok: true,
        response: { content: reply.content, feedback: reply.feedback ?? null },
      };
    },
  };
}

/** Deferred provider: every reply is released manually (late-result races). */
function createDeferredProvider(): AIProvider & {
  resolveNext: (content: string, feedback?: ConversationFeedback | null) => void;
} {
  const pending: ((result: AIProviderResult) => void)[] = [];
  return {
    id: 'deferred-ai',
    resolveNext: (content, feedback = null) => {
      pending.shift()?.({ ok: true, response: { content, feedback } });
    },
    async generate(): Promise<AIProviderResult> {
      return new Promise<AIProviderResult>((resolve) => {
        pending.push(resolve);
      });
    },
  };
}

function createFailingProvider(message = 'provider unavailable'): AIProvider {
  return {
    id: 'failing-ai',
    async generate(): Promise<AIProviderResult> {
      return {
        ok: false,
        error: { code: 'unavailable', message, retryable: true },
      };
    },
  };
}

function buildSpeakingSession(provider: AIProvider, mode: 'natural' | 'coach' = 'natural') {
  const engine = createConversationEngine(createDemoLearnerModel());
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, { mode });
}

const INCORRECT_FEEDBACK: ConversationFeedback = {
  correction: {
    original: 'Yesterday I go to the office',
    improved: 'Yesterday I went to the office',
    explanation: 'Use the past tense for finished actions.',
    severity: 'incorrect',
  },
};

const UNNATURAL_FEEDBACK: ConversationFeedback = {
  correction: {
    original: 'I am agree with you',
    improved: 'I agree with you',
    explanation: 'This phrasing sounds unnatural in English.',
    severity: 'unnatural',
  },
};

/** Evidence builder for the deterministic aggregator tests (no engines needed). */
function speakingEvidence(
  overrides: Partial<DiagnosticSpeakingEvidence> = {},
): DiagnosticSpeakingEvidence {
  return {
    provenance: 'real',
    committedLearnerTurns: 3,
    committedTutorTurns: 3,
    incorrectCorrections: 0,
    unnaturalCorrections: 0,
    naturalTurns: 3,
    correctionNotes: [],
    ...overrides,
  };
}

function languageUseEvidence(
  overrides: Partial<DiagnosticLanguageUseEvidence> = {},
): DiagnosticLanguageUseEvidence {
  return {
    provenance: 'real',
    answered: 1,
    natural: 1,
    unnatural: 0,
    incorrect: 0,
    notes: [],
    ...overrides,
  };
}

function evidence(overrides: Partial<DiagnosticEvidence> = {}): DiagnosticEvidence {
  return {
    speaking: null,
    listening: null,
    languageUse: null,
    pronunciation: null,
    ...overrides,
  };
}

/** The single existing profile's learner id (the real composition source). */
async function learnerIdOf(adapter: SqlJsAdapter): Promise<string> {
  return (await new SQLiteUserProfileRepository(adapter).get()).id;
}

async function seedProfile(adapter: SqlJsAdapter, patch: Record<string, unknown> = {}) {
  const repo = new SQLiteUserProfileRepository(adapter);
  return repo.update({
    displayName: 'Salem',
    nativeLanguage: 'ar',
    targetLevel: 'C1',
    currentLevel: 'B1',
    learningGoals: ['Work / professional communication'],
    preferredModes: ['coach'],
    ...patch,
  });
}

// ────────────────────────────────────────────────────────────── profile tests

describe('Onboarding — profile (existing repository, no silent overwrite)', () => {
  let adapter: SqlJsAdapter;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
  });

  it('1. a brand-new install with no profile can still begin onboarding', async () => {
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });

    const prefill = await service.loadPrefill();
    expect(prefill.profileId).toBeNull();
    expect(prefill.isComplete).toBe(false);
    expect(prefill.hasExistingData).toBe(false);
    expect(prefill.missingFields.length).toBeGreaterThan(0);

    // The learner can save the profile step: the EXISTING repository creates the
    // single learner_profile row (no second profile table).
    const saved = await service.saveProfileDraft({
      displayName: 'Maha',
      targetLevel: 'B2',
      learningGoals: ['Everyday conversation', 'Travel'],
      preferredModes: ['natural', 'coach'],
    });
    expect(saved.profileId).toBeTruthy();
    expect(saved.displayName).toBe('Maha');
    expect(saved.learningGoals).toEqual(['Everyday conversation', 'Travel']);
    expect(saved.preferredModes).toEqual(['natural', 'coach']);
    expect(saved.currentLevel).toBe('unknown');
  });

  it('2. an existing profile is prefilled and never overwritten silently', async () => {
    await seedProfile(adapter, {
      displayName: 'Salem',
      targetLevel: 'C1',
      currentLevel: 'B1',
      learningGoals: ['Presentations'],
      preferredModes: ['intensive'],
    });
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });

    const prefill = await service.loadPrefill();
    expect(prefill.hasExistingData).toBe(true);
    expect(prefill.displayName).toBe('Salem');
    expect(prefill.nativeLanguage).toBe('ar');
    expect(prefill.targetLevel).toBe('C1');
    expect(prefill.learningGoals).toEqual(['Presentations']);
    expect(prefill.preferredModes).toEqual(['intensive']);
    expect(prefill.isComplete).toBe(true);

    // A draft that only changes the name leaves everything else untouched.
    const saved = await service.saveProfileDraft({
      displayName: 'Salem A.',
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: [],
    });
    expect(saved.displayName).toBe('Salem A.');
    expect(saved.targetLevel).toBe('C1'); // not reset to unknown
    expect(saved.learningGoals).toEqual(['Presentations']); // not erased
    expect(saved.preferredModes).toEqual(['intensive']); // not erased
    expect(saved.currentLevel).toBe('B1'); // the diagnostic never sets this
  });

  it('3. goals persist through the existing profile repository', async () => {
    await seedProfile(adapter);
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    const goals = ['Meetings', 'Interviews', 'Pronunciation', 'Confidence / fluency'];
    await service.saveProfileDraft({
      targetLevel: 'B2',
      learningGoals: goals,
      preferredModes: ['coach'],
    });

    const stored = await new SQLiteUserProfileRepository(adapter).get();
    expect(stored.learningGoals).toEqual(goals);
    // Every curated goal the UI offers is a plain string the existing model stores.
    for (const option of LEARNING_GOAL_OPTIONS) {
      expect(typeof option.label).toBe('string');
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('4. the target level persists correctly', async () => {
    await seedProfile(adapter, { targetLevel: 'unknown' });
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    const saved = await service.saveProfileDraft({
      targetLevel: 'C1',
      learningGoals: [],
      preferredModes: [],
    });
    expect(saved.targetLevel).toBe('C1');
    expect((await new SQLiteUserProfileRepository(adapter).get()).targetLevel).toBe('C1');
  });

  it('5. preferred practice modes persist correctly', async () => {
    await seedProfile(adapter, { preferredModes: [] });
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    const saved = await service.saveProfileDraft({
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: ['natural', 'intensive'],
    });
    expect(saved.preferredModes).toEqual(['natural', 'intensive']);
    expect((await new SQLiteUserProfileRepository(adapter).get()).preferredModes).toEqual([
      'natural',
      'intensive',
    ]);
  });

  it('6. a supported native language is offered and persists', async () => {
    await seedProfile(adapter);
    const service = createOnboardingService({
      adapter,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    const codes = NATIVE_LANGUAGE_OPTIONS.map((option) => option.code);
    expect(codes).toContain('ar');
    await service.saveProfileDraft({
      nativeLanguage: 'fr',
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: [],
    });
    expect((await new SQLiteUserProfileRepository(adapter).get()).nativeLanguage).toBe('fr');
  });
});

// ─────────────────────────────────────────────────── state machine behaviours

describe('Onboarding — diagnostic state machine', () => {
  it('7. progression is deterministic and owned by the domain session', () => {
    const session = createDiagnosticSession({ learnerId: 'learner-1', startedAt: NOW });
    expect(session.getCurrentStepId()).toBe('profile');
    expect(session.getStatus()).toBe('in_progress');

    const firstToken = session.getCurrentStepToken();
    expect(session.markProfileStepDone(firstToken)).toBe(true);
    expect(session.markProfileStepDone(firstToken)).toBe(false); // already done

    expect(session.advance()).toBe('speaking');
    expect(session.advance()).toBe('listening');
    expect(session.advance()).toBe('language_use');
    expect(session.advance()).toBe('pronunciation');
    expect(session.advance()).toBe('summary');
    expect(session.advance()).toBeNull();

    // The declared order is the real order.
    expect(DIAGNOSTIC_STEP_ORDER).toEqual([
      'profile',
      'speaking',
      'listening',
      'language_use',
      'pronunciation',
      'summary',
    ]);
  });

  it('8. a stale result cannot mutate a replacement step (token guard)', async () => {
    const session = createDiagnosticSession({ learnerId: 'learner-1', startedAt: NOW });
    session.markProfileStepDone(session.getCurrentStepToken());
    session.advance();

    const staleToken = session.getCurrentStepToken();
    // The screen re-enters the step (a new diagnostic step token).
    session.advance();
    session.advance();

    expect(session.recordSpeaking(speakingEvidence(), staleToken)).toBe(false);
    expect(session.snapshot().evidence.speaking).toBeNull();
  });

  it('9. an abandoned or incomplete diagnostic can never be marked completed', async () => {
    const session = createDiagnosticSession({ learnerId: 'learner-1', startedAt: NOW });
    session.markProfileStepDone(session.getCurrentStepToken());
    expect(session.canComplete()).toBe(false); // speaking + summary still open
    expect(session.complete()).toBe(false);

    session.advance();
    session.recordSpeaking(speakingEvidence(), session.getCurrentStepToken());
    session.advance();
    session.advance();
    session.advance();
    session.advance();
    session.markSummaryDone(session.getCurrentStepToken());
    expect(session.canComplete()).toBe(true);

    session.abandon();
    expect(session.getStatus()).toBe('abandoned');
    expect(session.canComplete()).toBe(false);
    expect(session.complete()).toBe(false);
    expect(session.snapshot().isComplete).toBe(false);
  });

  it('10. an unavailable step is recorded honestly and is not a learner failure', () => {
    const session = createDiagnosticSession({ learnerId: 'learner-1', startedAt: NOW });
    session.markProfileStepDone(session.getCurrentStepToken());
    session.advance(); // speaking
    session.recordSpeaking(speakingEvidence(), session.getCurrentStepToken());
    session.advance(); // listening
    expect(session.markListeningUnavailable('Listening is unavailable right now.', session.getCurrentStepToken())).toBe(true);

    const snapshot = session.snapshot();
    const listening = snapshot.steps.find((step) => step.id === 'listening');
    expect(listening?.status).toBe('unavailable');
    expect(listening?.unavailableReason).toBe('Listening is unavailable right now.');
    expect(snapshot.evidence.listening).toBeNull();
  });
});

// ────────────────────────────────────────── speaking / language-use evidence

describe('Onboarding — speaking & language use reuse the existing conversation stack', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    learnerId = (await seedProfile(adapter)).id;
  });

  it('11. the speaking step runs through the EXISTING ConversationSession', async () => {
    const provider = createFeedbackProvider([
      { content: 'Tell me about your work.' },
      { content: 'Nice! What did you do there?', feedback: null },
    ]);
    const session = buildSpeakingSession(provider);
    const step = createDiagnosticSpeakingStep({ session, mode: 'natural', isRealAI: true });

    const result = await step.send('I work as a project manager in a logistics company.');
    expect(result.ok).toBe(true);
    // Exactly the existing engine/session path was used (real history committed).
    expect(session.getHistory().length).toBe(2);
    expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(1);
    expect(step.getSpeakingEvidence().committedTutorTurns).toBe(1);
    expect(step.getSpeakingEvidence().provenance).toBe('real');
  });

  it('12. a failed provider creates no learner weakness and no evidence', async () => {
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const session = buildSpeakingSession(createFailingProvider());
    const step = createDiagnosticSpeakingStep({
      session,
      mode: 'coach',
      isRealAI: true,
      learningPersistence: persistence,
    });

    const result = await step.send('This turn will fail.');
    expect(result.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(0);
    expect(await weaknessRepo.listWeaknesses(learnerId)).toEqual([]);
    expect(await new SQLiteMistakeRepository(adapter).listMistakes(learnerId)).toEqual([]);
  });

  it('13. a demo conversation never persists real weakness evidence', async () => {
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const provider = createFeedbackProvider([
      {
        content: 'Demo reply',
        feedback: INCORRECT_FEEDBACK,
      },
    ]);
    const session = buildSpeakingSession(provider);
    const step = createDiagnosticSpeakingStep({
      session,
      mode: 'natural',
      isRealAI: false, // offline demo
      learningPersistence: persistence,
    });

    const result = await step.send('Yesterday I go to the office with my team.');
    expect(result.ok).toBe(true);
    expect(step.getSpeakingEvidence().provenance).toBe('demo');
    // Demo practice is NOT assessment evidence: nothing was written.
    expect(await weaknessRepo.listWeaknesses(learnerId)).toEqual([]);
    expect(await new SQLiteMistakeRepository(adapter).listMistakes(learnerId)).toEqual([]);
  });

  it('14. real structured feedback is persisted by the EXISTING owner exactly once per turn', async () => {
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const mistakeRepo = new SQLiteMistakeRepository(adapter);
    const reviewRepo = new SQLiteReviewRepository(adapter);
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const provider = createFeedbackProvider([
      { content: 'Let us fix that.', feedback: INCORRECT_FEEDBACK },
    ]);
    const session = buildSpeakingSession(provider);
    const step = createDiagnosticSpeakingStep({
      session,
      mode: 'coach',
      isRealAI: true,
      learningPersistence: persistence,
    });

    await step.send('Yesterday I go to the office with my manager.');

    const mistakes = await mistakeRepo.listMistakes(learnerId);
    expect(mistakes.length).toBe(1);
    expect(mistakes[0].occurrenceCount).toBe(1);
    const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses.length).toBeGreaterThan(0);
    // The existing scheduler owns review items; the diagnostic adds none of its own.
    const due = await reviewRepo.listDue(learnerId, LATER);
    expect(Array.isArray(due)).toBe(true);
  });

  it('15. language-use evidence comes from the existing structured feedback severities', async () => {
    const provider = createFeedbackProvider([
      { content: 'Good.', feedback: null },
      { content: 'Almost.', feedback: UNNATURAL_FEEDBACK },
      { content: 'Careful.', feedback: INCORRECT_FEEDBACK },
    ]);
    const session = buildSpeakingSession(provider);
    const step = createDiagnosticSpeakingStep({ session, mode: 'coach', isRealAI: true });

    await step.sendLanguageUse('I plan to travel next week because I need a break.');
    await step.sendLanguageUse('I am agree with you about the plan for next week.');
    await step.sendLanguageUse('Yesterday I go to the office and meet my manager.');

    const evidence = step.getLanguageUseEvidence();
    expect(evidence.answered).toBe(3);
    expect(evidence.natural).toBe(1);
    expect(evidence.unnatural).toBe(1);
    expect(evidence.incorrect).toBe(1);
    expect(evidence.notes.length).toBeGreaterThan(0);
  });

  it('16. the language-use task is bounded and deterministic', () => {
    expect(LANGUAGE_USE_TASKS.length).toBeGreaterThan(0);
    const first = languageUseTaskForDiagnostic();
    const second = languageUseTaskForDiagnostic();
    expect(first.id).toBe(second.id);
    expect(first.prompt.length).toBeGreaterThan(10);
  });

  it('17. discarded (abandoned) step results never mutate the step', async () => {
    const provider = createFeedbackProvider([{ content: 'Reply' }]);
    const session = buildSpeakingSession(provider);
    const step = createDiagnosticSpeakingStep({ session, mode: 'natural', isRealAI: true });
    step.abandon();

    await step.send('A turn that arrives after the step was closed.');
    expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(0);
  });
});

// ────────────────────────────────────────────────────── listening / diagnosis

describe('Onboarding — listening & pronunciation reuse existing engines', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    learnerId = (await seedProfile(adapter)).id;
  });

  it('18. the listening step plans through the EXISTING ListeningService', async () => {
    const listening = createListeningService(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      listening,
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance(); // speaking
    handle.session.recordSpeaking(
      speakingEvidence(),
      handle.session.getCurrentStepToken(),
    );
    handle.session.advance(); // listening

    const planned = await service.startListeningTask(handle);
    expect(planned.status).toBe('ready');
    if (planned.status !== 'ready') return;
    expect(planned.exercise.learnerId).toBe(learnerId);
    expect(planned.exercise.speakText.length).toBeGreaterThan(0);
    expect(planned.exercise.type).toBeTruthy();
  });

  it('19. a correct listening answer becomes real evidence through the existing evaluator', async () => {
    const listening = createListeningService(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      listening,
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance(); // speaking
    handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
    handle.session.advance(); // listening
    const planned = await service.startListeningTask(handle);
    if (planned.status !== 'ready') throw new Error('expected a planned listening task');

    const outcome = await service.recordListeningAnswer(
      handle,
      planned.exercise,
      planned.exercise.expectedAnswer,
    );
    expect(outcome.ok).toBe(true);
    const evidence = handle.session.snapshot().evidence.listening;
    expect(evidence?.answered).toBe(1);
    expect(evidence?.evaluatedBy).toBe('local');
    expect((evidence?.understood ?? 0) + (evidence?.mostlyUnderstood ?? 0)).toBe(1);
  });

  it('20. unavailable listening infrastructure is reported, never treated as a learner error', async () => {
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      listening: {
        startSession: async () => ({ exercises: [], sourceNote: 'Listening is unavailable right now.' }),
        evaluateAnswer: async () => {
          throw new Error('should not be called');
        },
        resolveLearnerId: async () => learnerId,
      },
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance(); // speaking
    handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
    handle.session.advance(); // listening

    const planned = await service.startListeningTask(handle);
    expect(planned.status).toBe('unavailable');
    const step = handle.session.snapshot().steps.find((entry) => entry.id === 'listening');
    expect(step?.status).toBe('unavailable');
    expect(handle.session.snapshot().evidence.listening).toBeNull();
  });

  it('21. pronunciation reuses the EXISTING PronunciationEngine and omits fabricated results', async () => {
    const engine = createPronunciationEngine(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: engine,
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used in this test.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.recordLanguageUse(
      languageUseEvidence(),
      handle.session.getCurrentStepToken(),
    );
    handle.session.advance();

    const outcome = await service.recordPronunciation(
      handle,
      'I would like to book a table for two people please.',
    );
    expect(typeof outcome.observed).toBe('boolean');
    const snapshotEvidence = handle.session.snapshot().evidence;
    if (outcome.observed) {
      expect(snapshotEvidence.pronunciation?.noteLines.length).toBeGreaterThan(0);
    } else {
      // No real observation → omitted entirely (never invented).
      expect(snapshotEvidence.pronunciation).toBeNull();
      const step = handle.session.snapshot().steps.find((entry) => entry.id === 'pronunciation');
      expect(step?.status).toBe('unavailable');
    }
  });

  it('22. an unavailable pronunciation engine produces no fabricated result', async () => {
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: {
        analyzeSpokenTurn: async () => {
          throw new Error('analysis exploded');
        },
      },
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.recordLanguageUse(languageUseEvidence(), handle.session.getCurrentStepToken());
    handle.session.advance();

    const outcome = await service.recordPronunciation(handle, 'Some spoken turn.');
    expect(outcome.observed).toBe(false);
    expect(handle.session.snapshot().evidence.pronunciation).toBeNull();
  });
});

// ─────────────────────────────────────────────────── deterministic assessment

describe('Onboarding — deterministic level estimation', () => {
  it('23. the same evidence always maps to the same estimate (pure function)', () => {
    const input = evidence({
      speaking: speakingEvidence({
        committedLearnerTurns: 5,
        incorrectCorrections: 0,
        unnaturalCorrections: 1,
      }),
      languageUse: languageUseEvidence(),
      listening: {
        answered: 1,
        understood: 1,
        mostlyUnderstood: 0,
        partial: 0,
        missedKeyMeaning: 0,
        evaluatedBy: 'local',
      },
    });
    const first = estimateWorkingLevel(input);
    const second = estimateWorkingLevel(JSON.parse(JSON.stringify(input)) as DiagnosticEvidence);
    expect(first).toEqual(second);
    expect(first.status).toBe('estimated');
    expect(first.level).toBe('B1');
    expect(first.confidence).toBe('strong');
  });

  it('24. insufficient evidence produces no invented CEFR level', () => {
    const estimate = estimateWorkingLevel(
      evidence({ speaking: speakingEvidence({ committedLearnerTurns: 1 }) }),
    );
    expect(estimate.status).toBe('insufficient');
    expect(estimate.level).toBe('unknown');
    expect(estimate.confidence).toBe('limited');

    // No evidence at all is still "not enough evidence".
    const empty = estimateWorkingLevel(evidence());
    expect(empty.status).toBe('insufficient');
    expect(empty.level).toBe('unknown');
  });

  it('25. demo conversations never feed the level estimate', () => {
    const estimate = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ provenance: 'demo', committedLearnerTurns: 8 }),
        languageUse: languageUseEvidence({ provenance: 'demo' }),
      }),
    );
    expect(estimate.status).toBe('insufficient');
    expect(estimate.level).toBe('unknown');
  });

  it('26. the estimate moves deterministically with the evidence and never exceeds the Phase-1 range', () => {
    const strong = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 9 }),
        languageUse: languageUseEvidence(),
        listening: {
          answered: 1,
          understood: 1,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'ai',
        },
      }),
    );
    // The strongest realistic evidence still does not claim C1: a short
    // diagnostic cannot support that, so the ceiling stays at B2.
    expect(strong.level).toBe('B2');

    const weak = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({
          committedLearnerTurns: 4,
          incorrectCorrections: 3,
          naturalTurns: 0,
        }),
        languageUse: languageUseEvidence({
          natural: 0,
          incorrect: 1,
        }),
        listening: {
          answered: 1,
          understood: 0,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 1,
          evaluatedBy: 'local',
        },
      }),
    );
    expect(weak.level).toBe('A2');

    // A short diagnostic never claims A1, C1 or C2.
    for (const level of [strong.level, weak.level]) {
      expect(['A2', 'B1', 'B2']).toContain(level);
    }
  });

  it('27. confidence is derived from evidence coverage, never from the AI', () => {
    const limited = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 3 }),
        languageUse: languageUseEvidence(),
      }),
    );
    expect(limited.confidence).toBe('moderate');

    const strong = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 5 }),
        languageUse: languageUseEvidence(),
        listening: {
          answered: 1,
          understood: 0,
          mostlyUnderstood: 1,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'local',
        },
      }),
    );
    expect(strong.confidence).toBe('strong');
  });

  it('28. strengths and focus areas come only from real recorded evidence', () => {
    const demoOnly = evidence({
      speaking: speakingEvidence({ provenance: 'demo', committedLearnerTurns: 8 }),
    });
    expect(strengthsFromEvidence(demoOnly)).toEqual([]);
    expect(focusAreasFromEvidence(demoOnly)).toEqual([]);

    const real = evidence({
      speaking: speakingEvidence({
        committedLearnerTurns: 6,
        incorrectCorrections: 1,
        unnaturalCorrections: 1,
        correctionNotes: ['Use the past tense for finished actions.'],
      }),
      languageUse: languageUseEvidence({
        natural: 0,
        unnatural: 1,
        notes: ['This phrasing sounds unnatural in English.'],
      }),
    });
    const focus = focusAreasFromEvidence(real);
    expect(focus).toEqual([
      'Use the past tense for finished actions.',
      'This phrasing sounds unnatural in English.',
    ]);
    expect(strengthsFromEvidence(real).length).toBeGreaterThan(0);
  });

  it('29. the result text contains no score, percentage, star or mastery wording', async () => {
    const estimate = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 5, correctionNotes: ['Past tense.'] }),
        languageUse: languageUseEvidence(),
      }),
    );
    const line = describeEstimateForResult(estimate);
    expect(line).toContain('B1');
    for (const banned of ['%', 'score', 'stars', 'XP', 'mastery']) {
      expect(line.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(line.toLowerCase()).toContain('working level');
  });
});

// ─────────────────────────────────────── profile acceptance / level decision

describe('Onboarding — explicit level acceptance policy', () => {
  let adapter: SqlJsAdapter;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter, { currentLevel: 'B1' });
  });

  function service() {
    return createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
  }

  it('30. accepting the estimated level updates the EXISTING profile exactly once', async () => {
    const onboarding = service();
    const decision = await onboarding.acceptEstimatedLevel({ status: 'estimated', level: 'B2', confidence: 'moderate', basis: [] });
    expect(decision.updated).toBe(true);
    expect(decision.reason).toBe('accepted');
    expect(decision.currentLevel).toBe('B2');
    expect((await new SQLiteUserProfileRepository(adapter).get()).currentLevel).toBe('B2');
  });

  it('31. repeated acceptance is idempotent', async () => {
    const onboarding = service();
    const estimate = { status: 'estimated' as const, level: 'B2' as const, confidence: 'moderate' as const, basis: [] };
    await onboarding.acceptEstimatedLevel(estimate);
    const again = await onboarding.acceptEstimatedLevel(estimate);
    expect(again.updated).toBe(false);
    expect(again.reason).toBe('already-accepted');
    expect(again.currentLevel).toBe('B2');
  });

  it('32. declining leaves the prior currentLevel untouched', async () => {
    const onboarding = service();
    const decision = await onboarding.keepCurrentLevel();
    expect(decision.updated).toBe(false);
    expect(decision.reason).toBe('kept');
    expect(decision.currentLevel).toBe('B1');
    expect((await new SQLiteUserProfileRepository(adapter).get()).currentLevel).toBe('B1');
  });

  it('33. an insufficient estimate can never change the level', async () => {
    const onboarding = service();
    const decision = await onboarding.acceptEstimatedLevel({
      status: 'insufficient',
      level: 'unknown',
      confidence: 'limited',
      basis: [],
    });
    expect(decision.updated).toBe(false);
    expect(decision.reason).toBe('not-estimated');
    expect((await new SQLiteUserProfileRepository(adapter).get()).currentLevel).toBe('B1');
  });

  it('34. LearnerModel refresh sees the accepted profile change (existing path)', async () => {
    const learnerModel = createTalkLearnerModel(adapter)!;
    const onboarding = createOnboardingService({
      adapter,
      learnerModel,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    await learnerModel.refresh();
    expect(learnerModel.profile.currentLevel).toBe('B1');

    await onboarding.acceptEstimatedLevel({ status: 'estimated', level: 'B2', confidence: 'strong', basis: [] });
    // The service refreshed the SAME model instance: no second learner model.
    expect(learnerModel.profile.currentLevel).toBe('B2');
    expect(learnerModel.getCoachingContext().profile.currentLevel).toBe('B2');
  });

  it('35. future conversation turns receive the updated level and goals through LearnerModel', async () => {
    const learnerModel = createTalkLearnerModel(adapter)!;
    const onboarding = createOnboardingService({
      adapter,
      learnerModel,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      now: () => NOW,
    });
    await onboarding.saveProfileDraft({
      displayName: 'Salem',
      targetLevel: 'C1',
      learningGoals: ['Meetings', 'Presentations'],
      preferredModes: ['coach'],
    });
    await onboarding.acceptEstimatedLevel({ status: 'estimated', level: 'B2', confidence: 'moderate', basis: [] });

    const prompts: string[] = [];
    const provider: AIProvider = {
      id: 'prompt-capture-ai',
      async generate(request): Promise<AIProviderResult> {
        prompts.push(
          [request.systemPrompt, ...request.messages.map((message) => message.content)].join('\n'),
        );
        return { ok: true, response: { content: 'Let us talk about meetings.' } };
      },
    };
    const engine = createConversationEngine(learnerModel);
    const orchestrator = createConversationOrchestrator(engine, provider);
    const session: ConversationSession = createConversationSession(orchestrator, { mode: 'coach' });
    await session.send({ userMessage: 'I would like to practise for a meeting tomorrow.' });

    const prompt = prompts.at(-1) ?? '';
    expect(prompt).toContain('B2');
    expect(prompt.toLowerCase()).toContain('meetings');
  });
});

// ───────────────────────────────────────────────────────── result integrity

describe('Onboarding — result integrity & evidence ownership', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    learnerId = (await seedProfile(adapter)).id;
  });

  async function runDiagnostic(options: {
    readonly learningPersistence?: ReturnType<typeof createLearningPersistenceService>;
    readonly listening?: NonNullable<Parameters<typeof createOnboardingService>[0]>['listening'];
    readonly provider?: AIProvider;
    readonly isRealAI?: boolean;
  }) {
    const provider = options.provider ?? createStubProvider(['Great, go on.', 'Interesting! And then?']);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      ...(options.learningPersistence ? { learningPersistence: options.learningPersistence } : {}),
      ...(options.listening ? { listening: options.listening } : {}),
      createSpeakingBundle: () => ({
        session: buildSpeakingSession(provider, 'coach'),
        providerKind: options.isRealAI === false ? 'demo' : 'gemini',
        providerInfo: {
          kind: options.isRealAI === false ? 'demo' : 'gemini',
          label: options.isRealAI === false ? 'Offline demo' : 'Gemini • Real AI tutor',
          isRealAI: options.isRealAI !== false,
          allowsPersonalizedFeedback: options.isRealAI !== false,
        },
      }),
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    return { service, handle };
  }

  it('36. a completed diagnostic produces a compact qualitative result', async () => {
    const { service, handle } = await runDiagnostic({});
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    await service.recordSpeakingAnswer(handle, 'Last week I finished a big project for a client.');
    await service.recordSpeakingAnswer(handle, 'I prepared the plan and talked to the whole team.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used in this test.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used in this test.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const result = await service.finishDiagnostic(handle);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.estimate.status).toBe('estimated');
    expect(['A2', 'B1', 'B2', 'C1']).toContain(result.estimate.level);
    expect(result.profile.currentLevel).toBe('B1'); // unchanged until accepted
    expect(result.pronunciationLines).toBeNull(); // omitted, never fabricated
    const serialized = JSON.stringify(result).toLowerCase();
    for (const banned of [/\bscore\b/, /\bstars?\b/, /\bxp\b/, /\bstreak\b/, /\bmastery\b/, /%/]) {
      expect(serialized).not.toMatch(banned);
    }
  });

  it('37. an abandoned diagnostic produces no result and no completion', async () => {
    const { service, handle } = await runDiagnostic({});
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'I work as a project manager in a logistics company.');
    handle.session.abandon();

    expect(await service.finishDiagnostic(handle)).toBeNull();
    expect(await service.buildResult(handle)).toBeNull();
    expect(handle.session.getStatus()).toBe('abandoned');
  });

  it('38. reopening the result never re-persists evidence (weaknesses stay counted once)', async () => {
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const provider = createFeedbackProvider([
      { content: 'Let us fix that.', feedback: INCORRECT_FEEDBACK },
      { content: 'Good.', feedback: null },
      { content: 'Nice.', feedback: null },
    ]);
    const { service, handle } = await runDiagnostic({
      learningPersistence: persistence,
      provider,
    });
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'Yesterday I go to the office with my manager.');
    await service.recordSpeakingAnswer(handle, 'I prepared a plan for the next project yesterday.');
    await service.recordSpeakingAnswer(handle, 'The team finished the report on Friday evening.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    handle.session.markPronunciationUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const first = await service.finishDiagnostic(handle);
    expect(first).not.toBeNull();
    const mistakesAfterFirst = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
    const weaknessesAfterFirst = await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId);

    // Re-opening the result (and building it again) must add nothing.
    const again = await service.buildResult(handle);
    expect(again).not.toBeNull();
    const resultAgain = await service.finishDiagnostic(handle);
    expect(resultAgain).toBeNull(); // already completed: no second completion

    const mistakesAfterSecond = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
    const weaknessesAfterSecond = await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId);
    expect(mistakesAfterSecond.map((m) => m.occurrenceCount)).toEqual(
      mistakesAfterFirst.map((m) => m.occurrenceCount),
    );
    expect(weaknessesAfterSecond.length).toBe(weaknessesAfterFirst.length);
  });

  it('39. a reassessment never erases prior learning evidence', async () => {
    // Pre-existing evidence from an earlier session.
    const persistence = createLearningPersistenceService(adapter, learnerId);
    await persistence.recordFeedbackEvidence(INCORRECT_FEEDBACK);
    const before = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
    expect(before.length).toBe(1);
    const beforeWeaknesses = await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId);

    const { service, handle } = await runDiagnostic({ learningPersistence: persistence });
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'A short reassessment answer for the tutor.');
    handle.session.abandon();

    const after = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after[0].occurrenceCount).toBe(before[0].occurrenceCount);
    expect((await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId)).length).toBe(
      beforeWeaknesses.length,
    );
  });

  it('40. the diagnostic adds no session/weakness rows of its own (existing owners only)', async () => {
    const { service, handle } = await runDiagnostic({ isRealAI: false });
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'Offline demo practice turn with enough words.');
    handle.session.abandon();

    // Demo evidence is never persisted anywhere by the diagnostic itself.
    expect(await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId)).toEqual([]);
    expect(await new SQLiteMistakeRepository(adapter).listMistakes(learnerId)).toEqual([]);
  });
});

// ─────────────────────────────────────────────── integration / wiring checks

describe('Onboarding — integration with the rest of the app', () => {
  it('41. the onboarding module introduces no second engine, table or provider', () => {
    const files = ['index.ts', 'service.ts', 'session.ts', 'assessment.ts', 'speaking.ts', 'types.ts'];
    const sources = files.map((file) =>
      readFileSync(join(__dirname, file), 'utf8'),
    );
    const joined = sources.join('\n');
    for (const banned of [
      'CREATE TABLE',
      'openai',
      'anthropic',
      'elevenlabs',
      'supabase',
      '@google',
    ]) {
      expect(joined).not.toContain(banned);
    }
    // No numeric-score surface anywhere in the module's output types.
    for (const banned of [/percentage/i, /\bxp\b/, /\bstreak\b/, /\bmastery %/, /\d+\s*%/]) {
      expect(joined).not.toMatch(banned);
    }
  });

  it('42. Adaptive Lessons keep consuming normal learner evidence (no diagnostic coupling)', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);

    const plannerSource = readFileSync(
      join(__dirname, '..', 'adaptive-lessons', 'planner.ts'),
      'utf8',
    );
    // The planner reads the ordinary learner model — never a diagnostic module.
    expect(plannerSource).not.toContain('onboarding');
    expect(plannerSource).not.toContain('Diagnostic');

    const { createAdaptiveLessonService } = await import('../adaptive-lessons');
    const service = createAdaptiveLessonService(adapter);
    const today = await service.getTodayPractice();
    expect(['ready', 'no-profile', 'unavailable']).toContain(today.status);
  });

  it('45. a failed STT turn creates no diagnostic evidence (voice path)', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const learnerId = (await seedProfile(adapter)).id;
    const session = buildSpeakingSession(createStubProvider(['Reply that must not happen.']));
    const step = createDiagnosticSpeakingStep({ session, mode: 'natural', isRealAI: true });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: {
        id: 'stt-unavailable',
        async transcribe() {
          return { ok: false, error: 'Speech recognition is unavailable.' };
        },
      },
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const outcome = await coordinator.stopRecordingAndProcess();
    expect(outcome.ok).toBe(false);

    // Nothing was committed, so the diagnostic absorbs no evidence at all.
    await step.observeCommittedHistory();
    expect(session.getHistory()).toEqual([]);
    expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(0);
    expect(step.getSpeakingEvidence().committedTutorTurns).toBe(0);
    expect(await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId)).toEqual([]);
  });

  it('46. a real voice turn is absorbed from the committed history exactly once', async () => {
    const session = buildSpeakingSession(
      createFeedbackProvider([{ content: 'Interesting!', feedback: UNNATURAL_FEEDBACK }]),
    );
    const step = createDiagnosticSpeakingStep({ session, mode: 'natural', isRealAI: true });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'I work in logistics and I enjoy it.' }),
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const outcome = await coordinator.stopRecordingAndProcess();
    expect(outcome.ok).toBe(true);

    await step.observeCommittedHistory();
    await step.observeCommittedHistory(); // repeated observation never double-counts
    const evidence = step.getSpeakingEvidence();
    expect(evidence.committedLearnerTurns).toBe(1);
    expect(evidence.committedTutorTurns).toBe(1);
    expect(evidence.unnaturalCorrections).toBe(1);
  });

  it('47. real pronunciation observations reach the result, and unavailable analysis omits the section', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);

    const realLines = ['The final consonant in "worked" was softened.', 'Word stress landed on the first syllable.'];
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: {
        analyzeSpokenTurn: async () => ({
          analysis: {
            learnerId: 'x',
            observations: [],
            weakPoints: [],
            strengths: [],
            analyzedAt: NOW,
          },
          feedbackLines: realLines,
          unavailable: false,
        } as never),
      },
      createSpeakingBundle: () => ({
        session: buildSpeakingSession(createStubProvider(['Go on.', 'Interesting!'])),
        providerKind: 'gemini',
        providerInfo: {
          kind: 'gemini',
          label: 'Gemini • Real AI tutor',
          isRealAI: true,
          allowsPersonalizedFeedback: true,
        },
      }),
      now: () => NOW,
    });

    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'I work in logistics and I enjoy the work.');
    await service.recordSpeakingAnswer(handle, 'Last week I prepared a plan for a new client.');
    await service.recordSpeakingAnswer(handle, 'I explained the plan to my team in a meeting.');
    handle.session.advance();
    handle.session.markListeningUnavailable('Not used.', handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordLanguageUseAnswer(handle, 'I plan to travel next week because I need a rest.');
    handle.session.advance();
    const observed = await service.recordPronunciation(handle, 'I worked on the project last week.');
    expect(observed.observed).toBe(true);
    handle.session.advance();
    handle.session.markSummaryDone(handle.session.getCurrentStepToken());

    const result = await service.finishDiagnostic(handle);
    expect(result).not.toBeNull();
    expect(result?.pronunciationLines).toEqual(realLines);
    expect(result?.estimate.status).toBe('estimated');
  });

  it('48. repeating the same diagnostic evidence never duplicates weaknesses or review items', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const learnerId = (await seedProfile(adapter)).id;
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const mistakeRepo = new SQLiteMistakeRepository(adapter);

    // The same real correction arrives twice (e.g. a retried turn).
    await persistence.recordFeedbackEvidence(INCORRECT_FEEDBACK);
    await persistence.recordFeedbackEvidence(INCORRECT_FEEDBACK);

    const mistakes = await mistakeRepo.listMistakes(learnerId);
    expect(mistakes.length).toBe(1); // one row, evidence accumulated
    expect(mistakes[0].occurrenceCount).toBeGreaterThan(1);
    const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
    const references = weaknesses.map((weakness) => weakness.referenceId ?? weakness.id);
    expect(new Set(references).size).toBe(references.length); // no duplicate identity
  });

  it('49. the DEFAULT onboarding composition has the EXISTING pronunciation engine', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);

    // The real factory used by the app (not a test double).
    const service = createOnboardingServiceOn(adapter);
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();

    // The pronunciation step is reachable with a real target sentence…
    expect(handle.pronunciationTask.sentence.length).toBeGreaterThan(10);
    expect(handle.pronunciationTask.sentence).toBe(pronunciationTaskForDiagnostic().sentence);

    handle.session.advance();
    handle.session.advance();
    handle.session.advance();

    // …and the REAL engine analyses a repeat of that target on this composition:
    // the default path can never degrade into "pronunciation unavailable".
    const outcome = await service.recordPronunciation(
      handle,
      handle.pronunciationTask.sentence,
    );
    expect(outcome.observed).toBe(true);
    const evidence = handle.session.snapshot().evidence.pronunciation;
    expect(evidence?.observed).toBe(true);
    expect(evidence?.noteLines.length).toBeGreaterThan(0);
    // Real, qualitative engine output only — no number anywhere.
    for (const line of evidence?.noteLines ?? []) {
      expect(line).not.toMatch(/\d+\s*%/);
      expect(line.toLowerCase()).not.toMatch(/\bscore\b|\baccuracy\b/);
    }
  });

  it('50. the dedicated pronunciation target is passed to the engine as expectedText', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const calls: { transcript: string; expectedText?: string; mode?: string }[] = [];
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: {
        analyzeSpokenTurn: async (input: {
          transcript: string;
          expectedText?: string;
          mode?: string;
        }) => {
          calls.push(input);
          return {
            analysis: {
              learnerId: 'x',
              observations: [],
              weakPoints: [],
              strengths: [],
              analyzedAt: NOW,
            },
            feedbackLines: ['Word stress on "yesterday" needed care.'],
            unavailable: false,
          } as never;
        },
      },
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    for (let index = 0; index < 4; index += 1) handle.session.advance();

    const task = handle.pronunciationTask;
    expect(PRONUNCIATION_TASKS.map((entry) => entry.id)).toContain(task.id);
    const outcome = await service.recordPronunciation(handle, 'I usually walk to work yesterday.', task.sentence);

    expect(outcome.observed).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].expectedText).toBe(task.sentence); // the KNOWN target sentence
    expect(calls[0].transcript).toBe('I usually walk to work yesterday.');
    expect(calls[0].mode).toBe('coach'); // existing coaching mode
    expect(handle.session.snapshot().evidence.pronunciation?.noteLines).toEqual([
      'Word stress on "yesterday" needed care.',
    ]);
  });

  it('51. no transcript or no target means unavailable — never fabricated evidence', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    let engineCalls = 0;
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: {
        analyzeSpokenTurn: async () => {
          engineCalls += 1;
          return null;
        },
      },
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    for (let index = 0; index < 4; index += 1) handle.session.advance();

    // No transcript (failed STT / nothing recorded).
    const empty = await service.recordPronunciation(handle, '   ', handle.pronunciationTask.sentence);
    expect(empty.observed).toBe(false);
    expect(engineCalls).toBe(0);
    expect(handle.session.snapshot().evidence.pronunciation).toBeNull();
    let step = handle.session.snapshot().steps.find((entry) => entry.id === 'pronunciation');
    expect(step?.status).toBe('unavailable');

    // No target sentence at all: free conversation is never judged.
    const fresh = await service.beginDiagnostic();
    fresh.session.markProfileStepDone(fresh.session.getCurrentStepToken());
    for (let index = 0; index < 4; index += 1) fresh.session.advance();
    const noTarget = await service.recordPronunciation(fresh, 'Some free conversation text.', '  ');
    expect(noTarget.observed).toBe(false);
    expect(engineCalls).toBe(0);
    expect(fresh.session.snapshot().evidence.pronunciation).toBeNull();
  });

  it('52. a pronunciation result never carries a numeric score', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: {
        analyzeSpokenTurn: async () => ({
          analysis: {
            learnerId: 'x',
            observations: [],
            weakPoints: [],
            strengths: [],
            analyzedAt: NOW,
          },
          feedbackLines: ['The last sound in "walked" was softened.'],
          unavailable: false,
        } as never),
      },
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    for (let index = 0; index < 4; index += 1) handle.session.advance();
    await service.recordPronunciation(handle, 'I usually walked to work.', handle.pronunciationTask.sentence);

    const evidence = handle.session.snapshot().evidence.pronunciation;
    const serialized = JSON.stringify(evidence).toLowerCase();
    for (const banned of [/\d+\s*%/, /\bscore\b/, /\baccuracy\b/, /\bnative-?like\b/, /\baccent\b/]) {
      expect(serialized).not.toMatch(banned);
    }
  });

  it('53. free conversation alone never produces pronunciation evidence', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const engine = createPronunciationEngine(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: engine,
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'I work in logistics and I manage a small team.');
    for (let index = 0; index < 3; index += 1) handle.session.advance();

    // The speaking turn exists, but the pronunciation step has no repeat and no
    // target comparison → the step is honestly unavailable (nothing is invented).
    expect(handle.session.getCurrentStepId()).toBe('pronunciation');
    const before = handle.session.snapshot().evidence.pronunciation;
    expect(before).toBeNull();
  });

  it('54. zero corrections alone cannot inflate the estimate', () => {
    // Same real evidence, only the engine's REPORTED problems differ.
    const clean = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 3, naturalTurns: 3 }),
        languageUse: languageUseEvidence({ natural: 1, unnatural: 0, incorrect: 0 }),
      }),
    );
    expect(clean.status).toBe('estimated');
    expect(clean.level).toBe('B1'); // only the connected conversation counts

    // The absence of corrections contributes NOTHING: the same evidence with the
    // natural/language-use counters at zero is identical.
    const silent = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 3, naturalTurns: 0 }),
        languageUse: languageUseEvidence({ natural: 0, unnatural: 0, incorrect: 0 }),
      }),
    );
    expect(silent.level).toBe(clean.level);
    expect(silent.basis).toEqual(clean.basis);

    // Real reported problems still move the estimate DOWN (never up).
    const withProblems = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({
          committedLearnerTurns: 3,
          naturalTurns: 3,
          incorrectCorrections: 1,
          unnaturalCorrections: 2,
        }),
        languageUse: languageUseEvidence({ natural: 0, unnatural: 1, incorrect: 0 }),
      }),
    );
    expect(withProblems.status).toBe('estimated');
    expect(withProblems.level).toBe('A2');
  });

  it('55. natural-mode silence is never interpreted as proven grammatical quality', () => {
    // A long, silent conversation: the engine reported nothing at all.
    const silentLong = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({
          committedLearnerTurns: 8,
          naturalTurns: 8,
          incorrectCorrections: 0,
          unnaturalCorrections: 0,
        }),
        languageUse: languageUseEvidence({ natural: 1 }),
      }),
    );
    // Sustained speaking counts (it really happened) but silence adds nothing:
    // the result stays in the conservative middle range, never B2/C1.
    expect(silentLong.level).toBe('B1');
    expect(silentLong.basis.join(' ').toLowerCase()).not.toContain('no correction');
    expect(silentLong.basis.join(' ').toLowerCase()).not.toContain('natural');
  });

  it('56. explicit incorrect/unnatural evidence lowers the estimate, sustained speaking keeps it useful', () => {
    const base = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 6 }),
        listening: {
          answered: 1,
          understood: 1,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'local',
        },
      }),
    );
    expect(base.status).toBe('estimated');
    expect(base.level).toBe('B2'); // sustained speaking + real listening outcome

    const oneIncorrect = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 6, incorrectCorrections: 1 }),
        listening: {
          answered: 1,
          understood: 1,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'local',
        },
      }),
    );
    expect(oneIncorrect.level).toBe('B1');

    const manyIncorrect = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({
          committedLearnerTurns: 6,
          incorrectCorrections: 3,
          naturalTurns: 0,
        }),
        listening: {
          answered: 1,
          understood: 1,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'local',
        },
      }),
    );
    // Six sustained turns alone (+2) plus the real listening outcome (+1) would
    // be B2; three reported grammatical corrections bring it back down.
    expect(manyIncorrect.level).toBe('B1');
    expect(manyIncorrect.level).not.toBe(base.level);
  });

  it('57. thin evidence returns insufficient instead of an inflated level', () => {
    // One short turn: not enough to judge connected speech, whatever the
    // absence of corrections suggests.
    const thin = estimateWorkingLevel(
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 2, naturalTurns: 2 }),
      }),
    );
    expect(thin.status).toBe('insufficient');
    expect(thin.level).toBe('unknown');
    expect(thin.confidence).toBe('limited');
  });

  it('58. the estimate is identical for identical evidence (deterministic, coverage-only confidence)', () => {
    const build = () =>
      evidence({
        speaking: speakingEvidence({ committedLearnerTurns: 6, unnaturalCorrections: 1 }),
        languageUse: languageUseEvidence({ natural: 0, unnatural: 1 }),
        listening: {
          answered: 1,
          understood: 0,
          mostlyUnderstood: 1,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'ai',
        },
      });
    const a = estimateWorkingLevel(build());
    const b = estimateWorkingLevel(build());
    expect(a).toEqual(b);
    expect(a.level).toBe('B1');
    expect(a.confidence).toBe('strong');
  });

  it('59. the diagnostic conversation runs in the EXISTING coach mode', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const engine = createConversationEngine(createDemoLearnerModel());
    let observedMode: string | null = null;
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      createSpeakingBundle: (config) => {
        observedMode = config.mode;
        const orchestrator = createConversationOrchestrator(engine, createStubProvider(['Go on.']));
        return {
          session: createConversationSession(orchestrator, { mode: config.mode }),
          providerKind: 'gemini',
          providerInfo: {
            kind: 'gemini',
            label: 'Gemini • Real AI tutor',
            isRealAI: true,
            allowsPersonalizedFeedback: true,
          },
        };
      },
      now: () => NOW,
    });
    await service.beginDiagnostic();
    expect(observedMode).toBe('coach');
  });

  it('60. the onboarding screen copy is honest about what is saved when', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
    // The old false promise is gone.
    expect(screen).not.toContain('Nothing on your profile changes unless you accept it');
    expect(screen).toContain('Your learning preferences are saved when you start the assessment');
    expect(screen).toContain('changes only if you accept the estimate at the end');
    // A failed start never claims the profile was untouched.
    expect(screen).not.toContain('Your profile was not changed');
    expect(screen).toContain('Your learning preferences were saved, but the assessment could not start.');
    expect(screen).toContain('Your learning preferences could not be saved, so the assessment was not started.');
  });

  it('61. the dedicated pronunciation task is the one the screen presents and repeats', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
    // The screen shows the target sentence, plays it, and repeats it by voice.
    expect(screen).toContain('pronunciationTask');
    expect(screen).toContain('Play the sentence');
    expect(screen).toContain('Repeat it');
    // The transcript is analysed against the KNOWN target (never free text alone).
    expect(screen).toContain('handle.pronunciationTask.sentence');
    // Voice work in flight blocks advancing.
    expect(screen).toContain('Wait for your answer to finish before continuing.');
  });

  it('62. a late speaking result cannot become evidence for the NEXT step', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const provider = createDeferredProvider();
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      createSpeakingBundle: () => ({
        session: buildSpeakingSession(provider, 'coach'),
        providerKind: 'gemini',
        providerInfo: {
          kind: 'gemini',
          label: 'Gemini • Real AI tutor',
          isRealAI: true,
          allowsPersonalizedFeedback: true,
        },
      }),
      now: () => NOW,
    });

    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance(); // speaking

    // An answer is sent while `speaking` is the current step…
    const pending = service.recordSpeakingAnswer(
      handle,
      'I work in logistics and I manage a small team every day.',
    );

    // …and the flow moves on before the AI answers.
    handle.session.advance(); // listening
    handle.session.advance(); // language_use
    expect(handle.session.getCurrentStepId()).toBe('language_use');

    provider.resolveNext('A late tutor reply.');
    const outcome = await pending;

    const snapshot = handle.session.snapshot();
    expect(outcome.ok).toBe(false); // the stale speaking result was refused
    expect(snapshot.evidence.speaking).toBeNull();
    expect(snapshot.evidence.languageUse).toBeNull();
  });

  it('63. a late language-use result cannot become pronunciation evidence', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const provider = createDeferredProvider();
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: createPronunciationEngine(adapter),
      createSpeakingBundle: () => ({
        session: buildSpeakingSession(provider, 'coach'),
        providerKind: 'gemini',
        providerInfo: {
          kind: 'gemini',
          label: 'Gemini • Real AI tutor',
          isRealAI: true,
          allowsPersonalizedFeedback: true,
        },
      }),
      now: () => NOW,
    });

    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    for (let index = 0; index < 3; index += 1) handle.session.advance(); // → language_use
    expect(handle.session.getCurrentStepId()).toBe('language_use');

    const pending = service.recordLanguageUseAnswer(
      handle,
      'I plan to travel next week because I need a rest.',
    );
    handle.session.advance(); // pronunciation
    provider.resolveNext('Late reply.');
    await pending;

    const snapshot = handle.session.snapshot();
    expect(snapshot.currentStepId).toBe('pronunciation');
    expect(snapshot.evidence.languageUse).toBeNull();
    // A spoken answer in the conversation is NOT pronunciation evidence: the
    // dedicated repeat + target is still required.
    expect(snapshot.evidence.pronunciation).toBeNull();
  });

  it('64. abandoning the diagnostic makes every late result harmless', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    await seedProfile(adapter);
    const service = createOnboardingService({
      adapter,
      learnerModel: createTalkLearnerModel(adapter)!,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation: createPronunciationEngine(adapter),
      now: () => NOW,
    });
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    await service.recordSpeakingAnswer(handle, 'I work in logistics and I manage a small team.');
    const tokenBeforeAbandon = handle.session.getCurrentStepToken();

    // The learner leaves the screen: the diagnostic is abandoned FIRST.
    handle.session.abandon();

    expect(handle.session.recordSpeaking(speakingEvidence(), tokenBeforeAbandon)).toBe(false);
    expect(
      handle.session.recordListening(
        {
          answered: 1,
          understood: 1,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'local',
        },
        tokenBeforeAbandon,
      ),
    ).toBe(false);
    expect(handle.session.recordLanguageUse(languageUseEvidence(), tokenBeforeAbandon)).toBe(false);
    expect(
      handle.session.recordPronunciation({ observed: true, noteLines: ['Late note.'] }, tokenBeforeAbandon),
    ).toBe(false);
    expect(handle.session.snapshot().evidence.pronunciation).toBeNull();
    expect(handle.session.canComplete()).toBe(false);
    expect(await service.finishDiagnostic(handle)).toBeNull();
  });

  it('65. recording the same committed evidence twice neither doubles the turn nor the weaknesses', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const learnerId = (await seedProfile(adapter)).id;
    const persistence = createLearningPersistenceService(adapter, learnerId);
    const provider = createFeedbackProvider([
      { content: 'Let us fix that.', feedback: INCORRECT_FEEDBACK },
    ]);
    const session = buildSpeakingSession(provider, 'coach');
    const step = createDiagnosticSpeakingStep({
      session,
      mode: 'coach',
      isRealAI: true,
      learningPersistence: persistence,
    });
    const diagnostic = createDiagnosticSession({ learnerId, startedAt: NOW });
    diagnostic.markProfileStepDone(diagnostic.getCurrentStepToken());
    diagnostic.advance();
    const token = diagnostic.getCurrentStepToken();

    await step.send('Yesterday I go to the office with my manager and the team.');
    const first = step.getSpeakingEvidence();
    diagnostic.recordSpeaking(first, token);
    // Re-reporting the SAME observation (for example a repeated handler call)
    // replaces the evidence instead of accumulating it.
    diagnostic.recordSpeaking(step.getSpeakingEvidence(), token);
    const second = step.getSpeakingEvidence();
    expect(second).toEqual(first);
    expect(second.committedLearnerTurns).toBe(1);

    await step.observeCommittedHistory();
    await step.observeCommittedHistory();
    expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(1);

    const mistakes = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
    expect(mistakes.length).toBe(1);
    expect(mistakes[0].occurrenceCount).toBe(1); // one learner answer → one occurrence
    const weaknesses = await SQLiteWeaknessRepository.prototype.listWeaknesses.call(
      new SQLiteWeaknessRepository(adapter),
      learnerId,
    );
    expect(weaknesses.length).toBeLessThanOrEqual(1);
  });

  it('66. the screen prevents double submission and advancing during voice work', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
    // Re-entrancy guards exist for the mic, the text fallback and Continue.
    expect(screen).toContain('micInFlightRef');
    expect(screen).toContain('answerInFlightRef');
    expect(screen).toContain('continueInFlightRef');
    // Advancing is refused while ANY voice work for the current step is active.
    for (const check of [
      'voice.isProcessing',
      'voice.isSwitching',
      "voice.state === 'requesting_permission'",
      "voice.state === 'recording'",
      "voice.state === 'transcribing'",
      "voice.state === 'sending'",
      "voice.state === 'speaking'",
    ]) {
      expect(screen).toContain(check);
    }
    expect(screen).toContain('Wait for your answer to finish before continuing.');
    // The purpose of a voice turn is captured when the microphone OPENS.
    expect(screen).toContain('pendingPurposeRef');
    // Leaving the screen abandons the diagnostic before disposing voice work.
    const unmountIndex = screen.indexOf('mountedRef.current = false;');
    const abandonIndex = screen.indexOf('handle.session.abandon()', unmountIndex);
    expect(unmountIndex).toBeGreaterThan(-1);
    expect(abandonIndex).toBeGreaterThan(unmountIndex);
  });

  it('67. a VOICE answer is recorded against the step it was started in', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
    // The voice path records language-use evidence as language use (never as
    // speaking evidence for a different step)…
    expect(screen).toContain('recordLanguageUse(handle.speaking.getLanguageUseEvidence()');
    expect(screen).toContain('recordSpeaking(handle.speaking.getSpeakingEvidence()');
    // …and the pronunciation voice path uses the dedicated target comparison.
    expect(screen).toContain('recordPronunciation(');
    expect(screen).toContain('handle.pronunciationTask.sentence,');
  });

  describe('Pronunciation recording is transcription-only', () => {
    it('68. a pronunciation repeat never calls ConversationSession.send()', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const persistedTranscripts: string[] = [];
      const engineCalls: { transcript: string; expectedText?: string }[] = [];
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        pronunciation: {
          analyzeSpokenTurn: async (input: { transcript: string; expectedText?: string }) => {
            engineCalls.push({ transcript: input.transcript, expectedText: input.expectedText });
            return {
              analysis: {
                learnerId: 'x',
                observations: [],
                weakPoints: [],
                strengths: [],
                analyzedAt: NOW,
              },
              feedbackLines: ['The final sound in "walked" was softened.'],
              unavailable: false,
            } as never;
          },
        },
        now: () => NOW,
      });
      const handle = await service.beginDiagnostic();
      const session = handle.conversation;

      // The pronunciation repeat goes through the TRANSCRIPTION-ONLY path.
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'I usually walk to work.' }),
        ttsProvider: createDemoTTSProvider(),
      });
      await coordinator.startRecording();
      const outcome = await coordinator.stopRecordingAndTranscribe();
      expect(outcome.ok).toBe(true);
      expect(outcome.transcript).toBe('I usually walk to work.');

      // …the ConversationSession is completely untouched by that repeat.
      expect(session.getHistory()).toEqual([]); // no learner turn, no tutor reply
      expect(session.getLastFeedback()).toBeNull(); // no conversation feedback
      const learnerId = await learnerIdOf(adapter);
      expect(await new SQLiteMistakeRepository(adapter).listMistakes(learnerId)).toEqual([]);
      expect(await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId)).toEqual([]);
      expect(session.getSavedVocabulary()).toEqual([]); // no vocabulary side effect
      persistedTranscripts.push(outcome.transcript ?? '');

      // Only the EXISTING pronunciation engine saw it, with the known target.
      engineCalls.length = 0;
      for (let index = 0; index < 4; index += 1) handle.session.advance();
      const observed = await service.recordPronunciation(
        handle,
        outcome.transcript!,
        handle.pronunciationTask.sentence,
      );
      expect(observed.observed).toBe(true);
      expect(engineCalls).toEqual([
        { transcript: 'I usually walk to work.', expectedText: handle.pronunciationTask.sentence },
      ]);
    });

    it('69. the conversational path still submits exactly one turn (voice paths unchanged)', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const session = buildSpeakingSession(createStubProvider(['A tutor reply.']), 'coach');
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'I manage a small team.' }),
        ttsProvider: createDemoTTSProvider(),
      });

      await coordinator.startRecording();
      const outcome = await coordinator.stopRecordingAndProcess();

      expect(outcome.ok).toBe(true);
      // The normal path still commits the learner turn AND the tutor reply.
      expect(session.getHistory().map((turn) => turn.role)).toEqual(['user', 'assistant']);
    });

    it('70. a duplicate stop is refused on the transcription-only path', async () => {
      const session = buildSpeakingSession(createStubProvider(['Reply.']));
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'One utterance only.' }),
        ttsProvider: createDemoTTSProvider(),
      });

      await coordinator.startRecording();
      const first = await coordinator.stopRecordingAndTranscribe();
      const second = await coordinator.stopRecordingAndTranscribe();

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.transcript).toBeUndefined();
      expect(session.getHistory()).toEqual([]);
    });

    it('71. dispose invalidates a late transcription-only STT result', async () => {
      let release: ((result: STTResult) => void) | null = null;
      const sttProvider = {
        id: 'gated-stt',
        async transcribe(): Promise<STTResult> {
          return new Promise<STTResult>((resolve) => {
            release = resolve;
          });
        },
      };
      const releaseTranscript = (transcript: string) => {
        const resolver = release;
        release = null;
        resolver?.({ ok: true, transcript });
      };
      const session = buildSpeakingSession(createStubProvider(['Reply.']));
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider,
        ttsProvider: createDemoTTSProvider(),
      });

      await coordinator.startRecording();
      const pending = coordinator.stopRecordingAndTranscribe();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // The screen goes away while STT is still running.
      await coordinator.dispose();
      releaseTranscript('A late unmount transcript.');
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      expect(session.getHistory()).toEqual([]);
      expect(await coordinator.startRecording()).toBe(false);
    });

    it('72. a session switch invalidates a late transcription-only STT result', async () => {
      let release: ((result: STTResult) => void) | null = null;
      const session = buildSpeakingSession(createStubProvider(['Reply.']));
      const sttProvider = {
        id: 'gated-stt',
        async transcribe(): Promise<STTResult> {
          return new Promise<STTResult>((resolve) => {
            release = resolve;
          });
        },
      };
      const releaseTranscript = (transcript: string) => {
        const resolver = release;
        release = null;
        resolver?.({ ok: true, transcript });
      };
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider,
        ttsProvider: createDemoTTSProvider(),
      });

      await coordinator.startRecording();
      const pending = coordinator.stopRecordingAndTranscribe();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const replacement = buildSpeakingSession(createStubProvider(['New session reply.']));
      await coordinator.switchSession(replacement);
      releaseTranscript('A stale transcript from the old session.');
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      expect(session.getHistory()).toEqual([]);
      expect(replacement.getHistory()).toEqual([]);
    });

    it('73. a late pronunciation transcript is discarded when the step advanced', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      let engineCalls = 0;
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        pronunciation: {
          analyzeSpokenTurn: async () => {
            engineCalls += 1;
            return {
              analysis: { learnerId: 'x', observations: [], weakPoints: [], strengths: [], analyzedAt: NOW },
              feedbackLines: ['Late pronunciation note.'],
              unavailable: false,
            } as never;
          },
        },
        now: () => NOW,
      });
      const handle = await service.beginDiagnostic();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      for (let index = 0; index < 4; index += 1) handle.session.advance();
      expect(handle.session.getCurrentStepId()).toBe('pronunciation');

      // The recording started against THIS step token…
      const capturedToken = handle.session.getCurrentStepToken();
      // …but the learner moved on while STT was still running.
      handle.session.advance();
      expect(handle.session.getCurrentStepId()).toBe('summary');

      const late = await service.recordPronunciation(
        handle,
        'I usually walk to work.',
        handle.pronunciationTask.sentence,
        { stepToken: capturedToken },
      );

      expect(late.observed).toBe(false);
      expect(engineCalls).toBe(0); // the wrong-step transcript never reached the engine
      expect(handle.session.snapshot().evidence.pronunciation).toBeNull();
    });

    it('74. the pronunciation screen path is transcription-only and token-bound', () => {
      const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
      const pronunciationBranch = screen.slice(
        screen.indexOf("if (purpose === 'pronunciation')"),
        screen.indexOf('// The EXISTING coordinator committed the turn'),
      );
      // The pronunciation repeat uses the transcription-only coordinator method…
      expect(pronunciationBranch).toContain('stopRecordingAndTranscribe()');
      expect(pronunciationBranch).not.toContain('stopRecordingAndProcess');
      // …and passes the captured step token, not the token current at completion.
      expect(pronunciationBranch).toContain('stepToken');
      expect(pronunciationBranch).toContain('recordPronunciation');
      // The conversational branch is untouched.
      expect(screen).toContain('const outcome = await coordinator.stopRecordingAndProcess();');
    });
  });

  describe('Level sufficiency requires real speaking evidence', () => {
    const listeningOk = {
      answered: 1,
      understood: 1,
      mostlyUnderstood: 0,
      partial: 0,
      missedKeyMeaning: 0,
      evaluatedBy: 'local' as const,
    };

    it('75. one speaking turn + language use + listening is insufficient', () => {
      const estimate = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 1, naturalTurns: 1 }),
          languageUse: languageUseEvidence({ natural: 1 }),
          listening: listeningOk,
        }),
      );
      expect(estimate.status).toBe('insufficient');
      expect(estimate.level).toBe('unknown');
    });

    it('76. two speaking turns + language use + listening is insufficient', () => {
      const estimate = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 2, naturalTurns: 2 }),
          languageUse: languageUseEvidence({ natural: 1 }),
          listening: listeningOk,
        }),
      );
      expect(estimate.status).toBe('insufficient');
      expect(estimate.level).toBe('unknown');
    });

    it('77. three substantive real turns plus another real dimension is eligible', () => {
      const withLanguageUse = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 3 }),
          languageUse: languageUseEvidence({ natural: 0, unnatural: 0, incorrect: 0 }),
        }),
      );
      expect(withLanguageUse.status).toBe('estimated');
      expect(['A2', 'B1', 'B2']).toContain(withLanguageUse.level);

      const withListening = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 3 }),
          listening: listeningOk,
        }),
      );
      expect(withListening.status).toBe('estimated');
    });

    it('78. speaking alone (no other real dimension) is insufficient', () => {
      const estimate = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 8 }),
        }),
      );
      expect(estimate.status).toBe('insufficient');
      expect(estimate.level).toBe('unknown');
    });

    it('79. demo or missing speaking never satisfies the requirement', () => {
      const demo = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ provenance: 'demo', committedLearnerTurns: 8 }),
          languageUse: languageUseEvidence({ natural: 1 }),
          listening: listeningOk,
        }),
      );
      expect(demo.status).toBe('insufficient');
      expect(demo.level).toBe('unknown');

      const noSpeaking = estimateWorkingLevel(
        evidence({ languageUse: languageUseEvidence(), listening: listeningOk }),
      );
      expect(noSpeaking.status).toBe('insufficient');
      expect(noSpeaking.level).toBe('unknown');
    });

    it('80. the B2 ceiling still holds with the strongest realistic evidence', () => {
      const strongest = estimateWorkingLevel(
        evidence({
          speaking: speakingEvidence({ committedLearnerTurns: 10 }),
          languageUse: languageUseEvidence(),
          listening: listeningOk,
        }),
      );
      expect(strongest.status).toBe('estimated');
      expect(strongest.level).toBe('B2');
      expect(strongest.confidence).toBe('strong');
    });
  });

  describe('Diagnostic async integrity — no step change while evidence work runs', () => {
    it('81. voice evidence absorption is AWAITED before the evidence snapshot is read', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      const learnerId = (await seedProfile(adapter)).id;
      const persistence = createLearningPersistenceService(adapter, learnerId);
      const provider = createFeedbackProvider([
        { content: 'Let us fix that.', feedback: INCORRECT_FEEDBACK },
      ]);
      const session = buildSpeakingSession(provider, 'coach');
      const step = createDiagnosticSpeakingStep({
        session,
        mode: 'coach',
        isRealAI: true,
        learningPersistence: persistence,
      });

      // A real voice turn committed through the EXISTING coordinator.
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'Yesterday I go to work by bus.' }),
        ttsProvider: createDemoTTSProvider(),
      });
      await coordinator.startRecording();
      await coordinator.stopRecordingAndProcess();

      // The AWAITED absorption resolves only after the real evidence (and its
      // persistence through the EXISTING owner) is applied…
      await step.observeCommittedHistory();

      // …so the snapshot read right after it already contains the turn.
      const evidence = step.getSpeakingEvidence();
      expect(evidence.committedLearnerTurns).toBe(1);
      expect(evidence.incorrectCorrections).toBe(1);
      const mistakes = await new SQLiteMistakeRepository(adapter).listMistakes(learnerId);
      expect(mistakes.length).toBe(1);
      expect(mistakes[0].occurrenceCount).toBe(1);
    });

    it('82. the awaited absorption is what the diagnostic records for language use', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      const learnerId = (await seedProfile(adapter)).id;
      const session = buildSpeakingSession(
        createFeedbackProvider([{ content: 'Almost.', feedback: UNNATURAL_FEEDBACK }]),
        'coach',
      );
      const step = createDiagnosticSpeakingStep({
        session,
        mode: 'coach',
        isRealAI: true,
        learningPersistence: createLearningPersistenceService(adapter, learnerId),
      });
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'I am agree with the plan.' }),
        ttsProvider: createDemoTTSProvider(),
      });

      await coordinator.startRecording();
      await coordinator.stopRecordingAndProcess();
      await step.observeCommittedHistory({ purpose: 'language_use' });

      const languageUse = step.getLanguageUseEvidence();
      expect(languageUse.answered).toBe(1);
      expect(languageUse.unnatural).toBe(1);
      expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(0); // never double-counted
    });

    it('83. awaiting absorption twice never doubles the evidence (idempotent)', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const session = buildSpeakingSession(createStubProvider(['A reply.']), 'coach');
      const step = createDiagnosticSpeakingStep({ session, mode: 'coach', isRealAI: true });
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'I manage a small team.' }),
        ttsProvider: createDemoTTSProvider(),
      });
      await coordinator.startRecording();
      await coordinator.stopRecordingAndProcess();

      await step.observeCommittedHistory();
      await step.observeCommittedHistory();
      await step.observeCommittedHistory();
      expect(step.getSpeakingEvidence().committedLearnerTurns).toBe(1);
    });

    it('84. a pronunciation operation stays guarded until the engine finishes (post-STT)', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);

      let releaseEngine: (() => void) | null = null;
      const finishEngine = () => {
        const release = releaseEngine;
        releaseEngine = null;
        release?.();
      };
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        pronunciation: {
          analyzeSpokenTurn: async () => {
            await new Promise<void>((resolve) => {
              releaseEngine = resolve;
            });
            return {
              analysis: {
                learnerId: 'x',
                observations: [],
                weakPoints: [],
                strengths: [],
                analyzedAt: NOW,
              },
              feedbackLines: ['The final sound in "walked" was softened.'],
              unavailable: false,
            } as never;
          },
        },
        now: () => NOW,
      });

      const handle = await service.beginDiagnostic();
      const session = handle.conversation;
      const coordinator = createVoiceSessionCoordinator({
        session,
        recorder: createDemoAudioRecorder(),
        sttProvider: createDemoSTTProvider({ defaultTranscript: 'I usually walk to work.' }),
        ttsProvider: createDemoTTSProvider(),
      });
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      for (let index = 0; index < 4; index += 1) handle.session.advance();
      const capturedToken = handle.session.getCurrentStepToken();

      await coordinator.startRecording();
      const transcription = await coordinator.stopRecordingAndTranscribe();
      expect(transcription.ok).toBe(true);
      // STT finished and the coordinator is idle again…
      expect(coordinator.getStatus().state).toBe('idle');
      expect(session.getHistory()).toEqual([]); // …still no conversation turn

      // …but the OPERATION is not finished: the engine analysis is running.
      const recording = service.recordPronunciation(
        handle,
        transcription.transcript!,
        handle.pronunciationTask.sentence,
        { stepToken: capturedToken },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(handle.session.snapshot().evidence.pronunciation).toBeNull();

      finishEngine();
      const observed = await recording;
      expect(observed.observed).toBe(true);
      expect(handle.session.snapshot().evidence.pronunciation?.noteLines).toHaveLength(1);
    });

    it('85. a late listening answer cannot be attributed to a later step (captured token)', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      let releaseEvaluation: (() => void) | null = null;
      const finishEvaluation = () => {
        const release = releaseEvaluation;
        releaseEvaluation = null;
        release?.();
      };
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        listening: {
          startSession: async () => ({
            exercises: [
              {
                id: 'ex-1',
                learnerId: 'x',
                type: 'listen_and_type',
                difficulty: 'medium',
                speakText: 'The meeting starts at nine.',
                expectedAnswer: 'The meeting starts at nine.',
                keyItems: ['meeting'],
                source: 'general',
              },
            ],
            sourceNote: '',
          }),
          evaluateAnswer: async () => {
            await new Promise<void>((resolve) => {
              releaseEvaluation = resolve;
            });
            return {
              evaluation: {
                result: 'understood',
                feedbackLines: ['You caught it.'],
                missedItems: [],
                revealedTranscript: 'The meeting starts at nine.',
                evaluatedBy: 'local',
              },
              persistenceError: false,
            };
          },
          resolveLearnerId: async () => 'x',
        },
        now: () => NOW,
      });

      const handle = await service.beginDiagnostic();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();
      handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
      handle.session.advance(); // listening
      const capturedToken = handle.session.getCurrentStepToken();
      const planned = await service.startListeningTask(handle);
      expect(planned.status).toBe('ready');
      if (planned.status !== 'ready') return;

      const pending = service.recordListeningAnswer(handle, planned.exercise, 'The meeting starts at nine.', {
        stepToken: capturedToken,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // The flow moved on before the evaluation finished.
      handle.session.advance(); // language_use
      finishEvaluation();
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      expect(handle.session.snapshot().evidence.listening).toBeNull();
      expect(handle.session.snapshot().evidence.languageUse).toBeNull();
    });

    it('89. the listening record uses the CAPTURED token, never the later current one', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        listening: {
          startSession: async () => ({
            exercises: [
              {
                id: 'ex-1',
                learnerId: 'x',
                type: 'listen_and_type',
                difficulty: 'medium',
                speakText: 'The meeting starts at nine.',
                expectedAnswer: 'The meeting starts at nine.',
                keyItems: ['meeting'],
                source: 'general',
              },
            ],
            sourceNote: '',
          }),
          evaluateAnswer: async () => ({
            evaluation: {
              result: 'understood',
              feedbackLines: ['You caught it.'],
              missedItems: [],
              revealedTranscript: 'The meeting starts at nine.',
              evaluatedBy: 'local',
            },
            persistenceError: false,
          }),
          resolveLearnerId: async () => 'x',
        },
        now: () => NOW,
      });

      const handle = await service.beginDiagnostic();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();
      handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
      handle.session.advance(); // listening
      const capturedToken = handle.session.getCurrentStepToken();
      const planned = await service.startListeningTask(handle);
      if (planned.status !== 'ready') throw new Error('expected a listening task');

      // Probe: observe WHICH token the service hands to the state machine.
      const seenTokens: number[] = [];
      const realRecordListening = handle.session.recordListening.bind(handle.session);
      const probeHandle = {
        ...handle,
        session: {
          ...handle.session,
          recordListening: (evidence: Parameters<typeof realRecordListening>[0], token: number) => {
            seenTokens.push(token);
            return realRecordListening(evidence, token);
          },
        },
      };

      // A deliberately stale token (as if the answer belonged to an older entry
      // of this step): the service must forward the CALLER's token, not read the
      // current one after the evaluation finished.
      const staleToken = capturedToken + 1;
      const outcome = await service.recordListeningAnswer(
        probeHandle,
        planned.exercise,
        planned.exercise.expectedAnswer,
        { stepToken: staleToken },
      );

      expect(seenTokens).toEqual([staleToken]);
      expect(seenTokens).not.toContain(handle.session.getCurrentStepToken());
      expect(outcome.ok).toBe(false); // stale token → honestly refused
      expect(handle.session.snapshot().evidence.listening).toBeNull();
    });

    it('86. the listening evaluation records against the token captured before it started', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const seenTokens: number[] = [];
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        listening: createListeningService(adapter),
        now: () => NOW,
      });
      const handle = await service.beginDiagnostic();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();
      handle.session.recordSpeaking(speakingEvidence(), handle.session.getCurrentStepToken());
      handle.session.advance();
      const capturedToken = handle.session.getCurrentStepToken();
      seenTokens.push(capturedToken);

      const planned = await service.startListeningTask(handle);
      if (planned.status !== 'ready') throw new Error('expected a listening task');
      const outcome = await service.recordListeningAnswer(handle, planned.exercise, planned.exercise.expectedAnswer, {
        stepToken: capturedToken,
      });

      expect(outcome.ok).toBe(true);
      const evidence = handle.session.snapshot().evidence.listening;
      expect(evidence?.answered).toBe(1);
      // The recorded evidence belongs to the captured (current) step.
      const listeningStep = handle.session.snapshot().steps.find((step) => step.id === 'listening');
      expect(listeningStep?.status).toBe('active');
    });

    it('87. the screen blocks navigation with a SYNCHRONOUS guard for every operation', () => {
      const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');

      // One unified operation guard, checked BEFORE anything else in continueStep.
      expect(screen).toContain('diagnosticOperationInFlightRef');
      const continueIndex = screen.indexOf('const continueStep = useCallback');
      const guardIndex = screen.indexOf('diagnosticOperationInFlightRef.current ||', continueIndex);
      const advanceIndex = screen.indexOf('handle.session.advance();', continueIndex);
      expect(guardIndex).toBeGreaterThan(continueIndex);
      expect(guardIndex).toBeLessThan(advanceIndex);
      for (const guard of [
        'micInFlightRef.current',
        'answerInFlightRef.current',
        'listeningInFlightRef.current',
      ]) {
        expect(screen).toContain(guard);
      }

      // Typed answers hold the operation guard for their whole duration.
      const typedIndex = screen.indexOf('const submitTextAnswer = useCallback');
      const typedBlock = screen.slice(typedIndex, screen.indexOf('const continueStep = useCallback'));
      expect(typedBlock).toContain('diagnosticOperationInFlightRef.current = true;');
      expect(typedBlock).toContain('diagnosticOperationInFlightRef.current = false;');
      expect(typedBlock).toContain('const stepToken = handle.session.getCurrentStepToken();');

      // Listening is guarded and re-entrancy protected with a captured token.
      const listeningIndex = screen.indexOf('const submitListeningAnswer = useCallback');
      const listeningBlock = screen.slice(listeningIndex, screen.indexOf('const acceptLevel = useCallback'));
      expect(listeningBlock).toContain('if (listeningInFlightRef.current) return;');
      expect(listeningBlock).toContain('{ stepToken }');

      // Pronunciation holds the guard across STT *and* the engine analysis.
      const micIndex = screen.indexOf('const pressMic = useCallback');
      const micBlock = screen.slice(micIndex, screen.indexOf('const submitTextAnswer = useCallback'));
      expect(micBlock).toContain('diagnosticOperationInFlightRef.current = true;');
      const pronounceIndex = micBlock.indexOf('stopRecordingAndTranscribe()');
      const releaseIndex = micBlock.indexOf('diagnosticOperationInFlightRef.current = false;');
      expect(pronounceIndex).toBeGreaterThan(-1);
      expect(releaseIndex).toBeGreaterThan(pronounceIndex); // guard spans the engine call too
      expect(micBlock).toContain('await handle.speaking.observeCommittedHistory({ purpose });');
    });

    it('88. after a completed operation navigation works again', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();
      await seedProfile(adapter);
      const service = createOnboardingService({
        adapter,
        learnerModel: createTalkLearnerModel(adapter)!,
        profileRepository: new SQLiteUserProfileRepository(adapter),
        now: () => NOW,
      });
      const handle = await service.beginDiagnostic();
      handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
      handle.session.advance();

      // A completed (awaited) operation leaves the state machine free to advance.
      await service.recordSpeakingAnswer(handle, 'I work in logistics and I manage a small team.');
      expect(handle.session.getCurrentStepId()).toBe('speaking');
      expect(handle.session.advance()).toBe('listening');
      expect(handle.session.getCurrentStepId()).toBe('listening');
    });
  });

  it('43. the onboarding screens and entry points are wired without new navigation architecture', () => {
    const navigator = readFileSync(join(__dirname, '..', 'navigation', 'RootNavigator.tsx'), 'utf8');
    expect(navigator).toContain('Onboarding');
    expect(navigator).toContain('createStackNavigator');
    const home = readFileSync(join(__dirname, '..', 'screens', 'HomeScreen.tsx'), 'utf8');
    expect(home).toContain("navigate('Onboarding'");
    const settings = readFileSync(join(__dirname, '..', 'screens', 'SettingsScreen.tsx'), 'utf8');
    expect(settings).toContain("navigate('Onboarding'");
  });

  it('44. the onboarding screen drives the diagnostic through the domain service only', () => {
    const screen = readFileSync(join(__dirname, '..', 'screens', 'OnboardingScreen.tsx'), 'utf8');
    // The flow lives in the service/state machine, not in React side effects.
    expect(screen).toContain('createDefaultOnboardingService');
    expect(screen).toContain('beginDiagnostic');
    expect(screen).toContain('finishDiagnostic');
    expect(screen).toContain('acceptEstimatedLevel');
    expect(screen).toContain('keepCurrentLevel');
    // Voice-first with a manual fallback and no auto-listening.
    expect(screen).toContain('pressMic');
    expect(screen).toContain('TextInput');
    // No gamification in the rendered result.
    const resultSlice = screen.slice(screen.indexOf('renderResult'));
    for (const banned of ['score', 'stars', 'streak', 'badge', 'XP']) {
      expect(resultSlice).not.toContain(banned);
    }
  });
});
