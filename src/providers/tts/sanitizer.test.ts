/**
 * src/providers/tts/sanitizer.test.ts
 */

import { describe, it, expect } from 'vitest';
import { sanitizeTextForTTS } from './sanitizer';

describe('sanitizeTextForTTS', () => {
  it('returns empty string for null, undefined, or empty text', () => {
    expect(sanitizeTextForTTS('')).toBe('');
    expect(sanitizeTextForTTS('   ')).toBe('');
  });

  it('strips markdown headings and bold/italic asterisks', () => {
    const input = '### Great job!\n**You** spoke very *well*.';
    const result = sanitizeTextForTTS(input);
    expect(result).toBe('Great job! You spoke very well.');
  });

  it('strips bracketed system/tutor notes', () => {
    const input = 'Hello there! [Correction: grammar issue] How are you today?';
    const result = sanitizeTextForTTS(input);
    expect(result).toBe('Hello there! How are you today?');
  });

  it('strips URLs and links', () => {
    const input = 'Check out [this link](https://example.com) or visit https://google.com for help.';
    const result = sanitizeTextForTTS(input);
    expect(result).toBe('Check out this link or visit for help.');
  });

  it('strips bullet points and numbered list markers', () => {
    const input = 'Here are tips:\n- Practice daily\n* Listen to podcasts\n1. Read aloud';
    const result = sanitizeTextForTTS(input);
    expect(result).toContain('Practice daily');
    expect(result).toContain('Listen to podcasts');
    expect(result).toContain('Read aloud');
    expect(result).not.toContain('-');
    expect(result).not.toContain('*');
  });

  it('collapses multiple whitespace and newlines', () => {
    const input = 'Hello   world!\n\n\nHow is it    going?';
    const result = sanitizeTextForTTS(input);
    expect(result).toBe('Hello world! How is it going?');
  });
});
