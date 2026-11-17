// Sheet nesting for flat wood/plate parts: pack each panel's bounding
// rectangle onto stock sheets so that every part comes free with straight
// through-cuts (guillotine cuts), which is what a table saw or track saw can do.
//
// Packer: guillotine best-fit over free rectangles. Every part is inflated by
// the saw kerf, the usable region is the sheet minus the trimmed edge margin
// (plus one kerf, so the last part may run right up to the trim line). Placing
// a part in a free rectangle splits the rest of it into two by one of several
// split rules; we try a handful of part orderings × fit scores × split rules
// and keep the best layout (fewest sheets, then the biggest offcuts, then the
// fewest cuts). Because every free rectangle comes from a straight cut through
// its parent, the cut sequence falls out of the split tree.
//
// Coordinates are mm, origin at the sheet's lower-left corner, y up (as in
// DXF). Sheet grain is taken to run along the sheet's height (y, the 2440 mm
// side of a 4×8); a panel's grain runs along its outline's y (its length).

import { entitiesToDxf, type DxfEntity, type DxfPanel } from './exporters';

export interface NestPart extends DxfPanel {
  /** copies to cut */
  qty: number;
  thickMm: number;
  material: string;
  /** a show face: with "grain matters" on it keeps the sheet's grain (no rotation) */
  visible?: boolean;
  /** never rotate (overrides everything) */
  grainLocked?: boolean;
}

export interface SheetPreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

export const SHEET_PRESETS: SheetPreset[] = [
  { id: '4x8', label: '4 × 8 ft (1220 × 2440)', w: 1220, h: 2440 },
  { id: '5x5', label: '5 × 5 ft Baltic birch (1525 × 1525)', w: 1525, h: 1525 },
  { id: 'half', label: 'Half sheet 4 × 4 ft (1220 × 1220)', w: 1220, h: 1220 },
  { id: 'quarter', label: 'Quarter sheet 2 × 4 ft (610 × 1220)', w: 610, h: 1220 },
];

export interface NestOptions {
  sheetW: number;
  sheetH: number;
  /** saw kerf, mm (default 3.2 — a typical thin-kerf blade) */
  kerfMm?: number;
  /** trimmed off every factory edge, mm (default 10) */
  marginMm?: number;
  /** visible panels keep the sheet's grain direction */
  grainMatters?: boolean;
  /** for the cost estimate */
  pricePerSheet?: number;
}

export interface Placement {
  /** index into the parts passed in */
  part: number;
  copy: number;
  name: string;
  /** global sheet index */
  sheet: number;
  x: number;
  y: number;
  /** placed size (after rotation) */
  w: number;
  h: number;
  rotated: boolean;
}

export interface GuillotineCut {
  /** 'x': a cut along x = pos (parallel to y); 'y': along y = pos */
  axis: 'x' | 'y';
  /** centre of the kerf */
  pos: number;
  from: number;
  to: number;
  kind: 'trim' | 'cut';
}

export interface NestSheet {
  index: number;
  w: number;
  h: number;
  material: string;
  thickMm: number;
  placements: Placement[];
  /** in shop order: each cut runs right through the piece it is made in */
  cuts: GuillotineCut[];
  partArea: number;
  utilisation: number;
}

export interface NestResult {
  sheets: NestSheet[];
  /** parts that fit no sheet (too big, or too big without rotating) */
  unplaced: { part: number; name: string; w: number; h: number; reason: string }[];
  sheetsNeeded: number;
  partArea: number;
  sheetArea: number;
  utilisation: number;
  wastePct: number;
  cost: number | null;
  kerfMm: number;
  marginMm: number;
  heuristic: string;
}

const EPS = 1e-6;

/** bounding box of a panel (outline and any round holes) */
export function partBounds(p: DxfPanel): { x0: number; y0: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const [x, y] of p.outline) add(x, y);
  for (const h of p.holes ?? []) { add(h.x - h.r, h.y - h.r); add(h.x + h.r, h.y + h.r); }
  if (!isFinite(x0)) return { x0: 0, y0: 0, w: 0, h: 0 };
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

export const canRotate = (p: NestPart, grainMatters: boolean) => !p.grainLocked && !(grainMatters && p.visible);

// ---------------------------------------------------------------- packer

interface Item { part: number; copy: number; name: string; w: number; h: number; rot: boolean }
interface Free { x: number; y: number; w: number; h: number; depth: number }
interface RawCut extends GuillotineCut { depth: number; seq: number }
interface Bin { free: Free[]; placed: Placement[]; cuts: RawCut[] }

type Fit = 'baf' | 'bssf' | 'blsf';
type Split = 'sas' | 'las' | 'slas' | 'llas' | 'minas' | 'maxas';
type Order = 'area' | 'long' | 'h' | 'w' | 'perim' | 'short';

const ORDERS: Record<Order, (a: Item, b: Item) => number> = {
  area: (a, b) => b.w * b.h - a.w * a.h || Math.max(b.w, b.h) - Math.max(a.w, a.h),
  long: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || Math.min(b.w, b.h) - Math.min(a.w, a.h),
  short: (a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h) || Math.max(b.w, b.h) - Math.max(a.w, a.h),
  h: (a, b) => b.h - a.h || b.w - a.w,
  w: (a, b) => b.w - a.w || b.h - a.h,
  perim: (a, b) => b.w + b.h - (a.w + a.h),
};

function fitScore(f: Free, w: number, h: number, fit: Fit): [number, number] {
  const lw = f.w - w, lh = f.h - h;
  if (fit === 'baf') return [f.w * f.h - w * h, Math.min(lw, lh)];
  if (fit === 'bssf') return [Math.min(lw, lh), Math.max(lw, lh)];
  return [Math.max(lw, lh), Math.min(lw, lh)];
}

/** true: the first cut runs along y (full width of the free rect) */
function splitAlongY(f: Free, w: number, h: number, s: Split): boolean {
  const lw = f.w - w, lh = f.h - h;
  switch (s) {
    case 'sas': return f.w <= f.h;
    case 'las': return f.w > f.h;
    case 'slas': return lw <= lh;
    case 'llas': return lw > lh;
    case 'minas': return w * lh > lw * h;
    case 'maxas': return w * lh <= lw * h;
  }
}

function packGroup(
  items: Item[],
  rotOk: (it: Item) => boolean,
  SW: number,
  SH: number,
  kerf: number,
  margin: number,
  order: Order,
  fit: Fit,
  split: Split
): { bins: Bin[]; unfit: Item[] } {
  const UW = SW - 2 * margin + kerf, UH = SH - 2 * margin + kerf;
  const bins: Bin[] = [];
  const unfit: Item[] = [];
  let seq = 0;
  const sorted = [...items].sort(ORDERS[order]);
  const newBin = (): Bin => {
    const b: Bin = { free: [{ x: 0, y: 0, w: UW, h: UH, depth: 0 }], placed: [], cuts: [] };
    bins.push(b);
    return b;
  };
  for (const it of sorted) {
    const orients: [number, number, boolean][] = [[it.w + kerf, it.h + kerf, false]];
    if (rotOk(it) && Math.abs(it.w - it.h) > EPS) orients.push([it.h + kerf, it.w + kerf, true]);
    if (!orients.some(([w, h]) => w <= UW + EPS && h <= UH + EPS)) { unfit.push(it); continue; }
    let best: { b: Bin; fi: number; w: number; h: number; rot: boolean; s: [number, number] } | null = null;
    const search = (cands: Bin[]) => {
      for (const b of cands)
        b.free.forEach((f, fi) => {
          for (const [w, h, rot] of orients) {
            if (w > f.w + EPS || h > f.h + EPS) continue;
            const s = fitScore(f, w, h, fit);
            if (!best || s[0] < best.s[0] - EPS || (Math.abs(s[0] - best.s[0]) <= EPS && s[1] < best.s[1] - EPS)) best = { b, fi, w, h, rot, s };
          }
        });
    };
    search(bins);
    if (!best) search([newBin()]);
    const { b, fi, w, h, rot } = best!;
    const f = b.free[fi];
    b.free.splice(fi, 1);
    b.placed.push({ part: it.part, copy: it.copy, name: it.name, sheet: -1, x: margin + f.x, y: margin + f.y, w: rot ? it.h : it.w, h: rot ? it.w : it.h, rotated: rot });
    const lw = f.w - w, lh = f.h - h;
    const alongY = splitAlongY(f, w, h, split);
    const cutY = (y: number, x0: number, x1: number, depth: number) => {
      if (y - EPS > 0) b.cuts.push({ axis: 'y', pos: margin + y - kerf / 2, from: margin + x0, to: Math.min(SW - margin, margin + x1), kind: 'cut', depth, seq: seq++ });
    };
    const cutX = (x: number, y0: number, y1: number, depth: number) => {
      if (x - EPS > 0) b.cuts.push({ axis: 'x', pos: margin + x - kerf / 2, from: margin + y0, to: Math.min(SH - margin, margin + y1), kind: 'cut', depth, seq: seq++ });
    };
    const keep = (r: Free) => { if (r.w > kerf + EPS && r.h > kerf + EPS) b.free.push(r); };
    if (alongY) {
      // full-width cut above the part, then a cut beside it within its strip
      if (lh > EPS) cutY(f.y + h, f.x, f.x + f.w, f.depth);
      if (lw > EPS) cutX(f.x + w, f.y, f.y + h, f.depth + 1);
      keep({ x: f.x, y: f.y + h, w: f.w, h: lh, depth: f.depth + 1 });
      keep({ x: f.x + w, y: f.y, w: lw, h, depth: f.depth + 2 });
    } else {
      if (lw > EPS) cutX(f.x + w, f.y, f.y + f.h, f.depth);
      if (lh > EPS) cutY(f.y + h, f.x, f.x + w, f.depth + 1);
      keep({ x: f.x + w, y: f.y, w: lw, h: f.h, depth: f.depth + 1 });
      keep({ x: f.x, y: f.y + h, w, h: lh, depth: f.depth + 2 });
    }
  }
  return { bins, unfit };
}

function binScore(bins: Bin[]): [number, number, number] {
  // fewest sheets; then the biggest offcuts (sum over sheets of the largest free rect); then fewest cuts
  const off = bins.reduce((a, b) => a + Math.max(0, ...b.free.map((f) => f.w * f.h)), 0);
  const cuts = bins.reduce((a, b) => a + b.cuts.length, 0);
  return [bins.length, -off, cuts];
}

const better = (a: [number, number, number], b: [number, number, number]) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i] - 1e-6) return true;
    if (a[i] > b[i] + 1e-6) return false;
  }
  return false;
};

/** Nest the parts onto sheets: identical-material groups each get their own sheets. */
export function nestPanels(parts: NestPart[], o: NestOptions): NestResult {
  const kerf = Math.max(0, o.kerfMm ?? 3.2);
  const margin = Math.max(0, o.marginMm ?? 10);
  const grain = !!o.grainMatters;
  const SW = o.sheetW, SH = o.sheetH;

  // group by material and thickness, keeping first-seen order
  const groups = new Map<string, number[]>();
  parts.forEach((p, i) => {
    const k = `${p.material}|${p.thickMm}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  });

  const sheets: NestSheet[] = [];
  const unplaced: NestResult['unplaced'] = [];
  const heur: string[] = [];
  for (const idx of groups.values()) {
    const items: Item[] = [];
    for (const i of idx) {
      const b = partBounds(parts[i]);
      for (let c = 0; c < Math.max(0, Math.round(parts[i].qty)); c++) items.push({ part: i, copy: c, name: parts[i].name, w: b.w, h: b.h, rot: false });
    }
    if (!items.length) continue;
    const rotOk = (it: Item) => canRotate(parts[it.part], grain);
    let best: { bins: Bin[]; unfit: Item[]; label: string } | null = null;
    for (const order of Object.keys(ORDERS) as Order[])
      for (const fit of ['baf', 'bssf', 'blsf'] as Fit[])
        for (const split of ['sas', 'las', 'slas', 'llas', 'minas', 'maxas'] as Split[]) {
          const r = packGroup(items, rotOk, SW, SH, kerf, margin, order, fit, split);
          if (!best || better(binScore(r.bins), binScore(best.bins))) best = { ...r, label: `${order}/${fit}/${split}` };
        }
    heur.push(best!.label);
    for (const it of best!.unfit) {
      const fitsRotated = it.h <= SW - 2 * margin + EPS && it.w <= SH - 2 * margin + EPS;
      unplaced.push({ part: it.part, name: it.name, w: it.w, h: it.h, reason: fitsRotated ? 'fits only turned 90° (across the grain)' : 'bigger than the sheet' });
    }
    const p0 = parts[idx[0]];
    for (const b of best!.bins) {
      const index = sheets.length;
      const placements = b.placed.map((pl) => ({ ...pl, sheet: index }));
      const area = placements.reduce((a, pl) => a + pl.w * pl.h, 0);
      const trims: GuillotineCut[] =
        margin > 0
          ? [
              { axis: 'x', pos: margin - kerf / 2, from: 0, to: SH, kind: 'trim' },
              { axis: 'y', pos: margin - kerf / 2, from: margin, to: SW, kind: 'trim' },
              { axis: 'x', pos: SW - margin + kerf / 2, from: margin, to: SH, kind: 'trim' },
              { axis: 'y', pos: SH - margin + kerf / 2, from: margin, to: SW - margin, kind: 'trim' },
            ]
          : [];
      const cuts = [...b.cuts].sort((a, c) => a.depth - c.depth || a.seq - c.seq).map(({ axis, pos, from, to, kind }) => ({ axis, pos, from, to, kind }));
      sheets.push({ index, w: SW, h: SH, material: p0.material, thickMm: p0.thickMm, placements, cuts: [...trims, ...cuts], partArea: area, utilisation: area / (SW * SH) });
    }
  }
  const partArea = sheets.reduce((a, s) => a + s.partArea, 0);
  const sheetArea = sheets.length * SW * SH;
  const utilisation = sheetArea ? partArea / sheetArea : 0;
  return {
    sheets,
    unplaced,
    sheetsNeeded: sheets.length,
    partArea,
    sheetArea,
    utilisation,
    wastePct: sheetArea ? (1 - utilisation) * 100 : 0,
    cost: o.pricePerSheet != null && isFinite(o.pricePerSheet) ? sheets.length * o.pricePerSheet : null,
    kerfMm: kerf,
    marginMm: margin,
    heuristic: heur.join(', '),
  };
}

// ---------------------------------------------------------------- geometry at the nested position

/** a part's outline and holes moved (and turned 90° CCW if rotated) to its place on the sheet */
export function placedGeometry(part: DxfPanel, pl: Placement): { outline: [number, number][]; holes: { x: number; y: number; r: number }[]; polyHoles: [number, number][][] } {
  const b = partBounds(part);
  const tf = ([u, v]: [number, number]): [number, number] =>
    pl.rotated ? [pl.x + (b.h - (v - b.y0)), pl.y + (u - b.x0)] : [pl.x + (u - b.x0), pl.y + (v - b.y0)];
  return {
    outline: part.outline.map(tf),
    holes: (part.holes ?? []).map((h) => {
      const [x, y] = tf([h.x, h.y]);
      return { x, y, r: h.r };
    }),
    polyHoles: (part.polyHoles ?? []).map((ph) => ph.map(tf)),
  };
}

// ---------------------------------------------------------------- DXF / cut list

export const NEST_LAYERS = [
  { name: 'SHEET', color: 8 },
  { name: 'CUT_OUTSIDE', color: 1 },
  { name: 'CUT_INSIDE', color: 5 },
  { name: 'TEXT', color: 3 },
];

/** Nested-sheet DXF: sheets side by side, panels at their nested places. */
export function nestedDxf(parts: NestPart[], r: NestResult, opts: { gapMm?: number } = {}): string {
  const gap = opts.gapMm ?? 200;
  const ents: DxfEntity[] = [];
  let ox = 0;
  for (const s of r.sheets) {
    ents.push({ kind: 'poly', layer: 'SHEET', pts: [[ox, 0], [ox + s.w, 0], [ox + s.w, s.h], [ox, s.h]] });
    ents.push({ kind: 'text', layer: 'TEXT', x: ox, y: s.h + 30, h: 25, s: `Sheet ${s.index + 1} of ${r.sheets.length}: ${s.w} x ${s.h} mm, ${s.thickMm} mm ${s.material}, ${(s.utilisation * 100).toFixed(0)}% used` });
    ents.push({ kind: 'text', layer: 'TEXT', x: ox, y: s.h + 5, h: 15, s: `kerf ${r.kerfMm} mm allowed between parts (outlines are finished sizes), ${r.marginMm} mm edge trim` });
    for (const pl of s.placements) {
      const g = placedGeometry(parts[pl.part], pl);
      const mv = (pts: [number, number][]) => pts.map(([x, y]) => [x + ox, y] as [number, number]);
      ents.push({ kind: 'poly', layer: 'CUT_OUTSIDE', pts: mv(g.outline) });
      for (const h of g.polyHoles) ents.push({ kind: 'poly', layer: 'CUT_INSIDE', pts: mv(h) });
      for (const h of g.holes) ents.push({ kind: 'circle', layer: 'CUT_INSIDE', x: h.x + ox, y: h.y, r: h.r });
      const th = Math.max(4, Math.min(20, pl.w / 14, pl.h / 4));
      ents.push({ kind: 'text', layer: 'TEXT', x: pl.x + ox + 5, y: pl.y + 5, h: th, s: `${pl.name}${parts[pl.part].qty > 1 ? ` ${pl.copy + 1}/${parts[pl.part].qty}` : ''}${pl.rotated ? ' (turned)' : ''}` });
    }
    ox += s.w + gap;
  }
  return entitiesToDxf(NEST_LAYERS, ents);
}

export interface CutListRow {
  name: string;
  qty: number;
  w: number;
  h: number;
  thickMm: number;
  material: string;
  sheets: number[];
  /** copies cut turned 90° */
  rotated: number;
}

/** identical panels (same name, size, thickness, material) grouped, in input order */
export function cutListRows(parts: NestPart[], r: NestResult): CutListRow[] {
  const rows = new Map<string, CutListRow>();
  parts.forEach((p, i) => {
    const b = partBounds(p);
    const key = `${p.name}|${b.w.toFixed(1)}|${b.h.toFixed(1)}|${p.thickMm}|${p.material}`;
    const row = rows.get(key) ?? { name: p.name, qty: 0, w: b.w, h: b.h, thickMm: p.thickMm, material: p.material, sheets: [], rotated: 0 };
    row.qty += Math.max(0, Math.round(p.qty));
    for (const s of r.sheets)
      for (const pl of s.placements)
        if (pl.part === i) {
          if (!row.sheets.includes(s.index + 1)) row.sheets.push(s.index + 1);
          if (pl.rotated) row.rotated++;
        }
    rows.set(key, row);
  });
  for (const row of rows.values()) row.sheets.sort((a, b) => a - b);
  return [...rows.values()];
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function cutListCsv(parts: NestPart[], r: NestResult): string {
  const rows = cutListRows(parts, r);
  const out: (string | number)[][] = [['Panel', 'Qty', 'Width mm', 'Height mm', 'Thickness mm', 'Material', 'Sheet #', 'Rotated']];
  for (const row of rows)
    out.push([row.name, row.qty, row.w.toFixed(1), row.h.toFixed(1), row.thickMm, row.material, row.sheets.join(' '), row.rotated === 0 ? 'no' : row.rotated === row.qty ? 'yes' : `${row.rotated} of ${row.qty}`]);
  out.push([]);
  out.push(['Sheets', r.sheetsNeeded]);
  out.push(['Sheet size mm', r.sheets[0] ? `${r.sheets[0].w} x ${r.sheets[0].h}` : '']);
  out.push(['Part area m2', (r.partArea / 1e6).toFixed(3)]);
  out.push(['Sheet area m2', (r.sheetArea / 1e6).toFixed(3)]);
  out.push(['Waste %', r.wastePct.toFixed(1)]);
  out.push(['Kerf mm', r.kerfMm]);
  out.push(['Edge trim mm', r.marginMm]);
  if (r.cost != null) out.push(['Est. sheet cost', r.cost.toFixed(2)]);
  for (const u of r.unplaced) out.push(['NOT PLACED', u.name, u.w.toFixed(1), u.h.toFixed(1), u.reason]);
  return out.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}
