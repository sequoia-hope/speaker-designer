//! Live Parametric Speaker & Sound-System Design Modifier (`speaker-engine::parametric`).
//!
//! Bridges interactive parametric sliders (dimensions, panel materials, wall/baffle thicknesses,
//! bracing, port/horn/cardioid/Linkwitz-Transform tuning, driver motor `Bl`/`M_ms`, DSP crossover
//! & delay, and multi-speaker array spacing) directly into `SystemDesignSpec` and the multi-tier
//! Rust simulation & 3D solid-CAD engine.

use crate::run_system_simulation;
use acoustics_types::{
    AcousticsError, BiquadStage, CrossoverFilter, JoineryKind, PanelMaterialKind,
    PanelMaterialSpec, SimulatedVariant, SpeakerCabinetSpec, SystemDesignSpec, VisualCabinetModel,
    WayEnclosure,
};
use serde::{Deserialize, Serialize};

/// Baseline physical parameters extracted from a `SystemDesignSpec` cabinet + scene variant
/// to initialize the Parametric Design Studio controls accurately.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParametricBaselineInfo {
    pub design_id: String,
    pub cabinet_idx: usize,
    pub cabinet_id: String,
    pub cabinet_name: String,
    pub variant_idx: usize,
    pub variant_label: String,
    /// `"sealed"` | `"vented"` | `"folded_horn"` | `"tapped_horn"` | `"cardioid_slot"` | `"waveguide_loaded"`
    pub topology: String,
    pub has_linkwitz_transform: bool,
    pub placement_count: usize,

    // 1. Exterior Geometry & Construction
    pub width_mm: f64,
    pub depth_mm: f64,
    pub height_mm: f64,
    pub edge_round_mm: f64,
    pub enclosure_material: PanelMaterialKind,
    pub baffle_material: PanelMaterialKind,
    pub wall_thickness_mm: f64,
    pub baffle_thickness_mm: f64,
    pub brace_count: usize,
    pub joinery: JoineryKind,

    // 2. Topology-Specific Acoustic Loading
    pub base_chamber_liters: f64,
    pub port_length_mm: f64,
    pub port_area_cm2: f64,
    pub port_flare_mm: f64,
    pub horn_path_length_m: f64,
    pub horn_mouth_area_cm2: f64,
    pub slot_area_cm2: f64,
    pub slot_path_mm: f64,
    pub slot_flow_resistivity: f64,
    pub lt_target_fp_hz: f64,
    pub lt_target_qp: f64,

    // 3. Primary Transducer, Drive & Array/DSP
    pub primary_driver_name: String,
    pub primary_bl_tm: f64,
    pub primary_mms_g: f64,
    pub high_spl_volts_rms: f64,
}

/// Interactive parametric edits applied onto a `SystemDesignSpec`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParametricPatch {
    pub cabinet_idx: usize,
    pub variant_idx: usize,

    // 1. Exterior Geometry & Construction
    pub width_mm: f64,
    pub depth_mm: f64,
    pub height_mm: f64,
    pub edge_round_mm: f64,
    pub enclosure_material: PanelMaterialKind,
    pub baffle_material: PanelMaterialKind,
    pub wall_thickness_mm: f64,
    pub baffle_thickness_mm: f64,
    pub brace_count: usize,
    pub joinery: JoineryKind,

    // 2. Topology-Specific Acoustic Loading
    /// Multiplier on auto-scaled net chamber volume (`1.0` = track physical box interior).
    pub chamber_volume_scale: f64,
    pub port_length_mm: f64,
    pub port_area_cm2: f64,
    pub port_flare_mm: f64,
    pub horn_length_scale: f64,
    pub horn_mouth_scale: f64,
    pub slot_area_cm2: f64,
    pub slot_path_mm: f64,
    pub slot_flow_resistivity: f64,
    pub lt_target_fp_hz: f64,
    pub lt_target_qp: f64,

    // 3. Transducer, Drive & Active DSP / Array
    pub motor_bl_scale: f64,
    pub moving_mass_scale: f64,
    pub high_spl_volts_rms: f64,
    pub lf_gain_trim_db: f64,
    pub crossover_scale: f64,
    pub sub_delay_trim_ms: f64,
    pub array_spacing_scale: f64,

    /// When `false` (default interactive mode), skips 3D BEM matrix solve for ~30 ms live turnaround;
    /// when `true`, runs full 3D Burton–Miller BEM cabinet diffraction & waveguide solve!
    #[serde(default)]
    pub include_3d_bem: bool,
}

/// Result returned to the browser from a live WASM parametric simulation run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParametricSimulationOutput {
    pub high_spl_volts_rms: f64,
    pub cabinet_models: Vec<VisualCabinetModel>,
    pub simulated_variant: SimulatedVariant,
    pub modified_toml: String,
}

fn clear_interior_vol_m3(dims_m: [f64; 3], wall_t_m: f64, baffle_t_m: f64) -> f64 {
    let iw = (dims_m[0] - 2.0 * wall_t_m).max(0.08);
    let id = (dims_m[1] - wall_t_m - baffle_t_m).max(0.08);
    let ih = (dims_m[2] - 2.0 * wall_t_m).max(0.08);
    iw * id * ih
}

/// Extract exact physical baseline parameters for `cabinet_idx` and `variant_idx`.
pub fn extract_parametric_baseline(
    spec: &SystemDesignSpec,
    cabinet_idx: usize,
    variant_idx: usize,
) -> ParametricBaselineInfo {
    let c_idx = cabinet_idx.min(spec.cabinets.len().saturating_sub(1));
    let v_idx = variant_idx.min(spec.variants.len().saturating_sub(1));
    let cab = &spec.cabinets[c_idx];
    let var = &spec.variants[v_idx];
    let way0 = &cab.ways[0];
    let drv0 = spec.drivers.iter().find(|d| d.id == way0.driver_id);

    let topology: String;
    let base_chamber_liters: f64;
    let mut port_length_mm = 260.0;
    let mut port_area_cm2 = 180.0;
    let mut port_flare_mm = 18.0;
    let mut horn_path_length_m = 2.20;
    let mut horn_mouth_area_cm2 = 4200.0;
    let mut slot_area_cm2 = 160.0;
    let mut slot_path_mm = 190.0;
    let mut slot_flow_resistivity = 14_500.0;

    match &way0.enclosure {
        WayEnclosure::Sealed { volume_m3, .. } => {
            topology = "sealed".into();
            base_chamber_liters = volume_m3 * 1000.0;
        }
        WayEnclosure::Vented {
            volume_m3, port, ..
        } => {
            topology = "vented".into();
            base_chamber_liters = volume_m3 * 1000.0;
            port_length_mm = port.length_m * 1000.0;
            port_area_cm2 = port.area_m2 * 10_000.0;
            port_flare_mm = port.flare_radius_m * 1000.0;
        }
        WayEnclosure::FoldedHorn {
            rear_volume_m3,
            segments,
            ..
        } => {
            topology = "folded_horn".into();
            base_chamber_liters = rear_volume_m3 * 1000.0;
            horn_path_length_m = segments.iter().map(|s| s.length_m).sum();
            horn_mouth_area_cm2 = segments
                .last()
                .map(|s| s.mouth_area_m2 * 10_000.0)
                .unwrap_or(4500.0);
        }
        WayEnclosure::TappedHorn {
            throat_to_tap,
            tap_to_mouth,
            ..
        } => {
            topology = "tapped_horn".into();
            horn_path_length_m = throat_to_tap
                .iter()
                .chain(tap_to_mouth.iter())
                .map(|s| s.length_m)
                .sum();
            horn_mouth_area_cm2 = tap_to_mouth
                .last()
                .map(|s| s.mouth_area_m2 * 10_000.0)
                .unwrap_or(3850.0);
            base_chamber_liters = clear_interior_vol_m3(
                cab.dims_m,
                cab.construction.wall_thickness_m,
                cab.construction.front_baffle_thickness_m,
            ) * 1000.0;
        }
        WayEnclosure::CardioidSlot {
            internal_volume_m3,
            slot_area_m2,
            slot_path_m,
            slot_flow_resistivity: sigma,
            port,
        } => {
            topology = "cardioid_slot".into();
            base_chamber_liters = internal_volume_m3 * 1000.0;
            slot_area_cm2 = slot_area_m2 * 10_000.0;
            slot_path_mm = slot_path_m * 1000.0;
            slot_flow_resistivity = *sigma;
            if let Some(p) = port {
                port_length_mm = p.length_m * 1000.0;
                port_area_cm2 = p.area_m2 * 10_000.0;
                port_flare_mm = p.flare_radius_m * 1000.0;
            }
        }
        WayEnclosure::WaveguideLoaded {
            rear_volume_m3,
            waveguide,
            ..
        } => {
            topology = "waveguide_loaded".into();
            base_chamber_liters = rear_volume_m3 * 1000.0;
            horn_path_length_m = waveguide.length_m;
            horn_mouth_area_cm2 = waveguide.mouth_area_m2 * 10_000.0;
        }
    }

    let mut has_linkwitz_transform = false;
    let mut lt_target_fp_hz = 22.0;
    let mut lt_target_qp = 0.707;
    for ch in &var.dsp_channels {
        for st in &ch.stages {
            if let BiquadStage::LinkwitzTransform { fp_hz, qp, .. } = st {
                has_linkwitz_transform = true;
                lt_target_fp_hz = *fp_hz;
                lt_target_qp = *qp;
            }
        }
    }

    ParametricBaselineInfo {
        design_id: spec.id.clone(),
        cabinet_idx: c_idx,
        cabinet_id: cab.id.clone(),
        cabinet_name: cab.name.clone(),
        variant_idx: v_idx,
        variant_label: var.label.clone(),
        topology,
        has_linkwitz_transform,
        placement_count: var.placements.len(),
        width_mm: (cab.dims_m[0] * 1000.0).round(),
        depth_mm: (cab.dims_m[1] * 1000.0).round(),
        height_mm: (cab.dims_m[2] * 1000.0).round(),
        edge_round_mm: (cab.edge_round_m * 1000.0).round(),
        enclosure_material: cab.construction.enclosure_material.kind,
        baffle_material: cab.construction.baffle_material.kind,
        wall_thickness_mm: (cab.construction.wall_thickness_m * 1000.0 * 10.0).round() / 10.0,
        baffle_thickness_mm: (cab.construction.front_baffle_thickness_m * 1000.0 * 10.0).round()
            / 10.0,
        brace_count: cab.construction.brace_count,
        joinery: cab.construction.joinery,
        base_chamber_liters,
        port_length_mm,
        port_area_cm2,
        port_flare_mm,
        horn_path_length_m,
        horn_mouth_area_cm2,
        slot_area_cm2,
        slot_path_mm,
        slot_flow_resistivity,
        lt_target_fp_hz,
        lt_target_qp,
        primary_driver_name: drv0
            .map(|d| d.name.clone())
            .unwrap_or_else(|| way0.driver_id.clone()),
        primary_bl_tm: drv0.map(|d| d.small_signal.bl_t_m).unwrap_or(18.0),
        primary_mms_g: drv0.map(|d| d.small_signal.mms_kg * 1000.0).unwrap_or(120.0),
        high_spl_volts_rms: spec.settings.high_spl_volts_rms,
    }
}

/// Apply a `ParametricPatch` to a `SystemDesignSpec`, producing a physically consistent modified spec.
pub fn apply_parametric_patch(
    spec: &SystemDesignSpec,
    patch: &ParametricPatch,
) -> SystemDesignSpec {
    let mut out = spec.clone();
    if out.cabinets.is_empty() || out.variants.is_empty() {
        return out;
    }

    let c_idx = patch.cabinet_idx.min(out.cabinets.len() - 1);
    let v_idx = patch.variant_idx.min(out.variants.len() - 1);

    out.settings.high_spl_volts_rms = patch.high_spl_volts_rms.clamp(2.83, 180.0);

    let (cab_id, primary_drv_id) = {
        let cab: &mut SpeakerCabinetSpec = &mut out.cabinets[c_idx];
        let old_dims = cab.dims_m;
        let old_wt = cab.construction.wall_thickness_m;
        let old_bt = cab.construction.front_baffle_thickness_m;
        let old_net = clear_interior_vol_m3(old_dims, old_wt, old_bt);

        let new_w = (patch.width_mm / 1000.0).clamp(0.16, 1.60);
        let new_d = (patch.depth_mm / 1000.0).clamp(0.18, 1.80);
        let new_h = (patch.height_mm / 1000.0).clamp(0.20, 2.20);
        let new_wt = (patch.wall_thickness_mm / 1000.0).clamp(0.009, 0.045);
        let new_bt = (patch.baffle_thickness_mm / 1000.0).clamp(0.012, 0.060);

        let w_scale = new_w / old_dims[0].max(0.05);
        let h_scale = new_h / old_dims[2].max(0.05);
        let new_net = clear_interior_vol_m3([new_w, new_d, new_h], new_wt, new_bt);
        let geom_vol_ratio = (new_net / old_net.max(1.0e-4)) * patch.chamber_volume_scale.clamp(0.4, 2.2);

        cab.dims_m = [new_w, new_d, new_h];
        cab.edge_round_m = (patch.edge_round_mm / 1000.0).clamp(0.0, 0.22 * new_w.min(new_h));
        cab.construction.enclosure_material = PanelMaterialSpec::from_kind(patch.enclosure_material);
        cab.construction.baffle_material = PanelMaterialSpec::from_kind(patch.baffle_material);
        cab.construction.wall_thickness_m = new_wt;
        cab.construction.front_baffle_thickness_m = new_bt;
        cab.construction.internal_partition_thickness_m = (new_wt * 0.95).clamp(0.010, 0.040);
        cab.construction.brace_thickness_m = (new_wt * 0.95).clamp(0.012, 0.040);
        cab.construction.brace_count = patch.brace_count.min(6);
        cab.construction.joinery = patch.joinery;

        cab.subtitle = format!(
            "{:.0}×{:.0}×{:.0} mm · {:.0} mm {} · {:.0} mm Baffle · {} Braces",
            new_w * 1000.0,
            new_d * 1000.0,
            new_h * 1000.0,
            new_wt * 1000.0,
            cab.construction.enclosure_material.name,
            new_bt * 1000.0,
            cab.construction.brace_count
        );

        // Scale driver vertical/horizontal acoustic offsets with cabinet dimensions
        for (wi, wy) in cab.ways.iter_mut().enumerate() {
            wy.local_acoustic_offset.x *= w_scale;
            wy.local_acoustic_offset.z =
                (wy.local_acoustic_offset.z * h_scale).clamp(new_wt + 0.03, new_h - new_wt - 0.03);

            if wi == 0 {
                match &mut wy.enclosure {
                    WayEnclosure::Sealed { volume_m3, .. } => {
                        *volume_m3 = (*volume_m3 * geom_vol_ratio).clamp(0.002, 1.2);
                    }
                    WayEnclosure::Vented {
                        volume_m3, port, ..
                    } => {
                        *volume_m3 = (*volume_m3 * geom_vol_ratio).clamp(0.004, 1.5);
                        port.length_m = (patch.port_length_mm / 1000.0).clamp(0.04, 1.20);
                        port.area_m2 = (patch.port_area_cm2 / 10_000.0).clamp(0.0010, 0.20);
                        port.flare_radius_m = (patch.port_flare_mm / 1000.0).clamp(0.0, 0.050);
                        port.local_exit_offset.x *= w_scale;
                        port.local_exit_offset.z = (port.local_exit_offset.z * h_scale)
                            .clamp(new_wt + 0.02, 0.35 * new_h);
                    }
                    WayEnclosure::FoldedHorn {
                        rear_volume_m3,
                        segments,
                        ..
                    } => {
                        *rear_volume_m3 = (*rear_volume_m3 * geom_vol_ratio).clamp(0.008, 0.40);
                        let l_sc = patch.horn_length_scale.clamp(0.50, 1.80);
                        let m_sc = patch.horn_mouth_scale.clamp(0.45, 1.85);
                        let n_seg = segments.len().max(1);
                        for (si, seg) in segments.iter_mut().enumerate() {
                            seg.length_m = (seg.length_m * l_sc).clamp(0.15, 2.80);
                            let u0 = (si as f64) / (n_seg as f64);
                            let u1 = ((si + 1) as f64) / (n_seg as f64);
                            let s0_factor = 1.0 + u0 * (m_sc - 1.0);
                            let s1_factor = 1.0 + u1 * (m_sc - 1.0);
                            seg.throat_area_m2 = (seg.throat_area_m2 * s0_factor).clamp(0.008, 1.20);
                            seg.mouth_area_m2 = (seg.mouth_area_m2 * s1_factor).clamp(0.015, 1.50);
                        }
                    }
                    WayEnclosure::TappedHorn {
                        throat_to_tap,
                        tap_to_mouth,
                        ..
                    } => {
                        let l_sc = patch.horn_length_scale.clamp(0.50, 1.80);
                        let m_sc = patch.horn_mouth_scale.clamp(0.45, 1.85);
                        let n_a = throat_to_tap.len().max(1);
                        for (si, seg) in throat_to_tap.iter_mut().enumerate() {
                            seg.length_m = (seg.length_m * l_sc).clamp(0.15, 2.50);
                            let u0 = 0.5 * (si as f64) / (n_a as f64);
                            let u1 = 0.5 * ((si + 1) as f64) / (n_a as f64);
                            seg.throat_area_m2 *= 1.0 + u0 * (m_sc - 1.0);
                            seg.mouth_area_m2 *= 1.0 + u1 * (m_sc - 1.0);
                        }
                        let tap_area = throat_to_tap
                            .last()
                            .map(|s| s.mouth_area_m2)
                            .unwrap_or(0.22);
                        for (si, seg) in tap_to_mouth.iter_mut().enumerate() {
                            seg.length_m = (seg.length_m * l_sc).clamp(0.10, 1.50);
                            if si == 0 {
                                seg.throat_area_m2 = tap_area;
                            } else {
                                seg.throat_area_m2 *= m_sc;
                            }
                            seg.mouth_area_m2 = (seg.mouth_area_m2 * m_sc).clamp(0.04, 1.40);
                        }
                    }
                    WayEnclosure::CardioidSlot {
                        internal_volume_m3,
                        slot_area_m2,
                        slot_path_m,
                        slot_flow_resistivity,
                        port,
                    } => {
                        *internal_volume_m3 =
                            (*internal_volume_m3 * geom_vol_ratio).clamp(0.005, 0.50);
                        *slot_area_m2 = (patch.slot_area_cm2 / 10_000.0).clamp(0.0020, 0.12);
                        *slot_path_m = (patch.slot_path_mm / 1000.0).clamp(0.04, 0.55);
                        *slot_flow_resistivity = patch.slot_flow_resistivity.clamp(1_500.0, 60_000.0);
                        if let Some(p) = port {
                            p.length_m = (patch.port_length_mm / 1000.0).clamp(0.04, 0.90);
                            p.area_m2 = (patch.port_area_cm2 / 10_000.0).clamp(0.0008, 0.10);
                            p.flare_radius_m = (patch.port_flare_mm / 1000.0).clamp(0.0, 0.040);
                        }
                    }
                    WayEnclosure::WaveguideLoaded {
                        rear_volume_m3,
                        waveguide,
                        ..
                    } => {
                        *rear_volume_m3 = (*rear_volume_m3 * geom_vol_ratio).clamp(0.0002, 0.30);
                        waveguide.length_m =
                            (waveguide.length_m * patch.horn_length_scale.clamp(0.5, 1.8))
                                .clamp(0.02, 0.80);
                        waveguide.mouth_area_m2 =
                            (waveguide.mouth_area_m2 * patch.horn_mouth_scale.clamp(0.5, 1.8))
                                .clamp(0.003, 0.60);
                    }
                }
            }
        }

        (
            cab.id.clone(),
            cab.ways
                .first()
                .map(|w| w.driver_id.clone())
                .unwrap_or_default(),
        )
    };

    // Scale primary LF transducer motor strength Bl & moving mass Mms
    let bl_sc = patch.motor_bl_scale.clamp(0.55, 1.65);
    let mms_sc = patch.moving_mass_scale.clamp(0.55, 1.65);
    if (bl_sc - 1.0).abs() > 1e-4 || (mms_sc - 1.0).abs() > 1e-4 {
        if let Some(drv) = out.drivers.iter_mut().find(|d| d.id == primary_drv_id) {
            drv.small_signal.bl_t_m *= bl_sc;
            drv.small_signal.mms_kg *= mms_sc;
        }
    }

    // Apply DSP & Array Spacing updates to the active variant
    let var = &mut out.variants[v_idx];

    // Identify DSP channels feeding way 0 of `cab_id`
    let lf_dsp_ids: Vec<String> = var
        .placements
        .iter()
        .filter(|pl| pl.cabinet_spec_id == cab_id)
        .filter_map(|pl| pl.way_dsp_channels.first().cloned())
        .collect();

    let xo_sc = patch.crossover_scale.clamp(0.55, 1.65);
    let scale_filter = |flt: &mut Option<CrossoverFilter>, is_highpass: bool| {
        if let Some(f) = flt {
            match f {
                CrossoverFilter::Butterworth { freq_hz, .. }
                | CrossoverFilter::LinkwitzRiley { freq_hz, .. }
                | CrossoverFilter::Bessel { freq_hz, .. } => {
                    // Leave subsonic protection high-pass filters (< 45 Hz) fixed!
                    if !(is_highpass && *freq_hz < 45.0) {
                        *freq_hz = (*freq_hz * xo_sc).clamp(45.0, 14_000.0);
                    }
                }
            }
        }
    };

    for ch in &mut var.dsp_channels {
        if lf_dsp_ids.iter().any(|id| id == &ch.id) {
            ch.gain_db += patch.lf_gain_trim_db.clamp(-18.0, 18.0);
            ch.delay_s = (ch.delay_s + patch.sub_delay_trim_ms / 1000.0).clamp(0.0, 0.080);
        }
        scale_filter(&mut ch.highpass, true);
        scale_filter(&mut ch.lowpass, false);

        for st in &mut ch.stages {
            if let BiquadStage::LinkwitzTransform { fp_hz, qp, .. } = st {
                *fp_hz = patch.lt_target_fp_hz.clamp(14.0, 48.0);
                *qp = patch.lt_target_qp.clamp(0.45, 1.25);
            }
        }
    }

    // Scale multi-speaker array placement coordinates around their horizontal centroid
    let sp_sc = patch.array_spacing_scale.clamp(0.40, 2.20);
    if var.placements.len() > 1 && (sp_sc - 1.0).abs() > 1e-4 {
        let n = var.placements.len() as f64;
        let cx = var.placements.iter().map(|p| p.transform.position.x).sum::<f64>() / n;
        let cy = var.placements.iter().map(|p| p.transform.position.y).sum::<f64>() / n;
        for pl in &mut var.placements {
            pl.transform.position.x = cx + (pl.transform.position.x - cx) * sp_sc;
            pl.transform.position.y = cy + (pl.transform.position.y - cy) * sp_sc;
        }
    }

    out
}

/// Run a live parametric simulation for a single active variant + full 3D solid CAD rebuild!
pub fn simulate_parametric_edit(
    base_spec: &SystemDesignSpec,
    patch: &ParametricPatch,
) -> Result<ParametricSimulationOutput, AcousticsError> {
    let modified_full = apply_parametric_patch(base_spec, patch);
    let modified_toml = toml::to_string_pretty(&modified_full)
        .map_err(|e| AcousticsError::Io(format!("TOML serialize error: {e}")))?;

    let v_idx = patch
        .variant_idx
        .min(modified_full.variants.len().saturating_sub(1));
    let mut sim_spec = modified_full;
    let mut active_var = sim_spec.variants[v_idx].clone();
    if !active_var.label.starts_with("🎛") {
        active_var.label = format!("🎛 Parametric: {}", active_var.label);
    }
    active_var.summary = format!(
        "Live parametric solve ({:.0}×{:.0}×{:.0} mm · {:.0} mm walls · {:.0} Vrms)",
        patch.width_mm, patch.depth_mm, patch.height_mm, patch.wall_thickness_mm, patch.high_spl_volts_rms
    );
    sim_spec.variants = vec![active_var];

    // Keep exact `num_freqs` so every frequency-domain array aligns 1:1 with A/B comparison variants!
    if !patch.include_3d_bem {
        sim_spec.settings.enable_3d_bem = false;
        sim_spec.settings.field_grid_nx = sim_spec.settings.field_grid_nx.min(34);
        sim_spec.settings.field_grid_ny = sim_spec.settings.field_grid_ny.min(34);
    }

    let mut bundle = run_system_simulation(&sim_spec)?;
    let simulated_variant = bundle
        .variants
        .pop()
        .ok_or_else(|| AcousticsError::Io("empty variant output".into()))?;

    Ok(ParametricSimulationOutput {
        high_spl_volts_rms: bundle.high_spl_volts_rms,
        cabinet_models: bundle.cabinet_models,
        simulated_variant,
        modified_toml,
    })
}
