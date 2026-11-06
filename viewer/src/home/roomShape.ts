// The shape of ONE room (not the rest of the home): an outline polygon with
// windows and openings on its edges, defined in compass "plan" coordinates and
// rotated into the app's listening frame for whichever wall the speakers face.
//
// Plan frame: X → east, Y → south, origin at the north-west inside corner.
// App frame:  x across the front wall (seen from the seat), y away from it.

import { FT, IN } from './roomAcoustics';

export type Compass = 'north' | 'east' | 'south' | 'west';

export interface EdgeFeature {
  kind: 'window' | 'opening';
  /** distance from the edge's start vertex to the feature's centre (m) */
  centerM: number;
  widthM: number;
  sillM: number;
  headM: number;
  label: string;
}

export interface PlanEdge {
  wall: Compass;
  features: EdgeFeature[];
}

export interface RoomShape {
  id: string;
  /** rectangular core used by the acoustic model (m) */
  planWidthM: number; // east-west
  planDepthM: number; // north-south
  heightM: number;
  /** outline vertices (plan frame, m), closed implicitly; edge i runs v[i] → v[i+1] */
  outline: [number, number][];
  edges: PlanEdge[];
  wallNames: Record<Compass, string>;
  note: string;
}

// Rounded to the nearest half foot — close enough for acoustics.
const Wp = 12.5 * FT;
const Dp = 12.5 * FT;
const bay = 0.2; // the bay bulges ~8″ past the main wall line (estimated)
const f = 0.27;

/**
 * The listening room: roughly 12½′ square with a 9′ ceiling, a shallow
 * three-window bay on one wall and a wide opening on the opposite wall.
 * Sizes and positions are approximate.
 */
export const LIVING_ROOM: RoomShape = {
  id: 'living',
  planWidthM: Wp,
  planDepthM: Dp,
  heightM: 9 * FT,
  outline: [
    [0, 0],
    [Wp, 0],
    [Wp, Dp],
    [Wp * (1 - f), Dp + bay],
    [Wp * f, Dp + bay],
    [0, Dp],
  ],
  edges: [
    {
      wall: 'north',
      features: [{ kind: 'opening', centerM: 6 * FT, widthM: 60 * IN, sillM: 0, headM: 80 * IN, label: 'Opening to hall (~5′)' }],
    },
    { wall: 'east', features: [] },
    {
      wall: 'south',
      features: [{ kind: 'window', centerM: -1, widthM: 32 * IN, sillM: 28 * IN, headM: 88 * IN, label: 'Bay window 32×60' }],
    },
    {
      wall: 'south',
      features: [{ kind: 'window', centerM: -1, widthM: 36 * IN, sillM: 28 * IN, headM: 88 * IN, label: 'Bay window 36×60' }],
    },
    {
      wall: 'south',
      features: [{ kind: 'window', centerM: -1, widthM: 32 * IN, sillM: 28 * IN, headM: 88 * IN, label: 'Bay window 32×60' }],
    },
    {
      wall: 'west',
      // edge runs south → north; window centre ~7′1″ from the north wall
      features: [{ kind: 'window', centerM: Dp - 85 * IN, widthM: 48 * IN, sillM: 60 * IN, headM: 84 * IN, label: 'High window 48×24 (stair side)' }],
    },
  ],
  wallNames: {
    north: 'Hall-opening wall',
    south: 'Bay-window wall',
    west: 'Stair wall',
    east: 'Office wall',
  },
  note: 'Outline and window positions are approximate — the acoustic model uses the rectangle.',
};

export interface AppSegment {
  a: [number, number];
  b: [number, number];
  features: EdgeFeature[];
  wall: Compass;
}

export interface AppShape {
  widthM: number;
  depthM: number;
  outline: [number, number][];
  segments: AppSegment[];
  wallLabel: Record<'front' | 'back' | 'left' | 'right', string>;
}

/** Rotate the plan so the speakers stand in front of `front`. */
export function toAppFrame(shape: RoomShape, front: Compass): AppShape {
  const W0 = shape.planWidthM;
  const D0 = shape.planDepthM;
  const tf = ([X, Y]: [number, number]): [number, number] => {
    switch (front) {
      case 'south':
        return [W0 - X, D0 - Y];
      case 'north':
        return [X, Y];
      case 'east':
        return [Y, W0 - X];
      case 'west':
        return [D0 - Y, X];
    }
  };
  const swap = front === 'east' || front === 'west';
  const outline = shape.outline.map(tf);
  const segments: AppSegment[] = shape.outline.map((v, i) => {
    const w = shape.outline[(i + 1) % shape.outline.length];
    const len = Math.hypot(w[0] - v[0], w[1] - v[1]);
    return {
      a: tf(v),
      b: tf(w),
      wall: shape.edges[i].wall,
      // centre −1 means "centred on this edge"
      features: shape.edges[i].features.map((ft) => ({ ...ft, centerM: ft.centerM < 0 ? len / 2 : ft.centerM })),
    };
  });
  const opposite: Record<Compass, Compass> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  // facing `front`, which compass wall is on your left?
  const leftOf: Record<Compass, Compass> = { north: 'west', south: 'east', east: 'north', west: 'south' };
  const left = leftOf[front];
  return {
    widthM: swap ? D0 : W0,
    depthM: swap ? W0 : D0,
    outline,
    segments,
    wallLabel: {
      front: shape.wallNames[front],
      back: shape.wallNames[opposite[front]],
      left: shape.wallNames[left],
      right: shape.wallNames[opposite[left]],
    },
  };
}

export const ROOM_SHAPES: Record<string, RoomShape> = { living: LIVING_ROOM };

/**
 * If a point sits against a wall inside (or within `clearM` of) a doorway /
 * opening, slide it along the wall to the nearer side of the opening.
 */
export function avoidOpenings(pt: { x: number; y: number }, shape: AppShape | null, clearM = 0.3, nearWallM = 0.6): { x: number; y: number } {
  if (!shape) return pt;
  for (const seg of shape.segments) {
    const ax = seg.a[0];
    const ay = seg.a[1];
    const len = Math.hypot(seg.b[0] - ax, seg.b[1] - ay);
    const ux = (seg.b[0] - ax) / len;
    const uy = (seg.b[1] - ay) / len;
    const u = (pt.x - ax) * ux + (pt.y - ay) * uy;
    const dist = Math.abs((pt.x - ax) * -uy + (pt.y - ay) * ux);
    if (dist > nearWallM || u < 0 || u > len) continue;
    for (const f of seg.features) {
      if (f.kind !== 'opening') continue;
      const lo = f.centerM - f.widthM / 2 - clearM;
      const hi = f.centerM + f.widthM / 2 + clearM;
      if (u > lo && u < hi) {
        const target = u - lo < hi - u && lo > 0.3 ? lo : hi < len - 0.3 ? hi : lo;
        return { x: pt.x + (target - u) * ux, y: pt.y + (target - u) * uy };
      }
    }
  }
  return pt;
}
