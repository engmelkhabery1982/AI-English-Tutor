/**
 * src/screens/components/inspectable-text.test.ts
 *
 * Behavior tests for the pure contextual-inspection helpers (Package 2, C/E):
 * tokenization, sentence context, reliable item-type inference, and a prefill
 * that preserves the learner's selected text EXACTLY.
 */

import { describe, expect, it } from 'vitest';
import {
  buildInspectionPrefill,
  inferInspectableItemType,
  splitInspectableSentences,
  tokenizeInspectableSentence,
} from './inspectable-text';

describe('inspectable text helpers', () => {
  it('splits a passage into sentences', () => {
    expect(
      splitInspectableSentences('We met at dawn. She broke the ice! Did you notice?'),
    ).toEqual(['We met at dawn.', 'She broke the ice!', 'Did you notice?']);
  });

  it('tokens keep display text, strip only surrounding punctuation for lookup', () => {
    const tokens = tokenizeInspectableSentence('She said, "break the ice," warmly.');
    const quoted = tokens.find((token) => token.display === '"break');
    expect(quoted?.lookup).toBe('break');
    const comma = tokens.find((token) => token.display === 'ice,"');
    expect(comma?.lookup).toBe('ice');
    // Inner apostrophes survive untouched.
    const inner = tokenizeInspectableSentence("Don't stop").find((t) => t.display === "Don't");
    expect(inner?.lookup).toBe("Don't");
  });

  it('punctuation-only tokens are not inspectable', () => {
    const tokens = tokenizeInspectableSentence('Wait — really?');
    const dash = tokens.find((token) => token.display === '—');
    expect(dash?.lookup).toBe('');
  });

  it('infers only word vs phrase — never invents idiom/expression types', () => {
    expect(inferInspectableItemType('ice')).toBe('word');
    expect(inferInspectableItemType('break the ice')).toBe('phrase');
  });

  it('the prefill preserves the selected text exactly and carries real context', () => {
    const prefill = buildInspectionPrefill({
      selectedText: 'broke the ice',
      sentence: 'She broke the ice with a joke.',
      fullText: 'The room was quiet. She broke the ice with a joke.',
      targetLanguage: 'Arabic',
      sourceRef: 'lesson-1',
    });
    expect(prefill.selectedText).toBe('broke the ice');
    expect(prefill.originalText).toContain(prefill.selectedText);
    expect(prefill.context).toBe('She broke the ice with a joke.');
    expect(prefill.itemType).toBe('phrase');
    expect(prefill.targetLanguage).toBe('Arabic');
    expect(prefill.sourceRef).toBe('lesson-1');
  });

  it('a single tapped word prefills as a word lookup', () => {
    const prefill = buildInspectionPrefill({
      selectedText: 'quiet',
      sentence: 'The room was quiet.',
      fullText: 'The room was quiet.',
      targetLanguage: 'Arabic',
    });
    expect(prefill.itemType).toBe('word');
    expect(prefill.sourceRef).toBeUndefined();
  });

  it('the prefill is plain serializable data (safe as a route param)', () => {
    const prefill = buildInspectionPrefill({
      selectedText: 'ice',
      sentence: 'She broke the ice.',
      fullText: 'She broke the ice.',
      targetLanguage: 'Arabic',
    });
    const roundTrip = JSON.parse(JSON.stringify(prefill));
    expect(roundTrip).toEqual({ ...prefill });
  });
});
