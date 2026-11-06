// Speaker build planner: Thiele-Small box alignment → box geometry → joinery-
// consistent cut list → baffle layout → sheet nesting → shop steps.
//
// Everything here is plain, checkable arithmetic. Formulas:
//  • Sealed box (Small 1972):  Vb = Vas / ((Qtc/Qts)² − 1),  fc = fs·Qtc/Qts
//  • Vented box: Keele's QB3/SBB4 fits  Vb ≈ 15·Vas·Qts^2.87, fb ≈ 0.42·fs·Qts^−0.9
//    (good starting points; the response is then evaluated with Small's exact
//    4th-order vented transfer function, including Q_L = 7 box losses)
//  • Port: Helmholtz  fb = c/2π · √(Sp / (Vb · L_eff)),  L_eff = L + 0.732·D
//    (one flanged + one free end), sized for ≤ 17 m/s peak air speed at Xmax.

import type { BoxAlignment } from './roomAcoustics';
import { SPEED_OF_SOUND, boxResponse, toDb } from './roomAcoustics';
import type { DriverInfo } from './drivers';

export type BoxType = 'sealed' | 'vented';
export type PortSide = 'front' | 'rear';
/**
 * Driver arrangement on the baffle.
 *  wt     — tweeter above one woofer (stand-mount 2-way)
 *  mtm    — woofer / tweeter / woofer stacked (D'Appolito)
 *  tower  — tweeter on top, two woofers below (floor-standing 2.5-way)
 *  center — woofer / tweeter / woofer side by side (horizontal centre channel)
 *  sub    — one woofer, no tweeter (subwoofer)
 *  fr     — one full-range driver, no tweeter, no crossover
 */
export type Arrangement = 'wt' | 'mtm' | 'tower' | 'center' | 'sub' | 'fr';
export const isSingleDriver = (a: Arrangement | undefined) => a === 'sub' || a === 'fr';

export interface SheetMaterial {
  id: string;
  name: string;
  thicknessMm: number;
  sheetMm: [number, number];
  notes: string;
  finish: string;
  approxSheetUsd: number;
}

export const MATERIALS: SheetMaterial[] = [
  {
    id: 'bb18',
    name: '18 mm (¾″) Baltic birch plywood',
    thicknessMm: 18,
    sheetMm: [1525, 1525],
    notes:
      'Void-free, strong, holds screws well, edges look nice when rounded over. Sold in 5′×5′ sheets. The best all-round choice for a first build.',
    finish: 'Sand to 220, then Danish oil or water-based poly. Exposed ply edges are a feature.',
    approxSheetUsd: 110,
  },
  {
    id: 'mdf19',
    name: '19 mm (¾″) MDF',
    thicknessMm: 19,
    sheetMm: [1220, 2440],
    notes:
      'Cheap, dead, dimensionally perfect, machines cleanly with a router. Heavy, dusty (wear a respirator), and edges/screw holes are weak; ruined by water. Needs paint or veneer.',
    finish: 'Seal edges with thinned glue or shellac, prime (oil-based), sand, then paint.',
    approxSheetUsd: 55,
  },
  {
    id: 'bb12',
    name: '12 mm (½″) Baltic birch plywood',
    thicknessMm: 12,
    sheetMm: [1525, 1525],
    notes:
      'Lighter and fine for small boxes (< ~10 L) if braced. Use for braces or a double-layer baffle.',
    finish: 'Same as ¾″ birch.',
    approxSheetUsd: 85,
  },
];

export interface BuildOptions {
  arrangement?: Arrangement;
  driverWoofer: DriverInfo;
  driverTweeter: DriverInfo | null;
  boxType: BoxType;
  /** sealed only — target total Q (0.707 = Butterworth, flattest; 0.6 = tighter, drier) */
  targetQtc: number;
  /** vented only — tuning multiplier on the QB3 starting point */
  tuningScale: number;
  volumeScale: number;
  portSide: PortSide;
  materialId: string;
  doubleBaffle: boolean;
  roundoverMm: number;
  quantity: number;
  /** build a matching pair of stands that put the tweeter at this height (mm); 0 = no stands */
  standTweeterHeightMm: number;
  /** proportion of external height to width (tall & narrow = less baffle-step, fits stands) */
  aspect: 'bookshelf' | 'tall' | 'cube';
}

export const DEFAULT_OPTIONS_PARTIAL = {
  boxType: 'sealed' as BoxType,
  targetQtc: 0.707,
  tuningScale: 1.0,
  volumeScale: 1.0,
  portSide: 'front' as PortSide,
  materialId: 'bb18',
  doubleBaffle: false,
  roundoverMm: 12.7,
  quantity: 2,
  standTweeterHeightMm: 1000,
  aspect: 'bookshelf' as const,
};

export interface Panel {
  id: string;
  name: string;
  qtyPerBox: number;
  /** finished size, mm: length (grain/long), width */
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  materialId: string;
  notes: string[];
}

export interface Hole {
  label: string;
  /** centre, mm, from the baffle's left edge (x) and top edge (y) */
  xMm: number;
  yMm: number;
  throughDiaMm: number;
  rebateDiaMm: number | null;
  rebateDepthMm: number | null;
  /** mounting screws on a bolt circle */
  screwPcdMm?: number;
  screwCount?: number;
  /** true when the datasheet gave no bolt circle and we estimated it */
  screwPcdEstimated?: boolean;
  kind: 'tweeter' | 'woofer' | 'port';
}

export function wooferCountOf(a: Arrangement | undefined) {
  return a === 'mtm' || a === 'tower' || a === 'center' ? 2 : 1;
}

export interface PortDesign {
  diameterMm: number;
  lengthMm: number;
  count: number;
  fbHz: number;
  peakVelocityMs: number;
  fitsInBox: boolean;
  firstPipeResonanceHz: number;
}

export interface BoxDesign {
  alignment: BoxAlignment;
  f3Hz: number;
  netVolumeL: number;
  grossInternalL: number;
  /** towers: height of the dead (sand-filled) space below the false floor, mm; 0 = none */
  deadSpaceMm: number;
  arrangement: Arrangement;
  wooferCount: number;
  internalMm: { w: number; h: number; d: number };
  externalMm: { w: number; h: number; d: number };
  wallMm: number;
  baffleMm: number;
  port: PortDesign | null;
  baffleStepHz: number;
  responseDb: { f: number; db: number }[];
  warnings: string[];
  notes: string[];
}

export interface BuildPlan {
  box: BoxDesign;
  material: SheetMaterial;
  panels: Panel[];
  holes: Hole[];
  braces: string[];
  sheets: SheetLayout[];
  shopping: ShoppingItem[];
  steps: BuildStep[];
  massKgPerBox: number;
  stand: StandDesign | null;
  jig: JigSetting[];
  panelOps: PanelOp[];
}

export interface ShoppingItem {
  item: string;
  qty: string;
  why: string;
  approxUsd?: number;
}

export interface BuildStep {
  title: string;
  minutes: number;
  tools: string[];
  skills: string[];
  body: string[];
  check?: string;
  safety?: string;
}

// ---------------------------------------------------------------------------
// 1. Box alignment
// ---------------------------------------------------------------------------

export function designBox(o: BuildOptions): BoxDesign {
  const arr: Arrangement = o.arrangement ?? 'wt';
  const n = wooferCountOf(arr);
  const d0 = o.driverWoofer;
  // N identical woofers in one box behave like one driver with N× Vas and N× Sd
  const d: DriverInfo = { ...d0, vasL: d0.vasL * n, sdCm2: d0.sdCm2 * n, displacementL: (d0.displacementL ?? 0.6) * n };
  const tw = isSingleDriver(arr) ? null : o.driverTweeter;
  const mat = MATERIALS.find((m) => m.id === o.materialId) ?? MATERIALS[0];
  const t = mat.thicknessMm;
  const baffle = o.doubleBaffle ? 2 * t : t;
  const warnings: string[] = [];
  const notes: string[] = [];

  let alignment: BoxAlignment;
  let netL: number;
  let port: PortDesign | null = null;

  if (o.boxType === 'sealed') {
    const qtc = Math.max(o.targetQtc, d.qts * 1.08);
    if (o.targetQtc < d.qts * 1.08)
      warnings.push(
        `This woofer's Qts (${d.qts.toFixed(2)}) is too high for Qtc ${o.targetQtc.toFixed(2)} — the box would be enormous. Using Qtc ${qtc.toFixed(2)}.`
      );
    netL = (d.vasL / ((qtc / d.qts) ** 2 - 1)) * o.volumeScale;
    // actual Qtc for the scaled volume
    const alpha = d.vasL / netL;
    const qtcActual = d.qts * Math.sqrt(alpha + 1);
    const fc = d.fsHz * Math.sqrt(alpha + 1);
    alignment = { kind: 'sealed', fcHz: fc, qtc: qtcActual };
    notes.push(
      `Sealed: Qtc ${qtcActual.toFixed(2)}, system resonance fc = ${fc.toFixed(0)} Hz. Sealed boxes roll off gently (12 dB/octave), which blends well with room gain and with a subwoofer.`
    );
    if (d.qts > 0.6)
      warnings.push(
        `Qts ${d.qts.toFixed(2)} is high for a sealed box; expect a boomy or very large box. A vented box or a lower-Qts woofer suits better.`
      );
  } else {
    if (d.qts > 0.55)
      warnings.push(`Qts ${d.qts.toFixed(2)} is high for a vented box; consider sealed.`);
    if (d.qts < 0.25)
      warnings.push(
        `Qts ${d.qts.toFixed(2)} is very low; a vented box will sound lean unless boosted with EQ.`
      );
    netL = 15 * d.vasL * Math.pow(d.qts, 2.87) * o.volumeScale;
    const fb = 0.42 * d.fsHz * Math.pow(d.qts, -0.9) * o.tuningScale;
    alignment = {
      kind: 'vented',
      fsHz: d.fsHz,
      fbHz: fb,
      qts: d.qts,
      alpha: d.vasL / netL,
      ql: 7,
    };
    port = designPort(d, netL, fb);
    notes.push(
      `Vented: tuned to ${fb.toFixed(0)} Hz. Below that, output falls at 24 dB/octave and the cone unloads, so keep a high-pass (or a sub crossover) below tuning if you play loud.`
    );
  }

  // gross internal = net + woofer displacement + port + braces (~4 %)
  const portVolL = port ? (Math.PI * (port.diameterMm / 2 + 3) ** 2 * port.lengthMm * port.count) / 1e6 : 0;
  const grossL = (netL + (d.displacementL ?? 0.6) + portVolL) * 1.04;

  // ---- proportions ----
  const fw = d0.frameDiaMm;
  const ft = tw?.frameDiaMm ?? 0;
  const gap = 6;
  const portSpan = port && (o.portSide === 'front' && arr !== 'center') ? port.diameterMm + 30 : 0;
  // space the drivers need on the baffle (external, mm)
  let needExtW: number;
  let needExtH: number;
  if (arr === 'center') {
    needExtW = 2 * fw + (ft ? ft + 2 * gap : gap) + 2 * 14;
    needExtH = Math.max(fw, ft) + 2 * 14;
  } else {
    needExtW = Math.max(fw, ft) + 2 * 12;
    const stack = arr === 'mtm' || arr === 'tower' ? 2 * fw + gap : fw;
    needExtH = stack + (ft ? ft + gap : 0) + 2 * 15 + portSpan;
  }
  const ratios =
    o.aspect === 'tall'
      ? { h: 2.2, d: 1.3 }
      : o.aspect === 'cube'
        ? { h: 1.15, d: 1.1 }
        : { h: 1.6, d: 1.25 };
  const V = grossL * 1e6; // mm³
  const depthMin = (d0.mountDepthMm ?? 80) + 25 - (baffle - t);
  let wi: number;
  let hi: number;
  let di: number;
  let deadSpaceMm = 0;
  if (arr === 'tower') {
    // tweeter at seated ear height (≈ standTweeterHeightMm, default ~0.95 m)
    const tweeterFromTop = ft ? ft / 2 + 16 : 60;
    const extH = Math.round((o.standTweeterHeightMm || 950) + tweeterFromTop);
    hi = extH - 2 * t;
    wi = needExtW - 2 * t;
    di = V / (wi * hi);
    // a tall speaker needs a reasonable footprint to be stable (≥ ~10″ deep outside)
    const towerDepthMin = Math.max(depthMin, 230);
    if (di < towerDepthMin) {
      di = towerDepthMin;
    }
    if (V / (wi * di) < hi - t) {
      // the box is taller than the air volume needs: make it deep enough for the
      // woofers and wall off the bottom with a false floor (fill below with sand)
      const activeH = Math.max(V / (wi * di), needExtH - 2 * t);
      deadSpaceMm = Math.max(0, Math.round(hi - activeH - t));
    }
  } else if (arr === 'center') {
    wi = needExtW - 2 * t;
    hi = needExtH - 2 * t;
    di = V / (wi * hi);
    if (di < depthMin) {
      di = depthMin;
    }
    if (di > 1.6 * hi + 120) {
      // too deep for a TV console: grow the height instead
      di = Math.max(depthMin, 1.3 * hi);
      hi = V / (wi * di);
    }
  } else {
    wi = Math.cbrt(V / (ratios.h * ratios.d));
    wi = Math.max(wi, needExtW - 2 * t);
    const hd = V / wi;
    hi = Math.sqrt((hd * ratios.h) / ratios.d);
    di = hd / hi;
    if (hi < needExtH - 2 * t) {
      hi = needExtH - 2 * t;
      di = V / (wi * hi);
    }
    if (di < depthMin) {
      di = depthMin;
      hi = Math.max(V / (wi * di), needExtH - 2 * t);
    }
  }
  // round to whole millimetres
  wi = Math.round(wi);
  hi = Math.round(hi);
  di = Math.round(di);
  if (deadSpaceMm > 0)
    notes.push(
      `Floor-standing: the woofers only need ${netL.toFixed(0)} L, so the bottom ${Math.round(deadSpaceMm)} mm is walled off with a false floor. Fill that space with dry sand through a hole before closing it — a heavy base keeps a tall speaker stable and dead.`
    );
  if (port && port.lengthMm > di - 40 && port.lengthMm < hi) {
    notes.push(
      'The port is longer than the box is deep — it needs a 90° elbow, or mount it on the side/bottom. Alternatively use two smaller ports (shorter for the same tuning).'
    );
  }
  if (port && !port.fitsInBox) {
    warnings.push(
      `Port length ${port.lengthMm.toFixed(0)} mm does not fit. Try "Box volume" ↑, tuning ↑, or a smaller woofer.`
    );
  }

  const ext = { w: wi + 2 * t, h: hi + 2 * t, d: di + t + baffle };

  // baffle step: transition from 4π → 2π radiation at roughly 115/W(m) Hz
  const baffleStepHz = 115 / (Math.min(ext.w, ext.h) / 1000);
  if (!isSingleDriver(arr)) notes.push(
    `Baffle step centred near ${baffleStepHz.toFixed(0)} Hz (narrow ${(ext.w / 25.4).toFixed(1)}″ baffle). The crossover or DSP should add ~3–6 dB of shelf below this, less if the speakers sit near the front wall.`
  );

  const responseDb: { f: number; db: number }[] = [];
  let f3 = 0;
  for (let i = 0; i < 120; i++) {
    const f = 10 * Math.pow(400 / 10, i / 119);
    const db = toDb(boxResponse(alignment, f));
    responseDb.push({ f, db });
  }
  for (const p of responseDb) {
    if (p.db >= -3) {
      f3 = p.f;
      break;
    }
  }

  return {
    alignment,
    f3Hz: f3,
    netVolumeL: netL,
    grossInternalL: (wi * (hi - deadSpaceMm - (deadSpaceMm ? t : 0)) * di) / 1e6,
    deadSpaceMm,
    arrangement: arr,
    wooferCount: n,
    internalMm: { w: wi, h: hi, d: di },
    externalMm: ext,
    wallMm: t,
    baffleMm: baffle,
    port,
    baffleStepHz,
    responseDb,
    warnings,
    notes,
  };
}

export function designPort(d: DriverInfo, netL: number, fbHz: number): PortDesign {
  // Required port area for ≤ 17 m/s peak air speed when the cone moves Xmax at fb
  // (conservative: at fb nearly all the volume velocity leaves through the port).
  const vMax = 17;
  const vd = (d.sdCm2 / 1e4) * (d.xmaxMm / 1000); // m³ (peak)
  const spNeed = (2 * Math.PI * fbHz * vd) / vMax; // m²
  // standard tube sizes (inner diameter, mm)
  const tubes = [35, 41, 51, 64, 76, 89, 102];
  let count = 1;
  let D = tubes.find((x) => Math.PI * (x / 2000) ** 2 >= spNeed);
  if (!D) {
    count = 2;
    D = tubes.find((x) => 2 * Math.PI * (x / 2000) ** 2 >= spNeed) ?? 102;
  }
  const sp = count * Math.PI * (D / 2000) ** 2;
  const Vb = netL / 1000;
  const leff = (sp * (SPEED_OF_SOUND / (2 * Math.PI * fbHz)) ** 2) / Vb; // m
  const L = (leff - 0.732 * (D / 1000) * 1) * 1000; // physical, mm (end correction per tube)
  const peakV = (2 * Math.PI * fbHz * vd) / sp;
  return {
    diameterMm: D,
    lengthMm: Math.max(L, 10),
    count,
    fbHz,
    peakVelocityMs: peakV,
    fitsInBox: L > 10 && L < 600,
    firstPipeResonanceHz: SPEED_OF_SOUND / (2 * (leff + 1e-6)),
  };
}

// ---------------------------------------------------------------------------
// 2. Joinery-consistent cut list
// ---------------------------------------------------------------------------
//
// Construction: "Glued butt box, baffle & back overlay"
//   • front baffle and back panel are the full outer W × H
//   • the two sides sit BETWEEN baffle and back:      H × (D − baffle − t)
//   • top and bottom sit between the sides AND between baffle and back:
//                                                     (W − 2t) × (D − baffle − t)
// so every panel is a plain rectangle cut square on a table saw / track saw,
// and the only visible plywood edges are on the side faces of the baffle and
// back (which get rounded over). This is the most forgiving joint for a first
// build and, glued, it is far stronger than the panels themselves.

export function cutList(box: BoxDesign, o: BuildOptions, mat: SheetMaterial): Panel[] {
  const t = mat.thicknessMm;
  const { w: W, h: H, d: D } = box.externalMm;
  const innerD = D - box.baffleMm - t;
  const panels: Panel[] = [
    {
      id: 'baffle',
      name: o.doubleBaffle ? 'Front baffle — outer layer' : 'Front baffle',
      qtyPerBox: 1,
      lengthMm: H,
      widthMm: W,
      thicknessMm: t,
      materialId: mat.id,
      notes: [
        'Driver holes + flush-mount rebates cut with a router circle jig BEFORE assembly.',
        `Round over the outer edges (${(o.roundoverMm / 25.4).toFixed(2)}″ radius) after glue-up.`,
      ],
    },
  ];
  if (o.doubleBaffle)
    panels.push({
      id: 'baffle2',
      name: 'Front baffle — inner layer',
      qtyPerBox: 1,
      lengthMm: H,
      widthMm: W,
      thicknessMm: t,
      materialId: mat.id,
      notes: [
        'Glued to the outer layer face-to-face. Through-holes only (no rebate); chamfer the inside edge of the woofer hole 45° so the cone can breathe.',
      ],
    });
  panels.push(
    {
      id: 'back',
      name: 'Back panel',
      qtyPerBox: 1,
      lengthMm: H,
      widthMm: W,
      thicknessMm: t,
      materialId: mat.id,
      notes: ['Terminal cup / binding-post holes' + (o.boxType === 'vented' && o.portSide === 'rear' ? ' + port hole.' : '.')],
    },
    {
      id: 'side',
      name: 'Side',
      qtyPerBox: 2,
      lengthMm: H,
      widthMm: innerD,
      thicknessMm: t,
      materialId: mat.id,
      notes: ['Full height; sits between baffle and back.'],
    },
    {
      id: 'topbottom',
      name: 'Top / bottom',
      qtyPerBox: 2,
      lengthMm: W - 2 * t,
      widthMm: innerD,
      thicknessMm: t,
      materialId: mat.id,
      notes: ['Captured between the sides. Cut these to EXACTLY the measured gap between your sides.'],
    }
  );
  if (box.deadSpaceMm > 0) {
    panels.push({
      id: 'divider',
      name: 'False floor (tower)',
      qtyPerBox: 1,
      lengthMm: W - 2 * t,
      widthMm: innerD,
      thicknessMm: t,
      materialId: mat.id,
      notes: [
        `Glued in level, ${Math.round(box.deadSpaceMm)} mm above the inside of the bottom panel. Seal all four edges airtight — the bass chamber is above it.`,
        'Before fitting it, drill a 1″ hole in the bottom panel to pour sand into the space below; plug it afterwards.',
      ],
    });
  }
  // brace: a window brace at mid depth when panels are large enough to ring
  if (box.internalMm.h > 220 || box.internalMm.d > 220) {
    panels.push({
      id: 'brace',
      name: 'Window brace',
      qtyPerBox: 1,
      lengthMm: H - 2 * t,
      widthMm: W - 2 * t,
      thicknessMm: t,
      materialId: mat.id,
      notes: [
        `Cut a window leaving a 38 mm (1½″) frame; glue at mid-depth (${Math.round(innerD / 2)} mm from the baffle's back face). Ties both sides, top and bottom together.`,
        'Make sure the woofer magnet clears it — move it rearward if needed.',
      ],
    });
  }
  return panels;
}

function screws(d: DriverInfo) {
  const n = d.mountingHoles ?? 4;
  if (d.mountingPcdMm) return { screwPcdMm: d.mountingPcdMm, screwCount: n, screwPcdEstimated: false };
  // no bolt circle in the datasheet: screws sit roughly mid-flange
  return { screwPcdMm: (d.frameDiaMm + d.cutoutDiaMm) / 2 + 2, screwCount: n, screwPcdEstimated: true };
}

export function baffleHoles(box: BoxDesign, o: BuildOptions): Hole[] {
  const W = box.externalMm.w;
  const H = box.externalMm.h;
  const arr = box.arrangement;
  const holes: Hole[] = [];
  const gap = 6; // frame-to-frame gap keeps the drivers acoustically close
  const wf = o.driverWoofer;
  const tw = isSingleDriver(arr) ? null : o.driverTweeter;
  const wHole = (x: number, y: number, label: string): Hole => ({
    label,
    xMm: x,
    yMm: y,
    throughDiaMm: wf.cutoutDiaMm,
    rebateDiaMm: wf.flangeMm ? wf.frameDiaMm + 1 : null,
    rebateDepthMm: wf.flangeMm ?? null,
    kind: 'woofer',
    ...screws(wf),
  });
  const tHole = (x: number, y: number): Hole => ({
    label: `Tweeter (${tw!.model})`,
    xMm: x,
    yMm: y,
    throughDiaMm: tw!.cutoutDiaMm,
    rebateDiaMm: tw!.flangeMm ? tw!.frameDiaMm + 1 : null,
    rebateDepthMm: tw!.flangeMm ?? null,
    kind: 'tweeter',
    ...screws(tw!),
  });
  const wl = (i: number) => `Woofer ${box.wooferCount > 1 ? i + ' ' : ''}(${wf.model})`;
  let y = 0;
  if (arr === 'center') {
    const cy = H / 2;
    const span = 2 * wf.frameDiaMm + (tw ? tw.frameDiaMm + 2 * gap : gap);
    let x = (W - span) / 2 + wf.frameDiaMm / 2;
    holes.push(wHole(x, cy, wl(1)));
    x += wf.frameDiaMm / 2 + gap;
    if (tw) {
      x += tw.frameDiaMm / 2;
      holes.push(tHole(x, cy));
      x += tw.frameDiaMm / 2 + gap;
    }
    x += wf.frameDiaMm / 2;
    holes.push(wHole(x, cy, wl(2)));
    y = cy + wf.frameDiaMm / 2;
  } else if (arr === 'mtm') {
    y = 15 + wf.frameDiaMm / 2;
    holes.push(wHole(W / 2, y, wl(1)));
    y += wf.frameDiaMm / 2 + gap;
    if (tw) {
      y += tw.frameDiaMm / 2;
      holes.push(tHole(W / 2, y));
      y += tw.frameDiaMm / 2 + gap;
    }
    y += wf.frameDiaMm / 2;
    holes.push(wHole(W / 2, y, wl(2)));
    y += wf.frameDiaMm / 2;
  } else if (isSingleDriver(arr)) {
    const portSpan = box.port && o.portSide === 'front' ? box.port.diameterMm + 30 : 0;
    y = (H - portSpan) / 2;
    holes.push(wHole(W / 2, y, wl(1)));
    y += wf.frameDiaMm / 2;
  } else {
    // wt and tower: tweeter at the top, woofer(s) below
    y = tw ? tw.frameDiaMm / 2 + 16 : 16;
    if (tw) {
      holes.push(tHole(W / 2, y));
      y += tw.frameDiaMm / 2 + gap;
    }
    for (let i = 1; i <= box.wooferCount; i++) {
      y += wf.frameDiaMm / 2;
      holes.push(wHole(W / 2, y, wl(i)));
      y += wf.frameDiaMm / 2 + (i < box.wooferCount ? gap : 0);
    }
  }
  if (box.port && o.portSide === 'front' && arr !== 'center') {
    y += 14 + box.port.diameterMm / 2 + 4;
    const flare = box.port.diameterMm + 4; // tube OD ≈ ID + ~4 mm wall
    for (let i = 0; i < box.port.count; i++) {
      const x = box.port.count === 1 ? W / 2 : W / 2 + (i === 0 ? -1 : 1) * (flare / 2 + 8);
      holes.push({
        label: `Port ${box.port.count > 1 ? i + 1 : ''}`.trim(),
        xMm: x,
        yMm: y,
        throughDiaMm: flare,
        rebateDiaMm: null,
        rebateDepthMm: null,
        kind: 'port',
      });
    }
  }
  return holes;
}

// ---------------------------------------------------------------------------
// 2b. Stands: a hollow square column between a top plate and a wider base
// ---------------------------------------------------------------------------

export interface StandDesign {
  heightMm: number;
  columnMm: number;
  panels: Panel[];
  notes: string[];
}

export function standDesign(box: BoxDesign, holes: Hole[], o: BuildOptions, mat: SheetMaterial): StandDesign | null {
  if (!o.standTweeterHeightMm) return null;
  if (box.arrangement !== 'wt' && box.arrangement !== 'mtm') return null;
  const t = mat.thicknessMm;
  const tw = holes.find((h) => h.kind === 'tweeter') ?? holes[0];
  const tweeterAboveBottom = box.externalMm.h - tw.yMm;
  const height = Math.round(o.standTweeterHeightMm - tweeterAboveBottom);
  if (height < 150) return null;
  const C = 150; // column outside size
  const colH = height - 2 * t;
  const base = { w: Math.max(box.externalMm.w + 80, 300), d: Math.max(box.externalMm.d + 80, 300) };
  const id = 'stand';
  return {
    heightMm: height,
    columnMm: C,
    notes: [
      `Stand height ${height} mm puts the tweeter at ${o.standTweeterHeightMm} mm (your seated ear height).`,
      'Fill the column with dry sand or kitty litter through a hole in the top plate before closing it: heavy stands stop the speaker rocking and sound tighter.',
      'Put 4 adjustable feet or carpet spikes under the base; 4 small rubber/cork pads between top plate and speaker.',
    ],
    panels: [
      { id: id + '-top', name: 'Stand top plate', qtyPerBox: 1, lengthMm: box.externalMm.d, widthMm: box.externalMm.w, thicknessMm: t, materialId: mat.id, notes: ['Same footprint as the speaker. Drill a 1″ hole in the middle for filling with sand.'] },
      { id: id + '-base', name: 'Stand base', qtyPerBox: 1, lengthMm: base.d, widthMm: base.w, thicknessMm: t, materialId: mat.id, notes: ['Wider than the speaker so it cannot tip.'] },
      { id: id + '-colA', name: 'Stand column, wide side', qtyPerBox: 2, lengthMm: colH, widthMm: C, thicknessMm: t, materialId: mat.id, notes: ['Front and back of the column.'] },
      { id: id + '-colB', name: 'Stand column, narrow side', qtyPerBox: 2, lengthMm: colH, widthMm: C - 2 * t, thicknessMm: t, materialId: mat.id, notes: ['Sits between the wide sides (same butt-joint idea as the speaker).'] },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2c. Per-panel machining operations and router circle-jig settings
// ---------------------------------------------------------------------------

export interface JigSetting {
  hole: string;
  pass: string;
  /** distance from the pivot pin to the FAR (outer) edge of the bit */
  radiusMm: number;
  depthMm: number | 'through';
}

export function jigSettings(holes: Hole[], baffleMm: number): JigSetting[] {
  const out: JigSetting[] = [];
  for (const h of holes) {
    if (h.rebateDiaMm && h.rebateDepthMm) {
      out.push({ hole: h.label, pass: 'Rebate — outer edge', radiusMm: h.rebateDiaMm / 2, depthMm: h.rebateDepthMm });
      out.push({ hole: h.label, pass: 'Rebate — clear the ring inward in ~5 mm steps', radiusMm: h.throughDiaMm / 2 + 6, depthMm: h.rebateDepthMm });
    }
    out.push({ hole: h.label, pass: 'Through-hole (3–4 passes)', radiusMm: h.throughDiaMm / 2, depthMm: 'through' });
  }
  void baffleMm;
  return out;
}

export interface PanelOp {
  panelId: string;
  ops: string[];
}

export function panelOperations(box: BoxDesign, panels: Panel[], holes: Hole[], o: BuildOptions, mat: SheetMaterial): PanelOp[] {
  const t = mat.thicknessMm;
  const f = (mm: number) => `${Math.round(mm)} mm`;
  const innerD = box.externalMm.d - box.baffleMm - t;
  const hasBrace = panels.some((p) => p.id === 'brace');
  const ops: PanelOp[] = [];
  for (const p of panels) {
    const list: string[] = [`Rip to ${f(Math.min(p.lengthMm, p.widthMm))}, crosscut to ${f(Math.max(p.lengthMm, p.widthMm))}.`];
    if (p.id === 'baffle' || p.id === 'baffle2') {
      list.push('Draw a vertical centre line on the FRONT face.');
      for (const h of holes) {
        list.push(
          `${h.label}: mark centre ${f(h.yMm)} from the top edge; drill a ¼″ pivot hole 6 mm deep (not through).`
        );
        if (p.id === 'baffle' && h.rebateDiaMm && h.rebateDepthMm)
          list.push(`  • rebate Ø${h.rebateDiaMm.toFixed(0)} × ${h.rebateDepthMm} mm deep, then through-hole Ø${h.throughDiaMm.toFixed(1)}.`);
        else list.push(`  • through-hole Ø${h.throughDiaMm.toFixed(1)}.`);
        if (h.screwPcdMm && h.screwCount)
          list.push(
            `  • ${h.screwCount} screw holes on a Ø${h.screwPcdMm.toFixed(0)} mm circle${h.screwPcdEstimated ? ' (estimated — mark them through the real driver)' : ''}; pilot 3 mm (⅛″), 15 mm deep.`
          );
      }
      if (p.id === 'baffle2') list.push('Inner layer: through-holes only. Chamfer the back edge of the woofer hole 45°.');
      else if (!o.doubleBaffle) list.push('From the inside face, chamfer the back edge of the woofer hole 45° (router chamfer bit or rasp).');
      list.push(`After assembly: round over the front edges, ${(o.roundoverMm / 25.4).toFixed(2)}″ radius.`);
    } else if (p.id === 'back') {
      list.push('Mark the terminal-cup cut-out ⅓ of the way up, centred; cut with a jigsaw (or two holes for binding posts).');
      if (box.port && o.portSide === 'rear') list.push(`Port hole Ø${(box.port.diameterMm + 4).toFixed(0)} near the top, centred.`);
      list.push('Pencil "INSIDE" on the inside face.');
    } else if (p.id === 'side') {
      list.push(`Face the best-looking face OUT; mark which edge is FRONT.`);
      if (hasBrace) list.push(`On the inside face, draw the brace line ${f(innerD / 2)} back from the front edge — the brace's front face goes on that line.`);
    } else if (p.id === 'topbottom') {
      list.push('Test-fit between the two sides before gluing; plane/sand to a snug push-fit if needed.');
      if (hasBrace) list.push(`Mark the brace line ${f(innerD / 2)} from the front edge.`);
    } else if (p.id === 'divider') {
      list.push(`Mark a level line ${f(box.deadSpaceMm)} up from the inside of the bottom panel on both sides — the false floor's underside goes on it.`);
      list.push('Glue it in, then run a bead of glue/caulk around all four edges from above: it must be airtight.');
    } else if (p.id === 'brace') {
      list.push(`Mark a 38 mm border; drill ½″ holes inside each corner; jigsaw out the window (${f(p.widthMm - 76)} × ${f(p.lengthMm - 76)}).`);
      list.push('Ease the inside edges with sandpaper; it should drop in snug between the walls.');
    } else if (p.id.startsWith('stand')) {
      if (p.id === 'stand-top') list.push('Drill a 1″ fill hole in the centre (sand goes in through here).');
      if (p.id === 'stand-base') list.push('Drill and fit 4 threaded inserts for adjustable feet near the corners.');
    }
    ops.push({ panelId: p.id, ops: list });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 3. Sheet nesting (shelf packing with saw kerf)
// ---------------------------------------------------------------------------

export interface PlacedPart {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SheetLayout {
  sheetMm: [number, number];
  parts: PlacedPart[];
  usedFraction: number;
}

export function nestSheets(panels: Panel[], quantity: number, mat: SheetMaterial, kerf = 3.5): SheetLayout[] {
  const parts: { label: string; w: number; h: number }[] = [];
  for (const p of panels.filter((p) => p.materialId === mat.id)) {
    for (let i = 0; i < p.qtyPerBox * quantity; i++) {
      // long dimension along the sheet's x (rip direction)
      const a = Math.max(p.lengthMm, p.widthMm);
      const b = Math.min(p.lengthMm, p.widthMm);
      parts.push({ label: p.name, w: a, h: b });
    }
  }
  parts.sort((p, q) => q.h - p.h || q.w - p.w);
  const [SW, SH] = mat.sheetMm;
  const margin = 10; // factory edges are often dinged — trim them
  const sheets: SheetLayout[] = [];
  const open = () => {
    const s = { sheetMm: [SW, SH] as [number, number], parts: [] as PlacedPart[], usedFraction: 0, shelves: [] as { y: number; h: number; x: number }[] };
    sheets.push(s);
    return s;
  };
  type S = SheetLayout & { shelves: { y: number; h: number; x: number }[] };
  for (const part of parts) {
    let placed = false;
    for (const s of sheets as S[]) {
      // try existing shelves
      for (const sh of s.shelves) {
        if (part.h <= sh.h && sh.x + part.w <= SW - margin) {
          s.parts.push({ label: part.label, x: sh.x, y: sh.y, w: part.w, h: part.h });
          sh.x += part.w + kerf;
          placed = true;
          break;
        }
      }
      if (placed) break;
      const top = s.shelves.length ? s.shelves[s.shelves.length - 1].y + s.shelves[s.shelves.length - 1].h + kerf : margin;
      if (top + part.h <= SH - margin && margin + part.w <= SW - margin) {
        s.shelves.push({ y: top, h: part.h, x: margin + part.w + kerf });
        s.parts.push({ label: part.label, x: margin, y: top, w: part.w, h: part.h });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const s = open() as S;
      if (part.w > SW - 2 * margin || part.h > SH - 2 * margin) {
        // part bigger than the sheet: place anyway so the UI can flag it
      }
      s.shelves.push({ y: margin, h: part.h, x: margin + part.w + kerf });
      s.parts.push({ label: part.label, x: margin, y: margin, w: part.w, h: part.h });
    }
  }
  for (const s of sheets) {
    s.usedFraction = s.parts.reduce((a, p) => a + p.w * p.h, 0) / (SW * SH);
    delete (s as Partial<S>).shelves;
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// 4. Full plan
// ---------------------------------------------------------------------------

export function makePlan(o0: BuildOptions): BuildPlan {
  const o: BuildOptions = {
    ...o0,
    // a centre speaker sits on/under a TV: port it out the back; a sub has no tweeter
    portSide: o0.arrangement === 'center' ? 'rear' : o0.portSide,
    driverTweeter: isSingleDriver(o0.arrangement) ? null : o0.driverTweeter,
  };
  const mat = MATERIALS.find((m) => m.id === o.materialId) ?? MATERIALS[0];
  const box = designBox(o);
  const panels = cutList(box, o, mat);
  const holes = baffleHoles(box, o);
  const stand = standDesign(box, holes, o, mat);
  const sheets = nestSheets([...panels, ...(stand?.panels ?? [])], o.quantity, mat);
  const jig = jigSettings(holes, box.baffleMm);
  const panelOps = panelOperations(box, [...panels, ...(stand?.panels ?? [])], holes, o, mat);
  const density = mat.id.startsWith('mdf') ? 750 : 680;
  const woodKg =
    panels.reduce((a, p) => a + p.qtyPerBox * p.lengthMm * p.widthMm * p.thicknessMm, 0) * 1e-9 * density;
  const massKgPerBox = woodKg + (o.driverWoofer.massKg ?? 1.5) + (o.driverTweeter?.massKg ?? 0.4) + 0.4;

  const braces = panels.some((p) => p.id === 'brace')
    ? ['One window brace at mid-depth']
    : ['Box is small enough that the glued panels are stiff on their own'];

  const shopping = shoppingList(o, box, mat, sheets.length);
  const steps = buildSteps(o, box, panels, holes, mat);
  if (stand) {
    steps.splice(steps.length - 2, 0, {
      title: 'Build the stands',
      minutes: 120,
      tools: ['Table saw or track saw', 'Clamps', 'Drill', 'Wood glue'],
      skills: ['Glue-ups'],
      body: [
        `Glue the column: two narrow sides between the two wide sides (${stand.columnMm} mm square tube, ${stand.heightMm - 2 * mat.thicknessMm} mm tall).`,
        'Centre the column on the base and the top plate; glue and screw through the plates into the column from outside (pre-drill, countersink).',
        'Fill with dry sand through the hole in the top plate, then plug it.',
        ...stand.notes.slice(2),
      ],
      check: 'Stand sits without rocking on a hard floor; adjust the feet.',
    });
  }
  return { box, material: mat, panels, holes, braces, sheets, shopping, steps, massKgPerBox, stand, jig, panelOps };
}

function shoppingList(o: BuildOptions, box: BoxDesign, mat: SheetMaterial, nSheets: number): ShoppingItem[] {
  const q = o.quantity;
  const items: ShoppingItem[] = [
    {
      item: mat.name,
      qty: `${nSheets} sheet${nSheets > 1 ? 's' : ''} (${(mat.sheetMm[0] / 304.8).toFixed(0)}′×${(mat.sheetMm[1] / 304.8).toFixed(0)}′)`,
      why: 'Cabinet panels. Buy one extra half-sheet if this is your first build — mistakes happen.',
      approxUsd: nSheets * mat.approxSheetUsd,
    },
    {
      item: `Woofer: ${o.driverWoofer.brand} ${o.driverWoofer.model}`,
      qty: `${q}`,
      why: 'Bass/midrange driver.',
      approxUsd: o.driverWoofer.priceUsd ? o.driverWoofer.priceUsd * q : undefined,
    },
  ];
  if (o.driverTweeter)
    items.push({
      item: `Tweeter: ${o.driverTweeter.brand} ${o.driverTweeter.model}`,
      qty: `${q}`,
      why: 'Treble driver.',
      approxUsd: o.driverTweeter.priceUsd ? o.driverTweeter.priceUsd * q : undefined,
    });
  items.push(
    box.arrangement === 'fr'
      ? {
          item: 'No crossover needed — a full-range driver plays the whole band',
          qty: '—',
          why: 'Wire the driver straight to the terminals. Use the AV receiver / DSP to high-pass it around 100–120 Hz so it is not asked for deep bass.',
        }
      : box.arrangement === 'sub'
      ? {
          item: 'Subwoofer plate amplifier with DSP (mounts in the back panel)',
          qty: `${q}`,
          why: 'Powers the sub and provides the low-pass crossover, level, phase/delay and room EQ. Cut the back-panel opening from the amp\'s template.',
        }
      : {
          item: 'Crossover: a published, measured design for this exact driver pair — or an active DSP amplifier',
          qty: `${q}`,
          why: 'The crossover is the part that makes or breaks the sound and it cannot be designed from datasheets alone. For a first build, pick a proven kit/design, or go active (e.g. a 4-channel DSP amp) so you can tune it with a measurement mic.',
        },
    {
      item: 'Wood glue (Titebond II or III)',
      qty: '1 × 16 oz',
      why: 'The glue joint is what holds the box and makes it airtight.',
      approxUsd: 10,
    },
    {
      item: 'Terminal cup or a pair of binding posts',
      qty: `${q}`,
      why: 'Speaker-wire connection on the back panel.',
      approxUsd: 8 * q,
    },
    {
      item: 'Driver mounting screws (#8 × ¾″ pan-head) or T-nuts + M4 machine screws',
      qty: `${q * (o.driverWoofer.mountingHoles ?? 4) + q * (o.driverTweeter?.mountingHoles ?? 3)}`,
      why: 'T-nuts let you remove drivers many times without stripping the wood.',
      approxUsd: 10,
    },
    {
      item: 'Foam gasket tape (3 mm × 6 mm)',
      qty: '1 roll',
      why: 'Under driver flanges so the box is airtight.',
      approxUsd: 8,
    },
    {
      item: o.boxType === 'sealed' ? 'Polyester fibre fill (or recycled denim)' : 'Acoustic foam or denim sheet, ~25 mm',
      qty: o.boxType === 'sealed' ? `${Math.ceil(box.netVolumeL * 0.012 * q * 10) / 10} kg` : `${q} × enough to line 3 walls`,
      why:
        o.boxType === 'sealed'
          ? 'Fill a sealed box loosely ~50–80 %: damps internal reflections and makes the box act a bit larger.'
          : 'Line the back, top and one side of a vented box. Keep the port mouth clear.',
      approxUsd: 15,
    },
    {
      item: '16 AWG speaker wire (internal)',
      qty: '3 m',
      why: 'Crossover to drivers and terminals.',
      approxUsd: 8,
    }
  );
  if (box.port)
    items.push({
      item: `Flared port tube ${box.port.diameterMm} mm (${(box.port.diameterMm / 25.4).toFixed(1)}″) ID, cut to ${box.port.lengthMm.toFixed(0)} mm`,
      qty: `${q * box.port.count}`,
      why: 'Flared ends reduce chuffing. Buy long ones and trim to length.',
      approxUsd: 10 * q * box.port.count,
    });
  return items;
}

function buildSteps(o: BuildOptions, box: BoxDesign, panels: Panel[], holes: Hole[], mat: SheetMaterial): BuildStep[] {
  const fmt = (mm: number) => `${mm.toFixed(0)} mm (${(mm / 25.4).toFixed(2)}″)`;
  const t = mat.thicknessMm;
  const isMdf = mat.id.startsWith('mdf');
  const brace = panels.find((p) => p.id === 'brace');
  const steps: BuildStep[] = [
    {
      title: 'Check your drivers and parts before cutting anything',
      minutes: 20,
      tools: ['Calipers or a ruler'],
      skills: [],
      body: [
        'Have the drivers in hand. Measure the real frame diameter, the cut-out the datasheet asks for, and the flange thickness. Datasheets are sometimes wrong by a few mm.',
        'If anything differs from the numbers in this plan, edit the driver and the cut list updates.',
        'Decide crossover vs. DSP now — it decides whether the back panel needs room inside for a crossover board.',
      ],
      check: `Woofer cut-out ${fmt(o.driverWoofer.cutoutDiaMm)}, frame ${fmt(o.driverWoofer.frameDiaMm)}.`,
    },
    {
      title: 'Break the sheet down into strips',
      minutes: 60,
      tools: ['Table saw, or a track saw / circular saw + straight-edge guide', 'Saw horses or foam board on the floor', 'Tape measure, square, pencil'],
      skills: ['Ripping plywood', 'Crosscutting to length'],
      body: [
        `Follow the sheet layout. First rip long strips at the panel widths (${[...new Set(panels.map((p) => Math.round(Math.min(p.lengthMm, p.widthMm))))].map((w) => fmt(w)).join(', ')}), then crosscut each strip to length.`,
        'Cut all parts that share a dimension at the same fence setting, one after the other. Matching parts matter more than exact parts.',
        'Label every part in pencil (e.g. "L-side-A") on the inside face as you cut.',
      ],
      check: 'Stack the two sides on top of each other — they should match to within a hair. Check every part is square with a framing square.',
      safety: 'Use a riving knife and push stick on a table saw; never stand directly behind the blade. Support the whole sheet — a sagging sheet pinches the blade.',
    },
    {
      title: 'Cut the driver holes in the baffle (before assembly)',
      minutes: 75,
      tools: ['Plunge router', 'Circle-cutting jig (e.g. Jasper 200 or a home-made trammel)', '¼″ or ⅜″ straight/spiral bit', 'Drill'],
      skills: ['Router circle cutting', 'Flush-mount rebates'],
      body: [
        `Mark the vertical centre line of the baffle. Hole centres (from the top edge): ${holes.map((h) => `${h.label} at ${fmt(h.yMm)}`).join('; ')}.`,
        'For each driver: drill a ¼″ pivot hole at the centre. First cut the flush-mount rebate (the wider, shallow recess) in 2–3 mm passes to the flange depth, then reset the jig and cut the through-hole in several passes.',
        'Practice on a scrap first and test-fit the actual driver. A driver that drops in with ~0.5 mm of play is perfect.',
        ...(o.doubleBaffle
          ? ['On the inner baffle layer cut only the through-holes, then glue both layers face to face with the holes aligned (use dowels or two screws through waste to register).']
          : []),
        'Chamfer or round the back edge of the woofer hole at 45° from inside — this lets the air behind the cone escape freely.',
      ],
      check: 'Driver sits flat and flush; the rebate is the same depth all the way round.',
      safety: 'Clamp the baffle down and the waste piece too — the centre disk can fly loose on the final pass.',
    },
    {
      title: 'Back panel holes',
      minutes: 20,
      tools: ['Jigsaw or hole saw', 'Drill'],
      skills: [],
      body: [
        'Cut the terminal-cup hole (use the cup\'s template) or drill two holes for binding posts, about ⅓ of the way up the back.',
        ...(box.port && o.portSide === 'rear' ? [`Cut the port hole (${fmt(box.port.diameterMm + 4)}) near the top, centred.`] : []),
      ],
    },
    ...(brace
      ? [
          {
            title: 'Make the window brace',
            minutes: 25,
            tools: ['Drill with ½″ bit', 'Jigsaw', 'File / sandpaper'],
            skills: ['Interior cut-outs with a jigsaw'],
            body: [
              `Mark a 38 mm (1½″) border on the brace blank (${fmt(brace.lengthMm)} × ${fmt(brace.widthMm)}). Drill a hole inside each corner, then jigsaw between them.`,
              'It only needs to be stiff, not pretty. Hold it up to the woofer: the magnet must clear the brace.',
            ],
          } as BuildStep,
        ]
      : []),
    {
      title: 'Dry fit',
      minutes: 15,
      tools: ['Clamps (4+ bar clamps, 24″ or longer)', 'Painter\'s tape'],
      skills: [],
      body: [
        'Assemble the box with no glue and clamp it. Check that the top/bottom fit snugly between the sides and that baffle and back cover everything with nothing sticking out.',
        'If something is proud by a millimetre, that is fine — a flush-trim bit fixes it later. Gaps are the enemy, not overhangs.',
      ],
      check: 'Measure both diagonals of the open box — equal diagonals mean it is square.',
    },
    {
      title: 'Glue-up: sides, top, bottom onto the back',
      minutes: 45,
      tools: ['Wood glue', 'Clamps', 'Square', 'Damp rag', 'Optional: brad nailer (18 ga, 1¼″)'],
      skills: ['Glue-ups', 'Squaring a box'],
      body: [
        'Lay the back panel inside-face up. Glue and stand the two sides on it, then slide top and bottom in between the sides.',
        ...(isMdf ? ['MDF edges drink glue: pre-coat edges with a thin layer, wait 5 minutes, then glue again.'] : []),
        'Brad nails (or a couple of screws in pre-drilled holes) hold parts while you clamp — the glue provides the strength.',
        ...(brace ? ['Glue the window brace in at mid-depth now, while you can reach.'] : []),
        'Clamp, check diagonals, and wipe squeeze-out. Leave 1 hour before unclamping, 24 h before stressing.',
      ],
      check: 'Diagonals equal; open front edges all lie in one plane (lay a straight-edge across).',
    },
    {
      title: 'Seal the inside, then glue on the baffle',
      minutes: 40,
      tools: ['Glue or acrylic caulk', 'Clamps'],
      skills: ['Air-tight seams'],
      body: [
        'Run a bead of glue or caulk along every inside seam and smooth it with a finger. Air leaks whistle and smear the bass.',
        o.boxType === 'sealed'
          ? 'Leave the polyfill for later (it goes in through the woofer hole).'
          : 'Staple or glue the damping to the back, top and one side panel now — easier than through the woofer hole.',
        'Glue and clamp the baffle on. Lots of clamps, even pressure.',
      ],
    },
    {
      title: 'Flush trim and round over',
      minutes: 45,
      tools: ['Router (handheld or table)', 'Flush-trim bit', `Round-over bit, ${(o.roundoverMm / 25.4).toFixed(2)}″ radius`],
      skills: ['Flush trimming', 'Round-overs'],
      body: [
        'Trim any overhanging edges flush with a flush-trim bit (bearing rides on the neighbouring panel).',
        `Round over the baffle edges. Besides looking good, a ${(o.roundoverMm / 25.4).toFixed(2)}″ radius softens the diffraction ripple from the tweeter. Round all other edges with a smaller radius or sandpaper.`,
      ],
      safety: 'Move the router counter-clockwise around the outside of the box (against the bit rotation). Take two light passes for large round-overs.',
    },
    {
      title: 'Sand and finish',
      minutes: 120,
      tools: ['Random-orbit sander', '120 / 180 / 220 grit', 'Rags or brushes'],
      skills: ['Finishing'],
      body: [
        mat.finish,
        'Mask the driver rebates so the gasket seats on bare, flat wood.',
        'Finish takes the longest — several coats with drying time between. This is a good weekend activity while you work on the crossover.',
      ],
      safety: isMdf ? 'MDF dust is very fine: respirator (P100) and dust extraction, always.' : 'Oily rags can self-ignite: lay them flat to dry outside.',
    },
    {
      title: 'Wire, fill, and mount the drivers',
      minutes: 60,
      tools: ['Soldering iron', 'Screwdriver (hand — not an impact driver!)', 'Drill + pilot bit'],
      skills: ['Soldering', 'Polarity'],
      body: [
        'Mount the crossover (or run wires for an active setup) on the back panel, install the terminal cup.',
        'Put gasket tape under each driver flange. Drill pilot holes; drive screws by hand in a star pattern, snug but not cranked.',
        o.boxType === 'sealed'
          ? `Fill the box loosely with ~${(box.netVolumeL * 12).toFixed(0)} g of polyfill before the woofer goes in.`
          : 'Fit the port tube; it should be glued airtight to the baffle and its inner end must be at least one port-diameter away from any wall.',
        'Check polarity on every driver with a 1.5 V battery: positive to red should push the cone OUT.',
      ],
      check:
        o.boxType === 'sealed'
          ? 'Gently press the woofer cone in: it should come back out slowly. If it springs back instantly or hisses, there is an air leak.'
          : 'Play a low sine tone at the tuning frequency — the port should move lots of air while the cone barely moves.',
    },
    {
      title: 'Measure and tune in the room',
      minutes: 120,
      tools: ['Measurement mic (e.g. UMIK-1)', 'REW (free Room EQ Wizard software)', 'Laptop'],
      skills: ['Room measurement'],
      body: [
        'Place the speakers at the positions from the Room tab. Measure at the listening seat.',
        'Move speakers in 5–10 cm steps to reduce the biggest bass dip — dips cannot be fixed by EQ, peaks can.',
        'Use EQ only to cut the big room-mode peaks below ~200 Hz.',
      ],
    },
  ];
  return steps;
}

/** Short shop-skill explainers: what the task is and what tool does it. */
export const SHOP_SKILLS: { name: string; tools: string; what: string }[] = [
  {
    name: 'Ripping & crosscutting plywood',
    tools: 'Table saw, or track saw / circular saw + clamped straight-edge',
    what: 'Ripping = cutting along the long direction of a sheet into strips; crosscutting = cutting strips to length. The goal is square, identical parts. Cut a little oversize when in doubt and sneak up on the final size.',
  },
  {
    name: 'Router circle cutting',
    tools: 'Plunge router + circle jig (trammel) + spiral bit',
    what: 'The router pivots on a pin at the hole centre and cuts a perfect circle in several shallow passes. Used for driver holes, rebates (shallow wider recesses so the driver sits flush) and port holes.',
  },
  {
    name: 'Flush-mount rebate',
    tools: 'Router + circle jig',
    what: 'A shallow recess as deep as the driver flange so the driver face is level with the baffle. Reduces diffraction (reflections off the flange edge) — mostly matters for tweeters.',
  },
  {
    name: 'Glue-up',
    tools: 'Wood glue, bar/F clamps, square, brad nailer optional',
    what: 'Apply a thin even coat to both mating surfaces, assemble, clamp with even pressure, check square by measuring diagonals, wipe squeeze-out. Glued wood joints are stronger than the wood.',
  },
  {
    name: 'Flush trimming',
    tools: 'Router + flush-trim bit (bearing at the tip or shank)',
    what: 'The bearing rolls on one panel while the cutter trims the overhanging neighbour exactly flush. Makes a slightly-off glue-up look perfect.',
  },
  {
    name: 'Round-over',
    tools: 'Router + round-over bit',
    what: 'Rounds a sharp edge to a radius. On a speaker baffle it softens edge diffraction and looks professional.',
  },
  {
    name: 'Bracing',
    tools: 'Jigsaw, drill',
    what: 'Internal braces stiffen large panels so they do not vibrate and colour the sound. A "window brace" is a panel with its middle cut out that ties all four walls together.',
  },
  {
    name: 'Air-sealing',
    tools: 'Glue or acrylic caulk, foam gasket tape',
    what: 'A speaker box must be airtight (except the port). Seal inside seams and gasket every driver flange; test by pressing the woofer cone gently.',
  },
  {
    name: 'Soldering & polarity',
    tools: 'Soldering iron (40–60 W), rosin-core solder, battery for polarity check',
    what: 'Join wires to crossover parts and driver tabs. Every driver must be wired with the correct polarity or the sound gets thin and hollow.',
  },
];
