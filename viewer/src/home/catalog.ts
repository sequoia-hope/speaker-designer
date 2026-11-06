// Parts Express (and Madisound where PE has no stock) catalogue data for the
// bill of materials. Prices are what each store charged on 2026-11-06 (Dayton
// items were on sale); check before ordering.

export interface CatalogPart {
  item: string;
  part: string | null;
  usd: number;
  spec: string;
  url: string;
}

export const PRICES_AS_OF = '2026-11-06';

export const PARTS = {
  "plateAmp": {
    "item": "Dayton Audio SPA250DSP 250W Subwoofer Plate Amplifier with DSP",
    "part": "300-8010",
    "usd": 269.98,
    "spec": "250 W RMS @4 ohm; 5 PEQ, LPF, HPF, phase, subsonic, limiter, PC GUI; RCA+XLR; 10-1/4\"H x 7-1/4\"W, cutout 9-1/4\"H x 6-1/4\"W",
    "url": "https://www.parts-express.com/Dayton-Audio-SPA250DSP-250W-Subwoofer-Plate-Amplifier-with-DSP-300-8010"
  },
  "dsp408": {
    "item": "Dayton Audio DSP-408 4x8 DSP",
    "part": "230-500",
    "usd": 199.98,
    "spec": "4 in / 8 out RCA (+4 high-level in); LR/BW/Bessel XO 0-24 dB/oct, PEQ, delay, 6 presets; 12 VDC adapter included",
    "url": "https://www.parts-express.com/Dayton-Audio-DSP-408-4x8-DSP-Digital-Signal-Processor-for-Home-and-Car-Audio-230-500"
  },
  "minidsp": {
    "item": "miniDSP 2x4 HD USB DAC DSP",
    "part": "230-324",
    "usd": 354.99,
    "spec": "2 in / 4 out, 32-bit/96 kHz, RCA analog + Toslink + USB audio in; FIR taps; 12 VDC",
    "url": "https://www.parts-express.com/miniDSP-2x4-HD-USB-DAC-Digital-Signal-Processor-230-324"
  },
  "kabd": {
    "item": "Dayton Audio KABD-4100 4x100W Amp Board with DSP",
    "part": "325-434",
    "usd": 95.98,
    "spec": "4 x 100 W @6 ohm with 36 VDC supply (sold separately, 5-10 A); onboard DSP; 20-20k Hz +/-3 dB",
    "url": "https://www.parts-express.com/Dayton-Audio-KABD-4100-4-x-100W-Bluetooth-Amp-Board-with-DSP-325-434"
  },
  "apa150": {
    "item": "Dayton Audio APA150 150W Stereo/Bridgeable Amplifier",
    "part": "300-812",
    "usd": 219.98,
    "spec": "Stereo, bridgeable power amp (two units = 4 ch for an active 2-way pair)",
    "url": "https://www.parts-express.com/Dayton-Audio-APA150-150W-Power-Amplifier-300-812"
  },
  "umm6": {
    "item": "Dayton Audio UMM-6 USB Measurement Microphone",
    "part": "390-808",
    "usd": 79.99,
    "spec": "USB, individually calibrated, 5-20,000 Hz with cal file",
    "url": "https://www.parts-express.com/Dayton-Audio-UMM-6-USB-Measurement-Microphone-390-808"
  },
  "umik": {
    "item": "miniDSP UMIK-1 USB Measurement Microphone",
    "part": "230-332",
    "usd": 139.98,
    "spec": "USB omni calibrated mic (REW standard)",
    "url": "https://www.parts-express.com/miniDSP-UMIK-1-Omni-directional-USB-Measurement-Calibrated-Microphone-230-332"
  },
  "termCup": {
    "item": "Speaker Terminal Cup Gold Insulated 5-Way Binding Post",
    "part": "260-242",
    "usd": 8.98,
    "spec": "Terminal cup with gold 5-way binding posts",
    "url": "https://www.parts-express.com/Speaker-Terminal-Cup-Gold-Insulated-5-Way-Binding-Post-260-242"
  },
  "polyfill": {
    "item": "Acousta-Fill Nylon Polyfill 1 lb. Bag",
    "part": "260-319",
    "usd": 15.98,
    "spec": "Polyfill cabinet damping, 1 lb (5 lb bag 260-331 $54.98)",
    "url": "https://www.parts-express.com/Acousta-Fill-Nylon-Polyfill-1-lb.-Bag-Speaker-Cabinet-Damping-Material-260-319"
  },
  "denim": {
    "item": "Sonic Barrier Acousta-Blue Denim 30mm x 40\" x 55\"",
    "part": "260-566",
    "usd": 34.98,
    "spec": "Denim wall-lining absorber, 15.2 sq ft",
    "url": "https://www.parts-express.com/Sonic-Barrier-Acousta-Blue-Speaker-Cabinet-Sound-Absorbing-Denim-30mm-x-40-x-55-15.2-Sq.-ft.-260-566"
  },
  "gasket": {
    "item": "Speaker Gasketing Tape 1/8\" x 1/2\" x 50 ft",
    "part": "260-542",
    "usd": 14.48,
    "spec": "Foam driver gasket tape (3/8\" wide: 260-540 $13.98)",
    "url": "https://www.parts-express.com/Speaker-Gasketing-Tape-1-8-x-1-2-x-50-ft.-Roll-260-542"
  },
  "tnuts": {
    "item": "#10-32 Deluxe 6-Prong T-Nuts 50 pcs",
    "part": "081-1088",
    "usd": 9.98,
    "spec": "T-nuts for driver mounting",
    "url": "https://www.parts-express.com/10-32-Deluxe-6-Prong-T-Nuts-50-Pcs.-081-1088"
  },
  "mountKit": {
    "item": "Cast Frame #10-32 Speaker Mounting Kit",
    "part": "260-776",
    "usd": 5.19,
    "spec": "Machine screws + T-nuts kit for cast-frame drivers (#8-32 version 260-779 $3.59)",
    "url": "https://www.parts-express.com/Cast-Frame-10-32-Speaker-Mounting-Kit-260-776"
  },
  "port2": {
    "item": "Precision Port 2\" Flared Port Tube Kit",
    "part": "268-348",
    "usd": 14.05,
    "spec": "2\" flared port kit",
    "url": "https://www.parts-express.com/Precision-Port-2-Flared-Port-Tube-Kit-268-348"
  },
  "port3": {
    "item": "Precision Port 3\" Flared Port Tube Kit",
    "part": "268-350",
    "usd": 19.13,
    "spec": "3\" flared port kit (4\" kit 268-352 $20.89)",
    "url": "https://www.parts-express.com/Precision-Port-3-Flared-Port-Tube-Kit-268-350"
  },
  "wire": {
    "item": "Audtek SKRL-16-100 100 ft 16 AWG OFC Speaker Wire",
    "part": "100-017",
    "usd": 44.49,
    "spec": "16 AWG OFC, 100 ft (CCA 100 ft 100-034 $12.98)",
    "url": "https://www.parts-express.com/Audtek-SKRL-16-100-16-AWG-OFC-Speaker-Wire-100-ft.-100-017"
  },
  "feet": {
    "item": "4-Pack Rubber Cabinet Feet 1-1/2\" dia x 3/4\" H",
    "part": "260-7517",
    "usd": 3.09,
    "spec": "Rubber cabinet feet, 4 pcs",
    "url": "https://www.parts-express.com/4-Pack-Rubber-Cabinet-Feet-1-1-2-dia-x-3-4-H-260-7517"
  },
  "spikes": {
    "item": "Dayton Audio DSS2-BK Black Spike Set 4 pcs",
    "part": "240-664",
    "usd": 12.98,
    "spec": "Speaker spikes, 4 pcs",
    "url": "https://www.parts-express.com/Dayton-Audio-DSS2-BK-Black-Spike-Set-4-Pcs.-240-664"
  }
} satisfies Record<string, CatalogPart>;

export interface Kit {
  id: string;
  name: string;
  part: string | null;
  usd: number;
  includes: string;
  drivers: string;
  notes: string;
  url: string;
}

export const KITS: Kit[] = [
  {
    "id": "cnote",
    "name": "C-Note MT Bookshelf Kit Pair (knock-down cabinets)",
    "part": "300-7140",
    "usd": 159.98,
    "includes": "Pair: 1/2\" MDF KD cabinets, drivers, 2-way XO (6 parts, PCB), ports, binding posts, screws, wire",
    "drivers": "2x Dayton DSA135-8 5\" + 2x ND25FW-4 1\" waveguide dome",
    "notes": "8 ohm, 85 dB 2.83V, 43-20k Hz, 11x7.5x9.5\"; Dayton design; best beginner kit",
    "url": "https://www.parts-express.com/C-Note-MT-Bookshelf-Speaker-Kit-Pair-with-Knock-Down-Cabinets-300-7140"
  },
  {
    "id": "cnote-parts",
    "name": "C-Note MT Kit Pair, components only",
    "part": "300-7141",
    "usd": 124.98,
    "includes": "Drivers, ports, XO parts + PCBs, binding posts, screws, wire; no cabinets (cut sheet provided)",
    "drivers": "2x DSA135-8 + 2x ND25FW-4",
    "notes": "Build your own boxes",
    "url": "https://www.parts-express.com/C-Note-MT-Bookshelf-Speaker-Kit-Pair-Components-Only-300-7141"
  },
  {
    "id": "cnote-center",
    "name": "C-Note Center Channel Kit (MTM)",
    "part": "300-7142",
    "usd": 134.98,
    "includes": "Single: KD MDF cabinet, drivers, XO parts, 2 ports, binding posts, screws, wire",
    "drivers": "2x DSA135-8 + 1x ND25FW-4",
    "notes": "4 ohm, 87 dB 1W/1m, 43-20k Hz, 8x21.5x9.5\"; voice-matched to C-Note MT",
    "url": "https://www.parts-express.com/C-Note-Center-Channel-Speaker-Kit-300-7142"
  },
  {
    "id": "ons",
    "name": "Overnight Sensations MT Kit Pair",
    "part": "300-706",
    "usd": 174.98,
    "includes": "Pair: 1/2\" Baltic birch KD cabinets, drivers, ports, XO parts + PCBs, binding posts, wire, screws",
    "drivers": "2x HiVi B4N 4\" + 2x Dayton ND20FA-6 3/4\"",
    "notes": "Paul Carmody design; 8 ohm, 83 dB 1W/1m, 45-20k Hz, 9x6x8.4\"",
    "url": "https://www.parts-express.com/Overnight-Sensations-MT-Speaker-Pair-Kit-300-706"
  },
  {
    "id": "amiga",
    "name": "Amiga MT Tower Kit (single)",
    "part": "300-7124",
    "usd": 239.98,
    "includes": "ONE tower: KD MDF cabinet, drivers, XO parts, port, foam damping, binding posts, screws, wire",
    "drivers": "1x Dayton RS180S-8 7\" + 1x Peerless DX25TG59-04 1\"",
    "notes": "Paul Carmody design; 8 ohm, 84 dB, 34-20k Hz, 34x8x11\"; only 5 kits in stock and RS180S-8 itself shows out of stock at PE",
    "url": "https://www.parts-express.com/Amiga-MT-Tower-Speaker-Kit-With-Knock-Down-Cabinet-300-7124"
  },
  {
    "id": "tritrix",
    "name": "TriTrix MTM Kit Pair (KD cabinets)",
    "part": "300-7128",
    "usd": 299.98,
    "includes": "Pair: KD MDF cabinets (3/4\" baffle, braces), drivers, XO parts, ports, foam; NO screws, binding posts or wire",
    "drivers": "4x Dayton DC130BS-4 5.25\" + 2x DC28FS-8 1-1/8\"",
    "notes": "Curt Campbell design; 8 ohm, 88 dB 1W/1m, 45-20k Hz, 18.5x7.5x11.5\"; works as L/R or center",
    "url": "https://www.parts-express.com/Tritrix-MTM-Speaker-Kit-Pair-with-Knock-Down-Cabinets-300-7128"
  },
  {
    "id": "aviatrix",
    "name": "AviaTrix RST Sealed MTM Kit Pair",
    "part": "300-7134",
    "usd": 299.98,
    "includes": "Pair: 1/2\" MDF KD cabinets, drivers, XO parts, polyfill, binding posts",
    "drivers": "4x Dayton ND140-8 5.25\" + 2x RST28F-4 1-1/8\"",
    "notes": "6 ohm, 86 dB 1W/1m, 40-20k Hz, sealed; music + HT",
    "url": "https://www.parts-express.com/AviaTrix-RST-Sealed-MTM-Speaker-Kit-Pair-with-Knock-Down-Cabinets-300-7134"
  },
  {
    "id": "samba",
    "name": "Samba MT Bookshelf Kit (single)",
    "part": "300-7121",
    "usd": 164.98,
    "includes": "ONE speaker: KD MDF cabinet, drivers, XO parts",
    "drivers": "1x Dayton RS180P-4 7\" + 1x RST28F-4 1-1/8\"",
    "notes": "Dayton design; 4 ohm, 87 dB 1W/1m, 40-20k Hz, 15x8.5x11.75\"",
    "url": "https://www.parts-express.com/Samba-MT-Bookshelf-Speaker-Kit-with-Knock-Down-Cabinet-300-7121"
  },
  {
    "id": "za52",
    "name": "Zaph|Audio ZA5.2 TM 2-Way, Pair (NOT PE - Madisound)",
    "part": null,
    "usd": 319.0,
    "includes": "Drivers + crossover per Madisound options (crossover-only option exists); cabinet not stated",
    "drivers": "Zaph ZA14W08 5\" + Vifa DQ25SC16-04",
    "notes": "Sold by Madisound, not Parts Express; ZA5.3c center single $225.00",
    "url": "https://www.madisoundspeakerstore.com/2-way-speaker-kits/zaph|audio-za5.2-tm-2-way-pair/"
  }
];
