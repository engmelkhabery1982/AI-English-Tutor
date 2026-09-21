/**
 * Package 2 (I) — Review continuation-control contracts.
 *
 * After feedback the learner must be able to continue immediately:
 *  1. "Card N of M" / the progress area clears the top safe area
 *     (status bar / notch) — the practice view has no navigation header,
 *  2. Next Card / Finish Session live in a STICKY bottom bar OUTSIDE the
 *     practice ScrollView, so arbitrarily long feedback can never bury
 *     them below the fold,
 *  3. the sticky control only appears once an evaluation exists and keeps
 *     the existing handleNextItem semantics (grading, scheduler, evidence
 *     and Demo Mode behavior untouched).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'ReviewScreen.tsx'), 'utf8');

describe('Review continuation controls stay reachable', () => {
  it('gives the practice progress header top safe-area spacing', () => {
    expect(source).toContain('useSafeAreaInsets');
    expect(source).toContain('<View style={[styles.practiceHeader, { paddingTop: insets.top }]}>');
  });

  it('renders Next Card / Finish Session in a sticky bar outside the ScrollView', () => {
    const scrollViewEnd = source.indexOf('</ScrollView>');
    const stickyAt = source.indexOf('styles.continuationBar');
    expect(scrollViewEnd).toBeGreaterThan(-1);
    expect(stickyAt).toBeGreaterThan(scrollViewEnd);
    // The bar is gated by the evaluation — no phantom controls before feedback.
    expect(source).toContain('{evaluation ? (\n        <View style={styles.continuationBar}>');
    // Exactly one continuation control; no duplicated in-flow button.
    const occurrences = source.match(/id="next_card_button"/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).toContain('onPress={handleNextItem}');
    expect(source).toContain("currentIndex + 1 < sessionCandidates.length ? 'Next Card →' : 'Finish Session'");
  });

  it('keeps the continuation control announced and labeled', () => {
    const sticky = source.slice(
      source.indexOf('styles.continuationBar'),
      source.indexOf('</View>', source.indexOf('styles.continuationBar')),
    );
    expect(sticky).toContain('accessibilityRole="button"');
    expect(sticky).toContain('accessibilityLabel');
  });

  it('leaves feedback, grading and Demo Mode semantics untouched', () => {
    // The feedback content itself still renders inside the scrollable card…
    expect(source).toContain('<Text style={styles.evalFeedbackText}>{evaluation.feedback}</Text>');
    // …Demo Mode notice unchanged, and the existing shared-service wiring
    // (change modes / vary context / record results) is intact.
    expect(source).toContain('Demo Mode · Not real AI');
    for (const text of ['service.changeMode', 'service.varyContext', 'recordPracticeResult']) {
      expect(source).toContain(text);
    }
  });
});
