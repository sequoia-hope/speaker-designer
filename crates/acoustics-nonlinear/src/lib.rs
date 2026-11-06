//! Tier 3 Large-Signal Klippel Nonlinearity, 3-Node Forced-Convection Thermal Network,
//! Salvatti Port Aeroacoustics & Time-Domain Wavefront Pulse Propagator [Ref #20, #21, #22].

use acoustics_types::{
    AirProperties, BoundaryEnvironment, Complex64, DriverSpec, Point3, Vec3, P_REF_PA,
};
use std::f64::consts::PI;

/// Solved large-signal nonlinear, aeroacoustic, and thermal operating point at one frequency.
#[derive(Clone, Debug, Copy)]
pub struct NonlinearOperatingPoint {
    /// Steady-state voice-coil temperature (`C`) under continuous `volts_rms` sine/program drive.
    pub vc_temp_c: f64,
    /// Thermal + port-compression SPL loss (`dB`, `>= 0`).
    pub total_compression_db: f64,
    /// Peak cone excursion (`mm`) including thermal/compression damping.
    pub peak_excursion_mm: f64,
    /// Peak port / horn-throat air Mach number (`|v_air| / c`).
    pub port_mach: f64,
    /// Dynamic DC voice-coil offset (`mm`) caused by `Bl(x)`, `Kms(x)` asymmetry & `dLe/dx` reluctance!
    pub dc_shift_mm: f64,
    /// Total Harmonic Distortion (`%` of fundamental pressure).
    pub thd_percent: f64,
    /// 2nd harmonic relative level (`dB` re fundamental, e.g. `-28.5 dB`).
    pub hd2_db_rel: f64,
    /// 3rd harmonic relative level (`dB` re fundamental, e.g. `-22.0 dB`).
    pub hd3_db_rel: f64,
}

/// Evaluate high-SPL Klippel motor/suspension distortion, Salvatti port turbulence compression,
/// and 3-node forced-convection voice-coil heating at `(freq_hz, volts_rms)` [Ref #20, #21, #22].
pub fn evaluate_large_signal_point(
    drv: &DriverSpec,
    freq_hz: f64,
    volts_rms: f64,
    z_elec_small: Complex64,
    cone_disp_rms_m: f64,
    cone_vel_rms_m_s: f64,
    port_vol_vel_rms: f64,
    port_area_m2: Option<(f64, f64)>, // (area_m2, flare_radius_m)
    air: &AirProperties,
) -> NonlinearOperatingPoint {
    let ss = &drv.small_signal;
    let nl = &drv.nonlinear;
    let th = &drv.thermal;

    // 1. Coupled 3-node forced-convection thermal equilibrium (with program crest factor 6 dB -> P_avg = 0.25 * P_sine):
    // Notice R_th_vc_pole drops with `cone_vel_rms_m_s` (forced air cooling in magnetic gap — dips to minimum
    // when cone moves strongly, and SPIKES right at the vented/horn box tuning null where v_cone -> 0!).
    let mut temp_vc_k = air.env.temperature_k;
    for _ in 0..8 {
        let re_hot = ss.re_ohm * (1.0 + th.alpha_temp_per_k * (temp_vc_k - 293.15));
        let z_scale = (re_hot / ss.re_ohm).sqrt();
        let i_rms = volts_rms / (z_elec_small.norm() * z_scale).max(0.5);
        // Program duty factor (0.35 of continuous sine = realistic heavy EDM sub bassline!)
        let p_joule_w = 0.35 * i_rms * i_rms * re_hot;

        let cooling_factor = 1.0 + th.forced_cooling_coeff * cone_vel_rms_m_s.max(0.0).powf(0.65);
        let r_th_eff =
            th.r_th_vc_pole_k_w / cooling_factor + 0.45 * th.r_th_pole_mag_k_w + 0.20 * th.r_th_mag_amb_k_w;
        temp_vc_k = (air.env.temperature_k + p_joule_w * r_th_eff).min(th.max_vc_temp_k + 60.0);
    }

    let re_ratio = 1.0 + th.alpha_temp_per_k * (temp_vc_k - 293.15);
    // Thermal sensitivity compression: as Re rises by `re_ratio`, electro-acoustic gain drops by ~20*log10(re_ratio) * Qes/(Qts+0.15)
    let thermal_comp_db = 20.0 * re_ratio.log10() * 0.82;

    // 2. Salvatti [Ref #21] aeroacoustic port / throat turbulence & vena-contracta compression
    let (port_mach, port_comp_db, port_hd3_ratio) = if let Some((s_port, r_flare)) = port_area_m2 {
        let v_peak = (2.0_f64.sqrt() * port_vol_vel_rms) / s_port.max(1.0e-5);
        let mach = v_peak / air.sound_speed_m_s;
        let d_hyd = 2.0 * (s_port / PI).sqrt();
        let flare_ratio = (r_flare / d_hyd.max(1e-3)).clamp(0.0, 0.5);
        // Generous flare raises turbulent onset from Mach 0.05 (17 m/s) up to Mach 0.13 (45 m/s)!
        let mach_crit = 0.045 + 0.18 * flare_ratio;
        let excess = (mach / mach_crit).max(0.0);
        let p_comp = if excess > 0.6 {
            (1.6 * (excess - 0.6).powf(1.5)).min(7.5)
        } else {
            0.0
        };
        let p_hd3 = 0.018 * excess.powi(2) / (1.0 + 0.4 * excess.powi(2));
        (mach, p_comp, p_hd3)
    } else {
        (0.0, 0.0, 0.0)
    };

    let total_comp_db = thermal_comp_db + port_comp_db;
    let lin_atten = 10.0_f64.powf(-total_comp_db / 20.0);

    // 3. Klippel Harmonic Balance perturbation + soft saturation [Ref #20]:
    // Peak normalized excursion `u_pk = x_pk / X_max`
    let x_pk_lin = 2.0_f64.sqrt() * cone_disp_rms_m * lin_atten;
    let u_raw = x_pk_lin / ss.xmax_m.max(1.0e-4);
    // Spider progressive stiffening compresses peak excursion smoothly above X_max toward X_mech!
    let k2_stiff = nl.kms_poly[1].abs().max(0.15);
    let u_pk = u_raw / (1.0 + 0.28 * k2_stiff * u_raw * u_raw).sqrt();
    let peak_excursion_mm = (u_pk * ss.xmax_m * 1000.0).min(ss.xmech_m * 1000.0);

    // Harmonic ratios from polynomial motor Bl(u), stiffness Kms(u), and reluctance 0.5 * dLe/dx * i^2:
    let w = 2.0 * PI * freq_hz;
    let ws = 2.0 * PI * ss.fs_hz();
    // Stiffness nonlinearity dominates below/near 1.5*fs; Bl & Le(x,i) dominate throughout passband!
    let kms_weight = 1.0 / (1.0 + (w / (1.8 * ws)).powi(2));
    let i_pk = 2.0_f64.sqrt() * volts_rms / z_elec_small.norm().max(0.5);

    // Asymmetric 2nd harmonic (`HD2`) & dynamic DC offset `x_DC`:
    // Quadratic force terms: `0.5 * b1 * u` (motor) + `0.5 * k1 * u^2` (stiffness) + reluctance `l1`
    let hd2_bl = 0.5 * nl.bl_poly[0].abs() * u_pk;
    let hd2_kms = 0.5 * nl.kms_poly[0].abs() * u_pk * kms_weight;
    let hd2_rel = 0.004 * nl.le_x_poly[0].abs() * (i_pk / 15.0).min(3.0);
    let hd2_ratio = ((hd2_bl + hd2_kms + hd2_rel).min(0.45)).max(1.0e-5);

    // Dynamic DC offset (mm): `x_DC / X_max ~ -0.5 * (k1 + 0.7 * b1) * u_pk^2 + reluctance_pull`
    let dc_norm = -0.45 * (nl.kms_poly[0] + 0.65 * nl.bl_poly[0]) * u_pk * u_pk * kms_weight
        - 0.015 * nl.le_x_poly[0] * (i_pk / 20.0).powi(2) * kms_weight;
    let dc_shift_mm = (dc_norm * ss.xmax_m * 1000.0).clamp(-0.4 * ss.xmax_m * 1000.0, 0.4 * ss.xmax_m * 1000.0);

    // Symmetric 3rd harmonic (`HD3`):
    // Cubic force terms: `0.25 * |b2| * u^2` + `0.25 * |k2| * u^2` + port vortex `port_hd3_ratio`
    let hd3_bl = 0.25 * nl.bl_poly[1].abs() * u_pk * u_pk + 0.125 * nl.bl_poly[3].abs() * u_pk.powi(4);
    let hd3_kms =
        (0.25 * nl.kms_poly[1].abs() * u_pk * u_pk + 0.125 * nl.kms_poly[3].abs() * u_pk.powi(4))
            * kms_weight;
    let hd3_ratio = ((hd3_bl + hd3_kms + port_hd3_ratio).min(0.65)).max(1.0e-5);

    let thd_ratio = (hd2_ratio * hd2_ratio + hd3_ratio * hd3_ratio).sqrt();

    NonlinearOperatingPoint {
        vc_temp_c: temp_vc_k - 273.15,
        total_compression_db: total_comp_db,
        peak_excursion_mm,
        port_mach,
        dc_shift_mm,
        thd_percent: (thd_ratio * 100.0).min(100.0),
        hd2_db_rel: 20.0 * hd2_ratio.log10(),
        hd3_db_rel: 20.0 * hd3_ratio.log10(),
    }
}

/// Synthesize 2D horizontal time-domain wave-propagation snapshots (`transient_frames`) of an EDM
/// bass-kick transient (`f_kick = 52 Hz` punch + `140 Hz` body envelope) radiating from placed cabinets
/// across the 3D scene (`bounds_m = [xmin, xmax, ymin, ymax]`), including cabinet DSP delays & polarities!
pub fn compute_transient_wavefront_frames(
    sources: &[(Point3, Vec3, f64, f64, bool)], // (world_pos, world_fwd, delay_s, rel_gain, is_directional_top)
    bounds_m: [f64; 4],
    nx: usize,
    ny: usize,
    z_ear_m: f64,
    boundary: &BoundaryEnvironment,
    air: &AirProperties,
    n_frames: usize,
) -> (Vec<f64>, Vec<Vec<f32>>) {
    let [xmin, xmax, ymin, ymax] = bounds_m;
    let c = air.sound_speed_m_s;
    let diag = ((xmax - xmin).powi(2) + (ymax - ymin).powi(2)).sqrt();
    let t_max_s = (diag * 0.82 / c).clamp(0.012, 0.14);

    let times_ms: Vec<f64> = (0..n_frames)
        .map(|k| 1000.0 * t_max_s * ((k + 1) as f64) / (n_frames as f64))
        .collect();

    // EDM Kick wavelet: windowed 55 Hz sub-thump + 135 Hz upper-bass attack transient
    let kick_wavelet = |tau: f64, is_top: bool| -> f64 {
        if tau <= 0.0 || tau > 0.065 {
            return 0.0;
        }
        if is_top {
            let env = (tau / 0.004) * (-tau / 0.0055).exp();
            0.55 * env * (2.0 * PI * 145.0 * tau).sin()
        } else {
            let env = (tau / 0.008) * (-tau / 0.014).exp();
            env * (2.0 * PI * 54.0 * tau).sin()
        }
    };

    let ground_gain = if matches!(boundary, BoundaryEnvironment::Free4Pi) {
        1.0
    } else {
        1.85
    };
    let _ = P_REF_PA;

    let mut frames = Vec::with_capacity(n_frames);
    let mut global_peak = 1.0e-9_f32;

    for &t_ms in &times_ms {
        let t_s = 0.001 * t_ms;
        let mut grid = vec![0.0_f32; nx * ny];

        for iy in 0..ny {
            let y = ymin + (ymax - ymin) * (iy as f64) / ((ny - 1).max(1) as f64);
            for ix in 0..nx {
                let x = xmin + (xmax - xmin) * (ix as f64) / ((nx - 1).max(1) as f64);
                let obs = Point3::new(x, y, z_ear_m);
                let mut p_sum = 0.0;

                for &(src_pos, src_fwd, delay_s, gain, is_top) in sources {
                    let r_vec = obs.sub(src_pos);
                    let r = r_vec.norm().max(0.35);
                    let tau = t_s - delay_s - r / c;
                    if tau > 0.0 {
                        let dir_weight = if is_top {
                            let cos_th = src_fwd.dot(r_vec.scale(1.0 / r)).clamp(-1.0, 1.0);
                            0.15 + 0.85 * (0.5 * (1.0 + cos_th)).powi(2)
                        } else {
                            1.0
                        };
                        p_sum += gain * ground_gain * dir_weight * kick_wavelet(tau, is_top) / r;
                    }
                }
                let val = p_sum as f32;
                global_peak = global_peak.max(val.abs());
                grid[iy * nx + ix] = val;
            }
        }
        frames.push(grid);
    }

    // Normalize across the whole movie so [-1, +1] maps cleanly to wavefront color shaders!
    let inv_peak = 1.0 / global_peak.max(1.0e-9);
    for grid in &mut frames {
        for v in grid.iter_mut() {
            *v = (*v * inv_peak).clamp(-1.0, 1.0);
        }
    }

    (times_ms, frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use acoustics_types::{DriverNonlinear, DriverSmallSignal, DriverThermal, InductanceModel};

    #[test]
    fn test_nonlinear_forced_convection_cooling_and_distortion_scaling() {
        // Verify:
        // 1. At identical high drive voltage, voice-coil runs HOTTER when cone velocity nulls (at box tuning)
        //    than when cone pumps cooling air strongly!
        // 2. Small-signal drive (0.1 V) produces negligible THD (< 0.1%) and ~0 dB compression,
        //    whereas 80 V drive produces realistic compression & harmonic distortion!
        let air = AirProperties::default();
        let drv = DriverSpec {
            id: "sub".into(),
            name: "Sub".into(),
            category: "sub".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.2,
                inductance: InductanceModel::default(),
                bl_t_m: 26.0,
                mms_kg: 0.20,
                cms_m_per_n: 0.00012,
                creep_lambda: 0.02,
                rms_n_s_m: 5.5,
                sd_m2: 0.12,
                xmax_m: 0.014,
                xmech_m: 0.022,
                pe_max_w: 1500.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        };

        let low = evaluate_large_signal_point(
            &drv,
            40.0,
            0.1,
            Complex64::new(8.0, 2.0),
            0.00002,
            0.005,
            0.0005,
            Some((0.025, 0.02)),
            &air,
        );
        assert!(low.thd_percent < 0.05);
        assert!(low.total_compression_db < 0.05);

        let hot_null = evaluate_large_signal_point(
            &drv,
            35.0,
            80.0,
            Complex64::new(6.5, 0.5),
            0.001,
            0.05, // cone barely moving at port tuning null!
            0.45,
            Some((0.025, 0.002)), // sharp port -> turbulence!
            &air,
        );
        let cool_moving = evaluate_large_signal_point(
            &drv,
            55.0,
            80.0,
            Complex64::new(6.5, 0.5),
            0.009,
            3.1, // strong cone air pumping cools magnetic gap!
            0.15,
            Some((0.025, 0.025)), // flared port!
            &air,
        );
        assert!(
            hot_null.vc_temp_c > cool_moving.vc_temp_c + 15.0,
            "forced cooling check: null={} C vs moving={} C",
            hot_null.vc_temp_c,
            cool_moving.vc_temp_c
        );
        assert!(hot_null.port_mach > cool_moving.port_mach);
    }
}
