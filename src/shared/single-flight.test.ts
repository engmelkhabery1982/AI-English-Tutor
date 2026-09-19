/**
 * src/shared/single-flight.test.ts
 *
 * The composition cache every feature default factory is built on.
 *
 * Without a lifecycle token it is the plain "shared in-flight attempt + cached
 * success + retryable failure" slot. WITH a token (the canonical application
 * database lifecycle) a cached success must never outlive the connection it
 * was composed on, while concurrent callers inside the SAME lifecycle still
 * share exactly one composition.
 */

import { describe, expect, it } from 'vitest';

import { createRecoverableSingleFlight } from './single-flight';

describe('createRecoverableSingleFlight (no lifecycle token)', () => {
  it('shares one in-flight composition and reuses the successful one', async () => {
    let compositions = 0;
    const flight = createRecoverableSingleFlight(async () => {
      compositions += 1;
      return { value: compositions };
    });

    const [a, b] = await Promise.all([flight(), flight()]);
    expect(a).toBe(b);
    expect(compositions).toBe(1);

    const cached = await flight();
    expect(cached).toBe(a);
    expect(compositions).toBe(1);
  });

  it('does not cache a failed composition and retries on the next request', async () => {
    let attempts = 0;
    const flight = createRecoverableSingleFlight(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('bootstrap failed');
      return `attempt ${attempts}`;
    });

    await expect(flight()).rejects.toThrow('bootstrap failed');
    expect(await flight()).toBe('attempt 2');
    expect(await flight()).toBe('attempt 2');
    expect(attempts).toBe(2);
  });
});

describe('createRecoverableSingleFlight (lifecycle token)', () => {
  it('caches a success for ONE lifecycle and recomposes when the token changes', async () => {
    let token: unknown = { lifecycle: 1 };
    let compositions = 0;
    const flight = createRecoverableSingleFlight(
      async () => {
        compositions += 1;
        return `composition ${compositions}`;
      },
      { lifecycleToken: () => token },
    );

    const first = await flight();
    expect(first).toBe('composition 1');
    expect(await flight()).toBe(first); // same lifecycle: reused
    expect(compositions).toBe(1);

    token = { lifecycle: 2 }; // the database was closed and reopened
    const second = await flight();
    expect(second).toBe('composition 2');
    expect(second).not.toBe(first);
    expect(await flight()).toBe(second); // cached again for the NEW lifecycle
    expect(compositions).toBe(2);
  });

  it('shares one composition among concurrent callers of the SAME lifecycle', async () => {
    const token = { lifecycle: 1 };
    let compositions = 0;
    const flight = createRecoverableSingleFlight(
      async () => {
        compositions += 1;
        return { id: compositions };
      },
      { lifecycleToken: () => token },
    );

    const [a, b, c] = await Promise.all([flight(), flight(), flight()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(compositions).toBe(1);
  });

  it('never caches a composition that finished AFTER the lifecycle changed', async () => {
    let token: unknown = { lifecycle: 1 };
    const pending: ((value: string) => void)[] = [];
    let compositions = 0;
    const flight = createRecoverableSingleFlight(
      () =>
        new Promise<string>((resolve) => {
          compositions += 1;
          pending.push(resolve);
        }),
      { lifecycleToken: () => token },
    );

    const stale = flight();
    token = { lifecycle: 2 }; // closed while the composition was still running
    pending[0]('stale value');
    expect(await stale).toBe('stale value');
    await Promise.resolve();

    // The value built across the close is NOT handed out again: the next
    // request composes fresh for the new lifecycle.
    const fresh = flight();
    expect(compositions).toBe(2);
    pending[1]('fresh value');
    expect(await fresh).toBe('fresh value');
    expect(await flight()).toBe('fresh value');
    expect(compositions).toBe(2);
  });

  it('does not adopt an in-flight composition started before a lifecycle change', async () => {
    let token: unknown = { lifecycle: 1 };
    const pending: ((value: string) => void)[] = [];
    let compositions = 0;
    const flight = createRecoverableSingleFlight(
      () =>
        new Promise<string>((resolve) => {
          compositions += 1;
          pending.push(resolve);
        }),
      { lifecycleToken: () => token },
    );

    const inFlight = flight();
    token = { lifecycle: 2 };
    // A caller arriving after the change must not receive the old attempt.
    const afterChange = flight();
    expect(afterChange).not.toBe(inFlight);
    expect(compositions).toBe(2);

    pending[0]('lifecycle 1 value');
    pending[1]('lifecycle 2 value');
    expect(await inFlight).toBe('lifecycle 1 value');
    expect(await afterChange).toBe('lifecycle 2 value');
  });

  it('still retries a failed composition within the same lifecycle', async () => {
    const token = { lifecycle: 1 };
    let attempts = 0;
    const flight = createRecoverableSingleFlight(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('composition failed');
        return 'ready';
      },
      { lifecycleToken: () => token },
    );

    await expect(flight()).rejects.toThrow('composition failed');
    expect(await flight()).toBe('ready');
    expect(await flight()).toBe('ready');
    expect(attempts).toBe(2);
  });
});
