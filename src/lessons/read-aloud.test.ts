import { describe, expect, it, vi } from 'vitest';
import { ReadAloudPractice } from './read-aloud';
import { progressMemory, recorder } from './testing/fixtures';
import type { STTResult } from '../providers/stt/types';
function fixture(transcript = 'She walked to the garden') {
  const record = recorder(), progress = progressMemory();
  const stt = { id: 'real-stt-test', transcribe: vi.fn(async (): Promise<STTResult> => ({ ok: true, transcript })) };
  const practice = new ReadAloudPractice('She walked to the garden', 'learner', 'passage', record, stt, progress);
  return { practice, record, stt, progress };
}
describe('read aloud over the existing voice stack', () => {
  it('records, transcribes and compares only after explicit submission; no acoustic scores', async () => {
    const { practice, record, stt, progress } = fixture();
    await practice.toggleRecording(); expect(record.startRecording).toHaveBeenCalledOnce();
    await practice.toggleRecording(); expect(stt.transcribe).toHaveBeenCalledOnce();
    expect(progress.record).not.toHaveBeenCalled();
    expect(await practice.compare()).toMatchObject({ outcome: 'matches_transcript', evidence: 'transcript_comparison' });
    expect(practice.feedback?.limitation).toContain('not an acoustic');
    expect(practice.feedback).not.toHaveProperty('score');
    expect(progress.record).toHaveBeenCalledOnce();
    practice.dispose();
  });
  it('reports omissions/substitutions as possible transcription mismatches and permits retry', async () => {
    const { practice } = fixture('She walk garden');
    await practice.toggleRecording(); await practice.toggleRecording();
    const feedback = await practice.compare();
    expect(feedback?.outcome).toBe('transcript_differs');
    expect(feedback?.lines.join(' ')).toMatch(/substitution|Not recognized/);
    expect(feedback?.lines.join(' ')).not.toMatch(/\d+%|CEFR|improved/i);
    practice.reset(); expect(practice.voice.userAnswer).toBe(''); expect(practice.feedback).toBeNull();
    await practice.toggleRecording(); expect(practice.voice.isRecording).toBe(true); practice.dispose();
  });
  it('provider failure never records or fabricates a transcript; retry can succeed', async () => {
    const { practice, stt, progress } = fixture();
    stt.transcribe.mockResolvedValueOnce({ ok: false, error: 'HTTP 429 {quota}' });
    await practice.toggleRecording(); await practice.toggleRecording();
    expect(practice.error).not.toMatch(/HTTP|quota|429/);
    expect(practice.voice.userAnswer).toBe('');
    expect(await practice.compare()).toBeNull(); expect(progress.record).not.toHaveBeenCalled();
    await practice.toggleRecording(); await practice.toggleRecording(); expect(await practice.compare()).not.toBeNull(); practice.dispose();
  });
  it('a failed persistence retains the transcript for explicit retry', async () => {
    const { practice, progress } = fixture();
    vi.mocked(progress.record).mockRejectedValueOnce(Error('disk failure'));
    await practice.toggleRecording(); await practice.toggleRecording();
    expect(await practice.compare()).toBeNull(); expect(practice.voice.userAnswer).toBe('She walked to the garden');
    expect(await practice.compare()).not.toBeNull(); practice.dispose();
  });
  it.each(['reset','dispose'] as const)('%s invalidates late STT and prevents evidence', async action => {
    const { practice, stt, progress } = fixture();
    let resolve!: (v: STTResult) => void;
    stt.transcribe.mockImplementation(() => new Promise(r => { resolve = r; }));
    await practice.toggleRecording();
    const pending = practice.toggleRecording();
    await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalledOnce());
    practice[action](); resolve({ ok: true, transcript: 'late transcript' }); await pending;
    expect(practice.voice.userAnswer).toBe(''); expect(await practice.compare()).toBeNull(); expect(progress.record).not.toHaveBeenCalled(); practice.dispose();
  });
  it('blocks double microphone operations and unavailable providers', async () => {
    const { practice, record, stt, progress } = fixture();
    await Promise.all([practice.toggleRecording(), practice.toggleRecording()]);
    expect(record.startRecording).toHaveBeenCalledOnce(); practice.dispose();
    const unavailable = new ReadAloudPractice('target', 'learner', 'content', recorder(), stt, progress, true);
    await unavailable.toggleRecording(); expect(stt.transcribe).not.toHaveBeenCalled(); unavailable.dispose();
  });
});
