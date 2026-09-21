/**
 * src/voice/mic-intent.test.ts
 *
 * Regression tests for the session-transition / mic race (Package 1, A):
 * a mic tap during an active transition queues exactly ONE intent, only the
 * transition it was queued for may execute it, and a newer transition drops
 * it instead of running it against a session the learner moved past.
 */

import { describe, expect, it } from 'vitest';
import { MicIntentQueue, createMicIntentQueue } from './mic-intent';

describe('MicIntentQueue — one queued mic intent per transition', () => {
  it('consumes the intent exactly once for the transition that owns it', () => {
    const queue = createMicIntentQueue();
    queue.queue(7);
    expect(queue.pending).toBe(true);
    expect(queue.consume(7)).toBe(true);
    expect(queue.pending).toBe(false);
    // A second settlement of the same token cannot execute it twice.
    expect(queue.consume(7)).toBe(false);
  });

  it('repeated taps during one transition never queue more than one execution', () => {
    const queue = new MicIntentQueue();
    queue.queue(3);
    queue.queue(3);
    queue.queue(3);
    expect(queue.consume(3)).toBe(true);
    expect(queue.consume(3)).toBe(false);
  });

  it('a stale/superseded transition can never consume the intent', () => {
    const queue = createMicIntentQueue();
    // The tap arrived during transition 4; transition 3 settling late must not
    // execute it (it would act on the outgoing session).
    queue.queue(4);
    expect(queue.consume(3)).toBe(false);
    expect(queue.pending).toBe(true);
    // The owning transition still executes it.
    expect(queue.consume(4)).toBe(true);
  });

  it('a newer transition clears a pending intent (session replacement)', () => {
    const queue = createMicIntentQueue();
    queue.queue(1);
    // A newer session replacement starts: the older intent belonged to the
    // replaced transition and must never start a recording afterwards.
    queue.clear();
    expect(queue.pending).toBe(false);
    expect(queue.consume(1)).toBe(false);
  });

  it('nothing pending means nothing to consume', () => {
    const queue = createMicIntentQueue();
    expect(queue.pending).toBe(false);
    expect(queue.consume(0)).toBe(false);
    expect(queue.consume(1)).toBe(false);
  });
});
