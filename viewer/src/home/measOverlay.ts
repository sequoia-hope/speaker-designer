// Predicted-vs-measured overlays: level-align an imported measurement to a
// simulated curve over a stated band, and summarise where they disagree.
// Pure (no Svelte state) so it can be tested without a browser.
import { logGrid, makeInterpolator, smoothOctave, usablePoints, type MeasPoint, type Measurement, type MeasurementKind } from './measurements';

export interface XY {
  x: number;
  y: number;
}

/** Which measurement a chart overlays (persisted per chart in home state). */
export interface OverlaySel {
  on: boolean;
  id: string | null;
}

export interface BandDeviation {
  f0: number;
  f1: number;
  /** the signed difference (measured − predicted, dB) of largest magnitude */
  maxDb: number;
  /** frequency of that largest difference */
  atHz: number;
  rmsDb: number;
}

export interface OverlayCompare {
  /** the measurement shifted by offsetDb, on a log grid over the overlap with the chart */
  points: XY[];
  /** dB added to the measurement to match the prediction's mean over `band` */
  offsetDb: number;
  /** the band actually used for the level match (clipped to both curves) */
  band: [number, number];
  /** deviation by band, over the frequencies both curves cover */
  bands: BandDeviation[];
  /** whole overlap */
  overall: { maxDb: number; atHz: number; rmsDb: number } | null;
  /** −3 dB points (relative to the prediction's level in `band`), null = not inside the data */
  f3Pred: number | null;
  f3Meas: number | null;
  /** lowest frequency in the measurement (so "f3 below the data" can be said) */
  measFMin: number;
}

/** Measurements usable for a chart of this kind (≥ 2 points in their chosen range). */
export function overlayChoices(list: Measurement[], kind: MeasurementKind): Measurement[] {
  return list.filter((m) => m.kind === kind && usablePoints(m).length >= 2);
}

/** The measurement a chart should draw, or null (off, missing, or of the wrong kind). */
export function pickOverlay(list: Measurement[], sel: OverlaySel | undefined, kind: MeasurementKind): Measurement | null {
  if (!sel?.on) return null;
  const choices = overlayChoices(list, kind);
  return choices.find((m) => m.id === sel.id) ?? null;
}

/** Linear interpolation of an x-sorted series at x, on log x; NaN outside it. */
export function seriesAt(pts: XY[], x: number): number {
  const n = pts.length;
  if (!n || x < pts[0].x || x > pts[n - 1].x) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (b.x === a.x) return a.y;
  const t = Math.log(x / a.x) / Math.log(b.x / a.x);
  return a.y + t * (b.y - a.y);
}

function meanOver(pts: XY[], f0: number, f1: number): number {
  const g = logGrid(f0, f1, 24).map((f) => seriesAt(pts, f)).filter(Number.isFinite);
  return g.length ? g.reduce((a, b) => a + b, 0) / g.length : NaN;
}

/**
 * −3 dB point below `refBand`: the highest frequency under the band's lower edge
 * where the curve has fallen 3 dB under `refDb` (interpolated). Null if it never
 * does inside the data.
 */
export function minus3Below(pts: XY[], refDb: number, refLo: number): number | null {
  const lim = refDb - 3;
  for (let i = pts.length - 1; i > 0; i--) {
    const b = pts[i];
    const a = pts[i - 1];
    if (a.x >= refLo || !Number.isFinite(a.y) || !Number.isFinite(b.y)) continue;
    if (b.y >= lim && a.y < lim) {
      const t = (lim - a.y) / (b.y - a.y);
      return a.x * Math.pow(b.x / a.x, t);
    }
  }
  return null;
}

/** Split [f0, f1] at the given edges (only those strictly inside). */
export function splitBands(f0: number, f1: number, edges: number[]): [number, number][] {
  const cuts = [f0, ...edges.filter((e) => e > f0 * 1.05 && e < f1 / 1.05), f1];
  const out: [number, number][] = [];
  for (let i = 1; i < cuts.length; i++) out.push([cuts[i - 1], cuts[i]]);
  return out;
}

function deviationOver(pred: XY[], meas: XY[], f0: number, f1: number): { maxDb: number; atHz: number; rmsDb: number } | null {
  let max = 0;
  let at = NaN;
  let ss = 0;
  let n = 0;
  for (const f of logGrid(f0, f1, 48)) {
    const d = seriesAt(meas, f) - seriesAt(pred, f);
    if (!Number.isFinite(d)) continue;
    ss += d * d;
    n++;
    if (Math.abs(d) >= Math.abs(max)) {
      max = d;
      at = f;
    }
  }
  return n ? { maxDb: max, atHz: at, rmsDb: Math.sqrt(ss / n) } : null;
}

/**
 * Align a measurement to a predicted curve and compare them.
 * - The measurement is smoothed (1/`smooth` octave) and resampled onto a log grid
 *   over the part of [xMin, xMax] it covers.
 * - Its level is shifted so its mean over `alignBand` (clipped to where both
 *   curves exist) equals the prediction's mean there.
 * - Deviation is reported per band between `edges`, over the overlap.
 */
export function compareToPrediction(
  pred: XY[],
  meas: Measurement | MeasPoint[],
  opts: { alignBand: [number, number]; xMin?: number; xMax?: number; smooth?: number; edges?: number[]; ppo?: number }
): OverlayCompare | null {
  const raw = Array.isArray(meas) ? meas : usablePoints(meas);
  const pr = pred.filter((p) => p.x > 0 && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
  if (raw.length < 2 || pr.length < 2) return null;
  const sm = opts.smooth ? smoothOctave(raw, opts.smooth) : raw;
  const it = makeInterpolator(sm);
  const lo = Math.max(it.fMin, opts.xMin ?? it.fMin);
  const hi = Math.min(it.fMax, opts.xMax ?? it.fMax);
  if (!(hi > lo)) return null;
  const grid = logGrid(lo, hi, opts.ppo ?? 48);
  const m0: XY[] = grid.map((x) => ({ x, y: it.mag(x) }));
  // level match over the band, clipped to where both curves exist
  const oLo = Math.max(lo, pr[0].x);
  const oHi = Math.min(hi, pr[pr.length - 1].x);
  if (!(oHi > oLo)) return null;
  let b0 = Math.max(opts.alignBand[0], oLo);
  let b1 = Math.min(opts.alignBand[1], oHi);
  if (!(b1 > b0 * 1.05)) {
    // the band misses the overlap: use the top octave of the overlap instead
    b1 = oHi;
    b0 = Math.max(oLo, oHi / 2);
  }
  const offsetDb = meanOver(pr, b0, b1) - meanOver(m0, b0, b1);
  if (!Number.isFinite(offsetDb)) return null;
  const points = m0.map((p) => ({ x: p.x, y: p.y + offsetDb }));
  const bands: BandDeviation[] = [];
  for (const [f0, f1] of splitBands(oLo, oHi, opts.edges ?? [50, 100, 200, 500, 1000, 2000, 5000])) {
    const d = deviationOver(pr, points, f0, f1);
    if (d) bands.push({ f0, f1, ...d });
  }
  const refDb = meanOver(pr, b0, b1);
  return {
    points,
    offsetDb,
    band: [b0, b1],
    bands,
    overall: deviationOver(pr, points, oLo, oHi),
    f3Pred: minus3Below(pr, refDb, b0),
    f3Meas: minus3Below(points, refDb, b0),
    measFMin: lo,
  };
}

/** A measured impedance on a chart's range (no level change), lightly smoothed. */
export function impedanceOverlay(meas: Measurement, xMin: number, xMax: number, smooth = 24): XY[] {
  const raw = usablePoints(meas);
  if (raw.length < 2) return [];
  const it = makeInterpolator(smoothOctave(raw, smooth));
  const lo = Math.max(it.fMin, xMin);
  const hi = Math.min(it.fMax, xMax);
  if (!(hi > lo)) return [];
  return logGrid(lo, hi, 48).map((x) => ({ x, y: it.mag(x) }));
}

export const fmtHzShort = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
export const fmtDb = (d: number, digits = 1) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)} dB`;
