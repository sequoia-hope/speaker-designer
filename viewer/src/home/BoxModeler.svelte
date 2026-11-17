<script lang="ts">
  import MiniChart, { type MiniSeries } from './MiniChart.svelte';
  import type { DriverInfo } from './drivers';
  import type { BoxDesign } from './speakerBuild';
  import {
    EMPTY_MODELER_ALT,
    PR_PRESETS,
    bandpassPortLengthMm,
    boxLabel,
    boxNetL,
    boxSpecOf,
    defaultBandpassTargets,
    designBandpass4,
    designBandpass6,
    f3HighOf,
    f3Of,
    hasPort,
    isBandpass,
    prMassForTuning,
    printedAsModel,
    runModel,
    suggestPr,
    type BandpassDesign,
    type BoxKind,
    type BoxSpec,
    type ModelResult,
    type ModelerAlt,
    type Placement,
  } from './boxModel';
  import { portNoiseMs } from './speakerBuild';
  import { home, saveHome } from './homeState.svelte';
  import MeasOverlayControl from './MeasOverlayControl.svelte';
  import { compareToPrediction, impedanceOverlay, pickOverlay } from './measOverlay';

  let { box, woofer, wooferYmm = 0 }: { box: BoxDesign; woofer: DriverInfo; wooferYmm?: number } = $props();
  let placement = $state<Placement>('half');
  let noiseOverride = $state<number | null>(null);
  const noise = $derived(noiseOverride ?? portNoiseMs(box.portEnds));
  const baffle = $derived({ widthMm: box.externalMm.w, heightMm: box.externalMm.h, driverYmm: wooferYmm || box.externalMm.h / 2 });

  type Graph = 'spl' | 'excursion' | 'port' | 'maxspl' | 'impedance' | 'delay';
  let graph = $state<Graph>('spl');
  // power as a log-scale slider position so 1 W and 1000 W are both reachable
  let powerPos = $state<number | null>(null);
  let hpOn = $state(false);
  let hpHz = $state(25);
  let hpOrder = $state<2 | 4>(4);

  const N = $derived(box.wooferCount);
  const rated = $derived((woofer.powerW ?? 50) * N);
  const pMin = 0.5;
  const pMax = $derived(Math.max(rated * 2, 20));
  const toPos = (w: number) => Math.log(w / pMin) / Math.log(pMax / pMin);
  const pos = $derived(powerPos ?? toPos(rated));
  const powerW = $derived.by(() => {
    const w = pMin * Math.pow(pMax / pMin, pos);
    return w < 10 ? Math.round(w * 10) / 10 : Math.round(w);
  });

  // ---- which box: sealed / vented follow (and switch) the woodworking plan above;
  //      passive radiator and bandpass boxes are modelled here only ----
  type BpSpec = Extract<BoxSpec, { kind: 'bp4' | 'bp6' }>;
  // the PR / bandpass choices live in the design's settings, so they persist and
  // are saved with it (SavedDesigns snapshots the settings)
  const ds = $derived(home.designs[home.activeDesign]);
  const mod = $derived<ModelerAlt>(ds?.modeler ?? EMPTY_MODELER_ALT);
  function setMod(patch: Partial<ModelerAlt>) {
    if (!ds) return;
    ds.modeler = { ...EMPTY_MODELER_ALT, ...(ds.modeler ? ($state.snapshot(ds.modeler) as ModelerAlt) : {}), ...patch };
  }
  const alt = $derived(mod.alt);
  const planSpec = $derived(boxSpecOf(box));
  const kind = $derived<BoxKind>(alt ?? planSpec.kind);
  const KINDS: [BoxKind, string][] = [
    ['sealed', 'Sealed box'],
    ['vented', 'Vented box'],
    ['pr', 'Passive radiator'],
    ['bp4', 'Bandpass 4th'],
    ['bp6', 'Bandpass 6th'],
  ];
  const KIND_NAME: Record<BoxKind, string> = { sealed: 'sealed', vented: 'vented', pr: 'passive-radiator', bp4: '4th-order bandpass', bp6: '6th-order bandpass' };
  function pickKind(k: BoxKind) {
    if (k === 'sealed' || k === 'vented') {
      if (alt) setMod({ alt: null });
      const cur = home.designs[home.activeDesign];
      if (cur && cur.boxType !== k) cur.boxType = k;
    } else setMod({ alt: k });
  }
  // the woofer (and count) a PR/bandpass setting was made for; a new woofer starts over
  const key = $derived(`${woofer.id}:${N}`);

  // ---- passive radiator ----
  type PrUser = { key: string; id: string | null; count: number | null; netL: number | null; fp: number | null };
  const prU = $derived<PrUser>(mod.pr && mod.pr.key === key ? mod.pr : { key, id: null, count: null, netL: null, fp: null });
  function setPr(patch: Partial<PrUser>) {
    setMod({ pr: { ...prU, ...patch, key } });
  }
  const prSug = $derived(suggestPr(woofer, N));
  const prDev = $derived(PR_PRESETS.find((p) => p.id === prU.id) ?? prSug.pr);
  const prN = $derived(prU.count ?? prSug.prCount);
  const prVol = $derived(prU.netL ?? Math.round(box.netVolumeL * 10) / 10);
  // default tuning: the plan's port tuning if it has one, else Keele's vented rule of thumb 0.42·Fs·Qts^−0.9
  const prFpDefault = $derived(Math.round(planSpec.kind === 'vented' ? planSpec.fbHz : Math.min(80, Math.max(15, 0.42 * woofer.fsHz * Math.pow(woofer.qts, -0.9)))));
  const prFp = $derived(prU.fp ?? prFpDefault);
  const prTune = $derived(prMassForTuning(prVol, prDev, prN, prFp));

  // ---- bandpass: auto-designed for the woofer until you design or edit it ----
  type BpUser = { key: string; spec: BpSpec; design: BandpassDesign | null; edited: boolean };
  const bpUser = $derived({ bp4: mod.bp4 as BpUser | null, bp6: mod.bp6 as BpUser | null });
  const bpTarget = $derived(mod.bpTarget);
  const bpDefaults = $derived(defaultBandpassTargets(woofer));
  const target = $derived(bpTarget && bpTarget.key === key ? bpTarget : { key, lo: Math.round(bpDefaults.fLowHz), hi: Math.round(bpDefaults.fHighHz) });
  const bpAuto = $derived.by((): BandpassDesign | null => {
    if (kind !== 'bp4' && kind !== 'bp6') return null;
    if (bpUser[kind]?.key === key) return null;
    const t = { fLowHz: target.lo, fHighHz: target.hi };
    return kind === 'bp4' ? designBandpass4(woofer, N, t) : designBandpass6(woofer, N, t);
  });
  const bpCur = $derived.by((): BpUser | null => {
    if (kind !== 'bp4' && kind !== 'bp6') return null;
    const u = bpUser[kind];
    if (u && u.key === key) return u;
    return bpAuto ? { key, spec: bpAuto.spec, design: bpAuto, edited: false } : null;
  });
  let designing = $state(false);
  function designBp() {
    if (kind !== 'bp4' && kind !== 'bp6') return;
    const k = kind;
    designing = true;
    // let the button repaint before the (≈0.1 s) bp6 fit
    setTimeout(() => {
      const t = { fLowHz: target.lo, fHighHz: target.hi };
      const des = k === 'bp4' ? designBandpass4(woofer, N, t) : designBandpass6(woofer, N, t);
      setMod({ [k]: { key, spec: des.spec, design: des, edited: false } });
      designing = false;
    }, 0);
  }
  function setTarget(lo: number, hi: number) {
    setMod({ bpTarget: { key, lo, hi: Math.max(hi, Math.round(lo * 1.3)) } });
  }
  function setBp(patch: Record<string, number>) {
    if (!bpCur) return;
    const next = { ...($state.snapshot(bpCur.spec) as BpSpec), ...patch } as BpSpec;
    setMod({ [next.kind]: { key, spec: next, design: bpCur.design ? ($state.snapshot(bpCur.design) as BandpassDesign) : null, edited: true } });
  }
  const dia = (a: number) => Math.round(2 * Math.sqrt(a / Math.PI) * 1000); // mm
  const area = (dMm: number) => Math.PI * (dMm / 2000) ** 2;
  const num = (e: Event) => +(e.currentTarget as HTMLInputElement).value;

  const spec = $derived.by((): BoxSpec => {
    if (kind === 'pr') return { kind: 'pr', netL: prVol, pr: prDev, prCount: prN, addedMassG: Math.round(prTune.addedMassG * 10) / 10 };
    if ((kind === 'bp4' || kind === 'bp6') && bpCur) return bpCur.spec;
    return planSpec;
  });
  const portLens = $derived(
    spec.kind === 'bp4'
      ? [{ label: 'Port', len: bandpassPortLengthMm(spec.frontL, spec.fbHz, spec.portAreaM2) }]
      : spec.kind === 'bp6'
        ? [
            { label: 'Front port', len: bandpassPortLengthMm(spec.frontL, spec.fbFrontHz, spec.frontPortAreaM2) },
            { label: 'Rear port', len: bandpassPortLengthMm(spec.rearL, spec.fbRearHz, spec.rearPortAreaM2) },
          ]
        : []
  );
  const r = $derived(
    runModel({
      driver: woofer,
      count: N,
      box: spec,
      powerW,
      highPass: hpOn ? { hz: hpHz, order: hpOrder } : null,
      portNoiseMs: noise,
      placement,
      baffle,
      f0: 10,
      f1: 500,
      n: 170,
    })
  );
  const vented = $derived(hasPort(spec));
  /** the tuning below which the cone unloads (vented, PR, bp6 rear) — where a high-pass belongs */
  const unloadHz = $derived(spec.kind === 'vented' ? spec.fbHz : spec.kind === 'pr' ? prTune.fpHz : spec.kind === 'bp6' ? spec.fbRearHz : null);
  // a vented box unloads below tuning, so the useful high-pass sits just under it
  function toggleHp(on: boolean) {
    hpOn = on;
    if (on) hpHz = unloadHz ? Math.max(10, Math.round(unloadHz * 0.8)) : 25;
  }
  const PORT_LIMIT = $derived(noise);
  // the Port tab disappears when nothing on screen has a port
  $effect(() => {
    if (graph === 'port' && !vented && !home.modelerPins.some((p) => hasPort(p.box))) graph = 'spl';
  });

  const pts = (ys: number[]) => r.freqs.map((x, i) => ({ x, y: ys[i] }));
  const flat = (y: number) => [
    { x: 10, y },
    { x: 500, y },
  ];
  const bassBand = (i: number) => r.freqs[i] >= 15 && r.freqs[i] <= 300;

  /** frequency range where ys > limit (in the bass band) */
  function overRange(ys: number[], limit: number): [number, number] | null {
    let lo = -1;
    let hi = -1;
    ys.forEach((y, i) => {
      if (!bassBand(i) || !(y > limit)) return;
      if (lo < 0) lo = i;
      hi = i;
    });
    return lo < 0 ? null : [r.freqs[lo], r.freqs[hi]];
  }
  function peak(ys: number[]) {
    let k = -1;
    ys.forEach((y, i) => {
      if (bassBand(i) && Number.isFinite(y) && (k < 0 || y > ys[k])) k = i;
    });
    return k < 0 ? { y: NaN, f: NaN } : { y: ys[k], f: r.freqs[k] };
  }

  const excOver = $derived(overRange(r.excursionMm, r.xmaxMm));
  const excPeak = $derived(peak(r.excursionMm));
  const prPeak = $derived(r.prExcursionMm ? peak(r.prExcursionMm) : null);
  const prOver = $derived(r.prExcursionMm && r.prXmaxMm != null ? overRange(r.prExcursionMm, r.prXmaxMm) : null);
  const portPeak = $derived(vented ? peak(r.portVelocity) : null);
  const portOver = $derived(vented ? overRange(r.portVelocity, PORT_LIMIT) : null);
  const splAt = (f: number, ys: number[]) => {
    const i = r.freqs.findIndex((x) => x >= f);
    return ys[Math.max(0, i)];
  };
  const fmtHz = (f: number) => `${f.toFixed(0)} Hz`;
  const fmtW = (w: number) => (w < 10 ? w.toFixed(1) : w.toFixed(0));

  function niceRange(ys: number[], span: number, step: number, floor?: number) {
    const top = Math.max(...ys.filter((y, i) => Number.isFinite(y) && bassBand(i)));
    const yMax = Math.ceil((top + step / 2) / step) * step;
    return { yMin: floor ?? yMax - span, yMax };
  }

  // ---- comparison pins (same amp power and filter, so the comparison is fair) ----
  const PIN_COLORS = ['#a3e635', '#fb923c', '#2dd4bf', '#e2e8f0'];
  const MAX_PINS = 4;
  const curLabel = $derived(boxLabel(woofer, N, spec));
  const pinned = $derived(
    home.modelerPins.map((p, i) => ({
      pin: p,
      color: PIN_COLORS[i % PIN_COLORS.length],
      r: p.printed
        ? printedAsModel(p.printed, p.driver, powerW)
        : runModel({ driver: p.driver, count: p.count, box: p.box, powerW, highPass: hpOn ? { hz: hpHz, order: hpOrder } : null, portNoiseMs: noise, placement, baffle, f0: 10, f1: 500, n: 170 }),
    }))
  );
  const alreadyPinned = $derived(home.modelerPins.some((p) => p.label === curLabel));
  function pinCurrent() {
    if (home.modelerPins.length >= MAX_PINS || alreadyPinned) return;
    home.modelerPins.push({
      id: `pin-${Date.now().toString(36)}`,
      label: curLabel,
      driver: $state.snapshot(woofer) as DriverInfo,
      count: N,
      box: $state.snapshot(spec) as BoxSpec,
    });
    saveHome();
  }
  function unpin(id: string) {
    home.modelerPins = home.modelerPins.filter((p) => p.id !== id);
    saveHome();
  }

  function curveOf(res: ModelResult, g: Graph): number[] {
    switch (g) {
      case 'spl':
        return res.spl;
      case 'maxspl':
        return res.maxSpl;
      case 'excursion':
        return res.excursionMm;
      case 'port':
        return res.portVelocity;
      case 'impedance':
        return res.impedance;
      default:
        return res.groupDelayMs;
    }
  }
  const finiteBass = (ys: number[]) => ys.filter((y, i) => Number.isFinite(y) && bassBand(i));

  // ---- an imported measurement over the prediction (loudness / impedance graphs) ----
  const MEAS_COLOR = '#f97316';
  const measSpl = $derived(pickOverlay(home.measurements, home.measOverlay.box, 'spl'));
  const measZ = $derived(pickOverlay(home.measurements, home.measOverlay.boxZ, 'impedance'));
  const splCmp = $derived(measSpl ? compareToPrediction(pts(r.spl), measSpl, { alignBand: [200, 2000], xMin: 10, xMax: 500, smooth: 12, edges: [50, 100, 200] }) : null);
  const zPts = $derived(measZ ? impedanceOverlay(measZ, 10, 500) : []);

  const chart = $derived.by(() => {
    const blue = '#38bdf8';
    const amber = '#fbbf24';
    const red = '#f87171';
    const violet = '#c084fc';
    const comparing = pinned.length > 0;
    const others = pinned.filter((p) => graph !== 'port' || hasPort(p.pin.box));
    const pinSeries: MiniSeries[] = others.map((p) => ({ label: p.pin.label, color: p.color, points: pts(curveOf(p.r, graph)), width: 1.7 }));
    const all = [curveOf(r, graph), ...others.map((p) => curveOf(p.r, graph))].flatMap((ys) => finiteBass(ys));
    // passive radiators move too: their travel shares the excursion graph
    const prCurves = graph === 'excursion' ? [r, ...others.map((p) => p.r)].flatMap((x) => (x.prExcursionMm ? finiteBass(x.prExcursionMm) : [])) : [];
    const mainLabel = (what: string) => (comparing ? `This design — ${curLabel}` : what);
    let series: MiniSeries[] = [];
    let yMin = 0;
    let yMax = 1;
    let yStep = 5;
    let yLabel = 'dB';
    if (graph === 'spl') {
      series = [{ label: mainLabel(`${fmtW(powerW)} W (${r.voltsRms.toFixed(1)} V)`), color: blue, points: pts(r.spl) }];
      if (!comparing) series.push({ label: '2.83 V, no filter', color: '#94a3b8', points: pts(r.spl283), dashed: true, width: 1.4 });
      ({ yMin, yMax } = niceRange([...all, ...(comparing ? [] : finiteBass(r.spl283))], 40, 5));
    } else if (graph === 'maxspl') {
      series = [{ label: mainLabel('Max SPL (Xmax / power limited)'), color: comparing ? blue : '#34d399', points: pts(r.maxSpl) }];
      if (!comparing) series.push({ label: `At ${fmtW(powerW)} W`, color: blue, points: pts(r.spl), dashed: true, width: 1.4 });
      ({ yMin, yMax } = niceRange([...all, ...(comparing ? [] : finiteBass(r.spl))], 40, 5));
    } else if (graph === 'excursion') {
      series = [
        { label: mainLabel('Cone excursion (peak)'), color: blue, points: pts(r.excursionMm) },
        { label: `Xmax ${r.xmaxMm} mm`, color: red, points: flat(r.xmaxMm), dashed: true, width: 1.4 },
      ];
      if (r.prExcursionMm && r.prXmaxMm != null)
        series.push(
          { label: comparing ? 'This design — passive radiator' : 'Passive radiator excursion (peak)', color: violet, points: pts(r.prExcursionMm) },
          { label: `PR Xmax ${r.prXmaxMm} mm`, color: violet, points: flat(r.prXmaxMm), dashed: true, width: 1.2 }
        );
      // pinned drivers with a different Xmax get their own limit line
      for (const p of others)
        if (p.r.xmaxMm !== r.xmaxMm) series.push({ label: `Xmax ${p.r.xmaxMm} mm (${p.pin.driver.model})`, color: p.color, points: flat(p.r.xmaxMm), dashed: true, width: 1 });
      for (const p of others)
        if (p.r.prExcursionMm) series.push({ label: `${p.pin.label} — passive radiator`, color: p.color, points: pts(p.r.prExcursionMm), dashed: true, width: 1.3 });
      yLabel = 'mm';
      const xm = Math.max(r.xmaxMm, r.prXmaxMm ?? 0, ...others.map((p) => Math.max(p.r.xmaxMm, p.r.prXmaxMm ?? 0)));
      const top = Math.min(Math.max(...all, ...prCurves), xm * 4);
      yMax = Math.max(xm * 1.5, top * 1.1);
      yStep = yMax > 20 ? 5 : yMax > 8 ? 2 : 1;
      yMax = Math.ceil(yMax / yStep) * yStep;
    } else if (graph === 'port') {
      series = [
        ...(r.ports && r.ports.length > 1
          ? r.ports.map((pt, k) => ({ label: comparing ? `This design — ${pt.label.toLowerCase()}` : `${pt.label} air speed (peak)`, color: blue, points: pts(pt.velocity), ...(k ? { dashed: true } : {}) }))
          : vented
            ? [{ label: mainLabel('Port air speed (peak)'), color: blue, points: pts(r.portVelocity) }]
            : []),
        { label: `${PORT_LIMIT} m/s: port noise starts`, color: amber, points: flat(PORT_LIMIT), dashed: true, width: 1.4 },
      ];
      yLabel = 'm/s';
      const top = Math.min(all.length ? Math.max(...all) : 0, 80);
      yStep = top > 40 ? 10 : 5;
      yMax = Math.ceil(Math.max(top * 1.1, 25) / yStep) * yStep;
    } else if (graph === 'impedance') {
      series = [{ label: mainLabel('Impedance'), color: blue, points: pts(r.impedance) }];
      yLabel = 'Ω';
      const top = Math.max(...all, ...r.impedance);
      yStep = top > 60 ? 20 : top > 30 ? 10 : 5;
      yMax = Math.ceil((top * 1.05) / yStep) * yStep;
    } else {
      series = [{ label: mainLabel('Group delay'), color: blue, points: pts(r.groupDelayMs) }];
      yLabel = 'ms';
      const top = Math.max(...all);
      yStep = top > 40 ? 10 : 5;
      yMax = Math.ceil((top * 1.1) / yStep) * yStep;
    }
    if (graph === 'spl' && splCmp && measSpl)
      series.push({ label: `Measured: ${measSpl.name} (${splCmp.offsetDb >= 0 ? '+' : '−'}${Math.abs(splCmp.offsetDb).toFixed(1)} dB)`, color: MEAS_COLOR, points: splCmp.points, dashed: true, width: 1.8 });
    if (graph === 'impedance' && measZ && zPts.length) {
      series.push({ label: `Measured: ${measZ.name}`, color: MEAS_COLOR, points: zPts, dashed: true, width: 1.8 });
      const top = Math.max(...zPts.map((p) => p.y).filter(Number.isFinite));
      if (top * 1.05 > yMax) yMax = Math.ceil((top * 1.05) / yStep) * yStep;
    }
    return { series: [...series, ...pinSeries], yMin, yMax, yStep, yLabel };
  });

  /** WinISD-style side-by-side numbers */
  const table = $derived.by(() => {
    const row = (label: string, color: string, res: ModelResult, b: BoxSpec, id: string | null) => {
      const ex = finiteBass(res.excursionMm);
      const pv = finiteBass(res.portVelocity);
      const prx = res.prExcursionMm ? finiteBass(res.prExcursionMm) : [];
      return {
        id,
        label,
        color,
        netL: boxNetL(b),
        f3: f3Of(res),
        f3High: isBandpass(b) ? f3HighOf(res) : null,
        prExc: prx.length ? Math.max(...prx) : null,
        prXmax: res.prXmaxMm ?? null,
        sens: res.sensitivity283,
        max40: splAt(40, res.maxSpl),
        exc: ex.length ? Math.max(...ex) : NaN,
        xmax: res.xmaxMm,
        port: pv.length ? Math.max(...pv) : null,
      };
    };
    return [row(curLabel, '#38bdf8', r, spec, null), ...pinned.map((p) => row(p.pin.label, p.color, p.r, p.pin.box, p.pin.id))];
  });

  const anyPr = $derived(table.some((t) => t.prExc != null));
  const markers = $derived([
    ...(spec.kind === 'vented' || spec.kind === 'bp4' ? [{ x: spec.fbHz, label: 'tuning', color: '#a78bfa' }] : []),
    ...(spec.kind === 'bp6'
      ? [
          { x: spec.fbRearHz, label: 'rear tuning', color: '#a78bfa' },
          { x: spec.fbFrontHz, label: 'front tuning', color: '#a78bfa' },
        ]
      : []),
    ...(spec.kind === 'pr'
      ? [
          { x: prTune.fpHz, label: 'tuning', color: '#a78bfa' },
          { x: prTune.nullHz, label: 'PR null', color: '#64748b' },
        ]
      : []),
    ...(hpOn ? [{ x: hpHz, label: 'high-pass', color: '#f472b6' }] : []),
  ]);

  const GRAPHS: [Graph, string][] = [
    ['spl', 'Loudness'],
    ['excursion', 'Cone travel'],
    ['port', 'Port speed'],
    ['maxspl', 'Max output'],
    ['impedance', 'Impedance'],
    ['delay', 'Group delay'],
  ];
  const HELP: Record<Graph, string> = {
    spl: 'Sound level 1 m in front (pick where it plays above: a big baffle is the datasheet condition; on a stand adds the baffle step from this cabinet\'s real front; near a wall or in a corner adds those reflections). The dashed line is the standard 2.83 V reference; the solid line is your amplifier power, including any high-pass filter.',
    excursion: 'How far the cone moves (peak). Above the red Xmax line distortion climbs fast; far above it the voice coil can hit the back plate. Vented and passive-radiator boxes keep the cone still near tuning but let it flap freely below — that is what the high-pass filter is for. A passive radiator’s own travel (violet) has its own Xmax.',
    port: 'Peak air speed in the port. Above ~17 m/s you start to hear chuffing and the port compresses; above ~25–30 m/s it is clearly audible. Fixes: a bigger (or second) port, flared ends, or less power below tuning. In a bandpass all the sound comes out of the port(s), so they work hard across the whole passband.',
    maxspl: 'The loudest this box can play at each frequency before the cone reaches Xmax, the amplifier reaches the woofer’s power rating, a port gets noisy or a passive radiator reaches its Xmax, whichever comes first. Where it dips, the bass is excursion-limited.',
    impedance: 'What your amplifier sees. Sealed boxes have one bass peak; vented and passive-radiator boxes have two with a dip at the tuning frequency; a 6th-order bandpass has three. Keep the minimum above what your amp is rated for.',
    delay: 'How much the bass lags behind the rest of the sound. Under ~10–20 ms at 40 Hz is generally inaudible; vented and high-Q boxes have more than sealed, low-Q ones.',
  };
</script>

<section class="card" data-testid="box-modeler">
  <h2>Box modeler</h2>
  <p class="sub">
    Simulates the {woofer.brand} {woofer.model}{N > 1 ? ` (×${N}, wired in parallel)` : ''} in {alt ? 'a' : 'this'} {boxNetL(spec).toFixed(0)} L {KIND_NAME[spec.kind]} box, like WinISD: loudness, cone travel{spec.kind === 'pr' ? ', radiator travel' : ''}{vented ? ', port speed' : ''}, impedance and timing, at a power you choose.
  </p>

  <div class="chips" role="group" aria-label="Box type to model">
    <span class="small muted" style="align-self:center">Box:</span>
    {#each KINDS as [k, lbl]}
      <button class="chip" class:on={kind === k} aria-pressed={kind === k} onclick={() => pickKind(k)}>{lbl}</button>
    {/each}
  </div>
  {#if !alt}
    <p class="small muted">Sealed and vented follow the woodworking plan above (switching here switches the plan). Passive-radiator and bandpass boxes are modelled here only.</p>
  {:else if spec.kind === 'pr'}
    <div class="boxctl" data-testid="pr-controls">
      <div class="field">
        <label for="bm-pr">Radiator</label>
        <select id="bm-pr" value={prDev.id} onchange={(e) => setPr({ id: (e.currentTarget as HTMLSelectElement).value })}>
          {#each PR_PRESETS as p}
            <option value={p.id}>{p.name}{p.id === prSug.pr.id ? ' — suggested' : ''}</option>
          {/each}
        </select>
        <span class="hint">Sd {prDev.sdCm2} cm², Mms {prDev.mmsG} g, Cms {prDev.cmsMmPerN} mm/N, Xmax {prDev.xmaxMm} mm — generic values; use your radiator's datasheet when you buy one.</span>
      </div>
      <div class="chips">
        <button class="chip" class:on={prN === 1} onclick={() => setPr({ count: 1 })}>1 radiator</button>
        <button class="chip" class:on={prN === 2} onclick={() => setPr({ count: 2 })}>2 radiators</button>
      </div>
      <div class="field">
        <label for="bm-prv">Net volume</label>
        <span class="val">{prVol.toFixed(1)} L</span>
        <input id="bm-prv" type="range" min="2" max={Math.max(150, Math.round(box.netVolumeL * 3))} step="0.5" value={prVol} oninput={(e) => setPr({ netL: num(e) })} />
      </div>
      <div class="field">
        <label for="bm-prf">Tuning (Fp)</label>
        <span class="val">{prTune.fpHz.toFixed(0)} Hz</span>
        <span class="hint">
          {prTune.addedMassG.toFixed(0)} g added to {prN > 1 ? 'each radiator' : 'the radiator'} · response null at {prTune.nullHz.toFixed(0)} Hz (the loaded radiator's own resonance)
        </span>
        <input id="bm-prf" type="range" min="15" max="90" step="1" value={prFp} oninput={(e) => setPr({ fp: num(e) })} />
      </div>
      {#if !prTune.reachable}
        <p class="small warn-text">This radiator is too heavy to tune that high in {prVol.toFixed(0)} L — with no added mass it lands at {prTune.fpHz.toFixed(0)} Hz. Use a lighter or stiffer radiator, or a smaller box.</p>
      {:else if prTune.overMax}
        <p class="small warn-text">{prTune.addedMassG.toFixed(0)} g is more than a typical {prDev.name?.split(' ')[0]} radiator takes ({prDev.maxAddedMassG} g) — use a bigger radiator, two, or a larger box.</p>
      {/if}
    </div>
  {:else if bpCur && (spec.kind === 'bp4' || spec.kind === 'bp6')}
    {@const sp = spec}
    <div class="boxctl" data-testid="bp-controls">
      <div class="field">
        <label for="bm-lo">Passband from</label>
        <span class="val">{target.lo}–{target.hi} Hz</span>
        <input id="bm-lo" type="range" min="15" max="150" step="1" value={target.lo} oninput={(e) => setTarget(num(e), target.hi)} />
      </div>
      <div class="field">
        <label for="bm-hi">Passband to</label>
        <input id="bm-hi" type="range" min="40" max="300" step="1" value={target.hi} oninput={(e) => setTarget(target.lo, num(e))} />
      </div>
      <div class="pinbar">
        <button class="chip" onclick={designBp} disabled={designing} data-testid="bp-design">{designing ? 'Designing…' : 'Design for this passband'}</button>
        {#if bpCur.design}
          <span class="small muted">
            {bpCur.edited ? 'Edited from a design' : 'Designed'} for {bpCur.design.fLowHz.toFixed(0)}–{bpCur.design.fHighHz?.toFixed(0) ?? '?'} Hz (−3 dB){bpCur.design.gainDb != null ? `, ${bpCur.design.gainDb >= 0 ? '+' : ''}${bpCur.design.gainDb.toFixed(1)} dB over the bare woofer` : ''}{bpCur.design.s != null ? ` · S ${bpCur.design.s.toFixed(2)}, Qbp ${bpCur.design.qbp?.toFixed(2)}` : ''}
          </span>
        {/if}
      </div>
      {#if bpCur.design && !bpCur.edited}
        {#each bpCur.design.notes as n}
          <p class="small warn-text">{n}</p>
        {/each}
      {/if}
      <div class="field">
        <label for="bm-vr">Rear chamber{sp.kind === 'bp4' ? ' (sealed)' : ''}</label>
        <span class="val">{sp.rearL.toFixed(1)} L</span>
        <input id="bm-vr" type="range" min="0.5" max={Math.max(100, Math.round(sp.rearL * 2), Math.round(woofer.vasL * N * 3))} step="0.5" value={sp.rearL} oninput={(e) => setBp({ rearL: num(e) })} />
      </div>
      <div class="field">
        <label for="bm-vf">Front chamber (ported)</label>
        <span class="val">{sp.frontL.toFixed(1)} L</span>
        <input id="bm-vf" type="range" min="0.5" max={Math.max(100, Math.round(sp.frontL * 2), Math.round(woofer.vasL * N * 3))} step="0.5" value={sp.frontL} oninput={(e) => setBp({ frontL: num(e) })} />
      </div>
      {#if sp.kind === 'bp4'}
        <div class="field">
          <label for="bm-fb">Front tuning</label>
          <span class="val">{sp.fbHz.toFixed(0)} Hz</span>
          <input id="bm-fb" type="range" min="15" max="250" step="1" value={sp.fbHz} oninput={(e) => setBp({ fbHz: num(e) })} />
        </div>
        <div class="field">
          <label for="bm-pd">Port diameter</label>
          <span class="val">{dia(sp.portAreaM2)} mm</span>
          <span class="hint">{portLens[0].len > 10 ? `${portLens[0].len.toFixed(0)} mm long` : 'too short to tune this low — use a smaller port'}{portLens[0].len > 700 ? ' — too long to fit; use a slot port or a bigger chamber' : ''}</span>
          <input id="bm-pd" type="range" min="30" max="250" step="1" value={dia(sp.portAreaM2)} oninput={(e) => setBp({ portAreaM2: area(num(e)) })} />
        </div>
      {:else}
        <div class="field">
          <label for="bm-fbr">Rear tuning</label>
          <span class="val">{sp.fbRearHz.toFixed(0)} Hz</span>
          <input id="bm-fbr" type="range" min="12" max="200" step="1" value={sp.fbRearHz} oninput={(e) => setBp({ fbRearHz: num(e) })} />
        </div>
        <div class="field">
          <label for="bm-fbf">Front tuning</label>
          <span class="val">{sp.fbFrontHz.toFixed(0)} Hz</span>
          <input id="bm-fbf" type="range" min="15" max="300" step="1" value={sp.fbFrontHz} oninput={(e) => setBp({ fbFrontHz: num(e) })} />
        </div>
        <div class="field">
          <label for="bm-pdf">Front port diameter</label>
          <span class="val">{dia(sp.frontPortAreaM2)} mm</span>
          <span class="hint">{portLens[0].len > 10 ? `${portLens[0].len.toFixed(0)} mm long` : 'too short to tune this low — use a smaller port'}{portLens[0].len > 700 ? ' — too long to fit' : ''}</span>
          <input id="bm-pdf" type="range" min="30" max="250" step="1" value={dia(sp.frontPortAreaM2)} oninput={(e) => setBp({ frontPortAreaM2: area(num(e)) })} />
        </div>
        <div class="field">
          <label for="bm-pdr">Rear port diameter</label>
          <span class="val">{dia(sp.rearPortAreaM2)} mm</span>
          <span class="hint">{portLens[1].len > 10 ? `${portLens[1].len.toFixed(0)} mm long` : 'too short to tune this low — use a smaller port'}{portLens[1].len > 700 ? ' — too long to fit' : ''}</span>
          <input id="bm-pdr" type="range" min="30" max="250" step="1" value={dia(sp.rearPortAreaM2)} oninput={(e) => setBp({ rearPortAreaM2: area(num(e)) })} />
        </div>
      {/if}
      <p class="small muted">All the sound comes out of the port{sp.kind === 'bp6' ? 's' : ''}: the woofer sits sealed inside{sp.kind === 'bp4' ? ', between a sealed rear chamber and a ported front one' : ', between two ported chambers'}. Total {boxNetL(sp).toFixed(1)} L net, plus the woofer, bracing and ports.</p>
    </div>
  {/if}

  <div class="field">
    <label for="bm-power">Amplifier power</label>
    <span class="val">{fmtW(powerW)} W</span>
    <span class="hint">{r.voltsRms.toFixed(1)} V into {r.nominalOhm.toFixed(r.nominalOhm % 1 ? 1 : 0)} Ω nominal · woofer{N > 1 ? 's' : ''} rated {rated} W</span>
    <input id="bm-power" type="range" min="0" max="1" step="0.005" value={pos} oninput={(e) => (powerPos = +(e.currentTarget as HTMLInputElement).value)} />
  </div>
  <label class="toggle">
    <input type="checkbox" checked={hpOn} onchange={(e) => toggleHp((e.currentTarget as HTMLInputElement).checked)} />
    High-pass (subsonic) filter <span class="muted small">— DSP, receiver “speaker size” setting, or a cap in front of the amp</span>
  </label>
  {#if hpOn}
    <div class="field">
      <label for="bm-hp">High-pass at</label>
      <span class="val">{hpHz} Hz</span>
      <input id="bm-hp" type="range" min="10" max="120" step="1" bind:value={hpHz} />
    </div>
    <div class="chips">
      <button class="chip" class:on={hpOrder === 2} onclick={() => (hpOrder = 2)}>12 dB/oct</button>
      <button class="chip" class:on={hpOrder === 4} onclick={() => (hpOrder = 4)}>24 dB/oct</button>
    </div>
  {/if}

  <div class="chips">
    <span class="small muted" style="align-self:center">Where it plays:</span>
    {#each [['half', 'On a big baffle (datasheet)'], ['free', 'On a stand (baffle step)'], ['wall', 'Near a wall'], ['corner', 'In a corner']] as [k, lbl]}
      <button class="chip" class:on={placement === k} onclick={() => (placement = k as Placement)}>{lbl}</button>
    {/each}
  </div>
  {#if vented}
    <div class="field">
      <label for="bm-noise">Port noise threshold</label>
      <span class="val">{noise} m/s</span>
      <span class="hint">~17 m/s for a plain tube, ~25 for flared ends; also limits max output.</span>
      <input id="bm-noise" type="range" min="10" max="35" step="1" value={noise} oninput={(e) => (noiseOverride = +(e.currentTarget as HTMLInputElement).value)} />
    </div>
  {/if}
  <div class="chips graphs" role="tablist" aria-label="Box modeler graph">
    {#each GRAPHS.filter(([g]) => g !== 'port' || vented || pinned.some((p) => hasPort(p.pin.box))) as [g, lbl]}
      <button class="chip" role="tab" aria-selected={graph === g} class:on={graph === g} onclick={() => (graph = g)}>{lbl}</button>
    {/each}
  </div>
  <MiniChart
    series={chart.series}
    xMin={10}
    xMax={500}
    yMin={chart.yMin}
    yMax={chart.yMax}
    yStep={chart.yStep}
    yLabel={chart.yLabel}
    xTicks={[10, 20, 50, 100, 200, 500]}
    {markers}
    height={210}
    xBand={graph === 'spl' && splCmp ? { x0: splCmp.band[0], x1: splCmp.band[1], label: 'level match' } : null}
  />
  {#if graph === 'spl'}
    <MeasOverlayControl sel={home.measOverlay.box} kind="spl" cmp={splCmp} alignNote="compared with the solid line; a near-field woofer or far-field speaker measurement in that band is the usual reference" testid="box-overlay" />
  {:else if graph === 'impedance'}
    <MeasOverlayControl sel={home.measOverlay.boxZ} kind="impedance" testid="box-overlay-z" />
  {/if}
  <p class="small muted">{pinned.length && (graph === 'spl' || graph === 'maxspl') ? (graph === 'spl' ? 'Sound level 1 m in front, on a large baffle (half space), no room — every design at the same amplifier power and filter.' : HELP.maxspl.replace('this box', 'each box')) : HELP[graph]}</p>

  <div class="pinbar">
    <button class="chip" onclick={pinCurrent} disabled={alreadyPinned || home.modelerPins.length >= MAX_PINS} data-testid="pin-design">
      📌 {alreadyPinned ? 'Pinned' : 'Pin this design to compare'}
    </button>
    <span class="small muted">
      {#if home.modelerPins.length === 0}
        Pin it, then change the woofer or box above — both show on the graphs.
      {:else if home.modelerPins.length >= MAX_PINS}
        {MAX_PINS} pins max — remove one to pin another.
      {:else}
        Pinned designs are run at the same {fmtW(powerW)} W{hpOn ? ` and ${hpHz} Hz high-pass` : ''}.
      {/if}
    </span>
  </div>
  {#if pinned.length}
    <div class="cmp-wrap">
      <table class="cmp" data-testid="compare-table">
        <thead>
          <tr><th>Design</th><th>Net</th><th>F3</th><th>Sens.</th><th>Max @40 Hz</th><th>Peak travel</th>{#if anyPr}<th>PR travel</th>{/if}<th>Port</th><th></th></tr>
        </thead>
        <tbody>
          {#each table as t}
            <tr>
              <td><i class="sw" style:background={t.color}></i>{t.id ? t.label : 'This design'}</td>
              <td>{t.netL.toFixed(0)} L</td>
              <td>{t.f3.toFixed(0)}{t.f3High != null ? `–${t.f3High.toFixed(0)}` : ''} Hz</td>
              <td>{t.sens.toFixed(1)} dB</td>
              <td>{t.max40.toFixed(0)} dB</td>
              <td class:over={t.exc > t.xmax}>{t.exc.toFixed(1)} / {t.xmax} mm</td>
              {#if anyPr}<td class:over={t.prExc != null && t.prXmax != null && t.prExc > t.prXmax}>{t.prExc == null ? '—' : `${t.prExc.toFixed(1)} / ${t.prXmax} mm`}</td>{/if}
              <td class:over={t.port != null && t.port > PORT_LIMIT}>{t.port == null ? '—' : `${t.port.toFixed(0)} m/s`}</td>
              <td>{#if t.id}<button class="x" aria-label={`Remove ${t.label}`} onclick={() => unpin(t.id!)}>×</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="stats">
    <div class="stat"><div class="k">Sensitivity</div><div class="v">{r.sensitivity283.toFixed(1)} dB</div><div class="s">2.83 V / 1 m, half space{isBandpass(spec) ? ' · passband peak' : ''}</div></div>
    <div class="stat"><div class="k">At {fmtW(powerW)} W</div><div class="v">{splAt(100, r.spl).toFixed(0)} dB</div><div class="s">at 100 Hz · {splAt(40, r.spl).toFixed(0)} dB at 40 Hz</div></div>
    <div class="stat">
      <div class="k">Peak cone travel</div>
      <div class="v" class:over={excPeak.y > r.xmaxMm}>{excPeak.y.toFixed(1)} mm</div>
      <div class="s">at {fmtHz(excPeak.f)} · Xmax {r.xmaxMm} mm</div>
    </div>
    {#if prPeak && r.prXmaxMm != null}
      <div class="stat">
        <div class="k">Peak radiator travel</div>
        <div class="v" class:over={prPeak.y > r.prXmaxMm}>{prPeak.y.toFixed(1)} mm</div>
        <div class="s">at {fmtHz(prPeak.f)} · Xmax {r.prXmaxMm} mm</div>
      </div>
    {/if}
    {#if portPeak}
      <div class="stat">
        <div class="k">Peak port speed</div>
        <div class="v" class:over={portPeak.y > PORT_LIMIT}>{portPeak.y.toFixed(0)} m/s</div>
        <div class="s">at {fmtHz(portPeak.f)}</div>
      </div>
    {/if}
    <div class="stat"><div class="k">Lowest impedance</div><div class="v">{r.minImpedance.ohm.toFixed(1)} Ω</div><div class="s">{r.minImpedance.hz > 400 ? 'higher up, ≈ voice-coil Re' : `at ${fmtHz(r.minImpedance.hz)}`}</div></div>
    <div class="stat"><div class="k">Group delay</div><div class="v">{splAt(40, r.groupDelayMs).toFixed(1)} ms</div><div class="s">at 40 Hz</div></div>
  </div>

  <ul class="callouts">
    {#if excOver}
      <li class="bad">
        At {fmtW(powerW)} W the cone goes past Xmax between {fmtHz(excOver[0])} and {fmtHz(excOver[1])}.
        {#if unloadHz && !hpOn}Turn on a high-pass just below tuning ({Math.round(unloadHz * 0.8)} Hz or so) — that's where a {spec.kind === 'pr' ? 'passive-radiator' : 'vented'} box unloads.{:else}Use less power, a higher high-pass, or pair it with a subwoofer and cross over above {fmtHz(excOver[1])}.{/if}
      </li>
    {:else}
      <li class="good">Cone stays within Xmax everywhere at {fmtW(powerW)} W{hpOn ? ` with the ${hpHz} Hz high-pass` : ''}.</li>
    {/if}
    {#if prOver}
      <li class="bad">The passive radiator goes past its Xmax ({r.prXmaxMm} mm) between {fmtHz(prOver[0])} and {fmtHz(prOver[1])} — use two radiators, a bigger one, or a high-pass just below tuning.</li>
    {/if}
    {#if portOver}
      <li class="warn">Port air reaches {portPeak?.y.toFixed(0)} m/s ({fmtHz(portOver[0])}–{fmtHz(portOver[1])}); expect audible chuffing when played this loud. A larger-diameter or flared port helps.</li>
    {/if}
    {#if r.minImpedance.ohm < 3.2}
      <li class="warn">Impedance dips to {r.minImpedance.ohm.toFixed(1)} Ω — check your amplifier is happy driving that (many are only rated to 4 Ω).</li>
    {/if}
    {#if r.mech.assumed.length}
      <li>The datasheet doesn't give {r.mech.assumed.join(', ')}; the curves use a typical value.</li>
    {/if}
  </ul>
  <p class="small muted">
    Model: Thiele/Small lumped circuit (voice coil, cone, box, port, box leakage Q<sub>L</sub>{spec.kind === 'vented' ? ` ${spec.ql ?? 7}` : ''}{spec.kind === 'pr' ? '; the passive radiator is a second mass–spring–damper on the box (Hurlburt, JAES 2000)' : ''}{isBandpass(spec) ? '; bandpass chambers in series with the cone, sound from the port(s) only (Dickason’s Loudspeaker Design Cookbook alignment for the 4th-order design)' : ''}). It matches the textbook Small alignment curves within 0.2 dB and the woofers' datasheet sensitivities within ~1.5 dB. No room, no baffle step, no cone breakup — the Room tab adds the room. Voice-coil inductance isn't in the datasheets we have, so impedance above a few hundred Hz reads low.
  </p>
</section>

<style>
  .pinbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin: 8px 0;
  }
  .pinbar .chip:disabled {
    opacity: 0.55;
  }
  .cmp-wrap {
    overflow-x: auto;
    margin-bottom: 10px;
  }
  .cmp {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    white-space: nowrap;
  }
  .cmp th {
    text-align: left;
    color: var(--text-2);
    font-weight: 600;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
  }
  .cmp td {
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
  }
  .cmp td:first-child {
    white-space: normal;
    min-width: 130px;
  }
  .sw {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: 6px;
    vertical-align: middle;
  }
  .x {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    width: 26px;
    height: 26px;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
  }
  .graphs {
    margin-top: 12px;
  }
  .over {
    color: #f87171 !important;
  }
  .boxctl {
    border-left: 2px solid var(--border);
    padding-left: 10px;
    margin: 6px 0 10px;
  }
  .boxctl select {
    max-width: 100%;
  }
  .warn-text {
    color: #fbbf24;
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 14px;
    flex-wrap: wrap;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
