<script lang="ts">
  import MiniChart, { type MiniSeries } from './MiniChart.svelte';
  import Room3D, { type SpeakerLook } from './Room3D.svelte';
  import VenueSwitch from './VenueSwitch.svelte';
  import {
    LAYOUTS,
    ARRIVAL_LEGEND,
    arrivalColor,
    arrivalMap,
    coverageMap,
    imageMap,
    interferenceField,
    layoutSpeakers,
    alignToSeat,
    bestSubDelay,
    crossoverSumDb,
    type LayoutId,
    type SystemSpeaker,
  } from './system';
  import { cellsCanvas, fieldCanvas } from './mapImage';
  import { inZone, livingLayout } from './furniture';
  import { onDestroy } from 'svelte';
  import { ROOM_SHAPES, avoidOpenings, toAppFrame, type Compass } from './roomShape';
  import { designById, type Role } from './designs';
  import { planFor } from './planning';
  import { cabinetDims } from './hybridModels';
  import { home, saveHome, ROOM_PRESETS } from './homeState.svelte';
  import {
    FT,
    type BoxAlignment,
    type Complex,
    type ModalSource,
    type RoomConfig,
    type PlacementConfig,
    type Vec3,
    bandStdDb,
    boxResponse,
    buildModalEngine,
    cmul,
    cscale,
    dist,
    firstReflections,
    fmtFtIn,
    fmtFtInFrac,
    parseLength,
    listenerPosition,
    logFreqs,
    lr4,
    roomModes,
    sbirNotchHz,
    schroederHz,
    speakerPositions,
    stereoAngleDeg,
    subPositions,
    toDb,
    toeInDeg,
  } from './roomAcoustics';

  let { alignment, speakerLabel, onGoSpeaker, onOpenDesign, speakerMm, tweeterFromTopMm }: {
    alignment: BoxAlignment;
    speakerLabel: string;
    onGoSpeaker: () => void;
    onOpenDesign: (id: string) => void;
    speakerMm: { w: number; h: number; d: number };
    tweeterFromTopMm: number;
  } = $props();

  // ---- room shape & system layout -----------------------------------------
  const shape = $derived(home.shapeId && ROOM_SHAPES[home.shapeId] ? toAppFrame(ROOM_SHAPES[home.shapeId], home.frontWall) : null);
  function setFront(c: Compass) {
    if (!home.shapeId) return;
    const app = toAppFrame(ROOM_SHAPES[home.shapeId], c);
    home.frontWall = c;
    home.room.widthM = app.widthM;
    home.room.depthM = app.depthM;
  }
  const layout = $derived(LAYOUTS.find((l) => l.id === home.system.layout) ?? LAYOUTS[0]);
  function selectLayout(id: LayoutId) {
    const l = LAYOUTS.find((x) => x.id === id)!;
    home.system.layout = id;
    home.sub = { ...l.subs };
  }
  const speakers = $derived<SystemSpeaker[]>(
    alignToSeat(
      layoutSpeakers(home.system.layout, home.room, home.placement, home.sub, {
        delayMs: home.system.fillDelayMs,
        gainDb: home.system.fillGainDb,
      }).map((s) => {
        const moved = s.mount === 'wall' || s.mount === 'floor' ? { ...s, pos: { ...s.pos, ...avoidOpenings(s.pos, shape) } } : s;
        const tallMains = home.designs[home.system.roles.mains]?.arrangement === 'tower' || (home.hybrid.useLiving && home.hybrid.living.heightMm > 700);
        return s.role === 'mains' && tallMains ? { ...moved, mount: 'floor' as const } : moved;
      }),
      listenerPosition(home.room, home.placement),
      { auto: home.system.autoAlign, dsp: home.system.dsp, fillDelayMs: home.system.fillDelayMs }
    )
  );
  const ROLES: Role[] = ['mains', 'center', 'surround', 'height', 'fill', 'sub'];
  const ROLE_LABEL: Record<Role, string> = { mains: 'Mains', center: 'Centre', surround: 'Surround', height: 'Ceiling', fill: 'Party fill', sub: 'Sub' };
  const looks = $derived.by(() => {
    const out = {} as Record<Role, SpeakerLook>;
    const ear = Math.round(home.placement.earHeightM * 1000);
    for (const r of ROLES) {
      const st = home.designs[home.system.roles[r]];
      if (!st) continue;
      const { plan } = planFor(st, ear);
      out[r] = {
        ...plan.box.externalMm,
        tweeterFromTopMm: plan.holes.find((h) => h.kind === 'tweeter')?.yMm ?? plan.box.externalMm.h / 2,
        isTower: st.arrangement === 'tower',
      };
    }
    if (home.hybrid.useLiving) {
      const hd = cabinetDims(home.hybrid.living);
      out.mains = { w: hd.w, h: hd.h, d: hd.d, tweeterFromTopMm: 90, isTower: hd.h > 700 };
    }
    return out;
  });
  function pickSpeaker(id: string | null) {
    const s = speakers.find((x) => x.id === id);
    if (s) onOpenDesign(home.system.roles[s.role]);
  }
  // persist
  $effect(() => {
    JSON.stringify(home.system) + home.frontWall + home.shapeId + home.mapMode;
    saveHome();
  });
  let view = $state<'3d' | 'plan'>('3d');

  const room = $derived(home.room);
  const pl = $derived(home.placement);
  const sub = $derived(home.sub);

  // ---- persistence -------------------------------------------------------
  $effect(() => {
    JSON.stringify(home.room) + JSON.stringify(home.placement) + JSON.stringify(home.sub);
    saveHome();
  });

  // keep placement inside the room
  $effect(() => {
    const maxSpacing = home.room.widthM - 0.5;
    if (home.placement.speakerSpacingM > maxSpacing) home.placement.speakerSpacingM = Math.max(0.8, maxSpacing);
    const maxL = home.room.depthM - 0.3;
    if (home.placement.listenerDistM > maxL) home.placement.listenerDistM = maxL;
  });

  // ---- sources -------------------------------------------------------------
  const BAND: [number, number] = [30, 150];
  const freqs = logFreqs(18, 220, 72);

  function makeSources(r: RoomConfig, p: PlacementConfig): ModalSource[] {
    const { L, R } = speakerPositions(r, p);
    const subs = subPositions(r, home.sub).map((p) => ({ ...p, ...avoidOpenings(p, shape) }));
    const fc = home.sub.crossoverHz;
    const al = alignment;
    // each speaker's DSP: delay e^{−jωτ}, level and polarity
    const dsp = (id: string) => {
      const sp = speakers.find((x) => x.id === id);
      const tau = (sp?.delayMs ?? 0) / 1000;
      const g = (sp?.invert ? -1 : 1) * 10 ** ((sp?.gainDb ?? 0) / 20);
      return (f: number, h: Complex): Complex => cmul(h, { re: g * Math.cos(-2 * Math.PI * f * tau), im: g * Math.sin(-2 * Math.PI * f * tau) });
    };
    const mainDrive = (id: string) => {
      const d = dsp(id);
      return (f: number): Complex => {
        let h = boxResponse(al, f);
        if (subs.length) h = cmul(h, lr4(f, fc, 'hp'));
        return d(f, h);
      };
    };
    const srcs: ModalSource[] = [
      { pos: L, drive: mainDrive('L') },
      { pos: R, drive: mainDrive('R') },
    ];
    if (subs.length) {
      const subAl: BoxAlignment = { kind: 'sealed', fcHz: 24, qtc: 0.7 };
      const g = 2 / subs.length; // same total bass output as the two mains
      subs.forEach((s, i) => {
        const d = dsp(`S${i + 1}`);
        srcs.push({ pos: s, drive: (f) => d(f, cscale(cmul(boxResponse(subAl, f), lr4(f, fc, 'lp')), g)) });
      });
    }
    return srcs;
  }

  function seatResponse(r: RoomConfig, p: PlacementConfig) {
    const eng = buildModalEngine(r, makeSources(r, p), freqs, 1);
    // normalise to the free-field level of the pair at the seat
    const ear = listenerPosition(r, p);
    const { L } = speakerPositions(r, p);
    const ref = 20 * Math.log10(2 / Math.max(dist(L, ear), 0.3));
    return { eng, resp: eng.responseAt(ear).map((c) => toDb(c) - ref) };
  }

  const seat = $derived(seatResponse(room, pl));
  const anechoic = $derived(
    freqs.map((f) => ({ x: f, y: toDb(boxResponse(alignment, f)) }))
  );
  const fSch = $derived(schroederHz(room));
  const smoothness = $derived(
    bandStdDb(freqs, seat.resp.map((db) => ({ re: Math.pow(10, db / 20), im: 0 })), BAND[0], BAND[1])
  );

  // heat-map of bass evenness at ear height (debounced; it is the expensive bit)
  const GRID = 0.25;
  let heat = $state<{ x: number; y: number; std: number }[]>([]);
  let heatBusy = $state(false);
  let heatTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const eng = seat.eng;
    const r = { ...room };
    const z = mapZ;
    heatBusy = true;
    if (heatTimer) clearTimeout(heatTimer);
    heatTimer = setTimeout(() => {
      const out: { x: number; y: number; std: number }[] = [];
      const bandIdx = freqs.map((f, i) => [f, i] as const).filter(([f]) => f >= BAND[0] && f <= BAND[1]).map(([, i]) => i);
      for (let y = GRID / 2; y < r.depthM; y += GRID) {
        for (let x = GRID / 2; x < r.widthM; x += GRID) {
          const resp = eng.responseAt({ x, y, z });
          const vals = bandIdx.map((i) => toDb(resp[i]));
          const m = vals.reduce((a, b) => a + b, 0) / vals.length;
          const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
          out.push({ x, y, std: sd });
        }
      }
      heat = out;
      heatBusy = false;
    }, 220);
  });

  // ---- optimiser: speaker distance from wall × seat distance ---------------
  let optBusy = $state(false);
  let optMsg = $state('');
  function optimise() {
    optBusy = true;
    optMsg = '';
    setTimeout(() => {
      const r = { ...room };
      const base = { ...pl };
      const f2 = logFreqs(BAND[0], BAND[1], 36);
      let best = { score: Infinity, front: base.speakerFrontDistM, seat: base.listenerDistM, spacing: base.speakerSpacingM, std: 0 };
      const maxSpacing = Math.min(r.widthM - 0.6, 3.2);
      for (let front = 0.25; front <= Math.min(1.4, r.depthM * 0.3); front += 0.075) {
        for (let spacing = 1.4; spacing <= maxSpacing + 1e-6; spacing += 0.3) {
          const p0 = { ...base, speakerFrontDistM: front, speakerSpacingM: spacing };
          const eng = buildModalEngine(r, makeSources(r, p0), f2, 1);
          for (let seatY = front + 1.2; seatY <= r.depthM - 0.5; seatY += 0.05) {
            const p = { ...p0, listenerDistM: seatY };
            const resp = eng.responseAt(listenerPosition(r, p));
            const std = bandStdDb(f2, resp, BAND[0], BAND[1]);
            const angle = stereoAngleDeg(p);
            // ±10° around 60° is free; outside that, penalise; prefer not sitting against the back wall
            const anglePen = Math.max(0, Math.abs(angle - 60) - 6) * 0.35;
            const backPen = Math.max(0, 1.0 - (r.depthM - seatY)) * 1.5;
            const score = std + anglePen + backPen;
            if (score < best.score) best = { score, front, seat: seatY, spacing, std };
          }
        }
      }
      const before = smoothness;
      home.placement.speakerFrontDistM = Math.round(best.front * 100) / 100;
      home.placement.speakerSpacingM = Math.round(best.spacing * 100) / 100;
      home.placement.listenerDistM = Math.round(best.seat * 100) / 100;
      optMsg = `Bass unevenness ${before.toFixed(1)} → ${best.std.toFixed(1)} dB (30–150 Hz std. dev.). Speakers ${fmtFtIn(best.front)} from the front wall, ${fmtFtIn(best.spacing)} apart; seat ${fmtFtIn(best.seat)} from the front wall.`;
      optBusy = false;
    }, 30);
  }

  // ---- derived insights ----------------------------------------------------
  const modes = $derived(roomModes(room, 160));
  const axial = $derived(modes.filter((m) => m.kind === 'axial').slice(0, 9));
  const angle = $derived(stereoAngleDeg(pl));
  const toe = $derived(toeInDeg(pl));
  const reflections = $derived(firstReflections(room, pl));
  const sideRefl = $derived(
    reflections.filter(
      (r) => (r.surface === 'left wall' && r.speaker === 'L') || (r.surface === 'right wall' && r.speaker === 'R')
    )
  );
  const farSideRefl = $derived(
    reflections.filter(
      (r) => (r.surface === 'left wall' && r.speaker === 'R') || (r.surface === 'right wall' && r.speaker === 'L')
    )
  );
  const ceilRefl = $derived(reflections.filter((r) => r.surface === 'ceiling'));
  const sideGap = $derived((room.widthM - pl.speakerSpacingM) / 2);

  type Note = { cls: 'good' | 'warn' | 'bad' | ''; html: string };
  const insights = $derived.by(() => {
    const out: Note[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) < 0.06;
    if (near(room.widthM, room.depthM))
      out.push({
        cls: 'bad',
        html: `<b>Almost square room</b> (${fmtFtIn(room.widthM)} × ${fmtFtIn(room.depthM)}). Side-to-side and front-to-back resonances land on the same notes (${(343.2 / (2 * room.widthM)).toFixed(0)} Hz, ${(343.2 / room.widthM).toFixed(0)} Hz…) and stack up. Keep the seat off the exact centre, and expect a subwoofer + EQ to be part of the plan.`,
      });
    const fz = 343.2 / (2 * room.heightM);
    const fxy = 343.2 * Math.sqrt(1 / room.widthM ** 2 + 1 / room.depthM ** 2) / 2;
    if (near(fz, fxy) || near(2 * room.heightM, room.widthM) || near(2 * room.heightM, room.depthM))
      out.push({
        cls: 'warn',
        html: `The floor-to-ceiling resonance (${fz.toFixed(0)} Hz) lands on top of a floor-plan resonance (${fxy.toFixed(0)} Hz), so that note stacks up too.`,
      });
    const seatFrac = pl.listenerDistM / room.depthM;
    const f1 = 343.2 / (2 * room.depthM);
    if (Math.abs(seatFrac - 0.5) < 0.06 && f1 < 30)
      out.push({
        cls: '',
        html: `Seat near mid-room (${(seatFrac * 100).toFixed(0)} %). That nulls the first front-to-back mode, but in this long room it sits at ${f1.toFixed(0)} Hz — below nearly all music, so it costs little and also removes the 3rd mode (${(3 * f1).toFixed(0)} Hz) boom.`,
      });
    else if (Math.abs(seatFrac - 0.5) < 0.06)
      out.push({
        cls: 'bad',
        html: `<b>Seat is at the middle of the room (${(seatFrac * 100).toFixed(0)} %).</b> That is the null of the first front-to-back mode (${(343.2 / (2 * room.depthM)).toFixed(0)} Hz) — bass there goes missing. Move the seat forward or back by ~10 % of the room.`,
      });
    else if (pl.listenerDistM > room.depthM - 0.6)
      out.push({
        cls: 'warn',
        html: `<b>Head is ${fmtFtIn(room.depthM - pl.listenerDistM)} from the back wall.</b> Close to a wall every mode is at maximum: bass gets loud and boomy. Over ~3 ft away is better, or treat the back wall.`,
      });
    else out.push({ cls: 'good', html: `Seat at ${(seatFrac * 100).toFixed(0)} % of the room depth — clear of the half-way bass null.` });

    if (Math.abs(angle - 60) <= 8)
      out.push({ cls: 'good', html: `Stereo angle ${angle.toFixed(0)}° — close to the classic 60° equilateral triangle, which gives a stable phantom centre.` });
    else if (angle < 52)
      out.push({ cls: 'warn', html: `Stereo angle ${angle.toFixed(0)}° — narrow. Move the seat forward or the speakers apart for a wider stage.` });
    else out.push({ cls: 'warn', html: `Stereo angle ${angle.toFixed(0)}° — wide; the centre image may thin out ("hole in the middle").` });

    const nFront = sbirNotchHz(pl.speakerFrontDistM);
    if (pl.speakerFrontDistM < 0.35)
      out.push({ cls: 'good', html: `Speakers close to the wall: front-wall cancellation pushed up to ~${nFront.toFixed(0)} Hz where the speaker is starting to beam forward. Expect extra bass (reduce the baffle-step boost).` });
    else
      out.push({
        cls: nFront > 60 && nFront < 200 ? 'warn' : '',
        html: `Front-wall bounce (SBIR) cancels around <b>${nFront.toFixed(0)} Hz</b> (¼-wavelength at ${fmtFtIn(pl.speakerFrontDistM)}). Either push the speakers almost against the wall, pull them far out, or let subwoofers cover that range.`,
      });
    const nSide = sbirNotchHz(sideGap);
    out.push({
      cls: '',
      html: `Side-wall bounce notch near ${nSide.toFixed(0)} Hz (speakers ${fmtFtIn(sideGap)} from the side walls). Avoid equal distances to the front and side walls — the notches stack up.`,
    });
    if (Math.abs(sideGap - pl.speakerFrontDistM) < 0.12)
      out.push({ cls: 'warn', html: `Distance to side wall ≈ distance to front wall: the two cancellations land on the same frequency. Change one by 30 cm+.` });

    out.push({
      cls: '',
      html: `Toe-in each speaker <b>${toe.toFixed(0)}°</b> so the axes cross ${pl.toeCrossAheadM > 0 ? fmtFtIn(pl.toeCrossAheadM) + ' in front of your head (a slightly wider sweet spot)' : 'at your head (sharpest image)'}.`,
    });
    if (smoothness < 3) out.push({ cls: 'good', html: `Predicted bass at the seat is quite even (±${smoothness.toFixed(1)} dB).` });
    else if (smoothness > 5)
      out.push({
        cls: 'warn',
        html: `Bass at the seat varies a lot (±${smoothness.toFixed(1)} dB). Try “Find best spot”, or add two subwoofers — opposite-wall subs cancel the odd room modes and make bass even over a whole sofa.`,
      });
    return out;
  });

  // ---- chart ---------------------------------------------------------------
  const chartSeries = $derived.by((): MiniSeries[] => {
    const s: MiniSeries[] = [
      { label: `${speakerLabel} in this room, at your seat`, color: '#38bdf8', points: freqs.map((f, i) => ({ x: f, y: seat.resp[i] })), width: 2.4 },
      { label: 'Same speaker, no room (anechoic)', color: '#94a3b8', points: anechoic, dashed: true, width: 1.5 },
    ];
    return s;
  });

  // ---- plan view -----------------------------------------------------------
  const PAD = 0.7; // m of margin around the room in the drawing
  const sc = 100; // svg units per metre
  const vb = $derived(`${-PAD * sc} ${-PAD * sc} ${(room.widthM + 2 * PAD) * sc} ${(room.depthM + 2 * PAD) * sc}`);
  // colour relative to this room: every seat in a real room has some unevenness,
  // what matters is where it is *least* bad
  const heatRange = $derived.by(() => {
    if (!heat.length) return { lo: 2, hi: 6 };
    const v = heat.map((h) => h.std).sort((a, b) => a - b);
    return { lo: v[Math.floor(v.length * 0.05)], hi: v[Math.floor(v.length * 0.95)] };
  });
  // ---- map modes ------------------------------------------------------------
  const mapZ = $derived(home.mapEar === 'standing' ? 1.6 : home.placement.earHeightM);
  // per-zone scores from whatever maps are available
  const zoneStats = $derived.by(() =>
    layoutF.zones.map((z) => {
      const hz = heat.filter((h) => inZone(z, h.x, h.y));
      const cz = coverage.cells.filter((c) => inZone(z, c.x, c.y));
      const iz = image.cells.filter((c) => inZone(z, c.x, c.y));
      const az = arrival?.hasFills ? arrival.cells.filter((c) => inZone(z, c.x, c.y)) : [];
      const mean = (a: number[]) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN);
      return {
        z,
        bass: mean(hz.map((h) => h.std)),
        level: mean(cz.map((c) => c.db)) - coverage.max,
        spread: cz.length ? Math.max(...cz.map((c) => c.db)) - Math.min(...cz.map((c) => c.db)) : NaN,
        image: iz.length ? iz.filter((c) => c.ms < 0.6).length / iz.length : NaN,
        arrival: az.length ? az.filter((c) => c.cls === 'blend' || c.cls === 'mainsOnly').length / az.length : NaN,
      };
    })
  );
  const layoutF = $derived(livingLayout(home.room, home.furniture.layout, home.furniture.chaiseSide, home.placement.listenerDistM));
  const coverage = $derived(coverageMap(home.room, speakers, mapZ, GRID));
  const image = $derived(imageMap(home.room, home.placement, mapZ, GRID));
  function covColor(db: number) {
    const t = Math.min(Math.max((coverage.max - db) / 10, 0), 1); // 0 dB below max → green, 10 dB → red
    return `hsl(${140 - 140 * t} 70% 45%)`;
  }
  function imgColor(ms: number) {
    const t = Math.min(ms / 1.2, 1);
    return `hsl(${140 - 140 * t} 70% 45%)`;
  }
  // timing & interference
  const fills = $derived(speakers.filter((s) => s.role === 'fill'));
  const autoFillDelay = $derived(fills[0]?.autoDelayMs ?? 0);
  const fillDelayNow = $derived(fills[0]?.delayMs ?? 0);
  const arrival = $derived(speakers.some((x) => x.role === 'fill') ? arrivalMap(home.room, speakers, mapZ, 0.1) : null);
  let iFreq = $state(500);
  const seatPos = $derived(listenerPosition(home.room, home.placement));
  const wallR = $derived.by(() => {
    const { widthM: W, depthM: D, heightM: H, rt60S } = home.room;
    return Math.sqrt(1 - Math.min(0.95, (0.161 * W * D * H) / (2 * (W * D + W * H + D * H) * Math.max(rt60S, 0.1))));
  });
  const xSum = $derived(crossoverSumDb(speakers, seatPos, home.sub.crossoverHz));
  const hasDsp = (id: string) => Object.keys(home.system.dsp[id] ?? {}).length > 0;
  function setDsp(id: string, patch: { delayMs?: number; gainDb?: number; invert?: boolean }) {
    home.system.dsp = { ...home.system.dsp, [id]: { ...(home.system.dsp[id] ?? {}), ...patch } };
  }
  let subMsg = $state('');
  function resetDsp(id: string) {
    const { [id]: _drop, ...rest } = home.system.dsp;
    void _drop;
    home.system.dsp = rest;
    subMsg = '';
  }
  const f1 = (v: number | undefined) => (Math.abs(v ?? 0) < 0.05 ? 0 : (v as number)).toFixed(1);
  function numIn(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    return Number.isFinite(v) ? v : 0;
  }
  function alignSub() {
    const b = bestSubDelay(speakers, seatPos, home.sub.crossoverHz);
    for (const sp of speakers.filter((x) => x.role === 'sub')) setDsp(sp.id, { delayMs: Math.round(b.delayMs * 10) / 10, invert: b.invert });
    subMsg = `Subs: ${b.delayMs.toFixed(1)} ms${b.invert ? ', polarity flipped' : ''} — within ${Math.abs(b.sumDb).toFixed(1)} dB of a perfect sum at the seat.`;
  }
  let iView = $state<'level' | 'wave'>('level');
  let animating = $state(false);
  const field = $derived(
    home.mapMode === 'interference'
      ? interferenceField(home.room, speakers, mapZ, iFreq, home.sub.crossoverHz, {
          walls: home.system.walls,
          maxCells: [70000, 40000, 16000][home.system.walls],
        })
      : null
  );
  const mapCanvas = $derived.by(() => {
    const W = home.room.widthM;
    const D = home.room.depthM;
    if (home.mapMode === 'interference' && field) return fieldCanvas(field, iView, 0, document.createElement('canvas'));
    if (home.mapMode === 'arrival')
      return arrival && arrival.hasFills ? cellsCanvas(arrival.cells, arrival.grid, W, D, arrivalColor) : null;
    if (home.mapMode === 'coverage') return cellsCanvas(coverage.cells.map((c) => ({ x: c.x, y: c.y, v: c.db })), GRID, W, D, covColor);
    if (home.mapMode === 'image') return cellsCanvas(image.cells.map((c) => ({ x: c.x, y: c.y, v: c.ms })), GRID, W, D, imgColor);
    return heat.length ? cellsCanvas(heat.map((h) => ({ x: h.x, y: h.y, v: h.std })), GRID, W, D, heatColor) : null;
  });
  let mapVersion = $state(0);
  let mapUrl = $state('');
  $effect(() => {
    mapUrl = mapCanvas ? mapCanvas.toDataURL() : '';
  });
  // animated wave (interference)
  let raf = 0;
  $effect(() => {
    if (!animating || !field || !mapCanvas) return;
    const f = field;
    const cv = mapCanvas;
    const t0 = performance.now();
    let frame = 0;
    const loop = () => {
      const phase = (((performance.now() - t0) / 1600) % 1) * Math.PI * 2;
      fieldCanvas(f, 'wave', -phase, cv);
      mapVersion++;
      if (view === 'plan' && frame++ % 2 === 0) mapUrl = cv.toDataURL();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
  // wavefront playback (arrival): time since the music "starts", in ms
  let tWave = $state(0);
  let playingWaves = $state(false);
  let wraf = 0;
  function playWaves() {
    view = 'plan';
    playingWaves = true;
    tWave = 0;
    const t0 = performance.now();
    const loop = () => {
      tWave = (performance.now() - t0) / 60; // 60× slow motion
      if (tWave < 45 && playingWaves) wraf = requestAnimationFrame(loop);
      else playingWaves = false;
    };
    wraf = requestAnimationFrame(loop);
  }
  onDestroy(() => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(wraf);
  });
  const ROLE_COLOR: Record<string, string> = { mains: '#38bdf8', center: '#38bdf8', fill: '#fb923c', surround: '#a78bfa', height: '#c4b5fd', sub: '#a78bfa' };
  const FREQ_PRESETS = [60, 120, 250, 500, 1000, 2000, 4000];
  function heatColor(std: number) {
    const { lo, hi } = heatRange;
    const t = Math.min(Math.max((std - lo) / Math.max(hi - lo, 0.5), 0), 1);
    const hue = 140 - 140 * t;
    return `hsl(${hue} 70% 45%)`;
  }
  const spk = $derived(speakerPositions(room, pl));
  const ear = $derived(listenerPosition(room, pl));
  const subsPos = $derived(subPositions(room, sub).map((p) => ({ ...p, ...avoidOpenings(p, shape) })));
  function spkRect(p: Vec3, side: 'L' | 'R') {
    const w = (speakerMm.w / 1000) * sc;
    const d = (speakerMm.d / 1000) * sc;
    const rot = side === 'L' ? -toe : toe;
    return { x: p.x * sc, y: p.y * sc, w, d, rot };
  }

  const INCH = 0.0254;
  let badInput = $state<string | null>(null);
  function stepIn(key: 'widthM' | 'depthM' | 'heightM', dIn: number) {
    const v = Math.round(home.room[key] / INCH + dIn);
    home.room[key] = Math.max(72, Math.min(720, v)) * INCH;
    home.roomName = 'Custom room';
    home.shapeId = null;
  }
  function setLen(key: 'widthM' | 'depthM' | 'heightM', el: HTMLInputElement) {
    const v = parseLength(el.value);
    if (v !== null && v >= 1.8 && v <= 20) {
      home.room[key] = v;
      home.roomName = 'Custom room';
      home.shapeId = null;
      badInput = null;
    } else {
      badInput = key;
    }
    el.value = fmtFtInFrac(home.room[key]);
  }
  function preset(w: number, d: number) {
    home.room.widthM = w * FT;
    home.room.depthM = d * FT;
    home.roomName = `${w}×${d} ft room`;
    home.shapeId = null;
  }
  function applyPreset(i: number) {
    const r = ROOM_PRESETS[i];
    home.room.widthM = r.widthM;
    home.room.depthM = r.depthM;
    home.room.heightM = r.heightM;
    home.roomName = r.name;
    home.shapeId = r.shapeId;
    setFront(home.frontWall);
  }
  function swapOrientation() {
    const w = home.room.widthM;
    home.room.widthM = home.room.depthM;
    home.room.depthM = w;
  }
  function equilateral() {
    home.placement.listenerDistM =
      Math.round((home.placement.speakerFrontDistM + home.placement.speakerSpacingM * 0.866 + 0.1) * 100) / 100;
  }
</script>

<div class="split">
<div class="vis">
<section class="card vis-card">
  <VenueSwitch />
  <div class="vis-hd">
    <h2>{home.roomName} · {layout.channels}</h2>
    <div class="seg">
      <button class:on={view === '3d'} onclick={() => (view = '3d')}>3D room</button>
      <button class:on={view === 'plan'} onclick={() => (view = 'plan')}>Top view</button>
    </div>
  </div>
  <div class="seg maps" role="group" aria-label="Map shown on the floor">
    <button class:on={home.mapMode === 'bass'} onclick={() => (home.mapMode = 'bass')}>Bass evenness</button>
    <button class:on={home.mapMode === 'coverage'} onclick={() => (home.mapMode = 'coverage')}>Loudness coverage</button>
    <button class:on={home.mapMode === 'image'} onclick={() => (home.mapMode = 'image')}>Stereo image</button>
    <button class:on={home.mapMode === 'arrival'} onclick={() => (home.mapMode = 'arrival')}>Arrival & delay</button>
    <button class:on={home.mapMode === 'interference'} onclick={() => (home.mapMode = 'interference')}>Interference</button>
  </div>
  <div class="seg maps" role="group" aria-label="Ear height for the maps">
    <button class:on={home.mapEar === 'seated'} onclick={() => (home.mapEar = 'seated')}>Seated ears ({fmtFtIn(home.placement.earHeightM)})</button>
    <button class:on={home.mapEar === 'standing'} onclick={() => (home.mapEar = 'standing')}>Standing / dancing (5′ 3″)</button>
  </div>
  <p class="sub maplegend">
    {#if home.mapMode === 'bass'}
      How even the bass (30–150 Hz) is at ear height, relative to the rest of this room:
      <span class="g">green ±{heatRange.lo.toFixed(1)} dB</span> → <span class="r">red ±{heatRange.hi.toFixed(1)} dB</span>. Your seat ±{smoothness.toFixed(1)} dB.
    {:else if home.mapMode === 'coverage'}
      How loud the music is (1–4 kHz direct sound, all speakers but subs) compared with the loudest spot:
      <span class="g">green = within 2 dB</span> → <span class="r">red = 10 dB quieter</span>. Spread across the room: <b>{coverage.spreadDb.toFixed(1)} dB</b>.
    {:else if home.mapMode === 'image'}
      Difference in arrival time from the left and right speakers: <span class="g">green &lt; 0.3 ms</span> = centred
      stereo image; <span class="r">red &gt; 1 ms</span> = the sound collapses into the nearer speaker. Sweet spot along your
      row ≈ <b>{fmtFtIn(image.sweetWidthM)}</b> wide.
    {:else if home.mapMode === 'arrival'}
      {#if arrival?.hasFills}
        Which sound reaches each spot first, and whether the fills blend in (precedence / Haas effect). Sound still comes
        from the front over <b>{((arrival.goodFraction) * 100).toFixed(0)} %</b> of the room.
      {:else}
        This layout has no delayed fill speakers, so nothing can "pull" the sound away from the front. Press play to
        watch the wavefronts — with seat alignment on, every speaker's sound reaches the sweet spot at the same moment. For fills, try <button class="linklike" onclick={() => selectLayout('party')}>Guests / party</button>.
      {/if}
    {:else}
      A centre-panned sound (a voice, a kick drum) at <b>{iFreq >= 1000 ? (iFreq / 1000).toFixed(1) + ' kHz' : iFreq.toFixed(0) + ' Hz'}</b>
      played by every speaker at once, with their real distances, delays and levels. {iView === 'level' ? 'Yellow = waves add up, dark blue = they cancel.' : 'Red/blue = pressure pushing/pulling; watch the waves cross.'}
      Deep dips (&gt; 10 dB) cover <b>{((field?.deepDipFraction ?? 0) * 100).toFixed(0)} %</b> of the listening area.
      {home.system.walls === 0 ? 'Direct sound only — walls switched off.' : `Includes ${home.system.walls === 1 ? 'one bounce' : 'up to two bounces'} off the floor, ceiling and walls (treated as a flat box, ${Math.round((1 - wallR ** 2) * 100)} % absorbed per bounce from the RT60).`}
    {/if}
  </p>
  {#if home.mapMode === 'arrival' && arrival?.hasFills}
    <div class="ctl-panel">
      <div class="legend-chips">
        {#each Object.values(ARRIVAL_LEGEND) as l}<span><i style:background={l.color}></i>{l.label}</span>{/each}
      </div>
      <div class="field compact">
        <label for="fdelay">Fill delay</label>
        <span class="val">{fillDelayNow.toFixed(1)} ms {home.system.fillDelayMs === null ? '(auto)' : ''}</span>
        <input id="fdelay" type="range" min="0" max="60" step="0.5" value={fillDelayNow} oninput={(e) => (home.system.fillDelayMs = +(e.target as HTMLInputElement).value)} />
      </div>
      <div class="field compact">
        <label for="fgain">Fill level vs mains</label>
        <span class="val">{home.system.fillGainDb > 0 ? '+' : ''}{home.system.fillGainDb} dB</span>
        <input id="fgain" type="range" min="-15" max="3" step="1" bind:value={home.system.fillGainDb} />
      </div>
      <div class="opt-row">
        <button class="btn ghost" onclick={() => (home.system.fillDelayMs = null)} disabled={home.system.fillDelayMs === null}>Auto delay ({autoFillDelay.toFixed(1)} ms)</button>
        <button class="btn" onclick={playWaves} disabled={playingWaves}>▶ Play arrivals (slow-mo)</button>
      </div>
    </div>
  {:else if home.mapMode === 'interference'}
    <div class="ctl-panel">
      <div class="field compact">
        <label for="ifreq">Frequency</label>
        <span class="val">{iFreq >= 1000 ? (iFreq / 1000).toFixed(2) + ' kHz' : iFreq.toFixed(0) + ' Hz'} · λ = {fmtFtIn(343.2 / iFreq)}</span>
        <input id="ifreq" type="range" min="0" max="1" step="0.001" value={Math.log(iFreq / 40) / Math.log(100)} oninput={(e) => (iFreq = Math.round(40 * Math.pow(100, +(e.target as HTMLInputElement).value)))} />
      </div>
      <div class="chips">
        {#each FREQ_PRESETS as f}<button class="chip" class:on={iFreq === f} onclick={() => (iFreq = f)}>{f >= 1000 ? f / 1000 + 'k' : f}</button>{/each}
      </div>
      <div class="opt-row">
        <div class="seg">
          <button class:on={iView === 'level' && !animating} onclick={() => { iView = 'level'; animating = false; }}>Loudness</button>
          <button class:on={iView === 'wave' || animating} onclick={() => { iView = 'wave'; }}>Wave</button>
        </div>
        <button class="btn" onclick={() => { animating = !animating; if (animating) iView = 'wave'; }}>{animating ? '❚❚ Pause' : '▶ Animate waves'}</button>
      </div>
      <div class="opt-row">
        <span class="small muted">Walls</span>
        <div class="seg" role="group" aria-label="Wall reflections">
          <button class:on={home.system.walls === 0} onclick={() => (home.system.walls = 0)}>Off</button>
          <button class:on={home.system.walls === 1} onclick={() => (home.system.walls = 1)}>1st bounce</button>
          <button class:on={home.system.walls === 2} onclick={() => (home.system.walls = 2)}>2nd bounce</button>
        </div>
      </div>
    </div>
  {:else if home.mapMode === 'arrival'}
    <div class="ctl-panel">
      <div class="opt-row">
        <button class="btn" onclick={playWaves} disabled={playingWaves}>▶ Play arrivals (slow-mo)</button>
        <span class="small muted">Each ring leaves its speaker after that speaker's DSP delay — with seat alignment on they all reach the sweet spot together.</span>
      </div>
    </div>
  {/if}
  {#if view === '3d'}
    <div class="vis-3d">
      <Room3D
        {room}
        placement={pl}
        {shape}
        {speakers}
        {looks}
        {mapCanvas}
        {mapVersion}
        {reflections}
        showTv={speakers.some((s) => s.role === 'center')}
        furniture={layoutF.items}
        zones={layoutF.zones}
        onPick={pickSpeaker}
      />
    </div>
  {:else}
  <div class="svg-wrap plan-svg" class:busy={heatBusy}>
    <svg viewBox={vb} role="img" aria-label="Room plan view">
      {#if shape}
        <polygon points={shape.outline.map(([x, y]) => `${x * sc},${y * sc}`).join(' ')} fill="#0d1526" />
      {:else}
        <rect x="0" y="0" width={room.widthM * sc} height={room.depthM * sc} fill="#0d1526" />
      {/if}
      {#if mapUrl}
        <image href={mapUrl} x="0" y="0" width={room.widthM * sc} height={room.depthM * sc} preserveAspectRatio="none"
          opacity={home.mapMode === 'interference' ? 0.95 : 0.65} style:image-rendering={home.mapMode === 'interference' ? 'auto' : 'pixelated'} />
      {/if}
      {#if shape}
        <polygon points={shape.outline.map(([x, y]) => `${x * sc},${y * sc}`).join(' ')} fill="none" stroke="#cbd5e1" stroke-width="7" stroke-linejoin="round" />
        {#each shape.segments as seg}
          {@const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1])}
          {@const ux = (seg.b[0] - seg.a[0]) / len}
          {@const uy = (seg.b[1] - seg.a[1]) / len}
          {#each seg.features as f}
            {@const x0 = seg.a[0] + ux * (f.centerM - f.widthM / 2)}
            {@const y0 = seg.a[1] + uy * (f.centerM - f.widthM / 2)}
            {@const x1 = seg.a[0] + ux * (f.centerM + f.widthM / 2)}
            {@const y1 = seg.a[1] + uy * (f.centerM + f.widthM / 2)}
            {#if f.kind === 'window'}
              <line x1={x0 * sc} y1={y0 * sc} x2={x1 * sc} y2={y1 * sc} stroke="#7dd3fc" stroke-width="9" />
              <line x1={x0 * sc} y1={y0 * sc} x2={x1 * sc} y2={y1 * sc} stroke="#0d1526" stroke-width="2" />
            {:else}
              <line x1={x0 * sc} y1={y0 * sc} x2={x1 * sc} y2={y1 * sc} stroke="#070b14" stroke-width="11" />
              <text x={((x0 + x1) / 2) * sc} y={((y0 + y1) / 2) * sc + (y0 > room.depthM / 2 ? -14 : 30)} text-anchor="middle" class="pl-lbl small-lbl">opening</text>
            {/if}
          {/each}
        {/each}
        <text x={(room.widthM / 2) * sc} y={-(PAD - 0.3) * sc} text-anchor="middle" class="pl-lbl">Front: {shape.wallLabel.front}</text>
        <text x={(room.widthM / 2) * sc} y={(room.depthM + PAD - 0.12) * sc} text-anchor="middle" class="pl-lbl small-lbl">Back: {shape.wallLabel.back}</text>
      {:else}
        <rect x="0" y="0" width={room.widthM * sc} height={room.depthM * sc} fill="none" stroke="#cbd5e1" stroke-width="5" />
        <text x={(room.widthM / 2) * sc} y={-14} text-anchor="middle" class="pl-lbl">Front wall · {fmtFtIn(room.widthM)}</text>
      {/if}
      <text x={room.widthM * sc + 22} y={(room.depthM / 2) * sc} text-anchor="middle" class="pl-lbl" transform={`rotate(90 ${room.widthM * sc + 22} ${(room.depthM / 2) * sc})`}>{fmtFtIn(room.depthM)}</text>
      <polyline
        points={`${spk.L.x * sc},${spk.L.y * sc} ${ear.x * sc},${ear.y * sc} ${spk.R.x * sc},${spk.R.y * sc} ${spk.L.x * sc},${spk.L.y * sc}`}
        fill="none" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="8 6" opacity="0.7"
      />
      {#each sideRefl as r}
        <rect x={r.at.x * sc - 9} y={r.at.y * sc - 9} width="18" height="18" fill="#fbbf24" transform={`rotate(45 ${r.at.x * sc} ${r.at.y * sc})`} />
      {/each}
      {#each speakers as sp}
        {@const lk = looks[sp.role]}
        {@const w = ((sp.role === 'center' ? lk.w : lk.w) / 1000) * sc}
        {@const dd = (lk.d / 1000) * sc}
        {@const rot = (Math.atan2(-sp.aim.x, sp.aim.y) * 180) / Math.PI}
        <g transform={`translate(${sp.pos.x * sc} ${sp.pos.y * sc}) rotate(${rot})`} class="spk" role="button" tabindex="0" onclick={() => pickSpeaker(sp.id)} onkeydown={(e) => e.key === 'Enter' && pickSpeaker(sp.id)}>
          <rect x={-w / 2} y={sp.mount === 'wall' || sp.mount === 'ceiling' ? -dd / 2 : -dd} width={w} height={dd} rx="3"
            fill={sp.role === 'sub' ? '#a78bfa' : sp.mount === 'ceiling' ? '#c4b5fd' : '#b99066'} stroke={sp.role === 'fill' ? '#fb923c' : '#fde68a'} stroke-width="2"
            stroke-dasharray={sp.mount === 'ceiling' ? '6 4' : undefined} />
          {#if sp.role !== 'sub'}<line x1="0" y1="0" x2="0" y2={50} stroke="#38bdf8" stroke-width="3" />{/if}
        </g>
        <text x={sp.pos.x * sc} y={sp.pos.y * sc + (sp.pos.y < room.depthM / 2 ? -dd - 8 : dd + 22)} text-anchor="middle" class="pl-tag">{sp.id}</text>
      {/each}
      {#if home.mapMode === 'arrival' && (playingWaves || tWave > 0)}
        <clipPath id="roomclip"><rect x="0" y="0" width={room.widthM * sc} height={room.depthM * sc} /></clipPath>
        <g clip-path="url(#roomclip)">
          {#each speakers.filter((x) => x.role !== 'sub') as sp}
            {@const r = Math.max(0, (343.2 * (tWave - (sp.delayMs ?? 0))) / 1000)}
            {#if r > 0}
              <circle cx={sp.pos.x * sc} cy={sp.pos.y * sc} r={r * sc} fill={ROLE_COLOR[sp.role]} fill-opacity="0.07" stroke={ROLE_COLOR[sp.role]} stroke-width="6" stroke-opacity="0.9" />
            {/if}
          {/each}
        </g>
        <text x={10} y={(room.depthM * 0.42) * sc} class="pl-lbl">t = {tWave.toFixed(1)} ms {tWave < fillDelayNow ? `· fills wait until ${fillDelayNow.toFixed(1)} ms` : ''}</text>
      {/if}
      {#each layoutF.items as f}
        <rect x={f.x0 * sc} y={f.y0 * sc} width={(f.x1 - f.x0) * sc} height={(f.y1 - f.y0) * sc} rx="10" fill="#475569" fill-opacity="0.85" stroke="#94a3b8" stroke-width="2" />
        <text x={((f.x0 + f.x1) / 2) * sc} y={((f.y0 + f.y1) / 2) * sc} text-anchor="middle" class="pl-furn" transform={`rotate(-90 ${((f.x0 + f.x1) / 2) * sc} ${((f.y0 + f.y1) / 2) * sc})`}>{f.label}</text>
      {/each}
      {#each layoutF.zones.filter((z) => z.id === 'dance') as z}
        <rect x={z.x0 * sc} y={z.y0 * sc} width={(z.x1 - z.x0) * sc} height={(z.y1 - z.y0) * sc} fill="none" stroke="#f472b6" stroke-width="3" stroke-dasharray="14 9" />
        <text x={((z.x0 + z.x1) / 2) * sc} y={(z.y1 * sc) - 12} text-anchor="middle" class="pl-dance">dance floor</text>
      {/each}
      <circle cx={ear.x * sc} cy={ear.y * sc} r="16" fill="#34d399" stroke="#ecfdf5" stroke-width="3" />
      <text x={ear.x * sc} y={ear.y * sc + 40} text-anchor="middle" class="pl-lbl">{home.furniture.layout === 'split' ? 'Sweet spot' : 'You'}</text>
    </svg>
  </div>
  {/if}
  <div class="legend-row small muted">
    <span>Mains → front wall: <b>{fmtFtIn(pl.speakerFrontDistM)}</b></span>
    <span>Apart: <b>{fmtFtIn(pl.speakerSpacingM)}</b></span>
    <span>Seat → front wall: <b>{fmtFtIn(pl.listenerDistM)}</b></span>
    <span>Toe-in: <b>{toe.toFixed(0)}°</b></span>
  </div>
  <div class="opt-row">
    <button class="btn" disabled={optBusy} onclick={optimise}>{optBusy ? 'Searching…' : '✦ Find best spot'}</button>
    <button class="btn ghost" onclick={equilateral}>△ Equilateral seat</button>
  </div>
  {#if optMsg}<p class="small" style="color: var(--emerald)">{optMsg}</p>{/if}
</section>
</div>
<div class="side">
<section class="card">
  <h2>Sound system</h2>
  <p class="sub">Pick what the room is for. Each layout places its speakers by the standard angles, fitted to your walls.</p>
  <div class="layouts">
    {#each LAYOUTS as l}
      <button class="lcard" class:on={home.system.layout === l.id} onclick={() => selectLayout(l.id)}>
        <b>{l.channels}</b><span>{l.name}</span>
      </button>
    {/each}
  </div>
  <p class="small" style="margin-top:10px"><b>Goal:</b> {layout.goal}</p>
  <p class="small muted"><b>How it works:</b> {layout.learn}</p>
  <h3>Speakers in this layout</h3>
  <table class="tbl">
    <thead><tr><th>Speaker</th><th>Where</th><th>Design</th></tr></thead>
    <tbody>
      {#each speakers as sp}
        <tr>
          <td><b>{sp.id}</b> {sp.label}<span class="mm">{sp.mount}{sp.delayMs ? ` · delay ${sp.delayMs.toFixed(1)} ms` : ''}</span></td>
          <td>{fmtFtIn(sp.pos.x)} from left, {fmtFtIn(sp.pos.y)} out<span class="mm">{fmtFtIn(sp.pos.z)} up{sp.note ? ` · ${sp.note}` : ''}</span></td>
          <td>
            <button class="linklike" onclick={() => onOpenDesign(home.system.roles[sp.role])}>{designById(home.system.roles[sp.role])?.name}</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="small muted">Tap a design to see it in 3D or change which design plays each role.</p>
</section>

<section class="card">
  <h2>Furniture & zones</h2>
  <div class="chips">
    <button class="chip" class:on={home.furniture.layout === 'split'} onclick={() => (home.furniture.layout = 'split')}>Split L-couch + dance floor</button>
    <button class="chip" class:on={home.furniture.layout === 'sofa'} onclick={() => (home.furniture.layout = 'sofa')}>One sofa facing the speakers</button>
  </div>
  {#if home.furniture.layout === 'split'}
    <div class="chips">
      <span class="small muted" style="align-self:center">Chaise on the</span>
      <button class="chip" class:on={home.furniture.chaiseSide === 'left'} onclick={() => (home.furniture.chaiseSide = 'left')}>{shape ? shape.wallLabel.left : 'left wall'}</button>
      <button class="chip" class:on={home.furniture.chaiseSide === 'right'} onclick={() => (home.furniture.chaiseSide = 'right')}>{shape ? shape.wallLabel.right : 'right wall'}</button>
    </div>
    <p class="small muted">
      With seats on both side walls, nobody sits in the classic stereo sweet spot — so the goal shifts to <b>even</b>
      sound over the dance floor and both couches. The "Guests / party" or 2.2 layouts and the <i>Standing / dancing</i> maps
      are the ones to watch. Each couch hears its own side's speaker first and louder, so expect the stereo image to lean
      that way there.
    </p>
  {/if}
  <table class="tbl">
    <thead><tr><th>Zone</th><th>Bass evenness</th><th>Loudness</th><th>Stereo image</th>{#if arrival?.hasFills}<th>From the front</th>{/if}</tr></thead>
    <tbody>
      {#each zoneStats as zs}
        <tr>
          <td><b>{zs.z.label}</b><span class="mm">maps at {home.mapEar === 'standing' ? 'standing' : 'seated'} height</span></td>
          <td>{Number.isFinite(zs.bass) ? `±${zs.bass.toFixed(1)} dB` : '—'}</td>
          <td>{Number.isFinite(zs.level) ? `${zs.level.toFixed(1)} dB` : '—'}<span class="mm">{Number.isFinite(zs.spread) ? `${zs.spread.toFixed(1)} dB spread` : ''}</span></td>
          <td>{Number.isFinite(zs.image) ? `${(zs.image * 100).toFixed(0)} % centred` : '—'}</td>
          {#if arrival?.hasFills}<td>{Number.isFinite(zs.arrival) ? `${(zs.arrival * 100).toFixed(0)} %` : '—'}</td>{/if}
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="small muted">Bass: lower is more even. Loudness: average level relative to the loudest spot in the room (and how much it varies inside the zone).</p>
</section>

<section class="card">
  <h2>Delays, levels &amp; polarity</h2>
  <p class="sub">What each output of your DSP (AV receiver, miniDSP or plate amp) should be set to. The maps, the seat response and the wavefronts all use these values.</p>
  <label class="toggle"><input type="checkbox" bind:checked={home.system.autoAlign} /> Auto-align every speaker to the sweet spot</label>
  <p class="small muted">
    {#if home.system.autoAlign}
      Like an AV receiver's "speaker distance &amp; level": nearer speakers wait for the farthest one, and each is trimmed
      to be equally loud at the seat (inverse-square). Party fills keep their echo-safe delay on top.
    {:else}
      No alignment: every speaker plays immediately at full level, so nearer speakers arrive first and louder.
    {/if}
  </p>
  <table class="tbl dsp">
    <thead><tr><th>Out</th><th>To seat</th><th>Delay ms</th><th>Level dB</th><th>Pol.</th></tr></thead>
    <tbody>
      {#each speakers as sp}
        {@const d = Math.hypot(sp.pos.x - seatPos.x, sp.pos.y - seatPos.y, sp.pos.z - seatPos.z)}
        {@const isFill = sp.role === 'fill'}
        <tr>
          <td><b>{sp.id}</b><span class="mm">{sp.label}</span></td>
          <td>{fmtFtIn(d)}<span class="mm">{((d / 343.2) * 1000).toFixed(1)} ms</span></td>
          <td>
            <input class="num" type="number" step="0.1" min="0" max="60" aria-label={`${sp.id} delay`}
              value={f1(sp.delayMs)}
              onchange={(e) => (isFill ? (home.system.fillDelayMs = numIn(e)) : setDsp(sp.id, { delayMs: numIn(e) }))} />
            <span class="mm">auto {f1(sp.autoDelayMs)}</span>
          </td>
          <td>
            <input class="num" type="number" step="0.5" min="-20" max="10" aria-label={`${sp.id} level`}
              value={f1(sp.gainDb)}
              onchange={(e) => (isFill ? (home.system.fillGainDb = numIn(e)) : setDsp(sp.id, { gainDb: numIn(e) }))} />
            {#if !isFill}<span class="mm">auto {f1(sp.autoGainDb)}</span>{/if}
          </td>
          <td>
            <button class="pol" class:inv={sp.invert} aria-label={`${sp.id} polarity`} onclick={() => setDsp(sp.id, { invert: !sp.invert })}>{sp.invert ? '−' : '+'}</button>
            {#if hasDsp(sp.id) || (isFill && home.system.fillDelayMs !== null)}
              <button class="pol" aria-label={`Reset ${sp.id}`} title="Back to auto" onclick={() => { resetDsp(sp.id); if (isFill) home.system.fillDelayMs = null; }}>↺</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if Number.isFinite(xSum)}
    <h3>Sub ↔ mains at the crossover</h3>
    <p class="small">
      Around {home.sub.crossoverHz} Hz at the sweet spot the subs and mains add up to
      <b class:good={xSum > -1.5} class:bad={xSum < -4}>{xSum > -0.05 ? 'a perfect sum' : `${xSum.toFixed(1)} dB short of a perfect sum`}</b>
      {xSum > -1.5 ? '— they are in step.' : xSum < -4 ? '— they are fighting: change the sub delay or flip its polarity.' : '— close; a small sub delay change would help.'}
      (Direct sound only; the room adds its own peaks and dips — check with a mic.)
    </p>
    <div class="opt-row">
      <button class="btn" onclick={alignSub}>⟲ Find best sub delay</button>
      {#if subMsg}<span class="small muted">{subMsg}</span>{/if}
    </div>
  {/if}
</section>

{#if fills.length || speakers.some((x) => x.role === 'sub')}
<section class="card">
  <h2>Setting the delays for real</h2>
  <p class="sub">The planner's delays are a starting point. Here is how installers set them with a measurement mic and free REW software.</p>
  <ol class="howto">
    {#if fills.length}
      <li><b>Fill delay.</b> Put the mic where the fill helps most (back of the room, ear height). Play REW's sweep through a <i>main</i> speaker only and note the impulse peak time; repeat with the <i>fill</i> only. Set the fill's DSP delay to <code>t_main − t_fill + 10–15 ms</code>. The planner's guess: <b>{autoFillDelay.toFixed(1)} ms</b>.</li>
      <li><b>Fill level.</b> With pink noise, set the fill so that at that spot it is 3–6 dB quieter than the mains. Walk around: the sound should still seem to come from the front.</li>
      <li><b>Check for echo.</b> Clap-like music (drums) shouldn't "double" anywhere. If it does, the delay is too long or the fill too loud.</li>
    {/if}
    {#if speakers.some((x) => x.role === 'sub')}
      <li><b>Sub timing.</b> At the main seat, measure a main speaker and the sub together around the crossover ({home.sub.crossoverHz} Hz). Adjust the sub's delay (or phase knob / polarity) until the combined level is <i>highest</i> there — REW's alignment tool automates this.</li>
      <li><b>Two subs.</b> Time-align them to each other first (same distance-equivalent), then to the mains, then use the plate amp's EQ to cut the remaining peaks.</li>
    {/if}
  </ol>
</section>
{/if}

<section class="card">
  <h2>Your room</h2>
  <p class="sub">
    Type sizes in feet and inches (<code>12'6 1/2"</code>), or in metres (<code>3.86m</code>). Width is
    the wall the speakers stand in front of.
  </p>
  {#each [['widthM', 'Width (speaker wall)'], ['depthM', 'Depth (front → back)'], ['heightM', 'Ceiling height']] as [key, label]}
    {@const k = key as 'widthM' | 'depthM' | 'heightM'}
    <div class="field">
      <label for={`rm-${k}`}>{label}</label>
      <div class="stepper">
        <button aria-label={`decrease ${label}`} onclick={() => stepIn(k, -1)}>−</button>
        <input
          id={`rm-${k}`}
          class="len"
          class:bad={badInput === k}
          value={fmtFtInFrac(room[k])}
          onchange={(e) => setLen(k, e.target as HTMLInputElement)}
          onfocus={(e) => (e.target as HTMLInputElement).select()}
        />
        <button aria-label={`increase ${label}`} onclick={() => stepIn(k, 1)}>+</button>
      </div>
    </div>
  {/each}
  {#if shape && home.shapeId}
    <h3>Which wall do the speakers face out from?</h3>
    <div class="chips">
      {#each ['south', 'north', 'west', 'east'] as c}
        {@const nm = ROOM_SHAPES[home.shapeId].wallNames[c as Compass]}
        <button class="chip" class:on={home.frontWall === c} onclick={() => setFront(c as Compass)}>{nm}</button>
      {/each}
    </div>
    <p class="small muted">{ROOM_SHAPES[home.shapeId].note}</p>
  {/if}
  {#if badInput}<p class="small" style="color: var(--rose)">Couldn't read that — try 12'6 1/2" or 3.8m.</p>{/if}
  <div class="chips">
    {#each ROOM_PRESETS as r, i}
      <button class="chip" class:on={home.roomName === r.name} onclick={() => applyPreset(i)}>{r.name}</button>
    {/each}
    <button class="chip" onclick={() => preset(15, 25)}>15×25 ft</button>
    <button class="chip" onclick={() => preset(15, 30)}>15×30 ft</button>
    <button class="chip" onclick={() => preset(20, 30)}>20×30 ft</button>
    {#if !shape}<button class="chip" onclick={swapOrientation}>↻ Use the other wall</button>{/if}
  </div>
  <h3>How lively is the room?</h3>
  <div class="chips">
    {#each [[0.6, 'Empty / echoey'], [0.45, 'Furnished, wood floors'], [0.35, 'Rugs, sofa, curtains']] as [t, lbl]}
      <button class="chip" class:on={Math.abs(room.rt60S - (t as number)) < 0.01} onclick={() => (home.room.rt60S = t as number)}>
        {lbl}
      </button>
    {/each}
  </div>
  <p class="small muted">
    This model assumes a closed box with rigid walls:
    wide openings (like a 5′ doorway to the hall) and big windows let some bass escape, so real peaks will be a
    little smaller and slightly shifted.
  </p>
</section>



<section class="card">
  <h2>Placement</h2>
  <div class="field">
    <label for="pl-front">Speaker baffle → front wall</label>
    <span class="val">{fmtFtIn(pl.speakerFrontDistM)}</span>
    <input id="pl-front" type="range" min="0.15" max={Math.min(2, room.depthM * 0.4)} step="0.01" bind:value={home.placement.speakerFrontDistM} />
  </div>
  <div class="field">
    <label for="pl-spacing">Speaker spacing (centre to centre)</label>
    <span class="val">{fmtFtIn(pl.speakerSpacingM)}</span>
    <input id="pl-spacing" type="range" min="0.8" max={room.widthM - 0.5} step="0.01" bind:value={home.placement.speakerSpacingM} />
  </div>
  <div class="field">
    <label for="pl-seat">Your head → front wall</label>
    <span class="val">{fmtFtIn(pl.listenerDistM)}</span>
    <input id="pl-seat" type="range" min={pl.speakerFrontDistM + 0.8} max={room.depthM - 0.3} step="0.01" bind:value={home.placement.listenerDistM} />
  </div>
  <div class="field">
    <label for="pl-toe">Axes cross in front of you</label>
    <span class="val">{fmtFtIn(pl.toeCrossAheadM)}</span>
    <span class="hint">0 = aimed straight at your ears (sharpest image, narrowest sweet spot).</span>
    <input id="pl-toe" type="range" min="0" max="1.5" step="0.05" bind:value={home.placement.toeCrossAheadM} />
  </div>
  <div class="field">
    <label for="pl-ear">Seated ear height</label>
    <span class="val">{fmtFtIn(pl.earHeightM)}</span>
    <span class="hint">Put the tweeter at about this height (stands).</span>
    <input id="pl-ear" type="range" min="0.8" max="1.3" step="0.01" bind:value={home.placement.earHeightM} />
  </div>
</section>

<section class="card">
  <h2>Bass at your seat</h2>
  <p class="sub">
    Using the <button class="linklike" onclick={onGoSpeaker}>{speakerLabel}</button> you are designing. 0 dB =
    what the pair would do with no room at all.
  </p>
  <MiniChart
    series={chartSeries}
    xMin={18}
    xMax={220}
    yMin={-24}
    yMax={18}
    yStep={6}
    xTicks={[20, 30, 50, 80, 100, 150, 200]}
    shadeFrom={{ x: fSch, label: 'statistical region — trend only' }}
    markers={[
      { x: fSch, label: 'Schroeder', color: '#a78bfa' },
      ...(pl.speakerFrontDistM > 0.2 ? [{ x: sbirNotchHz(pl.speakerFrontDistM), label: 'wall bounce', color: '#fb7185' }] : []),
      ...(sub.count ? [{ x: sub.crossoverHz, label: 'sub X-over', color: '#34d399' }] : []),
    ]}
  />
  <p class="small muted">
    Below the purple line (~{fSch.toFixed(0)} Hz) the room's resonances dominate and seat position matters a
    lot; above it, the speaker's own design and early reflections matter more.
  </p>
  <h3>Subwoofers</h3>
  <div class="chips">
    {#each [[0, 'None'], [1, '1 sub'], [2, '2 subs'], [4, '4 subs']] as [n, lbl]}
      <button class="chip" class:on={sub.count === n} onclick={() => (home.sub.count = n as 0 | 1 | 2 | 4)}>{lbl}</button>
    {/each}
  </div>
  {#if sub.count > 0}
    <div class="chips">
      {#each [['front-corners', 'Front corners'], ['front-wall-mid', 'Front wall'], ['front-back-mid', 'Front + back wall middles'], ['four-midwalls', 'All 4 wall middles']] as [id, lbl]}
        <button class="chip" class:on={sub.layout === id} onclick={() => (home.sub.layout = id as typeof sub.layout)}>{lbl}</button>
      {/each}
    </div>
    <div class="field">
      <label for="sub-xo">Crossover</label>
      <span class="val">{sub.crossoverHz} Hz</span>
      <input id="sub-xo" type="range" min="50" max="120" step="5" bind:value={home.sub.crossoverHz} />
    </div>
    <p class="small muted">
      Subs are modelled as generic sealed subwoofers (−3 dB ≈ 25 Hz), with a 4th-order Linkwitz-Riley crossover on
      both subs and mains. Two subs at the middles of opposite walls cancel the odd room modes: that is the trick for an
      even "sweet spot" across a whole sofa instead of a single head position.
      <b>Limitation:</b> each sub's delay and level are not optimised here (in practice you tune them with a measurement
      mic), so multi-sub results are pessimistic.
    </p>
  {/if}
  <h3>Insights</h3>
  <ul class="callouts">
    {#each insights as n}
      <li class={n.cls}>{@html n.html}</li>
    {/each}
  </ul>
</section>

<section class="card">
  <h2>Where to put absorption panels</h2>
  <p class="sub">
    Mirror points where sound bounces off a surface once on the way to you. Panels (2–4″ thick mineral wool in a
    wood frame — a great first woodworking project) here sharpen the stereo image.
  </p>
  <table class="tbl">
    <thead><tr><th>Surface</th><th>Centre of panel</th><th>Arrives late by</th></tr></thead>
    <tbody>
      {#each [...sideRefl, ...farSideRefl] as r}
        <tr>
          <td>{r.surface} <span class="muted small">({r.speaker} speaker)</span></td>
          <td>{fmtFtIn(r.at.y)} from front wall, {fmtFtIn(r.at.z)} up</td>
          <td>{r.delayMs.toFixed(1)} ms</td>
        </tr>
      {/each}
      {#each ceilRefl as r}
        <tr>
          <td>ceiling <span class="muted small">({r.speaker})</span></td>
          <td>{fmtFtIn(r.at.y)} from front wall, {fmtFtIn(r.at.x)} from left wall</td>
          <td>{r.delayMs.toFixed(1)} ms</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<section class="card">
  <h2>Room modes</h2>
  <p class="sub">
    Frequencies where sound bounces back and forth between parallel walls and builds up. Axial modes (between one pair
    of walls) are the strongest.
  </p>
  <div class="modes">
    {#each axial as m}
      {@const dir = m.n[0] ? 'side↔side' : m.n[1] ? 'front↔back' : 'floor↔ceiling'}
      <div class="mode"><b>{m.freqHz.toFixed(0)} Hz</b><span>{dir} ×{Math.max(...m.n)}</span></div>
    {/each}
  </div>
  <p class="small muted">
    {modes.length} modes below 160 Hz in total ({modes.filter((m) => m.kind === 'axial').length} axial). Room volume
    {(room.widthM * room.depthM * room.heightM).toFixed(0)} m³ ({((room.widthM * room.depthM * room.heightM) / FT ** 3).toFixed(0)} ft³).
  </p>
</section>
</div>
</div>

<style>
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
    font-size: 14px;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
  .dsp .num {
    width: 62px;
    padding: 4px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--text-0, inherit);
    font: inherit;
    font-size: 13px;
  }
  .pol {
    min-width: 30px;
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--text-1);
    cursor: pointer;
    font-size: 14px;
  }
  .pol.inv {
    border-color: #f87171;
    color: #f87171;
  }
  .good {
    color: var(--emerald);
  }
  .bad {
    color: #f87171;
  }
  :global(.pl-furn) {
    fill: #e2e8f0;
    font-size: 17px;
    font-weight: 700;
  }
  :global(.pl-dance) {
    fill: #f9a8d4;
    font-size: 18px;
    font-weight: 700;
  }
  .ctl-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--bg-2);
    border-radius: 10px;
    padding: 8px 10px;
  }
  .ctl-panel .field.compact {
    margin: 2px 0;
  }
  .legend-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 12px;
    font-size: 12px;
    color: var(--text-1);
  }
  .legend-chips i {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
    margin-right: 5px;
    vertical-align: -1px;
  }
  .howto {
    padding-left: 20px;
    margin: 4px 0 0;
    font-size: 13.5px;
    color: var(--text-1);
  }
  .howto li {
    margin: 7px 0;
  }
  .maps {
    align-self: flex-start;
    flex-wrap: wrap;
  }
  .maplegend {
    margin: 0 !important;
  }
  .maplegend .g {
    color: hsl(140 70% 55%);
  }
  .maplegend .r {
    color: hsl(0 70% 62%);
  }
  .layouts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 6px;
  }
  .lcard {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 9px;
    color: var(--text-1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .lcard b {
    font-size: 16px;
    color: var(--text-0);
  }
  .lcard.on {
    border-color: var(--accent);
    background: rgba(56, 189, 248, 0.1);
  }
  :global(.pl-tag) {
    fill: #e2e8f0;
    font-size: 18px;
    font-weight: 800;
  }
  :global(.small-lbl) {
    font-size: 17px !important;
  }
  .spk {
    cursor: pointer;
  }
  .legend-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 8px;
  }
  .legend-row b {
    color: var(--text-0);
  }
  .opt-row {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .busy {
    opacity: 0.85;
  }
  :global(.pl-lbl) {
    fill: #cbd5e1;
    font-size: 22px;
    font-weight: 600;
  }
  :global(.pl-sub) {
    fill: #1e1b4b;
    font-size: 13px;
    font-weight: 800;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 6px;
  }
  .mode {
    background: var(--bg-2);
    border-radius: 9px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .mode b {
    color: var(--text-0);
    font-size: 15px;
  }
  .stepper input.len {
    width: 112px;
    font-size: 15px;
  }
  .stepper input.bad {
    border-color: var(--rose);
  }
  .linklike {
    background: none;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
