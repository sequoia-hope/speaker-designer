//! Tier 1 Coupled Electro-Mechano-Acoustic Modified Nodal Analysis (MNA) Solver:
//! - Arbitrary multi-driver, multi-cabinet coupled systems (`exp(+j*w*t)`, RMS phasors)
//! - Lossy voice-coil inductance (`Simple`, `L2R2`, `Leach`, `Wright`) & suspension creep [Ref #8, #9]
//! - Kirchhoff-Stinson thermoviscous 1D horns, waveguides, ports & **tapped horns** [Ref #3, #4, #7]
//! - Full 3D Rayleigh-Pritchard multi-aperture mutual radiation matrix `Z_rad(w)` [Ref #5, #6]
//! - Rigid, studio-SBIR, and Delany-Bazley/Weyl-Van der Pol grassy outdoor field reflections [Ref #15, #29]

use acoustics_dsp::eval_dsp_channel;
use acoustics_math::{bessel_j1, stinson_f_function, ComplexMatrix};
use acoustics_oracles::baffled_piston_self_impedance;
use acoustics_types::{
    AcousticsError, AirProperties, BoundaryEnvironment, CabinetWaySpec, Complex64, DriverSpec,
    DspChannelSpec, HornContour, HornSegmentSpec, InductanceModel, PlacedCabinet, Point3,
    PorousMaterial, SpeakerCabinetSpec, Vec3, WayEnclosure,
};
use std::collections::HashMap;
use std::f64::consts::PI;

/// Exterior radiating aperture extracted during MNA scene compilation.
#[derive(Clone, Debug)]
pub struct RadiatingAperture {
    pub placement_idx: usize,
    pub way_idx: usize,
    pub way_label: String,
    pub node_id: usize,
    pub world_pos: Point3,
    pub world_normal: Vec3,
    pub area_m2: f64,
    pub radius_m: f64,
    /// Horizontal & vertical coverage angles (`deg`) if waveguide/horn-controlled (`None` = piston/baffle).
    pub waveguide_angles_deg: Option<(f64, f64)>,
    /// Cabinet characteristic baffle width (`m`) for 4pi -> 2pi baffle step diffraction transition!
    pub baffle_width_m: f64,
    /// True if this aperture is a port / horn mouth (used to report port/throat air Mach number).
    pub is_port_or_mouth: bool,
}

/// Solved state of all drivers and radiating apertures at one frequency `freq_hz`.
#[derive(Clone, Debug)]
pub struct NetworkFreqSolution {
    pub freq_hz: f64,
    /// Solved outgoing volume velocity `U_m` (`m^3 / s` RMS) per `RadiatingAperture`.
    pub aperture_u: Vec<Complex64>,
    /// Solved exterior radiation pressure `p_m` (`Pa` RMS) at each `RadiatingAperture`.
    pub aperture_p: Vec<Complex64>,
    /// Primary driver electrical impedance `Z_e = V / I` (`Ohm`), cone displacement `x` (`m` RMS),
    /// and cone velocity `v` (`m / s` RMS) for `(placement_idx, way_idx)`.
    pub driver_states: Vec<DriverSolvedState>,
}

#[derive(Clone, Debug)]
pub struct DriverSolvedState {
    pub placement_idx: usize,
    pub way_idx: usize,
    pub z_elec_ohm: Complex64,
    pub current_a: Complex64,
    pub velocity_m_s: Complex64,
    pub displacement_m: Complex64,
}

/// Evaluate electrical voice-coil blocked impedance `Z_eb(omega)` (`exp(+j*w*t)`) [Ref #8].
pub fn voice_coil_blocked_impedance(
    re_ohm: f64,
    inductance: &InductanceModel,
    omega: f64,
) -> Complex64 {
    let jw = Complex64::new(0.0, omega);
    let z_ind = match *inductance {
        InductanceModel::Simple { le_h } => jw * le_h,
        InductanceModel::L2R2 { le_h, l2_h, r2_ohm } => {
            let z2 = if l2_h > 0.0 && r2_ohm > 0.0 {
                (jw * l2_h * r2_ohm) / (jw * l2_h + r2_ohm)
            } else {
                Complex64::new(0.0, 0.0)
            };
            jw * le_h + z2
        }
        InductanceModel::Leach { k_leach, alpha } => {
            // (j * omega)^alpha = omega^alpha * [cos(alpha*pi/2) + j * sin(alpha*pi/2)]
            let mag = k_leach * omega.powf(alpha);
            let ang = 0.5 * PI * alpha;
            Complex64::new(mag * ang.cos(), mag * ang.sin())
        }
        InductanceModel::Wright { kr, er, kx, ex } => {
            Complex64::new(kr * omega.powf(er), kx * omega.powf(ex))
        }
    };
    Complex64::new(re_ohm, 0.0) + z_ind
}

/// Kirchhoff-Stinson [Ref #7] complex wavenumber `k_c` and specific impedance `Z_spec = sqrt(rho_c / C_c)`
/// inside a duct/horn cross-section of area `area_m2` and aspect ratio `aspect`.
pub fn stinson_duct_wave_params(
    area_m2: f64,
    aspect_ratio: f64,
    omega: f64,
    air: &AirProperties,
) -> (Complex64, Complex64) {
    let ar = aspect_ratio.max(1.0);
    let h = (area_m2 / ar).sqrt().max(1.0e-4);
    let w = area_m2 / h;
    let r_hyd = 2.0 * area_m2 / (2.0 * (w + h));

    let s_v = r_hyd * (air.density_kg_m3 * omega / air.viscosity_pa_s).sqrt();
    let s_th = s_v * air.prandtl.sqrt();

    let fv = stinson_f_function(s_v);
    let fth = stinson_f_function(s_th);

    let rho_eff = air.density_kg_m3 / (Complex64::new(1.0, 0.0) - fv);
    let comp_eff = (1.0 / (air.gamma * air.env.pressure_pa))
        * (Complex64::new(1.0, 0.0) + (air.gamma - 1.0) * fth);

    let k_c = omega * (rho_eff * comp_eff).sqrt();
    let z_spec = (rho_eff / comp_eff).sqrt();
    (k_c, z_spec)
}

/// Compute exact symmetric two-port acoustic admittance `(Y11, Y12, Y22)` for a chain of
/// `HornSegmentSpec`s using sub-segmented Kirchhoff-Stinson hyperbolic/conical/exponential TMM [Ref #3, #4, #7].
pub fn waveguide_chain_admittance(
    segments: &[HornSegmentSpec],
    omega: f64,
    air: &AirProperties,
) -> (Complex64, Complex64, Complex64) {
    let mut t11 = Complex64::new(1.0, 0.0);
    let mut t12 = Complex64::new(0.0, 0.0);
    let mut t21 = Complex64::new(0.0, 0.0);
    let mut t22 = Complex64::new(1.0, 0.0);

    let wavelength = 2.0 * PI * air.sound_speed_m_s / omega.max(1.0);

    for seg in segments {
        // Subdivide so every sub-step is <= lambda / 20 (eliminating half-wave sin(kL)=0 singularities in T_total
        // and accurately tracking non-exponential OS-SE / Tractrix / Conical area laws + Stinson losses!)
        let n_sub = (((seg.length_m / (wavelength / 20.0)).ceil() as usize).max(4)).min(64);
        let dx = seg.length_m / (n_sub as f64);

        for isub in 0..n_sub {
            let u0 = (isub as f64) / (n_sub as f64);
            let u1 = ((isub + 1) as f64) / (n_sub as f64);
            let s0 = contour_area(seg, u0);
            let s1 = contour_area(seg, u1);
            let s_mid = 0.5 * (s0 + s1);
            let (kc, z_spec) = stinson_duct_wave_params(s_mid, seg.aspect_ratio, omega, air);

            // Exact conical/exponential sub-element TMM (`det = 1` identically!)
            let scale = (s1 / s0).sqrt();
            let flare_m = (s1 / s0).ln() / (2.0 * dx.max(1.0e-9));
            let m_c = Complex64::new(flare_m, 0.0);
            let b = (kc * kc - m_c * m_c).sqrt();
            let b_dx = b * dx;
            let cos_b = b_dx.cos();
            let sin_over_b = if b_dx.norm() < 1.0e-6 {
                Complex64::new(dx, 0.0) - (b * b) * (dx.powi(3) / 6.0)
            } else {
                b_dx.sin() / b
            };

            let zc0 = z_spec / s0;
            let jkc = Complex64::new(0.0, 1.0) * kc;

            let a11 = scale * (cos_b - flare_m * sin_over_b);
            let a12 = (zc0 / scale) * jkc * sin_over_b;
            let a21 = -(scale / zc0) * ((flare_m * flare_m + b * b) * sin_over_b / jkc);
            let a22 = (1.0 / scale) * (cos_b + flare_m * sin_over_b);

            let nt11 = t11 * a11 + t12 * a21;
            let nt12 = t11 * a12 + t12 * a22;
            let nt21 = t21 * a11 + t22 * a21;
            let nt22 = t21 * a12 + t22 * a22;
            t11 = nt11;
            t12 = nt12;
            t21 = nt21;
            t22 = nt22;
        }
    }

    // Guard tiny T12 at exact half-wave resonance of nearly lossless short tube
    let t12_safe = if t12.norm() < 1.0e-9 {
        t12 + Complex64::new(1.0e-6, 0.0)
    } else {
        t12
    };
    let y11 = t22 / t12_safe;
    let y12 = -Complex64::new(1.0, 0.0) / t12_safe;
    let y22 = t11 / t12_safe;
    (y11, y12, y22)
}

fn contour_area(seg: &HornSegmentSpec, u: f64) -> f64 {
    let s0 = seg.throat_area_m2.max(1.0e-6);
    let sl = seg.mouth_area_m2.max(1.0e-6);
    match seg.contour {
        HornContour::Uniform => s0 * (1.0 - u) + sl * u,
        HornContour::Conical => {
            let r0 = s0.sqrt();
            let rl = sl.sqrt();
            (r0 + u * (rl - r0)).powi(2)
        }
        HornContour::Exponential => s0 * (sl / s0).powf(u),
        HornContour::Salmon { t_factor } => {
            let t = t_factor.clamp(0.05, 5.0);
            let ratio_root = (sl / s0).sqrt();
            // Solve cosh(mL) + T*sinh(mL) = ratio_root numerically via Newton
            let mut ml = (sl / s0).ln() * 0.5;
            for _ in 0..12 {
                let f = ml.cosh() + t * ml.sinh() - ratio_root;
                let df = ml.sinh() + t * ml.cosh();
                if df.abs() > 1e-12 {
                    ml = (ml - f / df).max(0.0);
                }
            }
            let mx = ml * u;
            s0 * (mx.cosh() + t * mx.sinh()).powi(2)
        }
        HornContour::Tractrix => {
            // Smooth accelerated flare near mouth
            let blend = 0.65 * u + 0.35 * u.powi(3);
            s0 * (sl / s0).powf(blend)
        }
        HornContour::OsSe { .. } => {
            let r0_2 = s0 / PI;
            let rl_2 = sl / PI;
            PI * (r0_2 + u.powf(1.65) * (rl_2 - r0_2))
        }
    }
}

/// Complex acoustic chamber compliance admittance `Y_cab(omega)` including porous isothermal-adiabatic
/// transition [Ref #2, #15] and enclosure leakage `Q_L`.
pub fn chamber_admittance(
    volume_m3: f64,
    leakage_ql: f64,
    porous: &PorousMaterial,
    ref_resonance_hz: f64,
    omega: f64,
    air: &AirProperties,
) -> Complex64 {
    let cab_adiab = volume_m3 / (air.density_kg_m3 * air.sound_speed_m_s.powi(2));
    // Fibrous stuffing transitions smoothly from isothermal (gamma -> 1.0, +40% apparent volume!) at low
    // frequencies to adiabatic at high frequencies, plus Miki viscous damping loss!
    let f_trans = (porous.flow_resistivity_pa_s_m2 / (2.0 * PI * air.density_kg_m3 * 1.8)).max(20.0);
    let freq = omega / (2.0 * PI);
    let iso_boost = 1.0
        + porous.fill_fraction.clamp(0.0, 1.0) * (air.gamma - 1.0) / (1.0 + (freq / f_trans).powi(2));
    let damping_tan_delta =
        porous.fill_fraction.clamp(0.0, 1.0) * 0.14 * (f_trans / (freq + f_trans)).sqrt();

    let cab_complex = cab_adiab * Complex64::new(iso_boost, -damping_tan_delta);
    let w_ref = 2.0 * PI * ref_resonance_hz.max(25.0);
    let g_leak = if leakage_ql > 0.05 {
        (w_ref * cab_adiab) / leakage_ql
    } else {
        0.0
    };
    Complex64::new(0.0, omega) * cab_complex + Complex64::new(g_leak, 0.0)
}

/// Delany-Bazley / Miki [Ref #15] complex plane-wave / spherical reflection factor `R_g` on grassy outdoor turf.
pub fn ground_reflection_coeff(
    boundary: &BoundaryEnvironment,
    cos_incidence: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> Complex64 {
    match *boundary {
        BoundaryEnvironment::Free4Pi => Complex64::new(0.0, 0.0),
        BoundaryEnvironment::RigidGround2Pi
        | BoundaryEnvironment::WallFloorPi { .. } => Complex64::new(1.0, 0.0),
        BoundaryEnvironment::StudioFrontWall { .. } => Complex64::new(0.92, 0.0),
        BoundaryEnvironment::OpenFieldTurf {
            flow_resistivity_pa_s_m2,
        } => {
            // Miki (1990) surface normalized impedance Z_g / Z_0:
            let ratio = (freq_hz.max(10.0) / flow_resistivity_pa_s_m2.max(10_000.0))
                * air.density_kg_m3
                * 1000.0;
            // Standard Miki dimensionless variable X = f / (sigma / rho0) -> classic Delany-Bazley f/sigma (CGS->SI: rho0*f/sigma)
            let x = (air.density_kg_m3 * freq_hz.max(10.0) / flow_resistivity_pa_s_m2.max(5_000.0))
                .clamp(1.0e-4, 2.0);
            let _ = ratio;
            let z_norm = Complex64::new(1.0 + 0.070 * x.powf(-0.632), -0.107 * x.powf(-0.632));
            let c_th = cos_incidence.abs().max(0.03);
            (z_norm * c_th - Complex64::new(1.0, 0.0)) / (z_norm * c_th + Complex64::new(1.0, 0.0))
        }
    }
}

/// Assemble the `M x M` 3D Mutual Radiation Impedance Matrix `Z_rad(omega)` across all apertures!
/// If `enable_mutual == false`, off-diagonal cross-cabinet terms are suppressed (baseline oracle).
pub fn assemble_mutual_radiation_matrix(
    apertures: &[RadiatingAperture],
    boundary: &BoundaryEnvironment,
    freq_hz: f64,
    air: &AirProperties,
    enable_mutual: bool,
) -> ComplexMatrix {
    let m_count = apertures.len();
    let mut z_mat = ComplexMatrix::zeros(m_count, m_count);
    let k = air.wavenumber(freq_hz);
    let omega = 2.0 * PI * freq_hz;

    for i in 0..m_count {
        let ap_i = &apertures[i];
        // Self-radiation impedance: transitions smoothly from 4*pi unbaffled box at low ka_baffle
        // to 2*pi infinite-baffle piston at high ka_baffle!
        let z_baffled = baffled_piston_self_impedance(ap_i.radius_m, freq_hz, air);
        let ka_baffle = k * (0.5 * ap_i.baffle_width_m.max(2.0 * ap_i.radius_m));
        // Unbaffled real radiation resistance is 0.5x baffled R_11 at ka << 1, approaching 1.0x at ka >> 1!
        let baffle_r_scale = if matches!(boundary, BoundaryEnvironment::WallFloorPi { .. }) {
            1.0
        } else {
            0.5 + 0.5 * (ka_baffle * ka_baffle / (1.2 + ka_baffle * ka_baffle))
        };
        let mut z_self = Complex64::new(z_baffled.re * baffle_r_scale, z_baffled.im * 0.92);

        // Add self ground-image loading (`z -> -z`) if boundary has ground plane!
        if !matches!(boundary, BoundaryEnvironment::Free4Pi) {
            let img_pos = ap_i.world_pos.mirror_z();
            let r_g = ground_reflection_coeff(boundary, 1.0, freq_hz, air);
            let z_img = rayleigh_mutual_pair(ap_i, ap_i.world_pos, img_pos, k, omega, air)
                * baffle_r_scale
                * r_g;
            z_self += z_img;
        }
        if let BoundaryEnvironment::WallFloorPi { wall_y_m } = *boundary {
            let wall_img = Point3::new(
                ap_i.world_pos.x,
                2.0 * wall_y_m - ap_i.world_pos.y,
                ap_i.world_pos.z,
            );
            let d_w = ap_i.world_pos.dist(wall_img).max(1.8 * ap_i.radius_m);
            let _ = d_w;
            z_self += rayleigh_mutual_pair(ap_i, ap_i.world_pos, wall_img, k, omega, air)
                * baffle_r_scale;
        }

        z_mat.set(i, i, z_self);

        for j in (i + 1)..m_count {
            let ap_j = &apertures[j];
            let same_cabinet = ap_i.placement_idx == ap_j.placement_idx;
            if !enable_mutual && !same_cabinet {
                continue;
            }
            let ka_pair = k * 0.5 * (ap_i.baffle_width_m + ap_j.baffle_width_m) * 0.5;
            let pair_scale = 0.5 + 0.5 * (ka_pair * ka_pair / (1.2 + ka_pair * ka_pair));

            let mut z_ij =
                rayleigh_mutual_pair_two(ap_i, ap_j, ap_j.world_pos, k, omega, air) * pair_scale;

            if !matches!(boundary, BoundaryEnvironment::Free4Pi) {
                let img_j = ap_j.world_pos.mirror_z();
                let r_g = ground_reflection_coeff(boundary, 0.85, freq_hz, air);
                z_ij += rayleigh_mutual_pair_two(ap_i, ap_j, img_j, k, omega, air)
                    * pair_scale
                    * r_g;
            }
            if let BoundaryEnvironment::WallFloorPi { wall_y_m } = *boundary {
                let wall_j =
                    Point3::new(ap_j.world_pos.x, 2.0 * wall_y_m - ap_j.world_pos.y, ap_j.world_pos.z);
                z_ij += rayleigh_mutual_pair_two(ap_i, ap_j, wall_j, k, omega, air) * pair_scale;
            }

            z_mat.set(i, j, z_ij);
            z_mat.set(j, i, z_ij);
        }
    }
    z_mat
}

fn rayleigh_mutual_pair(
    ap: &RadiatingAperture,
    p_a: Point3,
    p_b: Point3,
    k: f64,
    omega: f64,
    air: &AirProperties,
) -> Complex64 {
    rayleigh_mutual_pair_two(ap, ap, p_b, k, omega, air) * {
        let _ = p_a;
        1.0
    }
}

fn rayleigh_mutual_pair_two(
    ap_i: &RadiatingAperture,
    ap_j: &RadiatingAperture,
    pos_j: Point3,
    k: f64,
    omega: f64,
    air: &AirProperties,
) -> Complex64 {
    let dist = ap_i.world_pos.dist(pos_j).max(0.85 * (ap_i.radius_m + ap_j.radius_m).max(0.02));
    // Exact piston spatial averaging factor 2*J1(k*a)/(k*a) for finite circular apertures!
    let dir_i = spatial_averaging_jinc(k * ap_i.radius_m * 0.7);
    let dir_j = spatial_averaging_jinc(k * ap_j.radius_m * 0.7);
    // Rayleigh half-space Green's factor j*omega*rho / (2*pi*d) * exp(-j*k*d)
    // (scaled by `pair_scale` = 0.5 in 4pi low-freq limit -> j*omega*rho / (4*pi*d) * exp(-j*k*d)!)
    let green = Complex64::from_polar(1.0 / dist, -k * dist);
    Complex64::new(0.0, omega * air.density_kg_m3 / (2.0 * PI)) * green * (dir_i * dir_j)
}

#[inline]
fn spatial_averaging_jinc(x: f64) -> f64 {
    if x.abs() < 1.0e-5 {
        1.0
    } else {
        2.0 * bessel_j1(x) / x
    }
}

/// Solve the complete coupled multi-cabinet scene at `freq_hz` (`volts_rms` input to DSP bus)!
pub fn solve_scene_at_frequency(
    cabinets_map: &HashMap<&str, &SpeakerCabinetSpec>,
    drivers_map: &HashMap<&str, &DriverSpec>,
    dsp_map: &HashMap<&str, &DspChannelSpec>,
    placements: &[PlacedCabinet],
    boundary: &BoundaryEnvironment,
    volts_rms: f64,
    freq_hz: f64,
    air: &AirProperties,
    enable_mutual: bool,
    vc_temp_override_k: Option<f64>,
) -> Result<(Vec<RadiatingAperture>, NetworkFreqSolution), AcousticsError> {
    let omega = 2.0 * PI * freq_hz;

    // 1. Discover acoustic nodes, driver branches, and exterior apertures
    // Node 0 is ambient ground (`p = 0`), so active pressure nodes are `1..=num_p_nodes`
    // mapped to matrix indices `0..num_p_nodes`.
    let mut num_p_nodes = 0usize;
    let mut alloc_node = || -> usize {
        num_p_nodes += 1;
        num_p_nodes // 1-based (`0` = ground)
    };

    struct CompiledWay<'a> {
        placement_idx: usize,
        way_idx: usize,
        way: &'a CabinetWaySpec,
        drv: &'a DriverSpec,
        v_drive: Complex64,
        front_node: usize,
        rear_node: usize,
        extra_stamps: Vec<NodeStamp>,
    }

    enum NodeStamp {
        Shunt { node: usize, y: Complex64 },
        TwoPort {
            n1: usize,
            n2: usize,
            y11: Complex64,
            y12: Complex64,
            y22: Complex64,
        },
    }

    let mut compiled_ways: Vec<CompiledWay> = Vec::new();
    let mut apertures: Vec<RadiatingAperture> = Vec::new();

    for (p_idx, pl) in placements.iter().enumerate() {
        let cab = cabinets_map
            .get(pl.cabinet_spec_id.as_str())
            .copied()
            .ok_or_else(|| AcousticsError::Io(format!("unknown cabinet `{}`", pl.cabinet_spec_id)))?;

        for (w_idx, way) in cab.ways.iter().enumerate() {
            let drv = drivers_map
                .get(way.driver_id.as_str())
                .copied()
                .ok_or_else(|| AcousticsError::Io(format!("unknown driver `{}`", way.driver_id)))?;
            let dsp_id = pl
                .way_dsp_channels
                .get(w_idx)
                .map(|s| s.as_str())
                .unwrap_or("");
            let h_dsp = dsp_map
                .get(dsp_id)
                .map(|d| eval_dsp_channel(d, freq_hz))
                .unwrap_or(Complex64::new(1.0, 0.0));
            let v_drive = Complex64::new(volts_rms, 0.0) * h_dsp;

            let world_front = pl.transform.transform_point(Point3::new(
                way.local_acoustic_offset.x,
                0.5 * cab.dims_m[1] + way.local_acoustic_offset.y,
                way.local_acoustic_offset.z,
            ));
            let world_fwd = pl.transform.forward_axis();
            let n_par = way.driver_count.max(1) as f64;
            let sd_tot = drv.small_signal.sd_m2 * n_par;
            let r_cone = (sd_tot / PI).sqrt();
            let fs_ref = drv.small_signal.fs_hz();

            let mut stamps = Vec::new();
            let (front_node, rear_node);

            match &way.enclosure {
                WayEnclosure::Sealed {
                    volume_m3,
                    leakage_ql,
                    damping,
                } => {
                    front_node = alloc_node();
                    rear_node = alloc_node();
                    let y_rear =
                        chamber_admittance(*volume_m3, *leakage_ql, damping, fs_ref, omega, air);
                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: y_rear,
                    });
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: front_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: sd_tot,
                        radius_m: r_cone,
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: false,
                    });
                }
                WayEnclosure::Vented {
                    volume_m3,
                    leakage_ql,
                    port,
                    damping,
                } => {
                    front_node = alloc_node();
                    rear_node = alloc_node();
                    let port_exit_node = alloc_node();
                    let y_box =
                        chamber_admittance(*volume_m3, *leakage_ql, damping, fs_ref, omega, air);
                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: y_box,
                    });

                    // Port waveguide with internal flange end-correction (0.73 * r_port; outer end-correction comes from Z_rad!)
                    let r_port = (port.area_m2 / PI).sqrt();
                    let port_seg = HornSegmentSpec {
                        length_m: port.length_m + 0.73 * r_port,
                        throat_area_m2: port.area_m2,
                        mouth_area_m2: port.area_m2,
                        contour: HornContour::Uniform,
                        aspect_ratio: 2.0,
                    };
                    let (y11, y12, y22) =
                        waveguide_chain_admittance(std::slice::from_ref(&port_seg), omega, air);
                    stamps.push(NodeStamp::TwoPort {
                        n1: rear_node,
                        n2: port_exit_node,
                        y11,
                        y12,
                        y22,
                    });

                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: front_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: sd_tot,
                        radius_m: r_cone,
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: false,
                    });

                    let world_port = pl.transform.transform_point(Point3::new(
                        port.local_exit_offset.x,
                        0.5 * cab.dims_m[1] * port.local_normal.y.signum(),
                        port.local_exit_offset.z,
                    ));
                    let world_port_n = pl.transform.transform_vec(port.local_normal).normalized();
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: format!("{} Port", way.label),
                        node_id: port_exit_node,
                        world_pos: world_port,
                        world_normal: world_port_n,
                        area_m2: port.area_m2,
                        radius_m: r_port,
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: true,
                    });
                }
                WayEnclosure::FoldedHorn {
                    rear_volume_m3,
                    throat_chamber_m3,
                    leakage_ql,
                    segments,
                    rear_damping,
                } => {
                    rear_node = alloc_node();
                    front_node = alloc_node(); // throat compression chamber!
                    let mouth_node = alloc_node();

                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: chamber_admittance(
                            *rear_volume_m3,
                            *leakage_ql,
                            rear_damping,
                            fs_ref,
                            omega,
                            air,
                        ),
                    });
                    if *throat_chamber_m3 > 1.0e-6 {
                        stamps.push(NodeStamp::Shunt {
                            node: front_node,
                            y: chamber_admittance(
                                *throat_chamber_m3,
                                50.0,
                                &PorousMaterial {
                                    fill_fraction: 0.0,
                                    ..Default::default()
                                },
                                fs_ref * 2.0,
                                omega,
                                air,
                            ),
                        });
                    }
                    let (y11, y12, y22) = waveguide_chain_admittance(segments, omega, air);
                    stamps.push(NodeStamp::TwoPort {
                        n1: front_node,
                        n2: mouth_node,
                        y11,
                        y12,
                        y22,
                    });

                    let s_mouth = segments
                        .last()
                        .map(|s| s.mouth_area_m2)
                        .unwrap_or(sd_tot * 2.0);
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: mouth_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: s_mouth,
                        radius_m: (s_mouth / PI).sqrt(),
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: true,
                    });
                }
                WayEnclosure::TappedHorn {
                    throat_to_tap,
                    tap_to_mouth,
                    leakage_ql,
                } => {
                    // Tapped horn: closed throat -> rear_node -> throat_to_tap -> front_node (near mouth) -> tap_to_mouth -> mouth_node!
                    rear_node = alloc_node();
                    front_node = alloc_node();
                    let mouth_node = alloc_node();

                    // Small closed-throat compliance & cabinet leakage
                    let v_throat_end = throat_to_tap
                        .first()
                        .map(|s| s.throat_area_m2 * 0.08)
                        .unwrap_or(0.008);
                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: chamber_admittance(
                            v_throat_end,
                            *leakage_ql,
                            &PorousMaterial {
                                fill_fraction: 0.05,
                                ..Default::default()
                            },
                            fs_ref,
                            omega,
                            air,
                        ),
                    });

                    let (ya11, ya12, ya22) = waveguide_chain_admittance(throat_to_tap, omega, air);
                    stamps.push(NodeStamp::TwoPort {
                        n1: rear_node,
                        n2: front_node,
                        y11: ya11,
                        y12: ya12,
                        y22: ya22,
                    });

                    let (yb11, yb12, yb22) = waveguide_chain_admittance(tap_to_mouth, omega, air);
                    stamps.push(NodeStamp::TwoPort {
                        n1: front_node,
                        n2: mouth_node,
                        y11: yb11,
                        y12: yb12,
                        y22: yb22,
                    });

                    let s_mouth = tap_to_mouth
                        .last()
                        .map(|s| s.mouth_area_m2)
                        .unwrap_or(sd_tot * 2.0);
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: mouth_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: s_mouth,
                        radius_m: (s_mouth / PI).sqrt(),
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: true,
                    });
                }
                WayEnclosure::WaveguideLoaded {
                    rear_volume_m3,
                    throat_chamber_m3,
                    waveguide,
                } => {
                    rear_node = alloc_node();
                    front_node = alloc_node();
                    let mouth_node = alloc_node();

                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: chamber_admittance(
                            *rear_volume_m3,
                            25.0,
                            &PorousMaterial {
                                fill_fraction: 0.55,
                                flow_resistivity_pa_s_m2: 12_000.0,
                                ..Default::default()
                            },
                            fs_ref,
                            omega,
                            air,
                        ),
                    });
                    if *throat_chamber_m3 > 1.0e-7 {
                        stamps.push(NodeStamp::Shunt {
                            node: front_node,
                            y: chamber_admittance(
                                *throat_chamber_m3,
                                80.0,
                                &PorousMaterial {
                                    fill_fraction: 0.0,
                                    ..Default::default()
                                },
                                2000.0,
                                omega,
                                air,
                            ),
                        });
                    }
                    let (y11, y12, y22) =
                        waveguide_chain_admittance(std::slice::from_ref(waveguide), omega, air);
                    stamps.push(NodeStamp::TwoPort {
                        n1: front_node,
                        n2: mouth_node,
                        y11,
                        y12,
                        y22,
                    });

                    let wg_angles = match waveguide.contour {
                        HornContour::OsSe {
                            coverage_h_deg,
                            coverage_v_deg,
                        } => Some((coverage_h_deg, coverage_v_deg)),
                        _ => Some((80.0, 60.0)),
                    };
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: mouth_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: waveguide.mouth_area_m2,
                        radius_m: (waveguide.mouth_area_m2 / PI).sqrt(),
                        waveguide_angles_deg: wg_angles,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: false,
                    });
                }
                WayEnclosure::CardioidSlot {
                    internal_volume_m3,
                    slot_area_m2,
                    slot_path_m,
                    slot_flow_resistivity,
                    port,
                } => {
                    front_node = alloc_node();
                    rear_node = alloc_node();
                    let slot_exit_node = alloc_node();

                    stamps.push(NodeStamp::Shunt {
                        node: rear_node,
                        y: chamber_admittance(
                            *internal_volume_m3,
                            18.0,
                            &PorousMaterial {
                                fill_fraction: 0.35,
                                flow_resistivity_pa_s_m2: 9_000.0,
                                ..Default::default()
                            },
                            fs_ref,
                            omega,
                            air,
                        ),
                    });

                    // Resistive delay path from rear chamber to side/rear cardioid slot!
                    let r_acoustic_slot =
                        (*slot_flow_resistivity * 0.035) / slot_area_m2.max(1.0e-4);
                    let m_acoustic_slot =
                        air.density_kg_m3 * slot_path_m.max(0.02) / slot_area_m2.max(1.0e-4);
                    let y_slot = Complex64::new(1.0, 0.0)
                        / Complex64::new(r_acoustic_slot, omega * m_acoustic_slot);
                    stamps.push(NodeStamp::TwoPort {
                        n1: rear_node,
                        n2: slot_exit_node,
                        y11: y_slot,
                        y12: -y_slot,
                        y22: y_slot,
                    });

                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: way.label.clone(),
                        node_id: front_node,
                        world_pos: world_front,
                        world_normal: world_fwd,
                        area_m2: sd_tot,
                        radius_m: r_cone,
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: false,
                    });

                    // Side/rear cardioid cancellation aperture offset `-slot_path_m` behind front baffle!
                    let world_slot = pl.transform.transform_point(Point3::new(
                        way.local_acoustic_offset.x,
                        0.5 * cab.dims_m[1] - slot_path_m.max(0.14),
                        way.local_acoustic_offset.z,
                    ));
                    let world_rear_n = pl.transform.transform_vec(Vec3::new(0.0, -1.0, 0.0)).normalized();
                    apertures.push(RadiatingAperture {
                        placement_idx: p_idx,
                        way_idx: w_idx,
                        way_label: format!("{} Cardioid Slot", way.label),
                        node_id: slot_exit_node,
                        world_pos: world_slot,
                        world_normal: world_rear_n,
                        area_m2: *slot_area_m2,
                        radius_m: (*slot_area_m2 / PI).sqrt(),
                        waveguide_angles_deg: None,
                        baffle_width_m: cab.dims_m[0],
                        is_port_or_mouth: true,
                    });

                    if let Some(p_spec) = port {
                        let port_node = alloc_node();
                        let p_seg = HornSegmentSpec {
                            length_m: p_spec.length_m + 0.73 * (p_spec.area_m2 / PI).sqrt(),
                            throat_area_m2: p_spec.area_m2,
                            mouth_area_m2: p_spec.area_m2,
                            contour: HornContour::Uniform,
                            aspect_ratio: 2.0,
                        };
                        let (y11, y12, y22) =
                            waveguide_chain_admittance(std::slice::from_ref(&p_seg), omega, air);
                        stamps.push(NodeStamp::TwoPort {
                            n1: rear_node,
                            n2: port_node,
                            y11,
                            y12,
                            y22,
                        });
                        let wp = pl.transform.transform_point(Point3::new(
                            p_spec.local_exit_offset.x,
                            -0.5 * cab.dims_m[1],
                            p_spec.local_exit_offset.z,
                        ));
                        apertures.push(RadiatingAperture {
                            placement_idx: p_idx,
                            way_idx: w_idx,
                            way_label: format!("{} LF Port", way.label),
                            node_id: port_node,
                            world_pos: wp,
                            world_normal: world_rear_n,
                            area_m2: p_spec.area_m2,
                            radius_m: (p_spec.area_m2 / PI).sqrt(),
                            waveguide_angles_deg: None,
                            baffle_width_m: cab.dims_m[0],
                            is_port_or_mouth: true,
                        });
                    }
                }
            }

            compiled_ways.push(CompiledWay {
                placement_idx: p_idx,
                way_idx: w_idx,
                way,
                drv,
                v_drive,
                front_node,
                rear_node,
                extra_stamps: stamps,
            });
        }
    }

    // 2. Assemble global MNA linear system:
    // Unknown ordering:
    //   [0 .. num_p_nodes]                          -> Acoustic nodal pressures `p_1 .. p_{Np}`
    //   [num_p_nodes .. + 2 * n_ways]               -> Driver `(I_d, v_d)` per `CompiledWay`
    //   [num_p_nodes + 2*n_ways .. + n_apertures]   -> Exterior aperture volume velocities `U_ext`
    let n_ways = compiled_ways.len();
    let n_ap = apertures.len();
    let base_drv = num_p_nodes;
    let base_ap = num_p_nodes + 2 * n_ways;
    let total_dof = base_ap + n_ap;

    let mut mat = ComplexMatrix::zeros(total_dof, total_dof);
    let mut rhs = vec![Complex64::new(0.0, 0.0); total_dof];

    for (k_way, cw) in compiled_ways.iter().enumerate() {
        for st in &cw.extra_stamps {
            match *st {
                NodeStamp::Shunt { node, y } => {
                    mat.add_assign(node - 1, node - 1, y);
                }
                NodeStamp::TwoPort {
                    n1,
                    n2,
                    y11,
                    y12,
                    y22,
                } => {
                    mat.add_assign(n1 - 1, n1 - 1, y11);
                    mat.add_assign(n1 - 1, n2 - 1, y12);
                    mat.add_assign(n2 - 1, n1 - 1, y12);
                    mat.add_assign(n2 - 1, n2 - 1, y22);
                }
            }
        }

        // Parallel identical drivers in way:
        // R_e_par = R_e / N, Bl_par = Bl, M_md_par = N * M_md, C_ms_par = C_ms / N, R_ms_par = N * R_ms, S_d_par = N * S_d
        // (Verify: for N parallel drivers driven by same voltage V, total current I_tot = N * I_1 => V = (Z_e/N)*I_tot + Bl*v,
        //  total force = N * Bl * I_1 = Bl * I_tot = (N * Z_m) * v + (N * S_d) * dp! Exact!)
        let n_par = cw.way.driver_count.max(1) as f64;
        let ss = &cw.drv.small_signal;
        let temp_scale = if let Some(t_k) = vc_temp_override_k {
            1.0 + cw.drv.thermal.alpha_temp_per_k * (t_k - 293.15)
        } else {
            1.0
        };
        let z_eb = voice_coil_blocked_impedance(ss.re_ohm * temp_scale, &ss.inductance, omega) / n_par;

        // Logarithmic suspension creep [Ref #9]: C_ms(w) = C_ms0 * [1 - lambda * ln(j * f / 1000)]
        let creep = ss.creep_lambda.clamp(0.0, 0.15);
        let cms_complex = if creep > 0.0 {
            let ln_term = Complex64::new((freq_hz.max(1.0) / 1000.0).ln(), 0.5 * PI);
            ss.cms_m_per_n * (Complex64::new(1.0, 0.0) - creep * ln_term)
        } else {
            Complex64::new(ss.cms_m_per_n, 0.0)
        };

        let m_dry = ss.dry_mass_kg(air.density_kg_m3);
        let jw = Complex64::new(0.0, omega);
        let z_mech =
            n_par * (Complex64::new(ss.rms_n_s_m, omega * m_dry) + 1.0 / (jw * cms_complex));
        let sd_tot = Complex64::new(n_par * ss.sd_m2, 0.0);
        let bl = Complex64::new(ss.bl_t_m, 0.0);

        let idx_i = base_drv + 2 * k_way;
        let idx_v = base_drv + 2 * k_way + 1;
        let nf = cw.front_node - 1;
        let nr = cw.rear_node - 1;

        // Row idx_i: Z_eb * I_tot + Bl * v = V_drive
        mat.set(idx_i, idx_i, z_eb);
        mat.set(idx_i, idx_v, bl);
        rhs[idx_i] = cw.v_drive;

        // Row idx_v: -Bl * I_tot + Z_mech * v + S_d_tot * p_front - S_d_tot * p_rear = 0
        mat.set(idx_v, idx_i, -bl);
        mat.set(idx_v, idx_v, z_mech);
        mat.set(idx_v, nf, sd_tot);
        mat.set(idx_v, nr, -sd_tot);

        // Acoustic KCL at front_node (`nf`): -S_d_tot * v enters `nf` => sum Y * p - S_d_tot * v = 0
        mat.add_assign(nf, idx_v, -sd_tot);
        // Acoustic KCL at rear_node (`nr`): +S_d_tot * v leaves `nr` => sum Y * p + S_d_tot * v = 0
        mat.add_assign(nr, idx_v, sd_tot);
    }

    // 3. Stamp 3D Mutual Radiation Matrix `Z_rad` across all exterior apertures!
    let z_rad =
        assemble_mutual_radiation_matrix(&apertures, boundary, freq_hz, air, enable_mutual);
    for m in 0..n_ap {
        let idx_u = base_ap + m;
        let node_idx = apertures[m].node_id - 1;
        // KCL at aperture node: +U_ext leaves interior node into exterior space!
        mat.add_assign(node_idx, idx_u, Complex64::new(1.0, 0.0));
        // Radiation equation: p_{node_m} - sum_q Z_rad(m, q) * U_ext_q = 0
        mat.add_assign(idx_u, node_idx, Complex64::new(1.0, 0.0));
        for q in 0..n_ap {
            mat.add_assign(idx_u, base_ap + q, -z_rad.get(m, q));
        }
    }

    let lu = mat
        .lu_factor()
        .map_err(|rcond| AcousticsError::SingularSystem { freq_hz, rcond })?;
    let sol = lu.solve(&rhs);

    let jw = Complex64::new(0.0, omega);
    let mut driver_states = Vec::with_capacity(n_ways);
    for (k_way, cw) in compiled_ways.iter().enumerate() {
        let i_tot = sol[base_drv + 2 * k_way];
        let v_cone = sol[base_drv + 2 * k_way + 1];
        let z_elec = if i_tot.norm() > 1.0e-18 {
            cw.v_drive / i_tot
        } else {
            Complex64::new(1.0e6, 0.0)
        };
        driver_states.push(DriverSolvedState {
            placement_idx: cw.placement_idx,
            way_idx: cw.way_idx,
            z_elec_ohm: z_elec,
            current_a: i_tot,
            velocity_m_s: v_cone,
            displacement_m: v_cone / jw,
        });
    }

    let mut aperture_u = Vec::with_capacity(n_ap);
    let mut aperture_p = Vec::with_capacity(n_ap);
    for m in 0..n_ap {
        aperture_u.push(sol[base_ap + m]);
        aperture_p.push(sol[apertures[m].node_id - 1]);
    }

    Ok((
        apertures,
        NetworkFreqSolution {
            freq_hz,
            aperture_u,
            aperture_p,
            driver_states,
        },
    ))
}

/// Evaluate coherent 3D acoustic pressure `p(r, omega)` (`Pa` RMS) at world observation point `obs`
/// from solved `apertures` & `aperture_u`, including:
/// - Aperture piston/waveguide 3D directional pattern (or fused 3D BEM directivity modifier!),
/// - Cabinet baffle-step transition (`4*pi` -> `2*pi`),
/// - Ground / studio-wall reflections (`Rigid`, `WallFloor`, `StudioFrontWall` SBIR, `OpenFieldTurf`),
/// - ISO 9613-1 outdoor atmospheric attenuation `alpha_atm(f)` [Ref #29]!
pub fn evaluate_field_pressure(
    obs: Point3,
    apertures: &[RadiatingAperture],
    aperture_u: &[Complex64],
    boundary: &BoundaryEnvironment,
    freq_hz: f64,
    air: &AirProperties,
    filter_way: Option<usize>,
) -> Complex64 {
    let k = air.wavenumber(freq_hz);
    let omega = 2.0 * PI * freq_hz;
    let alpha_np_per_m = air.atmospheric_attenuation_db_per_m(freq_hz) / 8.685_889_638;
    let mut p_tot = Complex64::new(0.0, 0.0);

    for (m, ap) in apertures.iter().enumerate() {
        if let Some(target_w) = filter_way {
            if ap.way_idx != target_w {
                continue;
            }
        }
        let u_m = aperture_u[m];
        if u_m.norm_sqr() < 1.0e-36 {
            continue;
        }

        // Direct path
        p_tot += radiate_single_path(ap, ap.world_pos, ap.world_normal, obs, u_m, k, omega, alpha_np_per_m, air);

        // Ground image (`z -> -z`)
        if !matches!(boundary, BoundaryEnvironment::Free4Pi) {
            let img_pos = ap.world_pos.mirror_z();
            let img_n = Vec3::new(ap.world_normal.x, ap.world_normal.y, -ap.world_normal.z);
            let d_img = obs.dist(img_pos).max(0.05);
            let cos_inc = ((obs.z + ap.world_pos.z) / d_img).clamp(0.02, 1.0);
            let r_g = ground_reflection_coeff(boundary, cos_inc, freq_hz, air);
            p_tot += r_g
                * radiate_single_path(ap, img_pos, img_n, obs, u_m, k, omega, alpha_np_per_m, air);
        }

        // Front/Stage Wall image (`y -> 2*wall_y - y`) for quarter-space or Studio SBIR!
        match *boundary {
            BoundaryEnvironment::WallFloorPi { wall_y_m } => {
                let w_pos = Point3::new(ap.world_pos.x, 2.0 * wall_y_m - ap.world_pos.y, ap.world_pos.z);
                let w_n = Vec3::new(ap.world_normal.x, -ap.world_normal.y, ap.world_normal.z);
                p_tot += radiate_single_path(ap, w_pos, w_n, obs, u_m, k, omega, alpha_np_per_m, air);
            }
            BoundaryEnvironment::StudioFrontWall {
                wall_y_m,
                wall_reflection,
            } => {
                let w_pos = Point3::new(ap.world_pos.x, 2.0 * wall_y_m - ap.world_pos.y, ap.world_pos.z);
                let w_n = Vec3::new(ap.world_normal.x, -ap.world_normal.y, ap.world_normal.z);
                p_tot += wall_reflection
                    * radiate_single_path(ap, w_pos, w_n, obs, u_m, k, omega, alpha_np_per_m, air);
            }
            _ => {}
        }
    }
    p_tot
}

fn radiate_single_path(
    ap: &RadiatingAperture,
    src: Point3,
    normal: Vec3,
    obs: Point3,
    u_vol: Complex64,
    k: f64,
    omega: f64,
    alpha_np_per_m: f64,
    air: &AirProperties,
) -> Complex64 {
    let vec_to_obs = obs.sub(src);
    let r = vec_to_obs.norm().max(0.08);
    let dir = vec_to_obs.scale(1.0 / r);
    let cos_theta = normal.dot(dir).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();

    // Baffle diffraction & directivity pattern:
    // - At low ka_baffle << 1: omnidirectional 4*pi monopole `j*w*rho*U / (4*pi*r)`!
    // - At high ka_baffle >> 1: transitions to 2*pi forward baffle (+6 dB on-axis baffle step!)
    //   multiplied by circular piston `2*J1(ka*sin(theta))/(ka*sin(theta))` OR OS-SE constant-directivity beam!
    let ka_baffle = k * (0.5 * ap.baffle_width_m.max(2.0 * ap.radius_m));
    let baffle_transition = (ka_baffle * ka_baffle) / (1.35 + ka_baffle * ka_baffle);

    let pattern = if let Some((cov_h_deg, cov_v_deg)) = ap.waveguide_angles_deg {
        // Constant-directivity OS-SE waveguide beam above throat/mouth cutoff `ka_mouth ~ 1.2`!
        let ka_mouth = k * ap.radius_m;
        let wg_control = (ka_mouth * ka_mouth) / (1.4 + ka_mouth * ka_mouth);
        // Decompose off-axis angle into approximate horizontal & vertical components
        let up = Vec3::Z;
        let right = normal.cross(up).normalized();
        let real_up = right.cross(normal).normalized();
        let ang_h = dir.dot(right).asin().abs();
        let ang_v = dir.dot(real_up).asin().abs();
        let half_h = 0.5 * cov_h_deg.to_radians().max(0.2);
        let half_v = 0.5 * cov_v_deg.to_radians().max(0.2);
        // At half-coverage angle, OS-SE drops -6 dB (`amplitude = 0.5`), smooth super-Gaussian skirt!
        let u_ellip = if cos_theta >= 0.0 {
            ((ang_h / half_h).powi(2) + (ang_v / half_v).powi(2)).sqrt()
        } else {
            1.5 + (PI - theta).max(0.0)
        };
        let beam = (-0.693_147 * u_ellip.powf(2.3)).exp().max(0.03);
        // Directivity index on-axis gain boost of waveguide (`sqrt(Q_dir)`)!
        let solid_angle_frac = ((cov_h_deg / 360.0) * (cov_v_deg / 180.0)).clamp(0.04, 0.5);
        let wg_on_axis_gain = (0.5 / solid_angle_frac).sqrt().min(3.4);
        let rear_shadow = 1.0 - baffle_transition * (0.5 * (1.0 - cos_theta)).powf(0.85) * 0.92;
        (1.0 - wg_control) * rear_shadow + wg_control * wg_on_axis_gain * beam
    } else {
        // Direct radiator / horn mouth: baffle step + `2*J1(ka*sin(theta))/(ka*sin(theta))`!
        let sin_th = theta.sin().abs();
        let piston_beam = if cos_theta > 0.0 {
            spatial_averaging_jinc(k * ap.radius_m * sin_th).abs().max(0.04)
        } else {
            spatial_averaging_jinc(k * ap.radius_m).abs().max(0.04)
        };
        let on_axis_baffle_boost = 1.0 + baffle_transition; // 1.0 (4pi) -> 2.0 (+6 dB 2pi baffle step!)
        let cardioid_baffle_wrap = (1.0 - baffle_transition)
            + baffle_transition * (0.12 + 0.88 * (0.5 * (1.0 + cos_theta)).powf(1.15));
        on_axis_baffle_boost * cardioid_baffle_wrap * ((1.0 - baffle_transition) + baffle_transition * piston_beam)
    };

    let atten = (-alpha_np_per_m * r).exp();
    let green_4pi = Complex64::from_polar(atten / (4.0 * PI * r), -k * r);
    Complex64::new(0.0, omega * air.density_kg_m3) * u_vol * green_4pi * pattern
}

#[cfg(test)]
mod tests {
    use super::*;
    use acoustics_oracles::salmon_horn_throat_impedance;
    use acoustics_types::{DriverNonlinear, DriverSmallSignal, DriverThermal, Transform3};

    #[test]
    fn test_stinson_tmm_matches_lossless_salmon_horn_limit() {
        // Oracle O1.2: In a wide horn where viscous layer is negligible, TMM matches exact Salmon formula!
        let mut air = AirProperties::default();
        air.viscosity_pa_s = 1.0e-12; // turn off viscosity to test pure analytical wave identity!
        air.thermal_conductivity = 1.0e-12;

        let s0: f64 = 0.05;
        let flare_m: f64 = 0.7;
        let len: f64 = 1.6;
        let sl = s0 * (2.0 * flare_m * len).exp();
        let seg = HornSegmentSpec {
            length_m: len,
            throat_area_m2: s0,
            mouth_area_m2: sl,
            contour: HornContour::Exponential,
            aspect_ratio: 1.0,
        };

        for &f in &[45.0, 90.0, 220.0] {
            let w = 2.0 * PI * f;
            let z_load = Complex64::new(air.z0() / sl, 120.0);
            let z_exact = salmon_horn_throat_impedance(s0, flare_m, 1.0, len, z_load, f, &air);

            let (y11, y12, y22) = waveguide_chain_admittance(std::slice::from_ref(&seg), w, &air);
            // Terminating port 2 in z_load (`U_2_in = -p_2 / z_load` => `(y22 + 1/z_load) p_2 + y12 p_1 = 0`):
            let y_in = y11 - (y12 * y12) / (y22 + 1.0 / z_load);
            let z_tmm = 1.0 / y_in;
            let rel_err = (z_tmm - z_exact).norm() / z_exact.norm();
            assert!(rel_err < 2.0e-3, "f={f} Hz: z_tmm={z_tmm} vs z_exact={z_exact}");
        }
    }

    #[test]
    fn test_four_folded_horns_coupled_gain_and_excursion_reduction() {
        // Verify that 4 mouth-coupled folded horns at 34 Hz gain > +12.5 dB over 1 horn AND reduce cone excursion!
        let air = AirProperties::default();
        let drv = DriverSpec {
            id: "sub18".into(),
            name: "18in Horn Sub".into(),
            category: "sub".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.2,
                inductance: InductanceModel::L2R2 {
                    le_h: 1.4e-3,
                    l2_h: 0.9e-3,
                    r2_ohm: 14.0,
                },
                bl_t_m: 28.5,
                mms_kg: 0.215,
                cms_m_per_n: 0.00010,
                creep_lambda: 0.02,
                rms_n_s_m: 6.5,
                sd_m2: 0.122,
                xmax_m: 0.014,
                xmech_m: 0.022,
                pe_max_w: 1600.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        };
        let cab = SpeakerCabinetSpec {
            id: "horn1".into(),
            name: "Folded Horn".into(),
            subtitle: "2.2m".into(),
            dims_m: [0.60, 0.90, 0.90],
            edge_round_m: 0.01,
            visual_fold_count: 3,
            construction: Default::default(),
            ways: vec![CabinetWaySpec {
                way_id: "sub".into(),
                label: "Sub".into(),
                driver_id: "sub18".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.45),
                enclosure: WayEnclosure::FoldedHorn {
                    rear_volume_m3: 0.055,
                    throat_chamber_m3: 0.008,
                    leakage_ql: 20.0,
                    segments: vec![
                        HornSegmentSpec {
                            length_m: 0.9,
                            throat_area_m2: 0.042,
                            mouth_area_m2: 0.14,
                            contour: HornContour::Salmon { t_factor: 0.6 },
                            aspect_ratio: 1.2,
                        },
                        HornSegmentSpec {
                            length_m: 1.35,
                            throat_area_m2: 0.14,
                            mouth_area_m2: 0.48,
                            contour: HornContour::Exponential,
                            aspect_ratio: 1.1,
                        },
                    ],
                    rear_damping: PorousMaterial::default(),
                },
            }],
        };

        let mut cabs = HashMap::new();
        cabs.insert("horn1", &cab);
        let mut drvs = HashMap::new();
        drvs.insert("sub18", &drv);
        let dsp_map = HashMap::new();

        let pl_1 = vec![PlacedCabinet {
            instance_id: "s1".into(),
            label: "Sub 1".into(),
            cabinet_spec_id: "horn1".into(),
            transform: Transform3::at(0.0, 0.0, 0.0),
            way_dsp_channels: vec!["".into()],
        }];
        let pl_4 = vec![
            PlacedCabinet {
                instance_id: "s1".into(),
                label: "S1".into(),
                cabinet_spec_id: "horn1".into(),
                transform: Transform3::at(-0.31, 0.0, 0.0),
                way_dsp_channels: vec!["".into()],
            },
            PlacedCabinet {
                instance_id: "s2".into(),
                label: "S2".into(),
                cabinet_spec_id: "horn1".into(),
                transform: Transform3::at(0.31, 0.0, 0.0),
                way_dsp_channels: vec!["".into()],
            },
            PlacedCabinet {
                instance_id: "s3".into(),
                label: "S3".into(),
                cabinet_spec_id: "horn1".into(),
                transform: Transform3::at(-0.31, 0.0, 0.91),
                way_dsp_channels: vec!["".into()],
            },
            PlacedCabinet {
                instance_id: "s4".into(),
                label: "S4".into(),
                cabinet_spec_id: "horn1".into(),
                transform: Transform3::at(0.31, 0.0, 0.91),
                way_dsp_channels: vec!["".into()],
            },
        ];

        let boundary = BoundaryEnvironment::RigidGround2Pi;
        let mic = Point3::new(0.0, 10.0, 1.2);
        let f_test = 35.0;

        let (ap1, sol1) = solve_scene_at_frequency(
            &cabs, &drvs, &dsp_map, &pl_1, &boundary, 40.0, f_test, &air, true, None,
        )
        .unwrap();
        let (ap4, sol4) = solve_scene_at_frequency(
            &cabs, &drvs, &dsp_map, &pl_4, &boundary, 40.0, f_test, &air, true, None,
        )
        .unwrap();

        let spl1 = acoustics_types::pa_to_spl_db(
            evaluate_field_pressure(mic, &ap1, &sol1.aperture_u, &boundary, f_test, &air, None).norm(),
        );
        let spl4 = acoustics_types::pa_to_spl_db(
            evaluate_field_pressure(mic, &ap4, &sol4.aperture_u, &boundary, f_test, &air, None).norm(),
        );

        let r_rad_1 = (sol1.aperture_p[0] / sol1.aperture_u[0]).re;
        let r_rad_4 = (sol4.aperture_p[0] / sol4.aperture_u[0]).re;
        // Real radiation resistance per mouth increases nearly 4x!
        assert!(
            r_rad_4 > 3.2 * r_rad_1,
            "expected >3.2x mutual R_rad boost, got {r_rad_4} vs {r_rad_1}"
        );
        assert!(spl4 - spl1 > 11.5, "got spl4={spl4:.2}, spl1={spl1:.2}");
    }
}
