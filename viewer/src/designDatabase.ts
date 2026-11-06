import type { DesignEncyclopediaDatabase, DesignEncyclopediaEntry } from './types';

export const FALLBACK_DESIGN_DATABASE: DesignEncyclopediaDatabase = {
  schema_version: 1,
  designs: [
    {
      design_id: '01-studio-monitor-aether-83m',
      short_name: 'Aether-83M',
      archetype: 'Tri-Amped 3-Way Constant-Directivity Studio Monitor',
      family_badge: 'OS-SE Waveguide · 3-Way',
      use_case: 'Near- to Mid-Field Mixing & Mastering Control Rooms (1.5–3.2 m)',
      bandwidth_spec: '31 Hz – 20 kHz (±1.5 dB Listening Window)',
      radiation_pattern: '90° H × 70° V Constant-Directivity OS-SE above 750 Hz',
      efficiency_class: 'Active Tri-Amped Studio Reference (112 dB Peak @ 1 m)',
      physics_principle:
        'Matches the acoustic impedance and dispersion width of a dedicated 4" shorting-ring midrange (ka ≈ 2.4 at 2.6 kHz) seamlessly into a 3D BEM-solved 148 mm Oblate Spheroidal (OS-SE) waveguide housing a 1" Beryllium dome, while an 8.5" flared-slot woofer handles 31–320 Hz below cabinet baffle-step.',
      why_it_sounds_distinct:
        'Eliminates the classic 2-way "off-axis energy flare" at 2–3.5 kHz where a beaming 8" woofer hands off to a wide-dispersion 1" tweeter. Early room reflections share the exact same spectral tilt as the direct arrival, creating rock-solid phantom center imaging that translates effortlessly across rooms.',
      strengths: [
        'Zero crossover phase shift or vertical lobing inside the critical 320 Hz – 2.6 kHz vocal & instrument band',
        'Smooth, monotonic CTA-2034 Directivity Index (+4.2 dB → +8.6 dB) with parallel Early Reflections & Sound Power curves',
        '28 mm CNC 6061-T6 billet aluminum front baffle + 22 mm HDF-760 enclosure suppresses Kirchhoff–Mindlin panel coloration below -42 dB',
        'Generous 22 mm flared slot port keeps Mach number < 0.11 at reference monitoring levels',
      ],
      tradeoffs: [
        'Requires 3 active amplifier channels and precision Linkwitz-Riley 24 dB/oct DSP time alignment',
        'Billet aluminum machined waveguide baffle adds cost and cabinet mass (~23 kg per monitor)',
        'Omnidirectional bass below 180 Hz still interacts with untreated close studio front walls (compare Cardioid-8C)',
      ],
      heritage_inspirations: [
        'Genelec 8351B / 8341A ("The Ones" Minimum-Diffraction Waveguide Monitors)',
        'Neumann KH 310 & KH 420 Tri-Amped Midfield Monitors',
        'Earl Geddes Oblate Spheroidal (OS) Constant-Directivity Waveguide Theory',
      ],
      material_rationale:
        'Combines a 28 mm CNC-machined 6061-T6 billet aluminum front baffle (E = 68.9 GPa, zero edge-rout tearout for the continuous OS-SE flare) with a 22 mm High-Density Acoustic MDF-760 body (η = 0.034 internal damping) and dual window braces.',
      simulator_experiments: [
        'Switch to Variant 2 ("Classic Flat-Baffle 2-Way") on the Spinorama tab to watch the 2.1 kHz Directivity Index step appear',
        'Open 3D CAD Cutaway → Uncut Solid and drag the Explode slider to inspect the sealed 4" mid sub-enclosure and OS-SE throat',
        'Open Parametric Lab and change Baffle Material from 6061-T6 Aluminum to 16 mm MDF to see panel coloration jump on the CAD tab',
      ],
    },
    {
      design_id: '02-studio-monitor-cardioid-sbir',
      short_name: 'Cardioid-8C',
      archetype: 'Passive-Resistive Acoustic Cardioid Studio Monitor',
      family_badge: 'Acoustic Cardioid · Anti-SBIR',
      use_case: 'Compact & Untreated Control Rooms Placed 35–80 cm from Front Wall',
      bandwidth_spec: '34 Hz – 20 kHz (10–14 dB Rear Null across 90–350 Hz)',
      radiation_pattern: 'Heart-Shaped Cardioid 90–350 Hz · 85° × 65° OS-SE HF',
      efficiency_class: 'Boundary-Controlled Active 2-Way (Dual 8.5" + 1" Be)',
      physics_principle:
        'Routes the rear wave of dual 8.5" woofers through precision flow-resistive side slots (σ = 14.5 kPa·s/m², 22 cm acoustic delay path). The delayed, attenuated rear wave arrives at the rear cabinet corners 180° out of phase with the diffracting front wave, canceling radiation toward the studio wall behind the speaker.',
      why_it_sounds_distinct:
        'In real rooms, a conventional speaker placed 55 cm from a rigid front wall suffers a severe quarter-wave Speaker-Boundary Interference Response (SBIR) notch around 140–160 Hz plus +6 dB mud below 80 Hz. Cardioid-8C erases that wall bounce acoustically before it ever hits the drywall — delivering tight, dry upper-bass punch.',
      strengths: [
        'Suppresses the 140–160 Hz front-wall SBIR cancellation crater by > 10 dB at the mix position',
        'Passive porous-slot resistance creates cardioid directivity without burning extra DSP channels on rear woofers',
        '21 mm Constrained-Layer Damped (CLD) viscoelastic birch walls (η = 0.085) deaden internal midrange slot resonances',
      ],
      tradeoffs: [
        'Side resistive slots intentionally vent some low-end pressure, costing ~3.5 dB sensitivity below 70 Hz vs a sealed/vented box (compensated via dual 8.5" cone area)',
        'Slot flow resistivity (mineral wool / sintered felt density) must be tightly controlled during assembly',
      ],
      heritage_inspirations: [
        'Dutch & Dutch 8c Acoustic Cardioid Studio Monitor',
        'Kii THREE & Amphion/Geithain K-Series Cardioid Monitors',
        'Harry F. Olson Single-Element Unidirectional Acoustic Phase-Shift Enclosures',
      ],
      material_rationale:
        'Uses 21 mm CLD Birch + Viscoelastic shear core (η = 0.085, nearly 4× standard plywood damping) with 45° lock-miter corners and a 28 mm Valchromat HDF-840 front baffle so internal back-wave pressure cannot excite side-panel ringing around the cardioid slots.',
      simulator_experiments: [
        'Toggle Variant 1 (Cardioid-8C) vs Variant 2 (Conventional Vented Omni) on the SPL tab to see the 150 Hz wall-bounce notch vanish',
        'Switch 3D CAD to "Plan Cut Z" and 2D Blueprints to "Plan Section (X–Y)" to inspect the resistive side slots and porous lining',
        'In Parametric Lab, sweep "Cardioid Flow Resistivity" and "Slot Path" to tune the depth and frequency of the rear null',
      ],
    },
    {
      design_id: '03-subwoofer-coupling-1x-2x-4x',
      short_name: 'TerraHorn-18 Stack',
      archetype: 'Mouth-Coupled 2.25 m Folded Bass Horn Array (1× / 2× / 4× / CSA)',
      family_badge: 'Folded Horn · Mutual Z_rad',
      use_case: 'Sound-System Culture Stacks, Dub/Techno Clubs & Festival Ground Stacks',
      bandwidth_spec: '4× Stack: 28–105 Hz | Single Cabinet: 39–105 Hz',
      radiation_pattern: '2π Half-Space Ground-Coupled (Optional 3:1 Cardioid Rear Null)',
      efficiency_class: 'Ultra-High Acoustic Efficiency (~106 dB 1W/1m in 4× Stack)',
      physics_principle:
        'A single 0.49 m² horn mouth is acoustically small at 32 Hz (ka = 0.23), creating a huge impedance mismatch with outside air that reflects bass energy back down the horn throat. Stacking 4 cabinets side-by-side creates a 1.96 m² combined mouth (3.92 m² with rigid ground reflection), multiplying normalized real radiation resistance Re(Z_rad) by ~3.7× per driver!',
      why_it_sounds_distinct:
        'Explains mathematically why horn subwoofers "wake up" when stacked in quads: the air itself stiffens against every cone simultaneously. Standing-wave throat ripple flattens out, cutoff drops by nearly a third of an octave (39 Hz → 28 Hz) for free, cone excursion drops at 32 Hz, and bass transients feel effortlessly fast and physical.',
      strengths: [
        '+13.5 to +15 dB more deep sub-bass (28–42 Hz) in a 4× stack than a single horn at identical per-driver voltage',
        '3.7× higher real radiation loading damps cone motion, lowering excursion and Klippel motor THD at peak SPL',
        'Sealed rear compression chamber protects the 18" driver below horn cutoff (unlike open bass-reflex ports)',
      ],
      tradeoffs: [
        'A lone 1× horn rolls off early below 42 Hz with pronounced throat-reflection ripple — requires stacking of ≥ 2–4 cabinets',
        'Large physical truck-pack volume (62 × 92 × 91 cm, ~68 kg of 18 mm 13-ply Baltic Birch per cabinet)',
        'Folded 2.25 m path introduces internal quarter-wave resonances above 130 Hz, limiting upper crossover to ≤ 95 Hz',
      ],
      heritage_inspirations: [
        'Funktion-One F218 / Infrabass & Turbosound Flashlight Horn Stacks',
        'void Acoustics Stasys X / Lab Horn (Tom Danley / ProSoundWeb)',
        'Beranek & Mellow Coupled Pistons Mutual Radiation Impedance Theory',
      ],
      material_rationale:
        '18 mm 13-ply void-free Baltic Birch (E = 11.5 GPa) with interlocking CNC tab-and-dado joinery, 24 mm double-rebated internal driver baffle, and 45° corner reflectors withstands > 165 dB internal throat pressure without panel flex.',
      simulator_experiments: [
        'Open "Impedance & Z_rad Loading" and compare 1× vs 2× vs 4× stacks to watch Re(Z_rad) skyrocket between 28–55 Hz',
        'Check "SPL, Coupling & Crossover": notice how solid cyan (Coupled Full Physics) beats dashed grey (Uncoupled Baseline) by +3.5 dB!',
        'In Parametric Lab, stretch "Horn Path Length Scale" to 1.25× to trade upper sensitivity for sub-25 Hz infra extension',
      ],
    },
    {
      design_id: '04-outdoor-edm-oasis-360',
      short_name: 'Oasis-360 Surround',
      archetype: 'Open-Field 360° Quadraphonic Tops + Coupled Cardioid Sub Monoblock',
      family_badge: 'Full Venue · 360° EDM',
      use_case: 'Open-Field Electronic Dance Music Gatherings (12×12 m to 18×18 m Floor)',
      bandwidth_spec: '26 Hz – 18 kHz Coherent Full-Space Surround',
      radiation_pattern: 'Inward 4-Corner 60°×40° Synergy Tops + Unidirectional North Sub Blanket',
      efficiency_class: '10-Cabinet Touring Outdoor Rig (6× Horn Subs + 4× Coincident 3-Way Tops)',
      physics_principle:
        'Decouples sub-bass geometry (< 85 Hz, where wavelengths exceed 4 m and human ears cannot localize direction) from mid/high surround geometry (> 85 Hz). All 6 horn subs stay locked in one North mouth-coupled cardioid monoblock, while 4 elevated (2.85 m, -7.5° tilt) 3-way Synergy point-source horns surround the dancefloor corners.',
      why_it_sounds_distinct:
        'Avoids the #1 outdoor 4-point sound-system mistake: putting 1 subwoofer in each corner. Corner subs destroy mutual horn coupling AND carve -18 dB checkerboard comb-filtering dead zones every 2.5 m across the dancefloor. Oasis-360 bathes the entire floor in ±2.1 dB uniform chest-coupled sub-bass while enveloping dancers in 360° kick, synth, and percussion clarity.',
      strengths: [
        '+6.5 dB higher mean sub-bass SPL and 2.4× tighter spatial uniformity across the dancefloor vs 4-corner distributed subs',
        'Top-reversed cardioid rear sub pair cuts 35–80 Hz boom in the North DJ booth by ~14 dB',
        'Synergy-3P coincident 3-way horns fire 85 Hz–20 kHz from one phase-coherent 60°×40° conical throat aimed down into the crowd rather than miles across the field',
      ],
      tradeoffs: [
        'Requires digital LMS delay alignment (~4.2 ms on corner tops) so North sub wavefronts lock to corner kick transients at dancefloor center',
        'Four 2.85 m structural ground-support towers / lifts required at the dancefloor perimeter',
      ],
      heritage_inspirations: [
        'Despacio 360° Audiophile Dancefloor Concept (soulwax / McIntosh / point-source stacks)',
        'Danley Sound Labs SH50 / Jericho Coincident Synergy Horn Architecture',
        'Modern Boutique Desert/Forest Open-Air Techno & House Deployments',
      ],
      material_rationale:
        'Pairs weather-coated polyurea 18 mm Baltic Birch TerraHorn-18 ground subs with lightweight rigging-grade birch Synergy-3P 3-way coincident tops.',
      simulator_experiments: [
        'Scrub the 3D Stage frequency slider across 50–75 Hz while toggling Variant 1 (Oasis-360 Monoblock) vs Variant 2 (Naive 4-Corner Subs)',
        'Switch the Virtual-Mic Auralizer between "Dancefloor Center", "DJ Booth", and "South Chill Lounge" and click ▶ Listen (EDM)',
        'Inspect the Synergy-3P 3D Cabinet CAD section cut to see the paraxial mid ports entering the shared conical horn flare',
      ],
    },
    {
      design_id: '05-outdoor-edm-fieldthrow-range',
      short_name: 'FieldThrow-Arc',
      archetype: '6-Sub Electronic Delay Arc + Dual-Splay Vertical-Shaded Mains',
      family_badge: '45 m Throw · Delay Arc',
      use_case: 'Larger Open-Field Stages Requiring Uniform Coverage from 6 m out to 45 m',
      bandwidth_spec: '26 Hz – 18 kHz (75° Lobe-Free Horizontal Coverage to 45 m)',
      radiation_pattern: '75° Parabolic Electronic Sub Arc + Vertically Shaded Near/Far Horn Tops',
      efficiency_class: '12-Cabinet Medium-Festival Main Stage (8× Subs + 4× Tops)',
      physics_principle:
        'Replaces spaced Left/Right subwoofer stacks (which interfere like a two-slit experiment to create a narrow center "Power Alley" flanked by deep off-axis nulls) with 6 center-coupled subs spaced 0.62 m apart (< λ/4) driven with parabolic progressive delays. Simultaneously, upper (+3 dB, -2.2° tilt) and lower (-2.5 dB, -9° tilt) Synergy mains counteract inverse-square law and ISO 9613-1 air/turf absorption.',
      why_it_sounds_distinct:
        'Walk left-to-right anywhere across the meadow and the tonal balance stays remarkably constant — no painful ear-splitting front row and no thin, bass-starved off-axis dead zones 35 m back.',
      strengths: [
        'Eliminates L/R subwoofer "Power Alley" comb lobing across the entire 75° horizontal fan',
        'Dual-splay amplitude/angle shading compresses front-to-back SPL drop from 17 dB down to ~7.5 dB across 8–42 m',
        'Includes 2 rear-facing cardioid subs behind arc center to keep the stage deck clean',
      ],
      tradeoffs: [
        'Requires 7 independent subwoofer DSP delay/gain channels (6 parabolic arc taps + 1 rear cardioid bus)',
        'Needs continuous 3.8 m clear ground width directly in front of the stage apron',
      ],
      heritage_inspirations: [
        'Meyer Sound / L-Acoustics Electronic Curvilinear Subwoofer Delay Arrays',
        'Dave Rat & Bob McCarthy Arena/Festival "No Power Alley" Sub Design',
        'Point-Source Vertical Amplitude Shading Arrays',
      ],
      material_rationale:
        'Tour-grade 18 mm 13-ply Baltic Birch cabinets finished in 2 mm impact-resistant polyurea with Delrin turf skids and fly-track hardware.',
      simulator_experiments: [
        'Toggle Variant 1 (75° Electronic Arc) vs Variant 2 (Spaced L/R Stacks) on the 3D Stage at 63 Hz to visualize the Power Alley fingers!',
        'Compare the "Primary Dancefloor (6–20 m)" and "Long-Range Open Field (24–44 m)" Zone Scorecards beneath the 3D scene',
      ],
    },
    {
      design_id: '06-prototype-bayesian-calibration',
      short_name: 'Prototype #1 MAP',
      archetype: 'Measurement-to-Model Dual-AD Bayesian Calibration Benchmark',
      family_badge: 'Bayesian MAP · .zma/.frd',
      use_case: 'Shop Quality Control, Prototype Bring-Up & Digital-Twin Updating',
      bandwidth_spec: '18 – 320 Hz High-Precision Electro-Mechano-Acoustic Identification',
      radiation_pattern: '2π Ground-Plane 2.0 m Standardized Calibration Geometry',
      efficiency_class: '145 L 18" Vented Subwoofer Prototype (Prior vs Calibrated Posterior)',
      physics_principle:
        'Propagates exact Forward-Mode Dual Automatic Differentiation (`DualVec`) Jacobians through the coupled electrical impedance `Z_e(f)` and 2π ground-plane SPL forward physics models. Solves a Gauss-Newton Levenberg-Marquardt Maximum A Posteriori (MAP) inverse problem with Laplace Hessian 95% credible intervals and SVD identifiability diagnostics.',
      why_it_sounds_distinct:
        'Datasheet Thiele-Small specs routinely drift ±15–25% after spider break-in, internal braces displace net box volume, and a tiny unsealed speakON gasket can quietly rob 2 dB of 33 Hz output. Instead of guessing why a built box measures differently than CAD, Bayesian calibration pinpoints the exact physical root causes automatically.',
      strengths: [
        'Reduces model-to-measurement RMS error from > 2.4 dB down to 0.09 dB across both impedance and SPL simultaneously',
        'Automatically catches an accidental air leak (`Posterior Q_L = 4.3` vs `Design Prior Q_L = 14.0`) plus `+23%` spider break-in compliance',
        'Computes full 9×9 parameter correlation matrix so you know which parameters are decoupled vs collinear (why free-air + in-box `.zma` breaks the `Bl`–`M_ms`–`V_b` degeneracy)',
      ],
      tradeoffs: [
        'Requires clean 2.83 Vrms small-signal impedance `.zma` + outdoor ground-plane `.frd` sweeps before high-SPL nonlinear fitting',
      ],
      heritage_inspirations: [
        'Klippel LPM / LSI Linear & Nonlinear Parameter Identification',
        'Neville Thiele & Richard Small Dual-Measurement (`V_as` Added-Compliance) Method',
        'Laplace-Approximation Bayesian Physical System Identification',
      ],
      material_rationale:
        'Models a shop-built 18 mm Baltic Birch + 24 mm baffle vented prototype where internal window-brace wood volume reduced net `V_b` from 145 L to 134 L.',
      simulator_experiments: [
        'Open the "Bayesian Calibration" tab to inspect Prior vs Measured vs Posterior curves, 95% CI bars, and the 9×9 SVD correlation heatmap',
        'Switch to Parametric Lab and adjust Port Length or Chamber Volume to explore how sensitivity shifts around the calibrated posterior',
      ],
    },
    {
      design_id: '07-tapped-horn-keystone-18',
      short_name: 'Keystone-18TH',
      archetype: 'λ/2 Dual-Side Tapped Bass Horn (1× / 2× / 4× & Front-Horn Shootout)',
      family_badge: 'Tapped Horn · Dual-Side',
      use_case: 'High-Impact Bass Music Rigs Seeking Maximum 30–55 Hz Output per Truck Cubic Meter',
      bandwidth_spec: '30 – 92 Hz (+3.5 dB Deep-Bass Advantage over Same-Size Front Horn)',
      radiation_pattern: '2π Half-Space Mouth-Coupled (1×, 2×, 4× Stacks)',
      efficiency_class: 'Extreme Low-End Power Density (103 dB 1W/1m Single · 109 dB in 4×)',
      physics_principle:
        'Instead of sealing the back of the cone in a dead chamber (which wastes 50% of the driver radiation), a Tapped Horn mounts the 18" woofer right near the horn mouth ("tap") with its rear side feeding the narrow closed throat of an expanding 2.17 m folded line. Between 30–85 Hz, the 2.17 m path delays the inverted rear wave by ~180° so rear and front cone waves sum constructively at the 0.385 m² mouth!',
      why_it_sounds_distinct:
        'Delivers seismic, chest-compressing 30–50 Hz weight out of a remarkably compact 58×86×88 cm box, while the open magnet sits right in the high-velocity mouth airflow for natural forced convective voice-coil cooling.',
      strengths: [
        'Beats a larger front-loaded horn (TerraHorn-18) by +3.5 dB from 30–50 Hz using a single 18" neodymium driver',
        'Exhibits TWO acoustic cone-excursion nulls (33 Hz & 72 Hz) where horn air mass clamps diaphragm motion',
        'Open magnet structure inside the horn tap airflow runs 18–25 °C cooler under sustained EDM sub-bass',
      ],
      tradeoffs: [
        'At λ = L_path (~120–150 Hz), front and rear waves arrive out of phase again, carving a deep cancellation notch — requires a steep ≤ 92 Hz LR24 low-pass',
        'Higher group delay (~14–18 ms near 30 Hz) than a pure front-loaded horn or sealed Linkwitz sub',
      ],
      heritage_inspirations: [
        'Tom Danley Patented Tapped Horn Series (TH118 / TH118XL / DTS10)',
        'Art Welnitz "Keystone Sub" & Josh Ricci (Data-Bass) Othorn / Gjallarhorn',
        'Martinsson Tham-Series Compact Folded Tapped Horns',
      ],
      material_rationale:
        'Built from weatherproof 18 mm Phenolic-Film Marine Baltic Birch (E = 12.2 GPa) with interlocking CNC finger-tabs and a 24 mm internal Tap-Junction Driver Baffle.',
      simulator_experiments: [
        'Select Variant 3 (1× Keystone-18TH) with A/B Compare set to Variant 4 (1× TerraHorn-18) to see the +3.5 dB 30–50 Hz advantage AND the 125 Hz cancellation notch!',
        'Open 3D CAD Cutaway → Side Cut X to inspect the internal Tap-Junction Driver Baffle and dual rear-throat / front-mouth paths',
        'Check "Excursion, THD & Thermal" to see the dual cone-excursion minima and lower voice-coil temperature',
      ],
    },
    {
      design_id: '08-studio-sub-linkwitz-dual12',
      short_name: 'IsoPulse-212',
      archetype: 'Force-Canceling Dual-Opposed 12" Sealed Subwoofer + Active Linkwitz Transform',
      family_badge: 'Linkwitz Transform · F=0 N',
      use_case: 'Mastering Suites, Atmos Rooms & Apartments Needing 20 Hz Extension in 38 Liters',
      bandwidth_spec: '20 – 95 Hz (±1.0 dB Flat Butterworth Alignment via Active Pole-Zero Biquad)',
      radiation_pattern: 'Zero-Vibration Omnidirectional Point Source (λ >> 38 cm Box)',
      efficiency_class: 'High-Excursion Voltage-Driven Compact Sub (2 kW Class-D · 18 mm Xmax)',
      physics_principle:
        'Defies Hoffman’s Iron Law using modern kilowatt amplification and long-stroke motors: stuffing two 12" drivers into a tiny 38 L sealed cube raises raw resonance to f_0 = 58 Hz, Q_0 = 0.96. An active Siegfried Linkwitz biquad pole-zero filter mathematically cancels `(f_0, Q_0)` and substitutes a ruler-flat `f_p = 21 Hz, Q_p = 0.707` 2nd-order sealed roll-off — while opposed +Y / -Y drivers bolted via internal aluminum tie-bars cancel chassis reaction forces (`F_front + F_rear = 0 N`).',
      why_it_sounds_distinct:
        'Zero port chuffing, zero organ-pipe port resonances, zero cabinet floor-rattle, and ultra-tight < 9 ms group delay all the way down to 20 Hz — the gold standard for pitch articulation on fast 808 glides and acoustic double-bass.',
      strengths: [
        'Extends flat to 20 Hz from an ultra-compact 380 × 400 × 390 mm cube (1/4 the volume of an equivalent vented sub)',
        'Back-to-back Newtonian force cancellation eliminates mechanical floor/desk transmission (`Coin-Balanced-On-Top` stillness)',
        'Gentle 12 dB/oct sealed roll-off yields half the group delay of a 24 dB/oct 4th-order vented box',
      ],
      tradeoffs: [
        'Requires +13 dB active low-frequency boost at 20 Hz — demanding massive amplifier voltage headroom and linear 18 mm Xmax cones',
        'Sealed cone excursion climbs 4× per octave downward (`1/f²`), making a 17.5 Hz subsonic protection filter mandatory',
      ],
      heritage_inspirations: [
        'Siegfried Linkwitz Active Pole-Zero Transform Circuit / DSP Filter',
        'Barefoot Sound Dual-Force Subwoofers, KEF KC62 / KF92 & Devialet Push-Push Architecture',
        ' Rythmik / Perlisten Compact Sealed Servo & DSP Mastering Subwoofers',
      ],
      material_rationale:
        'Uses dual opposed 32 mm CNC 6061-T6 billet aluminum baffles tied internally by bolted aluminum tension bars inside a 25 mm Valchromat HDF-840 shell.',
      simulator_experiments: [
        'Compare Variant 1 (Active Linkwitz Transform, fp = 21 Hz) vs Variant 2 (Raw 38 L Sealed Box, f0 = 58 Hz) on SPL and Group Delay plots',
        'Open 3D CAD Cutaway → Side Cut X to see the opposed +Y / -Y 12" motors and internal 6061-T6 force-canceling tie bars',
        'In Parametric Lab, drag "Linkwitz Target f_p (Hz)" from 21 Hz down to 16 Hz and watch Cone Excursion on the Nonlinear tab!',
      ],
    },
    {
      design_id: '09-mastering-tower-chronos-mtm',
      short_name: 'Chronos-MTM',
      archetype: "Symmetric Joseph D'Appolito 3.5-Way Floorstanding Mastering Tower",
      family_badge: "D'Appolito MTM · Mastering",
      use_case: 'Full-Range Reference Mastering Rooms & Audiophile Listening Spaces',
      bandwidth_spec: '25 Hz – 20 kHz Full-Range Floorstander (No External Sub Required)',
      radiation_pattern: '95° H × Controlled Narrow V Symmetric Point-Source Lobing Free (< 1.8 kHz)',
      efficiency_class: 'High-Headroom Mastering Reference (116 dB Continuous Peak)',
      physics_principle:
        'Flanks a shallow-waveguide 1" Beryllium tweeter (`z = 840 mm`) symmetrically with upper (`z = 990 mm`) and lower (`z = 690 mm`) 5.5" shorting-ring midwoofers in isolated sealed chambers above a dedicated 58 L 10" flared-slot subwoofer. Crossing the M-T-M array low at 1.75 kHz keeps center-to-center mid spacing near the D’Appolito `2/3 λ` coherence limit, narrowing vertical floor/ceiling splash while locking acoustic center height at seated ear level.',
      why_it_sounds_distinct:
        'Combines the pinpoint vertical phantom-source lock of a coaxial monitor with the effortless dynamic slam and thermal headroom of dual 5.5" mids + a dedicated 10" carbon-cone bass section — reducing studio console, floor, and ceiling bounce by 4–6 dB across the midrange.',
      strengths: [
        'Symmetric vertical off-axis behavior eliminates the upward/downward main-lobe tilt of asymmetric TM 3-ways',
        'Dual 5.5" midwoofers double radiating area (+6 dB headroom, half excursion/IMD) across 160–1750 Hz',
        '21 mm CLD viscoelastic birch + 30 mm billet aluminum baffle + 3 window braces tame tall-cabinet pipe & bending modes',
      ],
      tradeoffs: [
        'Violating the low-crossover rule (e.g., stretching MTM crossover to 3.3 kHz in Variant 2) creates severe ±20° vertical comb nulls!',
        'Tall 114 cm cabinet requires ≥ 2.0 m listening distance for full geometric wavefront integration',
      ],
      heritage_inspirations: [
        "Joseph D'Appolito (AES 1983) Symmetric Vertical Polar Geometric Mean Topology",
        'Dunlavy SC-IV / Duntech Sovereign Time-Aligned Mastering Arrays',
        'ATC SCM100 / PMC MB2 / Lipinski L-707 Mastering Towers',
      ],
      material_rationale:
        'Pairs a 30 mm CNC 6061-T6 aluminum front baffle (machined shallow 95°×75° OS-SE tweeter Dish) with a 21 mm CLD viscoelastic birch body and dual sealed midrange sub-enclosures.',
      simulator_experiments: [
        'Open "Spinorama & Polar Sonograms" and toggle Variant 1 (Aligned 1.75 kHz XO) vs Variant 2 (3.3 kHz XO) — look at the Vertical Polar Sonogram!',
        'In Parametric Lab, sweep "Crossover Frequency Scale" from 0.8× to 1.8× and watch Early Reflections DI react in real time',
      ],
    },
    {
      design_id: '10-festival-endfire-vs-csa',
      short_name: 'End-Fire vs CSA',
      archetype: '4-Cabinet Outdoor Subwoofer Array Topology Shootout (End-Fire vs CSA vs Wall)',
      family_badge: 'End-Fire · 3:1 CSA · Wall',
      use_case: 'Outdoor Festival & Open-Field Stages Needing High Forward Punch + Quiet Stage/Neighbors',
      bandwidth_spec: '29 – 95 Hz Directional Touring Bass Array (4× 18" Reflex Subs)',
      radiation_pattern: 'End-Fire Torpedo Beam vs Heart-Shaped CSA Cardioid vs Broadside Figure-8',
      efficiency_class: '4× 1800 W 18" Neodymium Touring Reflex Array (TerraVent-18)',
      physics_principle:
        'Tests the three fundamental ways to deploy the exact same four 18" bass-reflex subwoofers on open turf: (1) 4-Deep End-Fire line spaced d = 1.15 m along +Y with progressive delay `τ_n = n · d / c_0 = 3.35 ms/rank` so all 4 wavefronts constructively align forward while smearing destructively across 4 phases backward; (2) 3-Front / 1-Rear Inverted Cardioid Sub Array (CSA) in a compact 0.8 m footprint; (3) 4-Wide unsteered Broadside Wall.',
      why_it_sounds_distinct:
        'End-Fire hits dancers 20 m out with all four cones summing in-phase (+2.2 dB louder forward than 3:1 CSA, where 1 of 4 subs works purely as a rear canceler!) while carving a broadband 15–20 dB quiet zone behind the array so DJs and vocal mics stay completely clear of low-end feedback.',
      strengths: [
        'End-Fire preserves 100% in-phase forward summation of all 4 cabinets while maintaining wide, even horizontal dancefloor coverage',
        '3:1 CSA achieves > 13 dB stage rejection when venue layout prohibits a 3.5 m deep End-Fire line in front of the stage',
        'Side-by-side comparison on identical hardware isolates pure array-geometry & DSP physics from cabinet differences',
      ],
      tradeoffs: [
        '4-Deep End-Fire consumes ~3.5 m of front-to-back ground depth ahead of the stage',
        '3:1 CSA sacrifices ~2.2 dB forward output relative to End-Fire/Broadside because the 4th cabinet radiates out-of-phase to cancel rear energy',
        'Unsteered 4-Wide Broadside Wall beams narrowly above 65 Hz and floods the stage (-Y) with omnidirectional bass',
      ],
      heritage_inspirations: [
        'd&b audiotechnik SL-Sub / J-Sub CSA & End-Fire Array Papers',
        'L-Acoustics KS28 Cardioid & End-Fire Touring Configurations',
        'Thomas Lund / Merlijn van Veen Directional Subwoofer Array Calculus',
      ],
      material_rationale:
        'Uses four identical 58×72×68 cm TerraVent-18 touring cabinets built from 18 mm 13-ply Baltic Birch (24 mm front baffle, interlocking CNC tabs) tuned to 33 Hz.',
      simulator_experiments: [
        'Cycle Variants 1, 2, and 3 while watching the 3D Stage SPL field map at 55 Hz — watch the red forward lobe & blue stage quiet zone morph!',
        'Compare the "Open-Field Dancefloor" vs "DJ Booth / Stage Deck" Zone Scorecards across all 3 variants',
        'In Parametric Lab, adjust "Array Spacing Scale" and "Sub Delay Trim (ms)" to steer the rear cancellation null frequency!',
      ],
    },
  ],
  topologies: [
    {
      id: 'topo-sealed',
      name: 'Sealed Acoustic Suspension',
      kind: 'enclosure',
      rolloff_slope: '12 dB/octave (2nd-Order High-Pass)',
      typical_sensitivity: 'Low–Moderate (84–91 dB 1W/1m)',
      group_delay_profile: 'Lowest Possible (< 6–9 ms @ 30 Hz)',
      rear_rejection: 'Omnidirectional below ~180 Hz (0 dB)',
      mechanism_summary:
        'Traps the rear diaphragm wave completely inside an airtight, porous-damped air spring (`C_ab = V_b / (ρ_0 c_0²)`). Zero phase inversion means crisp transient decay and predictable `1/f²` excursion growth.',
      when_to_choose:
        'Dedicated midrange sub-chambers, compact studio monitors, or high-excursion subwoofers paired with kilowatts of clean Class-D power.',
      example_design_ids: ['08-studio-sub-linkwitz-dual12', '09-mastering-tower-chronos-mtm'],
    },
    {
      id: 'topo-linkwitz-transform',
      name: 'Sealed + Active Linkwitz Pole-Zero Transform',
      kind: 'enclosure',
      rolloff_slope: '12 dB/octave Extended to Arbitrary Target f_p (+ BW4 Subsonic)',
      typical_sensitivity: 'Voltage-Headroom Driven (Trades Amp Watts for Tiny Box Volume)',
      group_delay_profile: 'Ultra-Low (< 9 ms down to 21 Hz)',
      rear_rejection: 'Omnidirectional (Force-Canceling Chassis = Zero Floor Vibration)',
      mechanism_summary:
        'Cascades an active biquad pole-zero EQ stage `(s² + (ω_0/Q_0)s + ω_0²) / (s² + (ω_p/Q_p)s + ω_p²)` ahead of a small high-Q sealed box, algebraically canceling the small-box resonance and replacing it with a deep Butterworth target.',
      when_to_choose:
        'Mastering & Atmos rooms needing ruler-flat 20 Hz extension and zero port noise from a 30–50 L cabinet with long-stroke drivers.',
      example_design_ids: ['08-studio-sub-linkwitz-dual12'],
    },
    {
      id: 'topo-vented',
      name: 'Bass-Reflex / Flared-Slot Vented',
      kind: 'enclosure',
      rolloff_slope: '24 dB/octave (4th-Order Acoustic High-Pass)',
      typical_sensitivity: 'Moderate–High (90–98 dB 1W/1m)',
      group_delay_profile: 'Moderate (12–18 ms near Helmholtz Tuning f_b)',
      rear_rejection: 'Omnidirectional below ~180 Hz (0 dB)',
      mechanism_summary:
        'Couples box air compliance `C_ab` with the acoustic mass `M_ap` of a flared port duct to create a Helmholtz resonator at `f_b`. Near `f_b`, the port radiates in-phase while clamping cone velocity near zero — boosting max SPL and cutting distortion, until unloading rapidly below `f_b`.',
      when_to_choose:
        'All-round studio monitors, floorstanding towers, and versatile touring subwoofers when balanced size, low-end extension, and output are required.',
      example_design_ids: [
        '01-studio-monitor-aether-83m',
        '06-prototype-bayesian-calibration',
        '09-mastering-tower-chronos-mtm',
        '10-festival-endfire-vs-csa',
      ],
    },
    {
      id: 'topo-folded-horn',
      name: 'Front-Loaded Folded Bass Horn',
      kind: 'enclosure',
      rolloff_slope: 'Steep Below flare cutoff f_c (Sealed Rear Protects Excursion)',
      typical_sensitivity: 'Very High (101–107 dB 1W/1m when Mouth-Coupled)',
      group_delay_profile: 'Fast Passband Impulse + Acoustic Path Transit Delay (~6.5 ms)',
      rear_rejection: '3–5 dB Natural Baffle Shadowing > 60 Hz (+15 dB in 3:1 CSA)',
      mechanism_summary:
        'Uses an expanding multi-segment Salmon/Exponential acoustic transformer (`S_throat → S_mouth`) plus a throat compression chamber to step high-pressure, low-velocity cone motion into low-pressure, large-area air motion — thriving on mutual `Z_rad` coupling when stacked in multiples.',
      when_to_choose:
        'Outdoor EDM sound systems, club stacks, and high-SPL dancefloors deploying 2, 4, or 8 coupled cabinets together.',
      example_design_ids: [
        '03-subwoofer-coupling-1x-2x-4x',
        '04-outdoor-edm-oasis-360',
        '05-outdoor-edm-fieldthrow-range',
      ],
    },
    {
      id: 'topo-tapped-horn',
      name: 'Tapped Bass Horn (λ/2 Dual-Side Loading)',
      kind: 'enclosure',
      rolloff_slope: '24–30 dB/oct Below Tap Resonance + Steep λ Upper Notch',
      typical_sensitivity: 'Extreme Deep-Bass Density (102–109 dB 1W/1m @ 32–65 Hz)',
      group_delay_profile: 'Moderate–High (14–20 ms @ 30 Hz; Dual Excursion Nulls)',
      rear_rejection: 'Omnidirectional Single · Directional in End-Fire / CSA',
      mechanism_summary:
        'Radiates from BOTH sides of a single woofer: the rear feeds the narrow closed throat of an expanding ~2.2 m folded horn while the front sits right inside the wide mouth tap. Over a ~1.8-octave passband, the path length inverts rear phase so both sides sum constructively (+6 dB) with natural open-air magnet cooling.',
      when_to_choose:
        'Sub-bass specialists (28–85 Hz) needing maximum chest-rattling output per liter of truck space and lower voice-coil temperatures.',
      example_design_ids: ['07-tapped-horn-keystone-18'],
    },
    {
      id: 'topo-cardioid-slot',
      name: 'Passive-Resistive Acoustic Cardioid Enclosure',
      kind: 'enclosure',
      rolloff_slope: '18 dB/oct + Controlled 10–14 dB Rear Null (90–350 Hz)',
      typical_sensitivity: 'Moderate (-3 dB LF Sensitivity Traded for Rear Cancellation)',
      group_delay_profile: 'Low & Room-Reflection-Free (Eliminates Wall Ringing)',
      rear_rejection: '10–14 dB Passive Acoustic Null at 180° Rear',
      mechanism_summary:
        'Vents internal rear cone pressure through side slots lined with calibrated porous flow resistance `R_slot + jωM_slot`. Forms an acoustic RC phase-shift network matching external wrap-around time `d / c_0` so front and rear waves cancel behind the cabinet without extra amps.',
      when_to_choose:
        'Studio monitors placed close to front walls/windows or compact live monitors needing clean stage decks.',
      example_design_ids: ['02-studio-monitor-cardioid-sbir'],
    },
    {
      id: 'topo-waveguide-synergy',
      name: 'OS-SE Constant-Directivity & Coincident Synergy Waveguides',
      kind: 'enclosure',
      rolloff_slope: 'Acoustic Impedance Match Across 300 Hz – 20 kHz',
      typical_sensitivity: '94–108 dB 1W/1m (Up to +12 dB On-Axis Directivity Gain)',
      group_delay_profile: 'Time-Coincident Point Source when Multi-Way Tapped',
      rear_rejection: '15–25 dB Above 500 Hz (Controlled 60°–95° Forward Pattern)',
      mechanism_summary:
        'Shapes waveguide wall curvature via Earl Geddes Oblate Spheroidal (`OS-SE`) coordinates free of higher-order Mode-Conversion HOMs, or injects midrange/LF ports paraxially into a single conical flare (Danley Synergy) so 3 ways share one acoustic center.',
      when_to_choose:
        'Every high-precision studio monitor (Aether-83M, Chronos-MTM) and point-source outdoor dancefloor top (Oasis-360, FieldThrow-Arc).',
      example_design_ids: [
        '01-studio-monitor-aether-83m',
        '04-outdoor-edm-oasis-360',
        '09-mastering-tower-chronos-mtm',
      ],
    },
    {
      id: 'array-monoblock',
      name: 'Mouth-Coupled Subwoofer Monoblock',
      kind: 'sub_array',
      rolloff_slope: 'Extends Horn/Port Low Cutoff Downward by 15–28%',
      typical_sensitivity: '+6 dB per Doubling (+ Mutual Z_rad Bonus on Horns!)',
      group_delay_profile: 'Smoothest Possible (Zero Spatial Interference Nulls)',
      rear_rejection: '0–4 dB (Combine with Rear CSA Pair for +14 dB Rejection)',
      mechanism_summary:
        'Clusters all subwoofers within `< λ/4` center-to-center spacing (`≤ 0.7 m`) as a single virtual piston. Eliminates multi-stack comb filtering across 360° while maximizing mutual radiation resistance `Re(Z_rad_ij)` between adjacent mouths.',
      when_to_choose:
        'Default best practice for small-to-medium outdoor dancefloors (Oasis-360) instead of scattering subs into corners or L/R stacks.',
      example_design_ids: ['03-subwoofer-coupling-1x-2x-4x', '04-outdoor-edm-oasis-360'],
    },
    {
      id: 'array-csa',
      name: 'Cardioid Subwoofer Array (3:1 / 2:1 Inverted CSA)',
      kind: 'sub_array',
      rolloff_slope: 'Matches Base Cabinet Passband (30–95 Hz)',
      typical_sensitivity: '~1.8–2.2 dB Less Forward SPL than All-Forward Stack',
      group_delay_profile: 'Tight Forward Wavefront; Active Cancellation Behind Stack',
      rear_rejection: '13–16 dB Heart-Shaped Null Directly Behind Stack',
      mechanism_summary:
        'Rotates 1 out of every 3 or 4 subwoofers 180° backward, delays it by the front-to-back acoustic wrap-around time (`Δt ≈ d_eff / c_0 ≈ 2.3–2.7 ms`), and inverts polarity so rear-going waves cancel over the DJ booth / stage.',
      when_to_choose:
        'Stages with shallow front aprons where DJ turntables, microphones, or nearby residences behind the stage require quiet sub-bass.',
      example_design_ids: [
        '03-subwoofer-coupling-1x-2x-4x',
        '04-outdoor-edm-oasis-360',
        '10-festival-endfire-vs-csa',
      ],
    },
    {
      id: 'array-endfire',
      name: 'End-Fire Progressive Delay Line (4-Deep)',
      kind: 'sub_array',
      rolloff_slope: 'Broadband Coherent Forward Summation (28–95 Hz)',
      typical_sensitivity: '100% Full 4× In-Phase On-Axis Summation (+12 dB)',
      group_delay_profile: 'Zero Inter-Rank Smear Forward; 4-Phase Destructive Smear Rear',
      rear_rejection: '15–22 dB Broadband Rear Rejection Across > 1.5 Octaves',
      mechanism_summary:
        'Places `N = 4` subwoofer ranks in a line pointing at the crowd (`d ≈ 1.15 m` spacing) with progressive delay `τ_k = k · d / c_0`. Forward waves stack in exact phase at every frequency, while rear waves spread across `0, 2d, 4d, 6d` path offsets and cancel.',
      when_to_choose:
        'Open-field EDM festivals with ≥ 3.5 m depth ahead of the stage seeking maximum forward throw AND maximum stage/backstage quietness.',
      example_design_ids: ['10-festival-endfire-vs-csa'],
    },
    {
      id: 'array-electronic-arc',
      name: 'Broadside Electronic Delay Arc',
      kind: 'sub_array',
      rolloff_slope: 'Matches Base Cabinet Passband with Controlled Horizontal Fan',
      typical_sensitivity: 'High Coupled Efficiency Tuned to Target Splay Angle (e.g. 75°)',
      group_delay_profile: 'Coherent Cylindrical/Spherical Virtual Wavefront Origin',
      rear_rejection: 'Combine with Center Rear CSA Subs for Unidirectional Arc',
      mechanism_summary:
        'Arranges `6–12` subs horizontally at `< λ/4` spacing so they couple without grating lobes, then applies a convex parabolic DSP delay taper (`τ(x)`) outer-to-inner to widen horizontal coverage smoothly instead of beaming narrowly down center.',
      when_to_choose:
        'Wide open-field dancefloors & festival meadows (FieldThrow-Arc) where a widebroadside line would otherwise beam too narrowly above 60 Hz.',
      example_design_ids: ['05-outdoor-edm-fieldthrow-range'],
    },
  ],
};

export function findDesignDossier(
  db: DesignEncyclopediaDatabase,
  designId: string
): DesignEncyclopediaEntry | null {
  return db.designs.find((d) => d.design_id === designId) ?? null;
}
