// Physics checks for the passive-radiator and bandpass boxes (pure module, no browser).
// Limiting cases against the sealed/vented model (itself checked against Small 1973),
// the PR tuning/null relations (Hurlburt, JAES 2000) and the classic bp4 alignment
// (Dickason, Loudspeaker Design Cookbook).
import { test, expect } from '@playwright/test';
import { DRIVERS, type DriverInfo } from '../src/home/drivers';
import {
  PR_PRESETS,
  boxLabel,
  boxNetL,
  defaultBandpassTargets,
  designBandpass4,
  designBandpass6,
  f3HighOf,
  f3Of,
  prMassForTuning,
  prMech,
  prTuningHz,
  runModel,
  suggestPr,
  type BoxSpec,
  type ModelInput,
  type PassiveRadiator,
} from '../src/home/boxModel';
import { boxResponse } from '../src/home/roomAcoustics';

const base = DRIVERS.find((d) => d.id === 'sb17nrx2c35-8')!;
// no voice-coil inductance, so the textbook (Le = 0) formulas apply exactly
const woofer: DriverInfo = { ...base, leMh: 0 };
const sub = DRIVERS.find((d) => d.id === 'rss265ho-4')!;
const run = (box: BoxSpec, o: Partial<ModelInput> = {}) => runModel({ driver: woofer, count: 1, box, powerW: 1, f0: 8, f1: 1000, n: 400, ...o });
const at = (r: { freqs: number[] }, ys: number[], f: number) => ys[r.freqs.findIndex((x) => x >= f)];
const argMin = (r: { freqs: number[] }, ys: number[], lo: number, hi: number) => {
  let k = -1;
  r.freqs.forEach((f, i) => {
    if (f >= lo && f <= hi && (k < 0 || ys[i] < ys[k])) k = i;
  });
  return r.freqs[k];
};
const argMax = (r: { freqs: number[] }, ys: number[], lo: number, hi: number) => argMin(r, ys.map((y) => -y), lo, hi);
const maxDiff = (a: number[], b: number[], keep: (i: number) => boolean) => Math.max(...a.map((x, i) => (keep(i) ? Math.abs(x - b[i]) : 0)));
const pr8 = PR_PRESETS.find((p) => p.id === 'pr-8')!;

test('vented model still matches Small (1973) with losses (regression for the generalised chambers)', () => {
  const vb = 25;
  const fb = 38;
  const r = run({ kind: 'vented', netL: vb, fbHz: fb, portAreaM2: 0.003, ql: 7 }, { f1: 2000 });
  const ref = r.spl283[r.freqs.findIndex((f) => f >= 1500)];
  const al = { kind: 'vented' as const, fsHz: woofer.fsHz, fbHz: fb, qts: woofer.qts, alpha: woofer.vasL / vb, ql: 7 };
  r.freqs.forEach((f, i) => {
    if (f < 15 || f > 300) return;
    const h = boxResponse(al, f);
    const small = 20 * Math.log10(Math.hypot(h.re, h.im));
    expect(Math.abs(r.spl283[i] - ref - small)).toBeLessThan(0.25);
  });
});

test('PR: tuning helper round-trips, and Fp = 1/(2π√(Map·(Cab‖Cap)))', () => {
  for (const pr of PR_PRESETS) {
    for (const [netL, fp] of [
      [15, 40],
      [40, 30],
    ]) {
      const m = prMassForTuning(netL, pr, 2, fp);
      if (!m.reachable) continue;
      expect(m.fpHz).toBeCloseTo(fp, 6);
      expect(prTuningHz(netL, pr, 2, m.addedMassG)).toBeCloseTo(fp, 6);
      // the loaded radiator's own resonance (the response null) is always below the box tuning
      expect(m.nullHz).toBeLessThan(fp);
    }
  }
  // an already-heavy PR can't tune high: no negative mass, and it says where it lands
  const heavy = prMassForTuning(10, PR_PRESETS[3], 1, 200);
  expect(heavy.reachable).toBe(false);
  expect(heavy.addedMassG).toBe(0);
  expect(heavy.fpHz).toBeLessThan(200);
  // fs- and Cms-specified suspensions agree
  const m1 = prMech(pr8);
  const viaFs: PassiveRadiator = { ...pr8, cmsMmPerN: undefined, fsHz: m1.fs0 };
  expect(prMech(viaFs).Cmp).toBeCloseTo(m1.Cmp, 9);
  // suggestions displace at least twice the woofer
  for (const d of [base, sub]) {
    const s = suggestPr(d, 1);
    expect(s.pr.sdCm2 * s.pr.xmaxMm * s.prCount).toBeGreaterThanOrEqual(2 * d.sdCm2 * d.xmaxMm);
  }
});

test('PR box tuned to Fp: cone-excursion null at Fp, radiator does the work there, response null at the PR resonance', () => {
  const netL = 25;
  const fp = 35;
  const { addedMassG, nullHz } = prMassForTuning(netL, pr8, 1, fp);
  const r = run({ kind: 'pr', netL, pr: pr8, prCount: 1, addedMassG });
  // cone excursion minimum at the box tuning (like a vented box at fb)
  expect(Math.abs(argMin(r, r.excursionMm, 15, 100) / fp - 1)).toBeLessThan(0.03);
  // ...where the radiator moves several times the cone's air (volume displacement Sd·x)
  expect(pr8.sdCm2 * at(r, r.prExcursionMm!, fp)).toBeGreaterThan(4 * woofer.sdCm2 * at(r, r.excursionMm, fp));
  // PR excursion peaks between its own resonance and the tuning, and falls 12 dB/oct above
  const prPeak = argMax(r, r.prExcursionMm!, 10, 200);
  expect(prPeak).toBeGreaterThan(nullHz * 0.95);
  expect(prPeak).toBeLessThan(fp * 1.1);
  const x2 = at(r, r.prExcursionMm!, 4 * fp) / at(r, r.prExcursionMm!, 8 * fp);
  expect(x2).toBeGreaterThan(5);
  // the radiator and cone cancel at the loaded PR's free-air resonance: a deep notch
  const notch = argMin(r, r.spl283, 8, fp);
  expect(Math.abs(notch / nullHz - 1)).toBeLessThan(0.05);
  expect(at(r, r.spl283, notch)).toBeLessThan(r.sensitivity283 - 25);
  // impedance: two peaks with the dip near Fp, like a vented box
  const z = r.impedance;
  const peaks = r.freqs.filter((f, i) => f > 10 && f < 300 && i > 0 && z[i] > z[i - 1] && z[i] > z[i + 1]);
  expect(peaks.length).toBe(2);
  const dip = argMin(r, z, peaks[0], peaks[1]);
  expect(Math.abs(dip / fp - 1)).toBeLessThan(0.08);
  expect(r.prXmaxMm).toBe(pr8.xmaxMm);
  expect(boxLabel(woofer, 1, { kind: 'pr', netL, pr: pr8, prCount: 1, addedMassG })).toContain('PR 25 L @ 35 Hz');
});

test('PR limits: Sd → 0 is the sealed box; a huge mass is the sealed box; a limp heavy PR is the vented box', () => {
  const netL = 20;
  const sealedQl = 20;
  const sealed = run({ kind: 'sealed', netL, ql: sealedQl });
  // Ql is referenced to the tuning (Small); equal leak resistance means ql scaled by f_ref
  const tiny: PassiveRadiator = { ...pr8, sdCm2: 1e-4 };
  const fpTiny = prTuningHz(netL, tiny, 1, 0);
  const r0 = run({ kind: 'pr', netL, pr: tiny, prCount: 1, addedMassG: 0, ql: (sealedQl * fpTiny) / woofer.fsHz });
  expect(maxDiff(r0.spl283, sealed.spl283, () => true)).toBeLessThan(0.01);
  expect(maxDiff(r0.excursionMm, sealed.excursionMm, () => true)).toBeLessThan(1e-3);
  expect(maxDiff(r0.impedance, sealed.impedance, () => true)).toBeLessThan(1e-3);

  const fpHeavy = prTuningHz(netL, pr8, 1, 1e7);
  const r1 = run({ kind: 'pr', netL, pr: pr8, prCount: 1, addedMassG: 1e7, ql: (sealedQl * fpHeavy) / woofer.fsHz });
  expect(maxDiff(r1.spl283, sealed.spl283, (i) => r1.freqs[i] > 12)).toBeLessThan(0.05);

  // a PR with almost no suspension and no loss is an acoustic mass — a port
  const fb = 36;
  const limp: PassiveRadiator = { ...pr8, cmsMmPerN: 1e6, qm: 1e9 };
  const { addedMassG } = prMassForTuning(netL, limp, 1, fb);
  const pr = run({ kind: 'pr', netL, pr: limp, prCount: 1, addedMassG, ql: 7 });
  const vented = run({ kind: 'vented', netL, fbHz: fb, portAreaM2: limp.sdCm2 / 1e4, ql: 7 });
  expect(maxDiff(pr.spl283, vented.spl283, () => true)).toBeLessThan(0.05);
  expect(maxDiff(pr.excursionMm, vented.excursionMm, () => true)).toBeLessThan(0.01);
});

test('PR excursion limits max SPL when the radiator is the weak link', () => {
  const small: PassiveRadiator = { ...PR_PRESETS[0], xmaxMm: 2 };
  const { addedMassG } = prMassForTuning(25, small, 1, 35);
  const r = run({ kind: 'pr', netL: 25, pr: small, prCount: 1, addedMassG }, { powerW: 100 });
  expect(r.maxSplLimit.filter((l, i) => l === 'pr' && r.freqs[i] < 60).length).toBeGreaterThan(5);
  const roomy = run({ kind: 'pr', netL: 25, pr: { ...small, xmaxMm: 50 }, prCount: 1, addedMassG }, { powerW: 100 });
  expect(at(roomy, roomy.maxSpl, 35)).toBeGreaterThan(at(r, r.maxSpl, 35) + 3);
});

test('bp4: an endless front chamber is the sealed rear box behind a 2nd-order low-pass at Fb', () => {
  const rearL = 12;
  const fb = 70;
  const ql = 1e6; // lossless, so the two boxes' leak references don't matter
  const bp = run({ kind: 'bp4', rearL, frontL: 1e6, fbHz: fb, portAreaM2: 0.003, ql });
  const sealed = run({ kind: 'sealed', netL: rearL, ql });
  bp.freqs.forEach((f, i) => {
    if (Math.abs(Math.log(f / fb)) < 0.5) return;
    const lp = -20 * Math.log10(Math.abs(1 - (f / fb) ** 2));
    expect(Math.abs(bp.spl283[i] - (sealed.spl283[i] + lp))).toBeLessThan(0.05);
  });
  // the front chamber is transparent to the cone: same excursion and impedance as sealed
  expect(maxDiff(bp.excursionMm, sealed.excursionMm, () => true)).toBeLessThan(1e-3);
  expect(boxNetL({ kind: 'bp4', rearL, frontL: 8, fbHz: fb, portAreaM2: 0.003 })).toBe(20);
});

test('bp4 design (Dickason): −3 dB points and passband gain land on the targets', () => {
  for (const d of [woofer, base, sub]) {
    const t = defaultBandpassTargets(d);
    const des = designBandpass4(d, 1, t);
    expect(des.notes.filter((n) => !n.includes('port'))).toEqual([]);
    expect(Math.abs(des.fLowHz / t.fLowHz - 1)).toBeLessThan(0.08);
    expect(Math.abs(des.fHighHz! / t.fHighHz - 1)).toBeLessThan(0.08);
    expect(des.s).toBeCloseTo(Math.SQRT1_2, 3);
    // the textbook relations behind it
    expect(des.spec.rearL).toBeCloseTo(d.vasL / ((des.qbp! / d.qts) ** 2 - 1), 6);
    expect(des.spec.frontL).toBeCloseTo((2 * des.s! * d.qts) ** 2 * d.vasL, 6);
    expect(des.spec.fbHz).toBeCloseTo((des.qbp! * d.fsHz) / d.qts, 6);
  }
  // lossless & no Le: the passband sits 40·log10(2·S·Qbp) above the driver on an infinite baffle
  const des = designBandpass4(woofer, 1, defaultBandpassTargets(woofer));
  const bp = run({ ...des.spec, ql: 1e6 }, { f1: 3000 });
  const ib = run({ kind: 'sealed', netL: 1e7, ql: 1e6 }, { f1: 3000 });
  const plateau = at(ib, ib.spl283, 2000);
  expect(Math.abs(bp.sensitivity283 - plateau - 40 * Math.log10(2 * des.s! * des.qbp!))).toBeLessThan(0.3);
  // ...and the ideal (lossless) −3 dB points are the analytic ones within 2 %
  const b = 1 / (2 * des.s! * des.qbp!);
  const f0 = des.spec.fbHz;
  expect(Math.abs(f3Of(bp) / ((f0 * (Math.sqrt(b * b + 4) - b)) / 2) - 1)).toBeLessThan(0.02);
  expect(Math.abs(f3HighOf(bp)! / ((f0 * (Math.sqrt(b * b + 4) + b)) / 2) - 1)).toBeLessThan(0.02);
});

test('bp4 design: an impossible target is clamped to a buildable box and explained', () => {
  // far wider than the driver's Fs/Qts allows, centred below Fs
  const des = designBandpass4(base, 1, { fLowHz: 15, fHighHz: 30 });
  expect(des.notes.length).toBeGreaterThan(0);
  expect(des.spec.rearL).toBeGreaterThan(0.3);
  expect(des.spec.rearL).toBeLessThan(25 * base.vasL);
  expect(des.spec.frontL).toBeGreaterThan(0.3);
  expect(des.spec.fbHz).toBeGreaterThan(base.fsHz);
  expect(des.portLengthMm[0]).toBeGreaterThan(0);
});

test('bandpass: sound only from the ports; DC output vanishes; impedance tends to Re; ports reported per port', () => {
  const des4 = designBandpass4(base, 1, defaultBandpassTargets(base));
  const r4 = runModel({ driver: base, count: 1, box: des4.spec, powerW: 10, f0: 5, f1: 2000, n: 300 });
  expect(r4.ports?.length).toBe(1);
  expect(r4.spl283[0]).toBeLessThan(r4.sensitivity283 - 40);
  // far above the passband the output keeps falling (12 dB/oct from the port; the
  // front-chamber leak lets a little through at 6 dB/oct) — the cone itself is not heard
  expect(at(r4, r4.spl283, 1600)).toBeLessThan(at(r4, r4.spl283, 400) - 15);
  const tight = runModel({ driver: base, count: 1, box: { ...des4.spec, ql: 1e6 }, powerW: 10, f0: 5, f1: 2000, n: 300 });
  expect(at(tight, tight.spl283, 1600)).toBeLessThan(at(tight, tight.spl283, 400) - 22);
  expect(r4.impedance[r4.impedance.length - 1]).toBeLessThan(base.reOhm * 1.6);
  // velocity from the model matches U_port/Sp
  expect(r4.portVelocity).toEqual(r4.ports![0].velocity);

  const des6 = designBandpass6(base, 1, { fLowHz: 40, fHighHz: 150 });
  const r6 = runModel({ driver: base, count: 1, box: des6.spec, powerW: 10, f0: 5, f1: 1000, n: 300 });
  expect(r6.ports?.map((p) => p.label)).toEqual(['Front port', 'Rear port']);
  // the rear port carries the low end, the front port the top
  const rearLow = at(r6, r6.ports![1].velocity, des6.spec.fbRearHz);
  const frontLow = at(r6, r6.ports![0].velocity, des6.spec.fbRearHz);
  expect(rearLow).toBeGreaterThan(frontLow);
  expect(r6.spl283[0]).toBeLessThan(r6.sensitivity283 - 40);
  r6.freqs.forEach((_, i) => expect(r6.portVelocity[i]).toBeCloseTo(Math.max(r6.ports![0].velocity[i], r6.ports![1].velocity[i]), 9));
  expect(boxNetL(des6.spec)).toBeCloseTo(des6.spec.rearL + des6.spec.frontL, 9);
});

test('bp6: a rear port that never tunes is the bp4; the design helper hits its passband', () => {
  const common = { rearL: 15, frontL: 9, ql: 1e6 };
  const bp4 = run({ kind: 'bp4', ...common, fbHz: 75, portAreaM2: 0.003 });
  const bp6 = run({ kind: 'bp6', ...common, fbFrontHz: 75, fbRearHz: 0.05, frontPortAreaM2: 0.003, rearPortAreaM2: 0.003 });
  expect(maxDiff(bp6.spl283, bp4.spl283, (i) => bp6.freqs[i] > 10)).toBeLessThan(0.05);

  for (const [d, t] of [
    [base, { fLowHz: 40, fHighHz: 150 }],
    [sub, { fLowHz: 25, fHighHz: 90 }],
  ] as const) {
    const des = designBandpass6(d, 1, t);
    expect(Math.abs(des.fLowHz / t.fLowHz - 1)).toBeLessThan(0.15);
    expect(Math.abs(des.fHighHz! / t.fHighHz - 1)).toBeLessThan(0.15);
    // physically sensible: positive chambers, rear tuned below front, ports that fit
    expect(des.spec.rearL).toBeGreaterThan(0.3);
    expect(des.spec.frontL).toBeGreaterThan(0.3);
    expect(des.spec.fbRearHz).toBeLessThan(des.spec.fbFrontHz);
    for (const l of des.portLengthMm) expect(l).toBeLessThan(720);
  }
});

test('several woofers share the bandpass and PR box like one in a 1/N share', () => {
  const des = designBandpass4(base, 2, defaultBandpassTargets(base));
  const two = runModel({ driver: base, count: 2, box: des.spec, powerW: 1, n: 120 });
  const half = runModel({ driver: base, count: 1, box: { ...des.spec, rearL: des.spec.rearL / 2, frontL: des.spec.frontL / 2, portAreaM2: des.spec.portAreaM2 / 2 }, powerW: 1, n: 120 });
  // twice the drivers on the same volts: +6 dB (half the impedance)
  expect(maxDiff(two.spl283.map((x) => x - 6.0206), half.spl283, () => true)).toBeLessThan(1e-6);
  const pr = { kind: 'pr' as const, netL: 40, pr: pr8, prCount: 2, addedMassG: 30 };
  const p2 = runModel({ driver: base, count: 2, box: pr, powerW: 1, n: 120 });
  const p1 = runModel({ driver: base, count: 1, box: { ...pr, netL: 20, prCount: 1 }, powerW: 1, n: 120 });
  expect(maxDiff(p2.prExcursionMm!, p1.prExcursionMm!.map((x) => x / Math.SQRT2), () => true)).toBeLessThan(1e-6);
});
