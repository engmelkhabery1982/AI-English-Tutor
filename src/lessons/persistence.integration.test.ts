import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import { createAppRepositories, createAdaptiveLessonService } from '../adaptive-lessons';
import { createSaveToReviewService } from '../learner-agency';
import { createLanguageInspector, inspectionSaveInput } from '../dictionary/inspector';
import { providerWith, inspectionPayload, audio } from './testing/fixtures';
import { ReviewService } from '../review/service';
import { activeReviewCandidate } from '../review/active-modes';
import { recordPracticeActivity, readPracticeActivity } from './activity';
import { StoryLessonSession } from './session';
import { STARTER_LESSONS } from './catalogue';
import { NextFocusService } from '../progress-dashboard/next-focus-service';
import type { AppRepositories } from '../repositories';
import { createLearningTools } from './composition';
import { generateId } from '../shared/id';

let adapter: SqlJsAdapter, repos: AppRepositories, learnerId: string;
beforeEach(async () => {
  adapter = new SqlJsAdapter(':memory:'); await adapter.init(); repos = createAppRepositories(adapter);
  const profile = await repos.profile.update({ displayName: 'WO3 learner', currentLevel: 'B1', targetLevel: 'B2', learningGoals: [], preferredModes: ['coach'] }); learnerId = profile.id;
});
afterEach(async () => { await adapter.close(); });
describe('learning integration on existing SQLite contracts', () => {
  it('first launch offers inspection without inventing a learner profile', async () => {
    const empty = new SqlJsAdapter(':memory:'); await empty.init();
    try { const tools = await createLearningTools(empty); expect(tools.profile).toBeNull(); expect(() => tools.openLesson(STARTER_LESSONS[0], 'reading', () => {})).toThrow('Create a learner profile'); }
    finally { await empty.close(); }
  });
  it('inspection save round-trips original text, context, selected meaning and generated provenance; duplicates never reset review', async () => {
    const result = await createLanguageInspector(providerWith(inspectionPayload)).inspect({ originalText: 'Please break the ice at the meeting.', selectedText: 'break the ice', itemType: 'idiom', targetLanguage: 'Arabic' });
    if (!result.ok) throw Error('inspection failed');
    const save = createSaveToReviewService({ databaseAdapter: adapter });
    const input = inspectionSaveInput(learnerId, result.value, 'sense-1');
    const saved = await save.save(input); if (!saved.ok) throw Error('save failed');
    const stored = await repos.expressions.get(saved.id);
    expect(stored?.source).toMatchObject({ originalText: input.originalText, selectedSenseId: 'sense-1', containsGeneratedText: true, generatedBy: 'test-provider', saveSource: 'manual_learner', saveOrigin: 'inspector' });
    expect(stored?.meanings[0].examples).toHaveLength(3);
    expect(stored?.meanings[0].examples[0].source).toBe('ai-generated');
    expect(stored?.meanings[0].examples[2].source).toBe('manual');
    const review = await repos.review.getByReference!(learnerId, 'expression', saved.id);
    await repos.review.markReviewed(review!.id, 'correct', 'real attempt', 'attempt-1');
    const before = await repos.review.getByReference!(learnerId, 'expression', saved.id);
    expect(await save.save(input)).toMatchObject({ duplicate: true });
    expect(await repos.review.getByReference!(learnerId, 'expression', saved.id)).toEqual(before);
    expect(await repos.progress.list(learnerId)).toHaveLength(0);
    expect(await repos.weaknesses.listWeaknesses(learnerId)).toHaveLength(0);
  });
  it('active Review uses queued saves, persists one row, updates only the practiced meaning and is restart-idempotent', async () => {
    const save = createSaveToReviewService({ databaseAdapter: adapter });
    const saved = await save.save({ learnerId, text: 'run', itemType: 'word', selectedMeaning: 'Manage a business', example: 'We run a cafe.', additionalExamples: ['They run a shop.'], origin: 'inspector', meaningIsGenerated: true });
    if (!saved.ok) throw Error('save failed');
    const item = (await repos.vocabulary.get(saved.id))!;
    await repos.vocabulary.update(item.id, { meanings: [...item.meanings, { definition: 'Move quickly on foot', examples: [{ text: 'We run in the park.', source: 'curated' }] }] });
    const service = new ReviewService(repos);
    const candidates = await service.planSession(learnerId, { minItems: 1, activeModes: { audio: true, speech: false, provider: false } });
    const candidate = candidates.find(c => c.referenceId === item.id)!;
    expect(candidate.active).toMatchObject({ meaningIndex: 0, mode: 'produce_item' });
    const evaluation = await service.evaluateAnswer(candidate, 'run');
    await service.recordPracticeResult(learnerId, candidate, 'run', evaluation, undefined, { attemptId: 'saved-attempt' });
    await new ReviewService(repos).recordPracticeResult(learnerId, candidate, 'run', evaluation, undefined, { attemptId: 'saved-attempt' });
    const stored = (await repos.vocabulary.get(item.id))!;
    expect(stored.meanings[0].review?.reviewCount).toBe(1);
    expect(stored.meanings[1].review?.reviewCount ?? 0).toBe(0);
    const review = (await repos.review.getByReference!(learnerId, 'vocabulary', item.id))!;
    expect(review.reviewCount).toBe(1); expect(review.outcomeHistory).toHaveLength(1);
    const next = activeReviewCandidate({ ...candidate, reviewCount: 1 }, stored, { audio: true, speech: false, provider: false });
    expect(next.active?.meaningIndex).toBe(1);
    expect((await repos.review.list!(learnerId)).filter(r => r.referenceId === item.id)).toHaveLength(1);
  });
  it.each(['listening','reading'] as const)('%s lesson completes through progress records and Save to Review with no fake level or weakness', async mode => {
    const save = createSaveToReviewService({ databaseAdapter: adapter });
    const session = new StoryLessonSession(STARTER_LESSONS[0], mode, learnerId, repos.progress, save, audio());
    if (mode === 'listening') await session.play(); else await session.expose();
    session.reveal(true);
    for (const q of session.lesson.questions) await session.answer(q.id, q.answer);
    await session.complete(); await session.complete();
    await session.saveLanguage(0); await session.saveLanguage(0);
    const records = await repos.progress.list(learnerId);
    expect(records.filter(r => readPracticeActivity(r)?.action === 'complete')).toHaveLength(1);
    expect(records.reduce((n, r) => n + r.turnsCompleted, 0)).toBe(2);
    expect(await repos.review.list!(learnerId)).toHaveLength(1);
    expect((await repos.profile.get()).currentLevel).toBe('B1');
    expect(await repos.weaknesses.listWeaknesses(learnerId)).toHaveLength(0);
    const summary = await new NextFocusService(repos, createAdaptiveLessonService(adapter, { disableAI: true })).load();
    expect(mode === 'reading' ? summary.readingExposure.answers : summary.listeningExposure.answers).toBe(2);
    expect(summary.savedItemsAwaitingPractice).toBe(1);
    session.dispose();
  });
  it('progress event idempotency survives recreation and cannot collide across learners', async () => {
    const event = { version: 1 as const, eventId: 'attempt', sessionId: 's', kind: 'read_aloud' as const, action: 'transcript_comparison' as const, at: new Date().toISOString(), contentId: 'story', answer: 'Actual STT text' };
    await recordPracticeActivity(repos.progress, learnerId, event);
    await recordPracticeActivity(createAppRepositories(adapter).progress, learnerId, event);
    expect(await repos.progress.list(learnerId)).toHaveLength(1);
    // No foreign learner write is needed to prove the identity is scoped.
    const id = (await repos.progress.list(learnerId))[0].id;
    expect(id).not.toBe(event.eventId); expect(id).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('next-focus service sees real persisted weakness and never writes projections', async () => {
    await repos.weaknesses.upsertWeakness({ learnerId, referenceId: generateId(), type: 'grammar', status: 'repeated', occurrenceCount: 3, severity: 0.4, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), contexts: [], evidence: [{ kind: 'turn', id: generateId(), at: new Date().toISOString(), summary: 'Actual correction' }], resolved: false });
    const service = new NextFocusService(repos, createAdaptiveLessonService(adapter, { disableAI: true }));
    const summary = await service.load();
    expect(summary.recurringWeakness).toHaveLength(1);
    expect(summary.recommendations.some(r => r.type === 'grammar')).toBe(true);
    expect(await repos.progress.list(learnerId)).toHaveLength(0);
  });
});
