<script lang="ts">
  // Named saves of whatever design is on screen (plywood settings or printed params),
  // with load / delete and a JSON file to back up or share them.
  import { home, saveHome, withModeler, type SavedDesign } from './homeState.svelte';
  import { designById } from './designs';
  import { printedDesignById } from './hybrid';
  import { downloadBlob } from './exporters';
  import { validatePoints, type Measurement } from './measurements';

  let name = $state('');
  let msg = $state<string | null>(null);

  const currentName = $derived(
    home.activePrint ? (home.activePrint === 'sub' ? 'Printed horn sub' : (printedDesignById(home.activePrint)?.name ?? 'Printed design')) : (designById(home.activeDesign)?.name ?? 'Design')
  );

  function save() {
    const n = name.trim() || `${currentName} — ${new Date().toLocaleDateString()}`;
    const s: SavedDesign = home.activePrint
      ? { id: `sv-${Date.now().toString(36)}`, name: n, savedAt: new Date().toISOString(), kind: 'printed', baseId: home.activePrint, params: $state.snapshot(home.activePrint === 'sub' ? home.hybrid.sub : home.hybrid.designs[home.activePrint]) }
      : { id: `sv-${Date.now().toString(36)}`, name: n, savedAt: new Date().toISOString(), kind: 'plywood', baseId: home.activeDesign, settings: $state.snapshot(home.designs[home.activeDesign]) };
    home.savedDesigns = [s, ...home.savedDesigns];
    name = '';
    msg = `Saved “${n}”.`;
    saveHome();
  }
  function load(s: SavedDesign) {
    if (s.kind === 'printed' && s.params) {
      if (s.baseId === 'sub') home.hybrid.sub = $state.snapshot(s.params);
      else home.hybrid.designs[s.baseId] = $state.snapshot(s.params);
      home.activePrint = s.baseId;
    } else if (s.settings) {
      // settings carry the box modeler's PR / bandpass choices too (older saves: none)
      home.designs[s.baseId] = withModeler({ [s.baseId]: $state.snapshot(s.settings) })[s.baseId];
      home.activeDesign = s.baseId;
      home.activePrint = null;
    }
    msg = `Loaded “${s.name}”.`;
    saveHome();
  }
  function remove(s: SavedDesign) {
    home.savedDesigns = home.savedDesigns.filter((x) => x.id !== s.id);
    saveHome();
  }
  function exportAll() {
    downloadBlob('speaker-designs.json', JSON.stringify({ format: 'speaker-designer/saved-designs', version: 1, designs: $state.snapshot(home.savedDesigns), customDrivers: $state.snapshot(home.customDrivers), measurements: $state.snapshot(home.measurements) }, null, 2), 'application/json');
  }
  async function importFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.format !== 'speaker-designer/saved-designs' || !Array.isArray(data.designs)) throw new Error('not a saved-designs file');
      const have = new Set(home.savedDesigns.map((x) => x.id));
      const add = (data.designs as SavedDesign[]).filter((x) => x && x.id && !have.has(x.id) && (x.kind === 'plywood' ? x.settings : x.params));
      home.savedDesigns = [...add, ...home.savedDesigns];
      // drivers the designs use, if they came along
      const drv = new Set(home.customDrivers.map((x) => x.id));
      for (const d of data.customDrivers ?? []) if (d?.id && !drv.has(d.id)) home.customDrivers.push(d);
      // and the measurements (REW / FRD / ZMA imports)
      const ms = new Set(home.measurements.map((x) => x.id));
      const addM = (Array.isArray(data.measurements) ? (data.measurements as Measurement[]) : []).filter(
        (m) => m?.id && !ms.has(m.id) && (m.kind === 'spl' || m.kind === 'impedance') && validatePoints(m.points).length === 0
      );
      home.measurements = [...home.measurements, ...addM];
      msg = `Imported ${add.length} design${add.length === 1 ? '' : 's'}${addM.length ? ` and ${addM.length} measurement${addM.length === 1 ? '' : 's'}` : ''}.`;
      saveHome();
    } catch (err) {
      msg = `Couldn't import that file: ${(err as Error).message}.`;
    }
    (e.currentTarget as HTMLInputElement).value = '';
  }
</script>

<div class="saved" data-testid="saved-designs">
  <h3>My saved designs</h3>
  <div class="row">
    <input placeholder={`Name for this ${currentName}`} bind:value={name} aria-label="Name for the saved design" />
    <button class="chip" onclick={save}>💾 Save</button>
  </div>
  {#if home.savedDesigns.length}
    <ul>
      {#each home.savedDesigns as s}
        <li>
          <span><b>{s.name}</b> <span class="muted small">{s.kind === 'printed' ? '3D-printed' : 'plywood'} · {new Date(s.savedAt).toLocaleDateString()}</span></span>
          <span class="acts">
            <button class="chip" onclick={() => load(s)} aria-label={`Load ${s.name}`}>Load</button>
            <button class="chip" onclick={() => remove(s)} aria-label={`Delete ${s.name}`}>✕</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="row">
    <button class="chip" onclick={exportAll} disabled={!home.savedDesigns.length && !home.measurements.length}>⬇ Export (JSON)</button>
    <label class="chip">⬆ Import<input type="file" accept="application/json,.json" onchange={importFile} hidden /></label>
  </div>
  {#if msg}<p class="small muted" role="status">{msg}</p>{/if}
</div>

<style>
  .saved {
    margin-top: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 6px 0;
  }
  .row input {
    flex: 1 1 160px;
    font: inherit;
    font-size: 16px;
    padding: 6px 9px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-1, #0d1322);
    color: var(--text-0);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 4px 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .acts {
    display: flex;
    gap: 4px;
  }
</style>
