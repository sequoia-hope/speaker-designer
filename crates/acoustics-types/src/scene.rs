//! Multi-speaker 3D scene, active LMS DSP chain, ground/boundary physics, and listener zones.

use crate::{AmbientEnvironment, DriverSpec, SpeakerCabinetSpec, Transform3};
use serde::{Deserialize, Serialize};

/// Crossover filter family & slope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "snake_case")]
pub enum CrossoverFilter {
    Butterworth { order: u8, freq_hz: f64 },
    LinkwitzRiley { order: u8, freq_hz: f64 },
    Bessel { order: u8, freq_hz: f64 },
}

/// Parametric EQ / All-Pass / Linkwitz-Transform biquad stage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "biquad", rename_all = "snake_case")]
pub enum BiquadStage {
    Peaking {
        freq_hz: f64,
        gain_db: f64,
        q: f64,
    },
    LowShelf {
        freq_hz: f64,
        gain_db: f64,
        q: f64,
    },
    HighShelf {
        freq_hz: f64,
        gain_db: f64,
        q: f64,
    },
    AllPass2 {
        freq_hz: f64,
        q: f64,
    },
    LinkwitzTransform {
        f0_hz: f64,
        q0: f64,
        fp_hz: f64,
        qp: f64,
    },
}

/// Active DSP channel strip feeding one speaker way or subwoofer group.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DspChannelSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub invert_polarity: bool,
    /// Time alignment delay in seconds (e.g. `0.0024` = `2.4 ms`).
    #[serde(default)]
    pub delay_s: f64,
    #[serde(default)]
    pub highpass: Option<CrossoverFilter>,
    #[serde(default)]
    pub lowpass: Option<CrossoverFilter>,
    #[serde(default)]
    pub stages: Vec<BiquadStage>,
}

/// Placed speaker cabinet instance inside the 3D venue/studio scene.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlacedCabinet {
    pub instance_id: String,
    pub label: String,
    pub cabinet_spec_id: String,
    pub transform: Transform3,
    /// Maps each `way` index of the cabinet to a `DspChannelSpec` id!
    pub way_dsp_channels: Vec<String>,
}

/// Acoustic environment / boundary reflection model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "space", rename_all = "snake_case")]
pub enum BoundaryEnvironment {
    /// Anechoic 4-pi free space (for CTA-2034 studio monitor Spinorama!).
    Free4Pi,
    /// Rigid 2-pi ground plane (`z = 0`).
    RigidGround2Pi,
    /// Quarter-space (`z = 0` floor + `y = wall_y` rigid front/stage wall).
    WallFloorPi { wall_y_m: f64 },
    /// Studio room front-wall SBIR boundary (`z = 0` floor + `y = wall_y` semi-reflective studio wall).
    StudioFrontWall {
        wall_y_m: f64,
        wall_reflection: f64,
    },
    /// Open grassy field (`z = 0`) using Delany-Bazley / Weyl-Van der Pol complex ground reflection [Ref #15]
    /// (`flow_resistivity ~ 200_000 Pa*s/m^2` for turf/soil, rigid at 30 Hz sub-bass, absorptive at 1-8 kHz!).
    OpenFieldTurf { flow_resistivity_pa_s_m2: f64 },
}

impl Default for BoundaryEnvironment {
    fn default() -> Self {
        Self::RigidGround2Pi
    }
}

/// Named 2D rectangular listener / exclusion evaluation zone at ear height `z_ear_m`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListenerZone {
    pub id: String,
    pub label: String,
    /// `"sweet_spot"`, `"stage_quiet"`, `"far_range"`, or `"mixing_position"`.
    pub role: String,
    pub x_min_m: f64,
    pub x_max_m: f64,
    pub y_min_m: f64,
    pub y_max_m: f64,
    pub z_ear_m: f64,
}

/// One runnable configuration variant inside a `SystemDesignSpec`
/// (enables instant A/B/C comparison inside a single bundle, e.g. `1x` vs `2x` vs `4x` Coupled Horns,
/// or `Oasis-360 Monoblock + 4-Point` vs `Naive 4-Corner Subs`!).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SceneVariantSpec {
    pub variant_id: String,
    pub label: String,
    pub summary: String,
    pub boundary: BoundaryEnvironment,
    pub dsp_channels: Vec<DspChannelSpec>,
    pub placements: Vec<PlacedCabinet>,
}

/// Solver settings for generating a simulation bundle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulationSettings {
    pub freq_min_hz: f64,
    pub freq_max_hz: f64,
    pub num_freqs: usize,
    /// Small-signal reference RMS drive voltage (typically `2.83 V` = 1 W into 8 Ohm).
    pub small_signal_volts_rms: f64,
    /// High-SPL large-signal RMS drive voltage (e.g. `80.0 V` for PA sub, `20.0 V` for studio monitor).
    pub high_spl_volts_rms: f64,
    /// Enable full 3D Burton-Miller BEM boundary diffraction & waveguide solve (`crates/acoustics-bem`).
    #[serde(default = "default_true")]
    pub enable_3d_bem: bool,
    /// Horizontal 2D field map domain `[x_min, x_max, y_min, y_max]` in meters and grid count.
    pub field_bounds_m: [f64; 4],
    pub field_grid_nx: usize,
    pub field_grid_ny: usize,
    pub listener_height_m: f64,
    /// Primary observation / sweet-spot reference point `[x, y, z]` in meters.
    pub reference_mic_m: [f64; 3],
}

fn default_true() -> bool {
    true
}

/// Top-level declarative Speaker & Sound-System Design file (`designs/*.toml`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SystemDesignSpec {
    pub id: String,
    pub title: String,
    pub category: String,
    pub description: String,
    /// Detailed acoustic engineering rationale surfaced in the viewer.
    pub design_notes: Vec<String>,
    #[serde(default)]
    pub environment: AmbientEnvironment,
    pub settings: SimulationSettings,
    pub drivers: Vec<DriverSpec>,
    pub cabinets: Vec<SpeakerCabinetSpec>,
    pub zones: Vec<ListenerZone>,
    pub variants: Vec<SceneVariantSpec>,
}
