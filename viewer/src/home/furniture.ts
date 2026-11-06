// Furniture and listening zones for the living room.
// 'split'  — an L-shaped couch split in two: a chaise lounge along one side wall
//            and a short couch along the other, leaving a dance floor in the middle.
// 'sofa'   — a conventional sofa behind the sweet spot.

import type { RoomConfig } from './roomAcoustics';

export type FurnitureLayout = 'split' | 'sofa';

export interface FurnitureItem {
  id: string;
  label: string;
  kind: 'chaise' | 'couch' | 'sofa';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** seat height & back height (m) */
  seatH: number;
  backH: number;
  /** which side the backrest is on */
  back: 'left' | 'right' | 'back';
}

export interface Zone {
  id: string;
  label: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** typical ear height in this zone (m) */
  earM: number;
  color: string;
}

export function livingLayout(room: RoomConfig, layout: FurnitureLayout, chaiseSide: 'left' | 'right', listenerY: number) {
  const W = room.widthM;
  const D = room.depthM;
  const items: FurnitureItem[] = [];
  const zones: Zone[] = [];
  if (layout === 'split') {
    const chaiseLeft = chaiseSide === 'left';
    const chaise = { len: 1.7, dep: 0.8 };
    const couch = { len: 1.5, dep: 0.85 };
    const cy0 = Math.max(1.2, D - 0.35 - chaise.len);
    const sy0 = Math.max(1.3, D - 0.35 - couch.len);
    const chaiseX: [number, number] = chaiseLeft ? [0.04, 0.04 + chaise.dep] : [W - 0.04 - chaise.dep, W - 0.04];
    const couchX: [number, number] = chaiseLeft ? [W - 0.04 - couch.dep, W - 0.04] : [0.04, 0.04 + couch.dep];
    items.push({ id: 'chaise', label: 'Chaise lounge', kind: 'chaise', x0: chaiseX[0], x1: chaiseX[1], y0: cy0, y1: cy0 + chaise.len, seatH: 0.42, backH: 0.8, back: chaiseLeft ? 'left' : 'right' });
    items.push({ id: 'couch', label: 'Short couch', kind: 'couch', x0: couchX[0], x1: couchX[1], y0: sy0, y1: sy0 + couch.len, seatH: 0.44, backH: 0.85, back: chaiseLeft ? 'right' : 'left' });
    const dx0 = Math.min(chaiseX[1], couchX[1]) + 0.25;
    const dx1 = Math.max(chaiseX[0], couchX[0]) - 0.25;
    zones.push({ id: 'dance', label: 'Dance floor', x0: dx0, x1: dx1, y0: 0.9, y1: D - 0.3, earM: 1.6, color: '#f472b6' });
    zones.push({ id: 'chaise', label: 'Chaise lounge', x0: chaiseX[0] + 0.1, x1: chaiseX[1] - 0.1, y0: cy0 + 0.1, y1: cy0 + chaise.len - 0.1, earM: 0.9, color: '#fbbf24' });
    zones.push({ id: 'couch', label: 'Short couch', x0: couchX[0] + 0.1, x1: couchX[1] - 0.1, y0: sy0 + 0.1, y1: sy0 + couch.len - 0.1, earM: 1.0, color: '#fbbf24' });
  } else {
    const y0 = Math.min(D - 0.9, listenerY + 0.05);
    items.push({ id: 'sofa', label: 'Sofa', kind: 'sofa', x0: W / 2 - 0.95, x1: W / 2 + 0.95, y0, y1: Math.min(D - 0.05, y0 + 0.85), seatH: 0.42, backH: 0.85, back: 'back' });
    zones.push({ id: 'sofa', label: 'Sofa', x0: W / 2 - 0.9, x1: W / 2 + 0.9, y0: y0 - 0.15, y1: y0 + 0.3, earM: 1.0, color: '#fbbf24' });
  }
  return { items, zones };
}

export function inZone(z: Zone, x: number, y: number) {
  return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
}
