// Measurement import (pure module, no browser): parsers, resampling/smoothing,
// minimum-phase reconstruction, T/S extraction, crossover hookup.
import { test, expect } from '@playwright/test';
import {
  parseMeasurement,
  MeasurementParseError,
  toFrdText,
  interpAt,
  resampleLog,
  smoothOctave,
  logGrid,
  minimumPhaseDeg,
  minimumPhaseOf,
  measuredResponse,
  estimateTS,
  crossoverInputs,
  kindFromValues,
  validatePoints,
  roleFromName,
  newMeasurement,
  wrapDeg,
  type Measurement,
  type MeasPoint,
} from '../src/home/measurements';
import { DRIVERS } from '../src/home/drivers';
import { twoWaySum, tweeterResponse } from '../src/home/crossover';
import { logFreqs, toDb } from '../src/home/roomAcoustics';

// --- synthetic references ---------------------------------------------------

/** 2nd-order high-pass s²/(s² + s/Q + 1) at fc: magnitude (dB) and phase (deg). */
function hp2(f: number, fc: number, q: number) {
  const w = f / fc;
  const re = 1 - w * w;
  const im = w / q;
  const den = Math.hypot(re, im);
  const db = 20 * Math.log10((w * w) / den);
  const deg = (Math.atan2(-im, re) * 180) / Math.PI + 180; // arg(−w²) − arg(den)
  return { db, deg: wrapDeg(deg) };
}

/** Free-air driver impedance from T/S. */
function zDriver(f: number, t: { re: number; fs: number; qms: number; qes: number; leMh?: number }) {
  const res = (t.re * t.qms) / t.qes;
  const x = t.qms * (f / t.fs - t.fs / f);
  const r = t.re + res / (1 + x * x);
  const i = (2 * Math.PI * f * (t.leMh ?? 0)) / 1000 - (res * x) / (1 + x * x);
  return { ohm: Math.hypot(r, i), deg: (Math.atan2(i, r) * 180) / Math.PI };
}

const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));
const angDiff = (a: number, b: number) => Math.abs(wrapDeg(a - b));

// --- fixtures ---------------------------------------------------------------

const freqs20 = logGrid(20, 20000, 12);

const FRD_TEXT = [
  '* Vendor FRD, 0 deg on-axis, 2.83 V / 1 m',
  '# exported by some tool',
  '; another comment style',
  ...freqs20.map((f) => {
    const r = hp2(f, 1200, 0.8);
    return `${f.toFixed(3)}  ${(r.db + 90).toFixed(3)}  ${r.deg.toFixed(3)}`;
  }),
].join('\n');

const FRD_NO_PHASE_CSV = ['Frequency,SPL', ...freqs20.map((f) => `${f.toFixed(2)},${(85 + hp2(f, 60, 0.7).db).toFixed(2)}`)].join('\r\n');

const FRD_SEMI_DECIMAL_COMMA = freqs20.map((f) => `${f.toFixed(2).replace('.', ',')};${(80 + hp2(f, 900, 0.7).db).toFixed(2).replace('.', ',')};${hp2(f, 900, 0.7).deg.toFixed(1).replace('.', ',')}`).join('\n');

const ZT = { re: 6.2, fs: 42, qms: 4.1, qes: 0.42 };
const ZMA_TEXT = freqs20.map((f) => {
  const z = zDriver(f, { ...ZT, leMh: 0.6 });
  return `${f.toFixed(3)}\t${z.ohm.toFixed(4)}\t${z.deg.toFixed(3)}`;
}).join('\n');

const REW_SPL = [
  '* Measurement data measured by REW V5.20.13',
  '* Source: USB Audio Device, Mic: UMIK-1',
  '* Format: 1/48 octave smoothing',
  '* Dated: 12-Nov-2026 10:31:02',
  '* REW Settings:',
  '*  C-weighting compensation: Off',
  '*  Target level: 75.0 dB',
  '* Note:Delay 0.123 ms (42 mm, 1.65 in) using estimated IR delay relative to Acoustic reference with no timing offset',
  '* Measurement: tweeter on-axis',
  '* Smoothing: 1/48 octave',
  '* Frequency Step: 48 ppo',
  '* Start Frequency: 20.000 Hz',
  '*',
  '* Freq(Hz) SPL(dB) Phase(degrees)',
  ...freqs20.map((f) => `${f.toFixed(6)} ${(88 + hp2(f, 1000, 0.7).db).toFixed(3)} ${hp2(f, 1000, 0.7).deg.toFixed(4)}`),
].join('\n');

const REW_Z = [
  '* Measurement data measured by REW V5.20.13',
  '* Source: impedance jig',
  '* Note: Target level: 75.0 dB',
  '* Freq(Hz) Impedance(ohms) Phase(degrees)',
  ...freqs20.map((f) => {
    const z = zDriver(f, ZT);
    return `${f.toFixed(6)} ${z.ohm.toFixed(5)} ${z.deg.toFixed(4)}`;
  }),
].join('\n');

// --- parsing ----------------------------------------------------------------

test('FRD: whitespace columns, * # ; comments, with phase', () => {
  const r = parseMeasurement(FRD_TEXT, 'tweeter.frd');
  expect(r.points.length).toBe(freqs20.length);
  expect(r.hasPhase).toBe(true);
  expect(r.kind).toBe('spl');
  expect(r.header.length).toBe(3);
  expect(r.points[0].f).toBeCloseTo(20, 2);
  const mid = interpAt(r.points, 5000);
  expect(mid.mag).toBeCloseTo(90 + hp2(5000, 1200, 0.8).db, 1);
});

test('FRD: comma-separated with a text header and no phase', () => {
  const r = parseMeasurement(FRD_NO_PHASE_CSV, 'woofer.txt');
  expect(r.hasPhase).toBe(false);
  expect(r.kind).toBe('spl');
  expect(r.points.every((p) => p.phase === undefined)).toBe(true);
  expect(r.points.at(-1)!.mag).toBeCloseTo(85, 1);
});

test('semicolon separator with decimal commas', () => {
  const r = parseMeasurement(FRD_SEMI_DECIMAL_COMMA, 'x.frd');
  expect(r.points.length).toBe(freqs20.length);
  expect(r.hasPhase).toBe(true);
  expect(r.points[10].f).toBeCloseTo(freqs20[10], 1);
});

test('ZMA: tab-separated impedance', () => {
  const r = parseMeasurement(ZMA_TEXT, 'woofer.zma');
  expect(r.kind).toBe('impedance');
  expect(r.kindFrom).toBe('extension');
  expect(r.hasPhase).toBe(true);
  // even without the extension the values give it away
  const r2 = parseMeasurement(ZMA_TEXT, 'woofer.txt');
  expect(r2.kind).toBe('impedance');
  expect(r2.kindFrom).toBe('values');
});

test('REW SPL and impedance text exports: header decides the kind', () => {
  const s = parseMeasurement(REW_SPL, 'export.txt');
  expect(s.kind).toBe('spl');
  expect(s.kindFrom).toBe('header');
  expect(s.points.length).toBe(freqs20.length);
  const z = parseMeasurement(REW_Z, 'export.txt');
  expect(z.kind).toBe('impedance');
  expect(z.kindFrom).toBe('header');
  // user override wins
  expect(parseMeasurement(REW_Z, 'export.txt', 'spl').kind).toBe('spl');
});

test('value-based kind guess', () => {
  const rel: MeasPoint[] = freqs20.map((f) => ({ f, mag: hp2(f, 1000, 0.7).db }));
  expect(kindFromValues(rel).kind).toBe('spl');
  const abs: MeasPoint[] = freqs20.map((f) => ({ f, mag: 85 + hp2(f, 1000, 0.7).db / 4 }));
  expect(kindFromValues(abs).kind).toBe('spl');
});

test('validation: too few points, disorder, junk, descending, duplicates, 0 Hz', () => {
  expect(() => parseMeasurement('100 80\n200 81\n300 82', 'a.frd')).toThrow(MeasurementParseError);
  expect(() => parseMeasurement('hello\nworld', 'a.frd')).toThrow(/no numeric data/);
  const shuffled = freqs20.map((f, i) => `${i === 5 ? 99999 : f} 80`).join('\n');
  expect(() => parseMeasurement(shuffled, 'a.frd')).toThrow(/not in order/);
  expect(() => parseMeasurement(freqs20.map((f) => `${f} NaN`).join('\n'), 'a.frd')).toThrow();
  const desc = freqs20.slice().reverse().map((f) => `${f} 80 0`).join('\n');
  const rd = parseMeasurement(desc, 'a.frd');
  expect(rd.points[0].f).toBeCloseTo(20, 3);
  expect(rd.warnings.join(' ')).toMatch(/descending/);
  const dup = ['0 80 0', ...freqs20.flatMap((f, i) => (i === 3 ? [`${f} 80 0`, `${f} 80 0`] : [`${f} 80 0`]))].join('\n');
  const rdup = parseMeasurement(dup, 'a.frd');
  expect(rdup.points.length).toBe(freqs20.length);
  expect(rdup.warnings.join(' ')).toMatch(/0 Hz/);
  expect(rdup.warnings.join(' ')).toMatch(/repeated/);
  expect(validatePoints(rdup.points)).toEqual([]);
  expect(validatePoints([{ f: 2, mag: 1 }, { f: 1, mag: 1 }])[0]).toMatch(/only 2/);
});

test('round trip: parse → text → parse', () => {
  const a = parseMeasurement(REW_SPL, 'a.txt');
  const b = parseMeasurement(toFrdText(a.points, ['round trip']), 'b.frd');
  expect(b.points.length).toBe(a.points.length);
  for (let i = 0; i < a.points.length; i++) {
    expect(b.points[i].f).toBe(a.points[i].f);
    expect(b.points[i].mag).toBe(a.points[i].mag);
    expect(b.points[i].phase).toBe(a.points[i].phase);
  }
  // JSON (how it's stored / exported) round-trips too
  expect(JSON.parse(JSON.stringify(a.points))).toEqual(a.points);
});

// --- interpolation, resampling, smoothing ----------------------------------

test('interpolation and log resampling, phase through the ±180° wrap', () => {
  const pts: MeasPoint[] = logGrid(100, 10000, 6).map((f) => ({ f, mag: Math.log2(f), phase: wrapDeg(-0.36 * f) }));
  // mag linear in ln f → exact
  expect(interpAt(pts, 1234).mag).toBeCloseTo(Math.log2(1234), 9);
  const rs = resampleLog(pts, 24);
  expect(rs.length).toBe(Math.ceil(Math.log2(100) * 24) + 1);
  expect(rs[0].f).toBeCloseTo(100, 9);
  expect(rs.at(-1)!.f).toBeCloseTo(10000, 6);
  // unwrapped interpolation never jumps by ~360° between neighbours
  for (let i = 1; i < 40; i++) expect(angDiff(rs[i].phase!, rs[i - 1].phase!)).toBeLessThan(60);
  // outside the data the ends are held
  expect(interpAt(pts, 10).mag).toBeCloseTo(pts[0].mag, 9);
});

test('1/N-octave smoothing: flat stays flat, a narrow notch is filled in, a line stays a line', () => {
  const g = logGrid(20, 20000, 48);
  const flat = smoothOctave(g.map((f) => ({ f, mag: 80 })), 3);
  expect(maxAbs(flat.map((p) => p.mag - 80))).toBeLessThan(1e-9);
  const notch = g.map((f) => ({ f, mag: Math.abs(f - 1000) / 1000 < 0.01 ? 60 : 80 }));
  const sm = smoothOctave(notch, 3);
  const at1k = sm[g.findIndex((f) => f >= 1000)].mag;
  expect(at1k).toBeGreaterThan(78);
  const line = g.map((f) => ({ f, mag: 6 * Math.log2(f) }));
  const sl = smoothOctave(line, 6);
  for (let i = 30; i < g.length - 30; i++) expect(sl[i].mag).toBeCloseTo(line[i].mag, 6);
});

// --- minimum phase -----------------------------------------------------------

test('minimum phase of a 2nd-order high-pass recovers its phase in band', () => {
  for (const [fc, q] of [
    [1000, 0.707],
    [800, 1.2],
    [1500, 0.5],
  ]) {
    const g = logGrid(20, 20000, 48);
    const db = g.map((f) => hp2(f, fc, q).db);
    const ph = minimumPhaseDeg(g, db);
    const errs = g.map((f, i) => (f >= 100 && f <= 10000 ? angDiff(ph[i], hp2(f, fc, q).deg) : 0));
    expect(maxAbs(errs)).toBeLessThan(2);
  }
});

test('minimum phase from a sparse, non-log measurement (resampled internally)', () => {
  const pts: MeasPoint[] = logGrid(200, 20000, 12).map((f) => ({ f: Math.round(f), mag: 88 + hp2(Math.round(f), 1000, 0.7).db }));
  const mp = minimumPhaseOf(pts, 48);
  const errs = mp.filter((p) => p.f > 400 && p.f < 10000).map((p) => angDiff(p.phase!, hp2(p.f, 1000, 0.7).deg));
  expect(maxAbs(errs)).toBeLessThan(3);
});

test('a 4th-order roll-off (LR4 high-pass) is recovered too', () => {
  const g = logGrid(20, 20000, 48);
  const lr4 = (f: number) => {
    const a = hp2(f, 2000, Math.SQRT1_2);
    return { db: 2 * a.db, deg: wrapDeg(2 * a.deg) };
  };
  const ph = minimumPhaseDeg(g, g.map((f) => lr4(f).db));
  const errs = g.map((f, i) => (f >= 200 && f <= 10000 ? angDiff(ph[i], lr4(f).deg) : 0));
  expect(maxAbs(errs)).toBeLessThan(3);
});

// --- measured response for the crossover -----------------------------------

const tweeter = DRIVERS.find((d) => d.role === 'tweeter')!;
const woofer = DRIVERS.find((d) => d.role === 'woofer')!;

const mkMeas = (pts: MeasPoint[], extra: Partial<Measurement> = {}): Measurement => ({
  id: 'm1',
  name: 'test',
  kind: 'spl',
  role: 'tweeter',
  points: pts,
  importedAt: '2026-11-16T00:00:00.000Z',
  note: '',
  ...extra,
});

test('measured tweeter without phase reproduces the ideal roll-off it was made from', () => {
  const tw = { ...tweeter, fsHz: 900, qts: 0.8 };
  const pts: MeasPoint[] = logGrid(100, 20000, 48).map((f) => ({ f, mag: 92 + toDb(tweeterResponse(tw, f)) }));
  const fx = logFreqs(200, 20000, 200);
  const r = measuredResponse(mkMeas(pts), fx, [4000, 16000]);
  expect(r.phaseSource).toBe('minimum');
  expect(r.refDb).toBeCloseTo(92, 1);
  fx.forEach((f, i) => {
    const ideal = tweeterResponse(tw, f);
    expect(Math.abs(toDb(r.H[i]) - toDb(ideal))).toBeLessThan(0.05);
    if (f > 300 && f < 10000) expect(angDiff((Math.atan2(r.H[i].im, r.H[i].re) * 180) / Math.PI, (Math.atan2(ideal.im, ideal.re) * 180) / Math.PI)).toBeLessThan(2);
  });
});

test('measured phase with a mic delay: the delay is found and removed (or kept)', () => {
  const tau = 0.0029; // 1 m of air
  const pts: MeasPoint[] = logGrid(150, 20000, 48).map((f) => {
    const h = hp2(f, 1000, 0.7);
    return { f, mag: 90 + h.db, phase: wrapDeg(h.deg - 360 * f * tau) };
  });
  const fx = logFreqs(200, 20000, 160);
  const r = measuredResponse(mkMeas(pts), fx, [3000, 12000]);
  expect(r.phaseSource).toBe('measured');
  expect(r.delayMs).toBeCloseTo(2.9, 1);
  fx.forEach((f, i) => {
    if (f > 300 && f < 15000) expect(angDiff((Math.atan2(r.H[i].im, r.H[i].re) * 180) / Math.PI, hp2(f, 1000, 0.7).deg)).toBeLessThan(3);
  });
  const k = measuredResponse(mkMeas(pts, { keepTiming: true }), fx, [3000, 12000]);
  expect(k.keptDelayMs).toBeCloseTo(2.9, 1);
  // forcing minimum phase ignores the file's phase
  expect(measuredResponse(mkMeas(pts, { minPhase: true }), fx, [3000, 12000]).phaseSource).toBe('minimum');
  // a range limit is honoured
  expect(() => measuredResponse(mkMeas(pts, { fMin: 19000 }), fx, [3000, 12000])).toThrow(/fewer than 10/);
});

test('crossoverInputs: measured tweeter replaces the ideal roll-off, sum matches the ideal-model sum', () => {
  const fx = logFreqs(200, 20000, 160);
  const ones = fx.map(() => ({ re: 1, im: 0 }));
  const pts: MeasPoint[] = logGrid(100, 20000, 48).map((f) => ({ f, mag: 95 + toDb(tweeterResponse(tweeter, f)) }));
  const list = [mkMeas(pts, { driverId: tweeter.id })];
  const inp = crossoverInputs(list, woofer, tweeter, fx, ones, -40, 2500);
  expect(inp.tweeterH).not.toBeNull();
  expect(inp.sources.tweeter).toMatch(/measured/);
  expect(inp.sources.woofer).toMatch(/simulated/);
  const o = { fcHz: 2500, type: 'LR4' as const, tweeterLevelDb: 0, tweeterOffsetMm: 0, invertTweeter: false };
  const a = twoWaySum(fx, ones, woofer, tweeter, o);
  const b = twoWaySum(fx, inp.wooferH, woofer, inp.tweeter, { ...o, tweeterH: inp.tweeterH });
  expect(maxAbs(a.sumDb.map((v, i) => (fx[i] > 400 && fx[i] < 10000 ? v - b.sumDb[i] : 0)))).toBeLessThan(0.3);
  // assigned to another driver → not used
  const other = crossoverInputs([mkMeas(pts, { driverId: 'someone-else' })], woofer, tweeter, fx, ones, -40, 2500);
  expect(other.tweeterH).toBeNull();
  expect(other.sources.tweeter).toMatch(/ideal/);
  // both measured → level match from the measurements
  const wpts: MeasPoint[] = logGrid(30, 8000, 48).map((f) => ({ f, mag: 87 }));
  const both = crossoverInputs([...list, mkMeas(wpts, { id: 'w', role: 'woofer' })], woofer, tweeter, fx, ones, -40, 2500);
  expect(both.tweeter.sensDb - woofer.sensDb).toBeCloseTo(8, 0);
  expect(both.sources.woofer).toMatch(/measured/);
});

// --- T/S from impedance ------------------------------------------------------

test('T/S from a synthetic impedance sweep (Re entered, with Le)', () => {
  for (const t of [
    { re: 6.2, fs: 42, qms: 4.1, qes: 0.42, leMh: 0.6 },
    { re: 3.3, fs: 28, qms: 6, qes: 0.3, leMh: 1.2 },
    { re: 5.6, fs: 750, qms: 1.6, qes: 0.9, leMh: 0.05 },
  ]) {
    const pts = logGrid(10, 20000, 48).map((f) => ({ f, mag: zDriver(f, t).ohm, phase: zDriver(f, t).deg }));
    const est = estimateTS(pts, t.re)!;
    expect(est).not.toBeNull();
    const qts = (t.qms * t.qes) / (t.qms + t.qes);
    expect(Math.abs(est.fsHz / t.fs - 1)).toBeLessThan(0.05);
    expect(Math.abs(est.qts / qts - 1)).toBeLessThan(0.05);
    expect(Math.abs(est.qms / t.qms - 1)).toBeLessThan(0.08);
    expect(est.reSource).toBe('entered');
  }
});

test('T/S from a synthetic impedance sweep (Re from the curve, no Le)', () => {
  const t = { re: 6.2, fs: 42, qms: 4.1, qes: 0.42 };
  const parsed = parseMeasurement(REW_Z, 'z.txt');
  const est = estimateTS(parsed.points)!;
  const qts = (t.qms * t.qes) / (t.qms + t.qes);
  expect(est.reSource).toBe('minimum above Fs');
  expect(Math.abs(est.fsHz / t.fs - 1)).toBeLessThan(0.05);
  expect(Math.abs(est.qts / qts - 1)).toBeLessThan(0.05);
  expect(est.notes.join(' ')).toMatch(/ohmmeter/);
});

test('T/S: a vented-box (double-peak) curve is flagged, a flat line gives nothing', () => {
  // two resonances ≈ vented box
  const pts = logGrid(10, 20000, 48).map((f) => {
    // Re + two parallel resonances (box + driver), magnitude of the complex sum
    const res = (f0: number, r: number, q: number) => {
      const x = q * (f / f0 - f0 / f);
      return { re: r / (1 + x * x), im: (-r * x) / (1 + x * x) };
    };
    const a = res(25, 30, 4);
    const b = res(80, 25, 4);
    return { f, mag: Math.hypot(6 + a.re + b.re, a.im + b.im) };
  });
  expect(estimateTS(pts)!.notes.join(' ')).toMatch(/vented/);
  expect(estimateTS(logGrid(10, 20000, 12).map((f) => ({ f, mag: 8 })))).toBeNull();
});

test('new measurements: role from the file name, dense exports decimated', () => {
  expect(roleFromName('SB26STAC_tweeter_0deg.frd')).toBe('tweeter');
  expect(roleFromName('tw_hf.txt')).toBe('tweeter');
  expect(roleFromName('woofer-in-box.frd')).toBe('woofer');
  expect(roleFromName('L_sum_1m.txt')).toBe('system');
  expect(roleFromName('shelf.frd')).toBeUndefined();
  const lin = Array.from({ length: 8000 }, (_, i) => `${(i + 1) * 2.93} ${80 + Math.sin(i / 50)} 0`).join('\n');
  const m = newMeasurement('woofer.txt', parseMeasurement(lin, 'woofer.txt'));
  expect(m.points.length).toBeLessThan(2000);
  expect(m.role).toBe('woofer');
  expect(m.kind).toBe('spl');
  expect(validatePoints(m.points)).toEqual([]);
});
