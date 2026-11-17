// WinISD-style box modeler: a lumped electro-mechano-acoustic model of a
// woofer in a sealed, vented, passive-radiator or bandpass box, driven by an
// amplifier of a given power.
//
//   amp ── Re + jωLe ──[ Bl ]── Mms, Cms, Rms ──[ Sd ]── rear chamber + front chamber
//
//   chamber = Cab ‖ Ral (leak, Small's Q_L) ‖ port Map ‖ passive radiator(s)
//             (PR: Mmp + Cmp + Rmp in series, seen through its area: Zmp/Sp²)
//   sealed/vented/PR: front = free air; bp4: sealed rear + vented front;
//   bp6: vented rear + vented front.
//
// Everything is solved per frequency in closed form:
//   cone velocity  u = Bl·V / ( Ze·(Zm + Sd²·(Zrear + Zfront)) + Bl² )
//   rear pressure  pr = −Sd·u·Zrear   (cone out → rear pressure drops)
//   front pressure pf = +Sd·u·Zfront  (bandpass only)
//   outward flows  port p/Zport, leak p/Ral, PR n·Sp·v with v = p·Sp/Zmp
//   radiated flow  U = Σ outward flows (+ Sd·u when the cone faces the room)
//   SPL at 1 m     p = ρ·ω·|U| / (2π·r)     (half space, like a datasheet's
//                                           baffle measurement and WinISD)
//
// Mms from a datasheet already includes the front air load, so no extra
// radiation mass is added. Several woofers in one box are wired in parallel
// and share the box, ports and radiators: by symmetry each behaves like one
// driver in Vb/N with port area Sp/N and N_pr/N radiators, so we solve one and scale.

import type { DriverInfo } from './drivers';
import type { BoxDesign } from './speakerBuild';
import { SPEED_OF_SOUND } from './roomAcoustics';
import { baffleResponse } from './diffraction';
import { buildGeometry, simulate, type HybridParams } from './hybrid';

const RHO = 1.204;
const C = SPEED_OF_SOUND;
const P_REF = 20e-6;

interface Cx {
  re: number;
  im: number;
}
const cx = (re: number, im = 0): Cx => ({ re, im });
const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const scl = (a: Cx, k: number): Cx => cx(a.re * k, a.im * k);
const inv = (a: Cx) => div(cx(1), a);
const abs = (a: Cx) => Math.hypot(a.re, a.im);
const arg = (a: Cx) => Math.atan2(a.im, a.re);

export interface MechParams {
  Sd: number; // m²
  Cms: number; // m/N
  Mms: number; // kg
  Rms: number; // N·s/m
  Bl: number; // T·m
  Re: number; // Ω
  Le: number; // H
  qes: number;
  qms: number;
  /** which of Qes/Qms the datasheet left out and we had to assume */
  assumed: string[];
}

/** Thiele/Small → mechanical. Fills a missing Qes or Qms from Qts (1/Qts = 1/Qes + 1/Qms). */
export function tsToMech(d: DriverInfo): MechParams {
  const assumed: string[] = [];
  let qes = d.qes;
  let qms = d.qms;
  if (qes == null && qms != null && qms > d.qts) qes = (d.qts * qms) / (qms - d.qts);
  if (qms == null && qes != null && qes > d.qts) qms = (d.qts * qes) / (qes - d.qts);
  if (qes == null || qms == null) {
    qms = 5;
    qes = (d.qts * qms) / (qms - d.qts);
    assumed.push('Qms (taken as 5)');
  }
  const Sd = d.sdCm2 / 1e4;
  const ws = 2 * Math.PI * d.fsHz;
  const Cms = d.vasL / 1000 / (RHO * C * C * Sd * Sd);
  const Mms = 1 / (ws * ws * Cms);
  const Rms = (ws * Mms) / qms;
  const Bl = Math.sqrt((ws * Mms * d.reOhm) / qes);
  return { Sd, Cms, Mms, Rms, Bl, Re: d.reOhm, Le: (d.leMh ?? 0) / 1000, qes, qms, assumed };
}

/**
 * A passive radiator (drone): a diaphragm with mass, suspension and loss but no motor.
 * Give the suspension as Cms or as the bare free-air resonance fs (without added mass).
 */
export interface PassiveRadiator {
  /** catalogue id, for the presets */
  id?: string;
  name?: string;
  sdCm2: number;
  /** moving mass as supplied, without added mass (g) */
  mmsG: number;
  cmsMmPerN?: number;
  fsHz?: number;
  /** one-way linear excursion (mm) */
  xmaxMm: number;
  /** mechanical Q at the bare free-air resonance (default 6) */
  qm?: number;
  /** most mass the maker's kit/threaded stud takes (g), if known */
  maxAddedMassG?: number;
}

export type BoxSpec =
  | { kind: 'sealed'; netL: number; ql?: number; fill?: number }
  | { kind: 'vented'; netL: number; fbHz: number; portAreaM2: number; ql?: number }
  /** sealed box with passive radiator(s); addedMassG is per radiator */
  | { kind: 'pr'; netL: number; pr: PassiveRadiator; prCount: number; addedMassG: number; ql?: number }
  /** 4th-order bandpass: sealed rear chamber, vented front chamber, sound only from the port */
  | { kind: 'bp4'; rearL: number; frontL: number; fbHz: number; portAreaM2: number; ql?: number }
  /** 6th-order (series-tuned) bandpass: both chambers vented, sound only from the two ports */
  | { kind: 'bp6'; rearL: number; frontL: number; fbRearHz: number; fbFrontHz: number; rearPortAreaM2: number; frontPortAreaM2: number; ql?: number };

export type BoxKind = BoxSpec['kind'];

/** Total internal volume of the box (both chambers for a bandpass), L. */
export function boxNetL(b: BoxSpec): number {
  return b.kind === 'bp4' || b.kind === 'bp6' ? b.rearL + b.frontL : b.netL;
}
export const isBandpass = (b: BoxSpec) => b.kind === 'bp4' || b.kind === 'bp6';
export const hasPort = (b: BoxSpec) => b.kind === 'vented' || b.kind === 'bp4' || b.kind === 'bp6';

export interface HighPass {
  hz: number;
  /** 2 = 12 dB/oct, 4 = 24 dB/oct (Butterworth) */
  order: 2 | 4;
}

export type Placement = 'half' | 'free' | 'wall' | 'corner';

/** Placement factor per frequency (complex): baffle step + boundary reflections, 1 m on axis. */
function placementFactor(inp: ModelInput, freqs: number[]): Cx[] {
  const pl = inp.placement ?? 'half';
  if (pl === 'half' || !inp.baffle) return freqs.map(() => cx(1));
  const b = inp.baffle;
  const r = baffleResponse({ widthMm: b.widthMm, heightMm: b.heightMm, driverXmm: b.widthMm / 2, driverYmm: b.driverYmm, edgeRadiusMm: b.edgeRadiusMm ?? 12, distanceM: 1 }, freqs);
  // walls 0.3 m behind/beside the speaker: image sources, path 1 m vs 1 m + 2d (rigid walls)
  const d = 0.3;
  const images = pl === 'wall' ? [2 * d] : pl === 'corner' ? [2 * d, 2 * d, 2 * Math.SQRT2 * d] : [];
  return freqs.map((f, i) => {
    const g = Math.pow(10, r.db[i] / 20);
    const ph = (r.phaseDeg[i] * Math.PI) / 180;
    let sum = cx(1);
    for (const extra of images) {
      const k = (2 * Math.PI * f) / C;
      const a = 1 / (1 + extra);
      sum = add(sum, cx(a * Math.cos(-k * extra), a * Math.sin(-k * extra)));
    }
    return mul(cx(g * Math.cos(ph), g * Math.sin(ph)), sum);
  });
}

export interface ModelInput {
  driver: DriverInfo;
  count: number;
  box: BoxSpec;
  /** amplifier power into the nominal impedance of the woofer group (W) */
  powerW: number;
  highPass?: HighPass | null;
  /** port noise threshold (peak m/s); also limits max SPL. Default 17 */
  portNoiseMs?: number;
  /** where it plays: on a big baffle (datasheet-like), free space with the real baffle step,
   *  near a wall, or in a corner; the baffle (mm) is needed for anything but 'half' */
  placement?: Placement;
  baffle?: { widthMm: number; heightMm: number; driverYmm: number; edgeRadiusMm?: number };
  f0?: number;
  f1?: number;
  n?: number;
}

export interface ModelResult {
  freqs: number[];
  /** complex pressure at 1 m per volt (after placement), for crossover work */
  H: Cx[];
  /** SPL at 1 m, half space, at the chosen power (dB) */
  spl: number[];
  /** SPL at 2.83 V with no filter (dB) — the sensitivity-style curve */
  spl283: number[];
  /** peak cone excursion (mm) */
  excursionMm: number[];
  /** peak air speed in the port (m/s); empty for sealed */
  portVelocity: number[];
  /** input impedance magnitude (Ω) and phase (deg) of the woofer group */
  impedance: number[];
  impedancePhase: number[];
  /** group delay of the acoustic output (ms) */
  groupDelayMs: number[];
  /** loudest it can play before hitting Xmax or the power rating (dB); same filter applied */
  maxSpl: number[];
  /** which limit sets maxSpl at each frequency */
  maxSplLimit: ('xmax' | 'power' | 'port' | 'pr')[];
  voltsRms: number;
  nominalOhm: number;
  ratedPowerW: number;
  xmaxMm: number;
  /** passband sensitivity, 2.83 V / 1 m, half space (dB) */
  sensitivity283: number;
  /** lowest impedance above the bass peak — what the amp must drive */
  minImpedance: { ohm: number; hz: number };
  mech: MechParams;
  /** each port's peak air speed (m/s) — two for a 6th-order bandpass; absent for sealed/PR */
  ports?: { label: string; velocity: number[]; areaM2: number }[];
  /** passive radiator excursion (peak mm) and its Xmax; only for a PR box */
  prExcursionMm?: number[];
  prXmaxMm?: number;
  /** box kind the result came from */
  kind?: BoxKind;
}

function highPassH(hp: HighPass, f: number): Cx {
  // Butterworth sections in s = j f/fc
  const s = cx(0, f / hp.hz);
  const s2 = mul(s, s);
  const section = (q: number) => div(s2, add(add(s2, scl(s, 1 / q)), cx(1)));
  if (hp.order === 2) return section(Math.SQRT1_2);
  return mul(section(0.5412), section(1.3066));
}

export function logFreqs(f0: number, f1: number, n: number) {
  return Array.from({ length: n }, (_, i) => f0 * Math.pow(f1 / f0, i / (n - 1)));
}

/** PR mechanical elements from its datasheet numbers (suspension from Cms or bare fs). */
export function prMech(pr: PassiveRadiator, addedMassG = 0) {
  const Sp = pr.sdCm2 / 1e4;
  const M0 = Math.max(pr.mmsG, 0.1) / 1000;
  const Cmp = pr.cmsMmPerN != null && pr.cmsMmPerN > 0 ? pr.cmsMmPerN / 1000 : 1 / ((2 * Math.PI * Math.max(pr.fsHz ?? 25, 1)) ** 2 * M0);
  const fs0 = 1 / (2 * Math.PI * Math.sqrt(M0 * Cmp));
  const Mmp = M0 + Math.max(addedMassG, 0) / 1000;
  // losses taken at the bare resonance and kept when mass is added
  const Rmp = (2 * Math.PI * fs0 * M0) / (pr.qm ?? 6);
  return { Sp, Mmp, Cmp, Rmp, fs0, fsLoaded: 1 / (2 * Math.PI * Math.sqrt(Mmp * Cmp)) };
}

/**
 * Tuning of a PR box: the PR mass resonating against its own suspension and the box air
 * in series, Fp = 1/(2π√(Map·(Cab‖Cap))) with Cab‖Cap = Cab·Cap/(Cab+Cap) in acoustic units
 * (Hurlburt, "Complete Response Function and System Parameters for a Loudspeaker with
 * Passive Radiator", JAES 2000). n radiators act as one with n× the area-weighted compliance.
 */
export function prTuningHz(netL: number, pr: PassiveRadiator, prCount: number, addedMassG: number): number {
  const m = prMech(pr, addedMassG);
  const n = Math.max(prCount, 1e-9);
  const Cab = netL / 1000 / (RHO * C * C);
  const Map = m.Mmp / (m.Sp * m.Sp) / n;
  const Cap = m.Cmp * m.Sp * m.Sp * n;
  return 1 / (2 * Math.PI * Math.sqrt(Map * ((Cab * Cap) / (Cab + Cap))));
}

/**
 * Added mass per radiator that tunes the box to fpHz. If the bare radiator is already too
 * heavy for that tuning, the mass is 0 and `fpHz` says where it really lands; `overMax` flags
 * more mass than the maker allows.
 */
export function prMassForTuning(netL: number, pr: PassiveRadiator, prCount: number, fpHz: number) {
  const m = prMech(pr, 0);
  const n = Math.max(prCount, 1e-9);
  const Cab = netL / 1000 / (RHO * C * C);
  const Cap = m.Cmp * m.Sp * m.Sp * n;
  const w = 2 * Math.PI * fpHz;
  const Map = (Cab + Cap) / (w * w * Cab * Cap);
  const need = (Map * n * m.Sp * m.Sp - m.Mmp) * 1000;
  const addedMassG = Math.max(0, need);
  return {
    addedMassG,
    reachable: need >= 0,
    fpHz: prTuningHz(netL, pr, prCount, addedMassG),
    overMax: pr.maxAddedMassG != null && addedMassG > pr.maxAddedMassG,
    /** the response null sits at the loaded radiator's own free-air resonance */
    nullHz: prMech(pr, addedMassG).fsLoaded,
  };
}

/** Typical passive radiators, for sizing — generic values, not a specific product's datasheet. */
export const PR_PRESETS: PassiveRadiator[] = [
  { id: 'pr-6.5', name: '6.5″ passive radiator (typical)', sdCm2: 133, mmsG: 25, cmsMmPerN: 1.2, xmaxMm: 9, qm: 6, maxAddedMassG: 80 },
  { id: 'pr-8', name: '8″ passive radiator (typical)', sdCm2: 220, mmsG: 45, cmsMmPerN: 0.9, xmaxMm: 12, qm: 6, maxAddedMassG: 150 },
  { id: 'pr-10', name: '10″ passive radiator (typical)', sdCm2: 340, mmsG: 90, cmsMmPerN: 0.6, xmaxMm: 15, qm: 5, maxAddedMassG: 300 },
  { id: 'pr-12', name: '12″ passive radiator (typical)', sdCm2: 500, mmsG: 200, cmsMmPerN: 0.35, xmaxMm: 20, qm: 5, maxAddedMassG: 500 },
];

/**
 * A PR that suits the woofer(s): the usual rule is radiator displacement (Sd·Xmax, all
 * radiators together) at least ~2× the woofers', ideally from larger area than the woofer.
 * Picks the smallest preset that gets there with one radiator, else with two.
 */
export function suggestPr(d: DriverInfo, count = 1): { pr: PassiveRadiator; prCount: number } {
  const vd = d.sdCm2 * d.xmaxMm * Math.max(1, count);
  for (const n of [1, 2])
    for (const pr of PR_PRESETS) if (pr.sdCm2 * n >= 1.2 * d.sdCm2 * count && pr.sdCm2 * pr.xmaxMm * n >= 2 * vd) return { pr, prCount: n };
  return { pr: PR_PRESETS[PR_PRESETS.length - 1], prCount: 2 };
}

/** Leak Q default per chamber: Small's lossy-box Ql (~7 vented, near-lossless sealed). */
function defaultQl(kind: BoxKind, fill: number): number {
  if (kind === 'sealed') return 1 / (1 / 50 + fill / 8);
  if (kind === 'pr') return 15;
  return 7;
}

/** One enclosure chamber as seen by the cone, per driver (the box shares split by N). */
interface Chamber {
  Cab: number;
  Ral: number;
  /** port acoustic mass (0 = no port) and area */
  Map: number;
  Sp: number;
  /** passive radiators on this chamber (per driver share) */
  pr: { Sp: number; Mmp: number; Cmp: number; Rmp: number; n: number } | null;
}

function chamberOf(volL: number, N: number, ql: number, fRef: number, fbHz: number | null, portArea: number): Chamber {
  const Vb = volL / 1000 / N;
  const Cab = Vb / (RHO * C * C);
  const wb = 2 * Math.PI * (fbHz ?? fRef);
  return {
    Cab,
    // leakage/absorption as a resistance across the box compliance (Small: Ql = ωb·Cab·Ral)
    Ral: ql / (wb * Cab),
    // port mass chosen so the chamber really tunes to fb
    Map: fbHz ? 1 / (wb * wb * Cab) : 0,
    Sp: fbHz ? portArea / N : 0,
    pr: null,
  };
}

/** Chamber admittance and the outward flows per unit pressure from its port, PR(s) and leak. */
function chamberY(ch: Chamber, w: number) {
  let Y = cx(1 / ch.Ral, w * ch.Cab);
  const Yport = ch.Map ? cx(0, -1 / (w * ch.Map)) : cx(0);
  Y = add(Y, Yport);
  // PR: mechanical impedance Zmp, acoustic Zmp/Sp² — flow per pressure n·Sp²/Zmp
  let Ypr = cx(0);
  let vPerP = cx(0); // diaphragm velocity per unit box pressure
  if (ch.pr) {
    const Zmp = cx(ch.pr.Rmp, w * ch.pr.Mmp - 1 / (w * ch.pr.Cmp));
    vPerP = scl(inv(Zmp), ch.pr.Sp);
    Ypr = scl(vPerP, ch.pr.Sp * ch.pr.n);
    Y = add(Y, Ypr);
  }
  return { Y, Yport, Ypr, vPerP };
}

export function runModel(inp: ModelInput): ModelResult {
  const d = inp.driver;
  const N = Math.max(1, Math.round(inp.count));
  const m = tsToMech(d);
  const freqs = logFreqs(inp.f0 ?? 10, inp.f1 ?? 500, inp.n ?? 160);

  // the whole group sees the amp; parallel wiring → nominal impedance / N
  const nominalOhm = d.nominalOhm / N;
  const voltsRms = Math.sqrt(Math.max(inp.powerW, 1e-6) * nominalOhm);
  const ratedPowerW = (d.powerW ?? 50) * N;
  const xmax = Math.max(d.xmaxMm, 0.5) / 1000;
  const portNoise = inp.portNoiseMs ?? 17;
  const placeF = placementFactor(inp, freqs);

  // Enclosure as chambers. Behind the cone: `rear`; in front: free air, or a vented
  // front chamber for a bandpass. By symmetry each of N woofers drives 1/N of every
  // volume, port area and radiator, so we solve one driver and scale.
  const b = inp.box;
  const fill = b.kind === 'sealed' ? (b.fill ?? 0) : 0;
  const ql = b.ql ?? defaultQl(b.kind, fill);
  let rear: Chamber;
  let front: Chamber | null = null;
  let prXmax = 0;
  const portLabels: string[] = [];
  if (b.kind === 'sealed') {
    // fibre fill: ~15 % more effective volume, and absorption losses on top of the leak
    rear = chamberOf(b.netL * (1 + 0.15 * fill), N, ql, d.fsHz, null, 0);
  } else if (b.kind === 'vented') {
    rear = chamberOf(b.netL, N, ql, d.fsHz, b.fbHz, b.portAreaM2);
    portLabels.push('Port');
  } else if (b.kind === 'pr') {
    const pm = prMech(b.pr, b.addedMassG);
    rear = chamberOf(b.netL, N, ql, prTuningHz(b.netL, b.pr, b.prCount, b.addedMassG), null, 0);
    rear.pr = { Sp: pm.Sp, Mmp: pm.Mmp, Cmp: pm.Cmp, Rmp: pm.Rmp, n: b.prCount / N };
    prXmax = Math.max(b.pr.xmaxMm, 0.5) / 1000;
  } else if (b.kind === 'bp4') {
    // the sealed rear chamber is nearly lossless; the front behaves like a vented box
    rear = chamberOf(b.rearL, N, b.ql ?? 20, b.fbHz, null, 0);
    front = chamberOf(b.frontL, N, ql, b.fbHz, b.fbHz, b.portAreaM2);
    portLabels.push('Port');
  } else {
    rear = chamberOf(b.rearL, N, ql, b.fbRearHz, b.fbRearHz, b.rearPortAreaM2);
    front = chamberOf(b.frontL, N, ql, b.fbFrontHz, b.fbFrontHz, b.frontPortAreaM2);
    portLabels.push('Front port', 'Rear port');
  }
  const isPr = !!rear.pr;

  const spl: number[] = [];
  const spl283: number[] = [];
  const exc: number[] = [];
  const prExc: number[] = [];
  const portV: number[][] = portLabels.map(() => []);
  const zMag: number[] = [];
  const zPh: number[] = [];
  const maxSpl: number[] = [];
  const maxLim: ModelResult['maxSplLimit'] = [];
  const phase: number[] = [];
  const Hc: Cx[] = [];
  const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12) / P_REF);

  freqs.forEach((f, fi) => {
    const w = 2 * Math.PI * f;
    const Ze = cx(m.Re, w * m.Le);
    const Zm = cx(m.Rms, w * m.Mms - 1 / (w * m.Cms));
    const R = chamberY(rear, w);
    const Zr = inv(R.Y);
    const F = front ? chamberY(front, w) : null;
    const Zf = F ? inv(F.Y) : cx(0);
    // the cone works against both chambers in series (the pressure difference across it)
    const Zmot = add(Zm, scl(add(Zr, Zf), m.Sd * m.Sd));
    // per volt, unfiltered
    const u1 = div(cx(m.Bl), add(mul(Ze, Zmot), cx(m.Bl * m.Bl)));
    // cone out (u > 0) → rear pressure drops, front chamber pressure rises
    const pr1 = scl(mul(Zr, u1), -m.Sd);
    const pf1 = scl(mul(Zf, u1), m.Sd);
    // radiated volume velocity: port(s), radiator(s) and leak flows leave the chambers;
    // Small's Q_L is a leak, so at DC cone + port + leak cancel exactly
    const UpR = mul(pr1, R.Yport);
    const UpF = F ? mul(pf1, F.Yport) : cx(0);
    let U1 = add(add(UpR, scl(pr1, 1 / rear.Ral)), mul(pr1, R.Ypr));
    U1 = front && F ? add(U1, add(UpF, scl(pf1, 1 / front.Ral))) : add(U1, scl(u1, m.Sd));
    // p(1 m, half space) per volt, for the whole group, then where it is placed
    const p1 = mul(scl(mul(cx(0, w), U1), (RHO * N) / (2 * Math.PI)), placeF[fi]);
    const Zin = scl(add(Ze, div(cx(m.Bl * m.Bl), Zmot)), 1 / N);

    const H = inp.highPass ? highPassH(inp.highPass, f) : cx(1);
    const V = scl(H, voltsRms);
    Hc.push(p1);
    const p = mul(p1, V);
    const u = mul(u1, V);

    spl.push(db(abs(p)));
    spl283.push(db(abs(p1) * 2.83));
    exc.push(((abs(u) * Math.SQRT2) / w) * 1000);
    const vPr1 = mul(pr1, R.vPerP); // PR diaphragm velocity per volt
    if (isPr) prExc.push(((abs(vPr1) * voltsRms * abs(H) * Math.SQRT2) / w) * 1000);
    // per-port air speed per volt (peak), front port first
    const portPerVolt: number[] = [];
    if (front) portPerVolt.push((abs(UpF) * Math.SQRT2) / front.Sp);
    if (rear.Map) portPerVolt.push((abs(UpR) * Math.SQRT2) / rear.Sp);
    portPerVolt.forEach((v, k) => portV[k].push(v * voltsRms * abs(H)));
    zMag.push(abs(Zin));
    zPh.push((arg(Zin) * 180) / Math.PI);
    phase.push(arg(mul(p1, H)));

    // max output: scale the (filtered) drive until the cone reaches Xmax, the electrical
    // power reaches the rating, a port reaches the noise threshold or the PR its Xmax
    const hMag = abs(H);
    const xPerVolt = (abs(u1) * hMag * Math.SQRT2) / w;
    const vByX = xmax / Math.max(xPerVolt, 1e-15); // amp volts (rms, before filter)
    const vByP = Math.sqrt(ratedPowerW * nominalOhm);
    const portMax = Math.max(0, ...portPerVolt) * hMag;
    const vByPort = portMax > 0 ? portNoise / portMax : Infinity;
    const prPerVolt = isPr ? (abs(vPr1) * hMag * Math.SQRT2) / w : 0;
    const vByPr = prPerVolt > 0 ? prXmax / prPerVolt : Infinity;
    const vLim = Math.min(vByX, vByP, vByPort, vByPr);
    maxSpl.push(db(abs(p1) * hMag * vLim));
    maxLim.push(vLim === vByPort ? 'port' : vLim === vByPr ? 'pr' : vByX < vByP ? 'xmax' : 'power');
  });

  // group delay = −dφ/dω, with phase unwrapped
  const un = [...phase];
  for (let i = 1; i < un.length; i++) {
    while (un[i] - un[i - 1] > Math.PI) un[i] -= 2 * Math.PI;
    while (un[i] - un[i - 1] < -Math.PI) un[i] += 2 * Math.PI;
  }
  const gd = freqs.map((_, i) => {
    const a = Math.max(0, i - 1);
    const c = Math.min(freqs.length - 1, i + 1);
    const dw = 2 * Math.PI * (freqs[c] - freqs[a]);
    return (-(un[c] - un[a]) / dw) * 1000;
  });

  let sensitivity283: number;
  if (front) {
    // a bandpass has no plateau above the bass: its passband level is the top of the hump
    sensitivity283 = Math.max(...spl283.filter((_, i) => freqs[i] < 400));
  } else {
    // passband sensitivity: plateau where the response has flattened out
    const pass = spl283.filter((_, i) => freqs[i] > Math.max(4 * d.fsHz, 150) && freqs[i] < 400);
    sensitivity283 = pass.length ? pass.reduce((s, x) => s + x, 0) / pass.length : spl283[spl283.length - 1];
  }

  // the impedance minimum above the (highest) bass peak
  let peakI = 0;
  for (let i = 0; i < freqs.length && freqs[i] < Math.max(2.5 * d.fsHz, 120); i++) if (zMag[i] > zMag[peakI]) peakI = i;
  let minI = peakI;
  for (let i = peakI; i < freqs.length; i++) if (zMag[i] < zMag[minI]) minI = i;

  // ports: front port first for a bandpass (it is "the" port of a bp4)
  const portAreas = [...(front ? [front.Sp * N] : []), ...(rear.Map ? [rear.Sp * N] : [])];
  const ports = portLabels.map((label, k) => ({ label, velocity: portV[k], areaM2: portAreas[k] }));
  // the single "port velocity" curve: the faster port at each frequency
  const portVelocity = ports.length ? freqs.map((_, i) => Math.max(...ports.map((p) => p.velocity[i]))) : [];

  return {
    freqs,
    H: Hc,
    spl,
    spl283,
    excursionMm: exc,
    portVelocity,
    impedance: zMag,
    impedancePhase: zPh,
    groupDelayMs: gd,
    maxSpl,
    maxSplLimit: maxLim,
    voltsRms,
    nominalOhm,
    ratedPowerW,
    xmaxMm: d.xmaxMm,
    sensitivity283,
    minImpedance: { ohm: zMag[minI], hz: freqs[minI] },
    mech: m,
    ports: ports.length ? ports : undefined,
    prExcursionMm: isPr ? prExc : undefined,
    prXmaxMm: b.kind === 'pr' ? b.pr.xmaxMm : undefined,
    kind: b.kind,
  };
}

/** The box the planner designed, as a model input. */
export function boxSpecOf(box: BoxDesign): BoxSpec {
  if (box.alignment.kind === 'vented' && box.port) {
    const a = box.port.count * Math.PI * (box.port.diameterMm / 2000) ** 2;
    return { kind: 'vented', netL: box.netVolumeL, fbHz: box.port.fbHz, portAreaM2: a, ql: box.alignment.ql };
  }
  return { kind: 'sealed', netL: box.netVolumeL, fill: box.sealedFill };
}

// ---------------------------------------------------------------------------
// Driver guidance: EBP, derived parameters, which box suits, data sanity
// ---------------------------------------------------------------------------

export interface DriverGuidance {
  ebp: number;
  blTm: number;
  mmsG: number;
  cmsMmPerN: number;
  rmsKgS: number;
  verdict: 'sealed' | 'ported' | 'either';
  reasons: string[];
  /** inconsistent or missing T/S data */
  dataIssues: string[];
}

/**
 * EBP = Fs/Qes (efficiency-bandwidth product): below ~50 the motor is strong for the
 * resonance and a sealed box suits, above ~90 a ported one, between either. A low Qts
 * (< ~0.35) also suits a transmission line or horn — it has the damping to drive one
 * without boom.
 */
export function driverGuidance(d: DriverInfo): DriverGuidance {
  const m = tsToMech(d);
  const ebp = d.fsHz / m.qes;
  const reasons: string[] = [];
  let verdict: DriverGuidance['verdict'] = 'either';
  if (ebp < 50) {
    verdict = 'sealed';
    reasons.push(`EBP ${ebp.toFixed(0)} (below ~50): a strong motor for its resonance — it gives its best, tight bass in a sealed box.`);
  } else if (ebp > 90) {
    verdict = 'ported';
    reasons.push(`EBP ${ebp.toFixed(0)} (above ~90): a light motor for its resonance — sealed would sound thin; a port (or a line/horn) gives it the bass.`);
  } else reasons.push(`EBP ${ebp.toFixed(0)} (between ~50 and ~90): works sealed or ported — sealed for a sub-assisted system, ported for more bass on its own.`);
  if (d.qts < 0.35) reasons.push(`Qts ${d.qts} (below ~0.35): well damped — a good transmission-line or horn candidate.`);
  if (d.qts > 0.6) reasons.push(`Qts ${d.qts} (high): little damping — needs a large sealed box or an open baffle; avoid ports.`);
  const dataIssues: string[] = [];
  if (d.qes == null || d.qms == null) dataIssues.push(`The datasheet gives no ${d.qes == null ? 'Qes' : 'Qms'}; it is assumed from Qts.`);
  if (d.qes != null && d.qms != null) {
    const q = (d.qes * d.qms) / (d.qes + d.qms);
    if (Math.abs(q - d.qts) / d.qts > 0.08) dataIssues.push(`Qes and Qms combine to Qts ${q.toFixed(2)}, not the stated ${d.qts} — one of the three is probably a typo.`);
  }
  if (d.role !== 'tweeter') {
    const sens = sensitivityFromTS(d);
    if (Math.abs(sens - d.sensDb) > 2.5)
      dataIssues.push(`The T/S numbers imply ${sens.toFixed(1)} dB at 2.83 V, the datasheet says ${d.sensDb} dB — makers often measure sensitivity where the cone's breakup lifts it, but a big gap can mean a mistyped Vas, Sd or Qes.`);
  }
  if (d.leMh == null) dataIssues.push('No voice-coil inductance (Le) given — impedance above a few hundred Hz is approximate.');
  return { ebp, blTm: m.Bl, mmsG: m.Mms * 1000, cmsMmPerN: m.Cms * 1000, rmsKgS: m.Rms, verdict, reasons, dataIssues };
}

// ---------------------------------------------------------------------------
// Comparison pins and summaries
// ---------------------------------------------------------------------------

/** A design frozen for side-by-side comparison (the driver is copied so later edits don't move it). */
export interface ModelPin {
  id: string;
  label: string;
  driver: DriverInfo;
  count: number;
  box: BoxSpec;
  /** a printed design (TL, horn, shell…): simulated with its own geometry */
  printed?: HybridParams;
}

/**
 * A printed design's simulation, converted to the modeler's basis: the given amp
 * power instead of 2.83 V, and half space (+6 dB) instead of full space — so it
 * can sit on the same graphs and in the same table as the plywood boxes.
 */
export function printedAsModel(params: HybridParams, d: DriverInfo, powerW: number, f0 = 10, f1 = 500, n = 170): ModelResult {
  const g = buildGeometry(params, d);
  const r = simulate(params, d, g, { coupled: 1, floor: false, f0, f1, n });
  const volts = Math.sqrt(Math.max(powerW, 1e-6) * d.nominalOhm);
  const k = volts / 2.83;
  const dbK = 20 * Math.log10(k);
  const HALF = 6.02;
  const spl283 = r.spl.map((x) => x + HALF);
  const pass = spl283.filter((_, i) => r.freqs[i] > 150 && r.freqs[i] < 400);
  const z = r.impedance ?? r.freqs.map(() => NaN);
  let minI = 0;
  z.forEach((v, i) => {
    if (r.freqs[i] > 2 * d.fsHz && v < z[minI]) minI = i;
  });
  return {
    freqs: r.freqs,
    H: [],
    spl: spl283.map((x) => x + dbK),
    spl283,
    excursionMm: r.excursionMm.map((x) => x * k),
    portVelocity: r.mouthVelocity ? r.mouthVelocity.map((x) => x * k) : [],
    impedance: z,
    impedancePhase: z.map(() => 0),
    groupDelayMs: r.groupDelayMs ?? r.freqs.map(() => 0),
    maxSpl: r.maxSpl.map((x) => x + HALF),
    maxSplLimit: r.freqs.map(() => 'xmax' as const),
    voltsRms: volts,
    nominalOhm: d.nominalOhm,
    ratedPowerW: d.powerW ?? 50,
    xmaxMm: d.xmaxMm,
    sensitivity283: pass.length ? pass.reduce((a, b) => a + b, 0) / pass.length : spl283[spl283.length - 1],
    minImpedance: { ohm: z[minI], hz: r.freqs[minI] },
    mech: tsToMech(d),
  };
}

export function boxLabel(driver: DriverInfo, count: number, box: BoxSpec) {
  const n = count > 1 ? `${count}× ` : '';
  const L = (x: number) => x.toFixed(x < 10 ? 1 : 0);
  let b: string;
  switch (box.kind) {
    case 'vented':
      b = `vented ${box.netL.toFixed(0)} L @ ${box.fbHz.toFixed(0)} Hz`;
      break;
    case 'pr': {
      const fp = prTuningHz(box.netL, box.pr, box.prCount, box.addedMassG);
      const size = box.pr.name?.match(/^[\d.]+″/)?.[0] ?? `${box.pr.sdCm2.toFixed(0)} cm²`;
      b = `PR ${L(box.netL)} L @ ${fp.toFixed(0)} Hz (${box.prCount > 1 ? `${box.prCount}× ` : ''}${size} + ${box.addedMassG.toFixed(0)} g)`;
      break;
    }
    case 'bp4':
      b = `bandpass 4th ${L(box.rearL)}+${L(box.frontL)} L @ ${box.fbHz.toFixed(0)} Hz`;
      break;
    case 'bp6':
      b = `bandpass 6th ${L(box.rearL)}+${L(box.frontL)} L @ ${box.fbRearHz.toFixed(0)}/${box.fbFrontHz.toFixed(0)} Hz`;
      break;
    default:
      b = `sealed ${box.netL.toFixed(0)} L`;
  }
  return `${n}${driver.model} · ${b}`;
}

/** −3 dB point of the 2.83 V curve relative to its passband. */
export function f3Of(r: ModelResult): number {
  for (let i = 0; i < r.freqs.length; i++) if (r.spl283[i] >= r.sensitivity283 - 3) return r.freqs[i];
  return r.freqs[r.freqs.length - 1];
}

/** Upper −3 dB point (a bandpass's top end): first frequency above the peak that is 3 dB under the passband level. */
export function f3HighOf(r: ModelResult): number | null {
  let k = 0;
  r.freqs.forEach((f, i) => {
    if (f < 400 && r.spl283[i] > r.spl283[k]) k = i;
  });
  for (let i = k; i < r.freqs.length; i++) if (r.spl283[i] < r.sensitivity283 - 3) return r.freqs[i];
  return null;
}

// ---------------------------------------------------------------------------
// Bandpass design helpers
// ---------------------------------------------------------------------------

export interface BandpassDesign {
  spec: Extract<BoxSpec, { kind: 'bp4' | 'bp6' }>;
  /** −3 dB points of the modelled result (2.83 V curve) */
  fLowHz: number;
  fHighHz: number | null;
  /** passband level above the woofer(s) on an infinite baffle (dB) */
  gainDb: number;
  /** physical port length(s), mm — front port first */
  portLengthMm: number[];
  /** bp4 design parameters: Dickason's S and the rear-chamber Qbp */
  s?: number;
  qbp?: number;
  notes: string[];
}

/**
 * The box modeler's passive-radiator / bandpass choices for one design, kept in
 * DesignSettings so they persist and travel with saved designs. Each part
 * remembers the woofer it was made for (`key` = "wooferId:count"); a different
 * woofer ignores it and starts the PR/bandpass design over.
 */
export interface ModelerAlt {
  /** a PR / bandpass box modelled instead of the plan's sealed/vented box; null = follow the plan */
  alt: 'pr' | 'bp4' | 'bp6' | null;
  pr: { key: string; id: string | null; count: number | null; netL: number | null; fp: number | null } | null;
  bp4: ModelerBp | null;
  bp6: ModelerBp | null;
  bpTarget: { key: string; lo: number; hi: number } | null;
}
export interface ModelerBp {
  key: string;
  spec: Extract<BoxSpec, { kind: 'bp4' | 'bp6' }>;
  design: BandpassDesign | null;
  edited: boolean;
}

export const EMPTY_MODELER_ALT: ModelerAlt = { alt: null, pr: null, bp4: null, bp6: null, bpTarget: null };

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown) => (fin(x) ? x : null);

/** Tidy a stored ModelerAlt (localStorage or an imported file): malformed parts fall back to the defaults. */
export function sanitizeModelerAlt(raw: unknown): ModelerAlt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const out: ModelerAlt = { ...EMPTY_MODELER_ALT };
  if (r.alt === 'pr' || r.alt === 'bp4' || r.alt === 'bp6') out.alt = r.alt;
  if (r.pr && typeof r.pr === 'object' && typeof r.pr.key === 'string')
    out.pr = { key: r.pr.key, id: typeof r.pr.id === 'string' ? r.pr.id : null, count: numOrNull(r.pr.count), netL: numOrNull(r.pr.netL), fp: numOrNull(r.pr.fp) };
  for (const k of ['bp4', 'bp6'] as const) {
    const b = r[k];
    if (!b || typeof b !== 'object' || typeof b.key !== 'string' || !b.spec || b.spec.kind !== k) continue;
    const s = b.spec;
    const ok =
      k === 'bp4'
        ? [s.rearL, s.frontL, s.fbHz, s.portAreaM2].every(fin)
        : [s.rearL, s.frontL, s.fbRearHz, s.fbFrontHz, s.rearPortAreaM2, s.frontPortAreaM2].every(fin);
    if (!ok) continue;
    const design = b.design && typeof b.design === 'object' && b.design.spec?.kind === k && Array.isArray(b.design.notes) ? (b.design as BandpassDesign) : null;
    out[k] = { key: b.key, spec: s, design, edited: !!b.edited };
  }
  const t = r.bpTarget;
  if (t && typeof t === 'object' && typeof t.key === 'string' && fin(t.lo) && fin(t.hi)) out.bpTarget = { key: t.key, lo: t.lo, hi: t.hi };
  return out;
}

/** Physical length of one round port of this area tuning volL to fbHz (one flanged end), mm. */
export function bandpassPortLengthMm(volL: number, fbHz: number, areaM2: number): number {
  const leff = (areaM2 * (C / (2 * Math.PI * fbHz)) ** 2) / (volL / 1000);
  const D = 2 * Math.sqrt(areaM2 / Math.PI);
  return (leff - 0.732 * D) * 1000;
}

/** Port area for ≤ 17 m/s with the cone(s) at Xmax at fb (the vented planner's rule), kept short enough to fit. */
function bpPortArea(d: DriverInfo, N: number, volL: number, fbHz: number, notes: string[], what: string): number {
  const vd = (d.sdCm2 / 1e4) * (d.xmaxMm / 1000) * N;
  const need = (2 * Math.PI * fbHz * vd) / 17;
  const maxLen = 0.7; // m — longer than this rarely fits and starts to pipe-resonate in band
  const maxArea = (maxLen * (volL / 1000)) / (C / (2 * Math.PI * fbHz)) ** 2;
  const minArea = Math.PI * 0.0175 ** 2; // a 35 mm tube
  let a = Math.max(need, minArea);
  if (a > maxArea) {
    notes.push(
      `The ${what} would need ${(need * 1e4).toFixed(0)} cm² to stay quiet at full excursion, but in this chamber that is longer than ~${maxLen * 1000} mm; it is sized to fit — expect port noise when pushed (a slot port or a bigger chamber helps).`
    );
    a = Math.max(maxArea, minArea);
  }
  return a;
}

/** P² at the −3 dB point of a 2nd-order low-pass prototype with quality factor q (|H|² = ½). */
function protoEdgeY(q: number) {
  const a = 2 - 1 / (q * q);
  return (a + Math.sqrt(a * a + 4)) / 2;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * 4th-order bandpass for a target passband (fLow–fHigh, −3 dB).
 *
 * The lossless bp4 response is a 2nd-order low-pass prototype mapped to a bandpass; the
 * design form is Dickason's (Loudspeaker Design Cookbook, after Geddes):
 *   the rear chamber sets the closed-box Qbp = Qts·√(1 + Vas/Vr), centre f0 = Fs·Qbp/Qts;
 *   the front chamber is tuned to Fb = f0 and its size sets the bandwidth: Vf = (2·S·Qts)²·Vas,
 *   S = 1/(2·QL) (S = 0.7 flat, 0.6 → 0.35 dB, 0.5 → 1.25 dB ripple);
 *   b = 1/(2·S·Qbp), Fl,Fh = Fb·(√(b²y + 4) ∓ b√y)/2 (y = 1 for a flat S = 0.7);
 *   passband gain over the bare driver: 40·log10(2·S·Qbp).
 * The absolute bandwidth Fh − Fl ≈ (Fs/Qts)·QL·√y is set by the driver, so the target is met
 * with S between 0.7 (flat) and 1.0 (over-damped), Qbp between 1.05 and 4.5 × Qts; outside
 * that the helper says so and returns the nearest buildable box. The −3 dB points returned
 * are the modelled ones (with leakage and voice-coil inductance), not the ideal ones.
 */
export function designBandpass4(d: DriverInfo, count: number, target: { fLowHz: number; fHighHz: number }): BandpassDesign {
  const N = Math.max(1, Math.round(count));
  const notes: string[] = [];
  const qts = d.qts;
  const fs = d.fsHz;
  const vas = d.vasL * N;
  const fl = Math.min(target.fLowHz, target.fHighHz);
  const fh = Math.max(target.fLowHz, target.fHighHz, fl * 1.2);
  // bandwidth → QL (g is monotonic in QL)
  const g = (q: number) => q * Math.sqrt(protoEdgeY(q));
  const want = ((fh - fl) * qts) / fs;
  const qLo = 0.5;
  const qHi = Math.SQRT1_2;
  let qL: number;
  if (want < g(qLo) * 0.995) {
    qL = qLo;
    notes.push(`This driver's narrowest 4th-order passband is ~${((fs / qts) * g(qLo)).toFixed(0)} Hz wide (its Fs/Qts sets it); the box is designed for that.`);
  } else if (want > g(qHi) * 1.005) {
    qL = qHi;
    notes.push(`This driver covers at most ~${((fs / qts) * g(qHi)).toFixed(0)} Hz of flat 4th-order bandwidth (its Fs/Qts sets it); for a wider band use a 6th-order bandpass or a vented box.`);
  } else {
    let lo = qLo;
    let hi = qHi;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (g(m) < want) lo = m;
      else hi = m;
    }
    qL = (lo + hi) / 2;
  }
  const f0Want = Math.sqrt(fl * fh);
  const qbp = clamp((f0Want * qts) / fs, qts * 1.05, qts * 4.5);
  const f0 = (qbp * fs) / qts;
  if (Math.abs(f0 - f0Want) > 0.5)
    notes.push(`A passband centred at ${f0Want.toFixed(0)} Hz would need ${f0Want < f0 ? 'an endless' : 'a vanishingly small'} rear chamber with this driver; it is centred at ${f0.toFixed(0)} Hz instead.`);
  const rearL = clamp(vas / ((qbp / qts) ** 2 - 1), 0.3, 2000);
  const frontL = clamp((vas * qts * qts) / (qL * qL), 0.3, 2000);
  const portAreaM2 = bpPortArea(d, N, frontL, f0, notes, 'port');
  const spec = { kind: 'bp4' as const, rearL, frontL, fbHz: f0, portAreaM2 };
  const r = runModel({ driver: d, count: N, box: spec, powerW: 1, f0: Math.max(5, fl / 4), f1: Math.max(500, fh * 3), n: 220 });
  return {
    spec,
    fLowHz: f3Of(r),
    fHighHz: f3HighOf(r),
    gainDb: r.sensitivity283 - (sensitivityFromTS(d) + 20 * Math.log10(N)),
    portLengthMm: [bandpassPortLengthMm(frontL, f0, portAreaM2)],
    s: 1 / (2 * qL),
    qbp,
    notes,
  };
}

/** Nelder–Mead on a few parameters (small, deterministic). */
function nelderMead(fn: (x: number[]) => number, x0: number[], step: number, iters: number): { x: number[]; f: number } {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))].map((x) => ({ x, f: fn(x) }));
  for (let k = 0; k < iters; k++) {
    simplex.sort((a, b) => a.f - b.f);
    const best = simplex[0];
    const worst = simplex[n];
    const cen = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const at = (t: number) => cen.map((c, j) => c + t * (worst.x[j] - c));
    const xr = at(-1);
    const fr = fn(xr);
    if (fr < best.f) {
      const xe = at(-2);
      const fe = fn(xe);
      simplex[n] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr };
    } else if (fr < simplex[n - 1].f) simplex[n] = { x: xr, f: fr };
    else {
      const xc = at(0.5);
      const fc = fn(xc);
      if (fc < worst.f) simplex[n] = { x: xc, f: fc };
      else
        simplex = simplex.map((p, i) => {
          if (i === 0) return p;
          const x = p.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j]));
          return { x, f: fn(x) };
        });
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0];
}

/**
 * 6th-order (series-tuned) bandpass for a target passband: both chambers vented, sound from
 * both ports. Rather than an idealised alignment table, this fits the four box parameters
 * (Vr, Vf, rear Fb, front Fb) to a 3rd-order Butterworth bandpass target (−3 dB at fLow and
 * fHigh) through the same lumped model the graphs use, starting from the bp4 design (rear
 * tuned low, front tuned high). Chambers stay within 0.3 L – 6·Vas, tunings within
 * 0.5·fLow – 2·fHigh; port areas follow the vented planner's 17 m/s rule, capped to fit.
 */
export function designBandpass6(d: DriverInfo, count: number, target: { fLowHz: number; fHighHz: number }): BandpassDesign {
  const N = Math.max(1, Math.round(count));
  const notes: string[] = [];
  const fl = Math.min(target.fLowHz, target.fHighHz);
  const fh = Math.max(target.fLowHz, target.fHighHz, fl * 1.3);
  const f0 = Math.sqrt(fl * fh);
  const beta = (fh - fl) / f0;
  const vMax = Math.max(6 * d.vasL * N, 5);
  const freqs = logFreqs(fl / 2.5, fh * 2.5, 48);
  const tgt = freqs.map((f) => Math.max(-25, -10 * Math.log10(1 + ((f / f0 - f0 / f) / beta) ** 6)));
  const inBand = freqs.map((f) => f >= fl && f <= fh);
  const unpack = (x: number[]) => ({
    rearL: clamp(Math.exp(x[0]), 0.3, vMax),
    frontL: clamp(Math.exp(x[1]), 0.3, vMax),
    fbRearHz: clamp(Math.exp(x[2]), fl * 0.5, fh * 2),
    fbFrontHz: clamp(Math.exp(x[3]), fl * 0.5, fh * 2),
  });
  // the port mass is set from the tuning, so area doesn't change the response: any value fits
  const spec6 = (p: ReturnType<typeof unpack>, ra = 0.005, fa = 0.005) => ({ kind: 'bp6' as const, ...p, rearPortAreaM2: ra, frontPortAreaM2: fa });
  const cost = (x: number[]) => {
    const r = runModel({ driver: d, count: N, box: spec6(unpack(x)), powerW: 1, f0: freqs[0], f1: freqs[freqs.length - 1], n: freqs.length });
    let off = 0;
    let k = 0;
    r.spl283.forEach((y, i) => {
      if (inBand[i]) {
        off += y - tgt[i];
        k++;
      }
    });
    off /= Math.max(k, 1);
    let c = 0;
    r.spl283.forEach((y, i) => {
      const e = Math.max(y - off, -25) - tgt[i];
      c += e * e * (inBand[i] ? 2 : 1);
    });
    return c;
  };
  const b4 = designBandpass4(d, N, { fLowHz: fl, fHighHz: fh });
  let best: { x: number[]; f: number } | null = null;
  for (const vr of [b4.spec.rearL, b4.spec.rearL * 3])
    for (const fr of [fl * 0.9, fl * 1.3])
      for (const ff of [f0 * 1.2, fh * 0.8]) {
        const res = nelderMead(cost, [Math.log(vr), Math.log(b4.spec.frontL), Math.log(fr), Math.log(ff)], 0.3, 140);
        if (!best || res.f < best.f) best = res;
      }
  const p = unpack(nelderMead(cost, best!.x, 0.08, 160).x);
  const fa = bpPortArea(d, N, p.frontL, p.fbFrontHz, notes, 'front port');
  const ra = bpPortArea(d, N, p.rearL, p.fbRearHz, notes, 'rear port');
  const spec = spec6(p, ra, fa);
  const r = runModel({ driver: d, count: N, box: spec, powerW: 1, f0: Math.max(5, fl / 4), f1: Math.max(500, fh * 3), n: 220 });
  const fLowHz = f3Of(r);
  const fHighHz = f3HighOf(r);
  if (Math.abs(Math.log(fLowHz / fl)) > 0.2 || fHighHz == null || Math.abs(Math.log(fHighHz / fh)) > 0.2)
    notes.push(`The closest this driver gets to ${fl.toFixed(0)}–${fh.toFixed(0)} Hz is ${fLowHz.toFixed(0)}–${fHighHz?.toFixed(0) ?? '?'} Hz.`);
  return {
    spec,
    fLowHz,
    fHighHz,
    gainDb: r.sensitivity283 - (sensitivityFromTS(d) + 20 * Math.log10(N)),
    portLengthMm: [bandpassPortLengthMm(p.frontL, p.fbFrontHz, fa), bandpassPortLengthMm(p.rearL, p.fbRearHz, ra)],
    notes,
  };
}

/**
 * A sensible starting passband for a bandpass with this driver: the flat (S = 0.7) bp4 with
 * a rear chamber of Vas/2, i.e. Qbp = Qts·√3, centred at Fs·√3.
 */
export function defaultBandpassTargets(d: DriverInfo): { fLowHz: number; fHighHz: number } {
  const qbp = d.qts * Math.sqrt(3);
  const f0 = d.fsHz * Math.sqrt(3);
  const b = Math.SQRT1_2 / qbp;
  return { fLowHz: (f0 * (Math.sqrt(b * b + 4) - b)) / 2, fHighHz: (f0 * (Math.sqrt(b * b + 4) + b)) / 2 };
}

/** Reference efficiency → 2.83 V / 1 m half-space sensitivity implied by the T/S numbers. */
export function sensitivityFromTS(d: DriverInfo): number {
  const m = tsToMech(d);
  const eta0 = (RHO / (2 * Math.PI * C)) * ((m.Bl * m.Bl * m.Sd * m.Sd) / (m.Re * m.Mms * m.Mms));
  // half-space 1 W into Re, then 2.83 V into Re delivers 8/Re W
  return 112.16 + 10 * Math.log10(eta0) + 10 * Math.log10(8 / m.Re);
}
