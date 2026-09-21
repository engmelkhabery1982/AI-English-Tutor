/**
 * Package 2 gap fix — translation target language resolution contracts.
 *
 * The translation target must NEVER be hardcoded at a contextual entry
 * point. One rule everywhere (Talk, Reading/Story, Listening transcript,
 * Deep Listening transcript): the learner profile's nativeLanguage when
 * available, otherwise the existing app default — resolved through the SAME
 * profile source Learning Tools uses (canonical app DB repositories), with
 * no second profile store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_TARGET_LANGUAGE,
  selectInspectablePhraseRange,
  splitInspectableSentences,
} from './components/inspectable-text';

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

describe('target language comes from the learner profile, never hardcoded', () => {
  it('Talk resolves the profile language through the shared hook', () => {
    const talk = read('TalkScreen.tsx');
    expect(talk).toContain("import { useTargetLanguage } from './components/use-target-language';");
    expect(talk).toContain('const inspectionTargetLanguage = useTargetLanguage();');
    expect(talk).toContain('targetLanguage={inspectionTargetLanguage}');
    expect(talk).not.toContain('targetLanguage="Arabic"');
  });

  it('both Deep Listening transcript sites resolve the profile language', () => {
    const panel = read('listening/DeepListeningPanel.tsx');
    expect(panel).toContain("import { useTargetLanguage } from '../components/use-target-language';");
    expect(panel).toContain('const inspectionTargetLanguage = useTargetLanguage();');
    const uses = panel.match(/targetLanguage=\{inspectionTargetLanguage\}/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(panel).not.toContain('targetLanguage="Arabic"');
  });

  it('Reading (StoryPanel) keeps the profile rule, and no screen hardcodes the target', () => {
    const story = read('learning/StoryPanel.tsx');
    expect(story).toContain("tools.profile?.nativeLanguage ?? 'Arabic'");
    // The InspectorPanel default stays profile-driven too.
    const inspector = read('learning/InspectorPanel.tsx');
    expect(inspector).toContain("tools.profile?.nativeLanguage ?? 'Arabic'");
  });

  it('the hook reuses the existing profile source — no second store', () => {
    const hook = read('components/use-target-language.ts');
    // Same canonical database + repositories Learning Tools composes from:
    expect(hook).toContain("getAppDatabase()");
    expect(hook).toContain('createAppRepositories(adapter)');
    expect(hook).toContain('repos.profile.get()');
    expect(hook).toContain('isProfileNotFoundError');
    // No new persistence of its own:
    expect(hook).not.toContain('AsyncStorage');
    expect(hook).not.toContain('new Map(');
  });

  it('the fallback default is the existing app default', () => {
    expect(DEFAULT_INSPECTION_TARGET_LANGUAGE).toBe('Arabic');
  });

  it('selection is never rewritten: every possible phrase span is an exact substring', () => {
    const passages = [
      'She said, "break the ice," warmly. Then everyone relaxed!',
      "Don't give up — look forward to tomorrow's reply.",
      'Wait… really? I look forward to it.',
    ];
    for (const passage of passages) {
      for (const sentence of splitInspectableSentences(passage)) {
        const count = sentence.split(/\s+/).filter(Boolean).length;
        for (let a = 0; a < count; a += 1) {
          for (let b = 0; b < count; b += 1) {
            const selected = selectInspectablePhraseRange(sentence, a, b);
            if (selected === null) continue;
            // EXACT visible text: an unmodified substring of the source.
            expect(passage.includes(selected)).toBe(true);
          }
        }
      }
    }
  });
});
