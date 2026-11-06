// Hybrid cabinets: a 3D-printed core with a 2D internal profile (folded horn,
// transmission line, folded slot port, or 2D waveguide), extruded through the
// cabinet's width and closed by two flat wooden side plates.
//
// Geometry is built from rectangles (channels = air, the rest of the profile =
// printed plastic), so it can be drawn, split into printable tiles, checked
// for plate spans, and turned into a 1D acoustic model:
//
//   driver (T/S → Re, Bl, Mms, Cms, Rms) ── front / rear acoustic loads
//   path    = cascade of short tube segments (exact plane-wave ABCD matrices,
//             small loss; more loss where a line is stuffed)
//   mouth   = baffled-piston radiation impedance of the COMBINED mouth when
//             N cabinets couple (each cabinet sees N·Z_rad(N·A_mouth)), with the
//             ground image for floor-standing subs
//
// This is the standard way horn/TL simulators (Hornresp-style) model 1D
// paths; it ignores higher-order modes in wide channels and bend effects, so
// trust it below roughly c / (2 · widest channel).

import { SPEED_OF_SOUND } from './roomAcoustics';
import type { DriverInfo } from './drivers';

const RHO = 1.204;
const C = SPEED_OF_SOUND;

// ---------------------------------------------------------------------------
// complex helpers
// ---------------------------------------------------------------------------
export interface Cx {
  re: number;
  im: number;
}
const cx = (re: number, im = 0): Cx => ({ re, im });
const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
const sub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const scl = (a: Cx, k: number): Cx => cx(a.re * k, a.im * k);
const inv = (a: Cx) => div(cx(1), a);
const abs = (a: Cx) => Math.hypot(a.re, a.im);
// cos / sin of a complex argument
const ccos = (z: Cx): Cx => cx(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im));
const csin = (z: Cx): Cx => cx(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im));

// Bessel J0/J1 by Simpson integration of their integral forms (fine for x < ~60)
function besselJ(n: 0 | 1, x: number) {
  const N = 64;
  let s = 0;
  for (let i = 0; i <= N; i++) {
    const t = (Math.PI * i) / N;
    const f = Math.cos(n * t - x * Math.sin(t));
    s += f * (i === 0 || i === N ? 1 : i % 2 ? 4 : 2);
  }
  return ((s * Math.PI) / (3 * N)) / Math.PI;
}
// Struve H1 (Aarts & Janssen 2003 approximation)
function struveH1(z: number) {
  if (z < 1e-6) return 0;
  return 2 / Math.PI - besselJ(0, z) + (16 / Math.PI - 5) * (Math.sin(z) / z) + (12 - 36 / Math.PI) * ((1 - Math.cos(z)) / (z * z));
}
/** Acoustic radiation impedance (Pa·s/m³) of a baffled circular piston of area A. */
export function zRad(areaM2: number, f: number): Cx {
  const a = Math.sqrt(areaM2 / Math.PI);
  const k = (2 * Math.PI * f) / C;
  const x = 2 * k * a;
  const R = x < 1e-4 ? (x * x) / 8 : 1 - (2 * besselJ(1, x)) / x;
  const X = x < 1e-4 ? (4 * x) / (3 * Math.PI) : (2 * struveH1(x)) / x;
  return scl(cx(R, X), (RHO * C) / areaM2);
}

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------
export type ProfileType = 'folded-horn' | 'tl' | 'slot-port' | 'waveguide';
export type MouthPlace = 'edge' | 'corner';

export interface HybridParams {
  type: ProfileType;
  driverId: string;
  /** profile width = cabinet depth front→back (mm) */
  depthMm: number;
  /** profile height = cabinet height (mm) */
  heightMm: number;
  /** width between the two outer plates (mm), including any plywood dividers */
  extrusionMm: number;
  plateMm: number;
  plateMaterial: 'bb18' | 'mdf19' | 'bb12';
  /** plywood dividers that split the printed core into thinner cores (stiffer walls, shorter prints) */
  dividers: number;
  /** printed wall thickness (mm) — a whole number of extrusion lines */
  wallMm: number;
  /** how much corners are rounded (0 = square, 1 = as round as the space allows) */
  rounding: number;
  /** number of path legs (folds + 1) */
  legs: number;
  /** horn: throat area as a fraction of the cone area (compression ratio⁻¹) */
  throatRatio: number;
  /** horn: rear chamber volume (L) */
  rearChamberL: number;
  /** TL: end area / start area */
  taper: number;
  /** slot port: slot height (mm) */
  slotMm: number;
  mouth: MouthPlace;
  /** waveguide: coverage angle (deg) and throat width (mm) */
  coverageDeg: number;
  throatMm: number;
}

export const HYBRID_PRESETS: Record<'sub' | 'living' | 'waveguide', HybridParams> = {
  sub: {
    type: 'folded-horn',
    driverId: 'bc-18tbw100',
    depthMm: 950,
    heightMm: 900,
    extrusionMm: 580,
    plateMm: 18,
    plateMaterial: 'bb18',
    dividers: 1,
    wallMm: 15,
    rounding: 0.9,
    legs: 5,
    throatRatio: 0.45,
    rearChamberL: 55,
    taper: 1,
    slotMm: 60,
    mouth: 'edge',
    coverageDeg: 90,
    throatMm: 36,
  },
  living: {
    type: 'tl',
    driverId: 'sb17nrx2c35-8',
    depthMm: 340,
    heightMm: 920,
    extrusionMm: 200,
    plateMm: 18,
    plateMaterial: 'bb18',
    dividers: 0,
    wallMm: 9,
    rounding: 0.9,
    legs: 6,
    throatRatio: 1,
    rearChamberL: 0,
    taper: 0.45,
    slotMm: 40,
    mouth: 'edge',
    coverageDeg: 90,
    throatMm: 25,
  },
  waveguide: {
    type: 'waveguide',
    driverId: 'sb26stac-c000-4',
    depthMm: 170,
    heightMm: 310,
    extrusionMm: 120,
    plateMm: 12,
    plateMaterial: 'bb12',
    dividers: 0,
    wallMm: 7.5,
    rounding: 1,
    legs: 1,
    throatRatio: 1,
    rearChamberL: 0,
    taper: 1,
    slotMm: 40,
    mouth: 'edge',
    coverageDeg: 90,
    throatMm: 30,
  },
};

// ---------------------------------------------------------------------------
// geometry: outlines are polygons with filleted (organic) corners
// ---------------------------------------------------------------------------
export type Pt = [number, number];
export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  label?: string;
}
export interface Geometry {
  W: number; // profile width (mm) = depth
  H: number; // profile height (mm)
  /** acoustic width of the channels (mm) = extrusion − dividers */
  E: number;
  wallMm: number;
  /** total width between the outer plates (mm) */
  Etot: number;
  /** printed cores side by side (dividers + 1), each this thick (mm) */
  cores: number;
  coreMm: number;
  /** solid printed region: outer contour (opens at the mouth) and holes (closed chambers) */
  core: Pt[];
  holes: Pt[][];
  /** rectangles of open space each plate spans (for resonance checks) */
  spans: Rect[];
  labels: { x: number; y: number; text: string }[];
  driver: { x: number; y: number; dia: number; face: 'front' | 'internal' };
  /** path along the horn / line / port, start → exit: cumulative length (mm) and area (mm²) */
  path: { s: number[]; area: number[] };
  mouthRect: Rect | null;
  chambers: { label: string; volumeL: number }[];
  stats: { label: string; value: string }[];
  fits: boolean;
  warnings: string[];
}

export function pointInPoly(poly: Pt[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function signedArea(poly: Pt[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  return a / 2; // with j = i − 1 this is > 0 for COUNTER-clockwise polygons (y up)
}
function dedupe(poly: Pt[]) {
  const out: Pt[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.01) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.01) out.pop();
  // drop collinear points
  const res: Pt[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) > 1e-6) res.push(b);
  }
  return res;
}

/**
 * Round every corner of a polygon that bounds SOLID material (solid inside).
 * Convex solid corners (wall tips, mouth lips, outer corners) get radius
 * `convex(edgeMin)`; concave ones (inside bends, chamber corners) `concave(edgeMin)`.
 */
function fillet(poly0: Pt[], convexR: (minEdge: number, p: Pt) => number, concaveR: (minEdge: number) => number): Pt[] {
  const poly = dedupe(poly0);
  const n = poly.length;
  const ccw = signedArea(poly) > 0;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const P = poly[i];
    const A = poly[(i - 1 + n) % n];
    const B = poly[(i + 1) % n];
    const la = Math.hypot(A[0] - P[0], A[1] - P[1]);
    const lb = Math.hypot(B[0] - P[0], B[1] - P[1]);
    const u: Pt = [(A[0] - P[0]) / la, (A[1] - P[1]) / la];
    const v: Pt = [(B[0] - P[0]) / lb, (B[1] - P[1]) / lb];
    const cross = (P[0] - A[0]) * (B[1] - P[1]) - (P[1] - A[1]) * (B[0] - P[0]);
    const convex = ccw ? cross > 0 : cross < 0;
    const phi = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    if (phi < 1e-3 || Math.PI - phi < 1e-3) {
      out.push(P);
      continue;
    }
    const minEdge = Math.min(la, lb);
    let r = convex ? convexR(minEdge, P) : concaveR(minEdge);
    // the tangent points must stay on the edges (leave room for the neighbour's fillet)
    const dMax = 0.5 * minEdge * 0.98;
    let d = r / Math.tan(phi / 2);
    if (d > dMax) {
      d = dMax;
      r = d * Math.tan(phi / 2);
    }
    if (r < 0.3) {
      out.push(P);
      continue;
    }
    const T1: Pt = [P[0] + u[0] * d, P[1] + u[1] * d];
    const T2: Pt = [P[0] + v[0] * d, P[1] + v[1] * d];
    const bis: Pt = [u[0] + v[0], u[1] + v[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const cdist = r / Math.sin(phi / 2);
    const Cc: Pt = [P[0] + (bis[0] / bl) * cdist, P[1] + (bis[1] / bl) * cdist];
    let a1 = Math.atan2(T1[1] - Cc[1], T1[0] - Cc[0]);
    let a2 = Math.atan2(T2[1] - Cc[1], T2[0] - Cc[0]);
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil((Math.abs(da) / (Math.PI / 2)) * 8));
    for (let k = 0; k <= steps; k++) {
      const a = a1 + (da * k) / steps;
      out.push([Cc[0] + r * Math.cos(a), Cc[1] + r * Math.sin(a)]);
    }
    a1 = a2;
  }
  return out;
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Pt[] {
  return fillet(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    () => r,
    () => r
  );
}

interface Leg {
  yt: number;
  yb: number;
}

/**
 * Square serpentine channel (air) of horizontal legs stacked top → bottom.
 * Leg 0 starts at xStart going in direction d0 (+1 = toward the front); legs
 * alternate; the last leg exits through the front face (x = W). Turns happen
 * at the inner faces xa (back) / xb (front); the dividing wall between legs i
 * and i+1 stops a gap g_i short of the turn side. Returns the polygon split as
 * side A (starts on leg 0's top edge) and side B (bottom edge), both start→exit.
 */
function serpentine(legs: Leg[], xa: number, xb: number, W: number, xStart: number, d0: 1 | -1, t: number, gaps: number[]) {
  const A: Pt[] = [[xStart, legs[0].yt]];
  const B: Pt[] = [[xStart, legs[0].yb]];
  let aTop = true; // side A currently runs along a top edge
  for (let i = 0; i < legs.length - 1; i++) {
    const di = i % 2 === 0 ? d0 : (-d0 as 1 | -1);
    const side = di > 0 ? xb : xa;
    const tip = side - di * gaps[i];
    const outer: Pt[] = [
      [side, legs[i].yt],
      [side, legs[i + 1].yb],
    ];
    const inner: Pt[] = [
      [tip, legs[i].yb],
      [tip, legs[i].yb - t],
    ];
    if (aTop) {
      A.push(...outer);
      B.push(...inner);
    } else {
      A.push(...inner);
      B.push(...outer);
    }
    aTop = !aTop;
  }
  const last = legs[legs.length - 1];
  A.push([W, aTop ? last.yt : last.yb]);
  B.push([W, aTop ? last.yb : last.yt]);
  return { A, B };
}

/** Solid core contour = rectangle with the channel cut in from the mouth (x = W). */
function coreWithChannel(W: number, H: number, A: Pt[], B: Pt[]): Pt[] {
  const aExit = A[A.length - 1];
  const bExit = B[B.length - 1];
  const outer: Pt[] =
    bExit[1] < aExit[1]
      ? [
          [W, 0],
          [0, 0],
          [0, H],
          [W, H],
        ]
      : [
          [W, H],
          [0, H],
          [0, 0],
          [W, 0],
        ];
  // B exit → around the outside → A exit, then back along A to the start and out along B to its exit
  return [bExit, ...outer, aExit, ...[...A].reverse().slice(1), ...B.slice(0, -1)];
}

function seg(s: number[], a: number[], len: number, a0: number, a1: number, n = 6) {
  const start = s.length ? s[s.length - 1] : 0;
  for (let i = 1; i <= n; i++) {
    s.push(start + (len * i) / n);
    a.push(a0 + ((a1 - a0) * i) / n);
  }
}

export function buildGeometry(p: HybridParams, d: DriverInfo): Geometry {
  const W = p.depthMm;
  const H = p.heightMm;
  const Etot = p.extrusionMm;
  const cores = Math.max(1, Math.round(p.dividers) + 1);
  const E = Math.max(10, Etot - (cores - 1) * p.plateMm);
  const coreMm = E / cores;
  const t = p.wallMm;
  const dia = d.frameDiaMm;
  const sd = d.sdCm2 * 100; // mm²
  const warnings: string[] = [];
  const stats: Geometry['stats'] = [];
  const chambers: Geometry['chambers'] = [];
  const spans: Rect[] = [];
  const labels: Geometry['labels'] = [];
  const holes: Pt[][] = [];
  const s: number[] = [0];
  const area: number[] = [];
  let fits = true;
  const k = Math.max(0, Math.min(1, p.rounding));
  const outerR = 25 * k;
  // solid-corner rounding: wall tips become half-round, lips/outer corners flare, bends sweep
  const convex = (minEdge: number, P: Pt) => {
    const onOuter = (P[0] < 1 || P[0] > W - 1) && (P[1] < 1 || P[1] > H - 1);
    return onOuter ? outerR : k * Math.min(t * 1.5, minEdge / 2);
  };
  const concave = (minEdge: number) => k * 0.5 * minEdge * 0.95;
  const base = { W, H, E, Etot, cores, coreMm, wallMm: t };

  if (p.type === 'waveguide') {
    // oblate-spheroid-like flare: half-width w(x) = √(r0² + (x·tan θ)²)
    const r0 = p.throatMm / 2;
    const tn = Math.tan(((p.coverageDeg / 2) * Math.PI) / 180);
    const len = W - t;
    const cy = H / 2;
    const A: Pt[] = [];
    const B: Pt[] = [];
    for (let i = 0; i <= 40; i++) {
      const x = (len * i) / 40;
      const w = Math.min(H / 2 - t, Math.sqrt(r0 * r0 + (x * tn) ** 2));
      A.push([t + x, cy + w]);
      B.push([t + x, cy - w]);
    }
    A.push([W, A[A.length - 1][1]]);
    B.push([W, B[B.length - 1][1]]);
    const core = fillet(coreWithChannel(W, H, A, B), (me, P) => ((P[0] < 1 || P[0] > W - 1) && (P[1] < 1 || P[1] > H - 1) ? outerR : k * Math.min(30, me / 2)), () => 0);
    const mouthW = A[A.length - 1][1] - B[B.length - 1][1];
    const fControl = 25000 / ((mouthW / 1000) * p.coverageDeg);
    stats.push(
      { label: 'Mouth width × height', value: `${mouthW.toFixed(0)} × ${Etot} mm` },
      { label: 'Pattern control down to (Keele)', value: `≈ ${fControl.toFixed(0)} Hz at ${p.coverageDeg}°` },
      { label: 'Profile', value: 'oblate-spheroid flare with rolled mouth lips' }
    );
    warnings.push('Waveguides are geometry-only here: their frequency response needs the compression driver/tweeter’s own data, so they are not fed into the maps.');
    return {
      ...base,
      core,
      holes,
      spans: [{ x0: t, x1: W, y0: cy - mouthW / 2, y1: cy + mouthW / 2 }],
      labels,
      driver: { x: t / 2, y: cy, dia: Math.max(p.throatMm, dia * 0.6), face: 'internal' },
      path: { s: [0, len], area: [p.throatMm * E, mouthW * E] },
      mouthRect: { x0: W - 1, x1: W, y0: cy - mouthW / 2, y1: cy + mouthW / 2 },
      chambers,
      stats,
      fits,
      warnings,
    };
  }

  // ---- serpentine designs -------------------------------------------------
  let legs: Leg[] = [];
  let xa = t;
  const xb = W - t;
  let xStart = xb;
  let d0: 1 | -1 = 1;
  let A: Pt[] = [];
  let B: Pt[] = [];
  let driver: Geometry['driver'];
  let L = 0;

  const stack = (hs: number[]) => {
    const out: Leg[] = [];
    let yTop = H - t;
    for (const h of hs) {
      out.push({ yt: yTop, yb: yTop - h });
      yTop = yTop - h - t;
    }
    return out;
  };
  const gapsFor = (hs: number[], legLen: number) => hs.slice(0, -1).map((h, i) => Math.min(Math.max(h, hs[i + 1]) * 1.05, legLen * 0.5));
  // centre-line length of a rounded 180° bend ≈ π × (wall/2 + channel/2)
  const bendLen = (h0: number, h1: number) => Math.PI * (t / 2 + (h0 + h1) / 4);

  if (p.type === 'folded-horn') {
    const inner = H - 2 * t;
    const cw = Math.max((p.rearChamberL * 1e6) / (inner * E), (d.mountDepthMm ?? 120) + 25);
    const xDrv = t + cw;
    const tcD = 70;
    xStart = xDrv + t; // driver wall front face; leg 0 starts here over the throat chamber
    xa = xDrv + t + tcD + t;
    d0 = 1;
    holes.push(roundedRect(t, t, t + cw, H - t, 40 * k));
    chambers.push({ label: 'Rear chamber', volumeL: (cw * inner * E) / 1e6 });
    spans.push({ x0: t, x1: t + cw, y0: t, y1: H - t, label: 'rear chamber' });
    labels.push({ x: t + cw / 2, y: H / 2, text: 'rear chamber' });
    const N = p.legs % 2 === 1 ? p.legs : p.legs + 1;
    if (N !== p.legs) warnings.push(`Folded horn needs an odd number of legs to exit at the front — using ${N}.`);
    const legLen = xb - xa;
    if (legLen < 150) {
      fits = false;
      warnings.push('Not enough depth for the horn legs — make the cabinet deeper, the walls thinner or the rear chamber smaller.');
    }
    const St = Math.max(sd * p.throatRatio, 1);
    const lens = Array.from({ length: N }, (_, i) => (i === 0 ? xb - xStart : legLen));
    const solve = (Sm: number) => {
      const Lsum = lens.reduce((a, b) => a + b, 0);
      let acc = 0;
      const hs: number[] = [];
      for (const l of lens) {
        hs.push((St * Math.pow(Sm / St, (acc + l / 2) / Lsum)) / E);
        acc += l;
      }
      return { hs, used: hs.reduce((a, b) => a + b, 0) + (N + 1) * t, Lsum };
    };
    let lo = St;
    let hi = St * 400;
    for (let it = 0; it < 60; it++) {
      const m = Math.sqrt(lo * hi);
      if (solve(m).used > H) hi = m;
      else lo = m;
    }
    const Sm = lo;
    const { hs, Lsum } = solve(Sm);
    if (Sm < St * 1.5) {
      fits = false;
      warnings.push('The profile is too short for this many legs: the horn cannot expand. Fewer legs, thinner walls or a taller cabinet.');
    }
    legs = stack(hs);
    const gaps = gapsFor(hs, legLen);
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    // merge the throat chamber (in front of the driver, below leg 0) into the channel
    const tcTop = legs[0].yb;
    const drvY = tcTop - 6 - dia / 2;
    const tcBot = Math.max(t, drvY - dia / 2);
    const tcFront = xDrv + t + tcD;
    B[0] = [tcFront, legs[0].yb];
    B.unshift([tcFront, tcBot], [xStart, tcBot]);
    A[0] = [xStart, legs[0].yt];
    chambers.push({ label: 'Throat chamber', volumeL: (tcD * (tcTop - tcBot) * E) / 1e6 });
    labels.push({ x: xStart + tcD / 2, y: (tcTop + tcBot) / 2, text: 'throat chamber' });
    driver = { x: xDrv + t / 2, y: drvY, dia, face: 'internal' };
    L = Lsum + hs.slice(0, -1).reduce((a, h, i) => a + bendLen(h, hs[i + 1]) - (gaps[i] + t), 0);
    area.push(St);
    for (let i = 0; i < 48; i++) {
      const sl = (L * (i + 1)) / 48;
      s.push(sl);
      area.push(St * Math.pow(Sm / St, (sl - L / 96) / L));
    }
    const m = Math.log(Sm / St) / (L / 1000);
    stats.push(
      { label: 'Horn path length (centre line)', value: `${(L / 1000).toFixed(2)} m` },
      { label: 'Throat → mouth', value: `${(St / 100).toFixed(0)} → ${(Sm / 100).toFixed(0)} cm²` },
      { label: 'Exponential flare cut-off', value: `${((m * C) / (4 * Math.PI)).toFixed(0)} Hz` },
      { label: 'Quarter-wave of the path', value: `${(C / (4 * (L / 1000))).toFixed(0)} Hz` }
    );
    labels.push({ x: (xa + xb) / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'throat' }, { x: (xa + xb) / 2, y: (legs[N - 1].yt + legs[N - 1].yb) / 2, text: 'mouth leg' });
  } else if (p.type === 'tl') {
    if (E < dia + 6) warnings.push(`The channels (${E} mm wide) are narrower than the driver frame (${dia} mm) — widen the extrusion.`);
    const N = p.legs % 2 === 0 ? p.legs : p.legs + 1;
    if (N !== p.legs) warnings.push(`A transmission line needs an even number of legs to exit at the front — using ${N}.`);
    d0 = -1;
    xa = t;
    xStart = xb;
    const legLen = xb - xa;
    const S0 = Math.max(sd * 1.1, (dia + 12) * E * 0.6);
    const hs = Array.from({ length: N }, (_, i) => (S0 * (1 + (p.taper - 1) * ((i + 0.5) / N))) / E);
    hs[0] = Math.max(hs[0], dia + 2 * t);
    const room = H - (N + 1) * t;
    const sumH = hs.reduce((a, b) => a + b, 0);
    // grow the line to use the height, but never wider than ~3× the cone area at the start
    const grow = Math.max(1, Math.min(room / sumH, (3 * sd) / (hs[0] * E)));
    for (let i = 0; i < N; i++) hs[i] *= grow;
    let used = hs.reduce((a, b) => a + b, 0) + (N + 1) * t;
    const spare = H - used;
    if (spare > 40) {
      // leftover height becomes a sealed void (no filament): fill with sand or shorten the cabinet
      holes.push(roundedRect(t, t, W - t, t + spare - t, 30 * k));
      labels.push({ x: W / 2, y: t + (spare - t) / 2, text: 'sealed void (sand)' });
      stats.push({ label: 'Spare height', value: `${spare.toFixed(0)} mm at the bottom — a sealed void (fill with sand for stability), or shorten the cabinet by that much` });
      used = H;
    }
    if ((hs[0] * E) / sd > 3.5)
      warnings.push(`The line starts at ${((hs[0] * E) / sd).toFixed(1)}× the cone area — wider than the usual 1–3×, which weakens the line's bass. Add legs (a longer, lower-tuned line) or narrow the core.`);
    if (used > H + 1) {
      fits = false;
      warnings.push(`The line needs ${used.toFixed(0)} mm of height but the cabinet is ${H} mm — taller cabinet, fewer legs, thinner walls or more taper.`);
    }
    legs = stack(hs);
    const gaps = gapsFor(hs, legLen);
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    driver = { x: W - t / 2, y: (legs[0].yt + legs[0].yb) / 2, dia, face: 'front' };
    for (let i = 0; i < N; i++) {
      seg(s, area, legLen, hs[i] * E, (i < N - 1 ? hs[i + 1] : hs[i]) * E);
      if (i < N - 1) seg(s, area, bendLen(hs[i], hs[i + 1]) - (gaps[i] + t), hs[i + 1] * E, hs[i + 1] * E, 2);
    }
    area.unshift(area[0]);
    L = s[s.length - 1];
    stats.push(
      { label: 'Line length (centre line)', value: `${(L / 1000).toFixed(2)} m` },
      { label: 'Quarter-wave tuning', value: `≈ ${(C / (4 * (L / 1000))).toFixed(0)} Hz` },
      { label: 'Start → end area', value: `${((hs[0] * E) / 100).toFixed(0)} → ${((hs[N - 1] * E) / 100).toFixed(0)} cm² (${((hs[0] * E) / sd).toFixed(1)}× Sd at the start)` }
    );
    labels.push({ x: W / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'line start' }, { x: W / 2, y: (legs[N - 1].yt + legs[N - 1].yb) / 2, text: 'terminus' });
  } else {
    // slot-port box: leg 0 is the box itself (behind the driver), then the folded slot
    const nSlot = p.legs % 2 === 1 ? Math.min(p.legs, 5) : Math.min(p.legs + 1, 5);
    if (nSlot !== p.legs) warnings.push(`The slot needs an odd number of runs to exit at the front — using ${nSlot}.`);
    d0 = -1;
    xa = t;
    xStart = xb;
    const legLen = xb - xa;
    const boxH = H - 2 * t - nSlot * (p.slotMm + t);
    if (boxH < dia + 2 * t) {
      fits = false;
      warnings.push('Not enough height for the driver above the folded slot — taller cabinet or fewer slot runs.');
    }
    const hs = [Math.max(boxH, 20), ...Array.from({ length: nSlot }, () => p.slotMm)];
    legs = stack(hs);
    const gaps = gapsFor(hs, legLen).map((g, i) => (i === 0 ? Math.min(g, p.slotMm * 1.6) : g));
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    driver = { x: W - t / 2, y: (legs[0].yt + legs[0].yb) / 2, dia, face: 'front' };
    const Vb = (legLen * boxH * E) / 1e6 - (d.displacementL ?? 0.5);
    chambers.push({ label: 'Box (net)', volumeL: Vb });
    const Lp = nSlot * legLen + (nSlot - 1) * (bendLen(p.slotMm, p.slotMm) - p.slotMm - t);
    seg(s, area, Lp, p.slotMm * E, p.slotMm * E, 12);
    area.unshift(area[0]);
    const Sp = (p.slotMm * E) / 1e6;
    const leff = Lp / 1000 + 0.9 * Math.sqrt(Sp / Math.PI) * 2;
    const fb = (C / (2 * Math.PI)) * Math.sqrt(Sp / ((Vb / 1000) * leff));
    stats.push(
      { label: 'Net box volume', value: `${Vb.toFixed(1)} L` },
      { label: 'Slot port', value: `${p.slotMm} × ${E} mm, ${(Lp / 1000).toFixed(2)} m long (rounded bends)` },
      { label: 'Helmholtz tuning (estimate)', value: `≈ ${fb.toFixed(0)} Hz` }
    );
    labels.push({ x: W / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'box' });
    L = Lp;
  }
  for (const lg of legs) spans.push({ x0: xa, x1: xb, y0: lg.yb, y1: lg.yt });
  const last = legs[legs.length - 1];
  const core = fillet(coreWithChannel(W, H, A, B), convex, concave);
  return {
    ...base,
    core,
    holes,
    spans,
    labels,
    driver: driver!,
    path: { s, area },
    mouthRect: { x0: W - 1, x1: W, y0: last.yb, y1: last.yt },
    chambers,
    stats,
    fits,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// acoustic simulation
// ---------------------------------------------------------------------------
export interface SimResult {
  freqs: number[];
  /** SPL at 1 m for 2.83 V (dB), half-space for floor subs, full space otherwise */
  spl: number[];
  /** cone excursion at 2.83 V (mm peak) */
  excursionMm: number[];
  /** excursion- and power-limited max SPL (dB) */
  maxSpl: number[];
  /** complex free-field pressure at 1 m per 2.83 V (one cabinet) — for the maps */
  H: Cx[];
  f3: number;
}

function tsToMech(d: DriverInfo) {
  const Sd = d.sdCm2 / 1e4;
  const ws = 2 * Math.PI * d.fsHz;
  const Cms = d.vasL / 1000 / (RHO * C * C * Sd * Sd);
  const Mms = 1 / (ws * ws * Cms);
  const Rms = (ws * Mms) / (d.qms ?? 4);
  const Bl = Math.sqrt((ws * Mms * d.reOhm) / (d.qes ?? d.qts * 1.1));
  return { Sd, Cms, Mms, Rms, Bl, Re: d.reOhm };
}

/** ABCD matrix of the path, start → end, at frequency f with loss factor eta. */
function pathMatrix(path: Geometry['path'], f: number, eta: (frac: number) => number): [Cx, Cx, Cx, Cx] {
  let M: [Cx, Cx, Cx, Cx] = [cx(1), cx(0), cx(0), cx(1)];
  const L = path.s[path.s.length - 1];
  for (let i = 1; i < path.s.length; i++) {
    const l = (path.s[i] - path.s[i - 1]) / 1000;
    const S = path.area[i] / 1e6;
    const k = (2 * Math.PI * f) / C;
    const kk = cx(k, -k * eta(path.s[i] / L));
    const kl = scl(kk, l);
    const Z0 = (RHO * C) / S;
    const T: [Cx, Cx, Cx, Cx] = [ccos(kl), mul(cx(0, Z0), csin(kl)), mul(cx(0, 1 / Z0), csin(kl)), ccos(kl)];
    M = [add(mul(M[0], T[0]), mul(M[1], T[2])), add(mul(M[0], T[1]), mul(M[1], T[3])), add(mul(M[2], T[0]), mul(M[3], T[2])), add(mul(M[2], T[1]), mul(M[3], T[3]))];
  }
  return M;
}

export function simulate(p: HybridParams, d: DriverInfo, g: Geometry, opts: { coupled: number; floor: boolean; f0?: number; f1?: number; n?: number }): SimResult {
  const { Sd, Cms, Mms, Rms, Bl, Re } = tsToMech(d);
  const Le = 0; // datasheet Le is too inconsistent to matter below ~300 Hz
  const f0 = opts.f0 ?? 15;
  const f1 = opts.f1 ?? 600;
  const n = opts.n ?? 90;
  const freqs = Array.from({ length: n }, (_, i) => f0 * Math.pow(f1 / f0, i / (n - 1)));
  const N = Math.max(1, opts.coupled);
  const Vin = 2.83;
  const spl: number[] = [];
  const exc: number[] = [];
  const maxSpl: number[] = [];
  const H: Cx[] = [];
  const Pmax = d.powerW ?? 100;
  const xmax = (d.xmaxMm || 3) / 1000;
  const mouthA = g.mouthRect ? ((g.mouthRect.y1 - g.mouthRect.y0) * g.E) / 1e6 : 0;
  for (const f of freqs) {
    const w = 2 * Math.PI * f;
    const Zm = add(cx(Rms, w * Mms), cx(0, -1 / (w * Cms)));
    const Ze = cx(Re, w * Le);
    let Zf: Cx;
    let Zr: Cx;
    let out: (v: Cx) => Cx; // radiated volume velocity for cone velocity v
    if (p.type === 'folded-horn') {
      const Vtc = (g.chambers.find((c) => c.label === 'Throat chamber')?.volumeL ?? 2) / 1000;
      const Vrc = (g.chambers.find((c) => c.label === 'Rear chamber')?.volumeL ?? 50) / 1000;
      // mouth load: N coupled mouths (+ ground image for floor subs) form one bigger mouth
      const img = opts.floor ? 2 : 1;
      const ZmL = scl(zRad(mouthA * N * img, f), N * img);
      const M = pathMatrix(g.path, f, () => 0.012);
      const Zth = div(add(mul(M[0], ZmL), M[1]), add(mul(M[2], ZmL), M[3]));
      const Ctc = Vtc / (RHO * C * C);
      Zf = inv(add(cx(0, w * Ctc), inv(Zth)));
      Zr = inv(cx(1 / ((RHO * C) / Sd * 40), w * (Vrc / (RHO * C * C)))); // small leak keeps it finite
      out = (v) => {
        const Ucone = scl(v, Sd);
        const ptc = mul(Zf, Ucone);
        const Uth = div(ptc, Zth);
        return div(Uth, add(mul(M[2], ZmL), M[3]));
      };
    } else if (p.type === 'tl' || p.type === 'slot-port') {
      Zf = zRad(Sd, f);
      const ZmL = zRad(Math.max(mouthA, 1e-4), f);
      const stuffed = p.type === 'tl';
      const M = pathMatrix(g.path, f, (frac) => (stuffed ? (frac < 0.5 ? 0.12 : 0.03) : 0.02));
      const Zin = div(add(mul(M[0], ZmL), M[1]), add(mul(M[2], ZmL), M[3]));
      if (p.type === 'tl') {
        Zr = Zin;
        out = (v) => {
          const Uin = scl(v, -Sd);
          const Uend = div(Uin, add(mul(M[2], ZmL), M[3]));
          return add(scl(v, Sd), Uend);
        };
      } else {
        const Vb = (g.chambers[0]?.volumeL ?? 10) / 1000;
        const Cb = Vb / (RHO * C * C);
        const Zb = inv(cx(1 / ((RHO * C) / Sd * 30), w * Cb));
        Zr = inv(add(inv(Zb), inv(Zin)));
        out = (v) => {
          const pb = mul(Zr, scl(v, -Sd));
          const Uin = div(pb, Zin);
          const Uend = div(Uin, add(mul(M[2], ZmL), M[3]));
          return add(scl(v, Sd), Uend);
        };
      }
    } else {
      // waveguide: not simulated (see warnings) — sealed-box-like placeholder for completeness
      Zf = zRad(Sd, f);
      Zr = inv(cx(0, w * (0.002 / (RHO * C * C))));
      out = (v) => scl(v, Sd);
    }
    const Zmot = add(Zm, scl(add(Zf, Zr), Sd * Sd));
    const i = div(cx(Vin), add(Ze, div(cx(Bl * Bl), Zmot)));
    const v = div(scl(i, Bl), Zmot);
    const U = out(v);
    // free-field pressure at 1 m from this one cabinet: jωρU/(4π)
    const pff = mul(cx(0, (w * RHO) / (4 * Math.PI)), U);
    H.push(pff);
    const pChart = scl(pff, opts.floor ? 2 * N : 1); // chart: whole coupled stack on the ground
    const db = 20 * Math.log10(abs(pChart) / 20e-6 + 1e-12);
    spl.push(db);
    const x = abs(v) / w;
    exc.push(x * 1000);
    const iRms = abs(i);
    const vByX = xmax / Math.max(x, 1e-12);
    const vByP = Math.sqrt(Pmax * Re) / Math.max(iRms * Math.sqrt(Re) * Math.sqrt(Re) / Re, 1e-12) / Vin;
    const scale = Math.min(vByX, Math.sqrt(Pmax / Math.max(iRms * iRms * Re, 1e-12)));
    void vByP;
    maxSpl.push(db + 20 * Math.log10(scale));
  }
  // −3 dB below the 2× f3-region median
  const ref = [...spl.filter((_, i) => freqs[i] > freqs[0] * 3 && freqs[i] < Math.min(freqs[freqs.length - 1], 200))].sort((a, b) => a - b);
  const top = ref[Math.floor(ref.length * 0.7)] ?? 0;
  let f3 = freqs[0];
  for (let i = 0; i < freqs.length; i++) if (spl[i] >= top - 3) {
    f3 = freqs[i];
    break;
  }
  return { freqs, spl, excursionMm: exc, maxSpl, H, f3 };
}

// ---------------------------------------------------------------------------
// printing: tile the profile onto the bed, slice each core, key the seams
// ---------------------------------------------------------------------------
export interface Printer {
  bedX: number;
  bedY: number;
  maxZ: number;
  margin: number;
  /** nozzle diameter, extrusion line width and layer height (mm) */
  nozzle: number;
  lineWidth: number;
  layerH: number;
  /** sustained volumetric flow (mm³/s) — ~30 for a 1.2 mm nozzle on a high-flow hot end */
  flow: number;
  filamentDensity: number; // g/cm³
}
export const DEFAULT_PRINTER: Printer = {
  bedX: 250,
  bedY: 370,
  maxZ: 300,
  margin: 10,
  nozzle: 1.2,
  lineWidth: 1.5,
  layerH: 0.8,
  flow: 30,
  filamentDensity: 1.27,
};

export interface Segment {
  id: string;
  /** tile name within a core, e.g. B2 */
  tile: string;
  core: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  /** footprint on the bed (mm), after rotation */
  bedW: number;
  bedH: number;
  grams: number;
}

export interface PrintPlan {
  rotated: boolean;
  usable: [number, number];
  cutsX: number[];
  cutsY: number[];
  /** layer splits inside each core (mm from that core's bottom) */
  cutsZ: number[];
  segments: Segment[];
  keys: { x: number; y: number }[];
  totalGrams: number;
  hours: number;
  solidFraction: number;
  layers: number;
}

export function isAir(g: Geometry, x: number, y: number) {
  if (!pointInPoly(g.core, x, y)) return true;
  for (const h of g.holes) if (pointInPoly(h, x, y)) return true;
  return false;
}

export function planPrint(g: Geometry, pr: Printer): PrintPlan {
  const ux = pr.bedX - 2 * pr.margin;
  const uy = pr.bedY - 2 * pr.margin;
  const tiles = (a: number, b: number) => Math.ceil(g.W / a) * Math.ceil(g.H / b);
  const rotated = tiles(uy, ux) < tiles(ux, uy);
  const [ax, ay] = rotated ? [uy, ux] : [ux, uy];
  const nx = Math.ceil(g.W / ax);
  const ny = Math.ceil(g.H / ay);
  const nz = Math.ceil(g.coreMm / pr.maxZ);
  // put cuts through solid walls where possible (stronger joints, keys have material to bite)
  const snap = (v: number, along: 'x' | 'y') => {
    const n0 = along === 'x' ? nx : ny;
    const len0 = along === 'x' ? g.W : g.H;
    const lim = along === 'x' ? ax : ay;
    const win = Math.max(0, Math.min(40, Math.floor((lim - len0 / n0) / 2)));
    let best = v;
    let bestScore = -1;
    for (let dv = -win; dv <= win; dv += 2) {
      const c = v + dv;
      let solid = 0;
      for (let i = 0; i <= 60; i++) {
        const q = ((along === 'x' ? g.H : g.W) * i) / 60;
        if (!(along === 'x' ? isAir(g, c, q) : isAir(g, q, c))) solid++;
      }
      if (solid > bestScore || (solid === bestScore && Math.abs(dv) < Math.abs(best - v))) {
        bestScore = solid;
        best = c;
      }
    }
    return best;
  };
  const cutsX = Array.from({ length: nx - 1 }, (_, i) => snap((g.W * (i + 1)) / nx, 'x'));
  const cutsY = Array.from({ length: ny - 1 }, (_, i) => snap((g.H * (i + 1)) / ny, 'y'));
  const cutsZ = Array.from({ length: nz - 1 }, (_, i) => (g.coreMm * (i + 1)) / nz);
  const xs = [0, ...cutsX, g.W];
  const ys = [0, ...cutsY, g.H];
  const zs = [0, ...cutsZ, g.coreMm];
  // density map: the slicer prints solid perimeters near every surface and sparse
  // infill deeper inside thick blobs (filleted corners, the block under a chamber…)
  const step = 5;
  const gx = Math.ceil(g.W / step);
  const gy = Math.ceil(g.H / step);
  const solid = new Uint8Array(gx * gy);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) solid[j * gx + i] = isAir(g, (i + 0.5) * step, (j + 0.5) * step) ? 0 : 1;
  // chamfer distance (mm) from each solid cell to the nearest air / outside
  const INF = 1e9;
  const dist = new Float64Array(gx * gy);
  for (let q = 0; q < gx * gy; q++) dist[q] = solid[q] ? INF : 0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= gx || j >= gy ? 0 : dist[j * gx + i]);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) {
      const q = j * gx + i;
      if (!solid[q]) continue;
      dist[q] = Math.min(dist[q], at(i - 1, j) + step, at(i, j - 1) + step, at(i - 1, j - 1) + step * 1.414, at(i + 1, j - 1) + step * 1.414);
    }
  for (let j = gy - 1; j >= 0; j--)
    for (let i = gx - 1; i >= 0; i--) {
      const q = j * gx + i;
      if (!solid[q]) continue;
      dist[q] = Math.min(dist[q], at(i + 1, j) + step, at(i, j + 1) + step, at(i + 1, j + 1) + step * 1.414, at(i - 1, j + 1) + step * 1.414);
    }
  const shell = Math.max(g.wallMm / 2 + pr.lineWidth, 3 * pr.lineWidth);
  const dens = (q: number) => (!solid[q] ? 0 : dist[q] - step / 2 <= shell ? 0.95 : 0.15);
  let filled = 0;
  let solidCells = 0;
  for (let q = 0; q < gx * gy; q++) {
    filled += dens(q);
    if (solid[q]) solidCells++;
  }
  const solidFraction = solidCells / (gx * gy);
  const massIn = (x0: number, x1: number, y0: number, y1: number, zMm: number) => {
    let m = 0;
    for (let j = Math.floor(y0 / step); j < Math.min(gy, Math.ceil(y1 / step)); j++)
      for (let i = Math.floor(x0 / step); i < Math.min(gx, Math.ceil(x1 / step)); i++) m += dens(j * gx + i);
    return (m * step * step * zMm * pr.filamentDensity) / 1000;
  };
  void filled;
  const segments: Segment[] = [];
  for (let c = 0; c < g.cores; c++)
    for (let k = 0; k < zs.length - 1; k++)
      for (let j = 0; j < ys.length - 1; j++)
        for (let i = 0; i < xs.length - 1; i++) {
          const grams = massIn(xs[i], xs[i + 1], ys[j], ys[j + 1], zs[k + 1] - zs[k]);
          const w = xs[i + 1] - xs[i];
          const h = ys[j + 1] - ys[j];
          segments.push({
            id: `${g.cores > 1 ? `${c + 1}·` : ''}${String.fromCharCode(65 + j)}${i + 1}${zs.length > 2 ? `·L${k + 1}` : ''}`,
            tile: `${String.fromCharCode(65 + j)}${i + 1}`,
            core: c,
            x0: xs[i],
            x1: xs[i + 1],
            y0: ys[j],
            y1: ys[j + 1],
            z0: zs[k],
            z1: zs[k + 1],
            bedW: rotated ? h : w,
            bedH: rotated ? w : h,
            grams,
          });
        }
  // alignment keys: where a seam runs through solid, one key per ~80 mm of solid
  const keys: PrintPlan['keys'] = [];
  const seam = (fixed: number, along: 'x' | 'y') => {
    const len = along === 'x' ? g.H : g.W;
    let run0 = -1;
    for (let q = 0; q <= len; q += 2) {
      const sld = q > 0 && q < len && !(along === 'x' ? isAir(g, fixed, q) : isAir(g, q, fixed));
      if (sld && run0 < 0) run0 = q;
      if (!sld && run0 >= 0) {
        const run = q - run0;
        if (run >= 5) {
          const n = Math.max(1, Math.floor(run / 80));
          for (let m = 0; m < n; m++) {
            const v = run0 + (run * (m + 0.5)) / n;
            keys.push(along === 'x' ? { x: fixed, y: v } : { x: v, y: fixed });
          }
        }
        run0 = -1;
      }
    }
  };
  cutsX.forEach((c) => seam(c, 'x'));
  cutsY.forEach((c) => seam(c, 'y'));
  const totalGrams = segments.reduce((a, s) => a + s.grams, 0);
  const volMm3 = (totalGrams / pr.filamentDensity) * 1000;
  const hours = ((volMm3 / Math.max(pr.flow, 1)) * 1.3) / 3600; // +30 % travel/acceleration
  return {
    rotated,
    usable: [ux, uy],
    cutsX,
    cutsY,
    cutsZ,
    segments,
    keys,
    totalGrams,
    hours,
    solidFraction,
    layers: Math.ceil(g.coreMm / Math.max(pr.layerH, 0.05)),
  };
}

// ---------------------------------------------------------------------------
// practical build checks
// ---------------------------------------------------------------------------
export interface Issue {
  level: 'ok' | 'warn' | 'bad';
  title: string;
  body: string;
}

const PLATES = {
  bb18: { name: '18 mm Baltic birch', E: 11.5e9, rho: 680, nu: 0.3 },
  bb12: { name: '12 mm Baltic birch', E: 11.5e9, rho: 680, nu: 0.3 },
  mdf19: { name: '19 mm MDF', E: 3.5e9, rho: 750, nu: 0.25 },
};
const PETG = { E: 2.0e9, rho: 1270, nu: 0.38 };

export function buildIssues(p: HybridParams, g: Geometry, d: DriverInfo, plan: PrintPlan, pr: Printer, outdoor: boolean): Issue[] {
  const out: Issue[] = [];
  const plate = PLATES[p.plateMaterial];
  const tp = p.plateMm / 1000;
  const passTop = p.type === 'folded-horn' ? 150 : p.type === 'waveguide' ? 20000 : 500;
  // limits for "bad" / "watch it": subs only play to ~150 Hz; a stuffed line or a box's
  // walls only need to stay clear of the low-mid band where they'd be excited strongly
  const lim =
    p.type === 'folded-horn'
      ? { wallBad: 200, wallWarn: 400, plateBad: 300, plateWarn: 750 }
      : p.type === 'waveguide'
        ? { wallBad: 0, wallWarn: 0, plateBad: 0, plateWarn: 0 }
        : { wallBad: 150, wallWarn: 300, plateBad: 250, plateWarn: 500 };

  // ---- printer settings ----
  const maxLayer = pr.nozzle * 0.75;
  if (pr.layerH > maxLayer)
    out.push({
      level: 'bad',
      title: `${pr.layerH} mm layers won't bond with a ${pr.nozzle} mm nozzle`,
      body: `Layer height should stay under ~75 % of the nozzle (≈ ${maxLayer.toFixed(1)} mm here) or the layers barely touch and the walls leak and split. ${pr.layerH >= pr.nozzle ? `${pr.layerH} mm works well as the LINE WIDTH instead.` : ''}`,
    });
  if (pr.lineWidth < pr.nozzle * 0.95 || pr.lineWidth > pr.nozzle * 1.6)
    out.push({ level: 'warn', title: `Line width ${pr.lineWidth} mm vs ${pr.nozzle} mm nozzle`, body: 'Line widths of ~100–150 % of the nozzle print reliably; outside that the walls get weak or blobby.' });
  const lines = p.wallMm / pr.lineWidth;
  out.push({
    level: Math.abs(lines - Math.round(lines)) > 0.05 ? 'warn' : 'ok',
    title: `Walls: ${p.wallMm} mm = ${lines.toFixed(lines % 1 ? 1 : 0)} lines at ${pr.lineWidth} mm, ${pr.layerH} mm layers`,
    body: `${Math.abs(lines - Math.round(lines)) > 0.05 ? `Not a whole number of lines — the slicer will leave a gap or overlap. Use ${(Math.round(lines) * pr.lineWidth).toFixed(1)} mm. ` : ''}Set the slicer to ${Math.round(lines)} perimeters so walls are solid perimeters (no infill gaps for air to leak through). With the profile flat on the bed, every layer is a complete cross-section: a leak would have to cross all ${Math.round(lines)} lines. Fat lines leave rough walls — harmless below ~500 Hz in a horn or line.`,
  });

  // ---- printed walls spanning between plates/dividers (the floppiest part) ----
  const tw = p.wallMm / 1000;
  const span = g.coreMm / 1000;
  const Dw = (PETG.E * tw ** 3) / (12 * (1 - PETG.nu ** 2));
  const fWall = (22.37 / (2 * Math.PI)) * Math.sqrt(Dw / (PETG.rho * tw)) / (span * span); // clamped strip
  out.push({
    level: fWall < lim.wallBad ? 'bad' : fWall < lim.wallWarn ? 'warn' : 'ok',
    title: `Printed walls flex at ≈ ${fWall.toFixed(0)} Hz (span ${g.coreMm.toFixed(0)} mm between plates)`,
    body:
      fWall < lim.wallWarn
        ? `Walls glued between two plates ${g.coreMm.toFixed(0)} mm apart act like a ${p.wallMm} mm PETG strip clamped on both edges. ${fWall < lim.wallBad ? `That is inside the band this cabinet plays (up to ~${passTop} Hz) — they will buzz and lose output.` : `That is above the ~${passTop} Hz this cabinet plays, but close enough that loud bass can excite it.`} Fixes: add a plywood divider (halving the span raises this ×4), thicken walls (×1.5 thickness ≈ ×1.5 frequency), or curve the walls (an arch is far stiffer than a flat strip).`
        : `Comfortably above the ~${passTop} Hz this cabinet plays. Curved bends add stiffness on top of this.`,
  });

  // ---- side plates over the open channels ----
  let worst = { a: 0, b: 0, f: Infinity, label: '' };
  const D = (plate.E * tp ** 3) / (12 * (1 - plate.nu ** 2));
  for (const r of g.spans) {
    const a = (r.x1 - r.x0) / 1000;
    const b = (r.y1 - r.y0) / 1000;
    if (a < 0.03 || b < 0.03) continue;
    const f11 = 1.8 * (Math.PI / 2) * Math.sqrt(D / (plate.rho * tp)) * (1 / (a * a) + 1 / (b * b));
    if (f11 < worst.f) worst = { a, b, f: f11, label: r.label ?? 'channel' };
  }
  if (Number.isFinite(worst.f))
    out.push({
      level: worst.f < lim.plateBad ? 'bad' : worst.f < lim.plateWarn ? 'warn' : 'ok',
      title: `Side-plate resonance: ${worst.f.toFixed(0)} Hz over the ${worst.label}`,
      body: `The ${plate.name} plate spans ${(worst.a * 1000).toFixed(0)} × ${(worst.b * 1000).toFixed(0)} mm unsupported there. ${
        worst.f < lim.plateWarn ? `Close to the band this cabinet plays — add printed posts or ribs in that space, use a thicker plate, or laminate a second plate.` : 'Comfortably above the band this cabinet plays.'
      }`,
    });

  // ---- pressure / sealing ----
  const Vd = (d.sdCm2 / 1e4) * ((d.xmaxMm || 3) / 1000);
  const rearL = g.chambers.find((c) => /Rear|Box/.test(c.label))?.volumeL ?? 0;
  const pPeak = rearL > 0 ? (RHO * C * C * Vd) / (rearL / 1000) : 0;
  if (pPeak > 0)
    out.push({
      level: pPeak > 3000 ? 'warn' : 'ok',
      title: `Air pressure in the ${/Rear/.test(g.chambers[0]?.label ?? '') ? 'rear chamber' : 'box'}: up to ${(pPeak / 1000).toFixed(1)} kPa at Xmax`,
      body: `Leaks whistle and cost bass. Seal the inside of every chamber and channel with 2 coats of thin epoxy (or a brush-on polyurethane), and seal the plate joints (below). Test: block the mouth/port, push the cone gently — it should come back slowly.`,
    });

  // ---- plates to core ----
  const perim = 2 * (g.W + g.H);
  const bolts = Math.ceil(perim / 150) * g.cores + g.spans.length;
  out.push({
    level: 'ok',
    title: `Plates and dividers to cores: glue + ${bolts} through-bolts${g.cores > 1 ? `, ${g.cores - 1} divider${g.cores > 2 ? 's' : ''}` : ''}`,
    body: `Sand each core's two faces flat (sandpaper on glass) — fat-nozzle top layers are never perfectly flat. Glue plates${g.cores > 1 ? ' and dividers' : ''} on with polyurethane construction adhesive or thickened epoxy along every wall edge (it fills gaps and seals). Clamp with M6 threaded rod through printed bosses every ~150 mm around the outside and at wall junctions (≈ ${bolts}); rods running through all cores and dividers also keep the stack aligned. For a removable plate (to service a horn driver) use 3 mm closed-cell EPDM gasket on the wall edges with heat-set M6 inserts instead of glue.`,
  });

  // ---- print volume ----
  if (plan.totalGrams > 6000)
    out.push({
      level: 'warn',
      title: `Big print: ~${(plan.totalGrams / 1000).toFixed(0)} kg of filament, ~${plan.hours.toFixed(0)} h at ${pr.flow} mm³/s`,
      body: 'Estimate assumes solid perimeters near every surface and 15 % infill inside thick corners. To cut it down: print only the complex parts (bends, throat, mouth) and use plywood strips for long straight walls between the plates; lower the wall count where the flex check allows; or build one cabinet and measure before printing four.',
    });
  out.push({
    level: plan.segments.length > 40 ? 'warn' : 'ok',
    title: `${plan.segments.length} printed pieces · ${(plan.totalGrams / 1000).toFixed(1)} kg · ~${plan.hours.toFixed(0)} h`,
    body: `${plan.keys.length} dovetail alignment keys where seams cross walls${plan.cutsZ.length ? `, plus 8 mm dowel pins through the walls between the ${plan.cutsZ.length + 1} layers of each core` : ''}. Glue seams with epoxy (PETG/ASA) and run a bead along every seam inside the channels before closing with the plates.`,
  });
  if (outdoor)
    out.push({
      level: 'warn',
      title: 'Outdoors: print in PETG or ASA, not PLA',
      body: 'PLA softens around 55–60 °C — a dark cabinet in summer sun gets there. PETG or ASA hold up; ASA also resists UV. Seal plywood edges and paint (or use exterior ply): dew in a clearing will swell raw Baltic birch.',
    });
  if (g.driver.face === 'front')
    out.push({
      level: p.wallMm < 12 ? 'warn' : 'ok',
      title: 'Driver mounting on a printed wall',
      body: `The front wall is ${p.wallMm} mm. Thicken it to ≥ 15 mm around the driver (a printed boss ring) with heat-set inserts, or glue a plywood ring/baffle on the front — plastic threads strip.`,
    });
  if (g.driver.face === 'internal' && p.type === 'folded-horn')
    out.push({
      level: 'warn',
      title: 'Getting the driver in and out',
      body: 'The driver sits on an internal wall. Make one side plate removable over the rear chamber (gasket + inserts), or print a driver hatch.',
    });
  for (const w of g.warnings) out.push({ level: g.fits ? 'warn' : 'bad', title: 'Geometry', body: w });
  return out;
}

/** Normalised per-cabinet response for the maps: unity in the passband of a single (uncoupled) cabinet. */
export function mapResponse(sim1: SimResult, simN: SimResult, band: [number, number]) {
  const ref = (() => {
    const v: number[] = [];
    sim1.freqs.forEach((f, i) => {
      if (f >= band[0] && f <= band[1]) v.push(abs(sim1.H[i]));
    });
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 1;
  })();
  const fs = simN.freqs;
  return (f: number): Cx => {
    // log-frequency interpolation of the complex response
    if (f <= fs[0]) return scl(simN.H[0], 1 / ref);
    if (f >= fs[fs.length - 1]) return scl(simN.H[fs.length - 1], 1 / ref);
    let i = 1;
    while (fs[i] < f) i++;
    const t = Math.log(f / fs[i - 1]) / Math.log(fs[i] / fs[i - 1]);
    const a = simN.H[i - 1];
    const b = simN.H[i];
    return scl(add(scl(a, 1 - t), scl(b, t)), 1 / ref);
  };
}

export { sub as cxSub };
