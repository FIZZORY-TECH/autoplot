/**
 * Indicator math — ported verbatim from app-design/project/data.js.
 * All semantics match the prototype exactly; only the signature is adapted to TypeScript.
 */
import type { Bar } from '../data/MarketDataProvider';

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

/**
 * Simple Moving Average over closing prices.
 * Returns `null` for the first (period - 1) positions (insufficient data).
 * Verbatim port of data.js `sma(c, n)`.
 */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average over closing prices.
 * Every position has a value (EMA starts from the very first bar).
 * Verbatim port of data.js `ema(c, n)`.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

export interface BollingerResult {
  upper: (number | null)[];
  mid: (number | null)[];
  lower: (number | null)[];
}

/**
 * Bollinger Bands (SMA mid ± k * population std-dev).
 * Verbatim port of data.js `bollinger(c, n, mult)`.
 *
 * @param values  closing prices
 * @param period  lookback window (default 20)
 * @param k       std-dev multiplier (default 2)
 */
export function bollinger(
  values: number[],
  period = 20,
  k = 2,
): BollingerResult {
  const mid = sma(values, period);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i] as number;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (values[j] - m) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = m + sd * k;
    lower[i] = m - sd * k;
  }
  return { mid, upper, lower };
}

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

/**
 * Relative Strength Index using Wilder's smoothing.
 * Returns `null` until period bars of data are available.
 * Verbatim port of data.js `rsi(c, n)`.
 *
 * @param values  closing prices
 * @param period  lookback (default 14)
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const g = Math.max(delta, 0);
    const l = Math.max(-delta, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        const rs = (gain / period) / Math.max(loss / period, 1e-9);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      const rs = gain / Math.max(loss, 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Donchian channel (W5-A)
// ---------------------------------------------------------------------------

export interface DonchianResult {
  high: (number | null)[];
  low: (number | null)[];
}

/**
 * Donchian channel — highest-high and lowest-low over the trailing `period`
 * bars (inclusive of the current bar). Returns `null` until `period` bars
 * are available.
 */
export function donchian(bars: Bar[], period: number): DonchianResult {
  const n = bars.length;
  const high: (number | null)[] = new Array(n).fill(null);
  const low: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    high[i] = hh;
    low[i] = ll;
  }
  return { high, low };
}

// ---------------------------------------------------------------------------
// ATR (Wilder) — W5-A
// ---------------------------------------------------------------------------

/**
 * Average True Range using Wilder's smoothing.
 * Returns `null` for the first `period` positions.
 */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n === 0) return out;
  const tr: number[] = new Array(n).fill(0);
  tr[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < n; i++) {
    const prevClose = bars[i - 1].c;
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prevClose),
      Math.abs(bars[i].l - prevClose),
    );
  }
  if (n < period) return out;
  // Seed: simple mean of first `period` TR values.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prevAtr = sum / period;
  out[period - 1] = prevAtr;
  for (let i = period; i < n; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heikin-Ashi
// ---------------------------------------------------------------------------

/**
 * Convert a raw OHLCV series to Heikin-Ashi bars.
 * Verbatim port of data.js `toHeikinAshi(c)`.
 * All fields (`ts`, `v`) are preserved from the source bar.
 */
export function toHeikinAshi(bars: Bar[]): Bar[] {
  const ha: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haC = (b.o + b.h + b.l + b.c) / 4;
    const haO = i === 0 ? (b.o + b.c) / 2 : (ha[i - 1].o + ha[i - 1].c) / 2;
    const haH = Math.max(b.h, haO, haC);
    const haL = Math.min(b.l, haO, haC);
    ha.push({ ts: b.ts, o: haO, h: haH, l: haL, c: haC, v: b.v });
  }
  return ha;
}

// ---------------------------------------------------------------------------
// User-pasted series parser
// ---------------------------------------------------------------------------

export interface ParseResult {
  series: number[];
  errors: string[];
}

/**
 * Parse a user-pasted numeric series (CSV / whitespace-separated / JSON array).
 *
 * Rules:
 *   - Blank lines are silently skipped.
 *   - Each non-blank token is parsed as a float.
 *   - Tokens that are not valid numbers are reported as parse errors with a
 *     1-based line reference (e.g. "line 3: 'abc' is not a number").
 *   - The final `series` contains only the successfully parsed numbers, in order.
 *
 * This is a TypeScript adaptation of data.js `parseUserSeries`; the signature
 * is intentionally different (no `length` alignment) so that the indicator
 * pipeline can handle alignment at the call site.
 */
export function parseUserSeries(text: string): ParseResult {
  const series: number[] = [];
  const errors: string[] = [];

  if (!text || !text.trim()) return { series, errors };

  const trimmed = text.trim();

  // JSON array shortcut
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      parsed.forEach((v, idx) => {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push(`index ${idx}: '${String(v)}' is not a number`);
        } else {
          series.push(n);
        }
      });
    } catch {
      errors.push('line 1: invalid JSON array');
    }
    return { series, errors };
  }

  // Line-by-line CSV / whitespace parsing
  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    const lineNum = lineIdx + 1;
    const tokens = line.trim().split(/[\s,;]+/).filter(Boolean);
    for (const token of tokens) {
      const n = parseFloat(token);
      if (Number.isNaN(n)) {
        errors.push(`line ${lineNum}: '${token}' is not a number`);
      } else {
        series.push(n);
      }
    }
  });

  return { series, errors };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a price for tabular display with adaptive decimal precision.
 * Verbatim port of data.js `fmtPrice(v)`.
 */
export function fmtPrice(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '—';
  if (decimals !== undefined) return value.toFixed(decimals);
  const a = Math.abs(value);
  if (a >= 10000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1000)  return value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 100)   return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1)     return value.toFixed(3);
  if (a >= 0.01)  return value.toFixed(4);
  return value.toFixed(6);
}

/**
 * Format a decimal ratio as a signed percentage string, e.g. +2.45% / -0.81%.
 * Verbatim port of data.js `fmtPct(p)`.
 * @param value  decimal fraction (0.025 → '+2.50%')
 */
export function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return sign + (value * 100).toFixed(2) + '%';
}

/**
 * Format a USD amount with a sign-aware `$` prefix and K/M magnitude suffixes
 * (e.g. `$1.23K`, `-$4.56M`, `$78.90`). Used for portfolio value / P&L readouts.
 */
export function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  const prefix = value < 0 ? '-$' : '$';
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(2)}K`;
  return `${prefix}${abs.toFixed(2)}`;
}
