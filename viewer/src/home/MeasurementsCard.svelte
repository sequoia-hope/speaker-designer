<script lang="ts">
  // Imported measurements (REW text exports, .frd, .zma): list, assign to a driver/role,
  // compare with the simulation, and estimate T/S from an impedance sweep. SPL
  // measurements assigned to the woofer/tweeter feed the crossover card.
  import MiniChart from './MiniChart.svelte';
  import { home, saveHome } from './homeState.svelte';
  import { allDrivers, type DriverInfo } from './drivers';
  import {
    MeasurementParseError,
    bandLevel,
    driverImpedance,
    estimateTS,
    hasPhase,
    newMeasurement,
    parseMeasurement,
    pickMeasurement,
    smoothOctave,
    usablePoints,
    type Measurement,
    type MeasurementKind,
    type MeasurementRole,
  } from './measurements';
  import { tweeterResponse, twoWaySum } from './crossover';
  import { toDb } from './roomAcoustics';

  let {
    woofer,
    tweeter,
    freqs,
    wooferH,
    wooferZ,
    suggestedFc,
    tweeterOffsetMm,
  }: {
    woofer: DriverInfo;
    tweeter: DriverInfo | null;
    /** the simulation the crossover card uses: woofer in its box (relative, 0 dB = sensitivity) */
    freqs: number[];
    wooferH: { re: number; im: number }[];
    /** simulated input impedance of the woofer group in its box (Ω) */
    wooferZ: number[];
    suggestedFc: number;
    tweeterOffsetMm: number;
  } = $props();

  let msgs = $state<{ cls: string; text: string }[]>([]);
  let smoothN = $state(6);
  let alignLevels = $state(true);
  let open = $state<string | null>(null);

  const COLORS = ['#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#facc15', '#4ade80'];
  const colorOf = (m: Measurement) => COLORS[Math.max(0, home.measurements.indexOf(m)) % COLORS.length];
  const fcHz = $derived(Math.round(suggestedFc / 50) * 50);

  async function onFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const out: { cls: string; text: string }[] = [];
    for (const file of Array.from(input.files ?? [])) {
      try {
        const r = parseMeasurement(await file.text(), file.name);
        const m = newMeasurement(file.name, r);
        home.measurements = [...home.measurements, m];
        out.push({
          cls: r.kindFrom === 'values' || r.warnings.length ? 'warn' : 'good',
          text: `${file.name}: ${r.points.length} points, ${r.kind === 'spl' ? 'frequency response' : 'impedance'} (${r.kindReason}${r.kindFrom === 'values' ? ' — a guess, change it below if wrong' : ''}), ${r.hasPhase ? 'with phase' : 'no phase'}.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`,
        });
        open = m.id;
      } catch (err) {
        out.push({ cls: 'bad', text: `${file.name}: couldn't read it — ${err instanceof MeasurementParseError ? err.message : (err as Error).message}.` });
      }
    }
    msgs = out;
    input.value = '';
    saveHome();
  }

  function update(m: Measurement, patch: Partial<Measurement>) {
    const i = home.measurements.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    const next: Record<string, unknown> = { ...$state.snapshot(home.measurements[i]), ...patch };
    // cleared optional fields are removed, not stored as undefined
    for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
    home.measurements[i] = next as unknown as Measurement;
    saveHome();
  }
  function remove(m: Measurement) {
    if (!confirm(`Delete the measurement “${m.name}”?`)) return;
    home.measurements = home.measurements.filter((x) => x.id !== m.id);
    saveHome();
  }
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(+v) || +v <= 0 ? undefined : +v);

  const driversFor = (role: MeasurementRole | undefined) =>
    allDrivers().filter((d) => (role === 'tweeter' ? d.role === 'tweeter' : role === 'woofer' ? d.role !== 'tweeter' : true));
  const driverName = (id: string | undefined) => {
    const d = allDrivers().find((x) => x.id === id);
    return d ? `${d.brand} ${d.model}` : id;
  };
  const usedIn = (m: Measurement) => {
    if (m.kind !== 'spl' || !tweeter || (m.role !== 'woofer' && m.role !== 'tweeter')) return false;
    return pickMeasurement(home.measurements, m.role, m.role === 'woofer' ? woofer.id : tweeter.id)?.id === m.id;
  };
  const forOther = (m: Measurement) =>
    !!m.driverId && m.driverId !== (m.role === 'tweeter' ? tweeter?.id : m.role === 'woofer' ? woofer.id : m.driverId);

  // --- simulated curves (absolute dB SPL at 2.83 V-ish: sensitivity + relative response) ---
  const pts = (ys: number[]) => freqs.map((x, i) => ({ x, y: ys[i] }));
  const simW = $derived(wooferH.map((h) => woofer.sensDb + toDb(h)));
  const simT = $derived(tweeter ? freqs.map((f) => tweeter.sensDb + toDb(tweeterResponse(tweeter, f))) : null);
  const simSys = $derived(
    tweeter
      ? twoWaySum(freqs, wooferH, woofer, tweeter, { fcHz, type: 'LR4', tweeterLevelDb: 0, tweeterOffsetMm, invertTweeter: false }).sumDb.map((d) => woofer.sensDb + d)
      : null
  );
  const simLevel = (ys: number[], f0: number, f1: number) => {
    const v = ys.filter((_, i) => freqs[i] >= f0 && freqs[i] <= f1);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  /** the simulated curve a measurement is compared against, and the band its level is matched over */
  function reference(m: Measurement): { ys: number[]; band: [number, number] } {
    if (m.role === 'tweeter' && simT) return { ys: simT, band: [2 * fcHz, Math.min(4 * fcHz, 16000)] };
    if (m.role === 'woofer' || !simSys) return { ys: simW, band: [150, Math.max(300, fcHz / 2)] };
    return { ys: simSys, band: [300, 3000] };
  }

  const splList = $derived(home.measurements.filter((m) => m.kind === 'spl' && usablePoints(m).length >= 2));
  const zList = $derived(home.measurements.filter((m) => m.kind === 'impedance' && usablePoints(m).length >= 2));

  const splSeries = $derived.by(() => {
    const s: { label: string; color: string; points: { x: number; y: number }[]; dashed?: boolean; width?: number }[] = [];
    const roles = new Set(splList.map((m) => m.role ?? 'system'));
    if (roles.has('woofer') || roles.has('system') || !tweeter) s.push({ label: 'Woofer (simulated)', color: '#94a3b8', points: pts(simW), dashed: true, width: 1.3 });
    if (simT && roles.has('tweeter')) s.push({ label: 'Tweeter (ideal)', color: '#f9a8d4', points: pts(simT), dashed: true, width: 1.3 });
    if (simSys && roles.has('system')) s.push({ label: `Sum (sim., LR4 ${fcHz} Hz)`, color: '#38bdf8', points: pts(simSys), dashed: true, width: 1.3 });
    for (const m of splList) {
      const p = smoothN ? smoothOctave(usablePoints(m), smoothN) : usablePoints(m);
      let off = 0;
      if (alignLevels) {
        const ref = reference(m);
        const want = simLevel(ref.ys, ...ref.band);
        const have = bandLevel(p, ...ref.band);
        if (Number.isFinite(want) && Number.isFinite(have)) off = want - have;
      }
      s.push({
        label: `${m.name}${alignLevels && Math.abs(off) >= 0.05 ? ` (${off > 0 ? '+' : ''}${off.toFixed(1)} dB)` : ''}`,
        color: colorOf(m),
        points: p.map((q) => ({ x: q.f, y: q.mag + off })),
      });
    }
    return s;
  });
  const splRange = $derived.by(() => {
    let hi = -Infinity;
    for (const s of splSeries) for (const p of s.points) if (p.x >= 20 && p.x <= 20000 && Number.isFinite(p.y)) hi = Math.max(hi, p.y);
    const top = Number.isFinite(hi) ? Math.ceil((hi + 3) / 10) * 10 : 100;
    return { yMin: top - 50, yMax: top };
  });

  const zSeries = $derived.by(() => {
    const s: { label: string; color: string; points: { x: number; y: number }[]; dashed?: boolean; width?: number }[] = [];
    const roles = new Set(zList.map((m) => m.role));
    if (!roles.has('tweeter') || roles.has('woofer') || roles.size > 1) s.push({ label: 'Woofer in its box (sim.)', color: '#94a3b8', points: pts(wooferZ), dashed: true, width: 1.3 });
    if (tweeter && roles.has('tweeter'))
      s.push({ label: 'Tweeter (free-air model)', color: '#f9a8d4', points: freqs.map((f) => ({ x: f, y: driverImpedance(tweeter, f).ohm })), dashed: true, width: 1.3 });
    for (const m of zList) s.push({ label: m.name, color: colorOf(m), points: (smoothN ? smoothOctave(usablePoints(m), Math.max(smoothN, 24)) : usablePoints(m)).map((q) => ({ x: q.f, y: q.mag })) });
    return s;
  });
  const zMax = $derived.by(() => {
    let hi = 0;
    for (const s of zSeries) for (const p of s.points) if (p.x >= 10 && p.x <= 20000 && Number.isFinite(p.y)) hi = Math.max(hi, p.y);
    return Math.min(100, Math.max(10, Math.ceil(hi / 5) * 5));
  });

  const fmtF = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${f.toFixed(f < 100 ? 1 : 0)} Hz`);
  const ROLE_LABEL: Record<MeasurementRole, string> = { woofer: 'Woofer', tweeter: 'Tweeter', system: 'Whole speaker' };
</script>

<section class="card" data-testid="measurements">
  <h2>Measurements</h2>
  <p class="sub">
    Import what you measured (REW: <i>File → Export → Export measurement as text</i>) or the manufacturer's .frd / .zma files. Frequency responses assigned to the woofer or
    tweeter replace the simulation in the crossover above; impedance sweeps give a T/S estimate.
  </p>
  <div class="chips">
    <label class="chip">⬆ Import .frd / .zma / REW .txt<input type="file" multiple accept=".frd,.zma,.txt,.csv,.dat,text/plain" onchange={onFiles} hidden data-testid="meas-file" /></label>
    {#if home.measurements.length}
      <span class="small muted" style="align-self:center">Smoothing:</span>
      {#each [[0, 'none'], [12, '1/12'], [6, '1/6'], [3, '1/3']] as [n, lbl]}
        <button class="chip" class:on={smoothN === n} onclick={() => (smoothN = n as number)}>{lbl} oct</button>
      {/each}
    {/if}
  </div>
  {#if msgs.length}
    <ul class="callouts" role="status">{#each msgs as m}<li class={m.cls}>{m.text}</li>{/each}</ul>
  {/if}

  {#if splList.length}
    <h3>Frequency response</h3>
    <MiniChart series={splSeries} xMin={20} xMax={20000} yMin={splRange.yMin} yMax={splRange.yMax} yStep={10} xTicks={[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]} markers={tweeter ? [{ x: fcHz, label: 'crossover', color: '#fbbf24' }] : []} />
    <label class="toggle small"><input type="checkbox" bind:checked={alignLevels} /> Shift each measurement to the simulation's level (mic distance and drive voltage rarely match the datasheet's)</label>
  {/if}
  {#if zList.length}
    <h3>Impedance</h3>
    <MiniChart series={zSeries} xMin={10} xMax={20000} yMin={0} yMax={zMax} yStep={zMax > 40 ? 10 : 5} yLabel="Ω" xTicks={[10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]} />
  {/if}

  {#if home.measurements.length}
    <ul class="mlist">
      {#each home.measurements as m (m.id)}
        {@const up = usablePoints(m)}
        {@const ts = m.kind === 'impedance' && up.length >= 10 ? estimateTS(up, m.reOhm) : null}
        {@const drv = allDrivers().find((d) => d.id === m.driverId)}
        <li data-testid="measurement">
          <div class="mhd">
            <i class="sw" style:background={colorOf(m)}></i>
            <button class="linklike" onclick={() => (open = open === m.id ? null : m.id)} aria-expanded={open === m.id}><b>{m.name}</b></button>
            <span class="tag">{m.kind === 'spl' ? 'SPL' : 'Impedance'}</span>
            {#if m.role}<span class="tag">{ROLE_LABEL[m.role]}</span>{/if}
            {#if usedIn(m)}<span class="tag used">used in crossover</span>{/if}
            {#if forOther(m)}<span class="tag">for {driverName(m.driverId)}</span>{/if}
            <span class="small muted">{m.points.length} pts · {fmtF(m.points[0].f)}–{fmtF(m.points[m.points.length - 1].f)} · {hasPhase(m.points) ? 'phase' : 'no phase'}</span>
            <button class="chip x" onclick={() => remove(m)} aria-label={`Delete ${m.name}`}>✕</button>
          </div>
          {#if open === m.id}
            <div class="mbody">
              <div class="grid">
                <label>Name <input value={m.name} onchange={(e) => update(m, { name: (e.currentTarget as HTMLInputElement).value.trim() || m.name })} /></label>
                <label>Type
                  <select value={m.kind} onchange={(e) => update(m, { kind: (e.currentTarget as HTMLSelectElement).value as MeasurementKind })}>
                    <option value="spl">Frequency response (dB)</option>
                    <option value="impedance">Impedance (Ω)</option>
                  </select>
                </label>
                <label>Role
                  <select value={m.role ?? ''} onchange={(e) => update(m, { role: ((e.currentTarget as HTMLSelectElement).value || undefined) as MeasurementRole | undefined })}>
                    <option value="">—</option>
                    <option value="woofer">Woofer</option>
                    <option value="tweeter">Tweeter</option>
                    <option value="system">Whole speaker</option>
                  </select>
                </label>
                <label>Driver
                  <select value={m.driverId ?? ''} onchange={(e) => update(m, { driverId: (e.currentTarget as HTMLSelectElement).value || undefined })}>
                    <option value="">{m.role && m.role !== 'system' ? `whichever ${m.role} is chosen` : 'not specified'}</option>
                    {#each driversFor(m.role) as d}<option value={d.id}>{d.brand} {d.model}</option>{/each}
                  </select>
                </label>
                <label>Use from (Hz) <input type="number" min="1" placeholder={String(Math.round(m.points[0].f))} value={m.fMin ?? ''} onchange={(e) => update(m, { fMin: num((e.currentTarget as HTMLInputElement).value) })} /></label>
                <label>Use up to (Hz) <input type="number" min="1" placeholder={String(Math.round(m.points[m.points.length - 1].f))} value={m.fMax ?? ''} onchange={(e) => update(m, { fMax: num((e.currentTarget as HTMLInputElement).value) })} /></label>
              </div>
              <label class="note">Note <input value={m.note} onchange={(e) => update(m, { note: (e.currentTarget as HTMLInputElement).value })} /></label>
              {#if up.length < 10}<p class="small bad-t">Fewer than 10 points in the chosen range: widen it.</p>{/if}
              {#if m.kind === 'spl'}
                {#if hasPhase(m.points)}
                  <label class="toggle small"><input type="checkbox" checked={!!m.minPhase} onchange={(e) => update(m, { minPhase: (e.currentTarget as HTMLInputElement).checked || undefined })} /> Ignore the file's phase (use minimum phase from the magnitude)</label>
                  <label class="toggle small"><input type="checkbox" checked={!!m.keepTiming} disabled={!!m.minPhase} onchange={(e) => update(m, { keepTiming: (e.currentTarget as HTMLInputElement).checked || undefined })} /> Keep its timing (woofer and tweeter measured with the same timing reference / mic position)</label>
                {:else}
                  <p class="small muted">No phase in the file: the crossover uses the minimum phase reconstructed from the magnitude (fine for most drivers in their passband; it can't know the acoustic offset).</p>
                {/if}
                {#if m.role === 'woofer' || m.role === 'tweeter'}
                  <p class="small muted">
                    {#if usedIn(m)}Used in the crossover for the {m.role}.
                    {:else if forOther(m)}Not used: it's assigned to {driverName(m.driverId)}, and this design uses a different {m.role}.
                    {:else if !tweeter}Not used: this design has no crossover.
                    {:else}Not used: another {m.role} measurement takes precedence (one for this exact driver, or a newer one).{/if}
                  </p>
                {/if}
              {:else if ts}
                <div class="ts" data-testid="ts-estimate">
                  <div><b>T/S estimate</b> <span class="small muted">(from the impedance peak — an estimate, not a full measurement)</span></div>
                  <div class="tsrow">
                    <span>Fs <b>{ts.fsHz.toFixed(1)} Hz</b></span>
                    <span>Qms <b>{ts.qms.toFixed(2)}</b></span>
                    <span>Qes <b>{ts.qes.toFixed(2)}</b></span>
                    <span>Qts <b>{ts.qts.toFixed(2)}</b></span>
                    <span>Zmax {ts.zMaxOhm.toFixed(1)} Ω</span>
                    <span>Re {ts.reOhm.toFixed(2)} Ω ({ts.reSource})</span>
                  </div>
                  <label class="small">Re from an ohmmeter (Ω) <input type="number" step="0.01" min="0.1" value={m.reOhm ?? ''} placeholder="auto" onchange={(e) => update(m, { reOhm: num((e.currentTarget as HTMLInputElement).value) })} /></label>
                  {#if drv}
                    <div class="small muted">Datasheet ({drv.brand} {drv.model}): Fs {drv.fsHz} Hz · Qts {drv.qts}{drv.qms ? ` · Qms ${drv.qms}` : ''}{drv.qes ? ` · Qes ${drv.qes}` : ''} · Re {drv.reOhm} Ω</div>
                  {/if}
                  {#each ts.notes as n}<div class="small muted">{n}</div>{/each}
                  <div class="small muted">Vas needs a second sweep (added mass or a known box) and isn't estimated. Measure in free air, driver held still, at a low level.</div>
                </div>
              {:else}
                <p class="small muted">No clear impedance peak found, so no T/S estimate.</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="small muted">Nothing imported yet. Files are plain text: frequency, magnitude (dB or Ω) and optionally phase per line; comment lines start with *, # or ;.</p>
  {/if}
</section>

<style>
  h3 {
    margin: 12px 0 4px;
  }
  .toggle {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin-top: 6px;
  }
  .mlist {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
  }
  .mlist > li {
    border-top: 1px solid var(--border);
    padding: 6px 0;
  }
  .mhd {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 13px;
  }
  .sw {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .x {
    margin-left: auto;
  }
  .tag {
    font-size: 11px;
    background: var(--bg-3);
    border-radius: 6px;
    padding: 1px 6px;
    color: var(--text-1);
  }
  .tag.used {
    background: rgba(52, 211, 153, 0.18);
    color: var(--emerald);
  }
  .linklike {
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-0);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .mbody {
    padding: 6px 0 2px 18px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
  }
  .grid label,
  .note,
  .ts label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--text-2);
  }
  .note {
    margin-top: 6px;
  }
  input:not([type='checkbox']),
  select {
    font: inherit;
    font-size: 14px;
    padding: 4px 7px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--bg-1, #0d1322);
    color: var(--text-0);
  }
  .ts {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-2);
    font-size: 13px;
  }
  .tsrow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 4px 0 6px;
  }
  .ts label {
    max-width: 220px;
  }
  .bad-t {
    color: #fca5a5;
  }
</style>
