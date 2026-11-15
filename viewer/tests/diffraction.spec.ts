// Reference checks for the on-axis edge-diffraction (baffle step) model.
// Pure module, no browser.
import { test, expect } from '@playwright/test';
import { baffleResponse, baffleStepShelf, type BaffleOpts } from '../src/home/diffraction';

const logFreqs = (lo: number, hi: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => lo * (hi / lo) ** (i / n));
const FREQS = logFreqs(20, 20000, 240);

/** Peak-to-dip of the response around an ideal first-order 6 dB shelf at f3, from f3/2 to 8·f3. */
function ripple(o: BaffleOpts): number {
  const { f3Hz } = baffleStepShelf(o);
  const { freqs, db } = baffleResponse(o, FREQS);
  let max = -Infinity;
  let min = Infinity;
  freqs.forEach((f, i) => {
    if (f < f3Hz / 2 || f > f3Hz * 8) return;
    const x = f / f3Hz;
    const shelf = 20 * Math.log10(Math.hypot(0.5, x) / Math.hypot(1, x));
    max = Math.max(max, db[i] - shelf);
    min = Math.min(min, db[i] - shelf);
  });
  return max - min;
}

const centred = (w: number, h: number): BaffleOpts => ({ widthMm: w, heightMm: h, driverXmm: w / 2, driverYmm: h / 2 });

test('large baffle: −6 dB at very low frequency, ≈ 0 dB on average at high frequency', () => {
  const o = centred(2000, 2000);
  const lf = baffleResponse(o, [2, 5]);
  for (const d of lf.db) expect(Math.abs(d + 6)).toBeLessThan(0.5);
  const hf = baffleResponse(o, logFreqs(4000, 8000, 60));
  const mean = hf.db.reduce((s, d) => s + d, 0) / hf.db.length;
  expect(Math.abs(mean)).toBeLessThan(1);
});

test('−3 dB point of a 0.2 m centred baffle sits near the 115/W rule and scales as 1/W', () => {
  const rule = 115 / 0.2; // 575 Hz
  const f3 = baffleStepShelf(centred(200, 200)).f3Hz;
  // The −½ edge-source model puts the −3 dB crossing at ≈ 0.72·c/(2π·ρ) for
  // edges at ρ, i.e. ~0.6× the sphere-derived 115/W rule (see report).
  expect(f3).toBeGreaterThan(rule * 0.55);
  expect(f3).toBeLessThan(rule * 1.3);
  const f3Double = baffleStepShelf(centred(400, 400)).f3Hz;
  expect(f3Double / f3).toBeGreaterThan(0.45);
  expect(f3Double / f3).toBeLessThan(0.55);
  const shelf = baffleStepShelf(centred(200, 200));
  expect(shelf.gainDb).toBeGreaterThanOrEqual(3);
  expect(shelf.gainDb).toBeLessThanOrEqual(6);
  expect(shelf.note).toMatch(/wall/);
});

test('a centred driver ripples more than one offset towards a corner', () => {
  const c = ripple(centred(250, 250));
  const off = ripple({ widthMm: 250, heightMm: 250, driverXmm: 80, driverYmm: 70 });
  expect(c).toBeGreaterThan(off + 1);
});

test('a 40 mm roundover reduces ripple compared with sharp edges', () => {
  const sharp = ripple(centred(250, 250));
  const round = ripple({ ...centred(250, 250), edgeRadiusMm: 40 });
  expect(round).toBeLessThan(sharp - 1);
});

test('ellipse outline: circle is the worst case for a centred driver; rounding the curved front tames it', () => {
  // Physically, an outline alone does not cure ripple: a centred driver on a
  // circular baffle has every edge at the same distance (maximum coherence).
  const rect = ripple(centred(300, 300));
  const circle = ripple({ ...centred(300, 300), shape: 'ellipse' });
  expect(circle).toBeGreaterThanOrEqual(rect);
  // A curved front with a generous roundover beats the sharp rectangle.
  const curved = ripple({ ...centred(300, 300), shape: 'ellipse', edgeRadiusMm: 40 });
  expect(curved).toBeLessThan(rect - 1);
});

test('piston directivity fades the edge ripple at high frequency', () => {
  const o = { ...centred(250, 250), pistonRadiusMm: 80 };
  const { db } = baffleResponse(o, logFreqs(8000, 16000, 30));
  for (const d of db) expect(Math.abs(d)).toBeLessThan(0.5);
});
