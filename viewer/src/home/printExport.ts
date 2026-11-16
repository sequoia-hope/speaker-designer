// Files to make a design: STL of every printed piece (as the print plan splits
// them), DXF of the plywood / sandwich plates and of plywood panels.
//
// Printed pieces are built in millimetres: each print-plan segment is the
// printed profile (outline − chambers, only the printed caps for "bends"
// construction, minus the driver's wall) clipped to the segment's rectangle
// and extruded by its height. The driver's wall is a separate flat piece with
// its holes (it prints flat, so the round holes need no support, and glues to
// the core). Waveguide inserts, the tweeter pod and resonance traps are added.

import * as THREE from 'three';
import pc from 'polygon-clipping';
import type { Geometry, HeadGeometry, HybridParams, Printer, Pt, PrintPlan, RoundWaveguide } from './hybrid';
import type { DriverInfo } from './drivers';
import type { BuildPlan } from './speakerBuild';
import { meshesToStl, panelsToDxf, type DxfPanel } from './exporters';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { layOut, recipeVolume, writeStep, writeWaffle, type CadPart, type Loop2, type Recipe } from './cad';

type Ring = [number, number][];
const ring = (poly: Pt[]): Ring => [...poly.map(([x, y]) => [x, y] as [number, number]), [poly[0][0], poly[0][1]]];
const rectRing = (x0: number, x1: number, y0: number, y1: number): Ring => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const open = (r: Ring): [number, number][] => r.slice(0, -1);

/** Rounded rectangle W × H (profile mm) — the outer plates' and dividers' outline. */
export function plateOutline(W: number, H: number): Pt[] {
  const r = Math.min(25, W / 4, H / 4);
  const out: Pt[] = [];
  const corners: [number, number, number][] = [
    [r, r, Math.PI],
    [W - r, r, -Math.PI / 2],
    [W - r, H - r, 0],
    [r, H - r, Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return out;
}

/** The driver's wall, cut out of the printed profile and made as its own piece. */
export function driverWallRect(g: Geometry, woofer: DriverInfo): { x0: number; x1: number; y0: number; y1: number } {
  const t = g.wallMm;
  const dv = g.driver;
  if (dv.face === 'front') return { x0: g.W - t, x1: g.W, y0: -1, y1: g.H + 1 };
  if (dv.face === 'down') {
    const Rw = woofer.frameDiaMm / 2 + 6;
    return { x0: dv.x - Rw, x1: dv.x + Rw, y0: dv.y - t / 2, y1: dv.y + t / 2 };
  }
  return { x0: dv.x - t / 2, x1: dv.x + t / 2, y0: -1, y1: g.H + 1 };
}

/** The printed part of the profile, as polygons with holes (profile mm). */
export function printedProfile(g: Geometry, woofer: DriverInfo) {
  const regions: [number, number][] = g.construction === 'bends' ? g.caps.map((c) => [c.x0, c.x1]) : [[0, g.W]];
  const w = driverWallRect(g, woofer);
  let solid = pc.difference([ring(g.core)], ...g.holes.map((h) => [ring(h)] as Ring[]));
  const rs = regions.map(([a, b]) => [rectRing(a, b, -1, g.H + 1)] as Ring[]);
  solid = pc.intersection(solid, pc.union(rs[0], ...rs.slice(1)));
  return pc.difference(solid, [rectRing(w.x0, w.x1, w.y0, w.y1)]);
}

function shapeOf(poly: Ring[]): THREE.Shape {
  const sh = new THREE.Shape(open(poly[0]).map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of poly.slice(1)) sh.holes.push(new THREE.Path(open(h).map(([x, y]) => new THREE.Vector2(x, y))));
  return sh;
}

/** A closed solid of revolution for a waveguide insert (axis = +z, face at z = depth). */
function waveguideSection(wg: RoundWaveguide): [number, number][] {
  const D = wg.depthMm;
  return [...wg.profile, [wg.flangeR, D], [wg.flangeR, D - 3], [wg.R + wg.wallMm, D - 3], [wg.profile[0][0] + wg.wallMm, 0], [wg.profile[0][0], 0]];
}
function waveguideSolid(wg: RoundWaveguide): THREE.BufferGeometry {
  const sec = waveguideSection(wg);
  const g = new THREE.LatheGeometry(
    sec.map(([r, z]) => new THREE.Vector2(r, z)),
    96
  );
  g.rotateX(Math.PI / 2);
  return g;
}

export interface PrintPiece {
  name: string;
  geometry: THREE.BufferGeometry;
  /** the exact solid, for STEP / Waffle Iron (same frame as `geometry`) */
  recipe: Recipe;
  rotX90?: boolean;
}

const polyLoop = (r: Ring): Loop2 => ({ kind: 'poly', pts: open(r) });
const rectLoop = (x0: number, y0: number, x1: number, y1: number): Loop2 => ({ kind: 'poly', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

/** Every printed piece of a design, in mm, each sitting on z = 0 (its print orientation). */
export function printPieces(g: Geometry, p: HybridParams, plan: PrintPlan, woofer: DriverInfo, head: HeadGeometry | null): PrintPiece[] {
  const out: PrintPiece[] = [];
  if (g.shell) {
    // bands of the revolved shell; a band too wide for the bed is two closed half-rings
    const sec = [ring(g.shell.section.map(([r, z]) => [r, z] as Pt))];
    for (const seg of plan.segments) {
      const clip = pc.intersection(sec, [rectRing(-1, g.shell.Rmax + 10, seg.x0, seg.x1)]);
      for (const poly of clip) {
        const pts = open(poly[0]).map(([r, z]) => new THREE.Vector2(Math.max(0, r), z));
        const half = seg.core > 0;
        const lathe = new THREE.LatheGeometry([...pts, pts[0]], 96, half ? (seg.core - 1) * Math.PI : 0, half ? Math.PI : Math.PI * 2);
        let geo: THREE.BufferGeometry = lathe;
        if (half) {
          // close the two cut faces with the section itself
          const cap = new THREE.ShapeGeometry(new THREE.Shape(pts));
          const a = cap.clone().rotateY(-Math.PI / 2 + (seg.core - 1) * Math.PI);
          const b = cap.clone().rotateY(Math.PI / 2 + (seg.core - 1) * Math.PI);
          geo = mergeGeometries([lathe.toNonIndexed(), a.toNonIndexed(), b.toNonIndexed()].map((x) => {
            x.deleteAttribute('uv');
            x.deleteAttribute('normal');
            return x;
          }))!;
        }
        out.push({ name: seg.id, geometry: geo, recipe: { kind: 'revolve', section: pts.map((v) => [v.x, v.y]), phi0: half ? (seg.core - 1) * Math.PI : 0, sweep: half ? Math.PI : Math.PI * 2 } });
      }
    }
    if (head) out.push(...podPieces(head));
    return out;
  }
  const solid = printedProfile(g, woofer);
  for (const seg of plan.segments) {
    const clip = pc.intersection(solid, [rectRing(seg.x0, seg.x1, seg.y0, seg.y1)]);
    clip.forEach((poly, i) => {
      if (Math.abs(poly[0].length) < 4) return;
      const geo = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: seg.z1 - seg.z0, bevelEnabled: false, curveSegments: 6 });
      out.push({
        name: `core ${seg.core + 1} ${seg.tile}${clip.length > 1 ? `-${i + 1}` : ''}`,
        geometry: geo,
        recipe: { kind: 'prism', outer: polyLoop(poly[0]), holes: poly.slice(1).map(polyLoop), depth: seg.z1 - seg.z0 },
      });
    });
  }
  // the driver's wall: a flat plate with its holes (prints flat)
  {
    const w = driverWallRect(g, woofer);
    const t = g.wallMm;
    const holeFor = (y: number, r: number, cx = 0) => {
      const h = new THREE.Path();
      h.absarc(cx, y, r, 0, Math.PI * 2, true);
      return h;
    };
    if (g.driver.face === 'down') {
      const sh = new THREE.Shape([new THREE.Vector2(-g.Etot / 2, w.x0), new THREE.Vector2(g.Etot / 2, w.x0), new THREE.Vector2(g.Etot / 2, w.x1), new THREE.Vector2(-g.Etot / 2, w.x1)]);
      sh.holes.push(holeFor(g.driver.x, woofer.cutoutDiaMm / 2));
      out.push({
        name: 'woofer wall',
        geometry: new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 64 }),
        recipe: { kind: 'prism', outer: rectLoop(-g.Etot / 2, w.x0, g.Etot / 2, w.x1), holes: [{ kind: 'circle', c: [0, g.driver.x], r: woofer.cutoutDiaMm / 2 }], depth: t },
      });
    } else {
      // solid stretches of the profile at that depth, the full width between the plates
      const xm = (w.x0 + w.x1) / 2;
      let y0: number | null = null;
      const solidAt = (y: number) => isSolid(g, xm, y);
      for (let y = 0; y <= g.H; y += 1) {
        const s = y < g.H && solidAt(y + 0.5);
        if (s && y0 === null) y0 = y;
        if (!s && y0 !== null) {
          const sh = new THREE.Shape([new THREE.Vector2(-g.Etot / 2, y0), new THREE.Vector2(g.Etot / 2, y0), new THREE.Vector2(g.Etot / 2, y), new THREE.Vector2(-g.Etot / 2, y)]);
          const circles: Loop2[] = [];
          const cut = (cy: number, r: number) => {
            if (cy - r > y0! && cy + r < y) {
              sh.holes.push(holeFor(cy, r));
              circles.push({ kind: 'circle', c: [0, cy], r });
            }
          };
          cut(g.driver.y, woofer.cutoutDiaMm / 2);
          if (g.tweeter && g.driver.face === 'front') cut(g.tweeter.y, g.tweeter.holeR);
          out.push({
            name: `front wall ${Math.round(y0)}–${y} mm`,
            geometry: new THREE.ExtrudeGeometry(sh, { depth: w.x1 - w.x0, bevelEnabled: false, curveSegments: 64 }),
            recipe: { kind: 'prism', outer: rectLoop(-g.Etot / 2, y0, g.Etot / 2, y), holes: circles, depth: w.x1 - w.x0 },
          });
          y0 = null;
        }
      }
    }
  }
  if (g.tweeter?.waveguide) out.push(waveguidePiece('waveguide insert', g.tweeter.waveguide));
  if (head) out.push(...podPieces(head));
  for (const tr of g.traps ?? []) {
    const body = new THREE.CylinderGeometry(tr.diaMm / 2, tr.diaMm / 2, tr.lenMm, 64);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, tr.lenMm / 2);
    out.push({ name: `trap ${tr.harmonic}${tr.harmonic === 3 ? 'rd' : 'th'} harmonic`, geometry: body, recipe: { kind: 'prism', outer: { kind: 'circle', c: [0, 0], r: tr.diaMm / 2 }, holes: [], depth: tr.lenMm } });
  }
  return out;
}

function waveguidePiece(name: string, wg: RoundWaveguide): PrintPiece {
  return { name, geometry: waveguideSolid(wg), recipe: { kind: 'revolve', section: waveguideSection(wg), phi0: 0, sweep: Math.PI * 2 }, rotX90: true };
}

/** the separate tweeter pod (a rounded block with the tweeter / waveguide hole) and its waveguide */
function podPieces(head: HeadGeometry): PrintPiece[] {
  const r = Math.min(head.w, head.h) * 0.32;
  const sh = new THREE.Shape();
  const [x0, y0, x1, y1] = [-head.w / 2, -head.h / 2, head.w / 2, head.h / 2];
  sh.moveTo(x0 + r, y0);
  sh.lineTo(x1 - r, y0);
  sh.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  sh.lineTo(x1, y1 - r);
  sh.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  sh.lineTo(x0 + r, y1);
  sh.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  sh.lineTo(x0, y0 + r);
  sh.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  const outline = sh.getPoints(12).map((v) => [v.x, v.y] as [number, number]);
  const holeR = head.waveguide ? head.waveguide.R + head.waveguide.wallMm : head.tweeterCutoutMm / 2;
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
  sh.holes.push(hole);
  const out: PrintPiece[] = [
    {
      name: 'tweeter pod (shell)',
      geometry: new THREE.ExtrudeGeometry(sh, { depth: head.d, bevelEnabled: false, curveSegments: 24 }),
      recipe: { kind: 'prism', outer: { kind: 'poly', pts: outline }, holes: [{ kind: 'circle', c: [0, 0], r: holeR }], depth: head.d },
    },
  ];
  if (head.waveguide) out.push(waveguidePiece('pod waveguide', head.waveguide));
  return out;
}

export interface PieceEstimate {
  name: string;
  grams: number;
  hours: number;
  heightMm: number;
}
export interface PrintEstimate {
  pieces: PieceEstimate[];
  grams: number;
  /** metres of 1.75 mm filament */
  metres: number;
  hours: number;
  filamentCost: number;
  energyCost: number;
  longest: PieceEstimate;
}

function meshArea(g: THREE.BufferGeometry) {
  const geo = g.index ? g.toNonIndexed() : g;
  const p = geo.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let s = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1).sub(a);
    c.fromBufferAttribute(p, i + 2).sub(a);
    s += b.cross(c).length() / 2;
  }
  return s;
}

/**
 * Filament, time and cost for every printed piece. Each piece's solid volume
 * (from its exact recipe) splits into a skin — perimeters on the walls, solid
 * layers top and bottom, ≈ surface area × skin thickness — and the inside at
 * the infill percentage. Skins print at ~60 % of the hot end's flow (slower
 * outer walls), infill at full flow, plus 15 % for travel and a few seconds a
 * layer; each piece is its own print with ~6 min to heat and level.
 */
export function printEstimate(pieces: PrintPiece[], pr: Printer): PrintEstimate {
  const skinMm = Math.max(pr.perimeters, 1) * pr.lineWidth;
  const flow = Math.max(pr.flow, 1);
  const est = pieces.map((pc_) => {
    const vol = recipeVolume(pc_.recipe);
    const skin = Math.min(vol, (meshArea(pc_.geometry) / 2) * skinMm);
    const inside = vol - skin;
    const printed = skin + inside * Math.min(Math.max(pr.infillPct, 0), 100) / 100;
    pc_.geometry.computeBoundingBox();
    const bb = pc_.geometry.boundingBox!;
    const heightMm = bb.max.z - bb.min.z;
    const layers = heightMm / Math.max(pr.layerH, 0.05);
    const seconds = (skin / (flow * 0.6) + (printed - skin) / flow) * 1.15 + layers * 4 + 360;
    return { name: pc_.name, grams: (printed / 1000) * pr.filamentDensity, hours: seconds / 3600, heightMm };
  });
  const grams = est.reduce((a, e) => a + e.grams, 0);
  const hours = est.reduce((a, e) => a + e.hours, 0);
  return {
    pieces: est,
    grams,
    metres: grams / pr.filamentDensity / (Math.PI * 0.875 ** 2),
    hours,
    filamentCost: (grams / 1000) * pr.pricePerKg,
    energyCost: ((hours * pr.watts) / 1000) * pr.kwhPrice,
    longest: est.reduce((a, e) => (e.hours > a.hours ? e : a), est[0] ?? { name: '', grams: 0, hours: 0, heightMm: 0 }),
  };
}

/** A quick test print: a ring the driver's cut-out size, to check the fit before printing a cabinet. */
export function fitTestPieces(woofer: DriverInfo, wallMm: number, tweeterHoleR?: number): PrintPiece[] {
  const ring = (name: string, r: number): PrintPiece => {
    const sh = new THREE.Shape();
    sh.absarc(0, 0, r + 12, 0, Math.PI * 2, false);
    const h = new THREE.Path();
    h.absarc(0, 0, r, 0, Math.PI * 2, true);
    sh.holes.push(h);
    const t = Math.max(3, Math.min(wallMm, 6));
    return { name, geometry: new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 96 }), recipe: { kind: 'prism', outer: { kind: 'circle', c: [0, 0], r: r + 12 }, holes: [{ kind: 'circle', c: [0, 0], r }], depth: t } };
  };
  const out = [ring(`woofer fit ring (${woofer.cutoutDiaMm} mm)`, woofer.cutoutDiaMm / 2)];
  if (tweeterHoleR) out.push(ring(`tweeter fit ring (${Math.round(tweeterHoleR * 2)} mm)`, tweeterHoleR));
  return out;
}

function isSolid(g: Geometry, x: number, y: number) {
  const inPoly = (poly: Pt[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return inPoly(g.core) && !g.holes.some(inPoly);
}

/** One binary STL with every piece laid out side by side (mm). */
export function printPiecesStl(pieces: PrintPiece[]): ArrayBuffer {
  const group = new THREE.Group();
  let x = 0;
  let rowY = 0;
  let rowH = 0;
  for (const pc_ of pieces) {
    pc_.geometry.computeBoundingBox();
    const b = pc_.geometry.boundingBox!;
    const w = b.max.x - b.min.x;
    const h = b.max.y - b.min.y;
    if (x > 0 && x + w > 1200) {
      x = 0;
      rowY += rowH + 20;
      rowH = 0;
    }
    const m = new THREE.Mesh(pc_.geometry);
    m.position.set(x - b.min.x, rowY - b.min.y, -b.min.z);
    group.add(m);
    x += w + 20;
    rowH = Math.max(rowH, h);
  }
  group.updateMatrixWorld(true);
  return meshesToStl(group, { mmPerUnit: 1 });
}

type ThickPanel = DxfPanel & { thickMm: number; material: string };
const PLATE_CAD_MATERIAL: Record<string, string> = { bb18: 'Birch plywood', bb12: 'Birch plywood', mdf19: 'MDF', glass: 'Laminated glass', acrylic: 'Acrylic', sandwich: 'Birch plywood' };

/** a printed design's flat parts: the two outer plates, dividers (with their cut-outs) and plywood strips */
function platePanels(g: Geometry, p: HybridParams, woofer: DriverInfo): ThickPanel[] {
  const panels: ThickPanel[] = [];
  if (g.shell) return panels;
  const mat = PLATE_CAD_MATERIAL[p.plateMaterial] ?? 'Birch plywood';
  const outline = plateOutline(g.W, g.H).map(([x, y]) => [x, g.H - y] as [number, number]);
  for (const side of ['left', 'right']) panels.push({ name: `side plate ${side}`, outline, notes: [`${p.plateMm} mm ${p.plateMaterial}`], thickMm: p.plateMm, material: mat });
  if (g.cores > 1) {
    const w = driverWallRect(g, woofer);
    const div = pc.difference([ring(plateOutline(g.W, g.H))], ...g.dividerCuts.map((c) => [ring(c)] as Ring[]), [rectRing(w.x0, w.x1, w.y0, w.y1)]);
    div.forEach((poly, i) =>
      panels.push({
        name: `divider ${i + 1}${g.cores > 2 ? ` (x${g.cores - 1})` : ''}`,
        outline: open(poly[0]).map(([x, y]) => [x, g.H - y] as [number, number]),
        polyHoles: poly.slice(1).map((h) => open(h).map(([x, y]) => [x, g.H - y] as [number, number])),
        notes: ['notched round the drivers; windows keep each chamber one volume'],
        thickMm: p.plateMm,
        material: mat,
      })
    );
  }
  for (const st of g.strips) {
    const L = st.lengthMm;
    panels.push({ name: `${st.name} (x${st.qty})`, outline: [[0, 0], [L, 0], [L, st.widthMm], [0, st.widthMm]], notes: [`${st.thickMm} mm plywood`], thickMm: st.thickMm, material: 'Birch plywood' });
  }
  return panels;
}

/** DXF of a printed design's flat parts: the two outer plates, dividers (with their cut-outs) and plywood strips. */
export function platesDxf(g: Geometry, p: HybridParams, woofer: DriverInfo): string {
  if (g.shell) return panelsToDxf([{ name: 'no flat parts', outline: [[0, 0], [10, 0], [10, 10], [0, 10]], notes: ['a curved shell has no plates'] }]);
  return panelsToDxf(platePanels(g, p, woofer), { gapMm: 20 });
}

function panelPart(pn: ThickPanel): CadPart {
  return {
    name: pn.name,
    material: pn.material,
    recipe: {
      kind: 'prism',
      outer: { kind: 'poly', pts: pn.outline },
      holes: [...(pn.holes ?? []).map((h) => ({ kind: 'circle', c: [h.x, h.y], r: h.r }) as Loop2), ...(pn.polyHoles ?? []).map((h) => ({ kind: 'poly', pts: h }) as Loop2)],
      depth: pn.thickMm,
    },
  };
}

/** every part of a printed design as an exact solid: printed pieces (PETG) then the flat parts, laid out */
export function printedCadParts(pieces: PrintPiece[], g: Geometry, p: HybridParams, woofer: DriverInfo, filament = 'PETG'): CadPart[] {
  return layOut([...pieces.map((pc_) => ({ name: pc_.name, recipe: pc_.recipe, rotX90: pc_.rotX90, material: filament })), ...platePanels(g, p, woofer).map(panelPart)]);
}

/** a plywood design's panels as exact solids, laid out flat */
export function plywoodCadParts(plan: BuildPlan): CadPart[] {
  return layOut(plywoodPanels(plan).map(panelPart), 25);
}

export const cadStep = (parts: CadPart[], name: string) => writeStep(parts, `${name}.step`);
export const cadWaffle = (parts: CadPart[], name: string) => writeWaffle(parts, name);

/** a plywood design's panels with the baffle and back-panel holes in place */
function plywoodPanels(plan: BuildPlan): ThickPanel[] {
  const panels: ThickPanel[] = [];
  const box = plan.box;
  for (const pn of plan.panels) {
    const W = pn.widthMm;
    const L = pn.lengthMm;
    const isBaffle = pn.id === 'baffle';
    const isBack = pn.id === 'back';
    const outline: [number, number][] = [[0, 0], [W, 0], [W, L], [0, L]];
    const holes: { x: number; y: number; r: number }[] = [];
    const polyHoles: [number, number][][] = [];
    if (isBaffle || pn.id === 'baffle2') for (const h of plan.holes) holes.push({ x: h.xMm, y: L - h.yMm, r: (pn.id === 'baffle2' ? h.throughDiaMm : h.throughDiaMm) / 2 });
    if (isBack) {
      // drawn as seen from behind (x mirrored), like the back-panel drawing
      const tm = box.terminalMm;
      const tx = W - tm.xMm;
      const ty = L - tm.yMm;
      if (tm.kind === 'cup') polyHoles.push([[tx - 37.5, ty - 37.5], [tx + 37.5, ty - 37.5], [tx + 37.5, ty + 37.5], [tx - 37.5, ty + 37.5]]);
      else for (const dx of [-9.5, 9.5]) holes.push({ x: tx + dx, y: ty, r: 4.5 });
      if (box.port) for (const rp of box.rearPorts) holes.push({ x: W - rp.xMm, y: L - rp.yMm, r: (box.port.diameterMm + 4) / 2 });
    }
    const notes = [`${pn.thicknessMm} mm, ${pn.qtyPerBox} per speaker`, ...(isBaffle ? ['rebates: see the baffle drawing'] : [])];
    panels.push({ name: pn.name, outline, holes, polyHoles, notes, thickMm: pn.thicknessMm, material: pn.materialId.startsWith('mdf') ? 'MDF' : 'Birch plywood' });
  }
  return panels;
}

/** DXF of a plywood design's panels, with the baffle and back-panel holes in place. */
export function plywoodDxf(plan: BuildPlan): string {
  return panelsToDxf(plywoodPanels(plan), { gapMm: 25 });
}
