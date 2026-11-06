# Spec 02 — Tier 2: Full-Wave 3D Coupled Interior FEM + Exterior Burton-Miller BEM (`acoustics-fem`, `acoustics-bem`, `acoustics-coupled`)

## 1. Scope & Purpose

Tier 2 solves the exact three-dimensional Helmholtz PDE $(\nabla^2 + k^2)p(\mathbf{x}) = 0$ inside arbitrary 3D loudspeaker enclosures, folded horns, waveguides, phase plugs, and flared ports, coupled seamlessly across open mouths/diaphragms to unbounded 3D exterior radiation, cabinet edge diffraction, multi-cabinet mutual scattering, and rigid/symmetric ground/wall boundaries.

It also extracts **compact Multi-Port 3D Reduced-Order Models ($\mathbf{Z}_{3D}(\omega)$ + Spherical Harmonic Multipoles)** so an expensive 3D geometry solve can be reused instantaneously in Tier 1 (driver/crossover iteration) and Tier 3 (nonlinear/thermal transient simulation).

---

## 2. Geometry & Mesh Contracts (`acoustics-mesh`)

1. **Surface Mesh (`AcousticSurfaceMesh`):** Orientable, watertight manifold triangle mesh per solid body (`positions: Vec<[f64; 3]>`, `indices: Vec<[u32; 3]>`, outward normals verified via generalized winding number [Ref #18]), partitioned into persistent `PatchId` groups with assigned `BoundaryCondition`:
   - `RigidWall` ($\partial_n p = 0$)
   - `ThermoviscousWall` (Berggren Stokes boundary layer [Ref #16])
   - `SurfaceImpedance { model: DelanyBazley | Miki | Tabular }` ($\partial_n p = -j\omega\rho_0 Y_s(\omega) p$)
   - `TransducerFace { driver_id, side: Front | Rear, mode_shape }` ($v_n(\mathbf{x}) = v_d \psi(\mathbf{x})$)
   - `CouplingInterface { interface_id }` (fictitious cap sheet across a horn mouth or port exit separating Interior $\Omega_{\text{int}}$ from Exterior $\Omega_{\text{ext}}$ with $p_{\text{int}} = p_{\text{ext}}$ and $v_{n,\text{int}} + v_{n,\text{ext}} = 0$)
   - `ElasticPanel { thickness_m, E_pa, rho_panel, nu, loss_eta }` (vibro-acoustic enclosure wall)
2. **Frequency-Adaptive Mesh Sizing:** Element edge length $h \le \frac{c}{6 f_{\max}}$ for quadratic P2 FEM / linear BEM, or banded multi-mesh schedules (low band $20\text{–}250\text{ Hz}$, mid band $250\text{ Hz}–2\text{ kHz}$, high band $2\text{–}20\text{ kHz}$) so subwoofer solves never pay 20 kHz element counts.
3. **Clean-Room MIT Volumetric Meshing [Ref #17, #18]:**
   - **Path A (Inhomogeneous Interior FEM):** **Labelle & Shewchuk (2007) BCC Isosurface Stuffing** generates 4-node (P1) and curved 10-node (P2) tetrahedra with guaranteed dihedral angles $\ge 10.7^\circ$ and zero slivers in pure WASM-clean Rust.
   - **Path B (Homogeneous Interior Subregion BEM):** Air-only folded horns and cabinets can optionally solve $\Omega_{\text{int}}$ via **Multi-Domain BEM** directly from the surface triangles without volumetric tetrahedralization.

---

## 3. Mathematical Formulation ($e^{+j\omega t}$)

### 3.1 Interior 3D Helmholtz FEM (`acoustics-fem`) [Ref #11, #15, #16]

Inside $\Omega_{\text{int}} = \Omega_{\text{air}} \cup \Omega_{\text{porous}}$, pressure $p(\mathbf{x}) = \sum_{i=1}^{N_F} N_i(\mathbf{x}) p_i$ (preferring **10-node quadratic P2 tetrahedra** to suppress Helmholtz dispersion pollution error) satisfies the weak variational form:

$$\int_{\Omega_{\text{int}}} \left( \frac{1}{\tilde{\rho}(\mathbf{x}, \omega)} \nabla w \cdot \nabla p - \frac{\omega^2}{\tilde{K}(\mathbf{x}, \omega)} w \, p \right) d\Omega + j\omega \int_{\Gamma_{\text{imp}}} Y_s(\omega) w \, p \, d\Gamma + \mathcal{B}_{\text{TV}}(w, p) = -j\omega \int_{\Gamma_v} w \, v_n \, d\Gamma$$

- **Inhomogeneous Porous Media (`Omega_porous`):** **Johnson-Champoux-Allard (JCA) [Ref #15]** 5-parameter equivalent fluid ($\phi, \sigma, \alpha_\infty, \Lambda, \Lambda'$) defines spatially varying complex density $\tilde{\rho}(\omega)$ and bulk modulus $\tilde{K}(\omega)$:
  $$\tilde{\rho}(\omega) = \frac{\alpha_\infty \rho_0}{\phi}\left[1 + \frac{\sigma\phi}{j\omega\rho_0\alpha_\infty}\sqrt{1 + j\frac{4\alpha_\infty^2 \mu \rho_0 \omega}{\sigma^2 \Lambda^2 \phi^2}}\right], \quad \tilde{K}(\omega) = \frac{\gamma P_0 / \phi}{\gamma - (\gamma - 1)\left[1 + \frac{8\kappa}{j\omega \rho_0 C_p \Lambda'^2}\sqrt{1 + j\frac{\rho_0 C_p \omega \Lambda'^2}{16\kappa}}\right]^{-1}}$$
- **Thermoviscous Stokes Boundary Layer $\mathcal{B}_{\text{TV}}$ [Ref #16]:** On narrow port walls, compression-driver slots, and horn throats ($\Gamma_{\text{TV}}$), Berggren's tangential surface-Laplacian boundary integral:
  $$\mathcal{B}_{\text{TV}}(w, p) = \int_{\Gamma_{\text{TV}}} \left( \frac{\delta_v(1 - j)}{2\rho_0} \nabla_\Gamma w \cdot \nabla_\Gamma p - \frac{\omega^2 \delta_{\text{th}}(\gamma - 1)(1 - j)}{2\gamma P_0} w \, p \right) d\Gamma$$
  captures viscous ($\delta_v = \sqrt{2\mu/(\rho_0\omega)}$) and thermal ($\delta_{\text{th}} = \sqrt{2\kappa/(\rho_0 C_p \omega)}$) boundary layers accurately without prism layer meshing!
- **Matrix Form:** $(\mathbf{K}_{\text{FEM}}(\omega) - \omega^2 \mathbf{M}_{\text{FEM}}(\omega) + j\omega \mathbf{C}_{\text{FEM}}(\omega))\mathbf{p}_F - j\omega\rho_0 \mathbf{L}_{FI}\mathbf{v}_I - j\omega\rho_0 \mathbf{L}_{FD}\mathbf{v}_D = \mathbf{0}$.

### 3.2 Exterior 3D Burton-Miller BEM (`acoustics-bem`) [Ref #10, #11, #12]

Standard Kirchhoff-Helmholtz surface integral equations fail catastrophically at discrete fictitious eigenfrequencies of the interior volume enclosed by $\Gamma_{\text{ext}}$. We strictly enforce the **Burton-Miller (1971) [Ref #10]** combined boundary integral equation with coupling parameter $\alpha = -j / k$:

$$\frac{1}{2}\left(1 + \alpha \frac{\partial}{\partial n_{\mathbf{x}}}\right) p(\mathbf{x}) = \int_{\Gamma_{\text{ext}}} \left[ \left(\frac{\partial G_k}{\partial n_{\mathbf{y}}} + \alpha \frac{\partial^2 G_k}{\partial n_{\mathbf{x}}\partial n_{\mathbf{y}}}\right) p(\mathbf{y}) + j\omega\rho_0 \left(G_k + \alpha \frac{\partial G_k}{\partial n_{\mathbf{x}}}\right) v_n(\mathbf{y}) \right] d\Gamma_{\mathbf{y}}$$

- **Half / Quarter / Eighth-Space Modified Green's Function:**
  $$G_k(\mathbf{x}, \mathbf{y}) = \sum_{\sigma \in \mathcal{I}} \epsilon_\sigma \frac{e^{-jk|\mathbf{x} - \sigma(\mathbf{y})|}}{4\pi |\mathbf{x} - \sigma(\mathbf{y})|}$$
  Rigid ground ($z=0$), rigid room corners, and cabinet mirror symmetry ($1/2$ or $1/4$ cabinet meshing!) are exact in $G_k$ with **zero extra BEM DOFs**.
- **Maue-Mitzner Hypersingular Regularization [Ref #11]:** In a Petrov-Galerkin / Collocation-Galerkin weak form with continuous piecewise-linear ($P_1$) pressure and piecewise-constant ($P_0$) or $P_1$ velocity, the $O(1/R^3)$ hypersingular operator $N_k$ transforms via Stokes' theorem into weakly singular $O(1/R)$ integrals:
  $$\iint_{\Gamma\times\Gamma} \frac{\partial^2 G_k}{\partial n_{\mathbf{x}}\partial n_{\mathbf{y}}} \phi_i(\mathbf{x})\phi_j(\mathbf{y}) \, d\Gamma_{\mathbf{y}} d\Gamma_{\mathbf{x}} = \iint_{\Gamma\times\Gamma} G_k(\mathbf{x},\mathbf{y}) \left[ k^2 (\hat{\mathbf{n}}_{\mathbf{x}}\cdot\hat{\mathbf{n}}_{\mathbf{y}})\phi_i\phi_j - (\hat{\mathbf{n}}_{\mathbf{x}}\times\nabla_\Gamma\phi_i)\cdot(\hat{\mathbf{n}}_{\mathbf{y}}\times\nabla_\Gamma\phi_j) \right] d\Gamma_{\mathbf{y}} d\Gamma_{\mathbf{x}}$$
- **Exact Singular Quadrature [Ref #12]:** Coincident, common-edge, and common-vertex triangle pairs are integrated via **Erichsen-Sauter / Duffy polar-simplex coordinate transforms**, cancelling the $1/R$ Jacobian analytically to machine precision.
- **Linear Solver Strategy (`DenseDirect` vs `HMatrixGmres`):**
  - $N_{\text{BEM}} \le 3{,}000$: Dense assembly (WebGPU WGSL kernel or multi-Worker SIMD128) + `faer` complex LU factorization.
  - $N_{\text{BEM}} > 3{,}000$: Octree spatial clustering + admissible far-field **Adaptive Cross Approximation (ACA) $\mathcal{H}$-matrix [Ref #13]** ($\eta$-admissibility $\text{diam}(\tau) \le \eta\,\text{dist}(\tau,\sigma)$ for low-frequency / multi-band regimes) solved via **GMRES** with sparse near-field / Calderón preconditioning [Ref #14].

### 3.3 Coupled Electro-Mechano-FEM-BEM System & Multi-Port ROM (`acoustics-coupled`)

Eliminating interior FEM DOFs $\mathbf{p}_F$ via sparse `faer` factorization yields the exact boundary Schur complement on the coupling interfaces $\Gamma_I$ and driver diaphragms $\Gamma_D$, assembling cleanly with the BEM system and $N_d$ transducer electro-mechanical circuits into one coupled system!

**Multi-Port 3D Impedance ROM Extraction:** By solving $P = N_{\text{diaphragms}} + N_{\text{coupled\_cabinets}}$ unit-velocity RHS columns (reusing the *single* LU / $\mathcal{H}$-matrix factorization at each $\omega_q$!), `acoustics-coupled` extracts:
1. Exact multi-port acoustic impedance matrix $\mathbf{Z}_{3D}(\omega_q) \in \mathbb{C}^{P\times P}$;
2. Spherical-harmonic multipole radiation vectors $\mathbf{c}_{lm}^{(p)}(\omega_q)$ ($0 \le l \le L_{\max}$) enabling instantaneous evaluation of 3D far-field pressure anywhere in space for any future driver or DSP combination!

---

## 4. Branch Table

| Dimension | Branches | Selection / Normalization |
|---|---|---|
| `InteriorMethod` | `TetrahedralFemP1`, `TetrahedralFemP2` (default), `SubregionBem` | Selected per interior cavity (`SubregionBem` valid iff cavity is homogeneous fluid). |
| `BemLinearSolver` | `DenseFaerLu`, `HMatrixAcaGmres { tol, eta }` | Auto-selected at threshold $N_{\text{BEM}} = 3{,}000$ or pinned in solver config. |
| `KernelBackend` | `WebGpuWgsl`, `CpuSimd128` | Identical mathematical integrand; `WebGpuWgsl` verified bit-close ($< 10^{-5}$ `f32` / $< 10^{-12}$ `f64` accumulation) against `CpuSimd128`. |
| `SymmetryGroup` | `None`, `MirrorX`, `MirrorXY`, `GroundZ`, `GroundZMirrorX`, `QuarterWallFloor`, `EighthCorner` | Unified 8-element reflection group $\mathcal{I}$ with sign characters $\epsilon_\sigma \in \{-1, +1\}$. |
| `WallElasticity` | `Rigid`, `MindlinShellCoupled` | Adds sparse shell structural block $(\mathbf{K}_s(1+j\eta_s) - \omega^2\mathbf{M}_s)\mathbf{u}_s$ when cabinet resonance audit is enabled. |

---

## 5. Invariants & Analytical Oracles

1. **O2.1 — Pulsating & Oscillating Sphere Irregular-Frequency Oracle [Ref #10]:** For a unit sphere of radius $a$ evaluated specifically at the exact interior Dirichlet irregular wavenumbers $ka \in \{\pi, 4.493409, 2\pi, 3\pi\}$, Burton-Miller BEM surface pressure and far-field SPL match exact spherical Hankel $h_0^{(2)}(ka), h_1^{(2)}(ka)$ solutions within $< 0.05\text{ dB}$ and $< 0.5^\circ$ phase (whereas naive CBIE diverges by $> 30\text{ dB}$, verified by negative mutation test!).
2. **O2.2 — Levine-Schwinger Unflanged Circular Pipe Oracle [Ref #19]:** Coupled 3D Interior P2 FEM + Exterior Burton-Miller BEM on an open rigid circular cylinder ($L/a = 4$) reproduces the exact Wiener-Hopf end-correction $\Delta L / a = 0.6133 \pm 0.005$ as $ka \to 0$ and reflection magnitude $|R(ka)|$ within $1\%$ up to $ka = 3.0$.
3. **O2.3 — Closed Rectangular & Porous-Filled Cavity Eigenmode Oracle [Ref #11, #15]:** Interior P2 FEM eigenfrequencies/input impedance peaks on $L_x \times L_y \times L_z$ rigid box match analytical $f_{lmn} = \frac{c}{2}\sqrt{(l/L_x)^2 + (m/L_y)^2 + (n/L_z)^2}$ within $< 0.15\%$ at $6$ elements/wavelength; JCA half-filled tube surface impedance matches analytical 1D JCA transfer matrix within $< 0.1\text{ dB}$.
4. **O2.4 — Berggren Thermoviscous Narrow Tube Oracle [Ref #7, #16]:** 3D FEM with Berggren boundary condition on a $2\text{ mm}$ radius port matches Stinson's exact analytical Bessel tube attenuation ($\text{dB/m}$) and phase velocity shift within $< 2\%$ without boundary-layer prism elements.
5. **O2.5 — Low-Frequency Cross-Tier Convergence (Tier 2 $\leftrightarrow$ Tier 1):** Coupled 3D FEM-BEM on a 1×, 2×, and 4× ground-stacked exponential subwoofer horn agrees with Tier-1 (`acoustics-network`) SPL and electrical impedance within $< 0.25\text{ dB}$ below $80\text{ Hz}$ while revealing 3D fold reflections, mouth diffraction, and off-axis polar lobing above $80\text{ Hz}$.

---

## 6. Failure Modes & Typed Errors (`FemBemError`)

- `NonManifoldOrOpenMesh { body_id, open_edges, winding_leak }` — Input surface mesh is not watertight; highlights exact defective edges in the 3D viewport.
- `MeshTooCoarseForFrequency { max_edge_m, freq_hz, elements_per_wavelength }` — Refuses silent pollution error when $< 4$ elements/wavelength without auto-remesh permission.
- `UnmatchedInterfacePatch { interface_id }` — Interior and exterior meshes do not share conformal boundary nodes on a `CouplingInterface`.
- `GmresStagnation { freq_hz, iterations, residual }` — Iterative $\mathcal{H}$-matrix solve failed to reach target tolerance ($10^{-6}$).
