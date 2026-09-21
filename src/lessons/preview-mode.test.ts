/**
 * src/lessons/preview-mode.test.ts
 *
 * Package 2 (G): the built-in starter lesson must be playable WITHOUT AI and
 * WITHOUT a learner profile (preview mode), while persisting NOTHING and
 * never implying saved progress. Generated lessons still obey the provider
 * requirements (covered by the existing generation tests + screen contract).
 */

import { describe, expect, it, vi } from 'vitest';
import { STARTER_LESSONS } from './catalogue';
import { StoryLessonSession } from './session';
import { createPreviewProgressSink } from './composition';
import { audio } from './testing/fixtures';
import type { SaveToReviewService } from '../learner-agency';

const save: SaveToReviewService = {
  save: vi.fn(async () => ({ ok: false as const, id: null, duplicate: false, reason: 'no_profile' as const, reviewQueued: false })),
  isSaved: vi.fn(async () => ({ saved: false, id: null, manual: false })),
};

describe('built-in lesson preview mode (no AI, no profile)', () => {
  it('the preview sink accepts practice events but persists nothing', async () => {
    const sink = createPreviewProgressSink();
    const recorded = await sink.record(
      { learnerId: '', recordedAt: new Date().toISOString(), windowStart: '', windowEnd: '', sessionsCompleted: 0, turnsCompleted: 1, newWordsLearned: 0, weaknessesImproved: 0, weaknessesWorsened: 0, notes: '{}' },
      'preview-event',
    );
    expect(recorded.id).toBe('preview-not-saved');
    expect(await sink.list('')).toEqual([]);
    expect(await sink.latest('')).toBeNull();
  });

  it('a built-in lesson is fully playable in preview: read, answer, complete', async () => {
    const lesson = STARTER_LESSONS[0];
    expect(lesson.provenance.kind).toBe('curated'); // authored — no AI involved
    const session = new StoryLessonSession(lesson, 'reading', '', createPreviewProgressSink(), save, audio());

    // Reading exposure + every answer + completion all work with no profile…
    await session.expose();
    for (const question of lesson.questions) {
      const answer = await session.answer(question.id, question.answer);
      expect(answer).not.toBeNull();
    }
    expect(await session.complete()).toBe(true);
    expect(session.snapshot().completed).toBe(true);

    // …and the save service is never asked to fake a saved item.
    expect(save.save).not.toHaveBeenCalled();
    session.dispose();
  });

  it('listening preview requires playback before answering (rules unchanged)', async () => {
    const lesson = STARTER_LESSONS[0];
    const session = new StoryLessonSession(lesson, 'listening', '', createPreviewProgressSink(), save, audio());
    const first = lesson.questions[0];
    expect(await session.answer(first.id, first.answer)).toBeNull();
    expect(session.snapshot().error).toContain('Play the passage');
    await session.play();
    expect(await session.answer(first.id, first.answer)).not.toBeNull();
    session.dispose();
  });

  it('saving a language item without a profile fails honestly (no silent failure)', async () => {
    const lesson = STARTER_LESSONS[0];
    const session = new StoryLessonSession(lesson, 'reading', '', createPreviewProgressSink(), save, audio());
    const result = await session.saveLanguage(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_profile');
    session.dispose();
  });
});
