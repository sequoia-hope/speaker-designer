# Spec 01 — Tier 1: Electro-Mechano-Acoustic MNA, 1D Waveguides/Horns & 3D Mutual Radiation (`acoustics-network`)

## 1. Scope & Purpose

`crates/acoustics-network` solves arbitrary multi-driver, multi-cabinet loudspeaker systems in milliseconds across hundreds of log-spaced frequencies ($5\text{ Hz} \le f \le 30\text{ kHz}$). Unlike rigid template calculators ("sealed", "ported"), it compiles any loudspeaker and multi-cabinet array into a single coupled **Modified Nodal Analysis (MNA)** complex linear system $\mathbf{A}(\omega)\mathbf{x}(\omega) = \mathbf{b}(\omega)$, coupling:

1. Amplifier output impedance + active DSP transfer function $H_{\text{DSP},d}(\omega)$ per channel;
2. Lossy electro-mechano-acoustic transducer two-ports (woofers, subwoofers, compression drivers, domes, passive radiators);
3. Arbitrary nodal acoustic networks of lumped chambers, porous absorbers, vents, **1D Kirchhoff-Stinson thermoviscous horns/waveguides**, **tapped horns** (front & rear diaphragm nodes injected into arbitrary axial horn junctions), and compound/bandpass chambers;
4. **Full dense 3D Mutual Radiation Impedance Matrix $\mathbf{Z}_{\text{rad}}(\omega)$** coupling *every* exterior radiating aperture across *all* cabinets and image-source boundary planes ($4\pi$ free, $2\pi$ ground, $\pi$ wall-floor, $\pi/2$ corner, or finite-impedance ground).

---

## 2. Inputs & Parameter Domain (SI Units)

- **Ambient Air State (`AirProperties` [Ref #29]):** Temperature $T \in [233.15, 333.15]\text{ K}$, static pressure $P_0 \in [50{,}000, 120{,}000]\text{ Pa}$, relative humidity $RH \in [0, 1] \implies (\rho_0, c, \mu, \kappa, \gamma, C_p, \text{Pr})$.
- **Small-Signal Driver Parameters (`DriverSmallSignal`):**
  - Electrical: $R_{e0}$ ($\Omega$ at $T_{\text{ref}}$), voice-coil lossy inductance model (`InductanceModel` — see §4 Branch Table).
  - Mechanical: $M_{md}$ ($\text{kg}$, *dry* diaphragm + coil mass excluding air radiation load so 3D radiation mass is never double-counted; converter from datasheet $M_{ms}$ subtracts standard baffled $2 \times \frac{8}{3}\rho_0 a^3$), $C_{ms0}$ ($\text{m/N}$), creep factor $\lambda_{\text{creep}}$ [Ref #9], $R_{ms}$ ($\text{N}\cdot\text{s}/\text{m}$), effective piston area $S_d$ ($\text{m}^2$), motor force factor $Bl$ ($\text{T}\cdot\text{m}$), linear excursion limit $X_{\max}$ ($\text{m}$), mechanical damage limit $X_{\text{mech}}$ ($\text{m}$).
- **Acoustic Network Graph (`AcousticGraph`):**
  - Nodes $n \in \{0, \dots, N_a\}$ where node $0$ is ambient reference ($p_0 = 0$) and exterior boundary ports $m \in \{1, \dots, M_{\text{ext}}\}$ terminate into $\mathbf{Z}_{\text{rad}}(\omega)$.
  - Elements: `LumpedChamber`, `HelmholtzPort`, `WaveguideSegment` (cylindrical, conical, exponential, Salmon hyperbolic, tractrix, tabular spline), `PorousLayer` (JCA / Miki), `AcousticResistance` (mesh/screen/leak), `PassiveRadiator`.

---

## 3. Mathematical Formulation

### 3.1 Transducer Electro-Mechano-Acoustic Stamp ($e^{+j\omega t}$)

For driver $d$ with voice-coil voltage $V_d$, current $I_d$, diaphragm velocity $v_d$ (positive toward front acoustic node $n_+$ from rear acoustic node $n_-$), electrical impedance $Z_{e,d}(\omega)$, and mechanical impedance $Z_{m,d}(\omega) = R_{ms} + j\omega M_{md} + \frac{1}{j\omega C_{ms}(\omega)}$ with logarithmic creep $C_{ms}(\omega) = C_{ms0}\left[1 - \lambda_{\text{creep}}\ln(j\omega / \omega_{\text{ref}})\right]$ [Ref #9]:

$$\begin{bmatrix} Z_{e,d}(\omega) & Bl_d & 0 & 0 \\ -Bl_d & Z_{m,d}(\omega) & S_{d} & -S_{d} \\ 0 & -S_{d} & 0 & 0 \\ 0 & S_{d} & 0 & 0 \end{bmatrix} \begin{bmatrix} I_d \\ v_d \\ p_{n_+} \\ p_{n_-} \end{bmatrix} = \begin{bmatrix} V_{\text{amp},d}(\omega) \\ 0 \\ -U_{n_+} \\ -U_{n_-} \end{bmatrix}$$

### 3.2 1D Thermoviscous Waveguides, Folded Horns & Tapped Horns [Ref #3, #4, #7]

Each waveguide/horn segment of length $L$, hydraulic radius $r_h(x) = \frac{2 S(x)}{P_{\text{perim}}(x)}$, and area profile $S(x)$ uses **Kirchhoff-Stinson [Ref #7]** complex effective density and compressibility to capture viscous and thermal Stokes boundary-layer attenuation in narrow ports, slots, and horn throats:

$$\tilde{\rho}(\omega, r_h) = \rho_0 \left[1 - \frac{2}{s_v \sqrt{-j}} \frac{J_1(s_v \sqrt{-j})}{J_0(s_v \sqrt{-j})}\right]^{-1}, \quad \tilde{C}(\omega, r_h) = \frac{1}{\gamma P_0}\left[1 + (\gamma - 1)\frac{2}{s_{th}\sqrt{-j}}\frac{J_1(s_{th}\sqrt{-j})}{J_0(s_{th}\sqrt{-j})}\right]$$

where shear wavenumber $s_v = r_h \sqrt{\rho_0 \omega / \mu}$ and thermal wavenumber $s_{th} = s_v \sqrt{\text{Pr}}$, giving complex wavenumber $k_c(\omega) = \omega \sqrt{\tilde{\rho}\tilde{C}}$ and characteristic acoustic impedance $Z_c(\omega, x) = \frac{\sqrt{\tilde{\rho}/\tilde{C}}}{S(x)}$.

For canonical **Salmon hyperbolic-exponential segments [Ref #3]**, $S(x) = S_0(\cosh mx + T\sinh mx)^2$ ($T=0$: catenoid, $T=1$: exponential, $T \to \infty, m \to 0$: conical, $m=0$: uniform duct), the exact analytical $2\times 2$ transfer matrix $\mathbf{T}_{\text{seg}}(\omega)$ relating $(p_1, U_1)^T = \mathbf{T}_{\text{seg}}(p_2, U_2)^T$ is converted to its two-port nodal admittance matrix $\mathbf{Y}_{\text{seg}}(\omega) \in \mathbb{C}^{2\times 2}$ (with series expansion guard near $\sin(\gamma_h L) \to 0$ half-wave singularities, replaced smoothly by $N_{\text{sub}}$ sub-elements when $k_c L \to n\pi$). Arbitrary CAD spline area profiles $S(x)$ subdivide into exact piecewise conical/exponential sub-segments ($h \le \lambda / 24$).

**Tapped Horns & Offset Junctions:** Because every segment stamps a $2\times 2$ admittance block into the global MNA matrix $\mathbf{Y}_{\text{ac}}$, a **tapped horn** requires zero special-case hacks: the driver's rear face connects to horn node $n_a$ (near throat) and its front face connects to horn node $n_b$ (near mouth or mid-horn tap), automatically capturing bidirectional wave interference, throat impedance unloading below cutoff, and phase cancellation notches above the upper passband!

### 3.3 Full 3D Multi-Aperture Mutual Radiation Matrix $\mathbf{Z}_{\text{rad}}(\omega)$ [Ref #5, #6]

Let exterior radiating apertures $m \in \{1, \dots, M_{\text{ext}}\}$ across all cabinets in the 3D scene have world centroids $\mathbf{r}_m$, outward normals $\hat{\mathbf{n}}_m$, areas $S_m$, and quadrature patches:

1. **Self-Impedance $Z_{\text{rad},mm}(\omega)$:**
   - Circular/elliptical piston in baffled ($2\pi$), free-space ($4\pi$, Beranek unbaffled sphere/tube radiation interpolation [Ref #2, #19]), or Tier-2 cached $\mathbf{Z}_{3D}$ port impedance:
     $$Z_{\text{baffled}}(ka) = \frac{\rho_0 c}{S_m}\left[1 - \frac{J_1(2ka)}{ka} + j\frac{H_1(2ka)}{ka}\right]$$
2. **Mutual Impedance $Z_{\text{rad},mn}(\omega)$ ($m \neq n$) & Boundary Image Method:**
   - Evaluated via **Rayleigh-Pritchard double surface quadrature [Ref #5]** over aperture $m$ and aperture $n$ plus all active mirror images $\mathcal{I}$ (ground $z=0$, side wall $x=x_w$, rear wall $y=y_w$) weighted by reflection coefficient $R_{\text{img}}(\omega, \theta)$ (rigid $R=1$ or **Delany-Bazley/Weyl-Van der Pol** finite ground impedance):
     $$Z_{\text{rad},mn}(\omega) = \frac{j\omega\rho_0}{2\pi S_m S_n} \sum_{\sigma \in \mathcal{I}} R_\sigma \iint_{S_m}\iint_{S_n} \frac{e^{-jk|\mathbf{x} - \sigma(\mathbf{y})|}}{|\mathbf{x} - \sigma(\mathbf{y})|} \, dS_{\mathbf{y}} \, dS_{\mathbf{x}} \cdot \Phi_{\text{baffle}}(\hat{\mathbf{n}}_m, \hat{\mathbf{n}}_n, ka_{\text{cab}})$$
   - Where $\Phi_{\text{baffle}}$ transitions smoothly from omnidirectional $4\pi$ coupling at low subwoofer wavelengths ($ka_{\text{cab}} \ll 1$) to hemispherical $2\pi$ shadow weighting when $ka_{\text{cab}} \gg 1$ (and is superseded altogether whenever Tier-2 3D BEM is active).

### 3.4 3D Far-Field & Near-Field Evaluation

Once $\mathbf{x}(\omega)$ is solved, every aperture volume velocity $U_m(\omega)$ is known *including all mutual loading effects*. Acoustic pressure at any 3D listener point $\mathbf{r}$ is evaluated by coherent aperture-quadrature radiation summation across all apertures and active boundary images, including ISO 9613-1 atmospheric attenuation $e^{-\alpha_{\text{atm}}(f) R}$ [Ref #29].

---

## 4. Branch Table

| Dimension | Branches | Selection / Normalization |
|---|---|---|
| `InductanceModel` | `SimpleLe`, `L2R2` [Ref #8], `L3R3`, `Leach { k, alpha }`, `Wright { kr, er, kx, ex }` | Normalized to scalar complex $Z_e(\omega)$ in Tier 1; `L2R2`/`L3R3` directly stamp real ODE states in Tier 3. |
| `ChamberThermodynamics` | `Adiabatic`, `Isothermal`, `PolytropicFill { sigma, fill_ratio }` [Ref #2, #15] | Complex effective $\gamma_{\text{eff}}(\omega) \in [1.0, \gamma_0]$ eliminates discontinuous boolean branches. |
| `WaveguideContour` | `Uniform`, `Conical`, `Exponential`, `Salmon { t }`, `Tractrix`, `ProfileSpline` | `Uniform`/`Conical`/`Exponential` normalize to `Salmon` analytical limits or exact sub-segmented TMM. |
| `RadiationSpace` | `Free4Pi`, `Ground2Pi`, `WallFloorPi`, `CornerHalfPi`, `FiniteImpedanceGround { sigma }` | Handled uniformly via the image-source group $\mathcal{I}$ ($|\mathcal{I}| \in \{1, 2, 4, 8\}$). |
| `ApertureCouplingMode` | `UncoupledSelfOnly` (diagnostic comparison), `FullMutualRayleighPritchard`, `ImportedBemRom` | Allows instant UI A/B toggle showing the exact dB/excursion gain caused by 2×/4× mutual coupling! |

---

## 5. Invariants & Analytical Oracles (`acoustics-oracles`)

1. **O1.1 — Small (1972) Sealed & Vented Exact Oracle [Ref #1]:** With lossless $L_e=0$, no creep, and $2\pi$ radiation mass lumped into $M_{ms}$, electrical impedance $Z_e(f)$, cone displacement $|x(f)|$ null at $f_b$, and far-field SPL match Small's closed-form 2nd- and 4th-order transfer functions to $< 10^{-11}$ relative error.
2. **O1.2 — Salmon Analytical Horn Oracle [Ref #3]:** Multi-sub-segment TMM on a $2.5\text{ m}$ exponential and hyperbolic ($T=0.5$) horn terminated in known impedance matches the single closed-form Salmon throat impedance to $< 10^{-10}$ across $10\text{ Hz}–2\text{ kHz}$ (including exact $k_c L = n\pi$ half-wave points).
3. **O1.3 — Pritchard Mutual Impedance Oracle [Ref #5]:** Numerical aperture quadrature $Z_{\text{rad},12}(kd)$ for two circular pistons of radius $a$ at center spacing $d \in [2a, 20a]$ matches Pritchard's analytical Bessel-Struve series to $< 10^{-6}$ relative error.
4. **O1.4 — Reciprocity & Passivity Invariant (A5):** For any passive acoustic network without active amplifier sources, nodal impedance $\mathbf{Z}(\omega)$ is complex symmetric ($\|\mathbf{Z} - \mathbf{Z}^T\|_F / \|\mathbf{Z}\|_F < 10^{-13}$) and dissipative ($\lambda_{\min}(\mathbf{Z} + \mathbf{Z}^H) \ge -10^{-12}\|\mathbf{Z}\|$).
5. **O1.5 — 4× Horn Stack Energy Conservation Oracle:** Total radiated acoustic real power $\frac{1}{2}\text{Re}\{\mathbf{U}^H \mathbf{Z}_{\text{rad}} \mathbf{U}\}$ integrated over the $2\pi$ far-field hemisphere equals input electrical power minus voice-coil Joule, mechanical $R_{ms}$, and Stinson thermoviscous losses within $< 0.2\%$.

---

## 6. Failure Modes & Typed Errors (`NetworkError`)

- `DisconnectedAcousticSubgraph { node_id }` — Floating acoustic chamber with no path to ambient reference or compliance ground (caught at graph compilation before frequency sweep).
- `OverlappingRadiatingApertures { aperture_a, aperture_b, overlap_m }` — Two exterior mouths/ports physically intersect in 3D space ($d < r_{\min}$), invalidating mutual impedance integration.
- `NonPhysicalParameter { field, value, valid_range }` — Negative $R_e, M_{md}, C_{ms}, S_d$, or non-passive porous parameters rejected at construction.
- `SingularMnaMatrix { freq_hz, rcond }` — Ill-conditioned system (e.g., lossless zero-resistance LC loop at exact pole) flagged loudly with frequency and offending sub-circuit.
