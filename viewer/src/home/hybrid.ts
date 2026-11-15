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
import { findDriver, type DriverInfo } from './drivers';
import { shellBands, shellGeometry, shellVolumeCm3, type ShellGeometry } from './shell';
import { baffleResponse } from './diffraction';
import { abs as cabs, arg as carg, quarterWaveHz, solveLine, trapTuningHz, type Stuffing, type Trap } from './lineNetwork';

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
export type ProfileType = 'folded-horn' | 'tl' | 'slot-port' | 'waveguide' | 'sealed' | 'blh' | 'tapped' | 'shell';
/** printed tweeter head on top of a living-room cabinet */
export type HeadKind = 'none' | 'flat' | 'waveguide';
export type TweeterMount = 'none' | 'front' | 'pod';
export type MouthPlace = 'edge' | 'corner';

export type PlateMaterial = 'bb18' | 'mdf19' | 'bb12' | 'sandwich' | 'glass' | 'acrylic';

export type SandwichCore = 'ribs' | 'balsa' | 'paulownia' | 'poplar';

export interface SandwichSpec {
  skin: 'carbon' | 'glass';
  /** what holds the skins apart: printed ribs or a light wood */
  core: SandwichCore;
  /** layers of 200 g/m² woven cloth on EACH face */
  plies: number;
  /** core thickness (mm) */
  coreMm: number;
  /** rib spacing (mm) — square grid */
  ribPitchMm: number;
  /** rib thickness in extrusion lines */
  ribLines: number;
}

export const DEFAULT_SANDWICH: SandwichSpec = { skin: 'carbon', core: 'ribs', plies: 3, coreMm: 20, ribPitchMm: 40, ribLines: 2 };

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
  plateMaterial: PlateMaterial;
  /** skins + printed rib core, used when plateMaterial is 'sandwich' */
  sandwich: SandwichSpec;
  /** plywood dividers that split the printed core into thinner cores (stiffer walls, shorter prints) */
  dividers: number;
  /** printed wall thickness (mm) — a whole number of extrusion lines */
  wallMm: number;
  /** how much corners are rounded (0 = square, 1 = as round as the space allows) */
  rounding: number;
  /** 'full' = the whole core is printed; 'bends' = printed end-caps hold plywood straight walls */
  construction: 'full' | 'bends';
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
  /** (older saves) separately printed tweeter head — superseded by tweeterMount + tweeterWaveguide */
  head?: HeadKind;
  tweeterId?: string;
  /** transmission line: mount the woofer at this front fold (0 = the closed end; 1 = first front fold ≈ ⅓ along…) */
  driverFold?: number;
  /** lines and horns: stretches stuffed with fibre (fractions of the path) */
  stuffing?: Stuffing[];
  /** resonance traps: printed Helmholtz bottles on a side plate, each tuned to this line harmonic (3, 5…) */
  trapHarmonics?: number[];
  /** slot / port mouths: flare radius of the rounded ends (mm) — quieter at high air speed */
  portFlareMm?: number;
  /** living-room 2-ways: the tweeter in the cabinet's front wall, in a separate printed pod on top, or none */
  tweeterMount?: TweeterMount;
  /** a printed round waveguide round the tweeter (an insert in the front wall, or the pod's face) */
  tweeterWaveguide?: boolean;
  /** planned crossover (Hz): sizes the tweeter waveguide's mouth so it controls down to there */
  tweeterXoHz?: number;
  /** waveguide coverage angle (deg) — also used by the 2D 'waveguide' profile */
}

export const HYBRID_PRESETS: Record<'sub' | 'living' | 'waveguide', HybridParams> = {
  sub: {
    type: 'folded-horn',
    driverId: 'bc-18tbw100',
    depthMm: 950,
    heightMm: 900,
    extrusionMm: 580,
    plateMm: 18,
    sandwich: { ...DEFAULT_SANDWICH },
    plateMaterial: 'bb18',
    dividers: 1,
    wallMm: 18,
    rounding: 0.9,
    construction: 'bends',
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
    sandwich: { ...DEFAULT_SANDWICH },
    plateMaterial: 'bb18',
    dividers: 0,
    wallMm: 9,
    rounding: 0.9,
    construction: 'full',
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
    sandwich: { ...DEFAULT_SANDWICH },
    plateMaterial: 'bb12',
    dividers: 0,
    wallMm: 7.5,
    rounding: 1,
    construction: 'full',
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
  construction: 'full' | 'bends';
  /** 'bends' construction: the printed end-cap regions… */
  caps: Rect[];
  /** …and the plywood strips between them (per core) */
  strips: Strip[];
  /** sealed empty space boxed in by plywood (not printed) */
  dead: Rect[];
  labels: { x: number; y: number; text: string }[];
  /** 'front': in the front wall facing out; 'internal': on an internal baffle facing forward;
   *  'down': on a fold wall, cone facing down (a tapped horn), x = centre along the depth */
  driver: { x: number; y: number; dia: number; face: 'front' | 'internal' | 'down' };
  /** path along the horn / line / port, start → exit: cumulative length (mm), area (mm²), bend nodes */
  path: { s: number[]; area: number[]; bend?: boolean[] };
  /** path position (mm) of each 180° fold's middle, in order */
  foldS?: number[];
  /** where the driver's rear (and, for a tapped horn, front) feed the path (mm along it) */
  taps?: { rearMm: number; frontMm?: number };
  /** a curved shell (solid of revolution about the woofer axis) instead of an extruded profile */
  shell?: ShellGeometry;
  /** resonance traps fitted (designed from trapHarmonics), with where they sit in the profile */
  traps?: (Trap & { harmonic: number; x: number; y: number; diaMm: number; lenMm: number; neckX: number; neckY: number })[];
  mouthRect: Rect | null;
  /** where plywood dividers are cut away (profile coords): a notch round the driver,
   *  and a window through each box chamber so it stays one volume of air */
  dividerCuts: Pt[][];
  /** tweeter mounted in the front wall above the woofer (centre height, hole radius in the wall) */
  tweeter: { y: number; holeR: number; waveguide: RoundWaveguide | null; driver: DriverInfo } | null;
  chambers: { label: string; volumeL: number }[];
  stats: { label: string; value: string }[];
  fits: boolean;
  warnings: string[];
}

export interface Strip {
  name: string;
  /** where it sits in the profile (mm) */
  rect: Rect;
  lengthMm: number;
  thickMm: number;
  /** across the core (= printed core thickness) */
  widthMm: number;
  qty: number;
  note?: string;
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
function fillet(poly0: Pt[], convexR: (minEdge: number, p: Pt) => number, concaveR: (minEdge: number, p: Pt) => number): Pt[] {
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
    let r = convex ? convexR(minEdge, P) : concaveR(minEdge, P);
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

/** Do two segments properly cross (touching ends don't count)? */
function segsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Does a polygon's outline cross itself? */
export function selfIntersects(poly: Pt[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  return false;
}

function polysCross(a: Pt[], b: Pt[]) {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) if (segsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}

/**
 * Fillet, easing the rounding off until the outline doesn't cross itself: rounding is
 * cosmetic, so where radii would collide (short walls, tight folds) it gives way.
 */
function filletSafe(poly: Pt[], convexR: (minEdge: number, p: Pt) => number, concaveR: (minEdge: number, p: Pt) => number): Pt[] {
  for (const f of [1, 0.75, 0.5, 0.3, 0.15]) {
    const out = fillet(poly, (m, q) => convexR(m, q) * f, (m, q) => concaveR(m, q) * f);
    if (!selfIntersects(out)) return out;
  }
  return fillet(poly, () => 0, () => 0);
}

/** A profile that can't exist: crossing outline, chambers breaking out or overlapping. */
export function profileProblems(core: Pt[], holes: Pt[][]): string[] {
  const out: string[] = [];
  if (selfIntersects(core)) out.push('The profile overlaps itself (its walls cross) — the folds don\'t fit in this size: make it bigger or use fewer legs.');
  holes.forEach((h, i) => {
    if (selfIntersects(h)) out.push(`A chamber outline crosses itself (chamber ${i + 1}).`);
    if (polysCross(h, core) || !h.every((q) => pointInPoly(core, q[0], q[1]))) out.push(`A chamber breaks through the outer wall (chamber ${i + 1}).`);
  });
  for (let i = 0; i < holes.length; i++)
    for (let j = i + 1; j < holes.length; j++)
      if (polysCross(holes[i], holes[j]) || pointInPoly(holes[j], holes[i][0][0], holes[i][0][1]) || pointInPoly(holes[i], holes[j][0][0], holes[j][0][1]))
        out.push(`Two chambers overlap (${i + 1} and ${j + 1}).`);
  return out;
}

/**
 * Front-mounted parts must sit fully on solid front face (not over a rounded edge, a
 * port exit or air), their holes inside the printed front, and not on top of each other.
 */
export function frontMountProblems(g: Geometry, plateMm: number, woofer: DriverInfo): string[] {
  const out: string[] = [];
  const faceX = g.W - 0.5;
  const solid = (y: number) => y > 0 && y < g.H && pointInPoly(g.core, faceX, y) && !g.holes.some((h) => pointInPoly(h, faceX, y));
  const faceW = g.Etot + 2 * plateMm;
  const parts: { name: string; y: number; r: number; hole: number }[] = [];
  if (g.driver.face === 'down') {
    const R = woofer.frameDiaMm / 2;
    for (let dx = -R; dx <= R; dx += 1)
      if (!pointInPoly(g.core, g.driver.x + dx, g.driver.y) || g.holes.some((h) => pointInPoly(h, g.driver.x + dx, g.driver.y))) {
        out.push(`The woofer frame (Ø${woofer.frameDiaMm} mm) would hang off the end of its fold wall — a deeper cabinet.`);
        break;
      }
    if (woofer.cutoutDiaMm > g.Etot - 8) out.push(`The woofer's cut-out (Ø${woofer.cutoutDiaMm} mm) doesn't fit across the ${Math.round(g.Etot)} mm wide fold wall — widen the cabinet.`);
  }
  if (g.driver.face === 'front') parts.push({ name: `woofer frame (Ø${woofer.frameDiaMm} mm)`, y: g.driver.y, r: woofer.frameDiaMm / 2, hole: woofer.cutoutDiaMm });
  if (g.tweeter)
    parts.push({
      name: g.tweeter.waveguide ? `waveguide flange (Ø${Math.round(2 * g.tweeter.waveguide.flangeR)} mm)` : `tweeter faceplate (Ø${g.tweeter.driver.frameDiaMm} mm)`,
      y: g.tweeter.y,
      r: g.tweeter.waveguide ? g.tweeter.waveguide.flangeR : g.tweeter.driver.frameDiaMm / 2,
      hole: 2 * g.tweeter.holeR,
    });
  for (const q of parts) {
    if (2 * q.r > faceW + 0.5) out.push(`The ${q.name} is wider than the front (${Math.round(faceW)} mm) — widen the cabinet.`);
    if (q.hole > g.Etot - 8) out.push(`The hole for the ${q.name.split(' (')[0]} (Ø${Math.round(q.hole)} mm) doesn't fit in the ${Math.round(g.Etot)} mm printed front — widen the cabinet.`);
    for (let dy = -q.r; dy <= q.r; dy += 1)
      if (!solid(q.y + dy)) {
        out.push(`The ${q.name} would hang off the front (${Math.round(Math.abs(dy))} mm ${dy > 0 ? 'above' : 'below'} its centre there's no front face) — taller cabinet or less rounding.`);
        break;
      }
  }
  if (parts.length === 2 && Math.abs(parts[0].y - parts[1].y) < parts[0].r + parts[1].r)
    out.push('The woofer and tweeter overlap on the front — taller cabinet, or a smaller waveguide.');
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

function seg(s: number[], a: number[], len: number, a0: number, a1: number, n = 6, bends?: boolean[], isBend = false) {
  const start = s.length ? s[s.length - 1] : 0;
  for (let i = 1; i <= n; i++) {
    s.push(start + (len * i) / n);
    a.push(a0 + ((a1 - a0) * i) / n);
    bends?.push(isBend);
  }
}

/**
 * Resonance traps for a line: one printed Helmholtz bottle per requested
 * harmonic, tuned to it, hung off the path near the closed end (where every
 * odd harmonic has a pressure maximum), on the outside of a side plate with
 * its neck through the plate into the channel.
 */
function designTraps(p: HybridParams, path: { s: number[]; area: number[] }, legs: Leg[], xa: number, xb: number, W: number, t: number): Geometry['traps'] {
  if (!p.trapHarmonics?.length || !legs.length || path.s.length < 2) return [];
  const L = path.s[path.s.length - 1];
  const fq = quarterWaveHz(L, path.area[path.area.length - 1], 1);
  const neckAreaCm2 = 4;
  const neckLenMm = 30;
  const H = legs[0].yt + t;
  return p.trapHarmonics.map((h, k) => {
    const f = fq * h;
    const S = neckAreaCm2 / 1e4;
    const a = Math.sqrt(S / Math.PI);
    const V = S / (((2 * Math.PI * f) / C) ** 2 * (neckLenMm / 1000 + 1.7 * a)); // m³
    // a wide, shallow drum on the plate (~60 mm deep), no bigger than the plate allows
    const dia = Math.max(50, Math.min(160, Math.sqrt((4 * V * 1e9) / (Math.PI * 60)), 0.45 * Math.min(W, H)));
    const lenMm = (V * 1e9) / (Math.PI * (dia / 2) ** 2);
    // its neck opens into the first leg near the closed end (every odd harmonic's pressure peak)
    const atMm = Math.min(0.04 * L + k * 60, (xb - xa) * 0.8);
    const neckX = p.type === 'tl' || p.type === 'tapped' ? xb - atMm : xa + atMm;
    const neckY = (legs[0].yt + legs[0].yb) / 2;
    // the drum sits over the neck, shifted to stay on the plate (the neck can be off-centre)
    const x = Math.max(dia / 2 + 8, Math.min(neckX, W - dia / 2 - 8)) - k * (dia + 10);
    const y = Math.max(dia / 2 + 8, Math.min(neckY, H - dia / 2 - 8));
    void trapTuningHz;
    return { atMm, volumeL: V * 1000, neckAreaCm2, neckLenMm, q: 3, harmonic: h, x, y, diaMm: Math.round(dia), lenMm, neckX, neckY };
  });
}

/** Plywood dividers keep this much frame round a chamber window (like a window brace). */
const DIVIDER_FRAME_MM = 30;

function insetRect(r: Rect, m: number): Rect | null {
  const o = { x0: r.x0 + m, x1: r.x1 - m, y0: r.y0 + m, y1: r.y1 - m };
  return o.x1 - o.x0 > 20 && o.y1 - o.y0 > 20 ? o : null;
}

/** The space a driver's basket and magnet need, as seen in the profile (a divider must be cut away here). */
function driverCutRect(dv: Geometry['driver'], d: DriverInfo, W: number, t: number): Rect {
  const md = d.mountDepthMm ?? 80;
  const r = d.cutoutDiaMm / 2 + 6;
  if (dv.face === 'down') return { x0: dv.x - r, x1: dv.x + r, y0: dv.y - t / 2 - 2 * (d.xmaxMm || 5) - 25, y1: dv.y + t / 2 + md + 8 };
  return dv.face === 'front'
    ? { x0: W - t - md - 8, x1: W - t, y0: dv.y - r, y1: dv.y + r }
    : { x0: dv.x - t / 2 - md - 8, x1: dv.x + t / 2 + 12, y0: dv.y - r, y1: dv.y + r };
}

/** Thinnest printed wall between a closed chamber and the outside (a corner can break through). */
function thinnestWall(core: Pt[], holes: Pt[][]): number {
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
  };
  let min = Infinity;
  for (const h of holes)
    for (const p of h) {
      if (!pointInPoly(core, p[0], p[1])) return 0;
      for (let i = 0; i < core.length; i++) min = Math.min(min, segDist(p, core[i], core[(i + 1) % core.length]));
    }
  return min;
}

/** Anything printed inside the woofer's basket / magnet space? (sampled) */
function basketClearance(core: Pt[], holes: Pt[][], dv: Geometry['driver'], d: DriverInfo, W: number, t: number): string | null {
  const md = d.mountDepthMm ?? 80;
  const r = d.cutoutDiaMm / 2 - 1;
  const air = (x: number, y: number) => !pointInPoly(core, x, y) || holes.some((h) => pointInPoly(h, x, y));
  if (dv.face === 'down') {
    // basket + magnet go up from the wall's top face; the cone needs room below
    const top = dv.y + t / 2;
    for (let dy = 2; dy <= md; dy += 4)
      for (let dx = -r; dx <= r; dx += 4) {
        const rr = dy > 0.55 * md ? d.frameDiaMm / 4 : r;
        if (Math.abs(dx) > rr) continue;
        if (!air(dv.x + dx, top + dy)) return `The woofer's ${dy > 0.55 * md ? 'magnet' : 'basket'} runs into print ${Math.round(dy)} mm above its wall — the first channel must be at least ${md} mm tall.`;
      }
    const bottom = dv.y - t / 2;
    const room = 2 * (d.xmaxMm || 5) + 15;
    for (let dy = 2; dy <= room; dy += 3)
      for (let dx = -r; dx <= r; dx += 4) if (!air(dv.x + dx, bottom - dy)) return `The cone needs ${Math.round(room)} mm of free air below its wall to move — the second channel is too short.`;
    return null;
  }
  const xFace = dv.face === 'front' ? W - t : dv.x - t / 2;
  for (let dx = 2; dx <= md; dx += 4)
    for (let dy = -r; dy <= r; dy += 4) {
      // magnet is narrower than the basket rim
      const rr = dx > 0.55 * md ? d.frameDiaMm / 4 : r;
      if (Math.abs(dy) > rr) continue;
      if (!air(xFace - dx, dv.y + dy))
        return `The woofer's ${dx > 0.55 * md ? 'magnet' : 'basket'} runs into a printed wall ${Math.round(dx)} mm behind the front — the space behind the driver must be clear for ${md} mm. Make the first channel taller or the cabinet deeper.`;
    }
  return null;
}

/** Is a cylinder behind the front (radius r, from xFace back `depth` mm) clear of print? */
function cylinderClearance(core: Pt[], holes: Pt[][], xFace: number, depth: number, y: number, r: number, what: string): string | null {
  const air = (x: number, yy: number) => !pointInPoly(core, x, yy) || holes.some((h) => pointInPoly(h, x, yy));
  for (let dx = 2; dx <= depth; dx += 4)
    for (let dy = -r; dy <= r; dy += 4) if (!air(xFace - dx, y + dy)) return `There's printed wall where ${what} needs to go (${Math.round(dx)} mm behind the front) — taller cabinet or a deeper first channel.`;
  return null;
}

/** Air a front-mounted tweeter takes out of the box: its body, and a waveguide's flare (L). */
function tweeterDisplacementL(tw: DriverInfo | null, wg: RoundWaveguide | null): number {
  if (!tw) return 0;
  const body = (Math.PI * (tw.cutoutDiaMm / 2) ** 2 * (tw.mountDepthMm ?? 35)) / 1e6;
  if (!wg) return body;
  let flare = 0;
  for (let i = 1; i < wg.profile.length; i++) {
    const [r0, z0] = wg.profile[i - 1];
    const [r1, z1] = wg.profile[i];
    flare += Math.PI * (((r0 + r1) / 2 + wg.wallMm) ** 2) * (z1 - z0);
  }
  return body + flare / 1e6;
}

/** Union of axis-aligned rectangles as outline polygons (for divider cut-outs). */
export function rectUnion(rects: Rect[]): Pt[][] {
  if (!rects.length) return [];
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const on = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return rects.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
  };
  // directed boundary edges, filled cell on the left (counter-clockwise outlines)
  const edges = new Map<string, Pt>();
  const k = (p: Pt) => `${p[0]},${p[1]}`;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      if (!on(i, j)) continue;
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      if (!on(i, j - 1)) edges.set(k([x0, y0]), [x1, y0]);
      if (!on(i + 1, j)) edges.set(k([x1, y0]) + '|' + y1, [x1, y1]);
      if (!on(i, j + 1)) edges.set(k([x1, y1]) + '|t', [x0, y1]);
      if (!on(i - 1, j)) edges.set(k([x0, y1]) + '|l', [x0, y0]);
    }
  // chain: from each start point, follow the edge leaving the current end point
  const out = new Map<string, { from: Pt; to: Pt; used: boolean }[]>();
  for (const [key, to] of edges) {
    const [a] = key.split('|');
    const [fx, fy] = a.split(',').map(Number);
    const from: Pt = [fx, fy];
    if (!out.has(k(from))) out.set(k(from), []);
    out.get(k(from))!.push({ from, to, used: false });
  }
  const polys: Pt[][] = [];
  for (const list of out.values())
    for (const e0 of list) {
      if (e0.used) continue;
      const poly: Pt[] = [];
      let e: { from: Pt; to: Pt; used: boolean } | undefined = e0;
      while (e && !e.used) {
        e.used = true;
        poly.push(e.from);
        e = out.get(k(e.to))?.find((x) => !x.used);
      }
      // drop collinear points
      const clean = poly.filter((p, i) => {
        const a = poly[(i - 1 + poly.length) % poly.length];
        const b = poly[(i + 1) % poly.length];
        return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
      });
      if (clean.length >= 4) polys.push(clean);
    }
  return polys;
}

/**
 * The profile for a design, checked: anything that can't physically exist (crossing
 * walls, a driver hanging off the front, a pod overhanging the top…) marks it unbuildable
 * with the reason, so it is never offered as a working design.
 */
export function buildGeometry(p: HybridParams, d: DriverInfo): Geometry {
  const g = buildGeometryRaw(p, d);
  const problems = [...profileProblems(g.core, g.holes), ...frontMountProblems(g, p.plateMm, d)];
  const head = headGeometry(p, tweeterSetup(p).tweeter, d);
  if (head) problems.push(...headProblems(head, g, p));
  if (problems.length) {
    g.fits = false;
    g.warnings.push(...problems.filter((x) => !g.warnings.includes(x)));
  }
  return g;
}

function buildGeometryRaw(p: HybridParams, d: DriverInfo): Geometry {
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
  let bends = p.construction === 'bends' && p.type !== 'waveguide' && p.type !== 'sealed';
  let capsForFillet: Rect[] = [];
  const inCaps = (P: Pt) => !bends || capsForFillet.some((c) => P[0] >= c.x0 - 0.5 && P[0] <= c.x1 + 0.5 && P[1] >= c.y0 - 0.5 && P[1] <= c.y1 + 0.5);
  // tweeter in the front wall (living-room 2-ways): its space sits above the woofer
  const tws = tweeterSetup(p);
  const frontTw = tws.mount === 'front' && (p.type === 'sealed' || p.type === 'slot-port' || p.type === 'tl') ? tws.tweeter : null;
  const twWg = frontTw && tws.waveguide ? roundWaveguide(frontTw, p.coverageDeg || 90, Math.max(3, Math.min(t, 6)), p.tweeterXoHz) : null;
  /** radius it takes on the face and behind it, and how deep it reaches from the face */
  const twR = frontTw ? Math.max(twWg ? twWg.flangeR : frontTw.frameDiaMm / 2, twWg ? twWg.R + twWg.wallMm : frontTw.cutoutDiaMm / 2 + 2) : 0;
  const twDepth = frontTw ? (twWg ? twWg.depthMm : 0) + (frontTw.mountDepthMm ?? 35) : 0;
  const twStack = frontTw ? 2 * twR + 8 : 0;
  /** woofer + tweeter centres on the front, inside a vertical span [yb, yt] (tweeter on top) */
  const placeFront = (yb: number, yt: number) => {
    const yTw = frontTw ? yt - 8 - twR : null;
    const yW = frontTw ? yTw! - twR - 8 - dia / 2 : (yb + yt) / 2;
    return { yTw, yW, fits: yW - dia / 2 >= yb + 2 };
  };
  let twY: number | null = null;
  const bendFlags: boolean[] = [];
  const foldS: number[] = [];
  let tapRear = 0;
  let tapFront: number | undefined;
  const driverRef: { d: Geometry['driver'] | null } = { d: null };
  const convex = (minEdge: number, P: Pt) => {
    if (!inCaps(P)) return 0; // plywood corners stay square
    const onOuter = (P[0] < 1 || P[0] > W - 1) && (P[1] < 1 || P[1] > H - 1);
    // outer corners next to the woofer follow the (smaller) inner fillet, so the wall stays t thick
    return onOuter ? nearDriver(P, outerR) : nearDriver(P, k * Math.min(t * 1.5, minEdge / 2));
  };
  const concave0 = (minEdge: number, P: Pt) => (inCaps(P) ? k * 0.5 * minEdge * 0.95 : 0);
  // never let a fillet grow into the space the woofer's basket and magnet need
  const mountDepth = d.mountDepthMm ?? 80;
  const nearDriver = (P: Pt, r: number) => {
    const dv = driverRef.d;
    if (!dv) return r;
    // the space each driver needs, as rectangles in the profile; a fillet at P may only grow
    // until it reaches them (on the front face a driver needs its whole frame on flat face,
    // behind it only its cut-out; a tapped horn's driver needs its basket above the wall and
    // room for the cone below)
    const onFace = P[0] > W - 1;
    const rc = d.cutoutDiaMm / 2;
    const rects: Rect[] = [];
    if (dv.face === 'down') {
      const room = 2 * (d.xmaxMm || 8) + 15;
      rects.push({ x0: dv.x - rc, x1: dv.x + rc, y0: dv.y - t / 2 - room, y1: dv.y + t / 2 + mountDepth });
      rects.push({ x0: dv.x - dia / 2, x1: dv.x + dia / 2, y0: dv.y - t / 2 - 1, y1: dv.y + t / 2 + 1 });
    } else {
      const rr = onFace && dv.face === 'front' ? dia / 2 : rc;
      rects.push({
        x0: dv.face === 'front' ? W - t - mountDepth - 10 : dv.x - t / 2 - mountDepth - 10,
        x1: dv.face === 'front' ? W : dv.x + t / 2 + 10,
        y0: dv.y - rr,
        y1: dv.y + rr,
      });
    }
    if (twY !== null) rects.push({ x0: W - twDepth - 10, x1: W, y0: twY - twR, y1: twY + twR });
    let out = r;
    for (const q of rects) {
      const dx = Math.max(q.x0 - P[0], 0, P[0] - q.x1);
      const dy = Math.max(q.y0 - P[1], 0, P[1] - q.y1);
      out = Math.min(out, Math.max(0, Math.hypot(dx, dy) - 2));
    }
    return out;
  };
  const concave = (minEdge: number, P: Pt) => nearDriver(P, concave0(minEdge, P));
  let gapsUsed: number[] = [];
  let hornInfo: { xDrv: number; tcFront: number; tcBot: number } | null = null;
  let voidTop = 0;
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
    const core = filletSafe(coreWithChannel(W, H, A, B), (me, P) => ((P[0] < 1 || P[0] > W - 1) && (P[1] < 1 || P[1] > H - 1) ? outerR : k * Math.min(30, me / 2)), () => 0);
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
      construction: 'full',
      caps: [],
      strips: [],
      dead: [],
      core,
      holes,
      spans: [{ x0: t, x1: W, y0: cy - mouthW / 2, y1: cy + mouthW / 2 }],
      labels,
      driver: { x: t / 2, y: cy, dia: Math.max(p.throatMm, dia * 0.6), face: 'internal' },
      path: { s: [0, len], area: [p.throatMm * E, mouthW * E] },
      mouthRect: { x0: W - 1, x1: W, y0: cy - mouthW / 2, y1: cy + mouthW / 2 },
      dividerCuts: [],
      tweeter: null,
      chambers,
      stats,
      fits,
      warnings,
    };
  }

  if (p.type === 'shell') {
    // curved shell: depthMm = length along the woofer axis, heightMm = diameter;
    // rounding 1 → ellipsoid (a sphere if length = diameter), 0 → a fuller capsule
    const sg = shellGeometry({ diaMm: H, lengthMm: W, n: 2 + 4 * (1 - k), wallMm: t }, d);
    for (const pr of sg.problems) {
      fits = false;
      warnings.push(pr);
    }
    if (tws.mount === 'front') warnings.push('A round shell has one front pole — the tweeter goes in a pod on top (on a printed saddle), or use a coaxial driver.');
    const cy = H / 2;
    // the axial cross-section, for the drawing and the front-face checks
    const outerTop = sg.section.slice(0, sg.section.findIndex(([r, z]) => r === sg.holeR && z === sg.zFront));
    const core: Pt[] = [...outerTop.map(([r, z]) => [z, cy + r] as Pt), ...[...outerTop].reverse().map(([r, z]) => [z, cy - r] as Pt)];
    const innerPts = sg.section.slice(sg.section.findIndex(([r, z]) => r === sg.holeR && z === sg.zFront - t) + 1);
    const hole: Pt[] = [...innerPts.map(([r, z]) => [z, cy + r] as Pt), ...[...innerPts].reverse().map(([r, z]) => [z, cy - r] as Pt)];
    holes.push(dedupe(hole));
    chambers.push({ label: 'Box (net)', volumeL: sg.netL });
    // diffraction: this rounded front vs a square box with the same front
    const fq = Array.from({ length: 80 }, (_, i) => 150 * Math.pow(40, i / 79));
    const ripple = (db: number[]) => Math.max(...db.slice(20)) - Math.min(...db.slice(20));
    const curved = baffleResponse({ widthMm: 2 * sg.landR + 2 * sg.edgeRadiusMm * 0.5, heightMm: 2 * sg.landR + 2 * sg.edgeRadiusMm * 0.5, driverXmm: sg.landR + sg.edgeRadiusMm * 0.5, driverYmm: sg.landR + sg.edgeRadiusMm * 0.5, edgeRadiusMm: Math.min(sg.edgeRadiusMm, 200), shape: 'ellipse' }, fq);
    const boxy = baffleResponse({ widthMm: H, heightMm: H, driverXmm: H / 2, driverYmm: H / 2 }, fq);
    if (sg.netL > 0) {
      const alpha = d.vasL / sg.netL;
      const qtc = d.qts * Math.sqrt(1 + alpha);
      stats.push(
        { label: 'Net volume', value: `${sg.netL.toFixed(1)} L` },
        { label: 'Qtc / fc', value: `${qtc.toFixed(2)} / ${(d.fsHz * Math.sqrt(1 + alpha)).toFixed(0)} Hz${qtc > 0.85 ? ' — boomy: make the shell bigger' : qtc < 0.6 ? ' — lean: smaller shell, or EQ' : ''}` },
        { label: 'Edge diffraction ripple', value: `≈ ${ripple(curved.db).toFixed(1)} dB (a square box with this front: ≈ ${ripple(boxy.db).toFixed(1)} dB) — the front curves away with a ${Math.round(sg.edgeRadiusMm)} mm radius` },
        { label: 'Internal standing waves', value: `no parallel walls to bounce between; a box of the same volume would ring at ≈ ${Math.round(C / (2 * Math.cbrt(sg.netL / 1000)))} Hz and its multiples` }
      );
    }
    labels.push({ x: W / 2, y: cy, text: 'sealed shell' });
    const geo: Geometry = {
      ...base,
      E: H,
      Etot: H,
      cores: 1,
      coreMm: H,
      construction: 'full',
      caps: [],
      strips: [],
      dead: [],
      core: dedupe(core),
      holes,
      spans: [],
      labels,
      driver: { x: W - t / 2, y: cy, dia, face: 'front' },
      path: { s: [0], area: [0] },
      mouthRect: null,
      dividerCuts: [],
      tweeter: null,
      shell: sg,
      chambers,
      stats,
      fits,
      warnings,
    };
    geo.W = sg.zFront;
    return geo;
  }

  if (p.type === 'sealed') {
    // one rounded chamber; woofer high on the front so it sits close to a tweeter head
    const r = Math.min(60, (Math.min(W, H) - 2 * t) / 3) * k;
    const pl = placeFront(t + 2, H - t - 4);
    const yDrv0 = pl.yW;
    twY = pl.yTw;
    if (!pl.fits) {
      fits = false;
      warnings.push(`The front is too short for the ${dia} mm woofer${frontTw ? ` and the ${Math.round(2 * twR)} mm tweeter${twWg ? ' waveguide' : ''} above it` : ''} — make the cabinet taller.`);
    }
    const topY = twY !== null ? twY + twR : yDrv0 + d.cutoutDiaMm / 2;
    // big organic corners at the back; at the front only as round as the drivers allow
    const frontR = Math.max(0, Math.min(r, H - t - topY - 3, yDrv0 - d.cutoutDiaMm / 2 - t - 3));
    const chamber = filletSafe(
      [
        [t, t],
        [W - t, t],
        [W - t, H - t],
        [t, H - t],
      ],
      (_me, P) => (P[0] > W / 2 ? frontR : r),
      () => 0
    );
    holes.push(chamber);
    const backR = Math.min(outerR + r, Math.min(W, H) / 3);
    // the front corners stay tight enough that the woofer frame / tweeter flange sit on flat face
    const frameTop = Math.max(yDrv0 + dia / 2, twY !== null ? twY + twR : -Infinity);
    const faceGap = Math.min(H - frameTop - 2, yDrv0 - dia / 2 - 2);
    // concentric with the chamber: outer radius = inner radius + wall, so the wall never thins
    const core = filletSafe(
      [
        [0, 0],
        [W, 0],
        [W, H],
        [0, H],
      ],
      (_me, P) => (P[0] > W / 2 ? Math.max(0, Math.min(backR, frontR + t, faceGap)) : Math.min(backR, r + t)),
      () => 0
    );
    const Vb = ((W - 2 * t) * (H - 2 * t) * E) / 1e6 - (d.displacementL ?? 0.5) - tweeterDisplacementL(frontTw, twWg);
    chambers.push({ label: 'Box (net)', volumeL: Vb });
    spans.push({ x0: t, x1: W - t, y0: t, y1: H - t, label: 'box' });
    labels.push({ x: W / 2, y: H / 2, text: 'sealed box' });
    const yDrv = yDrv0;
    if (E < dia + 6) {
      fits = false;
      warnings.push(`The front (${Etot} mm between plates) is narrower than the driver frame (${dia} mm) — widen it.`);
    }
    if (W - 2 * t < (d.mountDepthMm ?? 80) + 15) {
      fits = false;
      warnings.push(`The box is too shallow for the driver's ${d.mountDepthMm ?? 80} mm mounting depth — make it deeper.`);
    }
    {
      const thin = thinnestWall(core, holes);
      if (thin < 0.5 * t) {
        fits = false;
        warnings.push(`A printed wall gets only ${thin.toFixed(1)} mm thick at a corner — less rounding, or thicker walls.`);
      }
      const issue = basketClearance(core, holes, { x: W - t / 2, y: yDrv, dia, face: 'front' }, d, W, t) ?? (twY !== null ? cylinderClearance(core, holes, W - t, twDepth - t, twY, twR - 1, `the tweeter${twWg ? ' waveguide' : ''}`) : null);
      if (issue) {
        fits = false;
        warnings.push(issue);
      }
    }
    if (Vb > 0) {
      const alpha = d.vasL / Vb;
      const qtc = d.qts * Math.sqrt(1 + alpha);
      const fc = d.fsHz * Math.sqrt(1 + alpha);
      stats.push(
        { label: 'Net box volume', value: `${Vb.toFixed(1)} L` },
        { label: 'Qtc / fc', value: `${qtc.toFixed(2)} / ${fc.toFixed(0)} Hz${qtc > 0.85 ? ' — boomy: make the box bigger' : qtc < 0.6 ? ' — lean: smaller box, or EQ' : ''}` }
      );
    }
    return {
      ...base,
      construction: 'full',
      caps: [],
      strips: [],
      dead: [],
      core,
      holes,
      spans,
      labels,
      driver: { x: W - t / 2, y: yDrv, dia, face: 'front' },
      path: { s: [0], area: [0] },
      mouthRect: null,
      dividerCuts: rectUnion(
        [
          driverCutRect({ x: W - t / 2, y: yDrv, dia, face: 'front' }, d, W, t),
          twY !== null ? { x0: W - t - twDepth - 8, x1: W - t, y0: twY - twR - 6, y1: twY + twR + 6 } : null,
          insetRect({ x0: t, x1: W - t, y0: t, y1: H - t }, DIVIDER_FRAME_MM),
        ].filter((r): r is Rect => !!r)
      ),
      tweeter: frontTw && twY !== null ? { y: twY, holeR: twWg ? twWg.R + twWg.wallMm : frontTw.cutoutDiaMm / 2, waveguide: twWg, driver: frontTw } : null,
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

  const stack = (hs: number[], top = H - t) => {
    const out: Leg[] = [];
    let yTop = top;
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
    holes.push(roundedRect(t, t, t + cw, H - t, bends ? 0 : 40 * k));
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
    gapsUsed = gaps;
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    // merge the throat chamber (in front of the driver, below leg 0) into the channel
    const tcTop = legs[0].yb;
    const drvY = tcTop - 6 - dia / 2;
    const tcBot = Math.max(t, drvY - dia / 2);
    const tcFront = xDrv + t + tcD;
    B[0] = [tcFront, legs[0].yb];
    // down the driver baffle, along the chamber floor, then up its front (this order — the
    // reverse drew the two walls as a crossing X)
    B.unshift([xStart, tcBot], [tcFront, tcBot]);
    A[0] = [xStart, legs[0].yt];
    chambers.push({ label: 'Throat chamber', volumeL: (tcD * (tcTop - tcBot) * E) / 1e6 });
    hornInfo = { xDrv, tcFront, tcBot };
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
  } else if (p.type === 'tapped') {
    // tapped horn: a horn closed at its throat; the woofer sits on the fold wall between the
    // first two runs, magnet up into run 0 (near the closed throat), cone down into run 1 —
    // so its rear feeds the throat and its front feeds the horn one fold further on
    const N = p.legs % 2 === 0 ? Math.max(p.legs, 2) : p.legs + 1;
    if (N !== p.legs) warnings.push(`A tapped horn here needs an even number of runs to exit at the front — using ${N}.`);
    d0 = -1;
    xa = t;
    xStart = xb;
    const legLen = xb - xa;
    const md = d.mountDepthMm ?? 120;
    const h0 = Math.max(md + 20, (p.throatRatio * sd) / E);
    const h1min = 2 * (d.xmaxMm || 8) + 30;
    // runs 1…N−1 grow geometrically to fill the height
    const avail = H - 2 * t - h0 - (N - 1) * t;
    const ht = Math.max(h1min, (p.throatRatio * sd) / E);
    const sum = (r: number) => Array.from({ length: N - 1 }, (_, i) => ht * r ** i).reduce((a, b) => a + b, 0);
    let lo = 1;
    let hi = 4;
    for (let it = 0; it < 60; it++) {
      const m = (lo + hi) / 2;
      if (sum(m) > avail) hi = m;
      else lo = m;
    }
    if (sum(1) > avail) {
      fits = false;
      warnings.push('Not enough height for the horn runs — taller cabinet or fewer runs.');
    }
    const hs = [h0, ...Array.from({ length: N - 1 }, (_, i) => ht * lo ** i)];
    legs = stack(hs);
    const gaps = gapsFor(hs, legLen);
    gapsUsed = gaps;
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    // the woofer near the front on the wall under run 0 (that wall is fixed at the front)
    const R = d.frameDiaMm / 2;
    const xd = xb - R - 12;
    if (xd - R < xa + gaps[0] + 5) {
      fits = false;
      warnings.push(`The fold wall is too short for the ${d.frameDiaMm} mm woofer frame — a deeper cabinet.`);
    }
    const wallY = legs[0].yb - t / 2;
    driver = { x: xd, y: wallY, dia, face: 'down' };
    for (let i = 0; i < N; i++) {
      seg(s, area, legLen, hs[i] * E, (i < N - 1 ? hs[i + 1] : hs[i]) * E, 6, bendFlags);
      if (i < N - 1) {
        const bl = bendLen(hs[i], hs[i + 1]) - (gaps[i] + t);
        foldS.push(s[s.length - 1] + bl / 2);
        seg(s, area, bl, hs[i + 1] * E, hs[i + 1] * E, 2, bendFlags, true);
      }
    }
    area.unshift(area[0]);
    bendFlags.unshift(false);
    L = s[s.length - 1];
    tapRear = xb - xd; // along run 0 from the closed front end
    tapFront = legLen + (bendLen(hs[0], hs[1]) - (gaps[0] + t)) + (xd - xa); // along run 1
    const St = hs[1] * E;
    const Sm = hs[N - 1] * E;
    stats.push(
      { label: 'Horn path (centre line)', value: `${(L / 1000).toFixed(2)} m, ${N} runs; quarter-wave ≈ ${(C / (4 * (L / 1000))).toFixed(0)} Hz` },
      { label: 'Taps', value: `rear ${Math.round(tapRear)} mm and front ${Math.round(tapFront)} mm along the path` },
      { label: 'Throat → mouth', value: `${(St / 100).toFixed(0)} → ${(Sm / 100).toFixed(0)} cm² (${(Sm / sd).toFixed(1)}× the cone)` }
    );
    labels.push({ x: (xa + xb) / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'throat (closed)' }, { x: (xa + xb) / 2, y: (legs[N - 1].yt + legs[N - 1].yb) / 2, text: 'mouth run' });
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
    // an in-wall tweeter gets its own small sealed compartment above the line, so the
    // line's start stays sized for the woofer (1–3× the cone area)
    const twTop = frontTw ? twStack + t : 0;
    const room = H - (N + 1) * t - twTop;
    const sumH = hs.reduce((a, b) => a + b, 0);
    // grow the line to use the height, but never wider than ~3× the cone area at the start
    const grow = Math.max(1, Math.min(room / sumH, (3 * sd) / (hs[0] * E)));
    for (let i = 0; i < N; i++) hs[i] *= grow;
    let used = hs.reduce((a, b) => a + b, 0) + (N + 1) * t + twTop;
    const spare = H - used;
    if (spare > 40) {
      // leftover height becomes a sealed void (no filament): fill with sand or shorten the cabinet
      holes.push(roundedRect(t, t, W - t, t + spare - t, 30 * k));
      voidTop = t + spare - t;
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
    legs = stack(hs, H - t - twTop);
    if (frontTw) {
      const yb = H - t - twStack;
      const fr = 3; // front corners: square enough to clear the tweeter
      holes.push(
        filletSafe(
          [
            [t, yb],
            [W - t, yb],
            [W - t, H - t],
            [t, H - t],
          ],
          (_me, P) => (P[0] > W / 2 ? fr : Math.min(30 * k, twStack / 2 - 1)),
          () => 0
        )
      );
      chambers.push({ label: 'Tweeter compartment (sealed)', volumeL: ((W - 2 * t) * twStack * E) / 1e6 });
      spans.push({ x0: t, x1: W - t, y0: yb, y1: H - t, label: 'tweeter compartment' });
      labels.push({ x: W / 2, y: yb + twStack / 2, text: 'tweeter' });
    }
    const gaps = gapsFor(hs, legLen);
    gapsUsed = gaps;
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    driver = { x: W - t / 2, y: (legs[0].yt + legs[0].yb) / 2, dia, face: 'front' };
    if (frontTw) twY = H - t - twStack / 2;
    for (let i = 0; i < N; i++) {
      seg(s, area, legLen, hs[i] * E, (i < N - 1 ? hs[i + 1] : hs[i]) * E, 6, bendFlags);
      if (i < N - 1) {
        const bl = bendLen(hs[i], hs[i + 1]) - (gaps[i] + t);
        foldS.push(s[s.length - 1] + bl / 2);
        seg(s, area, bl, hs[i + 1] * E, hs[i + 1] * E, 2, bendFlags, true);
      }
    }
    area.unshift(area[0]);
    bendFlags.unshift(false);
    // offset driver: on the front wall at a front fold (the folds alternate back, front, back…)
    const fold = Math.max(0, Math.round(p.driverFold ?? 0));
    if (fold > 0) {
      const i = 2 * fold - 1; // fold i joins legs i and i+1 at the front
      if (i < N - 1) {
        const yc = (legs[i].yt + legs[i + 1].yb) / 2;
        const room = legs[i].yt - legs[i + 1].yb; // channel + fold wall + channel at the front
        if (room < d.cutoutDiaMm + 4) {
          fits = false;
          warnings.push(`The fold the woofer is moved to is only ${Math.round(room)} mm tall — less than its ${d.cutoutDiaMm} mm cut-out. Fewer legs, or a taller cabinet.`);
        }
        if (gaps[i] < mountDepth + 10) {
          fits = false;
          warnings.push(`At that fold the wall between the channels ends only ${Math.round(gaps[i])} mm from the front — the woofer's magnet needs ${Math.round(mountDepth + 10)} mm. Fewer legs or a deeper cabinet.`);
        }
        driver = { x: W - t / 2, y: yc, dia, face: 'front' };
        tapRear = foldS[i];
        labels.push({ x: W - 60, y: yc, text: 'woofer' });
      } else {
        warnings.push(`This line has only ${Math.floor((N - 1) / 2)} front fold(s) — the woofer stays at the closed end.`);
      }
    }
    L = s[s.length - 1];
    stats.push(
      { label: 'Line length (centre line)', value: `${(L / 1000).toFixed(2)} m` },
      { label: 'Quarter-wave tuning', value: `≈ ${(C / (4 * (L / 1000))).toFixed(0)} Hz` },
      { label: 'Start → end area', value: `${((hs[0] * E) / 100).toFixed(0)} → ${((hs[N - 1] * E) / 100).toFixed(0)} cm² (${((hs[0] * E) / sd).toFixed(1)}× Sd at the start)` }
    );
    labels.push({ x: W / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'line start' }, { x: W / 2, y: (legs[N - 1].yt + legs[N - 1].yb) / 2, text: 'terminus' });
  } else {
    // slot-port box / back-loaded horn: leg 0 is the box (behind the driver), then a folded
    // path out to the front — constant for a slot, expanding for a horn
    const blh = p.type === 'blh';
    const nSlot = blh ? (p.legs % 2 === 1 ? Math.min(p.legs, 7) : Math.min(p.legs + 1, 7)) : p.legs % 2 === 1 ? Math.min(p.legs, 5) : Math.min(p.legs + 1, 5);
    if (nSlot !== p.legs) warnings.push(`The slot needs an odd number of runs to exit at the front — using ${nSlot}.`);
    d0 = -1;
    xa = t;
    xStart = xb;
    const legLen = xb - xa;
    // horn: legs grow geometrically from the throat (throatRatio × cone area) to fill the height
    let hornHs: number[] = [];
    let boxH = H - 2 * t - nSlot * (p.slotMm + t);
    if (blh) {
      const ht = Math.max(12, (p.throatRatio * sd) / E);
      boxH = Math.max(dia + 2 * t + twStack, (p.rearChamberL * 1e6) / ((xb - xa) * E));
      const avail = H - 2 * t - boxH - nSlot * t;
      let lo = 1;
      let hi = 4;
      const sum = (r: number) => Array.from({ length: nSlot }, (_, i) => ht * r ** i).reduce((a, b) => a + b, 0);
      for (let it = 0; it < 60; it++) {
        const m = (lo + hi) / 2;
        if (sum(m) > avail) hi = m;
        else lo = m;
      }
      hornHs = Array.from({ length: nSlot }, (_, i) => ht * lo ** i);
      if (sum(1) > avail) {
        fits = false;
        warnings.push('Not enough height for the horn below the rear chamber — taller cabinet, fewer folds or a smaller rear chamber.');
      }
    }
    if (boxH < dia + 2 * t + twStack) {
      fits = false;
      warnings.push(`Not enough height for the woofer${frontTw ? ' and tweeter' : ''} above the folded slot — taller cabinet or fewer slot runs.`);
    }
    const hs = [Math.max(boxH, 20), ...(blh ? hornHs : Array.from({ length: nSlot }, () => p.slotMm))];
    legs = stack(hs);
    const gaps = gapsFor(hs, legLen).map((g, i) => (i === 0 ? Math.min(g, (blh ? hs[1] : p.slotMm) * 1.6) : g));
    gapsUsed = gaps;
    ({ A, B } = serpentine(legs, xa, xb, W, xStart, d0, t, gaps));
    {
      const pl = placeFront(legs[0].yb, legs[0].yt);
      twY = pl.yTw;
      if (!pl.fits) {
        fits = false;
        warnings.push(`The first channel is too short for the woofer${frontTw ? ' and the tweeter above it' : ''} — taller cabinet or fewer legs.`);
      }
      driver = { x: W - t / 2, y: pl.yW, dia, face: 'front' };
    }
    const Vb = (legLen * boxH * E) / 1e6 - (d.displacementL ?? 0.5) - tweeterDisplacementL(frontTw, twWg);
    chambers.push({ label: blh ? 'Rear chamber (net)' : 'Box (net)', volumeL: Vb });
    if (blh) {
      // the horn path: through each leg and fold, growing in area
      for (let i = 1; i < hs.length; i++) {
        seg(s, area, legLen, hs[i] * E, (i < hs.length - 1 ? hs[i + 1] : hs[i]) * E, 6, bendFlags);
        if (i < hs.length - 1) {
          const bl = bendLen(hs[i], hs[i + 1]) - (gaps[i] + t);
          foldS.push(s[s.length - 1] + bl / 2);
          seg(s, area, bl, hs[i + 1] * E, hs[i + 1] * E, 2, bendFlags, true);
        }
      }
      area.unshift(area[0]);
      bendFlags.unshift(false);
      L = s[s.length - 1];
      const St = hs[1] * E;
      const Sm = hs[hs.length - 1] * E;
      const fc = (C * Math.log(Sm / St)) / (2 * Math.PI * (L / 1000)) / 2;
      stats.push(
        { label: 'Rear chamber', value: `${Vb.toFixed(1)} L` },
        { label: 'Horn path (centre line)', value: `${(L / 1000).toFixed(2)} m, ${hs.length - 1} runs` },
        { label: 'Throat → mouth', value: `${(St / 100).toFixed(0)} → ${(Sm / 100).toFixed(0)} cm² (throat ${(St / sd).toFixed(2)}× the cone)` },
        { label: 'Horn flare cut-off (estimate)', value: `≈ ${fc.toFixed(0)} Hz; below this the horn stops loading the cone` }
      );
      labels.push({ x: W / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'rear chamber' });
    }
    const Lp = nSlot * legLen + (nSlot - 1) * (bendLen(p.slotMm, p.slotMm) - p.slotMm - t);
    if (!blh) {
      seg(s, area, Lp, p.slotMm * E, p.slotMm * E, 12, bendFlags);
      area.unshift(area[0]);
      bendFlags.unshift(false);
    }
    const Sp = (p.slotMm * E) / 1e6;
    const leff = Lp / 1000 + 0.9 * Math.sqrt(Sp / Math.PI) * 2;
    const fb = (C / (2 * Math.PI)) * Math.sqrt(Sp / ((Vb / 1000) * leff));
    if (!blh) stats.push(
      { label: 'Net box volume', value: `${Vb.toFixed(1)} L` },
      { label: 'Slot port', value: `${p.slotMm} × ${E} mm, ${(Lp / 1000).toFixed(2)} m long (rounded bends)` },
      { label: 'Helmholtz tuning (estimate)', value: `≈ ${fb.toFixed(0)} Hz` }
    );
    if (!blh) {
      labels.push({ x: W / 2, y: (legs[0].yt + legs[0].yb) / 2, text: 'box' });
      L = Lp;
    }
  }
  for (const lg of legs) spans.push({ x0: xa, x1: xb, y0: lg.yb, y1: lg.yt });
  const last = legs[legs.length - 1];

  // ---- printed bends + plywood straight walls ------------------------------
  const caps: Rect[] = [];
  const strips: Strip[] = [];
  const dead: Rect[] = [];
  if (bends) {
    const socket = 25; // plywood strips slot this far into the printed caps
    let gR = 0;
    let gL = 0;
    gapsUsed.forEach((g, i) => {
      const di = i % 2 === 0 ? d0 : -d0;
      if (di > 0) gR = Math.max(gR, g);
      else gL = Math.max(gL, g);
    });
    const front: Rect = { x0: Math.max(0, xb - gR - socket), x1: W, y0: 0, y1: H, label: 'front cap (printed)' };
    const back: Rect = hornInfo
      ? { x0: xa - t, x1: xa + gL + socket, y0: 0, y1: H, label: 'back cap (printed)' }
      : { x0: 0, x1: xa + gL + socket, y0: 0, y1: H, label: 'back cap (printed)' };
    if (back.x1 > front.x0 - 60) {
      warnings.push('The legs are too short for a plywood middle section — this design is printed whole.');
      bends = false;
    } else {
      caps.push(back, front);
      const x0 = back.x1 - socket;
      const x1 = front.x0 + socket;
      const mid = (name: string, y0: number, y1: number, note?: string) =>
        strips.push({ name, rect: { x0, x1, y0, y1 }, lengthMm: x1 - x0, thickMm: t, widthMm: coreMm, qty: cores, note: note ?? `ends slot ${socket} mm into both printed caps` });
      mid('Top wall', H - t, H);
      mid('Bottom wall', 0, t);
      for (let i = 0; i < legs.length - 1; i++) mid(`Fold wall ${i + 1}`, legs[i].yb - t, legs[i].yb);
      if (voidTop > 0) mid('Wall above the sand void', voidTop, voidTop + t);
      if (hornInfo) {
        const { xDrv, tcFront, tcBot } = hornInfo;
        const box = (name: string, r: Rect, len: number, note?: string) => strips.push({ name, rect: r, lengthMm: len, thickMm: t, widthMm: coreMm, qty: cores, note });
        box('Back wall', { x0: 0, x1: t, y0: 0, y1: H }, H);
        box('Driver baffle (internal)', { x0: xDrv, x1: xDrv + t, y0: t, y1: H - t }, H - 2 * t, `driver cut-out Ø${d.cutoutDiaMm} mm; seals the rear chamber`);
        box('Rear chamber top', { x0: t, x1: xDrv, y0: H - t, y1: H }, xDrv - t);
        box('Rear chamber bottom', { x0: t, x1: xDrv, y0: 0, y1: t }, xDrv - t);
        if (back.x0 - (xDrv + t) > 10) {
          box('Top wall (over throat chamber)', { x0: xDrv + t, x1: back.x0, y0: H - t, y1: H }, back.x0 - xDrv - t + socket, `slots ${socket} mm into the back cap`);
          box('Bottom wall (under throat chamber)', { x0: xDrv + t, x1: back.x0, y0: 0, y1: t }, back.x0 - xDrv - t + socket, `slots ${socket} mm into the back cap`);
        }
        box('Throat chamber floor', { x0: xDrv + t, x1: tcFront, y0: tcBot - t, y1: tcBot }, tcFront - xDrv - t, 'closes the throat chamber below the driver');
        if (tcBot - 2 * t > 20) dead.push({ x0: xDrv + t, x1: back.x0, y0: t, y1: tcBot - t, label: 'sealed empty space' });
      }
    }
  }
  capsForFillet = caps;
  driverRef.d = driver!;
  const core = filletSafe(coreWithChannel(W, H, A, B), convex, concave);
  // divider cut-outs: notch round the driver, window through the slot-port box / horn rear chamber
  const cuts: (Rect | null)[] = [driverCutRect(driver!, d, W, t), twY !== null ? { x0: W - t - twDepth - 8, x1: W - t, y0: twY - twR - 6, y1: twY + twR + 6 } : null];
  if (p.type === 'slot-port' && legs[0]) cuts.push(insetRect({ x0: xa, x1: xb, y0: legs[0].yb, y1: legs[0].yt }, DIVIDER_FRAME_MM));
  if (hornInfo) cuts.push(insetRect({ x0: t, x1: hornInfo.xDrv, y0: t, y1: H - t }, DIVIDER_FRAME_MM));
  const thin = thinnestWall(core, holes);
  if (thin < 0.5 * t) {
    fits = false;
    warnings.push(`A printed wall gets only ${thin.toFixed(1)} mm thick where a chamber's corner meets the outside — less rounding, or thicker walls.`);
  }
  const clearIssue = basketClearance(core, holes, driver!, d, W, t) ?? (twY !== null ? cylinderClearance(core, holes, W - t, twDepth - t, twY, twR - 1, `the tweeter${twWg ? ' waveguide' : ''}`) : null);
  if (clearIssue) {
    fits = false;
    warnings.push(clearIssue);
  }
  return {
    ...base,
    dividerCuts: rectUnion(cuts.filter((r): r is Rect => !!r)),
    tweeter: frontTw && twY !== null ? { y: twY, holeR: twWg ? twWg.R + twWg.wallMm : frontTw.cutoutDiaMm / 2, waveguide: twWg, driver: frontTw } : null,
    construction: bends ? 'bends' : 'full',
    caps,
    strips,
    dead,
    core,
    holes,
    spans,
    labels,
    driver: driver!,
    path: { s, area, bend: bendFlags.length === s.length ? bendFlags : undefined },
    foldS,
    taps: { rearMm: tapRear, frontMm: tapFront },
    traps: designTraps(p, { s, area }, legs, xa, xb, W, t),
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
  // ---- lines and horns (transmission line, back-loaded and tapped horn) ----
  /** the cone's own output and the line/horn mouth's, at 2.83 V (dB) */
  coneSpl?: number[];
  mouthSpl?: number[];
  /** input impedance (Ω) and group delay (ms) */
  impedance?: number[];
  groupDelayMs?: number[];
  /** peak air speed at the mouth at 2.83 V (m/s) */
  mouthVelocity?: number[];
  /** line resonances (impedance peaks, Hz) */
  resonances?: number[];
  /** harmonics leaking from the mouth in the passband, etc. */
  lineWarnings?: string[];
}

/** Air speed (peak, m/s) above which a port or line mouth starts to sound. */
export const MOUTH_NOISE_MS = 17;

/**
 * Lines and horns through the 1D path solver (lineNetwork): the driver's rear
 * feeds the path at taps.rearMm (a TL's closed end or an offset fold; a BLH's
 * rear chamber), its front either radiates directly or, in a tapped horn,
 * feeds the path at taps.frontMm. Traps hang off the path as side branches.
 */
function simulateLine(p: HybridParams, d: DriverInfo, g: Geometry, opts: { coupled: number; floor: boolean; f0?: number; f1?: number; n?: number }): SimResult {
  const { Sd, Cms, Mms, Rms, Bl, Re } = tsToMech(d);
  const f0 = opts.f0 ?? 15;
  const f1 = opts.f1 ?? 600;
  const n = opts.n ?? 90;
  const freqs = Array.from({ length: n }, (_, i) => f0 * Math.pow(f1 / f0, i / (n - 1)));
  const N = Math.max(1, opts.coupled);
  const img = opts.floor ? 2 : 1;
  const Vin = 2.83;
  const mouthA = g.mouthRect ? ((g.mouthRect.y1 - g.mouthRect.y0) * g.E) / 1e6 : 1e-3;
  const stuffing = p.stuffing ?? (p.type === 'tl' ? [{ from: 0, to: 0.5, densityGL: 8 }] : []);
  const model = {
    path: g.path,
    startChamberL: p.type === 'blh' ? (g.chambers[0]?.volumeL ?? 0) : 0,
    mouthZ: (f: number) => scl(zRad(mouthA * N * img, f), N * img),
    stuffing,
    traps: g.traps ?? [],
  };
  const tapRear = g.taps?.rearMm ?? 0;
  const tapFront = p.type === 'tapped' ? g.taps?.frontMm : undefined;
  const xmax = (d.xmaxMm || 3) / 1000;
  const Pmax = d.powerW ?? 100;
  const out = { spl: [] as number[], cone: [] as number[], mouth: [] as number[], exc: [] as number[], max: [] as number[], z: [] as number[], vel: [] as number[], ph: [] as number[], H: [] as Cx[] };
  const db = (pa: number) => 20 * Math.log10(pa / 20e-6 + 1e-12);
  for (const f of freqs) {
    const w = 2 * Math.PI * f;
    const Zm = cx(Rms, w * Mms - 1 / (w * Cms));
    const Ze = cx(Re, 0);
    const sources = [{ atMm: tapRear, q: cx(-Sd) }, ...(tapFront !== undefined ? [{ atMm: tapFront, q: cx(Sd) }] : [])];
    const sol = solveLine(model, f, sources);
    const pr = sol.pAtSources[0];
    const pf = tapFront !== undefined ? sol.pAtSources[1] : scl(zRad(Sd, f), Sd);
    const Zmot = add(Zm, scl(sub(pf, pr), Sd));
    const i = div(cx(Vin), add(Ze, div(cx(Bl * Bl), Zmot)));
    const v = div(scl(i, Bl), Zmot);
    const Uc = tapFront !== undefined ? cx(0) : scl(v, Sd);
    const Um = mul(sol.mouthU, v);
    const U = add(Uc, Um);
    const k = (w * RHO) / (4 * Math.PI);
    const pff = mul(cx(0, k), U);
    out.H.push(pff);
    out.spl.push(db(cabs(pff) * (opts.floor ? 2 * N : 1)));
    out.cone.push(db(cabs(Uc) * k * (opts.floor ? 2 * N : 1)));
    out.mouth.push(db(cabs(Um) * k * (opts.floor ? 2 * N : 1)));
    out.ph.push(carg(pff));
    const x = cabs(v) / w;
    out.exc.push(x * 1000 * Math.SQRT2);
    const zin = add(Ze, div(cx(Bl * Bl), Zmot));
    out.z.push(cabs(zin));
    const vel = (cabs(Um) * Math.SQRT2) / (mouthA * N * img > 0 ? mouthA : 1);
    out.vel.push(vel);
    // loudest before Xmax, the power rating or mouth noise, whichever comes first
    const scaleX = xmax / Math.max(x * Math.SQRT2, 1e-12);
    const scaleP = Math.sqrt(Pmax / Math.max(cabs(i) ** 2 * Re, 1e-12));
    const scaleV = vel > 0 ? MOUTH_NOISE_MS / vel : Infinity;
    out.max.push(out.spl[out.spl.length - 1] + 20 * Math.log10(Math.min(scaleX, scaleP, scaleV)));
  }
  // group delay
  const un = [...out.ph];
  for (let i = 1; i < un.length; i++) {
    while (un[i] - un[i - 1] > Math.PI) un[i] -= 2 * Math.PI;
    while (un[i] - un[i - 1] < -Math.PI) un[i] += 2 * Math.PI;
  }
  const gd = freqs.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(freqs.length - 1, i + 1);
    return (-(un[b] - un[a]) / (2 * Math.PI * (freqs[b] - freqs[a]))) * 1000;
  });
  // resonances: impedance peaks
  const resonances: number[] = [];
  for (let i = 1; i < out.z.length - 1; i++) if (out.z[i] > out.z[i - 1] && out.z[i] >= out.z[i + 1] && out.z[i] > 1.3 * Re) resonances.push(freqs[i]);
  // harmonics leaking from the mouth: a mouth peak above the line's fundamental, in the passband,
  // within 6 dB of the cone's output there
  const lineWarnings: string[] = [];
  if (p.type === 'tl') {
    const L = g.path.s[g.path.s.length - 1];
    const fq = quarterWaveHz(L, mouthA * 1e6, 1);
    for (let i = 1; i < freqs.length - 1; i++) {
      const f = freqs[i];
      if (f < 1.8 * fq || f > 350) continue;
      if (out.mouth[i] > out.mouth[i - 1] && out.mouth[i] >= out.mouth[i + 1] && out.mouth[i] > out.cone[i] - 6) {
        const h = Math.round(f / fq);
        lineWarnings.push(
          `The line's ${h % 2 ? `${h}${h === 3 ? 'rd' : 'th'} harmonic` : 'resonance'} at ${Math.round(f)} Hz comes out of the terminus only ${(out.cone[i] - out.mouth[i]).toFixed(0)} dB below the cone — it will colour the mid-bass. More stuffing over the first half, an offset driver (at a fold ⅓ along), or a resonance trap tuned to it.`
        );
      }
    }
  }
  const ref = [...out.spl.filter((_, i) => freqs[i] > freqs[0] * 3 && freqs[i] < Math.min(freqs[freqs.length - 1], 200))].sort((a, b) => a - b);
  const top = ref[Math.floor(ref.length * 0.7)] ?? 0;
  let f3 = freqs[0];
  for (let i = 0; i < freqs.length; i++)
    if (out.spl[i] >= top - 3) {
      f3 = freqs[i];
      break;
    }
  return {
    freqs,
    spl: out.spl,
    excursionMm: out.exc,
    maxSpl: out.max,
    H: out.H,
    f3,
    coneSpl: out.cone,
    mouthSpl: out.mouth,
    impedance: out.z,
    groupDelayMs: gd,
    mouthVelocity: out.vel,
    resonances,
    lineWarnings,
  };
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
  if (p.type === 'tl' || p.type === 'blh' || p.type === 'tapped') return simulateLine(p, d, g, opts);
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
    } else if (p.type === 'slot-port') {
      Zf = zRad(Sd, f);
      const ZmL = zRad(Math.max(mouthA, 1e-4), f);
      const M = pathMatrix(g.path, f, () => 0.02);
      const Zin = div(add(mul(M[0], ZmL), M[1]), add(mul(M[2], ZmL), M[3]));
      {
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
    } else if (p.type === 'sealed' || p.type === 'shell') {
      // box compliance with light stuffing losses (a small parallel resistance)
      Zf = zRad(Sd, f);
      const Vb = (g.chambers[0]?.volumeL ?? 10) / 1000;
      Zr = inv(cx(1 / ((RHO * C) / Sd * 30), w * (Vb / (RHO * C * C))));
      out = (v) => scl(v, Sd);
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
  /** cut lines in profile coordinates (mm) */
  cutLines: { x1: number; y1: number; x2: number; y2: number }[];
  /** layer splits inside each core (mm from that core's bottom) */
  cutsZ: number[];
  /** the regions that are printed (whole profile, or the end-caps) */
  regions: Rect[];
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
  if (g.shell) {
    // printed nose-up in bands along the axis, each glued to the next on a printed lip
    const bedMin = Math.min(pr.bedX, pr.bedY) - 2 * pr.margin;
    const bedMax = Math.max(pr.bedX, pr.bedY) - 2 * pr.margin;
    const bands = shellBands(g.shell, pr.maxZ, bedMin, bedMax);
    const vol = shellVolumeCm3(g.shell);
    const grams = vol * 1.27;
    const segments: Segment[] = bands.flatMap((b, i) =>
      (b.halves ? [1, 2] : [0]).map((h) => ({
        id: `band ${i + 1}${h ? (h === 1 ? ' left half' : ' right half') : ''}`,
        tile: `B${i + 1}${h ? (h === 1 ? 'L' : 'R') : ''}`,
        core: h,
        x0: b.z0,
        x1: b.z1,
        y0: 0,
        y1: g.H,
        z0: 0,
        z1: b.z1 - b.z0,
        bedW: b.diaMm,
        bedH: h ? b.diaMm / 2 : b.diaMm,
        grams: (grams * (b.z1 - b.z0)) / g.shell!.zFront / (h ? 2 : 1),
      }))
    );
    return {
      rotated: false,
      usable: [pr.bedX - 2 * pr.margin, pr.bedY - 2 * pr.margin],
      cutLines: bands.slice(1).map((b) => ({ x1: b.z0, y1: 0, x2: b.z0, y2: g.H })),
      cutsZ: [],
      regions: [],
      segments,
      keys: [],
      totalGrams: grams,
      hours: (vol * 1000) / pr.flow / 3600,
      solidFraction: 1,
      layers: Math.ceil(Math.max(...bands.map((b) => b.z1 - b.z0)) / pr.layerH),
    };
  }
  const ux = pr.bedX - 2 * pr.margin;
  const uy = pr.bedY - 2 * pr.margin;
  const regions: Rect[] = g.caps.length ? g.caps : [{ x0: 0, x1: g.W, y0: 0, y1: g.H }];
  const nz = Math.ceil(g.coreMm / pr.maxZ);
  const cutsZ = Array.from({ length: nz - 1 }, (_, i) => (g.coreMm * (i + 1)) / nz);
  const zs = [0, ...cutsZ, g.coreMm];

  // density map over the profile: solid perimeters near surfaces, sparse infill inside blobs
  const step = 5;
  const gx = Math.ceil(g.W / step);
  const gy = Math.ceil(g.H / step);
  const solid = new Uint8Array(gx * gy);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) solid[j * gx + i] = isAir(g, (i + 0.5) * step, (j + 0.5) * step) ? 0 : 1;
  const INF = 1e9;
  const dist = new Float64Array(gx * gy);
  for (let q = 0; q < gx * gy; q++) dist[q] = solid[q] ? INF : 0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= gx || j >= gy ? 0 : dist[j * gx + i]);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) {
      const q = j * gx + i;
      if (solid[q]) dist[q] = Math.min(dist[q], at(i - 1, j) + step, at(i, j - 1) + step, at(i - 1, j - 1) + step * 1.414, at(i + 1, j - 1) + step * 1.414);
    }
  for (let j = gy - 1; j >= 0; j--)
    for (let i = gx - 1; i >= 0; i--) {
      const q = j * gx + i;
      if (solid[q]) dist[q] = Math.min(dist[q], at(i + 1, j) + step, at(i, j + 1) + step, at(i + 1, j + 1) + step * 1.414, at(i - 1, j + 1) + step * 1.414);
    }
  const shell = Math.max(g.wallMm / 2 + pr.lineWidth, 3 * pr.lineWidth);
  // deep inside thick corners: printed hollow with a few ribs (the plates close the pocket)
  const dens = (q: number) => (!solid[q] ? 0 : dist[q] - step / 2 <= shell ? 0.95 : 0.05);
  let solidCells = 0;
  for (let q = 0; q < gx * gy; q++) if (solid[q]) solidCells++;
  const massIn = (x0: number, x1: number, y0: number, y1: number, zMm: number) => {
    let m = 0;
    for (let j = Math.max(0, Math.floor(y0 / step)); j < Math.min(gy, Math.ceil(y1 / step)); j++)
      for (let i = Math.max(0, Math.floor(x0 / step)); i < Math.min(gx, Math.ceil(x1 / step)); i++) m += dens(j * gx + i);
    return (m * step * step * zMm * pr.filamentDensity) / 1000;
  };
  const solidAlong = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    for (let i = 0; i <= 60; i++) if (!isAir(g, x0 + ((x1 - x0) * i) / 60, y0 + ((y1 - y0) * i) / 60)) n++;
    return n;
  };

  const cutLines: PrintPlan['cutLines'] = [];
  const segments: Segment[] = [];
  const keys: PrintPlan['keys'] = [];
  let anyRotated = false;
  regions.forEach((R, ri) => {
    const RW = R.x1 - R.x0;
    const RH = R.y1 - R.y0;
    const tiles = (a: number, b: number) => Math.ceil(RW / a) * Math.ceil(RH / b);
    const rotated = tiles(uy, ux) < tiles(ux, uy);
    anyRotated ||= rotated;
    const [ax, ay] = rotated ? [uy, ux] : [ux, uy];
    const nx = Math.ceil(RW / ax);
    const ny = Math.ceil(RH / ay);
    // put cuts through solid walls where possible (stronger joints, keys have material to bite)
    const snap = (v: number, along: 'x' | 'y') => {
      const n0 = along === 'x' ? nx : ny;
      const len0 = along === 'x' ? RW : RH;
      const lim = along === 'x' ? ax : ay;
      const win = Math.max(0, Math.min(40, Math.floor((lim - len0 / n0) / 2)));
      let best = v;
      let bestScore = -1;
      for (let dv = -win; dv <= win; dv += 2) {
        const c = v + dv;
        const sc = along === 'x' ? solidAlong(c, R.y0, c, R.y1) : solidAlong(R.x0, c, R.x1, c);
        if (sc > bestScore || (sc === bestScore && Math.abs(dv) < Math.abs(best - v))) {
          bestScore = sc;
          best = c;
        }
      }
      return best;
    };
    const cx = Array.from({ length: nx - 1 }, (_, i) => snap(R.x0 + (RW * (i + 1)) / nx, 'x'));
    const cy = Array.from({ length: ny - 1 }, (_, i) => snap(R.y0 + (RH * (i + 1)) / ny, 'y'));
    cx.forEach((c) => cutLines.push({ x1: c, y1: R.y0, x2: c, y2: R.y1 }));
    cy.forEach((c) => cutLines.push({ x1: R.x0, y1: c, x2: R.x1, y2: c }));
    const xs = [R.x0, ...cx, R.x1];
    const ys = [R.y0, ...cy, R.y1];
    const prefix = regions.length > 1 ? (ri === 0 ? 'Back ' : 'Front ') : '';
    for (let c = 0; c < g.cores; c++)
      for (let kz = 0; kz < zs.length - 1; kz++)
        for (let j = 0; j < ys.length - 1; j++)
          for (let i = 0; i < xs.length - 1; i++) {
            const w = xs[i + 1] - xs[i];
            const h = ys[j + 1] - ys[j];
            const tile = `${prefix}${String.fromCharCode(65 + j)}${i + 1}`;
            segments.push({
              id: `${g.cores > 1 ? `${c + 1}·` : ''}${tile}${zs.length > 2 ? `·L${kz + 1}` : ''}`,
              tile,
              core: c,
              x0: xs[i],
              x1: xs[i + 1],
              y0: ys[j],
              y1: ys[j + 1],
              z0: zs[kz],
              z1: zs[kz + 1],
              bedW: rotated ? h : w,
              bedH: rotated ? w : h,
              grams: massIn(xs[i], xs[i + 1], ys[j], ys[j + 1], zs[kz + 1] - zs[kz]),
            });
          }
  });
  // alignment keys: where a seam runs through solid, one key per ~80 mm of solid
  for (const L of cutLines) {
    const len = Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
    let run0 = -1;
    for (let q = 0; q <= len; q += 2) {
      const x = L.x1 + ((L.x2 - L.x1) * q) / len;
      const y = L.y1 + ((L.y2 - L.y1) * q) / len;
      const sld = q > 0 && q < len && !isAir(g, x, y);
      if (sld && run0 < 0) run0 = q;
      if (!sld && run0 >= 0) {
        const run = q - run0;
        if (run >= 5) {
          const n = Math.max(1, Math.floor(run / 80));
          for (let m = 0; m < n; m++) {
            const v = run0 + (run * (m + 0.5)) / n;
            keys.push({ x: L.x1 + ((L.x2 - L.x1) * v) / len, y: L.y1 + ((L.y2 - L.y1) * v) / len });
          }
        }
        run0 = -1;
      }
    }
  }
  const totalGrams = segments.reduce((a, s) => a + s.grams, 0);
  const volMm3 = (totalGrams / pr.filamentDensity) * 1000;
  const hours = ((volMm3 / Math.max(pr.flow, 1)) * 1.3) / 3600; // +30 % travel/acceleration
  return {
    rotated: anyRotated,
    usable: [ux, uy],
    cutLines,
    cutsZ,
    regions,
    segments,
    keys,
    totalGrams,
    hours,
    solidFraction: solidCells / (gx * gy),
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
  /** 2 × 6 mm float glass with a PVB interlayer: stiff and heavy; the interlayer adds damping */
  glass: { name: '12 mm laminated glass', E: 70e9, rho: 2500, nu: 0.22 },
  /** cast acrylic: clear, light, poorly damped */
  acrylic: { name: '10 mm cast acrylic', E: 3.2e9, rho: 1190, nu: 0.37 },
};
const PETG = { E: 2.0e9, G: 0.75e9, rho: 1270, nu: 0.38 };

// ---------------------------------------------------------------------------
// sandwich plates: two fibre/epoxy skins bonded to a printed square-grid rib
// core. Bending stiffness comes from the skins being held apart (∝ spacing²),
// so thin, stiff skins on a light core beat a solid panel of the same weight.
// Wet-layup laminate values (≈ 50 % fibre), woven 200 g/m² cloth.
// ---------------------------------------------------------------------------
export const SKINS = {
  carbon: { name: 'carbon', cloth: '200 g/m² 2×2 twill carbon', tPly: 0.23, E: 45e9, rho: 1500, nu: 0.3, color: 0x26292e },
  glass: { name: 'fibreglass', cloth: '200 g/m² plain-weave E-glass', tPly: 0.18, E: 18e9, rho: 1850, nu: 0.25, color: 0xd5ddd2 },
};

/**
 * Light wood cores (typical values): end-grain balsa is the standard boat/aero
 * core (grain runs through the thickness → high shear stiffness for its weight);
 * paulownia is the lightest common hardware-store board; poplar plywood is
 * light ply that also adds its own bending stiffness.
 */
export const WOOD_CORES = {
  balsa: { name: 'end-grain balsa', rho: 150, E: 0.05e9, G: 0.16e9, sizes: [6, 10, 12, 19, 25], sheet: '610 × 1220 mm contour-kerfed sheets on scrim', short: 'Balsa' },
  paulownia: { name: 'paulownia', rho: 280, E: 2.2e9, G: 0.25e9, sizes: [10, 12, 15, 19, 25], sheet: 'edge-glued boards (plane to thickness)', short: 'Paulownia' },
  poplar: { name: 'poplar plywood', rho: 450, E: 6e9, G: 0.4e9, sizes: [6, 9, 12, 15, 18], sheet: '1220 × 2440 mm sheets', short: 'Poplar ply' },
};

export interface PlateProps {
  name: string;
  /** total thickness (mm) */
  tMm: number;
  /** bending stiffness (N·m) */
  D: number;
  /** transverse shear stiffness (N/m), Infinity for solid panels */
  S: number;
  /** mass per area (kg/m²) */
  m: number;
}

export interface SandwichInfo extends PlateProps {
  tSkinMm: number;
  ribMm: number;
  coreDensity: number;
  /** a square of skin between ribs (Hz) */
  skinPanelHz: number;
}

export function sandwichPlate(sw: SandwichSpec, pr: Printer): SandwichInfo {
  const sk = SKINS[sw.skin];
  const tf = (sw.plies * sk.tPly) / 1000;
  const c = sw.coreMm / 1000;
  const wood = sw.core === 'ribs' ? null : WOOD_CORES[sw.core];
  const ribMm = sw.ribLines * pr.lineWidth;
  const P = sw.ribPitchMm / 1000;
  const solidity = wood ? 1 : Math.min(1, (2 * ribMm) / sw.ribPitchMm - (ribMm / sw.ribPitchMm) ** 2);
  const d = c + tf;
  const D =
    (sk.E * tf * d * d) / (2 * (1 - sk.nu ** 2)) + (2 * sk.E * tf ** 3) / (12 * (1 - sk.nu ** 2)) + (wood ? (wood.E * c ** 3) / 12 : 0);
  const Gc = wood ? wood.G : PETG.G * (ribMm / sw.ribPitchMm);
  const S = (Gc * d * d) / c;
  // epoxy: fillets on rib tops, or the resin a wood face soaks up
  const bond = wood ? 0.2 : 0.15; // kg/m² per face
  const m = 2 * sk.rho * tf + (wood ? wood.rho : PETG.rho) * c * solidity + 2 * bond;
  const Ds = (sk.E * tf ** 3) / (12 * (1 - sk.nu ** 2));
  const skinPanelHz = wood ? Infinity : 1.8 * (Math.PI / 2) * Math.sqrt(Ds / (sk.rho * tf)) * (2 / (P * P));
  return {
    name: `${sw.skin === 'carbon' ? 'Carbon' : 'Fibreglass'} sandwich (${sw.plies}+${sw.plies} plies on ${sw.coreMm} mm ${wood ? wood.name : 'printed ribs'})`,
    tMm: sw.coreMm + 2 * sw.plies * sk.tPly,
    D,
    S,
    m,
    tSkinMm: sw.plies * sk.tPly,
    ribMm,
    coreDensity: solidity,
    skinPanelHz,
  };
}

export function plateProps(p: HybridParams, pr: Printer): PlateProps {
  if (p.plateMaterial === 'sandwich') return sandwichPlate(p.sandwich, pr);
  const pl = PLATES[p.plateMaterial];
  const t = p.plateMm / 1000;
  return { name: pl.name, tMm: p.plateMm, D: (pl.E * t ** 3) / (12 * (1 - pl.nu ** 2)), S: Infinity, m: pl.rho * t };
}

/** Plate thickness (mm) for the chosen material. */
export function plateThickness(p: HybridParams, pr: Printer) {
  return p.plateMaterial === 'sandwich' ? Math.round(sandwichPlate(p.sandwich, pr).tMm * 10) / 10 : p.plateMaterial === 'bb12' ? 12 : p.plateMaterial === 'mdf19' ? 19 : p.plateMaterial === 'glass' ? 12 : p.plateMaterial === 'acrylic' ? 10 : 18;
}

/** f11 of a plate panel a × b (m), edges between clamped and simply supported, with core-shear softening. */
export function panelHz(pp: PlateProps, a: number, b: number) {
  const k2 = Math.PI ** 2 * (1 / (a * a) + 1 / (b * b));
  const Deff = pp.D / (1 + (pp.D * k2) / pp.S);
  return 1.8 * (Math.PI / 2) * Math.sqrt(Deff / pp.m) * (1 / (a * a) + 1 / (b * b));
}

export interface PanelPlan {
  /** panels per cabinet (2 outer plates + dividers) */
  panels: number;
  tilesPerPanel: number;
  tileW: number;
  tileH: number;
  tilesX: number;
  tilesY: number;
  grams: number;
  hours: number;
  /** per cabinet */
  clothM2: number;
  epoxyKg: number;
  plateKg: number;
  birchKg: number;
}

/** The printed rib cores of the sandwich plates, tiled onto the bed, and the layup materials. */
export function planPanels(p: HybridParams, g: Geometry, pr: Printer): PanelPlan {
  const sw = p.sandwich;
  const info = sandwichPlate(sw, pr);
  const ux = pr.bedX - 2 * pr.margin;
  const uy = pr.bedY - 2 * pr.margin;
  const tile = (a: number, b: number) => {
    const nx = Math.ceil(g.W / a);
    const ny = Math.ceil(g.H / b);
    return { nx, ny, n: nx * ny, w: g.W / nx, h: g.H / ny };
  };
  const t1 = tile(ux, uy);
  const t2 = tile(uy, ux);
  const t = t2.n < t1.n ? t2 : t1;
  const panels = 2 + g.cores - 1;
  const areaM2 = (g.W * g.H) / 1e6;
  // the core grid + a solid 10 mm frame round every tile (the tiles are glued edge to edge)
  const frame = (2 * (t.w + t.h) * 10 * sw.coreMm) / 1e9; // m³ per tile
  const coreVolM3 = areaM2 * (sw.coreMm / 1000) * info.coreDensity + frame * t.n;
  const printed = sw.core === 'ribs';
  const grams = printed ? coreVolM3 * 1e6 * pr.filamentDensity * panels : 0;
  const hours = printed ? ((coreVolM3 * 1e9) / pr.flow / 3600) * 1.3 * panels : 0;
  const sk = SKINS[sw.skin];
  const clothM2 = areaM2 * 2 * sw.plies * panels * 1.15;
  const epoxyKg = clothM2 * 0.2 * 1.0 + areaM2 * 2 * (printed ? 0.15 : 0.2) * panels;
  void sk;
  return {
    panels,
    tilesPerPanel: printed ? t.n : 0,
    tileW: t.w,
    tileH: t.h,
    tilesX: t.nx,
    tilesY: t.ny,
    grams,
    hours,
    clothM2,
    epoxyKg,
    plateKg: info.m * areaM2 * panels,
    birchKg: 680 * 0.018 * areaM2 * panels,
  };
}

export function buildIssues(p: HybridParams, g: Geometry, d: DriverInfo, plan: PrintPlan, pr: Printer, outdoor: boolean): Issue[] {
  if (g.shell) {
    const sh = g.shell;
    const out: Issue[] = [];
    const bedMin = Math.min(pr.bedX, pr.bedY) - 2 * pr.margin;
    const bedMax = Math.max(pr.bedX, pr.bedY) - 2 * pr.margin;
    const big = plan.segments.filter((sg) => sg.bedW > bedMax || sg.bedH > bedMin);
    const halves = plan.segments.some((sg) => sg.core > 0);
    out.push(
      big.length
        ? { level: 'bad', title: `The shell is Ø${Math.round(2 * sh.Rmax)} mm — too big for your bed even in half-rings`, body: 'Make it smaller or print it on a bigger printer.' }
        : { level: 'ok', title: `${plan.segments.length} pieces: ${halves ? 'bands split into half-rings' : 'bands'}, printed nose-up`, body: `Each band (up to ${Math.round(Math.max(...plan.segments.map((sg) => sg.z1)))} mm tall) prints standing on its rim with no support; the curve stays under 45° except at the very back, where a little tree support helps.${halves ? ' Bands wider than the bed print as two half-rings with keyed seam faces — glue the halves first, then the bands.' : ''} Glue with epoxy on a printed 3 mm lip.` }
    );
    const lines = p.wallMm / pr.lineWidth;
    out.push({ level: lines < 3 ? 'warn' : 'ok', title: `Walls ${p.wallMm} mm = ${lines.toFixed(lines % 1 ? 1 : 0)} lines`, body: 'A curved shell is very stiff for its weight (no flat panels to flex), so thin walls are fine; fill with 100 % infill for mass and damping, or pour a little sand-epoxy into the back half.' });
    out.push({ level: 'ok', title: 'Front land', body: `The woofer sits on a flat Ø${Math.round(2 * sh.landR)} mm land with its Ø${Math.round(2 * sh.holeR)} mm hole printed in. Use heat-set M4 inserts for its screws and foam gasket tape.` });
    out.push({ level: 'ok', title: 'Stand', body: 'A round shell needs a cradle: print a ring (or use a cork ring for a bowl) under it, or the pedestal shown. Terminals: a small binding-post pair through the back pole; fill with polyester wool through the woofer hole.' });
    return out;
  }
  const extras: Issue[] = [];
  if (p.plateMaterial === 'glass')
    extras.push({ level: 'warn', title: 'Laminated-glass side plates', body: 'Very stiff and heavy (good), and the PVB interlayer damps them. Never glue glass straight to the print: seat it on 3 mm closed-cell EPDM gasket in a printed rebate and clamp with through-bolts in rubber sleeves, so the glass can\'t crack from the plastic\'s movement. Have it cut and edge-polished by a glazier, with the bolt holes drilled before toughening/laminating.' });
  if (p.plateMaterial === 'acrylic')
    extras.push({ level: 'warn', title: 'Acrylic side plates', body: 'See-through and easy to laser-cut, but light and poorly damped: panel resonances ring. Add a constrained-layer damping strip on the inside where it won\'t show, mount on gasket, and don\'t overtighten (acrylic crazes at the bolts).' });
  if (!g.shell && p.type !== 'waveguide')
    extras.push({
      level: 'ok',
      title: 'Terminals, stuffing access and seals',
      body: `Print a boss on the back wall for a pair of binding posts (or a 75 mm terminal cup if the back is wide enough) and seal them with silicone. ${p.type === 'tl' || p.type === 'blh' || p.type === 'tapped' ? 'Stuff the line through the woofer hole before fitting the woofer, or leave one side plate on screws over the stuffed section so you can tune it by ear.' : 'Fill through the woofer hole before fitting it.'} Print a 2 × 2 mm groove round each driver hole and round the plate faces of the core for gasket cord, so every joint seals without relying on glue alone.`,
    });

  const out: Issue[] = [];
  const plate = plateProps(p, pr);
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
  const wm = g.construction === 'bends' ? (p.wallMm === 19 ? PLATES.mdf19 : PLATES.bb18) : PETG;
  const Dw = (wm.E * tw ** 3) / (12 * (1 - wm.nu ** 2));
  const fWall = (22.37 / (2 * Math.PI)) * Math.sqrt(Dw / (wm.rho * tw)) / (span * span); // clamped strip
  out.push({
    level: fWall < lim.wallBad ? 'bad' : fWall < lim.wallWarn ? 'warn' : 'ok',
    title: `${g.construction === 'bends' ? 'Plywood fold walls' : 'Printed walls'} flex at ≈ ${fWall.toFixed(0)} Hz (span ${g.coreMm.toFixed(0)} mm between plates)`,
    body:
      fWall < lim.wallWarn
        ? `Walls glued between two plates ${g.coreMm.toFixed(0)} mm apart act like a ${p.wallMm} mm ${g.construction === 'bends' ? 'plywood' : 'PETG'} strip clamped on both edges. ${fWall < lim.wallBad ? `That is inside the band this cabinet plays (up to ~${passTop} Hz) — they will buzz and lose output.` : `That is above the ~${passTop} Hz this cabinet plays, but close enough that loud bass can excite it.`} Fixes: add a plywood divider (halving the span raises this ×4), thicken walls (×1.5 thickness ≈ ×1.5 frequency), or curve the walls (an arch is far stiffer than a flat strip).`
        : `Comfortably above the ~${passTop} Hz this cabinet plays. Curved bends add stiffness on top of this.`,
  });

  // ---- side plates over the open channels ----
  let worst = { a: 0, b: 0, f: Infinity, label: '' };
  for (const r of g.spans) {
    const a = (r.x1 - r.x0) / 1000;
    const b = (r.y1 - r.y0) / 1000;
    if (a < 0.03 || b < 0.03) continue;
    const f11 = panelHz(plate, a, b);
    if (f11 < worst.f) worst = { a, b, f: f11, label: r.label ?? 'channel' };
  }
  if (Number.isFinite(worst.f))
    out.push({
      level: worst.f < lim.plateBad ? 'bad' : worst.f < lim.plateWarn ? 'warn' : 'ok',
      title: `Side-plate resonance: ${worst.f.toFixed(0)} Hz over the ${worst.label}`,
      body: `The ${plate.name} plate spans ${(worst.a * 1000).toFixed(0)} × ${(worst.b * 1000).toFixed(0)} mm unsupported there. ${
        worst.f < lim.plateWarn ? `Close to the band this cabinet plays — add printed posts or ribs in that space, use a thicker plate, or laminate a second plate.` : 'Comfortably above the band this cabinet plays.'
      }${p.plateMaterial === 'sandwich' ? ` (18 mm birch there: ${panelHz(plateProps({ ...p, plateMaterial: 'bb18', plateMm: 18 }, pr), worst.a, worst.b).toFixed(0)} Hz.)` : ''}`,
    });

  // ---- sandwich plates ----
  if (p.plateMaterial === 'sandwich') {
    const sw = p.sandwich;
    const si = sandwichPlate(sw, pr);
    const birch = plateProps({ ...p, plateMaterial: 'bb18', plateMm: 18 }, pr);
    const pp = planPanels(p, g, pr);
    const sk = SKINS[sw.skin];
    const wood = sw.core === 'ribs' ? null : WOOD_CORES[sw.core];
    out.push({
      level: 'ok',
      title: `${si.name}: ${si.tMm.toFixed(1)} mm, ${si.m.toFixed(1)} kg/m² — ${(si.D / birch.D).toFixed(1)}× the stiffness of 18 mm birch at ${Math.round((si.m / birch.m) * 100)} % of the weight`,
      body: `Plates${g.cores > 1 ? ' and dividers' : ''} weigh ${pp.plateKg.toFixed(1)} kg per cabinet instead of ${pp.birchKg.toFixed(1)} kg in birch. The skins do the work: ${si.tSkinMm.toFixed(2)} mm of ${sk.name} on each face, held ${sw.coreMm} mm apart by ${wood ? `${wood.name} (${wood.rho} kg/m³)` : `${si.ribMm.toFixed(1)} mm printed ribs every ${sw.ribPitchMm} mm (core ${Math.round(si.coreDensity * 100)} % solid)`}. Doubling the core thickness makes it ~4× stiffer for little extra weight.`,
    });
    if (!wood)
    out.push({
      level: si.skinPanelHz < passTop * 3 ? 'warn' : 'ok',
      title: `Skin between ribs: ${si.skinPanelHz.toFixed(0)} Hz`,
      body:
        si.skinPanelHz < passTop * 3
          ? `Each ${sw.ribPitchMm} mm square of skin is a little drum close to the band this plays — tighten the rib pitch or add a ply.`
          : `Each ${sw.ribPitchMm} mm square of skin is far above the band this cabinet plays. The rib grid also stops the skin denting under clamps or knocks.`,
    });
    out.push({
      level: 'warn',
      title: 'Damping: fibre skins ring',
      body: `Carbon and glass/epoxy have far less internal damping than plywood, so panel resonances are sharper.${wood ? ` The ${wood.name} core helps — wood damps far better than plastic ribs — but a constrained-layer damping sheet on the inside face is still worth it.` : ''} Fill the rib cells with open-cell foam or pour a thin layer of viscoelastic (e.g. 2 mm of a constrained-layer damping sheet) on the inside skin before closing. ${p.type === 'folded-horn' ? 'For a horn sub the plates are already above the passband, so this is a refinement.' : 'Worth doing on a living-room speaker.'}`,
    });
    if (wood)
      out.push({
        level: 'ok',
        title: `Making the plates: ${pp.panels} ${wood.name} core panel${pp.panels > 1 ? 's' : ''}, ${sw.coreMm} mm`,
        body: `Buy ${wood.name} as ${wood.sheet}; common thicknesses ${wood.sizes.join(', ')} mm. Cut each core to the plate outline (bandsaw or jigsaw, sand the edge round). ${sw.core === 'balsa' ? 'Seal the end grain first with a thin coat of epoxy, let it go tacky, then lay up — balsa soaks up resin like a sponge. ' : 'Sand 80 grit and vacuum the dust. '}Wet-lay ${sw.plies} plies of ${sk.cloth} on one face (alternate 0/90 and ±45), peel ply, vacuum-bag or weight it flat; cure, flip, repeat. Wrap the cloth round the rounded edges, or edge-band with a strip of hardwood. Per cabinet: ~${pp.clothM2.toFixed(1)} m² of cloth and ~${pp.epoxyKg.toFixed(1)} kg of laminating epoxy. Bond to the printed core with thickened epoxy (room-temperature cure — PETG softens at ~75 °C). ${sw.core === 'balsa' ? 'Balsa crushes under bolt heads: drill oversize, fill with thickened epoxy, then re-drill (a "potted" hole) wherever a through-bolt goes.' : `${wood.name[0].toUpperCase() + wood.name.slice(1)} holds screws and bolts well — use big washers on the skin.`}`,
      });
    else
    out.push({
      level: 'ok',
      title: `Making the plates: ${pp.panels} panel${pp.panels > 1 ? 's' : ''} × ${pp.tilesPerPanel} printed rib tiles (${pp.tilesX} × ${pp.tilesY}, ${Math.round(pp.tileW)} × ${Math.round(pp.tileH)} mm)`,
      body: `Print the rib tiles flat (ribs standing up, ${sw.coreMm} mm tall), each with a solid 10 mm frame — ${(pp.grams / 1000).toFixed(1)} kg, ~${pp.hours.toFixed(0)} h. Glue the tiles into one panel on a flat table (epoxy, weights). Sand both faces flat, wipe with alcohol, then wet-lay ${sw.plies} plies of ${sk.cloth} on one face, alternating 0/90 and ±45 so it is stiff in every direction; peel ply on top and vacuum-bag (or just weight it under plastic on a flat surface). Cure, flip, repeat on the other face. Per cabinet: ~${pp.clothM2.toFixed(1)} m² of cloth and ~${pp.epoxyKg.toFixed(1)} kg of laminating epoxy. Use a ROOM-TEMPERATURE-cure epoxy and don't post-cure above ~55 °C — PETG softens at ~75 °C. Bond the finished plates to the cabinet core with thickened epoxy; through-bolts need printed or aluminium bosses in the rib core (fibre skins crack under bare bolt heads — use big washers).`,
    });
    if (outdoor)
      out.push({
        level: 'warn',
        title: 'Outdoors: UV-protect the epoxy',
        body: 'Epoxy yellows and chalks in sunlight. Finish with a UV-resistant 2-part clear coat (for the carbon look) or paint.',
      });
  }

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

  if (g.construction === 'bends')
    out.push({
      level: 'ok',
      title: `Printed bends + plywood: ${g.strips.reduce((a, st) => a + st.qty, 0)} plywood strips, 2 printed caps per core`,
      body: `Print the two end-caps with ${p.wallMm} mm slots (+0.4 mm clearance) where the plywood strips go in; ${(p.wallMm / pr.lineWidth).toFixed(0)} lines either side of each slot. Dry-fit the strips into one cap, then the other, glue with PU construction adhesive (it fills the print roughness and seals), and check the stack is square before the plates go on. Cut all the strips of one width at one fence setting — they must all be exactly the core thickness (${g.coreMm.toFixed(0)} mm).`,
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
      body: 'Estimate assumes solid walls near every surface and thick corners printed hollow with a few ribs (the plates close those pockets — seal them like the rest). To cut it down: print only the complex parts (bends, throat, mouth) and use plywood strips for long straight walls between the plates; lower the wall count where the flex check allows; or build one cabinet and measure before printing four.',
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
  out.push(...extras);
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


// ---------------------------------------------------------------------------
// printed tweeter head (living-room 2-ways)
// ---------------------------------------------------------------------------
//
// The tweeter lives in its own small printed pod on top of the cabinet,
// decoupled on a soft pad: no woofer-cabinet vibration reaches it, the pod's
// round edges keep diffraction low, and it can be set back so the tweeter's
// sound starts in step with the woofer's (time alignment). 'waveguide' heads
// add a printed round flare around the dome for controlled directivity.

/** Tweeter set-up of a design, reading older saves' `head` field. */
export function tweeterSetup(p: HybridParams): { mount: TweeterMount; waveguide: boolean; tweeter: DriverInfo | null } {
  const mount: TweeterMount = p.tweeterMount ?? (p.head === 'flat' || p.head === 'waveguide' ? 'pod' : 'none');
  const waveguide = p.tweeterWaveguide ?? p.head === 'waveguide';
  const tweeter = mount === 'none' || p.type === 'waveguide' || p.type === 'folded-horn' ? null : (findDriver(p.tweeterId) ?? null);
  return { mount: tweeter ? mount : 'none', waveguide, tweeter };
}

/**
 * A printed round waveguide for a dome tweeter: an oblate-spheroid flare
 * r(z) = √(r0² + (z·tan θ)²) from the throat (the tweeter's faceplate sits flush
 * in a recess there) to the mouth, finished with a rolled lip. Its depth follows
 * from the coverage angle, so a 90° guide really is 90°.
 */
export interface RoundWaveguide {
  /** throat radius = faceplate radius + clearance (mm) */
  r0: number;
  /** mouth radius before the lip, and the outer flange radius on the face (mm) */
  R: number;
  flangeR: number;
  /** flare depth, throat → face (mm), and the faceplate recess at the throat */
  depthMm: number;
  recessMm: number;
  coverageDeg: number;
  /** below this the guide no longer controls directivity (Keele's rule) */
  controlHz: number;
  /** profile from throat (z = 0) to face (z = depth): [radius, z] in mm, radius never shrinking */
  profile: [number, number][];
  /** shell wall (mm) */
  wallMm: number;
}

export function roundWaveguide(tw: DriverInfo, coverageDeg = 90, wallMm = 4, crossoverHz?: number): RoundWaveguide {
  // matched to a crossover: grow the mouth until the guide really controls down to 0.8 × it
  let wg = roundWaveguideSized(tw, coverageDeg, wallMm, crossoverHz);
  if (crossoverHz) {
    let grow = 0;
    while (wg.controlHz > 0.8 * crossoverHz && grow < 60) {
      grow += 2;
      wg = roundWaveguideSized(tw, coverageDeg, wallMm, crossoverHz, grow);
    }
  }
  return wg;
}

function roundWaveguideSized(tw: DriverInfo, coverageDeg: number, wallMm: number, crossoverHz?: number, growMm = 0): RoundWaveguide {
  const r0 = tw.frameDiaMm / 2 + 1;
  // mouth: by default a size that suits 1.5–2.5 kHz crossovers; with a crossover given, just big
  // enough that pattern control (Keele: f ≈ 25 000 / (mouth m × angle°)) reaches 0.8 × that
  const lipTotal = 8;
  const Rfor = crossoverHz ? 25000 / ((0.8 * crossoverHz) * coverageDeg) * 500 - lipTotal : r0 + 38;
  const R = Math.max(r0 + 20, Math.min(150, Rfor + growMm));
  const lip = 8;
  const th = (Math.min(Math.max(coverageDeg, 60), 130) / 2) * (Math.PI / 180);
  const zFlare = Math.sqrt(Math.max(R - lip, r0 + 1) ** 2 - r0 * r0) / Math.tan(th);
  const profile: [number, number][] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const z = (zFlare * i) / N;
    profile.push([Math.sqrt(r0 * r0 + (z * Math.tan(th)) ** 2), z]);
  }
  // rolled lip: an arc tangent to the wall at the mouth, turning it out flat onto the face.
  // With α the wall's angle from the axis, dr = lip·sin α dα and dz = lip·cos α dα, so both
  // radius and depth only ever grow — the flare can't choke or fold back.
  const [rEnd, zEnd] = profile[profile.length - 1];
  const phi = Math.atan2((zFlare * Math.tan(th) ** 2) / rEnd, 1); // wall angle from the axis at the mouth
  for (let i = 1; i <= 8; i++) {
    const a = phi + ((Math.PI / 2 - phi) * i) / 8;
    profile.push([rEnd + lip * (Math.cos(phi) - Math.cos(a)), zEnd + lip * (Math.sin(a) - Math.sin(phi))]);
  }
  const depth = profile[profile.length - 1][1];
  const Rm = profile[profile.length - 1][0];
  return {
    r0,
    R: Rm,
    flangeR: Rm + 10,
    depthMm: depth,
    recessMm: tw.flangeMm ?? 4,
    coverageDeg,
    controlHz: 25000 / (((2 * Rm) / 1000) * coverageDeg),
    profile,
    wallMm,
  };
}

/** Problems with a round waveguide (empty = it is a smooth, widening flare the tweeter fits). */
export function waveguideIssues(wg: RoundWaveguide, tw: DriverInfo): string[] {
  const out: string[] = [];
  for (let i = 1; i < wg.profile.length; i++) {
    if (wg.profile[i][0] < wg.profile[i - 1][0] - 1e-6) out.push(`The flare narrows ${wg.profile[i][1].toFixed(0)} mm from the throat (a choke).`);
    if (wg.profile[i][1] < wg.profile[i - 1][1] - 1e-6) out.push('The flare folds back on itself (self-intersecting).');
  }
  if (wg.r0 < tw.frameDiaMm / 2) out.push(`The throat (Ø${(2 * wg.r0).toFixed(0)} mm) is smaller than the ${tw.model}'s faceplate (Ø${tw.frameDiaMm} mm).`);
  return [...new Set(out)];
}

export interface HeadGeometry {
  kind: 'flat' | 'waveguide';
  /** outside size (mm): across, tall, front→back */
  w: number;
  h: number;
  d: number;
  /** how far the head's front sits behind the cabinet front (time alignment) */
  setbackMm: number;
  tweeterCutoutMm: number;
  tweeterFrameMm: number;
  tweeterDepthMm: number;
  /** the round waveguide in the pod's face, if any */
  waveguide: RoundWaveguide | null;
  /** waveguide mouth diameter (mm); 0 for flat */
  mouthMm: number;
  wallMm: number;
  grams: number;
  notes: string[];
}

export function headGeometry(p: HybridParams, tw: DriverInfo | null, woofer: DriverInfo): HeadGeometry | null {
  const setup = tweeterSetup(p);
  if (!tw || setup.mount !== 'pod') return null;
  const wall = Math.max(4, Math.min(p.wallMm, 8));
  const frame = tw.frameDiaMm;
  const depthT = tw.mountDepthMm ?? 35;
  const wg = setup.waveguide ? roundWaveguide(tw, p.coverageDeg || 90, wall, p.tweeterXoHz) : null;
  const face = (wg ? 2 * wg.flangeR : frame) + 2 * 14;
  const w = Math.round(face);
  const h = Math.round(face);
  // flare + the tweeter behind its throat + back wall + a little air
  const d = Math.round((wg ? wg.depthMm : 0) + depthT + 2 * wall + 15);
  // woofer acoustic centre sits ~ at its voice coil: ≈ 60 % of the mounting depth behind the
  // baffle; a dome tweeter's is ~ at its flange. A waveguide moves the tweeter back by its depth.
  const wooferAc = 0.6 * (woofer.mountDepthMm ?? 75);
  const setback = Math.max(0, Math.round(wooferAc - (wg ? wg.depthMm : 0)));
  const shellCm3 = (2 * (w * h + w * d + h * d) * wall) / 1000;
  return {
    kind: wg ? 'waveguide' : 'flat',
    w,
    h,
    d,
    setbackMm: setback,
    tweeterCutoutMm: tw.cutoutDiaMm,
    tweeterFrameMm: frame,
    tweeterDepthMm: depthT,
    waveguide: wg,
    mouthMm: wg ? Math.round(2 * wg.R) : 0,
    wallMm: wall,
    grams: Math.round(shellCm3 * 1.27 * 1.15),
    notes: [
      `Printed as one piece, face down, ${w} × ${h} × ${d} mm${wg ? ` with a Ø${Math.round(2 * wg.R)} mm, ${wg.coverageDeg}° round waveguide (${wg.depthMm.toFixed(0)} mm deep; controls directivity down to ≈ ${Math.round(wg.controlHz / 100) * 100} Hz)` : ''}.`,
      `Sits ${setback} mm back from the cabinet front so the tweeter and woofer sound start together (time alignment) — fine-tune by ear or with a measurement mic.`,
      'Stands on a 3 mm sorbothane / EPDM pad and is held by one M6 bolt into a heat-set insert in the cabinet top; the tweeter wire runs through a sealed grommet next to it.',
      'Fill the pod loosely with polyester wool. The tweeter has a closed back, so the pod is just a housing — it needs no particular volume.',
    ],
  };
}

/** A tweeter pod must stand on the flat part of the cabinet top, without overhanging. */
export function headProblems(h: HeadGeometry, g: Geometry, p: HybridParams): string[] {
  const out: string[] = [];
  // on a round shell the pod sits on a printed saddle shaped to the curve
  if (g.shell) return h.w > g.H ? [`The tweeter pod (${h.w} mm wide) is wider than the shell — a smaller pod (no waveguide).`] : out;
  const topW = g.Etot + 2 * p.plateMm;
  if (h.w > topW + 0.5) out.push(`The tweeter pod (${h.w} mm wide) overhangs the ${Math.round(topW)} mm cabinet top — a narrower pod (no waveguide) or a wider cabinet.`);
  if (h.setbackMm + h.d > g.W - 5) out.push(`The tweeter pod (${h.d} mm deep, set back ${h.setbackMm} mm) overhangs the back of the cabinet — a deeper cabinet.`);
  // its pad needs flat top: sample the profile just under the top across the pad
  const x0 = g.W - h.setbackMm - h.d * 0.8;
  const x1 = g.W - h.setbackMm - h.d * 0.2;
  for (let x = x0; x <= x1; x += 2)
    if (!pointInPoly(g.core, x, g.H - 0.5)) {
      out.push('The tweeter pod would sit on the rounded edge of the top, not on flat top — less rounding, or a deeper cabinet.');
      break;
    }
  return out;
}

/** Printed living-room designs offered in the Speakers gallery. */
export interface PrintedDesign {
  id: string;
  name: string;
  short: string;
  blurb: string;
  difficulty: 1 | 2 | 3;
  params: HybridParams;
}

const mon = (o: Partial<HybridParams>): HybridParams => ({
  ...HYBRID_PRESETS.living,
  sandwich: { ...DEFAULT_SANDWICH },
  construction: 'full',
  rounding: 1,
  dividers: 0,
  tweeterMount: 'front',
  tweeterWaveguide: false,
  coverageDeg: 90,
  tweeterId: 'sb26stac-c000-4',
  ...o,
});

export const PRINTED_DESIGNS: PrintedDesign[] = [
  {
    id: 'mon-sealed',
    name: 'Printed sealed monitor',
    short: '6.5″ + 1″ tweeter, sealed',
    difficulty: 1,
    blurb:
      'The simplest printed monitor: one rounded, fully printed shell between two plywood side plates, woofer and tweeter both in its front wall. Sealed = no port to tune and tight, forgiving bass that blends easily with a sub. The easiest place to start printing speakers.',
    params: mon({ type: 'sealed', driverId: 'sb17nrx2c35-8', heightMm: 330, depthMm: 300, extrusionMm: 210, wallMm: 9, legs: 1, dividers: 1 }),
  },
  {
    id: 'mon-slot',
    name: 'Printed slot-port monitor',
    short: '6.5″ + 1″, slot port',
    difficulty: 2,
    blurb:
      'Vented for deeper bass from the same woofer (tuned to ~39 Hz): the port is a wide, flat slot printed into the bottom of the shell with rounded, flared ends — quieter than a round tube, and easy to print. Tweeter above the woofer in the same front.',
    params: mon({ type: 'slot-port', driverId: 'sb17nrx2c35-8', heightMm: 460, depthMm: 320, extrusionMm: 200, wallMm: 9, legs: 1, slotMm: 22, dividers: 1 }),
  },
  {
    id: 'mon-tl',
    name: 'Printed mini transmission line',
    short: '5.25″ six-fold line, 64 cm',
    difficulty: 3,
    blurb:
      'A tapering transmission line folded six times inside a 64 cm stand-mount shell — curved, tapering channels are exactly what printing is good at. Deep, well-damped bass (line tuned below the woofer’s own resonance) for a small 5.25″ woofer; the tweeter has its own small sealed compartment at the top so the line stays the right size.',
    params: mon({ type: 'tl', driverId: 'dc130a-8', heightMm: 640, depthMm: 300, extrusionMm: 170, wallMm: 6, legs: 6, taper: 0.3 }),
  },
  {
    id: 'mon-wg',
    name: 'Printed waveguide monitor',
    short: '6.5″ + waveguide tweeter, sealed',
    difficulty: 2,
    blurb:
      'The sealed monitor with a printed 90° round waveguide around the tweeter, built into the front wall. It narrows the tweeter’s spread to match the woofer’s at the crossover, so the sound reflected from your walls is as smooth as the direct sound — the trick behind many modern studio monitors.',
    params: mon({ type: 'sealed', driverId: 'sb17nrx2c35-8', heightMm: 420, depthMm: 240, extrusionMm: 200, wallMm: 9, legs: 1, dividers: 1, tweeterWaveguide: true }),
  },
  {
    id: 'blh',
    name: 'Printed back-loaded horn',
    short: '6.5″ + 1″, folded rear horn, 60 cm',
    difficulty: 3,
    blurb:
      'The back of the woofer drives a small chamber and then a smoothly expanding horn folded five times inside the shell, out through a mouth at the bottom front. The horn makes the woofer’s rear wave useful: about 32 Hz from a 6.5″ in a 60 cm stand-mount — a flare that would be a stack of stepped panels in wood is one smooth curve in print.',
    params: mon({ type: 'blh', driverId: 'dc160-8', heightMm: 600, depthMm: 360, extrusionMm: 240, wallMm: 9, legs: 5, throatRatio: 0.8, rearChamberL: 4, dividers: 1 }),
  },
  {
    id: 'th-sub',
    name: 'Printed tapped-horn subwoofer',
    short: '12″ tapped horn, 80 cm',
    difficulty: 3,
    blurb:
      'A tapped horn: the 12″ woofer sits on a fold wall with its back feeding the closed throat and its front feeding the horn one fold further on, so both sides of the cone drive the same horn. Very efficient, deep bass from a sub-sized box — the expanding six-run path is exactly the kind of shape printing makes easy.',
    params: mon({ type: 'tapped', driverId: 'rss315hfa-8', heightMm: 800, depthMm: 700, extrusionMm: 300, wallMm: 9, legs: 6, throatRatio: 0.5, dividers: 1, tweeterMount: 'none' }),
  },
  {
    id: 'egg',
    name: 'Printed curved shell',
    short: '6.5″ egg, tweeter pod',
    difficulty: 2,
    blurb:
      'A curved, egg-shaped shell — a solid of revolution around the woofer — with the tweeter in a pod on top. No parallel walls inside for standing waves to build up between, and the front curves away so gently that edge diffraction almost disappears: the shapes that measure smoothest and that woodworkers almost never attempt.',
    params: mon({ type: 'shell', driverId: 'sb17nrx2c35-8', heightMm: 300, depthMm: 380, extrusionMm: 300, wallMm: 6, rounding: 1, dividers: 0, tweeterMount: 'pod' }),
  },
  {
    id: 'line',
    name: 'Printed line tower',
    short: '6.5″ transmission line, floor-standing',
    difficulty: 3,
    blurb: 'The original printed living-room speaker: a tall six-leg transmission line for deep bass without a sub. Woofer only — add a tweeter in its front or in a pod on top.',
    params: { ...HYBRID_PRESETS.living, sandwich: { ...DEFAULT_SANDWICH } },
  },
];
export const printedDesignById = (id: string) => PRINTED_DESIGNS.find((d) => d.id === id);

/** What the 3D viewer needs to draw a printed cabinet. */
export interface PrintedModel {
  geo: Geometry;
  params: HybridParams;
  head: HeadGeometry | null;
  plateColor: number;
  /** sandwich dividers match the plates; otherwise plywood */
  dividerColor?: number;
  /** one line about the print (pieces, filament, hours) for the part info */
  printSummary: string;
}

// ---------------------------------------------------------------------------
// "Make it fit": the smallest change to a design that makes it buildable
// ---------------------------------------------------------------------------

export interface FitChange {
  label: string;
  from: string;
  to: string;
}

/**
 * Search nearby designs for one that can be built (geometry fits, no blocking build
 * issue), changing as little as possible: size changes cost by how much they grow,
 * fold/divider/rounding changes a small fixed amount, soft warnings and bass far
 * from the original's add a bit. Candidates are tried cheapest first, so the first
 * that works is the answer. Returns null if nothing within reach works.
 */
export function autoFit(p: HybridParams, d: DriverInfo, pr: Printer): { params: HybridParams; changes: FitChange[] } | null {
  const it = autoFitSteps(p, d, pr);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** autoFit in slices, yielding to the page between them; reports progress 0…1. */
export async function autoFitAsync(p: HybridParams, d: DriverInfo, pr: Printer, onProgress?: (f: number) => void) {
  const it = autoFitSteps(p, d, pr);
  for (;;) {
    const t0 = performance.now();
    let r = it.next();
    while (!r.done && performance.now() - t0 < 40) r = it.next();
    if (r.done) return r.value;
    onProgress?.(r.value);
    await new Promise((ok) => setTimeout(ok, 0));
  }
}

function* autoFitSteps(p: HybridParams, d: DriverInfo, pr: Printer): Generator<number, { params: HybridParams; changes: FitChange[] } | null> {
  const sealedQ = (g: Geometry) => {
    const st = g.stats.find((x) => x.label === 'Qtc / fc');
    return st ? parseFloat(st.value) : null;
  };
  const tuning = (g: Geometry) => {
    const st = g.stats.find((x) => /tuning/i.test(x.label));
    const m = st?.value.match(/≈ (\d+) Hz/);
    return m ? +m[1] : null;
  };
  const g0 = buildGeometry(p, d);
  const fb0 = tuning(g0);
  const q0 = sealedQ(g0);

  const scales = [0.9, 1, 1.08, 1.16, 1.25, 1.35, 1.5, 1.7, 1.9];
  const legsOpts = p.type === 'tl' || p.type === 'folded-horn' || p.type === 'slot-port' ? [p.legs, p.legs - 2, p.legs + 2].filter((x) => x >= 1 && x <= 8) : [p.legs];
  const divOpts = [...new Set([p.dividers, 0, 1])].filter((x) => x >= 0 && x <= 3);
  const roundOpts = [...new Set([p.rounding, 0.5, 0])].filter((x) => x <= p.rounding + 1e-9);
  type Cand = { q: HybridParams; cost: number };
  const cands: Cand[] = [];
  const round = (x: number, step: number) => Math.round(x / step) * step;
  for (const sh of scales)
    for (const sd of scales)
      for (const se of scales)
        for (const legs of legsOpts)
          for (const dividers of divOpts)
            for (const rounding of roundOpts) {
              const q: HybridParams = {
                ...p,
                heightMm: round(p.heightMm * sh, 10),
                depthMm: round(p.depthMm * sd, 10),
                extrusionMm: round(p.extrusionMm * se, 5),
                legs,
                dividers,
                rounding,
              };
              const grow = (a: number, b: number) => Math.abs(Math.log(b / a));
              const cost =
                grow(p.heightMm, q.heightMm) +
                grow(p.depthMm, q.depthMm) +
                grow(p.extrusionMm, q.extrusionMm) +
                (legs !== p.legs ? 0.12 * Math.abs(legs - p.legs) / 2 : 0) +
                (dividers !== p.dividers ? 0.08 : 0) +
                (rounding !== p.rounding ? 0.15 * (p.rounding - rounding) : 0);
              cands.push({ q, cost });
            }
  cands.sort((a, b) => a.cost - b.cost);
  let best: { q: HybridParams; score: number } | null = null;
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    if (best && c.cost >= best.score) break; // nothing cheaper left to find
    if (c.cost === 0) continue;
    yield ci / cands.length;
    const g = buildGeometry(c.q, d);
    if (!g.fits) continue;
    if (buildIssues(c.q, g, d, planPrint(g, pr), pr, c.q.type === 'folded-horn').some((i) => i.level === 'bad')) continue;
    let score = c.cost + 0.25 * g.warnings.length;
    const q = sealedQ(g);
    if (q !== null) score += q > 0.9 ? (q - 0.9) * 3 : q < 0.6 ? (0.6 - q) * 3 : q0 !== null ? Math.abs(q - q0) * 0.5 : 0;
    const fb = tuning(g);
    if (fb !== null && fb0 !== null) score += Math.abs(Math.log(fb / fb0)) * 1.5;
    if (!best || score < best.score) best = { q: c.q, score };
  }
  if (!best) return null;
  const changes: FitChange[] = [];
  const mm = (x: number) => `${Math.round(x)} mm`;
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  if (best.q.heightMm !== p.heightMm) changes.push({ label: 'Height', from: mm(p.heightMm), to: mm(best.q.heightMm) });
  if (best.q.depthMm !== p.depthMm) changes.push({ label: 'Depth', from: mm(p.depthMm), to: mm(best.q.depthMm) });
  if (best.q.extrusionMm !== p.extrusionMm) changes.push({ label: 'Width between plates', from: mm(p.extrusionMm), to: mm(best.q.extrusionMm) });
  if (best.q.legs !== p.legs) changes.push({ label: p.type === 'slot-port' ? 'Port folds' : 'Legs', from: `${p.legs}`, to: `${best.q.legs}` });
  if (best.q.dividers !== p.dividers) changes.push({ label: 'Plywood dividers', from: `${p.dividers}`, to: `${best.q.dividers}` });
  if (best.q.rounding !== p.rounding) changes.push({ label: 'Organic rounding', from: pct(p.rounding), to: pct(best.q.rounding) });
  return { params: best.q, changes };
}
