import type { TextToSpeechProvider } from '../providers/tts/types';
import { TTSController } from '../voice/tts-controller';
import { learnerMessageForFailure } from '../providers/failures';
import { evaluateChoice } from '../listening/evaluator';
import type { ProgressRepository } from '../repositories';
import type { SaveToReviewService } from '../learner-agency';
import type { InspectionInput } from '../dictionary/inspector';
import { generateId } from '../shared/id';
import { recordPracticeActivity } from './activity';
import type { LessonAnswer, LessonMode, LessonSessionSnapshot, StoryLesson } from './types';

export class StoryLessonSession {
  readonly id = generateId();
  private readonly tts: TTSController;
  private state: LessonSessionSnapshot;
  private disposed = false;
  private generation = 0;
  private submitting = false;
  constructor(readonly lesson: StoryLesson, readonly mode: LessonMode, private readonly learnerId: string,
    private readonly progress: ProgressRepository, private readonly saveService: SaveToReviewService,
    private readonly audio: TextToSpeechProvider, private readonly changed: () => void = () => {}) {
    this.tts = new TTSController(audio);
    this.state = { lesson, mode, transcriptVisible: mode === 'reading', languageVisible: false, assistance: { revealed: false, plays: 0, slowed: false }, playback: 'idle', answers: [], pendingAnswer: null, completed: false, error: null };
  }
  snapshot(): LessonSessionSnapshot { return this.state; }
  get supportsSlower(): boolean { return this.audio.supportsSpeechRate === true; }
  private update(patch: Partial<LessonSessionSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.changed();
  }
  reveal(visible: boolean) {
    this.update({ transcriptVisible: visible, assistance: { ...this.state.assistance, revealed: this.state.assistance.revealed || visible } });
  }
  revealLanguage(visible: boolean) {
    this.update({ languageVisible: visible, assistance: { ...this.state.assistance, revealed: this.state.assistance.revealed || visible } });
  }
  async play(slow = false) {
    if (this.disposed) return;
    if (slow && !this.supportsSlower) { this.update({ error: 'Slower playback is not supported by this voice.' }); return; }
    this.tts.invalidate();
    const gen = ++this.generation;
    await this.tts.speak(this.lesson.passage, { rate: slow ? 0.75 : 1,
      onStart: () => { if (this.disposed || gen !== this.generation) return;
        this.update({ playback: 'playing', error: null, assistance: { ...this.state.assistance, plays: this.state.assistance.plays + 1, slowed: this.state.assistance.slowed || slow } });
        void this.expose().catch(() => { if (gen === this.generation) this.update({ error: 'Playback started, but activity could not be saved. Try again.' }); });
      },
      onDone: () => { if (gen === this.generation) this.update({ playback: 'idle' }); },
      onError: error => { if (gen === this.generation) this.update({ playback: 'error', error: learnerMessageForFailure(error.message) }); },
    });
    if (gen === this.generation && this.state.playback === 'playing') this.update({ playback: 'idle' });
  }
  /** Explicit read interaction or actual audio start; exposure is NOT comprehension. */
  async expose() {
    if (this.disposed || (this.mode === 'listening' && this.state.assistance.plays === 0)) return;
    await recordPracticeActivity(this.progress, this.learnerId, { version: 1, eventId: `${this.id}:exposure`, sessionId: this.id, kind: this.mode, action: 'exposure', contentId: this.lesson.id, at: new Date().toISOString() });
  }
  async answer(questionId: string, answer: string): Promise<LessonAnswer | null> {
    if (this.disposed || this.submitting || this.state.answers.some(a => a.questionId === questionId)) return null;
    if (this.mode === 'listening' && this.state.assistance.plays === 0) { this.update({ error: 'Play the passage before answering a listening question.' }); return null; }
    const question = this.lesson.questions.find(q => q.id === questionId);
    if (!question || !question.options.includes(answer)) return null; // skipped/blank/unknown choices are not evidence
    if (this.state.pendingAnswer && (this.state.pendingAnswer.questionId !== questionId || this.state.pendingAnswer.answer !== answer)) {
      this.update({ error: 'Retry the pending choice before answering another question. Its save status is uncertain.' }); return null;
    }
    const assisted = this.state.answers.length > 0 || this.state.assistance.revealed || this.state.assistance.plays > 1 || this.state.assistance.slowed;
    const rawEvaluation = evaluateChoice({ id: question.id, learnerId: this.learnerId, type: 'listen_and_choose', difficulty: 'medium', speakText: this.lesson.passage, expectedAnswer: question.answer, keyItems: [], source: 'general', explanation: question.explanation }, answer);
    // Do not implicitly reveal the entire listening transcript via evaluator feedback.
    const evaluation = { ...rawEvaluation, feedbackLines: [rawEvaluation.feedbackLines[0], question.explanation] };
    const result = { questionId, answer, evaluation, assisted };
    this.submitting = true;
    this.update({ pendingAnswer: { questionId, answer } });
    try {
      await recordPracticeActivity(this.progress, this.learnerId, { version: 1, eventId: `${this.id}:${questionId}`, sessionId: this.id, kind: this.mode, action: 'answer', at: new Date().toISOString(), contentId: this.lesson.id, assisted, answer, target: question.answer, outcome: evaluation.result });
      if (this.disposed) return null;
      this.update({ answers: [...this.state.answers, result], pendingAnswer: null, error: null });
      return result;
    } catch { this.update({ error: 'Your answer is kept. Could not save it — select the answer again to retry.' }); return null; }
    finally { this.submitting = false; }
  }
  async complete(): Promise<boolean> {
    if (this.disposed || this.state.answers.length !== this.lesson.questions.length) return false;
    try {
      await recordPracticeActivity(this.progress, this.learnerId, { version: 1, eventId: `${this.id}:complete`, sessionId: this.id, kind: this.mode, action: 'complete', at: new Date().toISOString(), contentId: this.lesson.id });
      this.update({ completed: true, error: null }); return !this.disposed;
    } catch { this.update({ error: 'Could not save completion. Retry completion; your answers are kept.' }); return false; }
  }
  inspection(selectedText: string, targetLanguage: string): InspectionInput {
    this.update({ assistance: { ...this.state.assistance, revealed: true } });
    const known = this.lesson.language.find(l => l.text === selectedText);
    return { originalText: this.lesson.passage, selectedText, itemType: known?.itemType === 'common_expression' ? 'expression' : known && ['word','phrase','idiom','collocation','sentence'].includes(known.itemType) ? known.itemType as InspectionInput['itemType'] : 'phrase', context: known?.context ?? this.lesson.passage, targetLanguage, sourceRef: this.lesson.id, contextSource: this.lesson.provenance.kind };
  }
  saveLanguage(index: number) {
    const item = this.lesson.language[index];
    if (!item) throw new Error('Choose a language item.');
    return this.saveService.save({ learnerId: this.learnerId, text: item.text, itemType: item.itemType, originalText: this.lesson.passage, contextSentence: item.context, contextSource: this.lesson.provenance.kind, selectedMeaning: item.meaning,
      origin: this.mode, originRef: this.lesson.id, meaningIsGenerated: this.lesson.provenance.kind === 'ai-generated', generatedBy: this.lesson.provenance.providerId });
  }
  stop() { ++this.generation; this.tts.invalidate(); this.update({ playback: 'idle' }); }
  dispose() { this.disposed = true; ++this.generation; void this.tts.dispose(); }
}
