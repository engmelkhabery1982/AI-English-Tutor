import { describe, expect, it } from 'vitest';
import { buildNextFocusSummary, type NextFocusInput } from './next-focus';
import { planAdaptiveLesson } from './planner';
import { createNeutralDictionaryCoachingContext } from '../dictionary/prompts';
import type { LearnerWeakness } from '../domain/models/learner';
import type { ProgressRecord, ReviewItem } from '../domain/models/learning';
import type { PracticeActivity } from '../lessons/activity';
const NOW = '2026-09-20T12:00:00.000Z';
const weakness: LearnerWeakness = { id: 'weak', learnerId: 'learner', type: 'grammar', referenceId: 'mistake', status: 'repeated', severity: 0.5, occurrenceCount: 3, contexts: ['work'], evidence: [{ id: 'turn-1', kind: 'turn', at: NOW }, { id: 'turn-2', kind: 'turn', at: NOW }], lastSeenAt: NOW, firstSeenAt: NOW, createdAt: NOW, updatedAt: NOW, resolved: false };
function input(weaknesses: readonly LearnerWeakness[] = []): NextFocusInput {
  const coaching = { ...createNeutralDictionaryCoachingContext(), activeWeaknesses: weaknesses };
  return { now: NOW,
    plan: planAdaptiveLesson({ coaching, hasProfile: true, weaknessTargets: [], pronunciationTargets: [], dueReview: { total: 0, byKind: {} }, now: NOW }),
    profile: { id: 'learner', displayName: 'Learner', targetLanguage: 'en', currentLevel: 'B1', targetLevel: 'B2', learningGoals: [], preferredModes: [], preferences: { correctionIntensity: 'natural' }, createdAt: NOW, updatedAt: NOW },
    weaknesses, reviews: [], vocabulary: [], expressions: [], progress: [], spokenTurns: [], dueCount: 0,
  };
}
function event(kind: PracticeActivity['kind'], action: PracticeActivity['action'] = 'answer', index = 1): ProgressRecord {
  return { id: `progress-${index}`, learnerId: 'learner', recordedAt: NOW, windowStart: NOW, windowEnd: NOW, sessionsCompleted: 0, turnsCompleted: action === 'answer' ? 1 : 0, newWordsLearned: 0, weaknessesImproved: 0, weaknessesWorsened: 0,
    notes: JSON.stringify({ practiceActivity: { version: 1, eventId: `${kind}-${index}`, sessionId: 'session', kind, action, at: NOW, contentId: 'story', answer: action === 'answer' ? 'my answer' : undefined } }),
  };
}
const review: ReviewItem = { id: 'r', learnerId: 'learner', referenceId: 'word', kind: 'vocabulary', prompt: 'recall', state: 'learning', dueAt: NOW, createdAt: NOW, reviewCount: 2, consecutiveCorrect: 1, outcomeHistory: [{ at: '2026-09-19', result: 'incorrect' }, { at: NOW, result: 'correct' }] };
describe('adaptive next focus / progress projection', () => {
  it('no evidence gives honest needs-more-evidence reasons and no scores or improvement', () => {
    const result = buildNextFocusSummary(input());
    expect(result.needsMoreEvidence).toEqual(['listening','reading','speaking']);
    expect(result.nextFocus.reason).toContain('evidence is still limited');
    expect(result.recentImprovement).toEqual([]);
    expect(result.speakingExposure.answers).toBe(0);
    expect(result).not.toHaveProperty('score'); expect(result).not.toHaveProperty('proficiency');
    expect(result.recommendations).toHaveLength(3);
  });
  it('real recurring weakness influences the EXISTING adaptive engine recommendations', () => {
    const result = buildNextFocusSummary(input([weakness]));
    expect(result.recommendations[0].type).toBe('grammar');
    expect(result.recommendations[0].evidenceIds).toContain('weak');
    expect(result.recurringWeakness[0].reason).toContain('repeatedly');
    expect(result.nextFocus.correctionPreference).toBe('natural');
  });
  it('due review backlog becomes an actionable recommendation', () => {
    const result = buildNextFocusSummary({ ...input(), reviews: [review], dueCount: 4 });
    expect(result.nextFocus).toMatchObject({ type: 'review', reason: 'Review saved language because 4 review items are due.' });
    expect(result.reviewBacklog).toBe(4);
  });
  it('recent exposure avoids naively recommending the same practice next, without claiming understanding', () => {
    const result = buildNextFocusSummary({ ...input(), progress: [event('listening', 'exposure')] });
    expect(result.nextFocus.type).toBe('reading');
    expect(result.listeningExposure).toMatchObject({ interactions: 1, answers: 0 });
    expect(result.needsMoreEvidence).toContain('listening');
  });
  it('deduplicates events and identical weakness evidence without deleting records', () => {
    const data = input([weakness, weakness, { ...weakness, id: 'alias', referenceId: 'alias-ref' }]);
    const result = buildNextFocusSummary({ ...data, progress: [event('reading'), event('reading')] });
    expect(result.recurringWeakness).toHaveLength(1);
    expect(result.recurringWeakness[0].evidenceIds).toEqual(['turn-1','turn-2']);
    expect(result.readingExposure.answers).toBe(1);
    expect(data.weaknesses).toHaveLength(3);
  });
  it('only review outcome transitions support item-specific improvement', () => {
    const result = buildNextFocusSummary({ ...input(), reviews: [review, review] });
    expect(result.recentImprovement).toHaveLength(1);
    expect(result.recentImprovement[0].reason).toContain('not a skill-level');
    expect(buildNextFocusSummary({ ...input(), reviews: [{ ...review, outcomeHistory: [{ at: NOW, result: 'correct' }] }] }).recentImprovement).toEqual([]);
  });
  it('saved language is awaiting practice, not learned, and exposure summaries retain actual counts', () => {
    const data = { ...input(), progress: [event('reading'), event('listening')], vocabulary: [{ id: 'word', learnerId: 'learner', headword: 'garden', type: 'word' as const, meanings: [], source: { addedBy: 'learner-created' as const, addedAt: NOW }, createdAt: NOW, updatedAt: NOW }] };
    const result = buildNextFocusSummary(data);
    expect(result.savedItemsAwaitingPractice).toBe(1);
    expect(result.recentlyPractisedLanguage).toEqual([]);
    expect(result.readingExposure.answers).toBe(1); expect(result.listeningExposure.answers).toBe(1);
  });
  it('does not convert text-only conversations to speaking exposure', () => {
    const result = buildNextFocusSummary({ ...input(), spokenTurns: [{ id: 'typed', sessionId: 'session', speaker: 'learner', text: 'typed message', turnIndex: 0, startedAt: NOW }] });
    expect(result.speakingExposure.answers).toBe(0);
  });
});
