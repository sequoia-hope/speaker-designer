<script lang="ts">
  import { home, saveHome } from './homeState.svelte';
  import { DESIGNS } from './designs';
  import { SHOP_SKILLS, type BuildPlan } from './speakerBuild';
  import { fmtInFrac } from './roomAcoustics';
  import type { DriverInfo } from './drivers';
  import Speaker3D from './Speaker3D.svelte';
  import PanelDrawing from './PanelDrawing.svelte';

  let { plan, woofer, tweeter }: { plan: BuildPlan; woofer: DriverInfo; tweeter: DriverInfo | null } = $props();

  const cur = $derived(home.designs[home.activeDesign]);
  const box = $derived(plan.box);
  let withStand = $state(false);
  const allPanels = $derived([...plan.panels, ...(plan.stand?.panels ?? [])]);
  const ext = $derived(box.externalMm);
  const t = $derived(plan.material.thicknessMm);
  const inch = (mm: number) => fmtInFrac(mm, 16);
  const both = (mm: number) => `${inch(mm)} (${Math.round(mm)} mm)`;

  const stepKey = (i: number) => `${home.activeDesign}|${cur.boxType}|${i}`;
  const doneCount = $derived(plan.steps.filter((_, i) => home.stepsDone[stepKey(i)]).length);
  function toggleStep(i: number) {
    home.stepsDone[stepKey(i)] = !home.stepsDone[stepKey(i)];
    saveHome();
  }

  const totalMinutes = $derived(plan.steps.reduce((a, s) => a + s.minutes, 0));
  const tools = $derived([...new Set(plan.steps.flatMap((s) => s.tools))]);
  const cost = $derived(plan.shopping.reduce((a, s) => a + (s.approxUsd ?? 0), 0));
  const unknownCost = $derived(plan.shopping.filter((s) => s.approxUsd === undefined).map((s) => s.item.split(':')[0]));

  // drawing scale: 1 svg unit = 1 mm
  const M = 70; // margin for dimension lines
</script>
<div class="split">
<div class="vis">
  <section class="card vis-card">
    <div class="vis-hd">
      <h2>Assembly</h2>
{#if plan.stand}
      <div class="seg">
        <button class:on={!withStand} onclick={() => (withStand = false)}>Speaker</button>
        <button class:on={withStand} onclick={() => (withStand = true)} disabled={!plan.stand}>With stand</button>
      </div>
{/if}
    </div>
    <p class="small muted" style="margin:0">Exploded so you can see every part. Slide to 0 to see it assembled; tap any part for its size and machining steps.</p>
    <div class="s3d-wrap">
      <Speaker3D {plan} {woofer} {tweeter} initialExplode={0.55} showStand={withStand && !!plan.stand} />
    </div>
  </section>
</div>
<div class="side">
<section class="card">
  <label class="pick">
    <span>Building</span>
    <select bind:value={home.activeDesign} aria-label="Design to build">
      {#each DESIGNS as d}<option value={d.id}>{d.name} — {d.short}</option>{/each}
    </select>
  </label>
  <h2>Woodworking plan</h2>
  <p class="sub">
    {cur.quantity} × {box.alignment.kind} box for the {woofer.brand} {woofer.model}{tweeter ? ` + ${tweeter.model}` : ''},
    in {plan.material.name}. Glued butt-joint construction: every part is a plain rectangle — no angled cuts.
  </p>
  <div class="stats">
    <div class="stat"><div class="k">Outside (W × H × D)</div><div class="v sm">{inch(ext.w)} × {inch(ext.h)} × {inch(ext.d)}</div><div class="s">{ext.w} × {ext.h} × {ext.d} mm</div></div>
    <div class="stat"><div class="k">Sheets</div><div class="v">{plan.sheets.length}</div><div class="s">{plan.material.name.split(' ')[0]} {plan.material.name.includes('plywood') ? 'ply' : 'MDF'}</div></div>
    <div class="stat"><div class="k">Shop time (rough)</div><div class="v">{(totalMinutes / 60).toFixed(0)} h</div><div class="s">+ glue & finish drying</div></div>
    <div class="stat"><div class="k">Parts cost (approx)</div><div class="v">${cost.toFixed(0)}+</div><div class="s">excl. {unknownCost.join(', ') || 'nothing'}</div></div>
  </div>
</section>

<section class="card">
  <h2>Front baffle</h2>
  <p class="sub">Hole centres measured from the top edge, on the vertical centre line. Dashed = flush-mount rebate.</p>
  <div class="svg-wrap">
    <svg viewBox={`${-M} ${-M * 0.7} ${ext.w + M * 2.6} ${ext.h + M * 1.4}`} role="img" aria-label="Front baffle drawing">
      <rect x="0" y="0" width={ext.w} height={ext.h} class="wood" />
      <line x1={ext.w / 2} y1="-10" x2={ext.w / 2} y2={ext.h + 10} class="cl" />
      {#each plan.holes as h}
        {#if h.rebateDiaMm}
          <circle cx={h.xMm} cy={h.yMm} r={h.rebateDiaMm / 2} class="rebate" />
        {/if}
        <circle cx={h.xMm} cy={h.yMm} r={h.throughDiaMm / 2} class="hole" />
        <line x1={h.xMm - 6} y1={h.yMm} x2={h.xMm + 6} y2={h.yMm} class="cross" />
        <line x1={h.xMm} y1={h.yMm - 6} x2={h.xMm} y2={h.yMm + 6} class="cross" />
        <!-- dimension from top -->
        <line x1={ext.w + 12} y1="0" x2={ext.w + 12} y2={h.yMm} class="dim" />
        <line x1={h.xMm + h.throughDiaMm / 2 + 4} y1={h.yMm} x2={ext.w + 18} y2={h.yMm} class="ext" />
        <text x={ext.w + 22} y={h.yMm + 4} class="dimtxt">{inch(h.yMm)}</text>
        <text x={ext.w + 22} y={h.yMm + 17} class="dimtxt mm">{Math.round(h.yMm)} mm</text>
      {/each}
      <!-- overall width -->
      <line x1="0" y1={-22} x2={ext.w} y2={-22} class="dim" />
      <text x={ext.w / 2} y={-30} text-anchor="middle" class="dimtxt">{inch(ext.w)} · {ext.w} mm</text>
      <!-- overall height -->
      <line x1={-22} y1="0" x2={-22} y2={ext.h} class="dim" />
      <text x={-30} y={ext.h / 2} text-anchor="middle" class="dimtxt" transform={`rotate(-90 -30 ${ext.h / 2})`}>{inch(ext.h)} · {ext.h} mm</text>
    </svg>
  </div>
  <table class="tbl" style="margin-top:8px">
    <thead><tr><th>Hole</th><th>Through-hole Ø</th><th>Rebate Ø × depth</th></tr></thead>
    <tbody>
      {#each plan.holes as h}
        <tr>
          <td>{h.label}<span class="mm">centre {both(h.yMm)} from top</span></td>
          <td>{inch(h.throughDiaMm)}<span class="mm">{h.throughDiaMm.toFixed(1)} mm</span></td>
          <td>
            {#if h.rebateDiaMm && h.rebateDepthMm}
              {inch(h.rebateDiaMm)} × {inch(h.rebateDepthMm)}<span class="mm">{h.rebateDiaMm.toFixed(0)} × {h.rebateDepthMm} mm</span>
            {:else if h.label.startsWith('Port')}
              —<span class="mm">glue tube flange on surface</span>
            {:else}
              measure flange<span class="mm">datasheet doesn't list it</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<section class="card">
  <h2>How the box goes together</h2>
  <p class="sub">Two cross-sections. Baffle and back cover everything; sides sit between them; top and bottom sit between the sides.</p>
  <div class="two">
    <div>
      <div class="cap">Seen from above (cut through the middle)</div>
      <div class="svg-wrap">
        <svg viewBox={`-40 -40 ${ext.w + 80} ${ext.d + 80}`} role="img" aria-label="Plan section">
          <!-- baffle at bottom (front), back at top -->
          <rect x="0" y={ext.d - box.baffleMm} width={ext.w} height={box.baffleMm} class="p-baffle" />
          <rect x="0" y="0" width={ext.w} height={t} class="p-back" />
          <rect x="0" y={t} width={t} height={ext.d - t - box.baffleMm} class="p-side" />
          <rect x={ext.w - t} y={t} width={t} height={ext.d - t - box.baffleMm} class="p-side" />
          {#if plan.panels.some((p) => p.id === 'brace')}
            <rect x={t} y={t + (ext.d - t - box.baffleMm) / 2 - t / 2} width={ext.w - 2 * t} height={t} class="p-brace" />
          {/if}
          <!-- woofer magnet outline -->
          <rect
            x={ext.w / 2 - woofer.frameDiaMm * 0.28}
            y={ext.d - box.baffleMm - (woofer.mountDepthMm ?? 80)}
            width={woofer.frameDiaMm * 0.56}
            height={woofer.mountDepthMm ?? 80}
            class="p-drv"
          />
          <text x={ext.w / 2} y={ext.d + 26} text-anchor="middle" class="dimtxt">FRONT (baffle)</text>
          <text x={ext.w / 2} y={-14} text-anchor="middle" class="dimtxt">back</text>
          <text x={ext.w / 2} y={ext.d - box.baffleMm - (woofer.mountDepthMm ?? 80) - 8} text-anchor="middle" class="dimtxt mm">woofer</text>
        </svg>
      </div>
    </div>
    <div>
      <div class="cap">Seen from the front (baffle removed)</div>
      <div class="svg-wrap">
        <svg viewBox={`-40 -40 ${ext.w + 80} ${ext.h + 80}`} role="img" aria-label="Front section">
          <rect x="0" y="0" width={t} height={ext.h} class="p-side" />
          <rect x={ext.w - t} y="0" width={t} height={ext.h} class="p-side" />
          <rect x={t} y="0" width={ext.w - 2 * t} height={t} class="p-top" />
          <rect x={t} y={ext.h - t} width={ext.w - 2 * t} height={t} class="p-top" />
          {#if plan.panels.some((p) => p.id === 'brace')}
            <rect x={t} y={t} width={ext.w - 2 * t} height={ext.h - 2 * t} class="p-brace-o" />
            <rect x={t + 38} y={t + 38} width={ext.w - 2 * t - 76} height={ext.h - 2 * t - 76} class="p-window" />
          {/if}
          <text x={ext.w / 2} y={-14} text-anchor="middle" class="dimtxt">top</text>
        </svg>
      </div>
    </div>
  </div>
  <div class="legend small">
    <span><i class="sw p-baffle"></i>Baffle</span><span><i class="sw p-back"></i>Back</span><span><i class="sw p-side"></i>Sides</span><span><i class="sw p-top"></i>Top/bottom</span>{#if plan.panels.some((p) => p.id === 'brace')}<span><i class="sw p-brace"></i>Window brace</span>{/if}
  </div>
</section>

<section class="card">
  <h2>Cut list</h2>
  <p class="sub">For {cur.quantity} speakers. Length × width, {plan.material.thicknessMm} mm thick. Cut matching parts at the same saw setting.</p>
  <table class="tbl">
    <thead><tr><th>Part</th><th>Qty</th><th>Length × width</th></tr></thead>
    <tbody>
      {#each allPanels as p, pi}
        {#if plan.stand && p.id === 'stand-top'}
          <tr><td colspan="3" class="grp">Stands ({plan.stand.heightMm} mm / {inch(plan.stand.heightMm)} tall)</td></tr>
        {/if}
        <tr>
          <td>
            <b>{p.name}</b>
            {#each p.notes as n}<span class="mm">{n}</span>{/each}
          </td>
          <td>{p.qtyPerBox * cur.quantity}</td>
          <td style="white-space:nowrap">
            {inch(p.lengthMm)} × {inch(p.widthMm)}
            <span class="mm">{Math.round(p.lengthMm)} × {Math.round(p.widthMm)} mm</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <label class="toggle"><input type="checkbox" bind:checked={cur.stands} /> Include matching stands (tweeter at your ear height from the Room tab)</label>
  <h3>Sheet layout</h3>
  {#each plan.sheets as s, si}
    <div class="cap">Sheet {si + 1} of {plan.sheets.length} · {Math.round(s.sheetMm[0] / 304.8)}′ × {Math.round(s.sheetMm[1] / 304.8)}′ · {(s.usedFraction * 100).toFixed(0)} % used</div>
    <div class="svg-wrap">
      <svg viewBox={`-10 -10 ${s.sheetMm[0] + 20} ${s.sheetMm[1] + 20}`} role="img" aria-label="Sheet layout">
        <rect x="0" y="0" width={s.sheetMm[0]} height={s.sheetMm[1]} class="sheet" />
        {#each s.parts as p}
          <rect x={p.x} y={p.y} width={p.w} height={p.h} class="part" />
          <text x={p.x + p.w / 2} y={p.y + p.h / 2} text-anchor="middle" class="ptxt">{p.label}</text>
          <text x={p.x + p.w / 2} y={p.y + p.h / 2 + 34} text-anchor="middle" class="ptxt mm">{inch(p.w)} × {inch(p.h)}</text>
        {/each}
      </svg>
    </div>
  {/each}
  <p class="small muted">Long edge of each part runs along the sheet. 3.5 mm saw kerf and 10 mm trimmed off dinged factory edges are allowed for. Many lumber yards will rip sheets for you if you bring this layout.</p>
</section>

<section class="card">
  <h2>Panel by panel</h2>
  <p class="sub">Every part, what to mark on it, and what to cut into it — in shop order. Do all the machining before any glue comes out.</p>
  {#each allPanels as p}
    {@const ops = plan.panelOps.find((o) => o.panelId === p.id)?.ops ?? []}
    <details class="acc skill">
      <summary>
        <span class="stitle">{p.name}</span>
        <span class="smin">{p.qtyPerBox * cur.quantity}× · {inch(p.lengthMm)} × {inch(p.widthMm)}</span>
      </summary>
      <div class="acc-body">
        <PanelDrawing panel={p} {plan} />
        <ol class="sbody">{#each ops as o}<li class:subop={o.startsWith('  •')}>{o.replace(/^\s*•\s*/, '')}</li>{/each}</ol>
      </div>
    </details>
  {/each}
</section>

<section class="card">
  <h2>Router circle-jig settings</h2>
  <p class="sub">
    Set the distance from the jig's pivot pin to the <b>far</b> edge of the bit (the edge away from the pin) — that edge
    makes the hole wall you keep. Cut in passes of ~3 mm (⅛″) depth. Test every setting on scrap first.
  </p>
  <table class="tbl">
    <thead><tr><th>Hole / pass</th><th>Pin → far edge</th><th>Depth</th></tr></thead>
    <tbody>
      {#each plan.jig as j}
        <tr>
          <td>{j.hole}<span class="mm">{j.pass}</span></td>
          <td style="white-space:nowrap">{inch(j.radiusMm)}<span class="mm">{j.radiusMm.toFixed(1)} mm</span></td>
          <td style="white-space:nowrap">{j.depthMm === 'through' ? 'through' : `${inch(j.depthMm)}`}<span class="mm">{j.depthMm === 'through' ? `${box.baffleMm} mm` : `${j.depthMm} mm`}</span></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <h3>Screw holes</h3>
  <ul class="callouts">
    {#each plan.holes.filter((h) => h.screwPcdMm) as h}
      <li class={h.screwPcdEstimated ? 'warn' : ''}>
        <b>{h.label}</b>: {h.screwCount} screws evenly spaced on a {inch(h.screwPcdMm ?? 0)} ({h.screwPcdMm?.toFixed(0)} mm) circle.
        {h.screwPcdEstimated ? 'The datasheet does not give this — set the driver in place and mark through its holes.' : 'From the datasheet drawing; still mark through the real driver.'}
        Pilot ⅛″ (3 mm) for #8 wood screws, or use T-nuts + M4 screws if you'll remove the driver often.
      </li>
    {/each}
  </ul>
</section>

{#if plan.stand}
  <section class="card">
    <h2>Stands</h2>
    <p class="sub">A hollow square column on a wide base, filled with sand. Same butt-joint method as the speakers — a good warm-up project.</p>
    <div class="stats">
      <div class="stat"><div class="k">Height</div><div class="v">{inch(plan.stand.heightMm)}</div><div class="s">{plan.stand.heightMm} mm</div></div>
      <div class="stat"><div class="k">Column</div><div class="v">{inch(plan.stand.columnMm)} sq.</div><div class="s">{plan.stand.columnMm} mm</div></div>
    </div>
    <ul class="callouts">{#each plan.stand.notes as n}<li>{n}</li>{/each}</ul>
  </section>
{/if}

<section class="card">
  <h2>Shopping list</h2>
  <table class="tbl">
    <tbody>
      {#each plan.shopping as s}
        <tr>
          <td><b>{s.item}</b><span class="mm">{s.why}</span></td>
          <td style="white-space:nowrap">{s.qty}</td>
          <td style="white-space:nowrap">{s.approxUsd ? `$${s.approxUsd.toFixed(0)}` : '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <h3>Tools you'll use</h3>
  <div class="chips">{#each tools as tool}<span class="chip">{tool}</span>{/each}</div>
</section>

<section class="card">
  <h2>Step by step</h2>
  <div class="progress"><div style:width={`${(doneCount / plan.steps.length) * 100}%`}></div></div>
  <p class="small muted">{doneCount} of {plan.steps.length} steps done · tick them off as you go (saved on this device).</p>
</section>
{#each plan.steps as s, i}
  <details class="acc step" class:done={home.stepsDone[stepKey(i)]}>
    <summary>
      <input
        type="checkbox"
        checked={!!home.stepsDone[stepKey(i)]}
        onclick={(e) => {
          e.stopPropagation();
          toggleStep(i);
        }}
        aria-label={`Mark step ${i + 1} done`}
      />
      <span class="snum">{i + 1}</span>
      <span class="stitle">{s.title}</span>
      <span class="smin">{s.minutes < 60 ? `${s.minutes} min` : `${(s.minutes / 60).toFixed(1)} h`}</span>
    </summary>
    <div class="acc-body">
      <ol class="sbody">{#each s.body as b}<li>{b}</li>{/each}</ol>
      {#if s.check}<p class="chk">✔ Check: {s.check}</p>{/if}
      {#if s.safety}<p class="safe">⚠ Safety: {s.safety}</p>{/if}
      <p class="small muted">Tools: {s.tools.join(' · ')}</p>
    </div>
  </details>
{/each}

<section class="card">
  <h2>Shop skills, in one paragraph each</h2>
  {#each SHOP_SKILLS as sk}
    <details class="acc skill">
      <summary>{sk.name}</summary>
      <div class="acc-body"><p>{sk.what}</p><p class="small muted">Tools: {sk.tools}</p></div>
    </details>
  {/each}
</section>
</div>
</div>

<style>
  .pick {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
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
    font-size: 15px;
  }
  .s3d-wrap {
    height: 58vh;
    min-height: 340px;
  }
  .grp {
    color: var(--accent);
    font-weight: 700;
    padding-top: 12px !important;
  }
  .subop {
    list-style: none;
    margin-left: -4px !important;
    color: var(--text-2);
  }
  .subop::before {
    content: '↳ ';
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 12px 0 4px;
    font-size: 14px;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  @media (max-width: 520px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
  .cap {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 8px;
  }
  .sm {
    font-size: 14px !important;
  }
  :global(.wood) {
    fill: #b99066;
    stroke: #fde68a;
    stroke-width: 2;
  }
  :global(.hole) {
    fill: #0a1020;
    stroke: #f8fafc;
    stroke-width: 2;
  }
  :global(.rebate) {
    fill: #8a6a48;
    stroke: #f8fafc;
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }
  :global(.cl) {
    stroke: #38bdf8;
    stroke-width: 1;
    stroke-dasharray: 12 4 3 4;
  }
  :global(.cross) {
    stroke: #38bdf8;
    stroke-width: 1.5;
  }
  :global(.dim) {
    stroke: #fbbf24;
    stroke-width: 1.5;
  }
  :global(.ext) {
    stroke: #fbbf24;
    stroke-width: 0.8;
    stroke-dasharray: 3 3;
  }
  :global(.dimtxt) {
    fill: #fbbf24;
    font-size: 15px;
    font-weight: 600;
  }
  :global(.dimtxt.mm) {
    fill: #94a3b8;
    font-size: 12px;
    font-weight: 500;
  }
  :global(.p-baffle) {
    fill: #f59e0b;
  }
  :global(.p-back) {
    fill: #64748b;
  }
  :global(.p-side) {
    fill: #b99066;
  }
  :global(.p-top) {
    fill: #d6b48a;
  }
  :global(.p-brace) {
    fill: #a78bfa;
  }
  :global(.p-brace-o) {
    fill: #a78bfa;
    opacity: 0.6;
  }
  :global(.p-window) {
    fill: #0a1020;
  }
  :global(.p-drv) {
    fill: none;
    stroke: #38bdf8;
    stroke-width: 2;
    stroke-dasharray: 5 4;
  }
  :global(.sheet) {
    fill: #3b2f22;
    stroke: #fde68a;
    stroke-width: 3;
  }
  :global(.part) {
    fill: #b99066;
    stroke: #0a1020;
    stroke-width: 3;
  }
  :global(.ptxt) {
    fill: #1c1408;
    font-size: 34px;
    font-weight: 700;
  }
  :global(.ptxt.mm) {
    font-size: 26px;
    font-weight: 500;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 8px;
    color: var(--text-1);
  }
  .sw {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    margin-right: 5px;
    vertical-align: -1px;
  }
  .sw.p-baffle {
    background: #f59e0b;
  }
  .sw.p-back {
    background: #64748b;
  }
  .sw.p-side {
    background: #b99066;
  }
  .sw.p-top {
    background: #d6b48a;
  }
  .sw.p-brace {
    background: #a78bfa;
  }
  .progress {
    height: 8px;
    background: var(--bg-3);
    border-radius: 4px;
    overflow: hidden;
  }
  .progress div {
    height: 100%;
    background: var(--emerald);
    transition: width 0.3s;
  }
  .step summary input {
    width: 22px;
    height: 22px;
    accent-color: var(--emerald);
    flex: none;
  }
  .snum {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg-3);
    display: grid;
    place-items: center;
    font-size: 12px;
  }
  .stitle {
    flex: 1;
    font-size: 14.5px;
  }
  .smin {
    font-size: 12px;
    color: var(--text-2);
    font-weight: 500;
    flex: none;
  }
  .step.done .stitle {
    color: var(--text-2);
    text-decoration: line-through;
  }
  .sbody {
    padding-left: 20px;
    margin: 0;
  }
  .sbody li {
    margin: 6px 0;
  }
  .chk {
    color: var(--emerald);
    font-size: 13.5px;
  }
  .safe {
    color: var(--amber);
    font-size: 13.5px;
  }
  details.skill {
    margin-top: 6px;
    background: var(--bg-2);
  }
  details.skill summary {
    font-size: 14px;
    padding: 10px 12px;
  }
</style>
