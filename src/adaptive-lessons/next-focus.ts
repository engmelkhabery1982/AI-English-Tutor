/** Next-activity projection of the EXISTING adaptive plan, with reading/exposure
 * coverage. It is not a second curriculum engine and writes no learner data. */
import type { AdaptiveLessonPlan, AdaptiveLessonStep } from './types';
import type { LearnerWeakness, UserProfile } from '../domain/models/learner';
import type { ReviewItem, ProgressRecord } from '../domain/models/learning';
import type { ConversationTurn } from '../domain/models/conversation';
import type { VocabularyItem, ExpressionItem } from '../domain/models/vocabulary';
import { readPracticeActivity } from '../lessons/activity';
import type { PracticeActivity } from '../lessons/activity';

export type NextPracticeType = 'conversation' | 'listening' | 'reading' | 'shadowing' | 'review' | 'grammar' | 'read_aloud';
export interface NextPracticeRecommendation {
  readonly type: NextPracticeType;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly targetLevel: string;
  readonly correctionPreference: string;
}
export interface ExposureSummary {
  readonly interactions: number;
  readonly answers: number;
  readonly lastAt: string | null;
  readonly note: string;
}
export interface NextFocusSummary {
  readonly recommendations: readonly NextPracticeRecommendation[];
  readonly nextFocus: NextPracticeRecommendation;
  readonly suggestedNextLessonType: NextPracticeType;
  readonly recentImprovement: readonly { readonly itemId: string; readonly reason: string }[];
  readonly recurringWeakness: readonly { readonly id: string; readonly type: string; readonly reason: string; readonly evidenceIds: readonly string[] }[];
  readonly needsMoreEvidence: readonly string[];
  readonly reviewBacklog: number;
  readonly speakingExposure: ExposureSummary;
  readonly listeningExposure: ExposureSummary;
  readonly readingExposure: ExposureSummary;
  readonly savedItemsAwaitingPractice: number;
  readonly recentlyPractisedLanguage: readonly { readonly id: string; readonly text: string; readonly at: string }[];
  readonly scope: string;
}
export interface NextFocusInput {
  readonly plan: AdaptiveLessonPlan;
  readonly profile: UserProfile;
  readonly weaknesses: readonly LearnerWeakness[];
  readonly reviews: readonly ReviewItem[];
  readonly vocabulary: readonly VocabularyItem[];
  readonly expressions: readonly ExpressionItem[];
  readonly progress: readonly ProgressRecord[];
  readonly spokenTurns: readonly ConversationTurn[];
  readonly dueCount: number;
  readonly now: string;
}
const unique = <T,>(values: readonly T[], key: (v: T) => string): T[] => [...new Map(values.map(v => [key(v), v])).values()];
function latest(values: readonly string[]): string | null { return [...values].sort().at(-1) ?? null; }
function exposure(events: readonly PracticeActivity[], kind: PracticeActivity['kind']): ExposureSummary {
  const selected = events.filter(e => e.kind === kind);
  return { interactions: new Set(selected.map(e => e.sessionId)).size, answers: selected.filter(e => e.action === 'answer' || e.action === 'transcript_comparison').length,
    lastAt: latest(selected.map(e => e.at)), note: 'Observed interactions only; exposure and assistance do not establish proficiency.' };
}
function stepType(step: AdaptiveLessonStep): NextPracticeType {
  return step.type === 'listening' ? 'listening' : step.type === 'pronunciation' ? 'read_aloud' : step.type === 'speaking' ? 'conversation' : step.target.kind === 'learner_weakness' && step.type === 'review' ? 'grammar' : 'review';
}
export function buildNextFocusSummary(input: NextFocusInput): NextFocusSummary {
  const events = unique(input.progress.flatMap(r => { const e = readPracticeActivity(r); return e ? [e] : []; }), e => e.eventId);
  const listeningExposure = exposure(events, 'listening'), readingExposure = exposure(events, 'reading');
  const readAloud = exposure(events, 'read_aloud');
  // Text conversation counts are deliberately NOT relabelled as speaking.
  const spoken = unique(input.spokenTurns.filter(t => t.speaker === 'learner' && Boolean(t.audioRef) && t.text.trim()), t => t.id);
  const speakingExposure = { ...readAloud, interactions: readAloud.interactions + spoken.length, answers: readAloud.answers + spoken.length, lastAt: latest([...spoken.map(t => t.startedAt), ...(readAloud.lastAt ? [readAloud.lastAt] : [])]), note: 'Only audio-linked learner turns and read-aloud transcripts. Text-only conversation is not speaking evidence.' };
  const evidenceUsed = new Set<string>();
  const recurringWeakness = unique(input.weaknesses, w => `${w.type}:${w.referenceId}`).filter(w => !w.resolved && w.occurrenceCount >= 2 && w.evidence.length > 0).flatMap(w => {
    const evidenceIds = [...new Set(w.evidence.map(e => e.id))].filter(id => !evidenceUsed.has(id));
    if (!evidenceIds.length) return [];
    evidenceIds.forEach(id => evidenceUsed.add(id));
    return [{ id: w.id, type: w.type, reason: `This ${w.type.replace(/_/g, ' ')} difficulty has been observed repeatedly.`, evidenceIds }];
  });
  const counts = { listening: listeningExposure, reading: readingExposure, conversation: speakingExposure };
  const needsMoreEvidence = Object.entries(counts).filter(([, e]) => e.answers < 3).map(([kind]) => kind === 'conversation' ? 'speaking' : kind);
  const lexical = [...input.vocabulary.map(v => ({ id: v.id, text: v.headword, meanings: v.meanings })), ...input.expressions.map(e => ({ id: e.id, text: e.expression, meanings: e.meanings }))];
  const reviews = unique(input.reviews, r => `${r.kind}:${r.referenceId}`);
  const recentImprovement = reviews.flatMap(r => {
    const history = r.outcomeHistory;
    const last = history.at(-1);
    return last?.result === 'correct' && Date.parse(input.now) - Date.parse(last.at) <= 30 * 86400000 && history.slice(0, -1).some(o => o.result === 'incorrect' || o.result === 'partial')
      ? [{ itemId: r.referenceId, reason: 'The latest recorded review was correct after an earlier miss or partial answer. This is item-specific evidence, not a skill-level improvement claim.' }] : [];
  }).slice(0, 5);
  const candidates: { type: NextPracticeType; reason: string; evidenceIds: readonly string[]; priority: number; lastAt: string | null }[] = [];
  if (input.dueCount > 0) candidates.push({ type: 'review', reason: `Review saved language because ${input.dueCount} review items are due.`, evidenceIds: reviews.filter(r => r.state !== 'retired' && r.dueAt <= input.now).map(r => r.id), priority: 0, lastAt: null });
  for (const step of input.plan.steps.filter(s => s.personalized && s.type !== 'wrap_up')) {
    const type = stepType(step);
    candidates.push({ type, reason: step.reason.message, evidenceIds: step.target.id ? [step.target.id] : [], priority: 1,
      lastAt: type === 'listening' ? listeningExposure.lastAt : type === 'conversation' || type === 'read_aloud' ? speakingExposure.lastAt : null });
  }
  for (const [kind, value] of Object.entries(counts)) {
    const type = kind as 'listening' | 'reading' | 'conversation';
    const label = kind === 'conversation' ? 'speaking' : kind;
    candidates.push({ type, reason: value.answers < 3 ? `Practise ${label} because evidence is still limited.` : `Try ${label} for balanced practice; exposure alone does not prove improvement.`, evidenceIds: [], priority: value.answers < 3 ? 2 : 3, lastAt: value.lastAt });
  }
  // Recent exposure breaks simplistic repeats, but never suppresses an overdue queue.
  const recent = (at: string | null) => at && Date.parse(input.now) - Date.parse(at) < 24 * 3600000 ? 2 : 0;
  candidates.sort((a, b) => (a.priority + (a.priority ? recent(a.lastAt) : 0)) - (b.priority + (b.priority ? recent(b.lastAt) : 0)) || (a.lastAt ?? '').localeCompare(b.lastAt ?? ''));
  const seen = new Set<string>();
  const recommendations = candidates.filter(c => { if (seen.has(c.type)) return false; seen.add(c.type); return true; }).slice(0, 3).map(c => ({ type: c.type, reason: c.reason, evidenceIds: c.evidenceIds,
    targetLevel: input.profile.currentLevel === 'unknown' ? 'A1' : input.profile.currentLevel,
    correctionPreference: input.profile.preferences?.correctionIntensity ?? 'balanced' }));
  return { recommendations, nextFocus: recommendations[0], suggestedNextLessonType: recommendations[0].type,
    recentImprovement, recurringWeakness, needsMoreEvidence, reviewBacklog: input.dueCount,
    speakingExposure, listeningExposure, readingExposure,
    savedItemsAwaitingPractice: lexical.filter(l => !l.meanings.some(m => (m.review?.reviewCount ?? 0) > 0)).length,
    recentlyPractisedLanguage: lexical.flatMap(l => { const at = latest(l.meanings.flatMap(m => m.review?.lastReviewAt ? [m.review.lastReviewAt] : [])); return at ? [{ id: l.id, text: l.text, at }] : []; }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
    scope: 'Recent bounded history (up to 500 progress, 200 review/weakness, 500 lexical rows per kind, 30 conversations). Review backlog is an exact queue count. Missing or legacy untyped activity is unknown, not zero proficiency.',
  };
}
