/**
 * src/providers/tts/sanitizer.ts
 *
 * Sanitizes tutor messages prior to Text-to-Speech playback.
 * Ensures only the natural conversational tutor response is spoken aloud,
 * never raw feedback JSON, markdown markup, or vocabulary metadata.
 */

export function sanitizeTextForTTS(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  let text = rawText;

  // 1. Remove hidden structured feedback tags
  text = text.replace(/\[\[FEEDBACK_START\]\][\s\S]*?\[\[FEEDBACK_END\]\]/g, '');

  // 2. Remove any JSON blocks (e.g. if model output raw JSON object)
  text = text.replace(/\{[\s\S]*?"(correction|vocabulary|coachingNote)"[\s\S]*?\}/g, '');
  text = text.replace(/```(?:json)?[\s\S]*?```/g, '');

  // 3. Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // 4. Remove standalone bracketed notes like [Correction: ...] or (Note: ...)
  text = text.replace(/\[\s*(?:Correction|Note|Feedback|Tip|Grammar)[^\]]*\]/gi, '');
  text = text.replace(/\(\s*(?:Correction|Note|Feedback|Tip|Grammar)[^)]*\)/gi, '');

  // 5. Remove markdown links: [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 6. Remove raw URLs
  text = text.replace(/https?:\/\/\S+/gi, '');

  // 7. Remove bold and italic markdown markers
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');

  // 6. Remove header markers and blockquote symbols
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/^>\s+/gm, '');

  // 7. Remove list bullet points: "- item" -> "item"
  text = text.replace(/^[-*•]\s+/gm, '');

  // 8. Normalize spaces, line breaks, and trim
  text = text.replace(/\s+/g, ' ').trim();

  // If text looks like leftover JSON (starts with { and ends with }), discard
  if (text.startsWith('{') && text.endsWith('}')) {
    return '';
  }

  return text;
}
