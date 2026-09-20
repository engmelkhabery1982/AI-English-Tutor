/** Read-aloud orchestration over the WO1-protected voice controller and existing
 * transcript-comparison pronunciation provider. Not an acoustic scoring engine. */
import { ReviewVoiceController } from '../review/voice-controller';
import { createTranscriptComparisonPronunciationProvider, normalizeForComparison } from '../pronunciation/baseline-provider';
import { learnerMessageForFailure } from '../providers/failures';
import type { AudioRecorderService } from '../voice/types';
import type { SpeechToTextProvider } from '../providers/stt/types';
import type { ProgressRepository } from '../repositories';
import { recordPracticeActivity } from './activity';
import { generateId } from '../shared/id';

export interface ReadAloudFeedback {
  readonly transcript: string;
  readonly target: string;
  readonly outcome: 'matches_transcript' | 'transcript_differs';
  readonly lines: readonly string[];
  readonly evidence: 'transcript_comparison';
  readonly limitation: string;
}
export const READ_ALOUD_LIMITATION = 'This compares speech-recognition text only. Recognition can be wrong; this is not an acoustic pronunciation score.';
export class ReadAloudPractice {
  readonly voice: ReviewVoiceController;
  private generation = 0;
  private disposed = false;
  private busy = false;
  private attemptId = generateId();
  feedback: ReadAloudFeedback | null = null;
  error: string | null = null;
  constructor(readonly target: string, private readonly learnerId: string, private readonly contentId: string,
    recorder: AudioRecorderService, stt: SpeechToTextProvider, private readonly progress: ProgressRepository, unavailable = false) {
    this.voice = new ReviewVoiceController(recorder, stt, { unavailable });
  }
  async toggleRecording() {
    if (this.disposed || this.busy) return;
    if (!this.voice.isRecording && !this.voice.isBusy) { this.feedback = null; this.error = null; this.voice.clearAnswer(); this.attemptId = generateId(); }
    const gen = this.generation;
    const state = await this.voice.toggleRecording();
    if (this.disposed || gen !== this.generation) return;
    this.error = state.error ? learnerMessageForFailure(state.error, 'speech') : null;
  }
  async compare(): Promise<ReadAloudFeedback | null> {
    if (this.disposed || this.busy || this.voice.isBusy || this.voice.isRecording || !this.voice.userAnswer.trim()) return null;
    const gen = this.generation, transcript = this.voice.userAnswer;
    this.busy = true;
    try {
      const analysis = await createTranscriptComparisonPronunciationProvider().analyze({ learnerId: this.learnerId, transcript, expectedText: this.target });
      if (this.disposed || gen !== this.generation) return null;
      const matches = normalizeForComparison(transcript) === normalizeForComparison(this.target);
      const feedback: ReadAloudFeedback = {
        transcript, target: this.target, outcome: matches ? 'matches_transcript' : 'transcript_differs', evidence: 'transcript_comparison', limitation: READ_ALOUD_LIMITATION,
        lines: matches ? ['The recognized words match the target. This does not establish pronunciation quality.'] : [
          'The transcript differs from the target. Compare the two texts and try again slowly.',
          ...analysis.observations.map(o => o.observed ? `Possible substitution: expected “${o.target}”, recognized “${o.observed}”.` : `Not recognized in the transcript: “${o.target}”. It may be omitted or misrecognized.`),
          ...(analysis.observations.length === 0 ? ['The words may be in a different order.'] : []),
        ],
      };
      await recordPracticeActivity(this.progress, this.learnerId, { version: 1, eventId: this.attemptId, sessionId: this.attemptId, kind: 'read_aloud', action: 'transcript_comparison', at: new Date().toISOString(), contentId: this.contentId, answer: transcript, target: this.target, outcome: feedback.outcome });
      if (this.disposed || gen !== this.generation) return null;
      this.feedback = feedback; this.error = null; return feedback;
    } catch { if (!this.disposed && gen === this.generation) this.error = 'Could not save the comparison. Your transcript is kept; retry Compare.'; return null; }
    finally { this.busy = false; }
  }
  reset() { ++this.generation; this.voice.reset(); this.feedback = null; this.error = null; this.attemptId = generateId(); }
  dispose() { this.disposed = true; ++this.generation; this.voice.dispose(); }
}
