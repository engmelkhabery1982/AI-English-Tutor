/**
 * src/providers/ai/demo/index.ts
 *
 * Deterministic, offline local AI Provider for text chat demo and verification.
 * Implements the standard AIProvider interface without external SDKs or network access.
 */

import type {
  AIProvider,
  AIProviderResult,
  ConversationRequest,
} from '../types';
import {
  createAIProviderResponse,
  createAIProviderSuccess,
} from '../index';

export const DEMO_AI_PROVIDER_ID = 'demo-local';

/**
 * Generates a deterministic English tutoring reply based on the user's message, mode, and topic.
 */
function generateDeterministicReply(request: ConversationRequest): string {
  const lastTurn = request.messages[request.messages.length - 1];
  const userText = (lastTurn?.role === 'user' ? lastTurn.content : '').trim();
  const lowerText = userText.toLowerCase();
  const topic = request.topic?.trim() || null;
  const mode = request.mode;

  // 1. Greetings
  if (/^(hello|hi|hey|good\s+(morning|afternoon|evening)|howdy)\b/i.test(lowerText)) {
    if (topic) {
      return `Hi! Nice to meet you. Let's talk about ${topic}! What would you like to share first?`;
    }
    return `Hi! Nice to meet you. What would you like to talk about today?`;
  }

  // 2. Common grammar / article omission patterns
  if (/\bwent to meeting\b/i.test(lowerText)) {
    return `That sounds interesting. You could say, "I went to a meeting yesterday." What was the meeting about?`;
  }
  if (/\bhave car\b/i.test(lowerText)) {
    return `Great! In English we say "I have a car" with the article "a". What kind of car do you have?`;
  }
  if (/\bbought book\b/i.test(lowerText)) {
    return `Nice! You could say "I bought a book." What is the book about?`;
  }
  if (/\b(am agree|agree with you)\b/i.test(lowerText)) {
    return `Quick tip: in English we say "I agree" rather than "I am agree". Why do you think so?`;
  }

  // 3. Questions / Inquiries
  if (/\bhow are you\b/i.test(lowerText)) {
    return `I'm doing well, thank you for asking! How are your English studies going today?`;
  }
  if (/\b(what is your name|who are you)\b/i.test(lowerText)) {
    return `I am your AI English Tutor demo assistant. I'm here to help you practice English!`;
  }
  if (lowerText.endsWith('?') || /^(what|where|when|why|how|who|can|could|would|is|are|do|does|did)\b/i.test(lowerText)) {
    if (topic) {
      return `That is a thoughtful question about ${topic}. How would you answer it from your own perspective?`;
    }
    return `That is a great question! Explaining your thoughts in English is wonderful practice. What do you think?`;
  }

  // 4. Mode-specific & fallback responses
  if (mode === 'coach') {
    if (topic) {
      return `Good point regarding ${topic}! In coach mode, try expanding your idea with an example or reason. What else can you add?`;
    }
    return `Good point! In coach mode, try using complete sentences with descriptive words. Could you elaborate on that?`;
  }

  if (mode === 'intensive') {
    if (topic) {
      return `Understood. In intensive mode, challenge yourself: use a connective word like "furthermore" or "however" to discuss ${topic}.`;
    }
    return `Understood. In intensive mode, let's refine this: try expanding your answer with more specific vocabulary.`;
  }

  // Default 'natural' mode
  if (topic) {
    return `That sounds interesting! Speaking about ${topic} is great practice. Tell me more about your thoughts on that.`;
  }
  return `That sounds interesting! Could you tell me a little more about that?`;
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

    const replyContent = generateDeterministicReply(request);
    const response = createAIProviderResponse(replyContent, {
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
