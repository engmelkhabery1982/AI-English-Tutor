/**
 * src/learning-progression/stable-key.ts
 *
 * The deterministic stable-key digest used by the WP-1 foundation.
 *
 * It reproduces the SAME FNV-1a UUID-shaped digest already used by the
 * repository's existing stable-reference helpers (the listening engine's
 * `stableReferenceId`, the speaking planner's plan id and the prompt
 * scenario index). It lives here as one shared implementation so the new
 * content-request key cannot drift from that established pattern and so
 * later work packages have ONE place to reuse it.
 *
 * Properties: pure, deterministic, no clock, no randomness, no I/O.
 * Identical identity string → identical key. Different identity → different
 * key with a 128-bit-shaped digest.
 */

/**
 * Deterministic UUID-shaped key for a stable identity string.
 *
 * The identity string is the ONLY input: callers are responsible for
 * normalizing their inputs first (see ./request normalization in the content
 * generation module), exactly like the existing stable-reference helpers.
 */
export function stableKey(identity: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < identity.length; i += 1) {
    const code = identity.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ (code + i)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(0, len);
  const block = (salt: number) => hex((h1 ^ (h2 + salt)) >>> 0, 8).slice(0, 4);
  return [
    hex(h1 >>> 0, 8),
    block(0x9e37),
    block(0x85eb),
    block(0xc2b2),
    hex((h1 + h2) >>> 0, 8).slice(0, 12),
  ].join('-');
}
