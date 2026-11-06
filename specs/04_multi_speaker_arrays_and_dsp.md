# Spec 04 — Multi-Speaker Sound Systems, Active LMS DSP & 3D Venue Analysis (`acoustics-dsp`, `speaker-engine`)

## 1. Scope & Purpose

`crates/acoustics-dsp` and `crates/speaker-engine` elevate individual speaker models into complete **multi-way, multi-cabinet 3D sound systems** — from 2× and 4× coupled subwoofer horn stacks, cardioid/end-fire/arc subwoofer arrays, to full-range 4-way festival/club stacks (subwoofers + kick bins + mid-horns + HF compression-driver waveguides) evaluated over 3D venue/audience geometry and standardized spherical balloons.

---

## 2. Active Loudspeaker Management (LMS) Signal Chain (`acoustics-dsp`)

Every amplifier channel $c \in \{1, \dots, N_{\text{ch}}\}$ models a complete digital loudspeaker processor operating identically in both the complex frequency domain $H_{\text{DSP},c}(\omega)$ (for Tiers 1 & 2) and discrete time domain $f_s \in \{48, 96, 192\}\text{ kHz}$ (for Tiers 3 & 4):

```
Input Bus(es) ──► Matrix Gain & Polarity (±1) ──► Fractional Delay (τ_c)
              ──► High-Pass / Low-Pass Crossover ──► N-Band Parametric EQ (PEQ)
              ──► All-Pass Phase Filters ──► FIR Convolution (h_FIR)
              ──► Peak & Thermal RMS Limiters ──► Amplifier Model (Gain, Z_out, V_rail)
```

### 2.1 Filter & Amplifier Primitives

1. **Crossovers:** Butterworth ($1\text{st–8th}$ order), Linkwitz-Riley (`LR12`, `LR24`, `LR36`, `LR48`), Bessel ($2\text{nd–8th}$), Chebyshev, and Elliptic/Cauer, evaluated via exact analog-matched / Orfanidis cramping-compensated biquad cascades (and exact Laplace/discrete transfer functions).
2. **Parametric & Shelving EQ:** Peaking (RBJ / Orfanidis constant-Q), Low/High Shelf, Notch, Tilt, and **Linkwitz Transform** (pole-zero relocation for sealed subwoofers).
3. **Phase Linearization & Delay:** First- and second-order All-Pass sections plus arbitrary **FIR taps** ($N_{\text{FIR}} \le 16{,}384$, windowed-sinc linear-phase crossovers, excess-phase horn group-delay inversion, or imported `.wav`/`.txt` FIR coefficients) and sub-sample fractional delay $e^{-j\omega\tau_c}$ (Lagrange / Thiran all-pass interpolator in time domain).
4. **Amplifier & Limiter Envelope:** Models amplifier voltage gain, nonzero output impedance $Z_{\text{amp}}(\omega)$ (damping factor!), rail supply sag / voltage clipping $\pm V_{\text{rail}}$, current limiting $I_{\max}$, and lookahead Peak + RMS limiters (active in Tier-3 transient/harmonic runs).

---

## 3. Coupled Multi-Subwoofer Array Topologies & Automated Synthesis [Ref #4, #5, #32]

Unlike uncoupled calculators, Speaker Designer optimizes array delays, gains, and polarities **with the full mutual radiation impedance matrix $\mathbf{Z}_{\text{rad}}(\omega)$ (Tier 1) or 3D BEM $\mathbf{Z}_{3D}(\omega)$ (Tier 2) inside the loop**:

### 3.1 Built-In Array Arrangement Generators & Presets

1. **Coupled Mouth Stacks (`2x Horizontal`, `2x Vertical`, `4x 2×2 Monoblock`, `Center-Mouth V-Couple`):**
   - Places 2 or 4 folded/tapped horns with mouths adjacent or mirrored on a ground/corner boundary so individual fractional horn mouths combine into one uninterrupted virtual mouth of $2 S_m$ or $4 S_m$.
   - Computes and displays the **Coupling Gain Decomposition**: separating coherent summation ($+6\text{ dB}$ per doubling) from **Mutual Impedance Loading Gain** ($\Delta L_{\text{mutual}}(f) \text{ dB}$ and cone-excursion reduction $\Delta |x(f)|$) so the designer sees *exactly* why a specific 2× or 4× arrangement locks together!
2. **Gradient / Cardioid Subwoofer Arrays (`CSA 2:1`, `CSA 3:1`, `Front-Back-Front`):**
   - Rear-facing (or inverted) element(s) separated by physical offset $d$; optimizer solves $(G_{\text{rear}}, \tau_{\text{rear}}, H_{\text{EQ,rear}}(\omega))$ to maximize rear cancellation hemisphere ($120^\circ\text{–}240^\circ$, e.g. stage/DJ booth zone) across $[f_{\text{lo}}, f_{\text{hi}}]$ **subject to rear-driver $X_{\max}$ excursion and negative active acoustic power constraints!**
3. **End-Fire Arrays (`2-Deep` to `8-Deep`):**
   - Co-axial line along $+\hat{\mathbf{y}}$ with progressive delay $\tau_m \approx m \cdot d / c$ refined against mutual coupling to maximize forward throw while suppressing rear/side lobes.
4. **Broadside & Electronically Steered Horizontal Arcs:**
   - Parabolic delay taper $\tau_m$ across $N$ horizontal subwoofers to synthesize a target horizontal coverage angle $\Theta_{-6\text{dB}} \in [40^\circ, 140^\circ]$ without power alleys.
5. **Multi-Way Phase-Tracking Crossover Optimizer:**
   - Given 3D acoustic transfer functions $H_k(\mathbf{r}_{\text{listen}}, \omega)$ (including physical acoustic centers and horn path delays!) of Sub, Kick, Mid, and HF ways over a target listening window, optimizes crossover slopes, delays $\tau_k$, polarities, and all-pass / PEQ bands so adjacent ways remain within $\pm 15^\circ$ relative phase throughout the entire $-10\text{ dB}$ crossover overlap zone!

---

## 4. Standardized 3D Directivity, Venue Coverage & Mutual-Power Diagnostics

### 4.1 Individual & Single-Stack Standardized Metrics [Ref #31]

- **ANSI/CTA-2034-A ("Spinorama"):** Evaluates exact $5^\circ$ or $10^\circ$ horizontal and vertical spherical orbits ($70$ unique points) at standard $2\text{ m}$ (or far-field normalized to $1\text{ m}$) to produce:
  - On-Axis, Listening Window (LW), Early Reflections (ER: floor, ceiling, front, side, rear bounces), Sound Power (SP), Directivity Index ($\text{DI} = \text{LW} - \text{SP}$), and Early Reflections DI ($\text{ERDI}$).
- **3D Polar Balloons & Contour Sonograms:** Normalized ($0\text{ dB}$ on-axis) and unnormalized horizontal/vertical directivity contour maps ($-180^\circ \dots +180^\circ \times 20\text{ Hz}\dots 20\text{ kHz}$), beamwidth $-3\text{ dB} / -6\text{ dB}$ curves, and interactive 3D colored spherical meshes at any frequency slider position.

### 4.2 Venue / Outdoor Sound-System Field Metrics

- **3D Listener Surfaces & Exclusion Zones:** Arbitrary planar, raked-bleacher, or multi-tier 3D audience polygons $\mathcal{S}_{\text{aud}}$ plus Quiet/Stage/Neighbor exclusion polygons $\mathcal{S}_{\text{excl}}$:
  - Spatial SPL uniformity ($\sigma_{\text{SPL}}$ std-dev and $L_{90} - L_{10}$ spread across $\mathcal{S}_{\text{aud}}$ in octave / 1/3-octave / broadband A- and C-weighted bands);
  - **Front-to-Back / Stage Rejection Ratio:** $\overline{L_p}(\mathcal{S}_{\text{aud}}) - \overline{L_p}(\mathcal{S}_{\text{stage}})$ ($\text{dB}$);
  - Maximum linear SPL before first cabinet hits $X_{\max}$, $I_{\max}$, $V_{\text{rail}}$, or thermal compression limit!
- **Per-Cabinet Mutual Acoustic Power Audit:** Plots active & reactive radiation impedance $Z_{\text{rad,eff},m}(\omega) = \frac{p_m(\omega)}{U_m(\omega)}$ seen by *each* cabinet in the array, flagging negative active power absorption ($\text{Re}\{Z_{\text{rad,eff},m}\} < 0$) where one driver is driven backward by its neighbors.

---

## 5. Branch Table

| Dimension | Branches | Selection / Normalization |
|---|---|---|
| `CrossoverFamily` | `Butterworth`, `LinkwitzRiley`, `Bessel`, `Elliptic`, `LinearPhaseFir` | Compiled to unified complex $H_{\text{DSP}}(\omega)$ + discrete biquad/FIR state machine. |
| `ArrayPreset` | `Custom3D`, `CoupledStack2x`, `CoupledStack4x`, `CardioidCsa`, `FrontBackFront`, `EndFire`, `ElectronicArc` | Generates deterministic 3D transforms (`Transform3`) + initial DSP delays; editable freely afterward. |
| `AlignmentTarget` | `MaxRearRejection`, `UniformAudienceSpl`, `PhaseMatchedCrossover`, `MaxHeadroomAtTargetSpl` | Smooth weighted least-squares / minimax objective over virtual microphone grids. |
| `BalloonReference` | `FreeField4Pi`, `GroundPlane2Pi` (standard for subwoofers!) | Explicitly tagged on all CTA-2034 / polar exports so $+6\text{ dB}$ ground gain is never misread. |

---

## 6. Invariants & Oracles

1. **O4.1 — Linkwitz-Riley All-Pass Acoustic Sum Oracle:** Complementary `LR24` and `LR48` low-pass + high-pass feeding two co-located ideal pistons sum to flat $0.000\text{ dB}$ magnitude ($< 10^{-12}$ ripple) and exact analytical group delay across $20\text{ Hz}–20\text{ kHz}$.
2. **O4.2 — Ideal End-Fire & Cardioid Analytical Array Factor Oracle [Ref #32]:** With mutual coupling temporarily disabled (`UncoupledSelfOnly`), $N$-element end-fire and 2-element gradient cardioid polar patterns match closed-form array factor $|1 - e^{-j(kd\cos\theta + \omega\tau)}|$ to $< 10^{-11}$; enabling `FullMutualRayleighPritchard` shifts rear driver cone excursion and optimal $G_{\text{rear}}$ measurably (verified by regression oracle).
3. **O4.3 — CTA-2034 Spherical Quadrature Weighting Oracle [Ref #31]:** Omnidirectional monopole yields $\text{LW} = \text{ER} = \text{SP}$ and $\text{DI} = 0.000\text{ dB}$ ($< 10^{-12}$); ideal first-order dipole yields analytical $\text{DI} = 10\log_{10}(3) = 4.7712\text{ dB}$ within spherical grid quadrature tolerance ($< 0.03\text{ dB}$).

---

## 7. Failure Modes & Typed Errors (`DspSystemError`)

- `CabinetCollision { cab_a, cab_b, penetration_m }` — Bounding boxes / meshes of placed cabinets intersect in 3D space.
- `UnstableIirBiquad { channel, stage, pole_radius }` — Rejects filter coefficients with $|z_p| \ge 1 - 10^{-12}$.
- `FirSampleRateMismatch { fir_fs, engine_fs }` — Triggers explicit polyphase resampling or typed error rather than silent pitch-shifted filtering.
