/** Typed events carried by EXISTING progress_records.notes, not an analytics store.
 * No proficiency, level or weakness mutation. Idempotency is owned by ProgressRepository.
 */
import type { ProgressRepository } from '../repositories';
import type { ProgressRecord } from '../domain/models/learning';
export interface PracticeActivity {
  readonly version: 1;
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: 'listening' | 'reading' | 'read_aloud';
  readonly action: 'exposure' | 'answer' | 'complete' | 'transcript_comparison';
  readonly at: string;
  readonly contentId: string;
  readonly assisted?: boolean;
  readonly answer?: string;
  readonly target?: string;
  readonly outcome?: string;
}
export async function recordPracticeActivity(repo: ProgressRepository, learnerId: string, event: PracticeActivity): Promise<void> {
  if ((event.action === 'answer' || event.action === 'transcript_comparison') && !event.answer?.trim()) return;
  await repo.record({ learnerId, recordedAt: event.at, windowStart: event.at, windowEnd: event.at,
    sessionsCompleted: event.action === 'complete' ? 1 : 0,
    turnsCompleted: event.action === 'answer' || event.action === 'transcript_comparison' ? 1 : 0,
    newWordsLearned: 0, weaknessesImproved: 0, weaknessesWorsened: 0,
    notes: JSON.stringify({ practiceActivity: event }),
  }, event.eventId);
}
export function readPracticeActivity(record: ProgressRecord): PracticeActivity | null {
  try {
    const e = JSON.parse(record.notes ?? '').practiceActivity;
    if (e?.version !== 1 || !['listening','reading','read_aloud'].includes(e.kind) || !['exposure','answer','complete','transcript_comparison'].includes(e.action) || typeof e.eventId !== 'string' || typeof e.sessionId !== 'string' || typeof e.at !== 'string' || typeof e.contentId !== 'string') return null;
    return e;
  } catch { return null; }
}
