/**
 * src/screens/components/inspectable-text.test.ts
 *
 * Behavior tests for the pure contextual-inspection helpers (Package 2, C/E):
 * tokenization, sentence context, reliable item-type inference, and a prefill
 * that preserves the learner's selected text EXACTLY.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_TARGET_LANGUAGE,
  buildInspectionPrefill,
  inferInspectableItemType,
  resolveTargetLanguage,
  selectInspectablePhraseRange,
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

describe('multi-word phrase selection (tap start word, tap end word)', () => {
  it('selects a two-word phrase exactly as displayed', () => {
    // Tokens: She=0 broke=1 the=2 ice=3 with=4 a=5 joke.=6
    expect(selectInspectablePhraseRange('She broke the ice with a joke.', 1, 2)).toBe(
      'broke the',
    );
    expect(selectInspectablePhraseRange('She broke the ice with a joke.', 3, 4)).toBe(
      'ice with',
    );
  });

  it('selects a three-or-more-word expression', () => {
    // "look" (0) → "to" (2) in: I look forward to your reply.
    expect(selectInspectablePhraseRange('I look forward to your reply.', 1, 3)).toBe(
      'look forward to',
    );
    // Longer span: "look forward to your reply" (1..4)
    expect(selectInspectablePhraseRange('I look forward to your reply.', 1, 4)).toBe(
      'look forward to your',
    );
  });

  it('preserves the visible word order regardless of tap order', () => {
    const sentence = 'She broke the ice with a joke.';
    // Anchoring on "broke" (1) and ending on "ice" (3)…
    expect(selectInspectablePhraseRange(sentence, 1, 3)).toBe('broke the ice');
    // …or tapping them in the opposite order yields the SAME visible text.
    expect(selectInspectablePhraseRange(sentence, 3, 1)).toBe('broke the ice');
    expect(selectInspectablePhraseRange(sentence, 2, 1)).toBe(
      selectInspectablePhraseRange(sentence, 1, 2),
    );
  });

  it('boundary punctuation never corrupts the selected phrase', () => {
    // Phrase ending on a comma/quote boundary: "break the ice," → ice
    expect(selectInspectablePhraseRange('She said, "break the ice," warmly.', 2, 4)).toBe(
      'break the ice',
    );
    // Phrase ending on the terminal period:
    expect(selectInspectablePhraseRange('We met at dawn.', 2, 3)).toBe('at dawn');
    // The result is ALWAYS an exact substring of the sentence:
    const sentence = 'She said, "break the ice," warmly.';
    const phrase = selectInspectablePhraseRange(sentence, 2, 4);
    expect(phrase).not.toBeNull();
    expect(sentence.includes(phrase as string)).toBe(true);
  });

  it('rejects invalid indices and punctuation-only spans', () => {
    const sentence = 'Wait — really?';
    expect(selectInspectablePhraseRange(sentence, 5, 6)).toBeNull();
    expect(selectInspectablePhraseRange(sentence, -1, 1)).toBeNull();
    expect(selectInspectablePhraseRange(sentence, 0, 99)).toBeNull();
    // Span of ONLY punctuation tokens yields nothing inspectable:
    expect(selectInspectablePhraseRange('Hmm — … ok', 1, 2)).toBeNull();
  });

  it('keeps single-word behavior unchanged (same-index span == token lookup)', () => {
    const sentence = 'She said, "break the ice," warmly.';
    const tokens = tokenizeInspectableSentence(sentence);
    tokens.forEach((token, index) => {
      if (token.lookup.length > 0) {
        expect(selectInspectablePhraseRange(sentence, index, index)).toBe(token.lookup);
      }
    });
  });

  it('prefills a phrase with the containing sentence as context and phrase type', () => {
    const fullText = 'The room was quiet. She broke the ice with a joke. Everyone laughed.';
    const sentence = splitInspectableSentences(fullText)[1];
    const selectedText = selectInspectablePhraseRange(sentence, 1, 3);
    expect(selectedText).toBe('broke the ice');
    const prefill = buildInspectionPrefill({
      selectedText: selectedText as string,
      sentence,
      fullText,
      targetLanguage: 'Spanish',
    });
    expect(prefill.selectedText).toBe('broke the ice');
    expect(prefill.context).toBe('She broke the ice with a joke.');
    expect(prefill.originalText).toBe(fullText);
    expect(prefill.itemType).toBe('phrase');
    expect(prefill.targetLanguage).toBe('Spanish');
  });

  it('keeps whole-sentence behavior unchanged (explicit sentence prefill)', () => {
    const fullText = 'The room was quiet. She broke the ice with a joke.';
    const sentence = splitInspectableSentences(fullText)[1];
    const prefill = buildInspectionPrefill({
      selectedText: sentence,
      sentence,
      fullText,
      targetLanguage: 'Arabic',
      itemType: 'sentence',
    });
    expect(prefill.itemType).toBe('sentence');
    expect(prefill.selectedText).toBe('She broke the ice with a joke.');
    expect(prefill.context).toBe(sentence);
  });
});

describe('translation target resolution (one rule, everywhere)', () => {
  it('uses the profile native language when available', () => {
    expect(resolveTargetLanguage('Spanish')).toBe('Spanish');
    expect(resolveTargetLanguage('French')).toBe('French');
  });

  it('falls back to the existing default only when unavailable', () => {
    expect(resolveTargetLanguage(undefined)).toBe(DEFAULT_INSPECTION_TARGET_LANGUAGE);
    expect(resolveTargetLanguage(null)).toBe(DEFAULT_INSPECTION_TARGET_LANGUAGE);
    expect(resolveTargetLanguage('')).toBe(DEFAULT_INSPECTION_TARGET_LANGUAGE);
    expect(resolveTargetLanguage('   ')).toBe(DEFAULT_INSPECTION_TARGET_LANGUAGE);
    expect(DEFAULT_INSPECTION_TARGET_LANGUAGE).toBe('Arabic');
  });
});
