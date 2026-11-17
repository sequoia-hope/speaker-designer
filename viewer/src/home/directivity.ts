// Off-axis (directivity) prediction for a dome tweeter, bare or in a printed
// round waveguide, and for the woofer it crosses to — so a waveguide can be
// chosen by its dispersion and its directivity matched at the crossover.
//
// Models
//
//   Bare dome / woofer — a rigid circular piston of radius a in an infinite
//   baffle (radius from the datasheet Sd):
//       D(θ) = 2·J1(ka·sinθ) / (ka·sinθ)
//   with the closed-form directivity index of the baffled piston
//       DI = 10·log10( (ka)² / (1 − J1(2ka)/(ka)) )      (→ 3 dB at LF).
//
//   Tweeter in a round waveguide — a numerical Rayleigh integral over the
//   mouth aperture with a spherical-cap wavefront:
//     - The oblate-spheroid flare r(z) = √(r0² + (z·tanα)²) has its asymptotic
//       cone apex at the throat centre (z = 0). Far down the flare the
//       wavefront is a spherical cap centred there, so at the mouth plane
//       (z = L, the end of the flare) a point at radius ρ lags the centre by
//       Δ(ρ) = √(L² + ρ²) − L.
//     - The normal particle velocity on that plane is that of a spherical wave
//       from the apex, v ∝ cos³ψ (ψ = atan(ρ/L)) — truncated at the mouth, this
//       reproduces a uniform field inside the cone and a −6 dB edge at the wall
//       angle, which is what "coverage" means.
//     - It is weighted by the dome's own piston directivity towards ψ,
//       2·J1(k·a_dome·sinψ)/(k·a_dome·sinψ): once the dome beams (k·a_dome ≫ 1)
//       it no longer fills the cone, so the pattern narrows again at the top.
//     - The rolled lip is a cos² taper from the flare end to the lip's outer
//       radius (a soft edge rather than a hard truncation).
//     - Far field of that aperture in an infinite baffle (axisymmetric):
//         p(θ) ∝ ∫₀^Rm v(ρ)·e^(−jkΔ(ρ))·J0(kρ·sinθ)·ρ dρ
//     So at low frequency the mouth radiates like a piston of the mouth radius
//     (wide; no pattern control while λ > mouth), in the mid/high band the cap
//     sets the coverage ≈ the wall angle, and at the very top the dome's own
//     beaming narrows it.
//
//   Directivity index (both): on-axis intensity over the mean over the front
//   hemisphere,  DI = 10·log10( 2 / ∫₀^{π/2} |D(θ)|² sinθ dθ ).
//
// Assumptions and limits (engineering approximations, not BEM)
//   - Infinite baffle: no cabinet edge diffraction, so the DI floors at 3 dB at
//     LF; on a real cabinet it falls towards 0 dB below the baffle step (a few
//     hundred Hz for a monitor), well below a tweeter crossover. The on-axis
//     baffle step is modelled separately in diffraction.ts; it is on-axis only,
//     so it is not folded in here. Both drivers share the baffle, so the DI
//     *match* at the crossover is not much affected.
//   - The wavefront is taken as a perfect spherical cap from the cone apex.
//     A real OS throat starts flat and becomes spherical only down the flare,
//     and higher-order modes / internal reflections (the HF "waist" or ripple
//     of real guides) are not modelled. Pistons are rigid (no cone breakup;
//     a real dome is a little wider than a flat piston at the top).
//   - What it predicts beyond "≈ nominal": a deep, narrow guide (60–75°)
//     narrows below nominal just above its control frequency, because the
//     cap's sag is still small in wavelengths and the mouth acts like a big
//     flat piston — the classic conical-horn mid-band narrowing; real OS guides
//     show it more mildly. A wide guide (≥ 105°) round a large-faceplate tweeter
//     is so shallow that the apex-to-mouth-edge angle exceeds the wall angle, so
//     it stays wider than nominal: physically fair (it is barely a guide), but
//     the exact width there is the least certain part of the model.
//   - The hard aperture edge (softened only by the lip taper) gives some
//     off-axis lobing / DI ripple in the upper octaves, as real guides with a
//     small roundover do; its exact frequencies are not to be trusted.
//   - Round guides only, so the vertical pattern equals the horizontal.
//   - Expect ±20 % on beamwidth and ~1 dB on DI versus measurements; good for
//     choosing a coverage angle and checking the crossover match, not for
//     fine voicing.

import { SPEED_OF_SOUND } from './roomAcoustics';
import type { DriverInfo } from './drivers';
import { roundWaveguide, type RoundWaveguide } from './hybrid';

const C = SPEED_OF_SOUND;
const D2R = Math.PI / 180;

/** Bessel J0 (Abramowitz & Stegun 9.4.1 / 9.4.3, |error| < 5e-8). */
export function besselJ0(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 3) {
    const y = (x / 3) * (x / 3);
    return 1 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.00021)))));
  }
  const y = 3 / ax;
  const f0 = 0.79788456 + y * (-0.00000077 + y * (-0.0055274 + y * (-0.00009512 + y * (0.00137237 + y * (-0.00072805 + y * 0.00014476)))));
  const t0 = ax - 0.78539816 + y * (-0.04166397 + y * (-0.00003954 + y * (0.00262573 + y * (-0.00054125 + y * (-0.00029333 + y * 0.00013558)))));
  return (f0 * Math.cos(t0)) / Math.sqrt(ax);
}

/** Bessel J1 (Abramowitz & Stegun 9.4.4 / 9.4.6, |error| < 1e-7). */
export function besselJ1(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 3) {
    const y = (x / 3) * (x / 3);
    return x * (0.5 + y * (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))));
  }
  const y = 3 / ax;
  const f1 = 0.79788456 + y * (0.00000156 + y * (0.01659667 + y * (0.00017105 + y * (-0.00249511 + y * (0.00113653 - y * 0.00020033)))));
  const t1 = ax - 2.35619449 + y * (0.12499612 + y * (0.0000565 + y * (-0.00637879 + y * (0.00074348 + y * (0.00079824 - y * 0.00029166)))));
  const j = (f1 * Math.cos(t1)) / Math.sqrt(ax);
  return x < 0 ? -j : j;
}

/** 2·J1(x)/x, = 1 at x = 0. */
export function jinc(x: number): number {
  return Math.abs(x) < 1e-6 ? 1 : (2 * besselJ1(x)) / x;
}

export type Radiator =
  | { kind: 'piston'; radiusM: number; label?: string }
  | {
      kind: 'waveguide';
      /** dome (piston) radius at the throat */
      domeRadiusM: number;
      /** flare end: radius and distance from the cone apex (throat centre) */
      flareEndRadiusM: number;
      flareLengthM: number;
      /** outer radius of the rolled lip = the aperture edge */
      mouthRadiusM: number;
      coverageDeg: number;
      label?: string;
    };

/** Effective piston radius (m) of a driver from its Sd. */
export function pistonRadiusM(d: DriverInfo): number {
  return Math.sqrt(d.sdCm2 / 1e4 / Math.PI);
}

export function pistonOf(d: DriverInfo): Radiator {
  return { kind: 'piston', radiusM: pistonRadiusM(d), label: d.model };
}

export function waveguideRadiator(wg: RoundWaveguide, tw: DriverInfo): Radiator {
  // the flare proper is the first 25 profile points; the rest is the rolled lip
  const end = wg.profile[Math.min(24, wg.profile.length - 1)];
  return {
    kind: 'waveguide',
    domeRadiusM: pistonRadiusM(tw),
    flareEndRadiusM: end[0] / 1000,
    flareLengthM: Math.max(end[1], 1) / 1000,
    mouthRadiusM: wg.R / 1000,
    coverageDeg: wg.coverageDeg,
    label: `${tw.model} in a ${wg.coverageDeg}° guide`,
  };
}

/** Complex far-field pattern of the waveguide aperture at angles θ (rad), normalised to on-axis. */
function waveguidePattern(r: Extract<Radiator, { kind: 'waveguide' }>, f: number, thetas: number[]): number[] {
  const k = (2 * Math.PI * f) / C;
  const Rm = r.mouthRadiusM;
  const L = r.flareLengthM;
  // radial midpoint rule; resolve both the cap phase and the J0 oscillation (≥ 6 points / rad)
  const N = Math.max(64, Math.ceil(k * Rm * 6));
  const dr = Rm / N;
  const wRe = new Float64Array(N);
  const wIm = new Float64Array(N);
  const rho = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const p = (i + 0.5) * dr;
    const s = Math.sqrt(L * L + p * p);
    const cosPsi = L / s;
    const sinPsi = p / s;
    let a = cosPsi ** 3 * jinc(k * r.domeRadiusM * sinPsi);
    if (p > r.flareEndRadiusM && Rm > r.flareEndRadiusM) {
      const u = (p - r.flareEndRadiusM) / (Rm - r.flareEndRadiusM);
      a *= Math.cos((u * Math.PI) / 2) ** 2;
    }
    const ph = -k * (s - L);
    wRe[i] = a * Math.cos(ph) * p * dr;
    wIm[i] = a * Math.sin(ph) * p * dr;
    rho[i] = p;
  }
  const mags: number[] = [];
  for (const th of thetas) {
    const ks = k * Math.sin(th);
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const j = besselJ0(ks * rho[i]);
      re += wRe[i] * j;
      im += wIm[i] * j;
    }
    mags.push(Math.hypot(re, im));
  }
  const m0 = thetas[0] === 0 ? mags[0] : waveguidePattern(r, f, [0])[0];
  return mags.map((m) => m / (m0 || 1));
}

/** |D(θ)| (linear, on-axis = 1) of a radiator at f for each θ in degrees. */
export function pattern(r: Radiator, f: number, anglesDeg: number[]): number[] {
  if (r.kind === 'piston') {
    const ka = ((2 * Math.PI * f) / C) * r.radiusM;
    return anglesDeg.map((a) => Math.abs(jinc(ka * Math.sin(a * D2R))));
  }
  const th = anglesDeg.map((a) => a * D2R);
  if (th[0] !== 0) return waveguidePattern(r, f, [0, ...th]).slice(1);
  return waveguidePattern(r, f, th);
}

const DI_ANGLES = Array.from({ length: 181 }, (_, i) => i * 0.5);

/** DI (dB) from |D| sampled on DI_ANGLES: trapezoidal hemisphere average. */
function diFromPattern(d: number[]): number {
  let s = 0;
  for (let i = 1; i < DI_ANGLES.length; i++) {
    const t0 = DI_ANGLES[i - 1] * D2R;
    const t1 = DI_ANGLES[i] * D2R;
    s += 0.5 * (d[i - 1] ** 2 * Math.sin(t0) + d[i] ** 2 * Math.sin(t1)) * (t1 - t0);
  }
  return 10 * Math.log10(2 / s);
}

/** Closed-form DI of a baffled piston of radius a at k·a. */
function pistonDi(ka: number): number {
  if (ka < 1e-3) return 10 * Math.log10(2);
  return 10 * Math.log10((ka * ka) / (1 - besselJ1(2 * ka) / ka));
}

/** Directivity index (dB) at f, relative to the front hemisphere (baffled: → 3 dB at LF). */
export function directivityIndex(r: Radiator, f: number): number {
  if (r.kind === 'piston') return pistonDi(((2 * Math.PI * f) / C) * r.radiusM);
  return diFromPattern(pattern(r, f, DI_ANGLES));
}

/** Full −6 dB beamwidth (degrees, 2× the first angle where the level falls 6 dB); 180 if it never does. */
export function beamwidth6(r: Radiator, f: number): number {
  const angles = Array.from({ length: 361 }, (_, i) => i * 0.25);
  const d = pattern(r, f, angles);
  const lim = 0.5;
  for (let i = 1; i < angles.length; i++) {
    if (d[i] < lim) {
      const t = (d[i - 1] - lim) / (d[i - 1] - d[i]);
      return 2 * (angles[i - 1] + t * (angles[i] - angles[i - 1]));
    }
  }
  return 180;
}

export interface PolarMap {
  freqs: number[];
  anglesDeg: number[];
  /** db[angle][freq], normalised to on-axis (0 dB on axis) */
  db: number[][];
  di: number[];
}

export function logFreqs(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo * (hi / lo) ** (i / (n - 1)));
}

/** Normalised off-axis levels on a grid of angles that are multiples of 0.5° (0…90), plus the DI. */
export function polarMap(r: Radiator, freqs: number[], anglesDeg: number[]): PolarMap {
  const idx = anglesDeg.map((a) => Math.round(a * 2));
  const db: number[][] = anglesDeg.map(() => []);
  const di: number[] = [];
  for (const f of freqs) {
    const d = pattern(r, f, DI_ANGLES);
    idx.forEach((j, i) => db[i].push(20 * Math.log10(Math.max(d[j], 1e-4))));
    di.push(r.kind === 'piston' ? directivityIndex(r, f) : diFromPattern(d));
  }
  return { freqs, anglesDeg, db, di };
}

export interface DiMatch {
  xoHz: number;
  wooferDi: number;
  tweeterDi: number;
  /** tweeter − woofer (dB) */
  deltaDb: number;
  ok: boolean;
  /** coverage (°) that best matches the woofer at this crossover, if a guide would help */
  suggestCoverageDeg: number | null;
  suggestDeltaDb: number | null;
  /** the best-matching coverage, when it would match better but doesn't fit the cabinet */
  blockedCoverageDeg: number | null;
  verdict: string;
}

export const DI_MATCH_TOL_DB = 1.5;
export const COVERAGE_RANGE = { min: 60, max: 120, step: 5 };

/**
 * How well the tweeter's DI (bare or in its guide) matches the woofer's at the
 * crossover, and the guide coverage that would match best.
 */
export function diMatch(
  woofer: DriverInfo,
  tw: DriverInfo,
  wg: RoundWaveguide | null,
  xoHz: number,
  wallMm = 4,
  crossoverHz?: number,
  /** whether a guide of this coverage still builds (default: all do) — only those are suggested */
  fits: (coverageDeg: number) => boolean = () => true,
): DiMatch {
  const wooferDi = directivityIndex(pistonOf(woofer), xoHz);
  const tweeterDi = directivityIndex(wg ? waveguideRadiator(wg, tw) : pistonOf(tw), xoHz);
  const deltaDb = tweeterDi - wooferDi;
  const ok = Math.abs(deltaDb) <= DI_MATCH_TOL_DB;
  let best: { cov: number; d: number } | null = null;
  let bestAny: { cov: number; d: number } | null = null;
  for (let cov = COVERAGE_RANGE.min; cov <= COVERAGE_RANGE.max; cov += COVERAGE_RANGE.step) {
    const g = roundWaveguide(tw, cov, wallMm, crossoverHz);
    const d = directivityIndex(waveguideRadiator(g, tw), xoHz) - wooferDi;
    if (!bestAny || Math.abs(d) < Math.abs(bestAny.d)) bestAny = { cov, d };
    if (fits(cov) && (!best || Math.abs(d) < Math.abs(best.d))) best = { cov, d };
  }
  const better = (b: { cov: number; d: number } | null) => !!b && Math.abs(b.d) < Math.abs(deltaDb) - 0.3 && (!wg || b.cov !== wg.coverageDeg);
  const suggestCoverageDeg = !ok && better(best) ? best!.cov : null;
  // the best match overall doesn't fit, and is clearly better than what does
  const blockedCoverageDeg = !ok && better(bestAny) && bestAny!.cov !== suggestCoverageDeg && (suggestCoverageDeg == null || Math.abs(bestAny!.d) < Math.abs(best!.d) - 0.3) ? bestAny!.cov : null;
  const suggestDeltaDb = suggestCoverageDeg != null ? best!.d : null;
  const fx = xoHz >= 1000 ? `${(xoHz / 1000).toFixed(1)} kHz` : `${Math.round(xoHz)} Hz`;
  let verdict: string;
  if (ok) verdict = `DI matches within ${Math.abs(deltaDb).toFixed(1)} dB at the ${fx} crossover.`;
  else if (suggestCoverageDeg != null)
    verdict = `Mismatch: the tweeter is ${Math.abs(deltaDb).toFixed(1)} dB ${deltaDb > 0 ? 'narrower' : 'wider'} than the woofer at ${fx} — try ${wg ? '' : 'a waveguide with '}coverage ${suggestCoverageDeg}° (${Math.abs(suggestDeltaDb!).toFixed(1)} dB).`;
  else if (blockedCoverageDeg != null)
    verdict = `Mismatch: the tweeter is ${Math.abs(deltaDb).toFixed(1)} dB ${deltaDb > 0 ? 'narrower' : 'wider'} than the woofer at ${fx}. A ${blockedCoverageDeg}° guide would match, but it doesn't fit this cabinet — widen it, or move the crossover ${deltaDb > 0 ? 'up' : 'down'}.`;
  else
    verdict = `Mismatch: the tweeter is ${Math.abs(deltaDb).toFixed(1)} dB ${deltaDb > 0 ? 'narrower' : 'wider'} than the woofer at ${fx}, and no coverage angle fixes it — move the crossover ${deltaDb > 0 ? 'up' : 'down'}.`;
  if (suggestCoverageDeg != null && blockedCoverageDeg != null) verdict += ` (${blockedCoverageDeg}° would match closer but doesn't fit this cabinet.)`;
  return { xoHz, wooferDi, tweeterDi, deltaDb, ok, suggestCoverageDeg, suggestDeltaDb, blockedCoverageDeg, verdict };
}
