<script lang="ts">
  // Toggle + picker for overlaying an imported measurement on a predicted chart,
  // and the predicted-vs-measured summary under it.
  import type { MeasurementKind } from './measurements';
  import { fmtDb, fmtHzShort, overlayChoices, type OverlayCompare, type OverlaySel } from './measOverlay';
  import { home } from './homeState.svelte';

  let {
    sel,
    kind = 'spl',
    cmp = null,
    alignNote = '',
    showF3 = true,
    testid = 'meas-overlay',
  }: {
    /** a slot of home.measOverlay (mutated in place, so it persists) */
    sel: OverlaySel;
    kind?: MeasurementKind;
    cmp?: OverlayCompare | null;
    /** what the level match means here, e.g. "near-field / far-field speaker measurement" */
    alignNote?: string;
    showF3?: boolean;
    testid?: string;
  } = $props();

  const choices = $derived(overlayChoices(home.measurements, kind));
  const current = $derived(choices.find((m) => m.id === sel.id) ?? null);
  function toggle(on: boolean) {
    sel.on = on;
    if (on && !current && choices.length) sel.id = choices[choices.length - 1].id;
  }
  const what = $derived(kind === 'spl' ? 'measured response' : 'measured impedance');
</script>

<div class="overlay" data-testid={testid}>
  {#if !choices.length}
    <span class="small muted">No {kind === 'spl' ? 'frequency-response' : 'impedance'} measurement imported yet — add a REW / .{kind === 'spl' ? 'frd' : 'zma'} export in the Measurements card (Speakers tab) to overlay it here.</span>
  {:else}
    <label class="tg">
      <input type="checkbox" checked={sel.on} onchange={(e) => toggle((e.currentTarget as HTMLInputElement).checked)} />
      Overlay a {what}
    </label>
    {#if sel.on}
      <select aria-label="Measurement to overlay" value={current?.id ?? ''} onchange={(e) => (sel.id = (e.currentTarget as HTMLSelectElement).value || null)}>
        {#if !current}<option value="">Pick one…</option>{/if}
        {#each choices as m}
          <option value={m.id}>{m.name}{m.role ? ` (${m.role})` : ''}</option>
        {/each}
      </select>
    {/if}
  {/if}
</div>
{#if sel.on && current && kind === 'spl'}
  {#if cmp}
    <div class="small summary" data-testid={`${testid}-summary`}>
      <div>
        Dashed: <b>{current.name}</b>, shifted <b>{fmtDb(cmp.offsetDb)}</b> so its mean over {fmtHzShort(cmp.band[0])}–{fmtHzShort(cmp.band[1])} (shaded) matches the prediction{alignNote ? ` — ${alignNote}` : ''}.
        {#if cmp.overall}
          Overall: RMS difference <b>{cmp.overall.rmsDb.toFixed(1)} dB</b>, largest {fmtDb(cmp.overall.maxDb)} at {fmtHzShort(cmp.overall.atHz)}.
        {/if}
      </div>
      {#if showF3}
        <div>
          −3 dB point: measured <b>{cmp.f3Meas != null ? fmtHzShort(cmp.f3Meas) : `below ${fmtHzShort(cmp.measFMin)} (the data's end)`}</b>
          vs predicted <b>{cmp.f3Pred != null ? fmtHzShort(cmp.f3Pred) : 'off the chart'}</b>{cmp.f3Meas != null && cmp.f3Pred != null ? ` (${cmp.f3Meas > cmp.f3Pred ? '+' : '−'}${Math.abs(cmp.f3Meas - cmp.f3Pred).toFixed(0)} Hz)` : ''}.
        </div>
      {/if}
      {#if cmp.bands.length > 1}
        <table class="dev">
          <thead><tr><th>Band</th><th>RMS</th><th>Largest (measured − predicted)</th></tr></thead>
          <tbody>
            {#each cmp.bands as b}
              <tr class:far={b.rmsDb > 3}>
                <td>{fmtHzShort(b.f0)}–{fmtHzShort(b.f1)}</td>
                <td>{b.rmsDb.toFixed(1)} dB</td>
                <td>{fmtDb(b.maxDb)} at {fmtHzShort(b.atHz)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {:else}
    <p class="small muted">{current.name} doesn't overlap this chart's frequency range.</p>
  {/if}
{/if}

<style>
  .overlay {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    margin: 6px 0;
  }
  .tg {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
  }
  .tg input {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }
  select {
    max-width: 260px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--text-0, inherit);
    font: inherit;
    font-size: 13px;
  }
  .summary {
    color: var(--text-1);
    display: grid;
    gap: 4px;
    margin: 4px 0 8px;
  }
  .dev {
    border-collapse: collapse;
    font-size: 12px;
  }
  .dev th,
  .dev td {
    text-align: left;
    padding: 2px 10px 2px 0;
    font-variant-numeric: tabular-nums;
  }
  .dev th {
    color: var(--text-2, #8b9dc3);
    font-weight: 500;
  }
  .dev tr.far td {
    color: #fbbf24;
  }
</style>
