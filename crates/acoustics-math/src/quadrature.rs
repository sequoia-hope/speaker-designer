//! 2D symmetric Dunavant triangle quadrature & Duffy singular coordinate transformation [Ref #12].

use acoustics_types::{Point3, Vec3};

/// Barycentric 7-point degree-5 Dunavant rule `(l1, l2, l3, weight_fraction_of_area)`.
pub const DUNAVANT_7: [([f64; 3], f64); 7] = [
    ([1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0], 0.225_000_000_000_000),
    (
        [
            0.059_715_871_789_770,
            0.470_142_064_105_115,
            0.470_142_064_105_115,
        ],
        0.132_394_152_788_506,
    ),
    (
        [
            0.470_142_064_105_115,
            0.059_715_871_789_770,
            0.470_142_064_105_115,
        ],
        0.132_394_152_788_506,
    ),
    (
        [
            0.470_142_064_105_115,
            0.470_142_064_105_115,
            0.059_715_871_789_770,
        ],
        0.132_394_152_788_506,
    ),
    (
        [
            0.797_426_985_353_087,
            0.101_286_507_323_456,
            0.101_286_507_323_456,
        ],
        0.125_939_180_544_827,
    ),
    (
        [
            0.101_286_507_323_456,
            0.797_426_985_353_087,
            0.101_286_507_323_456,
        ],
        0.125_939_180_544_827,
    ),
    (
        [
            0.101_286_507_323_456,
            0.101_286_507_323_456,
            0.797_426_985_353_087,
        ],
        0.125_939_180_544_827,
    ),
];

/// 6-point 1D Gauss-Legendre on `[0, 1]` `(xi, weight)`.
pub const GAUSS_01_6: [(f64, f64); 6] = [
    (0.033_765_242_898_423_99, 0.085_662_246_189_585_17),
    (0.169_395_306_766_867_74, 0.180_380_786_524_069_3),
    (0.380_690_406_958_401_55, 0.233_956_967_286_345_52),
    (0.619_309_593_041_598_5, 0.233_956_967_286_345_52),
    (0.830_604_693_233_132_3, 0.180_380_786_524_069_3),
    (0.966_234_757_101_576, 0.085_662_246_189_585_17),
];

/// 8-point 1D Gauss-Legendre on `[0, 1]` `(xi, weight)`.
pub const GAUSS_01_8: [(f64, f64); 8] = [
    (0.019_855_071_751_231_884, 0.050_614_268_145_188_13),
    (0.101_666_761_293_186_63, 0.111_190_517_226_687_23),
    (0.237_233_795_041_835_5, 0.156_853_322_938_943_64),
    (0.408_282_678_752_175_1, 0.181_341_891_689_181),
    (0.591_717_321_247_824_9, 0.181_341_891_689_181),
    (0.762_766_204_958_164_5, 0.156_853_322_938_943_64),
    (0.898_333_238_706_813_4, 0.111_190_517_226_687_23),
    (0.980_144_928_248_768_1, 0.050_614_268_145_188_13),
];

/// Compute triangle centroid, outward normal, and area from three vertices `(p0, p1, p2)`.
#[inline]
pub fn triangle_geometry(p0: Point3, p1: Point3, p2: Point3) -> (Point3, Vec3, f64) {
    let centroid = Point3::new(
        (p0.x + p1.x + p2.x) / 3.0,
        (p0.y + p1.y + p2.y) / 3.0,
        (p0.z + p1.z + p2.z) / 3.0,
    );
    let e1 = p1.sub(p0);
    let e2 = p2.sub(p0);
    let cross = e1.cross(e2);
    let twice_area = cross.norm();
    let normal = if twice_area > 1.0e-18 {
        cross.scale(1.0 / twice_area)
    } else {
        Vec3::Z
    };
    (centroid, normal, 0.5 * twice_area)
}

/// Evaluate regular 7-point quadrature points `(point, dS_weight)` on triangle `(p0, p1, p2)`.
pub fn triangle_quad_points_7(p0: Point3, p1: Point3, p2: Point3, area: f64) -> [(Point3, f64); 7] {
    let mut out = [(Point3::ORIGIN, 0.0); 7];
    for (idx, (b, w)) in DUNAVANT_7.iter().enumerate() {
        let pt = Point3::new(
            b[0] * p0.x + b[1] * p1.x + b[2] * p2.x,
            b[0] * p0.y + b[1] * p1.y + b[2] * p2.y,
            b[0] * p0.z + b[1] * p1.z + b[2] * p2.z,
        );
        out[idx] = (pt, w * area);
    }
    out
}

/// Duffy singularity-cancelling quadrature for weakly singular `1/R` BEM self-element integrals [Ref #12]!
/// Splits `(p0, p1, p2)` into 6 right-leaning sub-triangles around edge midpoints & `centroid`
/// and applies the collapsed square map `(u, v) in [0, 1]^2` whose Jacobian `2 * area_sub * u`
/// is proportional to `R = |y - centroid|`, cancelling `1 / R` analytically to `< 1e-10`!
pub fn duffy_centroid_quad_points(p0: Point3, p1: Point3, p2: Point3) -> Vec<(Point3, f64)> {
    let (c, _, _) = triangle_geometry(p0, p1, p2);
    let edges = [(p0, p1), (p1, p2), (p2, p0)];
    let mut pts = Vec::with_capacity(216);
    for (va, vb) in edges {
        let mid = Point3::new(
            0.5 * (va.x + vb.x),
            0.5 * (va.y + vb.y),
            0.5 * (va.z + vb.z),
        );
        for (e0, e1) in [(va, mid), (mid, vb)] {
            let (_, _, area_sub) = triangle_geometry(c, e0, e1);
            if area_sub <= 1.0e-18 {
                continue;
            }
            for &(u, wu) in &GAUSS_01_6 {
                for &(v, wv) in &GAUSS_01_8 {
                    let edge_pt = Point3::new(
                        (1.0 - v) * e0.x + v * e1.x,
                        (1.0 - v) * e0.y + v * e1.y,
                        (1.0 - v) * e0.z + v * e1.z,
                    );
                    let y = Point3::new(
                        c.x + u * (edge_pt.x - c.x),
                        c.y + u * (edge_pt.y - c.y),
                        c.z + u * (edge_pt.z - c.z),
                    );
                    let ds = 2.0 * area_sub * u * wu * wv;
                    pts.push((y, ds));
                }
            }
        }
    }
    pts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_duffy_singular_integral_exactness() {
        // Integrate 1 / |y - c| over an equilateral triangle of side s = 1.0 around its centroid c!
        // Analytical value on equilateral triangle of inradius r_in = 1 / (2 * sqrt(3)):
        // In polar coords from centroid: 3 * integral_{-pi/3}^{pi/3} integral_0^{r_in / cos(theta)} (1/r) * r dr dtheta
        // = 6 * r_in * integral_0^{pi/3} sec(theta) dtheta = 6 * (1/(2*sqrt(3))) * ln(tan(pi/3) + sec(pi/3))
        // = sqrt(3) * ln(2 + sqrt(3)).
        let p0 = Point3::new(0.0, 0.0, 0.0);
        let p1 = Point3::new(1.0, 0.0, 0.0);
        let p2 = Point3::new(0.5, 3.0_f64.sqrt() / 2.0, 0.0);
        let (c, _, _) = triangle_geometry(p0, p1, p2);

        let exact = 3.0_f64.sqrt() * (2.0 + 3.0_f64.sqrt()).ln();
        let num: f64 = duffy_centroid_quad_points(p0, p1, p2)
            .into_iter()
            .map(|(y, ds)| ds / y.dist(c))
            .sum();
        assert!(
            (num - exact).abs() < 1.0e-7,
            "Duffy num={num} vs exact={exact}"
        );
    }
}
