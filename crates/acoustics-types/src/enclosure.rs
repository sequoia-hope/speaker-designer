//! Enclosure, horn, waveguide, porous-absorber, and multi-way cabinet schemas.

use crate::{Point3, Vec3};
use serde::{Deserialize, Serialize};

/// Porous acoustic damping material parameters (Miki / Johnson-Champoux-Allard [Ref #15]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PorousMaterial {
    /// Static airflow resistivity `sigma` (`Pa * s / m^2`, e.g. `4_000` polyester Dacron, `18_000` mineral wool).
    pub flow_resistivity_pa_s_m2: f64,
    /// Open porosity `phi` in `(0.0, 1.0]` (typically `0.95..0.99`).
    #[serde(default = "default_porosity")]
    pub porosity: f64,
    /// High-frequency tortuosity `alpha_inf >= 1.0` (typically `1.02..1.08` for fibrous wool).
    #[serde(default = "default_tortuosity")]
    pub tortuosity: f64,
    /// Fraction of chamber volume filled `[0.0, 1.0]`.
    #[serde(default)]
    pub fill_fraction: f64,
}

fn default_porosity() -> f64 {
    0.97
}
fn default_tortuosity() -> f64 {
    1.04
}

impl Default for PorousMaterial {
    fn default() -> Self {
        Self {
            flow_resistivity_pa_s_m2: 8_000.0,
            porosity: 0.97,
            tortuosity: 1.04,
            fill_fraction: 0.25,
        }
    }
}

/// 1D / 3D Horn & Waveguide flare law [Ref #3, #4].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "law", rename_all = "snake_case")]
pub enum HornContour {
    /// Constant area duct / port (`S(x) = S_0`).
    Uniform,
    /// Conical flare (`r(x)` linear from `S_0` to `S_L`).
    Conical,
    /// Classical exponential horn (`S(x) = S_0 * exp(m * x)`).
    Exponential,
    /// Salmon generalized hyperbolic-exponential family (`T < 1` hypex/catenoid, `T = 1` exp) [Ref #3].
    Salmon { t_factor: f64 },
    /// Tractrix low-reflection mouth flare.
    Tractrix,
    /// Oblate Spheroidal Constant-Directivity Waveguide (`OS-SE`) with half-coverage angle `alpha_deg`.
    OsSe {
        coverage_h_deg: f64,
        coverage_v_deg: f64,
    },
}

/// Single horn / waveguide / transmission-line segment.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HornSegmentSpec {
    pub length_m: f64,
    pub throat_area_m2: f64,
    pub mouth_area_m2: f64,
    pub contour: HornContour,
    /// Aspect ratio `width / height` for rectangular horn channels (affects Stinson hydraulic radius!).
    #[serde(default = "default_aspect")]
    pub aspect_ratio: f64,
}

fn default_aspect() -> f64 {
    1.2
}

/// Port / vent geometry including flare radius for Salvatti high-SPL aeroacoustic turbulence [Ref #21].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PortSpec {
    pub area_m2: f64,
    pub length_m: f64,
    /// Flare radius at port ends (`m`; `0.0` = sharp edge, `0.025` = generous low-turbulence flare).
    #[serde(default)]
    pub flare_radius_m: f64,
    /// Local port exit offset relative to cabinet center (`m`).
    #[serde(default)]
    pub local_exit_offset: Point3,
    /// Outward radiation normal in cabinet-local coordinates (`Vec3::Y` = front, `-Vec3::Y` = rear).
    #[serde(default = "default_front_normal")]
    pub local_normal: Vec3,
}

fn default_front_normal() -> Vec3 {
    Vec3::Y
}

/// Acoustic loading topology for a single way / enclosure section.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "topology", rename_all = "snake_case")]
pub enum WayEnclosure {
    /// Sealed acoustic suspension chamber (`V_b` in `m^3`, leakage `Q_L`).
    Sealed {
        volume_m3: f64,
        #[serde(default = "default_ql_sealed")]
        leakage_ql: f64,
        #[serde(default)]
        damping: PorousMaterial,
    },
    /// Bass-reflex / vented enclosure (`V_b`, leakage `Q_L`, flared/slotted port).
    Vented {
        volume_m3: f64,
        #[serde(default = "default_ql_vented")]
        leakage_ql: f64,
        port: PortSpec,
        #[serde(default)]
        damping: PorousMaterial,
    },
    /// Front-loaded folded horn (`V_rear` sealed chamber + throat compression chamber + multi-segment horn).
    FoldedHorn {
        rear_volume_m3: f64,
        throat_chamber_m3: f64,
        #[serde(default = "default_ql_sealed")]
        leakage_ql: f64,
        segments: Vec<HornSegmentSpec>,
        #[serde(default)]
        rear_damping: PorousMaterial,
    },
    /// Tapped horn: driver rear feeds near horn throat (`tap_throat_seg`), driver front feeds near mouth!
    TappedHorn {
        throat_to_tap: Vec<HornSegmentSpec>,
        tap_to_mouth: Vec<HornSegmentSpec>,
        #[serde(default = "default_ql_vented")]
        leakage_ql: f64,
    },
    /// Waveguide-loaded midrange or high-frequency driver (`sealed` rear cup + front waveguide).
    WaveguideLoaded {
        rear_volume_m3: f64,
        throat_chamber_m3: f64,
        waveguide: HornSegmentSpec,
    },
    /// Acoustic resistive-slot cardioid enclosure (rear wave delayed & attenuated through side/rear porous slots
    /// to cancel rear radiation across `70..350 Hz`, eliminating studio front-wall SBIR!).
    CardioidSlot {
        internal_volume_m3: f64,
        slot_area_m2: f64,
        slot_path_m: f64,
        slot_flow_resistivity: f64,
        /// Optional vented LF sub-section or sealed LF below cardioid band.
        port: Option<PortSpec>,
    },
}

fn default_ql_sealed() -> f64 {
    15.0
}
fn default_ql_vented() -> f64 {
    7.0
}

/// One frequency band / acoustic way inside a `SpeakerCabinetSpec` (e.g. LF Sub, Kick, Mid, HF).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CabinetWaySpec {
    pub way_id: String,
    pub label: String,
    pub driver_id: String,
    /// Number of identical parallel/push-pull drivers in this way (`1` or `2`).
    #[serde(default = "default_one")]
    pub driver_count: usize,
    /// DSP channel index inside the cabinet's active processor (`0..n_ways`).
    pub dsp_channel_index: usize,
    /// Acoustic center / mouth position in cabinet-local coordinates (`m`).
    pub local_acoustic_offset: Point3,
    pub enclosure: WayEnclosure,
}

fn default_one() -> usize {
    1
}

/// Structural panel material family for cabinet walls, baffles, braces, and waveguides.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelMaterialKind {
    /// Void-free multi-ply Baltic Birch plywood (`rho ~ 680 kg/m^3, E ~ 11.5 GPa, eta ~ 0.022`).
    #[default]
    BalticBirch13Ply,
    /// High-density acoustic MDF (`rho ~ 760 kg/m^3, E ~ 4.0 GPa, eta ~ 0.034`).
    HighDensityMdf,
    /// Engineered high-density colored wood-fiber panel (`rho ~ 840 kg/m^3, E ~ 5.2 GPa, eta ~ 0.038`).
    ValchromatHdf,
    /// Marine phenolic-film birch plywood (`rho ~ 710 kg/m^3, E ~ 12.2 GPa, eta ~ 0.024`).
    PhenolicMarineBirch,
    /// CNC-machined 6061-T6 aluminum baffle / waveguide block (`rho ~ 2700 kg/m^3, E ~ 68.9 GPa`).
    CastAluminum6061,
    /// Constrained-layer damped birch + viscoelastic shear core (`rho ~ 740 kg/m^3, E ~ 9.6 GPa, eta ~ 0.085`).
    CldBirchViscoelastic,
}

impl PanelMaterialKind {
    pub fn hatch_key(self) -> &'static str {
        match self {
            Self::BalticBirch13Ply | Self::PhenolicMarineBirch | Self::CldBirchViscoelastic => {
                "birch"
            }
            Self::HighDensityMdf => "mdf",
            Self::ValchromatHdf => "hdf",
            Self::CastAluminum6061 => "aluminum",
        }
    }
}

/// Physical mechanical & damping properties of a structural cabinet panel material.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PanelMaterialSpec {
    pub name: String,
    #[serde(default)]
    pub kind: PanelMaterialKind,
    /// Bulk material density `rho` (`kg / m^3`).
    pub density_kg_m3: f64,
    /// Effective flexural Young's modulus `E` (`GPa`).
    pub youngs_modulus_gpa: f64,
    /// In-plane Poisson ratio `nu` (`0.22..0.35`).
    pub poisson_ratio: f64,
    /// Structural hysteretic loss factor `eta` (`0.005..0.12`).
    pub loss_factor_eta: f64,
    /// Realistic cutaway section color (`#rrggbb`).
    pub color_hex: String,
    /// Exterior coating / surface treatment.
    pub finish: String,
}

impl PanelMaterialSpec {
    pub fn baltic_birch_ply() -> Self {
        Self {
            name: "13-Ply Void-Free Baltic Birch (BB/BB)".into(),
            kind: PanelMaterialKind::BalticBirch13Ply,
            density_kg_m3: 680.0,
            youngs_modulus_gpa: 11.5,
            poisson_ratio: 0.30,
            loss_factor_eta: 0.022,
            color_hex: "#d4a36a".into(),
            finish: "2.0 mm Textured Polyurea Tour Coating".into(),
        }
    }

    pub fn high_density_mdf() -> Self {
        Self {
            name: "High-Density Acoustic MDF (HDF-760)".into(),
            kind: PanelMaterialKind::HighDensityMdf,
            density_kg_m3: 760.0,
            youngs_modulus_gpa: 4.0,
            poisson_ratio: 0.25,
            loss_factor_eta: 0.034,
            color_hex: "#b99066".into(),
            finish: "2K Satin Studio Polyurethane Lacquer".into(),
        }
    }

    pub fn valchromat_hdf() -> Self {
        Self {
            name: "Valchromat Structural Acoustic HDF-840".into(),
            kind: PanelMaterialKind::ValchromatHdf,
            density_kg_m3: 840.0,
            youngs_modulus_gpa: 5.2,
            poisson_ratio: 0.26,
            loss_factor_eta: 0.038,
            color_hex: "#5c6b7d".into(),
            finish: "CNC Matte Anthracite Hard-Wax Seal".into(),
        }
    }

    pub fn aluminum_6061_t6() -> Self {
        Self {
            name: "CNC 6061-T6 Billet Aluminum".into(),
            kind: PanelMaterialKind::CastAluminum6061,
            density_kg_m3: 2700.0,
            youngs_modulus_gpa: 68.9,
            poisson_ratio: 0.33,
            loss_factor_eta: 0.015,
            color_hex: "#9fb3c8".into(),
            finish: "Bead-Blasted Hard Black Anodized".into(),
        }
    }

    pub fn phenolic_marine_birch() -> Self {
        Self {
            name: "Phenolic-Film Marine Baltic Birch (WBP)".into(),
            kind: PanelMaterialKind::PhenolicMarineBirch,
            density_kg_m3: 710.0,
            youngs_modulus_gpa: 12.2,
            poisson_ratio: 0.30,
            loss_factor_eta: 0.024,
            color_hex: "#a87644".into(),
            finish: "Weatherproof Dark Phenolic Hex-Film + Polyurea Edges".into(),
        }
    }

    pub fn cld_birch_laminate() -> Self {
        Self {
            name: "CLD Constrained-Layer Birch + Viscoelastic Core".into(),
            kind: PanelMaterialKind::CldBirchViscoelastic,
            density_kg_m3: 740.0,
            youngs_modulus_gpa: 9.6,
            poisson_ratio: 0.31,
            loss_factor_eta: 0.085,
            color_hex: "#c9935b".into(),
            finish: "Satin Studio Catalyzed Varnish".into(),
        }
    }

    pub fn from_kind(kind: PanelMaterialKind) -> Self {
        match kind {
            PanelMaterialKind::BalticBirch13Ply => Self::baltic_birch_ply(),
            PanelMaterialKind::HighDensityMdf => Self::high_density_mdf(),
            PanelMaterialKind::ValchromatHdf => Self::valchromat_hdf(),
            PanelMaterialKind::PhenolicMarineBirch => Self::phenolic_marine_birch(),
            PanelMaterialKind::CastAluminum6061 => Self::aluminum_6061_t6(),
            PanelMaterialKind::CldBirchViscoelastic => Self::cld_birch_laminate(),
        }
    }
}

impl Default for PanelMaterialSpec {
    fn default() -> Self {
        Self::baltic_birch_ply()
    }
}

/// Cabinet panel corner & internal partition joinery method.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoineryKind {
    /// CNC-routed rabbet & housing dado joints (`50%` wall-thickness tongue engagement).
    #[default]
    RabbetDado,
    /// 45-degree lock-miter corners with flush-rebated front baffle.
    Miter45,
    /// Interlocking CNC finger-tab & mortise-tenon touring joinery.
    InterlockingCncTab,
}

impl JoineryKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::RabbetDado => "CNC Rabbet & Housing Dado (50% Depth)",
            Self::Miter45 => "45° Lock-Miter + Rebated Baffle",
            Self::InterlockingCncTab => "Interlocking CNC Mortise-Tenon + Dado",
        }
    }

    /// Effective boundary clamping factor `gamma_bc` between simply-supported (`1.0`) and clamped (`1.82`).
    pub fn boundary_stiffness_factor(self) -> f64 {
        match self {
            Self::RabbetDado => 1.42,
            Self::Miter45 => 1.36,
            Self::InterlockingCncTab => 1.48,
        }
    }
}

/// Complete real-world wall-thickness, material, joinery, bracing, and damping build specification.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CabinetConstructionSpec {
    /// Material for outer shell walls, internal horn folds, chambers, and braces.
    #[serde(default)]
    pub enclosure_material: PanelMaterialSpec,
    /// Material for the front baffle & waveguide faceplate (often thicker MDF, double-birch, or 6061-T6 Alu!).
    #[serde(default)]
    pub baffle_material: PanelMaterialSpec,
    /// Outer shell panel thickness in meters (e.g. `0.018` = `18 mm` Baltic Birch, `0.022` = `22 mm` MDF).
    #[serde(default = "default_wall_t")]
    pub wall_thickness_m: f64,
    /// Front baffle total thickness in meters (e.g. `0.024` = `24 mm` or `0.028` = `28 mm`).
    #[serde(default = "default_baffle_t")]
    pub front_baffle_thickness_m: f64,
    /// Internal horn partition / midrange sub-enclosure / port wall thickness in meters (e.g. `0.018` or `0.015`).
    #[serde(default = "default_partition_t")]
    pub internal_partition_thickness_m: f64,
    /// Internal window-matrix / tie brace thickness in meters (e.g. `0.018`).
    #[serde(default = "default_brace_t")]
    pub brace_thickness_m: f64,
    /// Number of internal structural window/tie braces (`0..6`).
    #[serde(default = "default_brace_count")]
    pub brace_count: usize,
    /// CNC flush-mount counterbore rebate depth on the front baffle for driver frames (`m`, e.g. `0.006` = `6 mm`).
    #[serde(default = "default_rebate_m")]
    pub driver_rebate_depth_m: f64,
    /// Acoustic porous wall-lining pad thickness (`m`, e.g. `0.025` = `25 mm` melamine / mineral wool).
    #[serde(default = "default_damping_t")]
    pub damping_lining_thickness_m: f64,
    /// Corner & internal partition joinery style.
    #[serde(default)]
    pub joinery: JoineryKind,
}

fn default_wall_t() -> f64 {
    0.018
}
fn default_baffle_t() -> f64 {
    0.024
}
fn default_partition_t() -> f64 {
    0.018
}
fn default_brace_t() -> f64 {
    0.018
}
fn default_brace_count() -> usize {
    2
}
fn default_rebate_m() -> f64 {
    0.006
}
fn default_damping_t() -> f64 {
    0.025
}

impl Default for CabinetConstructionSpec {
    fn default() -> Self {
        Self {
            enclosure_material: PanelMaterialSpec::baltic_birch_ply(),
            baffle_material: PanelMaterialSpec::baltic_birch_ply(),
            wall_thickness_m: default_wall_t(),
            front_baffle_thickness_m: default_baffle_t(),
            internal_partition_thickness_m: default_partition_t(),
            brace_thickness_m: default_brace_t(),
            brace_count: default_brace_count(),
            driver_rebate_depth_m: default_rebate_m(),
            damping_lining_thickness_m: default_damping_t(),
            joinery: JoineryKind::RabbetDado,
        }
    }
}

/// Complete physical speaker cabinet specification (1-way sub up to 4-way studio/PA monitor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpeakerCabinetSpec {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    /// Exterior bounding box `[width_x, depth_y, height_z]` in meters.
    pub dims_m: [f64; 3],
    /// Front baffle edge chamfer / rounding radius in meters (reduces edge diffraction in 3D BEM!).
    #[serde(default)]
    pub edge_round_m: f64,
    /// Number of internal horn folds for 3D cutaway visualization (`0` = direct/straight, `3..5` = folded bass horn).
    #[serde(default)]
    pub visual_fold_count: usize,
    /// Real structural panel materials, wall thicknesses, joinery, rebates, bracing & acoustic lining.
    #[serde(default)]
    pub construction: CabinetConstructionSpec,
    pub ways: Vec<CabinetWaySpec>,
}
