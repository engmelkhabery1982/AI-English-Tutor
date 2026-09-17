/**
 * src/onboarding/service.ts
 *
 * OnboardingDiagnosticService (Phase 1) — the single coordinator that binds the
 * diagnostic state machine to the EXISTING systems:
 *
 *   profile        → UserProfileRepository (the ONLY profile writer)
 *   speaking       → ConversationSession / ConversationEngine (through the
 *                    existing Talk composition) + LearningPersistenceService for
 *                    weakness evidence (real provider only)
 *   listening      → ListeningService (startSession / evaluateAnswer) — the
 *                    EXISTING owner of listening weaknesses + review scheduling
 *   pronunciation  → PronunciationEngine (real qualitative observations only)
 *   level estimate → the deterministic aggregator in assessment.ts
 *
 * NOTHING here creates a second engine, a second scheduler, a second profile
 * table or a diagnostic database table: the durable truth stays the existing
 * profile + learning evidence repositories.
 */

import type { CefrLevelInput, ConversationMode, IsoDate } from '../domain/shared/types';
import type { UserProfileRepository } from '../repositories';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerModel } from '../learner-model';
import type { ListeningExercise, ListeningService } from '../listening';
import type { PronunciationEngine } from '../pronunciation';
import {
  createTalkComposition,
  createTalkSession,
  resolveTalkCoaching,
  type TalkCoachingResolution,
  type TalkProviderKind,
  type TalkSessionBundle,
} from '../talk-demo';
import type { ConversationSession } from '../conversation-session';
import {
  createLearningPersistenceService,
  type LearningPersistenceService,
} from '../talk-demo/learning-persistence';
import { nowIso } from '../shared/time';
import {
  describeConfidence,
  describeEstimate,
  estimateWorkingLevel,
  focusAreasFromEvidence,
  strengthsFromEvidence,
} from './assessment';
import { createDiagnosticSession, type DiagnosticSession } from './session';
import {
  createDiagnosticSpeakingStep,
  languageUseTaskForDiagnostic,
  type DiagnosticSpeakingStep,
  type LanguageUseTask,
} from './speaking';
import type {
  DiagnosticLevelDecision,
  DiagnosticLevelEstimate,
  DiagnosticListeningEvidence,
  DiagnosticResult,
  DiagnosticSpeakingEvidence,
  OnboardingPrefill,
  OnboardingProfileDraft,
} from './types';

/** Learner-facing labels for what a complete profile still needs. */
const MISSING_LABELS = {
  displayName: 'your name',
  targetLevel: 'a target level',
  learningGoals: 'your learning goals',
  preferredModes: 'how you like to practise',
} as const;

const UNAVAILABLE_LISTENING_MESSAGE = 'Listening practice is unavailable right now.';
const UNAVAILABLE_PRONUNCIATION_MESSAGE =
  'Pronunciation analysis was not available for this session.';

export interface OnboardingServiceDeps {
  /** Existing database composition (adapter / learner model). */
  readonly adapter?: DatabaseAdapter;
  readonly learnerModel?: LearnerModel;
  readonly profileRepository?: UserProfileRepository;
  /** EXISTING persistence owner for weakness/review evidence. */
  readonly learningPersistence?: LearningPersistenceService;
  /** EXISTING listening engine (its own evidence owner). */
  readonly listening?: Pick<ListeningService, 'startSession' | 'evaluateAnswer' | 'resolveLearnerId'>;
  /** EXISTING pronunciation engine. */
  readonly pronunciation?: Pick<PronunciationEngine, 'analyzeSpokenTurn'>;
  /** Test/embedding override for the speaking composition (existing bundle). */
  readonly createSpeakingBundle?: (config: {
    readonly mode: ConversationMode;
    readonly topic?: string;
  }) => TalkSessionBundle;
  /** Test/embedding override for the default coaching composition. */
  readonly loadCoachingComposition?: () => Promise<{
    readonly databaseAdapter: DatabaseAdapter;
    readonly learnerModel: LearnerModel;
  }>;
  readonly now?: () => IsoDate;
}

export interface DiagnosticHandle {
  /** The diagnostic state machine (progression authority). */
  readonly session: DiagnosticSession;
  /** The EXISTING ConversationSession used by the speaking + language-use parts. */
  readonly conversation: ConversationSession;
  readonly providerKind: TalkProviderKind;
  readonly speaking: DiagnosticSpeakingStep;
  readonly languageUseTask: LanguageUseTask;
}

export interface OnboardingService {
  loadPrefill(): Promise<OnboardingPrefill>;
  /** Saves the learner's OWN report through the existing profile repository. */
  saveProfileDraft(draft: OnboardingProfileDraft): Promise<OnboardingPrefill>;

  /** Starts a fresh diagnostic run (state machine + existing conversation stack). */
  beginDiagnostic(options?: {
    readonly mode?: ConversationMode;
    readonly topic?: string;
  }): Promise<DiagnosticHandle>;

  /** Sends one speaking answer through the existing stack and records evidence. */
  recordSpeakingAnswer(
    handle: DiagnosticHandle,
    answer: string,
  ): Promise<{ readonly ok: boolean; readonly errorMessage?: string }>;

  /** Runs the bounded language-use task (same stack, structured feedback only). */
  recordLanguageUseAnswer(
    handle: DiagnosticHandle,
    answer: string,
  ): Promise<{ readonly ok: boolean; readonly errorMessage?: string }>;

  /** Plans ONE listening task with the existing ListeningService. */
  startListeningTask(handle: DiagnosticHandle): Promise<
    | { readonly status: 'ready'; readonly exercise: ListeningExercise }
    | { readonly status: 'unavailable'; readonly message: string }
  >;

  /** Evaluates one listening answer through the existing service (its own owner). */
  recordListeningAnswer(
    handle: DiagnosticHandle,
    exercise: ListeningExercise,
    answer: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }>;

  /** Real pronunciation observations of one spoken turn (unavailable → omitted). */
  recordPronunciation(
    handle: DiagnosticHandle,
    transcript: string,
  ): Promise<{ readonly observed: boolean }>;

  /** Finalizes the diagnostic ONLY when required steps are resolved. */
  finishDiagnostic(handle: DiagnosticHandle): Promise<DiagnosticResult | null>;

  /** Builds the result without changing anything (result screen reload). */
  buildResult(handle: DiagnosticHandle): Promise<DiagnosticResult | null>;

  /** Explicit acceptance: the ONLY path that changes the persisted level. */
  acceptEstimatedLevel(estimate: DiagnosticLevelEstimate): Promise<DiagnosticLevelDecision>;
  /** Explicit refusal: nothing is written. */
  keepCurrentLevel(): Promise<DiagnosticLevelDecision>;
}

export function createOnboardingService(deps: OnboardingServiceDeps = {}): OnboardingService {
  const now = deps.now ?? nowIso;
  let composition: TalkCoachingResolution | null = null;
  let listening: OnboardingServiceDeps['listening'] | undefined = deps.listening;

  /** Resolves the EXISTING persisted composition (never a second database). */
  async function resolveComposition(): Promise<TalkCoachingResolution> {
    if (composition) return composition;
    if (deps.learnerModel) {
      composition = {
        ...(deps.adapter ? { databaseAdapter: deps.adapter } : {}),
        learnerModel: deps.learnerModel,
        source: 'persisted',
      };
      return composition;
    }
    if (deps.adapter) {
      try {
        composition = { ...createTalkComposition(deps.adapter), source: 'persisted' };
        return composition;
      } catch {
        // Honest fallback: no fabricated personalization.
        composition = { databaseAdapter: deps.adapter, source: 'demo-fallback' };
        return composition;
      }
    }
    composition = await resolveTalkCoaching({
      ...(deps.loadCoachingComposition ? { loadDefaultComposition: deps.loadCoachingComposition } : {}),
    });
    return composition;
  }

  /** The EXISTING profile repository — the single profile writer. */
  async function resolveProfileRepository(): Promise<UserProfileRepository | null> {
    if (deps.profileRepository) return deps.profileRepository;
    const resolved = await resolveComposition();
    if (!resolved.databaseAdapter) return null;
    try {
      const { SQLiteUserProfileRepository } = await import('../data/local/sqlite/repositories');
      return new SQLiteUserProfileRepository(resolved.databaseAdapter);
    } catch {
      return null;
    }
  }

  /**
   * Tolerant read: a brand-new install has no profile row yet (the existing
   * repository creates one on `update()`), and that is not an error here.
   */
  async function readProfile(
    repo: UserProfileRepository,
  ): Promise<Awaited<ReturnType<UserProfileRepository['get']>> | null> {
    try {
      return await repo.get();
    } catch {
      return null;
    }
  }

  async function resolvePersistence(
    learnerId: string,
    adapter?: DatabaseAdapter,
  ): Promise<LearningPersistenceService | undefined> {
    if (deps.learningPersistence) return deps.learningPersistence;
    if (!adapter) return undefined;
    // The EXISTING service stays the mutation owner for weakness/review evidence.
    return createLearningPersistenceService(adapter, learnerId);
  }

  async function resolveListening(): Promise<OnboardingServiceDeps['listening'] | undefined> {
    if (listening) return listening;
    const resolved = await resolveComposition();
    if (!resolved.databaseAdapter) return undefined;
    try {
      const { createListeningService } = await import('../listening');
      listening = createListeningService(resolved.databaseAdapter);
      return listening;
    } catch {
      return undefined;
    }
  }

  function buildPrefill(
    profile: Awaited<ReturnType<UserProfileRepository['get']>> | null,
  ): OnboardingPrefill {
    if (!profile) {
      return {
        profileId: null,
        displayName: '',
        nativeLanguage: null,
        targetLevel: 'unknown',
        currentLevel: 'unknown',
        learningGoals: [],
        preferredModes: [],
        isComplete: false,
        missingFields: [
          MISSING_LABELS.displayName,
          MISSING_LABELS.targetLevel,
          MISSING_LABELS.learningGoals,
          MISSING_LABELS.preferredModes,
        ],
        hasExistingData: false,
      };
    }

    const missing: string[] = [];
    if (!profile.displayName.trim()) missing.push(MISSING_LABELS.displayName);
    if (profile.targetLevel === 'unknown') missing.push(MISSING_LABELS.targetLevel);
    if (profile.learningGoals.length === 0) missing.push(MISSING_LABELS.learningGoals);
    if (profile.preferredModes.length === 0) missing.push(MISSING_LABELS.preferredModes);

    return {
      profileId: profile.id,
      displayName: profile.displayName,
      nativeLanguage: profile.nativeLanguage ?? null,
      targetLevel: profile.targetLevel,
      currentLevel: profile.currentLevel,
      learningGoals: profile.learningGoals,
      preferredModes: profile.preferredModes,
      isComplete: missing.length === 0,
      missingFields: missing,
      hasExistingData:
        Boolean(profile.displayName.trim()) ||
        profile.targetLevel !== 'unknown' ||
        profile.learningGoals.length > 0 ||
        profile.preferredModes.length > 0 ||
        Boolean(profile.nativeLanguage),
    };
  }

  /** One honest sentence about the listening outcome (no scores). */
  function describeListening(evidence: DiagnosticListeningEvidence): string {
    if (evidence.evaluatedBy === 'unavailable' || evidence.answered === 0) {
      return 'Listening was not completed in this diagnostic.';
    }
    if (evidence.understood > 0) return 'You caught the main meaning of the spoken passage.';
    if (evidence.mostlyUnderstood > 0) return 'You followed most of the spoken passage.';
    if (evidence.partial > 0) return 'You caught part of the spoken passage.';
    return 'The spoken passage was hard to follow this time.';
  }

  /** One honest sentence about the speaking part (no scores). */
  function describeSpeaking(evidence: DiagnosticSpeakingEvidence): string {
    const turns = evidence.committedLearnerTurns;
    const corrections = evidence.incorrectCorrections + evidence.unnaturalCorrections;
    const base =
      turns >= 5
        ? 'You sustained a full conversation with the tutor'
        : `You completed ${turns} speaking turn(s) with the tutor`;
    if (corrections === 0) return `${base} with no corrections.`;
    return `${base}; ${corrections} sentence(s) were corrected.`;
  }

  /** Deterministic recommended focus from real evidence + the learner's goals. */
  function recommendedFocusFor(
    focusAreas: readonly string[],
    profile: { readonly learningGoals: readonly string[] } | null,
  ): string {
    if (focusAreas.length > 0) {
      return `Start with: ${focusAreas[0]}`;
    }
    if (profile && profile.learningGoals.length > 0) {
      return `Start with practice built around ${profile.learningGoals[0].toLowerCase()}.`;
    }
    return 'Let the tutor choose practice next.';
  }

  const service: OnboardingService = {
    async loadPrefill(): Promise<OnboardingPrefill> {
      const repo = await resolveProfileRepository();
      if (!repo) {
        throw new Error('The learner profile is unavailable right now.');
      }
      return buildPrefill(await readProfile(repo));
    },

    async saveProfileDraft(draft: OnboardingProfileDraft): Promise<OnboardingPrefill> {
      const repo = await resolveProfileRepository();
      if (!repo) {
        throw new Error('The learner profile is unavailable right now.');
      }
      const patch: {
        displayName?: string;
        nativeLanguage?: string;
        targetLevel?: CefrLevelInput;
        learningGoals?: readonly string[];
        preferredModes?: readonly ConversationMode[];
      } = {};

      // Only fields the learner actually provided are written. `currentLevel` is
      // NEVER touched here: only an explicit acceptance after the diagnostic is.
      const displayName = draft.displayName?.trim();
      if (displayName) patch.displayName = displayName;
      if (draft.nativeLanguage) patch.nativeLanguage = draft.nativeLanguage;
      if (draft.targetLevel !== 'unknown') patch.targetLevel = draft.targetLevel as CefrLevelInput;
      if (draft.learningGoals.length > 0) patch.learningGoals = [...draft.learningGoals];
      if (draft.preferredModes.length > 0) patch.preferredModes = [...draft.preferredModes];

      // Nothing to write yet: the existing row (or the empty state) is returned
      // untouched — a brand-new install gets the repository's own defaults.
      const updated =
        Object.keys(patch).length === 0 ? await repo.update({}) : await repo.update(patch);

      // The EXISTING learner model must immediately see the new profile.
      await refreshLearnerModel();
      return buildPrefill(updated);
    },

    async beginDiagnostic(options = {}): Promise<DiagnosticHandle> {
      const resolved = await resolveComposition();
      const profileRepo = await resolveProfileRepository();
      const profile = profileRepo ? await readProfile(profileRepo) : null;
      const learnerId = resolved.learnerModel?.profile?.id || profile?.id || '';
      if (!learnerId) {
        throw new Error('Set up your learning profile before starting the assessment.');
      }

      const mode = options.mode ?? 'natural';
      const config = {
        mode,
        ...(options.topic ? { topic: options.topic } : {}),
      };
      const bundle =
        deps.createSpeakingBundle?.(config) ??
        createTalkSession(config, {
          ...(resolved.databaseAdapter ? { databaseAdapter: resolved.databaseAdapter } : {}),
          ...(resolved.learnerModel ? { learnerModel: resolved.learnerModel } : {}),
        });

      const persistence = await resolvePersistence(learnerId, resolved.databaseAdapter);
      const session = createDiagnosticSession({ learnerId, startedAt: now() });
      const speaking = createDiagnosticSpeakingStep({
        session: bundle.session,
        mode,
        isRealAI: bundle.providerInfo.isRealAI,
        ...(persistence ? { learningPersistence: persistence } : {}),
      });
      return {
        session,
        conversation: bundle.session,
        providerKind: bundle.providerKind,
        speaking,
        languageUseTask: languageUseTaskForDiagnostic(),
      };
    },

    async recordSpeakingAnswer(handle, answer) {
      const token = handle.session.getCurrentStepToken();
      const result = await handle.speaking.send(answer);
      if (!result.ok) {
        // A failed AI/STT turn is NOT evidence: the step stays open and no
        // learner weakness can be created from it.
        return { ok: false, errorMessage: result.error.message };
      }
      const recorded = handle.session.recordSpeaking(handle.speaking.getSpeakingEvidence(), token);
      return { ok: recorded };
    },

    async recordLanguageUseAnswer(handle, answer) {
      const token = handle.session.getCurrentStepToken();
      const result = await handle.speaking.sendLanguageUse(answer);
      if (!result.ok) {
        return { ok: false, errorMessage: result.error.message };
      }
      handle.session.recordLanguageUse(handle.speaking.getLanguageUseEvidence(), token);
      return { ok: true };
    },

    async startListeningTask(handle) {
      const token = handle.session.getCurrentStepToken();
      const engine = await resolveListening();
      if (!engine) {
        handle.session.markListeningUnavailable(UNAVAILABLE_LISTENING_MESSAGE, token);
        return { status: 'unavailable', message: UNAVAILABLE_LISTENING_MESSAGE };
      }
      const plan = await engine.startSession(handle.session.learnerId, {
        difficulty: 'medium',
        targetCount: 1,
      });
      const exercise = plan.exercises[0];
      if (!exercise) {
        // Infrastructure/content unavailable — never treated as a learner error.
        const message = plan.sourceNote || UNAVAILABLE_LISTENING_MESSAGE;
        handle.session.markListeningUnavailable(message, token);
        return { status: 'unavailable', message };
      }
      return { status: 'ready', exercise };
    },

    async recordListeningAnswer(handle, exercise, answer) {
      const token = handle.session.getCurrentStepToken();
      const engine = await resolveListening();
      if (!engine) {
        handle.session.markListeningUnavailable(UNAVAILABLE_LISTENING_MESSAGE, token);
        return { ok: false, message: UNAVAILABLE_LISTENING_MESSAGE };
      }
      const outcome = await engine.evaluateAnswer(handle.session.learnerId, exercise, answer);
      const evaluation = outcome.evaluation;
      if (evaluation.evaluatedBy === 'unavailable' || evaluation.result === 'insufficient_evidence') {
        handle.session.markListeningUnavailable(
          'This listening task could not be evaluated.',
          token,
        );
        return { ok: false, message: 'This listening task could not be evaluated.' };
      }

      const category = evaluation.result;
      const evidence: DiagnosticListeningEvidence = {
        answered: 1,
        understood: category === 'understood' ? 1 : 0,
        mostlyUnderstood: category === 'mostly_understood' ? 1 : 0,
        partial: category === 'partial' ? 1 : 0,
        missedKeyMeaning: category === 'missed_key_meaning' || category === 'misunderstood' ? 1 : 0,
        evaluatedBy: evaluation.evaluatedBy,
      };
      handle.session.recordListening(evidence, token);
      return { ok: true, message: evaluation.feedbackLines[0] ?? 'Listening task completed.' };
    },

    async recordPronunciation(handle, transcript) {
      const token = handle.session.getCurrentStepToken();
      const engine = deps.pronunciation;
      if (!engine || !transcript.trim()) {
        handle.session.markPronunciationUnavailable(UNAVAILABLE_PRONUNCIATION_MESSAGE, token);
        return { observed: false };
      }
      try {
        const outcome = await engine.analyzeSpokenTurn({ transcript, mode: 'coach' });
        const lines = outcome && !outcome.unavailable ? outcome.feedbackLines : [];
        if (!outcome || outcome.unavailable || lines.length === 0) {
          // No real observation → the pronunciation section is simply omitted.
          handle.session.markPronunciationUnavailable(
            'No pronunciation observations were recorded in this session.',
            token,
          );
          return { observed: false };
        }
        handle.session.recordPronunciation({ observed: true, noteLines: lines.slice(0, 4) }, token);
        return { observed: true };
      } catch {
        handle.session.markPronunciationUnavailable(UNAVAILABLE_PRONUNCIATION_MESSAGE, token);
        return { observed: false };
      }
    },

    async finishDiagnostic(handle) {
      if (!handle.session.canComplete()) return null;
      if (!handle.session.complete()) return null;
      return service.buildResult(handle);
    },

    async buildResult(handle) {
      const snapshot = handle.session.snapshot();
      // An abandoned or still-running diagnostic never produces a result, so a
      // partial conversation can never be reported as a completed assessment.
      if (snapshot.status !== 'completed') return null;

      const repo = await resolveProfileRepository();
      const profile = repo ? await readProfile(repo) : null;
      const evidence = snapshot.evidence;
      const estimate = estimateWorkingLevel(evidence);
      const focusAreas = focusAreasFromEvidence(evidence);

      const notices: string[] = [];
      if (evidence.speaking && evidence.speaking.provenance === 'demo') {
        notices.push(
          'The conversation part ran in offline demo mode, so it is practice only — it did not feed the level estimate.',
        );
      }
      for (const step of snapshot.steps) {
        if (step.status === 'skipped') {
          notices.push(`${step.id}: skipped in this session.`);
        } else if (step.status === 'unavailable') {
          notices.push(`${step.id}: ${step.unavailableReason ?? 'not available right now.'}`);
        }
      }

      const realSpeaking =
        evidence.speaking && evidence.speaking.provenance === 'real' ? evidence.speaking : null;

      return {
        learnerId: snapshot.learnerId,
        generatedAt: now(),
        estimate,
        strengths: strengthsFromEvidence(evidence),
        focusAreas,
        speakingLine: realSpeaking
          ? describeSpeaking(realSpeaking)
          : 'The speaking part was not completed with a real tutor.',
        listeningLine: describeListening(evidence.listening ?? {
          answered: 0,
          understood: 0,
          mostlyUnderstood: 0,
          partial: 0,
          missedKeyMeaning: 0,
          evaluatedBy: 'unavailable',
        }),
        pronunciationLines:
          evidence.pronunciation && evidence.pronunciation.observed
            ? evidence.pronunciation.noteLines
            : null,
        recommendedFocus: recommendedFocusFor(focusAreas, profile),
        notices,
        profile: {
          displayName: profile?.displayName ?? '',
          targetLevel: profile?.targetLevel ?? 'unknown',
          currentLevel: profile?.currentLevel ?? 'unknown',
          learningGoals: profile?.learningGoals ?? [],
          preferredModes: profile?.preferredModes ?? [],
        },
      } satisfies DiagnosticResult;
    },

    async acceptEstimatedLevel(estimate) {
      const repo = await resolveProfileRepository();
      if (estimate.status !== 'estimated' || estimate.level === 'unknown') {
        const current = repo ? await readProfile(repo) : null;
        return {
          updated: false,
          currentLevel: current?.currentLevel ?? 'unknown',
          reason: 'not-estimated',
        };
      }
      if (!repo) {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }
      try {
        const profile = await readProfile(repo);
        if (profile && profile.currentLevel === estimate.level) {
          // Idempotent: accepting the same level twice changes nothing.
          return { updated: false, currentLevel: profile.currentLevel, reason: 'already-accepted' };
        }
        const updated = await repo.update({ currentLevel: estimate.level });
        // The EXISTING learner model must immediately see the accepted level.
        await refreshLearnerModel();
        return { updated: true, currentLevel: updated.currentLevel, reason: 'accepted' };
      } catch {
        return { updated: false, currentLevel: 'unknown', reason: 'persistence-failed' };
      }
    },

    async keepCurrentLevel() {
      const repo = await resolveProfileRepository();
      const profile = repo ? await readProfile(repo) : null;
      // Explicit refusal: the existing level is left exactly as it was.
      return { updated: false, currentLevel: profile?.currentLevel ?? 'unknown', reason: 'kept' };
    },
  };

  /** Refreshes the EXISTING learner model so downstream engines see the change. */
  async function refreshLearnerModel(): Promise<void> {
    const resolved = await resolveComposition();
    if (!resolved.learnerModel) return;
    try {
      await resolved.learnerModel.refresh();
    } catch {
      // A refresh problem must never undo or block a saved profile value.
    }
  }

  return service;
}

/** Learner-facing summary line for the estimate (never a score, never official). */
export function describeEstimateForResult(estimate: DiagnosticLevelEstimate): string {
  return `${describeEstimate(estimate)} (${describeConfidence(estimate.confidence)})`;
}
