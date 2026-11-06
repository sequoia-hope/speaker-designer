<script lang="ts">
  import MiniChart from './MiniChart.svelte';
  import Hybrid3D from './Hybrid3D.svelte';
  import { home, saveHome } from './homeState.svelte';
  import { DRIVERS } from './drivers';
  import { buildGeometry, buildIssues, HYBRID_PRESETS, planPrint, simulate, type ProfileType } from './hybrid';
  import { cabinetDims, driverFor } from './hybridModels';

  const isSub = $derived(home.hybrid.edit === 'sub');
  const p = $derived(isSub ? home.hybrid.sub : home.hybrid.living);
  const d = $derived(driverFor(p));
  const geo = $derived(buildGeometry(p, d));
  const plan = $derived(planPrint(geo, home.hybrid.printer));
  const issues = $derived(buildIssues(p, geo, d, plan, home.hybrid.printer, isSub));
  const solidPath = $derived(
    [geo.core, ...geo.holes].map((poly) => 'M ' + poly.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ') + ' Z').join(' ')
  );
  const lw = $derived(home.hybrid.printer.lineWidth);
  const sims = $derived.by(() => {
    if (p.type === 'waveguide') return [];
    const ns = isSub ? [1, 2, p.mouth === 'corner' ? 4 : 0].filter(Boolean) : [1];
    return ns.map((n) => ({ n, r: simulate(p, d, geo, { coupled: n, floor: isSub, f0: isSub ? 15 : 20, f1: isSub ? 300 : 600 }) }));
  });
  const dims = $derived(cabinetDims(p));
  $effect(() => {
    JSON.stringify(home.hybrid);
    saveHome();
  });

  let view = $state<'section' | '3d' | 'print'>('section');
  let showCoupled = $state(false);

  const drivers = $derived(DRIVERS.filter((x) => (isSub ? x.role === 'pa' || x.role === 'sub' : x.role === 'woofer' || (p.type === 'waveguide' && x.role === 'tweeter'))));
  function setType(t: ProfileType) {
    const base = t === 'waveguide' ? HYBRID_PRESETS.waveguide : HYBRID_PRESETS.living;
    home.hybrid.living = { ...base, type: t, ...(t === 'slot-port' ? { heightMm: 420, depthMm: 300, legs: 2, slotMm: 35 } : {}) };
  }
  const COLORS = ['#38bdf8', '#34d399', '#f472b6'];
  const sc = $derived(Math.min(1, 520 / Math.max(geo.W, geo.H)));
  const mm = (v: number) => `${Math.round(v)} mm`;
  const inch = (v: number) => `${(v / 25.4).toFixed(1)}″`;
</script>

<div class="split">
  <div class="vis">
    <section class="card vis-card">
      <div class="vis-hd">
        <h2>{isSub ? 'Printed horn sub' : p.type === 'tl' ? 'Printed transmission line' : p.type === 'slot-port' ? 'Printed slot-port box' : 'Printed waveguide'}</h2>
        <div class="seg">
          <button class:on={view === 'section'} onclick={() => (view = 'section')}>Cross-section</button>
          <button class:on={view === '3d'} onclick={() => (view = '3d')}>Assembled</button>
          <button class:on={view === 'print'} onclick={() => (view = 'print')}>Print layout</button>
        </div>
      </div>
      <div class="dimline">
        {mm(dims.w)} W × {mm(dims.h)} H × {mm(dims.d)} D ({inch(dims.w)} × {inch(dims.h)} × {inch(dims.d)}) · {geo.cores > 1 ? `${geo.cores} printed cores of ${geo.coreMm.toFixed(0)} mm with ${geo.cores - 1} divider${geo.cores > 2 ? 's' : ''}` : `core ${geo.coreMm.toFixed(0)} mm thick`} between two {p.plateMm} mm plates
      </div>
      {#if view === 'section'}
        <div class="svg-wrap sect">
          <svg viewBox={`-60 -40 ${geo.W + 120} ${geo.H + 90}`} role="img" aria-label="Cross-section">
            <g transform={`translate(0 ${geo.H}) scale(1 -1)`}>
              <path d={solidPath} class="print" fill-rule="evenodd" />
              {#if geo.mouthRect}<rect x={geo.mouthRect.x0 - 4} y={geo.mouthRect.y0} width="8" height={geo.mouthRect.y1 - geo.mouthRect.y0} class="mouth" />{/if}
              <!-- driver -->
              <rect x={geo.driver.x - 6} y={geo.driver.y - geo.driver.dia / 2} width="12" height={geo.driver.dia} class="drv" />
              <path d={`M ${geo.driver.x} ${geo.driver.y - geo.driver.dia * 0.45} L ${geo.driver.x + (geo.driver.face === 'front' ? -1 : 1) * geo.driver.dia * 0.28} ${geo.driver.y} L ${geo.driver.x} ${geo.driver.y + geo.driver.dia * 0.45}`} class="cone" />
            </g>
            {#each geo.labels as l}
              <text x={l.x} y={geo.H - l.y + 5} text-anchor="middle" class="lbl">{l.text}</text>
            {/each}
            <text x={geo.W + 8} y={geo.H - ((geo.mouthRect?.y0 ?? 0) + (geo.mouthRect?.y1 ?? 0)) / 2} class="lbl mouthlbl">{isSub ? 'mouth →' : p.type === 'waveguide' ? 'mouth →' : 'exit →'}</text>
            <line x1="0" y1={geo.H + 22} x2={geo.W} y2={geo.H + 22} class="dim" />
            <text x={geo.W / 2} y={geo.H + 42} text-anchor="middle" class="dimtxt">{mm(geo.W)} (depth, back → front)</text>
            <line x1="-22" y1="0" x2="-22" y2={geo.H} class="dim" />
            <text x="-30" y={geo.H / 2} text-anchor="middle" class="dimtxt" transform={`rotate(-90 -30 ${geo.H / 2})`}>{mm(geo.H)}</text>
          </svg>
        </div>
        <p class="small muted">Grey = printed plastic, dark = air. This profile is extruded {geo.coreMm.toFixed(0)} mm (into the screen){geo.cores > 1 ? ` as ${geo.cores} cores separated by ${geo.cores - 1} plywood divider${geo.cores > 2 ? 's' : ''}` : ''} and closed on both sides by the wooden plates. Bends sweep round, wall tips are half-round and the mouth lips roll out — the shapes 3D printing makes easy.</p>
      {:else if view === '3d'}
        <div class="vis-3d">
          <Hybrid3D {geo} {plan} plateMm={p.plateMm} plateColor={p.plateMaterial === 'mdf19' ? 0x9c7a55 : 0xcfa874} coupled={showCoupled && isSub ? (p.mouth === 'corner' ? 4 : 2) : 1} mouth={p.mouth} />
        </div>
        {#if isSub}
          <label class="toggle"><input type="checkbox" bind:checked={showCoupled} /> Show {p.mouth === 'corner' ? '4 cabinets (2 × 2)' : '2 cabinets'} coupled into one mouth</label>
        {/if}
      {:else}
        <div class="svg-wrap sect">
          <svg viewBox={`-30 -30 ${geo.W + 60} ${geo.H + 60}`} role="img" aria-label="Print layout">
            <g transform={`translate(0 ${geo.H}) scale(1 -1)`}>
              <path d={solidPath} class="print" fill-rule="evenodd" />
              {#each plan.cutsX as c}<line x1={c} y1="-10" x2={c} y2={geo.H + 10} class="cut" />{/each}
              {#each plan.cutsY as c}<line x1="-10" y1={c} x2={geo.W + 10} y2={c} class="cut" />{/each}
              {#each plan.keys as k}<rect x={k.x - 6} y={k.y - 6} width="12" height="12" class="key" transform={`rotate(45 ${k.x} ${k.y})`} />{/each}
            </g>
            {#each plan.segments.filter((sg) => sg.z0 === 0 && sg.core === 0) as sg}
              <text x={(sg.x0 + sg.x1) / 2} y={geo.H - (sg.y0 + sg.y1) / 2} text-anchor="middle" class="seglbl">{sg.tile}</text>
            {/each}
          </svg>
        </div>
        <p class="small muted">
          Red dashed = cut lines (placed through walls where possible); ◆ = alignment keys. Printed flat (profile on the bed){plan.rotated ? ', rotated 90° to fit' : ''}, the extrusion grows upward
          {#if plan.cutsZ.length}in {plan.cutsZ.length + 1} layers of ≤ {home.hybrid.printer.maxZ} mm{/if}.
        </p>
        <div class="beds">
          {#each plan.segments.filter((sg) => sg.z0 === 0 && sg.core === 0) as sg}
            <div class="bed">
              <svg viewBox={`0 0 ${home.hybrid.printer.bedX} ${home.hybrid.printer.bedY}`}>
                <rect x="0" y="0" width={home.hybrid.printer.bedX} height={home.hybrid.printer.bedY} class="bedrect" />
                <rect x={home.hybrid.printer.margin} y={home.hybrid.printer.margin} width={home.hybrid.printer.bedX - 2 * home.hybrid.printer.margin} height={home.hybrid.printer.bedY - 2 * home.hybrid.printer.margin} class="bedmargin" />
                <rect x={home.hybrid.printer.margin} y={home.hybrid.printer.margin} width={sg.bedW} height={sg.bedH} class="part" />
              </svg>
              <span>{sg.tile} · {Math.round(sg.bedW)}×{Math.round(sg.bedH)}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <div class="side">
    <section class="card">
      <h2>Hybrid printed + wood cabinet</h2>
      <p class="sub">A 3D-printed core carries the complicated inside (horn folds, line, port, waveguide); two flat plywood plates close it off. Big flat surfaces are wood, complex shapes are plastic.</p>
      <div class="seg">
        <button class:on={isSub} onclick={() => (home.hybrid.edit = 'sub')}>🌲 Outdoor horn sub</button>
        <button class:on={!isSub} onclick={() => (home.hybrid.edit = 'living')}>🛋️ Living-room speaker</button>
      </div>
      {#if !isSub}
        <div class="chips" style="margin-top:8px">
          {#each [['tl', 'Transmission line'], ['slot-port', 'Folded slot port'], ['waveguide', 'Waveguide']] as [t, lbl]}
            <button class="chip" class:on={p.type === t} onclick={() => setType(t as ProfileType)}>{lbl}</button>
          {/each}
        </div>
      {/if}
      <label class="pick">
        <span>Driver</span>
        <select bind:value={p.driverId} aria-label="Driver">
          {#each drivers as dr}<option value={dr.id}>{dr.brand} {dr.model} ({dr.sizeLabel}){dr.priceUsd ? ` — $${dr.priceUsd.toFixed(0)}` : ''}</option>{/each}
        </select>
      </label>
    </section>

    {#if sims.length}
      <section class="card">
        <h2>Output (simulated from this geometry)</h2>
        <MiniChart
          series={sims.map((s, i) => ({ label: s.n === 1 ? (isSub ? '1 cabinet on the ground' : '1 m, 2.83 V') : `${s.n} cabinets coupled`, color: COLORS[i], points: s.r.freqs.map((f, k) => ({ x: f, y: s.r.spl[k] })) }))}
          xMin={isSub ? 15 : 20}
          xMax={isSub ? 300 : 600}
          yMin={isSub ? 80 : 60}
          yMax={isSub ? 125 : 100}
          yStep={5}
          yLabel="dB"
          xTicks={isSub ? [20, 30, 50, 100, 200] : [20, 50, 100, 200, 500]}
          markers={[{ x: sims[0].r.f3, label: `f3 ${sims[0].r.f3.toFixed(0)} Hz` }]}
        />
        <p class="small muted">SPL at 1 m for 2.83 V{isSub ? ' (on the ground; coupled stacks are the whole stack)' : ''}. Max output (excursion- or power-limited) at 40 Hz: <b>{sims[sims.length - 1].r.maxSpl[sims[sims.length - 1].r.freqs.findIndex((f) => f >= 40)].toFixed(0)} dB</b>{isSub ? ` for ${sims[sims.length - 1].n} coupled` : ''}.</p>
      </section>
    {/if}
    <section class="card">
      <h2>Size & profile</h2>
      {#each [['heightMm', 'Height', 200, 1400, 10], ['depthMm', 'Depth (profile width)', 120, 1400, 10], ['extrusionMm', 'Width between the outer plates', 60, 900, 5]] as [k, lbl, mn, mx, st]}
        {@const key = k as 'heightMm' | 'depthMm' | 'extrusionMm'}
        <div class="field">
          <label for={`h-${key}`}>{lbl}</label><span class="val">{p[key]} mm</span>
          <input id={`h-${key}`} type="range" min={mn} max={mx} step={st} bind:value={p[key]} />
        </div>
      {/each}
      <div class="field">
        <label for="h-wall">Printed wall thickness</label>
        <span class="val">{p.wallMm.toFixed(1)} mm = {Math.round(p.wallMm / lw)} lines</span>
        <span class="hint">Snaps to whole {lw} mm lines. Chunky walls are stiffer; the flex check below tells you if they are enough.</span>
        <input id="h-wall" type="range" min={lw * 3} max={lw * 16} step={lw} value={p.wallMm} oninput={(e) => (p.wallMm = Math.round(+(e.target as HTMLInputElement).value / lw) * lw)} />
      </div>
      <div class="field">
        <label for="h-div">Plywood dividers inside the core</label>
        <span class="val">{p.dividers} → {geo.cores} printed core{geo.cores > 1 ? 's' : ''} of {geo.coreMm.toFixed(0)} mm</span>
        <span class="hint">Each divider halves the span the printed walls bridge — ~4× stiffer — and makes each core a shorter print.</span>
        <input id="h-div" type="range" min="0" max="3" step="1" bind:value={p.dividers} />
      </div>
      <div class="field">
        <label for="h-round">Organic rounding</label>
        <span class="val">{Math.round(p.rounding * 100)} %</span>
        <span class="hint">0 = square corners; 100 % = bends as round as the space allows.</span>
        <input id="h-round" type="range" min="0" max="1" step="0.05" bind:value={p.rounding} />
      </div>
      <div class="chips">
        {#each [['bb18', 18, '18 mm birch'], ['bb12', 12, '12 mm birch'], ['mdf19', 19, '19 mm MDF']] as [id, t, lbl]}
          <button class="chip" class:on={p.plateMaterial === id} onclick={() => { p.plateMaterial = id as 'bb18' | 'bb12' | 'mdf19'; p.plateMm = t as number; }}>{lbl} plates</button>
        {/each}
      </div>
      {#if p.type !== 'waveguide'}
        <div class="field">
          <label for="h-legs">{p.type === 'slot-port' ? 'Port folds' : 'Legs (folds + 1)'}</label><span class="val">{p.legs}</span>
          <input id="h-legs" type="range" min="1" max="8" step="1" bind:value={p.legs} />
        </div>
      {/if}
      {#if p.type === 'folded-horn'}
        <div class="field">
          <label for="h-thr">Throat area / cone area</label><span class="val">{p.throatRatio.toFixed(2)}</span>
          <span class="hint">Smaller = more compression (efficiency) but more air-speed and driver stress.</span>
          <input id="h-thr" type="range" min="0.25" max="1" step="0.01" bind:value={p.throatRatio} />
        </div>
        <div class="field">
          <label for="h-rc">Rear chamber</label><span class="val">{p.rearChamberL} L (min. set by driver depth)</span>
          <input id="h-rc" type="range" min="10" max="150" step="1" bind:value={p.rearChamberL} />
        </div>
        <div class="chips">
          <span class="small muted" style="align-self:center">Mouth:</span>
          <button class="chip" class:on={p.mouth === 'edge'} onclick={() => (p.mouth = 'edge')}>Bottom edge (2 couple)</button>
          <button class="chip" class:on={p.mouth === 'corner'} onclick={() => (p.mouth = 'corner')}>Corner (4 couple)</button>
        </div>
      {:else if p.type === 'tl'}
        <div class="field">
          <label for="h-tap">Line taper (end / start area)</label><span class="val">{p.taper.toFixed(2)}</span>
          <input id="h-tap" type="range" min="0.2" max="1.2" step="0.05" bind:value={p.taper} />
        </div>
      {:else if p.type === 'slot-port'}
        <div class="field">
          <label for="h-slot">Slot height</label><span class="val">{p.slotMm} mm</span>
          <input id="h-slot" type="range" min="15" max="120" step="1" bind:value={p.slotMm} />
        </div>
      {:else}
        <div class="field">
          <label for="h-cov">Coverage angle</label><span class="val">{p.coverageDeg}°</span>
          <input id="h-cov" type="range" min="40" max="120" step="5" bind:value={p.coverageDeg} />
        </div>
        <div class="field">
          <label for="h-thw">Throat width</label><span class="val">{p.throatMm} mm</span>
          <input id="h-thw" type="range" min="20" max="60" step="1" bind:value={p.throatMm} />
        </div>
      {/if}
      <ul class="callouts">
        {#each geo.stats as st}<li><b>{st.label}:</b> {st.value}</li>{/each}
        {#each geo.chambers as c}<li><b>{c.label}:</b> {c.volumeL.toFixed(1)} L</li>{/each}
      </ul>
    </section>

    <section class="card">
      <h2>Printing</h2>
      <div class="bedin">
        {#each [['bedX', 'Bed X', 1], ['bedY', 'Bed Y', 1], ['maxZ', 'Max Z', 1], ['margin', 'Margin', 1], ['nozzle', 'Nozzle', 0.1], ['lineWidth', 'Line width', 0.05], ['layerH', 'Layer', 0.05], ['flow', 'Flow mm³/s', 1]] as [k, lbl, st]}
          {@const key = k as 'bedX' | 'bedY' | 'maxZ' | 'margin' | 'nozzle' | 'lineWidth' | 'layerH' | 'flow'}
          <label>{lbl}<input type="number" min="0" max="1000" step={st} bind:value={home.hybrid.printer[key]} /></label>
        {/each}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Segments</div><div class="v">{plan.segments.length}</div><div class="s">{geo.cores > 1 ? `${geo.cores} cores × ` : ''}{plan.cutsX.length + 1} × {plan.cutsY.length + 1} tiles{plan.cutsZ.length ? ` × ${plan.cutsZ.length + 1} layers` : ''}</div></div>
        <div class="stat"><div class="k">Alignment keys</div><div class="v">{plan.keys.length}</div><div class="s">+ dowels between layers</div></div>
        <div class="stat"><div class="k">Filament / time</div><div class="v">{(plan.totalGrams / 1000).toFixed(1)} kg</div><div class="s">~{plan.hours.toFixed(0)} h at {home.hybrid.printer.flow} mm³/s · {plan.layers} layers per core</div></div>
        <div class="stat"><div class="k">Largest piece</div><div class="v sm">{Math.round(Math.max(...plan.segments.map((s) => s.bedW)))} × {Math.round(Math.max(...plan.segments.map((s) => s.bedH)))} mm</div><div class="s">fits {plan.usable[0]} × {plan.usable[1]} usable</div></div>
      </div>
      <table class="tbl" style="margin-top:8px">
        <thead><tr><th>Piece</th><th>On the bed</th><th>Height (Z)</th><th>≈ g</th></tr></thead>
        <tbody>
          {#each plan.segments as sg}
            <tr><td>{sg.id}</td><td>{Math.round(sg.bedW)} × {Math.round(sg.bedH)} mm</td><td>{Math.round(sg.z1 - sg.z0)} mm</td><td>{Math.round(sg.grams)}</td></tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Build notes</h2>
      <ul class="callouts">
        {#each issues as is}<li class={is.level === 'ok' ? 'good' : is.level}><b>{is.title}</b><br />{is.body}</li>{/each}
      </ul>
    </section>

    <section class="card">
      <h2>Use it in the simulator</h2>
      {#if isSub}
        <label class="toggle"><input type="checkbox" bind:checked={home.hybrid.useOutdoor} disabled={p.type !== 'folded-horn' || !geo.fits} /> Use this horn for the outdoor subs</label>
        <p class="small muted">The outdoor maps then use this cabinet's size and its simulated response, including how {p.mouth === 'corner' ? 'up to 4' : 'pairs of'} mouths couple.</p>
      {:else}
        <label class="toggle"><input type="checkbox" bind:checked={home.hybrid.useLiving} disabled={p.type === 'waveguide'} /> Use this speaker as the living-room mains</label>
        <p class="small muted">The living-room bass maps then use this speaker's simulated bass response instead of the woodworking design's.</p>
      {/if}
    </section>
  </div>
</div>

<style>
  .dimline {
    font-size: 13px;
    color: var(--amber);
  }
  .vis-3d {
    height: 52vh;
    min-height: 320px;
  }
  .sect svg {
    max-height: 56vh;
  }
  :global(.print) {
    fill: #9ca3af;
    stroke: #e5e7eb;
    stroke-width: 1;
  }
  :global(.air) {
    fill: #0b1020;
  }
  :global(.air.dim2) {
    fill: #1e293b;
  }
  :global(.mouth) {
    fill: #34d399;
  }
  :global(.drv) {
    fill: #1f2024;
    stroke: #38bdf8;
    stroke-width: 2;
  }
  :global(.cone) {
    fill: none;
    stroke: #38bdf8;
    stroke-width: 3;
  }
  :global(.lbl) {
    fill: #e2e8f0;
    font-size: 16px;
    font-weight: 600;
  }
  :global(.mouthlbl) {
    fill: #34d399;
  }
  :global(.cut) {
    stroke: #f87171;
    stroke-width: 3;
    stroke-dasharray: 12 8;
  }
  :global(.key) {
    fill: #fbbf24;
  }
  :global(.seglbl) {
    fill: #fde68a;
    font-size: 26px;
    font-weight: 800;
  }
  .beds {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
    gap: 6px;
    margin-top: 6px;
  }
  .bed {
    display: flex;
    flex-direction: column;
    align-items: center;
    font-size: 11px;
    color: var(--text-2);
  }
  .bed svg {
    width: 100%;
    height: auto;
  }
  :global(.bedrect) {
    fill: #111827;
    stroke: #475569;
    stroke-width: 4;
  }
  :global(.bedmargin) {
    fill: none;
    stroke: #64748b;
    stroke-width: 2;
    stroke-dasharray: 8 6;
  }
  .bed :global(.part) {
    fill: #93c5fd;
  }
  .pick {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-2);
  }
  .pick select {
    flex: 1;
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 8px;
    font-size: 14px;
  }
  .bedin {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    row-gap: 8px;
    gap: 6px;
  }
  .bedin label {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .bedin input {
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    font-size: 15px;
  }
  .sm {
    font-size: 14px !important;
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
</style>
