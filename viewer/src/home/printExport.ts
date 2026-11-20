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
import type { Geometry, HeadGeometry, HybridParams, Printer, Pt, PrintPlan, RoundWaveguide, Strip } from './hybrid';
import type { DriverInfo } from './drivers';
import { bindingPostOffsets, type BuildPlan } from './speakerBuild';
import { meshesToStl, panelsToDxf, type DxfPanel } from './exporters';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { NestPart } from './sheetLayout';
import { explodeParts, layOut, matMul, mulM3, recipeVolume, writeStep, writeWaffle, type CadPart, type Loop2, type M3, type Recipe, type V3 } from './cad';
import { boxLayout, boxPlacement, placeMatrix, podPlaces, printedLayout, shellLayout, VIEW_TO_CAD, WAVEGUIDE_FLANGE_MM, type Box3mm, type Place } from './assembly';

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

/**
 * Where a plywood strip sits in the profile (mm): its rectangle, run out to the
 * strip's full length (a strip that slots into a cap at one end only is longer
 * than the open stretch it spans). Lengthwise along whichever way it is longer.
 */
export function stripFootprint(st: Strip) {
  const r = st.rect;
  if (st.line) {
    // a sloped strip, laid level along its centre line (stripPose tilts it into place)
    const ln = st.line;
    const cx = (ln.x0 + ln.x1) / 2;
    const cy = (ln.y0 + ln.y1) / 2;
    return { x0: cx - st.lengthMm / 2, x1: cx + st.lengthMm / 2, y0: cy - st.thickMm / 2, y1: cy + st.thickMm / 2 };
  }
  return r.x1 - r.x0 >= r.y1 - r.y0 ? { x0: r.x0, x1: r.x0 + st.lengthMm, y0: r.y0, y1: r.y0 + st.thickMm } : { x0: r.x0, x1: r.x0 + st.thickMm, y0: r.y0, y1: r.y0 + st.lengthMm };
}

/** A strip's outline in the profile (mm): its footprint, tilted along its line if it slopes. */
export function stripRing(st: Strip): Ring {
  const f = stripFootprint(st);
  if (!st.line) return rectRing(f.x0, f.x1, f.y0, f.y1);
  const ln = st.line;
  const a = Math.atan2(ln.y1 - ln.y0, ln.x1 - ln.x0);
  const cx = (f.x0 + f.x1) / 2;
  const cy = (f.y0 + f.y1) / 2;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  return ring(([[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]] as Pt[]).map(([x, y]) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c] as Pt));
}

/** The printed part of the profile, as polygons with holes (profile mm): the printed caps keep slots where the plywood strips go in. */
export function printedProfile(g: Geometry, woofer: DriverInfo) {
  const regions: [number, number][] = g.construction === 'bends' ? g.caps.map((c) => [c.x0, c.x1]) : [[0, g.W]];
  const w = driverWallRect(g, woofer);
  let solid = pc.difference([ring(g.core)], ...g.holes.map((h) => [ring(h)] as Ring[]));
  const rs = regions.map(([a, b]) => [rectRing(a, b, -1, g.H + 1)] as Ring[]);
  solid = pc.intersection(solid, pc.union(rs[0], ...rs.slice(1)));
  const slots = g.strips.map((st) => [stripRing(st)] as Ring[]);
  return pc.difference(solid, [rectRing(w.x0, w.x1, w.y0, w.y1)], ...slots);
}

function shapeOf(poly: Ring[]): THREE.Shape {
  const sh = new THREE.Shape(open(poly[0]).map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of poly.slice(1)) sh.holes.push(new THREE.Path(open(h).map(([x, y]) => new THREE.Vector2(x, y))));
  return sh;
}

/** A closed solid of revolution for a waveguide insert (axis = +z, face at z = depth). */
function waveguideSection(wg: RoundWaveguide): [number, number][] {
  const D = wg.depthMm;
  const F = WAVEGUIDE_FLANGE_MM;
  return [...wg.profile, [wg.flangeR, D], [wg.flangeR, D - F], [wg.R + wg.wallMm, D - F], [wg.profile[0][0] + wg.wallMm, 0], [wg.profile[0][0], 0]];
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
  /** where the recipe (before rotX90 — this replaces it) sits in the finished speaker, in the 3D view's frame (assembly.ts) */
  at?: Place;
  /** pieces of one group move together in an exploded view */
  group?: string;
}

const polyLoop = (r: Ring): Loop2 => ({ kind: 'poly', pts: open(r) });
const rectLoop = (x0: number, y0: number, x1: number, y1: number): Loop2 => ({ kind: 'poly', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

/** an internal driver baffle that is a plywood strip ("printed bends + plywood"): plywood, not printed (as the 3D view draws it) */
const woodDriverWall = (g: Geometry) => g.driver.face === 'internal' && g.strips.some((st) => /Driver baffle/.test(st.name));

/** The driver's wall in front of / around the woofer: the solid stretches of the profile at that depth, the full width between the plates, with their holes. */
function driverWallPieces(g: Geometry, woofer: DriverInfo, plateMm: number): PrintPiece[] {
  const out: PrintPiece[] = [];
  const lay = printedLayout(g, plateMm);
  const w = driverWallRect(g, woofer);
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
          const h = new THREE.Path();
          h.absarc(0, cy, r, 0, Math.PI * 2, true);
          sh.holes.push(h);
          circles.push({ kind: 'circle', c: [0, cy], r });
        }
      };
      cut(g.driver.y, woofer.cutoutDiaMm / 2);
      if (g.tweeter && g.driver.face === 'front') cut(g.tweeter.y, g.tweeter.holeR);
      out.push({
        name: `${g.driver.face === 'front' ? 'front wall' : 'driver baffle'} ${Math.round(y0)}–${y} mm`,
        geometry: new THREE.ExtrudeGeometry(sh, { depth: w.x1 - w.x0, bevelEnabled: false, curveSegments: 64 }),
        recipe: { kind: 'prism', outer: rectLoop(-g.Etot / 2, y0, g.Etot / 2, y), holes: circles, depth: w.x1 - w.x0 },
        at: lay.frontWall(w.x0),
      });
      y0 = null;
    }
  }
  return out;
}

/** Every printed piece of a design, in mm, each sitting on z = 0 (its print orientation). */
export function printPieces(g: Geometry, p: HybridParams, plan: PrintPlan, woofer: DriverInfo, head: HeadGeometry | null): PrintPiece[] {
  const out: PrintPiece[] = [];
  if (g.shell) {
    // bands of the revolved shell; a band too wide for the bed is two closed half-rings
    const sl = shellLayout(g.shell);
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
        out.push({ name: seg.id, geometry: geo, recipe: { kind: 'revolve', section: pts.map((v) => [v.x, v.y]), phi0: half ? (seg.core - 1) * Math.PI : 0, sweep: half ? Math.PI : Math.PI * 2 }, at: sl.shell });
      }
    }
    if (head) out.push(...podPieces(head, sl.topY));
    return out;
  }
  const lay = printedLayout(g, p.plateMm);
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
        at: lay.across(lay.coreX(seg.core) + seg.z0, seg.z1 - seg.z0),
        // the pieces one tile splits into can wrap round each other: they explode as one
        group: `core ${seg.id}`,
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
      // drawn (across, W − depth), as the 3D view lays it
      const [v0, v1, vc] = [g.W - w.x1, g.W - w.x0, g.W - g.driver.x];
      const sh = new THREE.Shape([new THREE.Vector2(-g.Etot / 2, v0), new THREE.Vector2(g.Etot / 2, v0), new THREE.Vector2(g.Etot / 2, v1), new THREE.Vector2(-g.Etot / 2, v1)]);
      sh.holes.push(holeFor(vc, woofer.cutoutDiaMm / 2));
      out.push({
        name: 'woofer wall',
        geometry: new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 64 }),
        recipe: { kind: 'prism', outer: rectLoop(-g.Etot / 2, v0, g.Etot / 2, v1), holes: [{ kind: 'circle', c: [0, vc], r: woofer.cutoutDiaMm / 2 }], depth: t },
        at: lay.downWall(w.y0),
      });
    } else if (!woodDriverWall(g)) out.push(...driverWallPieces(g, woofer, p.plateMm));
  }
  if (g.tweeter?.waveguide) out.push({ ...waveguidePiece('waveguide insert', g.tweeter.waveguide), at: lay.tweeterWaveguide()! });
  if (head) out.push(...podPieces(head, lay.topY));
  for (const tr of g.traps ?? []) {
    const body = new THREE.CylinderGeometry(tr.diaMm / 2, tr.diaMm / 2, tr.lenMm, 64);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, tr.lenMm / 2);
    out.push({ name: `trap ${tr.harmonic}${tr.harmonic === 3 ? 'rd' : 'th'} harmonic`, geometry: body, recipe: { kind: 'prism', outer: { kind: 'circle', c: [0, 0], r: tr.diaMm / 2 }, holes: [], depth: tr.lenMm }, at: lay.trap(tr) });
  }
  return out;
}

function waveguidePiece(name: string, wg: RoundWaveguide): PrintPiece {
  return { name, geometry: waveguideSolid(wg), recipe: { kind: 'revolve', section: waveguideSection(wg), phi0: 0, sweep: Math.PI * 2 }, rotX90: true };
}

/** the separate tweeter pod (a rounded block with the tweeter / waveguide hole) and its waveguide, standing on topY */
function podPieces(head: HeadGeometry, topY: number): PrintPiece[] {
  const at = podPlaces(head, topY);
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
      at: at.body,
    },
  ];
  if (head.waveguide) out.push({ ...waveguidePiece('pod waveguide', head.waveguide), at: at.waveguide! });
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

/** a placement as world = R·local + t (mm, the 3D view's frame) */
type Pose = { R: M3; t: V3 };
/** each copy of the panel, placed in the finished speaker */
type ThickPanel = DxfPanel & { thickMm: number; material: string; at?: Pose[]; qty?: number };
const PLATE_CAD_MATERIAL: Record<string, string> = { bb18: 'Birch plywood', bb12: 'Birch plywood', mdf19: 'MDF', glass: 'Laminated glass', acrylic: 'Acrylic', sandwich: 'Birch plywood' };

const poseOf = (pl: Place): Pose => placeMatrix(pl);
/** a pose for a part drawn mirrored: `fix` (a proper turn + shift, local → as-placed local) first */
const compose = (a: Pose, fix: Pose): Pose => ({ R: matMul(a.R, fix.R), t: mulM3(a.R, fix.t).map((v, k) => v + a.t[k]) as V3 });
/** an outline drawn with y flipped (y' = H − y): turn it over (180° about x) and back through its thickness */
const unflipY = (H: number, thick: number): Pose => ({ R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]], t: [0, H, thick] });
/** …with x flipped (x' = W − x, seen from behind): 180° about y */
const unflipX = (W: number, thick: number): Pose => ({ R: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], t: [W, 0, thick] });
const boxPose = (pn: { outline: [number, number][]; thickMm: number }, box: Box3mm): Pose => {
  const xs = pn.outline.map(([x]) => x);
  const ys = pn.outline.map(([, y]) => y);
  return boxPlacement([Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), pn.thickMm], box);
};

/** a plywood strip's pose: laid level in its footprint box, then (if it slopes) tilted about its centre — profile x is world z, profile y world y */
function stripPose(st: Strip, pn: { outline: [number, number][]; thickMm: number }, box: Box3mm): Pose {
  const level = boxPose(pn, box);
  if (!st.line) return level;
  const ln = st.line;
  const a = -Math.atan2(ln.y1 - ln.y0, ln.x1 - ln.x0);
  const T: M3 = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  const c: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const t = mulM3(T, level.t.map((v, k) => v - c[k]) as V3).map((v, k) => v + c[k]) as V3;
  return { R: matMul(T, level.R), t };
}

/** a printed design's flat parts: the two outer plates, dividers (with their cut-outs) and plywood strips */
function platePanels(g: Geometry, p: HybridParams, woofer: DriverInfo): ThickPanel[] {
  const panels: ThickPanel[] = [];
  if (g.shell) return panels;
  const lay = printedLayout(g, p.plateMm);
  const mat = PLATE_CAD_MATERIAL[p.plateMaterial] ?? 'Birch plywood';
  // plates and dividers are drawn as seen from the left (the profile with y down): placed across like the cores
  const plateAt = (x0: number) => compose(poseOf(lay.across(x0, p.plateMm)), unflipY(g.H, p.plateMm));
  const outline = plateOutline(g.W, g.H).map(([x, y]) => [x, g.H - y] as [number, number]);
  for (const side of [-1, 1] as const)
    panels.push({ name: `side plate ${side < 0 ? 'left' : 'right'}`, outline, notes: [`${p.plateMm} mm ${p.plateMaterial}`], thickMm: p.plateMm, material: mat, at: [plateAt(lay.plateX(side))] });
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
        qty: Math.max(1, g.cores - 1),
        at: Array.from({ length: g.cores - 1 }, (_, c) => plateAt(lay.dividerX(c))),
      })
    );
  }
  if (woodDriverWall(g))
    for (const pc_ of driverWallPieces(g, woofer, p.plateMm)) {
      const r = pc_.recipe as Extract<Recipe, { kind: 'prism' }>;
      panels.push({
        name: `${pc_.name} (plywood)`,
        outline: r.outer.kind === 'poly' ? r.outer.pts : [],
        holes: r.holes.flatMap((h) => (h.kind === 'circle' ? [{ x: h.c[0], y: h.c[1], r: h.r }] : [])),
        notes: [`${r.depth} mm plywood, the full width between the plates, with the woofer's cut-out`],
        thickMm: r.depth,
        material: 'Birch plywood',
        at: [poseOf(pc_.at!)],
      });
    }
  for (const st of g.strips) {
    // the driver baffle is one full-width panel with its hole (above), not a strip per core
    if (woodDriverWall(g) && /Driver baffle/.test(st.name)) continue;
    const L = st.lengthMm;
    const f = stripFootprint(st);
    const pn = { outline: [[0, 0], [L, 0], [L, st.widthMm], [0, st.widthMm]] as [number, number][], thickMm: st.thickMm };
    panels.push({
      name: `${st.name} (x${st.qty})`,
      ...pn,
      notes: [`${st.thickMm} mm plywood`, ...(st.line ? [st.note ?? 'fitted at a slope'] : [])],
      material: 'Birch plywood',
      qty: st.qty,
      at: Array.from({ length: g.cores }, (_, c) => stripPose(st, pn, lay.profileBox(f.x0, f.x1, f.y0, f.y1, lay.coreX(c), lay.coreX(c) + g.coreMm))),
    });
  }
  return panels;
}

/** DXF of a printed design's flat parts: the two outer plates, dividers (with their cut-outs) and plywood strips. */
export function platesDxf(g: Geometry, p: HybridParams, woofer: DriverInfo): string {
  if (g.shell) return panelsToDxf([{ name: 'no flat parts', outline: [[0, 0], [10, 0], [10, 10], [0, 10]], notes: ['a curved shell has no plates'] }]);
  return panelsToDxf(platePanels(g, p, woofer), { gapMm: 20 });
}

/**
 * A printed design's flat parts for sheet nesting, for `speakers` cabinets.
 * Glass and fibre-sandwich plates are not sawn from stock sheets, so they are left out.
 */
export function plateNestParts(g: Geometry, p: HybridParams, woofer: DriverInfo, speakers = 2): NestPart[] {
  const all = platePanels(g, p, woofer);
  const firstStrip = all.length - g.strips.length; // strips are always plywood and come last
  return all
    .filter((pn, i) => i >= firstStrip || !(p.plateMaterial === 'glass' || p.plateMaterial === 'sandwich'))
    .map((pn) => ({ ...pn, qty: (pn.qty ?? 1) * speakers, visible: pn.name.startsWith('side plate') }));
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

/**
 * How the parts are arranged in a CAD file: side by side on the bed plane
 * ('flat', a print plate / cut sheet), where each sits in the finished speaker
 * ('assembled', every copy of a part that's needed more than once), or that
 * pulled apart from its centre ('exploded').
 */
export type CadArrangement = 'flat' | 'assembled' | 'exploded';
export const CAD_ARRANGEMENTS: { id: CadArrangement; label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'assembled', label: 'Assembled' },
  { id: 'exploded', label: 'Exploded' },
];

/** a part placed by a pose in the 3D view's frame, written in the CAD frame (z up, front face at y = 0) */
function posed(part: CadPart, pose: Pose): CadPart {
  return { ...part, rotX90: undefined, rot: matMul(VIEW_TO_CAD, pose.R), offset: mulM3(VIEW_TO_CAD, pose.t) };
}

function arrange(flat: CadPart[], placed: () => CadPart[], how: CadArrangement, gapMm: number): CadPart[] {
  if (how === 'flat') return layOut(flat, gapMm);
  const parts = placed();
  return how === 'exploded' ? explodeParts(parts) : parts;
}

function panelCopies(pn: ThickPanel): CadPart[] {
  const part = panelPart(pn);
  const at = pn.at ?? [];
  if (!at.length || (pn.qty != null && at.length !== pn.qty)) throw new Error(`${pn.name}: ${pn.qty ?? 'some'} needed, ${at.length} placed in the assembly`);
  const base = pn.name.replace(/ \(x\d+\)$/, '');
  return at.map((pose, i) => posed({ ...part, name: at.length > 1 ? `${base} ${i + 1}` : base }, pose));
}

/** every part of a printed design as an exact solid: printed pieces (PETG) then the flat parts — laid out flat, or assembled */
export function printedCadParts(pieces: PrintPiece[], g: Geometry, p: HybridParams, woofer: DriverInfo, filament = 'PETG', how: CadArrangement = 'flat'): CadPart[] {
  const printed = pieces.map((pc_) => ({ name: pc_.name, recipe: pc_.recipe, rotX90: pc_.rotX90, material: filament, ...(pc_.group ? { group: pc_.group } : {}) }) as CadPart);
  const panels = platePanels(g, p, woofer);
  return arrange([...printed, ...panels.map(panelPart)], () => [
    ...printed.map((part, i) => {
      const at = pieces[i].at;
      if (!at) throw new Error(`${part.name}: no place in the assembly`);
      return posed(part, poseOf(at));
    }),
    ...panels.flatMap(panelCopies),
  ], how, 20);
}

/** a plywood design's panels as exact solids: laid out flat, or assembled (each panel as many times as the box needs it) */
export function plywoodCadParts(plan: BuildPlan, how: CadArrangement = 'flat'): CadPart[] {
  const panels = plywoodPanels(plan);
  return arrange(panels.map(panelPart), () => panels.flatMap(panelCopies), how, 25);
}

export const cadStep = (parts: CadPart[], name: string) => writeStep(parts, `${name}.step`);
export const cadWaffle = (parts: CadPart[], name: string) => writeWaffle(parts, name);

/** a plywood design's panels with the baffle and back-panel holes in place */
function plywoodPanels(plan: BuildPlan): ThickPanel[] {
  const panels: ThickPanel[] = [];
  const box = plan.box;
  const lay = boxLayout(box);
  for (const pn of plan.panels) {
    const W = pn.widthMm;
    const L = pn.lengthMm;
    const isBaffle = pn.id === 'baffle';
    const isBack = pn.id === 'back';
    const outline: [number, number][] = [[0, 0], [W, 0], [W, L], [0, L]];
    const holes: { x: number; y: number; r: number }[] = [];
    const polyHoles: [number, number][][] = [];
    if (isBaffle || pn.id === 'baffle2') for (const h of plan.holes) holes.push({ x: h.xMm, y: L - h.yMm, r: (pn.id === 'baffle2' ? h.throughDiaMm : h.throughDiaMm) / 2 });
    // the window brace: a frame 38 mm wide, as drawn in the 3D view
    if (pn.id === 'brace' && W > 100 && L > 100) polyHoles.push([[38, 38], [W - 38, 38], [W - 38, L - 38], [38, L - 38]]);
    if (isBack) {
      // drawn as seen from behind (x mirrored), like the back-panel drawing
      const tm = box.terminalMm;
      const tx = W - tm.xMm;
      const ty = L - tm.yMm;
      if (tm.kind === 'cup') polyHoles.push([[tx - 37.5, ty - 37.5], [tx + 37.5, ty - 37.5], [tx + 37.5, ty + 37.5], [tx - 37.5, ty + 37.5]]);
      else for (const [dx, dy] of bindingPostOffsets(box)) holes.push({ x: tx - dx, y: ty - dy, r: 4.5 });
      // opposed: the back woofer's through-hole (its rebate is a pocket: see the drawing)
      for (const h of plan.backHoles) holes.push({ x: W - h.xMm, y: L - h.yMm, r: h.throughDiaMm / 2 });
      if (box.port) for (const rp of box.rearPorts) holes.push({ x: W - rp.xMm, y: L - rp.yMm, r: (box.port.diameterMm + 4) / 2 });
    }
    const notes = [`${pn.thicknessMm} mm, ${pn.qtyPerBox} per speaker`, ...(isBaffle || (isBack && plan.backHoles.some((h) => h.rebateDiaMm)) ? [`rebates: see the ${isBack ? 'back-panel' : 'baffle'} drawing`] : [])];
    // where each copy goes (the same places the 3D view draws them)
    const t = pn.thicknessMm;
    const box3 = (b: Box3mm | null) => (b ? [boxPose({ outline, thickMm: t }, b)] : []);
    const at: Pose[] =
      isBaffle ? [poseOf(lay.baffleLayer(t))]
      : pn.id === 'baffle2' ? [poseOf(lay.baffleLayer(lay.bt))]
      : isBack ? [compose(poseOf(lay.back), unflipX(W, t))]
      : pn.id === 'side' ? [...box3(lay.side(-1)), ...box3(lay.side(1))]
      : pn.id === 'topbottom' ? [...box3(lay.bottom), ...box3(lay.top)]
      : pn.id === 'divider' ? box3(lay.floor)
      : pn.id === 'brace' ? box3(lay.brace)
      : [];
    panels.push({ name: pn.name, outline, holes, polyHoles, notes, thickMm: t, material: pn.materialId.startsWith('mdf') ? 'MDF' : 'Birch plywood', at, qty: pn.qtyPerBox });
  }
  return panels;
}

const VISIBLE_PANELS = new Set(['baffle', 'side', 'topbottom']);

/** A plywood design's panels (and stand panels, if planned) for sheet nesting, for `quantity` speakers. */
export function plywoodNestParts(plan: BuildPlan, quantity: number): NestPart[] {
  const parts: NestPart[] = plywoodPanels(plan).map((pn, i) => ({
    ...pn,
    qty: plan.panels[i].qtyPerBox * quantity,
    visible: VISIBLE_PANELS.has(plan.panels[i].id),
  }));
  for (const sp of plan.stand?.panels ?? []) {
    parts.push({
      name: sp.name,
      outline: [[0, 0], [sp.widthMm, 0], [sp.widthMm, sp.lengthMm], [0, sp.lengthMm]],
      qty: sp.qtyPerBox * quantity,
      thickMm: sp.thicknessMm,
      material: sp.materialId.startsWith('mdf') ? 'MDF' : 'Birch plywood',
      visible: true,
    });
  }
  return parts;
}

/** DXF of a plywood design's panels, with the baffle and back-panel holes in place. */
export function plywoodDxf(plan: BuildPlan): string {
  return panelsToDxf(plywoodPanels(plan), { gapMm: 25 });
}
