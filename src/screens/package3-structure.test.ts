/**
 * Package 3 — structural UI/UX contracts.
 *
 * Source contracts for the reorganized information hierarchy (Home, Talk,
 * navigation, Review, Settings, Onboarding, Listening, Learning Tools).
 * Rendering/lifecycle behavior is covered by the existing suites; these
 * tests pin the STRUCTURE a learner sees.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

const home = read('HomeScreen.tsx');

describe('Home — one dominant primary CTA and core actions first', () => {
  it('shows exactly one primary CTA that answers "what should I do now?"', () => {
    // Exactly one dominant primary button in the source.
    expect(home.match(/style=\{styles.primaryButton\}/g)).toHaveLength(1);
    // Profile not ready → assess/setup is the primary; profile ready → the
    // real next activity (Daily Tutor). Both use the same CTA slot/testID.
    expect(home).toContain('testID="home-primary-cta"');
    expect(home).toContain('Assess my English');
    expect(home).toContain('onPress={openDailyTutor}');
    // The two setup surfaces never compete: the Daily Tutor card is in the
    // ELSE branch of the profile-not-ready condition.
    const setupAt = home.indexOf('prefill && !prefill.isComplete');
    const dailyAt = home.indexOf(') : dailyLoading && !dailyCard ? (');
    const dailyCardAt = home.indexOf(') : dailyCard ? (');
    expect(setupAt).toBeGreaterThan(-1);
    expect(dailyAt).toBeGreaterThan(setupAt);
    expect(dailyCardAt).toBeGreaterThan(dailyAt);
  });

  it('keeps the core practice actions (Talk / Listening / Review) immediately visible', () => {
    const practiceAt = home.indexOf('Practise and review');
    const talkAt = home.indexOf('home-talk-card');
    const listeningAt = home.indexOf('home-listening-card');
    const reviewAt = home.indexOf('home-review-card');
    expect(practiceAt).toBeGreaterThan(-1);
    expect(talkAt).toBeGreaterThan(practiceAt);
    expect(listeningAt).toBeGreaterThan(talkAt);
    expect(reviewAt).toBeGreaterThan(listeningAt);
    // Learning tools sit AFTER the core three (secondary entry).
    expect(home.indexOf('home-learning-tools-card')).toBeGreaterThan(reviewAt);
  });

  it('shows the adaptive lesson exactly once, as the single next-focus recommendation', () => {
    // One "Next focus" section; no second adaptive section below the skills.
    expect(home.match(/title="Next focus"/g)).toHaveLength(1);
    // No SECOND adaptive section header (the lesson itself lives in the
    // single Next-focus slot; the old duplicate bottom section is gone).
    expect(home).not.toContain('<SectionHeader title="Adaptive lesson"');
    // Adaptive recommendation appears before the secondary sections.
    const nextFocusAt = home.indexOf('title="Next focus"');
    expect(home.indexOf('title="Learning tools"')).toBeGreaterThan(nextFocusAt);
    expect(home.indexOf('title="More skills"')).toBeGreaterThan(nextFocusAt);
    // Vocabulary lives with Learning tools; the rest of the registry stays in
    // More skills — every registry entry still renders exactly once.
    expect(home).toContain("PRACTICE_LINKS.filter((link) => link.route === 'Vocabulary')");
    expect(home).toContain('PRACTICE_LINKS.map');
    expect(home).toContain('navigation.navigate(link.route)');
    expect(home.match(/testID=\{`home-skill-\$\{link.route\}`\}/g)).toHaveLength(2);
  });
});

const talk = read('TalkScreen.tsx');

describe('Talk — voice-first hierarchy with progressive disclosure', () => {
  it('keeps Conversation options collapsed by default', () => {
    expect(talk).toContain('const [optionsOpen, setOptionsOpen] = useState<boolean>(false);');
    // The options panel (mode selector + topic draft) renders only when open.
    expect(talk).toContain('{optionsOpen ? (');
    const panelAt = talk.indexOf('{optionsOpen ? (');
    const selectorAt = talk.indexOf('<View style={styles.modeSelector}>');
    const topicAt = talk.indexOf('accessibilityLabel="Conversation topic"');
    expect(selectorAt).toBeGreaterThan(panelAt);
    expect(topicAt).toBeGreaterThan(panelAt);
    expect(talk).toContain('accessibilityLabel="Conversation options"');
    expect(talk).toContain('testID="talk-options-disclosure"');
  });

  it('replaces the permanent help button row with ONE collapsed "Need help?" control', () => {
    expect(talk).toContain('const [helpOpen, setHelpOpen] = useState<boolean>(false);');
    expect(talk).toContain('{helpOpen ? (');
    const panelAt = talk.indexOf('{helpOpen ? (');
    // All help actions live inside the disclosure — the descriptor row and the
    // temporary correction relief are rendered only when it is open.
    const helpRowAt = talk.indexOf('HELP_ACTION_DESCRIPTORS.map');
    const fewerAt = talk.indexOf('fewerCorrectionsChip');
    expect(helpRowAt).toBeGreaterThan(panelAt);
    expect(fewerAt).toBeGreaterThan(panelAt);
    expect(talk).toContain('accessibilityLabel="Need help?"');
    expect(talk).toContain('testID="talk-help-disclosure"');
    // "Change topic" still reaches the topic draft in one step.
    expect(talk).toContain('setTopicChangeOpen(true);\n        setOptionsOpen(true);');
    expect(talk).toContain('setOptionsOpen(true);');
  });

  it('shows a prominent blocked-state card when real AI is unavailable', () => {
    expect(talk).toContain('styles.blockedCard');
    expect(talk).toContain('Talk needs a real AI provider');
    expect(talk).toContain('Configure provider');
    expect(talk).toContain('TALK_CONFIGURATION_REQUIRED_MESSAGE');
    expect(talk).toContain('accessibilityRole="alert"');
    // Provider-backed controls are visually de-emphasized, and the mic/send
    // stay disabled (Package 1 contract preserved).
    expect(talk).toContain('isProviderUnavailable && styles.controlsUnavailable');
    expect(talk).toContain('disabled={turnControls.micDisabled || isProviderUnavailable}');
  });

  it('keeps the mic/composer as the strongest action area', () => {
    // The composer is a direct child of the screen (outside the chat scroll),
    // rendered after the conversation — unchanged Package 1 structure.
    const chatAt = talk.indexOf('{/* Chat Area */}');
    const composerAt = talk.indexOf('{/* Message Composer */}');
    expect(chatAt).toBeGreaterThan(-1);
    expect(composerAt).toBeGreaterThan(chatAt);
    expect(talk).toContain('KeyboardAvoidingView');
    expect(talk).toContain('styles.micButton');
  });

  it('announces the disclosure state to assistive tech', () => {
    expect(talk.match(/accessibilityState=\{\{ expanded: (optionsOpen|helpOpen) \}\}/g)).toHaveLength(2);
  });
});

describe('Review — deduplicated empty/summary states', () => {
  const review = read('ReviewScreen.tsx');

  it('shows ONE empty state with ONE CTA when there is no profile', () => {
    expect(review).toContain('Nothing to review yet');
    expect(review).toContain('hasNoProfile && !isDemoMode ? (');
    expect(review).toContain('Set up my learning profile');
    // The zero counters are NOT repeated for a missing profile: the due
    // card, breakdown grid and priority list live in the else branch.
    const emptyAt = review.indexOf('Nothing to review yet');
    const dueAt = review.indexOf('Items due for review');
    expect(dueAt).toBeGreaterThan(emptyAt);
    expect(review).toContain('{summary.totalDue > 0 || activeWeaknesses.length > 0 ? (');
  });

  it('collapses an all-zero dashboard into one honest card', () => {
    expect(review).toContain('Nothing is due right now.');
    expect(review).toContain('An empty list');
    expect(review).toContain('is not a measurement of your English level.');
  });

  it('keeps Package 2 sticky continuation and all review semantics', () => {
    expect(review).toContain('styles.continuationBar');
    expect(review).toContain('id="next_card_button"');
    expect(review).toContain('{ paddingTop: insets.top }');
    expect(review).toContain('isDemoMode');
    expect(review).toContain('recordPracticeResult');
    expect(review).toContain('service.changeMode');
  });
});

describe('Settings — grouped sections with progressive disclosure', () => {
  const settings = read('SettingsScreen.tsx');

  it('groups the long screen into clear sections', () => {
    const providerAt = settings.indexOf('<SectionHeader title="AI provider" />');
    const learningAt = settings.indexOf('<SectionHeader title="Learning" />');
    const infoAt = settings.indexOf('<SectionHeader title="App info" />');
    expect(providerAt).toBeGreaterThan(-1);
    expect(learningAt).toBeGreaterThan(providerAt);
    expect(infoAt).toBeGreaterThan(learningAt);
  });

  it('collapses secondary explanation while critical provider controls stay visible', () => {
    // Long storage/privacy copy sits behind explicit disclosures…
    expect(settings).toContain('const [keyDetailsOpen, setKeyDetailsOpen] = useState<boolean>(false);');
    expect(settings).toContain('const [aboutDetailsOpen, setAboutDetailsOpen] = useState<boolean>(false);');
    expect(settings).toContain('How your key is stored');
    expect(settings).toContain('Privacy details');
    expect(settings.match(/accessibilityState=\{\{ expanded: (keyDetailsOpen|aboutDetailsOpen) \}\}/g)).toHaveLength(2);
    // …and every critical control/pinned copy is preserved.
    for (const required of [
      'secureTextEntry',
      'service.saveKey(draftKey)',
      'verifyConnection',
      'settings-save',
      'settings-remove',
      'settings-verify',
      'stays on this device',
      'secure storage',
      'never shown again',
      'STATUS_LABELS[snapshot.status]',
      'never switched on for you',
      'Test connection',
      "navigation.navigate('Onboarding')",
      'Assess my English',
    ]) {
      expect(settings, required).toContain(required);
    }
  });
});

describe('Onboarding — reduced setup density, unchanged assessment logic', () => {
  const onboarding = read('OnboardingScreen.tsx');

  it('breaks the profile form into numbered step cards', () => {
    expect(onboarding).toContain('1 · About you');
    expect(onboarding).toContain('2 · Your goals');
    expect(onboarding).toContain('3 · Practice preferences');
    const aboutAt = onboarding.indexOf('1 · About you');
    const goalsAt = onboarding.indexOf('2 · Your goals');
    const practiceAt = onboarding.indexOf('3 · Practice preferences');
    expect(goalsAt).toBeGreaterThan(aboutAt);
    expect(practiceAt).toBeGreaterThan(goalsAt);
  });

  it('keeps the primary action visible without scrolling the form', () => {
    // The start button lives in a persistent footer outside the ScrollView,
    // rendered for the whole profile phase.
    expect(onboarding).toContain('styles.profileFooter');
    expect(onboarding).toContain("phase === 'profile' ? (");
    expect(onboarding).toContain('testID="onboarding-start-assessment"');
    expect(onboarding).toContain('Start the assessment');
    const scrollEnd = onboarding.lastIndexOf('</ScrollView>');
    expect(onboarding.indexOf('styles.profileFooter')).toBeGreaterThan(scrollEnd);
  });

  it('preserves every assessment input and safeguard', () => {
    // All choice groups are still rendered with the same state bindings.
    for (const required of [
      'NATIVE_LANGUAGE_OPTIONS.map',
      'TARGET_LEVELS.map',
      'LEARNING_GOAL_OPTIONS.map',
      'PRACTICE_MODES.map',
      'onPress={() => void startDiagnostic()}',
      'createAssessmentAnswerController',
    ]) {
      expect(onboarding, required).toContain(required);
    }
    // Diagnostic safeguards untouched (step token / committed-history pins).
    expect(onboarding).toContain('stepToken: handle.session.getCurrentStepToken()');
    expect(onboarding).toContain('countCommittedLearnerTurns(handle.conversation)');
  });
});

describe('Listening — clear setup sequence, no dead space', () => {
  const listening = read('ListeningScreen.tsx');

  it('removes the vertically-centered blank-space layout', () => {
    // The setup screen is top-aligned now; the centered flexGrow container
    // (which produced large unused areas) is no longer wired to it.
    expect(listening).toContain('ref={setupScrollRef}');
    expect(listening).toContain('contentContainerStyle={styles.setupContent}');
    expect(listening).toContain('setupContent: { padding: 16, paddingBottom: 40 },');
    const setupScrollAt = listening.indexOf('ref={setupScrollRef}');
    expect(listening.indexOf('styles.centerContent', setupScrollAt)).toBe(-1);
  });

  it('makes the setup sequence explicit: mode → level → Start', () => {
    const modeLabelAt = listening.indexOf('>Mode</Text>');
    const levelLabelAt = listening.indexOf('>Level</Text>');
    const startAt = listening.indexOf('testID="start_listening_button"');
    expect(modeLabelAt).toBeGreaterThan(-1);
    expect(levelLabelAt).toBeGreaterThan(modeLabelAt);
    expect(startAt).toBeGreaterThan(levelLabelAt);
    // The explanatory paragraph is secondary info under the Start action.
    expect(listening.indexOf('Short listening exercises. Play the audio')).toBeGreaterThan(startAt);
  });

  it('preserves the Package 2 failure/start behavior', () => {
    expect(listening).toContain('onLayout={(event) => { startAreaY.current');
    expect(listening).toContain('accessibilityRole="alert"');
    expect(listening).toContain('setupScrollRef.current?.scrollTo(');
    expect(listening).toContain('No learner profile yet');
    // CEFR/difficulty semantics untouched.
    expect(listening).toContain("setDifficulty(level)");
  });
});

describe('Bottom navigation — full discoverable labels', () => {
  const navigator = read('../navigation/RootNavigator.tsx');

  it('shows full readable tab labels with meaningful icons (no single letters)', () => {
    expect(navigator).toContain('tabBarShowLabel: true');
    expect(navigator).toContain('const TAB_ICONS');
    for (const label of ['Home', 'Talk', 'Review', 'Progress', 'Settings']) {
      expect(navigator).toContain(`${label}: '`);
    }
    // The single-letter icon presentation is gone.
    expect(navigator).not.toContain('route.name.charAt(0)');
  });

  it('keeps clear selected/unselected states and the hidden utility tabs', () => {
    expect(navigator).toContain("tabBarActiveTintColor: '#2563EB'");
    expect(navigator).toContain("tabBarInactiveTintColor: '#9CA3AF'");
    expect(navigator).toContain('focused ? 1 : 0.65');
    // Existing behavior preserved: Listening/Vocabulary stay off the bar.
    expect(navigator).toContain("route.name === 'Listening' || route.name === 'Vocabulary' ? { display: 'none' }");
    expect(navigator).toContain('MAIN_TAB_ROUTES.map');
  });
});
