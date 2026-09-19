/**
 * src/provider-config/secure-store.test.ts
 *
 * Release regression guard: Android startup crash
 *
 *   Error: Requiring unknown module "expo-secure-store"
 *
 * ROOT CAUSE: Metro registers bundle dependencies ONLY from literal
 * `require('<module>')` calls its static analysis can see. The previous
 * implementation routed `require` through an aliased variable and invoked
 * the alias, so Metro never registered `expo-secure-store` in the release
 * bundle and the app crashed on startup at the first credential lookup.
 *
 * These tests pin the static source pattern (so the indirection cannot be
 * reintroduced by a "cleanup") and the honest runtime semantics that must
 * survive any future change to the loader:
 * - no native runtime (Node/vitest)  → loader returns null, read reports
 *   `unavailable` — never a fabricated save, never a silent memory fallback.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExpoSecureKeyStore, loadExpoSecureStore } from './secure-store';

const SOURCE = readFileSync(join(__dirname, 'secure-store.ts'), 'utf8');

describe('Metro bundling pattern (release regression guard)', () => {
  it('resolves expo-secure-store with a LITERAL require Metro can statically register', () => {
    expect(SOURCE).toMatch(/require\(\s*['"]expo-secure-store['"]\s*\)/);
  });

  it('never loads expo-secure-store through an aliased or indirect require', () => {
    // Every call of the form <identifier>('expo-secure-store') in the source
    // must be the literal `require(...)` itself. Any other identifier
    // (an aliased require, a helper, a method) is invisible to Metro and
    // reintroduces the startup crash.
    const calls =
      SOURCE.match(/\b([A-Za-z_$][\w$]*)\(\s*['"]expo-secure-store['"]\s*\)/g) ?? [];
    const indirect = calls.filter((call) => !call.startsWith('require('));
    expect(indirect).toEqual([]);
  });
});

describe('honest loader semantics outside a native runtime (Node/vitest)', () => {
  it('returns null when the native module cannot load — no fabricated store', () => {
    expect(loadExpoSecureStore()).toBeNull();
  });

  it('reports an unavailable READ (never "no value stored") on the expo adapter', () => {
    const read = createExpoSecureKeyStore().getSync('ai-english-tutor.gemini.api-key');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure).toBe('unavailable');
      expect(read.message.length).toBeGreaterThan(0);
    }
  });

  it('reports the store as not available for reachability probes', async () => {
    await expect(createExpoSecureKeyStore().isAvailable()).resolves.toBe(false);
  });
});
