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

export async function createLearningTools(databaseAdapter?: DatabaseAdapter) {
  const adapter = databaseAdapter ?? (await getAppDatabase()).adapter;
  const repos = createAppRepositories(adapter);
  const profile = await repos.profile.get().catch(error => { if (isProfileNotFoundError(error)) return null; throw error; });
  const providers = resolveReviewProviders({ isDemo: false });
  const save = createSaveToReviewService({ databaseAdapter: adapter });
  return {
    profile, get provider() { return resolveReviewProviders({ isDemo: false }).aiProvider; }, save,
    nextFocus: new NextFocusService(repos, createAdaptiveLessonService(adapter)),
    openLesson(lesson: StoryLesson, mode: LessonMode, changed: () => void) {
      if (!profile) throw new Error('Create a learner profile to save practice.');
      return new StoryLessonSession(lesson, mode, profile.id, repos.progress, save, createExpoTTSProvider(), changed);
    },
    readAloud(lesson: StoryLesson) {
      if (!profile) throw new Error('Create a learner profile to save practice.');
      return new ReadAloudPractice(lesson.passage, profile.id, lesson.id, createExpoAudioRecorder(), providers.sttProvider, repos.progress, providers.kind === 'unavailable');
    },
  };
}
export type LearningTools = Awaited<ReturnType<typeof createLearningTools>>;
