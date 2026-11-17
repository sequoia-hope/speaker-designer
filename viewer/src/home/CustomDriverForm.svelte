<script lang="ts">
  import type { DriverInfo } from './drivers';
  import { sensitivityFromTS } from './boxModel';
  import { home, saveHome } from './homeState.svelte';
  import { newMeasurement, type MeasPoint, type Measurement } from './measurements';
  import {
    TS_LABEL,
    TS_UNIT,
    fitImpedance,
    parseFrd,
    parseTsText,
    parseZma,
    vasFromAddedMass,
    vasFromBox,
    type ImpedanceFit,
    type TsKey,
    type TsParseResult,
  } from './driverImport';

  let {
    initial = null,
    defaultRole = 'woofer',
    onSave,
    onCancel,
  }: {
    initial?: DriverInfo | null;
    defaultRole?: 'woofer' | 'sub';
    onSave: (d: DriverInfo) => void;
    onCancel: () => void;
  } = $props();

  // Every field is text so half-typed numbers ("0.") don't fight the cursor.
  const str = (x: number | undefined | null) => (x == null || !Number.isFinite(x) ? '' : String(x));
  const i0 = initial;
  let f = $state({
    brand: i0?.brand ?? '',
    model: i0?.model ?? '',
    role: (i0?.role === 'sub' || i0?.role === 'pa' ? 'sub' : i0?.role === 'woofer' ? 'woofer' : defaultRole) as 'woofer' | 'sub',
    nominalOhm: str(i0?.nominalOhm ?? 8),
    reOhm: str(i0?.reOhm),
    fsHz: str(i0?.fsHz),
    qts: str(i0?.qts),
    qes: str(i0?.qes),
    qms: str(i0?.qms),
    vasL: str(i0?.vasL),
    sdCm2: str(i0?.sdCm2),
    xmaxMm: str(i0?.xmaxMm),
    leMh: str(i0?.leMh),
    sensDb: str(i0?.sensDb),
    powerW: str(i0?.powerW),
    frameDiaMm: str(i0?.frameDiaMm),
    cutoutDiaMm: str(i0?.cutoutDiaMm),
    mountDepthMm: str(i0?.mountDepthMm),
    priceUsd: str(i0?.priceUsd),
    url: i0?.url ?? '',
  });

  const num = (s: string) => {
    const t = s.trim().replace(',', '.');
    if (!t) return undefined;
    const x = Number(t);
    return Number.isFinite(x) ? x : NaN;
  };

  type Key = keyof typeof f;
  const RANGES: Partial<Record<Key, [number, number, string]>> = {
    nominalOhm: [1, 32, 'Ω'],
    reOhm: [0.5, 64, 'Ω'],
    fsHz: [5, 2000, 'Hz'],
    qts: [0.08, 3, ''],
    qes: [0.08, 5, ''],
    qms: [0.3, 40, ''],
    vasL: [0.02, 3000, 'L'],
    sdCm2: [3, 3000, 'cm²'],
    xmaxMm: [0.1, 40, 'mm'],
    leMh: [0, 20, 'mH'],
    sensDb: [70, 110, 'dB'],
    powerW: [1, 5000, 'W'],
    frameDiaMm: [30, 600, 'mm'],
    cutoutDiaMm: [25, 600, 'mm'],
    mountDepthMm: [10, 400, 'mm'],
    priceUsd: [0, 10000, '$'],
  };
  const REQUIRED: Key[] = ['nominalOhm', 'reOhm', 'fsHz', 'vasL', 'sdCm2', 'xmaxMm'];

  const check = $derived.by(() => {
    const errors: Partial<Record<Key | 'q' | 'name', string>> = {};
    const warnings: string[] = [];
    if (!f.model.trim()) errors.name = 'Give it a model name.';
    for (const [k, [lo, hi, unit]] of Object.entries(RANGES) as [Key, [number, number, string]][]) {
      const x = num(f[k] as string);
      if (x === undefined) {
        if (REQUIRED.includes(k)) errors[k] = 'Required';
      } else if (Number.isNaN(x)) errors[k] = 'Not a number';
      else if (x < lo || x > hi) errors[k] = `Expected ${lo}–${hi} ${unit}`.trim();
    }
    let qts = num(f.qts);
    let qes = num(f.qes);
    let qms = num(f.qms);
    const given = [qts, qes, qms].filter((x) => x !== undefined && !Number.isNaN(x)).length;
    if (given < 1) errors.q = 'Enter Qts (or Qes and Qms).';
    else if (qts === undefined && (qes === undefined || qms === undefined)) errors.q = 'With no Qts, enter both Qes and Qms.';
    if (qts === undefined && qes !== undefined && qms !== undefined) qts = (qes * qms) / (qes + qms);
    if (qts !== undefined && qes !== undefined && qms !== undefined && !errors.q) {
      const implied = (qes * qms) / (qes + qms);
      if (Math.abs(implied - qts) / qts > 0.08)
        warnings.push(`Qes and Qms imply Qts ${implied.toFixed(2)}, but Qts is ${qts}. One of the three is probably mistyped — the model uses Qes and Qms.`);
    }
    if (qts !== undefined && qes !== undefined && qes <= qts) errors.qes = 'Qes must be larger than Qts';
    if (qts !== undefined && qms !== undefined && qms <= qts) errors.qms = 'Qms must be larger than Qts';
    const re = num(f.reOhm);
    const zn = num(f.nominalOhm);
    if (re && zn && re > zn) warnings.push(`Re (${re} Ω) is above the nominal impedance (${zn} Ω) — usually Re is about 0.7–0.9 × nominal.`);
    const cut = num(f.cutoutDiaMm);
    const frame = num(f.frameDiaMm);
    if (cut && frame && cut >= frame) errors.cutoutDiaMm = 'Must be smaller than the frame';
    return { errors, warnings, ok: Object.keys(errors).length === 0, qts, qes, qms };
  });

  /** Driver from the form, with build-only sizes estimated from Sd when left blank. */
  const draft = $derived.by((): DriverInfo | null => {
    if (!check.ok) return null;
    const sd = num(f.sdCm2)!;
    const effDia = 2 * Math.sqrt(sd / Math.PI) * 10; // mm, includes ~half the surround
    const frame = num(f.frameDiaMm) ?? Math.round(effDia * 1.33);
    const cut = num(f.cutoutDiaMm) ?? Math.round(Math.min(effDia * 1.12, frame - 8));
    const role = f.role;
    const sizeIn = Math.round((frame / 25.4) * 2) / 2;
    const d: DriverInfo = {
      id: initial?.id ?? `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      brand: f.brand.trim() || 'Custom',
      model: f.model.trim(),
      role,
      sizeLabel: `${sizeIn}″`,
      nominalOhm: num(f.nominalOhm)!,
      reOhm: num(f.reOhm)!,
      fsHz: num(f.fsHz)!,
      qts: +check.qts!.toFixed(3),
      qes: check.qes,
      qms: check.qms,
      leMh: num(f.leMh),
      vasL: num(f.vasL)!,
      sdCm2: sd,
      xmaxMm: num(f.xmaxMm)!,
      sensDb: 0,
      sensNote: '',
      powerW: num(f.powerW),
      frameDiaMm: frame,
      cutoutDiaMm: cut,
      mountDepthMm: num(f.mountDepthMm),
      priceUsd: num(f.priceUsd),
      url: f.url.trim(),
      blurb: '',
      custom: true,
    };
    const implied = sensitivityFromTS(d);
    const typed = num(f.sensDb);
    d.sensDb = typed ?? +implied.toFixed(1);
    d.sensNote = typed != null ? '2.83V/1m (entered)' : '2.83V/1m (computed from the T/S numbers)';
    const est: string[] = [];
    if (num(f.frameDiaMm) == null) est.push(`frame Ø${frame} mm`);
    if (num(f.cutoutDiaMm) == null) est.push(`cut-out Ø${cut} mm`);
    if (num(f.mountDepthMm) == null) est.push('mounting depth (80 mm assumed)');
    d.blurb =
      'Your own driver, entered from its datasheet.' +
      (est.length ? ` Estimated from the cone size, not the datasheet: ${est.join(', ')} — measure the real driver before cutting the baffle.` : '');
    return d;
  });

  const implied = $derived(draft ? sensitivityFromTS({ ...draft }) : null);
  const sensGap = $derived(implied != null && num(f.sensDb) != null ? num(f.sensDb)! - implied : null);

  type Field = { k: Key; label: string; unit?: string; hint?: string };
  const CORE: Field[] = [
    { k: 'fsHz', label: 'Fs', unit: 'Hz', hint: 'free-air resonance' },
    { k: 'qts', label: 'Qts' },
    { k: 'qes', label: 'Qes' },
    { k: 'qms', label: 'Qms' },
    { k: 'vasL', label: 'Vas', unit: 'L', hint: '1 ft³ = 28.3 L' },
    { k: 'sdCm2', label: 'Sd', unit: 'cm²', hint: 'cone area' },
    { k: 'xmaxMm', label: 'Xmax', unit: 'mm', hint: 'one way (half of p-p)' },
    { k: 'reOhm', label: 'Re', unit: 'Ω', hint: 'DC resistance' },
    { k: 'nominalOhm', label: 'Nominal', unit: 'Ω' },
    { k: 'leMh', label: 'Le', unit: 'mH', hint: 'optional' },
    { k: 'sensDb', label: 'Sensitivity', unit: 'dB', hint: '2.83 V / 1 m · optional' },
    { k: 'powerW', label: 'Power (RMS)', unit: 'W', hint: 'optional, 50 assumed' },
  ];
  const BUILD: Field[] = [
    { k: 'frameDiaMm', label: 'Frame Ø', unit: 'mm', hint: 'outside of the flange' },
    { k: 'cutoutDiaMm', label: 'Cut-out Ø', unit: 'mm', hint: 'hole in the baffle' },
    { k: 'mountDepthMm', label: 'Mount depth', unit: 'mm', hint: 'behind the baffle' },
    { k: 'priceUsd', label: 'Price', unit: '$' },
  ];

  // ---- import: datasheet paste, impedance sweep (.zma), on-axis response (.frd) ----
  let importOpen = $state(false);
  let paste = $state('');
  let pasteRes = $state<TsParseResult | null>(null);
  /** form fields last filled by an import (highlighted until edited) */
  let filled = $state<Partial<Record<Key, boolean>>>({});
  let zFit = $state<ImpedanceFit | null>(null);
  let zErr = $state<string | null>(null);
  let zNotes = $state<string[]>([]);
  let reDc = $state('');
  let vasMode = $state<'mass' | 'box'>('mass');
  let vasAmount = $state('');
  let z2Fit = $state<ImpedanceFit | null>(null);
  let z2Points = $state<MeasPoint[] | null>(null);
  let z2Name = $state('');
  /** measurements attached to the driver when it is saved */
  let attach = $state<{ frd: Measurement | null; zma: Measurement | null }>({ frd: null, zma: null });
  let frdErr = $state<string | null>(null);

  const FORM_KEYS: Partial<Record<TsKey, Key>> = {
    fsHz: 'fsHz',
    qts: 'qts',
    qes: 'qes',
    qms: 'qms',
    vasL: 'vasL',
    sdCm2: 'sdCm2',
    xmaxMm: 'xmaxMm',
    reOhm: 'reOhm',
    nominalOhm: 'nominalOhm',
    leMh: 'leMh',
    sensDb: 'sensDb',
    powerW: 'powerW',
  };
  const fmt = (k: TsKey, x: number) => (k === 'qts' || k === 'qes' || k === 'qms' ? x.toFixed(3) : String(Number(x.toPrecision(4))));
  function fill(vals: Partial<Record<TsKey, number | undefined>>) {
    const next = { ...filled };
    for (const [k, x] of Object.entries(vals) as [TsKey, number | undefined][]) {
      const fk = FORM_KEYS[k];
      if (!fk || x === undefined || !Number.isFinite(x)) continue;
      (f as Record<Key, string>)[fk] = fmt(k, x);
      next[fk] = true;
    }
    filled = next;
  }
  function readPaste() {
    pasteRes = parseTsText(paste);
    fill(pasteRes.values);
  }
  async function fileText(e: Event): Promise<{ name: string; text: string } | null> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    return file ? { name: file.name, text: await file.text() } : null;
  }
  const reEntered = $derived(num(reDc));
  async function loadZma(e: Event) {
    const file = await fileText(e);
    if (!file) return;
    zErr = null;
    try {
      const { parsed, fit } = parseZma(file.text, file.name, reEntered && reEntered > 0 ? reEntered : undefined);
      zNotes = parsed.warnings;
      if (!fit) throw new Error('no clear impedance peak — is it a free-air sweep of a single driver?');
      zFit = fit;
      z2Fit = z2Points ? fitImpedance(z2Points, fit.reOhm) : null;
      fill({ reOhm: fit.reOhm, fsHz: fit.fsHz, qms: fit.qms, qes: fit.qes, qts: fit.qts, leMh: fit.leMh });
      attach.zma = { ...newMeasurement(file.name, parsed), role: 'woofer', reOhm: reEntered && reEntered > 0 ? reEntered : undefined };
    } catch (err) {
      zErr = (err as Error).message;
    }
  }
  async function loadZma2(e: Event) {
    const file = await fileText(e);
    if (!file) return;
    zErr = null;
    try {
      z2Points = parseZma(file.text, file.name).parsed.points;
      z2Name = file.name;
      z2Fit = zFit ? fitImpedance(z2Points, zFit.reOhm) : null;
      if (zFit && !z2Fit) throw new Error('no clear impedance peak in the second sweep');
    } catch (err) {
      zErr = (err as Error).message;
    }
  }
  const vasCalc = $derived.by((): { vasL: number; how: string } | { err: string } | null => {
    if (!zFit || !z2Fit) return null;
    const amt = num(vasAmount);
    if (!amt || !(amt > 0)) return { err: vasMode === 'mass' ? 'Enter the added mass.' : 'Enter the box’s net volume.' };
    if (vasMode === 'mass') {
      const sd = num(f.sdCm2);
      if (!sd || !(sd > 0)) return { err: 'Enter Sd first: the added-mass method needs the cone area.' };
      const r = vasFromAddedMass(zFit.fsHz, z2Fit.fsHz, amt, sd);
      return r ? { vasL: r.vasL, how: `Mms ${r.mmsG.toFixed(1)} g, Cms ${r.cmsMmPerN.toFixed(3)} mm/N` } : { err: 'The second sweep’s Fs should be lower than the free-air Fs.' };
    }
    const v = vasFromBox(zFit.fsHz, zFit.qes, z2Fit.fsHz, z2Fit.qes, amt);
    return v ? { vasL: v, how: `Fc ${z2Fit.fsHz.toFixed(1)} Hz, Qec ${z2Fit.qes.toFixed(2)}` } : { err: 'The boxed sweep’s Fc should be higher than the free-air Fs.' };
  });
  async function loadFrd(e: Event) {
    const file = await fileText(e);
    if (!file) return;
    frdErr = null;
    try {
      attach.frd = { ...newMeasurement(file.name, parseFrd(file.text, file.name)), role: 'woofer' };
    } catch (err) {
      frdErr = (err as Error).message;
    }
  }

  function save() {
    if (!draft) return;
    const d = draft;
    onSave(d);
    // imported sweeps go to the measurements, tied to this driver (the crossover / impedance views pick them up)
    const add = [attach.frd, attach.zma].filter((m): m is Measurement => !!m).map((m) => ({ ...m, driverId: d.id }));
    if (add.length) {
      home.measurements = [...home.measurements, ...add];
      saveHome();
    }
  }
</script>

<form class="cdf" onsubmit={(e) => { e.preventDefault(); save(); }} data-testid="custom-driver-form" aria-label="Your driver">
  <div class="row2">
    <label class="fld"><span>Brand</span><input bind:value={f.brand} placeholder="e.g. Dayton Audio" /></label>
    <label class="fld" class:err={check.errors.name}><span>Model</span><input bind:value={f.model} placeholder="e.g. RS150-8" />{#if check.errors.name}<em>{check.errors.name}</em>{/if}</label>
  </div>
  <div class="chips">
    <button type="button" class="chip" class:on={f.role === 'woofer'} onclick={() => (f.role = 'woofer')}>Woofer / mid-bass</button>
    <button type="button" class="chip" class:on={f.role === 'sub'} onclick={() => (f.role = 'sub')}>Subwoofer</button>
  </div>

  <details class="imp" bind:open={importOpen} data-testid="driver-import">
    <summary>Import from a datasheet or a measurement</summary>
    <p class="small muted">Paste the T/S table from the maker's datasheet, and/or load your own impedance sweep (.zma) or on-axis response (.frd). The form below is filled in for you to check before saving.</p>

    <label class="fld">
      <span>Datasheet text</span>
      <textarea rows="5" bind:value={paste} placeholder={'Fs 28.5 Hz\nQts 0.38\nVas 42 L\nSd 220 cm²\nXmax 6 mm\nRe 3.2 Ω …'} aria-label="Datasheet text"></textarea>
    </label>
    <div class="chips">
      <button type="button" class="chip" onclick={readPaste} disabled={!paste.trim()} data-testid="read-paste">Read parameters</button>
    </div>
    {#if pasteRes}
      <div class="parsed small" data-testid="paste-result">
        {#if pasteRes.found.length}
          <p><b>Found:</b> {#each pasteRes.found as it, i}{i ? ' · ' : ''}{TS_LABEL[it.key]} {fmt(it.key, it.value)}{TS_UNIT[it.key] ? ` ${TS_UNIT[it.key]}` : ''}{/each}</p>
        {:else}
          <p class="errtxt">No T/S parameters recognised in that text.</p>
        {/if}
        {#if pasteRes.derived.length}
          <p><b>Worked out:</b> {#each pasteRes.derived as it, i}{i ? ' · ' : ''}<span title={it.how}>{TS_LABEL[it.key]} {fmt(it.key, it.value)}{TS_UNIT[it.key] ? ` ${TS_UNIT[it.key]}` : ''} <i class="muted">({it.how})</i></span>{/each}</p>
        {/if}
        {#if pasteRes.missing.length}<p class="errtxt"><b>Still missing:</b> {pasteRes.missing.map((k) => TS_LABEL[k]).join(', ')}</p>{/if}
        {#each pasteRes.warnings as w}<p class="warntxt">{w}</p>{/each}
      </div>
    {/if}

    <h4>Impedance sweep (.zma)</h4>
    <div class="chips">
      <label class="fld re"><span>Re from an ohmmeter<i>Ω</i></span><input inputmode="decimal" bind:value={reDc} placeholder="optional" aria-label="Measured DC resistance" /></label>
      <label class="chip file">⬆ Free-air sweep<input type="file" accept=".zma,.txt,.csv,text/plain" onchange={loadZma} hidden data-testid="zma-file" /></label>
    </div>
    {#if zErr}<p class="small errtxt">Couldn't use that file: {zErr}</p>{/if}
    {#if zFit}
      <div class="parsed small" data-testid="zma-result">
        <p>
          <b>Fitted:</b> Re {zFit.reOhm.toFixed(2)} Ω <i class="muted">({zFit.reSource})</i> · Fs {zFit.fsHz.toFixed(1)} Hz · Qms {zFit.qms.toFixed(2)} · Qes {zFit.qes.toFixed(3)} · Qts {zFit.qts.toFixed(3)}{zFit.leMh != null ? ` · Le ${zFit.leMh.toFixed(2)} mH` : ''}
          <span class="muted">(peak {zFit.zMaxOhm.toFixed(1)} Ω, f1/f2 {zFit.f1Hz.toFixed(1)}/{zFit.f2Hz.toFixed(1)} Hz)</span>
        </p>
        {#each [...zNotes, ...zFit.notes] as n}<p class="warntxt">{n}</p>{/each}
        <p class="muted">A single sweep can't give Vas: enter Vas and Sd from the datasheet, or add a second sweep —</p>
        <div class="chips">
          <button type="button" class="chip" class:on={vasMode === 'mass'} onclick={() => (vasMode = 'mass')}>with added mass</button>
          <button type="button" class="chip" class:on={vasMode === 'box'} onclick={() => (vasMode = 'box')}>in a sealed box</button>
          <label class="fld re"><span>{vasMode === 'mass' ? 'Added mass' : 'Box net volume'}<i>{vasMode === 'mass' ? 'g' : 'L'}</i></span><input inputmode="decimal" bind:value={vasAmount} aria-label={vasMode === 'mass' ? 'Added mass' : 'Box net volume'} /></label>
          <label class="chip file">⬆ Second sweep{z2Name ? ` (${z2Name})` : ''}<input type="file" accept=".zma,.txt,.csv,text/plain" onchange={loadZma2} hidden /></label>
        </div>
        {#if vasCalc}
          {#if 'err' in vasCalc}<p class="errtxt">{vasCalc.err}</p>
          {:else}
            <p>Vas <b>{vasCalc.vasL.toFixed(1)} L</b> <span class="muted">({vasCalc.how})</span> <button type="button" class="chip" onclick={() => vasCalc && 'vasL' in vasCalc && fill({ vasL: vasCalc.vasL })}>Use it</button></p>
          {/if}
        {/if}
      </div>
    {/if}

    <h4>On-axis response (.frd)</h4>
    <div class="chips">
      <label class="chip file">⬆ Response file<input type="file" accept=".frd,.txt,.csv,text/plain" onchange={loadFrd} hidden data-testid="frd-file" /></label>
    </div>
    {#if frdErr}<p class="small errtxt">Couldn't use that file: {frdErr}</p>{/if}
    {#if attach.frd || attach.zma}
      <p class="small muted" data-testid="attach-list">
        Saved with the driver, as its measurements:
        {#each [attach.frd, attach.zma] as m, i}
          {#if m}
            <span class="att">{m.fileName} ({m.kind === 'spl' ? 'response' : 'impedance'}, {m.points.length} points)
              <button type="button" class="x" aria-label={`Don't attach ${m.fileName}`} onclick={() => (i === 0 ? (attach.frd = null) : (attach.zma = null))}>✕</button></span>
          {/if}
        {/each}
      </p>
    {/if}
  </details>

  <h3>Thiele/Small parameters</h3>
  <p class="small muted">From the datasheet. Any two of Qts / Qes / Qms will do.</p>
  <div class="grid">
    {#each CORE as fl}
      <label class="fld" class:err={check.errors[fl.k] || ((fl.k === 'qts' || fl.k === 'qes') && check.errors.q && !f[fl.k])} class:filled={filled[fl.k]}>
        <span>{fl.label}{#if fl.unit}<i>{fl.unit}</i>{/if}</span>
        <input inputmode="decimal" autocomplete="off" bind:value={f[fl.k]} aria-label={fl.label} oninput={() => (filled[fl.k] = false)} />
        {#if check.errors[fl.k]}<em>{check.errors[fl.k]}</em>{:else if fl.hint}<small>{fl.hint}</small>{/if}
      </label>
    {/each}
  </div>
  {#if check.errors.q}<p class="small errtxt">{check.errors.q}</p>{/if}

  <h3>For the woodworking plan</h3>
  <p class="small muted">From the datasheet drawing. Leave blank to estimate from the cone size (then measure before cutting).</p>
  <div class="grid">
    {#each BUILD as fl}
      <label class="fld" class:err={check.errors[fl.k]}>
        <span>{fl.label}{#if fl.unit}<i>{fl.unit}</i>{/if}</span>
        <input inputmode="decimal" autocomplete="off" bind:value={f[fl.k]} aria-label={fl.label} />
        {#if check.errors[fl.k]}<em>{check.errors[fl.k]}</em>{:else if fl.hint}<small>{fl.hint}</small>{/if}
      </label>
    {/each}
  </div>
  <label class="fld"><span>Datasheet link</span><input bind:value={f.url} placeholder="https://…" inputmode="url" /></label>

  <ul class="callouts">
    {#each check.warnings as w}<li class="warn">{w}</li>{/each}
    {#if implied != null}
      {#if sensGap != null && Math.abs(sensGap) > 2.5}
        <li class="warn" data-testid="sens-mismatch">The T/S numbers imply <b>{implied.toFixed(1)} dB</b>, but the datasheet says {f.sensDb} dB ({sensGap > 0 ? '+' : ''}{sensGap.toFixed(1)} dB). Usually that means one of Fs, Vas, Sd, Qes or Re is mistyped or in the wrong unit (Vas in ft³? Sd in in²?). Some makers also quote sensitivity at 1 W into the nominal impedance or measure it with the cone's breakup peak.</li>
      {:else}
        <li class="good">The T/S numbers imply {implied.toFixed(1)} dB at 2.83 V{sensGap != null ? `, matching the datasheet's ${f.sensDb} dB` : ''} — the parameters are self-consistent.</li>
      {/if}
    {/if}
  </ul>

  <div class="actions">
    <button type="button" class="btn ghost" onclick={onCancel}>Cancel</button>
    <button type="submit" class="btn" disabled={!draft}>{initial ? 'Save changes' : 'Add driver'}</button>
  </div>
</form>

<style>
  .cdf {
    margin-top: 10px;
    padding: 12px;
    border: 1px dashed var(--border);
    border-radius: 11px;
    background: var(--bg-2);
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 8px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
    color: var(--text-1);
  }
  .fld span i {
    font-style: normal;
    color: var(--text-2);
    margin-left: 4px;
    font-size: 11px;
  }
  .fld input {
    font: inherit;
    font-size: 16px; /* no zoom-on-focus on iOS */
    padding: 7px 9px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-1, #0d1322);
    color: var(--text-0);
    width: 100%;
    box-sizing: border-box;
  }
  .fld small {
    color: var(--text-2);
    font-size: 11px;
  }
  .fld em,
  .errtxt {
    color: #fda4af;
    font-style: normal;
    font-size: 11px;
  }
  .fld.err input {
    border-color: #fb7185;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 10px;
  }
  h3 {
    margin: 14px 0 2px;
  }
  .imp {
    margin: 8px 0 4px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .imp summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--text-1);
  }
  .imp h4 {
    margin: 10px 0 4px;
    font-size: 13px;
  }
  .imp textarea {
    font: inherit;
    font-size: 14px;
    font-family: ui-monospace, monospace;
    padding: 7px 9px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-1, #0d1322);
    color: var(--text-0);
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .imp .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: flex-end;
    margin: 4px 0;
  }
  .imp .fld.re {
    width: 150px;
  }
  .chip.file {
    cursor: pointer;
  }
  .parsed p {
    margin: 3px 0;
  }
  .warntxt {
    color: #fcd34d;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
  }
  .att .x {
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    padding: 0 2px;
  }
  .fld.filled input {
    border-color: #38bdf8;
  }
</style>
