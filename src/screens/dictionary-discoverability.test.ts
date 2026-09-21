/**
 * src/screens/dictionary-discoverability.test.ts
 *
 * Source contracts for Package 2 (A/M): the dictionary/translation feature is
 * discoverable under an obvious learner-facing name, the Learning Tools tab
 * communicates its three areas, and the panel's progressive disclosure keeps
 * every existing capability (no functionality removed, provenance kept).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

const TOOLS = read('LearningToolsScreen.tsx');
const PANEL = read('learning/InspectorPanel.tsx');

describe('Learning Tools communicates Dictionary & Translate', () => {
  it('names the tab "Dictionary & Translate" (not the internal term "Inspector")', () => {
    expect(TOOLS).toContain("{ key: 'inspector', label: 'Dictionary & Translate' }");
    expect(TOOLS).toContain("{ key: 'listening', label: 'Listening' }");
    expect(TOOLS).toContain("{ key: 'reading', label: 'Reading' }");
    // The internal technical term is never the learner-facing label.
    expect(TOOLS).not.toContain("label: 'Inspector'");
  });

  it('explains what the feature does in a subtitle', () => {
    expect(TOOLS).toContain(
      'look up a word, phrase, expression, or sentence in context',
    );
  });

  it('keeps the provider-generated honesty message', () => {
    expect(TOOLS).toContain('not authoritative dictionary truth');
  });
});

describe('Dictionary & Translate panel — clear hierarchy, no lost capability', () => {
  it('uses the learner-facing title and honest provenance', () => {
    expect(PANEL).toContain('title="Dictionary & Translate"');
    expect(PANEL).toContain('provider-generated');
    expect(PANEL).toContain('Not authoritative dictionary truth');
  });

  it('primary action is a single obvious Look up / Translate', () => {
    expect(PANEL).toContain('Look up / Translate');
    expect(PANEL).toContain('accessibilityLabel="Look up and translate the selected text"');
  });

  it('keeps every existing field behind progressive disclosure', () => {
    // All original inputs survive (existing WO3 contract strings included)…
    for (const text of [
      'Original text',
      'Selected language',
      'Translation language',
      'Source context',
      'Item type',
      'state.result.rephrase',
      'state.canRetry',
      'inspectionSaveInput',
      'tools.save.save',
    ]) {
      expect(PANEL).toContain(text);
    }
    // …with the advanced ones inside the disclosure section.
    const moreOptionsAt = PANEL.indexOf('{moreOptionsOpen && (');
    expect(moreOptionsAt).toBeGreaterThan(-1);
    expect(PANEL.indexOf('accessibilityLabel="Original text"')).toBeGreaterThan(moreOptionsAt);
    expect(PANEL.indexOf('accessibilityLabel="Translation language"')).toBeGreaterThan(moreOptionsAt);
    expect(PANEL.indexOf('Item type')).toBeGreaterThan(moreOptionsAt);
  });

  it('supports every inspectable item type', () => {
    expect(PANEL).toContain(
      "const TYPES: readonly InspectionType[] = ['word','phrase','idiom','collocation','expression','sentence','short_text'];",
    );
  });

  it('a lookup with only the item typed never rewrites the selected text', () => {
    // The fallback sets originalText FROM selectedText — never the reverse.
    expect(PANEL).toContain('controller.edit({ ...input, originalText: input.selectedText });');
    expect(PANEL).not.toContain('selectedText: input.originalText });\n    void controller.inspect');
  });

  it('still saves a chosen meaning through the existing save service', () => {
    expect(PANEL).toContain('Save this meaning to Review');
    expect(PANEL).toContain('Already saved. The existing meaning and review schedule were kept.');
    expect(PANEL).toContain('Saved to Review — not marked learned.');
  });
});
