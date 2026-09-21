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
