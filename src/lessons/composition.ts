import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { isProfileNotFoundError } from '../review/profile-guard';
import { getAppDatabase } from '../data/local/sqlite/app-database';
import { createAppRepositories, createAdaptiveLessonService } from '../adaptive-lessons';
import { NextFocusService } from '../progress-dashboard/next-focus-service';
import { createSaveToReviewService } from '../learner-agency';
import { resolveReviewProviders } from '../review/providers';
import { createExpoAudioRecorder, createExpoTTSProvider } from '../talk-demo';
import { StoryLessonSession } from './session';
import { ReadAloudPractice } from './read-aloud';
import type { StoryLesson, LessonMode } from './types';
import type { ProgressRepository } from '../repositories';
import type { ProgressRecord } from '../domain/models/learning';

/**
 * PREVIEW MODE sink (Package 2, G): built-in lessons are fully playable
 * without AI and without a learner profile. Practice events go to this no-op
 * sink instead of the database, so preview never persists anything and never
 * fabricates saved progress. The surface states clearly that saving needs a
 * profile.
 */
export function createPreviewProgressSink(): ProgressRepository {
  return {
    async record(record: Omit<ProgressRecord, 'id'>): Promise<ProgressRecord> {
      return { ...record, id: 'preview-not-saved' };
    },
    async list(): Promise<readonly ProgressRecord[]> {
      return [];
    },
    async latest(): Promise<ProgressRecord | null> {
      return null;
    },
  };
}

export async function createLearningTools(databaseAdapter?: DatabaseAdapter) {
  const adapter = databaseAdapter ?? (await getAppDatabase()).adapter;
  const repos = createAppRepositories(adapter);
  const profile = await repos.profile.get().catch(error => { if (isProfileNotFoundError(error)) return null; throw error; });
  const providers = resolveReviewProviders({ isDemo: false });
  const save = createSaveToReviewService({ databaseAdapter: adapter });
  return {
    profile, get provider() { return resolveReviewProviders({ isDemo: false }).aiProvider; }, save,
    nextFocus: new NextFocusService(repos, createAdaptiveLessonService(adapter)),
    /**
     * Opens a lesson session. WITHOUT a profile the session runs in PREVIEW
     * mode: the built-in lesson is fully playable (no AI involved), but all
     * practice events go to the no-op preview sink — nothing is persisted and
     * no saved progress is implied.
     */
    openLesson(lesson: StoryLesson, mode: LessonMode, changed: () => void) {
      if (!profile) {
        return new StoryLessonSession(lesson, mode, '', createPreviewProgressSink(), save, createExpoTTSProvider(), changed);
      }
      return new StoryLessonSession(lesson, mode, profile.id, repos.progress, save, createExpoTTSProvider(), changed);
    },
    /** Read-aloud recording still needs a profile (spoken evidence is saved). */
    readAloud(lesson: StoryLesson) {
      if (!profile) throw new Error('Create a learner profile to save practice.');
      return new ReadAloudPractice(lesson.passage, profile.id, lesson.id, createExpoAudioRecorder(), providers.sttProvider, repos.progress, providers.kind === 'unavailable');
    },
  };
}
export type LearningTools = Awaited<ReturnType<typeof createLearningTools>>;
