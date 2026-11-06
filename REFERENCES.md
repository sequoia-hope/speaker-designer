# Research References & Algorithmic Basis

Every non-trivial physics equation, discretization scheme, singular quadrature, and optimization method in `speaker-designer` cites a numbered entry in this file (e.g., `// [Ref #12] Burton-Miller coupling alpha = -j/k`). Ad-hoc approximations where closed-form or peer-reviewed formulations exist are prohibited.

---

## I. Electro-Mechano-Acoustic Networks, Horns & Mutual Radiation

- **[Ref #1] Small, R. H. (1972–1973).** *Direct-Radiator Loudspeaker System Analysis*; *Closed-Box Loudspeaker Systems*; *Vented-Box Loudspeaker Systems* (Parts I–IV). *Journal of the Audio Engineering Society (JAES)*, Vols. 20–21.
  - Canonical small-signal Thiele-Small lumped parameterization and exact 2nd/4th-order transfer-function and excursion analytical oracles.
- **[Ref #2] Beranek, L. L., & Mellow, T. J. (2019).** *Acoustics: Sound Fields, Transducers and Vibration* (2nd ed.). Academic Press.
  - Unified mobility/impedance electro-mechano-acoustic analogies, radiation impedances of baffled/unbaffled pistons and spheres, enclosure compliance with isothermal-to-adiabatic porous transitions.
- **[Ref #3] Salmon, V. (1946).** *A New Family of Horns*. *Journal of the Acoustical Society of America (JASA)*, 17(3), 212–218.
  - Generalized hyperbolic-exponential horn contour family $S(x) = S_0 (\cosh mx + T \sinh mx)^2$ and exact 1D Webster horn solutions.
- **[Ref #4] Kolbrek, B., & Dunker, T. (2019).** *High-Quality Horn Loudspeaker Systems: History, Theory, and Design*. Kolbrek Elektroakustikk.
  - Acoustic transfer-matrix method (TMM) for arbitrary multi-segment horns, tapped horns, offset-driver junctions, mouth reflection termination, higher-order waveguide modes, and multi-mouth horn array coupling.
- **[Ref #5] Pritchard, R. L. (1960).** *Mutual Acoustic Impedance between Radiators in an Infinite Rigid Plane*. *JASA*, 32(6), 730–737.
  - Exact series and Bessel/Struve integral representations of mutual radiation impedance $Z_{12}(kd)$ between circular pistons, forming the fast analytical oracle and Tier-1 array coupling kernel.
- **[Ref #6] Struve / Rayleigh Piston Radiation — Pierce, A. D. (2019).** *Acoustics: An Introduction to Its Physical Principles and Applications* (3rd ed.). ASA / Springer.
  - Exact self-radiation impedance $Z_{11}(ka) = \rho_0 c S \left[1 - \frac{J_1(2ka)}{ka} + j\frac{H_1(2ka)}{ka}\right]$, Rayleigh surface integral, spherical harmonic expansions, and boundary reflection theory.
- **[Ref #7] Stinson, M. R. (1991).** *The propagation of plane sound waves in narrow and wide circular tubes, and generalization to uniform tubes of arbitrary cross-sectional shape*. *JASA*, 89(2), 550–558.
  - Exact Kirchhoff-Stinson complex thermoviscous density $\tilde{\rho}(\omega)$ and compressibility $\tilde{C}(\omega)$ in narrow ports, slots, compression-driver phase plugs, and horn throats.
- **[Ref #8] Wright, J. R. (1990)** *An Empirical Model for Loudspeaker Motor Impedance*, *JAES*, 38(10), 749–754; **Leach, W. M. (2002)** *Loudspeaker Voice-Coil Inductance Losses*, *JAES*, 50(6), 442–449; **Thorborg, K., & Unruh, A. D. (2008)** *Electrical Equivalent Circuit for Curved Voice-Coil Impedance*, *JAES*, 56(9), 696–709.
  - Lossy eddy-current voice-coil impedance models (fractional-pole Wright/Leach frequency-domain models and realizable L2R2/LR-ladder networks compatible with time-domain ODE integration).
- **[Ref #9] Knudsen, M. H., & Jensen, J. G. (1993) / Ritter, F. et al. (2009).** *Low-Frequency Loudspeaker Assessment by Nearfield Sound-Pressure Measurement* / *Viscoelastic Suspension Creep Modeling*. *JAES*.
  - Logarithmic suspension creep $C_{ms}(\omega)$ accounting for the 5–15% downward shift of effective resonance between sine sweeps and broadband program material.

---

## II. Full-Wave 3D Boundary Element (BEM) & Finite Element (FEM) Acoustics

- **[Ref #10] Burton, A. J., & Miller, G. F. (1971).** *The Application of Integral Equation Methods to the Numerical Solution of Some Exterior Boundary-Value Problems*. *Proceedings of the Royal Society of London A*, 323(1553), 201–210.
  - Combined boundary integral formulation $(\text{CBIE} + \alpha\,\text{HBIE})$ with $\alpha = -j/k$, eliminating spurious irregular interior resonances across all exterior wavenumbers.
- **[Ref #11] Maue, A. W. (1949) & Mitzner, K. M. (1966) / Marburg, S., & Nolte, B. (Eds.) (2008).** *Computational Acoustics of Noise Propagation in Fluids — Finite and Boundary Element Methods*. Springer.
  - Tangential curl regularization of the hypersingular operator $N_k$ into weakly singular $1/R$ surface integrals, pollution-error bounds for P1 vs P2 Helmholtz FEM, and coupled FEM-BEM symmetric/Schur formulations.
- **[Ref #12] Erichsen, S., & Sauter, S. A. (1998).** *Efficient Automatic Quadrature in 3-D Galerkin BEM*. *Computer Methods in Applied Mechanics and Engineering*, 157(3–4), 215–224; **Duffy, M. G. (1982)** *Quadrature over a Pyramid or Cube of Integrands with a Singularity at a Vertex*, *SIAM J. Numer. Anal.*, 19(6).
  - Singularity-canceling Duffy/polar coordinate transformations for coincident, common-edge, and common-vertex boundary element triangle pairs.
- **[Ref #13] Bebendorf, M. (2000) & Bebendorf, M. (2008).** *Approximation of Boundary Element Matrices*, *Numerische Mathematik*, 86, 565–589; *Hierarchical Matrices: A Means to Efficiently Solve Elliptic Boundary Value Problems*, Springer.
  - Hierarchical ($\mathcal{H}$-matrix) octree partitioning and Adaptive Cross Approximation (ACA) reducing dense BEM storage and GMRES matvecs from $O(N^2)$ to $O(N \log N)$.
- **[Ref #14] Antoine, X., & Darbas, M. (2007).** *Generalized Combined Field Integral Equations for the Iterative Solution of the Three-Dimensional Helmholtz Equation*. *M2AN*, 41(1), 147–167.
  - Calderón multiplicative preconditioning for rapid GMRES convergence of high-frequency Burton-Miller BEM systems.
- **[Ref #15] Johnson, D. L., Koplik, J., & Dashen, R. (1987)** *Theory of dynamic permeability and tortuosity in fluid-saturated porous media*, *J. Fluid Mech.*, 176, 379–402; **Champoux, Y., & Allard, J.-F. (1991)** *Dynamic tortuosity and bulk modulus in air-saturated porous media*, *J. Appl. Phys.*, 70(4), 1975–1979; **Miki, Y. (1990)** *Acoustical properties of porous materials*, *J. Acoust. Soc. Jpn. (E)*, 11(1).
  - JCA 5-parameter equivalent-fluid porous absorber physics ($\phi, \sigma, \alpha_\infty, \Lambda, \Lambda'$) and Miki single-parameter causal empirical model for enclosure damping materials.
- **[Ref #16] Berggren, M., Bernland, A., & Noreland, D. (2018).** *Acoustic boundary layers as boundary conditions*. *Journal of Computational Physics*, 371, 633–650.
  - Sub-grid surface impedance boundary condition capturing viscous and thermal Stokes boundary layers in 3D Helmholtz FEM without resolving micron-scale boundary-layer volume meshes.
- **[Ref #17] Labelle, F., & Shewchuk, J. R. (2007).** *Isosurface Stuffing: Fast Tetrahedral Meshes with Good Dihedral Angles*. *ACM Transactions on Graphics (SIGGRAPH)*, 26(3), Article 57.
  - Graded body-centered cubic (BCC) lattice tetrahedralization with guaranteed dihedral angle bounds ($\ge 10.7^\circ$), sliver-free P1/P2 interior cavity meshing, and clean-room pure-Rust suitability.
- **[Ref #18] Jacobson, A., Kavan, L., & Sorkine-Hornung, O. (2013).** *Robust Inside-Outside Segmentation using Generalized Winding Numbers*. *ACM TOG*, 32(4), Article 33.
  - Exact solid-angle inside/outside classification for watertight and near-watertight CAD meshes feeding tetrahedralization and FDTD cut-cells.
- **[Ref #19] Levine, H., & Schwinger, J. (1948).** *On the Radiation of Sound from an Unflanged Circular Pipe*. *Physical Review*, 73(4), 383–406.
  - Exact Wiener-Hopf solution for reflection magnitude $|R(ka)|$ and end-correction $\Delta L / a \to 0.6133$, serving as the canonical analytical benchmark for coupled interior-exterior 3D FEM-BEM.

---

## III. Large-Signal Nonlinearities, Thermal Compression, Aeroacoustics & 3D FDTD

- **[Ref #20] Klippel, W. (2006).** *Tutorial: Loudspeaker Nonlinearities — Causes, Parameters, Symptoms*. *JAES*, 54(10), 907–939; IEC 62458.
  - Large-signal state-space equations for $Bl(x)$, $K_{ms}(x)$, $L_e(x, i)$ reluctance force, dynamic DC offset, harmonic and intermodulation distortion, and Doppler modulation.
- **[Ref #21] Salvatti, A., Devantier, A., & Button, D. (2002).** *Maximizing Performance from Loudspeaker Ports*. *JAES*, 50(1/2), 19–45.
  - High-amplitude oscillatory pipe/port aeroacoustics: Reynolds/Strouhal scaling, vortex shedding, minor-loss quadratic damping, effective area vena-contracta detuning, and flare geometry effects.
- **[Ref #22] Button, D. J. (1992).** *Heat Dissipation and Power Compression in Loudspeakers*. *JAES*, 40(1/2), 32–41; **Chapman, P. J. (2000)** *Thermal Simulation of Loudspeakers*, *AES 104th Convention*.
  - Multi-node electro-thermal lumped networks ($T_{vc}, T_{pole}, T_{mag}$) with velocity-dependent forced air convection across voice-coil gap and port airflow.
- **[Ref #23] Gustavsen, B., & Semlyen, A. (1999).** *Rational Approximation of Frequency Domain Responses by Vector Fitting*. *IEEE Transactions on Power Delivery*, 14(3), 1052–1061.
  - Passivity-enforced rational pole-residue macromodeling of arbitrary frequency-domain 3D FEM-BEM multi-port radiation/enclosure impedances $\mathbf{Z}_{3D}(j\omega) \to \mathbf{Z}_{3D}(s)$ for exact-memory time-domain nonlinear DAE integration.
- **[Ref #24] Kowalczyk, K., & van Walstijn, M. (2011).** *Room Acoustics Simulation Using 3-D Compact Explicit FDTD Schemes*. *IEEE Transactions on Audio, Speech, and Language Processing*, 19(1), 34–46.
  - 27-point Interpolated Wideband (IWB) compact 3D FDTD stencil achieving $< 0.2\%$ isotropic numerical dispersion, ideal for WebGPU compute-shader execution.
- **[Ref #25] Bilbao, S. (2013) & Hamilton, B., & Bilbao, S. (2017).** *Modeling of Complex Geometries and Boundary Conditions in Finite Difference/Finite Volume Time Domain Room Acoustics*. *IEEE/ACM TASLP*.
  - Passivity-guaranteed conservative finite-volume cut-cell boundary conditions on arbitrary 3D triangulated CAD surfaces coupled with digital impedance wall filters.
- **[Ref #26] Roden, J. A., & Gedney, S. D. (2000).** *Convolutional PML (CPML): An Efficient FDTD Implementation of the CFS-PML for Arbitrary Media*. *Microwave and Optical Technology Letters*, 27(5), 334–339.
  - Unsplit Complex-Frequency-Shifted Convolutional Perfectly Matched Layer for reflection-free open-space truncation at grazing and evanescent low frequencies in 3D FDTD.

---

## IV. Measurement Processing, System Identification, Standards & Environmental Physics

- **[Ref #27] Farina, A. (2000).** *Simultaneous Measurement of Impulse Response and Distortion with a Swept-Sine Technique*. *AES 108th Convention*, Preprint 5093.
  - Exponential sine-sweep deconvolution separating linear impulse response $h_1(t)$ and individual harmonic impulse responses $h_2(t), h_3(t), \dots$ along negative time offsets.
- **[Ref #28] Keele, D. B. (1974).** *Low-Frequency Loudspeaker Assessment by Nearfield Sound-Pressure Measurement*. *JAES*, 22(3), 154–162; **Struck, C. J., & Temkin, S. F. (1994)** *Simulated Free Field Measurements*, *JAES*, 42(6), 467–482.
  - Near-field cone/port area-weighted complex summation, baffle diffraction step compensation, and time-windowed quasi-anechoic splicing.
- **[Ref #29] Cramer, O. (1993)** *The variation of the specific heat ratio and the speed of sound in air with temperature, pressure, humidity, and $\text{CO}_2$ concentration*, *JASA*, 93(5), 2510–2516; **ISO 9613-1:1993** *Attenuation of sound during propagation outdoors*.
  - Precision thermophysical properties of moist air ($\rho_0, c, \mu, \kappa, \gamma, C_p$) and atmospheric absorption $\alpha_{atm}(f, T, P, RH)$ for outdoor PA stacks and calibration temperature drift normalization.
- **[Ref #30] Nocedal, J., & Wright, S. J. (2006)** *Numerical Optimization* (2nd ed.), Springer; **Tarantola, A. (2005)** *Inverse Problem Theory and Methods for Model Parameter Estimation*, SIAM.
  - Trust-region Levenberg-Marquardt with bound constraints, Maximum A Posteriori (MAP) Bayesian Gaussian inverse theory, Posterior Laplace covariance $\boldsymbol{\Sigma}_{post}$, and Jacobian SVD identifiability analysis.
- **[Ref #31] ANSI/CTA-2034-A (R-2020).** *Standard Method of Measurement for In-Home Loudspeakers*. Consumer Technology Association.
  - Standardized 70-point 3D spherical polar balloon weighting, On-Axis, Listening Window, Early Reflections, Sound Power, Directivity Index (DI), and Early Reflections DI (ERDI) definitions.
- **[Ref #32] Olson, H. F. (1973)** *Gradient Loudspeakers*, *JAES*, 21(2), 86–93; ** Hill, A. J., & Hawksford, M. O. J. (2010–2020)** *Wide-area low-frequency sound-field control & subwoofer array synthesis*, *JAES*.
  - Cardioid, end-fire, front-back-front, and electronically steered broadside/arc subwoofer array radiation synthesis and mutual-coupling power analysis.
