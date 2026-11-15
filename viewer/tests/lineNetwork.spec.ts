// Reference checks for the 1D line/horn solver against textbook physics.
import { test, expect } from '@playwright/test';
import { abs, cx, miki, quarterWaveHz, solveLine, trapTuningHz, type LineModel } from '../src/home/lineNetwork';
import { SPEED_OF_SOUND as C } from '../src/home/roomAcoustics';

const RHO = 1.204;
/** a uniform straight pipe, length L (mm), area A (mm²), n segments */
const pipe = (L: number, A: number, n = 200) => ({
  s: Array.from({ length: n + 1 }, (_, i) => (L * i) / n),
  area: Array.from({ length: n + 1 }, () => A),
});
const freqs = (f0: number, f1: number, n: number) => Array.from({ length: n }, (_, i) => f0 * Math.pow(f1 / f0, i / (n - 1)));
/** an almost-open mouth: tiny radiation resistance + end-correction mass */
const nearlyOpen = (A: number) => (f: number) => {
  const a = Math.sqrt(A / 1e6 / Math.PI);
  const k = (2 * Math.PI * f) / C;
  return cx(((RHO * C) / (A / 1e6)) * ((k * a) ** 2) / 2, ((RHO * C) / (A / 1e6)) * 0.61 * k * a);
};
function peaks(fs: number[], ys: number[]) {
  const out: number[] = [];
  for (let i = 1; i < ys.length - 1; i++) if (ys[i] > ys[i - 1] && ys[i] >= ys[i + 1]) out.push(fs[i]);
  return out;
}

test('closed–open pipe: mouth output peaks at odd multiples of c/4L', () => {
  const L = 1500;
  const A = 100 * 100;
  const m: LineModel = { path: pipe(L, A), mouthZ: nearlyOpen(A), eta: 0.002 };
  const fs = freqs(20, 400, 2000);
  // drive at the closed end with a constant flow
  const ys = fs.map((f) => abs(solveLine(m, f, [{ atMm: 0, q: cx(1e-4) }]).mouthU));
  const pk = peaks(fs, ys);
  for (let n = 1; n <= 3; n++) {
    const expect_ = quarterWaveHz(L, A, n);
    const got = pk.reduce((best, f) => (Math.abs(f - expect_) < Math.abs(best - expect_) ? f : best), pk[0]);
    expect(Math.abs(got - expect_) / expect_, `harmonic ${n}: ${got.toFixed(1)} vs ${expect_.toFixed(1)} Hz`).toBeLessThan(0.02);
  }
});

test('a driver one third of the way down the line does not excite the 3rd harmonic', () => {
  const L = 1500;
  const A = 100 * 100;
  const m: LineModel = { path: pipe(L, A), mouthZ: nearlyOpen(A), eta: 0.004 };
  const f1 = quarterWaveHz(L, A, 1);
  const f3 = quarterWaveHz(L, A, 2); // 3 × c/4L
  const out = (at: number, f: number) => abs(solveLine(m, f, [{ atMm: at, q: cx(1e-4) }]).mouthU);
  // the 3rd harmonic's pressure node sits a third of the way along the ACOUSTIC length
  // (physical length + the mouth's end correction)
  const Leff = L + 0.61 * Math.sqrt(A / Math.PI);
  const endRatio = out(0, f3) / out(0, f1);
  const offRatio = out(Leff / 3, f3) / out(Leff / 3, f1);
  expect(endRatio).toBeGreaterThan(0.1); // clearly present when driven from the closed end
  expect(offRatio).toBeLessThan(endRatio * 0.1); // and essentially gone from the 1/3 point
});

test('Helmholtz trap: tuning matches c/2π·√(S/(V·L′)) and it notches the line there', () => {
  const t = { volumeL: 0.5, neckAreaCm2: 5, neckLenMm: 40 };
  const S = 5e-4;
  const a = Math.sqrt(S / Math.PI);
  const expectHz = (C / (2 * Math.PI)) * Math.sqrt(S / (0.5e-3 * (0.04 + 1.7 * a)));
  expect(Math.abs(trapTuningHz(t) - expectHz)).toBeLessThan(0.01);
  // a trap tuned to the 3rd harmonic, at the closed end (where its pressure is highest), cuts it
  const L = 1500;
  const A = 100 * 100;
  const f3 = quarterWaveHz(L, A, 2);
  // scale the volume so it tunes to f3
  const V = (S / (((2 * Math.PI * f3) / C) ** 2 * (0.04 + 1.7 * a))) * 1000;
  const base: LineModel = { path: pipe(L, A), mouthZ: nearlyOpen(A), eta: 0.004 };
  const withTrap: LineModel = { ...base, traps: [{ atMm: 20, volumeL: V, neckAreaCm2: 5, neckLenMm: 40, q: 3 }] };
  const o = (m: LineModel) => abs(solveLine(m, f3, [{ atMm: 0, q: cx(1e-4) }]).mouthU);
  expect(o(withTrap)).toBeLessThan(o(base) * 0.35);
});

test('stuffing (Miki model) damps the line: harmonics fall, more with density', () => {
  // Miki at low f/σ: the real part of Zc and the attenuation both rise
  const lo = miki(50, 5000);
  expect(lo.Zc.re).toBeGreaterThan(RHO * C);
  expect(-lo.k.im).toBeGreaterThan(0);
  const L = 1500;
  const A = 100 * 100;
  const f3 = quarterWaveHz(L, A, 2);
  const run = (density: number) =>
    abs(solveLine({ path: pipe(L, A), mouthZ: nearlyOpen(A), eta: 0.004, stuffing: density ? [{ from: 0, to: 0.6, densityGL: density }] : [] }, f3, [{ atMm: 0, q: cx(1e-4) }]).mouthU);
  expect(run(6)).toBeLessThan(run(0) * 0.5);
  expect(run(12)).toBeLessThan(run(6));
});

// ---- the printed designs that use the solver ----
import { PRINTED_DESIGNS, buildGeometry, simulate } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';

test('printed TL: an offset driver and a 3rd-harmonic trap each cut the terminus 3rd harmonic', () => {
  const base = { ...PRINTED_DESIGNS.find((d) => d.id === 'mon-tl')!.params, stuffing: [] };
  const d = findDriver(base.driverId)!;
  const third = (p: typeof base) => {
    const g = buildGeometry(p, d);
    expect(g.fits, g.warnings.join(' | ')).toBe(true);
    const r = simulate(p, d, g, { coupled: 1, floor: false, f0: 20, f1: 400, n: 300 });
    const L = g.path.s[g.path.s.length - 1];
    const mouthA = g.path.area[g.path.area.length - 1];
    const f3 = quarterWaveHz(L, mouthA, 2);
    // strongest terminus output within ±15 % of the 3rd harmonic
    return Math.max(...r.mouthSpl!.filter((_, i) => Math.abs(r.freqs[i] - f3) < 0.15 * f3));
  };
  const atEnd = third(base);
  expect(third({ ...base, driverFold: 1 })).toBeLessThan(atEnd - 3);
  expect(third({ ...base, trapHarmonics: [3] })).toBeLessThan(atEnd - 3);
});

test('back-loaded and tapped horns build and load the driver (bass gain over the bare cone)', () => {
  for (const id of ['blh', 'th-sub']) {
    const p = PRINTED_DESIGNS.find((x) => x.id === id)!.params;
    const d = findDriver(p.driverId)!;
    const g = buildGeometry(p, d);
    expect(g.fits, `${id}: ${g.warnings.join(' | ')}`).toBe(true);
    const r = simulate(p, d, g, { coupled: 1, floor: false, f0: 20, f1: 300, n: 120 });
    const i = r.freqs.findIndex((f) => f >= 50);
    // the horn's contribution makes the total louder than the cone alone at 50 Hz
    if (id === 'blh') expect(r.spl[i]).toBeGreaterThan(r.coneSpl![i] + 3);
    else expect(r.mouthSpl![i]).toBeGreaterThan(70);
    expect(r.impedance!.length).toBe(r.freqs.length);
  }
});
