// Multi-speaker system layouts for a room: where each speaker goes, how it is
// aimed, and what it does — plus two "sound design" maps:
//   • coverage: how evenly loud the music is across the room (direct sound,
//     1–4 kHz, simple 2-way directivity, power sum of all full-range speakers)
//   • stereo image: where the left/right arrival-time difference is small
//     enough (< ~0.6 ms) for a centred phantom image (precedence effect)

import type { PlacementConfig, RoomConfig, SubConfig, Vec3 } from './roomAcoustics';
import { SPEED_OF_SOUND, listenerPosition, speakerPositions, subPositions, toeInDeg } from './roomAcoustics';
import type { Role } from './designs';
import type { AppShape } from './roomShape';
import { buildRoom, glassAlpha, imageSources, pathGain, type ImageSource } from './reflections';

export type LayoutId = 'stereo' | '2.1' | '2.2' | 'lcr' | '5.1' | '5.1.2' | '7.1' | 'party';

export interface SystemSpeaker {
  id: string;
  role: Role | 'monitor';
  label: string;
  pos: Vec3;
  /** unit vector of the speaker's main axis */
  aim: Vec3;
  mount: 'stand' | 'floor' | 'console' | 'wall' | 'ceiling';
  /** signal delay to apply (ms), e.g. for delayed fill speakers */
  delayMs?: number;
  /** level relative to the mains (dB) */
  gainDb?: number;
  /** the delay the planner would pick */
  autoDelayMs?: number;
  /** the level trim the planner would pick */
  autoGainDb?: number;
  /** polarity inverted (cardioid sub arrays) */
  invert?: boolean;
  /** extra 2nd-order high-pass from the horn mouth size (subs), Hz */
  mouthHpHz?: number;
  /** cabinet group, e.g. one coupled sub stack */
  group?: string;
  /** part of the stage system (e.g. front fills) rather than a remote fill */
  onStage?: boolean;
  /** simulated complex response (normalised), e.g. a printed horn sub */
  response?: (fHz: number) => { re: number; im: number };
  note?: string;
}

export interface LayoutInfo {
  id: LayoutId;
  name: string;
  channels: string;
  goal: string;
  learn: string;
  subs: SubConfig;
}

export const LAYOUTS: LayoutInfo[] = [
  {
    id: 'stereo',
    name: 'Stereo pair',
    channels: '2.0',
    goal: 'Critical music listening from one seat.',
    learn: 'Two speakers and you at the tip of a triangle. Everything — vocals, instruments, the "stage" — is a phantom image your brain builds from tiny time and level differences between the two. Magical in the sweet spot, lopsided outside it.',
    subs: { count: 0, layout: 'front-wall-mid', crossoverHz: 80 },
  },
  {
    id: '2.1',
    name: 'Stereo + subwoofer',
    channels: '2.1',
    goal: 'Music with real bass; the sub takes the room-mode problem off the main speakers.',
    learn: 'Below ~80 Hz you cannot hear where sound comes from, so one sub can play the bass for both sides. Splitting the work also lets the mains go in the best spot for imaging while the sub goes in the best spot for bass.',
    subs: { count: 1, layout: 'front-wall-mid', crossoverHz: 80 },
  },
  {
    id: '2.2',
    name: 'Stereo + two subs',
    channels: '2.2',
    goal: 'Even bass for every seat — the best upgrade for hosting.',
    learn: 'Two subs on opposite walls cancel the room\'s odd resonances, so the bass sounds the same across a whole sofa instead of booming in one seat and vanishing in the next.',
    subs: { count: 2, layout: 'front-back-mid', crossoverHz: 80 },
  },
  {
    id: 'lcr',
    name: 'Left / Centre / Right',
    channels: '3.1',
    goal: 'TV and movies with guests: dialogue locked to the screen for every seat.',
    learn: 'A phantom centre only exists in the middle seat; sit to one side and voices jump to the nearer speaker. A real centre speaker fixes that for everyone. For music, a good upmixer spreads the stereo across all three.',
    subs: { count: 1, layout: 'front-corners', crossoverHz: 80 },
  },
  {
    id: '5.1',
    name: 'Surround 5.1',
    channels: '5.1',
    goal: 'Movies and games that wrap around you.',
    learn: 'Standard positions (ITU-R BS.775): L/R at ±30°, centre at 0°, surrounds at ±100–120°, a little above ear height. Surrounds carry ambience and effects, so they should be diffuse, not pin-point: aim them across the seats, not at your head.',
    subs: { count: 1, layout: 'front-corners', crossoverHz: 80 },
  },
  {
    id: '5.1.2',
    name: 'Surround + ceiling (Atmos 5.1.2)',
    channels: '5.1.2',
    goal: 'Height effects: rain, flyovers, the size of a concert hall.',
    learn: 'Two ceiling speakers slightly in front of the seats, in line with the mains. With a 9′ ceiling, the "top middle" position works well. Use small, wide-dispersion speakers aimed at the seats.',
    subs: { count: 1, layout: 'front-corners', crossoverHz: 80 },
  },
  {
    id: '7.1',
    name: 'Surround 7.1',
    channels: '7.1',
    goal: 'Smoother surround panning — but needs space behind the seats.',
    learn: 'Side surrounds at ±90–110°, rear surrounds at ±135–150°. In a 12′ room the rear pair ends up on the back wall close to the sofa; 5.1.2 usually gives more for the money here.',
    subs: { count: 2, layout: 'front-back-mid', crossoverHz: 80 },
  },
  {
    id: 'party',
    name: 'Guests / party',
    channels: '2.2 + fills',
    goal: 'Even, comfortable sound everywhere people stand and talk — not one perfect seat.',
    learn: 'Installers do this with a "distributed" design: mains with little toe-in for wide coverage, two subs for even bass, and small delayed fill speakers at the far end playing at a lower level. The delay (Haas effect) keeps the sound seeming to come from the mains while filling in the back of the room, so nobody has to shout and nobody is blasted.',
    subs: { count: 2, layout: 'front-back-mid', crossoverHz: 80 },
  },
];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Ray from the listener at azimuth `azDeg` (0 = towards the front wall, + = right) to the walls. */
function onWalls(room: RoomConfig, ear: Vec3, azDeg: number, margin = 0.12): { x: number; y: number } {
  const a = (azDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  let t = Infinity;
  if (dx > 1e-6) t = Math.min(t, (room.widthM - margin - ear.x) / dx);
  if (dx < -1e-6) t = Math.min(t, (margin - ear.x) / dx);
  if (dy > 1e-6) t = Math.min(t, (room.depthM - margin - ear.y) / dy);
  if (dy < -1e-6) t = Math.min(t, (margin - ear.y) / dy);
  return { x: ear.x + dx * t, y: ear.y + dy * t };
}

export interface FillSettings {
  /** null = automatic */
  delayMs: number | null;
  gainDb: number;
}

export function layoutSpeakers(
  id: LayoutId,
  room: RoomConfig,
  pl: PlacementConfig,
  subs: SubConfig,
  fill: FillSettings = { delayMs: null, gainDb: -6 }
): SystemSpeaker[] {
  const ear = listenerPosition(room, pl);
  const { L, R } = speakerPositions(room, pl);
  const out: SystemSpeaker[] = [];
  const toward = (p: Vec3, target: Vec3, flat = true): Vec3 => norm(flat ? { ...sub(target, p), z: 0 } : sub(target, p));
  const toe = (toeInDeg(pl) * Math.PI) / 180;
  const mainsAim = (side: -1 | 1, toeRad: number): Vec3 => ({ x: -side * Math.sin(toeRad), y: Math.cos(toeRad), z: 0 });
  const wide = id === 'party';
  const mainsToe = wide ? toe * 0.35 : toe;
  out.push({ id: 'L', role: 'mains', label: 'Left', pos: L, aim: mainsAim(-1, mainsToe), mount: 'stand' });
  out.push({ id: 'R', role: 'mains', label: 'Right', pos: R, aim: mainsAim(1, mainsToe), mount: 'stand' });

  if (id === 'lcr' || id === '5.1' || id === '5.1.2' || id === '7.1') {
    const c = { x: room.widthM / 2, y: pl.speakerFrontDistM, z: Math.max(0.55, pl.earHeightM - 0.3) };
    out.push({ id: 'C', role: 'center', label: 'Centre', pos: c, aim: toward(c, ear, false), mount: 'console', note: 'On a low console under the TV, tilted up toward ear height.' });
  }
  const surroundZ = Math.min(room.heightM - 0.3, pl.earHeightM + 0.6);
  const addSurround = (az: number, idp: string, label: string) => {
    const p = onWalls(room, ear, az);
    const pos = { x: p.x, y: p.y, z: surroundZ };
    out.push({ id: idp, role: 'surround', label, pos, aim: toward(pos, ear, false), mount: 'wall' });
  };
  if (id === '5.1' || id === '5.1.2') {
    addSurround(-110, 'SL', 'Surround left');
    addSurround(110, 'SR', 'Surround right');
  }
  if (id === '7.1') {
    addSurround(-100, 'SL', 'Side surround left');
    addSurround(100, 'SR', 'Side surround right');
    addSurround(-145, 'RL', 'Rear surround left');
    addSurround(145, 'RR', 'Rear surround right');
  }
  if (id === '5.1.2') {
    // "top middle": slightly ahead of the seat, in line with the mains
    const y = Math.max(0.4, ear.y - 0.35);
    for (const [side, p] of [
      [-1, L],
      [1, R],
    ] as const) {
      const pos = { x: room.widthM / 2 + side * Math.min(pl.speakerSpacingM / 2, room.widthM / 2 - 0.4), y, z: room.heightM - 0.03 };
      out.push({
        id: side < 0 ? 'TL' : 'TR',
        role: 'height',
        label: side < 0 ? 'Top left (ceiling)' : 'Top right (ceiling)',
        pos,
        aim: toward(pos, ear, false),
        mount: 'ceiling',
        note: 'Flush in the ceiling or on an angled bracket, aimed at the seats.',
      });
      void p;
    }
  }
  if (id === 'party') {
    // fills on the side walls near the back corners, a little above head height,
    // aimed across the back half of the room (keeps the back wall free for a sub)
    const y = Math.max(ear.y + 0.6, room.depthM - 0.45);
    const z = Math.min(room.heightM - 0.3, 1.9);
    for (const side of [-1, 1] as const) {
      const pos = { x: side < 0 ? 0.12 : room.widthM - 0.12, y, z };
      const target = { x: room.widthM / 2 - side * room.widthM * 0.05, y: room.depthM * 0.45, z: 1.4 };
      // delay so the mains' sound arrives first (+10 ms Haas margin) at the fill zone
      const zone = { x: room.widthM / 2 + side * room.widthM * 0.2, y: room.depthM * 0.78, z: 1.5 };
      const main = side < 0 ? L : R;
      const delay = (Math.hypot(zone.x - main.x, zone.y - main.y, zone.z - main.z) - Math.hypot(zone.x - pos.x, zone.y - pos.y, zone.z - pos.z)) / SPEED_OF_SOUND * 1000 + 10;
      const auto = Math.max(0, delay);
      const used = fill.delayMs ?? auto;
      out.push({
        id: side < 0 ? 'FL' : 'FR',
        role: 'fill',
        label: side < 0 ? 'Fill left (side wall, back)' : 'Fill right (side wall, back)',
        pos,
        aim: toward(pos, target, false),
        mount: 'wall',
        delayMs: used,
        autoDelayMs: auto,
        gainDb: fill.gainDb,
        note: `Plays the ${side < 0 ? 'left' : 'right'} channel ${Math.abs(fill.gainDb).toFixed(0)} dB quieter, delayed ${used.toFixed(1)} ms.`,
      });
    }
  }
  for (const [i, s] of subPositions(room, subs).entries()) {
    out.push({ id: `S${i + 1}`, role: 'sub', label: `Subwoofer ${i + 1}`, pos: s, aim: { x: 0, y: s.y < room.depthM / 2 ? 1 : -1, z: 0 }, mount: 'floor' });
  }
  return out;
}

/** Off-axis attenuation (dB) of a typical 2-way at 1–4 kHz: about −6 dB at 45°, −20 dB beyond 90°. */
// ---------------------------------------------------------------------------
// Seat alignment ("speaker distance & level" in an AV receiver): delay every
// speaker so its sound reaches the main seat at the same moment as the
// farthest one, and trim levels so each is equally loud there. Fills keep
// their Haas delay, shifted by whatever delay the mains got. Per-speaker
// overrides win over the automatic values.
// ---------------------------------------------------------------------------

export interface DspOverride {
  delayMs?: number;
  gainDb?: number;
  invert?: boolean;
}

export function alignToSeat(
  speakers: SystemSpeaker[],
  seat: Vec3,
  opts: { auto: boolean; dsp: Record<string, DspOverride>; fillDelayMs: number | null }
): SystemSpeaker[] {
  const dist = (s: SystemSpeaker) => Math.hypot(s.pos.x - seat.x, s.pos.y - seat.y, s.pos.z - seat.z);
  const direct = speakers.filter((s) => s.role !== 'fill' && s.role !== 'monitor');
  const dMax = Math.max(0, ...direct.map(dist));
  const mains = speakers.filter((s) => s.role === 'mains');
  const dMain = mains.length ? mains.reduce((a, s) => a + dist(s), 0) / mains.length : dMax;
  const mainsAlign = opts.auto ? ((dMax - dMain) / SPEED_OF_SOUND) * 1000 : 0;
  return speakers.map((s) => {
    const o = opts.dsp[s.id] ?? {};
    if (s.role === 'fill') {
      const auto = (s.autoDelayMs ?? 0) + mainsAlign;
      return { ...s, autoDelayMs: auto, delayMs: opts.fillDelayMs ?? auto, invert: o.invert ?? s.invert };
    }
    const d = dist(s);
    const autoDelay = opts.auto ? ((dMax - d) / SPEED_OF_SOUND) * 1000 : 0;
    const roleDefault = s.role === 'surround' || s.role === 'height' ? -3 : 0;
    const autoGain = opts.auto && s.role !== 'sub' ? Math.max(-10, Math.min(6, 20 * Math.log10(d / Math.max(dMain, 0.3)))) : roleDefault;
    return {
      ...s,
      autoDelayMs: autoDelay,
      autoGainDb: autoGain,
      delayMs: o.delayMs ?? autoDelay,
      gainDb: o.gainDb ?? autoGain,
      invert: o.invert ?? s.invert,
    };
  });
}

/**
 * How well the subs and the mains add up at a point around the crossover
 * (direct sound): 0 dB = perfectly in step, −6 dB or worse = fighting.
 * Returns the loss vs a perfect sum, averaged over half an octave each side.
 */
export function crossoverSumDb(speakers: SystemSpeaker[], at: Vec3, xoverHz: number): number {
  const mains = speakers.filter((s) => s.role === 'mains');
  const subs = speakers.filter((s) => s.role === 'sub');
  if (!mains.length || !subs.length) return NaN;
  let loss = 0;
  const fs = [0.7, 0.85, 1, 1.2, 1.4].map((m) => m * xoverHz);
  for (const f of fs) {
    const one = (list: SystemSpeaker[], type: 'lp' | 'hp') => {
      let re = 0;
      let im = 0;
      let mag = 0;
      const x = lr4c(f / xoverHz, type);
      for (const s of list) {
        const r = Math.max(0.3, Math.hypot(s.pos.x - at.x, s.pos.y - at.y, s.pos.z - at.z));
        const g = (s.invert ? -1 : 1) * 10 ** ((s.gainDb ?? 0) / 20) / r;
        const ph = -(2 * Math.PI * f) * (r / SPEED_OF_SOUND + (s.delayMs ?? 0) / 1000);
        re += g * (x.re * Math.cos(ph) - x.im * Math.sin(ph));
        im += g * (x.re * Math.sin(ph) + x.im * Math.cos(ph));
        mag += Math.abs(g) * Math.hypot(x.re, x.im);
      }
      return { re: re / list.length, im: im / list.length, mag: mag / list.length };
    };
    const a = one(mains, 'hp');
    const b = one(subs, 'lp');
    loss += 20 * Math.log10(Math.hypot(a.re + b.re, a.im + b.im) / (a.mag + b.mag));
  }
  return loss / fs.length;
}

/** Linkwitz–Riley 4th order at x = f/fc. */
function lr4c(x: number, type: 'lp' | 'hp') {
  const q = Math.SQRT1_2;
  const dre = 1 - x * x;
  const dim = x / q;
  const nre = type === 'lp' ? 1 : -x * x;
  const d2 = dre * dre + dim * dim;
  const bre = (nre * dre) / d2;
  const bim = (-nre * dim) / d2;
  return { re: bre * bre - bim * bim, im: 2 * bre * bim };
}

/** Sub delay (and polarity) that makes subs and mains add up best at the seat. */
export function bestSubDelay(speakers: SystemSpeaker[], at: Vec3, xoverHz: number): { delayMs: number; invert: boolean; sumDb: number } {
  let best = { delayMs: 0, invert: false, sumDb: -Infinity };
  // the mains are the reference; slide the subs (sub delays relative to their current values)
  for (const invert of [false, true])
    for (let dt = 0; dt <= 20; dt += 0.1) {
      const trial = speakers.map((s) => (s.role === 'sub' ? { ...s, delayMs: dt, invert } : s));
      const v = crossoverSumDb(trial, at, xoverHz);
      // prefer the normal polarity and the shortest delay when nearly equal
      if (v > best.sumDb + 0.05) best = { delayMs: dt, invert, sumDb: v };
    }
  return best;
}

export function directivityDb(offAxisDeg: number): number {
  const a = Math.min(Math.abs(offAxisDeg), 180);
  return Math.max(-24, -6 * (a / 45) ** 2);
}

export interface CoverageMap {
  grid: number;
  cells: { x: number; y: number; db: number }[];
  /** spread across the room away from the walls (dB) */
  spreadDb: number;
  min: number;
  max: number;
}

export interface Area {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function coverageMap(room: RoomConfig, speakers: SystemSpeaker[], zEar: number, grid = 0.2, area?: Area): CoverageMap {
  const srcs = speakers.filter((s) => s.role !== 'sub' && s.role !== 'monitor');
  const cells: { x: number; y: number; db: number }[] = [];
  for (let y = grid / 2; y < room.depthM; y += grid) {
    for (let x = grid / 2; x < room.widthM; x += grid) {
      let pow = 0;
      for (const s of srcs) {
        const v = { x: x - s.pos.x, y: y - s.pos.y, z: zEar - s.pos.z };
        const r = Math.max(Math.hypot(v.x, v.y, v.z), 0.3);
        const cos = (v.x * s.aim.x + v.y * s.aim.y + v.z * s.aim.z) / r;
        const off = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
        const gain = s.role === 'fill' ? (s.gainDb ?? -6) : s.role === 'height' || s.role === 'surround' ? -3 : 0;
        pow += Math.pow(10, (directivityDb(off) + gain - 20 * Math.log10(r)) / 10);
      }
      cells.push({ x, y, db: 10 * Math.log10(pow) });
    }
  }
  const inner = area
    ? cells.filter((c) => c.x >= area.x0 && c.x <= area.x1 && c.y >= area.y0 && c.y <= area.y1)
    : cells.filter((c) => c.x > 0.5 && c.x < room.widthM - 0.5 && c.y > 1.0 && c.y < room.depthM - 0.4);
  const sorted = inner.map((c) => c.db).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return { grid, cells, spreadDb: hi - lo, min: lo, max: hi };
}

/** |t_L − t_R| in ms at each point: < 0.6 ms ≈ centred image, > 1 ms the image collapses to the nearer speaker. */
export function imageMap(room: RoomConfig, pl: PlacementConfig, zEar: number, grid = 0.2) {
  const { L, R } = speakerPositions(room, pl);
  const cells: { x: number; y: number; ms: number }[] = [];
  for (let y = grid / 2; y < room.depthM; y += grid) {
    for (let x = grid / 2; x < room.widthM; x += grid) {
      const dl = Math.hypot(x - L.x, y - L.y, zEar - L.z);
      const dr = Math.hypot(x - R.x, y - R.y, zEar - R.z);
      cells.push({ x, y, ms: (Math.abs(dl - dr) / SPEED_OF_SOUND) * 1000 });
    }
  }
  // how wide is the "good" zone along the seat row?
  const ear = listenerPosition(room, pl);
  const row = cells.filter((c) => Math.abs(c.y - ear.y) < grid / 2 + 1e-6 && c.ms < 0.6);
  const widthM = row.length ? Math.max(...row.map((c) => c.x)) - Math.min(...row.map((c) => c.x)) + grid : 0;
  return { grid, cells, sweetWidthM: widthM };
}

// ---------------------------------------------------------------------------
// Timing: who arrives first, and does the sound still come from the front?
// ---------------------------------------------------------------------------

export type ArrivalClass = 'blend' | 'mainsOnly' | 'fillFirst' | 'fillLoud' | 'echo';

export const ARRIVAL_LEGEND: Record<ArrivalClass, { color: string; label: string; good: boolean }> = {
  blend: { color: 'hsl(140 70% 42%)', label: 'Fill helps, sound still comes from the front', good: true },
  mainsOnly: { color: 'hsl(195 70% 42%)', label: 'Mains only (fill too far / quiet to matter)', good: true },
  fillLoud: { color: 'hsl(42 90% 48%)', label: 'Fill too loud: image drifts toward it', good: false },
  fillFirst: { color: 'hsl(0 72% 50%)', label: 'Fill arrives first: sound comes from the fill', good: false },
  echo: { color: 'hsl(24 90% 50%)', label: 'Fill arrives too late: heard as an echo', good: false },
};

function levelAt(s: SystemSpeaker, x: number, y: number, z: number) {
  const v = { x: x - s.pos.x, y: y - s.pos.y, z: z - s.pos.z };
  const r = Math.max(Math.hypot(v.x, v.y, v.z), 0.3);
  const cos = (v.x * s.aim.x + v.y * s.aim.y + v.z * s.aim.z) / r;
  const off = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return { r, db: (s.gainDb ?? 0) + directivityDb(off) - 20 * Math.log10(r), tMs: (r / SPEED_OF_SOUND) * 1000 + (s.delayMs ?? 0) };
}

/**
 * Precedence ("Haas") map. Rules of thumb from the precedence-effect literature:
 *  • a later copy within ~1–30 ms fuses with the first and we localise to the first,
 *    even when the later one is louder: ~6 dB at 5–10 ms, ~10 dB at 10–30 ms (Haas 1951);
 *  • beyond ~30–40 ms a copy that isn't much quieter is heard as a separate echo.
 */
export function arrivalMap(room: RoomConfig, speakers: SystemSpeaker[], zEar: number, grid = 0.1, area?: Area) {
  const mains = speakers.filter((s) => s.role === 'mains' || s.role === 'center' || (s.role === 'fill' && s.onStage));
  const fills = speakers.filter((s) => s.role === 'fill' && !s.onStage);
  const cells: { x: number; y: number; v: number; cls: ArrivalClass; dt: number; dl: number }[] = [];
  if (!fills.length) return { cells, goodFraction: 1, grid, hasFills: false };
  const order: ArrivalClass[] = ['blend', 'mainsOnly', 'fillLoud', 'fillFirst', 'echo'];
  let good = 0;
  let n = 0;
  for (let y = grid / 2; y < room.depthM; y += grid) {
    for (let x = grid / 2; x < room.widthM; x += grid) {
      const m = mains.map((s) => levelAt(s, x, y, zEar));
      const f = fills.map((s) => levelAt(s, x, y, zEar));
      const tm = Math.min(...m.map((a) => a.tMs));
      const lm = 10 * Math.log10(m.reduce((a, b) => a + 10 ** (b.db / 10), 0));
      const tf = Math.min(...f.map((a) => a.tMs));
      const lf = 10 * Math.log10(f.reduce((a, b) => a + 10 ** (b.db / 10), 0));
      const dt = tf - tm;
      const dl = lf - lm;
      let cls: ArrivalClass;
      if (dl < -12) cls = 'mainsOnly';
      else if (dt < 0) cls = 'fillFirst';
      else if (dt < 5) cls = dl < -3 ? 'blend' : 'fillLoud';
      else if (dt <= 10) cls = dl < 6 ? 'blend' : 'fillLoud';
      else if (dt <= 30) cls = dl < 10 ? 'blend' : 'fillLoud';
      else cls = dl < -6 ? 'blend' : 'echo';
      cells.push({ x, y, v: order.indexOf(cls), cls, dt, dl });
      if (area ? x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1 : x > 0.4 && x < room.widthM - 0.4 && y > 0.8) {
        n++;
        if (ARRIVAL_LEGEND[cls].good) good++;
      }
    }
  }
  return { cells, goodFraction: n ? good / n : 1, grid, hasFills: true };
}

export function arrivalColor(v: number) {
  const order: ArrivalClass[] = ['blend', 'mainsOnly', 'fillLoud', 'fillFirst', 'echo'];
  return ARRIVAL_LEGEND[order[Math.round(v)] ?? 'blend'].color;
}

// ---------------------------------------------------------------------------
// Interference: coherent sum of every speaker playing the same (centre-panned)
// sound, with each one's delay, level, directivity and crossover. Optionally
// adds the ground bounce (outdoors) or 1st/2nd-order wall reflections (indoors).
// ---------------------------------------------------------------------------

export interface Field {
  nx: number;
  ny: number;
  grid: number;
  re: Float32Array;
  im: Float32Array;
  db: Float32Array;
  freqHz: number;
  /** share of the listening area more than 10 dB below its median */
  deepDipFraction: number;
  medianDb: number;
}

export function interferenceField(
  room: RoomConfig,
  speakers: SystemSpeaker[],
  zEar: number,
  freqHz: number,
  subXoverHz: number,
  opts: { ground?: boolean; maxCells?: number; x0?: number; y0?: number; walls?: 0 | 1 | 2; shape?: AppShape | null } = {}
): Field {
  const lambda = SPEED_OF_SOUND / freqHz;
  const maxCells = opts.maxCells ?? 70000;
  const grid = Math.max(0.015, Math.min(0.1, lambda / 6), Math.sqrt((room.widthM * room.depthM) / maxCells));
  const nx = Math.max(1, Math.round(room.widthM / grid));
  const ny = Math.max(1, Math.round(room.depthM / grid));
  const k = (2 * Math.PI * freqHz) / SPEED_OF_SOUND;
  const w = 2 * Math.PI * freqHz;
  const hasSubs = speakers.some((s) => s.role === 'sub');
  // crossover magnitudes/phases (LR4) — subs low-pass, everyone else high-pass
  const lr4 = (type: 'lp' | 'hp') => {
    const x = freqHz / subXoverHz;
    const q = Math.SQRT1_2;
    // BW2: num/(1 - x² + j x/q)
    const dre = 1 - x * x;
    const dim = x / q;
    const nre = type === 'lp' ? 1 : -x * x;
    const d2 = dre * dre + dim * dim;
    const bre = (nre * dre) / d2;
    const bim = (-nre * dim) / d2;
    return { re: bre * bre - bim * bim, im: 2 * bre * bim };
  };
  const dirScale = Math.min(1, Math.max(0, (freqHz - 250) / 1250));
  // 2nd-order (Q 0.7) high-pass, used for an under-sized horn mouth
  const hp2 = (fc: number) => {
    const x = freqHz / fc;
    const dre = 1 - x * x;
    const dim = x / 0.7;
    const d2 = dre * dre + dim * dim;
    return { re: (-x * x * dre) / d2, im: (x * x * dim) / d2 };
  };
  const cm = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
  const srcs = speakers
    .filter((s) => s.role !== 'monitor')
    .filter((s) => (s.role === 'sub' ? freqHz < subXoverHz * 3 : true))
    .map((s) => {
      let xo = s.role === 'sub' ? lr4('lp') : hasSubs ? lr4('hp') : { re: 1, im: 0 };
      if (s.response) xo = cm(xo, s.response(freqHz));
      else if (s.mouthHpHz) xo = cm(xo, hp2(s.mouthHpHz));
      const g = (s.invert ? -1 : 1) * 10 ** ((s.gainDb ?? (s.role === 'surround' || s.role === 'height' ? -3 : 0)) / 20);
      const omni = s.role === 'sub';
      return { s, xo, g, omni, tau: (s.delayMs ?? 0) / 1000 };
    });
  // ground reflection: rigid at bass, increasingly absorptive on turf/forest floor
  const groundR = opts.ground ? (freqHz < 200 ? 0.95 : Math.max(0.25, 0.95 - 0.35 * Math.log2(freqHz / 200))) : 0;
  // indoor walls: image sources off the room's real outline (bay facets included),
  // floor and ceiling. Walls reflect with the average factor from the RT60
  // (Sabine: α = 0.161 V / (S·RT60), R = √(1 − α)); window glass with its own
  // frequency-dependent absorption; openings don't reflect at all.
  const order = opts.walls ?? 0;
  const room3 = order ? buildRoom(room, opts.shape ?? null) : null;
  const Rw = (() => {
    const { widthM: W, depthM: D, heightM: H } = room;
    const alpha = Math.min(0.95, (0.161 * W * D * H) / (2 * (W * D + W * H + D * H) * Math.max(room.rt60S, 0.1)));
    return Math.sqrt(1 - alpha);
  })();
  const Rg = Math.sqrt(1 - glassAlpha(freqHz));
  const imgsOf = new Map<SystemSpeaker, ImageSource[]>();
  if (room3) for (const { s } of srcs) imgsOf.set(s, imageSources(s.pos, s.aim, room3, order));
  const re = new Float32Array(nx * ny);
  const im = new Float32Array(nx * ny);
  const db = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const y = (iy + 0.5) * grid;
    for (let ix = 0; ix < nx; ix++) {
      const x = (ix + 0.5) * grid;
      let pr = 0;
      let pi = 0;
      for (const { s, xo, g, omni, tau } of srcs) {
        if (room3) {
          const rcv = { x, y, z: zEar };
          for (const m of imgsOf.get(s)!) {
            const pg = pathGain(m, s.pos, rcv, room3, Rw, Rg);
            if (pg === 0) continue;
            const vx = x - m.pos.x;
            const vy = y - m.pos.y;
            const vz = zEar - m.pos.z;
            const r = Math.max(Math.hypot(vx, vy, vz), 0.15);
            const cos = (vx * m.aim.x + vy * m.aim.y + vz * m.aim.z) / r;
            const off = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
            const a = (pg * g * (omni ? 1 : 10 ** ((directivityDb(off) * dirScale) / 20))) / r;
            const ph = -(k * r + w * tau);
            const cr = Math.cos(ph);
            const ci = Math.sin(ph);
            pr += a * (xo.re * cr - xo.im * ci);
            pi += a * (xo.re * ci + xo.im * cr);
          }
          continue;
        }
        for (let img = 0; img < (groundR > 0 ? 2 : 1); img++) {
          const sz = img ? -s.pos.z : s.pos.z;
          const vx = x - s.pos.x;
          const vy = y - s.pos.y;
          const vz = zEar - sz;
          const r = Math.max(Math.hypot(vx, vy, vz), 0.15);
          const azz = img ? -s.aim.z : s.aim.z;
          const cos = (vx * s.aim.x + vy * s.aim.y + vz * azz) / r;
          const off = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
          const a = ((img ? groundR : 1) * g * (omni ? 1 : 10 ** ((directivityDb(off) * dirScale) / 20))) / r;
          const ph = -(k * r + w * tau);
          const cr = Math.cos(ph);
          const ci = Math.sin(ph);
          pr += a * (xo.re * cr - xo.im * ci);
          pi += a * (xo.re * ci + xo.im * cr);
        }
      }
      const i = iy * nx + ix;
      re[i] = pr;
      im[i] = pi;
      db[i] = 10 * Math.log10(pr * pr + pi * pi + 1e-12);
    }
  }
  // stats over the listening area
  const vals: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    const y = (iy + 0.5) * grid;
    if (y < 0.8) continue;
    for (let ix = 0; ix < nx; ix++) {
      const x = (ix + 0.5) * grid;
      if (x < 0.4 || x > room.widthM - 0.4) continue;
      vals.push(db[iy * nx + ix]);
    }
  }
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)] ?? 0;
  const deep = vals.filter((v) => v < median - 10).length / Math.max(vals.length, 1);
  return { nx, ny, grid, re, im, db, freqHz, deepDipFraction: deep, medianDb: median };
}

/** Stereo-image map for any left/right pair (|t_L − t_R| in ms). */
export function imageMapLR(room: RoomConfig, L: Vec3, R: Vec3, zEar: number, grid: number, rowY: number) {
  const cells: { x: number; y: number; ms: number }[] = [];
  for (let y = grid / 2; y < room.depthM; y += grid) {
    for (let x = grid / 2; x < room.widthM; x += grid) {
      const dl = Math.hypot(x - L.x, y - L.y, zEar - L.z);
      const dr = Math.hypot(x - R.x, y - R.y, zEar - R.z);
      cells.push({ x, y, ms: (Math.abs(dl - dr) / SPEED_OF_SOUND) * 1000 });
    }
  }
  const row = cells.filter((c) => Math.abs(c.y - rowY) < grid / 2 + 1e-6 && c.ms < 0.6);
  const widthM = row.length ? Math.max(...row.map((c) => c.x)) - Math.min(...row.map((c) => c.x)) + grid : 0;
  return { grid, cells, sweetWidthM: widthM };
}

/**
 * Bass level map (energy average over a band of the coherent sum of every sub,
 * with delays, polarity, crossover, horn-mouth roll-off and a ground image).
 * Outdoors there are no room modes, so "evenness" is about lobing and rear spill.
 */
export function bassLevelMap(room: RoomConfig, speakers: SystemSpeaker[], zEar: number, xoverHz: number, f0 = 35, f1 = 100, grid = 0.5) {
  const freqs: number[] = [];
  for (let i = 0; i < 12; i++) freqs.push(f0 * Math.pow(f1 / f0, i / 11));
  const nx = Math.max(1, Math.round(room.widthM / grid));
  const ny = Math.max(1, Math.round(room.depthM / grid));
  const acc = new Float64Array(nx * ny);
  for (const f of freqs) {
    const F = interferenceField(room, speakers, zEar, f, xoverHz, { ground: true, maxCells: nx * ny });
    // resample F onto our grid (nearest)
    for (let iy = 0; iy < ny; iy++) {
      const fy = Math.min(F.ny - 1, Math.floor(((iy + 0.5) * grid) / F.grid));
      for (let ix = 0; ix < nx; ix++) {
        const fx = Math.min(F.nx - 1, Math.floor(((ix + 0.5) * grid) / F.grid));
        const i = fy * F.nx + fx;
        acc[iy * nx + ix] += F.re[i] * F.re[i] + F.im[i] * F.im[i];
      }
    }
  }
  const cells: { x: number; y: number; db: number }[] = [];
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++) cells.push({ x: (ix + 0.5) * grid, y: (iy + 0.5) * grid, db: 10 * Math.log10(acc[iy * nx + ix] / freqs.length + 1e-12) });
  return { grid, cells };
}
