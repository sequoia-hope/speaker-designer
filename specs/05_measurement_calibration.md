# Spec 05 — Measurement Ingestion, Conditioning & Bayesian/MAP Model Calibration (`acoustics-io`, `acoustics-calibration`)

## 1. Scope & Purpose

Datasheet driver specs routinely drift by $10\text{–}25\%$ across production batches, internal wood bracing and driver baskets displace more air than sketched, porous stuffing behaves non-ideally, cabinet joints leak, and large-signal motor/suspension curves shift under break-in and heating.

`crates/acoustics-io` and `crates/acoustics-calibration` close the loop between **pre-build computational design** and **post-build physical reality**: ingesting electrical impedance, acoustic impulse/frequency responses, polar balloons, and multi-voltage large-signal sweeps to compute an **identifiability-verified Maximum A Posteriori (MAP) Posterior Model** complete with 95% credible intervals, residual diagnostics, and versioned lineage (`Design Prior` $\rightarrow$ `Calibrated Unit #1` $\rightarrow$ `4-Stack Field Verified`).

---

## 2. Measurement Ingestion & Signal Conditioning (`acoustics-io`)

### 2.1 Supported Measurement Formats

1. **Electrical Impedance:** `.zma`, REW/ARTA/LIMP/AudioTools `.txt`/`.csv` ($f, |Z|, \angle Z$ or $\text{Re}(Z), \text{Im}(Z)$), plus raw 2-channel sense-resistor `.wav` recordings ($V_{\text{ref}}, V_{\text{load}}$ with known $R_{\text{sense}}$ and cable-resistance lead calibration).
2. **Acoustic Transfer Functions & Impulse Responses:** `.frd`, `.wav` impulse responses (16/24/32-bit PCM & IEEE float via `hound`), REW/Smaart/Klippel multi-angle polar archives, and **Synchronized Exponential Sine Sweeps [Ref #27]**:
   - Generates exact phase-locked logarithmic measurement sweeps `.wav` ($f_1 \to f_2$ over duration $T_{\text{sweep}}$) and inverse filter $f_{\text{inv}}(t)$;
   - Deconvolves recorded `.wav` sweeps to simultaneously extract the **linear impulse response $h_1(t)$** AND **individual harmonic distortion impulse responses $h_2(t), h_3(t), h_4(t), h_5(t)$** separated cleanly at negative time offsets $\Delta t_m = \frac{T_{\text{sweep}} \ln m}{\ln(f_2 / f_1)}$!
3. **Environmental Metadata (`MeasurementConditions`):** Records ambient $(T_{\text{meas}}, P_{\text{meas}}, RH_{\text{meas}})$ per dataset so every simulation call inside the optimizer evaluates Cramer (1993) [Ref #29] air properties at the **exact thermodynamic conditions of that measurement** rather than misattributing a $10^\circ\text{C}$ shop temperature shift ($1.8\%$ speed-of-sound shift!) to internal box volume error!

### 2.2 Measurement Conditioning Pipeline

Before residuals touch the optimizer, raw acoustic measurements pass through deterministic, auditable conditioning:

1. **Time-of-Flight (TOF) & Acoustic Center Stripping:** Cross-correlation peak + Hilbert minimum-phase / excess-phase decomposition removes bulk propagation delay $e^{-j\omega \tau_{\text{TOF}}}$ so complex residuals never suffer $2\pi$ phase-wrapping local minima.
2. **Reflection-Free Time Windowing:** Interactive Hann / Tukey / Adrienne asymmetric gate $[t_{\text{pre}}, t_{\text{gate}}]$ with automatic first-reflection detection and mandatory low-frequency confidence weight taper below $f_{\text{gate}} = \frac{1}{t_{\text{gate}} - t_0}$.
3. **Near-Field + Port + Far-Field Splice [Ref #28]:** Combines close-mic cone ($p_{\text{cone}}$) and port/mouth ($p_{\text{port}}$) responses weighted by $\sqrt{S_d}$ and $\sqrt{S_p}$ with piston near-field high-frequency rolloff correction and Struck-Temkin baffle diffraction step to yield full-bandwidth $10\text{ Hz}–20\text{ kHz}$ free-field / ground-plane equivalents without an anechoic chamber!

---

## 3. Staged Bayesian / MAP Estimation & Identifiability Engine (`acoustics-calibration`)

### 3.1 Positivity-Guaranteed Parameterization & Gaussian Priors [Ref #30]

Optimizing raw parameters directly allows unphysical negative steps or poor scaling across 9 orders of magnitude ($C_{ms} \sim 10^{-4}\text{ m/N}$ vs $E_{\text{panel}} \sim 10^{10}\text{ Pa}$). Strictly positive physical parameters $\theta_i > 0$ map to dimensionless log-space coordinates $u_i = \ln(\theta_i / \theta_{i,\text{prior}})$, while bounded ratios (e.g. porosity $\phi \in (0,1)$) use logit transforms.

Given prior mean $\mathbf{u}_0 = \mathbf{0}$ with prior covariance $\boldsymbol{\Sigma}_u = \text{diag}(\sigma_{u,1}^2, \dots, \sigma_{u,P}^2)$ (encoding datasheet/CAD tolerances, e.g. $\sigma_{R_e} = 3\%$, $\sigma_{C_{ms}} = 20\%$, $\sigma_{V_b} = 4\%$) and frequency-weighted complex measurement residual vector $\mathbf{r}(\mathbf{u}) \in \mathbb{R}^{2 N_{\text{obs}}}$ (stacked real & imaginary parts of $\ln Z_{\text{sim}}/Z_{\text{meas}}$ and $\ln H_{\text{sim}}/H_{\text{meas}}$ weighted by coherence $\gamma^2(f)$ and gate validity $w_{\text{gate}}(f)$), the **MAP Objective** is:

$$\mathcal{J}(\mathbf{u}) = \frac{1}{2} \mathbf{r}(\mathbf{u})^T \mathbf{W} \mathbf{r}(\mathbf{u}) + \frac{1}{2} \mathbf{u}^T \boldsymbol{\Sigma}_u^{-1} \mathbf{u}$$

### 3.2 Exact Forward-Mode Dual Automatic Differentiation + Trust-Region Levenberg-Marquardt

- All Tier-1 and Tier-3 algebraic/ODE evaluations are generic over scalar vs **Forward-Mode Dual Numbers (`DualVec<f64, P>`)**, yielding the **exact machine-precision Jacobian $\mathbf{J}(\mathbf{u}) = \frac{\partial \mathbf{r}}{\partial \mathbf{u}}$** in a single pass with zero finite-difference step cancellation! (When calibrating against Tier-2 3D geometry parameters, Tier-2 uses adjoint sensitivity or cached Multi-Port ROM interpolation.)
- Solved via **Scaled Trust-Region Levenberg-Marquardt [Ref #30]**:
  $$\left(\mathbf{J}^T \mathbf{W} \mathbf{J} + \boldsymbol{\Sigma}_u^{-1} + \lambda \mathbf{D}^T \mathbf{D}\right) \Delta\mathbf{u} = -\left(\mathbf{J}^T \mathbf{W} \mathbf{r} + \boldsymbol{\Sigma}_u^{-1}\mathbf{u}\right)$$

### 3.3 Three-Stage Hierarchical Calibration Protocol

To prevent cross-talk between small-signal driver parameters, enclosure losses, and high-SPL nonlinearities, calibration proceeds in three structured stages:

| Stage | Required Measurements | Fitted Parameter Vector | Identifiability Guarantee |
|---|---|---|---|
| **Stage A — Driver Small-Signal** | Free-air complex $Z_e(f)$ **+** at least ONE mechanical/acoustic scale anchor: Added-Mass $Z_e(f)$, Known Sealed-Box $Z_e(f)$, Calibrated SPL `@ V_rms / d`, or Laser Velocity $v(f)$ | $R_{e0}, M_{md}, C_{ms0}, \lambda_{\text{creep}}, R_{ms}, Bl$, Inductance (`L2R2` / `Wright` / `Leach`) | If *only* a single free-air $Z_e(f)$ curve is supplied, engine fits $(R_{e0}, f_s, Q_{ms}, Q_{es}, Z_{\text{ind}})$ and locks absolute scale ratio $Bl^2 / M_{md}$, surfacing an explicit `ScaleAnchorMissing` notice rather than inventing $V_{as}$! |
| **Stage B — As-Built Enclosure, Horn & Absorption** | In-cabinet complex $Z_e(f)$ and/or ground-plane / spliced acoustic $H(f)$ (+ optional off-axis polars) | Effective chamber volumes $V_{b,k}$, horn/port end-corrections $\Delta L_p$, enclosure air-leak $Q_L$, porous flow resistivity $\sigma$ & fill fraction, wall loss $Q_{\text{wall}}$ | Separates port tuning shift ($\Delta L_p$) from box volume shift ($V_b$) via impedance saddle frequency vs twin-peak spacing & SPL knee! |
| **Stage C — Large-Signal Nonlinear, Aero & Thermal** | Multi-voltage stepped sweeps (e.g. $0.5\text{ V}, 4\text{ V}, 16\text{ V}, 40\text{ V}$) + Farina harmonic IRs $h_2, h_3$ + hot-vs-cold DC/LF $Z_e(f)$ | Polynomial $Bl(x)$ ($b_1\dots b_4$), $K_{ms}(x)$ ($k_1\dots k_4$), $L_e(x,i)$, thermal $(R_{\text{th},10}, \gamma_{\text{conv}}, C_{\text{th},1})$, port turbulence $K_{\text{turb}}$ | Even harmonics ($h_2$) + DC shift isolate asymmetric $(b_1, k_1)$; odd harmonics ($h_3$) + resonance shift vs voltage isolate symmetric $(b_2, k_2)$; LF $\text{Re}(Z_e)$ rise directly measures $\Delta T_{vc}$! |

### 3.4 Posterior Uncertainty, SVD Identifiability & Model Lineage

At the converged MAP estimate $\hat{\mathbf{u}}$:
1. **Posterior Covariance (Laplace Approximation):** $\boldsymbol{\Sigma}_{\text{post}} = \left(\mathbf{J}^T \mathbf{W} \mathbf{J} + \boldsymbol{\Sigma}_u^{-1}\right)^{-1}$ yields $\pm 2\sigma$ (95%) credible intervals for every physical parameter AND propagated 95% confidence ribbons on simulated SPL/excursion curves!
2. **SVD Collinearity Audit:** Singular value decomposition of the likelihood Fisher matrix $\mathbf{F} = \mathbf{J}^T \mathbf{W} \mathbf{J}$ identifies any parameter linear combinations whose information comes almost entirely from the prior ($\text{prior\_share}_k > 0.85$), reporting human-readable measurement recommendations to break the correlation.
3. **Immutable Model Snapshots:** Calibration never silently overwrites the design spec. It appends a timestamped `ModelRevision { parent_id, measurements_used, posterior_params, covariance, residual_rms_db }` so designers can compare `CAD Nominal` vs `Measured Prototype #1` vs `4× Stack Prediction Using Calibrated Driver/Horn` side by side!

---

## 4. Branch Table

| Dimension | Branches | Selection / Normalization |
|---|---|---|
| `ScaleAnchorMode` | `FreeAirOnlyRelative`, `AddedMass { delta_m_kg }`, `ReferenceSealedBox { v_b_m3 }`, `CalibratedSpl { mic_dist_m, space }`, `LaserVelocity` | Automatically detected from attached `MeasurementSet` tags; adjusts Stage-A active parameter subspace. |
| `ResidualMetric` | `ComplexLogMagnitudeAndPhase`, `MagnitudeOnlyMinimumPhase` (for uncalibrated-phase legacy `.frd` imports) | `ComplexLogMagnitudeAndPhase` (after TOF strip) is default whenever phase is valid. |
| `RobustLossKernel` | `L2Gaussian`, `Huber { delta }`, `Cauchy { scale }` | `Huber` downweights isolated room-mode notches or mic wind glitches automatically. |

---

## 5. Invariants & Analytical Oracles

1. **O5.1 — Exact Dual-AD vs Complex-Step Derivative Oracle:** Analytical Dual-AD Jacobian $\mathbf{J}(\mathbf{u})$ across all Stage A/B/C parameters matches complex-step differentiation $\text{Im}\{f(u + j h)\}/h$ ($h = 10^{-20}$) to $< 10^{-13}$ relative error.
2. **O5.2 — Synthetic Noisy Measurement Recovery & Cramér-Rao Oracle [Ref #30]:** Across $100$ seeded Monte Carlo trials of synthetic `.zma` (free-air + in-box vented/horn) + `.frd` corrupted by $0.15\text{ dB}$ / $1^\circ$ Gaussian noise and a simulated cabinet air leak ($Q_L = 5.5$), true ground-truth parameters fall inside the reported 95% posterior credible intervals $95\% \pm 3\%$ of the time!
3. **O5.3 — Unidentifiable Subspace Detection Oracle:** Feeding free-air $Z_e(f)$ alone triggers `ScaleAnchorMissing`, leaves $(f_s, Q_{ms}, Q_{es}, R_e)$ converged to $< 0.1\%$, and reports $> 0.99$ correlation on $(Bl, M_{md})$ without diverging.
4. **O5.4 — Farina Exponential Sweep Deconvolution Oracle [Ref #27]:** Passing a synthetic exponential sweep through a known polynomial nonlinearity $y = x + 0.05 x^2 + 0.02 x^3$ recovers exact harmonic ratios HD2 and HD3 within $< 0.1\text{ dB}$ across $20\text{ Hz}–5\text{ kHz}$.

---

## 6. Failure Modes & Typed Errors (`CalibrationError`)

- `InsufficientFrequencyOverlap { meas_range_hz, model_range_hz }` — Imported curve misses key resonance band (e.g., high-passed $> 100\text{ Hz}$ curve used to fit $32\text{ Hz}$ subwoofer tuning).
- `PolarityInvertedMeasurement { detected_phase_offset_deg }` — Detects $180^\circ$ inverted mic/wiring polarity before fitting and prompts one-click polarity flip.
- `SenseResistorMissingOrInvalid` — Raw 2-channel impedance `.wav` imported without positive $R_{\text{sense}}$.
