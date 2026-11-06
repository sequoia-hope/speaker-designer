# Spec 03 — Tier 3 (Large-Signal Nonlinear, Thermal & Aeroacoustics) & Tier 4 (WebGPU 3D IWB-FDTD)

## 1. Scope & Purpose

High-output subwoofers and PA stacks operate far outside small-signal linear acoustics. Tier 3 (`crates/acoustics-nonlinear`) and Tier 4 (`crates/acoustics-fdtd`) simulate high-SPL nonlinear electro-mechanics, electro-thermal power compression, port/throat vortex shedding, arbitrary program-audio transient response, and full 3D time-domain wave propagation:

- **Tier 3 (`acoustics-nonlinear`):** Couples Klippel large-signal transducer differential-algebraic equations (DAEs), 3-node forced-convection voice-coil/motor heating, and nonlinear aeroacoustic port/throat losses directly to **Vector-Fitted rational macromodels $\mathbf{Z}_{3D}(s)$ [Ref #23]** of the Tier-1 or Tier-2 3D horn/array acoustic load. Solves steady-state distortion via **Harmonic Balance (HBM)** and arbitrary transients/auralization via **L-stable implicit Runge-Kutta (ESDIRK / RadauIIA)**.
- **Tier 4 (`acoustics-fdtd`):** Executes a **27-point Interpolated Wideband (IWB) 3D FDTD [Ref #24]** wave solver with **conservative finite-volume CAD cut-cells [Ref #25]** and **unsplit CFS-CPML open boundaries [Ref #26]** on **WebGPU (`wgpu` WGSL)**, coupled bi-directionally every sample step to the nonlinear Tier-3 driver states.

---

## 2. Tier 3: Large-Signal Nonlinear, Aeroacoustic & Thermal Formulation

### 2.1 Klippel Nonlinear Transducer State-Space [Ref #20]

For cone displacement $x(t)$, velocity $v(t) = \dot{x}(t)$, main coil current $i(t)$, eddy-current branch currents $i_2(t), i_3(t)$ [Ref #8], and voice-coil temperature $T_{vc}(t)$:

1. **Polynomial + Asymmetric Curve Laws (guaranteed globally stable bounding outside $\pm X_{\text{mech}}$):**
   $$Bl(x) = \sum_{n=0}^{P} b_n x^n, \qquad K_{ms}(x) = \sum_{n=0}^{P} k_n x^n \quad (\text{enforcing } \partial_x(K_{ms}(x)x) > 0), \qquad L_e(x, i) = L_{e0}(x) \cdot \Psi_i(i)$$
2. **Coupled Voltage & Force Equations (including Maxwell Reluctance Force!):**
   $$v_{\text{amp}}(t) = R_e(T_{vc})\, i + \frac{d}{dt}\big[L_e(x, i)\, i\big] + Bl(x)\, v + v_{\text{eddy}}(i, i_2)$$
   $$M_{md}\dot{v} + R_{ms}(v)\, v + K_{ms}(x)\, x = Bl(x)\, i + \underbrace{\frac{1}{2}\frac{\partial L_e(x, i)}{\partial x} i^2}_{\text{Reluctance force } f_{\text{rel}}} - S_d\big(p_{\text{front}}(t) - p_{\text{rear}}(t)\big)$$
   Notice that asymmetric $b_1 \neq 0$ or $k_1 \neq 0$ plus reluctance pull $\frac{1}{2}\partial_x L_e \, i^2$ generates **dynamic DC displacement $x_{\text{DC}}(t)$**, shifting the voice coil off center at high bass levels and eating mechanical excursion headroom — captured naturally here!

### 2.2 Aeroacoustic Port & Horn Throat Nonlinearity [Ref #21]

In ports, bandpass vents, and narrow horn throats carrying volume velocity $U_p(t) = S_p v_p(t)$ at high acoustic Reynolds and Strouhal numbers ($\text{St} = \omega d_h / |v_p|$):

$$\Delta p_{\text{port,NL}}(U_p) = \Delta p_{\text{linear}}(U_p) + \frac{\rho_0}{2 S_p^2 \, C_c^2(|v_p|, r_{\text{flare}}/d_h)} K_{\text{turb}}(\text{St}) \, |U_p| U_p$$

where $C_c \in (0.61, 1.0]$ is the flare-dependent vena-contracta contraction coefficient (sharp-edged port $r_{\text{flare}}/d_h = 0 \implies$ severe jetting, quadratic damping compression, and downward tuning shift of $f_b$ as effective port air mass sheds into free vortex rings; generous elliptical/exponential flare suppresses separation). Outputs instantaneous Mach number $\text{Ma}(t) = |v_p(t)|/c$ and audible chuffing risk contours.

### 2.3 Three-Node Forced-Convection Electro-Thermal Network [Ref #22]

Joule dissipation $P_{\text{diss}}(t) = R_e(T_{vc}) i^2(t) + R_2(T_{\text{pole}}) i_2^2(t)$ drives a 3-state thermal RC ladder ($T_{vc}$: voice coil, $T_{\text{pole}}$: pole/top-plate steel, $T_{\text{mag}}$: magnet structure referenced to $T_{\text{amb}}$ or enclosure internal $T_{\text{box}}$):

$$R_e(T_{vc}) = R_{e0}\big[1 + \alpha_{\text{metal}}(T_{vc} - T_{\text{ref}}) + \beta_{\text{metal}}(T_{vc} - T_{\text{ref}})^2\big]$$

$$C_{\text{th},1}\dot{T}_{vc} = P_{\text{coil}}(t) - \frac{T_{vc} - T_{\text{pole}}}{R_{\text{th},1}\big(v_{\text{rms}}(t), v_{\text{port,rms}}(t)\big)}, \qquad R_{\text{th},1}(v_{\text{rms}}) = \frac{R_{\text{th},10}}{1 + \gamma_{\text{conv}} v_{\text{rms}}^{\nu}}$$

Crucially, gap thermal resistance $R_{\text{th},1}$ drops when cone velocity pumps air through the magnetic gap/vented pole piece — meaning **a vented or horn subwoofer runs hottest right at its acoustic loading minimum where cone excursion nulls**, accurately predicting frequency-dependent power compression!

### 2.4 Coupling to Exact 3D Acoustics via Passivity-Enforced Vector Fitting [Ref #23]

Any multi-port impedance matrix $\mathbf{Z}_{3D}(j\omega)$ from Tier 1 or Tier 2 is approximated by a real-rational pole-residue state-space realization via **Gustavsen-Semlyen Vector Fitting** with passivity enforcement ($\text{Re}\{\lambda_{\min}(\mathbf{Z}_{\text{VF}}(j\omega))\} \ge 0$):

$$\mathbf{Z}_{\text{VF}}(s) = \mathbf{D}_0 + s\mathbf{E}_0 + \sum_{r=1}^{N_{\text{poles}}} \frac{\mathbf{R}_r}{s - p_r}, \quad \text{Re}(p_r) < 0 \implies \dot{\boldsymbol{\xi}}_r = p_r \boldsymbol{\xi}_r + \mathbf{U}(t), \quad \mathbf{p}_{\text{ac}}(t) = \mathbf{D}_0 \mathbf{U} + \mathbf{E}_0 \dot{\mathbf{U}} + \sum_r \mathbf{R}_r \boldsymbol{\xi}_r$$

This turns full 3D diffraction, folded-horn wave propagation, and 4-subwoofer mutual radiation into a **compact, exact-memory system of ordinary differential equations** solvable in real time!

---

## 3. Tier 4: WebGPU 3D Interpolated Wideband FDTD (`acoustics-fdtd`)

### 3.1 27-Point Isotropic Compact Stencil [Ref #24]

On uniform grid spacing $\Delta x$ and Courant number $\lambda_c = c \Delta t / \Delta x \le 1$ ($\lambda_c = 1$ optimal for the **IWB** scheme with interpolation weights $a = \frac{1}{4}, b = \frac{1}{16}, c_w = \frac{1}{64}$!):

$$\delta_t^2 p_{i,j,k}^n = \lambda_c^2 \Big[ d_1 D_{\text{axial}} + d_2 D_{\text{face-diag}} + d_3 D_{\text{body-diag}} \Big] p_{i,j,k}^n$$

achieving $< 0.2\%$ phase velocity anisotropy up to $f_{\max} = 0.25 f_s$ (nearly $4\times$ higher usable bandwidth per voxel than standard 7-point FDTD!).

### 3.2 Conservative Cut-Cells, Impedance Walls & CFS-CPML [Ref #25, #26]

1. **Conservative Finite-Volume Cut-Cells [Ref #25]:** Boundary voxels intersected by curved horn walls or angled baffles store fluid volume fraction $\kappa_v \in (0, 1]$ and 6 face aperture fractions $\alpha_{\pm x, \pm y, \pm z} \in [0, 1]$ (merged conservatively with neighbor cells when $\kappa_v < \kappa_{\min}$ to preserve the full $\lambda_c$ CFL timestep without instability!), eliminating staircase artifacts on curved horns and waveguides.
2. **Digital Wall Impedance Filters:** Porous walls and ground surfaces couple via passivity-guaranteed 1- to 4-pole bilinear/trapezoidal surface admittance filters.
3. **Unsplit CFS-CPML [Ref #26]:** 8–12 cell Complex-Frequency-Shifted Convolutional PML surrounds open boundaries, absorbing both propagating waves and **low-frequency evanescent near-fields** of compact subwoofers ($<-70\text{ dB}$ reflection!).
4. **Live Bi-Directional Nonlinear Transducer Coupling:** At every FDTD step $n$, average cut-cell pressure over diaphragm patch $\Gamma_d$ feeds the implicit midpoint/trapezoidal update of the Tier-3 Klippel driver ODE, which injects updated diaphragm volume velocity $U_d^{n+1/2}$ back into the boundary divergence operator — strictly discrete-energy passive!

---

## 4. Branch Table

| Dimension | Branches | Selection / Normalization |
|---|---|---|
| `Tier3SolverMode` | `HarmonicBalance { K_harmonics }`, `TimeDomainRadauIIA`, `TimeDomainEsdirk4` | `HarmonicBalance` for fast swept THD/IMD/compression curves; `Esdirk4`/`RadauIIA` for WAV program transients & thermal soak. |
| `ThermalTimescale` | `FrozenTemperature { t_vc_k }`, `QuasiStaticEquilibrium`, `DynamicMultiRate` | Exploits timescale separation ($\tau_{\text{ac}} \sim 0.1\text{ ms}$ vs $\tau_{\text{th}} \sim 1\text{–}1000\text{ s}$) for instant 3-hour festival thermal soak predictions! |
| `PortNonlinearModel` | `Linear`, `SalvattiFlareAware { r_flare_m }`, `EmpiricalFit { k1, k2 }` | Normalized through smooth $\mathcal{C}^1$ $|U_p|U_p$ minor-loss law. |
| `FdtdBackend` | `WebGpuWgslPingPong`, `CpuSimd128Tiled` | Identical stencil & cut-cell weights; `WebGpuWgslPingPong` streams slice textures directly to Three.js without CPU readback! |

---

## 5. Invariants & Analytical Oracles

1. **O3.1 — Small-Signal Linear Limit Cross-Tier Oracle:** At $V_{\text{drive}} = 1\text{ mV}_{\text{rms}}$ and $T_{vc} = T_{\text{ref}}$, Tier-3 time-domain impulse FFT and Harmonic Balance fundamental match Tier-1 / Tier-2 complex frequency response and electrical impedance to $< 0.02\text{ dB}$.
2. **O3.2 — Duffing & Klippel Analytical Harmonic Oracle [Ref #20]:** Under pure cubic stiffness $K_{ms}(x) = k_0 + k_2 x^2$ and quadratic motor $Bl(x) = b_0 + b_1 x$, HBM and Time-Domain steady-state HD2, HD3, and DC offset $x_{\text{DC}}$ match perturbation/reference solutions to $< 10^{-4}$ relative error.
3. **O3.3 — Vector Fitting Passivity & Fit Accuracy Oracle [Ref #23]:** Fitted $\mathbf{Z}_{\text{VF}}(j\omega)$ on a 4-port 3D horn stack matches $\mathbf{Z}_{3D}(\omega)$ within $< 0.05\text{ dB}$ RMS error and has strictly positive real-part eigenvalues across $\omega \in [0, \infty)$.
4. **O3.4 — FDTD Cavity Dispersion & Discrete Energy Invariant [Ref #24, #25]:** Lossless cut-cell FDTD inside a rotated ($23^\circ$ off-grid!) rigid rectangular cavity conserves discrete acoustic energy to $< 10^{-5}$ over $10{,}000$ steps and matches analytical eigenfrequencies within $< 0.2\%$ up to $0.20 f_s$.
5. **O3.5 — CFS-CPML Evanescent Reflection Oracle [Ref #26]:** Monopole point pulse in open CPML box exhibits boundary reflection energy $<-70\text{ dB}$ including $ka = 0.1$ near-field placement.

---

## 6. Failure Modes & Typed Errors

- `MechanicalBottoming { driver_id, peak_x_m, x_mech_m, time_s }` — Hard suspension clip warning surfaced with exact timestamp/frequency (optional soft-bumper limiter continues integration safely).
- `VoiceCoilThermalRunaway { driver_id, temp_k, max_safe_k }` — Flags insulation melt threshold ($e.g.\ 523\text{ K}$ polyimide) during long-term power compression sims.
- `VectorFitPassivityViolation { residual_neg_eig }` — Halts before time-domain integration if rational fit cannot be passivated within max pole budget.
- `WebGpuStorageLimitExceeded { voxels, required_mb, adapter_limit_mb }` — Reports exact grid resolution cap and suggests voxel spacing or domain crop before allocation.
