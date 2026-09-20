import { describe, expect, it, vi } from 'vitest';
import { STARTER_LESSONS, starterForLevel } from './catalogue';
import { StoryLessonSession } from './session';
import { generateStoryLesson } from './generation';
import { audio, progressMemory, providerWith, failingProvider } from './testing/fixtures';
import { readPracticeActivity } from './activity';
import type { SaveToReviewService } from '../learner-agency';
const save: SaveToReviewService = { save: vi.fn(async () => ({ ok: true as const, id: 'saved', duplicate: false, reason: 'created' as const, reviewQueued: true })), isSaved: vi.fn(async () => ({ saved: false, id: null, manual: false })) };
function fixture(mode: 'listening' | 'reading' = 'listening') {
  const progress = progressMemory(), tts = audio();
  const session = new StoryLessonSession(STARTER_LESSONS[0], mode, 'learner', progress, save, tts);
  return { session, progress, tts };
}
const generated = { title: 'A garden', passage: 'We set up a garden. Each neighbour took a turn watering it.', questions: [
  { id: 'q1', prompt: 'What did they set up?', options: ['A garden','A shop'], answer: 'A garden', explanation: 'They set up a garden.' },
  { id: 'q2', prompt: 'Who watered it?', options: ['Each neighbour','One gardener'], answer: 'Each neighbour', explanation: 'Each neighbour took a turn.' },
], language: [{ text: 'set up', itemType: 'phrase', meaning: 'Establish', context: 'We set up a garden.' }] };

describe('shared listening/reading lessons', () => {
  it('loads a small level-aware starter set with no assessment or AI claims', () => {
    expect(STARTER_LESSONS).toHaveLength(6);
    expect(starterForLevel('B2').level).toBe('B2');
    expect(starterForLevel('unknown').level).toBe('A1');
    for (const l of STARTER_LESSONS) { expect(l.questions.length).toBeGreaterThan(0); expect(l.provenance.kind).toBe('curated'); }
  });
  it('transcript reveal/hide, replay and slower playback never create comprehension evidence or completion', async () => {
    const { session, progress, tts } = fixture();
    session.reveal(true); session.reveal(false);
    expect(progress.record).not.toHaveBeenCalled();
    await session.play(); await session.play(true);
    expect(session.snapshot()).toMatchObject({ playback: 'idle', answers: [], completed: false, assistance: { revealed: true, plays: 2, slowed: true } });
    expect(vi.mocked(progress.record).mock.calls.every(([r]) => r.turnsCompleted === 0 && r.sessionsCompleted === 0)).toBe(true);
    expect(vi.mocked(tts.speak).mock.calls[1][1]?.rate).toBe(0.75);
    expect(await session.complete()).toBe(false);
  });
  it('does not offer unsupported speed or count failed playback', async () => {
    const progress = progressMemory(), tts = { ...audio(), supportsSpeechRate: false };
    const session = new StoryLessonSession(STARTER_LESSONS[0], 'listening', 'learner', progress, save, tts);
    await session.play(true); expect(tts.speak).not.toHaveBeenCalled();
    vi.mocked(tts.speak).mockRejectedValueOnce(new Error('HTTP 503 {payload}'));
    await session.play();
    expect(session.snapshot().playback).toBe('error');
    expect(session.snapshot().error).not.toContain('HTTP');
    expect(progress.record).not.toHaveBeenCalled();
  });
  it.each(['listening','reading'] as const)('%s: only actual choices create evidence; empty/skip/duplicate do not', async mode => {
    const { session, progress } = fixture(mode);
    expect(await session.answer('main', '')).toBeNull();
    if (mode === 'listening') { expect(await session.answer('main', session.lesson.questions[0].answer)).toBeNull(); await session.play(); }
    for (const question of session.lesson.questions) {
      const answer = await session.answer(question.id, question.answer);
      expect(answer?.evaluation.result).toBe('understood');
      expect(await session.answer(question.id, question.answer)).toBeNull();
    }
    expect(await session.complete()).toBe(true);
    const records = vi.mocked(progress.record).mock.calls.map(([r]) => r);
    expect(records.filter(r => r.turnsCompleted === 1)).toHaveLength(2);
    expect(records.filter(r => r.sessionsCompleted === 1)).toHaveLength(1);
    expect(records.every(r => r.listeningScore === undefined && r.newWordsLearned === 0)).toBe(true);
  });
  it.each(['listening','reading'] as const)('%s: selected inspection and universal save preserve source', async mode => {
    const { session } = fixture(mode);
    expect(session.inspection('busy', 'Arabic')).toMatchObject({ originalText: session.lesson.passage, selectedText: 'busy', contextSource: 'curated' });
    await session.saveLanguage(0);
    expect(save.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'busy', origin: mode, contextSource: 'curated', meaningIsGenerated: false }));
  });
  it('failed answer persistence allows retry without losing the lesson or committing completion', async () => {
    const { session, progress } = fixture('reading');
    vi.mocked(progress.record).mockRejectedValueOnce(new Error('disk full'));
    expect(await session.answer('main', session.lesson.questions[0].answer)).toBeNull();
    expect(session.snapshot().error).toContain('kept');
    expect(session.snapshot().answers).toHaveLength(0);
    expect(session.snapshot().pendingAnswer?.answer).toBe(session.lesson.questions[0].answer);
    expect(await session.answer('main', session.lesson.questions[0].options[1])).toBeNull();
    expect(await session.answer('main', session.lesson.questions[0].answer)).not.toBeNull();
  });
  it('late playback callbacks cannot mutate a disposed lesson', async () => {
    const { session, tts, progress } = fixture();
    vi.mocked(tts.speak).mockImplementation(async () => {});
    await session.play();
    const options = vi.mocked(tts.speak).mock.calls[0][1]; session.dispose(); options?.onStart?.(); options?.onDone?.();
    expect(progress.record).not.toHaveBeenCalled();
    expect(session.snapshot().assistance.plays).toBe(0);
  });
  it('generates validated shared content and marks provenance', async () => {
    const result = await generateStoryLesson(providerWith(generated), { level: 'B1', topic: 'Gardens' });
    expect(result.ok && result.value).toMatchObject({ level: 'B1', provenance: { kind: 'ai-generated', providerId: 'test-provider' } });
  });
  it('rejects ungrounded content and invalid options rather than making up answers', async () => {
    const result = await generateStoryLesson(providerWith({ ...generated, language: [{ ...generated.language[0], context: 'Not in the passage' }] }), { level: 'B1', topic: 'Gardens' });
    expect(!result.ok && result.failure.kind).toBe('malformed_response');
  });
  it.each(['reading','listening'])('%s generation failure is classified and explicit retry keeps request', async () => {
    const request = { level: 'B1' as const, topic: 'My topic' }, provider = failingProvider();
    const first = await generateStoryLesson(provider, request);
    expect(!first.ok && first.failure.kind).toBe('rate_limited');
    expect(request.topic).toBe('My topic');
    vi.mocked(provider.generate).mockResolvedValueOnce({ ok: true, response: { content: JSON.stringify(generated) } });
    expect((await generateStoryLesson(provider, request)).ok).toBe(true);
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
  it('legacy/malformed progress is not fabricated as typed exposure', () => {
    expect(readPracticeActivity({ id: 'old', notes: 'old aggregate' } as Parameters<typeof readPracticeActivity>[0])).toBeNull();
  });
});
