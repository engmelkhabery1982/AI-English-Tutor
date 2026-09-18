/**
 * Deterministic date-key utilities for the Daily Tutor.
 *
 * These tests pin the exact local-day semantics the daily plan depends on:
 * a learner near midnight must get ONE plan for their local day, and the
 * same (now, offset) pair must always produce the same key.
 */

import { describe, expect, it } from 'vitest';

import {
  dayIndexOf,
  daysBetweenDateKeys,
  isValidDateKey,
  rotationOf,
  toDateKey,
} from './date';

describe('toDateKey', () => {
  it('produces a YYYY-MM-DD key from a UTC instant at offset 0', () => {
    expect(toDateKey('2026-09-18T10:30:00.000Z', 0)).toBe('2026-09-18');
  });

  it('shifts to the previous local day when the offset is negative past midnight', () => {
    // 00:30 UTC on the 18th is 19:30 on the 17th at UTC-5.
    expect(toDateKey('2026-09-18T00:30:00.000Z', -300)).toBe('2026-09-17');
  });

  it('shifts to the next local day when the offset is positive past 24:00 UTC', () => {
    // 23:30 UTC on the 18th is 02:30 on the 19th at UTC+3.
    expect(toDateKey('2026-09-18T23:30:00.000Z', 180)).toBe('2026-09-19');
  });

  it('is deterministic: the same instant and offset always give the same key', () => {
    const iso = '2026-02-28T23:59:59.999Z';
    expect(toDateKey(iso, 60)).toBe(toDateKey(iso, 60));
    expect(toDateKey(iso, 60)).toBe('2026-03-01');
  });

  it('returns null for invalid input instead of inventing a date', () => {
    expect(toDateKey('not-a-date', 0)).toBeNull();
    expect(toDateKey('', 0)).toBeNull();
  });
});

describe('isValidDateKey', () => {
  it('accepts well-formed keys', () => {
    expect(isValidDateKey('2026-09-18')).toBe(true);
    expect(isValidDateKey('1999-01-01')).toBe(true);
  });

  it('rejects malformed or structurally impossible keys', () => {
    expect(isValidDateKey('2026-9-18')).toBe(false);
    expect(isValidDateKey('2026-09-32')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
    expect(isValidDateKey(20260918)).toBe(false);
    expect(isValidDateKey(null)).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(() => isValidDateKey(undefined)).not.toThrow();
    expect(isValidDateKey(undefined)).toBe(false);
  });
});

describe('dayIndexOf', () => {
  it('maps a key to a stable integer', () => {
    expect(dayIndexOf('2026-09-18')).toBe(dayIndexOf('2026-09-18'));
    expect(Number.isInteger(dayIndexOf('2026-09-18'))).toBe(true);
  });

  it('later dates have strictly larger day indexes', () => {
    expect(dayIndexOf('2026-09-19')).toBeGreaterThan(dayIndexOf('2026-09-18'));
    expect(dayIndexOf('2027-01-01')).toBeGreaterThan(dayIndexOf('2026-12-31'));
  });
});

describe('daysBetweenDateKeys', () => {
  it('is 0 for the same day', () => {
    expect(daysBetweenDateKeys('2026-09-18', '2026-09-18')).toBe(0);
  });

  it('counts whole days between keys (signed)', () => {
    expect(daysBetweenDateKeys('2026-09-18', '2026-09-17')).toBe(1);
    expect(daysBetweenDateKeys('2026-09-17', '2026-09-18')).toBe(-1);
    expect(daysBetweenDateKeys('2026-09-10', '2026-09-18')).toBe(-8);
  });

  it('crosses month and year boundaries correctly', () => {
    expect(daysBetweenDateKeys('2026-10-01', '2026-09-30')).toBe(1);
    expect(daysBetweenDateKeys('2027-01-01', '2026-12-31')).toBe(1);
  });
});

describe('rotationOf', () => {
  it('stays within [0, modulo)', () => {
    for (const key of ['2026-09-18', '2026-09-19', '2026-09-20', '2027-03-07']) {
      expect(rotationOf(key, 2)).toBeLessThan(2);
      expect(rotationOf(key, 3)).toBeGreaterThanOrEqual(0);
      expect(rotationOf(key, 3)).toBeLessThan(3);
    }
  });

  it('is deterministic for the same key', () => {
    expect(rotationOf('2026-09-18', 5)).toBe(rotationOf('2026-09-18', 5));
  });

  it('consecutive days can rotate differently (variety across days)', () => {
    const values = new Set([
      rotationOf('2026-09-16', 3),
      rotationOf('2026-09-17', 3),
      rotationOf('2026-09-18', 3),
    ]);
    // Across three consecutive days with modulo 3 the rotation must hit more
    // than one distinct value, otherwise there is no cross-day variety.
    expect(values.size).toBeGreaterThan(1);
  });
});
