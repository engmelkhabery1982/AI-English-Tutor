/** Source/AST contracts, not device rendering tests. Real services/lifecycle have separate suites. */
import { describe, expect, it } from 'vitest';
// @ts-ignore node built-ins are available in the Vitest runtime
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { MAIN_TAB_ROUTES, ROOT_STACK_ROUTES } from '../navigation/routes';
import { PRACTICE_LINKS } from '../navigation/learner-journey';

const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');
const home = read('./HomeScreen.tsx');
const settings = read('./SettingsScreen.tsx');
const panel = read('./listening/DeepListeningPanel.tsx');
const listening = read('./ListeningScreen.tsx');
const navigator = read('../navigation/RootNavigator.tsx');
const files: string[] = readdirSync(new URL('.', import.meta.url)).filter((f: string) => f.endsWith('.tsx'));
const screens = [...files, 'listening/DeepListeningPanel.tsx'];
const tree = (file: string) => ts.createSourceFile(file, read(`./${file}`), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function elements(file: string, name: string) {
  const result: (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[] = [];
  const root = tree(file);
  const walk = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(root) === name) result.push(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return result;
}
function attribute(node: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string) {
  return node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === name);
}

describe('Learner navigation contracts', () => {
  it('renders the specialist registry and wires every item to its actual destination', () => {
    expect(home).toContain('PRACTICE_LINKS.map');
    expect(home).toContain('navigation.navigate(link.route)');
    for (const link of PRACTICE_LINKS) {
      expect([...MAIN_TAB_ROUTES, ...ROOT_STACK_ROUTES]).toContain(link.route);
      expect(link.description.length).toBeGreaterThan(20);
    }
    expect(new Set(PRACTICE_LINKS.map(l => l.route)).size).toBe(PRACTICE_LINKS.length);
  });

  it('has a Home-rooted route to every major learning capability', () => {
    // Tabs come from the real rendered route table; the two hidden tabs must be in Home's registry.
    for (const route of ['Home', 'Talk', 'Review', 'Progress', 'Settings']) expect(MAIN_TAB_ROUTES).toContain(route);
    expect(navigator).toContain('MAIN_TAB_ROUTES.map');
    for (const route of ['Listening', 'Vocabulary', 'Pronunciation', 'Shadowing', 'FluencyPractice']) {
      expect(PRACTICE_LINKS.map(l => l.route)).toContain(route);
    }
    expect(home).toContain("navigation.navigate('DailyTutor')");
    expect(settings).toContain("navigation.navigate('Reassessment')");
    expect(navigator).toContain("name: 'Reassessment'");
  });

  it('gives Daily Tutor one primary CTA, above Talk/Review and specialist practice', () => {
    expect(home.match(/style=\{styles.primaryButton\}/g)).toHaveLength(1);
    const primary = home.indexOf('onPress={openDailyTutor}');
    expect(primary).toBeGreaterThan(0);
    expect(home.indexOf('Practise and review')).toBeGreaterThan(primary);
    expect(home.indexOf('Choose a skill')).toBeGreaterThan(home.indexOf('Practise and review'));
  });

  it('reassessment is in Progress AND Settings with level acceptance explained', () => {
    for (const file of ['./ProgressScreen.tsx', './SettingsScreen.tsx']) {
      expect(read(file)).toContain("navigation.navigate('Reassessment')");
      expect(read(file)).toMatch(/accept/);
    }
    expect(read('./ReassessmentScreen.tsx')).toContain('isReassessment={true}');
  });

  it('pronunciation and shadowing use ONE existing processor and repeat screen', () => {
    const entries = read('./SpeechPracticeScreen.tsx');
    expect(entries).toContain('initialPractice="pronunciation"');
    expect(entries).toContain('initialPractice="shadowing"');
    expect(listening).toContain('shadowingOnly={Boolean(props?.initialPractice)}');
    expect(panel).toContain("taskTypes: ['shadowing']");
    expect(panel).toContain('service.submitShadowingAttempt');
    expect(listening).toContain('not acoustic or phoneme scoring');
    expect(navigator).toContain("name: 'Pronunciation', component: PronunciationScreen");
    expect(navigator).toContain("name: 'Shadowing', component: ShadowingScreen");
  });

  it('positions fluency as repeated tasks, not a fluency percentage or open Talk', () => {
    const fluency = PRACTICE_LINKS.find(l => l.route === 'FluencyPractice')!;
    expect(fluency.description).toContain('Repeat speaking tasks');
    expect(fluency.description).toContain('less support');
    expect(home).toContain('Talk · Open conversation');
    expect(navigator).toContain("name: 'FluencyPractice'");
  });

  it('specialist practice has a real return action and native back navigation', () => {
    expect(listening).toContain('props?.initialPractice ? navigation.goBack()');
    expect(panel).toContain('onPress={onExit}');
    expect(navigator).toContain("headerBackTitle: 'Back'");
    expect(navigator).not.toContain('headerLeft: () => null');
  });

  it('every literal navigation destination exists', () => {
    for (const file of screens) {
      for (const match of read(`./${file}`).matchAll(/navigation\.navigate\('([^']+)'/g)) {
        expect([...MAIN_TAB_ROUTES, ...ROOT_STACK_ROUTES], `${file}: ${match[1]}`).toContain(match[1]);
      }
    }
  });
});

describe('Honest product and provider states', () => {
  it('keeps provider configuration and explicit, labelled Demo separate', () => {
    expect(settings).toContain('getProviderCredentialService');
    expect(settings).toContain('Demo mode');
    expect(settings).toContain('never switched on for you');
    expect(settings).toContain('not real AI');
    expect(read('./ReviewScreen.tsx')).toContain('isDemoMode');
    expect(read('./TalkScreen.tsx')).toContain("providerKind === 'unavailable'");
    expect(read('./TalkScreen.tsx')).toContain('disabled={turnControls.micDisabled || isProviderUnavailable}');
  });

  it('Settings shows status text, masks the draft and never reads stored secrets for display', () => {
    expect(settings).toContain('STATUS_LABELS[snapshot.status]');
    expect(settings).toContain('accessibilityLiveRegion="polite"');
    expect(settings).toContain('secureTextEntry');
    expect(settings).not.toContain('resolveKeySync');
    expect(settings).not.toMatch(/value=\{snapshot/);
    expect(settings).toContain('service.saveKey(draftKey)');
    expect(settings).toContain('verifyConnection');
  });

  it('unavailable microphone and pending processing cannot look like a fresh recording', () => {
    const mic = elements('listening/DeepListeningPanel.tsx', 'TouchableOpacity').find(n => attribute(n, 'testID')?.getText().includes('shadowing_repeat_button'))!;
    expect(attribute(mic, 'disabled')?.getText()).toContain('!shadowing?.controller.voiceAvailable');
    expect(attribute(mic, 'disabled')?.getText()).toContain('voicePending');
    expect(attribute(mic, 'accessibilityLabel')?.getText()).toContain('Processing spoken answer');
    expect(panel).toContain('Microphone unavailable');
    expect(panel).toContain('finally {');
    expect(panel).toContain('setVoicePending(false)');
    expect(panel).toContain('controllerRef.current?.isBusy');
    expect(read('./OnboardingScreen.tsx')).toContain("disabled={busy || (!voiceStatus?.canRecord && voiceStatus?.state !== 'recording')}");
    expect(read('./ReviewScreen.tsx')).toContain('disabled={!userAnswer.trim() || isEvaluating || isRecording || isTranscribing}');
  });

  it('microphone denial offers device settings, not a fabricated transcript', () => {
    const help = read('./components/MicrophoneHelp.tsx');
    expect(help).toContain('Linking.openSettings()');
    expect(help).toContain('Nothing is recorded without permission');
    expect(help).toContain('.catch(');
    expect(help).not.toMatch(/transcribe|startRecording|recordObservation/);
  });

  it('Review empty state describes future reviews, without a fake count or mastery claim', () => {
    const review = read('./ReviewScreen.tsx');
    expect(review).not.toContain('summary.totalDue || 5');
    expect(review).toContain('Check for due reviews');
    expect(review).toContain('This is not an empty queue');
    expect(review).toContain('setLoadAttempt(n => n + 1)');
    expect(review).toContain('void loadDashboardMetrics(true)');
    expect(review).toContain('onPress={leaveDemoMode}');
    expect(review).toContain('The cards and counts below are samples');
    expect(review).toContain('These sample answers and feedback are not saved');
    expect(review).toContain('These are sample results, not your learner history');
    expect(review).toContain('setSummary({ totalDue: 0, dueVocabularyCount: 0, dueExpressionCount: 0, activeWeaknessCount: 0, categories: [] })');
    expect(review).toContain("sessionState === 'dashboard') void loadDashboardMetrics()");
    expect(review).toContain('An empty list is not a measurement');
    expect(review).toContain('Saved words, expressions and supported observations from real practice');
  });

  it('reassessment read failure cannot become an available assessment status', () => {
    const reassess = read('./ReassessmentScreen.tsx');
    expect(reassess).toContain('setEligibility(null)');
    expect(reassess).toContain('setLoadError(true)');
    expect(reassess).toContain('setRetry(n => n + 1)');
    expect(reassess).not.toContain('available: true');
    expect(reassess).not.toContain('default-learner');
    expect(reassess).toContain('loadPrefill()).profileId');
    expect(reassess).toContain('service.checkEligibility(profileId)');
  });

  it('strengths are persisted records, displayed qualitatively and read-only', () => {
    const progress = read('./ProgressScreen.tsx');
    expect(progress).toContain('service.loadStrengths(learnerId)');
    expect(progress).toContain('Demonstrated strengths');
    expect(progress).toContain('No strengths recorded yet');
    expect(progress).not.toContain('strength.confidence');
    expect(progress).not.toMatch(/upsertStrength|recordSuccess/);
  });

  it('saved-item audio is structurally isolated from learner evidence', () => {
    const audio = read('./components/SavedItemAudio.tsx');
    expect(read('./VocabularyScreen.tsx')).toContain('<SavedItemAudio');
    expect(audio).toContain('TTSController');
    expect(audio).toContain('controller.current.speak(text');
    expect(audio).toContain('useVoiceAppStateGuard');
    expect(audio).toContain('owned.dispose()');
    expect(audio).toContain('does not count as practice');
    // Restrict imports, not just method spellings: this component has no route to repository writes.
    const imports = [...audio.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports).toEqual(['react', 'react-native', '@react-navigation/native', '../../providers/tts', '../../voice/tts-controller', '../../voice/use-app-state-guard', './LearnerButton']);
    expect(audio).not.toMatch(/recordObservation|submitAttempt|submitShadowing|upsert|reviewCount/);
  });

  it('saved vocabulary still renders all stored meanings and examples', () => {
    const vocab = read('./VocabularyScreen.tsx');
    expect(vocab).toContain('(selectedEntry.item.meanings ?? []).map');
    expect(vocab).toContain('meaning.examples');
    expect(vocab).toContain('Words');
    expect(vocab).toContain('Phrases');
    expect(vocab).toContain('Common Expressions');
    expect(vocab).toContain("navigation.navigate('Review')");
  });

  it('loading errors retain real retry paths, including failed service composition', () => {
    for (const file of ['VocabularyScreen', 'ProgressScreen']) {
      const source = read(`./${file}.tsx`);
      expect(source).toMatch(/if \(!serviceRef.current\) serviceRef.current = await createDefault/);
      expect(source).toContain('onPress={handleRetry}');
    }
    expect(listening).toContain('setLoadAttempt(n => n + 1)');
    expect(read('./FluencyPracticeScreen.tsx')).toContain('onPress={() => void handlePracticeAgain()}');
    expect(read('./DeepSpeakingScreen.tsx')).toContain('serviceRef.current = await (props?.loadService ?? createDefaultSpeakingService)()');
  });
});

describe('Accessibility, mobile layout and dead-action contracts', () => {
  it('all learner buttons have a real onPress, and no TODO/coming-soon UI remains', () => {
    for (const file of screens) {
      for (const button of elements(file, 'TouchableOpacity')) {
        expect(attribute(button, 'onPress'), file).toBeDefined();
        expect(attribute(button, 'onPress')?.getText(), file).not.toMatch(/=>\s*\{\s*\}/);
      }
      expect(read(`./${file}`), file).not.toMatch(/coming soon|onPress=\{\(\) => \{\}\}/i);
    }
    expect(settings).not.toMatch(/TODO|placeholder action|resetDatabase|dropDatabase/);
  });

  it('all text inputs have an explicit accessible name', () => {
    for (const file of screens) {
      for (const input of elements(file, 'TextInput')) expect(attribute(input, 'accessibilityLabel'), file).toBeDefined();
    }
  });

  it('all screens use the native accessibility/touch-target button wrapper', () => {
    for (const file of screens) {
      if (elements(file, 'TouchableOpacity').length) expect(read(`./${file}`), file).toContain('components/LearnerButton');
    }
    const button = read('./components/LearnerButton.tsx');
    expect(button).toContain("accessibilityRole={props.accessibilityRole ?? 'button'}");
    expect(button).toContain('disabled: Boolean(disabled)');
    expect(button).toContain('minHeight: 48');
    expect(button).toContain('minWidth: 48');
  });

  it('critical recording and playback controls expose accessible labels', () => {
    for (const name of ['TalkScreen.tsx', 'OnboardingScreen.tsx', 'listening/DeepListeningPanel.tsx']) {
      const buttons = elements(name, 'TouchableOpacity');
      const critical = buttons.filter(n => /handleToggleRecording|handleShadowingToggle|pressMic\(|handlePlay\(|handleStopSpeaking/.test(attribute(n, 'onPress')?.getText() ?? ''));
      expect(critical.length).toBeGreaterThan(0);
      critical.forEach(n => expect(attribute(n, 'accessibilityLabel'), name).toBeDefined());
    }
  });

  it('safe-area insets cover stack screens and the independent vocabulary modal', () => {
    expect(navigator).toContain('SafeAreaView');
    expect(navigator).toContain("['left', 'right', 'bottom']");
    expect(read('./VocabularyScreen.tsx')).toContain('<SafeAreaView style={styles.modalContainer}>');
    expect(navigator).toContain("route.name === 'Listening' || route.name === 'Vocabulary' ? { display: 'none' }");
  });

  it('critical layouts have no large fixed-width blocker and wrap crowded header rows', () => {
    for (const file of screens) expect(read(`./${file}`), file).not.toMatch(/\bwidth:\s*(?:[3-9]\d{2}|\d{4,})\b/);
    expect(home).toContain("flexWrap: 'wrap'");
    expect(settings).toContain("flexWrap: 'wrap'");
    expect(settings).toContain('keyboardShouldPersistTaps="handled"');
    expect(read('./TalkScreen.tsx')).toContain('KeyboardAvoidingView');
  });
});
