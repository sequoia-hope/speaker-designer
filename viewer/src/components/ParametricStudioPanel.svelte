<script lang="ts">
  import type {
    JoineryKind,
    PanelMaterialKind,
    ParametricBaselineInfo,
    ParametricPatch,
    ParametricSimulationOutput,
    SimulatedVariant,
    SimulationBundle,
  } from '../types';
  import { wasmEngine } from '../wasmEngine';
  import LineChart, { type ChartSeries } from './LineChart.svelte';

  interface Props {
    activeSimId: string;
    bundle: SimulationBundle;
    factoryVariant: SimulatedVariant | null;
    activeVariant: SimulatedVariant;
    selectedCabIdx: number;
    baseVariantIdx: number;
    factoryVariantLabels: string[];
    isParametricActive: boolean;
    lastModifiedToml: string;
    onSelectCab: (idx: number) => void;
    onSelectBaseVariant: (idx: number) => void;
    onApplyOutput: (
      output: ParametricSimulationOutput,
      patch: ParametricPatch,
      elapsedMs: number
    ) => void;
    onResetFactory: () => void;
    onJumpTab: (tab: 'response' | 'cad' | 'spinorama' | 'impedance' | 'nonlinear') => void;
  }

  let {
    activeSimId,
    bundle,
    factoryVariant,
    activeVariant,
    selectedCabIdx,
    baseVariantIdx,
    factoryVariantLabels,
    isParametricActive,
    lastModifiedToml,
    onSelectCab,
    onSelectBaseVariant,
    onApplyOutput,
    onResetFactory,
    onJumpTab,
  }: Props = $props();

  const MATERIALS: { value: PanelMaterialKind; label: string }[] = [
    { value: 'baltic_birch13_ply', label: '13-Ply Void-Free Baltic Birch (680 kg/m³)' },
    { value: 'phenolic_marine_birch', label: 'Phenolic-Film Marine Birch WBP (710 kg/m³)' },
    { value: 'cld_birch_viscoelastic', label: 'CLD Birch + Viscoelastic Core (η = 0.085)' },
    { value: 'high_density_mdf', label: 'High-Density Studio MDF-760 (760 kg/m³)' },
    { value: 'valchromat_hdf', label: 'Valchromat Acoustic HDF-840 (840 kg/m³)' },
    { value: 'cast_aluminum6061', label: 'CNC 6061-T6 Billet Aluminum (E = 68.9 GPa)' },
  ];

  const JOINERY_OPTIONS: { value: JoineryKind; label: string }[] = [
    { value: 'rabbet_dado', label: 'CNC Rabbet & Housing Dado (50%)' },
    { value: 'miter45', label: '45° Lock-Miter + Rebated Baffle' },
    { value: 'interlocking_cnc_tab', label: 'Interlocking Touring CNC Tabs' },
  ];

  let baseline = $state<ParametricBaselineInfo | null>(null);
  let patch = $state<ParametricPatch | null>(null);
  let loadingBaseline = $state<boolean>(true);
  let solving = $state<boolean>(false);
  let solveMs = $state<number | null>(null);
  let wasmErr = $state<string>('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let baselineKey = '';

  function buildInitialPatch(info: ParametricBaselineInfo): ParametricPatch {
    return {
      cabinet_idx: info.cabinet_idx,
      variant_idx: info.variant_idx,
      width_mm: info.width_mm,
      depth_mm: info.depth_mm,
      height_mm: info.height_mm,
      edge_round_mm: info.edge_round_mm,
      enclosure_material: info.enclosure_material,
      baffle_material: info.baffle_material,
      wall_thickness_mm: info.wall_thickness_mm,
      baffle_thickness_mm: info.baffle_thickness_mm,
      brace_count: info.brace_count,
      joinery: info.joinery,
      chamber_volume_scale: 1.0,
      port_length_mm: Math.round(info.port_length_mm),
      port_area_cm2: Math.round(info.port_area_cm2),
      port_flare_mm: Math.round(info.port_flare_mm),
      horn_length_scale: 1.0,
      horn_mouth_scale: 1.0,
      slot_area_cm2: Math.round(info.slot_area_cm2),
      slot_path_mm: Math.round(info.slot_path_mm),
      slot_flow_resistivity: Math.round(info.slot_flow_resistivity),
      lt_target_fp_hz: Number(info.lt_target_fp_hz.toFixed(1)),
      lt_target_qp: Number(info.lt_target_qp.toFixed(2)),
      motor_bl_scale: 1.0,
      moving_mass_scale: 1.0,
      high_spl_volts_rms: Math.round(info.high_spl_volts_rms),
      lf_gain_trim_db: 0.0,
      crossover_scale: 1.0,
      sub_delay_trim_ms: 0.0,
      array_spacing_scale: 1.0,
      include_3d_bem: false,
    };
  }

  async function loadBaselineForTarget(simId: string, cabIdx: number, varIdx: number) {
    loadingBaseline = true;
    wasmErr = '';
    try {
      const { info, elapsedMs } = await wasmEngine.extractBaseline(simId, cabIdx, varIdx);
      baseline = info;
      patch = buildInitialPatch(info);
      solveMs = elapsedMs;
    } catch (err) {
      wasmErr = err instanceof Error ? err.message : String(err);
    } finally {
      loadingBaseline = false;
    }
  }

  $effect(() => {
    const key = `${activeSimId}::${selectedCabIdx}::${baseVariantIdx}`;
    if (activeSimId && key !== baselineKey) {
      baselineKey = key;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      loadBaselineForTarget(activeSimId, selectedCabIdx, baseVariantIdx);
    }
  });

  function scheduleSimulate(immediate = false) {
    if (!patch || !activeSimId) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const run = async () => {
      if (!patch) return;
      solving = true;
      wasmErr = '';
      try {
        const snapshot: ParametricPatch = { ...patch };
        const { output, elapsedMs } = await wasmEngine.simulateParametric(
          activeSimId,
          snapshot
        );
        solveMs = elapsedMs;
        onApplyOutput(output, snapshot, elapsedMs);
      } catch (err) {
        wasmErr = err instanceof Error ? err.message : String(err);
      } finally {
        solving = false;
      }
    };
    if (immediate) {
      run();
    } else {
      debounceTimer = setTimeout(run, 85);
    }
  }

  function handleReset() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (baseline) {
      patch = buildInitialPatch(baseline);
    }
    onResetFactory();
  }

  function downloadModifiedToml() {
    const content = lastModifiedToml.trim();
    if (!content) return;
    const blob = new Blob([content], { type: 'application/toml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSimId}-custom.toml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const activeCabModel = $derived(
    bundle.cabinet_models[selectedCabIdx] ?? bundle.cabinet_models[0] ?? null
  );

  const previewSeries = $derived.by((): ChartSeries[] => {
    const out: ChartSeries[] = [
      {
        label: isParametricActive ? '🎛 Live Parametric SPL' : 'Factory Preset SPL',
        color: '#38bdf8',
        values: activeVariant.curves.spl_high_drive_db,
        width: 2.5,
      },
    ];
    if (isParametricActive && factoryVariant) {
      out.push({
        label: `Factory Baseline (${factoryVariant.label.split('(')[0].trim()})`,
        color: '#fb7185',
        values: factoryVariant.curves.spl_high_drive_db,
        dashed: true,
        width: 1.9,
      });
    }
    return out;
  });
</script>

<div class="param-panel">
  <!-- HEADER BAR: TARGET CABINET, BASE VARIANT, WASM STATUS & RESET / EXPORT -->
  <div class="param-header">
    <div class="hdr-left">
      <div class="title-line">
        <span class="wasm-badge" class:busy={solving}>
          {solving
            ? '⚡ Solving in Rust WASM…'
            : solveMs !== null
              ? `⚡ Rust WASM Ready (${solveMs.toFixed(0)} ms)`
              : '⚡ Rust WASM Engine'}
        </span>
        <h3>Parametric Speaker &amp; Array Design Lab</h3>
      </div>
      <p class="hdr-sub">
        Modify enclosure dimensions, real material thicknesses, acoustic port/horn/cardioid loading,
        driver motor &amp; DSP — re-solving 3D Solid CAD, CNC BOM &amp; coupled acoustics live in your browser.
      </p>
    </div>

    <div class="hdr-actions">
      <button
        class="btn-reset"
        disabled={!isParametricActive && !solving}
        onclick={handleReset}
      >
        ↺ Reset to Factory
      </button>
      {#if lastModifiedToml}
        <button class="btn-export" onclick={downloadModifiedToml}>
          ⬇ Export .toml
        </button>
      {/if}
    </div>
  </div>

  {#if wasmErr}
    <div class="wasm-err">WASM Solver Error: {wasmErr}</div>
  {/if}

  <!-- TARGET SELECTORS + LIVE KPI READOUT -->
  <div class="target-strip">
    <div class="sel-group">
      <label for="param-cab-select">Target Cabinet Spec</label>
      <select
        id="param-cab-select"
        value={selectedCabIdx}
        onchange={(e) =>
          onSelectCab(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {#each bundle.cabinet_models as cab, idx}
          <option value={idx}>{cab.title}</option>
        {/each}
      </select>
    </div>

    <div class="sel-group">
      <label for="param-var-select">Base Scene Configuration</label>
      <select
        id="param-var-select"
        value={baseVariantIdx}
        onchange={(e) =>
          onSelectBaseVariant(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {#each factoryVariantLabels as lbl, idx}
          <option value={idx}>{lbl}</option>
        {/each}
      </select>
    </div>

    {#if activeCabModel}
      <div class="kpi-chips">
        <div class="kpi-chip">
          <span>Net Air Vol</span>
          <strong>{activeCabModel.structural.net_internal_air_volume_l.toFixed(1)} L</strong>
        </div>
        <div class="kpi-chip">
          <span>Total Mass</span>
          <strong>{activeCabModel.structural.total_mass_kg.toFixed(1)} kg</strong>
        </div>
        <div class="kpi-chip">
          <span>Panel f₁₁ Mode</span>
          <strong>{activeCabModel.structural.braced_f11_hz.toFixed(0)} Hz</strong>
        </div>
      </div>
    {/if}
  </div>

  <!-- LIVE COMPACT A/B SPL CHART + QUICK INSPECT BUTTONS -->
  <div class="live-chart-wrap">
    <LineChart
      title="Live Parametric SPL vs Factory Baseline (@ Reference Position)"
      subtitle="Drag any parameter below — 3D Solid CAD (left) and acoustic response overlay update together"
      freqsHz={activeVariant.curves.freqs_hz}
      yLabel="SPL (dB)"
      height={172}
      series={previewSeries}
    />
    <div class="jump-strip">
      <button onclick={() => onJumpTab('cad')}>📐 Inspect Updated 2D Blueprints &amp; BOM →</button>
      <button onclick={() => onJumpTab('impedance')}>🧲 View Z_rad &amp; Impedance →</button>
      <button onclick={() => onJumpTab('nonlinear')}>🔥 View Excursion &amp; THD →</button>
      <button onclick={() => onJumpTab('spinorama')}>🎯 View Spinorama →</button>
    </div>
  </div>

  {#if loadingBaseline || !baseline || !patch}
    <div class="loading-param">Initializing Rust WASM parametric baseline…</div>
  {:else}
    <div class="cards-grid">
      <!-- 1. EXTERIOR CABINET DIMENSIONS & CHAMFER -->
      <section class="p-card">
        <div class="p-card-hdr">
          <h4>1. Exterior Dimensions &amp; Diffraction Edge</h4>
          <span class="topo-tag">{baseline.width_mm}×{baseline.depth_mm}×{baseline.height_mm} mm Factory</span>
        </div>

        <div class="ctrl-row">
          <div class="ctrl-top">
            <label for="sl-width">Cabinet Width (X)</label>
            <strong>{patch.width_mm.toFixed(0)} mm</strong>
          </div>
          <input
            id="sl-width"
            type="range"
            min={Math.max(170, Math.round(baseline.width_mm * 0.65))}
            max={Math.min(1400, Math.round(baseline.width_mm * 1.55))}
            step="5"
            bind:value={patch.width_mm}
            oninput={() => scheduleSimulate(false)}
          />
        </div>

        <div class="ctrl-row">
          <div class="ctrl-top">
            <label for="sl-depth">Cabinet Depth (Y)</label>
            <strong>{patch.depth_mm.toFixed(0)} mm</strong>
          </div>
          <input
            id="sl-depth"
            type="range"
            min={Math.max(190, Math.round(baseline.depth_mm * 0.65))}
            max={Math.min(1500, Math.round(baseline.depth_mm * 1.55))}
            step="5"
            bind:value={patch.depth_mm}
            oninput={() => scheduleSimulate(false)}
          />
        </div>

        <div class="ctrl-row">
          <div class="ctrl-top">
            <label for="sl-height">Cabinet Height (Z)</label>
            <strong>{patch.height_mm.toFixed(0)} mm</strong>
          </div>
          <input
            id="sl-height"
            type="range"
            min={Math.max(220, Math.round(baseline.height_mm * 0.65))}
            max={Math.min(1900, Math.round(baseline.height_mm * 1.5))}
            step="5"
            bind:value={patch.height_mm}
            oninput={() => scheduleSimulate(false)}
          />
        </div>

        <div class="ctrl-row">
          <div class="ctrl-top">
            <label for="sl-round">Baffle Edge Roundover Radius</label>
            <strong>{patch.edge_round_mm.toFixed(0)} mm</strong>
          </div>
          <input
            id="sl-round"
            type="range"
            min="0"
            max="55"
            step="2"
            bind:value={patch.edge_round_mm}
            oninput={() => scheduleSimulate(false)}
          />
        </div>
      </section>

      <!-- 2. STRUCTURAL MATERIALS, WALL THICKNESS & BRACING -->
      <section class="p-card">
        <div class="p-card-hdr">
          <h4>2. Panel Materials, Thickness &amp; Bracing</h4>
          <span class="topo-tag">Kirchhoff–Mindlin Plate Model</span>
        </div>

        <div class="ctrl-row">
          <label class="sel-lbl" for="sel-enc-mat">Enclosure Shell Material</label>
          <select
            id="sel-enc-mat"
            bind:value={patch.enclosure_material}
            onchange={() => scheduleSimulate(true)}
          >
            {#each MATERIALS as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>

        <div class="ctrl-row">
          <label class="sel-lbl" for="sel-baf-mat">Front Baffle Material</label>
          <select
            id="sel-baf-mat"
            bind:value={patch.baffle_material}
            onchange={() => scheduleSimulate(true)}
          >
            {#each MATERIALS as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>

        <div class="two-mini">
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-wall-t">Wall Thickness</label>
              <strong>{patch.wall_thickness_mm.toFixed(0)} mm</strong>
            </div>
            <input
              id="sl-wall-t"
              type="range"
              min="9"
              max="40"
              step="1"
              bind:value={patch.wall_thickness_mm}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-baf-t">Baffle Thickness</label>
              <strong>{patch.baffle_thickness_mm.toFixed(0)} mm</strong>
            </div>
            <input
              id="sl-baf-t"
              type="range"
              min="12"
              max="50"
              step="1"
              bind:value={patch.baffle_thickness_mm}
              oninput={() => scheduleSimulate(false)}
            />
          </div>
        </div>

        <div class="two-mini">
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-braces">Window Braces</label>
              <strong>{patch.brace_count}</strong>
            </div>
            <input
              id="sl-braces"
              type="range"
              min="0"
              max="6"
              step="1"
              bind:value={patch.brace_count}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="ctrl-row">
            <label class="sel-lbl" for="sel-joinery">CNC Joinery</label>
            <select
              id="sel-joinery"
              bind:value={patch.joinery}
              onchange={() => scheduleSimulate(true)}
            >
              {#each JOINERY_OPTIONS as j}
                <option value={j.value}>{j.label}</option>
              {/each}
            </select>
          </div>
        </div>
      </section>

      <!-- 3. TOPOLOGY-SPECIFIC ACOUSTIC LOADING & TUNING -->
      <section class="p-card">
        <div class="p-card-hdr">
          <h4>3. Acoustic Loading &amp; Resonator Tuning</h4>
          <span class="topo-tag">{baseline.topology.replace('_', ' ')}</span>
        </div>

        <div class="ctrl-row">
          <div class="ctrl-top">
            <label for="sl-vol-scale">Internal Chamber Volume Trim</label>
            <strong>{(patch.chamber_volume_scale * 100).toFixed(0)}%</strong>
          </div>
          <input
            id="sl-vol-scale"
            type="range"
            min="0.55"
            max="1.65"
            step="0.05"
            bind:value={patch.chamber_volume_scale}
            oninput={() => scheduleSimulate(false)}
          />
        </div>

        {#if baseline.topology === 'vented' || baseline.topology === 'cardioid_slot'}
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-port-len">Port Duct Length</label>
              <strong>{patch.port_length_mm.toFixed(0)} mm</strong>
            </div>
            <input
              id="sl-port-len"
              type="range"
              min="80"
              max="750"
              step="10"
              bind:value={patch.port_length_mm}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="two-mini">
            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-port-area">Port Area</label>
                <strong>{patch.port_area_cm2.toFixed(0)} cm²</strong>
              </div>
              <input
                id="sl-port-area"
                type="range"
                min="20"
                max={Math.max(450, Math.round(baseline.port_area_cm2 * 1.9))}
                step="5"
                bind:value={patch.port_area_cm2}
                oninput={() => scheduleSimulate(false)}
              />
            </div>

            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-port-flare">Exit Flare Radius</label>
                <strong>{patch.port_flare_mm.toFixed(0)} mm</strong>
              </div>
              <input
                id="sl-port-flare"
                type="range"
                min="0"
                max="45"
                step="2"
                bind:value={patch.port_flare_mm}
                oninput={() => scheduleSimulate(false)}
              />
            </div>
          </div>
        {/if}

        {#if baseline.topology === 'folded_horn' || baseline.topology === 'tapped_horn' || baseline.topology === 'waveguide_loaded'}
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-horn-len">
                Horn Path Length Scale ({(baseline.horn_path_length_m * patch.horn_length_scale).toFixed(2)} m)
              </label>
              <strong>{patch.horn_length_scale.toFixed(2)}×</strong>
            </div>
            <input
              id="sl-horn-len"
              type="range"
              min="0.65"
              max="1.45"
              step="0.03"
              bind:value={patch.horn_length_scale}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-horn-mouth">
                Horn Mouth Area Scale ({(baseline.horn_mouth_area_cm2 * patch.horn_mouth_scale).toFixed(0)} cm²)
              </label>
              <strong>{patch.horn_mouth_scale.toFixed(2)}×</strong>
            </div>
            <input
              id="sl-horn-mouth"
              type="range"
              min="0.65"
              max="1.50"
              step="0.03"
              bind:value={patch.horn_mouth_scale}
              oninput={() => scheduleSimulate(false)}
            />
          </div>
        {/if}

        {#if baseline.topology === 'cardioid_slot'}
          <div class="two-mini">
            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-slot-area">Cardioid Slot Area</label>
                <strong>{patch.slot_area_cm2.toFixed(0)} cm²</strong>
              </div>
              <input
                id="sl-slot-area"
                type="range"
                min="60"
                max="420"
                step="10"
                bind:value={patch.slot_area_cm2}
                oninput={() => scheduleSimulate(false)}
              />
            </div>

            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-slot-path">Delay Path</label>
                <strong>{patch.slot_path_mm.toFixed(0)} mm</strong>
              </div>
              <input
                id="sl-slot-path"
                type="range"
                min="90"
                max="420"
                step="10"
                bind:value={patch.slot_path_mm}
                oninput={() => scheduleSimulate(false)}
              />
            </div>
          </div>

          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-slot-sigma">Porous Slot Flow Resistivity σ</label>
              <strong>{(patch.slot_flow_resistivity / 1000).toFixed(1)} kPa·s/m²</strong>
            </div>
            <input
              id="sl-slot-sigma"
              type="range"
              min="4000"
              max="36000"
              step="1000"
              bind:value={patch.slot_flow_resistivity}
              oninput={() => scheduleSimulate(false)}
            />
          </div>
        {/if}

        {#if baseline.has_linkwitz_transform}
          <div class="two-mini">
            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-lt-fp">Linkwitz Target f_p</label>
                <strong>{patch.lt_target_fp_hz.toFixed(1)} Hz</strong>
              </div>
              <input
                id="sl-lt-fp"
                type="range"
                min="15"
                max="38"
                step="0.5"
                bind:value={patch.lt_target_fp_hz}
                oninput={() => scheduleSimulate(false)}
              />
            </div>

            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-lt-qp">Linkwitz Target Q_p</label>
                <strong>{patch.lt_target_qp.toFixed(2)}</strong>
              </div>
              <input
                id="sl-lt-qp"
                type="range"
                min="0.50"
                max="1.15"
                step="0.03"
                bind:value={patch.lt_target_qp}
                oninput={() => scheduleSimulate(false)}
              />
            </div>
          </div>
        {/if}
      </section>

      <!-- 4. TRANSDUCER MOTOR, DRIVE VOLTAGE & ACTIVE DSP / ARRAY -->
      <section class="p-card">
        <div class="p-card-hdr">
          <h4>4. Motor, Drive &amp; Active DSP / Array</h4>
          <span class="topo-tag">{baseline.primary_driver_name.split('(')[0].trim()}</span>
        </div>

        <div class="two-mini">
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-bl">Motor Force Bl</label>
              <strong>{(baseline.primary_bl_tm * patch.motor_bl_scale).toFixed(1)} T·m</strong>
            </div>
            <input
              id="sl-bl"
              type="range"
              min="0.70"
              max="1.35"
              step="0.03"
              bind:value={patch.motor_bl_scale}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-mms">Moving Mass M_ms</label>
              <strong>{(baseline.primary_mms_g * patch.moving_mass_scale).toFixed(0)} g</strong>
            </div>
            <input
              id="sl-mms"
              type="range"
              min="0.70"
              max="1.45"
              step="0.03"
              bind:value={patch.moving_mass_scale}
              oninput={() => scheduleSimulate(false)}
            />
          </div>
        </div>

        <div class="two-mini">
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-vrms">High-SPL Drive</label>
              <strong>{patch.high_spl_volts_rms.toFixed(0)} Vrms</strong>
            </div>
            <input
              id="sl-vrms"
              type="range"
              min="5"
              max="120"
              step="1"
              bind:value={patch.high_spl_volts_rms}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-lf-gain">LF Bus Gain Trim</label>
              <strong>{patch.lf_gain_trim_db >= 0 ? '+' : ''}{patch.lf_gain_trim_db.toFixed(1)} dB</strong>
            </div>
            <input
              id="sl-lf-gain"
              type="range"
              min="-8"
              max="8"
              step="0.5"
              bind:value={patch.lf_gain_trim_db}
              oninput={() => scheduleSimulate(false)}
            />
          </div>
        </div>

        <div class="two-mini">
          <div class="ctrl-row">
            <div class="ctrl-top">
              <label for="sl-xo">Crossover Freq Scale</label>
              <strong>{patch.crossover_scale.toFixed(2)}×</strong>
            </div>
            <input
              id="sl-xo"
              type="range"
              min="0.65"
              max="1.65"
              step="0.05"
              bind:value={patch.crossover_scale}
              oninput={() => scheduleSimulate(false)}
            />
          </div>

          {#if baseline.placement_count > 1}
            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-spacing">Array Spacing Scale</label>
                <strong>{patch.array_spacing_scale.toFixed(2)}×</strong>
              </div>
              <input
                id="sl-spacing"
                type="range"
                min="0.60"
                max="1.60"
                step="0.05"
                bind:value={patch.array_spacing_scale}
                oninput={() => scheduleSimulate(false)}
              />
            </div>
          {:else}
            <div class="ctrl-row">
              <div class="ctrl-top">
                <label for="sl-delay">Sub/LF Delay Trim</label>
                <strong>{patch.sub_delay_trim_ms >= 0 ? '+' : ''}{patch.sub_delay_trim_ms.toFixed(2)} ms</strong>
              </div>
              <input
                id="sl-delay"
                type="range"
                min="-3"
                max="5"
                step="0.25"
                bind:value={patch.sub_delay_trim_ms}
                oninput={() => scheduleSimulate(false)}
              />
            </div>
          {/if}
        </div>

        <label class="bem-toggle">
          <input
            type="checkbox"
            bind:checked={patch.include_3d_bem}
            onchange={() => scheduleSimulate(true)}
          />
          <span>Include Full 3D Burton–Miller BEM Cabinet Diffraction (~250 ms solve)</span>
        </label>
      </section>
    </div>
  {/if}
</div>

<style>
  .param-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .param-header {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 11px 13px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hdr-left {
    flex: 1;
    min-width: 220px;
  }
  .title-line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .title-line h3 {
    margin: 0;
    font-size: 14px;
  }
  .wasm-badge {
    font-size: 10px;
    font-weight: 700;
    background: rgba(52, 211, 153, 0.16);
    color: var(--emerald);
    border: 1px solid rgba(52, 211, 153, 0.45);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .wasm-badge.busy {
    background: rgba(251, 191, 36, 0.18);
    color: var(--amber);
    border-color: rgba(251, 191, 36, 0.55);
  }
  .hdr-sub {
    margin: 4px 0 0;
    font-size: 11.2px;
    color: var(--text-2);
    line-height: 1.38;
  }
  .hdr-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .btn-reset,
  .btn-export {
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--text-0);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-reset:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn-export {
    background: rgba(56, 189, 248, 0.15);
    border-color: rgba(56, 189, 248, 0.55);
    color: var(--accent);
  }

  .wasm-err {
    background: rgba(251, 113, 133, 0.14);
    border: 1px solid var(--rose);
    color: var(--rose);
    border-radius: 7px;
    padding: 8px 11px;
    font-size: 11.5px;
  }

  .target-strip {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .sel-group {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 155px;
    flex: 1;
  }
  .sel-group label,
  .sel-lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    font-weight: 700;
  }
  .sel-group select,
  .p-card select {
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 11.5px;
    width: 100%;
    min-width: 0;
  }
  .kpi-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .kpi-chip {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    font-size: 10px;
    color: var(--text-2);
  }
  .kpi-chip strong {
    font-size: 12px;
    color: var(--accent);
  }

  .live-chart-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .jump-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .jump-strip button {
    background: var(--bg-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    padding: 4px 9px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .jump-strip button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .cards-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px;
  }
  .p-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .p-card-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .p-card-hdr h4 {
    margin: 0;
    font-size: 12px;
    color: var(--text-0);
  }
  .topo-tag {
    font-size: 10px;
    color: var(--accent);
    background: rgba(56, 189, 248, 0.12);
    padding: 1px 7px;
    border-radius: 99px;
    font-weight: 600;
    text-transform: capitalize;
  }

  .ctrl-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .ctrl-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: var(--text-1);
  }
  .ctrl-top strong {
    color: var(--text-0);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .ctrl-row input[type='range'] {
    width: 100%;
    accent-color: #38bdf8;
    cursor: pointer;
    margin: 0;
  }
  .two-mini {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .bem-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--text-1);
    cursor: pointer;
    padding-top: 3px;
    border-top: 1px solid var(--border);
  }
  .loading-param {
    padding: 18px;
    text-align: center;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-2);
  }

  @media (max-width: 900px) {
    .cards-grid,
    .two-mini {
      grid-template-columns: 1fr;
    }
    .sel-group {
      min-width: 100%;
    }
  }

  @media (pointer: coarse) {
    .sel-group select,
    .p-card select {
      font-size: 16px;
    }
    .ctrl-row input[type='range'] {
      height: 26px;
    }
  }
</style>
