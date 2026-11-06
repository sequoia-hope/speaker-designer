# Speaker Designer

A browser app for planning DIY loudspeakers and a living-room sound system, plus an experimental acoustics "Lab".

**▶ Live app: https://sequoia-hope.github.io/speaker-designer/** — works on phones and desktops; nothing to install.
(The Lab is at https://sequoia-hope.github.io/speaker-designer/#lab.)

The site is the committed build (`index.html` + `viewer-assets/` + `simulations/` + `wasm/` at the repo root), served by GitHub Pages from `main`. After changing anything in `viewer/src`, rebuild with `cd viewer && npx vite build` and commit the output.

## Home Hi-Fi (the default view)

Mobile-first planner, open at `#home` (`viewer/src/home/`):

- **Room** — room shape (incl. bay windows / openings), system layouts (2.0 → 5.1.2, and a guests/party layout with delayed fills), placement optimiser, and maps of bass evenness (rectangular-room modal model), loudness coverage, stereo-image width, fill **arrival timing** (precedence/Haas) and **interference** (coherent sum with delays, animated).
- **Speakers** — 11 designs (monitors, MTM, tower, centre, compact surround/height, full-range, subs) built from real driver datasheets, in 3D with explode / cut-away / tap-to-identify.
- **Build** — joinery-consistent cut lists, baffle & panel drawings, router circle-jig settings, sheet nesting, stands, and a step-by-step shop checklist.
- **Print** — hybrid 3D-printed + plywood cabinets (folded horn, transmission line, folded slot port, waveguide) with organic rounded shapes, fat-nozzle print settings, a "printed bends + plywood walls" option, print segmentation for your bed, build checks, and a simulated response fed into the room and outdoor maps.
- **Parts** — whole-system bill of materials with Parts Express part numbers (prices dated in `viewer/src/home/catalog.ts`), or a kit path.

The original computational "Lab" (below) is still available at `#lab`; see the Learn tab for which of its outputs are reliable.

---

# Lab: 3D Computational Acoustics & Sound-System Simulator

High-fidelity 3D loudspeaker and multi-speaker sound-system physics simulator in **Rust**, paired with a browser-based **Three.js + Svelte 5 Acoustic Workbench** and engineered for future native integration into `waffle-iron` CAD.

## Quick Start

### 1. Open the 3D Acoustic Workbench Viewer

The workbench is served via the machine's `proj` registry (`./serve.sh`, zero hardcoded ports):

```bash
proj up speaker-designer
proj url speaker-designer
```

Architecture & mathematical specification pages are also served at `<proj url>/architecture.html` (and in [`ARCHITECTURE.md`](./ARCHITECTURE.md) + [`specs/`](./specs)).

### 2. Instantiate & Simulate Designs from the Terminal (`speaker-cli`)

All speaker cabinets, drivers, waveguides, folded/tapped horns, DSP crossovers, and 3D room/open-field placements live as human-editable `.toml` files in [`designs/`](./designs).

```bash
# List all built-in studio monitor, coupled subwoofer & outdoor EDM system presets
cargo run --release -p speaker-cli -- list-presets

# Simulate a single edited or newly created .toml design (updates simulations/manifest.json)
cargo run --release -p speaker-cli -- simulate --design designs/04-outdoor-edm-oasis-360.toml

# Re-simulate all designs in parallel
~/.claude/bin/reserve -c 8 --here -l "simulate-all" -- \
  cargo run --release -p speaker-cli -- simulate-all --designs-dir designs --out-dir simulations
```

After running `simulate`, click **↻ Reload Runs** in the web viewer sidebar to inspect updated 3D fields, cutaways, Spinoramas, excursion/thermal curves, and WebAudio virtual-mic impulse responses.

### 3. Calibrate Models from Physical Speaker Measurements

```bash
# Generate a phase-synchronized Farina/Novak exponential sine sweep (.wav) for shop/field testing
cargo run --release -p speaker-cli -- generate-sweep \
  --f1-hz 20 --f2-hz 20000 --duration-s 5.0 --out-wav sweep_48k.wav

# Fit physical transducer & enclosure parameters (including air-leak Q_L) via Dual-AD Bayesian MAP
cargo run --release -p speaker-cli -- calibrate \
  --design designs/06-prototype-bayesian-calibration.toml \
  --free-zma free_air.zma \
  --inbox-zma in_cabinet.zma \
  --spl-frd groundplane_2m.frd \
  --out-report-json calibration_report.json
```

---

## Included Sample Speaker & Sound-System Designs (`designs/*.toml`)

1. **`01-studio-monitor-aether-83m.toml` — Aether-83M 3-Way Constant-Directivity Studio Monitor**
   - 8.5" flared-slot woofer + 4" sealed midrange + 1" Beryllium dome in a 3D BEM-solved 90°×70° Oblate Spheroidal (`OS-SE`) waveguide vs a classic flat-baffle 2-way.
2. **`02-studio-monitor-cardioid-sbir.toml` — Cardioid-8C Near-Wall Studio Monitor Pair**
   - Acoustic resistive-slot cardioid mid-bass monitors placed 0.55 m from a studio front wall, suppressing Speaker-Boundary Interference Response (SBIR) comb notches vs conventional vented monitors.
3. **`03-subwoofer-coupling-1x-2x-4x.toml` — TerraHorn-18 Coupled Subwoofer Physics (`1×` vs `2×` vs `4×` vs `4× Cardioid`)**
   - Demonstrates why stacking 2 or 4 folded bass horns mouth-to-mouth multiplies real acoustic radiation resistance $\operatorname{Re}(Z_{\text{rad}}) \approx 3.7\times$ per mouth, extending low-frequency horn cutoff, collapsing throat impedance ripples, lowering cone excursion, and reducing voice-coil temperature by >40 °C at identical per-driver voltage.
4. **`04-outdoor-edm-oasis-360.toml` — Oasis-360 Open-Field Surround EDM Sound System**
   - Complete outdoor open-field system creating a uniform dancefloor sweet spot: a mouth-coupled North Cardioid 6× Horn-Sub Monoblock (`26–85 Hz`, `-15 dB` DJ booth rejection) paired with 4 elevated Corner 3-Way Synergy Point-Source Horn Tops (`85 Hz–20 kHz`) — contrasted directly against the anti-pattern of naive 4-corner distributed subs.
5. **`05-outdoor-edm-fieldthrow-range.toml` — FieldThrow-Arc Open-Field Dancefloor + 45 m Long-Range System**
   - 6× coupled bass horns with parabolic `75°` electronic-arc delay steering + dual-splay Synergy main stacks vs classic spaced Left/Right stacks ("power alley" lobing).
6. **`06-prototype-bayesian-calibration.toml` — Prototype #1 Bayesian Measurement Calibration**
   - Recovers 9 physical parameters (`R_e`, `Bl`, `M_ms`, `C_ms`, `R_ms`, `L_e`, `V_b`, `L_port`, `Q_L`) with 95% Laplace credible intervals and SVD Fisher correlation diagnostics, automatically catching an accidental cabinet air leak (`Q_L = 4.3`).

---

## Rust Crate Architecture (`12 Crates`, MIT, WASM-Clean)

- `acoustics-types` — SI physical types, declarative `.toml` schemas, `PatchId { pid, root_pid }` (`waffle-iron` CAD B-Rep seam), and JSON viewer bundle contract.
- `acoustics-math` — Bessel/Struve/Hankel special functions (Miller recurrence + complex Hankel), Kirchhoff-Stinson thermoviscous functions, complex LU / SPD solvers, Dunavant & Duffy singular quadrature, and exact Forward-Mode `DualComplex` automatic differentiation + Trust-Region Levenberg-Marquardt MAP solver.
- `acoustics-oracles` — Exact analytical test oracles (pulsating/oscillating sphere, Rayleigh/Struve piston, Pritchard mutual impedance, Salmon horn, Small sealed box).
- `acoustics-mesh` — Watertight manifold 3D BEM & cutaway cabinet mesh generator + half-edge topological validator.
- `acoustics-dsp` — Active Linkwitz-Riley / Butterworth / Bessel crossovers, parametric/shelf/all-pass/Linkwitz-Transform biquads, and electronic-arc / CSA array steering.
- `acoustics-network` — Coupled multi-driver Modified Nodal Analysis (MNA), Stinson thermoviscous multi-segment/folded/tapped horns, resistive cardioid slots, Delany-Bazley open-field turf reflection, and dense 3D Rayleigh-Pritchard mutual radiation impedance matrix $\mathbf{Z}_{\text{rad}}(\omega)$.
- `acoustics-bem` — 3D Exterior Helmholtz Burton-Miller Boundary Element Solver (`L_k`, `M_k`, `M_k^T`, and Liu-Rizzo regularized hypersingular `N_k` — immune to irregular interior frequencies).
- `acoustics-nonlinear` — Large-signal Klippel nonlinear harmonic solver (`Bl(x)`, `K_ms(x)`, `L_e(x,i)`), Salvatti port Mach turbulence compression, 3-node forced-convection thermal network, and time-domain wavefront propagator.
- `acoustics-io` — `.frd` / `.zma` parsers & writers, `.wav` I/O, and phase-synchronized Farina/Novak exponential sine-sweep generator & harmonic deconvolver.
- `acoustics-calibration` — Multi-curve Bayesian MAP parameter identification, 95% credible intervals, and prototype defect diagnostics.
- `speaker-engine` — Multi-tier simulation orchestrator, Spinorama/polar balloon synthesizer, spatial zone evaluator, and 48 kHz WebAudio virtual-mic FIR builder (`wasm32-unknown-unknown` ready).
- `speaker-cli` — Terminal CLI driver.
