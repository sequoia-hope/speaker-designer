import type { PlacementConfig, RoomConfig, SubConfig } from './roomAcoustics';
import { FT } from './roomAcoustics';
import { DESIGNS, type DesignSettings, type Role } from './designs';
import type { DspOverride, LayoutId } from './system';
import type { Compass } from './roomShape';
import { LIVING_ROOM, toAppFrame } from './roomShape';
import { DEFAULT_OUTDOOR, type OutdoorConfig } from './outdoor';
import { DEFAULT_PRINTER, HYBRID_PRESETS, PRINTED_DESIGNS, type HybridParams, type Printer } from './hybrid';
import { setCustomDriverSource, type DriverInfo } from './drivers';
import { sanitizeModelerAlt, type ModelPin } from './boxModel';
import type { Measurement } from './measurements';
import type { OverlaySel } from './measOverlay';

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
    /** printed living-room designs (a tweakable copy of each catalogue entry), by id */
    designs: Record<string, HybridParams>;
    /** which printed design is the living-room mains when useLiving is on */
    livingId: string;
    printer: Printer;
    useOutdoor: boolean;
    useLiving: boolean;
    /** printed horn sub ('sub', 'th-sub' …) used as the living-room subwoofer; null = a generic sealed sub */
    roomSubId: string | null;
  };
  /** printed design shown in the Speakers and Build tabs ('sub' or a PRINTED_DESIGNS id); null = the plywood activeDesign */
  activePrint: string | null;
  stepsDone: Record<string, boolean>;
  roomName: string;
  /** drivers the user typed in from a datasheet */
  customDrivers: DriverInfo[];
  /** designs pinned in the box modeler for side-by-side comparison */
  modelerPins: ModelPin[];
  /** named saves of designs (plywood settings or printed params) */
  savedDesigns: SavedDesign[];
  /** imported frequency-response / impedance measurements (REW, .frd, .zma) */
  measurements: Measurement[];
  /** imported measurement overlaid on each predicted-response chart (default off), and the room-EQ toggle */
  measOverlay: MeasOverlayState;
}

export interface MeasOverlayState {
  box: OverlaySel;
  boxZ: OverlaySel;
  printed: OverlaySel;
  printedZ: OverlaySel;
  room: OverlaySel;
  /** show the suggested room-mode EQ on the seat chart */
  roomEq: boolean;
}

export function freshOverlays(): MeasOverlayState {
  const off = () => ({ on: false, id: null });
  return { box: off(), boxZ: off(), printed: off(), printedZ: off(), room: off(), roomEq: false };
}

export interface SavedDesign {
  id: string;
  name: string;
  savedAt: string;
  kind: 'plywood' | 'printed';
  /** the catalogue design it was based on (plywood id, or a printed id / 'sub') */
  baseId: string;
  settings?: DesignSettings;
  params?: HybridParams;
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

export function freshPrinted(): Record<string, HybridParams> {
  return Object.fromEntries(PRINTED_DESIGNS.map((d) => [d.id, structuredClone(d.params)]));
}

/** The printed design the living-room mains use (when home.hybrid.useLiving). */
export function livingPrinted(): HybridParams {
  return home.hybrid.designs[home.hybrid.livingId] ?? home.hybrid.designs[PRINTED_DESIGNS[0].id];
}

/** Params of a printed design by id ('sub' = the horn sub). */
export function printedParams(id: string): HybridParams {
  return id === 'sub' ? home.hybrid.sub : home.hybrid.designs[id] ?? livingPrinted();
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
    activePrint: null,
    hybrid: {
      sub: { ...HYBRID_PRESETS.sub },
      designs: freshPrinted(),
      livingId: 'mon-sealed',
      printer: { ...DEFAULT_PRINTER },
      useOutdoor: false,
      useLiving: false,
      roomSubId: null,
    },
    stepsDone: {},
    customDrivers: [],
    modelerPins: [],
    savedDesigns: [],
    measurements: [],
    measOverlay: freshOverlays(),
  };
}

/** Keep each design's stored box-modeler (PR / bandpass) choices only if they're well-formed. */
export function withModeler(designs: Record<string, DesignSettings>): Record<string, DesignSettings> {
  for (const [id, ds] of Object.entries(designs)) {
    if (!ds || typeof ds !== 'object' || !('modeler' in ds)) continue;
    const m = sanitizeModelerAlt(ds.modeler);
    const { modeler: _drop, ...rest } = ds;
    designs[id] = m ? { ...rest, modeler: m } : rest;
  }
  return designs;
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
      designs: withModeler({ ...d.designs, ...(s.designs ?? {}) }),
      system: { ...d.system, ...(s.system ?? {}), roles: { ...d.system.roles, ...(s.system?.roles ?? {}) }, dsp: { ...(s.system?.dsp ?? {}) } },
      furniture: { ...d.furniture, ...(s.furniture ?? {}) },
      hybrid: {
        ...d.hybrid,
        ...(s.hybrid ?? {}),
        sub: { ...d.hybrid.sub, ...(s.hybrid?.sub ?? {}) },
        // older saves had one printed living-room design: it becomes the line tower
        designs: Object.fromEntries(
          Object.entries(d.hybrid.designs).map(([id, def]) => {
            const saved = s.hybrid?.designs?.[id] ?? (id === 'line' ? s.hybrid?.living : undefined);
            return [id, { ...def, ...(saved ?? {}) }];
          })
        ),
        livingId: s.hybrid?.livingId ?? (s.hybrid?.living ? 'line' : d.hybrid.livingId),
        printer: { ...d.hybrid.printer, ...(s.hybrid?.printer ?? {}) },
        roomSubId: typeof s.hybrid?.roomSubId === 'string' ? s.hybrid.roomSubId : null,
      },
      outdoor: { ...d.outdoor, ...(s.outdoor ?? {}), towerDelayOverride: { ...(s.outdoor?.towerDelayOverride ?? {}) } },
      stepsDone: { ...(s.stepsDone ?? {}) },
      activePrint: typeof s.activePrint === 'string' ? s.activePrint : null,
      customDrivers: Array.isArray(s.customDrivers) ? s.customDrivers : [],
      modelerPins: Array.isArray(s.modelerPins) ? s.modelerPins : [],
      savedDesigns: Array.isArray(s.savedDesigns) ? s.savedDesigns : [],
      measurements: Array.isArray(s.measurements) ? s.measurements.filter((m: Measurement) => m && Array.isArray(m.points)) : [],
      measOverlay: loadOverlays(s.measOverlay),
    };
  } catch {
    return d;
  }
}

function loadOverlays(raw: unknown): MeasOverlayState {
  const d = freshOverlays();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const sel = (v: unknown): OverlaySel => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { on: o.on === true, id: typeof o.id === 'string' ? o.id : null };
  };
  return { box: sel(r.box), boxZ: sel(r.boxZ), printed: sel(r.printed), printedZ: sel(r.printedZ), room: sel(r.room), roomEq: r.roomEq === true };
}

export const home = $state<HomeState>(load());
setCustomDriverSource(() => home.customDrivers);

// The state this window last wrote or adopted. Saving the same thing again is a
// no-op, so adopting another window's state never echoes back to it — even when
// the two normalise it slightly differently (e.g. an older build in a stale tab),
// which would otherwise ping-pong between the windows forever.
let lastSynced = '';

export function saveHome() {
  const json = JSON.stringify(home);
  if (json === lastSynced) return;
  lastSynced = json;
  try {
    localStorage.setItem(KEY, json);
  } catch {
    /* private mode etc. */
  }
}

// Keep several open browser windows in step: another window saved → adopt its
// edits here, so a stale window can't overwrite newer edits on its next save.
// Which design each window is *looking at* stays per-window, so two windows
// showing different speakers don't keep switching each other.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue || e.newValue === lastSynced) return;
    const view = { activeDesign: home.activeDesign, activePrint: home.activePrint };
    const next = load(e.newValue);
    if (!(view.activeDesign in next.designs)) view.activeDesign = next.activeDesign;
    Object.assign(home, next, view);
    lastSynced = JSON.stringify(home);
  });
}

export function resetHome() {
  Object.assign(home, defaultState());
  saveHome();
}
