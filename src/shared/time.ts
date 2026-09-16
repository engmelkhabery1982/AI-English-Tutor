/**
 * src/shared/time.ts
 *
 * Shared time utilities.
 */

export function nowIso(): string {
  return new Date().toISOString();
}
