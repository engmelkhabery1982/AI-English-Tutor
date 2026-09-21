/**
 * src/screens/components/inspectable-text.ts
 *
 * PURE helpers behind the shared "inspect language from content" interaction
 * (the InspectableText component renders them). No React Native imports here
 * so the logic is testable without a renderer and importable from the
 * runtime-pure navigation route table (type-only).
 *
 * Interaction contract (Package 2, C/D): React Native text does not offer a
 * reliable custom selection menu across the current stack, so the smallest
 * safe fallback is used — the learner TAPS a word/phrase region inside
 * learner-facing content, an explicit contextual action row appears, and only
 * that action opens Dictionary & Translate, prefilled with the exact selected
 * text, its containing sentence and the full source passage.
 */

/** Plain, serializable inspection prefill (safe to pass as a route param). */
export interface InspectionPrefillParam {
  readonly originalText: string;
  readonly selectedText: string;
  readonly itemType: 'word' | 'phrase' | 'idiom' | 'collocation' | 'expression' | 'sentence' | 'short_text';
  readonly context?: string;
  readonly targetLanguage: string;
  readonly sourceRef?: string;
}

export interface InspectableToken {
  /** The token exactly as it appears in the text (rendered). */
  readonly display: string;
  /** The tappable lookup form: surrounding punctuation removed, inner text untouched. */
  readonly lookup: string;
}

/** Splits a passage into sentences on terminal punctuation (same rule Talk uses). */
export function splitInspectableSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Splits ONE sentence into whitespace tokens. `lookup` strips leading/trailing
 * punctuation (quotes, commas, periods…) but NEVER alters the inner text, so
 * the learner's selection is preserved exactly. Tokens with no letters/digits
 * are not inspectable (lookup === '').
 */
export function tokenizeInspectableSentence(sentence: string): InspectableToken[] {
  return sentence.split(/\s+/).filter(Boolean).map((display) => {
    const lookup = display
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N}'’-]+$/u, '');
    return { display, lookup };
  });
}

/**
 * Reliable item-type inference only: ONE token is a word, anything spanning
 * tokens is a phrase. Nothing else is guessed (idioms/expressions stay a
 * learner choice in the panel's item-type control).
 */
export function inferInspectableItemType(selectedText: string): 'word' | 'phrase' {
  return /\s/.test(selectedText.trim()) ? 'phrase' : 'word';
}

/**
 * Builds the Dictionary & Translate prefill for a tap inside content. The
 * selected text is passed through EXACTLY as extracted from the passage (it is
 * a substring of the source, which the inspector validates).
 */
export function buildInspectionPrefill(input: {
  readonly selectedText: string;
  readonly sentence: string;
  readonly fullText: string;
  readonly targetLanguage: string;
  readonly sourceRef?: string;
  readonly itemType?: InspectionPrefillParam['itemType'];
}): InspectionPrefillParam {
  const selectedText = input.selectedText;
  return {
    originalText: input.fullText,
    selectedText,
    itemType: input.itemType ?? inferInspectableItemType(selectedText),
    context: input.sentence,
    targetLanguage: input.targetLanguage,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
  };
}
