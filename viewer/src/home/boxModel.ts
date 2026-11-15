// WinISD-style box modeler: a lumped electro-mechano-acoustic model of a
// woofer in a sealed or vented box, driven by an amplifier of a given power.
//
//   amp ── Re + jωLe ──[ Bl ]── Mms, Cms, Rms ──[ Sd ]── box (Cab ‖ Ral ‖ port Map)
//
// Everything is solved per frequency in closed form:
//   cone velocity  u = Bl·V / ( Ze·(Zm + Sd²·Zrear) + Bl² )
//   box pressure   pb = −Sd·u·Zrear        (cone out → box pressure drops)
//   port flow      Up = pb / Zport          (out of the box)
//   radiated flow  U = Sd·u + Up + Ul    (Ul = pb/Ral, the box leak)
//   SPL at 1 m     p = ρ·ω·|U| / (2π·r)     (half space, like a datasheet's
//                                           baffle measurement and WinISD)
//
// Mms from a datasheet already includes the front air load, so no extra
// radiation mass is added. Several woofers in one box are wired in parallel
// and share the box and port: by symmetry each behaves like one driver in
// Vb/N with port area Sp/N, so we solve one and scale.

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

export type BoxSpec =
  | { kind: 'sealed'; netL: number; ql?: number; fill?: number }
  | { kind: 'vented'; netL: number; fbHz: number; portAreaM2: number; ql?: number };

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
  maxSplLimit: ('xmax' | 'power' | 'port')[];
  voltsRms: number;
  nominalOhm: number;
  ratedPowerW: number;
  xmaxMm: number;
  /** passband sensitivity, 2.83 V / 1 m, half space (dB) */
  sensitivity283: number;
  /** lowest impedance above the bass peak — what the amp must drive */
  minImpedance: { ohm: number; hz: number };
  mech: MechParams;
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

  // per-driver share of the box
  const fill = inp.box.kind === 'sealed' ? (inp.box.fill ?? 0) : 0;
  // fibre fill: ~15 % more effective volume, and absorption losses on top of the leak
  const Vb = (inp.box.netL * (1 + 0.15 * fill)) / 1000 / N;
  const portNoise = inp.portNoiseMs ?? 17;
  const placeF = placementFactor(inp, freqs);
  const Cab = Vb / (RHO * C * C);
  const vented = inp.box.kind === 'vented' ? inp.box : null;
  const ql = inp.box.ql ?? (vented ? 7 : 1 / (1 / 50 + fill / 8));
  const wb = vented ? 2 * Math.PI * vented.fbHz : 2 * Math.PI * d.fsHz;
  // leakage/absorption as a resistance across the box compliance (Small: Ql = ωb·Cab·Ral)
  const Ral = ql / (wb * Cab);
  // port mass chosen so the box really tunes to fb
  const Map = vented ? 1 / (wb * wb * Cab) : 0;
  const Sp = vented ? vented.portAreaM2 / N : 0;

  const spl: number[] = [];
  const spl283: number[] = [];
  const exc: number[] = [];
  const pv: number[] = [];
  const zMag: number[] = [];
  const zPh: number[] = [];
  const maxSpl: number[] = [];
  const maxLim: ('xmax' | 'power' | 'port')[] = [];
  const phase: number[] = [];
  const Hc: Cx[] = [];

  for (const f of freqs) {
    const w = 2 * Math.PI * f;
    const Ze = cx(m.Re, w * m.Le);
    const Zm = cx(m.Rms, w * m.Mms - 1 / (w * m.Cms));
    const Yc = cx(1 / Ral, w * Cab);
    const Zport = vented ? cx(0, w * Map) : null;
    const Zrear = inv(Zport ? add(Yc, inv(Zport)) : Yc);
    const Zmot = add(Zm, scl(Zrear, m.Sd * m.Sd));
    // per volt, unfiltered
    const u1 = div(cx(m.Bl), add(mul(Ze, Zmot), cx(m.Bl * m.Bl)));
    const pb1 = scl(mul(Zrear, u1), -m.Sd);
    const Up1 = Zport ? div(pb1, Zport) : cx(0);
    // Small's Q_L is a leak: its flow escapes the box and radiates too, so at
    // DC cone + port + leak cancel exactly
    const Ul1 = scl(pb1, 1 / Ral);
    const U1 = add(add(scl(u1, m.Sd), Up1), Ul1);
    // p(1 m, half space) per volt, for the whole group, then where it is placed
    const p1 = mul(scl(mul(cx(0, w), U1), (RHO * N) / (2 * Math.PI)), placeF[freqs.indexOf(f)]);
    const Zin = scl(add(Ze, div(cx(m.Bl * m.Bl), Zmot)), 1 / N);

    const H = inp.highPass ? highPassH(inp.highPass, f) : cx(1);
    const V = scl(H, voltsRms);
    Hc.push(p1);
    const p = mul(p1, V);
    const u = mul(u1, V);
    const Up = mul(Up1, V);

    const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12) / P_REF);
    spl.push(db(abs(p)));
    spl283.push(db(abs(p1) * 2.83));
    exc.push(((abs(u) * Math.SQRT2) / w) * 1000);
    pv.push(vented ? (abs(Up) * Math.SQRT2) / Sp : NaN);
    zMag.push(abs(Zin));
    zPh.push((arg(Zin) * 180) / Math.PI);
    phase.push(arg(mul(p1, H)));

    // max output: scale the (filtered) drive until either the cone reaches Xmax
    // or the electrical power reaches the rating
    const hMag = abs(H);
    const xPerVolt = (abs(u1) * hMag * Math.SQRT2) / w;
    const vByX = xmax / Math.max(xPerVolt, 1e-15); // amp volts (rms, before filter)
    const vByP = Math.sqrt(ratedPowerW * nominalOhm);
    const portPerVolt = vented ? (abs(Up1) * hMag * Math.SQRT2) / Sp : 0;
    const vByPort = portPerVolt > 0 ? portNoise / portPerVolt : Infinity;
    const vLim = Math.min(vByX, vByP, vByPort);
    maxSpl.push(db(abs(p1) * hMag * vLim));
    maxLim.push(vLim === vByPort ? 'port' : vByX < vByP ? 'xmax' : 'power');
  }

  // group delay = −dφ/dω, with phase unwrapped
  const un = [...phase];
  for (let i = 1; i < un.length; i++) {
    while (un[i] - un[i - 1] > Math.PI) un[i] -= 2 * Math.PI;
    while (un[i] - un[i - 1] < -Math.PI) un[i] += 2 * Math.PI;
  }
  const gd = freqs.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(freqs.length - 1, i + 1);
    const dw = 2 * Math.PI * (freqs[b] - freqs[a]);
    return (-(un[b] - un[a]) / dw) * 1000;
  });

  // passband sensitivity: plateau where the response has flattened out
  const pass = spl283.filter((_, i) => freqs[i] > Math.max(4 * d.fsHz, 150) && freqs[i] < 400);
  const sensitivity283 = pass.length ? pass.reduce((s, x) => s + x, 0) / pass.length : spl283[spl283.length - 1];

  // the impedance minimum above the (highest) bass peak
  let peakI = 0;
  for (let i = 0; i < freqs.length && freqs[i] < Math.max(2.5 * d.fsHz, 120); i++) if (zMag[i] > zMag[peakI]) peakI = i;
  let minI = peakI;
  for (let i = peakI; i < freqs.length; i++) if (zMag[i] < zMag[minI]) minI = i;

  return {
    freqs,
    H: Hc,
    spl,
    spl283,
    excursionMm: exc,
    portVelocity: vented ? pv : [],
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
  const b = box.kind === 'vented' ? `vented ${box.netL.toFixed(0)} L @ ${box.fbHz.toFixed(0)} Hz` : `sealed ${box.netL.toFixed(0)} L`;
  return `${n}${driver.model} · ${b}`;
}

/** −3 dB point of the 2.83 V curve relative to its passband. */
export function f3Of(r: ModelResult): number {
  for (let i = 0; i < r.freqs.length; i++) if (r.spl283[i] >= r.sensitivity283 - 3) return r.freqs[i];
  return r.freqs[r.freqs.length - 1];
}

/** Reference efficiency → 2.83 V / 1 m half-space sensitivity implied by the T/S numbers. */
export function sensitivityFromTS(d: DriverInfo): number {
  const m = tsToMech(d);
  const eta0 = (RHO / (2 * Math.PI * C)) * ((m.Bl * m.Bl * m.Sd * m.Sd) / (m.Re * m.Mms * m.Mms));
  // half-space 1 W into Re, then 2.83 V into Re delivers 8/Re W
  return 112.16 + 10 * Math.log10(eta0) + 10 * Math.log10(8 / m.Re);
}
