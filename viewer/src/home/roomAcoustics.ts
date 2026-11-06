// Living-room acoustics: rectangular-room modal model, placement geometry,
// first-reflection points and speaker-boundary interference.
//
// Coordinate frame (all metres):
//   x = across the room (0 = left wall, W = right wall, as seen from the seat)
//   y = depth from the FRONT wall (the wall the speakers stand in front of)
//   z = height above the floor
//
// The modal model is the textbook rigid-wall rectangular-room Green's function
// (Kuttruff, "Room Acoustics", ch. 3) with a single modal damping constant
// derived from the room's reverberation time. It is physically meaningful below
// the Schroeder frequency (~150–250 Hz in a living room), which is exactly the
// band where placement matters most. Above that, the room behaves statistically
// and the curves here are not intended to be read.

export const SPEED_OF_SOUND = 343.2; // m/s at 20 °C

export const FT = 0.3048;
export const IN = 0.0254;

export interface RoomConfig {
  widthM: number; // across, left-right (front wall length)
  depthM: number; // front wall → back wall
  heightM: number;
  rt60S: number; // mid/low reverberation time
}

export interface PlacementConfig {
  /** distance from the front wall to the speaker's front baffle (m) */
  speakerFrontDistM: number;
  /** centre-to-centre spacing between L and R (m) */
  speakerSpacingM: number;
  /** woofer acoustic centre height (m) */
  wooferHeightM: number;
  /** listener head distance from the front wall (m) */
  listenerDistM: number;
  /** listener ear height (m) */
  earHeightM: number;
  /** where the speaker axes cross, metres in FRONT of the listener's head (0 = aimed at head) */
  toeCrossAheadM: number;
}

export interface SubConfig {
  count: 0 | 1 | 2 | 4;
  layout: 'front-corners' | 'front-wall-mid' | 'front-back-mid' | 'four-midwalls';
  crossoverHz: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RoomMode {
  n: [number, number, number];
  freqHz: number;
  kind: 'axial' | 'tangential' | 'oblique';
}

export interface Complex {
  re: number;
  im: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function speakerPositions(room: RoomConfig, p: PlacementConfig): { L: Vec3; R: Vec3 } {
  const cx = room.widthM / 2;
  return {
    L: { x: cx - p.speakerSpacingM / 2, y: p.speakerFrontDistM, z: p.wooferHeightM },
    R: { x: cx + p.speakerSpacingM / 2, y: p.speakerFrontDistM, z: p.wooferHeightM },
  };
}

export function listenerPosition(room: RoomConfig, p: PlacementConfig): Vec3 {
  return { x: room.widthM / 2, y: p.listenerDistM, z: p.earHeightM };
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Toe-in angle (degrees) so each speaker's axis crosses `toeCrossAheadM` in front of the head. */
export function toeInDeg(p: PlacementConfig): number {
  const aimY = p.listenerDistM - p.toeCrossAheadM - p.speakerFrontDistM;
  if (aimY <= 0.01) return 90;
  return (Math.atan2(p.speakerSpacingM / 2, aimY) * 180) / Math.PI;
}

/** Angle subtended at the listener between the two speakers (60° = equilateral triangle). */
export function stereoAngleDeg(p: PlacementConfig): number {
  const d = p.listenerDistM - p.speakerFrontDistM;
  return (2 * Math.atan2(p.speakerSpacingM / 2, Math.max(d, 0.01)) * 180) / Math.PI;
}

export interface ReflectionPoint {
  surface: 'left wall' | 'right wall' | 'ceiling' | 'floor' | 'front wall';
  speaker: 'L' | 'R';
  /** position on the surface (m) — for side walls: y (depth) & z; ceiling/floor: x & y */
  at: Vec3;
  extraPathM: number;
  delayMs: number;
}

/** Mirror-image first reflections for both speakers to the listener. */
export function firstReflections(room: RoomConfig, p: PlacementConfig): ReflectionPoint[] {
  const { L, R } = speakerPositions(room, p);
  const ear = listenerPosition(room, p);
  const out: ReflectionPoint[] = [];
  const add = (
    speaker: 'L' | 'R',
    s: Vec3,
    surface: ReflectionPoint['surface'],
    image: Vec3,
    onSurface: (t: number) => Vec3
  ) => {
    const direct = dist(s, ear);
    const reflected = dist(image, ear);
    // parametric point where the line image→ear crosses the plane
    const at = onSurface(0);
    out.push({
      surface,
      speaker,
      at,
      extraPathM: reflected - direct,
      delayMs: ((reflected - direct) / SPEED_OF_SOUND) * 1000,
    });
  };
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  });
  for (const [name, s] of [
    ['L', L],
    ['R', R],
  ] as const) {
    // Side wall nearest each speaker is the one that matters most, but we report both.
    const imgLeft = { ...s, x: -s.x };
    add(name, s, 'left wall', imgLeft, () => lerp(imgLeft, ear, (0 - imgLeft.x) / (ear.x - imgLeft.x)));
    const imgRight = { ...s, x: 2 * room.widthM - s.x };
    add(name, s, 'right wall', imgRight, () =>
      lerp(imgRight, ear, (room.widthM - imgRight.x) / (ear.x - imgRight.x))
    );
    const imgCeil = { ...s, z: 2 * room.heightM - s.z };
    add(name, s, 'ceiling', imgCeil, () => lerp(imgCeil, ear, (room.heightM - imgCeil.z) / (ear.z - imgCeil.z)));
    const imgFloor = { ...s, z: -s.z };
    add(name, s, 'floor', imgFloor, () => lerp(imgFloor, ear, (0 - imgFloor.z) / (ear.z - imgFloor.z)));
    const imgFront = { ...s, y: -s.y };
    add(name, s, 'front wall', imgFront, () => lerp(imgFront, ear, (0 - imgFront.y) / (ear.y - imgFront.y)));
  }
  return out;
}

/**
 * Speaker-boundary interference: a wall at distance d behind a (omnidirectional at
 * low frequency) woofer produces a first cancellation notch at c / (4 d).
 */
export function sbirNotchHz(distanceToBoundaryM: number): number {
  return SPEED_OF_SOUND / (4 * Math.max(distanceToBoundaryM, 0.01));
}

// ---------------------------------------------------------------------------
// Room modes
// ---------------------------------------------------------------------------

export function roomModes(room: RoomConfig, fMaxHz: number): RoomMode[] {
  const c = SPEED_OF_SOUND;
  const { widthM: Lx, depthM: Ly, heightM: Lz } = room;
  const nxMax = Math.ceil((2 * fMaxHz * Lx) / c);
  const nyMax = Math.ceil((2 * fMaxHz * Ly) / c);
  const nzMax = Math.ceil((2 * fMaxHz * Lz) / c);
  const modes: RoomMode[] = [];
  for (let nx = 0; nx <= nxMax; nx++) {
    for (let ny = 0; ny <= nyMax; ny++) {
      for (let nz = 0; nz <= nzMax; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const f = (c / 2) * Math.sqrt((nx / Lx) ** 2 + (ny / Ly) ** 2 + (nz / Lz) ** 2);
        if (f > fMaxHz) continue;
        const nonzero = (nx > 0 ? 1 : 0) + (ny > 0 ? 1 : 0) + (nz > 0 ? 1 : 0);
        modes.push({
          n: [nx, ny, nz],
          freqHz: f,
          kind: nonzero === 1 ? 'axial' : nonzero === 2 ? 'tangential' : 'oblique',
        });
      }
    }
  }
  modes.sort((a, b) => a.freqHz - b.freqHz);
  return modes;
}

/** Schroeder frequency: above this, modes overlap and the room is "statistical". */
export function schroederHz(room: RoomConfig): number {
  const V = room.widthM * room.depthM * room.heightM;
  return 2000 * Math.sqrt(room.rt60S / V);
}

// ---------------------------------------------------------------------------
// Source models
// ---------------------------------------------------------------------------

export type BoxAlignment =
  | { kind: 'sealed'; fcHz: number; qtc: number }
  | { kind: 'vented'; fsHz: number; fbHz: number; qts: number; alpha: number; ql: number }
  | { kind: 'flat' }
  /** any simulated response (e.g. a printed transmission line), → 1 well above cutoff */
  | { kind: 'custom'; fn: (fHz: number) => Complex };

/** Normalised in-box acoustic transfer function (pressure, half-space, → 1 well above cutoff). */
export function boxResponse(a: BoxAlignment, fHz: number): Complex {
  if (a.kind === 'flat') return { re: 1, im: 0 };
  if (a.kind === 'custom') return a.fn(fHz);
  if (a.kind === 'sealed') {
    // H = s² / (s² + s/Q + 1), s = j f/fc
    const w = fHz / a.fcHz;
    const num = { re: -w * w, im: 0 };
    const den = { re: 1 - w * w, im: w / a.qtc };
    return cdiv(num, den);
  }
  // Small (1973) vented-box response with enclosure losses Q_L.
  const h = a.fbHz / a.fsHz;
  const T0w = fHz / Math.sqrt(a.fsHz * a.fbHz);
  const Qt = a.qts;
  const Ql = a.ql;
  const sqh = Math.sqrt(h);
  const a1 = (Ql + h * Qt) / (sqh * Ql * Qt);
  const a2 = (h + (a.alpha + 1 + h * h) * Ql * Qt) / (h * Ql * Qt);
  const a3 = (h * Ql + Qt) / (sqh * Ql * Qt);
  // s = j w : s² = -w², s³ = -j w³, s⁴ = w⁴
  const w = T0w;
  const num = { re: w ** 4, im: 0 };
  const den = { re: w ** 4 - a2 * w * w + 1, im: -a1 * w ** 3 + a3 * w };
  return cdiv(num, den);
}

/** 4th-order Linkwitz-Riley low/high pass (complex), used for sub crossovers. */
export function lr4(fHz: number, fcHz: number, type: 'lp' | 'hp'): Complex {
  // LR4 = (BW2)²; BW2: Q = 1/√2
  const w = fHz / fcHz;
  const q = Math.SQRT1_2;
  const den = { re: 1 - w * w, im: w / q };
  const num = type === 'lp' ? { re: 1, im: 0 } : { re: -w * w, im: 0 };
  const bw2 = cdiv(num, den);
  return cmul(bw2, bw2);
}

// ---------------------------------------------------------------------------
// Modal pressure response
// ---------------------------------------------------------------------------

export interface ModalSource {
  pos: Vec3;
  /** complex drive (box response × crossover × gain), function of frequency */
  drive: (fHz: number) => Complex;
}

export interface ModalEngine {
  freqs: number[];
  /** complex pressure, relative to the free-field pressure of ONE speaker at `refDistM` */
  responseAt: (r: Vec3) => Complex[];
}

/**
 * Builds the modal engine for a fixed set of sources. Per-mode source coupling
 * is precomputed so evaluating many receiver positions (seat heat-map) is cheap.
 */
export function buildModalEngine(
  room: RoomConfig,
  sources: ModalSource[],
  freqs: number[],
  refDistM: number
): ModalEngine {
  const c = SPEED_OF_SOUND;
  const fMax = freqs[freqs.length - 1];
  // include modes well above the band so the residual (stiffness-like) tail converges
  const modes = roomModes(room, Math.max(fMax * 2.2, 300));
  const { widthM: Lx, depthM: Ly, heightM: Lz } = room;
  const V = Lx * Ly * Lz;
  const delta = (3 * Math.LN10) / room.rt60S; // amplitude decay constant, 1/s

  // all modes incl. (0,0,0)
  const allN: [number, number, number][] = [[0, 0, 0], ...modes.map((m) => m.n)];
  const allW = [0, ...modes.map((m) => 2 * Math.PI * m.freqHz)];
  const nModes = allN.length;
  const norm = allN.map(([a, b, d]) => (a ? 0.5 : 1) * (b ? 0.5 : 1) * (d ? 0.5 : 1));

  const psi = (n: [number, number, number], p: Vec3) =>
    Math.cos((n[0] * Math.PI * p.x) / Lx) *
    Math.cos((n[1] * Math.PI * p.y) / Ly) *
    Math.cos((n[2] * Math.PI * p.z) / Lz);

  // A[f][m] = Σ_sources drive_s(f) ψ_m(s) / (Λ_m (ω_m² − ω² + 2jδω))   (complex)
  //
  // Pressure from a point source of volume velocity Q:  p = jωρc² Q/V · Σ ψψ/(Λ(...)).
  // A speaker that is "flat" in free field has Q = H(ω)·4π r_ref p_ref /(jωρ),
  // so p_room / p_free(r_ref) = 4π r_ref c² / V · Σ H ψψ / (Λ(...)).
  const scale = (4 * Math.PI * refDistM * c * c) / V;
  const Are = new Float64Array(freqs.length * nModes);
  const Aim = new Float64Array(freqs.length * nModes);
  const srcPsi = sources.map((s) => allN.map((n) => psi(n, s.pos)));
  freqs.forEach((f, fi) => {
    const w = 2 * Math.PI * f;
    const drives = sources.map((s) => s.drive(f));
    for (let m = 0; m < nModes; m++) {
      let sre = 0;
      let sim = 0;
      for (let si = 0; si < sources.length; si++) {
        const p = srcPsi[si][m];
        sre += drives[si].re * p;
        sim += drives[si].im * p;
      }
      const dre = norm[m] * (allW[m] * allW[m] - w * w);
      const dim = norm[m] * (2 * delta * w);
      const q = cdiv({ re: sre, im: sim }, { re: dre, im: dim });
      Are[fi * nModes + m] = q.re * scale;
      Aim[fi * nModes + m] = q.im * scale;
    }
  });

  return {
    freqs,
    responseAt(r: Vec3) {
      const rp = allN.map((n) => psi(n, r));
      return freqs.map((_, fi) => {
        let re = 0;
        let im = 0;
        const base = fi * nModes;
        for (let m = 0; m < nModes; m++) {
          re += Are[base + m] * rp[m];
          im += Aim[base + m] * rp[m];
        }
        return { re, im };
      });
    },
  };
}

export function logFreqs(f0: number, f1: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(f0 * Math.pow(f1 / f0, i / (n - 1)));
  return out;
}

export function toDb(c: Complex): number {
  return 20 * Math.log10(Math.max(Math.hypot(c.re, c.im), 1e-9));
}

/** Standard deviation (dB) of a response over a band — lower = smoother bass. */
export function bandStdDb(freqs: number[], resp: Complex[], f0: number, f1: number): number {
  const vals: number[] = [];
  freqs.forEach((f, i) => {
    if (f >= f0 && f <= f1) vals.push(toDb(resp[i]));
  });
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

export function subPositions(room: RoomConfig, sub: SubConfig): Vec3[] {
  const W = room.widthM;
  const D = room.depthM;
  const z = 0.25; // woofer centre of a typical floor-standing sub
  const inset = 0.3;
  if (sub.count === 0) return [];
  switch (sub.layout) {
    case 'front-corners': {
      const both = [
        { x: inset, y: inset, z },
        { x: W - inset, y: inset, z },
      ];
      return sub.count === 1 ? [both[0]] : sub.count === 2 ? both : [...both, { x: inset, y: D - inset, z }, { x: W - inset, y: D - inset, z }];
    }
    case 'front-wall-mid':
      return sub.count === 1
        ? [{ x: W / 2, y: inset, z }]
        : [
            { x: W / 4, y: inset, z },
            { x: (3 * W) / 4, y: inset, z },
          ].slice(0, Math.min(sub.count, 2));
    case 'front-back-mid':
      return sub.count === 1
        ? [{ x: W / 2, y: inset, z }]
        : [
            { x: W / 2, y: inset, z },
            { x: W / 2, y: D - inset, z },
          ];
    case 'four-midwalls':
      return [
        { x: W / 2, y: inset, z },
        { x: W / 2, y: D - inset, z },
        { x: inset, y: D / 2, z },
        { x: W - inset, y: D / 2, z },
      ].slice(0, sub.count);
  }
}

// ---------------------------------------------------------------------------
// complex helpers
// ---------------------------------------------------------------------------

export function cmul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cdiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

export function cscale(a: Complex, k: number): Complex {
  return { re: a.re * k, im: a.im * k };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Format a length in feet + inches, e.g. 2.31 m → 7′ 7″ */
export function fmtFtIn(m: number): string {
  const totalIn = m / IN;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) {
    ft += 1;
    inch = 0;
  }
  return ft > 0 ? `${ft}′ ${inch}″` : `${inch}″`;
}

/** Woodworking inches rounded to the nearest 1/16″, e.g. 12 3/8″ */
export function fmtInFrac(mm: number, denom = 16): string {
  const neg = mm < 0;
  const v = Math.abs(mm) / 25.4;
  let whole = Math.floor(v);
  let num = Math.round((v - whole) * denom);
  if (num === denom) {
    whole += 1;
    num = 0;
  }
  let d = denom;
  while (num > 0 && num % 2 === 0) {
    num /= 2;
    d /= 2;
  }
  const frac = num ? `${num}/${d}` : '';
  const s = whole && frac ? `${whole} ${frac}` : whole ? `${whole}` : frac || '0';
  return `${neg ? '−' : ''}${s}″`;
}

/** Feet + inches to the nearest 1/8″, e.g. 3.81 m → 12′ 6″ */
export function fmtFtInFrac(m: number): string {
  const totalIn = Math.round((m / IN) * 8) / 8;
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn - ft * 12;
  return `${ft}′ ${fmtInFrac(inch * 25.4, 8)}`;
}

/**
 * Parse a length typed in feet and inches (or metres). Returns metres or null.
 * Accepts: 12'6 1/2"  ·  12' 6.5"  ·  12 6 1/2  ·  12-6  ·  12.5 (decimal feet)  ·  150in  ·  3.8m
 */
export function parseLength(raw: string): number | null {
  const vulgar: Record<string, string> = { '¼': ' 1/4', '½': ' 1/2', '¾': ' 3/4', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' };
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[¼½¾⅛⅜⅝⅞]/g, (c) => vulgar[c])
    .replace(/[′’]/g, "'")
    .replace(/[″”]/g, '"')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*m$/);
  if (m) return parseFloat(m[1]);
  const inOnly = s.match(/^([\d.]+)\s*(?:in|")$/);
  if (inOnly) return parseFloat(inOnly[1]) * IN;
  const frac = (t: string | undefined) => {
    if (!t) return 0;
    const f = t.match(/^(\d+)\/(\d+)$/);
    return f ? parseInt(f[1]) / parseInt(f[2]) : parseFloat(t) || 0;
  };
  // feet, then optional inches, then optional fraction
  const ftIn = s.match(/^([\d.]+)\s*(?:'|ft|-|\s)\s*([\d.]+)?\s*(\d+\/\d+)?\s*(?:"|in)?$/);
  if (ftIn) {
    const ft = parseFloat(ftIn[1]);
    const inch = (ftIn[2] && !ftIn[2].includes('/') ? parseFloat(ftIn[2]) : 0) + frac(ftIn[3]);
    if (Number.isFinite(ft)) return ft * FT + inch * IN;
  }
  const dec = parseFloat(s);
  return Number.isFinite(dec) && /^[\d.]+$/.test(s) ? dec * FT : null;
}
