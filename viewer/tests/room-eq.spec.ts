// Room-mode EQ and predicted-vs-measured overlays (pure modules, no browser).
import { test, expect } from '@playwright/test';
import { eqDb, fitRoomEq, parseApoText, peakingDb, toApoText, type PeqFilter } from '../src/home/roomEq';
import { compareToPrediction, minus3Below, pickOverlay, type XY } from '../src/home/measOverlay';
import { logGrid, type Measurement } from '../src/home/measurements';

// ---------------------------------------------------------------------------
// RBJ peaking filter
// ---------------------------------------------------------------------------

test('peaking biquad: full gain at fc, ~half gain at the band edges, flat far away', () => {
  expect(peakingDb(50, 50, -6, 4)).toBeCloseTo(-6, 2);
  expect(peakingDb(80, 80, 9, 2)).toBeCloseTo(9, 2);
  expect(Math.abs(peakingDb(5000, 50, -6, 4))).toBeLessThan(0.01);
  expect(Math.abs(peakingDb(5, 50, -6, 4))).toBeLessThan(0.05);
  // bandwidth fc/Q: RBJ's Q is defined at the half-gain (in dB) points
  const fc = 100;
  const q = 4;
  const bw = fc / q;
  const fl = (-bw + Math.sqrt(bw * bw + 4 * fc * fc)) / 2;
  expect(peakingDb(fl, fc, -10, q)).toBeCloseTo(-5, 0);
  expect(peakingDb(fl + bw, fc, -10, q)).toBeCloseTo(-5, 0);
  // a cut and the same boost cancel
  for (const f of [30, 70, 100, 140]) expect(peakingDb(f, 100, -7, 3) + peakingDb(f, 100, 7, 3)).toBeCloseTo(0, 6);
});

// ---------------------------------------------------------------------------
// Greedy room-EQ fit on a synthetic response
// ---------------------------------------------------------------------------

const PEAKS: PeqFilter[] = [
  { fc: 42, gainDb: 9, q: 5 },
  { fc: 71, gainDb: 7, q: 6 },
  { fc: 125, gainDb: 8, q: 8 },
];
/** a gently sloping in-room response with three modal peaks and a deep null at 95 Hz */
function synthetic(freqs: number[]) {
  return freqs.map((f) => 2 - 1.5 * Math.log2(f / 50) + eqDb(f, PEAKS) + peakingDb(f, 95, -14, 6));
}

test('fit finds the modal peaks, cuts only, and flattens towards the trend', () => {
  const freqs = logGrid(18, 300, 60);
  const r = fitRoomEq(freqs, synthetic(freqs));
  expect(r.filters.length).toBeGreaterThanOrEqual(3);
  expect(r.filters.length).toBeLessThanOrEqual(6);
  for (const f of r.filters) {
    expect(f.gainDb).toBeLessThanOrEqual(0);
    expect(f.q).toBeGreaterThan(0);
    expect(f.fc).toBeGreaterThanOrEqual(r.fMin);
    expect(f.fc).toBeLessThanOrEqual(r.fMax);
  }
  for (const p of PEAKS) {
    const near = r.filters.filter((f) => Math.abs(Math.log2(f.fc / p.fc)) < 0.1);
    expect(near.length, `a cut near ${p.fc} Hz`).toBeGreaterThan(0);
    // a real cut, not a token one
    expect(Math.min(...near.map((f) => f.gainDb))).toBeLessThan(-3);
  }
  // nothing boosts the null; no cut sits on it either
  expect(r.filters.some((f) => Math.abs(Math.log2(f.fc / 95)) < 0.05)).toBe(false);
  // the part above the trend (what cuts can fix) mostly goes; the null stays, so overall RMS drops less
  expect(r.after.aboveRmsDb).toBeLessThan(r.before.aboveRmsDb * 0.4);
  expect(r.after.rmsDb).toBeLessThan(r.before.rmsDb * 0.9);
  // the corrected curve is the input plus the filters
  r.freqs.forEach((f, i) => expect(r.corrected[i]).toBeCloseTo(r.input[i] + eqDb(f, r.filters), 6));
  // the peaks themselves come down
  const at = (f: number) => r.freqs.reduce((k, x, i) => (Math.abs(x - f) < Math.abs(r.freqs[k] - f) ? i : k), 0);
  for (const p of PEAKS) {
    const i = at(p.fc);
    expect(r.corrected[i] - r.target[i]).toBeLessThan(r.input[i] - r.target[i] - 3);
  }
});

test('fit respects the filter limit and does nothing on a flat response', () => {
  const freqs = logGrid(18, 300, 60);
  const two = fitRoomEq(freqs, synthetic(freqs), { maxFilters: 2 });
  expect(two.filters.length).toBeLessThanOrEqual(2);
  const flat = fitRoomEq(freqs, freqs.map(() => 3));
  expect(flat.filters).toHaveLength(0);
  expect(flat.after.rmsDb).toBeCloseTo(0, 6);
  // an all-dips response gets no boosts
  const dips = fitRoomEq(freqs, freqs.map((f) => peakingDb(f, 60, -12, 5) + peakingDb(f, 140, -10, 6)));
  for (const f of dips.filters) expect(f.gainDb).toBeLessThanOrEqual(0);
});

test('APO / REW text round-trips', () => {
  const freqs = logGrid(18, 300, 60);
  const r = fitRoomEq(freqs, synthetic(freqs));
  const txt = toApoText(r.filters, 'Room EQ test');
  expect(txt).toMatch(/^# Room EQ test/);
  expect(txt).not.toMatch(/Preamp/); // cuts only
  expect(txt).toMatch(/^Filter 1: ON PK Fc \d+\.\d Hz Gain -\d+\.\d dB Q \d+\.\d\d$/m);
  const back = parseApoText(txt);
  expect(back.preampDb).toBe(0);
  expect(back.filters).toHaveLength(r.filters.length);
  back.filters.forEach((f, i) => {
    expect(f.fc).toBeCloseTo(r.filters[i].fc, 1);
    expect(f.gainDb).toBeCloseTo(r.filters[i].gainDb, 1);
    expect(f.q).toBeCloseTo(r.filters[i].q, 2);
  });
  // a boost gets a preamp line, and that parses too
  const withBoost = toApoText([{ fc: 45, gainDb: -6, q: 4 }, { fc: 200, gainDb: 2.5, q: 1 }]);
  expect(withBoost.split('\n')[0]).toBe('Preamp: -2.5 dB');
  expect(withBoost).toContain('Filter 1: ON PK Fc 45.0 Hz Gain -6.0 dB Q 4.00');
  expect(parseApoText(withBoost)).toEqual({ preampDb: -2.5, filters: [{ fc: 45, gainDb: -6, q: 4 }, { fc: 200, gainDb: 2.5, q: 1 }] });
  // REW's padded spacing parses as well
  expect(parseApoText('Filter  3: ON  PK       Fc   63.5 Hz  Gain  -4.2 dB  Q  6.10').filters).toEqual([{ fc: 63.5, gainDb: -4.2, q: 6.1 }]);
});

// ---------------------------------------------------------------------------
// Overlay alignment / deviation
// ---------------------------------------------------------------------------

/** 2nd-order high-pass (dB) at fc, Q 0.707, on top of `level`. */
const hp2 = (f: number, fc: number, level: number) => {
  const w = f / fc;
  return level + 20 * Math.log10((w * w) / Math.hypot(1 - w * w, w * Math.SQRT2));
};

test('overlay: level offset, deviation by band and −3 dB points', () => {
  const pred: XY[] = logGrid(10, 500, 48).map((x) => ({ x, y: hp2(x, 40, 88) }));
  // "measured": 7 dB quieter (mic gain), rolls off at 50 Hz instead, with a +3 dB bump at 300 Hz
  const meas = logGrid(20, 20000, 96).map((f) => ({ f, mag: hp2(f, 50, 81) + peakingDb(f, 300, 3, 4) }));
  const c = compareToPrediction(pred, meas, { alignBand: [100, 250], xMin: 10, xMax: 500 })!;
  expect(c).not.toBeNull();
  expect(c.band[0]).toBeCloseTo(100, 6);
  expect(c.band[1]).toBeCloseTo(250, 6);
  expect(c.offsetDb).toBeGreaterThan(6);
  expect(c.offsetDb).toBeLessThan(8);
  // clipped to the chart and to the data
  expect(c.points[0].x).toBeCloseTo(20, 6);
  expect(c.points[c.points.length - 1].x).toBeCloseTo(500, 6);
  expect(c.measFMin).toBeCloseTo(20, 6);
  // −3 dB points: about 40 and 50 Hz (Butterworth: f3 = fc)
  expect(c.f3Pred!).toBeGreaterThan(37);
  expect(c.f3Pred!).toBeLessThan(43);
  expect(c.f3Meas!).toBeGreaterThan(47);
  expect(c.f3Meas!).toBeLessThan(54);
  // the bump shows as the largest positive deviation in the 200–500 band
  const top = c.bands.find((b) => b.f0 >= 199 && b.f1 <= 501)!;
  expect(top.maxDb).toBeGreaterThan(2);
  expect(Math.abs(Math.log2(top.atHz / 300))).toBeLessThan(0.15);
  // the low band shows the measured roll-off as negative
  const low = c.bands[0];
  expect(low.f0).toBeCloseTo(20, 6);
  expect(low.maxDb).toBeLessThan(-2);
  expect(c.overall!.rmsDb).toBeGreaterThan(0);
  // identical curves: zero offset, zero deviation
  const same = compareToPrediction(pred, pred.map((p) => ({ f: p.x, mag: p.y })), { alignBand: [100, 300] })!;
  expect(same.offsetDb).toBeCloseTo(0, 6);
  expect(same.overall!.rmsDb).toBeLessThan(1e-6);
});

test('overlay: band outside the overlap falls back, helpers behave', () => {
  const pred: XY[] = logGrid(15, 300, 48).map((x) => ({ x, y: 100 }));
  const meas = logGrid(20, 20000, 48).map((f) => ({ f, mag: 80 }));
  const c = compareToPrediction(pred, meas, { alignBand: [1000, 3000] })!;
  expect(c.offsetDb).toBeCloseTo(20, 6);
  expect(c.band[1]).toBeCloseTo(300, 6);
  expect(c.f3Meas).toBeNull();
  // no overlap at all
  expect(compareToPrediction(pred, logGrid(1000, 2000, 24).map((f) => ({ f, mag: 1 })), { alignBand: [100, 200] })).toBeNull();
  expect(minus3Below([{ x: 10, y: -10 }, { x: 20, y: 0 }, { x: 40, y: 0 }], 0, 30)).toBeCloseTo(10 * Math.pow(2, 0.7), 6);
  const ms: Measurement[] = [
    { id: 'a', name: 'a', kind: 'spl', points: meas, importedAt: '', note: '' },
    { id: 'z', name: 'z', kind: 'impedance', points: meas, importedAt: '', note: '' },
  ];
  expect(pickOverlay(ms, { on: true, id: 'a' }, 'spl')?.id).toBe('a');
  expect(pickOverlay(ms, { on: false, id: 'a' }, 'spl')).toBeNull();
  expect(pickOverlay(ms, { on: true, id: 'z' }, 'spl')).toBeNull();
  expect(pickOverlay(ms, undefined, 'spl')).toBeNull();
});
