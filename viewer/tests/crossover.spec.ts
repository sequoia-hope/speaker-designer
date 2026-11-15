// Reference checks for the two-way crossover helper (pure module, no browser).
import { test, expect } from '@playwright/test';
import { DRIVERS } from '../src/home/drivers';
import type { DriverInfo } from '../src/home/drivers';
import { twoWaySum, bestTweeterDelayMs, biquads, evalBiquads, xoLowPass, xoHighPass, passiveNetwork, tweeterResponse } from '../src/home/crossover';
import type { XoOpts } from '../src/home/crossover';
import { logFreqs, toDb } from '../src/home/roomAcoustics';

const base = DRIVERS.find((d) => d.role === 'woofer')!;
const woofer: DriverInfo = { ...base, nominalOhm: 8, reOhm: 6, sensDb: 87, leMh: 0.5 };
// a "flat" tweeter: Fs far below anything we evaluate
const flatTweeter: DriverInfo = { ...base, role: 'tweeter', nominalOhm: 8, reOhm: 6, sensDb: 87, fsHz: 0.01, qts: 0.7071 };

const FC = 2000;
const freqs = logFreqs(FC / 10, FC * 10, 400);
const ones = freqs.map(() => ({ re: 1, im: 0 }));
const opts = (o: Partial<XoOpts>): XoOpts => ({ fcHz: FC, type: 'LR4', tweeterLevelDb: 0, tweeterOffsetMm: 0, invertTweeter: false, ...o });
const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));

test('LR4 with ideal flat drivers sums to 0 dB ± 0.1 dB', () => {
  const r = twoWaySum(freqs, ones, woofer, flatTweeter, opts({}));
  expect(maxAbs(r.sumDb)).toBeLessThan(0.1);
  // and the skipTweeterHp switch gives the same answer with a real tweeter Fs
  const r2 = twoWaySum(freqs, ones, woofer, { ...flatTweeter, fsHz: 900 }, opts({ skipTweeterHp: true }));
  expect(maxAbs(r2.sumDb)).toBeLessThan(0.1);
  // LR4 sections are in phase at every frequency
  expect(maxAbs(r.phaseDiffDeg)).toBeLessThan(0.01);
  // tweeter's own HP: unit gain in passband, Q-shaped at Fs
  expect(Math.abs(toDb(tweeterResponse({ ...flatTweeter, fsHz: 1000, qts: 0.5 }, 20000)))).toBeLessThan(0.05);
  expect(toDb(tweeterResponse({ ...flatTweeter, fsHz: 1000, qts: 0.5 }, 1000))).toBeCloseTo(20 * Math.log10(0.5), 3);
});

test('LR2 sums flat only with the tweeter inverted', () => {
  const inv = twoWaySum(freqs, ones, woofer, flatTweeter, opts({ type: 'LR2', invertTweeter: true }));
  expect(maxAbs(inv.sumDb)).toBeLessThan(0.1);
  const norm = twoWaySum([FC], [{ re: 1, im: 0 }], woofer, flatTweeter, opts({ type: 'LR2', invertTweeter: false }));
  expect(norm.sumDb[0]).toBeLessThan(-60);
  expect(norm.notes.some((n) => n.includes('inverted'))).toBe(true);
});

test('BW3 sums flat in magnitude', () => {
  const r = twoWaySum(freqs, ones, woofer, flatTweeter, opts({ type: 'BW3' }));
  expect(maxAbs(r.sumDb)).toBeLessThan(0.1);
});

test('biquads match the analog prototypes (fs 48 kHz, fc 2 kHz)', () => {
  const fs = 48000;
  for (const type of ['LR2', 'LR4', 'BW3'] as const) {
    const dsp = biquads(opts({ type }), fs);
    // Exact check: the bilinear transform maps digital f to analog fa = fc·tan(πf/fs)/tan(πfc/fs)
    // (pre-warped at fc), so the digital response must equal the prototype there.
    for (const f of logFreqs(20, 0.45 * fs, 200)) {
      const fa = (FC * Math.tan((Math.PI * f) / fs)) / Math.tan((Math.PI * FC) / fs);
      expect(Math.abs(toDb(evalBiquads(dsp.woofer, f, fs)) - toDb(xoLowPass(type, FC, fa)))).toBeLessThan(0.01);
      expect(Math.abs(toDb(evalBiquads(dsp.tweeter, f, fs)) - toDb(xoHighPass(type, FC, fa)))).toBeLessThan(0.01);
    }
    // Against the unwarped prototype: within 0.2 dB below fs/8 wherever the
    // section is within 12 dB of its passband (bilinear compression makes the
    // deep low-pass stopband steeper near fs/2 — that's expected, not an error).
    for (const f of logFreqs(20, fs / 8, 200)) {
      const lp = toDb(xoLowPass(type, FC, f));
      const hp = toDb(xoHighPass(type, FC, f));
      if (lp > -12) expect(Math.abs(toDb(evalBiquads(dsp.woofer, f, fs)) - lp), `${type} LP ${f.toFixed(0)} Hz`).toBeLessThan(0.2);
      if (hp > -12) expect(Math.abs(toDb(evalBiquads(dsp.tweeter, f, fs)) - hp), `${type} HP ${f.toFixed(0)} Hz`).toBeLessThan(0.2);
    }
  }
  const lr4 = biquads(opts({ type: 'LR4' }), fs);
  expect(lr4.woofer).toHaveLength(2);
  expect(lr4.summary[0]).toContain('Low-pass 2 kHz LR4 (two Butterworth biquads, Q 0.707)');
  const lr2 = biquads(opts({ type: 'LR2', delayTweeterMs: -0.1 }), fs);
  expect(lr2.woofer).toHaveLength(1);
  expect(lr2.delayWooferSamples).toBe(5);
  expect(lr2.delayTweeterSamples).toBe(0);
});

test('passive 2nd-order values for 8 Ω at 2 kHz match the textbook formulas', () => {
  const R = 8;
  const w = 2 * Math.PI * FC;
  // LR2 (Q = 0.5): L = 2R/ωc, C = 1/(2ωcR)  — i.e. 0.3183·R/f and 0.0796/(R·f)
  const lr2 = passiveNetwork(opts({ type: 'LR2' }), woofer, flatTweeter);
  expect(lr2.order).toBe(2);
  expect(lr2.woofer[0].kind).toBe('L');
  expect(lr2.woofer[0].value).toBeCloseTo(((2 * R) / w) * 1e3, 6); // ≈ 1.273 mH
  expect(lr2.woofer[0].value).toBeCloseTo(((0.3183 * R) / FC) * 1e3, 2);
  expect(lr2.woofer[1].value).toBeCloseTo((1 / (2 * w * R)) * 1e6, 6); // ≈ 4.97 µF
  expect(lr2.tweeter[0].kind).toBe('C');
  expect(lr2.tweeter[0].value).toBeCloseTo((1 / (2 * w * R)) * 1e6, 6);
  expect(lr2.tweeter[1].kind).toBe('L');
  expect(lr2.tweeter[1].value).toBeCloseTo(((2 * R) / w) * 1e3, 6);
  expect(lr2.invertTweeter).toBe(true);
  // 2nd-order Butterworth (Q = 0.707): L = √2·R/ωc = 0.2251·R/f, C = 1/(√2·ωc·R) = 0.1125/(R·f).
  // Check the generic Q formulas L = R/(ωcQ), C = Q/(ωcR) against those constants.
  const q = Math.SQRT1_2;
  expect(R / (w * q) * 1e3).toBeCloseTo(((0.2251 * R) / FC) * 1e3, 2);
  expect((q / (w * R)) * 1e6).toBeCloseTo((0.1125 / (R * FC)) * 1e6, 1);
  // LR4 (Dickason LDC table): LP 0.3001R/f, 0.2533/(Rf), 0.1500R/f, 0.0563/(Rf); HP 0.0844/(Rf), 0.1000R/f, 0.1688/(Rf), 0.4501R/f
  const lr4 = passiveNetwork(opts({ type: 'LR4' }), woofer, flatTweeter);
  const lp = [((0.3001 * R) / FC) * 1e3, (0.2533 / (R * FC)) * 1e6, ((0.15 * R) / FC) * 1e3, (0.0563 / (R * FC)) * 1e6];
  const hp = [(0.0844 / (R * FC)) * 1e6, ((0.1 * R) / FC) * 1e3, (0.1688 / (R * FC)) * 1e6, ((0.4501 * R) / FC) * 1e3];
  lr4.woofer.forEach((p, i) => expect(Math.abs(p.value / lp[i] - 1)).toBeLessThan(0.002));
  lr4.tweeter.forEach((p, i) => expect(Math.abs(p.value / hp[i] - 1)).toBeLessThan(0.002));
  // Zobel: Rz = 1.25·Re, Cz = Le/Rz²
  expect(lr2.wooferZobel![0].value).toBeCloseTo(7.5, 6);
  expect(lr2.wooferZobel![1].value).toBeCloseTo((0.5e-3 / 56.25) * 1e6, 6);
  // L-pad: 6 dB hotter tweeter into 8 Ω
  const pad = passiveNetwork(opts({}), woofer, { ...flatTweeter, sensDb: 93 }).tweeterLPad!;
  const a = 10 ** (-6 / 20);
  expect(pad[0].value).toBeCloseTo(R * (1 - a), 6);
  expect(pad[1].value).toBeCloseTo((R * a) / (1 - a), 6);
  const par = (pad[1].value * R) / (pad[1].value + R);
  expect(pad[0].value + par).toBeCloseTo(R, 6);
  expect(par / (pad[0].value + par)).toBeCloseTo(a, 6);
  expect(lr2.caveat).toMatch(/measured/);
});

test('tweeter offset breaks the LR4 sum; bestTweeterDelayMs restores it', () => {
  const o = opts({ tweeterOffsetMm: 30 });
  const off = twoWaySum(freqs, ones, woofer, flatTweeter, o);
  expect(maxAbs(off.sumDb)).toBeGreaterThan(1);
  const best = bestTweeterDelayMs(freqs, ones, woofer, flatTweeter, o);
  expect(best.delayMs).toBeCloseTo(-30 / 343.2, 2);
  expect(best.invertTweeter).toBe(false);
  const fixed = twoWaySum(freqs, ones, woofer, flatTweeter, { ...o, delayTweeterMs: best.delayMs, invertTweeter: best.invertTweeter });
  expect(maxAbs(fixed.sumDb)).toBeLessThan(0.5);
});

test('level match uses sensitivities; trim adds on top', () => {
  const hot = { ...flatTweeter, sensDb: 91 };
  const r = twoWaySum(freqs, ones, woofer, hot, opts({ tweeterLevelDb: 1 }));
  expect(r.levelMatchDb).toBeCloseTo(4, 9);
  expect(r.tweeterDb[r.tweeterDb.length - 1]).toBeCloseTo(1, 2);
});
