// On-axis edge diffraction ("baffle step") of a driver on a finite front
// baffle, in the style of "The Edge" (secondary edge sources after Urban et
// al. and Vanderkooy, "A simple theory of cabinet edge diffraction", JAES 1991).
//
// Model
//   The driver is a point source (optionally with piston directivity) in the
//   baffle plane at (xd, yd). Its direct field reaches the on-axis listener at
//   distance R. Every perimeter element i re-radiates the field arriving at it
//   with a diffraction coefficient of −½, weighted by the angle dθᵢ it
//   subtends at the driver (Σ dθᵢ = 2π), and delayed by its extra path:
//
//     Δᵢ  = ρᵢ + √(ρᵢ² + R²) − R           ρᵢ = driver → edge distance
//     wᵢ  = (dθᵢ/2π)·(R/dᵢ) / Σⱼ (dθⱼ/2π)·(R/dⱼ)   dᵢ = edge → listener
//     H(f) = 1 − ½ · D(ka) · E(k) · Σᵢ wᵢ · e^(−j·k·Δᵢ)
//
//   H is the pressure relative to the same driver on an infinite baffle
//   (2π space), so H → ½ (−6 dB, 4π space) at low frequency and → 1 (0 dB)
//   with the familiar ripple above the step. The R/dᵢ spreading of each edge
//   source is renormalised so the LF limit is exactly −6 dB at any listening
//   distance (physically true: at LF the box radiates as a monopole).
//
//   D(ka) = 2·J1(ka)/(ka): the piston's directivity towards the baffle edge
//   (90° off axis), so the edges are fed less as the driver beams.
//
//   E(k) = 1 / (1 + (k·rₑ·C_ROUND)²) for an edge roundover of radius rₑ.
//   ENGINEERING APPROXIMATION, not a solution of the curved-edge problem: a
//   roundover diffracts like a sharp edge while λ ≫ rₑ and progressively less
//   once λ is comparable to rₑ. C_ROUND = 1 puts the half-strength point at
//   k·rₑ = 1 (λ ≈ 6·rₑ), roughly matching published measurements (e.g. a
//   20 mm roundover being effective above ~2–3 kHz). It ignores the small
//   shift of the effective edge position and any phase change.
//
//   shape 'ellipse' samples the ellipse inscribed in width × height instead
//   of the rectangle (an oval/curved front). The outline is treated as a
//   sharp edge unless edgeRadiusMm is also given.
//
// Limits
//   - On-axis only; first-order diffraction (no edge-to-edge multiple
//     diffraction), no cabinet sides/depth, no floor/wall reflections.
//   - The −½ coefficient is the half-plane limit; it slightly overstates the
//     ripple for real (90° wedge) cabinet edges, as The Edge does too.
//   - Point source + simple piston directivity; no cone breakup.

import { SPEED_OF_SOUND } from './roomAcoustics';

const C = SPEED_OF_SOUND;
/** Roundover attenuation constant: E = 1/(1 + (k·r·C_ROUND)²). See header. */
const C_ROUND = 1;
/** Perimeter sampling: element length ≤ MAX_STEP_M and at least MIN_POINTS elements. */
const MAX_STEP_M = 0.0025;
const MIN_POINTS = 512;

export interface BaffleOpts {
  widthMm: number;
  heightMm: number;
  /** measured from the baffle's left edge */
  driverXmm: number;
  /** measured from the baffle's top edge */
  driverYmm: number;
  pistonRadiusMm?: number;
  /** roundover radius; 0 = sharp */
  edgeRadiusMm?: number;
  /** ellipse = curved/rounded front (ellipse inscribed in width × height) */
  shape?: 'rect' | 'ellipse';
  /** listening distance, default 2 m */
  distanceM?: number;
}

/** Bessel J1 (Abramowitz & Stegun 9.4.4 / 9.4.6, |error| < 1e-7). */
function besselJ1(x: number): number {
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

/** Piston directivity 2·J1(x)/x. */
function piston(x: number): number {
  return x < 1e-6 ? 1 : (2 * besselJ1(x)) / x;
}

/** Edge-source geometry: extra path Δᵢ and normalised weight wᵢ per element. */
function edgeSources(o: BaffleOpts): { delta: Float64Array; weight: Float64Array } {
  const W = Math.max(o.widthMm, 1) / 1000;
  const Hh = Math.max(o.heightMm, 1) / 1000;
  const R = Math.max(o.distanceM ?? 2, 0.05);
  const ellipse = o.shape === 'ellipse';
  // driver relative to the baffle centre (y up)
  let xd = o.driverXmm / 1000 - W / 2;
  let yd = Hh / 2 - o.driverYmm / 1000;
  const a = W / 2;
  const b = Hh / 2;
  // keep the driver strictly inside the outline
  if (ellipse) {
    const e = Math.hypot(xd / a, yd / b);
    if (e > 0.98) {
      xd *= 0.98 / e;
      yd *= 0.98 / e;
    }
  } else {
    xd = Math.min(Math.max(xd, -a * 0.98), a * 0.98);
    yd = Math.min(Math.max(yd, -b * 0.98), b * 0.98);
  }

  // perimeter vertices (closed loop, counter-clockwise)
  let px: Float64Array;
  let py: Float64Array;
  if (ellipse) {
    const h = ((a - b) / (a + b)) ** 2;
    const perim = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))); // Ramanujan
    const n = Math.max(MIN_POINTS, Math.ceil(perim / MAX_STEP_M));
    px = new Float64Array(n);
    py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      px[i] = a * Math.cos(t);
      py[i] = b * Math.sin(t);
    }
  } else {
    const perim = 2 * (W + Hh);
    const n = Math.max(MIN_POINTS, Math.ceil(perim / MAX_STEP_M));
    px = new Float64Array(n);
    py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = (perim * i) / n; // arc length from (a, -b), walking CCW
      if (s < Hh) { px[i] = a; py[i] = -b + s; continue; }
      s -= Hh;
      if (s < W) { px[i] = a - s; py[i] = b; continue; }
      s -= W;
      if (s < Hh) { px[i] = -a; py[i] = b - s; continue; }
      s -= Hh;
      px[i] = -a + s; py[i] = -b;
    }
  }

  const n = px.length;
  const delta = new Float64Array(n);
  const weight = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ux = px[i] - xd, uy = py[i] - yd;
    const vx = px[j] - xd, vy = py[j] - yd;
    const dTheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); // signed, Σ = 2π
    const mx = (px[i] + px[j]) / 2 - xd;
    const my = (py[i] + py[j]) / 2 - yd;
    const rho = Math.hypot(mx, my);
    const d = Math.hypot(rho, R);
    delta[i] = rho + d - R;
    weight[i] = dTheta * (R / d);
    sum += weight[i];
  }
  for (let i = 0; i < n; i++) weight[i] /= sum;
  return { delta, weight };
}

/**
 * On-axis response of a driver on a finite baffle relative to the same driver
 * on an infinite baffle: ≈ −6 dB at LF, → 0 dB at HF, with the step ripple.
 */
export function baffleResponse(o: BaffleOpts, freqs: number[]): { freqs: number[]; db: number[]; phaseDeg: number[] } {
  const { delta, weight } = edgeSources(o);
  const n = delta.length;
  const pr = (o.pistonRadiusMm ?? 0) / 1000;
  const er = (o.edgeRadiusMm ?? 0) / 1000;
  const db = new Array<number>(freqs.length);
  const phaseDeg = new Array<number>(freqs.length);
  for (let fi = 0; fi < freqs.length; fi++) {
    const k = (2 * Math.PI * Math.max(freqs[fi], 0)) / C;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ph = k * delta[i];
      re += weight[i] * Math.cos(ph);
      im -= weight[i] * Math.sin(ph);
    }
    let g = -0.5;
    if (pr > 0) g *= piston(k * pr);
    if (er > 0) g /= 1 + (k * er * C_ROUND) ** 2;
    const hr = 1 + g * re;
    const hi = g * im;
    db[fi] = 10 * Math.log10(Math.max(hr * hr + hi * hi, 1e-12));
    phaseDeg[fi] = (Math.atan2(hi, hr) * 180) / Math.PI;
  }
  return { freqs: freqs.slice(), db, phaseDeg };
}

/**
 * Suggested baffle-step compensation shelf: f3Hz is where the modelled
 * response first rises through −3 dB (the middle of the −6 → 0 dB step,
 * ≈ 115/W[m] Hz for a centred driver), gainDb a recommended shelf depth.
 */
export function baffleStepShelf(o: BaffleOpts): { f3Hz: number; gainDb: number; note: string } {
  const freqs: number[] = [];
  for (let i = 0; i <= 240; i++) freqs.push(20 * 1000 ** (i / 240)); // 20 Hz – 20 kHz
  // judge the step on the bare edge geometry: no piston beaming, no roundover
  const { db } = baffleResponse({ ...o, pistonRadiusMm: 0, edgeRadiusMm: 0 }, freqs);
  let f3Hz = NaN;
  for (let i = 1; i < freqs.length; i++) {
    if (db[i - 1] < -3 && db[i] >= -3) {
      const t = (-3 - db[i - 1]) / (db[i] - db[i - 1]);
      f3Hz = freqs[i - 1] * (freqs[i] / freqs[i - 1]) ** t;
      break;
    }
  }
  if (!Number.isFinite(f3Hz)) f3Hz = 115 / (Math.min(o.widthMm, o.heightMm) / 1000);
  const depth = -db[0]; // ≈ 6 dB
  const gainDb = Math.round(Math.min(6, Math.max(3, depth * (2 / 3))) * 2) / 2;
  const note =
    `The baffle loses up to ${depth.toFixed(1)} dB below ~${Math.round(f3Hz)} Hz in free space. ` +
    `A ${gainDb} dB shelf centred near ${Math.round(f3Hz)} Hz is a typical in-room compromise: ` +
    `use the full 6 dB only for a speaker well out in the room; placed near a wall (< ~0.5 m) ` +
    `the wall restores much of the lost bass, so 2–3 dB (or less) is usually enough.`;
  return { f3Hz, gainDb, note };
}
