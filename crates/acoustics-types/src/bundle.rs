//! Self-contained simulation output bundle consumed by the 3D Three.js + Acoustic Chart Viewer.

use crate::{ListenerZone, PlacedCabinet, VisualCabinetModel};
use serde::{Deserialize, Serialize};

/// ANSI/CTA-2034-A ("Spinorama") standardized 70-orbit spherical response curves [Ref #31].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpinoramaData {
    pub freqs_hz: Vec<f64>,
    pub on_axis_db: Vec<f64>,
    pub listening_window_db: Vec<f64>,
    pub early_reflections_db: Vec<f64>,
    pub sound_power_db: Vec<f64>,
    pub directivity_index_db: Vec<f64>,
    pub erdi_db: Vec<f64>,
}

/// Horizontal & vertical polar directivity sonogram & 3D balloon slices.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DirectivityBalloonData {
    pub freqs_hz: Vec<f64>,
    /// Polar angles `-180..+180 deg` (typically 37 steps of 10 deg or 73 steps of 5 deg).
    pub angles_deg: Vec<f64>,
    /// Normalized horizontal SPL `[n_freqs][n_angles]` (`dB` relative to on-axis, or absolute).
    pub horizontal_spl_db: Vec<Vec<f32>>,
    /// Normalized vertical SPL `[n_freqs][n_angles]`.
    pub vertical_spl_db: Vec<Vec<f32>>,
    /// 3D spherical balloon sampled at key octave/1/3-octave frequencies:
    /// theta `0..180 deg` (polar from +Z), phi `0..360 deg` (azimuth).
    pub balloon_freqs_hz: Vec<f64>,
    pub theta_deg: Vec<f32>,
    pub phi_deg: Vec<f32>,
    /// `[n_balloon_freqs][n_theta * n_phi]` SPL (`dB`).
    pub balloon_spl_db: Vec<Vec<f32>>,
    /// Note indicating whether 3D Burton-Miller BEM diffraction/waveguide correction was fused.
    pub solver_method: String,
}

/// Electro-mechano-acoustic & mutual-coupling sweep at the reference mic + primary driver/horn.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VariantSweepCurves {
    pub freqs_hz: Vec<f64>,
    /// Combined system SPL at `reference_mic_m` (`dB SPL` at small-signal drive).
    pub spl_small_signal_db: Vec<f64>,
    /// Combined system SPL at `high_spl_volts_rms` including thermal + port compression!
    pub spl_high_drive_db: Vec<f64>,
    /// Uncoupled SPL baseline (what naive point-source sum WITHOUT mutual `Z_rad` predicts!).
    pub spl_uncoupled_baseline_db: Vec<f64>,
    /// Unwrapped excess/acoustic phase at reference mic (`deg`).
    pub phase_deg: Vec<f64>,
    /// Group delay (`ms`).
    pub group_delay_ms: Vec<f64>,
    /// Per-way individual SPL contributions `[way_label -> Vec<f64>]` (shows crossover phase sum!).
    pub per_way_spl_db: Vec<(String, Vec<f64>)>,
    /// Primary LF driver electrical impedance magnitude (`Ohm`) and phase (`deg`).
    pub impedance_mag_ohm: Vec<f64>,
    pub impedance_phase_deg: Vec<f64>,
    /// Primary LF normalized real radiation resistance seen per mouth (`Re(Z_rad) / (rho0*c/S_m)`).
    pub normalized_radiation_resistance: Vec<f64>,
    /// Peak cone excursion (`mm`) at `high_spl_volts_rms` vs `xmax_mm`.
    pub cone_excursion_mm: Vec<f64>,
    pub xmax_limit_mm: f64,
    /// Peak port / throat air Mach number (`|v_air| / c`) at `high_spl_volts_rms`.
    pub port_mach: Vec<f64>,
    /// Large-signal Klippel + port harmonic distortion (`%` or `dB` below fundamental) at `high_spl_volts_rms`.
    pub thd_percent: Vec<f64>,
    pub hd2_db_rel: Vec<f64>,
    pub hd3_db_rel: Vec<f64>,
    /// Dynamic DC voice-coil displacement shift (`mm`) from `Bl(x)`/`Kms(x)` asymmetry & reluctance!
    pub dc_shift_mm: Vec<f64>,
    /// Frequency-dependent voice-coil steady-state temperature (`C`) at `high_spl_volts_rms`
    /// (demonstrating forced-convection cooling dip vs box-tuning temperature spike!).
    pub vc_temp_c: Vec<f64>,
    /// Power compression (`dB` lost at `high_spl_volts_rms` after thermal soak).
    pub power_compression_db: Vec<f64>,
    /// Active DSP transfer magnitude (`dB`) per channel `[channel_label -> Vec<f64>]`.
    pub dsp_mag_db: Vec<(String, Vec<f64>)>,
}

/// 2D horizontal spatial sound-field slices across frequencies + time-domain EDM pulse wavefronts!
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpatialFieldData {
    pub bounds_m: [f64; 4],
    pub nx: usize,
    pub ny: usize,
    pub z_ear_m: f64,
    /// Selected frequencies (`Hz`) for interactive 3D spatial SPL & phase field scrubbing.
    pub slice_freqs_hz: Vec<f64>,
    /// `[n_slice_freqs][ny * nx]` SPL (`dB` at `high_spl_volts_rms`).
    pub spl_slices_db: Vec<Vec<f32>>,
    /// `[n_slice_freqs][ny * nx]` instantaneous real wave phase `cos(angle(p))` in `[-1, 1]` for wave visualization!
    pub wave_real_slices: Vec<Vec<f32>>,
    /// Time-domain transient pulse (e.g. 50 Hz EDM kick + 1 kHz transient click) wavefront snapshots:
    pub transient_times_ms: Vec<f64>,
    /// `[n_frames][ny * nx]` normalized instantaneous pressure `p(x, y, t)`.
    pub transient_frames: Vec<Vec<f32>>,
}

/// Quantitative scorecard for each `ListenerZone` (sweet-spot uniformity, stage rejection, far throw).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ZoneMetrics {
    pub zone_id: String,
    pub label: String,
    pub role: String,
    /// Sub-bass (`30..85 Hz`) mean SPL (`dB`) and spatial standard deviation (`+- dB` uniformity!).
    pub bass_mean_spl_db: f64,
    pub bass_spatial_std_db: f64,
    pub bass_min_max_spread_db: f64,
    /// Mid/High (`100..8000 Hz`) mean SPL (`dB`) and spatial standard deviation (`+- dB`).
    pub mid_high_mean_spl_db: f64,
    pub mid_high_spatial_std_db: f64,
}

/// Compact FIR impulse responses (`f_s = 48_000 Hz`, ~4096 taps) at key virtual mic spots
/// so the browser WebAudio player can auralize standing in the sweet spot vs off-axis vs behind stack!
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VirtualMicImpulse {
    pub label: String,
    pub position_m: [f64; 3],
    pub sample_rate_hz: u32,
    pub taps: Vec<f32>,
}

/// Simulated results for one `SceneVariantSpec`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulatedVariant {
    pub variant_id: String,
    pub label: String,
    pub summary: String,
    pub placements: Vec<PlacedCabinet>,
    pub curves: VariantSweepCurves,
    pub spinorama: SpinoramaData,
    pub directivity: DirectivityBalloonData,
    pub spatial_field: SpatialFieldData,
    pub zone_metrics: Vec<ZoneMetrics>,
    pub virtual_mics: Vec<VirtualMicImpulse>,
}

/// Fitted parameter row with Bayesian Prior vs True/Measured vs Posterior MAP + 95% CI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CalibratedParameterRow {
    pub name: String,
    pub unit: String,
    pub prior_value: f64,
    pub posterior_value: f64,
    pub ci95_low: f64,
    pub ci95_high: f64,
    /// Optional ground-truth value when running a controlled verification benchmark.
    pub ground_truth: Option<f64>,
}

/// Optional Bayesian measurement-to-model calibration report bundled with a design.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CalibrationReportData {
    pub summary: String,
    pub freqs_hz: Vec<f64>,
    pub prior_z_mag_ohm: Vec<f64>,
    pub measured_z_mag_ohm: Vec<f64>,
    pub posterior_z_mag_ohm: Vec<f64>,
    pub prior_spl_db: Vec<f64>,
    pub measured_spl_db: Vec<f64>,
    pub posterior_spl_db: Vec<f64>,
    pub prior_rms_error_db: f64,
    pub posterior_rms_error_db: f64,
    pub parameters: Vec<CalibratedParameterRow>,
    pub parameter_names: Vec<String>,
    /// Posterior parameter correlation matrix `[-1.0 .. +1.0]` from SVD Fisher audit.
    pub correlation_matrix: Vec<Vec<f64>>,
    pub diagnostics: Vec<String>,
}

/// Complete JSON simulation bundle written to `simulations/<id>/bundle.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulationBundle {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub category: String,
    pub description: String,
    pub design_notes: Vec<String>,
    pub reference_mic_m: [f64; 3],
    pub high_spl_volts_rms: f64,
    pub zones: Vec<ListenerZone>,
    pub cabinet_models: Vec<VisualCabinetModel>,
    pub variants: Vec<SimulatedVariant>,
    pub calibration: Option<CalibrationReportData>,
}

/// Lightweight manifest entry in `simulations/manifest.json` so the web viewer discovers all runs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulationManifestEntry {
    pub id: String,
    pub title: String,
    pub category: String,
    pub subtitle: String,
    pub bundle_path: String,
    pub variant_count: usize,
    pub has_calibration: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SimulationManifest {
    pub generated_at: String,
    pub simulations: Vec<SimulationManifestEntry>,
}
