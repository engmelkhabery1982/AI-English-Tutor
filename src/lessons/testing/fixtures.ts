import { vi } from 'vitest';
import type { AIProvider } from '../../providers/ai/types';
import type { AudioRecorderService } from '../../voice/types';
import type { TextToSpeechProvider } from '../../providers/tts/types';
import type { ProgressRepository } from '../../repositories';
export const inspectionPayload = {
  meanings: [{ id: 'sense-1', meaning: 'Begin a friendly conversation', translation: 'بدء محادثة ودية', usage: 'At the start of meeting new people', register: 'neutral', examples: ['A joke can break the ice at a meeting.', 'We played a game to break the ice at the party.'] }],
  contextualMeaning: 'Here it means helping people feel comfortable at a meeting.', contextualSenseId: 'sense-1', translation: 'كسر حاجز الصمت', rephrase: 'Start a friendly conversation', alternatives: ['Get people talking'],
};
export function providerWith(value: unknown): AIProvider {
  return { id: 'test-provider', generate: vi.fn(async () => ({ ok: true as const, response: { content: JSON.stringify(value) } })) };
}
export function failingProvider(code: 'rate_limit' | 'unavailable' | 'authentication' | 'unknown' = 'rate_limit'): AIProvider {
  return { id: 'test-provider', generate: vi.fn(async () => ({ ok: false as const, error: { code, message: 'HTTP 429 {secret:123}', retryable: true } })) };
}
export function progressMemory(): ProgressRepository {
  return { record: vi.fn(async record => ({ ...record, id: 'progress' })), list: vi.fn(async () => []), latest: vi.fn(async () => null) };
}
export function recorder(): AudioRecorderService {
  return { hasPermissions: vi.fn(async () => true), requestPermissions: vi.fn(async () => true), startRecording: vi.fn(async () => {}), stopRecording: vi.fn(async () => ({ uri: 'file:///test.m4a', durationMs: 1200, mimeType: 'audio/m4a' })), isRecording: vi.fn(() => false), getElapsedSeconds: vi.fn(() => 0) };
}
export function audio(): TextToSpeechProvider {
  return { id: 'test-audio', supportsSpeechRate: true, speak: vi.fn(async (_text, options) => { options?.onStart?.(); options?.onDone?.(); }), stop: vi.fn(async () => {}), isSpeaking: vi.fn(async () => false) };
}
