<script lang="ts">
  import type { DriverInfo } from './drivers';
  import { sensitivityFromTS } from './boxModel';

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

  function save() {
    if (draft) onSave(draft);
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

  <h3>Thiele/Small parameters</h3>
  <p class="small muted">From the datasheet. Any two of Qts / Qes / Qms will do.</p>
  <div class="grid">
    {#each CORE as fl}
      <label class="fld" class:err={check.errors[fl.k] || ((fl.k === 'qts' || fl.k === 'qes') && check.errors.q && !f[fl.k])}>
        <span>{fl.label}{#if fl.unit}<i>{fl.unit}</i>{/if}</span>
        <input inputmode="decimal" autocomplete="off" bind:value={f[fl.k]} aria-label={fl.label} />
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
</style>
