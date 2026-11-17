// Where every piece of a design sits in the finished speaker: the one set of
// placements that both the 3D view (Speaker3D) and the assembled CAD export use.
//
// Frame (mm), the 3D view's own (it draws in metres, × 0.001): x across the
// cabinet (centred on 0), y up (the floor at 0), z towards the listener (the
// front face at z = 0, the back at z = −depth).
//
// A placement is a three.js-style turn (Euler XYZ, radians) and a position: the
// view sets `object.rotation` / `object.position` from it, the CAD export turns
// it into a 3×3 rotation + translation (`placeMatrix`) — so the two cannot drift.

import * as THREE from 'three';
import type { Geometry, HeadGeometry } from './hybrid';
import type { ShellGeometry } from './shell';
import type { BoxDesign } from './speakerBuild';
import type { M3, V3 } from './cad';

export interface Place {
  /** Euler XYZ (radians), as three.js `object.rotation` */
  rot: V3;
  /** mm */
  pos: V3;
}
export interface Box3mm {
  min: V3;
  max: V3;
}

const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v - 1) < 1e-12 ? 1 : Math.abs(v + 1) < 1e-12 ? -1 : v);

/** a placement as a rotation matrix (rows) + translation: world = R·local + t */
export function placeMatrix(p: Place): { R: M3; t: V3 } {
  const e = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.rot[0], p.rot[1], p.rot[2], 'XYZ')).elements;
  // three.js stores column-major
  const R: M3 = [
    [snap(e[0]), snap(e[4]), snap(e[8])],
    [snap(e[1]), snap(e[5]), snap(e[9])],
    [snap(e[2]), snap(e[6]), snap(e[10])],
  ];
  return { R, t: [...p.pos] as V3 };
}

/** set a three.js object's rotation and position (metres: × s) from a placement */
export function applyPlace(o: THREE.Object3D, p: Place, s = 0.001) {
  o.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
  o.position.set(p.pos[0] * s, p.pos[1] * s, p.pos[2] * s);
}

const HALF = Math.PI / 2;

/** a round waveguide's flange (on its face) is this thick and sits on the wall's front face */
export const WAVEGUIDE_FLANGE_MM = 3;
/** the printed pedestal under a round shell */
export const SHELL_PEDESTAL_MM = 60;
/** the soft pad under a tweeter pod */
export const POD_PAD_MM = 3;

/**
 * A round waveguide (its revolve section (r, z), throat at z = 0, face at z = depth,
 * turned about +y) with its flange's back on a front face at `faceZ`, centred at height y.
 */
export function waveguidePlace(depthMm: number, y: number, faceZ: number): Place {
  return { rot: [HALF, 0, 0], pos: [0, y, faceZ + WAVEGUIDE_FLANGE_MM - depthMm] };
}

/** a tweeter pod (rounded block centred on its axis, extruded +z by its depth) standing on `topY` */
export function podPlaces(h: HeadGeometry, topY: number) {
  const y = topY + POD_PAD_MM + h.h / 2;
  const frontZ = -h.setbackMm;
  return {
    /** centre height of the pod's face, and where that face is */
    y,
    frontZ,
    body: { rot: [0, 0, 0], pos: [0, y, frontZ - h.d] } as Place,
    waveguide: h.waveguide ? waveguidePlace(h.waveguide.depthMm, y, frontZ) : null,
  };
}

/** A printed hybrid (profile extruded across, between plates). */
export function printedLayout(g: Geometry, plateMm: number) {
  const coreX = (c: number) => -g.Etot / 2 + c * (g.coreMm + plateMm);
  /** left edge of the outer plate on that side */
  const plateX = (side: -1 | 1) => (side < 0 ? -g.Etot / 2 - plateMm : g.Etot / 2);
  return {
    coreX,
    plateX,
    /** left edge of the divider after core c */
    dividerX: (c: number) => coreX(c) + g.coreMm,
    /** a profile shape (x = depth from the back, y = height) extruded +z by `w`, laid across from x0 to x0 + w */
    across: (x0: number, w: number): Place => ({ rot: [0, -HALF, 0], pos: [x0 + w, 0, -g.W] }),
    /** a profile rectangle (x0..x1 deep, y0..y1 high) across x from X0 to X1 */
    profileBox: (x0: number, x1: number, y0: number, y1: number, X0: number, X1: number): Box3mm => ({ min: [X0, y0, x0 - g.W], max: [X1, y1, x1 - g.W] }),
    /** the driver's wall (across, height) extruded +z from profile depth x0 */
    frontWall: (x0: number): Place => ({ rot: [0, 0, 0], pos: [0, 0, x0 - g.W] }),
    /** a tapped horn's fold wall under the woofer: shape (across, W − depth), thickness up from y0 */
    downWall: (y0: number): Place => ({ rot: [-HALF, 0, 0], pos: [0, y0, 0] }),
    /** a resonance trap (a cylinder along +z, length `lenMm`) lying across, outside the left plate, 4 mm clear for its neck */
    trap: (tr: { lenMm: number; x: number; y: number }): Place => ({ rot: [0, HALF, 0], pos: [plateX(-1) - 4 - tr.lenMm, tr.y, tr.x - g.W] }),
    tweeterWaveguide: () => (g.tweeter?.waveguide ? waveguidePlace(g.tweeter.waveguide.depthMm, g.tweeter.y, 0) : null),
    /** the pod stands on the top */
    topY: g.H,
  };
}

/** A round shell: revolved about its axis (lathe +y → toward the listener), front land at z = 0, on a pedestal. */
export function shellLayout(sg: ShellGeometry) {
  const cy = SHELL_PEDESTAL_MM + sg.Rmax;
  return {
    cy,
    /** the shell's section (r, z from the back pole) turned about +y */
    shell: { rot: [HALF, 0, 0], pos: [0, cy, -sg.zFront] } as Place,
    topY: cy + sg.Rmax,
  };
}

/** A plywood box (butt joints: baffle and back full size, sides between them, top/bottom between the sides). */
export function boxLayout(box: BoxDesign) {
  const { w: W, h: H, d: D } = box.externalMm;
  const t = box.wallMm;
  const bt = box.baffleMm;
  /** inside face of the baffle, and of the back */
  const zf = -bt;
  const zb = -D + t;
  const across = (y0: number, y1: number): Box3mm => ({ min: [-W / 2 + t, y0, zb], max: [W / 2 - t, y1, zf] });
  const floorY = box.deadSpaceMm > 0 ? t + box.deadSpaceMm : null;
  const brace = box.braceFromBaffleMm != null ? zf - box.braceFromBaffleMm : null;
  const braceY0 = t + (box.deadSpaceMm > 0 ? box.deadSpaceMm + t : 0);
  return {
    W,
    H,
    D,
    t,
    bt,
    zf,
    zb,
    /** a baffle layer seen from the front (x from its left edge, y up), extruded +z, its back face `b` mm behind the front */
    baffleLayer: (b: number): Place => ({ rot: [0, 0, 0], pos: [-W / 2, 0, -b] }),
    /** the back seen from the front (x from the left), extruded +z, outer face at z = −D */
    back: { rot: [0, 0, 0], pos: [-W / 2, 0, -D] } as Place,
    side: (side: -1 | 1): Box3mm => (side < 0 ? { min: [-W / 2, 0, zb], max: [-W / 2 + t, H, zf] } : { min: [W / 2 - t, 0, zb], max: [W / 2, H, zf] }),
    top: across(H - t, H),
    bottom: across(0, t),
    floor: floorY != null ? across(floorY, floorY + t) : null,
    /** window brace: front face `braceFromBaffleMm` behind the baffle, above any false floor */
    brace: brace != null ? ({ min: [-W / 2 + t, braceY0, brace - t], max: [W / 2 - t, H - t, brace] } as Box3mm) : null,
  };
}

/**
 * Turn a flat panel (local x × y, thickness along z, from 0) so it fills an
 * axis-aligned box: each local axis goes to the world axis of the same length
 * (within 0.5 mm), the turn kept proper. For plain rectangles.
 */
export function boxPlacement(size: V3, box: Box3mm): { R: M3; t: V3 } {
  const e = [0, 1, 2].map((k) => box.max[k] - box.min[k]);
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const perm = perms.find((pm) => pm.every((j, i) => Math.abs(e[j] - size[i]) < 0.5));
  if (!perm) throw new Error(`a ${size.map((v) => v.toFixed(1)).join(' × ')} mm panel doesn't fit its ${e.map((v) => v.toFixed(1)).join(' × ')} mm place`);
  const R: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  perm.forEach((j, i) => (R[j][i] = 1));
  const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  // a mirror: run the thickness the other way
  if (det < 0) R[perm[2]][2] = -1;
  const t: V3 = [0, 0, 0];
  perm.forEach((j, i) => (t[j] = R[j][i] > 0 ? box.min[j] : box.min[j] + size[i]));
  return { R, t };
}

/** the 3D view's frame (y up, front toward +z) → CAD's: z up, x across, y from the front face back */
export const VIEW_TO_CAD: M3 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
