/**
 * Honest view-models for the Daily Tutor.
 *
 * The contract here is deliberately strict: progress is COUNT-BASED ONLY.
 * No percentages, no scores, no XP, no CEFR claims, no improvement claims —
 * these tests grep the rendered strings to keep that honest.
 */

import { describe, expect, it } from 'vitest';

import {
  activityKindLabel,
  buildDailyTutorHomeCard,
  buildDailyTutorSessionView,
  completedActivityCount,
  currentActivityOf,
} from './view';
import type { DailyTutorSession } from './types';

function session(overrides: Partial<DailyTutorSession> = {}): DailyTutorSession {
  return {
    id: 'dt:learner-1:2026-09-18',
    learnerId: 'learner-1',
    dateKey: '2026-09-18',
    headline: 'Today focuses on review.',
    sourceMode: 'personalized',
    estimatedMinutes: 18,
    status: 'planned',
    createdAt: '2026-09-18T08:00:00.000Z',
    activities: [
      {
        id: 'dt:2026-09-18:review',
        kind: 'review',
        title: 'Quick review',
        reason: '2 review items are due.',
        estimatedMinutes: 5,
        target: { reviewLimit: 2 },
        status: 'pending',
      },
      {
        id: 'dt:2026-09-18:listening',
        kind: 'listening',
        title: 'Listening practice',
        reason: 'Balanced practice.',
        estimatedMinutes: 5,
        target: {},
        status: 'pending',
      },
      {
        id: 'dt:2026-09-18:deep_speaking',
        kind: 'deep_speaking',
        title: 'Speaking practice',
        reason: 'Curriculum priority: elaboration.',
        estimatedMinutes: 7,
        target: { practiceType: 'explain_and_expand' },
        status: 'pending',
      },
      {
        id: 'dt:2026-09-18:adaptive_lesson',
        kind: 'adaptive_lesson',
        title: 'Adaptive lesson',
        reason: 'Curriculum next step.',
        estimatedMinutes: 6,
        target: { skillId: 'past_simple_questions' },
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

describe('activityKindLabel', () => {
  it('labels every known kind', () => {
    expect(activityKindLabel('review')).toBe('Review');
    expect(activityKindLabel('vocabulary')).toBe('Vocabulary review');
    expect(activityKindLabel('expressions')).toBe('Expression review');
    expect(activityKindLabel('adaptive_lesson')).toBe('Adaptive lesson');
    expect(activityKindLabel('listening')).toBe('Listening');
    expect(activityKindLabel('pronunciation')).toBe('Pronunciation');
    expect(activityKindLabel('deep_speaking')).toBe('Speaking');
    expect(activityKindLabel('professional_english')).toBe('Professional English');
    expect(activityKindLabel('weakness_retraining')).toBe('Weakness retraining');
  });
});

describe('currentActivityOf / completedActivityCount', () => {
  it('the current activity is the first not-yet-settled one in order', () => {
    const partial = session({
      status: 'in_progress',
      activities: session().activities.map((activity, index) =>
        index === 0 ? { ...activity, status: 'completed' as const } : activity,
      ),
    });
    expect(currentActivityOf(partial)?.id).toBe('dt:2026-09-18:listening');
  });

  it('a fully settled session has no current activity', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity) => ({
        ...activity,
        status: 'completed' as const,
      })),
    });
    expect(currentActivityOf(done)).toBeNull();
  });

  it('completedActivityCount counts only real completions', () => {
    const mixed = session({
      activities: session().activities.map((activity, index) => ({
        ...activity,
        status: index === 0 ? ('completed' as const) : index === 1 ? ('skipped' as const) : activity.status,
      })),
    });
    expect(completedActivityCount(mixed)).toBe(1);
  });
});

describe('buildDailyTutorHomeCard', () => {
  it('a planned session is the "new" state with a Start button', () => {
    const card = buildDailyTutorHomeCard(session());
    expect(card.state).toBe('new');
    expect(card.buttonLabel).toBe('Start');
    expect(card.completedCount).toBe(0);
    expect(card.activityCount).toBe(4);
    expect(card.title).toBe('Today\u2019s Practice');
  });

  it('an in-progress session is "in_progress" with a Continue button', () => {
    const inProgress = session({
      status: 'in_progress',
      activities: session().activities.map((activity, index) =>
        index === 0 ? { ...activity, status: 'completed' as const, practicedItems: 2 } : activity,
      ),
    });
    const card = buildDailyTutorHomeCard(inProgress);
    expect(card.state).toBe('in_progress');
    expect(card.buttonLabel).toBe('Continue');
    expect(card.completedCount).toBe(1);
    expect(card.progressLabel).toContain('3 remaining');
  });

  it('a completed session is "completed" with a View summary button', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity) => ({
        ...activity,
        status: 'completed' as const,
      })),
    });
    const card = buildDailyTutorHomeCard(done);
    expect(card.state).toBe('completed');
    expect(card.buttonLabel).toBe('View summary');
    expect(card.progressLabel).toBe('4 of 4 activities complete');
  });

  it('progress labels are count-based only — never percentages or scores', () => {
    for (const status of ['planned', 'in_progress', 'completed'] as const) {
      const card = buildDailyTutorHomeCard(
        session({
          status,
          activities: session().activities.map((activity, index) => ({
            ...activity,
            status: status === 'planned' || index > 0 ? activity.status : ('completed' as const),
          })),
        }),
      );
      expect(card.progressLabel).not.toMatch(/%/);
      expect(card.progressLabel).not.toMatch(/\b\d+(\.\d+)?\s*(score|points|xp)\b/i);
      expect(card.headline).not.toMatch(/cefr|a1|a2|b1|b2|c1|c2/i);
    }
  });
});

describe('buildDailyTutorSessionView', () => {
  it('an open session shows the count-based progress label and a current activity', () => {
    const view = buildDailyTutorSessionView(session({ status: 'in_progress' }));
    expect(view.isComplete).toBe(false);
    expect(view.progressLabel).toBe('0 of 4 activities complete');
    expect(view.current?.id).toBe('dt:2026-09-18:review');
    expect(view.summaryLines).toEqual([]); // no summary before completion
  });

  it('a completed session builds honest, per-activity summary lines', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity, index) => ({
        ...activity,
        status: index === 3 ? ('skipped' as const) : ('completed' as const),
        ...(index === 0 ? { practicedItems: 3 } : {}),
        ...(index === 1 ? { practicedItems: 1 } : {}),
      })),
    });
    const view = buildDailyTutorSessionView(done);
    expect(view.isComplete).toBe(true);
    expect(view.completedCount).toBe(3);
    expect(view.skippedCount).toBe(1);
    expect(view.progressLabel).toBe('3 of 4 activities complete');

    const joined = view.summaryLines.join(' | ');
    expect(joined).toContain('You completed 3 of 4 activities.');
    expect(joined).toContain('1 activity was skipped');
    expect(joined).toContain('You practised review — 3 items.');
    expect(joined).toContain('You practised listening — 1 item.');
    expect(joined).toContain('You completed a speaking activity.');
  });

  it('the summary never claims scores, percentages, CEFR or improvement', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity) => ({
        ...activity,
        status: 'completed' as const,
        practicedItems: 2,
      })),
    });
    const view = buildDailyTutorSessionView(done);
    for (const line of view.summaryLines) {
      expect(line).not.toMatch(/%|\bscore\b|\bxp\b|cefr|improved by|better by|mastery/i);
    }
  });

  it('skillsPractised lists only completed activities (skips excluded)', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity, index) => ({
        ...activity,
        status: index === 1 ? ('skipped' as const) : ('completed' as const),
      })),
    });
    const view = buildDailyTutorSessionView(done);
    expect(view.skillsPractised).toEqual(['Review', 'Speaking', 'Adaptive lesson']);
  });

  it('the honest note about persistence appears once, at the end', () => {
    const done = session({
      status: 'completed',
      activities: session().activities.map((activity) => ({
        ...activity,
        status: 'completed' as const,
      })),
    });
    const view = buildDailyTutorSessionView(done);
    expect(view.summaryLines[view.summaryLines.length - 2]).toContain(
      'updated only by the practice you actually did',
    );
    expect(view.summaryLines[view.summaryLines.length - 1]).toContain('Tomorrow');
  });
});
