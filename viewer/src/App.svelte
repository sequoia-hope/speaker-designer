<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    DesignEncyclopediaDatabase,
    ParametricPatch,
    ParametricSimulationOutput,
    SimulationBundle,
    SimulationManifest,
    SimulationManifestEntry,
  } from './types';
  import Scene3D from './components/Scene3D.svelte';
  import LineChart, { type ChartSeries } from './components/LineChart.svelte';
  import SonogramPlot from './components/SonogramPlot.svelte';
  import CalibrationPanel from './components/CalibrationPanel.svelte';
  import CabinetCadPanel from './components/CabinetCadPanel.svelte';
  import DesignDatabasePanel from './components/DesignDatabasePanel.svelte';
  import ParametricStudioPanel from './components/ParametricStudioPanel.svelte';
  import { FALLBACK_DESIGN_DATABASE } from './designDatabase';
  import { VirtualMicPlayer } from './audio';

  let { onHome }: { onHome?: () => void } = $props();

  const WAY_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185'];

  let manifest = $state<SimulationManifest | null>(null);
  let designDb = $state<DesignEncyclopediaDatabase>(FALLBACK_DESIGN_DATABASE);
  let activeSimId = $state<string>('');
  let bundle = $state<SimulationBundle | null>(null);
  let factoryBundle = $state.raw<SimulationBundle | null>(null);
  let loading = $state<boolean>(true);
  let errorMsg = $state<string>('');

  let variantIdx = $state<number>(0);
  let baseVariantIdx = $state<number>(0);
  let compareIdx = $state<number>(1);
  let enableCompare = $state<boolean>(true);
  let selectedCabIdx = $state<number>(0);
  let isParametricActive = $state<boolean>(false);
  let lastModifiedToml = $state<string>('');
  let activeTab = $state<
    | 'response'
    | 'parametric'
    | 'database'
    | 'cad'
    | 'spinorama'
    | 'impedance'
    | 'nonlinear'
    | 'calibration'
  >('response');

  let activeMicIdx = $state<number>(0);
  let isAudioPlaying = $state<boolean>(false);
  let showCliModal = $state<boolean>(false);
  let mobileDrawerOpen = $state<boolean>(false);
  let sceneViewMode = $state<'venue' | 'cutaway'>('venue');
  let mobilePane = $state<'3d' | 'charts'>('3d');
  let mainEl = $state<HTMLElement | null>(null);
  const player = new VirtualMicPlayer();

  function setMobileWorkspace(
    mode: 'stage' | 'cad3d' | 'cad2d' | 'tune' | 'guide' | 'plots'
  ) {
    if (mode === 'stage') {
      mobilePane = '3d';
      sceneViewMode = 'venue';
    } else if (mode === 'cad3d') {
      mobilePane = '3d';
      sceneViewMode = 'cutaway';
    } else if (mode === 'cad2d') {
      mobilePane = 'charts';
      activeTab = 'cad';
    } else if (mode === 'tune') {
      mobilePane = 'charts';
      activeTab = 'parametric';
    } else if (mode === 'guide') {
      mobilePane = 'charts';
      activeTab = 'database';
    } else {
      mobilePane = 'charts';
      if (
        activeTab === 'cad' ||
        activeTab === 'parametric' ||
        activeTab === 'database'
      ) {
        activeTab =
          bundle?.calibration && activeSimId.includes('calibration')
            ? 'calibration'
            : 'response';
      }
    }
    mainEl?.scrollTo({ top: 0, behavior: 'instant' });
  }

  const groupedSimulations = $derived.by(() => {
    const groups = new Map<string, SimulationManifestEntry[]>();
    if (!manifest) return groups;
    for (const entry of manifest.simulations) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return groups;
  });

  const activeVariant = $derived(
    bundle ? (bundle.variants[variantIdx] ?? bundle.variants[0]) : null
  );

  const compareVariant = $derived(
    bundle && enableCompare && bundle.variants.length > 1 && compareIdx !== variantIdx
      ? (bundle.variants[compareIdx] ?? null)
      : null
  );

  async function loadManifest(preferredId?: string) {
    loading = true;
    errorMsg = '';
    try {
      const res = await fetch(`./simulations/manifest.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching simulations/manifest.json`);
      const data: SimulationManifest = await res.json();
      manifest = data;

      // Default to Oasis-360 Outdoor EDM or user's preferred simulation on first load
      const defaultEntry =
        data.simulations.find((s) => s.id === preferredId) ??
        data.simulations.find((s) => s.id.includes('oasis-360')) ??
        data.simulations[0];

      if (defaultEntry) {
        await selectSimulation(defaultEntry.id);
      } else {
        loading = false;
      }
    } catch (err) {
      errorMsg = String(err);
      loading = false;
    }
  }

  async function loadDesignDatabase() {
    try {
      const res = await fetch(`./simulations/design_database.json?t=${Date.now()}`);
      if (res.ok) {
        const db: DesignEncyclopediaDatabase = await res.json();
        if (db?.designs?.length) {
          designDb = db;
        }
      }
    } catch {
      // Inline FALLBACK_DESIGN_DATABASE remains active
    }
  }

  async function selectSimulation(id: string) {
    if (!manifest) return;
    const entry = manifest.simulations.find((s) => s.id === id);
    if (!entry) return;

    loading = true;
    errorMsg = '';
    activeSimId = id;
    mobileDrawerOpen = false;
    try {
      const cleanPath = entry.bundle_path.replace(/^\//, '');
      const res = await fetch(`./${cleanPath}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${cleanPath}`);
      const b: SimulationBundle = await res.json();
      factoryBundle = structuredClone(b);
      bundle = b;
      variantIdx = 0;
      baseVariantIdx = 0;
      isParametricActive = false;
      lastModifiedToml = '';
      compareIdx = b.variants.length > 1 ? 1 : 0;
      activeMicIdx = 0;
      const primarySpecId = b.variants[0]?.placements[0]?.cabinet_spec_id;
      const foundCabIdx = primarySpecId
        ? b.cabinet_models.findIndex((c) => c.model_id === primarySpecId)
        : 0;
      selectedCabIdx = foundCabIdx >= 0 ? foundCabIdx : 0;

      if (b.calibration && activeTab !== 'calibration' && id.includes('calibration')) {
        activeTab = 'calibration';
        mobilePane = 'charts';
      } else if (!b.calibration && activeTab === 'calibration') {
        activeTab = 'response';
      }
      mainEl?.scrollTo({ top: 0, behavior: 'instant' });

      if (isAudioPlaying && b.variants[0]?.virtual_mics[0]) {
        await player.updateImpulse(b.variants[0].virtual_mics[0]);
      }
    } catch (err) {
      errorMsg = String(err);
    } finally {
      loading = false;
    }
  }

  async function selectVariant(idx: number) {
    variantIdx = idx;
    if (factoryBundle && idx < factoryBundle.variants.length) {
      baseVariantIdx = idx;
    }
    if (compareIdx === idx && bundle && bundle.variants.length > 1) {
      compareIdx = idx === 0 ? 1 : 0;
    }
    if (bundle) {
      const v = bundle.variants[idx];
      const primarySpecId = v?.placements[0]?.cabinet_spec_id;
      if (primarySpecId) {
        const foundCabIdx = bundle.cabinet_models.findIndex((c) => c.model_id === primarySpecId);
        if (foundCabIdx >= 0) selectedCabIdx = foundCabIdx;
      }
      const mic = v?.virtual_mics[activeMicIdx] ?? v?.virtual_mics[0];
      if (isAudioPlaying && mic) {
        await player.updateImpulse(mic);
      }
    }
  }

  async function handleSelectBaseVariant(idx: number) {
    baseVariantIdx = idx;
    if (!isParametricActive) {
      await selectVariant(idx);
    } else {
      compareIdx = idx;
    }
  }

  async function applyParametricOutput(
    output: ParametricSimulationOutput,
    _patch: ParametricPatch,
    _elapsedMs: number
  ) {
    if (!bundle || !factoryBundle) return;
    const baseVar = factoryBundle.variants[baseVariantIdx] ?? factoryBundle.variants[0];
    const baseShort = baseVar ? baseVar.label.split('(')[0].trim() : 'Preset';
    const liveVar = {
      ...output.simulated_variant,
      variant_id: 'parametric_live',
      label: `🎛 Live Parametric (${baseShort})`,
    };
    bundle.high_spl_volts_rms = output.high_spl_volts_rms;
    bundle.cabinet_models = output.cabinet_models;
    bundle.variants = [...factoryBundle.variants, liveVar];
    const liveIdx = factoryBundle.variants.length;
    variantIdx = liveIdx;
    compareIdx = baseVariantIdx;
    enableCompare = true;
    isParametricActive = true;
    lastModifiedToml = output.modified_toml;

    const mic = liveVar.virtual_mics[activeMicIdx] ?? liveVar.virtual_mics[0];
    if (isAudioPlaying && mic) {
      await player.updateImpulse(mic);
    }
  }

  async function resetParametricToFactory() {
    if (!factoryBundle) return;
    const restored = structuredClone(factoryBundle);
    bundle = restored;
    isParametricActive = false;
    lastModifiedToml = '';
    const restoreIdx = Math.min(baseVariantIdx, restored.variants.length - 1);
    variantIdx = restoreIdx;
    compareIdx = restored.variants.length > 1 ? (restoreIdx === 0 ? 1 : 0) : 0;

    const v = restored.variants[restoreIdx];
    const mic = v?.virtual_mics[activeMicIdx] ?? v?.virtual_mics[0];
    if (isAudioPlaying && mic) {
      await player.updateImpulse(mic);
    }
  }

  async function handleMicChange(idx: number) {
    activeMicIdx = idx;
    const mic = activeVariant?.virtual_mics[idx];
    if (isAudioPlaying && mic) {
      await player.updateImpulse(mic);
    }
  }

  async function toggleAudio() {
    const mic = activeVariant?.virtual_mics[activeMicIdx] ?? activeVariant?.virtual_mics[0];
    if (!mic) return;
    isAudioPlaying = await player.toggle(mic);
  }

  // Build chart series helpers
  const mainSplSeries = $derived.by((): ChartSeries[] => {
    if (!activeVariant) return [];
    const out: ChartSeries[] = [
      {
        label: `${activeVariant.label.split('(')[0].trim()} (Coupled)`,
        color: '#38bdf8',
        values: activeVariant.curves.spl_high_drive_db,
        width: 2.5,
      },
      {
        label: 'Uncoupled Baseline (No Mutual Z_rad)',
        color: '#94a3b8',
        values: activeVariant.curves.spl_uncoupled_baseline_db,
        dashed: true,
        width: 1.5,
      },
    ];
    if (compareVariant) {
      out.push({
        label: `Compare: ${compareVariant.label.split('(')[0].trim()}`,
        color: '#fb7185',
        values: compareVariant.curves.spl_high_drive_db,
        width: 2.0,
      });
    }
    return out;
  });

  const waySplSeries = $derived.by((): ChartSeries[] => {
    if (!activeVariant) return [];
    const out: ChartSeries[] = activeVariant.curves.per_way_spl_db.map(([lbl, vals], i) => ({
      label: lbl,
      color: WAY_COLORS[i % WAY_COLORS.length],
      values: vals,
      width: 1.8,
    }));
    out.push({
      label: 'Combined Sum',
      color: '#f8fafc',
      values: activeVariant.curves.spl_high_drive_db,
      dashed: true,
      width: 1.6,
    });
    return out;
  });

  const dspSeries = $derived.by((): ChartSeries[] => {
    if (!activeVariant) return [];
    return activeVariant.curves.dsp_mag_db.map(([lbl, vals], i) => ({
      label: lbl,
      color: WAY_COLORS[i % WAY_COLORS.length],
      values: vals,
      width: 1.9,
    }));
  });

  const spinoramaSeries = $derived.by((): ChartSeries[] => {
    if (!activeVariant) return [];
    const sp = activeVariant.spinorama;
    const out: ChartSeries[] = [
      { label: 'On-Axis', color: '#38bdf8', values: sp.on_axis_db, width: 2.3 },
      { label: 'Listening Window', color: '#34d399', values: sp.listening_window_db, width: 1.9 },
      { label: 'Early Reflections', color: '#fbbf24', values: sp.early_reflections_db, width: 1.8 },
      { label: 'Sound Power', color: '#a78bfa', values: sp.sound_power_db, width: 1.8 },
    ];
    if (compareVariant) {
      out.push({
        label: `Compare SP (${compareVariant.variant_id})`,
        color: '#fb7185',
        values: compareVariant.spinorama.sound_power_db,
        dashed: true,
        width: 1.6,
      });
    }
    return out;
  });

  const diSeries = $derived.by((): ChartSeries[] => {
    if (!activeVariant) return [];
    const sp = activeVariant.spinorama;
    const out: ChartSeries[] = [
      { label: 'Sound Power DI (dB)', color: '#38bdf8', values: sp.directivity_index_db, width: 2.2 },
      { label: 'Early Reflections DI (dB)', color: '#34d399', values: sp.erdi_db, width: 1.7 },
    ];
    if (compareVariant) {
      out.push({
        label: `Compare DI (${compareVariant.variant_id})`,
        color: '#fb7185',
        values: compareVariant.spinorama.directivity_index_db,
        dashed: true,
        width: 1.9,
      });
    }
    return out;
  });

  onMount(() => {
    loadDesignDatabase();
    loadManifest();
    return () => player.stop();
  });
</script>

<div class="workbench">
  {#if mobileDrawerOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer-backdrop" onclick={() => (mobileDrawerOpen = false)}></div>
  {/if}

  <!-- LEFT DESIGN EXPLORER SIDEBAR (Slide-Over Drawer on Mobile) -->
  <aside class="sidebar" class:open={mobileDrawerOpen}>
    <div class="brand">
      <div class="logo-dot"></div>
      <div class="brand-text">
        <div class="brand-name">Speaker Designer</div>
        <div class="brand-tag">3D BEM · Coupled MNA · Klippel · MAP</div>
      </div>
      <button
        class="drawer-close-btn"
        aria-label="Close designs menu"
        onclick={() => (mobileDrawerOpen = false)}
      >
        ✕
      </button>
    </div>

    <div class="nav-scroll">
      {#each [...groupedSimulations.entries()] as [category, items]}
        <div class="cat-section">
          <div class="cat-hdr">{category}</div>
          {#each items as item}
            <button
              class="sim-item"
              class:active={activeSimId === item.id}
              onclick={() => selectSimulation(item.id)}
            >
              <div class="sim-item-title">
                <span>{item.title.split('—')[0].trim()}</span>
                {#if item.has_calibration}
                  <span class="cal-tag">MAP</span>
                {/if}
              </div>
              <div class="sim-item-sub">
                {item.title.includes('—') ? item.title.split('—')[1].trim() : item.subtitle}
              </div>
            </button>
          {/each}
        </div>
      {/each}
    </div>

    <div class="sidebar-footer">
      <button class="cli-btn" onclick={() => (showCliModal = !showCliModal)}>
        ⌘ Terminal CLI Commands
      </button>
      <div class="footer-links">
        <a href="./architecture.html" target="_blank" rel="noreferrer">Architecture Spec ↗</a>
        <button class="link-btn" onclick={() => loadManifest(activeSimId)}>↻ Reload Runs</button>
      </div>
    </div>
  </aside>

  <!-- MAIN WORKSPACE -->
  <main class="main-area" bind:this={mainEl}>
    {#if errorMsg}
      <div class="err-box">Failed to load simulation bundle: {errorMsg}</div>
    {:else if loading && !bundle}
      <div class="loading-box">Loading 3D acoustic simulation bundles…</div>
    {:else if bundle && activeVariant}
      <!-- TOP HEADER & VARIANT / AURALIZER BAR -->
      <header class="topbar">
        <div class="title-col">
          <div class="title-row">
            {#if onHome}
              <button class="home-btn" onclick={onHome}>⌂ Home Hi-Fi</button>
            {/if}
            <button
              class="mobile-menu-btn"
              aria-label="Open simulation designs menu"
              onclick={() => (mobileDrawerOpen = true)}
            >
              ☰ Designs
            </button>
            <span class="cat-pill">{bundle.category}</span>
            <h1>{bundle.title}</h1>
            <span class="drive-pill">High-SPL Drive: {bundle.high_spl_volts_rms.toFixed(0)} Vrms</span>
          </div>
          <p class="desc">{bundle.description}</p>
        </div>

        <div class="audio-box">
          <div class="audio-lbl">🎧 Virtual-Mic Auralizer</div>
          <div class="audio-controls">
            <select
              value={activeMicIdx}
              onchange={(e) =>
                handleMicChange(Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {#each activeVariant.virtual_mics as vm, idx}
                <option value={idx}>{vm.label}</option>
              {/each}
            </select>
            <button class="listen-btn" class:playing={isAudioPlaying} onclick={toggleAudio}>
              {isAudioPlaying ? '⏹ Stop Audio' : '▶ Listen (EDM)'}
            </button>
          </div>
        </div>
      </header>

      <!-- VARIANT A/B SWITCHER BAR -->
      <div class="variant-bar">
        <div class="v-pills">
          <span class="v-lbl">Active Configuration:</span>
          {#each bundle.variants as v, idx}
            <button
              class="v-btn"
              class:active={variantIdx === idx}
              onclick={() => selectVariant(idx)}
            >
              {v.label}
            </button>
          {/each}
        </div>

        {#if bundle.variants.length > 1}
          <div class="compare-box">
            <label class="cmp-chk">
              <input type="checkbox" bind:checked={enableCompare} />
              <span>A/B Overlay:</span>
            </label>
            {#if enableCompare}
              <select
                value={compareIdx}
                onchange={(e) =>
                  (compareIdx = Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {#each bundle.variants as cv, idx}
                  {#if idx !== variantIdx}
                    <option value={idx}>{cv.label}</option>
                  {/if}
                {/each}
              </select>
            {/if}
          </div>
        {/if}
      </div>

      <!-- SPLIT CONTENT: 3D SCENE + SCORECARDS (LEFT) | MULTI-TAB CHARTS (RIGHT) -->
      <div class="split-grid" data-mobile-pane={mobilePane}>
        <section class="left-pane">
          <div class="scene-holder">
            <Scene3D
              {bundle}
              variant={activeVariant}
              {activeMicIdx}
              bind:viewMode={sceneViewMode}
              {selectedCabIdx}
              onSelectCab={(i) => (selectedCabIdx = i)}
              onOpenCadTab={() => {
                activeTab = 'cad';
                mobilePane = 'charts';
                mainEl?.scrollTo({ top: 0, behavior: 'instant' });
              }}
            />
          </div>

          <!-- ZONE COVERAGE SCORECARD -->
          <div class="zones-card">
            <div class="card-hdr">
              <span>Spatial Zone Coverage &amp; Uniformity Scorecard</span>
              <span class="variant-note">{activeVariant.summary}</span>
            </div>
            <div class="zone-grid">
              {#each activeVariant.zone_metrics as zm, zi}
                {@const cmpZ = compareVariant?.zone_metrics[zi]}
                <div class="z-tile" data-role={zm.role}>
                  <div class="z-name">{zm.label}</div>
                  <div class="z-metrics">
                    <div>
                      <span class="m-lbl">Sub-Bass (35–80 Hz)</span>
                      <strong class="m-val">{zm.bass_mean_spl_db.toFixed(1)} dB</strong>
                      {#if cmpZ}
                        {@const diff = zm.bass_mean_spl_db - cmpZ.bass_mean_spl_db}
                        <span class="delta" class:pos={diff >= 0} class:neg={diff < 0}>
                          ({diff >= 0 ? '+' : ''}{diff.toFixed(1)} dB)
                        </span>
                      {/if}
                    </div>
                    <div>
                      <span class="m-lbl">Spatial Uniformity</span>
                      <strong
                        class="m-val"
                        class:good={zm.bass_spatial_std_db < 3.2}
                        class:bad={zm.bass_spatial_std_db >= 4.2}
                      >
                        ±{zm.bass_spatial_std_db.toFixed(2)} dB
                      </strong>
                      <span class="spread">(Δ {zm.bass_min_max_spread_db.toFixed(1)} dB)</span>
                    </div>
                    <div>
                      <span class="m-lbl">Kick / Mid / High</span>
                      <strong class="m-val">{zm.mid_high_mean_spl_db.toFixed(1)} dB</strong>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </div>

          <!-- DESIGN PHYSICS NOTES -->
          <div class="notes-card">
            <div class="card-hdr">Engineering &amp; Acoustic Physics Insights</div>
            <ul>
              {#each bundle.design_notes as note}
                <li>{note}</li>
              {/each}
            </ul>
          </div>
        </section>

        <!-- RIGHT ENGINEERING PLOTS DECK -->
        <section class="right-pane" data-active-tab={activeTab}>
          <nav class="tabs-bar">
            <button
              class:active={activeTab === 'response'}
              onclick={() => (activeTab = 'response')}
            >
              SPL, Coupling &amp; Crossover
            </button>
            <button
              class="tab-param-btn"
              class:active={activeTab === 'parametric'}
              onclick={() => (activeTab = 'parametric')}
            >
              🎛 Parametric Lab
              {#if isParametricActive}
                <span class="dot-live"></span>
              {/if}
            </button>
            <button
              class="tab-db-btn"
              class:active={activeTab === 'database'}
              onclick={() => (activeTab = 'database')}
            >
              📚 Design Guide
            </button>
            <button
              class="tab-cad-btn"
              class:active={activeTab === 'cad'}
              onclick={() => (activeTab = 'cad')}
            >
              Cabinet CAD, Thickness &amp; BOM
            </button>
            <button
              class:active={activeTab === 'spinorama'}
              onclick={() => (activeTab = 'spinorama')}
            >
              Spinorama &amp; Polar Sonograms
            </button>
            <button
              class:active={activeTab === 'impedance'}
              onclick={() => (activeTab = 'impedance')}
            >
              Impedance &amp; Z_rad Loading
            </button>
            <button
              class:active={activeTab === 'nonlinear'}
              onclick={() => (activeTab = 'nonlinear')}
            >
              Excursion, THD &amp; Thermal
            </button>
            <button
              class:active={activeTab === 'calibration'}
              onclick={() => (activeTab = 'calibration')}
            >
              Bayesian Calibration
              {#if bundle.calibration}
                <span class="dot-live"></span>
              {/if}
            </button>
          </nav>

          <div class="charts-scroll">
            {#if activeTab === 'parametric'}
              <ParametricStudioPanel
                {activeSimId}
                {bundle}
                factoryVariant={factoryBundle?.variants[baseVariantIdx] ?? factoryBundle?.variants[0] ?? null}
                {activeVariant}
                {selectedCabIdx}
                {baseVariantIdx}
                factoryVariantLabels={(factoryBundle ?? bundle).variants.map((v) => v.label)}
                {isParametricActive}
                {lastModifiedToml}
                onSelectCab={(i) => (selectedCabIdx = i)}
                onSelectBaseVariant={handleSelectBaseVariant}
                onApplyOutput={applyParametricOutput}
                onResetFactory={resetParametricToFactory}
                onJumpTab={(t) => {
                  activeTab = t;
                  mainEl?.scrollTo({ top: 0, behavior: 'instant' });
                }}
              />
            {:else if activeTab === 'database'}
              <DesignDatabasePanel
                database={designDb}
                {activeSimId}
                onSelectSimulation={(id) => selectSimulation(id)}
                onOpenParametric={() => {
                  activeTab = 'parametric';
                  mainEl?.scrollTo({ top: 0, behavior: 'instant' });
                }}
                onOpenCad={() => {
                  activeTab = 'cad';
                  sceneViewMode = 'cutaway';
                  mainEl?.scrollTo({ top: 0, behavior: 'instant' });
                }}
                onOpenPlots={(t) => {
                  activeTab = t;
                  mainEl?.scrollTo({ top: 0, behavior: 'instant' });
                }}
              />
            {:else if activeTab === 'cad'}
              <CabinetCadPanel
                cabinets={bundle.cabinet_models}
                {selectedCabIdx}
                onSelectCab={(i) => (selectedCabIdx = i)}
              />
            {:else if activeTab === 'response'}
              <LineChart
                title="System SPL @ Reference Position — Coupled Full Physics vs Uncoupled Baseline"
                subtitle="Solid cyan includes 3D mutual Z_rad mouth coupling + boundary reflections + thermal compression"
                freqsHz={activeVariant.curves.freqs_hz}
                yLabel="SPL (dB re 20 µPa)"
                series={mainSplSeries}
              />

              <LineChart
                title="Per-Way Acoustic Contributions &amp; Coherent Crossover Summation"
                subtitle="Individual radiated way SPLs vs total vector pressure sum at reference mic"
                freqsHz={activeVariant.curves.freqs_hz}
                yLabel="SPL (dB)"
                height={205}
                series={waySplSeries}
              />

              <div class="two-col">
                <LineChart
                  title="Active LMS / DSP Crossover &amp; EQ Transfer Curves"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Gain (dB)"
                  yMin={-36}
                  yMax={20}
                  height={195}
                  series={dspSeries}
                />
                <LineChart
                  title="System Group Delay (Transient Cohesion)"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Group Delay (ms)"
                  height={195}
                  series={[
                    {
                      label: activeVariant.variant_id,
                      color: '#34d399',
                      values: activeVariant.curves.group_delay_ms,
                    },
                    ...(compareVariant
                      ? [
                          {
                            label: `Compare (${compareVariant.variant_id})`,
                            color: '#fb7185',
                            values: compareVariant.curves.group_delay_ms,
                            dashed: true,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            {:else if activeTab === 'spinorama'}
              <LineChart
                title="ANSI/CTA-2034-A Spinorama (70-Point Spherical Orbit)"
                subtitle="Smooth parallel convergence of On-Axis, Listening Window, Early Reflections & Sound Power indicates neutral room/field tonality"
                freqsHz={activeVariant.spinorama.freqs_hz}
                yLabel="SPL (dB)"
                height={225}
                series={spinoramaSeries}
              />

              <LineChart
                title="Directivity Index (DI) &amp; Early Reflections DI"
                subtitle="Constant-directivity OS-SE / Synergy waveguides avoid abrupt crossover beaming steps"
                freqsHz={activeVariant.spinorama.freqs_hz}
                yLabel="DI (dB)"
                yMin={-4}
                yMax={16}
                height={180}
                series={diSeries}
              />

              <div class="two-col">
                <SonogramPlot
                  title="Horizontal Polar Sonogram (-180° to +180°)"
                  subtitle="Normalized to 0° On-Axis (0 dB → -24 dB)"
                  freqsHz={activeVariant.directivity.freqs_hz}
                  anglesDeg={activeVariant.directivity.angles_deg}
                  splMatrix={activeVariant.directivity.horizontal_spl_db}
                />
                <SonogramPlot
                  title="Vertical Polar Sonogram (-180° to +180°)"
                  subtitle="Shows vertical crossover lobing vs coaxial/waveguide control"
                  freqsHz={activeVariant.directivity.freqs_hz}
                  anglesDeg={activeVariant.directivity.angles_deg}
                  splMatrix={activeVariant.directivity.vertical_spl_db}
                />
              </div>
            {:else if activeTab === 'impedance'}
              <LineChart
                title="Normalized Real Radiation Resistance Seen Per Mouth — Re(Z_rad) / (ρ₀c / S_m)"
                subtitle="Computational key to coupled subwoofers: watch 4× stacked horn mouths multiply real acoustic load ~3.7× over a single cabinet!"
                freqsHz={activeVariant.curves.freqs_hz}
                yLabel="Re(Z_rad) / Z_char"
                height={225}
                series={[
                  {
                    label: `${activeVariant.variant_id} Re(Z_rad)`,
                    color: '#34d399',
                    values: activeVariant.curves.normalized_radiation_resistance,
                    width: 2.5,
                  },
                  ...(compareVariant
                    ? [
                        {
                          label: `Compare (${compareVariant.variant_id})`,
                          color: '#fb7185',
                          values: compareVariant.curves.normalized_radiation_resistance,
                          dashed: true,
                          width: 2.0,
                        },
                      ]
                    : []),
                ]}
              />

              <div class="two-col">
                <LineChart
                  title="Primary LF Electrical Impedance Magnitude |Z_e(f)|"
                  subtitle="Reflects horn/port acoustic loading right back into voice-coil electrical terminals"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="|Z_e| (Ω)"
                  height={210}
                  series={[
                    {
                      label: `${activeVariant.variant_id} |Z_e|`,
                      color: '#38bdf8',
                      values: activeVariant.curves.impedance_mag_ohm,
                    },
                    ...(compareVariant
                      ? [
                          {
                            label: `Compare |Z_e|`,
                            color: '#fb7185',
                            values: compareVariant.curves.impedance_mag_ohm,
                            dashed: true,
                          },
                        ]
                      : []),
                  ]}
                />
                <LineChart
                  title="Electrical Impedance Phase ∠Z_e(f)"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Phase (°)"
                  yMin={-75}
                  yMax={75}
                  height={210}
                  refLines={[{ value: 0, label: '0° Resistive', color: '#475569' }]}
                  series={[
                    {
                      label: '∠Z_e (°)',
                      color: '#fbbf24',
                      values: activeVariant.curves.impedance_phase_deg,
                    },
                  ]}
                />
              </div>
            {:else if activeTab === 'nonlinear'}
              <LineChart
                title="Large-Signal Peak Cone Excursion vs Mechanical X_max Limit"
                subtitle="Notice vented port / horn-loading excursion nulls AND mutual-coupling excursion reduction!"
                freqsHz={activeVariant.curves.freqs_hz}
                yLabel="Peak Excursion (mm)"
                height={215}
                refLines={[
                  {
                    value: activeVariant.curves.xmax_limit_mm,
                    label: `X_max = ${activeVariant.curves.xmax_limit_mm.toFixed(1)} mm`,
                    color: '#fb7185',
                  },
                ]}
                series={[
                  {
                    label: `${activeVariant.variant_id} Excursion`,
                    color: '#38bdf8',
                    values: activeVariant.curves.cone_excursion_mm,
                    width: 2.4,
                  },
                  ...(compareVariant
                    ? [
                        {
                          label: `Compare (${compareVariant.variant_id})`,
                          color: '#fbbf24',
                          values: compareVariant.curves.cone_excursion_mm,
                          dashed: true,
                        },
                      ]
                    : []),
                ]}
              />

              <div class="two-col">
                <LineChart
                  title="Klippel Motor/Suspension + Port THD (%)"
                  subtitle="Bl(x), K_ms(x), L_e(x,i) & port turbulence"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="THD (%)"
                  height={200}
                  refLines={[{ value: 10, label: '10% Max Sub THD', color: '#f59e0b' }]}
                  series={[
                    {
                      label: 'THD (%)',
                      color: '#f472b6',
                      values: activeVariant.curves.thd_percent,
                    },
                    ...(compareVariant
                      ? [
                          {
                            label: 'Compare THD (%)',
                            color: '#94a3b8',
                            values: compareVariant.curves.thd_percent,
                            dashed: true,
                          },
                        ]
                      : []),
                  ]}
                />
                <LineChart
                  title="2nd &amp; 3rd Harmonic Distortion (dB re Fundamental)"
                  subtitle="Even asymmetry (HD2) vs symmetric saturation (HD3)"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Relative Level (dB)"
                  yMin={-75}
                  yMax={-5}
                  height={200}
                  series={[
                    { label: 'HD2 (Asymmetric)', color: '#38bdf8', values: activeVariant.curves.hd2_db_rel },
                    { label: 'HD3 (Symmetric)', color: '#fb7185', values: activeVariant.curves.hd3_db_rel },
                  ]}
                />
              </div>

              <div class="two-col">
                <LineChart
                  title="3-Node Voice-Coil Temperature (°C) — Forced Air-Gap Cooling"
                  subtitle="High cone velocity pumps air through magnet gap; port tuning stalls coil & spikes T_vc!"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Voice-Coil Temp (°C)"
                  height={200}
                  series={[
                    {
                      label: `${activeVariant.variant_id} T_vc`,
                      color: '#fbbf24',
                      values: activeVariant.curves.vc_temp_c,
                    },
                    ...(compareVariant
                      ? [
                          {
                            label: 'Compare T_vc',
                            color: '#fb7185',
                            values: compareVariant.curves.vc_temp_c,
                            dashed: true,
                          },
                        ]
                      : []),
                  ]}
                />
                <LineChart
                  title="Thermal Power Compression (dB) &amp; Port Mach Number (×10)"
                  subtitle="Keep flared port Mach < 0.16 (1.6 on ×10 scale) to prevent chuffing"
                  freqsHz={activeVariant.curves.freqs_hz}
                  yLabel="Loss (dB) / 10×Mach"
                  height={200}
                  series={[
                    {
                      label: 'Power Compression (dB)',
                      color: '#fb7185',
                      values: activeVariant.curves.power_compression_db,
                    },
                    {
                      label: '10 × Port/Throat Mach',
                      color: '#34d399',
                      values: activeVariant.curves.port_mach.map((m) => m * 10),
                    },
                  ]}
                />
              </div>
            {:else if activeTab === 'calibration'}
              {#if bundle.calibration}
                <CalibrationPanel calibration={bundle.calibration} />
              {:else}
                <div class="empty-cal">
                  <h3>Measurement-to-Model Bayesian Calibration</h3>
                  <p>
                    This design bundle does not currently embed prototype `.zma` / `.frd` measurements.
                    You can calibrate any built prototype from the terminal or inspect the live
                    calibrated benchmark right now:
                  </p>
                  <pre>cargo run --release -p speaker-cli -- calibrate \
  --design designs/{bundle.id}.toml \
  --inbox-zma measurements/inbox.zma \
  --spl-frd measurements/groundplane_2m.frd</pre>
                  <button
                    class="jump-btn"
                    onclick={() => selectSimulation('06-prototype-bayesian-calibration')}
                  >
                    Open Prototype #1 Bayesian Calibration Benchmark →
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        </section>
      </div>
    {/if}
  </main>

  <nav class="mobile-bottom-nav" aria-label="Mobile Workspace Views">
    <button
      class:active={mobilePane === '3d' && sceneViewMode === 'venue'}
      onclick={() => setMobileWorkspace('stage')}
    >
      <span class="nav-ic">🌐</span>
      <span>Stage</span>
    </button>
    <button
      class:active={mobilePane === '3d' && sceneViewMode === 'cutaway'}
      onclick={() => setMobileWorkspace('cad3d')}
    >
      <span class="nav-ic">🪚</span>
      <span>3D CAD</span>
    </button>
    <button
      class:active={mobilePane === 'charts' && activeTab === 'cad'}
      onclick={() => setMobileWorkspace('cad2d')}
    >
      <span class="nav-ic">📐</span>
      <span>Blueprints</span>
    </button>
    <button
      class:active={mobilePane === 'charts' && activeTab === 'parametric'}
      onclick={() => setMobileWorkspace('tune')}
    >
      <span class="nav-ic">🎛</span>
      <span>Tune</span>
    </button>
    <button
      class:active={mobilePane === 'charts' && activeTab === 'database'}
      onclick={() => setMobileWorkspace('guide')}
    >
      <span class="nav-ic">📚</span>
      <span>Guide</span>
    </button>
    <button
      class:active={
        mobilePane === 'charts' &&
        activeTab !== 'cad' &&
        activeTab !== 'parametric' &&
        activeTab !== 'database'
      }
      onclick={() => setMobileWorkspace('plots')}
    >
      <span class="nav-ic">📈</span>
      <span>Plots</span>
    </button>
  </nav>

  {#if showCliModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-backdrop" onclick={() => (showCliModal = false)}>
      <div class="modal-card" onclick={(e) => e.stopPropagation()}>
        <div class="modal-hdr">
          <h3>Terminal CLI Design &amp; Simulation Workflow (`speaker-cli`)</h3>
          <button onclick={() => (showCliModal = false)}>✕</button>
        </div>
        <p>
          Create or edit any declarative speaker or multi-speaker sound-system `.toml` in
          <code>designs/</code>, run the Rust multi-tier solver, and click <strong>↻ Reload Runs</strong>:
        </p>
        <pre># 1. List all built-in studio, coupled horn-sub &amp; outdoor EDM designs
cargo run --release -p speaker-cli -- list-presets

# 2. Simulate a modified or custom TOML design (updates simulations/manifest.json)
cargo run --release -p speaker-cli -- simulate --design designs/{activeSimId || '04-outdoor-edm-oasis-360'}.toml

# 3. Generate a synchronized Farina exponential sine sweep WAV for field/shop measurement
cargo run --release -p speaker-cli -- generate-sweep --f1-hz 20 --f2-hz 20000 --out-wav sweep_48k.wav

# 4. Calibrate simulation parameters from measured .zma impedance + .frd SPL curves
cargo run --release -p speaker-cli -- calibrate \
  --design designs/06-prototype-bayesian-calibration.toml \
  --inbox-zma inbox.zma --spl-frd spl_2m.frd</pre>
      </div>
    </div>
  {/if}
</div>

<style>
  .workbench {
    display: grid;
    grid-template-columns: 268px 1fr;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }
  .drawer-backdrop,
  .drawer-close-btn,
  .mobile-menu-btn,
  .home-btn {
    border: 1px solid var(--emerald);
    background: rgba(52, 211, 153, 0.12);
    color: var(--emerald);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .mobile-bottom-nav {
    display: none;
  }
  .brand-text {
    flex: 1;
    min-width: 0;
  }
  .sidebar {
    background: var(--bg-1);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
  }
  .logo-dot {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: radial-gradient(circle at 35% 35%, #38bdf8, #6366f1 70%, #0f172a);
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.45);
    flex-shrink: 0;
  }
  .brand-name {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .brand-tag {
    font-size: 10px;
    color: var(--text-2);
    margin-top: 1px;
  }
  .nav-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 9px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .cat-hdr {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-2);
    padding: 0 6px 5px;
  }
  .sim-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 8px 9px;
    color: var(--text-1);
    cursor: pointer;
    margin-bottom: 3px;
    transition: all 0.12s;
  }
  .sim-item:hover {
    background: var(--bg-2);
    border-color: var(--border);
  }
  .sim-item.active {
    background: rgba(56, 189, 248, 0.11);
    border-color: rgba(56, 189, 248, 0.55);
    color: var(--text-0);
  }
  .sim-item-title {
    font-size: 12.5px;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .cal-tag {
    font-size: 9px;
    background: rgba(52, 211, 153, 0.18);
    color: var(--emerald);
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 700;
  }
  .sim-item-sub {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 2px;
    line-height: 1.3;
  }
  .sidebar-footer {
    padding: 10px 11px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cli-btn {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--text-0);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .cli-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .footer-links {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
  }
  .footer-links a,
  .link-btn {
    color: var(--text-2);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 11px;
  }
  .footer-links a:hover,
  .link-btn:hover {
    color: var(--accent);
  }

  .main-area {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    padding: 10px 14px;
    gap: 9px;
  }
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 9px 14px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
  }
  .title-row h1 {
    font-size: 15.5px;
    margin: 0;
    font-weight: 700;
  }
  .cat-pill {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    background: rgba(56, 189, 248, 0.14);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .drive-pill {
    font-size: 10.5px;
    background: rgba(251, 191, 36, 0.14);
    color: var(--amber);
    padding: 2px 8px;
    border-radius: 99px;
    font-weight: 600;
  }
  .desc {
    margin: 4px 0 0;
    font-size: 11.5px;
    color: var(--text-2);
    line-height: 1.38;
  }
  .audio-box {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    flex-shrink: 0;
  }
  .audio-lbl {
    font-size: 10px;
    color: var(--text-2);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .audio-controls {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .audio-controls select {
    background: var(--bg-2);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 7px;
    font-size: 11px;
    max-width: 185px;
  }
  .listen-btn {
    background: rgba(52, 211, 153, 0.15);
    border: 1px solid var(--emerald);
    color: var(--emerald);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .listen-btn.playing {
    background: rgba(251, 113, 133, 0.2);
    border-color: var(--rose);
    color: var(--rose);
  }

  .variant-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    flex-wrap: wrap;
  }
  .v-pills {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .v-lbl {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 600;
  }
  .v-btn {
    background: var(--bg-0);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s;
  }
  .v-btn.active {
    background: rgba(56, 189, 248, 0.16);
    border-color: var(--accent);
    color: var(--text-0);
    font-weight: 600;
  }
  .compare-box {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    color: var(--text-1);
  }
  .cmp-chk {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    color: var(--rose);
    font-weight: 600;
  }
  .compare-box select {
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid rgba(251, 113, 133, 0.45);
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 11px;
    max-width: 240px;
  }

  .split-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1.04fr 1fr;
    gap: 11px;
    overflow: hidden;
  }
  .left-pane {
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
  }
  .scene-holder {
    flex: 1;
    min-height: 375px;
  }
  .zones-card,
  .notes-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
  }
  .card-hdr {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 7px;
    flex-wrap: wrap;
  }
  .variant-note {
    font-size: 11px;
    color: var(--accent);
    font-weight: 400;
  }
  .zone-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
    gap: 8px;
  }
  .z-tile {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 7px 9px;
  }
  .z-tile[data-role='sweet_spot'] {
    border-left-color: var(--emerald);
  }
  .z-tile[data-role='stage_quiet'] {
    border-left-color: var(--amber);
  }
  .z-tile[data-role='far_range'] {
    border-left-color: var(--accent-2);
  }
  .z-name {
    font-size: 11.5px;
    font-weight: 600;
    margin-bottom: 5px;
    color: var(--text-0);
  }
  .z-metrics {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
  }
  .m-lbl {
    color: var(--text-2);
    margin-right: 5px;
  }
  .m-val {
    color: var(--text-0);
  }
  .m-val.good {
    color: var(--emerald);
  }
  .m-val.bad {
    color: var(--rose);
  }
  .spread {
    color: var(--text-2);
    font-size: 10px;
    margin-left: 3px;
  }
  .delta {
    font-size: 10.5px;
    font-weight: 600;
    margin-left: 3px;
  }
  .delta.pos {
    color: var(--emerald);
  }
  .delta.neg {
    color: var(--amber);
  }
  .notes-card ul {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.2px;
    color: var(--text-1);
    line-height: 1.4;
  }

  .right-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    gap: 8px;
  }
  .tabs-bar {
    display: flex;
    gap: 4px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    flex-wrap: wrap;
  }
  .tabs-bar button {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 600;
    padding: 6px 8px;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }
  .tabs-bar button.active {
    background: var(--bg-3);
    color: var(--accent);
  }
  .dot-live {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--emerald);
  }
  .charts-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding-right: 3px;
  }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px;
  }
  @media (max-width: 1280px) and (min-width: 1025px) and (min-height: 541px) {
    .workbench {
      grid-template-columns: 236px 1fr;
    }
    .split-grid {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }
    .left-pane,
    .right-pane,
    .charts-scroll {
      overflow: visible;
      min-height: auto;
      flex: none;
    }
    .two-col {
      grid-template-columns: 1fr;
    }
  }

  /* MOBILE & COMPACT LANDSCAPE (iPhone 16 Pro Max Portrait 440×956 & Landscape 956×440) */
  @media (max-width: 1024px), (max-height: 540px) {
    .workbench {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
    }

    .drawer-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(3, 6, 14, 0.72);
      backdrop-filter: blur(4px);
      z-index: 58;
    }

    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      width: min(85vw, 316px);
      z-index: 60;
      transform: translateX(-105%);
      transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      padding-top: var(--safe-top);
      padding-bottom: var(--safe-bottom);
      padding-left: var(--safe-left);
      box-shadow: 12px 0 36px rgba(0, 0, 0, 0.65);
    }
    .sidebar.open {
      transform: translateX(0);
    }

    .drawer-close-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 7px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      color: var(--text-1);
      font-size: 15px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .sim-item {
      padding: 10px 10px;
    }

    .mobile-menu-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.55);
      color: var(--accent);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .main-area {
      flex: 1;
      height: auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: calc(8px + var(--safe-top)) calc(10px + var(--safe-right))
        calc(72px + var(--safe-bottom)) calc(10px + var(--safe-left));
      gap: 8px;
    }

    .topbar {
      flex-direction: column;
      align-items: stretch;
      gap: 9px;
      padding: 10px 11px;
    }
    .title-row {
      gap: 6px;
    }
    .title-row h1 {
      font-size: 14.5px;
      line-height: 1.25;
      width: 100%;
    }
    .desc {
      font-size: 11px;
    }
    .audio-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      flex-wrap: wrap;
    }
    .audio-lbl {
      margin-bottom: 0;
    }
    .audio-controls {
      flex: 1;
      justify-content: flex-end;
      min-width: 210px;
    }
    .audio-controls select {
      flex: 1;
      max-width: none;
      min-width: 0;
      padding: 5px 7px;
    }
    .listen-btn {
      padding: 6px 11px;
    }

    .variant-bar {
      padding: 7px 9px;
      gap: 7px;
    }
    .v-pills {
      width: 100%;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 2px;
    }
    .v-lbl {
      display: none;
    }
    .v-btn {
      white-space: nowrap;
      padding: 6px 10px;
      flex-shrink: 0;
    }
    .compare-box {
      width: 100%;
      justify-content: space-between;
    }
    .compare-box select {
      flex: 1;
      max-width: none;
      min-width: 0;
    }

    .split-grid {
      display: flex;
      flex-direction: column;
      flex: none;
      overflow: visible;
      min-height: auto;
    }
    .split-grid[data-mobile-pane='3d'] .right-pane {
      display: none;
    }
    .split-grid[data-mobile-pane='charts'] .left-pane {
      display: none;
    }

    .left-pane,
    .right-pane,
    .charts-scroll {
      overflow: visible;
      min-height: auto;
      flex: none;
      padding-right: 0;
    }
    .scene-holder {
      min-height: auto;
      flex: none;
    }
    .zone-grid {
      grid-template-columns: 1fr;
    }
    .two-col {
      grid-template-columns: 1fr;
    }

    .tabs-bar {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      padding: 4px;
    }
    .tabs-bar button {
      flex: none;
      padding: 7px 11px;
      font-size: 12px;
    }
    .right-pane[data-active-tab='cad'] .tabs-bar,
    .right-pane[data-active-tab='parametric'] .tabs-bar,
    .right-pane[data-active-tab='database'] .tabs-bar,
    .tabs-bar .tab-cad-btn,
    .tabs-bar .tab-param-btn,
    .tabs-bar .tab-db-btn {
      display: none;
    }

    .mobile-bottom-nav {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 3px;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 48;
      background: rgba(11, 17, 32, 0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-top: 1px solid var(--border);
      padding: 6px calc(6px + var(--safe-right)) calc(6px + var(--safe-bottom))
        calc(6px + var(--safe-left));
    }
    .mobile-bottom-nav button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      color: var(--text-2);
      padding: 5px 2px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      font-size: 9.8px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mobile-bottom-nav button .nav-ic {
      font-size: 14px;
      line-height: 1.1;
    }
    .mobile-bottom-nav button.active {
      background: rgba(56, 189, 248, 0.14);
      border-color: rgba(56, 189, 248, 0.45);
      color: var(--accent);
    }
  }

  /* Ultra-compact iPhone 16 Pro Max Landscape (956 × 440) so 3D viewport is visible immediately */
  @media (max-height: 500px) and (orientation: landscape) {
    .main-area {
      padding-top: calc(5px + var(--safe-top));
      padding-bottom: calc(50px + var(--safe-bottom));
      gap: 6px;
    }
    .topbar {
      flex-direction: row;
      align-items: center;
      padding: 6px 10px;
      gap: 10px;
    }
    .title-row h1 {
      width: auto;
      font-size: 13.5px;
    }
    .desc {
      display: none;
    }
    .audio-box {
      padding: 4px 8px;
      flex-wrap: nowrap;
    }
    .audio-lbl {
      display: none;
    }
    .variant-bar {
      flex-wrap: nowrap;
      padding: 5px 9px;
    }
    .v-pills {
      width: auto;
      flex: 1;
    }
    .compare-box {
      width: auto;
      flex-shrink: 0;
    }
    .mobile-bottom-nav {
      padding-top: 4px;
      padding-bottom: calc(4px + var(--safe-bottom));
    }
    .mobile-bottom-nav button {
      flex-direction: row;
      gap: 6px;
      padding: 5px 8px;
      font-size: 11.5px;
    }
  }

  .empty-cal {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
  }
  .empty-cal h3 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .empty-cal p {
    font-size: 12px;
    color: var(--text-1);
    line-height: 1.45;
  }
  pre {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 11.5px;
    color: #bae6fd;
    overflow-x: auto;
  }
  .jump-btn {
    margin-top: 8px;
    background: rgba(56, 189, 248, 0.16);
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 7px 13px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .err-box,
  .loading-box {
    margin: auto;
    padding: 18px 24px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 13px;
  }
  .err-box {
    border-color: var(--rose);
    color: var(--rose);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 14, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .modal-card {
    background: var(--bg-1);
    border: 1px solid var(--border-hi);
    border-radius: 10px;
    padding: 16px 20px;
    max-width: 680px;
    width: 92%;
  }
  .modal-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-hdr h3 {
    margin: 0;
    font-size: 14.5px;
  }
  .modal-hdr button {
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 16px;
    cursor: pointer;
  }
  .modal-card p {
    font-size: 12px;
    color: var(--text-1);
  }
</style>
