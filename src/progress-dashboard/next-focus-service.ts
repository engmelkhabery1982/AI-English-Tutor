import type { AppRepositories } from '../repositories';
import type { AdaptiveLessonService } from '../adaptive-lessons/service';
import { buildNextFocusSummary } from '../adaptive-lessons/next-focus';

/** Read-only summary for future Home/Progress. All scheduling stays in the adaptive engine. */
export class NextFocusService {
  constructor(private readonly repos: AppRepositories, private readonly adaptive: Pick<AdaptiveLessonService, 'planLesson'>) {}
  async load(now = new Date().toISOString()) {
    const profile = await this.repos.profile.get();
    if (!profile) throw new Error('Create your learner profile before planning practice.');
    const [planned, weaknesses, reviews, vocabulary, expressions, progress, sessions, dueCount] = await Promise.all([
      this.adaptive.planLesson(profile.id, { force: true }), this.repos.weaknesses.listWeaknesses(profile.id, 200),
      this.repos.review.list?.(profile.id, 200) ?? this.repos.review.listDue(profile.id, now, 200),
      this.repos.vocabulary.list(profile.id, { limit: 500 }), this.repos.expressions.list(profile.id, { limit: 500 }),
      this.repos.progress.list(profile.id, 500), this.repos.conversations.listSessions(profile.id, 30),
      this.repos.review.countDue?.(profile.id, now) ?? this.repos.review.listDue(profile.id, now).then(rows => rows.length),
    ]);
    if (planned.status !== 'planned') throw new Error(planned.message);
    const turns = (await Promise.all(sessions.map(s => this.repos.conversations.listTurns(s.id)))).flat();
    return buildNextFocusSummary({ plan: planned.plan, profile, weaknesses, reviews, vocabulary, expressions, progress, spokenTurns: turns, dueCount, now });
  }
}
