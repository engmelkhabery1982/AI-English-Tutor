import { describe, expect, it } from 'vitest';
import { FeedbackStreamFilter, parseFeedbackAndContent } from './feedback';

describe('Feedback Parsing & Stream Filtering', () => {
  describe('parseFeedbackAndContent', () => {
    it('returns original content and null feedback when no feedback block exists', () => {
      const input = 'Hello, how can I help you today?';
      const result = parseFeedbackAndContent(input);
      expect(result.content).toBe('Hello, how can I help you today?');
      expect(result.feedback).toBeNull();
    });

    it('parses valid feedback and extracts clean content', () => {
      const input = `I went to the store yesterday.
[FEEDBACK]
{
  "correction": {
    "original": "I go yesterday",
    "improved": "I went yesterday",
    "explanation": "Use past tense for past events.",
    "severity": "incorrect"
  },
  "vocabulary": {
    "headword": "grocery",
    "type": "word",
    "meaning": "food and household supplies",
    "example": "I bought groceries."
  },
  "coachingNote": "Great effort using past tense."
}
[/FEEDBACK]`;

      const result = parseFeedbackAndContent(input);
      expect(result.content).toBe('I went to the store yesterday.');
      expect(result.feedback).not.toBeNull();
      expect(result.feedback?.correction?.original).toBe('I go yesterday');
      expect(result.feedback?.correction?.improved).toBe('I went yesterday');
      expect(result.feedback?.correction?.severity).toBe('incorrect');
      expect(result.feedback?.vocabulary?.headword).toBe('grocery');
      expect(result.feedback?.coachingNote).toBe('Great effort using past tense.');
    });

    it('handles malformed JSON inside feedback block gracefully', () => {
      const input = `Nice sentence! [FEEDBACK] { bad json [/FEEDBACK]`;
      const result = parseFeedbackAndContent(input);
      expect(result.content).toBe('Nice sentence!');
      expect(result.feedback).toBeNull();
    });
  });

  describe('FeedbackStreamFilter', () => {
    it('emits chunks directly when no feedback block is present', () => {
      const chunks: string[] = [];
      const filter = new FeedbackStreamFilter((c) => chunks.push(c));

      filter.push('Hello ');
      filter.push('world!');
      const result = filter.finish();

      expect(chunks.join('')).toBe('Hello world!');
      expect(result.content).toBe('Hello world!');
      expect(result.feedback).toBeNull();
    });

    it('filters out [FEEDBACK] block from emitted chunks and returns structured feedback upon finalize', () => {
      const chunks: string[] = [];
      const filter = new FeedbackStreamFilter((c) => chunks.push(c));

      filter.push('Hello there! ');
      filter.push('How are you?\n');
      filter.push('[FEED');
      filter.push('BACK]\n{\n');
      filter.push('  "coachingNote": "Good job!"\n');
      filter.push('}\n[/FEED');
      filter.push('BACK]');

      const result = filter.finish();

      // Emitted chunks should not have [FEEDBACK]
      expect(chunks.join('').trim()).toBe('Hello there! How are you?');
      expect(result.content.trim()).toBe('Hello there! How are you?');
      expect(result.feedback?.coachingNote).toBe('Good job!');
    });
  });
});
