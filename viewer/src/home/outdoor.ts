// Outdoor dance-party rig in an open area (e.g. a forest clearing).
//
// Venue frame (metres): x across, 0…W;  y from the back of the stage area
// (y = 0) through the stage line (y = B) to the back of the crowd (y = B + D);
// z up. The crowd faces −y (towards the stage); speakers fire toward +y.
//
// Physics used (all direct sound + one ground reflection; no walls outdoors):
//  • Subs: each cabinet is a monopole with its own delay / polarity / gain, an
//    LR4 low-pass, and a horn-mouth roll-off. Ground-stacked horns whose mouths
//    touch act as one bigger mouth: the mouth cut-off is estimated from the
//    combined mouth area (with its ground image) using ka = 1, which is why
//    2× and 4× stacks reach deeper. (The Lab's Rust engine solves the full
//    mutual radiation impedance; this is a fast approximation of its trend.)
//  • Cardioid (CSA): rear-facing cabinets, polarity inverted and delayed by the
//    front-to-back mouth spacing ÷ c, cancel the front block's sound behind the
//    stage while adding (slightly) in front.
//  • End-fire: ranks spaced d apart along the throw axis; rank n (counting from
//    the back) is delayed n·d/c so all ranks add in front and smear behind.
//  • Delay towers / front fills: delayed so they arrive just after the stage
//    sound at their coverage area (Haas offset), and level-matched so the
//    combined level there matches the level near the front of the crowd.

import { SPEED_OF_SOUND, type Vec3 } from './roomAcoustics';
import { directivityDb, type SystemSpeaker } from './system';

export type SubArray = 'broadside' | 'cardioid' | 'endfire';

export interface OutdoorConfig {
  widthM: number;
  crowdDepthM: number;
  backstageM: number;
  subCount: 2 | 4 | 6 | 8;
  subArray: SubArray;
  endfireSpacingM: number;
  /** null = automatic sub-to-tops alignment */
  subDelayMs: number | null;
  topsSpacingM: number;
  topsHeightM: number;
  towerCount: 0 | 2 | 4;
  /** distance of the back towers from the stage line */
  towerDistM: number;
  towerHeightM: number;
  /** Haas offset added to each tower's geometric delay */
  towerHaasMs: number;
  /** per-tower manual delay override (ms); missing = auto */
  towerDelayOverride: Record<string, number>;
  /** null = automatic level match */
  towerGainDb: number | null;
  frontFills: boolean;
  djMonitors: boolean;
  xoverHz: number;
}

export const DEFAULT_OUTDOOR: OutdoorConfig = {
  widthM: 30,
  crowdDepthM: 40,
  backstageM: 10,
  subCount: 4,
  subArray: 'cardioid',
  endfireSpacingM: 1.15,
  subDelayMs: null,
  topsSpacingM: 12,
  topsHeightM: 3.5,
  towerCount: 2,
  towerDistM: 22,
  towerHeightM: 4,
  towerHaasMs: 10,
  towerDelayOverride: {},
  towerGainDb: null,
  frontFills: true,
  djMonitors: true,
  xoverHz: 100,
};

/** Horn sub cabinet (the Lab's TerraHorn-18 folded horn, 0.6 W × 0.9 H × 0.9 D m). */
export const SUB_CAB_DEFAULT = { w: 0.6, h: 0.9, d: 0.9, mouthM2: 0.46 };
export const SUB_CAB = SUB_CAB_DEFAULT;
export const TOP_CAB = { w: 0.54, h: 0.88, d: 0.56 };
export const TOWER_CAB = { w: 0.45, h: 0.7, d: 0.45 };
export const FILL_CAB = { w: 0.35, h: 0.22, d: 0.3 };

/** Mouth cut-off of n coupled horn mouths on the ground (ka = 1 with the ground image). */
export function mouthCutoffHz(n: number) {
  const area = 2 * n * SUB_CAB.mouthM2; // + image in the ground
  const a = Math.sqrt(area / Math.PI);
  return SPEED_OF_SOUND / (2 * Math.PI * a);
}

export interface OutdoorRig {
  subCab: { w: number; h: number; d: number };
  venue: { widthM: number; depthM: number; heightM: number; rt60S: number };
  stageY: number;
  crowd: { x0: number; x1: number; y0: number; y1: number };
  stage: { x0: number; x1: number; y0: number; y1: number };
  dj: Vec3;
  ref: Vec3;
  speakers: SystemSpeaker[];
  subDelayAutoMs: number;
  subGroups: { id: string; n: number; mouthHz: number; label: string }[];
  notes: string[];
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const aimAt = (p: Vec3, t: Vec3) => norm({ x: t.x - p.x, y: t.y - p.y, z: t.z - p.z });
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function levelDb(s: SystemSpeaker, p: Vec3, gainDb = s.gainDb ?? 0) {
  const v = { x: p.x - s.pos.x, y: p.y - s.pos.y, z: p.z - s.pos.z };
  const r = Math.max(Math.hypot(v.x, v.y, v.z), 0.3);
  const cos = (v.x * s.aim.x + v.y * s.aim.y + v.z * s.aim.z) / r;
  const off = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return gainDb + directivityDb(off) - 20 * Math.log10(r);
}

export interface SubModel {
  name: string;
  /** cabinet outside size, m */
  cab: { w: number; h: number; d: number };
  /** how many mouths can couple into one (2 = edge mouths, 4 = corner mouths) */
  maxCouple: number;
  /** per-cabinet normalised response when n cabinets couple */
  response: (n: number) => (fHz: number) => { re: number; im: number };
}

export function buildRig(c: OutdoorConfig, model: SubModel | null = null): OutdoorRig {
  const SUB_CAB = model ? { ...model.cab, mouthM2: 0 } : SUB_CAB_DEFAULT;
  const W = c.widthM;
  const B = c.backstageM;
  const D = c.crowdDepthM;
  const cx = W / 2;
  const ear = 1.6;
  const notes: string[] = [];
  const speakers: SystemSpeaker[] = [];
  const stage = { x0: cx - Math.min(8, W * 0.35), x1: cx + Math.min(8, W * 0.35), y0: B - 5, y1: B };
  const crowd = { x0: 1, x1: W - 1, y0: B + 2.5, y1: B + D - 1 };
  const ref: Vec3 = { x: cx, y: B + Math.min(10, D * 0.3), z: ear };
  const dj: Vec3 = { x: cx, y: B - 2.2, z: ear };

  // ---- subs -------------------------------------------------------------
  const subY = B + SUB_CAB.d / 2; // centre of the front block, mouths at the stage line
  const subGroups: OutdoorRig['subGroups'] = [];
  const addSub = (id: string, x: number, y: number, z: number, facing: 1 | -1, group: string, extra: Partial<SystemSpeaker> = {}) =>
    speakers.push({
      id,
      role: 'sub',
      label: `Sub ${id}`,
      // acoustic centre at the mouth face
      pos: { x, y: y + (facing * SUB_CAB.d) / 2, z },
      aim: { x: 0, y: facing, z: 0 },
      mount: 'floor',
      group,
      ...extra,
    });
  const layBlock = (n: number, y: number, facing: 1 | -1, group: string, prefix: string, extra: Partial<SystemSpeaker> = {}) => {
    // stack two high where possible: columns side by side, mouths coupled
    const cols = Math.ceil(n / 2);
    let k = 0;
    for (let ci = 0; ci < cols; ci++) {
      const x = cx + (ci - (cols - 1) / 2) * (SUB_CAB.w + 0.02);
      for (let level = 0; level < 2 && k < n; level++, k++) addSub(`${prefix}${k + 1}`, x, y, SUB_CAB.h / 2 + level * SUB_CAB.h, facing, group, extra);
    }
  };
  if (c.subArray === 'broadside') {
    layBlock(c.subCount, subY, 1, 'front', 'S');
    subGroups.push({ id: 'front', n: c.subCount, mouthHz: mouthCutoffHz(c.subCount), label: `${c.subCount} coupled, facing the crowd` });
  } else if (c.subArray === 'cardioid') {
    // As in the Lab's Oasis-360: the front row sits on the ground facing the
    // crowd; the rear-facing cabinets sit ON TOP of it, so the rear mouths are
    // one cabinet depth (0.9 m) behind the front mouths. Putting them behind
    // the block instead doubles the spacing and cancels ~95 Hz in front too.
    const rear = Math.max(1, Math.round(c.subCount / 3));
    const front = c.subCount - rear;
    const rowX = (n: number, i: number) => cx + (i - (n - 1) / 2) * (SUB_CAB.w + 0.02);
    for (let i = 0; i < front; i++) addSub(`S${i + 1}`, rowX(front, i), subY, SUB_CAB.h / 2, 1, 'front');
    const spacing = SUB_CAB.d;
    const rearDelay = (spacing / SPEED_OF_SOUND) * 1000;
    // the rear group must match the front group's sound behind the stage
    const rearGain = 20 * Math.log10(front / rear) - 0.5;
    for (let i = 0; i < rear; i++)
      addSub(`R${i + 1}`, rowX(rear, i), subY, SUB_CAB.h * 1.5, -1, 'rear', { invert: true, delayMs: rearDelay, gainDb: rearGain });
    subGroups.push({ id: 'front', n: front, mouthHz: mouthCutoffHz(front), label: `${front} coupled on the ground, facing the crowd` });
    subGroups.push({ id: 'rear', n: rear, mouthHz: mouthCutoffHz(rear), label: `${rear} on top facing backwards: polarity inverted, +${rearDelay.toFixed(2)} ms, ${rearGain >= 0 ? '+' : ''}${rearGain.toFixed(1)} dB` });
    notes.push(`Cardioid: the rear cabinets' mouths are ${spacing.toFixed(2)} m behind the front mouths, so they're delayed ${rearDelay.toFixed(2)} ms and inverted. Behind the stage both arrive together in opposite polarity and cancel; in front they arrive ${(2 * rearDelay).toFixed(1)} ms apart, which adds through the sub band (it would only cancel around ${(1000 / (2 * rearDelay)).toFixed(0)} Hz, above the crossover).`);
  } else {
    const perRank = c.subCount >= 6 ? 2 : 1;
    const ranks = c.subCount / perRank;
    const d = c.endfireSpacingM;
    for (let r = 0; r < ranks; r++) {
      // rank 0 is the rearmost; ranks march forward toward the crowd
      const y = subY - (ranks - 1 - r) * d;
      const delay = (r * d * 1000) / SPEED_OF_SOUND;
      for (let i = 0; i < perRank; i++) {
        const x = cx + (i - (perRank - 1) / 2) * (SUB_CAB.w + 0.02);
        addSub(`E${r + 1}${perRank > 1 ? String.fromCharCode(97 + i) : ''}`, x, y, SUB_CAB.h / 2, 1, `rank${r}`, { delayMs: delay });
      }
      subGroups.push({ id: `rank${r}`, n: perRank, mouthHz: mouthCutoffHz(perRank), label: `Rank ${r + 1} (${perRank}×), +${delay.toFixed(2)} ms` });
    }
    notes.push(`End-fire: ${ranks} ranks ${d.toFixed(2)} m apart, each delayed ${((d * 1000) / SPEED_OF_SOUND).toFixed(2)} ms more than the one behind it, so their wavefronts stack up going forward. Rear rejection is broadband but the array is ${((ranks - 1) * d).toFixed(1)} m deep.`);
  }
  for (const s of speakers) {
    // rear (cardioid) cabinets are EQ'd to match the front block's response —
    // a cardioid only cancels if both halves have the same shape
    const g = subGroups.find((x) => x.id === (s.group === 'rear' ? 'front' : s.group));
    if (!g) continue;
    if (model) s.response = model.response(Math.min(g.n, model.maxCouple));
    else s.mouthHpHz = g.mouthHz;
  }
  if (model)
    for (const g of subGroups) {
      g.mouthHz = NaN;
      const k = Math.min(g.n, model.maxCouple);
      g.label += ` · ${model.name}: ${k === 1 ? 'mouth on its own' : `${k} mouths couple`}`;
    }

  // ---- tops (left / right mains) -----------------------------------------
  const spacing = Math.min(c.topsSpacingM, W - 2);
  const target = { y: B + Math.min(D * 0.55, 25), z: ear };
  for (const side of [-1, 1] as const) {
    const pos = { x: cx + (side * spacing) / 2, y: B, z: c.topsHeightM };
    const aim = aimAt(pos, { x: cx + (side * spacing) / 4, y: target.y, z: target.z });
    speakers.push({ id: side < 0 ? 'L' : 'R', role: 'mains', label: side < 0 ? 'Left top' : 'Right top', pos, aim, mount: 'stand', gainDb: 0 });
  }
  const tops = speakers.filter((s) => s.role === 'mains');

  // ---- sub ↔ tops alignment at the reference point ----------------------
  const front = speakers.filter((s) => s.role === 'sub' && !s.invert);
  const tSub = Math.min(...front.map((s) => dist(s.pos, ref) / SPEED_OF_SOUND * 1000 + (s.delayMs ?? 0)));
  const tTop = Math.min(...tops.map((s) => (dist(s.pos, ref) / SPEED_OF_SOUND) * 1000));
  const subDelayAutoMs = Math.max(0, tTop - tSub);
  const topDelay = Math.max(0, tSub - tTop);
  const subDelay = c.subDelayMs ?? subDelayAutoMs;
  for (const s of speakers) if (s.role === 'sub') s.delayMs = (s.delayMs ?? 0) + subDelay;
  for (const s of tops) s.delayMs = topDelay;

  // ---- delay towers -------------------------------------------------------
  const mainsRefLevel = 10 * Math.log10(tops.reduce((a, s) => a + 10 ** (levelDb(s, ref) / 10), 0));
  const placeTower = (id: string, label: string, pos: Vec3, zone: Vec3) => {
    const s: SystemSpeaker = { id, role: 'fill', label, pos, aim: aimAt(pos, zone), mount: 'stand' };
    const tMain = Math.min(...tops.map((t) => (dist(t.pos, zone) / SPEED_OF_SOUND) * 1000 + (t.delayMs ?? 0)));
    const tSelf = (dist(pos, zone) / SPEED_OF_SOUND) * 1000;
    const auto = Math.max(0, tMain - tSelf) + c.towerHaasMs;
    s.autoDelayMs = auto;
    s.delayMs = c.towerDelayOverride[id] ?? auto;
    // level match: combined level at its zone ≈ 3 dB under the level near the front
    // (towers sit a little under the stage so the image stays on the stage)
    const lm = 10 * Math.log10(tops.reduce((a, t) => a + 10 ** (levelDb(t, zone) / 10), 0));
    const need = 10 ** ((mainsRefLevel - 3) / 10) - 10 ** (lm / 10);
    const raw = levelDb(s, zone, 0);
    const autoGain = need > 0 ? Math.max(-20, Math.min(6, 10 * Math.log10(need) - raw)) : -20;
    s.gainDb = c.towerGainDb ?? Math.round(autoGain * 2) / 2;
    s.note = `aims at ${(zone.y - B).toFixed(0)} m from the stage; auto delay ${auto.toFixed(1)} ms (stage sound ${(tMain - tSelf).toFixed(1)} ms + Haas ${c.towerHaasMs} ms), level ${autoGain.toFixed(1)} dB`;
    speakers.push(s);
  };
  if (c.towerCount >= 2) {
    const ty = B + Math.min(c.towerDistM, D - 4);
    const tx = Math.min(W * 0.3, spacing * 0.75);
    for (const side of [-1, 1] as const)
      placeTower(side < 0 ? 'T1' : 'T2', side < 0 ? 'Delay tower, back left' : 'Delay tower, back right', { x: cx + side * tx, y: ty, z: c.towerHeightM }, { x: cx + side * tx * 0.6, y: Math.min(B + D - 2, ty + 12), z: ear });
  }
  if (c.towerCount >= 4) {
    const ty = B + Math.min(c.towerDistM * 0.55, D - 6);
    for (const side of [-1, 1] as const)
      placeTower(side < 0 ? 'T3' : 'T4', side < 0 ? 'Perimeter tower, left side' : 'Perimeter tower, right side', { x: side < 0 ? 1 : W - 1, y: ty, z: c.towerHeightM }, { x: cx + side * W * 0.22, y: ty + 6, z: ear });
  }

  // ---- front fills at the stage lip --------------------------------------
  if (c.frontFills) {
    const n = W > 24 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const x = cx + (i - (n - 1) / 2) * Math.min(5, W / (n + 1));
      const pos = { x, y: B + 0.2, z: 0.45 };
      const zone = { x, y: B + 4, z: ear };
      const tMain = Math.min(...tops.map((t) => (dist(t.pos, zone) / SPEED_OF_SOUND) * 1000 + (t.delayMs ?? 0)));
      const auto = Math.max(0, tMain - (dist(pos, zone) / SPEED_OF_SOUND) * 1000) + 2;
      speakers.push({
        id: `FF${i + 1}`,
        role: 'fill',
        label: 'Front fill (stage lip)',
        onStage: true,
        pos,
        aim: aimAt(pos, zone),
        mount: 'floor',
        delayMs: c.towerDelayOverride[`FF${i + 1}`] ?? auto,
        autoDelayMs: auto,
        gainDb: -10,
        note: 'Fills the first rows, which sit under the tops’ coverage; aligned to the tops +2 ms.',
      });
    }
  }

  // ---- DJ monitors ---------------------------------------------------------
  if (c.djMonitors) {
    for (const side of [-1, 1] as const) {
      const pos = { x: dj.x + side * 1.3, y: dj.y + 0.6, z: 1.1 };
      speakers.push({ id: side < 0 ? 'M1' : 'M2', role: 'monitor', label: 'DJ monitor', pos, aim: aimAt(pos, dj), mount: 'stand', note: 'Aimed back at the DJ; not part of the crowd maps.' });
    }
  }

  return {
    subCab: { w: SUB_CAB.w, h: SUB_CAB.h, d: SUB_CAB.d },
    venue: { widthM: W, depthM: B + D, heightM: 12, rt60S: 0.1 },
    stageY: B,
    crowd,
    stage,
    dj,
    ref,
    speakers,
    subDelayAutoMs,
    subGroups,
    notes,
  };
}
