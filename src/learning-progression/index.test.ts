/**
 * src/learning-progression/index.test.ts
 *
 * WP-1 — Phases 1 & 2 tests.
 *
 * Covers the deterministic DifficultyProfile resolver and the shared
 * curriculum evidence projection. Everything here is exercised as the PURE
 * functions they are: no repositories, no AI, no clock, no database.
 */

import { describe, it, expect } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import type { LearnerWeakness, PronunciationWeakness } from '../domain/models/learner';
import type { ExpressionItem, VocabularyItem } from '../domain/models/vocabulary';
import type { SkillDomain } from '../curriculum/types';
import { planCurriculum } from '../curriculum';
import {
  CONSERVATIVE_DIFFICULTY_PROFILE,
  CURRICULUM_EVIDENCE_MAPPINGS,
  DISCOURSE_LENGTH_ORDER,
  GRAMMAR_COMPLEXITY_ORDER,
  PROJECTED_SKILL_IDS,
  PROJECTION_ACTIVE_STATES,
  SUPPORT_LEVEL_ORDER,
  activeDifficultySkillIds,
  hasUrgentNegativeEvidence,
  isKnownLevel,
  isUrgentNegativeStatus,
  lifecycleFromMasteryState,
  lifecycleUrgency,
  projectCurriculumEvidence,
  resolveDifficultyProfile,
  stableKey,
  toProgressionEvidence,
  urgentNegativeEvidenceCount,
  weaknessTypeToDomain,
} from './index';
import type {
  DifficultyProfile,
  LearnerProgressionEvidence,
  ProgressionLevel,
  ProgressionWeaknessEvidence,
} from './index';

const NOW = '2026-09-18T12:00:00.000Z';
const EARLIER = '2026-09-01T08:00:00.000Z';
const ALL_LEVELS: readonly ProgressionLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const ALL_DOMAINS: readonly SkillDomain[] = [
  'grammar',
  'vocabulary',
  'expressions',
  'speaking',
  'listening',
  'pronunciation',
];

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function evidenceRow(
  domain: SkillDomain,
  status: ProgressionWeaknessEvidence['status'],
  resolved = false,
): ProgressionWeaknessEvidence {
  return { domain, status, resolved };
}

function evidence(
  rows: readonly ProgressionWeaknessEvidence[],
): LearnerProgressionEvidence {
  return { weaknesses: rows };
}

function weaknessRow(partial: {
  id: string;
  type: string;
  status: string;
  referenceId?: string;
  occurrenceCount?: number;
  lastSeenAt?: string;
  resolved?: boolean;
  notes?: string;
}): LearnerWeakness {
  return {
    id: partial.id,
    learnerId: 'learner-1',
    type: partial.type,
    referenceId: partial.referenceId ?? 'ref-1',
    status: partial.status,
    severity: 0.5,
    occurrenceCount: partial.occurrenceCount ?? 1,
    lastSeenAt: partial.lastSeenAt ?? NOW,
    firstSeenAt: EARLIER,
    contexts: [],
    evidence: [],
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    resolved: partial.resolved ?? false,
    createdAt: EARLIER,
    updatedAt: NOW,
  } as unknown as LearnerWeakness;
}

function pronunciationRow(partial: {
  id: string;
  targetSound: string;
  resolved?: boolean;
}): PronunciationWeakness {
  return {
    id: partial.id,
    learnerId: 'learner-1',
    targetSound: partial.targetSound,
    wordExamples: [],
    occurrenceCount: 2,
    lastSeenAt: NOW,
    firstSeenAt: EARLIER,
    contexts: [],
    exampleTurnIds: [],
    resolved: partial.resolved ?? false,
    createdAt: EARLIER,
    updatedAt: NOW,
  } as unknown as PronunciationWeakness;
}

function vocabItem(
  id: string,
  states: readonly { state: string; reviewCount?: number; lastReviewAt?: string }[],
): VocabularyItem {
  return {
    id,
    learnerId: 'learner-1',
    headword: `word-${id}`,
    type: 'word',
    meanings: states.map((entry) => ({
      definition: 'a real meaning',
      examples: [],
      review: {
        state: entry.state,
        reviewCount: entry.reviewCount ?? 1,
        ...(entry.lastReviewAt ? { lastReviewAt: entry.lastReviewAt } : {}),
        consecutiveCorrect: 0,
      },
    })),
    source: { addedBy: 'learner-created', addedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as VocabularyItem;
}

function exprItem(
  id: string,
  states: readonly { state: string; reviewCount?: number; lastReviewAt?: string }[],
): ExpressionItem {
  return {
    id,
    learnerId: 'learner-1',
    expression: `expr-${id}`,
    type: 'common_expression',
    meanings: states.map((entry) => ({
      definition: 'a real meaning',
      examples: [],
      review: {
        state: entry.state,
        reviewCount: entry.reviewCount ?? 1,
        ...(entry.lastReviewAt ? { lastReviewAt: entry.lastReviewAt } : {}),
        consecutiveCorrect: 0,
      },
    })),
    source: { addedBy: 'learner-created', addedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as ExpressionItem;
}

const NO_EVIDENCE = evidence([]);

/** Strip comments so purity scans inspect real code, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line: string) => !line.trim().startsWith('//'))
    .join('\n');
}

/* ================================================================== *
 * PART A — Difficulty profile
 * ================================================================== */

describe('DifficultyProfile — determinism and level fidelity', () => {
  it('1. identical input yields an identical profile (pure determinism)', () => {
    const ev = evidence([evidenceRow('listening', 'confirmed')]);
    const a = resolveDifficultyProfile('B1', ev, 'listening');
    const b = resolveDifficultyProfile('B1', ev, 'listening');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('2. evidence row ORDER cannot change the resolved profile', () => {
    const rows = [
      evidenceRow('grammar', 'confirmed'),
      evidenceRow('listening', 'relapsed'),
      evidenceRow('listening', 'repeated'),
    ];
    const forward = resolveDifficultyProfile('A2', evidence(rows), 'listening');
    const reversed = resolveDifficultyProfile('A2', evidence([...rows].reverse()), 'listening');
    expect(forward).toEqual(reversed);
  });

  it('3. every stored level resolves a distinct, stable profile', () => {
    const profiles = ALL_LEVELS.map((level) => resolveDifficultyProfile(level, NO_EVIDENCE));
    const serialized = profiles.map((profile) => JSON.stringify(profile));
    expect(new Set(serialized).size).toBe(ALL_LEVELS.length);
    for (const profile of profiles) {
      expect(isKnownLevel(profile.level)).toBe(true);
      expect(profile.evidenceAdjusted).toBe(false);
    }
  });

  it('4. the unknown level resolves to the most conservative profile', () => {
    const unknown = resolveDifficultyProfile('unknown', NO_EVIDENCE);
    expect(unknown).toEqual(CONSERVATIVE_DIFFICULTY_PROFILE);
    const lowestKnown = resolveDifficultyProfile('A1', NO_EVIDENCE);
    // Strictly more conservative than the lowest known level: shorter input
    // and a smaller deliberate new-language budget.
    expect(DISCOURSE_LENGTH_ORDER.indexOf(unknown.discourseLength)).toBeLessThanOrEqual(
      DISCOURSE_LENGTH_ORDER.indexOf(lowestKnown.discourseLength),
    );
    expect(unknown.newLanguageBudget).toBeLessThanOrEqual(lowestKnown.newLanguageBudget);
    expect(unknown.grammarComplexity).toBe('basic');
    expect(unknown.supportLevel).toBe('high');
  });

  it('5. unknown input (not a real level) degrades to the unknown profile, never a higher one', () => {
    const junk = resolveDifficultyProfile('B9' as ProgressionLevel, NO_EVIDENCE);
    expect(junk).toEqual(CONSERVATIVE_DIFFICULTY_PROFILE);
    expect(junk.level).toBe('unknown');
  });

  it('6. discourse length never decreases as the level rises, and is bounded', () => {
    const indexes = ALL_LEVELS.map((level) =>
      DISCOURSE_LENGTH_ORDER.indexOf(
        resolveDifficultyProfile(level, NO_EVIDENCE).discourseLength,
      ),
    );
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1]);
    }
    expect(indexes[indexes.length - 1]).toBeLessThanOrEqual(DISCOURSE_LENGTH_ORDER.length - 1);
  });

  it('7. the new-language budget never decreases as the level rises, and is non-negative', () => {
    const budgets = ALL_LEVELS.map(
      (level) => resolveDifficultyProfile(level, NO_EVIDENCE).newLanguageBudget,
    );
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
    for (const budget of budgets) {
      expect(Number.isInteger(budget)).toBe(true);
      expect(budget).toBeGreaterThanOrEqual(0);
    }
  });

  it('8. grammar complexity never decreases as the level rises', () => {
    const indexes = ALL_LEVELS.map((level) =>
      GRAMMAR_COMPLEXITY_ORDER.indexOf(
        resolveDifficultyProfile(level, NO_EVIDENCE).grammarComplexity,
      ),
    );
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1]);
    }
  });

  it('9. support level never increases as the level rises (higher levels need less support)', () => {
    const indexes = ALL_LEVELS.map((level) =>
      SUPPORT_LEVEL_ORDER.indexOf(resolveDifficultyProfile(level, NO_EVIDENCE).supportLevel),
    );
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeLessThanOrEqual(indexes[i - 1]);
    }
  });
});

describe('DifficultyProfile — domain scoping', () => {
  it('10. WP-1 may resolve identical values for every domain, and threads the domain through', () => {
    const profiles = ALL_DOMAINS.map((domain) =>
      resolveDifficultyProfile('B2', NO_EVIDENCE, domain),
    );
    for (let i = 0; i < profiles.length; i += 1) {
      expect(profiles[i].domain).toBe(ALL_DOMAINS[i]);
      expect({ ...profiles[i], domain: undefined }).toEqual({
        ...profiles[0],
        domain: undefined,
      });
    }
  });

  it('11. without a domain the profile carries no domain claim', () => {
    const profile = resolveDifficultyProfile('B2', NO_EVIDENCE);
    expect(profile.domain).toBeUndefined();
    expect('domain' in profile).toBe(false);
  });

  it('12. domain scoping really gates negative evidence', () => {
    const ev = evidence([evidenceRow('listening', 'confirmed')]);
    const listening = resolveDifficultyProfile('B2', ev, 'listening');
    const grammar = resolveDifficultyProfile('B2', ev, 'grammar');
    expect(listening.evidenceAdjusted).toBe(true);
    expect(grammar.evidenceAdjusted).toBe(false);
    expect(grammar).toEqual(resolveDifficultyProfile('B2', NO_EVIDENCE, 'grammar'));
  });
});

describe('DifficultyProfile — evidence can only make practice more supported', () => {
  it('13. real negative evidence increases the support level', () => {
    const ev = evidence([evidenceRow('listening', 'confirmed')]);
    const base = resolveDifficultyProfile('B2', NO_EVIDENCE, 'listening');
    const supported = resolveDifficultyProfile('B2', ev, 'listening');
    expect(SUPPORT_LEVEL_ORDER.indexOf(supported.supportLevel)).toBeGreaterThan(
      SUPPORT_LEVEL_ORDER.indexOf(base.supportLevel),
    );
    expect(supported.evidenceAdjusted).toBe(true);
  });

  it('14. real negative evidence shortens discourse and shrinks the budget, never raises them', () => {
    for (const level of ALL_LEVELS) {
      const ev = evidence([evidenceRow('speaking', 'relapsed')]);
      const base = resolveDifficultyProfile(level, NO_EVIDENCE, 'speaking');
      const supported = resolveDifficultyProfile(level, ev, 'speaking');
      expect(DISCOURSE_LENGTH_ORDER.indexOf(supported.discourseLength)).toBeLessThanOrEqual(
        DISCOURSE_LENGTH_ORDER.indexOf(base.discourseLength),
      );
      expect(supported.newLanguageBudget).toBeLessThanOrEqual(base.newLanguageBudget);
    }
  });

  it('15. negative evidence NEVER raises complexity or speech style, at any level', () => {
    for (const level of ALL_LEVELS) {
      const ev = evidence([
        evidenceRow('listening', 'relapsed'),
        evidenceRow('listening', 'confirmed'),
      ]);
      const base = resolveDifficultyProfile(level, NO_EVIDENCE, 'listening');
      const supported = resolveDifficultyProfile(level, ev, 'listening');
      expect(GRAMMAR_COMPLEXITY_ORDER.indexOf(supported.grammarComplexity)).toBeLessThanOrEqual(
        GRAMMAR_COMPLEXITY_ORDER.indexOf(base.grammarComplexity),
      );
      expect(supported.grammarComplexity).toBe(base.grammarComplexity);
      expect(supported.speechStyle).toEqual(base.speechStyle);
      // The stored working level is NEVER promoted by evidence.
      expect(supported.level).toBe(base.level);
    }
  });

  it('16. the most conservative profile cannot be pushed further, and says so honestly', () => {
    const ev = evidence([evidenceRow('listening', 'confirmed')]);
    const unknown = resolveDifficultyProfile('unknown', ev, 'listening');
    expect(unknown.supportLevel).toBe('high');
    expect(unknown.discourseLength).toBe('single_sentence');
    expect(unknown.newLanguageBudget).toBe(CONSERVATIVE_DIFFICULTY_PROFILE.newLanguageBudget);
    expect(unknown.evidenceAdjusted).toBe(false);
  });

  it('17. only unresolved, genuinely repeated difficulty counts as negative evidence', () => {
    expect(isUrgentNegativeStatus('relapsed')).toBe(true);
    expect(isUrgentNegativeStatus('confirmed')).toBe(true);
    expect(isUrgentNegativeStatus('active_training')).toBe(true);
    expect(isUrgentNegativeStatus('repeated')).toBe(true);
    expect(isUrgentNegativeStatus('observed')).toBe(false);
    expect(isUrgentNegativeStatus('improving')).toBe(false);
    expect(isUrgentNegativeStatus('stable')).toBe(false);
    expect(isUrgentNegativeStatus('mastered')).toBe(false);

    const observedOnly = evidence([evidenceRow('listening', 'observed')]);
    expect(hasUrgentNegativeEvidence(observedOnly, 'listening')).toBe(false);
    expect(resolveDifficultyProfile('B2', observedOnly, 'listening')).toEqual(
      resolveDifficultyProfile('B2', NO_EVIDENCE, 'listening'),
    );

    const resolvedConfirmed = evidence([evidenceRow('listening', 'confirmed', true)]);
    expect(hasUrgentNegativeEvidence(resolvedConfirmed, 'listening')).toBe(false);
    expect(resolveDifficultyProfile('B2', resolvedConfirmed, 'listening').evidenceAdjusted).toBe(
      false,
    );
  });

  it('18. an unscoped resolution considers every domain\u2019s negative evidence', () => {
    const ev = evidence([
      evidenceRow('grammar', 'confirmed'),
      evidenceRow('pronunciation', 'relapsed'),
    ]);
    expect(urgentNegativeEvidenceCount(ev)).toBe(2);
    expect(urgentNegativeEvidenceCount(ev, 'grammar')).toBe(1);
    expect(urgentNegativeEvidenceCount(ev, 'listening')).toBe(0);
    expect(resolveDifficultyProfile('B2', ev).evidenceAdjusted).toBe(true);
  });

  it('19. missing/absent evidence is treated as no evidence (never invented)', () => {
    expect(resolveDifficultyProfile('B1', undefined)).toEqual(
      resolveDifficultyProfile('B1', NO_EVIDENCE),
    );
    expect(resolveDifficultyProfile('B1', null)).toEqual(
      resolveDifficultyProfile('B1', NO_EVIDENCE),
    );
    expect(hasUrgentNegativeEvidence(undefined)).toBe(false);
    expect(urgentNegativeEvidenceCount(null)).toBe(0);
  });

  it('20. resolution never writes back into its inputs', () => {
    const ev = evidence([evidenceRow('listening', 'confirmed')]);
    const snapshot = JSON.stringify(ev);
    const profile = resolveDifficultyProfile('B2', ev, 'listening');
    expect(JSON.stringify(ev)).toBe(snapshot);
    // The resolved profile is a NEW object; mutating it cannot corrupt a base.
    expect(profile).not.toBe(CONSERVATIVE_DIFFICULTY_PROFILE);
    expect(profile.speechStyle).toEqual(resolveDifficultyProfile('B2', NO_EVIDENCE).speechStyle);
  });

  it('21. the profile exposes TEXT-only speech style and no audio/score fields', () => {
    const profile: DifficultyProfile = resolveDifficultyProfile('C1', NO_EVIDENCE, 'speaking');
    expect(profile.speechStyle.register).toBeDefined();
    expect(profile.speechStyle.sentenceShape).toBeDefined();
    expect(profile.speechStyle.contractionDensity).toBeDefined();
    expect(profile.speechStyle.lexicalStyle).toBeDefined();

    const keys = Object.keys(profile);
    for (const forbidden of [
      'speechRate',
      'scaffolding',
      'taskIndependence',
      'difficultyVariables',
      'score',
      'band',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(Object.keys(profile.speechStyle)).toEqual([
      'register',
      'sentenceShape',
      'contractionDensity',
      'lexicalStyle',
    ]);
  });

  it('22. the resolver is pure: no repository, AI, clock or randomness in the module', () => {
    const sources = ['difficulty.ts', 'evidence.ts', 'types.ts']
      .map((file) => readFileSync(join(__dirname, file), 'utf8'))
      .join('\n');
    const importLines = sources
      .split('\n')
      .filter((line: string) => line.trim().startsWith('import'))
      .join('\n');
    expect(importLines).not.toMatch(/sqlite|repositories|providers\/ai|fetch|node:/i);
    const code = stripComments(sources);
    expect(code).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/);
    expect(code).not.toMatch(/upsert|insert\(|\.write\(/i);
  });
});

/* ================================================================== *
 * Evidence normalization helpers
 * ================================================================== */

describe('progression evidence normalization', () => {
  it('23. weakness types map onto the six curriculum domains', () => {
    expect(weaknessTypeToDomain('grammar')).toBe('grammar');
    expect(weaknessTypeToDomain('vocabulary')).toBe('vocabulary');
    expect(weaknessTypeToDomain('natural_expression')).toBe('expressions');
    expect(weaknessTypeToDomain('listening')).toBe('listening');
    expect(weaknessTypeToDomain('pronunciation')).toBe('pronunciation');
    expect(weaknessTypeToDomain('fluency')).toBe('speaking');
    expect(weaknessTypeToDomain('confidence')).toBe('speaking');
    expect(weaknessTypeToDomain('unknown-type')).toBeNull();
  });

  it('24. already-loaded rows normalize without guessing a domain', () => {
    const built = toProgressionEvidence([
      { type: 'listening', status: 'confirmed', resolved: false },
      { type: 'not-a-real-type', status: 'confirmed', resolved: false },
      { type: 'fluency', status: 'repeated', resolved: true },
    ]);
    expect(built.weaknesses).toHaveLength(2);
    expect(built.weaknesses[0]).toEqual({
      domain: 'listening',
      status: 'confirmed',
      resolved: false,
    });
    expect(built.weaknesses[1].domain).toBe('speaking');
    expect(urgentNegativeEvidenceCount(built)).toBe(1);
  });
});

/* ================================================================== *
 * PART D — Curriculum evidence projection
 * ================================================================== */

describe('curriculum projection — supported mappings', () => {
  it('25. a word-pronunciation weakness maps onto sound_clarity with real metadata', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({
          id: 'w1',
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: 'p1',
          occurrenceCount: 3,
          lastSeenAt: NOW,
        }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'word_pronunciation:hello' })],
    });
    expect(snapshots).toEqual([
      {
        skillId: 'sound_clarity',
        lifecycleState: 'confirmed',
        lastObservedAt: NOW,
        evidenceCount: 3,
      },
    ]);
  });

  it('26. an ending observation maps onto sound_clarity too (same honest node)', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'pronunciation', status: 'observed', referenceId: 'p1' }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].skillId).toBe('sound_clarity');
    expect(snapshots[0].lifecycleState).toBe('observed');
  });

  it('27. a pronunciation weakness with no linked row is skipped (never guessed)', () => {
    expect(
      projectCurriculumEvidence({
        weaknesses: [
          weaknessRow({ id: 'w1', type: 'pronunciation', status: 'confirmed', referenceId: 'missing' }),
        ],
        pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      }),
    ).toEqual([]);
  });

  it('28. an unidentified identity carries no evidence', () => {
    expect(
      projectCurriculumEvidence({
        weaknesses: [
          weaknessRow({ id: 'w1', type: 'pronunciation', status: 'confirmed', referenceId: 'p1' }),
        ],
        pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'nokindhere' })],
      }),
    ).toEqual([]);
  });

  it('29. reviewed vocabulary maps onto core_vocabulary only', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      vocabulary: [vocabItem('v1', [{ state: 'struggling', lastReviewAt: NOW }])],
    });
    expect(snapshots).toEqual([
      {
        skillId: 'core_vocabulary',
        lifecycleState: 'confirmed',
        lastObservedAt: NOW,
        evidenceCount: 1,
      },
    ]);
  });

  it('30. reviewed expressions map onto common_expressions only', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      expressions: [exprItem('e1', [{ state: 'familiar', lastReviewAt: EARLIER }])],
    });
    expect(snapshots).toEqual([
      {
        skillId: 'common_expressions',
        lifecycleState: 'repeated',
        lastObservedAt: EARLIER,
        evidenceCount: 1,
      },
    ]);
  });

  it('31. every stored mastery state maps to an honest difficulty-side lifecycle state', () => {
    expect(lifecycleFromMasteryState('struggling', 3)).toBe('confirmed');
    expect(lifecycleFromMasteryState('familiar', 3)).toBe('repeated');
    expect(lifecycleFromMasteryState('learning', 1)).toBe('observed');
    expect(lifecycleFromMasteryState('new', 0)).toBeNull();
    expect(lifecycleFromMasteryState('new', 2)).toBe('observed');
    // Positive/terminal review states are NOT difficulty-side evidence:
    // they must never claim curriculum mastery.
    expect(lifecycleFromMasteryState('mastered', 5)).toBeNull();
    expect(lifecycleFromMasteryState('retired', 5)).toBeNull();
  });

  it('32. saved-but-never-reviewed or non-evidencing lexical items contribute NOTHING', () => {
    expect(
      projectCurriculumEvidence({
        weaknesses: [],
        pronunciationWeaknesses: [],
        vocabulary: [
          { ...vocabItem('v1', []), meanings: [{ definition: 'x', examples: [] }] } as VocabularyItem,
        ],
        expressions: [exprItem('e1', [{ state: 'retired' }])],
      }),
    ).toEqual([]);
  });
});

describe('curriculum projection — DEAD and UNMAPPABLE mappings emit nothing', () => {
  it('33. listening word/expression recognition is UNMAPPABLE (no listening skill is invented)', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({
          id: 'w1',
          type: 'listening',
          status: 'confirmed',
          notes: 'word_recognition:deadline',
        }),
        weaknessRow({
          id: 'w2',
          type: 'listening',
          status: 'relapsed',
          notes: 'expression_recognition:in the loop',
        }),
      ],
      pronunciationWeaknesses: [],
    });
    expect(snapshots).toEqual([]);
  });

  it('34. DEAD listening identities (connected speech, comprehension kinds) emit nothing', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: ['connected_speech', 'meaning_comprehension', 'detail_comprehension'].map(
        (kind, index) =>
          weaknessRow({
            id: `w${index}`,
            type: 'listening',
            status: 'confirmed',
            notes: `${kind}:something`,
          }),
      ),
      pronunciationWeaknesses: [],
    });
    expect(snapshots).toEqual([]);
  });

  it('35. DEAD pronunciation observation types emit nothing', () => {
    const dead = [
      'word_stress',
      'sentence_stress',
      'vowel',
      'consonant',
      'linking',
      'intonation',
      'intelligibility',
    ];
    const snapshots = projectCurriculumEvidence({
      weaknesses: dead.map((kind, index) =>
        weaknessRow({
          id: `w${index}`,
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: `p${index}`,
        }),
      ),
      pronunciationWeaknesses: dead.map((kind, index) =>
        pronunciationRow({ id: `p${index}`, targetSound: `${kind}:development` }),
      ),
    });
    expect(snapshots).toEqual([]);
  });

  it('36. the extra-word heuristic is NOT projected as rhythm evidence', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'pronunciation', status: 'confirmed', referenceId: 'p1' }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'rhythm:extra words' })],
    });
    expect(snapshots).toEqual([]);
    expect(PROJECTED_SKILL_IDS).not.toContain('rhythm');
  });

  it('37. grammar weakness identity is never guessed into a grammar skill', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'grammar', status: 'confirmed', notes: 'articles:a/the' }),
        weaknessRow({ id: 'w2', type: 'grammar', status: 'relapsed', notes: 'tense:present perfect' }),
      ],
      pronunciationWeaknesses: [],
    });
    expect(snapshots).toEqual([]);
    for (const skillId of PROJECTED_SKILL_IDS) {
      expect(['articles', 'present_tense', 'past_tense', 'conditionals', 'prepositions']).not.toContain(
        skillId,
      );
    }
  });

  it('38. there is deliberately no strength projection path in WP-1', () => {
    const strengthMapping = CURRICULUM_EVIDENCE_MAPPINGS.find(
      (mapping) => mapping.source === 'learner_strength',
    );
    expect(strengthMapping?.status).toBe('DEAD');
    expect(strengthMapping?.skillId).toBeUndefined();
    // Passing strength-shaped data cannot create evidence: the projection
    // input has no strength channel at all.
    const withStrengths = {
      weaknesses: [],
      pronunciationWeaknesses: [],
      strengths: [{ type: 'grammar', confidence: 1 }],
    };
    expect(projectCurriculumEvidence(withStrengths)).toEqual([]);
  });

  it('39. the explicit classification table covers every source family', () => {
    const sources = new Set(CURRICULUM_EVIDENCE_MAPPINGS.map((mapping) => mapping.source));
    expect(sources).toEqual(
      new Set([
        'listening_weakness',
        'pronunciation_weakness',
        'vocabulary_review',
        'expression_review',
        'grammar_weakness',
        'learner_strength',
      ]),
    );
    for (const mapping of CURRICULUM_EVIDENCE_MAPPINGS) {
      if (mapping.status === 'SUPPORTED') {
        expect(mapping.skillId).toBeTruthy();
        expect(mapping.domain).toBeTruthy();
      } else {
        expect(mapping.skillId).toBeUndefined();
      }
      expect(mapping.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('curriculum projection — aggregation, ordering and purity', () => {
  it('40. multiple real rows mapping to one skill produce exactly ONE snapshot', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'pronunciation', status: 'observed', referenceId: 'p1' }),
        weaknessRow({ id: 'w2', type: 'pronunciation', status: 'confirmed', referenceId: 'p2' }),
      ],
      pronunciationWeaknesses: [
        pronunciationRow({ id: 'p1', targetSound: 'word_pronunciation:hello' }),
        pronunciationRow({ id: 'p2', targetSound: 'ending:worked' }),
      ],
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].skillId).toBe('sound_clarity');
  });

  it('41. the most urgent existing lifecycle state wins', () => {
    const snapshotFor = (statuses: readonly string[]): string => {
      const snapshots = projectCurriculumEvidence({
        weaknesses: statuses.map((status, index) =>
          weaknessRow({
            id: `w${index}`,
            type: 'pronunciation',
            status,
            referenceId: `p${index}`,
          }),
        ),
        pronunciationWeaknesses: statuses.map((_status, index) =>
          pronunciationRow({ id: `p${index}`, targetSound: 'word_pronunciation:hello' }),
        ),
      });
      return snapshots[0].lifecycleState;
    };
    expect(snapshotFor(['observed', 'relapsed'])).toBe('relapsed');
    expect(snapshotFor(['mastered', 'confirmed'])).toBe('confirmed');
    expect(snapshotFor(['stable', 'active_training'])).toBe('active_training');
    expect(snapshotFor(['improving', 'repeated'])).toBe('repeated');
    expect(snapshotFor(['observed', 'improving'])).toBe('observed');
    expect(snapshotFor(['mastered', 'stable'])).toBe('stable');

    // The urgency order is exactly the project's existing priority order.
    expect(lifecycleUrgency('relapsed')).toBeLessThan(lifecycleUrgency('confirmed'));
    expect(lifecycleUrgency('confirmed')).toBeLessThan(lifecycleUrgency('active_training'));
    expect(lifecycleUrgency('active_training')).toBeLessThan(lifecycleUrgency('repeated'));
    expect(lifecycleUrgency('repeated')).toBeLessThan(lifecycleUrgency('observed'));
    expect(lifecycleUrgency('observed')).toBeLessThan(lifecycleUrgency('improving'));
    expect(lifecycleUrgency('improving')).toBeLessThan(lifecycleUrgency('stable'));
    expect(lifecycleUrgency('stable')).toBeLessThan(lifecycleUrgency('mastered'));
  });

  it('42. the LATEST valid observation timestamp survives aggregation', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({
          id: 'w1',
          type: 'pronunciation',
          status: 'observed',
          referenceId: 'p1',
          lastSeenAt: EARLIER,
        }),
        weaknessRow({
          id: 'w2',
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: 'p2',
          lastSeenAt: NOW,
        }),
      ],
      pronunciationWeaknesses: [
        pronunciationRow({ id: 'p1', targetSound: 'word_pronunciation:hello' }),
        pronunciationRow({ id: 'p2', targetSound: 'ending:worked' }),
      ],
    });
    expect(snapshots[0].lastObservedAt).toBe(NOW);
  });

  it('43. invalid timestamps are never emitted as observation metadata', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({
          id: 'w1',
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: 'p1',
          lastSeenAt: 'not-a-date',
        }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
    });
    expect(snapshots[0].lastObservedAt).toBeUndefined();
  });

  it('44. evidence count is the deterministic sum of applicable evidence', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({
          id: 'w1',
          type: 'pronunciation',
          status: 'observed',
          referenceId: 'p1',
          occurrenceCount: 4,
        }),
        weaknessRow({
          id: 'w2',
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: 'p2',
          occurrenceCount: 6,
        }),
      ],
      pronunciationWeaknesses: [
        pronunciationRow({ id: 'p1', targetSound: 'word_pronunciation:hello' }),
        pronunciationRow({ id: 'p2', targetSound: 'ending:worked' }),
      ],
      vocabulary: [vocabItem('v1', [{ state: 'familiar' }, { state: 'learning' }])],
    });
    const pronunciation = snapshots.find((s) => s.skillId === 'sound_clarity');
    const vocabulary = snapshots.find((s) => s.skillId === 'core_vocabulary');
    expect(pronunciation?.evidenceCount).toBe(10);
    expect(vocabulary?.evidenceCount).toBe(2);
  });

  it('45. output is sorted deterministically by skillId', () => {
    const snapshots = projectCurriculumEvidence({
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'pronunciation', status: 'confirmed', referenceId: 'p1' }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      vocabulary: [vocabItem('v1', [{ state: 'learning' }])],
      expressions: [exprItem('e1', [{ state: 'struggling' }])],
    });
    expect(snapshots.map((snapshot) => snapshot.skillId)).toEqual([
      'common_expressions',
      'core_vocabulary',
      'sound_clarity',
    ]);
    const reversed = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      expressions: [exprItem('e1', [{ state: 'struggling' }])],
      vocabulary: [vocabItem('v1', [{ state: 'learning' }])],
    });
    expect(reversed.map((s) => s.skillId)).toEqual(['common_expressions', 'core_vocabulary']);
  });

  it('46. a resolved or mastered weakness emits NOTHING (positive evidence is later work)', () => {
    // A mastered weakness row is no longer difficulty-side evidence: it must
    // not project, and must never exclude or claim a curriculum skill.
    expect(
      projectCurriculumEvidence({
        weaknesses: [
          weaknessRow({ id: 'w1', type: 'pronunciation', status: 'mastered', referenceId: 'p1' }),
        ],
        pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      }),
    ).toEqual([]);
    // The same for a resolved weakness row.
    expect(
      projectCurriculumEvidence({
        weaknesses: [
          weaknessRow({
            id: 'w1',
            type: 'pronunciation',
            status: 'stable',
            referenceId: 'p1',
            resolved: true,
          }),
        ],
        pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      }),
    ).toEqual([]);
    // The active-difficulty helper still reports nothing for mastered/observed
    // snapshots that a DIFFERENT (still-supported) mapping may produce.
    expect(PROJECTION_ACTIVE_STATES).toEqual([
      'relapsed',
      'confirmed',
      'active_training',
      'repeated',
    ]);
    expect(
      activeDifficultySkillIds([
        { skillId: 'sound_clarity', lifecycleState: 'confirmed' },
        { skillId: 'core_vocabulary', lifecycleState: 'observed' },
      ]),
    ).toEqual(['sound_clarity']);
  });

  it('46a. mastered lexical review states never mark a broad curriculum skill mastered', () => {
    // A FINITE set of fully-mastered saved words and expressions cannot make
    // the broad curriculum skills 'mastered' — that would let the planner
    // exclude the whole skill on the strength of a handful of meanings.
    const manyMastered = Array.from({ length: 25 }, (_v, index) => index);
    const snapshots = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      vocabulary: manyMastered.map((index) =>
        vocabItem(`v${index}`, [{ state: 'mastered', reviewCount: 8 }]),
      ),
      expressions: manyMastered.map((index) =>
        exprItem(`e${index}`, [{ state: 'mastered', reviewCount: 8 }]),
      ),
    });
    expect(snapshots).toEqual([]);

    // Mixed items: only the difficulty-side meanings survive. An otherwise
    // mastered word with one struggling meaning still evidences difficulty.
    const mixed = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      vocabulary: [
        vocabItem('v-mix', [
          { state: 'mastered', reviewCount: 8 },
          { state: 'struggling', reviewCount: 3 },
        ]),
      ],
    });
    expect(mixed).toEqual([
      {
        skillId: 'core_vocabulary',
        lifecycleState: 'confirmed',
        evidenceCount: 1,
      },
    ]);
  });

  it('46b. mastered lexical items never exclude a broad skill from curriculum planning', () => {
    // End-to-end honesty check through the EXISTING planner: even with many
    // mastered words/expressions, core_vocabulary and common_expressions stay
    // recommendable (no `mastered` snapshot is ever produced to exclude them).
    const manyMastered = Array.from({ length: 25 }, (_v, index) => index);
    const snapshots = projectCurriculumEvidence({
      weaknesses: [],
      pronunciationWeaknesses: [],
      vocabulary: manyMastered.map((index) =>
        vocabItem(`v${index}`, [{ state: 'mastered', reviewCount: 8 }]),
      ),
      expressions: manyMastered.map((index) =>
        exprItem(`e${index}`, [{ state: 'mastered', reviewCount: 8 }]),
      ),
    });
    const plan = planCurriculum({ evidence: snapshots, maxItems: 50 });
    const vocabularySkill = plan.recommendations.find((rec) => rec.skillId === 'core_vocabulary');
    const expressionsSkill = plan.recommendations.find(
      (rec) => rec.skillId === 'common_expressions',
    );
    expect(vocabularySkill).toBeDefined();
    expect(expressionsSkill).toBeDefined();
    expect(vocabularySkill?.lifecycleState).toBeNull(); // unobserved, not mastered
    expect(expressionsSkill?.lifecycleState).toBeNull();
    expect(vocabularySkill?.status).toBe('unobserved');
    expect(expressionsSkill?.status).toBe('unobserved');
  });

  it('46c. a resolved specific weakness never claims global curriculum mastery', () => {
    // A resolved pronunciation weakness (stable + resolved) paired with a
    // real row must not project sound_clarity — the same one-sided rule that
    // protects the broad lexical skills protects every projected skill.
    expect(
      projectCurriculumEvidence({
        weaknesses: [
          weaknessRow({
            id: 'w1',
            type: 'pronunciation',
            status: 'mastered',
            referenceId: 'p1',
            resolved: true,
          }),
        ],
        pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      }),
    ).toEqual([]);
  });

  it('47. the projection never mutates its inputs', () => {
    const input = {
      weaknesses: [
        weaknessRow({ id: 'w1', type: 'pronunciation', status: 'confirmed', referenceId: 'p1' }),
      ],
      pronunciationWeaknesses: [pronunciationRow({ id: 'p1', targetSound: 'ending:worked' })],
      vocabulary: [vocabItem('v1', [{ state: 'struggling' }])],
      expressions: [exprItem('e1', [{ state: 'learning' }])],
    };
    const before = JSON.stringify(input);
    const first = projectCurriculumEvidence(input);
    const second = projectCurriculumEvidence(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
  });

  it('48. missing lexical channels are simply no evidence (never fabricated)', () => {
    expect(
      projectCurriculumEvidence({ weaknesses: [], pronunciationWeaknesses: [] }),
    ).toEqual([]);
    expect(
      projectCurriculumEvidence({
        weaknesses: [],
        pronunciationWeaknesses: [],
        vocabulary: undefined,
        expressions: undefined,
      }),
    ).toEqual([]);
  });

  it('49. the projection performs no repository, clock or AI work', () => {
    const source = readFileSync(join(__dirname, 'curriculum-projection.ts'), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line: string) => line.trim().startsWith('import'))
      .join('\n');
    expect(importLines).not.toMatch(/sqlite|providers\/ai|conversation-engine|fetch|node:/i);
    expect(source).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/);
    expect(source).not.toMatch(/upsert|insert|update\(|delete/);
    // The curriculum core must never be modified to import domain types.
    const curriculumTypes = readFileSync(join(__dirname, '../curriculum/types.ts'), 'utf8');
    expect(curriculumTypes).not.toMatch(/domain\/models/);
  });
});

describe('curriculum projection — explicit coverage', () => {
  it('50. the EXACT set of reachable skillIds is pinned', () => {
    // Every skillId this projection can EVER reach, in deterministic order.
    expect(PROJECTED_SKILL_IDS).toEqual([
      'common_expressions',
      'core_vocabulary',
      'sound_clarity',
    ]);
    const supported = CURRICULUM_EVIDENCE_MAPPINGS.filter(
      (mapping) => mapping.status === 'SUPPORTED',
    ).map((mapping) => mapping.skillId);
    expect(new Set(PROJECTED_SKILL_IDS)).toEqual(new Set(supported));
  });

  it('51. every reachable skillId exists in the EXISTING curriculum catalog', async () => {
    const { getSkill } = await import('../curriculum/catalog');
    for (const skillId of PROJECTED_SKILL_IDS) {
      const node = getSkill(skillId);
      expect(node, `catalog is missing ${skillId}`).toBeTruthy();
      const mapping = CURRICULUM_EVIDENCE_MAPPINGS.find((entry) => entry.skillId === skillId);
      expect(node?.domain).toBe(mapping?.domain);
    }
  });

  it('52. no DEAD or UNMAPPABLE mapping can reach a snapshot', () => {
    const blocked = CURRICULUM_EVIDENCE_MAPPINGS.filter(
      (mapping) => mapping.status !== 'SUPPORTED',
    );
    expect(blocked.length).toBeGreaterThan(10);
    const deadKinds = blocked
      .filter((mapping) => mapping.identityKind)
      .map((mapping) => `${mapping.identityKind}:target`);
    const snapshots = projectCurriculumEvidence({
      weaknesses: deadKinds.map((identity, index) =>
        weaknessRow({
          id: `w${index}`,
          type: 'pronunciation',
          status: 'confirmed',
          referenceId: `p${index}`,
          notes: identity,
        }),
      ),
      pronunciationWeaknesses: deadKinds.map((identity, index) =>
        pronunciationRow({ id: `p${index}`, targetSound: identity }),
      ),
    });
    expect(snapshots).toEqual([]);
  });
});

describe('stable-key digest', () => {
  it('53. the digest is deterministic AND identical to the existing stable-reference pattern', async () => {
    const key = stableKey('content-request:v1|A2|listen_and_type');
    expect(key).toBe(stableKey('content-request:v1|A2|listen_and_type'));
    expect(key).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{4,12}$/);
    // Proof of reuse rather than a subtly different second digest.
    const { stableReferenceId } = await import('../listening/generator');
    for (const identity of ['a', 'B1|missing_word', 'word_recognition:deadline']) {
      expect(stableKey(identity)).toBe(stableReferenceId(identity));
    }
  });

  it('54. different identities produce different keys', () => {
    const keys = new Set(
      ['a', 'b', 'A2', 'B1', 'listen_and_type|A2', 'A2|listen_and_type'].map(stableKey),
    );
    expect(keys.size).toBe(6);
  });
});
