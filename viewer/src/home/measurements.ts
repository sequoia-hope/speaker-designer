// Measurement import: frequency-response (.frd, REW "SPL" text export) and
// impedance (.zma, REW impedance export) files, plus the signal processing the
// crossover needs to use them in place of the idealised models.
//
// Conventions
//   - Points are { f (Hz), mag, phase? (deg) }. mag is dB SPL for kind 'spl'
//     and ohms for kind 'impedance'. Phase is stored as read (usually wrapped
//     to ±180°); everything that interpolates phase unwraps it first.
//   - Time dependence e^{+jωt} (as crossover.ts): a delay τ multiplies a
//     response by e^{−jωτ}, so phase falls with frequency; a high-pass leads.
//   - "Log grid" = frequencies equally spaced in ln f.
//
// Pure module: no Svelte, no DOM — tested directly in Node.

import type { DriverInfo } from './drivers';
import type { Complex } from './roomAcoustics';

export type MeasurementKind = 'spl' | 'impedance';
export type MeasurementRole = 'woofer' | 'tweeter' | 'system';

export interface MeasPoint {
  f: number;
  mag: number;
  phase?: number;
}

export interface Measurement {
  id: string;
  name: string;
  kind: MeasurementKind;
  role?: MeasurementRole;
  /** the driver it was measured from; unset = "whichever driver has this role" */
  driverId?: string;
  points: MeasPoint[];
  /** ISO date */
  importedAt: string;
  note: string;
  fileName?: string;
  /** only use the data between these frequencies (e.g. above a gated measurement's limit) */
  fMin?: number;
  fMax?: number;
  /** ignore the file's phase and use the minimum-phase reconstruction */
  minPhase?: boolean;
  /** keep the measured delay (both drivers measured with a common timing reference) */
  keepTiming?: boolean;
  /** user-entered DC resistance for the T/S estimate (Ω) */
  reOhm?: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParseResult {
  points: MeasPoint[];
  hasPhase: boolean;
  kind: MeasurementKind;
  /** why that kind was chosen */
  kindReason: string;
  /** 'header' | 'extension' are reliable; 'values' is a guess */
  kindFrom: 'header' | 'extension' | 'values' | 'forced';
  /** header / comment text found in the file */
  header: string[];
  warnings: string[];
}

export class MeasurementParseError extends Error {}

const COMMENT_RE = /^\s*(\*|#|;|\/\/|%|!|")/;

/** Split one data line into numbers, coping with whitespace / comma / semicolon / tab separators and decimal commas. */
function splitNumbers(line: string): number[] | null {
  const t = line.trim();
  if (!t) return null;
  let parts: string[];
  if (t.includes(';')) {
    // "1000,5;85,2;-12,0" (European export) or "1000.5; 85.2"
    parts = t.split(/\s*;\s*/).map((p) => p.trim().replace(',', '.'));
  } else if (t.includes('\t') && /\d,\d/.test(t) && !/\d\.\d/.test(t)) {
    parts = t.split(/\t+/).map((p) => p.trim().replace(',', '.'));
  } else {
    parts = t.split(/[\s,]+/);
  }
  const out: number[] = [];
  for (const p of parts) {
    if (p === '') continue;
    // tolerate quoted numbers ("1000.0")
    const q = p.replace(/^"(.*)"$/, '$1');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(q)) return null;
    out.push(Number(q));
  }
  return out.length ? out : null;
}

function kindFromHeader(header: string[]): MeasurementKind | null {
  // the column-title line is the strongest hint; fall back to all header text
  const cols = header.filter((h) => /freq/i.test(h));
  for (const lines of [cols, header]) {
    const txt = lines.join(' ');
    const z = /imped|ohm|Ω|\bz\s*\(|\|z\|/i.test(txt);
    const s = /\bspl\b|db\s*spl|\bspl\s*\(|\bdb\b|\(db\)|magnitude\s*\(db/i.test(txt);
    if (z && !s) return 'impedance';
    if (s && !z) return 'spl';
    if (z && s) {
      // e.g. "Freq(Hz) Impedance(ohms) Phase" with a "dB" elsewhere: the column line decides
      if (/imped|ohm|Ω/i.test(txt)) return 'impedance';
    }
  }
  return null;
}

/** Guess SPL vs impedance from the numbers alone. */
export function kindFromValues(points: MeasPoint[]): { kind: MeasurementKind; reason: string } {
  const mags = points.map((p) => p.mag).sort((a, b) => a - b);
  const min = mags[0];
  const max = mags[mags.length - 1];
  const med = mags[Math.floor(mags.length / 2)];
  const phMax = Math.max(0, ...points.map((p) => (p.phase == null ? 0 : Math.abs(p.phase))));
  if (min <= 0.5) return { kind: 'spl', reason: `values go down to ${min.toFixed(1)} — relative dB, not ohms` };
  if (phMax > 100) return { kind: 'spl', reason: `phase reaches ${phMax.toFixed(0)}° — a passive impedance stays within ±90°` };
  if (med < 45 && min >= 1) return { kind: 'impedance', reason: `values ${min.toFixed(1)}–${max.toFixed(1)} (median ${med.toFixed(1)}) look like ohms` };
  return { kind: 'spl', reason: `values ${min.toFixed(0)}–${max.toFixed(0)} (median ${med.toFixed(0)}) look like dB SPL` };
}

/**
 * Parse an .frd / .zma / REW text export (or any "freq mag [phase]" table).
 * `fileName` lets the extension hint the kind; `forceKind` overrides detection.
 * Throws MeasurementParseError when the file is unusable.
 */
export function parseMeasurement(text: string, fileName = '', forceKind?: MeasurementKind): ParseResult {
  const header: string[] = [];
  const rows: number[][] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (COMMENT_RE.test(line)) {
      header.push(line.replace(COMMENT_RE, '').trim());
      continue;
    }
    const nums = splitNumbers(line);
    if (!nums) {
      // a non-numeric line: a column header before the data, or junk after it
      if (rows.length === 0) header.push(line);
      else skipped++;
      continue;
    }
    if (nums.length < 2) {
      skipped++;
      continue;
    }
    rows.push(nums);
  }
  if (skipped) warnings.push(`Skipped ${skipped} line${skipped === 1 ? '' : 's'} that weren't "frequency value [phase]" numbers.`);
  if (rows.length === 0) throw new MeasurementParseError('no numeric data found (expected columns: frequency, magnitude, optional phase)');
  const hasPhase = rows.every((r) => r.length >= 3);
  if (!hasPhase && rows.some((r) => r.length >= 3)) warnings.push('Only some lines have a phase column; phase ignored.');

  let pts: MeasPoint[] = rows.map((r) => (hasPhase ? { f: r[0], mag: r[1], phase: r[2] } : { f: r[0], mag: r[1] }));
  const bad = pts.filter((p) => !Number.isFinite(p.f) || !Number.isFinite(p.mag) || (p.phase != null && !Number.isFinite(p.phase)));
  if (bad.length) throw new MeasurementParseError(`${bad.length} line${bad.length === 1 ? ' has' : 's have'} non-finite numbers`);
  const nonPos = pts.filter((p) => p.f <= 0).length;
  if (nonPos) {
    pts = pts.filter((p) => p.f > 0);
    warnings.push(`Dropped ${nonPos} point${nonPos === 1 ? '' : 's'} at 0 Hz or below.`);
  }
  pts = validateOrder(pts, warnings);
  if (pts.length < 10) throw new MeasurementParseError(`only ${pts.length} usable points (need at least 10)`);

  let kind: MeasurementKind;
  let kindReason: string;
  let kindFrom: ParseResult['kindFrom'];
  const hk = kindFromHeader(header);
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (forceKind) {
    kind = forceKind;
    kindReason = 'set by you';
    kindFrom = 'forced';
  } else if (hk) {
    kind = hk;
    kindReason = `the file's header says ${hk === 'spl' ? 'SPL / dB' : 'impedance / ohms'}`;
    kindFrom = 'header';
  } else if (ext === 'zma' || ext === 'frd') {
    kind = ext === 'zma' ? 'impedance' : 'spl';
    kindReason = `.${ext} file`;
    kindFrom = 'extension';
    // an .frd that is obviously ohms (or vice versa) still gets flagged
    const v = kindFromValues(pts);
    if (v.kind !== kind) warnings.push(`It's a .${ext} file but the numbers look like ${v.kind === 'spl' ? 'dB SPL' : 'impedance'} (${v.reason}). Change the type if that's right.`);
  } else {
    const v = kindFromValues(pts);
    kind = v.kind;
    kindReason = v.reason;
    kindFrom = 'values';
  }
  return { points: pts, hasPhase, kind, kindReason, kindFrom, header, warnings };
}

/** Frequencies must rise strictly: reverse a descending file, drop exact duplicates, reject anything else. */
function validateOrder(pts: MeasPoint[], warnings: string[]): MeasPoint[] {
  if (pts.length >= 2 && pts[0].f > pts[pts.length - 1].f) {
    pts = pts.slice().reverse();
    warnings.push('Frequencies were in descending order; reversed.');
  }
  const out: MeasPoint[] = [];
  let dups = 0;
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && p.f === last.f) {
      dups++;
      continue;
    }
    if (last && p.f < last.f) throw new MeasurementParseError(`frequencies are not in order (${last.f} Hz is followed by ${p.f} Hz)`);
    out.push(p);
  }
  if (dups) warnings.push(`Dropped ${dups} repeated frequenc${dups === 1 ? 'y' : 'ies'}.`);
  return out;
}

/** Problems with a points array (for data that didn't come through the parser, e.g. an imported JSON). */
export function validatePoints(points: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(points)) return ['points is not an array'];
  if (points.length < 10) errs.push(`only ${points.length} points (need at least 10)`);
  let prev = 0;
  for (const p of points as MeasPoint[]) {
    if (!p || !Number.isFinite(p.f) || !Number.isFinite(p.mag) || (p.phase != null && !Number.isFinite(p.phase))) {
      errs.push('non-finite value');
      break;
    }
    if (p.f <= prev) {
      errs.push('frequencies not strictly increasing');
      break;
    }
    prev = p.f;
  }
  return errs;
}

/** Serialise back to a text file (.frd / .zma style, tab-separated). */
export function toFrdText(points: MeasPoint[], headerLines: string[] = []): string {
  const hasPhase = points.every((p) => p.phase != null);
  const lines = headerLines.map((h) => `* ${h}`);
  for (const p of points) lines.push(hasPhase ? `${p.f}\t${p.mag}\t${p.phase}` : `${p.f}\t${p.mag}`);
  return lines.join('\n') + '\n';
}

export const hasPhase = (pts: MeasPoint[]) => pts.length > 0 && pts.every((p) => p.phase != null);

// ---------------------------------------------------------------------------
// Interpolation, resampling, smoothing
// ---------------------------------------------------------------------------

/** Unwrap a phase sequence (deg) so consecutive steps never exceed 180°. */
export function unwrapDeg(ph: number[]): number[] {
  const out = ph.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    d -= 360 * Math.round(d / 360);
    out[i] = out[i - 1] + d;
  }
  return out;
}

export const wrapDeg = (d: number) => {
  let x = (((d + 180) % 360) + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
};

/** First index i with xs[i] > x (binary search); xs ascending. */
function upper(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export interface Interpolator {
  fMin: number;
  fMax: number;
  hasPhase: boolean;
  /** magnitude (linear in ln f between points); outside the data: held, or extended along the end slope */
  mag(f: number): number;
  /** unwrapped phase (deg), linear in ln f; held flat outside the data */
  phase(f: number): number;
  /** end slopes of mag per octave (fitted over the outer half octave) */
  slopeLo: number;
  slopeHi: number;
}

/** Least-squares slope of y vs log2 f over the first / last `oct` octaves (≥ 3 points). */
function endSlope(u: number[], y: number[], end: 'lo' | 'hi', oct = 0.5): number {
  const n = u.length;
  const span = oct * Math.LN2;
  const idx: number[] = [];
  if (end === 'lo') for (let i = 0; i < n && (u[i] - u[0] <= span || idx.length < 3); i++) idx.push(i);
  else for (let i = n - 1; i >= 0 && (u[n - 1] - u[i] <= span || idx.length < 3); i--) idx.push(i);
  const m = idx.length;
  const mu = idx.reduce((a, i) => a + u[i], 0) / m;
  const my = idx.reduce((a, i) => a + y[i], 0) / m;
  let num = 0;
  let den = 0;
  for (const i of idx) {
    num += (u[i] - mu) * (y[i] - my);
    den += (u[i] - mu) ** 2;
  }
  return den > 0 ? (num / den) * Math.LN2 : 0; // per octave
}

/**
 * Interpolator over measured points. `extrapolate: 'slope'` continues the
 * magnitude along the fitted end slope (dB/oct, clamped to ±maxSlope) — the
 * right thing for SPL roll-offs; 'hold' repeats the end value.
 */
export function makeInterpolator(points: MeasPoint[], extrapolate: 'hold' | 'slope' = 'hold', maxSlope = 30): Interpolator {
  const u = points.map((p) => Math.log(p.f));
  const m = points.map((p) => p.mag);
  const ph = hasPhase(points) ? unwrapDeg(points.map((p) => p.phase!)) : null;
  const clamp = (s: number) => Math.max(-maxSlope, Math.min(maxSlope, s));
  const slopeLo = extrapolate === 'slope' ? clamp(endSlope(u, m, 'lo')) : 0;
  const slopeHi = extrapolate === 'slope' ? clamp(endSlope(u, m, 'hi')) : 0;
  const n = u.length;
  const lin = (ys: number[], x: number) => {
    const i = upper(u, x);
    if (i <= 0) return ys[0];
    if (i >= n) return ys[n - 1];
    const t = (x - u[i - 1]) / (u[i] - u[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  };
  return {
    fMin: points[0].f,
    fMax: points[n - 1].f,
    hasPhase: !!ph,
    slopeLo,
    slopeHi,
    mag(f) {
      const x = Math.log(f);
      if (x < u[0]) return m[0] + (slopeLo * (x - u[0])) / Math.LN2;
      if (x > u[n - 1]) return m[n - 1] + (slopeHi * (x - u[n - 1])) / Math.LN2;
      return lin(m, x);
    },
    phase(f) {
      return ph ? lin(ph, Math.log(f)) : 0;
    },
  };
}

/** Magnitude and (wrapped) phase at f; outside the data the end values are held. */
export function interpAt(points: MeasPoint[], f: number): MeasPoint {
  const it = makeInterpolator(points);
  return it.hasPhase ? { f, mag: it.mag(f), phase: wrapDeg(it.phase(f)) } : { f, mag: it.mag(f) };
}

/** Log-spaced frequencies from f0 to f1 (inclusive) at `ppo` points per octave. */
export function logGrid(f0: number, f1: number, ppo: number): number[] {
  const n = Math.max(2, Math.ceil(Math.log2(f1 / f0) * ppo) + 1);
  const h = Math.log(f1 / f0) / (n - 1);
  return Array.from({ length: n }, (_, i) => f0 * Math.exp(i * h));
}

/** Resample onto a log grid (default: the data's own span); phase re-wrapped. */
export function resampleLog(points: MeasPoint[], ppo = 48, f0 = points[0].f, f1 = points[points.length - 1].f): MeasPoint[] {
  const it = makeInterpolator(points);
  return logGrid(f0, f1, ppo).map((f) => (it.hasPhase ? { f, mag: it.mag(f), phase: wrapDeg(it.phase(f)) } : { f, mag: it.mag(f) }));
}

/**
 * 1/N-octave smoothing: each point becomes the mean (over ln f, of the
 * piecewise-linear curve) of the window f·2^(±1/2N). dB for SPL is averaged
 * as dB, ohms as ohms, phase unwrapped. Windows are clipped at the data ends.
 */
export function smoothOctave(points: MeasPoint[], n: number): MeasPoint[] {
  if (!(n > 0) || points.length < 3) return points.slice();
  const u = points.map((p) => Math.log(p.f));
  const half = Math.LN2 / (2 * n);
  // cumulative integral of a piecewise-linear series over u
  const cum = (ys: number[]) => {
    const c = [0];
    for (let i = 1; i < ys.length; i++) c.push(c[i - 1] + ((ys[i] + ys[i - 1]) / 2) * (u[i] - u[i - 1]));
    return c;
  };
  const at = (ys: number[], c: number[], x: number) => {
    const i = Math.min(Math.max(upper(u, x), 1), u.length - 1);
    const t = x - u[i - 1];
    const slope = (ys[i] - ys[i - 1]) / (u[i] - u[i - 1]);
    return c[i - 1] + ys[i - 1] * t + 0.5 * slope * t * t;
  };
  const mags = points.map((p) => p.mag);
  const cm = cum(mags);
  const ph = hasPhase(points) ? unwrapDeg(points.map((p) => p.phase!)) : null;
  const cp = ph ? cum(ph) : null;
  return points.map((p, i) => {
    const a = Math.max(u[0], u[i] - half);
    const b = Math.min(u[u.length - 1], u[i] + half);
    if (b - a < 1e-12) return { ...p };
    const mag = (at(mags, cm, b) - at(mags, cm, a)) / (b - a);
    if (!ph || !cp) return { f: p.f, mag };
    return { f: p.f, mag, phase: wrapDeg((at(ph, cp, b) - at(ph, cp, a)) / (b - a)) };
  });
}

/** Mean of the magnitude over [f0, f1] (on a log grid; clipped to the data). */
export function bandLevel(points: MeasPoint[], f0: number, f1: number): number {
  const it = makeInterpolator(points);
  const a = Math.max(f0, it.fMin);
  const b = Math.min(f1, it.fMax);
  if (!(b > a)) return it.mag(Math.sqrt(f0 * f1));
  const g = logGrid(a, b, 24);
  return g.reduce((s, f) => s + it.mag(f), 0) / g.length;
}

/** Points inside the measurement's chosen range (fMin..fMax). */
export function usablePoints(m: Measurement): MeasPoint[] {
  const lo = m.fMin ?? 0;
  const hi = m.fMax ?? Infinity;
  return m.points.filter((p) => p.f >= lo && p.f <= hi);
}

/** Keep stored measurements a sensible size: very dense (linear FFT) exports go onto a 1/96-octave grid. */
export function decimate(points: MeasPoint[], maxPoints = 2000): MeasPoint[] {
  return points.length > maxPoints ? resampleLog(points, 96) : points;
}

// ---------------------------------------------------------------------------
// Minimum phase (Hilbert transform of ln|H| on a log-frequency grid)
// ---------------------------------------------------------------------------
//
// For a minimum-phase H, ln H is analytic in the right half-plane and its
// phase is the Hilbert transform of ln|H|. On a log axis u = ln(ω/ω0) this is
// Bode's gain–phase integral:
//
//   φ(ω0) = (1/π) ∫ A'(u) · ln coth(|u|/2) du,   A = ln|H| (nepers)
//
// (check: 1/s has A' = −1 and ∫ ln coth(|u|/2) du = π²/2, so φ = −π/2.)
// With A piecewise-linear on a uniform log grid (step h), A' is constant on
// each segment and the kernel integrates exactly:
//
//   T(U) = ∫_U^∞ ln coth(u/2) du = 2 Σ_{m odd} e^{−mU}/m²,   T(0) = π²/4
//
// so segment k contributes A'_k · (T(|k−i|h) − T((|k−i|+1)h)) at grid point i,
// and the magnitude beyond the grid, continued along its end slopes, adds
// slope · T(distance to the edge) exactly. No FFT, no time aliasing, and the
// low-frequency resolution is as fine as the grid. O(n²) for n grid points.

function tailT(U: number): number {
  if (U <= 0) return (Math.PI * Math.PI) / 4;
  if (U > 36) return 0;
  let s = 0;
  for (let m = 1; m < 400000; m += 2) {
    const e = Math.exp(-m * U);
    s += e / (m * m);
    if (e / m < 1e-13) break;
  }
  return 2 * s;
}

/**
 * Minimum phase (deg) on a uniform log grid from magnitudes in dB.
 * `slopeLo` / `slopeHi` (dB/oct) continue the magnitude beyond the grid ends;
 * default: the slope of the outer half octave.
 */
export function minimumPhaseDeg(freqs: number[], db: number[], slopeLo?: number, slopeHi?: number): number[] {
  const n = freqs.length;
  if (n < 2) return freqs.map(() => 0);
  const h = Math.log(freqs[n - 1] / freqs[0]) / (n - 1);
  const NP = Math.LN10 / 20; // dB → nepers
  const A = db.map((d) => d * NP);
  const u = freqs.map((f) => Math.log(f));
  const sLo = ((slopeLo ?? endSlope(u, db, 'lo')) * NP) / Math.LN2; // nepers per unit u
  const sHi = ((slopeHi ?? endSlope(u, db, 'hi')) * NP) / Math.LN2;
  const T = Array.from({ length: n + 1 }, (_, j) => tailT(j * h));
  const K = T.slice(0, n).map((t, j) => t - T[j + 1]);
  const s = Array.from({ length: n - 1 }, (_, k) => (A[k + 1] - A[k]) / h);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let acc = sLo * T[i] + sHi * T[n - 1 - i];
    for (let k = 0; k < n - 1; k++) acc += s[k] * (k >= i ? K[k - i] : K[i - k - 1]);
    out.push(((acc / Math.PI) * 180) / Math.PI);
  }
  return out;
}

/** Minimum-phase version of measured SPL points, evaluated on a log grid over [f0, f1] (default: the data span). */
export function minimumPhaseOf(points: MeasPoint[], ppo = 48, f0 = points[0].f, f1 = points[points.length - 1].f): MeasPoint[] {
  const it = makeInterpolator(points, 'slope');
  const g = logGrid(f0, f1, ppo);
  const db = g.map((f) => it.mag(f));
  const ph = minimumPhaseDeg(g, db, it.slopeLo, it.slopeHi);
  return g.map((f, i) => ({ f, mag: db[i], phase: ph[i] }));
}

// ---------------------------------------------------------------------------
// Measured response → complex H for the crossover
// ---------------------------------------------------------------------------

export interface MeasuredResponse {
  /** complex response on the requested freqs, relative: 0 dB = refDb */
  H: Complex[];
  refDb: number;
  phaseSource: 'measured' | 'minimum';
  /** delay taken out of the measured phase (ms); 0 when minimum phase */
  delayMs: number;
  /** delay left in the response (ms): keepTiming */
  keptDelayMs: number;
  /** requested freqs outside the measured range (filled in along the end slopes) */
  extrapolated: boolean;
}

/**
 * Pure delay τ (s) that best explains an excess phase: maximises the
 * coherence |Σ exp(j(ex_i + 360·f_i·τ))| over ±30 ms. Works on the wrapped
 * phase, so it doesn't matter that a long mic delay spins the phase faster
 * than the file's frequency spacing can unwrap. Coarse grid (≤ 22° phase error
 * at the top frequency per step), then a fine one around the best.
 */
export function fitDelay(f: number[], exDeg: number[], maxS = 0.03): number {
  if (f.length < 3) return 0;
  // ≤ 160 log-spaced points is plenty for the search
  const stride = Math.max(1, Math.ceil(f.length / 160));
  const fs: number[] = [];
  const ex: number[] = [];
  for (let i = 0; i < f.length; i += stride) {
    fs.push(f[i]);
    ex.push((exDeg[i] * Math.PI) / 180);
  }
  const fTop = Math.max(...fs);
  const score = (tau: number) => {
    let c = 0;
    let s = 0;
    for (let i = 0; i < fs.length; i++) {
      const a = ex[i] + 2 * Math.PI * fs[i] * tau;
      c += Math.cos(a);
      s += Math.sin(a);
    }
    return c * c + s * s;
  };
  const step = 1 / (16 * fTop);
  let best = 0;
  let bestS = score(0);
  for (let t = -maxS; t <= maxS; t += step) {
    const sc = score(t);
    if (sc > bestS) {
      bestS = sc;
      best = t;
    }
  }
  const c0 = best;
  for (let t = c0 - step; t <= c0 + step; t += step / 50) {
    const sc = score(t);
    if (sc > bestS) {
      bestS = sc;
      best = t;
    }
  }
  return best;
}

/**
 * Complex response of an SPL measurement on `freqs`, normalised so the mean
 * over `refBand` is 0 dB.
 *  - Magnitude: interpolated in ln f; continued along the end slopes outside the data.
 *  - Phase without a measured phase (or m.minPhase): minimum phase.
 *  - With measured phase: φ = φ_min + excess, where excess = measured − minimum
 *    phase on the data, minus its best-fit pure delay (linear in f, fitted where
 *    the response is within 10 dB of its passband). The delay is the mic
 *    distance / IR start — arbitrary unless both drivers share a timing
 *    reference (m.keepTiming), in which case it is put back.
 */
export function measuredResponse(m: Measurement, freqs: number[], refBand: [number, number]): MeasuredResponse {
  const pts = usablePoints(m);
  if (pts.length < 10) throw new MeasurementParseError(`${m.name}: fewer than 10 points in the chosen range`);
  const it = makeInterpolator(pts, 'slope');
  const refDb = bandLevel(pts, refBand[0], refBand[1]);
  const f0 = Math.min(freqs[0], it.fMin);
  const f1 = Math.max(freqs[freqs.length - 1], it.fMax);
  const g = logGrid(f0, f1, 48);
  const gDb = g.map((f) => it.mag(f));
  const gMin = minimumPhaseDeg(g, gDb, it.slopeLo, it.slopeHi);
  const ug = g.map((f) => Math.log(f));
  const minAt = (f: number) => {
    const x = Math.log(f);
    const i = Math.min(Math.max(upper(ug, x), 1), g.length - 1);
    const t = (x - ug[i - 1]) / (ug[i] - ug[i - 1]);
    return gMin[i - 1] + t * (gMin[i] - gMin[i - 1]);
  };
  const usePhase = it.hasPhase && !m.minPhase;
  let excessAt: (f: number) => number = () => 0;
  let tau = 0;
  if (usePhase) {
    const meas = unwrapDeg(pts.map((p) => p.phase!));
    const ex = pts.map((p, i) => meas[i] - minAt(p.f));
    // fit ex ≈ a − 360·f·τ over the passband (within 10 dB of the loudest smoothed level)
    const sm = smoothOctave(pts, 3);
    const top = Math.max(...sm.map((p) => p.mag));
    const idx = pts.map((_, i) => i).filter((i) => sm[i].mag > top - 10);
    tau = fitDelay(
      idx.map((i) => pts[i].f),
      idx.map((i) => ex[i]),
    );
    // wrap then unwrap: smooth even where the raw phase spun too fast to unwrap
    const resid = unwrapDeg(pts.map((p, i) => wrapDeg(ex[i] + 360 * p.f * tau)));
    const up = pts.map((p) => Math.log(p.f));
    excessAt = (f) => {
      const x = Math.log(f);
      if (x <= up[0]) return resid[0];
      if (x >= up[up.length - 1]) return resid[resid.length - 1];
      const i = upper(up, x);
      const t = (x - up[i - 1]) / (up[i] - up[i - 1]);
      return resid[i - 1] + t * (resid[i] - resid[i - 1]);
    };
  }
  const kept = usePhase && m.keepTiming ? tau : 0;
  const H = freqs.map((f) => {
    const a = 10 ** ((it.mag(f) - refDb) / 20);
    const ph = ((minAt(f) + excessAt(f) - 360 * f * kept) * Math.PI) / 180;
    return { re: a * Math.cos(ph), im: a * Math.sin(ph) };
  });
  return {
    H,
    refDb,
    phaseSource: usePhase ? 'measured' : 'minimum',
    delayMs: usePhase ? tau * 1000 : 0,
    keptDelayMs: kept * 1000,
    extrapolated: freqs[0] < it.fMin * 0.999 || freqs[freqs.length - 1] > it.fMax * 1.001,
  };
}

/** The SPL measurement to use for a role: assigned to that role, for this driver (or any driver); exact driver match first, newest first. */
export function pickMeasurement(list: Measurement[], role: MeasurementRole, driverId: string | undefined): Measurement | undefined {
  const c = list.filter((m) => m.kind === 'spl' && m.role === role && (!m.driverId || m.driverId === driverId) && usablePoints(m).length >= 10);
  c.sort((a, b) => Number(b.driverId === driverId) - Number(a.driverId === driverId) || b.importedAt.localeCompare(a.importedAt));
  return c[0];
}

export interface CrossoverInputs {
  wooferH: Complex[];
  /** measured tweeter (relative, 0 dB = its passband) or null = ideal roll-off */
  tweeterH: Complex[] | null;
  /** the tweeter with sensDb re-based on the measured levels when both drivers are measured */
  tweeter: DriverInfo;
  tweeterOffsetMm: number;
  sources: { woofer: string; tweeter: string };
  notes: string[];
}

const fmtMs = (ms: number) => `${ms.toFixed(2)} ms`;

function describe(m: Measurement, r: MeasuredResponse): string {
  let s = `measured: “${m.name}”, ${r.phaseSource === 'measured' ? 'its own phase' : 'minimum phase from the magnitude'}`;
  if (r.phaseSource === 'measured') s += r.keptDelayMs ? ` (timing kept: ${fmtMs(r.keptDelayMs)})` : ` (${fmtMs(r.delayMs)} delay removed)`;
  return s;
}

/**
 * Swap the simulated woofer / ideal tweeter for measurements assigned to
 * those roles (SPL, for this driver or unassigned). Levels: each measurement
 * is normalised to its own passband (woofer: 150 Hz…fc/2, tweeter:
 * 2fc…min(4fc, 16 kHz)); if both are measured their difference replaces the
 * datasheet sensitivities in the level match (assumes the same drive voltage
 * and mic distance). The geometric acoustic offset stays unless both keep
 * their measured timing, which already contains it.
 */
export function crossoverInputs(
  list: Measurement[],
  woofer: DriverInfo,
  tweeter: DriverInfo,
  freqs: number[],
  simWooferH: Complex[],
  tweeterOffsetMm: number,
  fcHz: number,
): CrossoverInputs {
  const out: CrossoverInputs = {
    wooferH: simWooferH,
    tweeterH: null,
    tweeter,
    tweeterOffsetMm,
    sources: { woofer: 'simulated (box model + baffle step)', tweeter: `ideal 2nd-order roll-off at its Fs (${tweeter.fsHz} Hz, Q ${tweeter.qts})` },
    notes: [],
  };
  const mw = pickMeasurement(list, 'woofer', woofer.id);
  const mt = pickMeasurement(list, 'tweeter', tweeter.id);
  let rw: MeasuredResponse | null = null;
  let rt: MeasuredResponse | null = null;
  try {
    if (mw) rw = measuredResponse(mw, freqs, [150, Math.max(300, fcHz / 2)]);
  } catch (e) {
    out.notes.push(`Woofer measurement not used: ${(e as Error).message}`);
  }
  try {
    if (mt) rt = measuredResponse(mt, freqs, [2 * fcHz, Math.min(4 * fcHz, 16000)]);
  } catch (e) {
    out.notes.push(`Tweeter measurement not used: ${(e as Error).message}`);
  }
  if (mw && rw) {
    out.wooferH = rw.H;
    out.sources.woofer = describe(mw, rw);
    if (rw.extrapolated) out.notes.push(`“${mw.name}” doesn't cover the whole graph; outside ${Math.round(usablePoints(mw)[0].f)}–${Math.round(usablePoints(mw).at(-1)!.f)} Hz it's continued along its end slopes.`);
  }
  if (mt && rt) {
    out.tweeterH = rt.H;
    out.sources.tweeter = describe(mt, rt);
    if (rt.extrapolated) out.notes.push(`“${mt.name}” doesn't cover the whole graph; outside ${Math.round(usablePoints(mt)[0].f)}–${Math.round(usablePoints(mt).at(-1)!.f)} Hz it's continued along its end slopes.`);
  }
  if (rw && rt) {
    out.tweeter = { ...tweeter, sensDb: woofer.sensDb + (rt.refDb - rw.refDb) };
    out.notes.push(`Level match from the two measurements: tweeter ${(rt.refDb - rw.refDb).toFixed(1)} dB vs the woofer (same voltage and mic distance assumed).`);
    if (rw.keptDelayMs && rt.keptDelayMs) {
      out.tweeterOffsetMm = 0;
      out.notes.push('Both measurements keep their timing, so the acoustic offset comes from them (the geometric estimate is not added).');
    }
  } else if ((rw?.keptDelayMs || rt?.keptDelayMs) && !(rw && rt)) {
    out.notes.push('“Keep timing” needs both drivers measured with the same timing reference; ignored for the crossover sum.');
    // fall back: strip the kept delay again
    if (mw && rw && rw.keptDelayMs) out.wooferH = measuredResponse({ ...mw, keepTiming: false }, freqs, [150, Math.max(300, fcHz / 2)]).H;
    if (mt && rt && rt.keptDelayMs) out.tweeterH = measuredResponse({ ...mt, keepTiming: false }, freqs, [2 * fcHz, Math.min(4 * fcHz, 16000)]).H;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Impedance: T/S estimates and a simple driver model
// ---------------------------------------------------------------------------

export interface TsEstimate {
  fsHz: number;
  zMaxOhm: number;
  reOhm: number;
  reSource: 'entered' | 'minimum above Fs';
  qms: number;
  qes: number;
  qts: number;
  /** −3 dB-style points where |Z| = √(Zmax·Re) */
  f1Hz: number;
  f2Hz: number;
  notes: string[];
}

/**
 * Estimate Fs, Qms, Qes, Qts from a free-air impedance sweep (standard
 * "impedance peak" method):
 *   r0 = Zmax / Re;  f1, f2 where |Z| = Re·√r0 either side of the peak;
 *   Fs = √(f1·f2);  Qms = Fs·√r0 / (f2 − f1);  Qes = Qms / (r0 − 1);  Qts = Qms·Qes / (Qms + Qes).
 * Re: the value entered (from a DC ohmmeter — best) or else the lowest |Z|
 * above the peak, which reads a little high because of the voice-coil
 * inductance (that makes Qes/Qts come out a little low). Vas needs an
 * added-mass or known-box second sweep and is not estimated.
 */
export function estimateTS(points: MeasPoint[], reOhm?: number): TsEstimate | null {
  if (points.length < 10) return null;
  const notes: string[] = [];
  // light smoothing so a noisy point isn't taken for the peak
  const sm = smoothOctave(points, 24);
  const z = sm.map((p) => p.mag);
  const f = sm.map((p) => p.f);
  // interior local maxima; pick the most prominent (peak / lowest |Z| after it)
  const peaks: { i: number; prom: number }[] = [];
  for (let i = 1; i < z.length - 1; i++) {
    if (z[i] >= z[i - 1] && z[i] > z[i + 1]) {
      let after = Infinity;
      for (let k = i + 1; k < z.length; k++) after = Math.min(after, z[k]);
      let before = Infinity;
      for (let k = 0; k < i; k++) before = Math.min(before, z[k]);
      const prom = z[i] / Math.max(after, 1e-9);
      if (prom > 1.2 && z[i] / Math.max(before, 1e-9) > 1.05) peaks.push({ i, prom });
    }
  }
  if (!peaks.length) return null;
  const sig = peaks.filter((p) => p.prom > 1.5);
  if (sig.length >= 2) notes.push('Two impedance peaks: this looks like a vented box (or a driver in a box), not a free-air sweep. The numbers below describe the main peak only.');
  const pk = peaks.reduce((a, b) => (b.prom > a.prom ? b : a));
  // refine the peak with the unsmoothed data near it
  let iMax = 0;
  let zMax = 0;
  for (let k = 0; k < points.length; k++)
    if (points[k].f > f[pk.i] / 1.2 && points[k].f < f[pk.i] * 1.2 && points[k].mag > zMax) {
      zMax = points[k].mag;
      iMax = k;
    }
  let re = reOhm && reOhm > 0 ? reOhm : NaN;
  let reSource: TsEstimate['reSource'] = 'entered';
  if (!Number.isFinite(re)) {
    re = Infinity;
    for (let k = iMax; k < points.length; k++) re = Math.min(re, points[k].mag);
    reSource = 'minimum above Fs';
    notes.push('Re taken as the lowest impedance above Fs, which reads slightly high (voice-coil inductance): enter the DC resistance from an ohmmeter for better Qes/Qts.');
  }
  if (!(zMax > re * 1.05)) return null;
  const r0 = zMax / re;
  const target = re * Math.sqrt(r0);
  // crossings either side, interpolated in ln f
  const cross = (dir: -1 | 1): number => {
    for (let k = iMax; k + dir >= 0 && k + dir < points.length; k += dir) {
      const a = points[k];
      const b = points[k + dir];
      if ((a.mag - target) * (b.mag - target) <= 0 && a.mag !== b.mag) {
        const t = (target - a.mag) / (b.mag - a.mag);
        return Math.exp(Math.log(a.f) + t * (Math.log(b.f) - Math.log(a.f)));
      }
    }
    return NaN;
  };
  const f1 = cross(-1);
  const f2 = cross(1);
  if (!Number.isFinite(f1) || !Number.isFinite(f2) || f2 <= f1) return null;
  const fs = Math.sqrt(f1 * f2);
  const qms = (fs * Math.sqrt(r0)) / (f2 - f1);
  const qes = qms / (r0 - 1);
  const qts = (qms * qes) / (qms + qes);
  if (Math.abs(fs / points[iMax].f - 1) > 0.1) notes.push(`The peak (${points[iMax].f.toFixed(0)} Hz) and √(f1·f2) (${fs.toFixed(0)} Hz) disagree: the peak is lopsided, so treat these as rough.`);
  return { fsHz: fs, zMaxOhm: zMax, reOhm: re, reSource, qms, qes, qts, f1Hz: f1, f2Hz: f2, notes };
}

/**
 * Free-air impedance of a driver from its datasheet T/S (|Z| in Ω):
 *   Z = Re + jωLe + Res / (1 + j·Qms·(f/Fs − Fs/f)),   Res = Re·Qms/Qes.
 * Missing Qms/Qes: Qms = 4 assumed, Qes from Qts. Approximate (Le as a pure inductor).
 */
export function driverImpedance(d: DriverInfo, f: number): { ohm: number; deg: number } {
  const qms = d.qms && d.qms > 0 ? d.qms : 4;
  let qes = d.qes && d.qes > 0 ? d.qes : 1 / (1 / Math.max(d.qts, 0.05) - 1 / qms);
  if (!(qes > 0)) qes = d.qts;
  const res = (d.reOhm * qms) / qes;
  const x = qms * (f / d.fsHz - d.fsHz / f);
  // res / (1 + jx) = res (1 − jx) / (1 + x²)
  const re = d.reOhm + res / (1 + x * x);
  const im = (2 * Math.PI * f * (d.leMh ?? 0)) / 1000 - (res * x) / (1 + x * x);
  return { ohm: Math.hypot(re, im), deg: (Math.atan2(im, re) * 180) / Math.PI };
}

/** A role guess from a file name ("tweeter_0deg.frd" → tweeter). */
export function roleFromName(name: string): MeasurementRole | undefined {
  const n = name.toLowerCase().replace(/\.[^.]+$/, '');
  const tok = new Set(n.split(/[^a-z]+/).filter(Boolean));
  const has = (...w: string[]) => w.some((x) => tok.has(x));
  if (/tweet|ribbon/.test(n) || has('tw', 'hf', 'dome', 'amt')) return 'tweeter';
  if (/woof|bass/.test(n) || has('wf', 'lf', 'mid', 'midwoofer', 'mw')) return 'woofer';
  if (/system/.test(n) || has('sys', 'sum', 'speaker', 'full', 'fullrange')) return 'system';
  return undefined;
}

/** A fresh Measurement from parsed data. */
export function newMeasurement(fileName: string, r: ParseResult, now = new Date()): Measurement {
  const base = fileName.replace(/\.[^.]+$/, '') || 'Measurement';
  return {
    id: `ms-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: base,
    kind: r.kind,
    role: roleFromName(fileName),
    points: decimate(r.points),
    importedAt: now.toISOString(),
    note: r.warnings.join(' '),
    fileName,
  };
}
