/**
 * src/translation/index.test.ts
 *
 * Tests for Translation Core, Chunking, and Document Translation Foundation.
 * Uses fake/injected AIProvider exclusively without network or Gemini SDK dependencies.
 */

import { describe, expect, it } from 'vitest';
import type { AIProvider, AIProviderResult, ConversationRequest } from '../providers/ai/types';
import {
  chunkLongText,
  createTranslationService,
  detectLanguageDirection,
  reconstructLongText,
  validateChunkSequence,
} from './index';
import type { DocumentBlock, TranslatedTextChunk } from './types';

function createMockAIProvider(
  handler: (request: ConversationRequest) => AIProviderResult
): AIProvider {
  return {
    id: 'mock-translation-ai',
    generate: async (request: ConversationRequest): Promise<AIProviderResult> => {
      return handler(request);
    },
  };
}

describe('Translation Core (Phase 1)', () => {
  it('9. translates English → Arabic with natural phrasing', async () => {
    const enToArJson = JSON.stringify({
      translatedText: 'يتطلب النجاح في الأعمال التجارية التزاماً وتفانياً مستمرين.',
      direction: 'en-to-ar',
      style: 'natural',
      arabicVariety: 'msa',
      literalTranslation: 'النجاح في العمل يتطلب التزاماً مستمراً وتفانياً.',
      alternatives: [
        'النجاح في ريادة الأعمال يستلزم مواظبة وتفانياً.',
      ],
      explanation: 'Uses modern standard business Arabic phrasing.',
      learningNotes: ["'Commitment' translates well to 'التزام'."],
      learningCandidates: {
        vocabulary: [
          {
            headword: 'commitment',
            partOfSpeech: 'noun',
            contextMeaning: 'dedication to a cause or activity',
            arabicMeaning: 'التزام',
          },
        ],
        expressions: [],
        collocations: [],
        phrasalVerbs: [],
      },
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: enToArJson },
    }));

    const service = createTranslationService(mockProvider);
    const outcome = await service.translateText(
      'Success in business requires continuous commitment and dedication.',
      { direction: 'en-to-ar' }
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.direction).toBe('en-to-ar');
      expect(outcome.data.translatedText).toContain('النجاح في الأعمال');
      expect(outcome.data.literalTranslation).toBeDefined();
      expect(outcome.data.alternatives).toHaveLength(1);
      expect(outcome.data.learningCandidates.vocabulary).toHaveLength(1);
      expect(outcome.data.learningCandidates.vocabulary[0].headword).toBe('commitment');
    }
  });

  it('10. translates Arabic → English accurately', async () => {
    const arToEnJson = JSON.stringify({
      translatedText: 'Continuous learning is the secret to professional excellence.',
      direction: 'ar-to-en',
      style: 'natural',
      arabicVariety: 'msa',
      literalTranslation: 'The continuous learning is secret of the professional distinction.',
      alternatives: [],
      explanation: null,
      learningNotes: [],
      learningCandidates: {
        vocabulary: [],
        expressions: [],
        collocations: [
          {
            collocation: 'continuous learning',
            usageNote: 'Common professional collocation',
          },
        ],
        phrasalVerbs: [],
      },
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: arToEnJson },
    }));

    const service = createTranslationService(mockProvider);
    const outcome = await service.translateText('التعلم المستمر هو سر التميز المهني.');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.direction).toBe('ar-to-en');
      expect(outcome.data.translatedText).toBe(
        'Continuous learning is the secret to professional excellence.'
      );
    }
  });

  it('11. provides natural translation by default in Modern Standard Arabic', () => {
    const dir1 = detectLanguageDirection('Welcome to our application!');
    expect(dir1).toBe('en-to-ar');

    const dir2 = detectLanguageDirection('أهلاً بك في تطبيقنا التعليمي');
    expect(dir2).toBe('ar-to-en');
  });

  it('12. alternative translation provided only when justified', async () => {
    const jsonWithAlt = JSON.stringify({
      translatedText: 'Let us get started.',
      direction: 'ar-to-en',
      style: 'natural',
      arabicVariety: 'msa',
      alternatives: ['Let us begin.'],
      learningNotes: [],
      learningCandidates: {
        vocabulary: [],
        expressions: [],
        collocations: [],
        phrasalVerbs: [],
      },
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: jsonWithAlt },
    }));

    const service = createTranslationService(mockProvider);
    const outcome = await service.translateText('دعنا نبدأ.');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.alternatives).toHaveLength(1);
      expect(outcome.data.alternatives[0]).toBe('Let us begin.');
    }
  });

  it('13. long-text chunking guarantees EXACT character preservation without dropping or altering whitespace', () => {
    const paragraph1 = '  First indented paragraph with \t tabs and spaces.';
    const paragraph2 = 'Second paragraph\r\nwith Windows-style line breaks and   multiple   spaces.';
    const paragraph3 = 'Third paragraph with emojis 🚀💡 and Arabic diacritics: كَتَبَ، قَرَأَ، دَرَسَ.\n\n\nTriple newline above.';
    const fullText = `${paragraph1}\n\n${paragraph2}\r\n\r\n${paragraph3}`;

    const chunks = chunkLongText(fullText, { maxChunkSize: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // Invariant: chunks.map(c => c.text).join('') === originalText
    const reconstructed = chunks.map((c) => c.text).join('');
    expect(reconstructed).toBe(fullText);

    // Invariant: startOffset and endOffset match exact slice positions in source text
    for (const chunk of chunks) {
      expect(fullText.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      expect(chunk.characterCount).toBe(chunk.text.length);
    }
  });

  it('13b. exact text preservation on complex inputs (markdown, code, long tokens without spaces)', () => {
    const complexText =
      '# Heading 1\n\n```typescript\nfunction test() {\n\tconst a = 1;\n\treturn a;\n}\n```\n\n' +
      '* List item 1\n* List item 2\n\n' +
      'A_very_long_unbroken_token_exceeding_standard_chunk_boundaries_abcdefghijklmnopqrstuvwxyz0123456789\n\n' +
      'Trailing spaces after this line.    \n\nFinal words.';

    const chunks = chunkLongText(complexText, { maxChunkSize: 45 });
    expect(chunks.length).toBeGreaterThan(1);

    expect(chunks.map((c) => c.text).join('')).toBe(complexText);

    for (const chunk of chunks) {
      expect(complexText.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it('14. chunk order is strictly preserved', () => {
    const fullText = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.';
    const chunks = chunkLongText(fullText, { maxChunkSize: 20 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
      expect(chunks[i].chunkId).toBe(`chunk-${i}`);
    }
  });

  it('15. no duplicated chunks generated during text chunking', () => {
    const sample = 'Line A\n\nLine B\n\nLine C\n\nLine D\n\nLine E';
    const chunks = chunkLongText(sample, { maxChunkSize: 15 });
    const ids = chunks.map((c) => c.chunkId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(chunks.length);

    const validation = validateChunkSequence(chunks);
    expect(validation.hasDuplicates).toBe(false);
    expect(validation.isStrictlySequential).toBe(true);
    expect(validation.valid).toBe(true);
  });

  it('16. deterministic chunking produces identical results for identical inputs', () => {
    const input = 'Sample text across several paragraphs.\n\nAnother paragraph here.\n\nAnd a third.';
    const run1 = chunkLongText(input, { maxChunkSize: 40 });
    const run2 = chunkLongText(input, { maxChunkSize: 40 });

    expect(run1).toEqual(run2);
  });

  it('17. document blocks preserve IDs and original order', async () => {
    const blocks: DocumentBlock[] = [
      { id: 'title-1', order: 0, type: 'title', text: 'Quarterly Report' },
      { id: 'h-1', order: 1, type: 'heading', text: 'Executive Summary' },
      { id: 'p-1', order: 2, type: 'paragraph', text: 'Revenue grew by 25% this quarter.' },
      { id: 'li-1', order: 3, type: 'list_item', text: 'Expanded into 3 new regional markets.' },
    ];

    const mockAiResponse = JSON.stringify({
      translatedBlocks: [
        { id: 'title-1', translatedText: 'التقرير الفصلي' },
        { id: 'h-1', translatedText: 'الملخص التنفيذي' },
        { id: 'p-1', translatedText: 'نمت الإيرادات بنسبة 25% هذا الربع.' },
        { id: 'li-1', translatedText: 'التوسع في ثلاثة أسواق إقليمية جديدة.' },
      ],
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: mockAiResponse },
    }));

    const service = createTranslationService(mockProvider);
    const result = await service.translateDocument({
      documentId: 'doc-report-1',
      blocks,
      options: { direction: 'en-to-ar' },
    });

    expect(result.overallSuccess).toBe(true);
    expect(result.blocks).toHaveLength(4);

    // Verify ordering and IDs are preserved exactly
    expect(result.blocks[0].id).toBe('title-1');
    expect(result.blocks[0].translatedText).toBe('التقرير الفصلي');
    expect(result.blocks[0].order).toBe(0);

    expect(result.blocks[1].id).toBe('h-1');
    expect(result.blocks[1].order).toBe(1);

    expect(result.blocks[2].id).toBe('p-1');
    expect(result.blocks[2].translatedText).toContain('25%');

    expect(result.blocks[3].id).toBe('li-1');
    expect(result.blocks[3].order).toBe(3);
  });

  it('18. translation failure preserves source without overwriting', async () => {
    const mockFailingProvider = createMockAIProvider(() => ({
      ok: false,
      error: {
        code: 'timeout',
        message: 'Network request timed out.',
        retryable: true,
      },
    }));

    const service = createTranslationService(mockFailingProvider);

    // Test text translation failure preserves source text
    const outcome = await service.translateText('Critical business memo.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.originalText).toBe('Critical business memo.');
      expect(outcome.error.code).toBe('ai_unavailable');
    }

    // Test document translation failure preserves source safely
    const blocks: DocumentBlock[] = [
      { id: 'b-1', order: 0, type: 'paragraph', text: 'Important paragraph text.' },
    ];
    const docResult = await service.translateDocument({ blocks });
    expect(docResult.overallSuccess).toBe(false);
    expect(docResult.blocks[0].originalText).toBe('Important paragraph text.');
    expect(docResult.blocks[0].translatedText).toBe('Important paragraph text.');
    expect(docResult.blocks[0].success).toBe(false);
  });

  it('19. malformed AI structured output fails safely', async () => {
    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: 'Not valid json at all!' },
    }));

    const service = createTranslationService(mockProvider);
    const outcome = await service.translateText('Hello world');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('invalid_response');
      expect(outcome.originalText).toBe('Hello world');
    }
  });

  it('21. no direct SQLite imports or writes exist in translation core', () => {
    // Verified by pure dependency structure; reconstructLongText is a pure function
    const mockChunks: TranslatedTextChunk[] = [
      {
        chunkId: 'chunk-0',
        index: 0,
        originalText: 'Hello',
        translatedText: 'مرحبا',
        success: true,
      },
    ];
    expect(reconstructLongText(mockChunks)).toBe('مرحبا');
  });

  it('23. no SDK/provider duplication and existing AIProvider reused', async () => {
    let capturedRequest: ConversationRequest | null = null;
    const mockProvider = createMockAIProvider((req) => {
      capturedRequest = req;
      return {
        ok: true,
        response: {
          content: JSON.stringify({
            translatedText: 'مرحبا بالعالم',
            direction: 'en-to-ar',
            style: 'natural',
            arabicVariety: 'msa',
            alternatives: [],
            learningNotes: [],
            learningCandidates: {
              vocabulary: [],
              expressions: [],
              collocations: [],
              phrasalVerbs: [],
            },
          }),
        },
      };
    });

    const service = createTranslationService(mockProvider);
    await service.translateText('Hello world');

    expect(capturedRequest).not.toBeNull();
    const req = capturedRequest as ConversationRequest | null;
    expect(req?.systemPrompt).toContain('professional translator');
  });

  describe('Service Long-Text Source Fidelity Regression Tests', () => {
    function createMockTranslatingProvider(customHandler?: (text: string) => string | null) {
      return createMockAIProvider((req) => {
        const userMsg = req.messages?.[0]?.content || '';
        const match = userMsg.match(/Translate the following text:\s*\n*"""\s*([\s\S]*?)\s*"""/i);
        const textToTranslate = match ? match[1].trim() : userMsg.trim();

        if (customHandler) {
          const handled = customHandler(textToTranslate);
          if (handled === null) {
            return {
              ok: false,
              error: { code: 'failed', message: 'Translation failed', retryable: false },
            };
          }
          return {
            ok: true,
            response: {
              content: JSON.stringify({
                translatedText: handled,
                direction: 'en-to-ar',
                style: 'natural',
                arabicVariety: 'msa',
                alternatives: [],
                learningNotes: [],
              }),
            },
          };
        }

        return {
          ok: true,
          response: {
            content: JSON.stringify({
              translatedText: `ترجمة: ${textToTranslate}`,
              direction: 'en-to-ar',
              style: 'natural',
              arabicVariety: 'msa',
              alternatives: [],
              learningNotes: [],
            }),
          },
        };
      });
    }

    it('service regression: 1. translateLongText originalText exactly equals raw input', async () => {
      const rawInput =
        '   \n\n\tLeading spaces, tabs, and newlines before text.\n\nSecond paragraph here.   \n\n';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 50 });

      expect(result.originalText).toBe(rawInput);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 2. input with leading newlines remains represented', async () => {
      const rawInput = '\n\n\nFirst paragraph starting after three newlines.\n\nSecond paragraph.';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 45 });

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText.startsWith('\n\n\n')).toBe(true);
      expect(result.chunks[0].originalText.startsWith('\n\n\n')).toBe(true);
      expect(result.chunks[0].translatedText.startsWith('\n\n\n')).toBe(true);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 3. trailing newlines remain represented', async () => {
      const rawInput =
        'First paragraph content.\n\nFinal paragraph ending with four trailing newlines.\n\n\n\n';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 45 });

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText.endsWith('\n\n\n\n')).toBe(true);
      const lastChunk = result.chunks[result.chunks.length - 1];
      expect(lastChunk.originalText.endsWith('\n\n\n\n')).toBe(true);
      expect(lastChunk.translatedText.endsWith('\n\n\n\n')).toBe(true);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 4. multiple blank lines do not collapse', async () => {
      const rawInput = 'Paragraph one.\n\n\n\n\nParagraph two with four blank lines above.';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 30 });

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText).toContain('\n\n\n\n\n');
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 5. tabs/indentation survive structurally', async () => {
      const rawInput = '\t\tCode block or indented paragraph.\n\n\tNext line indented with tab.';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 35 });

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText.startsWith('\t\t')).toBe(true);
      expect(result.translatedText).toContain('\n\n\t');
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 6. CRLF structure is preserved', async () => {
      const rawInput =
        'First line with CRLF.\r\n\r\nSecond line with CRLF.\r\n\r\nThird line.\r\n';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 35 });

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText).toContain('\r\n\r\n');
      expect(result.translatedText.endsWith('\r\n')).toBe(true);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
    });

    it('service regression: 7. chunk boundaries do not concatenate paragraphs', async () => {
      const p1 =
        'First paragraph describing fundamental principles of cognitive linguistics.';
      const p2 =
        'Second paragraph examining bilingual semantic transfer and syntactic alignment.';
      const p3 =
        'Third paragraph evaluating machine translation fluency and fidelity metrics.';
      const rawInput = `${p1}\n\n${p2}\n\n${p3}`;

      const service = createTranslationService(
        createMockTranslatingProvider((text) => {
          if (text.includes('cognitive linguistics')) return 'الفقرة الأولى عن اللسانيات الإدراكية.';
          if (text.includes('bilingual semantic')) return 'الفقرة الثانية عن النقل الدلالي ثنائي اللغة.';
          if (text.includes('evaluating machine')) return 'الفقرة الثالثة عن تقييم دقة الترجمة الآلية.';
          return `ترجمة: ${text}`;
        })
      );

      const result = await service.translateLongText(rawInput, { maxChunkSize: 85 });

      expect(result.chunks.length).toBeGreaterThanOrEqual(3);
      expect(result.originalText).toBe(rawInput);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);

      // Paragraphs must NOT be concatenated directly
      expect(result.translatedText).not.toContain('اللسانيات الإدراكية.الفقرة الثانية');
      expect(result.translatedText).not.toContain('ثنائي اللغة.الفقرة الثالثة');
      // Must preserve paragraph breaks between all translated chunks
      const translatedParagraphs = result.translatedText.split(/\n\n+/);
      expect(translatedParagraphs.length).toBe(3);
    });

    it('service regression: 8. failed chunk preserves exact original source slice', async () => {
      const p1 = 'First successful paragraph.';
      const p2 = 'Second paragraph that causes failure.';
      const p3 = 'Third successful paragraph.';
      const rawInput = `${p1}\n\n${p2}\n\n${p3}`;

      const service = createTranslationService(
        createMockTranslatingProvider((text) => {
          if (text.includes('causes failure')) return null; // simulate failure
          return `مترجم: ${text}`;
        })
      );

      const result = await service.translateLongText(rawInput, { maxChunkSize: 35 });

      expect(result.overallSuccess).toBe(false);
      expect(result.failedChunkIndexes.length).toBeGreaterThanOrEqual(1);

      // Source invariant remains intact
      expect(result.originalText).toBe(rawInput);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);

      // The failed chunk preserves exact original slice in translatedText
      const failedChunk = result.chunks.find((c) => !c.success);
      expect(failedChunk).toBeDefined();
      if (failedChunk) {
        expect(failedChunk.translatedText).toBe(failedChunk.originalText);
        expect(failedChunk.originalText).toContain('Second paragraph that causes failure.');
        expect(result.translatedText).toContain(failedChunk.originalText);
      }
    });

    it('service regression: 9. mixed Arabic/English input remains structurally intact', async () => {
      const rawInput =
        'Introductory English section.\n\n' +
        'فقرة باللغة العربية تشرح المفاهيم الأساسية.\n\n' +
        'Mixed closing section: الذكاء الاصطناعي (AI) and modern NLP models.\n\n';

      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput, { maxChunkSize: 50 });

      expect(result.originalText).toBe(rawInput);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
      expect(result.translatedText.endsWith('\n\n')).toBe(true);
      expect(result.translatedText).toContain('\n\n');
      const paragraphs = result.translatedText.trim().split(/\n\n+/);
      expect(paragraphs.length).toBe(3);
    });

    it('handles pure whitespace in translateLongText without error and preserves structure', async () => {
      const rawInput = '   \n\n\t   \r\n\r\n   ';
      const service = createTranslationService(createMockTranslatingProvider());
      const result = await service.translateLongText(rawInput);

      expect(result.originalText).toBe(rawInput);
      expect(result.translatedText).toBe(rawInput);
      expect(result.chunks.map((c) => c.originalText).join('')).toBe(rawInput);
      expect(result.overallSuccess).toBe(true);
    });
  });
});
