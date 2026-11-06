# Speaker Designer — System & Physics Architecture

**Speaker Designer** is an MIT-licensed, state-of-the-art 3D computational electroacoustics, multi-speaker sound-system simulator, and measurement-driven Bayesian calibration platform written in Rust.

It runs **100% client-side in the browser** via **WASM-in-Web-Workers + WebGPU compute (`wgpu` / WGSL) + Svelte 5 / Threlte (Three.js)** — matching Waffle Iron's runtime and layering — alongside a native headless CLI/assay host (`speaker-host`) for automated verification and batch compute. Its core crates are strictly isolated from UI and CAD kernel internals so the entire simulation and calibration stack can later embed directly into Waffle Iron as its native Electroacoustics Workbench.

---

## 1. Motivation: Why Multi-Subwoofer Coupling Demands Full Coupled Physics

Standard PA prediction tools treat each cabinet as an isolated, fixed-velocity point source or pre-baked polar balloon:

$$p_{\text{naive}}(\mathbf{r}, \omega) = \sum_{m=1}^{M} H_m(\theta_m, \phi_m, \omega) \frac{e^{-jk|\mathbf{r} - \mathbf{r}_m|}}{|\mathbf{r} - \mathbf{r}_m|}$$

That approximation breaks down completely whenever **two or four subwoofers** (especially folded horns, tapped horns, bandpass, or closely spaced vented/cardioid stacks) operate near one another or near rigid boundaries:

1. **Mutual Radiation Impedance ($\mathbf{Z}_{\text{rad}}$) [Ref #4, #5]:** Loudspeakers are voltage-driven coupled electro-mechano-acoustic impedance networks, not ideal velocity sources. For $M$ radiating apertures (horn mouths, ports, cones), surface pressure and volume velocity are linked by a **full complex symmetric radiation matrix**:
   $$\mathbf{p}_{\text{rad}}(\omega) = \mathbf{Z}_{\text{rad}}(\omega)\,\mathbf{U}(\omega)$$
   For a single horn mouth of area $S_m$ at $30\text{–}50\text{ Hz}$ ($ka \ll 1$), self-radiation resistance $R_{\text{rad},11} \propto (ka)^2$ is tiny while reactive mass $X_{\text{rad},11} \propto ka$ dominates. Acoustic energy reflects at the mouth back down the horn, creating throat impedance standing waves, severe response ripple, and unloaded cone excursion.
2. **The 2× / 4× Stack Transformation:** Placing 2 or 4 horn mouths together on a ground plane (half-space $2\pi$ or wall-floor quarter-space $\pi$) drives $\text{Re}\{Z_{\text{rad},ij}\} \to R_{\text{rad},ii}$ at low $kd$. Four in-phase coupled mouths multiply the real radiation resistance seen by *each* mouth by up to **$4\times$** ($8\times$ including the ground image):
   - Terminates the horn's characteristic impedance $\rho_0 c / S_m$, collapsing internal standing-wave reflections;
   - Lowers the effective horn cutoff frequency $f_c$ by $0.3\text{–}0.6$ octaves;
   - Gains up to $+6\text{ dB}$ **additional** electro-acoustic sensitivity above simple power summation ($+12\text{ dB}$ total SPL gain for $4\times$ cabinets at constant per-driver voltage);
   - **Suppresses cone excursion $x(\omega)$** near cutoff, unlocking dramatically cleaner transient headroom before hitting $X_{\max}$ or port turbulence.
3. **Asymmetric Power Flow in Cardioid & End-Fire Arrays [Ref #32]:** In gradient, front-back-front, or end-fire arrays with per-cabinet DSP delay $e^{-j\omega\tau_m}$ and polarity inversion, off-diagonal mutual impedances $Z_{\text{rad},ij}$ cross-couple forward and rear drivers asymmetrically. Rear cancellation drivers can experience negative active acoustic radiation resistance ($\text{Re}\{p_i U_i^*\} < 0$ — absorbing acoustic power from front cabinets!), drastically altering cone excursion, voice-coil current, and thermal dissipation.
4. **Large-Signal Nonlinear & Thermal Reality [Ref #20, #21, #22]:** Real subwoofers at $130\text{–}145\text{ dB SPL}$ are governed by $Bl(x)$ and $K_{ms}(x)$ asymmetry (dynamic DC cone offset), inductance modulation $L_e(x,i)$, port/throat vortex shedding, and velocity-modulated voice-coil heating $R_e(T_{vc})$.

**Speaker Designer models all of these phenomena simultaneously across four cross-verifying physics tiers.**

---

## 2. Non-Negotiable Architectural & Physics Invariants

Modeled directly on Waffle Iron's Engineering Constitution, these invariants govern every crate and PR:

- **A1 — Strict Downward Crate Layering:** Dependencies flow strictly downward (`Presentation → Bridge → Engine/Calibration → Solvers → Mesh/Oracles → Math/Types`). Compiler-enforced via `Cargo.toml`; zero cycles, zero physics in JavaScript/TypeScript.
- **A2 — WASM-in-Worker Isolation & Zero-Copy Transfer:** Authoritative project, geometry, solver, and calibration state lives in Rust inside Web Workers. Only typed commands, compact diagnostic summaries, and flat `TypedArray` buffers (`Float32Array` / `Float64Array` / `Uint32Array`) cross the Worker boundary.
- **A3 — Permissive Licensing Only (MIT / Apache-2.0):** Every shipping dependency must be MIT or Apache-2.0 and compile cleanly to `wasm32-unknown-unknown` (with `+simd128`). GPL/LGPL/AGPL packages (e.g., `TetGen`, `CGAL`, `Gmsh`, `FFTW`, `SuiteSparse`) are strictly forbidden.
- **A4 — Port Registry Law:** Never hardcode a port number in any config, script, test, or source file. Any server or preview command resolves its port strictly in order: `--port` flag $\rightarrow$ `$PORT` $\rightarrow$ `proj port`, then **fails loudly** if unresolved.
- **A5 — Harmonic Sign & Phasor Law ($e^{+j\omega t}$, RMS):** Every frequency-domain crate uses the $e^{+j\omega t}$ convention ($\partial_t \leftrightarrow +j\omega$, $Z_L = +j\omega L$, outgoing 3D free-space Green's function $G_k(R) = \frac{e^{-jkR}}{4\pi R}$, Euler relation $v_n = -\frac{1}{j\omega\rho_0}\frac{\partial p}{\partial n}$). Frequency-domain signal phasors represent **RMS** amplitudes; time-domain solvers use instantaneous physical quantities, bridged by explicit newtypes (`VoltsRms`, `VoltsPeak`). Passive multi-port impedance matrices must satisfy positive semi-definiteness $\mathbf{Z}(\omega) + \mathbf{Z}^H(\omega) \succeq 0$ within solver tolerance.
- **A6 — SI Base Units Everywhere:** All internal types compute in strict SI units: meters ($\text{m}$), kilograms ($\text{kg}$), seconds ($\text{s}$), Pascals ($\text{Pa}$), cubic meters per second ($\text{m}^3/\text{s}$), Kelvin ($\text{K}$), Volts ($\text{V}$), Amperes ($\text{A}$), Ohms ($\Omega$). Display units ($\text{mm}$, $\text{L}$, $\text{g}$, $^\circ\text{C}$, $\text{dB SPL}$) exist only at serialization/UI boundaries.
- **A7 — Measurable Analytical & Cross-Tier Oracles:** No solver or calibration stage merges without automated numerical oracles against closed-form analytical solutions (`crates/acoustics-oracles`) and cross-tier convergence tests.
- **A8 — Waffle Iron CAD Seam Independence:** Core crates never depend on `waffle-types` or `kernel-v2`. Geometry enters through `acoustics_types::AcousticSurfaceMesh` and persistent `PatchId` tags so standalone parametric enclosures, imported meshes, and future Waffle Iron B-Rep solids share one exact contract.
- **A9 — Determinism:** Given identical inputs and solver settings, mesh generation, matrix assembly, linear solves, and seeded stochastic diagnostics are deterministic across runs.

---

## 3. Unified Four-Tier Physics & Solver Stack

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        UNIFIED SPEAKER & SOUND-SYSTEM SCENE                       │
│   Drivers (T-S + Klippel + Thermal) · Enclosures/Horns/Waveguides · Porous Media  │
│   3D Placement & Ground/Wall Boundaries · Multi-Channel Active DSP (IIR/FIR/Lim)  │
└───────────┬───────────────────┬─────────────────────┬──────────────────┬──────────┘
            │                   │                     │                  │
            ▼                   ▼                     ▼                  ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │     TIER 1       │ │     TIER 2       │ │     TIER 3       │ │     TIER 4       │
  │  Fast Network +  │ │  Full-Wave 3D    │ │  Large-Signal    │ │  WebGPU 3D       │
  │  1D Horn TMM +   │ │  Coupled         │ │  Nonlinear +     │ │  Time-Domain     │
  │  3D Mutual Z_rad │ │  FEM – BEM       │ │  Electro-Thermal │ │  IWB-FDTD        │
  ├──────────────────┤ ├──────────────────┤ ├──────────────────┤ ├──────────────────┤
  │ • MNA electro-   │ │ • Interior P1/P2 │ │ • Klippel Bl(x), │ │ • 27-pt isotropic│
  │   mechano-acoust.│ │   Helmholtz FEM  │ │   Kms(x), Le(x,i)│ │   wideband FDTD  │
  │ • Stinson thermo-│ │   + JCA porous + │ │ • Port & throat  │ │ • Conservative   │
  │   viscous horns  │ │   Berggren BL    │ │   vortex/jetting │ │   cut-cell CAD   │
  │ • Tapped & multi-│ │ • Exterior 3D    │ │ • 3-node forced- │ │   boundaries     │
  │   port junctions │ │   Burton-Miller  │ │   convection T_vc│ │ • CFS-CPML open  │
  │ • Pritchard/     │ │   BEM + H-matrix │ │ • Harmonic Bal.  │ │   truncation     │
  │   Rayleigh 3D    │ │ • Multi-Port ROM │ │   (THD/IMD) +    │ │ • Live 2-way     │
  │   array Z_rad    │ │   Z_3D(ω) cache  │ │   Vector-Fitted  │ │   coupling to    │
  │                  │ │                  │ │   time-DAE + WAV │ │   Tier-3 drivers │
  │   ~1–5 ms/sweep  │ │  Exact 3D wave   │ │  High-SPL truth  │ │  3D wave movies  │
  └────────┬─────────┘ └────────┬─────────┘ └────────▲─────────┘ └────────▲─────────┘
           │                    │                    │                    │
           └──────────┬─────────┴────────────────────┴────────────────────┘
                      │  Multi-Port Z_3D(ω) ROM & Vector Fitting Z_3D(s)
                      ▼
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │           BAYESIAN / MAP MEASUREMENT CALIBRATION (`acoustics-calibration`)      │
  │   .zma + .frd + .wav (Farina harmonic IRs) + multi-level high-SPL sweeps        │
  │   Prior → Staged MAP + Dual-AD Jacobians → Posterior Model + 95% Credible Intv. │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

### Cross-Tier Coupling & Verification Synergy

The four tiers are not isolated silos — they actively accelerate and verify each other:

1. **Tier 2 $\rightarrow$ Tier 1 / Tier 3 Acceleration (Multi-Port 3D ROM):** Solving a 3D folded horn or 4-subwoofer stack in **Tier 2 (3D FEM-BEM)** extracts its exact $P$-port acoustic impedance matrix $\mathbf{Z}_{3D}(\omega)$ and spherical-harmonic far-field radiation operators. Once cached, **Tier 1** swaps drivers or re-optimizes active DSP crossovers in $< 2\text{ ms}$ with full 3D diffraction accuracy, and **Tier 3** fits a passivity-enforced rational macromodel $\mathbf{Z}_{3D}(s)$ via **Vector Fitting [Ref #23]** to run nonlinear Klippel + thermal transient simulations against the exact 3D horn/array acoustic load!
2. **Cross-Tier Automated Oracles:**
   - As $ka \to 0$, **Tier 2 (3D FEM-BEM)** on sealed, vented, and straight/exponential horn geometries must agree with **Tier 1 (MNA + TMM)** within $< 0.25\text{ dB}$ and $< 2^\circ$ phase.
   - Under small-signal excitation ($1\text{ mV}$), **Tier 3 (Time-Domain Nonlinear DAE)** and **Tier 4 (WebGPU 3D FDTD)** impulse-response FFTs must match **Tier 1 / Tier 2** complex transfer functions across the solver bandwidth.

Detailed mathematical specifications for each subsystem live in `/specs`:
- [specs/01_electro_mechano_acoustic_network.md](specs/01_electro_mechano_acoustic_network.md) — Tier 1 Electro-Mechano-Acoustic MNA, Horns & 3D Mutual Impedance
- [specs/02_3d_coupled_fem_bem.md](specs/02_3d_coupled_fem_bem.md) — Tier 2 Full-Wave 3D Coupled Interior FEM + Exterior Burton-Miller BEM
- [specs/03_nonlinear_thermal_and_3d_fdtd.md](specs/03_nonlinear_thermal_and_3d_fdtd.md) — Tier 3 Large-Signal Nonlinear/Thermal & Tier 4 WebGPU 3D IWB-FDTD
- [specs/04_multi_speaker_arrays_and_dsp.md](specs/04_multi_speaker_arrays_and_dsp.md) — Multi-Way Sound Systems, Active LMS DSP, Array Synthesis & CTA-2034 Metrics
- [specs/05_measurement_calibration.md](specs/05_measurement_calibration.md) — Measurement Conditioning & Staged Bayesian/MAP Model Calibration
- [specs/06_wasm_runtime_ui_and_cad_seam.md](specs/06_wasm_runtime_ui_and_cad_seam.md) — Browser Multi-Worker WASM + WebGPU Runtime, Svelte 5 UI & Waffle Iron Seam

---

## 4. Workspace Crate Graph & Dependency Layering

```
Layer 4: Hosts & Bridges
  ├── crates/wasm-bridge        (Web Worker protocol, TypedArray views, Worker-pool & WebGPU dispatch)
  └── crates/speaker-host       (Native CLI, assay verification runner, benchmark harness; non-WASM)
            │
Layer 3: Session Engine, Calibration & I/O
  ├── crates/speaker-engine     (Parametric DAG, multi-cabinet scene, ROM cache, model revisions)
  ├── crates/acoustics-calibration (Staged MAP/Levenberg-Marquardt, Jacobian SVD, Laplace CIs)
  └── crates/acoustics-io       (.zma, .frd, .wav, Farina sweep deconvolver, polar sets, .spkproj)
            │
Layer 2: Physics Solvers & Active DSP
  ├── crates/acoustics-coupled  (Monolithic & Schur-complement coupling + Multi-Port ROM extractor)
  ├── crates/acoustics-nonlinear(Klippel state-space, thermal RC, port aero, Harmonic Balance & DAE)
  ├── crates/acoustics-fdtd     (27-pt IWB-FDTD, conservative cut-cells, CPML; wgpu WGSL + CPU SIMD)
  ├── crates/acoustics-bem      (3D Burton-Miller BEM, Maue-Mitzner, Duffy quad, H-matrix ACA, wgpu)
  ├── crates/acoustics-fem      (3D P1/P2 Helmholtz FEM, JCA porous media, Berggren BL, panel shells)
  ├── crates/acoustics-network  (MNA lumped/distributed solver, Stinson TMM horns, Pritchard Z_rad)
  └── crates/acoustics-dsp      (IIR biquads, LR/BW/Bessel, FIR, delay/polarity, limiters, array opt)
            │
Layer 1: Geometry, Meshing & Analytical Oracles
  ├── crates/acoustics-mesh     (Parametric enclosures/horns/waveguides, BCC Isosurface Stuffing tets,
  │                              surface remeshing, winding-number audit, FDTD cut-cell voxelizer)
  └── crates/acoustics-oracles  (Exact closed-form reference solutions: spheres, pistons, pipes, horns)
            │
Layer 0: Pure Types & Numerical Primitives
  ├── crates/acoustics-math     (Bessel/Hankel/Struve/Legendre, singular quadratures, Vector Fitting,
  │                              Dual forward-mode AD, trust-region LM, SIMD complex linear-algebra wrappers)
  └── crates/acoustics-types    (Types & constants ONLY: SI units, tolerances, AcousticSurfaceMesh,
                                 TetMesh, PatchId, DriverParams, AirProperties, PorousMaterial, Errors)
```

### Crate Responsibility & Allowed Dependencies

| Crate | Layer | Allowed Workspace Dependencies | Primary Responsibility |
|---|---|---|---|
| `acoustics-types` | 0 | *none* | Pure data contracts, SI newtypes, tolerances, mesh/patch structs, error enums. Zero algorithms (mirrors `cad-primitives`). |
| `acoustics-math` | 0 | `acoustics-types` | Special functions, Gauss/Duffy/Erichsen-Sauter quadratures, Dual AD, Vector Fitting, trust-region LM, FFT helpers. |
| `acoustics-oracles` | 1 | `acoustics-types`, `acoustics-math` | Exact analytical solutions (`pulsating_sphere`, `pritchard_mutual_piston`, `levine_schwinger_pipe`, `small_vented`, `salmon_horn`). |
| `acoustics-mesh` | 1 | `acoustics-types`, `acoustics-math` | Parametric 3D cabinet/folded-horn/tapped-horn/waveguide generators, STL/OBJ import, Labelle-Shewchuk BCC tet mesher, cut-cell builder. |
| `acoustics-dsp` | 2 | `acoustics-types`, `acoustics-math` | Multi-channel LMS filters (IIR/FIR/all-pass/delay/limiters) and automated cardioid/end-fire/arc array synthesis. |
| `acoustics-network` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-dsp` | Tier-1 electro-mechano-acoustic MNA + Kirchhoff-Stinson 1D TMM horns/tapped-horns + 3D mutual-impedance array solver. |
| `acoustics-fem` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-mesh` | Tier-2a interior 3D P1/P2 Helmholtz FEM, JCA porous media, Berggren thermoviscous walls, Mindlin-Reissner enclosure panels. |
| `acoustics-bem` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-mesh` | Tier-2b exterior 3D Burton-Miller BEM, half/quarter/eighth-space Green's functions, $\mathcal{H}$-matrix ACA + GMRES, spherical multipoles. |
| `acoustics-coupled` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-dsp`, `acoustics-network`, `acoustics-fem`, `acoustics-bem` | Tier-2c monolithic & Schur-complement coupling of active DSP + N drivers + interior FEM + exterior BEM; Multi-Port $\mathbf{Z}_{3D}(\omega)$ ROM. |
| `acoustics-nonlinear` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-dsp`, `acoustics-network` | Tier-3 Klippel nonlinear motor/suspension, forced-convection thermal RC, port aero compression, Harmonic Balance & Vector-Fitted time DAE. |
| `acoustics-fdtd` | 2 | `acoustics-types`, `acoustics-math`, `acoustics-mesh`, `acoustics-nonlinear` | Tier-4 WebGPU/SIMD 27-point IWB-FDTD with conservative cut-cell boundaries, CPML, and live 2-way nonlinear transducer coupling. |
| `acoustics-io` | 3 | `acoustics-types`, `acoustics-math` | `.zma`, `.frd`, `.wav`, Farina exponential sweep generator/deconvolver, polar balloons, `.spkproj` persistence. |
| `acoustics-calibration` | 3 | `acoustics-types`, `acoustics-math`, `acoustics-io`, `acoustics-network`, `acoustics-coupled`, `acoustics-nonlinear` | Measurement conditioning (windowing, Keele splice, TOF strip) + 3-stage Bayesian MAP parameter estimation & identifiability analysis. |
| `speaker-engine` | 3 | Layers 0–3 (`acoustics-*`) | Stateful project session, rebuild DAG, multi-cabinet scene, ROM cache, calibration lineage, cancellation & progress streaming. |
| `wasm-bridge` | 4 | `acoustics-types`, `speaker-engine` | `wasm-bindgen` Worker entrypoints, Multi-Worker frequency shard coordinator, WebGPU device init, zero-copy `TypedArray` views. |
| `speaker-host` | 4 | `acoustics-types`, `acoustics-oracles`, `speaker-engine` | Native CLI & batch test/benchmark driver (never compiled to WASM). |

---

## 5. Approved Third-Party Dependencies (MIT / Apache-2.0, WASM-Clean)

| Domain | Crate(s) | License | WASM (`wasm32-unknown-unknown`) | Rationale |
|---|---|---|---|---|
| Dense & Sparse Complex Linear Algebra | `faer` | MIT | Clean (`+simd128`) | Pure-Rust high-performance `Complex<f64>`/`Complex<f32>` dense LU/QR/SVD & sparse LU/Cholesky without C/Fortran BLAS/LAPACK or GPL `SuiteSparse`. |
| FFT & Convolution | `rustfft`, `realfft` | MIT / Apache-2.0 | Clean (`+simd128`) | Pure-Rust radix/Bluestein FFTs for IR/FR transforms, Farina deconvolution, and Harmonic Balance. |
| Complex Numbers | `num-complex`, `num-traits` | MIT / Apache-2.0 | Clean | Workspace-wide `Complex64` / `Complex32` compatibility. |
| GPU Compute | `wgpu`, `bytemuck` | MIT / Apache-2.0 | Clean (WebGPU) | Unified WGSL compute shaders running on browser WebGPU in Workers and native Vulkan/Metal in `speaker-host`. |
| Serialization & Hashing | `serde`, `serde_json`, `postcard`, `sha2` | MIT / Apache-2.0 | Clean | Deterministic `.spkproj` files, content-addressed ROM cache keys, and Worker protocol framing. |
| Audio WAV I/O | `hound` | Apache-2.0 | Clean (in-memory `Cursor`) | Lossless 24/32-bit float `.wav` sweep/IR import and browser auralization export. |
| Error Handling | `thiserror` | MIT / Apache-2.0 | Clean | Typed, structured domain errors across all crates (no `anyhow` in library APIs). |
| Native Parallelism (`speaker-host` only) | `rayon` (behind `native-parallel` feature) | MIT / Apache-2.0 | Optional / gated | Native multi-core execution for `speaker-host` assays while browser WASM shards across a Web Worker pool. |
| Presentation (`app/`) | `svelte@^5`, `@threlte/core@^8`, `three@^0.170`, `vite@^6`, `@playwright/test` | MIT / Apache-2.0 | Browser Main Thread | Exact parity with `waffle-iron/app/package.json` for seamless component and viewport sharing. |

---

## 6. Waffle Iron CAD Integration Seam

When `speaker-designer` embeds into `waffle-iron`, neither solver crates nor `kernel-v2` require modification:

1. **Geometry Contract:** `acoustics_types::AcousticSurfaceMesh` accepts watertight indexed triangle buffers (`positions: Vec<[f64; 3]>`, `indices: Vec<[u32; 3]>`) partitioned into surface patches (`PatchRange { patch_id: PatchId, tri_start: u32, tri_count: u32 }`), plus optional exact surface-projection callbacks for P2 curved midpoint snapping.
2. **Persistent Provenance Mapping:** In Waffle Iron, `waffle_types::FaceProvenance { pid, root_pid }` and `Role::Named` survive parametric extrude/revolve/boolean rebuilds. A thin future adapter crate (`waffle-acoustics`) maps `EntityPid` $\leftrightarrow$ `PatchId` so user-assigned acoustic boundary conditions (`Diaphragm`, `PorousWall`, `RadiationInterface`, `SymmetryPlane`) persist automatically as the user edits sketch dimensions of a folded horn or waveguide in CAD.
3. **Two Interior Solver Paths on CAD Solids:**
   - **Multi-Domain Surface BEM (`acoustics-bem`):** Solves homogeneous interior air cavities and folded horns directly from Waffle Iron's watertight surface mesh (`RenderMesh` remeshed to $h \le \lambda/6$) with **zero volume meshing required**.
   - **BCC Isosurface-Stuffing Tetrahedral FEM (`acoustics-mesh` + `acoustics-fem`):** Generates guaranteed-dihedral-angle ($\ge 10.7^\circ$) P1/P2 tetrahedral volume meshes [Ref #17, #18] for inhomogeneous porous-absorber subdomains, thermoviscous throats, and vibro-acoustic cabinet panel coupling.

---

## 7. Phased Implementation Roadmap & Verification Gates

Every milestone leaves the workspace green, deterministic, and backed by automated analytical oracles:

| Milestone | Scope | Primary Verification Gate (Oracle) |
|---|---|---|
| **M0 — Workspace, Types, Math & Analytical Oracles** | Initialize Cargo workspace, `acoustics-types`, `acoustics-math` (Bessel/Hankel/Struve, quadratures, Dual AD, LM), `acoustics-oracles`, `speaker-host` CLI. | Special-function accuracy $< 10^{-12}$ vs reference tables; exact reciprocity & passivity checks on all analytical oracles. |
| **M1 — Tier 1 Network, Horns, 2×/4× Mutual Coupling & DSP** | `acoustics-dsp`, `acoustics-network` (MNA compiler, Wright/Leach/L2R2 drivers, Stinson 1D horns & tapped horns, Pritchard/Rayleigh 3D mutual $\mathbf{Z}_{\text{rad}}$, half/quarter/eighth-space boundaries). | Exact match ($< 10^{-9}$ rel. err) to Small (1972) sealed/vented, Salmon exponential horn, and Pritchard 2-/4-piston mutual impedance; demonstrate 1× vs 2× vs 4× folded-horn mouth coupling & cardioid stack physics. |
| **M2 — Standalone Svelte 5 + Threlte 3D App & WASM Worker Pool** | `acoustics-mesh` parametric 3D cabinet/horn generators, `wasm-bridge` Worker pool, Vite + Svelte 5 + Three.js/Threlte UI served cleanly via `serve.sh` (`proj port`), 3D polar balloons & audience SPL maps. | `proj doctor` clean; Playwright end-to-end GUI verification of parametric 4-sub horn stack, cardioid/end-fire DSP rack, and interactive 3D sound field. |
| **M3 — Tier 2 Full-Wave 3D Coupled FEM–BEM & Multi-Port ROM** | `acoustics-bem` (Burton-Miller + Maue-Mitzner + Duffy + half-space Green's + ACA $\mathcal{H}$-matrix + WebGPU), `acoustics-fem` (BCC tet mesher + P2 Helmholtz + JCA porous + Berggren BL), `acoustics-coupled` ($\mathbf{Z}_{3D}(\omega)$ ROM). | Pulsating & oscillating sphere error $< 0.1\text{ dB}$ across irregular frequencies; Levine-Schwinger unflanged pipe $\Delta L/a = 0.6133 \pm 0.005$; low-$ka$ convergence to M1 within $0.25\text{ dB}$. |
| **M4 — Measurement Import & Staged Bayesian Calibration** | `acoustics-io` (`.zma`, `.frd`, `.wav`, Farina sweep deconvolver), `acoustics-calibration` (gate/Keele splice/TOF conditioning, 3-stage Dual-AD MAP optimizer, SVD collinearity & 95% Laplace CIs), Calibration Studio UI. | Synthetic noisy `.zma` + `.frd` round-trip recovers true T-S, box leak $Q_L$, port tuning, and JCA $\sigma$ within theoretical Cramér-Rao 95% bounds; flags unidentifiable free-air-only $(Bl, M_{ms})$ degeneracy. |
| **M5 — Tier 3 Large-Signal Nonlinear, Thermal & Aeroacoustics** | `acoustics-nonlinear` (Klippel $Bl(x), K_{ms}(x), L_e(x,i)$, 3-node forced-convection thermal RC, Salvatti port compression, Harmonic Balance + Vector-Fitted time DAE + WAV auralizer) + Stage-C nonlinear calibration. | Analytical Duffing/Klippel HD2/HD3 benchmark parity; passivity check of Vector-Fitted 3D horn ROM; multi-level sweep calibration recovers polynomial $Bl(x), K_{ms}(x)$ and $R_{th}$. |
| **M6 — Tier 4 WebGPU 3D IWB-FDTD Wave Propagation** | `acoustics-fdtd` (WGSL 27-point IWB stencil, conservative cut-cells, CFS-CPML, live 2-way nonlinear driver coupling) + interactive 3D wave-slice & volumetric viewport rendering. | Rectangular cavity eigenfrequencies accurate to $< 0.2\%$; CPML reflection $<-70\text{ dB}$; small-signal FDTD impulse FFT matches M3 FEM-BEM response within $0.5\text{ dB}$. |
| **M7 — Waffle Iron Adapter Preparation** | Publish stable `waffle-acoustics` seam tests against mock/exported Waffle Iron `RenderMesh` + `EntityPid` bundles so CAD integration is a drop-in mount. | Round-trip parametric rebuild test preserving face boundary tags across boolean/extrude edits. |
