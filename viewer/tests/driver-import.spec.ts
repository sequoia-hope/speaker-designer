// Driver data import (pure module, no browser): datasheet T/S paste parser,
// .zma impedance fit, Vas from a second sweep, .frd attach.
import { test, expect } from '@playwright/test';
import { parseTsText, parseZma, parseFrd, fitImpedance, vasFromAddedMass, vasFromBox, deriveTs } from '../src/home/driverImport';
import { driverImpedance, type MeasPoint } from '../src/home/measurements';
import { DRIVERS, type DriverInfo } from '../src/home/drivers';
import { sanitizeModelerAlt } from '../src/home/boxModel';

const near = (got: number | undefined, want: number, tol = 0.05) => {
  expect(got, `expected ≈${want}`).toBeDefined();
  expect(Math.abs(got! / want - 1), `${got} vs ${want}`).toBeLessThan(tol);
};

test.describe('T/S paste parser', () => {
  test('a plain "label: value unit" list', () => {
    const r = parseTsText(`Thiele-Small Parameters
Fs: 28.5 Hz
Re: 3.2 Ω
Le: 0.6 mH
Qms: 2.95
Qes: 0.44
Qts: 0.38
Mms: 51 g
Cms: 0.612 mm/N
Rms: 3.1 kg/s
Vas: 42 liters
Sd: 220 cm²
BL: 8.15 Tm
Xmax: 6 mm
SPL: 87 dB 2.83V/1m
Pe: 100 W
Nominal impedance: 4 Ω`);
    const v = r.values;
    expect(v.fsHz).toBe(28.5);
    expect(v.reOhm).toBe(3.2);
    expect(v.leMh).toBe(0.6);
    expect(v.qms).toBe(2.95);
    expect(v.qes).toBe(0.44);
    expect(v.qts).toBe(0.38);
    expect(v.mmsG).toBe(51);
    expect(v.cmsMmPerN).toBe(0.612);
    expect(v.rmsKgS).toBe(3.1);
    expect(v.vasL).toBe(42);
    expect(v.sdCm2).toBe(220);
    expect(v.blTm).toBe(8.15);
    expect(v.xmaxMm).toBe(6);
    expect(v.sensDb).toBe(87);
    expect(v.powerW).toBe(100);
    expect(v.nominalOhm).toBe(4);
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual([]); // the set is self-consistent
  });

  test('a European table: decimal commas, labels in words and symbols, unit variants', () => {
    const r = parseTsText(`Nominal impedance        8 Ohm
DC resistance Re ...... 5,6 ohms
Resonance frequency (Fs)  42 Hz
Qms  4,1
Qes  0,52
Effective piston area (Sd)   0.0132 m²
Moving mass incl. air Mms  14.5 g
Compliance Cms  820 µm/N
Force factor BL   7,9 T·m
Voice coil inductance Le @ 1kHz  0.45 mH
Linear excursion Xmax  ± 4.5 mm
Sensitivity (2.83V/1m)  88.5 dB
Power handling (RMS)  60 W
Max power  120 W`);
    const v = r.values;
    expect(v.nominalOhm).toBe(8);
    expect(v.reOhm).toBe(5.6);
    expect(v.fsHz).toBe(42);
    expect(v.qms).toBe(4.1);
    expect(v.qes).toBe(0.52);
    near(v.sdCm2, 132, 1e-6);
    expect(v.mmsG).toBe(14.5);
    near(v.cmsMmPerN, 0.82, 1e-6);
    expect(v.blTm).toBe(7.9);
    expect(v.leMh).toBe(0.45);
    expect(v.xmaxMm).toBe(4.5);
    expect(v.sensDb).toBe(88.5);
    expect(v.powerW).toBe(60);
    // derived: Qts from Qes/Qms, Vas from Cms and Sd (ρc²·Sd²·Cms)
    near(v.qts, (4.1 * 0.52) / 4.62, 1e-3);
    near(v.vasL, 1.204 * 343.2 ** 2 * 0.0132 ** 2 * 820e-6 * 1000, 1e-3);
    expect(r.derived.map((d) => d.key)).toEqual(expect.arrayContaining(['qts', 'vasL']));
    expect(r.missing).toEqual([]);
  });

  test('imperial units, inline list, effective diameter, 1 W sensitivity', () => {
    const r = parseTsText(`Fs = 22 Hz, Qts = 0.33, Qes = 0.36
Vas = 2.1 cu.ft.
Effective diameter: 260 mm
Xmax: 12.5mm
Revc 3.6 ohm
Sens 1W/1m 86 dB`);
    const v = r.values;
    expect(v.fsHz).toBe(22);
    expect(v.qts).toBe(0.33);
    expect(v.qes).toBe(0.36);
    near(v.vasL, 2.1 * 28.3168, 1e-4);
    near(v.sdCm2, Math.PI * 13 ** 2, 1e-4); // from the 260 mm effective diameter
    expect(v.xmaxMm).toBe(12.5);
    expect(v.reOhm).toBe(3.6);
    near(v.qms, (0.33 * 0.36) / (0.36 - 0.33), 1e-3);
    expect(v.nominalOhm).toBe(4); // guessed from Re
    near(v.sensDb, 89, 0.002); // 1 W into 4 Ω → +3 dB for 2.83 V
    expect(r.missing).toEqual([]);
  });

  test('missing fields are reported, prose and RMS power do not confuse it', () => {
    const r = parseTsText(`The woofer has a resonance of 35 Hz and is rated at Power (RMS) 80 W.
Qts 0.45   Sd 86 sq.in`);
    expect(r.values.fsHz).toBe(35);
    expect(r.values.powerW).toBe(80);
    expect(r.values.rmsKgS).toBeUndefined();
    expect(r.values.qts).toBe(0.45);
    near(r.values.sdCm2, 86 * 6.4516, 1e-4);
    expect(r.missing).toEqual(expect.arrayContaining(['reOhm', 'vasL', 'xmaxMm', 'nominalOhm']));
    expect(r.missing).not.toContain('fsHz');
  });

  test('derivation: Fs and Qes from the mechanical parameters', () => {
    const r = deriveTs({ mmsG: 51, cmsMmPerN: 0.612, reOhm: 3.2, blTm: 8.15, rmsKgS: 3.1, sdCm2: 220 });
    near(r.values.fsHz, 1 / (2 * Math.PI * Math.sqrt(0.051 * 0.000612)), 1e-3);
    near(r.values.qes, (2 * Math.PI * r.values.fsHz! * 0.051 * 3.2) / 8.15 ** 2, 1e-3);
    near(r.values.qms, (2 * Math.PI * r.values.fsHz! * 0.051) / 3.1, 1e-3);
    near(r.values.vasL, 42, 0.02);
    expect(r.values.qts).toBeDefined();
  });

  test('inconsistent Vas/Cms gets a warning', () => {
    const r = parseTsText('Vas 42 L\nCms 1.5 mm/N\nSd 220 cm2');
    expect(r.warnings.join(' ')).toMatch(/imply Vas/);
  });
});

// --- synthetic impedance ------------------------------------------------------

const REF: DriverInfo = {
  ...DRIVERS[0],
  id: 'synthetic',
  reOhm: 3.2,
  fsHz: 28.5,
  qms: 2.95,
  qes: 0.44,
  qts: (2.95 * 0.44) / 3.39,
  leMh: 0.6,
  vasL: 42,
  sdCm2: 220,
};

function sweep(d: DriverInfo, f0 = 5, f1 = 20000, ppo = 48): MeasPoint[] {
  const pts: MeasPoint[] = [];
  for (let f = f0; f <= f1; f *= 2 ** (1 / ppo)) {
    const z = driverImpedance(d, f);
    pts.push({ f, mag: z.ohm, phase: z.deg });
  }
  return pts;
}
function zmaText(pts: MeasPoint[], withPhase = true): string {
  return ['* synthetic free-air sweep', '; Freq(Hz) Z(ohm) Phase(deg)', ...pts.map((p) => (withPhase ? `${p.f.toFixed(3)} ${p.mag.toFixed(4)} ${p.phase!.toFixed(3)}` : `${p.f.toFixed(3)}\t${p.mag.toFixed(4)}`))].join('\n');
}

test.describe('.zma impedance fit', () => {
  test('fits Re, Fs, Qms, Qes, Le of a synthetic driver within 5 %', () => {
    const { parsed, fit } = parseZma(zmaText(sweep(REF)), 'woofer.zma');
    expect(parsed.kind).toBe('impedance');
    expect(fit).not.toBeNull();
    expect(fit!.reSource).toBe('low-frequency minimum');
    near(fit!.reOhm, 3.2);
    near(fit!.fsHz, 28.5);
    near(fit!.qms, 2.95);
    near(fit!.qes, 0.44);
    near(fit!.qts, REF.qts);
    near(fit!.leMh, 0.6);
  });

  test('magnitude-only file, and a user-entered Re', () => {
    const fit = fitImpedance(parseZma(zmaText(sweep(REF), false)).parsed.points, 3.2)!;
    expect(fit.reSource).toBe('entered');
    expect(fit.reOhm).toBe(3.2);
    near(fit.fsHz, 28.5);
    near(fit.qms, 2.95);
    near(fit.qes, 0.44);
    near(fit.leMh, 0.6, 0.1);
  });

  test('a sweep starting above Fs falls back to the minimum above the peak', () => {
    const d = { ...REF, fsHz: 45, leMh: 0.2 };
    const fit = fitImpedance(sweep(d, 20))!;
    expect(fit.reSource).toBe('minimum above Fs');
    near(fit.fsHz, 45);
    expect(fit.reOhm).toBeGreaterThanOrEqual(3.2);
  });

  test('Vas from an added-mass sweep and from a known-box sweep', () => {
    const free = fitImpedance(sweep(REF))!;
    // Mms of the reference driver from Vas/Sd/Fs; adding m lowers Fs by √(Mms/(Mms+m)), Q's rise by √((Mms+m)/Mms)
    const cms = 0.042 / (1.204 * 343.2 ** 2 * 0.022 ** 2);
    const mms = 1 / ((2 * Math.PI * 28.5) ** 2 * cms);
    const m = 0.02;
    const k = Math.sqrt((mms + m) / mms);
    const loaded = fitImpedance(sweep({ ...REF, fsHz: 28.5 / k, qms: 2.95 * k, qes: 0.44 * k }))!;
    const am = vasFromAddedMass(free.fsHz, loaded.fsHz, 20, 220)!;
    near(am.vasL, 42);
    near(am.mmsG, mms * 1000);
    // sealed 30 L box: Fc = Fs·√(1+Vas/Vb), Qec = Qes·√(1+Vas/Vb)
    const a = Math.sqrt(1 + 42 / 30);
    const boxed = fitImpedance(sweep({ ...REF, fsHz: 28.5 * a, qms: 2.95 * a, qes: 0.44 * a }), free.reOhm)!;
    near(vasFromBox(free.fsHz, free.qes, boxed.fsHz, boxed.qes, 30)!, 42);
  });
});

test('.frd response parses as SPL through the shared measurement reader', () => {
  const lines = ['* on-axis 2.83V 1m', '"Freq" "dB" "Phase"'];
  for (let f = 20; f <= 20000; f *= 1.1) lines.push(`${f.toFixed(2)}, ${(87 - 3 / (1 + (f / 60) ** 2)).toFixed(2)}, ${(-f / 100).toFixed(1)}`);
  const r = parseFrd(lines.join('\n'), 'woofer_on_axis.frd');
  expect(r.kind).toBe('spl');
  expect(r.hasPhase).toBe(true);
  expect(r.points.length).toBeGreaterThan(50);
});

test('box-modeler PR/bandpass settings: stored values are sanitised, old saves have none', () => {
  expect(sanitizeModelerAlt(undefined)).toBeUndefined();
  const m = sanitizeModelerAlt({
    alt: 'bp4',
    pr: { key: 'w:1', id: 'x', count: 2, netL: 'junk', fp: 30 },
    bp4: { key: 'w:1', spec: { kind: 'bp4', rearL: 20, frontL: 12, fbHz: 50, portAreaM2: 0.002 }, design: null, edited: true },
    bp6: { key: 'w:1', spec: { kind: 'bp6', rearL: 20 } },
    bpTarget: { key: 'w:1', lo: 35, hi: 90 },
  })!;
  expect(m.alt).toBe('bp4');
  expect(m.pr).toEqual({ key: 'w:1', id: 'x', count: 2, netL: null, fp: 30 });
  expect(m.bp4?.spec.kind).toBe('bp4');
  expect(m.bp4?.edited).toBe(true);
  expect(m.bp6).toBeNull(); // incomplete spec dropped
  expect(m.bpTarget).toEqual({ key: 'w:1', lo: 35, hi: 90 });
  expect(sanitizeModelerAlt({ alt: 'horn' })!.alt).toBeNull();
});
