/**
 * src/screens/learning-tools-contracts.test.ts
 *
 * Source contracts for Package 2 screen-level fixes (G/H/I): the built-in
 * starter lesson is never an active-looking no-op, Listening start failures
 * stay visible, and Review continuation stays reachable. Behavior of the
 * preview session itself is covered by src/lessons/preview-mode.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

const TOOLS = read('LearningToolsScreen.tsx');
const STORY = read('learning/StoryPanel.tsx');
const COMPOSITION = read('../lessons/composition.ts');

describe('built-in starter lesson works without AI/profile', () => {
  it('the starter button is not gated on a profile (no active-looking no-op)', () => {
    // The old defect: disabled={!tools.profile || busy} silently did nothing.
    expect(TOOLS).not.toContain('disabled={!tools.profile || busy}');
    const starterAt = TOOLS.indexOf('Load built-in starter lesson');
    const slice = TOOLS.slice(Math.max(0, starterAt - 400), starterAt);
    expect(slice).toContain('disabled={busy}');
  });

  it('the lesson panel renders without a profile, in honest preview mode', () => {
    expect(TOOLS).not.toContain('{lesson && tools.profile && (');
    expect(TOOLS).toContain('preview={!tools.profile}');
    expect(STORY).toContain('Preview mode — this built-in lesson works without AI.');
    expect(STORY).toContain('create a learner profile to save progress and answers');
  });

  it('preview persists nothing: openLesson without a profile uses the no-op sink', () => {
    expect(COMPOSITION).toContain('createPreviewProgressSink()');
    expect(COMPOSITION).toContain("return { ...record, id: 'preview-not-saved' };");
    expect(COMPOSITION).not.toContain("if (!profile) throw new Error('Create a learner profile to save practice.');\n      return new StoryLessonSession");
  });

  it('reading and listening previews are consistent; read-aloud explains its profile need', () => {
    // Both modes share the same StoryPanel/session; only read-aloud (spoken
    // evidence) requires a profile — and says so instead of failing silently.
    expect(STORY).toContain('tools.profile ? tools.readAloud(lesson) : null');
    expect(STORY).toContain('Read-aloud practice records spoken evidence, so it needs a learner profile.');
  });

  it('generated lessons still require a provider and a profile', () => {
    const generateButtonAt = TOOLS.indexOf('Generate a new lesson');
    const slice = TOOLS.slice(Math.max(0, generateButtonAt - 300), generateButtonAt);
    expect(slice).toContain('disabled={busy || !tools.profile}');
    expect(TOOLS).toContain('generateStoryLesson(tools.provider');
  });
});
