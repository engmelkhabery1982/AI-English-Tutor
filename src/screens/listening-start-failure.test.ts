/**
 * Package 2 (H) — Listening start-failure UX contracts.
 *
 * A start failure must be:
 *  1. visible IMMEDIATELY adjacent to the Start button (same measured area,
 *     rendered above the action so both stay in one viewport),
 *  2. announced to assistive tech (accessibilityRole="alert" +
 *     accessibilityLiveRegion="assertive"),
 *  3. scrolled into view automatically when it appears on the setup screen,
 *  4. non-destructive: difficulty, mode and any previous lesson state survive
 *     a recoverable failure so a retry starts unchanged,
 *  5. explanatory when a profile is required — the requirement is stated at
 *     the action, not somewhere else in the app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'ListeningScreen.tsx'), 'utf8');

/** The setup-screen Start area: the measured View holding alert + button. */
function startAreaBlock(): string {
  const start = source.indexOf('onLayout={(event) => { startAreaY.current');
  const end = source.indexOf('testID="start_listening_button"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Listening start failures stay visible and recoverable', () => {
  it('renders the failure immediately above the Start button inside one measured area', () => {
    const block = startAreaBlock();
    const alertAt = block.indexOf('accessibilityRole="alert"');
    const buttonAt = block.indexOf('styles.startButton');
    expect(alertAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(alertAt);
    // The error text uses the setup screen's error style right beside Start.
    expect(block).toContain('styles.errorText');
  });

  it('announces the failure as a live alert region', () => {
    const block = startAreaBlock();
    expect(block).toContain('accessibilityRole="alert"');
    expect(block).toContain('accessibilityLiveRegion="assertive"');
  });

  it('scrolls the Start area into view when a failure appears', () => {
    expect(source).toContain('ref={setupScrollRef}');
    expect(source).toContain('setupScrollRef.current?.scrollTo(');
    // Only while the setup screen owns the failure (not mid-session states).
    expect(source).toContain("if (!errorMessage || session || sessionDone || mode !== 'short') return;");
  });

  it('keeps difficulty, mode and previous session on a recoverable start failure', () => {
    // Failure paths only: the no-profile early return and the catch block.
    // They clear the (not-yet-started) session and set the message — they
    // never reset the learner's selections, so a retry starts unchanged.
    const noProfileBranch = source.slice(
      source.indexOf('if (!learner) {'),
      source.indexOf('const result = await service.startSession'),
    );
    const catchBlock = source.slice(
      source.indexOf('} catch {', source.indexOf('const startSession')),
      source.indexOf('} finally {', source.indexOf('const startSession')),
    );
    expect(noProfileBranch.length).toBeGreaterThan(0);
    expect(catchBlock.length).toBeGreaterThan(0);
    for (const branch of [noProfileBranch, catchBlock]) {
      expect(branch).not.toContain('setDifficulty(');
      expect(branch).not.toContain('setMode(');
      expect(branch).not.toContain('setSessionDone(');
      expect(branch).not.toContain('setSavedItems(');
    }
  });

  it('explains the profile requirement at the action itself', () => {
    const startSession = source.slice(
      source.indexOf('const startSession = useCallback'),
      source.indexOf('}, [difficulty, isStarting]);'),
    );
    expect(startSession).toContain('No learner profile yet');
    expect(startSession).toContain('set up your profile');
  });
});
