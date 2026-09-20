import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('WO3 reachable minimal UI contracts', () => {
  it('Home links to the root learning-tools route without replacing existing tabs', () => {
    expect(source('./HomeScreen.tsx')).toContain("navigation.navigate('LearningTools')");
    expect(source('../navigation/RootNavigator.tsx')).toContain("name: 'LearningTools', component: LearningToolsScreen");
  });
  it('inspector supports direct paste, translation, rephrase, classified retry and universal save', () => {
    const panel = source('./learning/InspectorPanel.tsx');
    for (const text of ['Original text', 'Selected language', 'Translation language', 'state.result.rephrase', 'state.canRetry', 'inspectionSaveInput', 'tools.save.save']) expect(panel).toContain(text);
    expect(panel).not.toContain('provider.generate(');
  });
  it('reading/listening/read-aloud are wired to shared domain services rather than screen grading', () => {
    const panel = source('./learning/StoryPanel.tsx');
    for (const text of ['tools.openLesson', 'tools.readAloud', 'session.answer', 'session.complete', 'session.saveLanguage', 'readAloud.compare', 'useFocusEffect', 'AppState', 'readAloud.dispose']) expect(panel).toContain(text);
    expect(panel).not.toContain('provider.generate(');
    expect(panel).not.toContain('markReviewed(');
  });
  it('Review exposes supported modes, context variation and real audio/voice submission guards', () => {
    const review = source('./ReviewScreen.tsx');
    for (const text of ['candidate.active.availableModes', 'service.changeMode', 'service.varyContext', 'listeningPlayedRef', 'voiceRef.current?.userAnswer', 'recordPracticeResult']) expect(review).toContain(text);
  });
  it('next-focus loads its reusable projection and every recommendation has an entry point', () => {
    const hub = source('./LearningToolsScreen.tsx');
    for (const text of ['value.nextFocus.load()', 'summary.recommendations', 'openRecommendation', 'setSection(\'reading\')', "screen: 'Talk'", "screen: 'Review'"]) expect(hub).toContain(text);
  });
});
