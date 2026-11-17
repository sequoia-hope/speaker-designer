// Driver data import for "your own driver": a manufacturer's T/S parameter
// text (pasted from a datasheet PDF or web page), a free-air impedance sweep
// (.zma) to fit Re / Fs / Qms / Qes / Le from, and an on-axis response (.frd)
// to attach to the driver as a measurement. File parsing reuses the REW / FRD
// / ZMA reader in measurements.ts.
//
// Pure module: no Svelte, no DOM — tested directly in Node.

import { SPEED_OF_SOUND } from './roomAcoustics';
import { estimateTS, parseMeasurement, type MeasPoint, type ParseResult } from './measurements';

const RHO = 1.204; // kg/m³, as boxModel
/** ρc², the air's bulk modulus (Pa): Vas = ρc²·Sd²·Cms */
const RHO_C2 = RHO * SPEED_OF_SOUND * SPEED_OF_SOUND;

/** Everything the paste parser can find, in the units the driver form uses. */
export interface TsValues {
  fsHz?: number;
  qts?: number;
  qes?: number;
  qms?: number;
  vasL?: number;
  sdCm2?: number;
  /** effective cone diameter (mm) */
  effDiaMm?: number;
  xmaxMm?: number;
  reOhm?: number;
  nominalOhm?: number;
  leMh?: number;
  blTm?: number;
  mmsG?: number;
  /** compliance, mm/N */
  cmsMmPerN?: number;
  /** mechanical resistance, kg/s (N·s/m) */
  rmsKgS?: number;
  /** 2.83 V / 1 m sensitivity, dB */
  sensDb?: number;
  powerW?: number;
  /** peak displacement volume Sd·Xmax, cm³ */
  vdCm3?: number;
}
export type TsKey = keyof TsValues;

export interface ParsedItem {
  key: TsKey;
  value: number;
  /** the text it came from, e.g. "Vas = 1.48 ft³" */
  raw: string;
}
export interface DerivedItem {
  key: TsKey;
  value: number;
  how: string;
}
export interface TsParseResult {
  /** found + derived, in form units */
  values: TsValues;
  found: ParsedItem[];
  derived: DerivedItem[];
  /** what the driver form still needs */
  missing: TsKey[];
  warnings: string[];
}

export const TS_LABEL: Record<TsKey, string> = {
  fsHz: 'Fs',
  qts: 'Qts',
  qes: 'Qes',
  qms: 'Qms',
  vasL: 'Vas',
  sdCm2: 'Sd',
  effDiaMm: 'Effective Ø',
  xmaxMm: 'Xmax',
  reOhm: 'Re',
  nominalOhm: 'Nominal Z',
  leMh: 'Le',
  blTm: 'BL',
  mmsG: 'Mms',
  cmsMmPerN: 'Cms',
  rmsKgS: 'Rms',
  sensDb: 'Sensitivity',
  powerW: 'Power',
  vdCm3: 'Vd',
};
export const TS_UNIT: Record<TsKey, string> = {
  fsHz: 'Hz',
  qts: '',
  qes: '',
  qms: '',
  vasL: 'L',
  sdCm2: 'cm²',
  effDiaMm: 'mm',
  xmaxMm: 'mm',
  reOhm: 'Ω',
  nominalOhm: 'Ω',
  leMh: 'mH',
  blTm: 'T·m',
  mmsG: 'g',
  cmsMmPerN: 'mm/N',
  rmsKgS: 'kg/s',
  sensDb: 'dB',
  powerW: 'W',
  vdCm3: 'cm³',
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

type Family = 'hz' | 'ohm' | 'vol' | 'area' | 'len' | 'ind' | 'bl' | 'mass' | 'cms' | 'rms' | 'db' | 'w' | 'none' | 'volt';

/** Units as they follow a number, most specific first; factor converts to the family's base unit. */
const UNITS: [RegExp, Family, number][] = [
  // compound units first, so "mm/N" isn't read as "mm" and "kg/s" as "kg"
  [/^(?:mm\s*\/\s*N|mm\s*N\^?-1)/i, 'cms', 1],
  [/^(?:um|micron)\s*\/\s*N/i, 'cms', 1e-3],
  [/^m\s*\/\s*N/i, 'cms', 1e3],
  [/^(?:kg\s*\/\s*s|N\s*\*?\s*s\s*\/\s*m|mech\.?\s*ohms?)/i, 'rms', 1],
  [/^(?:T\s*\*?\s*m|N\s*\/\s*A|Wb\s*\/\s*m)/i, 'bl', 1],
  [/^kHz/i, 'hz', 1000],
  [/^(?:Hz|hertz)/i, 'hz', 1],
  [/^(?:ohms?|ohm)/i, 'ohm', 1],
  [/^(?:mH)/, 'ind', 1],
  [/^(?:uH)/i, 'ind', 1e-3],
  [/^dB/i, 'db', 1],
  // volume (base: litre)
  [/^(?:cu\.?\s*ft\.?|cubic\s+f(?:ee|oo)t|ft\s*\^?\s*3|ft3)/i, 'vol', 28.3168],
  [/^(?:cu\.?\s*in\.?|cubic\s+inch(?:es)?|in\s*\^?\s*3)/i, 'vol', 0.0163871],
  [/^(?:cm\s*\^?\s*3|cc|ccm)/i, 'vol', 1e-3],
  [/^(?:dm\s*\^?\s*3)/i, 'vol', 1],
  [/^(?:m\s*\^?\s*3)/i, 'vol', 1e3],
  [/^(?:litres?|liters?|ltrs?|lt|L)(?![a-z])/i, 'vol', 1],
  // area (base: cm²)
  [/^(?:cm\s*\^?\s*2|sq\.?\s*cm)/i, 'area', 1],
  [/^(?:mm\s*\^?\s*2)/i, 'area', 0.01],
  [/^(?:in\s*\^?\s*2|sq\.?\s*in(?:ch(?:es)?)?\.?)/i, 'area', 6.4516],
  [/^(?:m\s*\^?\s*2|sq\.?\s*m)/i, 'area', 1e4],
  // length (base: mm)
  [/^mm/i, 'len', 1],
  [/^cm/i, 'len', 10],
  [/^(?:inch(?:es)?|in\.?(?![a-z])|")/i, 'len', 25.4],
  // mass (base: g)
  [/^kg/i, 'mass', 1000],
  [/^(?:grams?|gm?)(?![a-z])/i, 'mass', 1],
  [/^m(?![a-z])/i, 'len', 1000],
  [/^H(?![a-z])/, 'ind', 1000],
  [/^T(?![a-z])/, 'bl', 1],
  [/^(?:watts?|W)(?![a-z])/i, 'w', 1],
  [/^(?:volts?|V)(?![a-z])/i, 'volt', 1],
];

function readUnit(s: string): { fam: Family; factor: number; len: number } | null {
  const lead = s.match(/^\s*/)![0].length;
  const t = s.slice(lead);
  for (const [re, fam, factor] of UNITS) {
    const m = t.match(re);
    if (m) {
      // a unit is a whole word: "mm" in "mmm" or "L" in "Le" isn't one
      const rest = t.slice(m[0].length);
      if (/^[a-z]/i.test(rest)) continue;
      return { fam, factor, len: lead + m[0].length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type Key = TsKey | 'pmax' | 'mmd' | 'ignore';

/** Datasheet labels, roughly in order of specificity. */
const LABELS: [Key, string][] = [
  ['vasL', String.raw`V\s?as|equivalent\s+(?:compliance\s+|air\s+)?volume(?:\s+of\s+(?:suspension|compliance))?|compliance\s+equivalent\s+volume`],
  ['pmax', String.raw`max(?:imum|\.)?\s+power|peak\s+power|music\s+power|program(?:me)?\s+power|P\s?max|P\s?peak`],
  [
    'powerW',
    String.raw`RMS\s+power|power\s+handling(?:\s*\(\s*(?:RMS|AES|nominal|continuous|long[\s-]term)\s*\))?|(?:rated|nominal|continuous|long[\s-]term)\s+power(?:\s+handling)?|power\s*\(\s*(?:RMS|AES|nominal|continuous)\s*\)|P\s?e|P\s?nom|P\s?rms|power`,
  ],
  ['fsHz', String.raw`F\s?s|F_s|F\s?0|Fo|resonan(?:ce|t)\s+freq(?:uency|\.)?(?:\s*\(\s*fs\s*\))?|free[\s-]air\s+resonance|resonance`],
  ['qts', String.raw`Q\s?ts|Q\s?t|total\s+Q(?:\s+factor)?`],
  ['qes', String.raw`Q\s?es|Q\s?e|electrical\s+Q(?:\s+factor)?`],
  ['qms', String.raw`Q\s?ms|Q\s?m|mechanical\s+Q(?:\s+factor)?`],
  ['rmsKgS', String.raw`R\s?ms|mechanical\s+resistance(?:\s+of\s+(?:total\s+)?(?:driver\s+)?suspension)?`],
  ['reOhm', String.raw`R\s?evc|R\s?e|R\s?dc|DC\s+resistance|voice[\s-]coil\s+(?:DC\s+)?resistance`],
  ['leMh', String.raw`L\s?evc|L\s?e(?:\s*(?:@|at)?\s*1\s?kHz)?|L1\s?kHz|voice[\s-]coil\s+inductance(?:\s*(?:@|at)\s*1\s?kHz)?|inductance`],
  ['effDiaMm', String.raw`effective\s+(?:piston\s+|cone\s+|diaphragm\s+|radiating\s+)?dia(?:meter|\.)?|D\s?eff|D\s?d|piston\s+diameter`],
  ['sdCm2', String.raw`S\s?d|effective\s+(?:piston\s+|cone\s+|radiating\s+|diaphragm\s+)?area|(?:piston|cone|radiating|diaphragm)\s+area`],
  ['xmaxMm', String.raw`X\s?max|X\s?lin|(?:max(?:imum|\.)?\s+)?linear\s+(?:excursion|travel)(?:\s*\(\s*one\s+way\s*\))?`],
  ['blTm', String.raw`B\s?[*x]?\s?L(?:\s+product)?|force\s+factor|motor\s+strength`],
  ['mmsG', String.raw`M\s?ms|moving\s+mass(?:\s+(?:incl(?:uding|\.)?|with)\s+air(?:\s+load)?)?`],
  ['mmd', String.raw`M\s?md|(?:diaphragm|cone)\s+mass`],
  ['cmsMmPerN', String.raw`C\s?ms|(?:mechanical\s+|suspension\s+)?compliance(?:\s+of\s+suspension)?`],
  [
    'sensDb',
    String.raw`sensitivity|U?SPL\s?o?|mean\s+SPL|sens\.?|characteristic\s+sensitivity`,
  ],
  ['nominalOhm', String.raw`nominal\s+impedance|rated\s+impedance|impedance|Z\s?nom|Z\s?n`],
  ['vdCm3', String.raw`V\s?d|displacement\s+volume\s*\(\s*Vd\s*\)`],
  // stops: labels whose numbers we don't want (they end the previous label's search)
  [
    'ignore',
    String.raw`X\s?mech|X\s?lim|X\s?damage|H\s?c|H\s?g|H\s?e|EBP|n0|eta0|efficiency|V\s?b|F\s?c|Q\s?tc|F\s?3|(?:net\s+|shipping\s+)?weight|overall\s+diameter|outer\s+diameter|cut-?out(?:\s+diameter)?|baffle\s+hole|mounting\s+depth|depth|frequency\s+(?:response|range)|usable\s+freq(?:uency)?\s+range|magnet(?:\s+weight)?|voice[\s-]coil\s+(?:diameter|height|former|layers?)|VC\s+diameter|coil\s+height|gap\s+height|gap\s+depth|S\s?pl\s+max|max(?:imum)?\s+SPL`,
  ],
];

// one capture group per label; a label is a whole word ("Re" not in "Pre", "Qt" not in "Qtc")
const LABEL_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${LABELS.map(([, s]) => `(${s})`).join('|')})(?![A-Za-z])`, 'gi');

const FAMILY: Record<Exclude<Key, 'ignore'>, Family> = {
  fsHz: 'hz',
  qts: 'none',
  qes: 'none',
  qms: 'none',
  vasL: 'vol',
  sdCm2: 'area',
  effDiaMm: 'len',
  xmaxMm: 'len',
  reOhm: 'ohm',
  nominalOhm: 'ohm',
  leMh: 'ind',
  blTm: 'bl',
  mmsG: 'mass',
  mmd: 'mass',
  cmsMmPerN: 'cms',
  rmsKgS: 'rms',
  sensDb: 'db',
  powerW: 'w',
  pmax: 'w',
  vdCm3: 'vol',
};

const NUM_RE = /(?<![A-Za-z0-9.,])[±~≈]?\s?([-+]?(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:[eE][-+]?\d+)?)/g;

function toNumber(s: string): number {
  let t = s;
  // "1,000" (thousands) vs "0,38" (decimal comma)
  if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  return Number(t);
}

/** One label's value from the text after it (up to the next label). */
function valueAfter(key: Exclude<Key, 'ignore'>, seg: string): number | null {
  const fam = FAMILY[key];
  // a unit before the number: "Vas (ft³) 1.48", "Sd [cm2]: 220"
  const pre = seg.match(/^\s*[(\[]\s*([^)\]]{1,12})[)\]]/);
  const preUnit = pre ? readUnit(pre[1]) : null;
  NUM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(seg))) {
    const x = toNumber(m[1]);
    if (!Number.isFinite(x)) continue;
    const after = seg.slice(m.index + m[0].length);
    const u = readUnit(after);
    if (u) NUM_RE.lastIndex = m.index + m[0].length + u.len; // don't read "cm2"'s 2 as a number
    if (u && u.fam !== fam) {
      // a dimensionless Q has no unit; anything with one belongs to something else
      continue;
    }
    if (fam === 'none') return x;
    if (u) return x * u.factor;
    if (preUnit && preUnit.fam === fam) return x * preUnit.factor;
    return x; // no unit: the form's unit
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paste parser
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/[²]/g, '2')
    .replace(/[³]/g, '3')
    .replace(/[µμ]/g, 'u')
    .replace(/[ΩΩ]/g, 'ohm')
    .replace(/[·•×⋅]/g, '*')
    .replace(/η/g, 'eta')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/ /g, ' ')
    // dot leaders ("Fs ........ 28.5 Hz") and ellipses
    .replace(/\.{2,}|…/g, ' ');
}

const sig = (x: number, n = 4) => Number(x.toPrecision(n));

/**
 * Read T/S parameters from free text ("Fs 28.5 Hz", "Qts: 0.38", "Vas = 1.48 ft³" …),
 * then derive what the standard relations allow. Tolerant: unknown lines are ignored.
 */
export function parseTsText(text: string): TsParseResult {
  const t = normalise(text);
  const found: ParsedItem[] = [];
  const warnings: string[] = [];
  const v: TsValues & { pmax?: number; mmd?: number } = {};
  const matches: { key: Key; start: number; end: number }[] = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(t))) {
    const gi = m.slice(1).findIndex((g) => g !== undefined);
    if (gi < 0) continue;
    let key = LABELS[gi][0];
    // "RMS" in capitals is a power rating, not Rms; "Re" in prose needs a number right after
    if (key === 'rmsKgS' && m[0] === 'RMS') key = 'ignore';
    matches.push({ key, start: m.index, end: m.index + m[0].length });
  }
  const sensSegs: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { key, end } = matches[i];
    if (key === 'ignore') continue;
    let seg = t.slice(end, i + 1 < matches.length ? matches[i + 1].start : t.length);
    // a value sits on the same line or the next one, close to its label
    seg = seg.split('\n').slice(0, 2).join('\n').slice(0, 60);
    const x = valueAfter(key, seg);
    if (x == null || !(x > 0)) continue;
    if (key === 'sensDb') sensSegs.push(seg);
    if ((v as Record<string, number>)[key] !== undefined) {
      const prev = (v as Record<string, number>)[key];
      if (Math.abs(prev - x) / prev > 0.02 && key !== 'pmax')
        warnings.push(`${TS_LABEL[key as TsKey] ?? key} appears twice (${sig(prev)} and ${sig(x)}); kept the first.`);
      continue;
    }
    (v as Record<string, number>)[key] = x;
    if (key !== 'pmax' && key !== 'mmd') {
      const lineEnd = t.indexOf('\n', end);
      found.push({ key, value: sig(x), raw: t.slice(matches[i].start, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 60) });
    }
  }
  // sensitivity at 1 W rather than 2.83 V
  const sensAt1W = sensSegs.some((s) => /\b1\s?W\b/i.test(s)) && !sensSegs.some((s) => /2[.,]83\s?V/i.test(s));

  const out = deriveTs(v, warnings);
  if (v.mmsG === undefined && v.mmd !== undefined && out.values.mmsG === undefined) {
    out.values.mmsG = v.mmd;
    out.derived.push({ key: 'mmsG', value: sig(v.mmd), how: 'from Mmd (cone mass without the air load: Mms is a little higher)' });
  }
  if (out.values.powerW === undefined && v.pmax !== undefined) {
    out.values.powerW = Math.round(v.pmax / 2);
    out.derived.push({ key: 'powerW', value: out.values.powerW, how: `half the ${v.pmax} W peak rating (no RMS rating found)` });
  }
  if (sensAt1W && out.values.sensDb !== undefined) {
    const z = out.values.nominalOhm;
    if (z && Math.abs(z - 8) > 1) {
      const adj = 10 * Math.log10(8 / z);
      out.values.sensDb = sig(out.values.sensDb + adj, 3);
      out.derived.push({ key: 'sensDb', value: out.values.sensDb, how: `datasheet's 1 W figure ${adj > 0 ? '+' : ''}${adj.toFixed(1)} dB for 2.83 V into ${z} Ω` });
    }
  }
  return { values: out.values, found, derived: out.derived, missing: missingFor(out.values), warnings: [...warnings, ...out.warnings] };
}

/** Fields the driver form can't do without. */
export function missingFor(v: TsValues): TsKey[] {
  const need: TsKey[] = ['fsHz', 'reOhm', 'vasL', 'sdCm2', 'xmaxMm', 'nominalOhm'];
  const miss = need.filter((k) => v[k] === undefined);
  if (v.qts === undefined && (v.qes === undefined || v.qms === undefined)) miss.splice(1, 0, 'qts');
  return miss;
}

/**
 * Fill in what the standard relations allow (SI inside):
 *   Qts = Qes·Qms/(Qes+Qms);  Sd = π(D/2)²;  Vas = ρc²·Sd²·Cms;
 *   Fs = 1/(2π√(Mms·Cms));    Qms = 2πFs·Mms/Rms;  Qes = 2πFs·Mms·Re/BL²;  Xmax = Vd/Sd.
 * Values given in the text always win; derived ones are listed with how.
 */
export function deriveTs(given: TsValues, warnings: string[] = []): { values: TsValues; derived: DerivedItem[]; warnings: string[] } {
  const v: TsValues = {};
  for (const k of Object.keys(TS_LABEL) as TsKey[]) if (given[k] !== undefined) v[k] = given[k];
  const derived: DerivedItem[] = [];
  const set = (k: TsKey, x: number, how: string) => {
    if (v[k] !== undefined || !Number.isFinite(x) || !(x > 0)) return false;
    v[k] = x;
    derived.push({ key: k, value: sig(x), how });
    return true;
  };
  const tau = 2 * Math.PI;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const { qts, qes, qms } = v;
    if (qes && qms) changed = set('qts', (qes * qms) / (qes + qms), 'from Qes and Qms') || changed;
    if (qts && qms && qms > qts) changed = set('qes', (qts * qms) / (qms - qts), 'from Qts and Qms') || changed;
    if (qts && qes && qes > qts) changed = set('qms', (qts * qes) / (qes - qts), 'from Qts and Qes') || changed;
    if (v.effDiaMm) changed = set('sdCm2', Math.PI * (v.effDiaMm / 20) ** 2, 'from the effective diameter, π(D/2)²') || changed;
    if (v.sdCm2) changed = set('effDiaMm', 20 * Math.sqrt(v.sdCm2 / Math.PI), 'from Sd') || changed;
    const sd = v.sdCm2 ? v.sdCm2 / 1e4 : undefined; // m²
    const cms = v.cmsMmPerN ? v.cmsMmPerN / 1000 : undefined; // m/N
    const mms = v.mmsG ? v.mmsG / 1000 : undefined; // kg
    if (sd && cms) changed = set('vasL', RHO_C2 * sd * sd * cms * 1000, 'from Cms and Sd, Vas = ρc²·Sd²·Cms') || changed;
    if (sd && v.vasL && !cms) changed = set('cmsMmPerN', (v.vasL / 1000 / (RHO_C2 * sd * sd)) * 1000, 'from Vas and Sd') || changed;
    if (mms && cms) changed = set('fsHz', 1 / (tau * Math.sqrt(mms * cms)), 'from Mms and Cms') || changed;
    if (v.fsHz && cms && !mms) changed = set('mmsG', (1 / ((tau * v.fsHz) ** 2 * cms)) * 1000, 'from Fs and Cms') || changed;
    if (v.fsHz && mms && !cms) changed = set('cmsMmPerN', (1 / ((tau * v.fsHz) ** 2 * mms)) * 1000, 'from Fs and Mms') || changed;
    if (v.fsHz && mms && v.rmsKgS) changed = set('qms', (tau * v.fsHz * mms) / v.rmsKgS, 'from Fs, Mms and Rms') || changed;
    if (v.fsHz && mms && v.qms) changed = set('rmsKgS', (tau * v.fsHz * mms) / v.qms, 'from Fs, Mms and Qms') || changed;
    if (v.fsHz && mms && v.reOhm && v.blTm) changed = set('qes', (tau * v.fsHz * mms * v.reOhm) / v.blTm ** 2, 'from Fs, Mms, Re and BL') || changed;
    if (v.fsHz && mms && v.reOhm && v.qes) changed = set('blTm', Math.sqrt((tau * v.fsHz * mms * v.reOhm) / v.qes), 'from Fs, Mms, Re and Qes') || changed;
    if (v.vdCm3 && v.sdCm2) changed = set('xmaxMm', (v.vdCm3 / v.sdCm2) * 10, 'from Vd / Sd') || changed;
    if (v.xmaxMm && v.sdCm2) changed = set('vdCm3', (v.sdCm2 * v.xmaxMm) / 10, 'Sd · Xmax') || changed;
    if (!changed) break;
  }
  if (v.reOhm && v.nominalOhm === undefined) {
    const z = v.reOhm < 2.4 ? 2 : v.reOhm < 5 ? 4 : v.reOhm < 10 ? 8 : 16;
    set('nominalOhm', z, `guessed from Re ${sig(v.reOhm, 3)} Ω`);
  }
  // consistency checks the user should see
  if (given.qts && given.qes && given.qms) {
    const implied = (given.qes * given.qms) / (given.qes + given.qms);
    if (Math.abs(implied - given.qts) / given.qts > 0.08) warnings.push(`Qes and Qms imply Qts ${implied.toFixed(2)}, but the text says ${given.qts}.`);
  }
  if (given.vasL && given.sdCm2 && given.cmsMmPerN) {
    const implied = RHO_C2 * (given.sdCm2 / 1e4) ** 2 * (given.cmsMmPerN / 1000) * 1000;
    if (Math.abs(implied - given.vasL) / given.vasL > 0.15) warnings.push(`Cms and Sd imply Vas ${implied.toFixed(1)} L, but the text says ${sig(given.vasL)} L — check the units.`);
  }
  if (given.fsHz && given.mmsG && given.cmsMmPerN) {
    const implied = 1 / (tau * Math.sqrt((given.mmsG / 1000) * (given.cmsMmPerN / 1000)));
    if (Math.abs(implied - given.fsHz) / given.fsHz > 0.15) warnings.push(`Mms and Cms imply Fs ${implied.toFixed(1)} Hz, but the text says ${sig(given.fsHz)} Hz.`);
  }
  return { values: v, derived, warnings };
}

// ---------------------------------------------------------------------------
// Impedance (.zma) fit
// ---------------------------------------------------------------------------

export interface ImpedanceFit {
  reOhm: number;
  reSource: 'entered' | 'low-frequency minimum' | 'minimum above Fs';
  fsHz: number;
  qms: number;
  qes: number;
  qts: number;
  zMaxOhm: number;
  f1Hz: number;
  f2Hz: number;
  /** voice-coil inductance (mH) fitted around 1 kHz, if the sweep reaches there */
  leMh?: number;
  notes: string[];
}

/** Motional impedance Res/(1 + jQms(f/Fs − Fs/f)) as [re, im]. */
function motional(f: number, fs: number, qms: number, res: number): [number, number] {
  const x = qms * (f / fs - fs / f);
  return [res / (1 + x * x), (-res * x) / (1 + x * x)];
}

/**
 * Fit Re, Fs, Qms, Qes (and Le) to a free-air impedance sweep with the
 * standard peak method (estimateTS in measurements.ts):
 *   r0 = Zmax/Re;  f1, f2 at |Z| = Re·√r0;  Fs = √(f1·f2);
 *   Qms = Fs·√r0/(f2 − f1);  Qes = Qms/(r0 − 1).
 * Re: the value entered (DC ohmmeter — best), else the sweep's low-frequency
 * minimum (refined by subtracting the fitted motional part), else the minimum
 * above Fs. Le: from the reactance left near 1 kHz after the motional part.
 */
export function fitImpedance(points: MeasPoint[], reEntered?: number): ImpedanceFit | null {
  if (points.length < 10) return null;
  const rough = estimateTS(points, reEntered && reEntered > 0 ? reEntered : undefined);
  if (!rough) return null;
  const notes = rough.notes.filter((n) => !/^Re taken as/.test(n));
  let reSource: ImpedanceFit['reSource'] = reEntered && reEntered > 0 ? 'entered' : 'minimum above Fs';
  let fit = rough;
  if (reSource !== 'entered') {
    // the low-frequency end of the sweep, well below Fs, is close to Re (no inductance there)
    let iLo = 0;
    for (let i = 1; i < points.length && points[i].f < rough.fsHz / 2.5; i++) if (points[i].mag < points[iLo].mag) iLo = i;
    if (points[0].f < rough.fsHz / 2.5) {
      // the motional part still adds to |Z| there (its reactance too, with a low Qms):
      // fit, take the fitted motional impedance off that point, refit until Re settles
      const p = points[iLo];
      let re = Math.min(p.mag, rough.reOhm);
      for (let it = 0; it < 8; it++) {
        const est = estimateTS(points, re);
        if (!est) break;
        fit = est;
        const res = est.reOhm * (est.qms / est.qes);
        const [mr, mi] = motional(p.f, est.fsHz, est.qms, res);
        const rTot = p.phase != null ? p.mag * Math.cos((p.phase * Math.PI) / 180) : Math.sqrt(Math.max(p.mag * p.mag - mi * mi, 0));
        const next = Math.max(rTot - mr, p.mag * 0.5);
        if (Math.abs(next - re) < 1e-4) break;
        re = next;
      }
      reSource = 'low-frequency minimum';
    } else {
      notes.push('The sweep doesn\'t start well below Fs, so Re is the lowest impedance above Fs, which reads slightly high (voice-coil inductance): enter the DC resistance from an ohmmeter for better Qes/Qts.');
    }
  }
  const out: ImpedanceFit = {
    reOhm: fit.reOhm,
    reSource,
    fsHz: fit.fsHz,
    qms: fit.qms,
    qes: fit.qes,
    qts: fit.qts,
    zMaxOhm: fit.zMaxOhm,
    f1Hz: fit.f1Hz,
    f2Hz: fit.f2Hz,
    notes,
  };
  // Le: reactance near 1 kHz minus the motional part, ωLe = X − Xm
  const res = out.reOhm * (out.qms / out.qes);
  const band = points.filter((p) => p.f >= Math.max(500, 8 * out.fsHz) && p.f <= 2000);
  const les: number[] = [];
  for (const p of band) {
    const [mr, mi] = motional(p.f, out.fsHz, out.qms, res);
    const R = out.reOhm + mr;
    let X: number;
    if (p.phase != null) X = p.mag * Math.sin((p.phase * Math.PI) / 180);
    else if (p.mag > R) X = Math.sqrt(p.mag * p.mag - R * R);
    else continue;
    const le = (X - mi) / (2 * Math.PI * p.f);
    if (le > 0) les.push(le * 1000);
  }
  if (les.length >= 3) {
    les.sort((a, b) => a - b);
    out.leMh = les[Math.floor(les.length / 2)];
    if (!points.some((p) => p.phase != null)) notes.push('Le fitted from |Z| alone (no phase column), and real voice coils aren\'t pure inductors: treat Le as approximate.');
  }
  return out;
}

/**
 * Vas from a second sweep with mass added to the cone (added-mass method):
 *   Mms = m / ((Fs/Fs′)² − 1);  Cms = 1/((2πFs)²·Mms);  Vas = ρc²·Sd²·Cms.
 */
export function vasFromAddedMass(fsHz: number, fsAddedHz: number, addedG: number, sdCm2: number): { vasL: number; mmsG: number; cmsMmPerN: number } | null {
  if (!(fsAddedHz > 0 && fsAddedHz < fsHz && addedG > 0 && sdCm2 > 0)) return null;
  const mms = addedG / 1000 / ((fsHz / fsAddedHz) ** 2 - 1);
  const cms = 1 / ((2 * Math.PI * fsHz) ** 2 * mms);
  return { vasL: RHO_C2 * (sdCm2 / 1e4) ** 2 * cms * 1000, mmsG: mms * 1000, cmsMmPerN: cms * 1000 };
}

/**
 * Vas from a second sweep in a sealed box of known net volume (known-volume method):
 *   Vas = Vb·(Fc·Qec / (Fs·Qes) − 1).
 */
export function vasFromBox(fsHz: number, qes: number, fcHz: number, qec: number, boxL: number): number | null {
  if (!(fcHz > fsHz && qec > 0 && qes > 0 && boxL > 0)) return null;
  const v = boxL * ((fcHz * qec) / (fsHz * qes) - 1);
  return v > 0 ? v : null;
}

/** Parse a .zma (or any impedance text export) and fit it. Throws MeasurementParseError on unusable files. */
export function parseZma(text: string, fileName = 'impedance.zma', reEntered?: number): { parsed: ParseResult; fit: ImpedanceFit | null } {
  const parsed = parseMeasurement(text, fileName, 'impedance');
  return { parsed, fit: fitImpedance(parsed.points, reEntered) };
}

/** Parse an .frd on-axis response (freq, dB, phase). Throws MeasurementParseError on unusable files. */
export function parseFrd(text: string, fileName = 'response.frd'): ParseResult {
  return parseMeasurement(text, fileName, 'spl');
}
