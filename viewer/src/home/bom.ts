// Bill of materials for a whole system: every speaker in the chosen layout,
// built from its assigned design, plus electronics, measurement and room
// treatment. Prices: see catalog.ts (PRICES_AS_OF).

import { PARTS, KITS, type Kit } from './catalog';
import { designById, type DesignSettings, type Role } from './designs';
import type { DriverInfo } from './drivers';
import { planFor, type PlannedDesign } from './planning';
import { MATERIALS, nestSheets, type Panel, type SheetLayout } from './speakerBuild';
import type { LayoutId, SystemSpeaker } from './system';

export interface BomLine {
  group: 'Drivers' | 'Cabinet hardware' | 'Wood & glue' | 'Electronics' | 'Measure & wire' | 'Room treatment';
  item: string;
  qty: number;
  unit?: number;
  vendor: string;
  part?: string | null;
  url?: string;
  note?: string;
}

export interface DesignUse {
  designId: string;
  name: string;
  roles: Role[];
  units: number;
  planned: PlannedDesign;
}

export interface Bom {
  uses: DesignUse[];
  lines: BomLine[];
  sheets: { materialName: string; layouts: SheetLayout[] }[];
  total: number;
  unpriced: number;
  electronicsNote: string;
}

const ROLE_ORDER: Role[] = ['mains', 'center', 'surround', 'height', 'fill', 'sub'];

function driverLine(d: DriverInfo, qty: number, what: string): BomLine {
  return {
    group: 'Drivers',
    item: `${d.brand} ${d.model} — ${what}`,
    qty,
    unit: d.priceUsd,
    vendor: d.vendor ?? '—',
    part: d.partNo ?? null,
    url: d.buyUrl ?? d.url,
  };
}

const P = (k: keyof typeof PARTS, qty: number, group: BomLine['group'], note?: string): BomLine => ({
  group,
  item: PARTS[k].item,
  qty,
  unit: PARTS[k].usd,
  vendor: 'Parts Express',
  part: PARTS[k].part,
  url: PARTS[k].url,
  note: note ?? PARTS[k].spec,
});

export function systemBom(
  layout: LayoutId,
  speakers: SystemSpeaker[],
  roles: Record<Role, string>,
  designs: Record<string, DesignSettings>,
  earHeightMm: number,
  route: 'passive' | 'active'
): Bom {
  // ---- which designs, how many of each ----
  const uses = new Map<string, DesignUse>();
  for (const role of ROLE_ORDER) {
    const n = speakers.filter((s) => s.role === role).length;
    if (!n) continue;
    const id = roles[role];
    const st = designs[id];
    if (!st) continue;
    const u = uses.get(id) ?? { designId: id, name: designById(id)?.name ?? id, roles: [], units: 0, planned: planFor(st, earHeightMm) };
    u.roles.push(role);
    u.units += n;
    uses.set(id, u);
  }
  const list = [...uses.values()];
  const lines: BomLine[] = [];

  // ---- drivers ----
  for (const u of list) {
    const { plan, woofer, tweeter } = u.planned;
    lines.push(driverLine(woofer, u.units * plan.box.wooferCount, `${u.name}`));
    if (tweeter) lines.push(driverLine(tweeter, u.units, `${u.name}`));
  }

  // ---- cabinet hardware ----
  const nonSubUnits = list.filter((u) => u.planned.plan.box.arrangement !== 'sub').reduce((a, u) => a + u.units, 0);
  const subUnits = list.filter((u) => u.planned.plan.box.arrangement === 'sub').reduce((a, u) => a + u.units, 0);
  const driverCount = list.reduce((a, u) => a + u.units * (u.planned.plan.box.wooferCount + (u.planned.tweeter ? 1 : 0)), 0);
  const screws = list.reduce(
    (a, u) => a + u.units * ((u.planned.woofer.mountingHoles ?? 4) * u.planned.plan.box.wooferCount + (u.planned.tweeter?.mountingHoles ?? 0)),
    0
  );
  if (nonSubUnits) lines.push(P('termCup', nonSubUnits, 'Cabinet hardware'));
  if (subUnits) lines.push(P('plateAmp', subUnits, 'Cabinet hardware', 'Powers each sub; DSP gives crossover, level, delay and room EQ. Back-panel cut-out 9¼″ × 6¼″.'));
  lines.push(P('gasket', Math.max(1, Math.ceil(driverCount / 14)), 'Cabinet hardware'));
  lines.push(P('tnuts', Math.max(1, Math.ceil(screws / 50)), 'Cabinet hardware', `${screws} driver screws in total; #10-32 machine screws to match.`));
  const sealedL = list.filter((u) => u.planned.plan.box.alignment.kind === 'sealed').reduce((a, u) => a + u.units * u.planned.plan.box.netVolumeL, 0);
  if (sealedL > 0) lines.push(P('polyfill', Math.max(1, Math.ceil((sealedL * 12) / 454)), 'Cabinet hardware', `~12 g per litre of sealed box (${sealedL.toFixed(0)} L total).`));
  const ventedUnits = list.filter((u) => u.planned.plan.box.port);
  if (ventedUnits.length) {
    lines.push(P('denim', Math.max(1, Math.ceil(ventedUnits.reduce((a, u) => a + u.units, 0) / 3)), 'Cabinet hardware', 'Lines the walls of the ported boxes.'));
    for (const u of ventedUnits) {
      const port = u.planned.plan.box.port!;
      lines.push(P(port.diameterMm <= 55 ? 'port2' : 'port3', u.units * port.count, 'Cabinet hardware', `${u.name}: cut to ${port.lengthMm.toFixed(0)} mm.`));
    }
  }
  const floorUnits = list.filter((u) => ['sub', 'tower'].includes(u.planned.plan.box.arrangement)).reduce((a, u) => a + u.units, 0);
  if (floorUnits) lines.push(P('feet', floorUnits, 'Cabinet hardware', 'Under subs and towers.'));

  // ---- wood: nest every panel of every speaker together ----
  const byMat = new Map<string, Panel[]>();
  for (const u of list) {
    for (const p of [...u.planned.plan.panels, ...(u.planned.plan.stand && u.roles.includes('mains') ? u.planned.plan.stand.panels : [])]) {
      const arr = byMat.get(p.materialId) ?? [];
      arr.push({ ...p, qtyPerBox: p.qtyPerBox * u.units, name: `${p.name}` });
      byMat.set(p.materialId, arr);
    }
  }
  const sheets: Bom['sheets'] = [];
  for (const [mid, panels] of byMat) {
    const mat = MATERIALS.find((m) => m.id === mid)!;
    const layouts = nestSheets(panels, 1, mat);
    sheets.push({ materialName: mat.name, layouts });
    lines.push({ group: 'Wood & glue', item: mat.name, qty: layouts.length, unit: mat.approxSheetUsd, vendor: 'Lumber yard', note: `${(mat.sheetMm[0] / 304.8).toFixed(0)}′×${(mat.sheetMm[1] / 304.8).toFixed(0)}′ sheets; price is a rough estimate. Add one spare for mistakes.` });
  }
  lines.push({ group: 'Wood & glue', item: 'Titebond II wood glue, 16 oz', qty: Math.max(1, Math.ceil(list.reduce((a, u) => a + u.units, 0) / 6)), unit: 10, vendor: 'Hardware store', note: 'Rough price.' });

  // ---- electronics ----
  const surround = ['lcr', '5.1', '5.1.2', '7.1'].includes(layout);
  let electronicsNote = '';
  if (surround) {
    electronicsNote =
      'Surround layouts need an AV receiver (one amplifier channel per speaker, a sub output, and automatic room correction such as Audyssey or Dirac). It handles bass management, delays and levels for you. Passive crossovers go inside each speaker.';
    lines.push({ group: 'Electronics', item: 'AV receiver with room correction (≥ ' + (layout === '7.1' ? '7' : layout === '5.1.2' ? '7' : layout === 'lcr' ? '3' : '5') + ' channels, sub pre-out)', qty: 1, vendor: 'Any (not sold at PE)', note: 'Choose one with Audyssey MultEQ XT32 or Dirac Live.' });
    lines.push({ group: 'Electronics', item: 'Passive crossover per speaker (published design or kit)', qty: nonSubUnits, vendor: 'DIY / kit', note: 'Parts Express has no crossover for the SB17/SB26 pair; a measured published design is the safe route.' });
  } else if (route === 'active') {
    electronicsNote =
      'Active route: a DSP splits the signal into woofer and tweeter channels, each with its own amplifier channel. No passive crossover to design — crossover, delay, baffle-step and room EQ are software settings tuned with the measurement mic. The DSP-408 also has spare outputs for the party fills (with their delay).';
    lines.push(P('dsp408', 1, 'Electronics'));
    const ampChannels = list.filter((u) => u.planned.plan.box.arrangement !== 'sub').reduce((a, u) => a + u.units * (u.planned.tweeter ? 2 : 1), 0);
    lines.push(P('apa150', Math.ceil(ampChannels / 2), 'Electronics', `${ampChannels} amplifier channels needed (woofer + tweeter per speaker); each APA150 gives 2.`));
  } else {
    electronicsNote =
      'Passive route: a crossover inside each speaker and a normal stereo amplifier. Simple to use, but the crossover must be designed for these exact drivers in these boxes (or use a kit).';
    lines.push({ group: 'Electronics', item: 'Stereo integrated amplifier, ≥ 50 W/ch, with sub output', qty: 1, vendor: 'Any', note: 'Many have a sub pre-out; otherwise feed the sub plate amp from the speaker outputs.' });
    lines.push({ group: 'Electronics', item: 'Passive crossover per speaker (published design or kit)', qty: nonSubUnits, vendor: 'DIY / kit' });
  }

  // ---- measure & wire ----
  lines.push(P('umm6', 1, 'Measure & wire', 'With free REW software: measure the room, place speakers and subs, set EQ.'));
  lines.push(P('wire', 1, 'Measure & wire', '100 ft of 16 AWG covers a small room plus internal wiring.'));

  // ---- room treatment ----
  lines.push({ group: 'Room treatment', item: 'Absorption panel: 2″ mineral wool or rigid fibreglass, 2′×4′', qty: 4, vendor: 'Building supply', note: 'Side-wall and ceiling first-reflection points (see the Room tab).' });
  lines.push({ group: 'Room treatment', item: '1×4 pine for panel frames, 12 ft per panel', qty: 4, vendor: 'Lumber yard' });
  lines.push({ group: 'Room treatment', item: 'Breathable fabric (e.g. burlap / Guilford of Maine), ~1 yd per panel', qty: 4, vendor: 'Fabric store' });

  const total = lines.reduce((a, l) => a + (l.unit ?? 0) * l.qty, 0);
  const unpriced = lines.filter((l) => l.unit === undefined).length;
  return { uses: list, lines, sheets, total, unpriced, electronicsNote };
}

/** The "buy a kit" path: Parts Express kits with crossovers already designed. */
export function kitPath(layout: LayoutId, speakers: SystemSpeaker[]): { role: string; kit: Kit; qty: number }[] {
  const k = (id: string) => KITS.find((x) => x.id === id)!;
  const has = (r: Role) => speakers.filter((s) => s.role === r).length;
  const out: { role: string; kit: Kit; qty: number }[] = [];
  if (has('mains')) out.push({ role: 'Left / right mains', kit: k('cnote'), qty: 1 });
  if (has('center')) out.push({ role: 'Centre', kit: k('cnote-center'), qty: 1 });
  const smalls = has('surround') + has('height') + has('fill');
  if (smalls) out.push({ role: 'Surrounds / heights / fills', kit: k('ons'), qty: Math.ceil(smalls / 2) });
  void layout;
  return out;
}
