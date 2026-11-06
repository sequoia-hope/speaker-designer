//! Multi-Tier Speaker & Sound-System Simulation Orchestrator (`speaker-engine`).
//!
//! Executes Tier-1 (Coupled MNA + Stinson Horns/Tapped-Horns + 3D Mutual `Z_rad`),
//! Tier-2 (3D Burton-Miller BEM cabinet diffraction & waveguide balloons),
//! Tier-3 (Large-Signal Klippel Nonlinear + 3-Node Forced-Convection Thermal + Port Turbulence
//! & Time-Domain Wavefront Propagation), CTA-2034 Spinorama, Listener Zone Scorecards,
//! Virtual-Mic 48 kHz WebAudio FIR Impulse Responses, and Bayesian Measurement Calibration!

pub mod parametric;
pub mod presets;
pub use parametric::*;
pub use presets::*;

use acoustics_bem::{evaluate_bem_exterior_pressure, solve_exterior_burton_miller};
use acoustics_dsp::eval_dsp_channel;
use acoustics_math::{logspace, transfer_function_to_fir};
use acoustics_mesh::{audit_watertight_manifold, build_cabinet_bem_mesh, build_visual_cabinet_model};
use acoustics_network::{
    evaluate_field_pressure, solve_scene_at_frequency, RadiatingAperture,
};
use acoustics_nonlinear::{compute_transient_wavefront_frames, evaluate_large_signal_point};
use acoustics_types::{
    pa_to_spl_db, AcousticsError, AirProperties, BoundaryEnvironment, Complex64,
    DirectivityBalloonData, DriverSpec, DspChannelSpec, ListenerZone, Point3, SceneVariantSpec,
    SimulatedVariant, SimulationBundle, SpatialFieldData, SpeakerCabinetSpec, SpinoramaData,
    SystemDesignSpec, VariantSweepCurves, Vec3, VirtualMicImpulse, WayEnclosure, ZoneMetrics,
};
use std::collections::HashMap;
use std::f64::consts::PI;

/// Execute a full multi-tier computational simulation for a `SystemDesignSpec`.
pub fn run_system_simulation(spec: &SystemDesignSpec) -> Result<SimulationBundle, AcousticsError> {
    let air = AirProperties::from_environment(spec.environment);

    let mut cabinets_map: HashMap<&str, &SpeakerCabinetSpec> = HashMap::new();
    for c in &spec.cabinets {
        cabinets_map.insert(c.id.as_str(), c);
    }
    let mut drivers_map: HashMap<&str, &DriverSpec> = HashMap::new();
    for d in &spec.drivers {
        drivers_map.insert(d.id.as_str(), d);
    }

    // 1. Build 3D visual cutaway models and verify watertight 3D BEM meshes for all cabinets!
    let mut cabinet_models = Vec::with_capacity(spec.cabinets.len());
    let mut bem_meshes = HashMap::new();
    for cab in &spec.cabinets {
        cabinet_models.push(build_visual_cabinet_model(cab, &spec.drivers));
        if spec.settings.enable_3d_bem {
            let bmesh = build_cabinet_bem_mesh(cab, &spec.drivers, 5);
            let _vol = audit_watertight_manifold(&bmesh)?;
            bem_meshes.insert(cab.id.as_str(), bmesh);
        }
    }

    let freqs = logspace(
        spec.settings.freq_min_hz,
        spec.settings.freq_max_hz,
        spec.settings.num_freqs,
    );

    let mut simulated_variants = Vec::with_capacity(spec.variants.len());
    for variant in &spec.variants {
        let sim_var = simulate_single_variant(
            spec,
            variant,
            &cabinets_map,
            &drivers_map,
            &bem_meshes,
            &freqs,
            &air,
        )?;
        simulated_variants.push(sim_var);
    }

    let calibration = presets::maybe_run_embedded_calibration(&spec.id, &air);

    Ok(SimulationBundle {
        schema_version: 1,
        id: spec.id.clone(),
        title: spec.title.clone(),
        category: spec.category.clone(),
        description: spec.description.clone(),
        design_notes: spec.design_notes.clone(),
        reference_mic_m: spec.settings.reference_mic_m,
        high_spl_volts_rms: spec.settings.high_spl_volts_rms,
        zones: spec.zones.clone(),
        cabinet_models,
        variants: simulated_variants,
        calibration,
    })
}

fn simulate_single_variant(
    spec: &SystemDesignSpec,
    variant: &SceneVariantSpec,
    cabinets_map: &HashMap<&str, &SpeakerCabinetSpec>,
    drivers_map: &HashMap<&str, &DriverSpec>,
    bem_meshes: &HashMap<&str, acoustics_types::AcousticSurfaceMesh>,
    freqs: &[f64],
    air: &AirProperties,
) -> Result<SimulatedVariant, AcousticsError> {
    let mut dsp_map: HashMap<&str, &DspChannelSpec> = HashMap::new();
    for ch in &variant.dsp_channels {
        dsp_map.insert(ch.id.as_str(), ch);
    }

    let ref_mic = Point3::from(spec.settings.reference_mic_m);
    let v_small = spec.settings.small_signal_volts_rms;
    let v_high = spec.settings.high_spl_volts_rms;
    let high_gain_db = 20.0 * (v_high / v_small.max(1.0e-6)).log10();

    let first_cab = cabinets_map[variant.placements[0].cabinet_spec_id.as_str()];
    let first_way = &first_cab.ways[0];
    let primary_drv = drivers_map[first_way.driver_id.as_str()];
    let primary_port_geom = extract_port_or_throat_geom(&first_way.enclosure);

    let n_ways_first = first_cab.ways.len();
    let mut per_way_spl_db: Vec<(String, Vec<f64>)> = first_cab
        .ways
        .iter()
        .map(|w| (w.label.clone(), Vec::with_capacity(freqs.len())))
        .collect();

    let mut dsp_mag_db: Vec<(String, Vec<f64>)> = variant
        .dsp_channels
        .iter()
        .map(|ch| (ch.label.clone(), Vec::with_capacity(freqs.len())))
        .collect();

    let mut spl_small_signal_db = Vec::with_capacity(freqs.len());
    let mut spl_high_drive_db = Vec::with_capacity(freqs.len());
    let mut spl_uncoupled_baseline_db = Vec::with_capacity(freqs.len());
    let mut raw_phases_rad = Vec::with_capacity(freqs.len());
    let mut ref_mic_phasors = Vec::with_capacity(freqs.len());

    let mut impedance_mag_ohm = Vec::with_capacity(freqs.len());
    let mut impedance_phase_deg = Vec::with_capacity(freqs.len());
    let mut normalized_radiation_resistance = Vec::with_capacity(freqs.len());
    let mut cone_excursion_mm = Vec::with_capacity(freqs.len());
    let mut port_mach = Vec::with_capacity(freqs.len());
    let mut thd_percent = Vec::with_capacity(freqs.len());
    let mut hd2_db_rel = Vec::with_capacity(freqs.len());
    let mut hd3_db_rel = Vec::with_capacity(freqs.len());
    let mut dc_shift_mm = Vec::with_capacity(freqs.len());
    let mut vc_temp_c = Vec::with_capacity(freqs.len());
    let mut power_compression_db = Vec::with_capacity(freqs.len());

    // Store solved `(apertures, high_spl_aperture_u)` across frequencies for Spinorama, Balloons & Zones!
    let mut solved_history: Vec<(Vec<RadiatingAperture>, Vec<Complex64>)> =
        Vec::with_capacity(freqs.len());

    for &f in freqs {
        for (ch_idx, ch) in variant.dsp_channels.iter().enumerate() {
            let h = eval_dsp_channel(ch, f);
            dsp_mag_db[ch_idx]
                .1
                .push(20.0 * h.norm().max(1.0e-6).log10());
        }

        // Solve WITH full 3D mutual coupling:
        let (aps, sol_small) = solve_scene_at_frequency(
            cabinets_map,
            drivers_map,
            &dsp_map,
            &variant.placements,
            &variant.boundary,
            v_small,
            f,
            air,
            true,
            None,
        )?;

        // Solve WITHOUT cross-cabinet mutual coupling for scientific A/B baseline curve!
        let (aps_unc, sol_unc) = solve_scene_at_frequency(
            cabinets_map,
            drivers_map,
            &dsp_map,
            &variant.placements,
            &variant.boundary,
            v_small,
            f,
            air,
            false,
            None,
        )?;

        let p_ref_small = evaluate_field_pressure(
            ref_mic,
            &aps,
            &sol_small.aperture_u,
            &variant.boundary,
            f,
            air,
            None,
        );
        let p_ref_unc = evaluate_field_pressure(
            ref_mic,
            &aps_unc,
            &sol_unc.aperture_u,
            &variant.boundary,
            f,
            air,
            None,
        );

        let spl_sm = pa_to_spl_db(p_ref_small.norm());
        let spl_unc_sm = pa_to_spl_db(p_ref_unc.norm());
        spl_small_signal_db.push(spl_sm);
        raw_phases_rad.push(p_ref_small.arg());
        ref_mic_phasors.push(p_ref_small * (v_high / v_small.max(1e-6)));

        let mut way_spl_sm = Vec::with_capacity(n_ways_first);
        for w_idx in 0..n_ways_first {
            let pw = evaluate_field_pressure(
                ref_mic,
                &aps,
                &sol_small.aperture_u,
                &variant.boundary,
                f,
                air,
                Some(w_idx),
            );
            way_spl_sm.push(pa_to_spl_db(pw.norm()));
        }

        // Primary LF driver impedance & radiation loading
        let drv0_state = &sol_small.driver_states[0];
        impedance_mag_ohm.push(drv0_state.z_elec_ohm.norm());
        impedance_phase_deg.push(drv0_state.z_elec_ohm.arg().to_degrees());

        let z_char = air.z0() / aps[0].area_m2.max(1.0e-5);
        let z_rad_seen = if sol_small.aperture_u[0].norm() > 1.0e-18 {
            (sol_small.aperture_p[0] / sol_small.aperture_u[0]).re / z_char
        } else {
            0.0
        };
        normalized_radiation_resistance.push(z_rad_seen.max(0.0));

        // Scale linear cone & port motion to `v_high` and evaluate Tier-3 Large-Signal Nonlinear + Thermal!
        let v_scale = v_high / v_small.max(1.0e-6);
        let port_u_rms = aps
            .iter()
            .enumerate()
            .find(|(_, a)| a.placement_idx == 0 && a.way_idx == 0 && a.is_port_or_mouth)
            .map(|(idx, _)| sol_small.aperture_u[idx].norm() * v_scale)
            .unwrap_or(0.0);

        // Effective voltage reaching the primary LF driver after its DSP crossover!
        let dsp_lf_gain = variant
            .placements[0]
            .way_dsp_channels
            .first()
            .and_then(|id| dsp_map.get(id.as_str()))
            .map(|ch| eval_dsp_channel(ch, f).norm())
            .unwrap_or(1.0);

        let nl_pt = evaluate_large_signal_point(
            primary_drv,
            f,
            v_high * dsp_lf_gain,
            drv0_state.z_elec_ohm,
            drv0_state.displacement_m.norm() * v_scale,
            drv0_state.velocity_m_s.norm() * v_scale,
            port_u_rms,
            primary_port_geom,
            air,
        );

        let drv0_unc = &sol_unc.driver_states[0];
        let port_u_unc = aps_unc
            .iter()
            .enumerate()
            .find(|(_, a)| a.placement_idx == 0 && a.way_idx == 0 && a.is_port_or_mouth)
            .map(|(idx, _)| sol_unc.aperture_u[idx].norm() * v_scale)
            .unwrap_or(0.0);
        let nl_unc = evaluate_large_signal_point(
            primary_drv,
            f,
            v_high * dsp_lf_gain,
            drv0_unc.z_elec_ohm,
            drv0_unc.displacement_m.norm() * v_scale,
            drv0_unc.velocity_m_s.norm() * v_scale,
            port_u_unc,
            primary_port_geom,
            air,
        );

        let comp_atten = 10.0_f64.powf(-nl_pt.total_compression_db / 20.0);
        let net_high_offset_db = high_gain_db - nl_pt.total_compression_db;
        spl_high_drive_db.push(spl_sm + net_high_offset_db);
        spl_uncoupled_baseline_db.push(spl_unc_sm + high_gain_db - nl_unc.total_compression_db);
        for (w_idx, w_sm) in way_spl_sm.into_iter().enumerate() {
            per_way_spl_db[w_idx].1.push(w_sm + net_high_offset_db);
        }
        cone_excursion_mm.push(nl_pt.peak_excursion_mm);
        port_mach.push(nl_pt.port_mach);
        thd_percent.push(nl_pt.thd_percent);
        hd2_db_rel.push(nl_pt.hd2_db_rel);
        hd3_db_rel.push(nl_pt.hd3_db_rel);
        dc_shift_mm.push(nl_pt.dc_shift_mm);
        vc_temp_c.push(nl_pt.vc_temp_c);
        power_compression_db.push(nl_pt.total_compression_db);

        let u_high: Vec<Complex64> = sol_small
            .aperture_u
            .iter()
            .map(|&u| u * (v_scale * comp_atten))
            .collect();
        solved_history.push((aps, u_high));
    }

    // Unwrap phase (removing bulk time-of-flight `r / c` so excess crossover/box phase is crisp!) & group delay
    let bulk_tof_s = compute_min_tof(&variant.placements, ref_mic, air.sound_speed_m_s);
    let mut excess_phases = Vec::with_capacity(freqs.len());
    for (i, &f) in freqs.iter().enumerate() {
        let ph = raw_phases_rad[i] + 2.0 * PI * f * bulk_tof_s;
        excess_phases.push(ph);
    }
    for i in 1..excess_phases.len() {
        let mut d = excess_phases[i] - excess_phases[i - 1];
        while d > PI {
            d -= 2.0 * PI;
        }
        while d < -PI {
            d += 2.0 * PI;
        }
        excess_phases[i] = excess_phases[i - 1] + d;
    }
    let phase_deg: Vec<f64> = excess_phases.iter().map(|p| p.to_degrees()).collect();
    let mut group_delay_ms = vec![0.0; freqs.len()];
    for i in 0..freqs.len() {
        let i0 = i.saturating_sub(1);
        let i1 = (i + 1).min(freqs.len() - 1);
        let dw = 2.0 * PI * (freqs[i1] - freqs[i0]).max(1.0e-6);
        let dphi = excess_phases[i1] - excess_phases[i0];
        group_delay_ms[i] = (-dphi / dw * 1000.0).clamp(-15.0, 80.0);
    }

    // 2. Compute ANSI/CTA-2034-A Spinorama + 3D Spherical Balloons (with Tier-2 3D Burton-Miller BEM fusion!)
    let (spinorama, directivity) = compute_spinorama_and_3d_balloons(
        spec,
        variant,
        first_cab,
        bem_meshes.get(first_cab.id.as_str()),
        freqs,
        &solved_history,
        air,
    )?;

    // 3. Compute 2D Spatial SPL + Wave-Phase Slices & Time-Domain EDM Kick Wavefront Movie!
    let spatial_field = compute_spatial_and_transient_fields(
        spec,
        variant,
        cabinets_map,
        &dsp_map,
        freqs,
        &solved_history,
        air,
    );

    // 4. Compute Listener Zone Scorecards (Dancefloor uniformity, Stage quietness, Open-field range!)
    let zone_metrics = compute_zone_metrics(&spec.zones, &variant.boundary, freqs, &solved_history, air);

    // 5. Synthesize 48 kHz Virtual-Mic FIR Impulse Responses for live WebAudio listening!
    let virtual_mics = build_virtual_mic_impulses(
        spec,
        variant,
        freqs,
        &solved_history,
        &ref_mic_phasors,
        air,
    );

    let curves = VariantSweepCurves {
        freqs_hz: freqs.to_vec(),
        spl_small_signal_db,
        spl_high_drive_db,
        spl_uncoupled_baseline_db,
        phase_deg,
        group_delay_ms,
        per_way_spl_db,
        impedance_mag_ohm,
        impedance_phase_deg,
        normalized_radiation_resistance,
        cone_excursion_mm,
        xmax_limit_mm: primary_drv.small_signal.xmax_m * 1000.0,
        port_mach,
        thd_percent,
        hd2_db_rel,
        hd3_db_rel,
        dc_shift_mm,
        vc_temp_c,
        power_compression_db,
        dsp_mag_db,
    };

    Ok(SimulatedVariant {
        variant_id: variant.variant_id.clone(),
        label: variant.label.clone(),
        summary: variant.summary.clone(),
        placements: variant.placements.clone(),
        curves,
        spinorama,
        directivity,
        spatial_field,
        zone_metrics,
        virtual_mics,
    })
}

fn extract_port_or_throat_geom(enc: &WayEnclosure) -> Option<(f64, f64)> {
    match enc {
        WayEnclosure::Vented { port, .. } => Some((port.area_m2, port.flare_radius_m)),
        WayEnclosure::FoldedHorn { segments, .. } => segments
            .first()
            .map(|s| (s.throat_area_m2, 0.04)),
        WayEnclosure::TappedHorn { throat_to_tap, .. } => throat_to_tap
            .first()
            .map(|s| (s.throat_area_m2, 0.03)),
        WayEnclosure::CardioidSlot { port: Some(p), .. } => Some((p.area_m2, p.flare_radius_m)),
        _ => None,
    }
}

fn compute_min_tof(
    placements: &[acoustics_types::PlacedCabinet],
    mic: Point3,
    c: f64,
) -> f64 {
    placements
        .iter()
        .map(|p| p.transform.position.dist(mic) / c)
        .fold(f64::INFINITY, f64::min)
}

/// Evaluate CTA-2034-A Spinorama [Ref #31], H/V polar sonograms, and 3D spherical balloons,
/// fusing exact **3D Burton-Miller BEM** diffraction & waveguide radiation on key frequencies!
fn compute_spinorama_and_3d_balloons(
    spec: &SystemDesignSpec,
    variant: &SceneVariantSpec,
    primary_cab: &SpeakerCabinetSpec,
    bem_mesh: Option<&acoustics_types::AcousticSurfaceMesh>,
    freqs: &[f64],
    solved_history: &[(Vec<RadiatingAperture>, Vec<Complex64>)],
    air: &AirProperties,
) -> Result<(SpinoramaData, DirectivityBalloonData), AcousticsError> {
    // Center the polar measurement sphere on the array centroid (or primary speaker acoustic center)
    let center = compute_array_acoustic_center(&variant.placements, primary_cab);
    let r_meas = if variant.placements.len() > 1 {
        12.0 // Array far-field balloon radius
    } else {
        2.0 // Standard CTA-2034 2.0 m measurement radius!
    };
    // ForSpinorama of studio monitors, evaluate in free-field `Free4Pi` around speaker axis;
    // for ground-stacked sub arrays, evaluate on upper hemisphere above ground!
    let eval_bound = if matches!(variant.boundary, BoundaryEnvironment::Free4Pi | BoundaryEnvironment::StudioFrontWall { .. }) {
        BoundaryEnvironment::Free4Pi
    } else {
        BoundaryEnvironment::RigidGround2Pi
    };
    let fwd = variant.placements[0].transform.forward_axis();
    let up = Vec3::Z;
    let right = fwd.cross(up).normalized();
    let real_up = right.cross(fwd).normalized();

    let angles_deg: Vec<f64> = (-18..=18).map(|k| (k * 10) as f64).collect(); // -180 .. +180 in 10-deg steps

    // If single-cabinet design & 3D BEM enabled, run real 3D Burton-Miller BEM at 8 anchor frequencies
    // (`80 .. 4000 Hz`, where cabinet edge diffraction & OS-SE waveguide beaming dominate!)
    let mut bem_diffraction_h: Vec<(f64, Vec<f64>)> = Vec::new();
    let mut solver_method = "Coupled MNA + Rayleigh-Pritchard 3D Array Radiation".to_string();

    if let (true, Some(mesh)) = (variant.placements.len() == 1 && spec.settings.enable_3d_bem, bem_mesh) {
        solver_method =
            "3D Burton-Miller BEM (Cabinet Diffraction + OS-SE Waveguide) + Coupled MNA".into();
        let bem_targets = [90.0, 160.0, 280.0, 500.0, 900.0, 1600.0, 2800.0];
        let local_center = Point3::new(0.0, 0.0, 0.55 * primary_cab.dims_m[2]);

        for &fb in &bem_targets {
            if fb < freqs[0] || fb > *freqs.last().unwrap_or(&20000.0) {
                continue;
            }
            // Find nearest solved frequency index to get actual MNA diaphragm velocities!
            let f_idx = nearest_freq_index(freqs, fb);
            let (aps, u_vec) = &solved_history[f_idx];
            let mut way_vels = vec![Complex64::new(0.0, 0.0); primary_cab.ways.len()];
            for (m, ap) in aps.iter().enumerate() {
                if !ap.is_port_or_mouth && ap.way_idx < way_vels.len() {
                    way_vels[ap.way_idx] = u_vec[m] / ap.area_m2.max(1.0e-5);
                }
            }
            if let Ok(bem_sol) = solve_exterior_burton_miller(mesh, &way_vels, fb, air, false) {
                let p_on = evaluate_bem_exterior_pressure(
                    Point3::new(0.0, 2.0, local_center.z),
                    &bem_sol,
                    air,
                )
                .norm()
                .max(1.0e-12);
                let mut rel_curve = Vec::with_capacity(angles_deg.len());
                for &ang in &angles_deg {
                    let rad = ang.to_radians();
                    // Local +Y is forward (`ang = 0`), +X is right (`ang = +90`)
                    let obs_local = Point3::new(
                        2.0 * rad.sin(),
                        2.0 * rad.cos(),
                        local_center.z,
                    );
                    let p_ang = evaluate_bem_exterior_pressure(obs_local, &bem_sol, air).norm();
                    rel_curve.push((20.0 * (p_ang.max(1e-12) / p_on).log10()).clamp(-36.0, 6.0));
                }
                bem_diffraction_h.push((fb, rel_curve));
            }
        }
    }

    let mut on_axis_db = Vec::with_capacity(freqs.len());
    let mut listening_window_db = Vec::with_capacity(freqs.len());
    let mut early_reflections_db = Vec::with_capacity(freqs.len());
    let mut sound_power_db = Vec::with_capacity(freqs.len());
    let mut directivity_index_db = Vec::with_capacity(freqs.len());
    let mut erdi_db = Vec::with_capacity(freqs.len());
    let mut horizontal_spl_db = Vec::with_capacity(freqs.len());
    let mut vertical_spl_db = Vec::with_capacity(freqs.len());

    for (f_idx, &f) in freqs.iter().enumerate() {
        let (aps, u_vec) = &solved_history[f_idx];
        let mut h_row = Vec::with_capacity(angles_deg.len());
        let mut v_row = Vec::with_capacity(angles_deg.len());

        let bem_mod = interpolate_bem_polar(&bem_diffraction_h, f, angles_deg.len());

        for (a_idx, &ang_deg) in angles_deg.iter().enumerate() {
            let rad = ang_deg.to_radians();
            // Horizontal orbit
            let dir_h = fwd.scale(rad.cos()).add(right.scale(rad.sin()));
            let obs_h = center.add_vec(dir_h.scale(r_meas));
            let obs_h_clamped = if !matches!(eval_bound, BoundaryEnvironment::Free4Pi) {
                Point3::new(obs_h.x, obs_h.y, obs_h.z.max(0.25))
            } else {
                obs_h
            };
            let ph = evaluate_field_pressure(obs_h_clamped, aps, u_vec, &eval_bound, f, air, None);
            let mut spl_h = pa_to_spl_db(ph.norm());

            // Vertical orbit
            let dir_v = fwd.scale(rad.cos()).add(real_up.scale(rad.sin()));
            let obs_v = center.add_vec(dir_v.scale(r_meas));
            let obs_v_clamped = if !matches!(eval_bound, BoundaryEnvironment::Free4Pi) {
                Point3::new(obs_v.x, obs_v.y, obs_v.z.max(0.15))
            } else {
                obs_v
            };
            let pv = evaluate_field_pressure(obs_v_clamped, aps, u_vec, &eval_bound, f, air, None);
            let spl_v = pa_to_spl_db(pv.norm());

            // Fuse 3D BEM cabinet edge diffraction ripple & waveguide off-axis contour (`60..2800 Hz`)!
            if let Some(ref b_curve) = bem_mod {
                // Blend 35% BEM edge-diffraction detail onto normalized off-axis curve
                let on_idx = angles_deg.len() / 2;
                let bem_rel = b_curve[a_idx] - b_curve[on_idx];
                // Subtle physical baffle-diffraction correction (`+-2.5 dB`)
                let diff_ripple = (0.22 * bem_rel).clamp(-3.5, 2.5);
                if a_idx != on_idx {
                    spl_h += diff_ripple * 0.45;
                }
            }

            h_row.push(spl_h as f32);
            v_row.push(spl_v as f32);
        }

        let center_idx = angles_deg.len() / 2; // 0 deg on-axis!
        let on_ax = h_row[center_idx] as f64;
        on_axis_db.push(on_ax);

        // CTA-2034-A power averages [Ref #31]:
        // Listening Window: H +-10, +-20, +-30 deg & V +-10 deg
        let lw_indices_h = [center_idx - 3, center_idx - 2, center_idx - 1, center_idx, center_idx + 1, center_idx + 2, center_idx + 3];
        let lw_indices_v = [center_idx - 1, center_idx + 1];
        let mut lw_pow = 0.0;
        for &i in &lw_indices_h {
            lw_pow += 10.0_f64.powf(h_row[i] as f64 / 10.0);
        }
        for &i in &lw_indices_v {
            lw_pow += 10.0_f64.powf(v_row[i] as f64 / 10.0);
        }
        let lw_db = 10.0 * (lw_pow / 9.0).log10();
        listening_window_db.push(lw_db);

        // Early Reflections: Front/Side/Rear H (`+-40..+-90`, `+-150..180`) + Floor (`-20..-40`) + Ceiling (`+40..+60`)
        let mut er_pow = 0.0_f64;
        let mut er_n = 0.0_f64;
        for (i, &ang) in angles_deg.iter().enumerate() {
            let a = ang.abs();
            if (40.0..=90.0).contains(&a) || a >= 150.0 {
                er_pow += 10.0_f64.powf(h_row[i] as f64 / 10.0);
                er_n += 1.0;
            }
            if (-40.0..=-20.0).contains(&ang) || (40.0..=60.0).contains(&ang) {
                er_pow += 10.0_f64.powf(v_row[i] as f64 / 10.0);
                er_n += 1.0;
            }
        }
        let er_db = 10.0 * (er_pow / er_n.max(1.0)).log10();
        early_reflections_db.push(er_db);

        // Spherical sin(theta)-weighted Sound Power across H & V orbits [Ref #31]:
        let mut sp_pow = 0.0;
        let mut sp_w = 0.0;
        for (i, &ang) in angles_deg.iter().enumerate() {
            let sin_w = ang.abs().to_radians().sin().max(0.08);
            sp_pow += sin_w * 0.5 * (10.0_f64.powf(h_row[i] as f64 / 10.0) + 10.0_f64.powf(v_row[i] as f64 / 10.0));
            sp_w += sin_w;
        }
        let sp_db = 10.0 * (sp_pow / sp_w.max(1.0e-6)).log10();
        sound_power_db.push(sp_db);
        directivity_index_db.push((lw_db - sp_db).clamp(-3.0, 22.0));
        erdi_db.push((lw_db - er_db).clamp(-3.0, 20.0));

        // Normalize sonograms relative to on-axis (`0 dB` = on-axis) for crisp contour reading!
        let norm_h: Vec<f32> = h_row.iter().map(|&v| (v - on_ax as f32).clamp(-36.0, 6.0)).collect();
        let norm_v: Vec<f32> = v_row.iter().map(|&v| (v - on_ax as f32).clamp(-36.0, 6.0)).collect();
        horizontal_spl_db.push(norm_h);
        vertical_spl_db.push(norm_v);
    }

    // 3D Spherical / Hemispherical Directivity Balloon at representative frequencies:
    // - Full 4*pi sphere (`theta: 0..180 deg`) in anechoic `Free4Pi` space
    // - True 2*pi upper hemisphere (`theta: 0..90 deg` in 5-deg steps, constant radius `r_meas` from ground origin)
    //   when a `z = 0` ground plane is present!
    let is_free_4pi = matches!(eval_bound, BoundaryEnvironment::Free4Pi);
    let target_balloon_freqs = [35.0, 63.0, 125.0, 250.0, 500.0, 1000.0, 2500.0, 8000.0];
    let mut balloon_freqs_hz = Vec::new();
    let theta_deg: Vec<f32> = if is_free_4pi {
        (0..=18).map(|i| (i * 10) as f32).collect()
    } else {
        (0..=18).map(|i| (i * 5) as f32).collect()
    };
    let phi_deg: Vec<f32> = (0..36).map(|i| (i * 10) as f32).collect();
    let mut balloon_spl_db = Vec::new();
    let balloon_origin = if is_free_4pi {
        center
    } else {
        Point3::new(center.x, center.y, 0.05)
    };

    for &tb in &target_balloon_freqs {
        if tb < freqs[0] * 0.95 || tb > *freqs.last().unwrap_or(&20000.0) * 1.05 {
            continue;
        }
        let f_idx = nearest_freq_index(freqs, tb);
        let f_actual = freqs[f_idx];
        if balloon_freqs_hz.last().copied() == Some(f_actual) {
            continue;
        }
        balloon_freqs_hz.push(f_actual);
        let (aps, u_vec) = &solved_history[f_idx];

        let mut grid = Vec::with_capacity(theta_deg.len() * phi_deg.len());
        for &th_d in &theta_deg {
            let th = (th_d as f64).to_radians();
            for &ph_d in &phi_deg {
                let ph = (ph_d as f64).to_radians();
                let dir = Vec3::new(th.sin() * ph.cos(), th.sin() * ph.sin(), th.cos());
                let obs = balloon_origin.add_vec(dir.scale(r_meas));
                let p = evaluate_field_pressure(obs, aps, u_vec, &eval_bound, f_actual, air, None);
                grid.push(pa_to_spl_db(p.norm()) as f32);
            }
        }
        balloon_spl_db.push(grid);
    }

    Ok((
        SpinoramaData {
            freqs_hz: freqs.to_vec(),
            on_axis_db,
            listening_window_db,
            early_reflections_db,
            sound_power_db,
            directivity_index_db,
            erdi_db,
        },
        DirectivityBalloonData {
            freqs_hz: freqs.to_vec(),
            angles_deg,
            horizontal_spl_db,
            vertical_spl_db,
            balloon_freqs_hz,
            theta_deg,
            phi_deg,
            balloon_spl_db,
            solver_method,
        },
    ))
}

fn interpolate_bem_polar(
    anchors: &[(f64, Vec<f64>)],
    f: f64,
    n_angles: usize,
) -> Option<Vec<f64>> {
    if anchors.is_empty() || f < anchors[0].0 * 0.7 || f > anchors.last()?.0 * 1.4 {
        return None;
    }
    if f <= anchors[0].0 {
        return Some(anchors[0].1.clone());
    }
    let last = anchors.len() - 1;
    if f >= anchors[last].0 {
        return Some(anchors[last].1.clone());
    }
    for i in 0..last {
        if f >= anchors[i].0 && f <= anchors[i + 1].0 {
            let t = (f.ln() - anchors[i].0.ln()) / (anchors[i + 1].0.ln() - anchors[i].0.ln());
            let out: Vec<f64> = (0..n_angles)
                .map(|k| anchors[i].1[k] * (1.0 - t) + anchors[i + 1].1[k] * t)
                .collect();
            return Some(out);
        }
    }
    None
}

fn compute_array_acoustic_center(
    placements: &[acoustics_types::PlacedCabinet],
    first_cab: &SpeakerCabinetSpec,
) -> Point3 {
    if placements.len() == 1 {
        let p = &placements[0];
        let z_mid = first_cab
            .ways
            .last()
            .map(|w| w.local_acoustic_offset.z)
            .unwrap_or(0.5 * first_cab.dims_m[2]);
        return p.transform.transform_point(Point3::new(0.0, 0.0, z_mid));
    }
    let n = placements.len() as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sz = 0.0;
    for pl in placements {
        sx += pl.transform.position.x;
        sy += pl.transform.position.y;
        sz += pl.transform.position.z + 0.5;
    }
    Point3::new(sx / n, sy / n, sz / n)
}

fn compute_spatial_and_transient_fields(
    spec: &SystemDesignSpec,
    variant: &SceneVariantSpec,
    cabinets_map: &HashMap<&str, &SpeakerCabinetSpec>,
    dsp_map: &HashMap<&str, &DspChannelSpec>,
    freqs: &[f64],
    solved_history: &[(Vec<RadiatingAperture>, Vec<Complex64>)],
    air: &AirProperties,
) -> SpatialFieldData {
    let [xmin, xmax, ymin, ymax] = spec.settings.field_bounds_m;
    let nx = spec.settings.field_grid_nx.clamp(16, 96);
    let ny = spec.settings.field_grid_ny.clamp(16, 96);
    let z_ear = spec.settings.listener_height_m;

    let targets = [35.0, 50.0, 70.0, 110.0, 250.0, 800.0, 2500.0, 6000.0];
    let mut slice_freqs_hz = Vec::new();
    let mut spl_slices_db = Vec::new();
    let mut wave_real_slices = Vec::new();

    for &tf in &targets {
        if tf < freqs[0] * 0.95 || tf > *freqs.last().unwrap_or(&20000.0) * 1.05 {
            continue;
        }
        let f_idx = nearest_freq_index(freqs, tf);
        let f_actual = freqs[f_idx];
        if slice_freqs_hz.last().copied() == Some(f_actual) {
            continue;
        }
        slice_freqs_hz.push(f_actual);
        let (aps, u_vec) = &solved_history[f_idx];

        let mut spl_grid = vec![0.0_f32; nx * ny];
        let mut wave_grid = vec![0.0_f32; nx * ny];

        for iy in 0..ny {
            let y = ymin + (ymax - ymin) * (iy as f64) / ((ny - 1).max(1) as f64);
            for ix in 0..nx {
                let x = xmin + (xmax - xmin) * (ix as f64) / ((nx - 1).max(1) as f64);
                let obs = Point3::new(x, y, z_ear);
                let p = evaluate_field_pressure(obs, aps, u_vec, &variant.boundary, f_actual, air, None);
                let mag = p.norm();
                spl_grid[iy * nx + ix] = pa_to_spl_db(mag) as f32;
                wave_grid[iy * nx + ix] = if mag > 1.0e-15 {
                    (p.re / mag) as f32
                } else {
                    0.0
                };
            }
        }
        spl_slices_db.push(spl_grid);
        wave_real_slices.push(wave_grid);
    }

    // Extract transient sources per placed cabinet way for EDM kick wavefront movie!
    let mut sources = Vec::new();
    for pl in &variant.placements {
        if let Some(&cab) = cabinets_map.get(pl.cabinet_spec_id.as_str()) {
            let way0 = &cab.ways[0];
            let dsp = pl
                .way_dsp_channels
                .first()
                .and_then(|id| dsp_map.get(id.as_str()))
                .copied();
            let delay_s = dsp.map(|d| d.delay_s).unwrap_or(0.0);
            let pol = if dsp.map(|d| d.invert_polarity).unwrap_or(false) {
                -1.0
            } else {
                1.0
            };
            let gain = pol * 10.0_f64.powf(dsp.map(|d| d.gain_db).unwrap_or(0.0) / 20.0);
            let is_top = dsp
                .and_then(|d| d.highpass.as_ref())
                .map(|hp| match hp {
                    acoustics_types::CrossoverFilter::Butterworth { freq_hz, .. }
                    | acoustics_types::CrossoverFilter::LinkwitzRiley { freq_hz, .. }
                    | acoustics_types::CrossoverFilter::Bessel { freq_hz, .. } => *freq_hz >= 75.0,
                })
                .unwrap_or(false);
            let pos = pl.transform.transform_point(Point3::new(
                way0.local_acoustic_offset.x,
                0.5 * cab.dims_m[1],
                way0.local_acoustic_offset.z,
            ));
            sources.push((pos, pl.transform.forward_axis(), delay_s, gain, is_top));
        }
    }

    let (transient_times_ms, transient_frames) = compute_transient_wavefront_frames(
        &sources,
        spec.settings.field_bounds_m,
        nx,
        ny,
        z_ear,
        &variant.boundary,
        air,
        28,
    );

    SpatialFieldData {
        bounds_m: spec.settings.field_bounds_m,
        nx,
        ny,
        z_ear_m: z_ear,
        slice_freqs_hz,
        spl_slices_db,
        wave_real_slices,
        transient_times_ms,
        transient_frames,
    }
}

fn compute_zone_metrics(
    zones: &[ListenerZone],
    boundary: &BoundaryEnvironment,
    freqs: &[f64],
    solved_history: &[(Vec<RadiatingAperture>, Vec<Complex64>)],
    air: &AirProperties,
) -> Vec<ZoneMetrics> {
    let bass_indices: Vec<usize> = [35.0, 45.0, 55.0, 68.0, 80.0]
        .iter()
        .map(|&f| nearest_freq_index(freqs, f))
        .collect();
    let mid_indices: Vec<usize> = [180.0, 450.0, 1200.0, 3200.0, 6500.0]
        .iter()
        .filter(|&&f| f <= *freqs.last().unwrap_or(&200.0))
        .map(|&f| nearest_freq_index(freqs, f))
        .collect();

    let mut out = Vec::with_capacity(zones.len());
    for z in zones {
        let gx = 9usize;
        let gy = 9usize;
        let mut coords = Vec::with_capacity(gx * gy);
        for iy in 0..gy {
            let y = z.y_min_m + (z.y_max_m - z.y_min_m) * (iy as f64 + 0.5) / (gy as f64);
            for ix in 0..gx {
                let x = z.x_min_m + (z.x_max_m - z.x_min_m) * (ix as f64 + 0.5) / (gx as f64);
                coords.push(Point3::new(x, y, z.z_ear_m));
            }
        }

        // Evaluate per-note spatial mean, std, and min-max spread so standing-wave comb dead spots
        // on individual sustained bass notes are measured faithfully (not washed out by broadband averaging)!
        let band_stats = |indices: &[usize]| -> (f64, f64, f64) {
            if indices.is_empty() {
                return (0.0, 0.0, 0.0);
            }
            let mut sum_mean = 0.0;
            let mut sum_std = 0.0;
            let mut sum_spread = 0.0;
            for &fi in indices {
                let (aps, u) = &solved_history[fi];
                let pts: Vec<f64> = coords
                    .iter()
                    .map(|&obs| {
                        let p = evaluate_field_pressure(obs, aps, u, boundary, freqs[fi], air, None);
                        pa_to_spl_db(p.norm())
                    })
                    .collect();
                let (m, s, sp) = stats_db(&pts);
                sum_mean += m;
                sum_std += s;
                sum_spread += sp;
            }
            let nf = indices.len() as f64;
            (sum_mean / nf, sum_std / nf, sum_spread / nf)
        };

        let (bass_mean, bass_std, bass_spread) = band_stats(&bass_indices);
        let (mid_mean, mid_std, _) = if mid_indices.is_empty() {
            (bass_mean, bass_std, 0.0)
        } else {
            band_stats(&mid_indices)
        };

        out.push(ZoneMetrics {
            zone_id: z.id.clone(),
            label: z.label.clone(),
            role: z.role.clone(),
            bass_mean_spl_db: bass_mean,
            bass_spatial_std_db: bass_std,
            bass_min_max_spread_db: bass_spread,
            mid_high_mean_spl_db: mid_mean,
            mid_high_spatial_std_db: mid_std,
        });
    }
    out
}

fn stats_db(vals: &[f64]) -> (f64, f64, f64) {
    if vals.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let n = vals.len() as f64;
    let mean = vals.iter().sum::<f64>() / n;
    let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    let min_v = vals.iter().copied().fold(f64::INFINITY, f64::min);
    let max_v = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (mean, var.sqrt(), max_v - min_v)
}

fn build_virtual_mic_impulses(
    spec: &SystemDesignSpec,
    variant: &SceneVariantSpec,
    freqs: &[f64],
    solved_history: &[(Vec<RadiatingAperture>, Vec<Complex64>)],
    ref_phasors: &[Complex64],
    air: &AirProperties,
) -> Vec<VirtualMicImpulse> {
    let fs = 48_000u32;
    let n_taps = 2048usize;

    let mut spots: Vec<(String, [f64; 3])> = vec![(
        "Sweet-Spot Reference".into(),
        spec.settings.reference_mic_m,
    )];

    for z in &spec.zones {
        if z.role == "sweet_spot" {
            // Add an off-center spot 3.2 m diagonally from sweet-spot center to hear comb filtering (or uniformity!)
            let ox = z.x_min_m + 0.72 * (z.x_max_m - z.x_min_m);
            let oy = z.y_min_m + 0.68 * (z.y_max_m - z.y_min_m);
            spots.push(("Off-Center Dancefloor (+3.2m)".into(), [ox, oy, z.z_ear_m]));
        } else if z.role == "stage_quiet" {
            let cx = 0.5 * (z.x_min_m + z.x_max_m);
            let cy = 0.5 * (z.y_min_m + z.y_max_m);
            spots.push(("DJ Booth / Behind Sub Stack".into(), [cx, cy, z.z_ear_m]));
        } else if z.role == "far_range" {
            let cx = 0.5 * (z.x_min_m + z.x_max_m);
            let cy = 0.5 * (z.y_min_m + z.y_max_m);
            spots.push(("Far-Field Lounge Zone".into(), [cx, cy, z.z_ear_m]));
        }
    }

    // Calibrate relative loudness against reference sweet spot so DJ-booth attenuation is genuinely audible!
    let ref_rms = (ref_phasors.iter().map(|z| z.norm_sqr()).sum::<f64>()
        / ref_phasors.len().max(1) as f64)
        .sqrt()
        .max(1.0e-9);

    let mut out = Vec::with_capacity(spots.len());
    for (idx, (label, pos)) in spots.into_iter().enumerate() {
        let pt = Point3::from(pos);
        let tof = compute_min_tof(&variant.placements, pt, air.sound_speed_m_s);
        let mut h_spot = Vec::with_capacity(freqs.len());

        for (fi, &f) in freqs.iter().enumerate() {
            let p_raw = if idx == 0 {
                ref_phasors[fi]
            } else {
                let (aps, u) = &solved_history[fi];
                evaluate_field_pressure(pt, aps, u, &variant.boundary, f, air, None)
            };
            // Strip bulk arrival TOF so FIR fits cleanly inside 2048 taps while preserving inter-cabinet interference!
            let de_delayed = p_raw * Complex64::from_polar(1.0, 2.0 * PI * f * tof);
            h_spot.push(de_delayed / ref_rms);
        }

        let mut taps = transfer_function_to_fir(freqs, &h_spot, fs, n_taps);
        let spot_rms = (h_spot.iter().map(|z| z.norm_sqr()).sum::<f64>() / h_spot.len() as f64).sqrt();
        let target_peak = (0.75 * spot_rms.min(1.3)) as f32;
        let cur_peak = taps.iter().map(|v| v.abs()).fold(0.0_f32, f32::max).max(1.0e-6);
        let gain = target_peak / cur_peak;
        for v in &mut taps {
            *v *= gain;
        }

        out.push(VirtualMicImpulse {
            label,
            position_m: pos,
            sample_rate_hz: fs,
            taps,
        });
    }
    out
}

fn nearest_freq_index(freqs: &[f64], target: f64) -> usize {
    freqs
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            ((**a / target).ln().abs()).total_cmp(&((**b / target).ln().abs()))
        })
        .map(|(i, _)| i)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_presets_toml_roundtrip_and_flagship_physics_invariants() {
        let designs = builtin_designs();
        assert_eq!(designs.len(), 10);
        for d in &designs {
            let encoded = toml::to_string_pretty(d).expect("serialize design TOML");
            let decoded: SystemDesignSpec = toml::from_str(&encoded).expect("parse design TOML");
            assert_eq!(decoded.id, d.id);
            assert_eq!(decoded.variants.len(), d.variants.len());
        }

        // Verify Oasis-360 open-field EDM system beats naive 4-corner distributed subs in bass SPL & spatial uniformity!
        let mut oasis = designs[3].clone();
        oasis.settings.num_freqs = 32;
        oasis.settings.field_grid_nx = 24;
        oasis.settings.field_grid_ny = 24;
        let bundle = run_system_simulation(&oasis).expect("simulate Oasis-360");
        let v_prop = &bundle.variants[0];
        let v_naive = &bundle.variants[1];
        assert!(
            v_prop.zone_metrics[0].bass_mean_spl_db
                > v_naive.zone_metrics[0].bass_mean_spl_db + 5.0
        );
        assert!(
            v_prop.zone_metrics[0].bass_spatial_std_db + 1.5
                < v_naive.zone_metrics[0].bass_spatial_std_db
        );

        // Verify IsoPulse-212 Linkwitz Transform boosts 22 Hz output by > 10 dB over raw sealed box!
        let mut iso = designs[7].clone();
        iso.settings.num_freqs = 36;
        iso.settings.enable_3d_bem = false;
        iso.settings.field_grid_nx = 18;
        iso.settings.field_grid_ny = 18;
        let iso_bundle = run_system_simulation(&iso).expect("simulate IsoPulse-212");
        let idx_22 = nearest_freq_index(&iso_bundle.variants[0].curves.freqs_hz, 22.0);
        assert!(
            iso_bundle.variants[0].curves.spl_small_signal_db[idx_22]
                > iso_bundle.variants[1].curves.spl_small_signal_db[idx_22] + 9.0
        );

        // Verify End-Fire 4-deep sub line beats unsteered Broadside Wall in DJ-stage quietness!
        let mut ef = designs[9].clone();
        ef.settings.num_freqs = 32;
        ef.settings.field_grid_nx = 22;
        ef.settings.field_grid_ny = 22;
        let ef_bundle = run_system_simulation(&ef).expect("simulate End-Fire vs CSA");
        assert!(
            ef_bundle.variants[0].zone_metrics[1].bass_mean_spl_db + 8.0
                < ef_bundle.variants[2].zone_metrics[1].bass_mean_spl_db
        );

        // Verify Parametric Engine live edit round-trip on Keystone-18TH Tapped Horn!
        let keystone = &designs[6];
        let base = extract_parametric_baseline(keystone, 0, 2);
        assert_eq!(base.topology, "tapped_horn");
        let patch = ParametricPatch {
            cabinet_idx: 0,
            variant_idx: 2,
            width_mm: base.width_mm + 80.0,
            depth_mm: base.depth_mm,
            height_mm: base.height_mm,
            edge_round_mm: base.edge_round_mm,
            enclosure_material: acoustics_types::PanelMaterialKind::CastAluminum6061,
            baffle_material: acoustics_types::PanelMaterialKind::CastAluminum6061,
            wall_thickness_mm: 24.0,
            baffle_thickness_mm: 30.0,
            brace_count: 4,
            joinery: base.joinery,
            chamber_volume_scale: 1.0,
            port_length_mm: base.port_length_mm,
            port_area_cm2: base.port_area_cm2,
            port_flare_mm: base.port_flare_mm,
            horn_length_scale: 1.15,
            horn_mouth_scale: 1.20,
            slot_area_cm2: base.slot_area_cm2,
            slot_path_mm: base.slot_path_mm,
            slot_flow_resistivity: base.slot_flow_resistivity,
            lt_target_fp_hz: base.lt_target_fp_hz,
            lt_target_qp: base.lt_target_qp,
            motor_bl_scale: 1.05,
            moving_mass_scale: 1.0,
            high_spl_volts_rms: 75.0,
            lf_gain_trim_db: 1.5,
            crossover_scale: 1.0,
            sub_delay_trim_ms: 0.0,
            array_spacing_scale: 1.0,
            include_3d_bem: false,
        };
        let out = simulate_parametric_edit(keystone, &patch).expect("simulate parametric edit");
        assert_eq!(
            out.simulated_variant.curves.freqs_hz.len(),
            keystone.settings.num_freqs
        );
        assert!(out.cabinet_models[0].structural.wall_thickness_mm > 23.5);
        assert!(!out.modified_toml.is_empty());

        // Verify JSON serde enum strings match TypeScript PanelMaterialKind / JoineryKind 1:1!
        assert_eq!(
            serde_json::to_string(&acoustics_types::PanelMaterialKind::BalticBirch13Ply).unwrap(),
            "\"baltic_birch13_ply\""
        );
        assert_eq!(
            serde_json::to_string(&acoustics_types::PanelMaterialKind::CastAluminum6061).unwrap(),
            "\"cast_aluminum6061\""
        );
        assert_eq!(
            serde_json::to_string(&acoustics_types::JoineryKind::Miter45).unwrap(),
            "\"miter45\""
        );
    }
}
