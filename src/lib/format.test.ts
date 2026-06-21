/**
 * src/lib/format.test.ts — Unit tests for shared formatting helpers.
 */
import { describe, expect, it } from 'vitest';
import { fmtBarTime, fmtVol } from './format';

// ---------------------------------------------------------------------------
// fmtVol
// ---------------------------------------------------------------------------
describe('fmtVol', () => {
  it('returns — for NaN', () => {
    expect(fmtVol(NaN)).toBe('—');
  });

  it('returns — for Infinity', () => {
    expect(fmtVol(Infinity)).toBe('—');
  });

  it('formats billions', () => {
    expect(fmtVol(1_500_000_000)).toBe('1.50B');
  });

  it('formats millions', () => {
    expect(fmtVol(2_500_000)).toBe('2.50M');
  });

  it('formats thousands', () => {
    expect(fmtVol(3_500)).toBe('3.50K');
  });

  it('formats small values', () => {
    expect(fmtVol(42)).toBe('42.00');
  });
});

// ---------------------------------------------------------------------------
// fmtBarTime
// ---------------------------------------------------------------------------

describe('fmtBarTime', () => {
  // Use a fixed UTC timestamp: 2026-06-21 14:00:00 UTC = 1750514400000 ms
  // Tests run in the local timezone of the CI machine, so we use Intl to
  // derive the expected string dynamically rather than hardcoding a locale
  // string that would break in a different TZ.
  const TS_MS = 1750514400000; // 2026-06-21 14:00 UTC

  it('formats intraday timeframe (1h)', () => {
    const result = fmtBarTime(TS_MS, '1h');
    // Must contain a month abbrev, a day number, and HH:MM (24-h colon)
    expect(result).toMatch(/[A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2}/);
  });

  it('formats intraday timeframe (4h)', () => {
    const result = fmtBarTime(TS_MS, '4h');
    expect(result).toMatch(/[A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2}/);
  });

  it('formats intraday timeframe (1m)', () => {
    const result = fmtBarTime(TS_MS, '1m');
    expect(result).toMatch(/[A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2}/);
  });

  it('formats daily timeframe (1d) — no time, has year', () => {
    const result = fmtBarTime(TS_MS, '1d');
    // Must contain a 4-digit year and NOT a colon (no HH:MM)
    expect(result).toMatch(/\b20\d{2}\b/);
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });

  it('formats weekly timeframe (1w) — no time, has year', () => {
    const result = fmtBarTime(TS_MS, '1w');
    expect(result).toMatch(/\b20\d{2}\b/);
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });

  it('returns — for NaN timestamp', () => {
    expect(fmtBarTime(NaN, '1h')).toBe('—');
  });

  it('returns — for Infinity timestamp', () => {
    expect(fmtBarTime(Infinity, '1h')).toBe('—');
  });

  it('unknown timeframe string defaults to intraday format (has time)', () => {
    const result = fmtBarTime(TS_MS, 'unknown');
    expect(result).toMatch(/[A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2}/);
  });
});
