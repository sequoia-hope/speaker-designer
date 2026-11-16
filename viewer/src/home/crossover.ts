// Two-way crossover helper: summed response of a woofer + tweeter through an
// ideal (analog-prototype) crossover, DSP biquad coefficients for the same
// filters, and a textbook passive network.
//
// Conventions
//   - Time dependence e^{+jωt}, so s = jω and a delay τ multiplies a response
//     by e^{-jωτ} (phase falls with frequency).
//   - Responses are relative: the woofer's passband (wooferH, incl. its box) is
//     normalised to ≈1, i.e. 0 dB = the woofer's sensitivity. The tweeter is
//     scaled by its sensitivity relative to the woofer's, minus the automatic
//     level match, plus the user trim `tweeterLevelDb`.
//   - `tweeterOffsetMm` > 0 means the tweeter's acoustic centre sits BEHIND the
//     woofer's (typical on a flat baffle: the woofer's voice coil is deeper
//     than the dome, so in practice it is usually negative, but a waveguide
//     can push the dome back). Sound from a source further back arrives later:
//     tweeter delay = offset / c.
//   - `delayTweeterMs` is an extra electrical delay on the tweeter channel
//     (DSP). Negative = delay the woofer instead; only the difference matters.
//   - `invertTweeter` flips the tweeter's polarity (×−1). LR2 needs it (the
//     two sections are 180° apart at fc); LR4 does not.
//   - Filters: LR2 = (1st-order Butterworth)², LR4 = (2nd-order Butterworth)²,
//     BW3 = 3rd-order Butterworth. f' = f/fc, s' = j·f'.

import type { DriverInfo } from './drivers';
import { SPEED_OF_SOUND, cmul, cdiv, cscale, toDb } from './roomAcoustics';
import type { Complex } from './roomAcoustics';

export type { Complex };

export type XoType = 'LR2' | 'LR4' | 'BW3';

export interface XoOpts {
  fcHz: number;
  type: XoType;
  /** relative trim (dB) on top of the automatic sensitivity level match */
  tweeterLevelDb: number;
  /** + = tweeter acoustic centre behind the woofer's (mm) */
  tweeterOffsetMm: number;
  invertTweeter: boolean;
  /** extra electrical delay on the tweeter (ms); negative = delay the woofer */
  delayTweeterMs?: number;
  /** treat the tweeter as flat (ignore its own Fs/Qts roll-off) — for reference checks */
  skipTweeterHp?: boolean;
  /**
   * measured tweeter response on the same freqs as wooferH (relative: 1 = its
   * passband level, see measurements.ts). Replaces the ideal Fs/Qts roll-off.
   */
  tweeterH?: Complex[] | null;
}

const cx = (re: number, im = 0): Complex => ({ re, im });
const cadd = (a: Complex, b: Complex): Complex => cx(a.re + b.re, a.im + b.im);
const cexpj = (phi: number): Complex => cx(Math.cos(phi), Math.sin(phi));
const carg = (a: Complex) => Math.atan2(a.im, a.re);

// ---------------------------------------------------------------------------
// Analog prototypes
// ---------------------------------------------------------------------------

/** Normalised denominator polynomials in s' (ascending powers), per type. */
function denom(type: XoType): number[] {
  switch (type) {
    case 'LR2':
      return [1, 2, 1]; // (1 + s')²
    case 'LR4':
      return [1, 2 * Math.SQRT2, 4, 2 * Math.SQRT2, 1]; // (s'² + √2 s' + 1)²
    case 'BW3':
      return [1, 2, 2, 1]; // (1 + s')(1 + s' + s'²)
  }
}

function polyAt(c: number[], s: Complex): Complex {
  let acc = cx(0);
  for (let k = c.length - 1; k >= 0; k--) acc = cadd(cmul(acc, s), cx(c[k]));
  return acc;
}

function spow(s: Complex, n: number): Complex {
  let r = cx(1);
  for (let i = 0; i < n; i++) r = cmul(r, s);
  return r;
}

/** Ideal electrical low-pass of the crossover at f (analog prototype). */
export function xoLowPass(type: XoType, fcHz: number, f: number): Complex {
  const s = cx(0, f / fcHz);
  return cdiv(cx(1), polyAt(denom(type), s));
}

/** Ideal electrical high-pass of the crossover at f (analog prototype). */
export function xoHighPass(type: XoType, fcHz: number, f: number): Complex {
  const d = denom(type);
  const s = cx(0, f / fcHz);
  return cdiv(spow(s, d.length - 1), polyAt(d, s));
}

/**
 * A dome tweeter's own low-end roll-off: 2nd-order high-pass at Fs with
 * Q = Qts (Qts missing/invalid → 1.0), unit gain in the passband.
 *   H(s) = s² / (s² + s·ωs/Q + ωs²)
 */
export function tweeterResponse(tw: DriverInfo, f: number): Complex {
  const q = tw.qts > 0 && Number.isFinite(tw.qts) ? tw.qts : 1.0;
  const w = f / tw.fsHz;
  return cdiv(cx(-w * w), cx(1 - w * w, w / q));
}

// ---------------------------------------------------------------------------
// Summation
// ---------------------------------------------------------------------------

export interface TwoWayResult {
  freqs: number[];
  sum: Complex[];
  woofer: Complex[];
  tweeter: Complex[];
  sumDb: number[];
  wooferDb: number[];
  tweeterDb: number[];
  /** woofer phase − tweeter phase (deg, wrapped to (−180, 180]) */
  phaseDiffDeg: number[];
  /** attenuation the tweeter needs to match the woofer: tweeter.sensDb − woofer.sensDb (dB) */
  levelMatchDb: number;
  notes: string[];
}

/** Sensitivity-based level match: how many dB the tweeter must come down. */
export function levelMatchDb(woofer: DriverInfo, tweeter: DriverInfo): number {
  return tweeter.sensDb - woofer.sensDb;
}

/**
 * Tweeter output relative to the woofer's passband (linear): its extra
 * sensitivity (tweeter.sensDb − woofer.sensDb) plus the electrical gain
 * (−levelMatch + trim). With the automatic match these cancel, leaving the trim.
 */
function tweeterAcousticGain(woofer: DriverInfo, tweeter: DriverInfo, o: XoOpts): number {
  const lm = levelMatchDb(woofer, tweeter);
  const sensRel = tweeter.sensDb - woofer.sensDb;
  return 10 ** ((sensRel - lm + o.tweeterLevelDb) / 20);
}

/** Net tweeter delay relative to the woofer (s): acoustic offset + electrical delay. */
function tweeterDelayS(o: XoOpts): number {
  return o.tweeterOffsetMm / 1000 / SPEED_OF_SOUND + (o.delayTweeterMs ?? 0) / 1000;
}

function tweeterAt(f: number, i: number, tweeter: DriverInfo, o: XoOpts, gain: number, tauS: number): Complex {
  let t = xoHighPass(o.type, o.fcHz, f);
  const meas = o.tweeterH?.[i];
  if (meas) t = cmul(t, meas);
  else if (!o.skipTweeterHp) t = cmul(t, tweeterResponse(tweeter, f));
  t = cmul(t, cexpj(-2 * Math.PI * f * tauS));
  return cscale(t, o.invertTweeter ? -gain : gain);
}

function wrapDeg(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

export function twoWaySum(freqs: number[], wooferH: Complex[], woofer: DriverInfo, tweeter: DriverInfo, o: XoOpts): TwoWayResult {
  const lm = levelMatchDb(woofer, tweeter);
  const gain = tweeterAcousticGain(woofer, tweeter, o);
  const tau = tweeterDelayS(o);
  const W: Complex[] = [];
  const T: Complex[] = [];
  const S: Complex[] = [];
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    const w = cmul(xoLowPass(o.type, o.fcHz, f), wooferH[i] ?? cx(1));
    const t = tweeterAt(f, i, tweeter, o, gain, tau);
    W.push(w);
    T.push(t);
    S.push(cadd(w, t));
  }
  const notes: string[] = [];
  if (lm > 0) notes.push(`Tweeter is ${lm.toFixed(1)} dB more sensitive than the woofer: pad it down by that much (L-pad or DSP gain).`);
  else if (lm < 0)
    notes.push(`Tweeter is ${(-lm).toFixed(1)} dB LESS sensitive than the woofer: a passive network cannot boost it — pad the woofer or use DSP gain.`);
  if (o.tweeterLevelDb) notes.push(`Tweeter trim ${o.tweeterLevelDb > 0 ? '+' : ''}${o.tweeterLevelDb.toFixed(1)} dB on top of the level match.`);
  if (o.type === 'LR2' && !o.invertTweeter) notes.push('LR2 sections are 180° apart at fc: wire the tweeter inverted or the sum has a deep null at the crossover.');
  if (o.type === 'BW3') notes.push('BW3 sums flat in magnitude with either polarity, but the drivers are 90° apart at fc (lobing tilts up or down).');
  if (!o.skipTweeterHp && !o.tweeterH && o.fcHz < 2 * tweeter.fsHz)
    notes.push(`Crossover at ${o.fcHz.toFixed(0)} Hz is below 2 × the tweeter's Fs (${tweeter.fsHz.toFixed(0)} Hz): its own roll-off and excursion will dominate.`);
  if (Math.abs(tau) > 1e-7)
    notes.push(`Net tweeter delay ${(tau * 1000).toFixed(3)} ms (${o.tweeterOffsetMm.toFixed(0)} mm offset${o.delayTweeterMs ? ` + ${o.delayTweeterMs.toFixed(3)} ms electrical` : ''}).`);
  return {
    freqs: freqs.slice(),
    sum: S,
    woofer: W,
    tweeter: T,
    sumDb: S.map(toDb),
    wooferDb: W.map(toDb),
    tweeterDb: T.map(toDb),
    phaseDiffDeg: W.map((w, i) => wrapDeg(((carg(w) - carg(T[i])) * 180) / Math.PI)),
    levelMatchDb: lm,
    notes,
  };
}

export interface DelaySearch {
  /** electrical tweeter delay to set as XoOpts.delayTweeterMs (negative = delay the woofer) */
  delayMs: number;
  invertTweeter: boolean;
  /** worst |sum| deviation from 0 dB within ±1 octave of fc */
  maxDevDb: number;
  rmsDevDb: number;
}

/**
 * Brute-force search over the electrical tweeter delay (and polarity) for the
 * flattest sum within fc/2..2fc: minimises the worst |sumDb| (0 dB = woofer
 * passband), RMS as tie-break. Coarse 10 µs grid over ±rangeMs around the
 * delay that cancels the acoustic offset, then a 0.5 µs refinement.
 */
export function bestTweeterDelayMs(
  freqs: number[],
  wooferH: Complex[],
  woofer: DriverInfo,
  tweeter: DriverInfo,
  o: XoOpts,
  rangeMs = 0.5,
): DelaySearch {
  const idx = freqs.map((f, i) => (f >= o.fcHz / 2 && f <= o.fcHz * 2 ? i : -1)).filter((i) => i >= 0);
  const fs = idx.map((i) => freqs[i]);
  const wh = idx.map((i) => wooferH[i] ?? cx(1));
  const lp = fs.map((f, k) => cmul(xoLowPass(o.type, o.fcHz, f), wh[k]));
  const gain = tweeterAcousticGain(woofer, tweeter, o);
  const base = idx.map((i) => tweeterAt(freqs[i], i, tweeter, { ...o, invertTweeter: false, tweeterOffsetMm: 0, delayTweeterMs: 0 }, gain, 0));
  const offS = o.tweeterOffsetMm / 1000 / SPEED_OF_SOUND;
  const score = (delayMs: number, inv: boolean) => {
    const tau = offS + delayMs / 1000;
    let mx = 0;
    let ss = 0;
    for (let k = 0; k < fs.length; k++) {
      const t = cmul(base[k], cexpj(-2 * Math.PI * fs[k] * tau));
      const s = cadd(lp[k], inv ? cscale(t, -1) : t);
      const d = Math.abs(toDb(s));
      mx = Math.max(mx, d);
      ss += d * d;
    }
    return { mx, rms: fs.length ? Math.sqrt(ss / fs.length) : 0 };
  };
  const better = (a: { mx: number; rms: number }, b: { mx: number; rms: number }) => a.mx < b.mx - 1e-9 || (Math.abs(a.mx - b.mx) <= 1e-9 && a.rms < b.rms);
  const centre = -offS * 1000;
  let best = { delayMs: centre, inv: o.invertTweeter, ...score(centre, o.invertTweeter) };
  for (const inv of [false, true]) {
    for (let d = centre - rangeMs; d <= centre + rangeMs + 1e-12; d += 0.01) {
      const s = score(d, inv);
      if (better(s, best)) best = { delayMs: d, inv, ...s };
    }
  }
  const c0 = best.delayMs;
  for (let d = c0 - 0.01; d <= c0 + 0.01 + 1e-12; d += 0.0005) {
    const s = score(d, best.inv);
    if (better(s, best)) best = { delayMs: d, inv: best.inv, ...s };
  }
  return { delayMs: best.delayMs, invertTweeter: best.inv, maxDevDb: best.mx, rmsDevDb: best.rms };
}

// ---------------------------------------------------------------------------
// DSP: RBJ-cookbook biquads
// ---------------------------------------------------------------------------

/** Normalised biquad (a0 = 1): y = b0·x + b1·x₁ + b2·x₂ − a1·y₁ − a2·y₂ */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface DspSettings {
  woofer: Biquad[];
  tweeter: Biquad[];
  /** whole-sample delays (rounded) — only one of them is non-zero */
  delayWooferSamples: number;
  delayTweeterSamples: number;
  /** tweeter channel gain (dB) = −levelMatchDb + trim */
  tweeterGainDb: number;
  invertTweeter: boolean;
  summary: string[];
}

/** RBJ cookbook 2nd-order LP/HP at f0 with quality Q. */
function rbj(kind: 'lp' | 'hp', f0: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (kind === 'lp' ? (1 - cw) / 2 : (1 + cw) / 2) / a0;
  const b1 = (kind === 'lp' ? 1 - cw : -(1 + cw)) / a0;
  return { b0, b1, b2: b0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

/** 1st-order LP/HP by the bilinear transform pre-warped at f0 (as a biquad with b2 = a2 = 0). */
function firstOrder(kind: 'lp' | 'hp', f0: number, fs: number): Biquad {
  const K = Math.tan((Math.PI * f0) / fs);
  const a1 = (K - 1) / (K + 1);
  return kind === 'lp' ? { b0: K / (1 + K), b1: K / (1 + K), b2: 0, a1, a2: 0 } : { b0: 1 / (1 + K), b1: -1 / (1 + K), b2: 0, a1, a2: 0 };
}

/** H(e^{jωT}) of a biquad cascade at frequency f. */
export function evalBiquads(bqs: Biquad[], f: number, sampleRateHz: number): Complex {
  const w = (2 * Math.PI * f) / sampleRateHz;
  const z1 = cexpj(-w);
  const z2 = cexpj(-2 * w);
  let h = cx(1);
  for (const q of bqs) {
    const num = cadd(cadd(cx(q.b0), cscale(z1, q.b1)), cscale(z2, q.b2));
    const den = cadd(cadd(cx(1), cscale(z1, q.a1)), cscale(z2, q.a2));
    h = cmul(h, cdiv(num, den));
  }
  return h;
}

const fmtHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);

/**
 * Biquad coefficients for a DSP two-way. The acoustic offset is NOT
 * compensated here — set `delayTweeterMs` (e.g. from bestTweeterDelayMs).
 * `levelMatch` = levelMatchDb(woofer, tweeter) if known (default 0).
 */
export function biquads(o: XoOpts, sampleRateHz: number, levelMatch = 0): DspSettings {
  const fc = o.fcHz;
  const fs = sampleRateHz;
  let woofer: Biquad[];
  let tweeter: Biquad[];
  let how: string;
  switch (o.type) {
    case 'LR2':
      // (1 + s')² = one 2nd-order section with Q = 0.5 (identical to two cascaded 1st-order)
      woofer = [rbj('lp', fc, 0.5, fs)];
      tweeter = [rbj('hp', fc, 0.5, fs)];
      how = 'one biquad, Q 0.5';
      break;
    case 'LR4':
      woofer = [rbj('lp', fc, Math.SQRT1_2, fs), rbj('lp', fc, Math.SQRT1_2, fs)];
      tweeter = [rbj('hp', fc, Math.SQRT1_2, fs), rbj('hp', fc, Math.SQRT1_2, fs)];
      how = 'two Butterworth biquads, Q 0.707';
      break;
    case 'BW3':
      // (1 + s')(1 + s' + s'²): a 1st-order section and a Q = 1 biquad
      woofer = [firstOrder('lp', fc, fs), rbj('lp', fc, 1, fs)];
      tweeter = [firstOrder('hp', fc, fs), rbj('hp', fc, 1, fs)];
      how = '1st-order section + biquad Q 1.0';
      break;
  }
  const dMs = o.delayTweeterMs ?? 0;
  const samples = Math.round((Math.abs(dMs) / 1000) * fs);
  const tweeterGainDb = -levelMatch + o.tweeterLevelDb;
  const summary = [
    `Low-pass ${fmtHz(fc)} ${o.type} (${how}) on the woofer`,
    `High-pass ${fmtHz(fc)} ${o.type} (${how}) on the tweeter`,
    `Tweeter gain ${tweeterGainDb >= 0 ? '+' : ''}${tweeterGainDb.toFixed(1)} dB${o.invertTweeter ? ', polarity inverted' : ''}`,
  ];
  if (samples) summary.push(`Delay ${dMs > 0 ? 'tweeter' : 'woofer'} ${Math.abs(dMs).toFixed(3)} ms (${samples} samples @ ${fs} Hz)`);
  return {
    woofer,
    tweeter,
    delayWooferSamples: dMs < 0 ? samples : 0,
    delayTweeterSamples: dMs > 0 ? samples : 0,
    tweeterGainDb,
    invertTweeter: o.invertTweeter,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Passive network
// ---------------------------------------------------------------------------

export interface PassivePart {
  ref: string;
  kind: 'L' | 'C' | 'R';
  /** mH for L, µF for C, Ω for R */
  value: number;
  unit: 'mH' | 'µF' | 'Ω';
  /** 'series' with the driver or 'shunt' across it */
  placement: 'series' | 'shunt';
  note: string;
}

export interface PassiveNetwork {
  order: number;
  woofer: PassivePart[];
  tweeter: PassivePart[];
  wooferZobel?: PassivePart[];
  tweeterLPad?: PassivePart[];
  invertTweeter: boolean;
  caveat: string;
}

/**
 * Normalised ladder elements (ωc = 1, R = 1) for a zero-source-impedance
 * low-pass terminated in R, amp side first: series L, shunt C, series L, …
 *   2nd order: H = 1/(s²LC + sL/R + 1) → L = R/(ωc·Q), C = Q/(ωc·R)
 *     Butterworth Q = 1/√2: L = √2·R/ωc = 0.2251·R/f, C = 1/(√2·ωc·R) = 0.1125/(R·f)
 *     LR2        Q = 1/2  : L = 2·R/ωc  = 0.3183·R/f, C = 1/(2·ωc·R)  = 0.0796/(R·f)
 *   3rd-order Butterworth (Dickason, LDC table): L1 = 3/2, C2 = 4/3, L3 = 1/2
 *     → 0.2387·R/f, 0.2122/(R·f), 0.0796·R/f
 *   4th-order LR, matching (s²+√2s+1)² term by term: L1 = 4√2/3, C2 = 9/(4√2),
 *     L3 = 2√2/3, C4 = 1/(2√2) → 0.3001·R/f, 0.2533/(R·f), 0.1501·R/f, 0.0563/(R·f)
 * The high-pass is the s → 1/s dual: each series L becomes a series C of
 * value 1/g, each shunt C a shunt L of 1/g (e.g. LR4 HP: 0.0844/(R·f),
 * 0.1000·R/f, 0.1688/(R·f), 0.4502·R/f).
 * Denormalise: L = g·R/ωc, C = g/(ωc·R).
 */
function ladder(type: XoType): number[] {
  switch (type) {
    case 'LR2':
      return [2, 0.5];
    case 'LR4':
      return [(4 * Math.SQRT2) / 3, 9 / (4 * Math.SQRT2), (2 * Math.SQRT2) / 3, 1 / (2 * Math.SQRT2)];
    case 'BW3':
      return [1.5, 4 / 3, 0.5];
  }
}

/** 2nd-order Butterworth ladder (Q = 1/√2) — not one of the XoTypes, exported for completeness. */
export const BW2_LADDER = [Math.SQRT2, Math.SQRT1_2];

function buildLadder(g: number[], R: number, fc: number, side: 'lp' | 'hp', prefix: string): PassivePart[] {
  const wc = 2 * Math.PI * fc;
  return g.map((gi, k) => {
    const series = k % 2 === 0;
    // LP: series L, shunt C. HP: series C (1/g), shunt L (1/g).
    const isL = side === 'lp' ? series : !series;
    const gv = side === 'lp' ? gi : 1 / gi;
    const value = isL ? ((gv * R) / wc) * 1e3 : (gv / (wc * R)) * 1e6;
    return {
      ref: `${prefix}${isL ? 'L' : 'C'}${k + 1}`,
      kind: isL ? 'L' : 'C',
      value,
      unit: isL ? 'mH' : 'µF',
      placement: series ? 'series' : 'shunt',
      note: `${series ? 'series' : 'across the driver'}${k === 0 ? ' (amp side)' : k === g.length - 1 ? ' (driver side)' : ''}`,
    } as PassivePart;
  });
}

/** Textbook passive two-way into the drivers' nominal impedances. */
export function passiveNetwork(o: XoOpts, woofer: DriverInfo, tweeter: DriverInfo): PassiveNetwork {
  const g = ladder(o.type);
  const net: PassiveNetwork = {
    order: g.length,
    woofer: buildLadder(g, woofer.nominalOhm, o.fcHz, 'lp', 'W'),
    // the L-pad is designed to present the tweeter's nominal impedance, so the HP sees the same R
    tweeter: buildLadder(g, tweeter.nominalOhm, o.fcHz, 'hp', 'T'),
    invertTweeter: o.type === 'LR2' ? true : o.invertTweeter,
    caveat:
      'Textbook values assume each driver is a pure resistance equal to its nominal impedance and a zero-impedance source. ' +
      "Real drivers rise in impedance with frequency (voice-coil inductance) and peak at Fs, and their acoustic responses aren't flat, " +
      'so the acoustic slopes, crossover point and summation will differ. Use this as a starting point only: a real design needs ' +
      'measured frequency/phase responses and impedance of the drivers in the actual box, then optimisation in a crossover simulator.',
  };
  if (woofer.leMh != null && woofer.leMh > 0) {
    // Zobel: Rz = 1.25·Re, Cz = Le/Rz² (cancels the inductive rise above ~R/(2πLe))
    const Rz = 1.25 * woofer.reOhm;
    const Cz = (woofer.leMh / 1000 / (Rz * Rz)) * 1e6;
    net.wooferZobel = [
      { ref: 'WZR', kind: 'R', value: Rz, unit: 'Ω', placement: 'shunt', note: 'Zobel resistor, in series with WZC, across the woofer' },
      { ref: 'WZC', kind: 'C', value: Cz, unit: 'µF', placement: 'shunt', note: 'Zobel capacitor' },
    ];
  }
  const att = levelMatchDb(woofer, tweeter) - o.tweeterLevelDb;
  if (att > 0.05) {
    // L-pad for attenuation A into R: a = 10^(−A/20), Rs = R(1−a), Rp = R·a/(1−a);
    // input impedance Rs + Rp‖R = R, output/input = a.
    const R = tweeter.nominalOhm;
    const a = 10 ** (-att / 20);
    net.tweeterLPad = [
      { ref: 'TRs', kind: 'R', value: R * (1 - a), unit: 'Ω', placement: 'series', note: `L-pad series resistor (−${att.toFixed(1)} dB)` },
      { ref: 'TRp', kind: 'R', value: (R * a) / (1 - a), unit: 'Ω', placement: 'shunt', note: 'L-pad parallel resistor, across the tweeter' },
    ];
  }
  return net;
}
