<script lang="ts">
  import { onDestroy } from 'svelte';
  import { home, saveHome } from './homeState.svelte';
  import VenueSwitch from './VenueSwitch.svelte';
  import Outdoor3D from './Outdoor3D.svelte';
  import { buildRig, DEFAULT_OUTDOOR, type SubArray, type SubModel } from './outdoor';
  import {
    ARRIVAL_LEGEND,
    arrivalColor,
    arrivalMap,
    bassLevelMap,
    coverageMap,
    imageMapLR,
    interferenceField,
  } from './system';
  import { cellsCanvas, fieldCanvas } from './mapImage';
  import { SPEED_OF_SOUND } from './roomAcoustics';

  let { subModel = null }: { subModel?: SubModel | null } = $props();
  const o = $derived(home.outdoor);
  const rig = $derived(buildRig(home.outdoor, subModel));
  $effect(() => {
    JSON.stringify(home.outdoor) + home.outdoorMap;
    saveHome();
  });

  const G = 0.5; // map grid, m
  const Z = 1.6; // standing ear height
  const crowd = $derived(rig.crowd);
  const W = $derived(rig.venue.widthM);
  const D = $derived(rig.venue.depthM);
  const B = $derived(rig.stageY);
  const inCrowd = (x: number, y: number) => x >= crowd.x0 && x <= crowd.x1 && y >= crowd.y0 && y <= crowd.y1;
  const pct = (a: number[], q: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  };

  // ---- maps ------------------------------------------------------------------
  const coverage = $derived(home.outdoorMap === 'coverage' ? coverageMap(rig.venue, rig.speakers, Z, G, crowd) : null);
  const bass = $derived.by(() => {
    if (home.outdoorMap !== 'bass') return null;
    const m = bassLevelMap(rig.venue, rig.speakers, Z, o.xoverHz, 35, 100, G);
    const vals = m.cells.filter((c) => inCrowd(c.x, c.y)).map((c) => c.db);
    const med = pct(vals, 0.5);
    const near = (c: { x: number; y: number }, y0: number, y1: number) => Math.abs(c.x - W / 2) < 3 && c.y >= y0 && c.y <= y1;
    const avg = (a: number[]) => 10 * Math.log10(a.reduce((p, q) => p + 10 ** (q / 10), 0) / Math.max(1, a.length));
    const front = avg(m.cells.filter((c) => near(c, B + 5, B + 9)).map((c) => c.db));
    const back = avg(m.cells.filter((c) => near(c, B - 9, B - 5)).map((c) => c.db));
    return { ...m, med, spread: pct(vals, 0.95) - pct(vals, 0.05), rearRejection: front - back };
  });
  const L = $derived(rig.speakers.find((s) => s.id === 'L')!);
  const R = $derived(rig.speakers.find((s) => s.id === 'R')!);
  const image = $derived(home.outdoorMap === 'image' ? imageMapLR(rig.venue, L.pos, R.pos, Z, G, B + 12) : null);
  const arrival = $derived(home.outdoorMap === 'arrival' ? arrivalMap(rig.venue, rig.speakers, Z, G, crowd) : null);
  let iFreq = $state(63);
  let animating = $state(false);
  let iView = $state<'level' | 'wave'>('level');
  const field = $derived(
    home.outdoorMap === 'interference' ? interferenceField(rig.venue, rig.speakers, Z, iFreq, o.xoverHz, { ground: true, maxCells: 120000 }) : null
  );
  const tooFine = $derived(field ? field.grid > SPEED_OF_SOUND / iFreq / 4 : false);

  const covColor = (db: number) => {
    const t = Math.min(Math.max(((coverage?.max ?? 0) - db) / 12, 0), 1);
    return `hsl(${140 - 140 * t} 70% 45%)`;
  };
  const bassColor = (db: number) => {
    const v = db - (bass?.med ?? 0);
    if (v >= 0) return `hsl(${140 - Math.min(v / 6, 1) * 90} 75% ${45 + Math.min(v / 6, 1) * 8}%)`;
    const t = Math.min(-v / 15, 1);
    return `hsl(${140 + t * 100} 60% ${45 - t * 20}%)`;
  };
  const imgColor = (ms: number) => `hsl(${140 - 140 * Math.min(ms / 1.2, 1)} 70% 45%)`;

  const mapCanvas = $derived.by(() => {
    if (home.outdoorMap === 'coverage' && coverage) return cellsCanvas(coverage.cells.map((c) => ({ x: c.x, y: c.y, v: c.db })), G, W, D, covColor);
    if (home.outdoorMap === 'bass' && bass) return cellsCanvas(bass.cells.map((c) => ({ x: c.x, y: c.y, v: c.db })), G, W, D, bassColor);
    if (home.outdoorMap === 'image' && image) return cellsCanvas(image.cells.map((c) => ({ x: c.x, y: c.y, v: c.ms })), G, W, D, imgColor);
    if (home.outdoorMap === 'arrival' && arrival) return cellsCanvas(arrival.cells, G, W, D, arrivalColor);
    if (home.outdoorMap === 'interference' && field) return fieldCanvas(field, iView, 0, document.createElement('canvas'));
    return null;
  });
  let mapVersion = $state(0);
  let mapUrl = $state('');
  $effect(() => {
    mapUrl = mapCanvas ? mapCanvas.toDataURL() : '';
  });
  let view = $state<'3d' | 'plan'>('3d');
  let raf = 0;
  $effect(() => {
    if (!animating || !field || !mapCanvas) return;
    const f = field;
    const cv = mapCanvas;
    const t0 = performance.now();
    let n = 0;
    const loop = () => {
      fieldCanvas(f, 'wave', -((((performance.now() - t0) / 1800) % 1) * Math.PI * 2), cv);
      mapVersion++;
      if (view === 'plan' && n++ % 3 === 0) mapUrl = cv.toDataURL();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
  // slow-motion wavefronts
  let tWave = $state(0);
  let playing = $state(false);
  let wraf = 0;
  const maxT = $derived(Math.max(...rig.speakers.map((s) => s.delayMs ?? 0)) + 70);
  function play() {
    view = 'plan';
    playing = true;
    const t0 = performance.now();
    const loop = () => {
      tWave = (performance.now() - t0) / 25; // 25× slow motion
      if (tWave < maxT && playing) wraf = requestAnimationFrame(loop);
      else playing = false;
    };
    wraf = requestAnimationFrame(loop);
  }
  onDestroy(() => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(wraf);
  });

  // ---- picking ---------------------------------------------------------------
  let picked = $state<string | null>(null);
  const pickedSpk = $derived(rig.speakers.find((s) => s.id === picked) ?? null);

  // ---- helpers -----------------------------------------------------------------
  const sc = 16; // svg px per metre
  const ROLE_COLOR: Record<string, string> = { mains: '#38bdf8', fill: '#fb923c', sub: '#a78bfa', monitor: '#94a3b8' };
  function setTowerDelay(id: string, v: number) {
    home.outdoor.towerDelayOverride = { ...home.outdoor.towerDelayOverride, [id]: v };
  }
  function autoTower(id: string) {
    const { [id]: _drop, ...rest } = home.outdoor.towerDelayOverride;
    void _drop;
    home.outdoor.towerDelayOverride = rest;
  }
  const towers = $derived(rig.speakers.filter((s) => s.role === 'fill'));
  const f1 = (n: number | undefined) => (n ?? 0).toFixed(1);
</script>

<div class="split">
  <div class="vis">
    <section class="card vis-card">
      <VenueSwitch />
      <div class="vis-hd">
        <h2>Clearing · {o.widthM} × {o.crowdDepthM} m crowd</h2>
        <div class="seg">
          <button class:on={view === '3d'} onclick={() => (view = '3d')}>3D</button>
          <button class:on={view === 'plan'} onclick={() => (view = 'plan')}>Top view</button>
        </div>
      </div>
      <div class="seg maps" role="group" aria-label="Outdoor map">
        <button class:on={home.outdoorMap === 'coverage'} onclick={() => (home.outdoorMap = 'coverage')}>Loudness coverage</button>
        <button class:on={home.outdoorMap === 'bass'} onclick={() => (home.outdoorMap = 'bass')}>Bass evenness</button>
        <button class:on={home.outdoorMap === 'image'} onclick={() => (home.outdoorMap = 'image')}>Stereo image</button>
        <button class:on={home.outdoorMap === 'arrival'} onclick={() => (home.outdoorMap = 'arrival')}>Arrival & delay</button>
        <button class:on={home.outdoorMap === 'interference'} onclick={() => (home.outdoorMap = 'interference')}>Interference</button>
      </div>
      <p class="sub maplegend">
        {#if home.outdoorMap === 'coverage' && coverage}
          Mid/high level (1–4 kHz, tops + towers + fills, power sum) vs the loudest spot in the crowd:
          <span class="g">green = within 2 dB</span> → <span class="r">red = 12 dB down</span>. Crowd spread <b>{coverage.spreadDb.toFixed(1)} dB</b>.
        {:else if home.outdoorMap === 'bass' && bass}
          Bass level (35–100 Hz, coherent sum of all subs with their delays, polarity and ground reflection) vs the crowd median:
          <span class="g">green = even</span>, <span class="y">yellow = hot</span>, <span class="b">blue = weak</span>. Crowd spread
          <b>{bass.spread.toFixed(1)} dB</b>; behind the stage <b>{bass.rearRejection.toFixed(1)} dB</b> quieter than the same distance in front.
        {:else if home.outdoorMap === 'image' && image}
          Left/right arrival-time difference: <span class="g">green &lt; 0.3 ms</span> centred image, <span class="r">red &gt; 1 ms</span>
          collapsed to one side. 12 m out, the centred strip is <b>{image.sweetWidthM.toFixed(1)} m</b> wide — outdoors with tops
          {o.topsSpacingM} m apart, most of the crowd hears mostly one side; that's normal for PA.
        {:else if home.outdoorMap === 'arrival' && arrival}
          Does the sound still come from the stage? Towers are judged against the stage system (tops + front fills).
          <b>{(arrival.goodFraction * 100).toFixed(0)} %</b> of the crowd area is fine.
        {:else if field}
          {iFreq} Hz from every speaker at once (delays, polarity, crossover, ground bounce).
          {iView === 'level' ? 'Yellow = adds, dark blue = cancels.' : 'Red/blue = pressure; watch the wavefronts.'}
          Deep dips cover <b>{(field.deepDipFraction * 100).toFixed(0)} %</b> of the area.
          {#if tooFine}<span class="r">At this frequency the pattern is finer than the map — try ≤ {Math.round(SPEED_OF_SOUND / field.grid / 4)} Hz.</span>{/if}
        {/if}
      </p>
      {#if home.outdoorMap === 'arrival'}
        <div class="ctl-panel">
          <div class="legend-chips">{#each Object.values(ARRIVAL_LEGEND) as l}<span><i style:background={l.color}></i>{l.label}</span>{/each}</div>
          <button class="btn" onclick={play} disabled={playing}>▶ Play arrivals (slow-mo)</button>
        </div>
      {:else if home.outdoorMap === 'interference'}
        <div class="ctl-panel">
          <div class="field compact">
            <label for="oifreq">Frequency</label>
            <span class="val">{iFreq} Hz · λ = {(SPEED_OF_SOUND / iFreq).toFixed(1)} m</span>
            <input id="oifreq" type="range" min="25" max="400" step="1" bind:value={iFreq} />
          </div>
          <div class="chips">
            {#each [40, 50, 63, 80, 100, 125, 160, 250] as f}<button class="chip" class:on={iFreq === f} onclick={() => (iFreq = f)}>{f}</button>{/each}
          </div>
          <div class="opt-row">
            <div class="seg">
              <button class:on={iView === 'level' && !animating} onclick={() => { iView = 'level'; animating = false; }}>Loudness</button>
              <button class:on={iView === 'wave' || animating} onclick={() => (iView = 'wave')}>Wave</button>
            </div>
            <button class="btn" onclick={() => { animating = !animating; if (animating) iView = 'wave'; }}>{animating ? '❚❚ Pause' : '▶ Animate waves'}</button>
          </div>
        </div>
      {/if}
      {#if view === '3d'}
        <div class="vis-3d">
          <Outdoor3D {rig} {mapCanvas} {mapVersion} onPick={(id) => (picked = id)} />
        </div>
      {:else}
        <div class="svg-wrap plan-svg">
          <svg viewBox={`-20 -30 ${W * sc + 40} ${D * sc + 50}`} role="img" aria-label="Outdoor top view">
            <rect x="0" y="0" width={W * sc} height={D * sc} fill="#1d2e1a" />
            {#if mapUrl}<image href={mapUrl} x="0" y="0" width={W * sc} height={D * sc} preserveAspectRatio="none" opacity="0.85" />{/if}
            <rect x={rig.stage.x0 * sc} y={rig.stage.y0 * sc} width={(rig.stage.x1 - rig.stage.x0) * sc} height={(rig.stage.y1 - rig.stage.y0) * sc} fill="#3b3128" fill-opacity="0.75" stroke="#a8a29e" />
            <text x={(W / 2) * sc} y={(rig.stage.y0 + 1.2) * sc} text-anchor="middle" class="o-lbl">stage / DJ</text>
            <rect x={crowd.x0 * sc} y={crowd.y0 * sc} width={(crowd.x1 - crowd.x0) * sc} height={(crowd.y1 - crowd.y0) * sc} fill="none" stroke="#f472b6" stroke-dasharray="10 6" stroke-width="2" />
            <text x={(W / 2) * sc} y={(crowd.y1 - 0.6) * sc} text-anchor="middle" class="o-lbl pink">crowd</text>
            {#if home.outdoorMap === 'arrival' && (playing || tWave > 0)}
              <clipPath id="oclip"><rect x="0" y="0" width={W * sc} height={D * sc} /></clipPath>
              <g clip-path="url(#oclip)">
                {#each rig.speakers.filter((s) => s.role !== 'monitor' && !(s.role === 'sub' && s.invert)) as s}
                  {@const r = (SPEED_OF_SOUND * (tWave - (s.delayMs ?? 0))) / 1000}
                  {#if r > 0 && (s.role !== 'sub' || s.id.endsWith('1'))}
                    <circle cx={s.pos.x * sc} cy={s.pos.y * sc} r={r * sc} fill="none" stroke={ROLE_COLOR[s.role]} stroke-width="3" stroke-opacity="0.85" />
                  {/if}
                {/each}
              </g>
              <text x="8" y="22" class="o-lbl big">t = {tWave.toFixed(0)} ms</text>
            {/if}
            {#each rig.speakers as s}
              {@const rot = (Math.atan2(-s.aim.x, s.aim.y) * 180) / Math.PI}
              <g transform={`translate(${s.pos.x * sc} ${s.pos.y * sc}) rotate(${rot})`} role="button" tabindex="0" class="spk"
                onclick={() => (picked = s.id)} onkeydown={(e) => e.key === 'Enter' && (picked = s.id)}>
                <rect x={s.role === 'sub' ? (-rig.subCab.w * sc) / 2 : -5} y={s.role === 'sub' ? -rig.subCab.d * sc : -8} width={s.role === 'sub' ? rig.subCab.w * sc : 10} height={s.role === 'sub' ? rig.subCab.d * sc : 8}
                  fill={s.role === 'sub' ? (s.invert ? '#7c6bb8' : '#a78bfa') : ROLE_COLOR[s.role]} stroke="#0b1622" />
                {#if s.role !== 'sub'}<line x1="0" y1="0" x2="0" y2={s.role === 'mains' ? 70 : 40} stroke={ROLE_COLOR[s.role]} stroke-width="2" />{/if}
              </g>
              {#if s.role !== 'sub'}<text x={s.pos.x * sc + 8} y={s.pos.y * sc - 6} class="o-tag">{s.id}</text>{/if}
            {/each}
            <text x={(W / 2) * sc} y={-12} text-anchor="middle" class="o-lbl">behind the stage ↑ · crowd ↓</text>
          </svg>
        </div>
      {/if}
      {#if pickedSpk}
        <div class="info">
          <button class="x" aria-label="Close" onclick={() => (picked = null)}>✕</button>
          <b>{pickedSpk.id} · {pickedSpk.label}</b>
          <div class="sz">delay {f1(pickedSpk.delayMs)} ms · level {pickedSpk.gainDb !== undefined ? `${pickedSpk.gainDb >= 0 ? '+' : ''}${pickedSpk.gainDb.toFixed(1)} dB` : '0 dB'}{pickedSpk.invert ? ' · polarity INVERTED' : ''}{pickedSpk.mouthHpHz ? ` · horn mouth cut-off ≈ ${pickedSpk.mouthHpHz.toFixed(0)} Hz` : ''}</div>
          {#if pickedSpk.note}<div class="small">{pickedSpk.note}</div>{/if}
        </div>
      {/if}
    </section>
  </div>

  <div class="side">
    <section class="card">
      <h2>Venue</h2>
      <p class="sub">A dance party in a forest clearing: stage at one end, crowd in front, trees all round (no walls, so no room modes — the maps are about distance, timing and interference).</p>
      <div class="field">
        <label for="ow">Crowd area width</label><span class="val">{o.widthM} m ({Math.round(o.widthM * 3.28)} ft)</span>
        <input id="ow" type="range" min="12" max="60" step="1" bind:value={home.outdoor.widthM} />
      </div>
      <div class="field">
        <label for="od">Crowd depth from the stage</label><span class="val">{o.crowdDepthM} m ({Math.round(o.crowdDepthM * 3.28)} ft)</span>
        <input id="od" type="range" min="12" max="70" step="1" bind:value={home.outdoor.crowdDepthM} />
      </div>
      <button class="chip" onclick={() => (home.outdoor = { ...DEFAULT_OUTDOOR, towerDelayOverride: {} })}>↺ Defaults</button>
    </section>

    <section class="card">
      <h2>Sub array</h2>
      <p class="sub">
        {#if subModel}
          Your printed hybrid horn ({(rig.subCab.w * 1000).toFixed(0)} × {(rig.subCab.h * 1000).toFixed(0)} × {(rig.subCab.d * 1000).toFixed(0)} mm), simulated from its geometry, ground-stacked front-centre.
        {:else}
          Horn-loaded 18″ subs (the Lab's TerraHorn-18, 0.6 × 0.9 × 0.9 m), ground-stacked front-centre. Design your own printed horn in the Print tab.
        {/if}
      </p>
      <div class="chips">
        {#each [2, 4, 6, 8] as n}<button class="chip" class:on={o.subCount === n} onclick={() => (home.outdoor.subCount = n as 2 | 4 | 6 | 8)}>{n} subs</button>{/each}
      </div>
      <div class="chips">
        {#each [['broadside', 'Coupled block'], ['cardioid', 'Cardioid (CSA)'], ['endfire', 'End-fire']] as [id, lbl]}
          <button class="chip" class:on={o.subArray === id} onclick={() => (home.outdoor.subArray = id as SubArray)}>{lbl}</button>
        {/each}
      </div>
      <p class="small muted">
        {#if o.subArray === 'broadside'}
          All cabinets side by side and stacked, mouths touching: they act as one big horn mouth — more output and deeper
          reach — but they radiate almost as much bass behind the stage as in front.
        {:else if o.subArray === 'cardioid'}
          About a third of the cabinets sit on top facing <i>backwards</i>, polarity flipped and delayed by the cabinet depth.
          Behind the stage their sound cancels the front block; in front it adds. Quieter for the DJ and the neighbours.
        {:else}
          Cabinets in a line pointing at the crowd, each delayed by its spacing ÷ the speed of sound so the waves pile up
          going forward and smear out behind. Strong, broadband rear rejection; long footprint.
        {/if}
      </p>
      {#if o.subArray === 'endfire'}
        <div class="field">
          <label for="oes">Rank spacing</label><span class="val">{o.endfireSpacingM.toFixed(2)} m = {((o.endfireSpacingM * 1000) / SPEED_OF_SOUND).toFixed(2)} ms</span>
          <input id="oes" type="range" min="0.9" max="2.0" step="0.05" bind:value={home.outdoor.endfireSpacingM} />
        </div>
      {/if}
      <table class="tbl">
        <thead><tr><th>Group</th><th>Mouth cut-off</th></tr></thead>
        <tbody>
          {#each rig.subGroups as g}
            <tr><td>{g.label}</td><td>{Number.isFinite(g.mouthHz) ? `≈ ${g.mouthHz.toFixed(0)} Hz` : 'simulated'}</td></tr>
          {/each}
        </tbody>
      </table>
      <p class="small muted">
        Coupling: horn mouths that touch (and the ground under them) work as one bigger mouth. 1 cabinet ≈ 101 Hz, 2 ≈ 71 Hz,
        4 ≈ 50 Hz, 8 ≈ 36 Hz — estimated from the combined mouth size (ka = 1), the trend the Lab's full mutual-radiation
        model shows. Coupled cabinets also add coherently: +6 dB for each doubling.
      </p>
      <div class="field">
        <label for="osd">Sub delay vs tops</label>
        <span class="val">{f1(o.subDelayMs ?? rig.subDelayAutoMs)} ms {o.subDelayMs === null ? '(auto)' : ''}</span>
        <span class="hint">Auto: subs and tops arrive together {(rig.ref.y - B).toFixed(0)} m into the crowd.</span>
        <input id="osd" type="range" min="0" max="25" step="0.1" value={o.subDelayMs ?? rig.subDelayAutoMs} oninput={(e) => (home.outdoor.subDelayMs = +(e.target as HTMLInputElement).value)} />
      </div>
      {#if o.subDelayMs !== null}<button class="chip" onclick={() => (home.outdoor.subDelayMs = null)}>Auto ({f1(rig.subDelayAutoMs)} ms)</button>{/if}
      <div class="field">
        <label for="oxo">Sub / top crossover</label><span class="val">{o.xoverHz} Hz</span>
        <input id="oxo" type="range" min="70" max="140" step="5" bind:value={home.outdoor.xoverHz} />
      </div>
      {#each rig.notes as n}<p class="small muted">{n}</p>{/each}
    </section>

    <section class="card">
      <h2>Tops (left / right mains)</h2>
      <p class="sub">3-way horn tops for mids and highs on poles at the stage edge, angled down into the crowd.</p>
      <div class="field">
        <label for="ots">Spacing</label><span class="val">{o.topsSpacingM} m</span>
        <input id="ots" type="range" min="4" max={Math.min(30, o.widthM - 2)} step="0.5" bind:value={home.outdoor.topsSpacingM} />
      </div>
      <div class="field">
        <label for="oth">Height (acoustic centre)</label><span class="val">{o.topsHeightM.toFixed(1)} m</span>
        <span class="hint">Higher = less difference between front and back rows (inverse-square), but more ground-bounce delay.</span>
        <input id="oth" type="range" min="2" max="6" step="0.1" bind:value={home.outdoor.topsHeightM} />
      </div>
      <p class="small muted">Tilt: {L ? ((-Math.asin(L.aim.z) * 180) / Math.PI).toFixed(1) : 0}° down, toed in {L ? Math.abs((Math.atan2(L.aim.x, L.aim.y) * 180) / Math.PI).toFixed(0) : 0}°, aimed {(Math.min(o.crowdDepthM * 0.55, 25)).toFixed(0)} m out.</p>
    </section>

    <section class="card">
      <h2>Delay / fill towers</h2>
      <div class="chips">
        {#each [0, 2, 4] as n}<button class="chip" class:on={o.towerCount === n} onclick={() => (home.outdoor.towerCount = n as 0 | 2 | 4)}>{n === 0 ? 'None' : n === 2 ? '2 at the back' : '2 back + 2 sides'}</button>{/each}
      </div>
      {#if o.towerCount}
        <div class="field">
          <label for="otd">Back towers from the stage</label><span class="val">{o.towerDistM} m</span>
          <input id="otd" type="range" min="10" max={Math.max(12, o.crowdDepthM - 4)} step="1" bind:value={home.outdoor.towerDistM} />
        </div>
        <div class="field">
          <label for="otz">Tower height</label><span class="val">{o.towerHeightM.toFixed(1)} m</span>
          <input id="otz" type="range" min="2.5" max="6" step="0.1" bind:value={home.outdoor.towerHeightM} />
        </div>
        <div class="field">
          <label for="oth2">Haas offset (added to every tower's alignment delay)</label><span class="val">{o.towerHaasMs} ms</span>
          <span class="hint">5–15 ms keeps the sound "on the stage"; 0 = pure time alignment.</span>
          <input id="oth2" type="range" min="0" max="25" step="1" bind:value={home.outdoor.towerHaasMs} />
        </div>
        <div class="field">
          <label for="otg">Tower level</label>
          <span class="val">{o.towerGainDb === null ? 'auto (level-matched)' : `${o.towerGainDb} dB`}</span>
          <input id="otg" type="range" min="-20" max="6" step="0.5" value={o.towerGainDb ?? towers[0]?.gainDb ?? 0} oninput={(e) => (home.outdoor.towerGainDb = +(e.target as HTMLInputElement).value)} />
        </div>
        {#if o.towerGainDb !== null}<button class="chip" onclick={() => (home.outdoor.towerGainDb = null)}>Auto level</button>{/if}
      {/if}
      {#if towers.length}
        <h3>Per-speaker delays</h3>
        {#each towers as t}
          <div class="field">
            <label for={`td-${t.id}`}>{t.id} · {t.label}</label>
            <span class="val">{f1(t.delayMs)} ms{o.towerDelayOverride[t.id] === undefined ? ' (auto)' : ''}</span>
            <span class="hint">{t.note}</span>
            <input id={`td-${t.id}`} type="range" min="0" max={Math.ceil(((t.autoDelayMs ?? 0) + 40) / 10) * 10} step="0.5" value={t.delayMs} oninput={(e) => setTowerDelay(t.id, +(e.target as HTMLInputElement).value)} />
          </div>
          {#if o.towerDelayOverride[t.id] !== undefined}<button class="chip" onclick={() => autoTower(t.id)}>Auto ({f1(t.autoDelayMs)} ms)</button>{/if}
        {/each}
      {/if}
    </section>

    <section class="card">
      <h2>Extras</h2>
      <label class="toggle"><input type="checkbox" bind:checked={home.outdoor.frontFills} /> Front fills at the stage lip</label>
      <label class="toggle"><input type="checkbox" bind:checked={home.outdoor.djMonitors} /> DJ booth monitors</label>
    </section>

    <section class="card">
      <h2>DSP setup sheet</h2>
      <p class="sub">What to type into the system processor. Positions in metres from the stage centre (x right, y toward the crowd).</p>
      <table class="tbl">
        <thead><tr><th>Out</th><th>Position</th><th>Delay</th><th>Level</th><th>Pol.</th></tr></thead>
        <tbody>
          {#each rig.speakers as s}
            <tr>
              <td><b>{s.id}</b><span class="mm">{s.label}</span></td>
              <td>{(s.pos.x - W / 2).toFixed(1)}, {(s.pos.y - B).toFixed(1)}, {s.pos.z.toFixed(1)}</td>
              <td>{f1(s.delayMs)} ms</td>
              <td>{s.gainDb !== undefined ? `${s.gainDb >= 0 ? '+' : ''}${s.gainDb.toFixed(1)}` : '0'} dB</td>
              <td>{s.invert ? '−' : '+'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="small muted">Measure and fine-tune on site with a mic: align subs to tops at the mix position, then each tower to the stage arrival at its zone (REW or the processor's delay finder).</p>
    </section>
  </div>
</div>

<style>
  .vis-3d {
    height: 58vh;
    min-height: 340px;
  }
  .maps {
    align-self: flex-start;
    flex-wrap: wrap;
  }
  .maplegend {
    margin: 0 !important;
  }
  .g {
    color: hsl(140 70% 55%);
  }
  .r {
    color: hsl(0 70% 62%);
  }
  .y {
    color: hsl(50 80% 55%);
  }
  .b {
    color: hsl(220 70% 65%);
  }
  .ctl-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--bg-2);
    border-radius: 10px;
    padding: 8px 10px;
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
  .opt-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .field.compact {
    margin: 2px 0;
  }
  .info {
    position: relative;
    background: var(--bg-2);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 9px 30px 9px 11px;
    font-size: 13px;
    color: var(--text-1);
  }
  .info .sz {
    color: var(--amber);
    font-size: 12.5px;
  }
  .x {
    position: absolute;
    right: 6px;
    top: 6px;
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
  }
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
  .spk {
    cursor: pointer;
  }
  :global(.o-lbl) {
    fill: #e2e8f0;
    font-size: 15px;
    font-weight: 700;
  }
  :global(.o-lbl.pink) {
    fill: #f9a8d4;
  }
  :global(.o-lbl.big) {
    font-size: 20px;
  }
  :global(.o-tag) {
    fill: #f8fafc;
    font-size: 13px;
    font-weight: 800;
  }
</style>
