//! Watertight acoustic surface mesh & Waffle Iron CAD seam contract (`PatchId`).

use serde::{Deserialize, Serialize};

/// Persistent topological patch identity.
///
/// Mirrors `waffle_types::EntityPid { pid, root_pid }` 1:1 (Invariant A8) so
/// acoustic boundary conditions assigned to B-Rep faces survive parametric CAD rebuilds.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PatchId {
    pub pid: u64,
    pub root_pid: u64,
}

impl PatchId {
    pub const fn rooted(pid: u64) -> Self {
        Self { pid, root_pid: pid }
    }
}

/// Physical acoustic boundary condition applied to a surface patch in 3D BEM / FEM.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoundaryCondition {
    /// Sound-hard rigid cabinet wall (`dv_n = 0`).
    RigidWall,
    /// Thermoviscous Stokes boundary-layer wall (`Berggren 2018` [Ref #16]).
    ThermoviscousWall,
    /// Locally reacting porous lining / resistive cardioid slot (`v_n = -Y_s(w) * p`).
    SurfaceImpedance {
        flow_resistivity_pa_s_m2: f64,
        thickness_m: f64,
    },
    /// Driven transducer diaphragm (`driver_index`, front `+1` or rear `-1`).
    TransducerDiaphragm {
        driver_index: usize,
        polarity_sign: f64,
    },
    /// Open horn mouth / port exit coupling an interior acoustic waveguide to exterior 3D space.
    RadiationPort { port_index: usize },
}

/// Contiguous triangle slice sharing a `PatchId` and `BoundaryCondition`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PatchSurface {
    pub id: PatchId,
    pub label: String,
    pub tri_start: u32,
    pub tri_count: u32,
    pub boundary: BoundaryCondition,
}

/// Orientable, watertight manifold 3D surface mesh in SI meters for 3D BEM & CAD exchange.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AcousticSurfaceMesh {
    pub name: String,
    pub positions: Vec<[f64; 3]>,
    pub indices: Vec<[u32; 3]>,
    pub patches: Vec<PatchSurface>,
}

/// Styled 3D solid sub-mesh for rich interactive section-cut & exploded CAD visualization
/// in the Three.js viewer (individual finite-thickness panels, rabbeted front baffle with
/// CNC counterbores, internal folded-horn partitions & 45° reflectors, window braces,
/// porous damping pads, sculpted waveguides, cast baskets, voice coils, and magnet motors).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VisualSubMesh {
    pub name: String,
    /// Semantic role: `"shell"`, `"baffle"`, `"internal_horn"`, `"brace"`, `"damping"`, `"waveguide"`, `"port"`, `"motor"`, `"cone"`, `"hardware"`.
    pub role: String,
    pub color_hex: String,
    pub opacity: f32,
    /// Stable CAD part identifier (`"left_wall"`, `"front_baffle"`, `"horn_partition_1"`, etc.).
    #[serde(default)]
    pub part_id: String,
    /// Interactive layer toggle group (`"outer_shell"`, `"front_baffle"`, `"internal_horn"`, `"bracing"`, `"damping"`, `"port_waveguide"`, `"driver_motor"`, `"driver_cone"`, `"hardware"`).
    #[serde(default)]
    pub layer: String,
    /// Material label shown in hover readout & BOM cutlist.
    #[serde(default)]
    pub material_name: String,
    /// Real wall/part thickness in millimeters (`mm`).
    #[serde(default)]
    pub thickness_mm: f32,
    /// Bounding/cutlist stock dimensions `[length_mm, width_mm, thickness_mm]`.
    #[serde(default)]
    pub cut_dims_mm: [f32; 3],
    /// Physical part mass (`kg`) computed from solid volume and material density.
    #[serde(default)]
    pub mass_kg: f32,
    /// Translation vector (`m`) applied at 100% Exploded Assembly slider.
    #[serde(default)]
    pub explode_offset_m: [f32; 3],
    /// Engineering / CNC joinery notes for BOM cutlist.
    #[serde(default)]
    pub notes: String,
    /// Flat `[x0, y0, z0, x1, y1, z1, ...]` in meters.
    pub positions: Vec<f32>,
    /// Flat `[nx0, ny0, nz0, ...]` unit normals.
    pub normals: Vec<f32>,
    /// Flat triangle vertex indices.
    pub indices: Vec<u32>,
}

/// Exact 2D cross-section polygon in millimeters (`mm`) for orthographic CAD blueprints.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionPolygon2D {
    pub part_id: String,
    pub label: String,
    /// Hatch key: `"birch"`, `"mdf"`, `"hdf"`, `"aluminum"`, `"damping"`, `"steel"`, `"magnet"`, `"copper"`, `"cone"`, `"outline"`.
    pub material_kind: String,
    pub color_hex: String,
    pub thickness_mm: f32,
    pub points_mm: Vec<[f32; 2]>,
    #[serde(default)]
    pub is_dashed: bool,
}

/// 2D acoustic path centerline or reference line in millimeters (`mm`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionPath2D {
    pub label: String,
    pub color_hex: String,
    pub points_mm: Vec<[f32; 2]>,
    #[serde(default)]
    pub dashed: bool,
    #[serde(default)]
    pub arrow_end: bool,
}

/// 2D engineering dimension callout line (`p0 -> p1` offset by `offset_mm`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionDimension2D {
    pub p0_mm: [f32; 2],
    pub p1_mm: [f32; 2],
    pub offset_mm: f32,
    pub label: String,
}

/// 2D engineering callout label in millimeters (`mm`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionLabel2D {
    pub pos_mm: [f32; 2],
    pub text: String,
    pub color_hex: String,
}

/// Orthographic 2D CAD cross-section / elevation blueprint (`Side Y-Z`, `Plan X-Y`, `Front X-Z`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CrossSectionBlueprint2D {
    pub view_id: String,
    pub title: String,
    pub plane_caption: String,
    pub u_label: String,
    pub v_label: String,
    /// `[u_min_mm, u_max_mm, v_min_mm, v_max_mm]`.
    pub bounds_mm: [f32; 4],
    pub polygons: Vec<SectionPolygon2D>,
    pub paths: Vec<SectionPath2D>,
    pub dimensions: Vec<SectionDimension2D>,
    pub labels: Vec<SectionLabel2D>,
}

/// Quantitative structural mechanics, panel modal resonance, mass & volume displacement summary.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CabinetStructuralSummary {
    pub enclosure_material_name: String,
    pub baffle_material_name: String,
    pub joinery_label: String,
    pub finish_label: String,
    pub density_kg_m3: f64,
    pub youngs_modulus_gpa: f64,
    pub poisson_ratio: f64,
    pub loss_factor_eta: f64,
    pub baffle_density_kg_m3: f64,
    pub baffle_youngs_modulus_gpa: f64,
    pub wall_thickness_mm: f64,
    pub baffle_thickness_mm: f64,
    pub partition_thickness_mm: f64,
    pub brace_thickness_mm: f64,
    pub rebate_depth_mm: f64,
    pub damping_thickness_mm: f64,
    pub brace_count: usize,
    /// Outer panel Kirchhoff flexural rigidity `D = E * h^3 / (12 * (1 - nu^2))` (`N * m`).
    pub flexural_rigidity_nm: f64,
    /// Front baffle Kirchhoff flexural rigidity (`N * m`).
    pub baffle_rigidity_nm: f64,
    pub gross_external_volume_l: f64,
    pub shell_wall_displacement_l: f64,
    pub internal_partitions_displacement_l: f64,
    pub drivers_and_damping_displacement_l: f64,
    pub net_internal_air_volume_l: f64,
    pub woodwork_mass_kg: f64,
    pub drivers_mass_kg: f64,
    pub damping_and_hardware_mass_kg: f64,
    pub total_mass_kg: f64,
    pub largest_unbraced_span_mm: [f64; 2],
    pub largest_braced_span_mm: [f64; 2],
    /// Fundamental `(1, 1)` Mindlin-Kirchhoff plate bending mode BEFORE internal bracing/partitions (`Hz`).
    pub unbraced_f11_hz: f64,
    /// Fundamental `(1, 1)` Mindlin-Kirchhoff plate bending mode AFTER internal bracing/partitions (`Hz`).
    pub braced_f11_hz: f64,
    /// Mass/stiffness low-frequency panel Sound Transmission Loss floor (`dB`).
    pub panel_stl_low_freq_db: f64,
    /// Structural frequency sweep (`20..5000 Hz`) for cabinet wall coloration audit.
    pub modal_freqs_hz: Vec<f64>,
    /// Radiated cabinet wall vibration level relative to direct acoustic output (`dB`) WITH bracing & real thickness.
    pub braced_coloration_db: Vec<f64>,
    /// Baseline coloration (`dB`) of an unbraced panel of 2/3 wall thickness for A/B structural comparison.
    pub unbraced_coloration_db: Vec<f64>,
}

/// Complete visual & structural 3D/2D cabinet CAD model exported into a simulation bundle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VisualCabinetModel {
    pub model_id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    pub dims_m: [f64; 3],
    #[serde(default)]
    pub structural: CabinetStructuralSummary,
    #[serde(default)]
    pub sections_2d: Vec<CrossSectionBlueprint2D>,
    pub submeshes: Vec<VisualSubMesh>,
}
