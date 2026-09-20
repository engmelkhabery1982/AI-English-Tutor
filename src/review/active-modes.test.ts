import { describe, expect, it, vi } from 'vitest';
import { activeReviewCandidate, evaluateActiveReview, type ActiveReviewMode } from './active-modes';
import { varyReviewContext } from './context-practice';
import type { ReviewItemCandidate } from './types';
import type { VocabularyItem } from '../domain/models/vocabulary';
import { providerWith, failingProvider } from '../lessons/testing/fixtures';
const base: ReviewItemCandidate = { id: 'review', learnerId: 'learner', referenceId: 'item', kind: 'vocabulary', exerciseType: 'vocabulary_recall', prompt: '', expectedAnswer: 'run', dueAt: '2026-01-01', reviewCount: 0, consecutiveCorrect: 0 };
const item: VocabularyItem = { id: 'item', learnerId: 'learner', headword: 'run', type: 'word', source: { addedBy: 'learner-created', addedAt: '2026-01-01', containsGeneratedText: true }, createdAt: '2026-01-01', updatedAt: '2026-01-01', meanings: [
  { definition: 'Manage a business', examples: [{ text: 'They run a shop.', source: 'ai-generated' }, { text: 'We run a small hotel.', source: 'ai-generated' }] },
  { definition: 'Move quickly on foot', examples: [{ text: 'I run to school.', source: 'curated' }, { text: 'We run in the park.', source: 'curated' }] },
] };
const capabilities = { audio: true, speech: true, provider: true };
describe('active review projection and evaluation', () => {
  it('deterministically selects only supported modes, retains identities and honours item type', () => {
    const first = activeReviewCandidate(base, item, capabilities);
    expect(first).toEqual(activeReviewCandidate(base, item, capabilities));
    expect(first.active?.mode).toBe('produce_item');
    const offline = Array.from({ length: 20 }, (_, reviewCount) => activeReviewCandidate({ ...base, reviewCount }, item, { audio: false, speech: false, provider: false }));
    expect(offline.every(c => !['create_sentence','speak_sentence','listen_recognize','recall_meaning'].includes(c.active!.mode))).toBe(true);
    expect(first.active?.itemType).toBe('word'); expect(first.referenceId).toBe(base.referenceId);
  });
  it.each(['recall_meaning','produce_item','produce_from_context','choose_meaning','create_sentence','listen_recognize','speak_sentence'] as const)('supports %s appropriately', mode => {
    const candidate = activeReviewCandidate(base, item, capabilities, mode);
    expect(candidate.active?.mode).toBe(mode);
    if (mode === 'listen_recognize') { expect(candidate.active?.audioText).toBe('run'); expect(candidate.contextSentence).toBeUndefined(); expect(candidate.definition).toBeUndefined(); }
    if (mode === 'choose_meaning') expect(candidate.active?.choices).toHaveLength(2);
    if (mode === 'recall_meaning') expect(candidate.definition).toBeUndefined();
  });
  it('does not ask for a sentence using a whole saved sentence', () => {
    const sentence = activeReviewCandidate(base, { ...item, type: 'sentence' }, capabilities);
    expect(sentence.active?.availableModes).not.toContain('create_sentence');
    expect(sentence.active?.availableModes).not.toContain('speak_sentence');
  });
  it('rotates known meanings and distinct examples, without new review identities', () => {
    const secondSense = activeReviewCandidate({ ...base, reviewCount: 1 }, item, capabilities);
    const newContext = activeReviewCandidate({ ...base, reviewCount: 2 }, item, capabilities);
    expect(secondSense.active?.meaningDefinition).toBe('Move quickly on foot');
    expect(newContext.active?.contextIndex).toBe(1);
    expect(newContext.contextSentence).toBe('We run a small hotel.');
    expect(newContext.id).toBe(base.id);
  });
  it('does not keep showing a lone identical example across attempts', () => {
    const single = { ...item, meanings: [{ ...item.meanings[0], examples: [item.meanings[0].examples[0]] }] };
    const later = activeReviewCandidate({ ...base, reviewCount: 1 }, single, capabilities, 'recall_meaning');
    expect(later.contextSentence).toBeUndefined();
  });
  it.each(['produce_item','produce_from_context','listen_recognize'] as const)('%s compares actual learner answers to the target', async mode => {
    const candidate = activeReviewCandidate(base, item, capabilities, mode);
    expect((await evaluateActiveReview(candidate, 'run', undefined, { source: 'typed', playbackStarted: true })).result).toBe('correct');
    expect((await evaluateActiveReview(candidate, 'walk', undefined, { source: 'typed', playbackStarted: true })).result).toBe('incorrect');
    await expect(evaluateActiveReview(candidate, '')).rejects.toThrow();
  });
  it.each(['recall_meaning','create_sentence','speak_sentence'] as ActiveReviewMode[])('%s requires semantic evidence, not substring grading', async mode => {
    const candidate = activeReviewCandidate(base, item, capabilities, mode);
    const provider = providerWith({ result: 'partial', feedback: 'Check the selected meaning.', suggestedCorrection: 'I run a cafe.' });
    expect((await evaluateActiveReview(candidate, 'I run a race.', provider, { source: 'stt' })).result).toBe('partial');
    expect(provider.generate).toHaveBeenCalledOnce();
    await expect(evaluateActiveReview(candidate, 'run', failingProvider())).rejects.toThrow();
  });
  it('refuses fake listening/speaking submissions without controller evidence', async () => {
    await expect(evaluateActiveReview(activeReviewCandidate(base, item, capabilities, 'listen_recognize'), 'run')).rejects.toThrow('Play the item');
    await expect(evaluateActiveReview(activeReviewCandidate(base, item, capabilities, 'speak_sentence'), 'I run a shop.', undefined, { source: 'typed' })).rejects.toThrow('Record your own');
  });
  it('variation stays in the selected meaning, marks generated provenance, rejects repeated contexts and never creates rows', async () => {
    const candidate = activeReviewCandidate(base, item, capabilities);
    const provider = providerWith({ sentence: 'My cousins run a bakery by the station.' });
    const varied = await varyReviewContext(candidate, provider);
    expect(varied).toMatchObject({ id: base.id, referenceId: base.referenceId, contextSentence: 'My cousins _____ a bakery by the station.', active: { meaningIndex: 0, contextProvenance: 'ai-generated', mode: 'produce_from_context' } });
    expect(JSON.stringify(vi.mocked(provider.generate).mock.calls[0][0])).toContain('Manage a business');
    await expect(varyReviewContext(varied, provider)).rejects.toThrow();
    await expect(varyReviewContext(candidate)).rejects.toThrow();
  });
});
