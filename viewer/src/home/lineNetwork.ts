// One-dimensional acoustic path solver for lines and horns (transmission lines,
// back-loaded horns, tapped horns, folded ports), with drivers that inject
// air anywhere along the path and side-branch resonance traps.
//
// The path is a chain of short uniform tube segments, start (closed end, or a
// chamber) → mouth. Each segment is the exact plane-wave two-port
//
//   [p_in ]   [ cos kl        j Zc sin kl ] [p_out]
//   [U_in ] = [ j sin kl / Zc   cos kl    ] [U_out]        (e^{+jωt})
//
// with Zc = ρc/S (open tube) or the stuffing's complex characteristic
// impedance, and k complex when the segment is lossy:
//   • open tube: k(1 − jη) with a small viscothermal η;
//   • stuffed with fibre: Miki (1990) — the low-frequency-safe refinement of
//     Delany & Bazley — from the fibre's flow resistivity σ, which follows
//     from the packing density (polyester fibre: σ ≈ 3000·(ρ/10 kg m⁻³)^1.35
//     Pa·s/m², a fit to published measurements);
//   • 180° bends: a little extra loss (documented approximation; bends mainly
//     matter well above the line's working range).
//
// Because every segment is reciprocal (AD − BC = 1) its inverse is
// [[D, −B], [−C, A]], so the state [p, U] (U = flow towards the mouth) can be
// carried from the start to the mouth. Unknown: the start pressure p0. Known:
// the injected flows q_i (a driver side pushing Sd·u into the path at s_i) and
// the traps' shunt admittances. The state is linear in p0, so we carry two
// states — one for p0 = 1 with no sources, one for p0 = 0 with the sources —
// and solve p0 from the mouth condition p = Z_mouth·U.
//
// Reference checks (tests/lineNetwork.spec.ts): a closed–open pipe resonates
// at odd multiples of c/4L; a Helmholtz trap shunt at c/2π·√(S/(V·L')); and a
// driver one third of the way along a line does not excite its 3rd harmonic.

import { SPEED_OF_SOUND } from './roomAcoustics';

export const RHO = 1.204;
const C = SPEED_OF_SOUND;

export interface Cx {
  re: number;
  im: number;
}
export const cx = (re: number, im = 0): Cx => ({ re, im });
export const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
export const sub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
export const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
export const scl = (a: Cx, k: number): Cx => cx(a.re * k, a.im * k);
export const inv = (a: Cx) => div(cx(1), a);
export const abs = (a: Cx) => Math.hypot(a.re, a.im);
export const arg = (a: Cx) => Math.atan2(a.im, a.re);
const csin = (z: Cx): Cx => cx(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im));
const ccos = (z: Cx): Cx => cx(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im));
const csqrt = (z: Cx): Cx => {
  const r = Math.sqrt(abs(z));
  const t = arg(z) / 2;
  return cx(r * Math.cos(t), r * Math.sin(t));
};

/** Flow resistivity (Pa·s/m²) of polyester fibre packed at `densityKgM3` (= g/L). */
export function fibreResistivity(densityKgM3: number): number {
  return 3000 * Math.pow(Math.max(densityKgM3, 0.1) / 10, 1.35);
}

/**
 * Miki (1990) model of a fibrous absorber: characteristic impedance (Pa·s/m)
 * and complex wavenumber (1/m) at frequency f for flow resistivity σ.
 */
export function miki(f: number, sigma: number): { Zc: Cx; k: Cx } {
  const X = Math.max(f / sigma, 1e-5); // Miki's variable f/σ
  const w = 2 * Math.PI * f;
  const Zc = scl(cx(1 + 0.07 * Math.pow(X, -0.632), -0.107 * Math.pow(X, -0.632)), RHO * C);
  const k = scl(cx(1 + 0.109 * Math.pow(X, -0.618), -0.16 * Math.pow(X, -0.618)), w / C);
  return { Zc, k };
}

/** A stretch of the path stuffed with fibre, as fractions of the path length. */
export interface Stuffing {
  from: number;
  to: number;
  /** packing density, g/L (= kg/m³); ~5–15 is typical for transmission lines */
  densityGL: number;
}

/** A side-branch resonance trap hanging off the path at `atMm`. */
export interface Trap {
  atMm: number;
  /** Helmholtz: chamber volume (L), neck area (cm²), neck length (mm) */
  volumeL: number;
  neckAreaCm2: number;
  neckLenMm: number;
  /** damping (a little wool in the chamber): ~2–5 is a broad, effective trap */
  q: number;
}

/** Tuning of a Helmholtz trap, with the usual flanged + free end correction. */
export function trapTuningHz(t: Pick<Trap, 'volumeL' | 'neckAreaCm2' | 'neckLenMm'>): number {
  const S = t.neckAreaCm2 / 1e4;
  const a = Math.sqrt(S / Math.PI);
  const Leff = t.neckLenMm / 1000 + 1.7 * a;
  return (C / (2 * Math.PI)) * Math.sqrt(S / ((t.volumeL / 1000) * Leff));
}

/** Shunt admittance (m³/s per Pa) of a trap at frequency f. */
export function trapAdmittance(t: Trap, f: number): Cx {
  const w = 2 * Math.PI * f;
  const S = t.neckAreaCm2 / 1e4;
  const a = Math.sqrt(S / Math.PI);
  const M = (RHO * (t.neckLenMm / 1000 + 1.7 * a)) / S;
  const Ca = t.volumeL / 1000 / (RHO * C * C);
  const w0 = 1 / Math.sqrt(M * Ca);
  const R = (w0 * M) / Math.max(t.q, 0.3);
  return inv(cx(R, w * M - 1 / (w * Ca)));
}

/** The path: cumulative length (mm) and area (mm²) at each node, start → mouth. */
export interface LinePath {
  s: number[];
  area: number[];
  /** nodes that sit in a 180° bend (extra loss) */
  bend?: boolean[];
}

export interface LineModel {
  path: LinePath;
  /** a chamber at the closed start (L); 0 = rigid closed end */
  startChamberL?: number;
  /** radiation load at the mouth (Pa·s/m³), e.g. a baffled piston of the mouth area */
  mouthZ: (f: number) => Cx;
  stuffing?: Stuffing[];
  traps?: Trap[];
  /** loss factor of the open tube (viscothermal), default 0.012 */
  eta?: number;
}

/** Flow injected into the path at a position (m³/s; + = into the path). */
export interface Source {
  atMm: number;
  q: Cx;
}

export interface LineSolution {
  /** pressure at each source position (Pa) */
  pAtSources: Cx[];
  /** volume velocity out of the mouth (m³/s) */
  mouthU: Cx;
  /** pressure at the closed start */
  p0: Cx;
}

type State = { p: Cx; U: Cx };
const step = (st: State, M: [Cx, Cx, Cx, Cx]): State => ({
  // inverse of a reciprocal ABCD: [[D, −B], [−C, A]]
  p: sub(mul(M[3], st.p), mul(M[1], st.U)),
  U: sub(mul(M[0], st.U), mul(M[2], st.p)),
});

/** Segment two-port for the stretch between nodes i−1 and i. */
function segment(m: LineModel, i: number, f: number): [Cx, Cx, Cx, Cx] {
  const { s, area, bend } = m.path;
  const L = s[s.length - 1];
  const len = (s[i] - s[i - 1]) / 1000;
  const S = Math.max((area[i - 1] + area[i]) / 2, 1) / 1e6;
  const mid = (s[i] + s[i - 1]) / 2 / Math.max(L, 1e-9);
  const w = 2 * Math.PI * f;
  const st = (m.stuffing ?? []).find((x) => mid >= x.from && mid <= x.to && x.densityGL > 0);
  let k: Cx;
  let Zc: Cx;
  if (st) {
    const mk = miki(f, fibreResistivity(st.densityGL));
    k = mk.k;
    Zc = scl(mk.Zc, 1 / S);
  } else {
    const eta = (m.eta ?? 0.012) + (bend?.[i] ? 0.03 : 0);
    k = cx(w / C, -(w / C) * eta);
    Zc = cx((RHO * C) / S);
  }
  const kl = scl(k, len);
  const c = ccos(kl);
  const sn = csin(kl);
  return [c, mul(cx(0, 1), mul(Zc, sn)), mul(cx(0, 1), div(sn, Zc)), c];
}

/**
 * Solve the path at one frequency for the given sources. Sources and traps are
 * applied at the node nearest their position.
 */
export function solveLine(m: LineModel, f: number, sources: Source[]): LineSolution {
  const { s } = m.path;
  const w = 2 * Math.PI * f;
  const nodeOf = (mm: number) => {
    let best = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i] - mm) < Math.abs(s[best] - mm)) best = i;
    return best;
  };
  const srcAt = new Map<number, Cx>();
  for (const q of sources) {
    const n = nodeOf(q.atMm);
    srcAt.set(n, add(srcAt.get(n) ?? cx(0), q.q));
  }
  const trapAt = new Map<number, Cx>();
  for (const t of m.traps ?? []) {
    const n = nodeOf(t.atMm);
    trapAt.set(n, add(trapAt.get(n) ?? cx(0), trapAdmittance(t, f)));
  }
  // start: rigid closed end (U = 0) or a chamber (flow out of it = −jωC·p)
  const Cst = ((m.startChamberL ?? 0) / 1000) / (RHO * C * C);
  let a: State = { p: cx(1), U: cx(0, -w * Cst) };
  let b: State = { p: cx(0), U: cx(0) };
  const recA: State[] = [];
  const recB: State[] = [];
  const node = (i: number) => {
    const y = trapAt.get(i);
    if (y) {
      a = { p: a.p, U: sub(a.U, mul(a.p, y)) };
      b = { p: b.p, U: sub(b.U, mul(b.p, y)) };
    }
    const q = srcAt.get(i);
    if (q) b = { p: b.p, U: add(b.U, q) };
    recA[i] = a;
    recB[i] = b;
  };
  node(0);
  for (let i = 1; i < s.length; i++) {
    const M = segment(m, i, f);
    a = step(a, M);
    b = step(b, M);
    node(i);
  }
  const ZL = m.mouthZ(f);
  // mouth: p = ZL·U  →  (a.p p0 + b.p) = ZL (a.U p0 + b.U)
  const p0 = div(sub(mul(ZL, b.U), b.p), sub(a.p, mul(ZL, a.U)));
  const at = (i: number) => add(mul(recA[i].p, p0), recB[i].p);
  const last = s.length - 1;
  return {
    pAtSources: sources.map((q) => at(nodeOf(q.atMm))),
    mouthU: add(mul(recA[last].U, p0), recB[last].U),
    p0,
  };
}

/** Odd-harmonic resonances of a closed–open line of length L (mm), with end correction. */
export function quarterWaveHz(lengthMm: number, mouthAreaMm2: number, n = 1): number {
  const a = Math.sqrt(mouthAreaMm2 / Math.PI) / 1000;
  return ((2 * n - 1) * C) / (4 * (lengthMm / 1000 + 0.61 * a));
}

export { csqrt };
