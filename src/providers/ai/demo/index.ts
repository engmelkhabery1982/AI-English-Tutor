/**
 * src/providers/ai/demo/index.ts
 *
 * Deterministic, offline local AI Provider for text chat demo and verification.
 * Implements the standard AIProvider interface without external SDKs or network access.
 */

import type {
  AIProvider,
  AIProviderResult,
  AIStreamCallback,
  ConversationFeedback,
  ConversationRequest,
} from '../types';
import {
  createAIProviderResponse,
  createAIProviderSuccess,
} from '../index';

export const DEMO_AI_PROVIDER_ID = 'demo-local';

interface DeterministicOutcome {
  readonly content: string;
  readonly feedback: ConversationFeedback | null;
}

/**
 * Generates a deterministic English tutoring reply and structured feedback based on the user's message, mode, and topic.
 */
function generateDeterministicOutcome(request: ConversationRequest): DeterministicOutcome {
  const lastTurn = request.messages[request.messages.length - 1];
  const userText = (lastTurn?.role === 'user' ? lastTurn.content : '').trim();
  const lowerText = userText.toLowerCase();
  const topic = request.topic?.trim() || null;
  const mode = request.mode;

  // 1. Greetings
  if (/^(hello|hi|hey|good\s+(morning|afternoon|evening)|howdy)\b/i.test(lowerText)) {
    const content = topic
      ? `Hi! Nice to meet you. Let's talk about ${topic}! What would you like to share first?`
      : `Hi! Nice to meet you. What would you like to talk about today?`;

    return {
      content,
      feedback: {
        correction: null,
        vocabulary: {
          headword: 'catch up',
          type: 'phrasal_verb',
          meaning: "to talk with someone you haven't seen in a while to find out what has been happening",
          example: "Let's catch up over coffee this weekend.",
        },
        coachingNote: 'Starting conversations with open questions helps practice extended speaking.',
      },
    };
  }

  // 2. Common grammar / article omission patterns
  if (/\bwent to meeting\b/i.test(lowerText)) {
    return {
      content: `That sounds interesting. You could say, "I went to a meeting yesterday." What was the meeting about?`,
      feedback: {
        correction: {
          original: 'I went to meeting yesterday',
          improved: 'I went to the meeting yesterday.',
          explanation: 'Use "the" when referring to a specific meeting.',
          severity: 'incorrect',
        },
        vocabulary: {
          headword: 'follow up',
          type: 'phrasal_verb',
          meaning: 'to check progress or continue communication about something',
          example: "I'll follow up with the client tomorrow.",
        },
        coachingNote: "Remember to include articles like 'a' or 'the' with countable singular nouns.",
      },
    };
  }

  if (/\bhave car\b/i.test(lowerText)) {
    return {
      content: `Great! In English we say "I have a car" with the article "a". What kind of car do you have?`,
      feedback: {
        correction: {
          original: 'have car',
          improved: 'have a car',
          explanation: "Use the indefinite article 'a' before singular countable nouns starting with a consonant sound.",
          severity: 'incorrect',
        },
        vocabulary: {
          headword: 'commute',
          type: 'word',
          meaning: 'to travel regularly between home and work or school',
          example: 'How long is your daily commute?',
        },
        coachingNote: "Countable nouns in singular form require a determiner such as 'a', 'an', or 'the'.",
      },
    };
  }

  if (/\bbought book\b/i.test(lowerText)) {
    return {
      content: `Nice! You could say "I bought a book." What is the book about?`,
      feedback: {
        correction: {
          original: 'bought book',
          improved: 'bought a book',
          explanation: "Add the indefinite article 'a' before singular countable noun 'book'.",
          severity: 'incorrect',
        },
        vocabulary: {
          headword: 'page-turner',
          type: 'phrase',
          meaning: 'a book that is so exciting you want to read it quickly',
          example: 'That novel was an absolute page-turner.',
        },
        coachingNote: 'Always check countable nouns for missing articles.',
      },
    };
  }

  if (/\b(am agree|agree with you)\b/i.test(lowerText)) {
    return {
      content: `Quick tip: in English we say "I agree" rather than "I am agree". Why do you think so?`,
      feedback: {
        correction: {
          original: 'am agree',
          improved: 'agree',
          explanation: "'Agree' is already a verb in English, so we say 'I agree' instead of 'I am agree'.",
          severity: 'incorrect',
        },
        vocabulary: {
          headword: 'see eye to eye',
          type: 'idiom',
          meaning: 'to agree fully with someone',
          example: 'We see eye to eye on most important issues.',
        },
        coachingNote: "'Agree' is a full verb, not an adjective.",
      },
    };
  }

  // 3. Questions / Inquiries
  if (/\bhow are you\b/i.test(lowerText)) {
    return {
      content: `I'm doing well, thank you for asking! How are your English studies going today?`,
      feedback: {
        correction: null,
        vocabulary: {
          headword: 'make progress',
          type: 'collocation',
          meaning: 'to develop or improve over time',
          example: "You're making steady progress in your spoken English.",
        },
        coachingNote: 'Answering personal questions in detail builds conversational fluency.',
      },
    };
  }

  if (/\b(what is your name|who are you)\b/i.test(lowerText)) {
    return {
      content: `I am your AI English Tutor demo assistant. I'm here to help you practice English!`,
      feedback: {
        coachingNote: 'Feel free to practice any topic or conversation mode anytime.',
      },
    };
  }

  if (lowerText.endsWith('?') || /^(what|where|when|why|how|who|can|could|would|is|are|do|does|did)\b/i.test(lowerText)) {
    const content = topic
      ? `That is a thoughtful question about ${topic}. How would you answer it from your own perspective?`
      : `That is a great question! Explaining your thoughts in English is wonderful practice. What do you think?`;
    return {
      content,
      feedback: {
        coachingNote: 'Formulating your own answers to questions is great for critical thinking in English.',
      },
    };
  }

  // 4. Mode-specific & fallback responses
  if (topic === 'Review Evaluation') {
    // Generate deterministic JSON for ReviewEvaluator
    const resultObj = {
      result: lowerText.includes('dog') ? 'correct' : 'incorrect',
      feedback: lowerText.includes('dog') ? 'Good job!' : 'Not quite.',
      explanation: 'Demo explanation.',
      suggestedCorrection: 'I have a dog'
    };
    return {
      content: JSON.stringify(resultObj),
      feedback: null
    };
  }

  if (mode === 'coach') {
    const content = topic
      ? `Good point regarding ${topic}! In coach mode, try expanding your idea with an example or reason. What else can you add?`
      : `Good point! In coach mode, try using complete sentences with descriptive words. Could you elaborate on that?`;
    return {
      content,
      feedback: {
        coachingNote: 'In coach mode, try expanding your idea with an example or reason.',
      },
    };
  }

  if (mode === 'intensive') {
    const content = topic
      ? `Understood. In intensive mode, challenge yourself: use a connective word like "furthermore" or "however" to discuss ${topic}.`
      : `Understood. In intensive mode, let's refine this: try expanding your answer with more specific vocabulary.`;
    return {
      content,
      feedback: {
        vocabulary: {
          headword: 'furthermore',
          type: 'linking_expression',
          meaning: 'in addition; moreover',
          example: 'The plan is practical; furthermore, it is cost-effective.',
        },
        coachingNote: 'In intensive mode, focus on connecting words and precise collocations.',
      },
    };
  }

  // Default 'natural' mode
  const content = topic
    ? `That sounds interesting! Speaking about ${topic} is great practice. Tell me more about your thoughts on that.`
    : `That sounds interesting! Could you tell me a little more about that?`;
  return {
    content,
    feedback: null,
  };
}

/**
 * Concrete implementation of the demo local AIProvider.
 */
class DemoAIProvider implements AIProvider {
  readonly id = DEMO_AI_PROVIDER_ID;

  async generate(request: ConversationRequest): Promise<AIProviderResult> {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error('Demo AI Provider requires a valid ConversationRequest with non-empty messages.');
    }

    const { content, feedback } = generateDeterministicOutcome(request);
    const response = createAIProviderResponse(content, {
      feedback,
      finishReason: 'completed',
    });

    return createAIProviderSuccess(response);
  }

  async generateStream(
    request: ConversationRequest,
    onChunk: AIStreamCallback
  ): Promise<AIProviderResult> {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error('Demo AI Provider requires a valid ConversationRequest with non-empty messages.');
    }

    const { content, feedback } = generateDeterministicOutcome(request);

    // Simulate streaming in small progressive chunks
    const words = content.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? '' : ' ') + words[i];
      onChunk(chunk);
    }

    const response = createAIProviderResponse(content, {
      feedback,
      finishReason: 'completed',
    });

    return createAIProviderSuccess(response);
  }
}

/**
 * Factory for creating a deterministic DemoAIProvider instance.
 */
export function createDemoAIProvider(): AIProvider {
  return new DemoAIProvider();
}
