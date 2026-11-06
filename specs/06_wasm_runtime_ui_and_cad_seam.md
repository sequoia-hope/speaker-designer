# Spec 06 — Browser WASM + WebGPU Runtime, Svelte 5 / Threlte UI & Waffle Iron CAD Seam (`wasm-bridge`, `speaker-host`, `app/`)

## 1. Scope & Purpose

Speaker Designer adopts the **exact browser-native runtime model of Waffle Iron** — pure Rust compiled to `wasm32-unknown-unknown` (+ `simd128`) running inside Web Workers, paired with a main-thread **Svelte 5 + TypeScript + Threlte (Three.js)** UI and **WebGPU (`wgpu`) compute acceleration** inside Workers — while adhering strictly to machine-wide `proj` port governance and maintaining a zero-friction seam for future embedding into Waffle Iron.

---

## 2. Browser Multi-Worker WASM + WebGPU Compute Architecture (`crates/wasm-bridge`)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  MAIN THREAD (`app/` — Svelte 5 + Threlte / Three.js)                         │
│  • 3D Scene, Cutaway Horns, Animated Polar Balloons, FDTD Slice Shaders       │
│  • Acoustic Plots (SPL, Phase, Spinorama, Z(f), Excursion, THD, Sonograms)    │
│  • DSP Rack, Parametric Cabinet/Horn Inspector, Calibration Studio            │
└──────────────────────┬────────────────────────────────────▲───────────────────┘
                       │ Typed Command Msg                  │ Zero-Copy Transferable
                       │ (postMessage)                      │ ArrayBuffers + Progress
                       ▼                                    │
┌───────────────────────────────────────────────────────────┴───────────────────┐
│  COORDINATOR WORKER (`wasm-bridge` — Authoritative `SpeakerSession` State)    │
│  • Owns `.spkproj` DAG, Meshes, ROM Cache, Calibration Lineage                │
│  • Runs Tier-1 (<5 ms), DSP updates, Calibration LM loop & WebGPU FDTD/BEM    │
│  • Shards embarrassingly parallel Tier-2 FEM-BEM frequencies across Pool      │
└───────┬──────────────────────────┬──────────────────────────┬─────────────────┘
        │ Shard ω_{1..k}           │ Shard ω_{k+1..2k}        │ WebGPU Compute
        ▼                          ▼                          ▼
┌────────────────┐        ┌────────────────┐        ┌───────────────────────────┐
│ SOLVER WORKER 1│  ...   │ SOLVER WORKER P│        │ BROWSER WebGPU (`wgpu`)   │
│ WASM + SIMD128 │        │ WASM + SIMD128 │        │ • 3D IWB-FDTD Leapfrog    │
│ FEM-BEM Solve  │        │ FEM-BEM Solve  │        │ • Dense BEM Green Kernels │
└────────────────┘        └────────────────┘        │ • 3D Audience Grid Eval   │
                                                    └───────────────────────────┘
```

### 2.1 Why Sharded Worker Pool + WebGPU?

1. **Zero `SharedArrayBuffer` Fragility:** Frequency-domain 3D FEM-BEM solves at frequencies $\{\omega_1, \dots, \omega_{N_f}\}$ share read-only mesh geometry and require zero inter-frequency communication. Sharding frequency batches across $P = \min(\text{hardwareConcurrency}, 16)$ independent WASM Workers achieves near-linear multi-core scaling in *every* modern browser even without COOP/COEP `SharedArrayBuffer` headers (while also supporting `SharedArrayBuffer` zero-copy mesh sharing when headers are active).
2. **WebGPU Compute Inside Worker (`navigator.gpu`):**
   - **Tier 4 (3D IWB-FDTD):** Stores pressure/velocity fields in GPU storage buffers (`ping`/`pong`), advancing hundreds of millions of voxel updates per second in WGSL and writing 2D cross-section / 3D isosurface vertex/texel buffers for 60 FPS live wavefront playback!
   - **Tier 2 (BEM Kernel & Field Evaluation):** Offloads dense $G_k(\mathbf{x}_i, \mathbf{y}_j)$ quadrature blocks and $50{,}000$-point 3D venue coverage / spherical balloon evaluation onto WebGPU compute shaders, falling back seamlessly and deterministically to `CpuSimd128` when WebGPU is unavailable (e.g. headless CI).
3. **Cancellation & Progressive Streaming:** Every long solve carries a monotonic `JobId` and cooperative cancellation check between frequency shards / FDTD frames, streaming completed frequency points progressively so SPL and polar plots fill in live as the sweep progresses!

### 2.2 Zero-Copy Binary Protocol

All large numerical payloads travel as flat little-endian `ArrayBuffer` transfers (`Transferable` ownership handoff, zero JSON array serialization overhead):
- `RenderMeshPayload`: `positions: Float32Array`, `normals: Float32Array`, `indices: Uint32Array`, `patch_ranges: Uint32Array`
- `BalloonPayload`: `[n_freqs, n_theta, n_phi]` complex pressure / dB `Float32Array`
- `FieldSlicePayload`: 2D/3D complex pressure & particle-velocity vector field `Float32Array`
- `FrequencySweepPayload`: SoA `Float64Array` columns (`freq_hz`, `spl_on_axis`, `phase_deg`, `z_re`, `z_im`, `excursion_m`, `port_mach`, `thd_pct`, …)

---

## 3. Port Registry & Local Serving Law (Invariant A4)

Per machine-wide rules (`~/scripts/launcher.toml` & `proj`):

1. **Zero Hardcoded Ports:** Neither `vite.config.ts`, `package.json`, `serve.sh`, Playwright config, nor any Rust/TS file may contain a port literal or fallback default.
2. **Strict Resolution Chain:** Both `./serve.sh` and `vite.config.ts` resolve the port strictly in order:
   1. Explicit `--port <N>` CLI argument;
   2. `$PORT` environment variable (exported automatically by `proj up speaker-designer`);
   3. Output of `proj port` executed from the repository directory;
   4. **Immediate loud exit (non-zero)** with diagnostic message if none resolve — never falling back to Vite's default port or scanning for a free port.
3. **Verification:** `proj doctor` must pass with zero errors or hardcoded-port warnings on `speaker-designer` after any serving or build change.

---

## 4. Presentation Layer Workspaces (`app/` — Svelte 5 + Threlte)

The standalone browser UI organizes into five tightly linked workspaces sharing a persistent 3D viewport and live status/headroom bar:

1. **Design & Geometry Mode:**
   - Parametric enclosure & horn studio (Sealed, Vented/Slotted, 4th/6th Bandpass, Front-Loaded Folded Horn, Tapped Horn, Conical/Exponential/Salmon/Tractrix/OS-SE Waveguide, Multi-Way Baffle) + STL/OBJ mesh import;
   - Interactive cutaway 3D view showing internal horn fold path, driver magnet/cone clearance, porous lining zones, and color-coded acoustic boundary patches (`Diaphragm`, `ThermoviscousWall`, `PorousLayer`, `CouplingInterface`).
2. **System & Array Layout Mode:**
   - Place, stack, mirror, splay, and aim multiple speaker types in 3D space (1×, 2×, 4× coupled horn stacks, CSA cardioid, end-fire, arc sub arrays + flown/ground-stacked tops);
   - Define ground/wall boundaries ($4\pi, 2\pi, \pi, \pi/2$, finite impedance) and 3D audience / stage-exclusion surfaces;
   - Integrated **Active LMS DSP Rack** with live phase-alignment overlay and 1-click Cardioid / End-Fire / Crossover optimizers.
3. **3D Field & Wave Visualizer:**
   - Frequency-domain 3D SPL / phase / active-intensity vector arrows on orthogonal cutaway planes (`XY`, `XZ`, `YZ`), audience surfaces, and 3D spherical polar balloons;
   - Time-domain **WebGPU 3D FDTD Wave Player** with play/pause/scrub, tone-burst / kick-drum / impulse excitation, slow-motion wavefront diffraction around horn folds and 4-sub mouths, and browser **WebAudio WAV Auralizer** (listen to simulated speaker + DSP transfer function + nonlinear distortion at any virtual mic!).
4. **Electro-Acoustic & High-SPL Charts:**
   - Overlayable multi-trace plots (comparing e.g. `1× Sub` vs `2× Coupled` vs `4× Monoblock`, or `Uncoupled` vs `Full Mutual Z_rad`): SPL & Phase, **CTA-2034 Spinorama**, Horizontal/Vertical Polar Sonograms, Electrical Impedance $|Z_e|, \angle Z_e$ & EPDR (Equivalent Peak Dissipation Resistance for amplifier load safety!), Cone Excursion $|x(f)|$ vs $X_{\max}$, Port Mach Velocity, Mutual Active/Reactive Radiation Power, Harmonic Balance **THD / HD2 / HD3 / IMD**, and **Thermal Power Compression** ($+0\text{ dB} \dots -6\text{ dB}$ loss after $1\text{ s}, 60\text{ s}, 3600\text{ s}$!).
5. **Calibration Studio:**
   - Drag-and-drop `.zma`, `.frd`, `.wav` sweeps/IRs; interactive time-gate & Keele near/far splice preview;
   - Staged MAP fit runner (Driver $\rightarrow$ Box/Horn $\rightarrow$ Nonlinear/Thermal) displaying `Prior` vs `Measured` vs `Posterior` curves, parameter shift bars with 95% credible intervals, and SVD parameter-correlation heatmap.

---

## 5. Exact Waffle Iron CAD Integration Contract

To guarantee zero refactoring when embedding into Waffle Iron:

```rust
// In crates/acoustics-types/src/mesh.rs (zero Waffle Iron dependencies)
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PatchId {
    pub pid: u64,
    pub root_pid: u64, // Mirrors waffle_types::EntityPid { pid, root_pid } 1:1!
}

pub struct AcousticSurfaceMesh {
    pub positions: Vec<[f64; 3]>,     // SI meters (identical to cad-primitives)
    pub indices: Vec<[u32; 3]>,       // Outward-oriented manifold triangles
    pub patches: Vec<PatchSurface>,   // Contiguous triangle ranges + PatchId
}
```

When embedded into Waffle Iron via a future ~300-line `crates/waffle-acoustics` bridge crate:
1. Waffle Iron's B-Rep solid (`KernelSolidHandle`) tessellates via `KernelIntrospect` into `RenderMesh` + per-face `FaceProvenance { pid, root_pid }`, mapping **1:1 without conversion** onto `PatchId { pid, root_pid }` and SI-meter `positions`!
2. User acoustic boundary tags (`TransducerFace`, `CouplingInterface`, `PorousWall`) bind to Waffle Iron's persistent `GeomRef` / `EntityPid`, surviving parametric sketch edits (e.g. changing horn throat width or fold angle in a Waffle sketch and hitting *Re-solve Acoustics*).
3. Analytical surface evaluation (`KernelIntrospect`) supplies exact curved-surface midpoint projection when lifting boundary triangles to quadratic P2 FEM/BEM elements.

---

## 6. Deterministic Project File Format (`.spkproj`) & Native Host (`speaker-host`)

- **`.spkproj` File Format:** Versioned, human-diffable JSON manifest (`schema_version: 1`) for driver definitions, parametric geometry, acoustic graphs, 3D scene transforms, DSP settings, and calibration revision lineage, with optional companion content-addressed binary blobs (`sha256`) for large imported `.wav` IRs, dense CAD meshes, and cached $\mathbf{Z}_{3D}(\omega)$ ROMs.
- **`crates/speaker-host` (Native Headless Runner):** Wraps `speaker-engine` natively on Linux (`x86_64`) so `cargo test --workspace`, analytical/cross-tier oracle suites, and large parameter sweeps run directly from the CLI (and book cores cleanly via `~/.claude/bin/reserve`) without requiring a headless browser for physics verification.
