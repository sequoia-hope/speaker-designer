import type { PlacementConfig, RoomConfig, SubConfig } from './roomAcoustics';
import { FT } from './roomAcoustics';
import { DESIGNS, type DesignSettings, type Role } from './designs';
import type { DspOverride, LayoutId } from './system';
import type { Compass } from './roomShape';
import { LIVING_ROOM, toAppFrame } from './roomShape';
import { DEFAULT_OUTDOOR, type OutdoorConfig } from './outdoor';
import { DEFAULT_PRINTER, HYBRID_PRESETS, type HybridParams, type Printer } from './hybrid';

export interface HomeState {
  room: RoomConfig;
  placement: PlacementConfig;
  sub: SubConfig;
  /** per-design settings (a tweakable copy of each catalogue preset) */
  designs: Record<string, DesignSettings>;
  /** design shown in the Speakers and Build tabs */
  activeDesign: string;
  system: {
    layout: LayoutId;
    roles: Record<Role, string>;
    /** party fills: null = automatic delay */
    fillDelayMs: number | null;
    fillGainDb: number;
    /** delay/level every speaker to the main seat (AV-receiver style) */
    autoAlign: boolean;
    /** per-speaker DSP overrides, by speaker id */
    dsp: Record<string, DspOverride>;
    /** wall reflections in the interference map: 0 = direct only */
    walls: 0 | 1 | 2;
  };
  /** a known room outline (windows, bay…) or null for a plain rectangle */
  shapeId: string | null;
  frontWall: Compass;
  mapMode: 'bass' | 'coverage' | 'image' | 'arrival' | 'interference';
  /** maps computed at seated or standing (dancing) ear height */
  mapEar: 'seated' | 'standing';
  furniture: { layout: 'split' | 'sofa'; chaiseSide: 'left' | 'right' };
  venue: 'living' | 'outdoor';
  outdoor: OutdoorConfig;
  outdoorMap: 'coverage' | 'bass' | 'image' | 'arrival' | 'interference';
  hybrid: {
    sub: HybridParams;
    living: HybridParams;
    edit: 'sub' | 'living';
    printer: Printer;
    useOutdoor: boolean;
    useLiving: boolean;
  };
  stepsDone: Record<string, boolean>;
  roomName: string;
}

const KEY = 'speaker-designer.home.v4';

export const ROOM_PRESETS = [
  {
    name: 'Living room',
    shapeId: 'living',
    widthM: 12.5 * FT,
    depthM: 12.5 * FT,
    heightM: 9 * FT,
  },
];

export function freshDesigns(): Record<string, DesignSettings> {
  return Object.fromEntries(DESIGNS.map((d) => [d.id, { ...d.settings }]));
}

export function defaultState(): HomeState {
  const front: Compass = 'south';
  const app = toAppFrame(LIVING_ROOM, front);
  return {
    roomName: ROOM_PRESETS[0].name,
    shapeId: 'living',
    frontWall: front,
    room: { widthM: app.widthM, depthM: app.depthM, heightM: LIVING_ROOM.heightM, rt60S: 0.45 },
    placement: {
      speakerFrontDistM: 0.25,
      speakerSpacingM: 2.3,
      wooferHeightM: 0.85,
      listenerDistM: 2.35,
      earHeightM: 1.0,
      toeCrossAheadM: 0.3,
    },
    sub: { count: 1, layout: 'front-wall-mid', crossoverHz: 80 },
    designs: freshDesigns(),
    activeDesign: 'monitor',
    system: {
      layout: '2.1',
      roles: { mains: 'monitor', center: 'center', surround: 'compact', height: 'fullrange', fill: 'compact', sub: 'sub12' },
      fillDelayMs: null,
      fillGainDb: -6,
      autoAlign: true,
      dsp: {},
      walls: 1,
    },
    mapMode: 'bass',
    mapEar: 'seated',
    furniture: { layout: 'split', chaiseSide: 'left' },
    venue: 'living',
    outdoor: { ...DEFAULT_OUTDOOR, towerDelayOverride: {} },
    outdoorMap: 'coverage',
    hybrid: {
      sub: { ...HYBRID_PRESETS.sub },
      living: { ...HYBRID_PRESETS.living },
      edit: 'sub',
      printer: { ...DEFAULT_PRINTER },
      useOutdoor: false,
      useLiving: false,
    },
    stepsDone: {},
  };
}

function load(raw: string | null = localStorage.getItem(KEY)): HomeState {
  const d = defaultState();
  try {
    if (!raw) return d;
    const s = JSON.parse(raw);
    // hybrid designs saved before organic shapes / fat-nozzle defaults: start from the new presets
    if (s.hybrid && s.hybrid.sub && s.hybrid.sub.rounding === undefined) {
      delete s.hybrid.sub;
      delete s.hybrid.living;
      delete s.hybrid.printer;
    }
    // older saves called this room the dining room
    if (s.shapeId === 'dining') s.shapeId = 'living';
    if (typeof s.roomName === 'string' && /dining/i.test(s.roomName)) s.roomName = 'Living room';
    return {
      ...d,
      ...s,
      room: { ...d.room, ...s.room },
      placement: { ...d.placement, ...s.placement },
      sub: { ...d.sub, ...s.sub },
      designs: { ...d.designs, ...(s.designs ?? {}) },
      system: { ...d.system, ...(s.system ?? {}), roles: { ...d.system.roles, ...(s.system?.roles ?? {}) }, dsp: { ...(s.system?.dsp ?? {}) } },
      furniture: { ...d.furniture, ...(s.furniture ?? {}) },
      hybrid: {
        ...d.hybrid,
        ...(s.hybrid ?? {}),
        sub: { ...d.hybrid.sub, ...(s.hybrid?.sub ?? {}) },
        living: { ...d.hybrid.living, ...(s.hybrid?.living ?? {}) },
        printer: { ...d.hybrid.printer, ...(s.hybrid?.printer ?? {}) },
      },
      outdoor: { ...d.outdoor, ...(s.outdoor ?? {}), towerDelayOverride: { ...(s.outdoor?.towerDelayOverride ?? {}) } },
      stepsDone: { ...(s.stepsDone ?? {}) },
    };
  } catch {
    return d;
  }
}

export const home = $state<HomeState>(load());

export function saveHome() {
  try {
    localStorage.setItem(KEY, JSON.stringify(home));
  } catch {
    /* private mode etc. */
  }
}

// Keep several open browser tabs in step: another tab saved → adopt its state here,
// so a stale tab can't overwrite newer edits on its next save.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue || e.newValue === JSON.stringify(home)) return;
    Object.assign(home, load(e.newValue));
  });
}

export function resetHome() {
  Object.assign(home, defaultState());
  saveHome();
}
