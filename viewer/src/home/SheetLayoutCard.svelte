<script lang="ts">
  // Sheet layout: nest flat parts onto stock sheets with a guillotine packer,
  // preview each sheet, list the cuts, and export the nested DXF / CSV cut list.
  import { SHEET_PRESETS, cutListCsv, cutListRows, nestPanels, nestedDxf, placedGeometry, type NestPart } from './sheetLayout';
  import { downloadBlob } from './exporters';
  import { untrack } from 'svelte';

  let {
    parts,
    fileBase,
    defaultSheetMm = [1220, 2440],
    defaultPrice = 0,
    heading = 'Sheet layout',
    note = '',
  }: { parts: NestPart[]; fileBase: string; defaultSheetMm?: [number, number]; defaultPrice?: number; heading?: string; note?: string } = $props();

  const initPreset = () => SHEET_PRESETS.find((s) => (s.w === defaultSheetMm[0] && s.h === defaultSheetMm[1]) || (s.w === defaultSheetMm[1] && s.h === defaultSheetMm[0]))?.id ?? 'custom';
  // the parent re-keys this card when the material changes, so initial values are enough
  let preset = $state(untrack(initPreset));
  let customW = $state(untrack(() => defaultSheetMm[0]));
  let customH = $state(untrack(() => defaultSheetMm[1]));
  let kerf = $state(3.2);
  let margin = $state(10);
  let price = $state(untrack(() => defaultPrice));
  let grain = $state(false);
  let showCuts = $state(false);

  const dims = $derived.by(() => {
    const p = SHEET_PRESETS.find((s) => s.id === preset);
    return p ? [p.w, p.h] : [Math.max(50, +customW || 0), Math.max(50, +customH || 0)];
  });
  const result = $derived(nestPanels(parts, { sheetW: dims[0], sheetH: dims[1], kerfMm: +kerf || 0, marginMm: +margin || 0, grainMatters: grain, pricePerSheet: +price || 0 }));
  const rows = $derived(cutListRows(parts, result));
  const anyVisible = $derived(parts.some((p) => p.visible));
  const fmt = (mm: number) => `${Math.round(mm * 10) / 10}`;
</script>

<section class="card" data-testid="sheet-layout">
  <h2>{heading}</h2>
  {#if note}<p class="small muted" style="margin-top:0">{note}</p>{/if}
  <div class="opts">
    <label>Sheet
      <select bind:value={preset} aria-label="Sheet size">
        {#each SHEET_PRESETS as s}<option value={s.id}>{s.label}</option>{/each}
        <option value="custom">Custom…</option>
      </select>
    </label>
    {#if preset === 'custom'}
      <label>W mm<input type="number" min="50" max="5000" step="1" bind:value={customW} /></label>
      <label>H mm<input type="number" min="50" max="5000" step="1" bind:value={customH} /></label>
    {/if}
    <label>Kerf mm<input type="number" min="0" max="10" step="0.1" bind:value={kerf} /></label>
    <label>Edge trim mm<input type="number" min="0" max="50" step="1" bind:value={margin} /></label>
    <label>Price / sheet<input type="number" min="0" max="10000" step="1" bind:value={price} /></label>
  </div>
  {#if anyVisible}
    <label class="toggle"><input type="checkbox" bind:checked={grain} /> Grain matters on visible panels (keep their grain along the sheet's long side; no turning)</label>
  {/if}
  <div class="chips" style="margin:8px 0">
    <button class="chip" data-testid="nest-dxf" disabled={!result.sheets.length} onclick={() => downloadBlob(`${fileBase}-nested.dxf`, nestedDxf(parts, result), 'application/dxf')}>⬇ Nested sheets (DXF)</button>
    <button class="chip" data-testid="nest-csv" onclick={() => downloadBlob(`${fileBase}-cut-list.csv`, cutListCsv(parts, result), 'text/csv')}>⬇ Cut list (CSV)</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="k">Sheets</div><div class="v">{result.sheetsNeeded}</div><div class="s">{dims[0]} × {dims[1]} mm</div></div>
    <div class="stat"><div class="k">Used</div><div class="v">{(result.utilisation * 100).toFixed(0)} %</div><div class="s">{(result.partArea / 1e6).toFixed(2)} m² of parts</div></div>
    <div class="stat"><div class="k">Waste</div><div class="v">{result.wastePct.toFixed(0)} %</div><div class="s">incl. kerf, trim, offcuts</div></div>
    {#if result.cost}<div class="stat"><div class="k">Sheet cost</div><div class="v">${result.cost.toFixed(0)}</div><div class="s">{result.sheetsNeeded} × ${(+price).toFixed(0)}</div></div>{/if}
  </div>
  {#if result.unplaced.length}
    <p class="small bad" role="alert">
      Not placed: {result.unplaced.map((u) => `${u.name} (${fmt(u.w)} × ${fmt(u.h)} mm — ${u.reason})`).join('; ')}. Pick a bigger sheet{grain ? ' or let visible panels turn' : ''}.
    </p>
  {/if}

  {#each result.sheets as s}
    <div class="cap">Sheet {s.index + 1} of {result.sheets.length} · {s.thickMm} mm {s.material} · {s.placements.length} parts · {(s.utilisation * 100).toFixed(0)} % used</div>
    <div class="svg-wrap">
      <svg viewBox={`-10 -10 ${s.w + 20} ${s.h + 20}`} role="img" aria-label={`Sheet ${s.index + 1} layout`} class="nest">
        <rect x="0" y="0" width={s.w} height={s.h} class="nsheet" />
        <rect x={result.marginMm} y={result.marginMm} width={Math.max(0, s.w - 2 * result.marginMm)} height={Math.max(0, s.h - 2 * result.marginMm)} class="ntrim" />
        <g transform={`translate(0 ${s.h}) scale(1 -1)`}>
          {#each s.placements as pl}
            {@const g = placedGeometry(parts[pl.part], pl)}
            <polygon points={g.outline.map((p) => p.join(',')).join(' ')} class="npart" class:rot={pl.rotated} />
            {#each g.polyHoles as h}<polygon points={h.map((p) => p.join(',')).join(' ')} class="nhole" />{/each}
            {#each g.holes as h}<circle cx={h.x} cy={h.y} r={h.r} class="nhole" />{/each}
          {/each}
          {#if showCuts}
            {#each s.cuts as c}
              {#if c.axis === 'x'}<line x1={c.pos} x2={c.pos} y1={c.from} y2={c.to} class="ncut" class:trim={c.kind === 'trim'} />
              {:else}<line y1={c.pos} y2={c.pos} x1={c.from} x2={c.to} class="ncut" class:trim={c.kind === 'trim'} />{/if}
            {/each}
          {/if}
        </g>
        {#each s.placements as pl}
          {@const fs = Math.max(14, Math.min(40, pl.w / 9, pl.h / 3))}
          <text x={pl.x + pl.w / 2} y={s.h - (pl.y + pl.h / 2)} text-anchor="middle" class="ntxt" font-size={fs}>{pl.name}{pl.rotated ? ' ↻' : ''}</text>
          <text x={pl.x + pl.w / 2} y={s.h - (pl.y + pl.h / 2) + fs * 1.1} text-anchor="middle" class="ntxt mm" font-size={fs * 0.8}>{fmt(pl.w)} × {fmt(pl.h)}</text>
        {/each}
      </svg>
    </div>
  {/each}
  <label class="toggle"><input type="checkbox" bind:checked={showCuts} /> Show the saw cuts</label>
  {#if showCuts}
    <details class="cuts">
      <summary>Cut order ({result.sheets.reduce((a, s) => a + s.cuts.length, 0)} straight through-cuts)</summary>
      {#each result.sheets as s}
        <div class="cap">Sheet {s.index + 1}</div>
        <ol class="small">
          {#each s.cuts as c}
            <li>{c.kind === 'trim' ? 'Trim edge: ' : ''}{c.axis === 'x' ? 'Cut across at x' : 'Cut along at y'} = {fmt(c.pos)} mm, from {fmt(c.from)} to {fmt(c.to)}</li>
          {/each}
        </ol>
      {/each}
    </details>
  {/if}

  <table class="tbl" style="margin-top:8px">
    <thead><tr><th>Panel</th><th>Qty</th><th>W × H mm</th><th>Thick</th><th>Material</th><th>Sheet</th><th>Turned</th></tr></thead>
    <tbody>
      {#each rows as r}
        <tr>
          <td>{r.name}</td>
          <td>{r.qty}</td>
          <td style="white-space:nowrap">{fmt(r.w)} × {fmt(r.h)}</td>
          <td>{r.thickMm}</td>
          <td>{r.material}</td>
          <td>{r.sheets.join(', ') || '—'}</td>
          <td>{r.rotated === 0 ? 'no' : r.rotated === r.qty ? 'yes' : `${r.rotated}/${r.qty}`}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="small muted">
    Guillotine layout: every part comes free with straight through-cuts, so it can be cut on a table saw or with a track saw. {result.kerfMm} mm kerf between parts and {result.marginMm} mm trimmed off each factory edge are allowed for. Sizes are bounding rectangles of the finished parts; the DXF has sheet outlines (SHEET), part outlines (CUT_OUTSIDE), cut-outs (CUT_INSIDE) and labels (TEXT).
  </p>
</section>

<style>
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: end;
  }
  .opts label {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .opts input {
    width: 90px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
    margin: 8px 0;
  }
  .cap {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 8px;
  }
  .nest {
    width: 100%;
    max-height: 520px;
  }
  .nsheet {
    fill: #3b2f22;
    stroke: #fde68a;
    stroke-width: 3;
  }
  .ntrim {
    fill: none;
    stroke: #fde68a;
    stroke-width: 1.5;
    stroke-dasharray: 8 6;
  }
  .npart {
    fill: #b99066;
    stroke: #0a1020;
    stroke-width: 3;
  }
  .npart.rot {
    fill: #a8845e;
  }
  .nhole {
    fill: #3b2f22;
    stroke: #0a1020;
    stroke-width: 2;
  }
  .ncut {
    stroke: #ef4444;
    stroke-width: 2;
  }
  .ncut.trim {
    stroke-dasharray: 10 6;
  }
  .ntxt {
    fill: #1c1408;
    font-weight: 700;
  }
  .ntxt.mm {
    font-weight: 500;
  }
  .cuts ol {
    margin: 4px 0;
    padding-left: 22px;
  }
</style>
