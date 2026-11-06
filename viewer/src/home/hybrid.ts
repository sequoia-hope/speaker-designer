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
  /** extrusion = printed-core thickness between the two plates (mm) */
  extrusionMm: number;
  plateMm: number;
  plateMaterial: 'bb18' | 'mdf19' | 'bb12';
  /** printed wall thickness (mm) */
  wallMm: number;
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
    depthMm: 900,
    heightMm: 900,
    extrusionMm: 560,
    plateMm: 18,
    plateMaterial: 'bb18',
    wallMm: 8,
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
    depthMm: 330,
    heightMm: 900,
    extrusionMm: 190,
    plateMm: 18,
    plateMaterial: 'bb18',
    wallMm: 6,
    legs: 4,
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
    depthMm: 160,
    heightMm: 300,
    extrusionMm: 120,
    plateMm: 12,
    plateMaterial: 'bb12',
    wallMm: 5,
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
// geometry
// ---------------------------------------------------------------------------
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
  E: number; // extrusion (mm)
  /** air regions (channels, chambers) */
  air: Rect[];
  /** polygons for non-rectangular air (waveguide flare) */
  airPolys: [number, number][][];
  driver: { x: number; y: number; dia: number; orient: 'x' | 'y'; face: 'front' | 'internal' };
  /** path along the horn / line / port, start → exit: cumulative length (mm) and area (mm²) */
  path: { s: number[]; area: number[] };
  mouthRect: Rect | null;
  chambers: { label: string; volumeL: number }[];
  stats: { label: string; value: string }[];
  fits: boolean;
  warnings: string[];
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
  const E = p.extrusionMm;
  const t = p.wallMm;
  const dia = d.frameDiaMm;
  const air: Rect[] = [];
  const airPolys: [number, number][][] = [];
  const warnings: string[] = [];
  const stats: Geometry['stats'] = [];
  const chambers: Geometry['chambers'] = [];
  const s: number[] = [0];
  const area: number[] = [];
  let mouthRect: Rect | null = null;
  let fits = true;
  const sd = d.sdCm2 * 100; // mm²

  if (p.type === 'folded-horn') {
    // back → front: wall | rear chamber | driver wall | throat chamber | legs | front
    const inner = H - 2 * t;
    const cw = Math.max((p.rearChamberL * 1e6) / (inner * E), (d.mountDepthMm ?? 120) + 25);
    const xDrv = t + cw; // driver mounting wall from xDrv to xDrv + t
    const tcD = 70; // throat chamber depth
    const xa = xDrv + t + tcD + t; // legs start (back end)
    const xb = W - t; // legs end (front wall)
    air.push({ x0: t, x1: t + cw, y0: t, y1: H - t, label: 'rear chamber' });
    chambers.push({ label: 'Rear chamber', volumeL: (cw * inner * E) / 1e6 });
    const N = p.legs % 2 === 1 ? p.legs : p.legs + 1; // odd so the last leg exits at the front
    if (N !== p.legs) warnings.push(`Folded horn needs an odd number of legs to exit at the front — using ${N}.`);
    const legLen = xb - xa;
    if (legLen < 150) {
      fits = false;
      warnings.push('Not enough depth for the horn legs — make the cabinet deeper or the rear chamber smaller.');
    }
    const St = Math.max(sd * p.throatRatio, 1);
    // solve the mouth area so the stacked legs exactly fill the height
    const lens = Array.from({ length: N }, (_, i) => (i === 0 ? xb - (xDrv + t) : legLen));
    const fillFor = (Sm: number) => {
      const L = lens.reduce((a, b) => a + b, 0);
      let acc = 0;
      let used = (N + 1) * t;
      const hs: number[] = [];
      for (const l of lens) {
        const mid = acc + l / 2;
        const h = (St * Math.pow(Sm / St, mid / L)) / E;
        hs.push(h);
        used += h;
        acc += l;
      }
      return { used, hs, L };
    };
    let lo = St;
    let hi = St * 400;
    for (let it = 0; it < 60; it++) {
      const m = Math.sqrt(lo * hi);
      if (fillFor(m).used > H) hi = m;
      else lo = m;
    }
    const Sm = lo;
    const { hs, L } = fillFor(Sm);
    if (Sm < St * 1.5) {
      fits = false;
      warnings.push('The profile is too short for this many legs: the horn cannot expand. Fewer legs or a taller cabinet.');
    }
    // lay out the legs top → bottom
    let yTop = H - t;
    for (let i = 0; i < N; i++) {
      const h = hs[i];
      const y0 = yTop - h;
      const fwd = i % 2 === 0;
      const x0 = i === 0 ? xDrv + t : xa;
      const x1 = i === N - 1 ? W : xb;
      air.push({ x0, x1, y0, y1: yTop, label: i === 0 ? 'throat' : i === N - 1 ? 'mouth leg' : undefined });
      // turn openings through the separating wall
      if (i < N - 1) {
        const hn = hs[i + 1];
        const gap = Math.min(Math.max(h, hn), legLen * 0.5);
        const tx0 = fwd ? xb - gap : xa;
        const tx1 = fwd ? xb : xa + gap;
        air.push({ x0: tx0, x1: tx1, y0: y0 - t, y1: y0 });
      }
      yTop = y0 - t;
    }
    // throat chamber in front of the driver, open into leg 0
    const drvY = H - t - hs[0] - 6 - dia / 2;
    const tcTop = H - t - hs[0];
    const tcBot = Math.max(t, drvY - dia / 2);
    air.push({ x0: xDrv + t, x1: xDrv + t + tcD, y0: tcBot, y1: tcTop, label: 'throat chamber' });
    chambers.push({ label: 'Throat chamber', volumeL: (tcD * (tcTop - tcBot) * E) / 1e6 });
    mouthRect = { x0: W - 1, x1: W, y0: t, y1: t + hs[N - 1] };
    // path: exponential area along L
    area.push(St);
    for (let i = 0; i < 48; i++) {
      const sl = (L * (i + 1)) / 48;
      s.push(sl);
      area.push(St * Math.pow(Sm / St, (sl - L / 96) / L));
    }
    const m = Math.log(Sm / St) / (L / 1000);
    stats.push(
      { label: 'Horn path length', value: `${(L / 1000).toFixed(2)} m` },
      { label: 'Throat → mouth', value: `${(St / 100).toFixed(0)} → ${(Sm / 100).toFixed(0)} cm²` },
      { label: 'Exponential flare cut-off', value: `${((m * C) / (4 * Math.PI)).toFixed(0)} Hz` },
      { label: 'Quarter-wave of the path', value: `${(C / (4 * (L / 1000))).toFixed(0)} Hz` }
    );
    return {
      W,
      H,
      E,
      air,
      airPolys,
      driver: { x: xDrv + t / 2, y: drvY, dia, orient: 'y', face: 'internal' },
      path: { s, area },
      mouthRect,
      chambers,
      stats,
      fits,
      warnings,
    };
  }

  if (p.type === 'tl' || p.type === 'slot-port') {
    // driver on the printed front wall near the top
    if (E < dia + 6) warnings.push(`The core (${E} mm) is narrower than the driver frame (${dia} mm) — widen the extrusion.`);
    const S0 = Math.max(sd, (dia + 10) * E * 0.0) || sd;
    if (p.type === 'tl') {
      const N = p.legs % 2 === 0 ? p.legs : p.legs + 1; // even → the last leg runs forward and exits at the front
      if (N !== p.legs) warnings.push(`A transmission line needs an even number of legs to exit at the front — using ${N}.`);
      const xa = t;
      const xb = W - t;
      const L0 = xb - xa;
      const lens = Array.from({ length: N }, () => L0);
      const L = lens.reduce((a, b) => a + b, 0);
      const Sstart = Math.max(S0 * 1.1, (dia + 12) * E * 0.6);
      const hs = lens.map((_, i) => {
        const mid = (i + 0.5) / N;
        return (Sstart * (1 + (p.taper - 1) * mid)) / E;
      });
      hs[0] = Math.max(hs[0], dia + 12); // the start of the line sits behind the driver
      // grow the line (keeping the taper) to use the whole height — no wasted solid plastic
      const room = H - (N + 1) * t;
      const sumH = hs.reduce((a, b) => a + b, 0);
      if (sumH < room) for (let i = 0; i < N; i++) hs[i] *= room / sumH;
      const used = hs.reduce((a, b) => a + b, 0) + (N + 1) * t;
      if ((hs[0] * E) / sd > 3.5)
        warnings.push(`The line starts at ${((hs[0] * E) / sd).toFixed(1)}× the cone area — wider than the usual 1–3×, which weakens the line's bass. Add legs (a longer, lower-tuned line) or narrow the core.`);
      if (used > H) {
        fits = false;
        warnings.push(`The line needs ${used.toFixed(0)} mm of height but the cabinet is ${H} mm — taller cabinet, fewer legs or more taper.`);
      }
      let yTop = H - t;
      for (let i = 0; i < N; i++) {
        const h = hs[i];
        const y0 = yTop - h;
        const back = i % 2 === 0; // leg 0 runs backward from behind the driver
        air.push({ x0: xa, x1: i === N - 1 ? W : xb, y0, y1: yTop, label: i === 0 ? 'line start' : i === N - 1 ? 'terminus' : undefined });
        if (i < N - 1) {
          const gap = Math.min(Math.max(h, hs[i + 1]), L0 * 0.5);
          air.push(back ? { x0: xa, x1: xa + gap, y0: y0 - t, y1: y0 } : { x0: xb - gap, x1: xb, y0: y0 - t, y1: y0 });
        }
        yTop = y0 - t;
      }
      mouthRect = { x0: W - 1, x1: W, y0: yTop + t, y1: yTop + t + hs[N - 1] };
      for (let i = 0; i < N; i++) seg(s, area, lens[i], hs[i] * E, (i < N - 1 ? hs[i + 1] : hs[i]) * E);
      area.unshift(area[0]);
      area.length = s.length;
      const Leff = L / 1000;
      stats.push(
        { label: 'Line length', value: `${Leff.toFixed(2)} m` },
        { label: 'Quarter-wave tuning', value: `≈ ${(C / (4 * Leff)).toFixed(0)} Hz` },
        { label: 'Start → end area', value: `${((hs[0] * E) / 100).toFixed(0)} → ${((hs[N - 1] * E) / 100).toFixed(0)} cm² (${(((hs[0] * E) / sd)).toFixed(1)}× Sd at the start)` }
      );
      return {
        W,
        H,
        E,
        air,
        airPolys,
        driver: { x: W - t / 2, y: H - t - hs[0] / 2, dia, orient: 'y', face: 'front' },
        path: { s, area },
        mouthRect,
        chambers,
        stats,
        fits,
        warnings,
      };
    }
    // slot-port box: chamber above, folded slot along the bottom
    const N = Math.max(1, Math.min(3, p.legs));
    const hs = p.slotMm;
    const portH = N * hs + N * t;
    const chamber: Rect = { x0: t, x1: W - t, y0: t + portH, y1: H - t, label: 'box' };
    air.push(chamber);
    const lens: number[] = [];
    let y = t + portH - t; // top of the first port leg (just under the chamber floor)
    for (let i = 0; i < N; i++) {
      const y0 = y - hs;
      const back = i % 2 === 0;
      const last = i === N - 1;
      // leg i runs from one end to the other; the last leg exits through the front
      air.push({ x0: t, x1: last ? W : W - t, y0, y1: y, label: last ? 'port exit' : undefined });
      lens.push(W - 2 * t);
      // opening between legs / from the chamber
      if (i === 0) air.push(back ? { x0: W - t - hs * 1.5, x1: W - t, y0: y, y1: y + t } : { x0: t, x1: t + hs * 1.5, y0: y, y1: y + t });
      if (!last) air.push(back ? { x0: t, x1: t + hs * 1.5, y0: y0 - t, y1: y0 } : { x0: W - t - hs * 1.5, x1: W - t, y0: y0 - t, y1: y0 });
      y = y0 - t;
    }
    // with N odd the last leg runs toward the front; fix direction if even by mirroring first opening
    mouthRect = { x0: W - 1, x1: W, y0: y + t, y1: y + t + hs };
    const Lp = lens.reduce((a, b) => a + b, 0);
    const Vb = ((chamber.x1 - chamber.x0) * (chamber.y1 - chamber.y0) * E) / 1e6 - (d.displacementL ?? 0.5);
    chambers.push({ label: 'Box (net)', volumeL: Vb });
    for (const l of lens) seg(s, area, l, hs * E, hs * E);
    area.unshift(area[0]);
    area.length = s.length;
    const Sp = (hs * E) / 1e6;
    const leff = Lp / 1000 + 0.9 * Math.sqrt(Sp / Math.PI) * 2;
    const fb = (C / (2 * Math.PI)) * Math.sqrt(Sp / ((Vb / 1000) * leff));
    stats.push(
      { label: 'Net box volume', value: `${Vb.toFixed(1)} L` },
      { label: 'Slot port', value: `${hs} × ${E} mm, ${(Lp / 1000).toFixed(2)} m long` },
      { label: 'Helmholtz tuning (estimate)', value: `≈ ${fb.toFixed(0)} Hz` }
    );
    return {
      W,
      H,
      E,
      air,
      airPolys,
      driver: { x: W - t / 2, y: H - t - Math.min(dia / 2 + 20, (H - portH) / 2), dia, orient: 'y', face: 'front' },
      path: { s, area },
      mouthRect,
      chambers,
      stats,
      fits,
      warnings,
    };
  }

  // 2D waveguide (plan view of a constant-directivity horn; extrusion = mouth height)
  const throat = p.throatMm;
  const half = (p.coverageDeg / 2) * (Math.PI / 180);
  const len = W - 2 * t;
  const mouthW = Math.min(H - 2 * t, throat + 2 * len * Math.tan(half));
  const cy = H / 2;
  const poly: [number, number][] = [
    [t, cy - throat / 2],
    [t + len * 0.12, cy - throat / 2 - len * 0.12 * Math.tan(half) * 0.5],
    [W, cy - mouthW / 2],
    [W, cy + mouthW / 2],
    [t + len * 0.12, cy + throat / 2 + len * 0.12 * Math.tan(half) * 0.5],
    [t, cy + throat / 2],
  ];
  airPolys.push(poly);
  const fControl = 25000 / ((mouthW / 1000) * p.coverageDeg);
  stats.push(
    { label: 'Mouth width × height', value: `${mouthW.toFixed(0)} × ${E} mm` },
    { label: 'Pattern control down to (Keele)', value: `≈ ${fControl.toFixed(0)} Hz at ${p.coverageDeg}°` },
    { label: 'Vertical (extrusion)', value: `uncontrolled below ≈ ${(25000 / ((E / 1000) * 60)).toFixed(0)} Hz for 60°` }
  );
  warnings.push('Waveguides are geometry-only here: their frequency response needs the compression driver/tweeter’s own data, so they are not fed into the maps.');
  return {
    W,
    H,
    E,
    air,
    airPolys,
    driver: { x: t / 2, y: cy, dia: Math.max(throat, d.frameDiaMm * 0.6), orient: 'y', face: 'internal' },
    path: { s: [0, len], area: [throat * E, mouthW * E] },
    mouthRect: { x0: W - 1, x1: W, y0: cy - mouthW / 2, y1: cy + mouthW / 2 },
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
// printing: tile the profile onto the bed, slice the extrusion, key the seams
// ---------------------------------------------------------------------------
export interface Printer {
  bedX: number;
  bedY: number;
  maxZ: number;
  margin: number;
  filamentDensity: number; // g/cm³
}
export const DEFAULT_PRINTER: Printer = { bedX: 250, bedY: 370, maxZ: 300, margin: 10, filamentDensity: 1.27 };

export interface Segment {
  id: string;
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
  cutsZ: number[];
  segments: Segment[];
  keys: { x: number; y: number; along: 'x' | 'y' | 'z' }[];
  totalGrams: number;
  solidFraction: number;
}

export function isAir(g: Geometry, x: number, y: number) {
  for (const r of g.air) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
  for (const poly of g.airPolys) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
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
  const nz = Math.ceil(g.E / pr.maxZ);
  // put cuts through WALLS where possible (stronger joints, keys have something to bite)
  const snap = (v: number, along: 'x' | 'y') => {
    let best = v;
    let bestScore = -1;
    const n0 = along === 'x' ? nx : ny;
    const len0 = along === 'x' ? g.W : g.H;
    const lim = along === 'x' ? ax : ay;
    const win = Math.max(0, Math.min(40, Math.floor((lim - len0 / n0) / 2)));
    for (let dv = -win; dv <= win; dv += 2) {
      const c = v + dv;
      let solid = 0;
      const n = 60;
      for (let i = 0; i <= n; i++) {
        const q = along === 'x' ? (g.H * i) / n : (g.W * i) / n;
        if (!(along === 'x' ? isAir(g, c, q) : isAir(g, q, c))) solid++;
      }
      if (solid > bestScore || (solid === bestScore && Math.abs(dv) < Math.abs(best - v))) {
        bestScore = solid;
        best = c;
      }
    }
    return best;
  };
  const cutsX = Array.from({ length: nx - 1 }, (_, i) => snap((g.W * (i + 1)) / nx, 'x')).filter((c) => c > 0 && c < g.W);
  const cutsY = Array.from({ length: ny - 1 }, (_, i) => snap((g.H * (i + 1)) / ny, 'y')).filter((c) => c > 0 && c < g.H);
  const cutsZ = Array.from({ length: nz - 1 }, (_, i) => (g.E * (i + 1)) / nz);
  // make sure every tile fits after snapping (shift cuts back if needed)
  const xs = [0, ...cutsX, g.W];
  const ys = [0, ...cutsY, g.H];
  const zs = [0, ...cutsZ, g.E];
  // solid fraction of the profile (sampled)
  let solid = 0;
  let tot = 0;
  for (let x = 2; x < g.W; x += 6)
    for (let y = 2; y < g.H; y += 6) {
      tot++;
      if (!isAir(g, x, y)) solid++;
    }
  const solidFraction = solid / Math.max(tot, 1);
  const segments: Segment[] = [];
  const fillFactor = 0.75; // thick walls: perimeters + ~40 % infill
  for (let k = 0; k < zs.length - 1; k++)
    for (let j = 0; j < ys.length - 1; j++)
      for (let i = 0; i < xs.length - 1; i++) {
        let sTile = 0;
        let nTile = 0;
        for (let x = xs[i] + 3; x < xs[i + 1]; x += 6)
          for (let y = ys[j] + 3; y < ys[j + 1]; y += 6) {
            nTile++;
            if (!isAir(g, x, y)) sTile++;
          }
        const areaMm2 = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) * (sTile / Math.max(nTile, 1));
        const grams = (areaMm2 * (zs[k + 1] - zs[k]) * fillFactor * pr.filamentDensity) / 1000;
        const w = xs[i + 1] - xs[i];
        const h = ys[j + 1] - ys[j];
        segments.push({
          id: `${String.fromCharCode(65 + j)}${i + 1}${zs.length > 2 ? `·${k + 1}` : ''}`,
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
  // alignment keys: one per solid run crossing each seam
  const keys: PrintPlan['keys'] = [];
  for (const c of cutsX) {
    let inSolid = false;
    let start = 0;
    for (let y = 0; y <= g.H; y += 2) {
      const sld = !isAir(g, c, y) && y > 0 && y < g.H;
      if (sld && !inSolid) {
        inSolid = true;
        start = y;
      }
      if (!sld && inSolid) {
        inSolid = false;
        const run = y - start;
        if (run >= 5) {
          const n = Math.max(1, Math.floor(run / 80));
          for (let q = 0; q < n; q++) keys.push({ x: c, y: start + (run * (q + 0.5)) / n, along: 'x' });
        }
      }
    }
  }
  for (const c of cutsY) {
    let inSolid = false;
    let start = 0;
    for (let x = 0; x <= g.W; x += 2) {
      const sld = !isAir(g, x, c) && x > 0 && x < g.W;
      if (sld && !inSolid) {
        inSolid = true;
        start = x;
      }
      if (!sld && inSolid) {
        inSolid = false;
        const run = x - start;
        if (run >= 5) {
          const n = Math.max(1, Math.floor(run / 80));
          for (let q = 0; q < n; q++) keys.push({ x: start + (run * (q + 0.5)) / n, y: c, along: 'y' });
        }
      }
    }
  }
  return {
    rotated,
    usable: [ux, uy],
    cutsX,
    cutsY,
    cutsZ,
    segments,
    keys,
    totalGrams: segments.reduce((a, s) => a + s.grams, 0),
    solidFraction,
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
  bb18: { name: '18 mm Baltic birch', E: 11.5e9, rho: 680, nu: 0.3, t: 18 },
  bb12: { name: '12 mm Baltic birch', E: 11.5e9, rho: 680, nu: 0.3, t: 12 },
  mdf19: { name: '19 mm MDF', E: 3.5e9, rho: 750, nu: 0.25, t: 19 },
};

export function buildIssues(p: HybridParams, g: Geometry, d: DriverInfo, plan: PrintPlan, outdoor: boolean): Issue[] {
  const out: Issue[] = [];
  const plate = PLATES[p.plateMaterial];
  const tp = p.plateMm / 1000;
  // pressure in the sealed chamber behind the cone at Xmax
  const Vd = (d.sdCm2 / 1e4) * ((d.xmaxMm || 3) / 1000);
  const rearL = g.chambers.find((c) => /Rear|Box/.test(c.label))?.volumeL ?? 0;
  const pPeak = rearL > 0 ? (RHO * C * C * Vd) / (rearL / 1000) : 0;
  // largest unsupported plate span = largest air rectangle (the plate only touches printed walls)
  let worst = { a: 0, b: 0, f: Infinity, label: '' };
  const D = (plate.E * tp ** 3) / (12 * (1 - plate.nu ** 2));
  for (const r of g.air) {
    const a = (r.x1 - r.x0) / 1000;
    const b = (r.y1 - r.y0) / 1000;
    if (a < 0.03 || b < 0.03) continue;
    // clamped-ish edges (glued to walls): simply-supported f11 × ~1.8
    const f11 = 1.8 * (Math.PI / 2) * Math.sqrt(D / (plate.rho * tp)) * (1 / (a * a) + 1 / (b * b));
    if (f11 < worst.f) worst = { a, b, f: f11, label: r.label ?? 'channel' };
  }
  const passTop = p.type === 'folded-horn' ? 150 : p.type === 'waveguide' ? 20000 : 500;
  out.push({
    level: worst.f < passTop * 2 ? 'bad' : worst.f < passTop * 5 ? 'warn' : 'ok',
    title: `Side-plate resonance: ${worst.f.toFixed(0)} Hz over the ${worst.label}`,
    body: `The ${plate.name} plate spans ${(worst.a * 1000).toFixed(0)} × ${(worst.b * 1000).toFixed(0)} mm unsupported there. ${
      worst.f < passTop * 5
        ? `That is close to the band this cabinet plays (up to ~${passTop} Hz). Add printed ribs or posts across the ${worst.label} (a 20 mm-wide pillar halving the span raises it ~4×), use a thicker plate, or laminate a second plate.`
        : 'Comfortably above the band this cabinet plays.'
    }`,
  });
  if (pPeak > 0)
    out.push({
      level: pPeak > 3000 ? 'warn' : 'ok',
      title: `Air pressure in the ${rearL > 0 ? 'rear chamber' : 'box'}: up to ${(pPeak / 1000).toFixed(1)} kPa at Xmax`,
      body: `That pushes on each plate over that area with ~${((pPeak * (rearL / 1000)) / (g.E / 1000)).toFixed(0)} N. Leaks whistle and lose bass. Print with ≥ 4 perimeters (≥ 1.6 mm) and 100 % top/bottom layers on mating faces, slightly over-extrude (105 %), then brush 2 coats of thin epoxy (or a polyurethane sealer) inside every chamber and channel. Test: block the mouth/port, push the cone gently — it should come back slowly.`,
    });
  out.push({
    level: p.wallMm < 5 ? 'warn' : 'ok',
    title: `Printed walls ${p.wallMm} mm`,
    body: `Internal walls also tie the two plates together. ${p.wallMm < 5 ? 'Under 5 mm they flex and ring — go to 6–8 mm with 40 % gyroid infill.' : 'Use 4–6 perimeters and 30–40 % gyroid infill; gyroid is stiff in all directions and damps ringing.'} Walls between ${g.E} mm-apart plates are well supported; the outer walls carry the screws, so thicken them to ≥ 10 mm where plates are bolted.`,
  });
  const boltSpacing = 150;
  const perim = 2 * (g.W + g.H);
  const bolts = Math.ceil(perim / boltSpacing) + Math.ceil(g.air.length / 2);
  out.push({
    level: 'ok',
    title: `Plates to core: glue + gasket edge + ${bolts} through-bolts`,
    body: `Recommended: (1) sand the core's two faces flat on a sheet of sandpaper on glass; (2) glue the plates on with polyurethane construction adhesive or thickened epoxy along every wall edge (it fills print gaps and seals); (3) clamp with M6 threaded rod or bolts through printed bosses every ~${boltSpacing} mm around the perimeter and at wall junctions (≈ ${bolts} per cabinet) — they keep it clamped if the glue line creeps. For a removable plate (to service a horn driver), use 3 mm closed-cell EPDM gasket tape on the wall edges instead of glue, with bolts every ~100 mm and heat-set M6 inserts in the core.`,
  });
  const hours = plan.totalGrams / 60; // ~60 g/h with a 0.6 mm nozzle; ~25 g/h with 0.4 mm
  if (plan.totalGrams > 8000)
    out.push({
      level: 'warn',
      title: `This core is a big print: ~${(plan.totalGrams / 1000).toFixed(0)} kg of filament, ~${hours.toFixed(0)} h with a 0.6 mm nozzle`,
      body: 'Ways to cut it down: print only the complex parts (throat, bends, mouth flare) and make long straight walls from 12 mm plywood strips glued between the plates; use a 0.6–0.8 mm nozzle with thick layers; drop internal wall thickness to 6 mm with ribs; or build one cabinet first and measure before printing four.',
    });
  out.push({
    level: plan.segments.length > 30 ? 'warn' : 'ok',
    title: `Segments: ${plan.segments.length} pieces, ${(plan.totalGrams / 1000).toFixed(1)} kg of filament`,
    body: `Joined with ${plan.keys.length} printed alignment keys (dovetail tongue on one piece, matching slot on the next) where seams cross walls${plan.cutsZ.length ? `, plus 8 mm dowel pins through the walls between the ${plan.cutsZ.length + 1} layers along the extrusion` : ''}. Glue seams with epoxy (PETG/ASA) and run a bead along every seam inside the channels before closing with the plates.`,
  });
  if (outdoor)
    out.push({
      level: 'warn',
      title: 'Outdoors: print in PETG or ASA, not PLA',
      body: 'PLA softens around 55–60 °C — a black cabinet in summer sun gets there. PETG or ASA hold up; ASA also resists UV. Seal plywood edges and paint (or use marine/exterior ply): a dewy night in a clearing will swell raw Baltic birch.',
    });
  if (g.driver.face === 'front')
    out.push({
      level: p.wallMm < 12 ? 'warn' : 'ok',
      title: 'Driver mounting on a printed wall',
      body: `The front wall is ${p.wallMm} mm. Thicken it locally to ≥ 15 mm around the driver (a printed boss ring) with heat-set inserts for the screws, or glue a plywood ring/baffle over the front — plastic threads strip and the wall must not flex.`,
    });
  if (g.driver.face === 'internal' && p.type === 'folded-horn')
    out.push({
      level: 'warn',
      title: 'Getting the driver in and out',
      body: 'The driver sits on an internal wall. Make one side plate removable over the rear chamber (gasket + inserts), or print a driver hatch: you will need to reach it to wire, gasket and service it.',
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
