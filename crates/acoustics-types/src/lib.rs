//! Foundation SI contracts, geometry primitives, transducer/enclosure schemas,
//! 3D system scenes, and simulation bundle data structures.
//!
//! All internal values are strictly SI base units (Invariant A6):
//! - Length: meters (`m`)
//! - Mass: kilograms (`kg`)
//! - Time: seconds (`s`), Frequency: Hertz (`Hz`)
//! - Pressure: Pascals (`Pa`, RMS phasor in frequency domain under `exp(+j*omega*t)`)
//! - Temperature: Kelvin (`K`)

pub mod air;
pub mod bundle;
pub mod driver;
pub mod enclosure;
pub mod mesh;
pub mod scene;

pub use air::*;
pub use bundle::*;
pub use driver::*;
pub use enclosure::*;
pub use mesh::*;
pub use scene::*;

pub use num_complex::Complex64;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Standard acoustic reference RMS pressure in air: 20 uPa.
pub const P_REF_PA: f64 = 20.0e-6;

/// Model-space coincidence tolerance in meters (matches `waffle-iron` `cad-primitives`).
pub const TAU_MODEL: f64 = 1.0e-7;

/// Central f64 evaluation/rounding tolerance (matches `waffle-iron` `cad-primitives`).
pub const TAU_EVAL: f64 = 1.0e-9;

/// Working precision floor (matches `waffle-iron` `cad-primitives`).
pub const TAU_WORK: f64 = 1.0e-12;

/// Convert RMS pressure magnitude (Pa) to dB SPL re 20 uPa.
#[inline]
pub fn pa_to_spl_db(p_rms_pa: f64) -> f64 {
    20.0 * (p_rms_pa.max(1.0e-18) / P_REF_PA).log10()
}

/// 3D point in SI meters (`Copy`, 24 bytes, identical layout to `cad_primitives::Point3`).
#[derive(Copy, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Point3 {
    pub const ORIGIN: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }

    #[inline]
    pub fn to_f32_array(self) -> [f32; 3] {
        [self.x as f32, self.y as f32, self.z as f32]
    }

    #[inline]
    pub fn dist(self, other: Self) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2) + (self.z - other.z).powi(2))
            .sqrt()
    }

    #[inline]
    pub fn add_vec(self, v: Vec3) -> Self {
        Self::new(self.x + v.x, self.y + v.y, self.z + v.z)
    }

    #[inline]
    pub fn sub(self, other: Self) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    #[inline]
    pub fn mirror_z(self) -> Self {
        Self::new(self.x, self.y, -self.z)
    }
}

impl From<[f64; 3]> for Point3 {
    fn from(a: [f64; 3]) -> Self {
        Self::new(a[0], a[1], a[2])
    }
}

/// 3D vector in SI units.
#[derive(Copy, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);
    pub const X: Self = Self::new(1.0, 0.0, 0.0);
    pub const Y: Self = Self::new(0.0, 1.0, 0.0);
    pub const Z: Self = Self::new(0.0, 0.0, 1.0);

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn dot(self, rhs: Self) -> f64 {
        self.x * rhs.x + self.y * rhs.y + self.z * rhs.z
    }

    #[inline]
    pub fn cross(self, rhs: Self) -> Self {
        Self::new(
            self.y * rhs.z - self.z * rhs.y,
            self.z * rhs.x - self.x * rhs.z,
            self.x * rhs.y - self.y * rhs.x,
        )
    }

    #[inline]
    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    #[inline]
    pub fn normalized(self) -> Self {
        let n = self.norm();
        if n > 1.0e-15 {
            Self::new(self.x / n, self.y / n, self.z / n)
        } else {
            Self::Z
        }
    }

    #[inline]
    pub fn scale(self, s: f64) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }

    #[inline]
    pub fn add(self, rhs: Self) -> Self {
        Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z)
    }

    #[inline]
    pub fn sub(self, rhs: Self) -> Self {
        Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z)
    }
}

/// 3D rigid placement (`position` in meters; `yaw_deg` around +Z, `pitch_deg` tilt, `roll_deg`).
/// Local speaker convention: +Y (or +X) forward acoustic axis; we standardize on:
/// - Local `+Y` is the primary forward acoustic radiation axis,
/// - Local `+X` is cabinet right,
/// - Local `+Z` is cabinet up.
#[derive(Copy, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Transform3 {
    pub position: Point3,
    #[serde(default)]
    pub yaw_deg: f64,
    #[serde(default)]
    pub pitch_deg: f64,
    #[serde(default)]
    pub roll_deg: f64,
}

impl Transform3 {
    pub fn at(x: f64, y: f64, z: f64) -> Self {
        Self {
            position: Point3::new(x, y, z),
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
        }
    }

    pub fn with_aim(mut self, yaw_deg: f64, pitch_deg: f64) -> Self {
        self.yaw_deg = yaw_deg;
        self.pitch_deg = pitch_deg;
        self
    }

    /// 3x3 rotation matrix (Z-yaw * X-pitch * Y-roll).
    pub fn rotation_matrix(&self) -> [[f64; 3]; 3] {
        let (sy, cy) = self.yaw_deg.to_radians().sin_cos();
        let (sp, cp) = self.pitch_deg.to_radians().sin_cos();
        let (sr, cr) = self.roll_deg.to_radians().sin_cos();
        // Local +Y is forward; yaw=0 aims along +Y, yaw=-90 aims along +X, yaw=180 aims -Y.
        // Pitch > 0 tilts local +Y upward toward +Z; Pitch < 0 tilts downward toward ground.
        [
            [cy * cr - sy * sp * sr, -sy * cp, cy * sr + sy * sp * cr],
            [sy * cr + cy * sp * sr, cy * cp, sy * sr - cy * sp * cr],
            [-cp * sr, sp, cp * cr],
        ]
    }

    pub fn transform_point(&self, local: Point3) -> Point3 {
        let r = self.rotation_matrix();
        Point3::new(
            self.position.x + r[0][0] * local.x + r[0][1] * local.y + r[0][2] * local.z,
            self.position.y + r[1][0] * local.x + r[1][1] * local.y + r[1][2] * local.z,
            self.position.z + r[2][0] * local.x + r[2][1] * local.y + r[2][2] * local.z,
        )
    }

    pub fn transform_vec(&self, local: Vec3) -> Vec3 {
        let r = self.rotation_matrix();
        Vec3::new(
            r[0][0] * local.x + r[0][1] * local.y + r[0][2] * local.z,
            r[1][0] * local.x + r[1][1] * local.y + r[1][2] * local.z,
            r[2][0] * local.x + r[2][1] * local.y + r[2][2] * local.z,
        )
    }

    /// Inverse transform from world point into cabinet-local coordinates.
    pub fn inverse_transform_point(&self, world: Point3) -> Point3 {
        let r = self.rotation_matrix();
        let d = world.sub(self.position);
        Point3::new(
            r[0][0] * d.x + r[1][0] * d.y + r[2][0] * d.z,
            r[0][1] * d.x + r[1][1] * d.y + r[2][1] * d.z,
            r[0][2] * d.x + r[1][2] * d.y + r[2][2] * d.z,
        )
    }

    /// World-space forward acoustic axis (`local +Y`).
    pub fn forward_axis(&self) -> Vec3 {
        self.transform_vec(Vec3::Y).normalized()
    }
}

/// Top-level typed error shared across acoustic crates.
#[derive(Debug, Error)]
pub enum AcousticsError {
    #[error("non-physical parameter `{field}` = {value} (expected {expected})")]
    NonPhysicalParameter {
        field: &'static str,
        value: f64,
        expected: &'static str,
    },
    #[error("mesh topology defect on `{mesh_name}`: {detail}")]
    MeshDefect { mesh_name: String, detail: String },
    #[error("singular linear system at {freq_hz:.2} Hz (rcond = {rcond:.3e})")]
    SingularSystem { freq_hz: f64, rcond: f64 },
    #[error("disconnected acoustic node {node_id}")]
    DisconnectedNode { node_id: usize },
    #[error("calibration error: {0}")]
    Calibration(String),
    #[error("I/O or format error: {0}")]
    Io(String),
}
