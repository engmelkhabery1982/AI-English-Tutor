/**
 * src/onboarding/answer-commit.test.ts
 *
 * Tests for the diagnostic assessment's typed-answer commit controller
 * (Work Order 1, items 1, 2, 3, 4 and 9).
 *
 * The device bug this pins shut: the answer box was cleared as soon as the send
 * handler finished — even when the turn had FAILED — while "Continue" checks
 * COMMITTED evidence. The learner watched their answer disappear and was then
 * told to answer before continuing.
 *
 * Pinned behaviour
 * - the draft is cleared ONLY after the answer really committed;
 * - a failure keeps the EXACT typed text, shows one classified learner-safe
 *   sentence (never a raw provider payload) and offers Retry;
 * - the learner may edit before retrying, and Retry then sends what they see;
 * - a failed submission records NO evidence and counts NO committed turn;
 * - a repeated tap can never commit twice, and a retry verifies the commit state
 *   so an answer that really landed is never sent again;
 * - a preserved answer is never recorded against a different assessment step.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE,
  createAssessmentAnswerController,
  type AssessmentAnswerCommitResult,
  type AssessmentAnswerPurpose,
  type AssessmentAnswerStep,
} from './answer-commit';
import { PROVIDER_FAILURE_MESSAGES } from '../providers/failures';

interface Harness {
  readonly controller: ReturnType<typeof createAssessmentAnswerController>;
  readonly commits: { readonly answer: string; readonly purpose: AssessmentAnswerPurpose; readonly step: AssessmentAnswerStep }[];
  readonly committed: { readonly answer: string; readonly alreadyCommitted: boolean }[];
  readonly failures: string[];
  /** Queue the result of the next commit call. */
  respond(result: AssessmentAnswerCommitResult): void;
  /** Make the next commit throw (transport-level failure). */
  throwNext(message: string): void;
  setStep(step: AssessmentAnswerStep | null): void;
  setPurpose(purpose: AssessmentAnswerPurpose): void;
  setCommittedLearnerTurns(count: number): void;
}

function harness(options?: { readonly initialStep?: AssessmentAnswerStep | null }): Harness {
  const queue: AssessmentAnswerCommitResult[] = [];
  let nextThrow: string | null = null;
  let step: AssessmentAnswerStep | null =
    options && 'initialStep' in options
      ? (options.initialStep ?? null)
      : { stepId: 'speaking', stepToken: 1 };
  let purpose: AssessmentAnswerPurpose = 'speaking';
  let committedLearnerTurns = 0;
  const commits: Harness['commits'] = [];
  const committed: Harness['committed'] = [];
  const failures: string[] = [];

  const controller = createAssessmentAnswerController({
    captureStep: () => step,
    currentPurpose: () => purpose,
    observeCommittedLearnerTurns: () => committedLearnerTurns,
    commit: async (input) => {
      commits.push(input);
      if (nextThrow !== null) {
        const message = nextThrow;
        nextThrow = null;
        throw new Error(message);
      }
      return queue.shift() ?? { ok: true };
    },
    onCommitted: (info) => {
      committedLearnerTurns += 1;
      committed.push({ answer: info.answer, alreadyCommitted: info.alreadyCommitted });
    },
    onFailure: (info) => {
      failures.push(info.failure.technical ?? info.failure.message);
    },
  });

  return {
    controller,
    commits,
    committed,
    failures,
    respond: (result) => {
      queue.push(result);
    },
    throwNext: (message) => {
      nextThrow = message;
    },
    setStep: (next) => {
      step = next;
    },
    setPurpose: (next) => {
      purpose = next;
    },
    setCommittedLearnerTurns: (count) => {
      committedLearnerTurns = count;
    },
  };
}

describe('assessment typed answer — the draft survives a failure', () => {
  it('keeps the exact typed answer when the turn fails', async () => {
    const stub = harness();
    stub.respond({
      ok: false,
      errorMessage: 'Gemini request failed with status 429: {"error":{"code":429,"message":"quota"}}',
    });
    stub.controller.setDraft('  I usually wake up at seven and check my messages.  ');

    const state = await stub.controller.submit();

    expect(state.phase).toBe('failed');
    // The learner's text is untouched — including the spacing they typed.
    expect(state.draft).toBe('  I usually wake up at seven and check my messages.  ');
    expect(state.preservedAnswer).toBe('I usually wake up at seven and check my messages.');
    expect(state.retryAvailable).toBe(true);
    expect(state.committedAnswers).toBe(0);
    // One classified, learner-safe sentence; the raw payload stays diagnostic.
    expect(state.learnerMessage).toBe(PROVIDER_FAILURE_MESSAGES.rate_limited.assessment);
    expect(state.learnerMessage).not.toContain('429');
    expect(state.learnerMessage).not.toContain('{');
    expect(state.technicalDetail).toContain('429');
    expect(state.failure?.kind).toBe('rate_limited');
    expect(stub.failures).toHaveLength(1);
  });

  it('records no evidence and counts no committed turn for a failed answer', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Request timed out after 20000ms' });
    stub.controller.setDraft('My favourite part of the day is the evening walk.');

    await stub.controller.submit();

    expect(stub.committed).toEqual([]);
    expect(stub.controller.getState().committedAnswers).toBe(0);
  });

  it('clears the draft only after the answer really committed', async () => {
    const stub = harness();
    stub.respond({ ok: true });
    stub.controller.setDraft('I work as a nurse in Dammam.');

    const state = await stub.controller.submit();

    expect(state.phase).toBe('idle');
    expect(state.draft).toBe('');
    expect(state.committedAnswers).toBe(1);
    expect(state.preservedAnswer).toBeNull();
    expect(state.retryAvailable).toBe(false);
    expect(state.learnerMessage).toBeNull();
    expect(stub.committed).toEqual([{ answer: 'I work as a nurse in Dammam.', alreadyCommitted: false }]);
    expect(stub.commits).toHaveLength(1);
  });

  it('never commits an empty answer', async () => {
    const stub = harness();
    stub.controller.setDraft('   ');

    const state = await stub.controller.submit();

    expect(stub.commits).toEqual([]);
    expect(state.phase).toBe('idle');
  });

  it('keeps the answer and reports honestly when the assessment is not running', async () => {
    const stub = harness({ initialStep: null });
    stub.controller.setDraft('I would like to practise interviews.');

    const state = await stub.controller.submit();

    expect(stub.commits).toEqual([]);
    expect(state.phase).toBe('failed');
    expect(state.draft).toBe('I would like to practise interviews.');
    expect(state.learnerMessage).toContain('not running');
    expect(state.learnerMessage).toContain('Nothing was recorded');
  });
});

describe('assessment typed answer — Retry is explicit and never duplicates', () => {
  it('resends the SAME preserved answer on Retry and clears it on success', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Network request failed' });
    stub.respond({ ok: true });
    stub.controller.setDraft('I often travel to Riyadh for work.');

    await stub.controller.submit();
    const retried = await stub.controller.retry();

    expect(stub.commits.map((entry) => entry.answer)).toEqual([
      'I often travel to Riyadh for work.',
      'I often travel to Riyadh for work.',
    ]);
    expect(retried.phase).toBe('idle');
    expect(retried.draft).toBe('');
    expect(retried.committedAnswers).toBe(1);
    expect(stub.committed).toHaveLength(1);
  });

  it('sends the edited text when the learner changes the answer before retrying', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Request timed out' });
    stub.respond({ ok: true });
    stub.controller.setDraft('I go to gym.');
    await stub.controller.submit();

    stub.controller.setDraft('I go to the gym three times a week.');
    const state = await stub.controller.retry();

    expect(stub.commits.map((entry) => entry.answer)).toEqual([
      'I go to gym.',
      'I go to the gym three times a week.',
    ]);
    expect(state.draft).toBe('');
    expect(state.committedAnswers).toBe(1);
  });

  it('refuses a Retry while the answer box is empty', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Network request failed' });
    stub.controller.setDraft('Something went wrong once.');
    await stub.controller.submit();

    stub.controller.setDraft('');
    expect(stub.controller.getState().retryAvailable).toBe(false);

    const state = await stub.controller.retry();
    expect(stub.commits).toHaveLength(1);
    expect(state.phase).toBe('failed');
  });

  it('commits at most once when the learner taps Send twice quickly', async () => {
    let release: (value: AssessmentAnswerCommitResult) => void = () => undefined;
    const gate = new Promise<AssessmentAnswerCommitResult>((resolve) => {
      release = resolve;
    });
    const controller = createAssessmentAnswerController({
      captureStep: () => ({ stepId: 'speaking', stepToken: 1 }),
      currentPurpose: () => 'speaking',
      observeCommittedLearnerTurns: () => 0,
      commit: () => gate,
    });
    controller.setDraft('I am learning English for my job.');

    const first = controller.submit();
    const second = controller.submit();
    const third = controller.retry();

    // The second and third taps return the SAME in-flight state: no extra commit.
    expect((await second).phase).toBe('submitting');
    expect((await third).phase).toBe('submitting');
    release({ ok: true });
    const settled = await first;

    expect(settled.phase).toBe('idle');
    expect(settled.committedAnswers).toBe(1);
  });

  it('treats an answer that really committed as committed, even if the call reported failure', async () => {
    // The turn committed but the service reported a failure (uncertain outcome):
    // the commit-state observer proves the learner turn really landed.
    let committedLearnerTurns = 0;
    const commits: string[] = [];
    const controller = createAssessmentAnswerController({
      captureStep: () => ({ stepId: 'speaking', stepToken: 1 }),
      currentPurpose: () => 'speaking',
      observeCommittedLearnerTurns: () => committedLearnerTurns,
      commit: async (input) => {
        commits.push(input.answer);
        committedLearnerTurns += 1;
        return { ok: false, errorMessage: 'Service unavailable, try again later' };
      },
      onCommitted: () => undefined,
    });
    controller.setDraft('I prefer reading the news in English.');

    const state = await controller.submit();

    expect(commits).toEqual(['I prefer reading the news in English.']);
    expect(state.phase).toBe('idle');
    expect(state.draft).toBe('');
    expect(state.committedAnswers).toBe(1);
    expect(state.learnerMessage).toBeNull();
    expect(state.retryAvailable).toBe(false);

    // Nothing preserved → a Retry cannot duplicate the committed answer.
    const retried = await controller.retry();
    expect(commits).toEqual(['I prefer reading the news in English.']);
    expect(retried.phase).toBe('idle');
  });

  it('does not resend a preserved answer whose turn committed after the failure', async () => {
    let committedLearnerTurns = 0;
    const commits: string[] = [];
    const controller = createAssessmentAnswerController({
      captureStep: () => ({ stepId: 'speaking', stepToken: 1 }),
      currentPurpose: () => 'speaking',
      observeCommittedLearnerTurns: () => committedLearnerTurns,
      commit: async (input) => {
        commits.push(input.answer);
        // The first call reports failure, but the turn really committed.
        committedLearnerTurns += 1;
        return { ok: false, errorMessage: 'Network request failed' };
      },
    });
    controller.setDraft('I usually study after work.');

    const first = await controller.submit();
    // The commit-state check already resolved it as committed…
    expect(first.phase).toBe('idle');
    expect(commits).toEqual(['I usually study after work.']);

    // …so a Retry has nothing preserved to resend.
    const second = await controller.retry();
    expect(commits).toEqual(['I usually study after work.']);
    expect(second.phase).toBe('idle');
  });
});

describe('assessment typed answer — step identity is respected', () => {
  it('never records a preserved answer against a different step', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Request timed out' });
    stub.controller.setDraft('I visited the corniche yesterday evening.');
    await stub.controller.submit();

    // The assessment moved on while the answer was preserved.
    stub.setStep({ stepId: 'language_use', stepToken: 2 });
    stub.setPurpose('language_use');
    const state = await stub.controller.retry();

    // No second commit was attempted for the stale step.
    expect(stub.commits).toHaveLength(1);
    expect(state.phase).toBe('failed');
    expect(state.learnerMessage).toBe(ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE);
    expect(state.retryAvailable).toBe(false);
    // The learner's own words are still not destroyed.
    expect(state.draft).toBe('I visited the corniche yesterday evening.');
  });

  it('captures the step identity at submission start', async () => {
    const stub = harness({ initialStep: { stepId: 'language_use', stepToken: 7 } });
    stub.setPurpose('language_use');
    stub.respond({ ok: true });
    stub.controller.setDraft('She has been working here since 2019.');

    await stub.controller.submit();

    expect(stub.commits).toEqual([
      {
        answer: 'She has been working here since 2019.',
        purpose: 'language_use',
        step: { stepId: 'language_use', stepToken: 7 },
      },
    ]);
  });
});

describe('assessment typed answer — view state helpers', () => {
  it('publishes state changes to subscribers', async () => {
    const stub = harness();
    const seen: string[] = [];
    const unsubscribe = stub.controller.subscribe((state) => {
      seen.push(state.phase);
    });
    stub.respond({ ok: true });
    stub.controller.setDraft('I can describe my daily routine.');
    await stub.controller.submit();
    unsubscribe();

    expect(seen[0]).toBe('idle');
    expect(seen).toContain('submitting');
    expect(seen[seen.length - 1]).toBe('idle');
  });

  it('dismisses the notice without touching the preserved answer', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Network request failed' });
    stub.controller.setDraft('I want to speak more confidently.');
    await stub.controller.submit();

    stub.controller.dismissMessage();
    const state = stub.controller.getState();

    expect(state.learnerMessage).toBeNull();
    expect(state.draft).toBe('I want to speak more confidently.');
    expect(state.phase).toBe('failed');
    expect(state.retryAvailable).toBe(true);
  });

  it('keeps the draft on reset unless the caller explicitly clears it', async () => {
    const stub = harness();
    stub.respond({ ok: false, errorMessage: 'Request timed out' });
    stub.controller.setDraft('My brother lives in Khobar.');
    await stub.controller.submit();

    stub.controller.reset();
    expect(stub.controller.getState().draft).toBe('My brother lives in Khobar.');
    expect(stub.controller.getState().phase).toBe('idle');
    expect(stub.controller.getState().learnerMessage).toBeNull();

    stub.controller.reset({ clearDraft: true });
    expect(stub.controller.getState().draft).toBe('');
  });

  it('reports a thrown transport failure as a classified, recoverable failure', async () => {
    const stub = harness();
    stub.throwNext('socket hang up');
    stub.controller.setDraft('I would like more speaking practice.');

    const state = await stub.controller.submit();

    expect(state.phase).toBe('failed');
    expect(state.draft).toBe('I would like more speaking practice.');
    expect(state.learnerMessage).toBe(PROVIDER_FAILURE_MESSAGES.network.assessment);
    expect(state.technicalDetail).toContain('socket hang up');
    expect(state.retryAvailable).toBe(true);
  });

  it('calls commit exactly once per submitted answer (no hidden duplicate work)', async () => {
    const stub = harness();
    const commit = vi.fn(async () => ({ ok: true }) as AssessmentAnswerCommitResult);
    const controller = createAssessmentAnswerController({
      captureStep: () => ({ stepId: 'speaking', stepToken: 3 }),
      currentPurpose: () => 'speaking',
      observeCommittedLearnerTurns: () => 0,
      commit,
    });
    controller.setDraft('I read one page every night.');
    await controller.submit();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(stub.commits).toEqual([]);
  });
});
