<script lang="ts">
  import './home.css';
  import { home, livingPrinted, printedParams, saveHome } from './homeState.svelte';
  import { findDriver } from './drivers';
  import { printedDesignById, tweeterSetup } from './hybrid';
  import { planFor } from './planning';
  import { designById } from './designs';
  import PartsTab from './PartsTab.svelte';
  import OutdoorTab from './OutdoorTab.svelte';
  import { cabinetDims, hybridLivingAlignment, hybridSubModel } from './hybridModels';
  import { fmtFtIn, fmtFtInFrac } from './roomAcoustics';
  import RoomTab from './RoomTab.svelte';
  import SpeakerTab from './SpeakerTab.svelte';
  import BuildTab from './BuildTab.svelte';
  import LearnTab from './LearnTab.svelte';

  type Tab = 'room' | 'speaker' | 'build' | 'print' | 'parts' | 'learn';
  let { onOpenLab, initialTab = 'room' }: { onOpenLab: () => void; initialTab?: Tab } = $props();

  // the old Print tab is now part of Speakers (design) and Build (print plan)
  let tab = $state<Tab>(initialTab === 'print' ? 'speaker' : initialTab);

  // persist every change, whichever tab made it (tabs only save while mounted)
  $effect(() => {
    JSON.stringify(home);
    saveHome();
  });
  let scroller = $state<HTMLElement | null>(null);

  function go(t: Tab) {
    tab = t;
    history.replaceState(null, '', `#home/${t}`);
    scroller?.scrollTo({ top: 0, behavior: 'instant' });
  }
  /** show a printed design ('sub' or a PRINTED_DESIGNS id; 'living' = the printed mains) */
  function openPrint(which: string, t: Tab = 'speaker') {
    home.activePrint = which === 'living' ? home.hybrid.livingId : which;
    go(t);
  }
  function openDesign(id: string, t: Tab = 'speaker') {
    home.activeDesign = id;
    home.activePrint = null;
    go(t);
  }

  const earMm = $derived(Math.round(home.placement.earHeightM * 1000));
  const active = $derived(planFor(home.designs[home.activeDesign] ?? Object.values(home.designs)[0], earMm));
  const mains = $derived(planFor(home.designs[home.system.roles.mains] ?? home.designs.monitor, earMm));
  const plan = $derived(active.plan);
  const woofer = $derived(active.woofer);
  const tweeter = $derived(active.tweeter);
  const activePreset = $derived(designById(home.activeDesign));
  const speakerLabel = $derived(home.hybrid.useLiving ? 'printed hybrid speaker' : (designById(home.system.roles.mains)?.name ?? 'speaker'));
  const hybridSub = $derived(home.hybrid.useOutdoor ? hybridSubModel(home.hybrid.sub) : null);
  const mainsAlignment = $derived((home.hybrid.useLiving ? hybridLivingAlignment(livingPrinted()) : null) ?? mains.plan.box.alignment);

  // sidebar: the printed design when one is active
  const printedSummary = $derived.by(() => {
    const id = home.activePrint;
    if (!id) return null;
    const p = printedParams(id);
    const w = findDriver(p.driverId);
    const tw = tweeterSetup(p).tweeter ?? undefined;
    const dims = cabinetDims(p);
    return {
      name: id === 'sub' ? 'Printed horn sub' : (printedDesignById(id)?.name ?? 'Printed speaker'),
      drivers: `${w?.model ?? ''}${tw ? ` + ${tw.model}` : ''}`,
      size: `${dims.w} × ${dims.h} × ${dims.d} mm · 3D-printed`,
    };
  });

  const NAV: { id: Tab; ic: string; label: string; sub: string }[] = [
    { id: 'room', ic: '🛋️', label: 'Room', sub: 'Living room or outdoor' },
    { id: 'speaker', ic: '🔊', label: 'Speakers', sub: 'Designs, in 3D' },
    { id: 'build', ic: '🪚', label: 'Build', sub: 'Drawings, cut list, steps' },
    { id: 'parts', ic: '🧾', label: 'Parts', sub: 'Bill of materials' },
    { id: 'learn', ic: '📖', label: 'Learn', sub: 'Primer & glossary' },
  ];
  const TITLES: Record<Tab, string> = {
    room: 'Room & sound system',
    speaker: 'Speakers',
    parts: 'Bill of materials',
    print: 'Speakers',
    build: 'Build plan',
    learn: 'Learn',
  };
</script>

<div class="home" data-testid="home-studio">
  <aside class="home-side">
    <div class="side-brand">
      <div class="logo-dot"></div>
      <div>
        <div class="brand-name">Home Hi-Fi</div>
        <div class="brand-tag">Room · Speaker · Build</div>
      </div>
    </div>
    <nav class="side-nav" aria-label="Home Hi-Fi sections (sidebar)">
      {#each NAV as n}
        <button class:active={tab === n.id} onclick={() => go(n.id)}>
          <span class="ic">{n.ic}</span>
          <span><b>{n.label}</b><small>{n.sub}</small></span>
        </button>
      {/each}
    </nav>
    <div class="side-sum">
      <div class="k">Project</div>
      <div>{home.roomName}</div>
      <div class="muted small">{fmtFtInFrac(home.room.widthM)} × {fmtFtInFrac(home.room.depthM)}, {fmtFtIn(home.room.heightM)} ceiling</div>
      <div style="margin-top:6px">System: {home.system.layout}</div>
      {#if printedSummary}
        <div style="margin-top:6px">Designing: {printedSummary.name}</div>
        <div class="muted small">{printedSummary.drivers}</div>
        <div class="muted small">{printedSummary.size}</div>
      {:else}
        <div style="margin-top:6px">Designing: {activePreset?.name}</div>
        <div class="muted small">{woofer.model}{tweeter ? ` + ${tweeter.model}` : ''}</div>
        <div class="muted small">{plan.box.externalMm.w} × {plan.box.externalMm.h} × {plan.box.externalMm.d} mm · {plan.box.netVolumeL.toFixed(1)} L</div>
      {/if}
    </div>
    <button class="lab-btn side-lab" onclick={onOpenLab}>Open Acoustics Lab →</button>
  </aside>
  <div class="home-main">
    <header class="home-top">
      <h1>
        {tab === 'room' && home.venue === 'outdoor' ? 'Outdoor sound system' : TITLES[tab]}
        <small>Home Hi-Fi · {home.venue === 'outdoor' ? `Outdoor · ${home.outdoor.widthM} × ${home.outdoor.crowdDepthM} m` : home.roomName}</small>
      </h1>
      <button class="lab-btn top-lab" onclick={onOpenLab}>Acoustics Lab</button>
    </header>
    <div class="home-scroll" bind:this={scroller}>
      <div class="home-inner">
        {#if tab === 'room' && home.venue === 'outdoor'}
          <OutdoorTab subModel={hybridSub} />
        {:else if tab === 'room'}
          <RoomTab
            alignment={mainsAlignment}
            {speakerLabel}
            onGoSpeaker={() => openDesign(home.system.roles.mains)}
            onOpenDesign={(id: string) => openDesign(id)}
            speakerMm={mains.plan.box.externalMm}
            tweeterFromTopMm={mains.plan.holes[0]?.yMm ?? 60}
          />
        {:else if tab === 'speaker'}
          <SpeakerTab {plan} {woofer} {tweeter} onGoBuild={() => go('build')} onOpenPrint={openPrint} />
        {:else if tab === 'build'}
          <BuildTab {plan} {woofer} {tweeter} onOpenPrint={openPrint} />
        {:else if tab === 'parts'}
          <PartsTab onOpenDesign={(id: string) => openDesign(id, 'build')} />
        {:else}
          <LearnTab {onOpenLab} />
        {/if}
      </div>
    </div>
    <nav class="home-tabs" aria-label="Home Hi-Fi sections">
      {#each NAV as n}
        <button class:active={tab === n.id} onclick={() => go(n.id)}><span class="ic">{n.ic}</span>{n.label}</button>
      {/each}
    </nav>
  </div>
</div>
