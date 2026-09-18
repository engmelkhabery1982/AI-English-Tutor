/**
 * src/daily-tutor/date.ts
 *
 * Deterministic daily-date handling for the Daily Tutor.
 *
 * Rules:
 * - A "date key" is a local calendar date 'YYYY-MM-DD'.
 * - Conversion from an ISO timestamp is a PURE function of (timestamp,
 *   explicit UTC offset) — no hidden system clock and no locale behaviour,
 *   so the same inputs always produce the same key (testable, stable plans).
 * - The day index (days since the UTC epoch of the date key) gives the
 *   planner a deterministic rotation value: same learner/date → same plan,
 *   different dates → varied-but-deterministic plans. Never Math.random.
 */

import type { DailyTutorDateKey } from './types';

/** Match a strict 'YYYY-MM-DD' key. */
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Convert an ISO timestamp into the local date key for the given UTC offset.
 *
 * @param iso ISO-8601 timestamp (e.g. '2026-09-18T08:30:00.000Z').
 * @param utcOffsetMinutes East-positive offset in minutes (e.g. +120 for
 *        UTC+2). Defaults to 0 (UTC). Use `-new Date().getTimezoneOffset()`
 *        at the composition edge for device-local dates.
 * @returns the 'YYYY-MM-DD' key, or null when the timestamp is invalid.
 */
export function toDateKey(iso: string, utcOffsetMinutes = 0): DailyTutorDateKey | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  const offsetMs = Math.round(utcOffsetMinutes) * 60_000;
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

/** True when the value is a well-formed 'YYYY-MM-DD' date key. */
export function isValidDateKey(value: unknown): value is DailyTutorDateKey {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed);
}

/**
 * Deterministic day index: whole days between the UTC epoch and the date
 * key. Used only as a stable rotation seed — never surfaced to the learner.
 */
export function dayIndexOf(dateKey: DailyTutorDateKey): number {
  return Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86_400_000);
}

/**
 * Number of whole days between two date keys (a − b). Negative when a is
 * earlier than b. Deterministic; used for "practised yesterday" logic.
 */
export function daysBetweenDateKeys(a: DailyTutorDateKey, b: DailyTutorDateKey): number {
  return dayIndexOf(a) - dayIndexOf(b);
}

/** Deterministic positive integer rotation value in [0, modulo). */
export function rotationOf(dateKey: DailyTutorDateKey, modulo: number): number {
  const m = Math.max(1, Math.floor(modulo));
  const value = dayIndexOf(dateKey) % m;
  return value < 0 ? value + m : value;
}
