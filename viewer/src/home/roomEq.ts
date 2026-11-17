// Room-mode EQ: propose a few parametric cuts that flatten the bass peaks of a
// listening-position response towards its own smoothed trend, and write them
// out in the REW / Equalizer APO text format. Pure (no Svelte state).
//
// Cuts only: a room-mode peak is a minimum-phase resonance the EQ can tame, but a
// null is the room cancelling the sound at that seat — boosting it burns amplifier
// power and excursion and barely moves the dip (and makes it worse elsewhere).
import { logGrid, smoothOctave } from './measurements';

export interface PeqFilter {
  fc: number;
  /** dB; always ≤ 0 from the fit */
  gainDb: number;
  q: number;
}

/** Sample rate the biquads are evaluated at (APO / miniDSP-style; irrelevant below ~1 kHz). */
export const EQ_FS = 48000;

/**
 * Magnitude (dB) of an RBJ-cookbook peaking EQ biquad at f:
 * A = 10^(G/40), w0 = 2π fc / fs, α = sin w0 / (2Q),
 * b = [1 + αA, −2cos w0, 1 − αA], a = [1 + α/A, −2cos w0, 1 − α/A].
 */
export function peakingDb(f: number, fc: number, gainDb: number, q: number, fs = EQ_FS): number {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  const b0 = 1 + alpha * A;
  const b1 = -2 * c;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * c;
  const a2 = 1 - alpha / A;
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  // H(e^{jw}) = (b0 + b1 e^{-jw} + b2 e^{-2jw}) / (a0 + a1 e^{-jw} + a2 e^{-2jw})
  const nr = b0 + b1 * cw + b2 * c2;
  const ni = -(b1 * sw + b2 * s2);
  const dr = a0 + a1 * cw + a2 * c2;
  const di = -(a1 * sw + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Summed magnitude (dB) of a filter bank at f. */
export function eqDb(f: number, filters: PeqFilter[], fs = EQ_FS): number {
  let s = 0;
  for (const p of filters) s += peakingDb(f, p.fc, p.gainDb, p.q, fs);
  return s;
}

export interface EqStats {
  rmsDb: number;
  maxDb: number;
  aboveRmsDb: number;
}

export interface RoomEqResult {
  filters: PeqFilter[];
  /** the fit grid (log-spaced) and the curves on it */
  freqs: number[];
  input: number[];
  target: number[];
  corrected: number[];
  /** deviation from the target over the fit range, before and after (aboveRmsDb: the part above it — what cuts can fix) */
  before: EqStats;
  after: EqStats;
  fMin: number;
  fMax: number;
}

export interface RoomEqOptions {
  /** fit range (Hz); the top defaults to 300 or the end of the data */
  fMin?: number;
  fMax?: number;
  maxFilters?: number;
  /** smoothing of the target trend (octaves: 1 = 1-octave window) */
  trendOct?: number;
  /** stop when no peak stands this far above the target */
  minPeakDb?: number;
  maxCutDb?: number;
  qMin?: number;
  qMax?: number;
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / Math.max(1, xs.length));

function devStats(dev: number[]) {
  return { rmsDb: rms(dev), maxDb: dev.reduce((a, b) => Math.max(a, Math.abs(b)), 0), aboveRmsDb: rms(dev.map((d) => Math.max(0, d))) };
}

/**
 * The smoothed trend a room EQ aims at: 1/`oct`-octave smoothing made robust to
 * the peaks and nulls themselves (each pass clips the curve to ±1 dB around the
 * previous trend before re-smoothing), so a big mode doesn't drag the target up
 * under itself, nor a deep null pull it down.
 */
export function trendOf(freqs: number[], db: number[], oct = 1, passes = 4): number[] {
  const sm = (ys: number[]) => smoothOctave(freqs.map((f, i) => ({ f, mag: ys[i] })), 1 / oct).map((p) => p.mag);
  let t = sm(db);
  for (let k = 0; k < passes; k++) t = sm(db.map((v, i) => Math.min(t[i] + 1, Math.max(t[i] - 1, v))));
  return t;
}

/**
 * Greedy room-mode EQ fit. On a 48 ppo log grid over [fMin, fMax]:
 * target = the 1-octave smoothed response; repeatedly take the largest peak
 * left above it, start a cut there (gain = −height, Q from its −half-height width),
 * refine fc / gain / Q by pattern search on the squared error to the target
 * (gain held ≤ 0), and stop at maxFilters or when no peak exceeds minPeakDb.
 */
export function fitRoomEq(freqs: number[], db: number[], opts: RoomEqOptions = {}): RoomEqResult {
  const pairs = freqs.map((f, i) => ({ f, mag: db[i] })).filter((p) => p.f > 0 && Number.isFinite(p.mag)).sort((a, b) => a.f - b.f);
  const fMin = Math.max(opts.fMin ?? 20, pairs[0]?.f ?? 20);
  const fMax = Math.min(opts.fMax ?? 300, pairs[pairs.length - 1]?.f ?? 300);
  const maxFilters = opts.maxFilters ?? 6;
  const minPeak = opts.minPeakDb ?? 1.5;
  const maxCut = opts.maxCutDb ?? 15;
  const qMin = opts.qMin ?? 0.7;
  const qMax = opts.qMax ?? 12;
  const empty: EqStats = { rmsDb: 0, maxDb: 0, aboveRmsDb: 0 };
  if (pairs.length < 4 || !(fMax > fMin * 1.2)) {
    return { filters: [], freqs: [], input: [], target: [], corrected: [], before: empty, after: empty, fMin, fMax };
  }
  // log-resample the input over the fit range
  const g = logGrid(fMin, fMax, 48);
  const interp = (f: number) => {
    const i = pairs.findIndex((p) => p.f >= f);
    if (i < 0) return pairs[pairs.length - 1].mag;
    if (i === 0) return pairs[0].mag;
    const a = pairs[i - 1];
    const b = pairs[i];
    const t = Math.log(f / a.f) / Math.log(b.f / a.f);
    return a.mag + t * (b.mag - a.mag);
  };
  const y = g.map(interp);
  const target = trendOf(g, y, opts.trendOct ?? 1);
  const base = y.map((v, i) => v - target[i]); // deviation before EQ
  const filters: PeqFilter[] = [];
  const bank = new Array(g.length).fill(0); // the fixed filters' sum
  const cost = (extra: PeqFilter | null) => {
    let s = 0;
    for (let i = 0; i < g.length; i++) {
      const r = base[i] + bank[i] + (extra ? peakingDb(g[i], extra.fc, extra.gainDb, extra.q) : 0);
      s += r * r;
    }
    return s;
  };
  const clampF = (p: PeqFilter): PeqFilter => ({
    fc: Math.min(fMax, Math.max(fMin, p.fc)),
    gainDb: Math.min(0, Math.max(-maxCut, p.gainDb)),
    q: Math.min(qMax, Math.max(qMin, p.q)),
  });

  while (filters.length < maxFilters) {
    // largest peak left above the target
    let k = -1;
    for (let i = 0; i < g.length; i++) {
      const r = base[i] + bank[i];
      if (k < 0 || r > base[k] + bank[k]) k = i;
    }
    const h = base[k] + bank[k];
    if (!(h >= minPeak)) break;
    // width at half the peak height → Q
    let a = k;
    let b = k;
    while (a > 0 && base[a] + bank[a] > h / 2) a--;
    while (b < g.length - 1 && base[b] + bank[b] > h / 2) b++;
    const bw = Math.max(g[b] - g[a], g[k] * 0.02);
    let best = clampF({ fc: g[k], gainDb: -h, q: g[k] / bw });
    let bestCost = cost(best);
    // pattern search in (log fc, gain, log Q)
    let step = { f: 0.04, g: 1.5, q: 0.25 };
    for (let it = 0; it < 60 && step.g > 0.05; it++) {
      let improved = false;
      const tries: PeqFilter[] = [
        { ...best, fc: best.fc * Math.exp(step.f) },
        { ...best, fc: best.fc * Math.exp(-step.f) },
        { ...best, gainDb: best.gainDb + step.g },
        { ...best, gainDb: best.gainDb - step.g },
        { ...best, q: best.q * Math.exp(step.q) },
        { ...best, q: best.q * Math.exp(-step.q) },
      ];
      for (const t of tries) {
        const c = clampF(t);
        const v = cost(c);
        if (v < bestCost - 1e-9) {
          best = c;
          bestCost = v;
          improved = true;
        }
      }
      if (!improved) step = { f: step.f / 2, g: step.g / 2, q: step.q / 2 };
    }
    // a cut that doesn't help (or rounds to nothing) ends the fit
    if (best.gainDb > -0.5 || bestCost >= cost(null) - 1e-6) break;
    best = { fc: Math.round(best.fc * 10) / 10, gainDb: Math.round(best.gainDb * 10) / 10, q: Math.round(best.q * 100) / 100 };
    filters.push(best);
    for (let i = 0; i < g.length; i++) bank[i] += peakingDb(g[i], best.fc, best.gainDb, best.q);
  }
  const corrected = y.map((v, i) => v + bank[i]);
  return {
    filters: filters.sort((p, q) => p.fc - q.fc),
    freqs: g,
    input: y,
    target,
    corrected,
    before: devStats(base),
    after: devStats(base.map((v, i) => v + bank[i])),
    fMin,
    fMax,
  };
}

/**
 * REW / Equalizer APO text: one "Filter N: ON PK Fc … Hz Gain … dB Q …" line per
 * filter, after a "Preamp: −x dB" line when any gain is positive (so the boosts
 * can't clip).
 */
export function toApoText(filters: PeqFilter[], header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(...header.split('\n').map((l) => `# ${l}`));
  const boost = Math.max(0, ...filters.map((f) => f.gainDb));
  if (boost > 0) lines.push(`Preamp: -${boost.toFixed(1)} dB`);
  filters.forEach((f, i) => lines.push(`Filter ${i + 1}: ON PK Fc ${f.fc.toFixed(1)} Hz Gain ${f.gainDb.toFixed(1)} dB Q ${f.q.toFixed(2)}`));
  return lines.join('\n') + '\n';
}

/** Parse APO / REW filter text back (PK filters only; others are skipped). */
export function parseApoText(text: string): { preampDb: number; filters: PeqFilter[] } {
  let preampDb = 0;
  const filters: PeqFilter[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const pre = /^Preamp:\s*([-+]?\d+(?:\.\d+)?)\s*dB/i.exec(line);
    if (pre) {
      preampDb = +pre[1];
      continue;
    }
    const m = /^Filter\s*\d*\s*:\s*ON\s+PK\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+([-+]?[\d.]+)\s*dB\s+Q\s+([\d.]+)/i.exec(line);
    if (m) filters.push({ fc: +m[1], gainDb: +m[2], q: +m[3] });
  }
  return { preampDb, filters };
}
