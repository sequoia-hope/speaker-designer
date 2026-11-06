//! High-detail finite-thickness 3D CAD speaker assemblies, 2D orthographic cross-section
//! blueprints (`Side Y-Z`, `Plan X-Y`, `Front X-Z`), and Kirchhoff-Mindlin structural
//! panel-bending resonance & coloration physics.

use acoustics_types::{
    CabinetStructuralSummary, CrossSectionBlueprint2D, DriverSpec, JoineryKind, PanelMaterialKind,
    SectionDimension2D, SectionLabel2D, SectionPath2D, SectionPolygon2D, SpeakerCabinetSpec,
    VisualCabinetModel, VisualSubMesh, WayEnclosure,
};
use std::f64::consts::PI;

#[inline]
fn safe_clamp(val: f64, lo: f64, hi: f64) -> f64 {
    if hi <= lo {
        0.5 * (lo + hi)
    } else {
        val.clamp(lo, hi)
    }
}

/// Accumulator for watertight/solid 3D triangle sub-meshes tracking exact displaced solid volume (`m^3`).
#[derive(Default)]
struct SolidBuilder {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    volume_m3: f64,
}

impl SolidBuilder {
    fn push_quad(&mut self, verts: [[f64; 3]; 4], normal: [f64; 3]) {
        let base = (self.positions.len() / 3) as u32;
        for v in &verts {
            self.positions.push(v[0] as f32);
            self.positions.push(v[1] as f32);
            self.positions.push(v[2] as f32);
            self.normals.push(normal[0] as f32);
            self.normals.push(normal[1] as f32);
            self.normals.push(normal[2] as f32);
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    fn push_tri(&mut self, verts: [[f64; 3]; 3], normal: [f64; 3]) {
        let base = (self.positions.len() / 3) as u32;
        for v in &verts {
            self.positions.push(v[0] as f32);
            self.positions.push(v[1] as f32);
            self.positions.push(v[2] as f32);
            self.normals.push(normal[0] as f32);
            self.normals.push(normal[1] as f32);
            self.normals.push(normal[2] as f32);
        }
        self.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }

    /// Add an axis-aligned 6-sided solid box `[x0..x1] x [y0..y1] x [z0..z1]`.
    fn add_box(&mut self, min: [f64; 3], max: [f64; 3]) {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        if x1 <= x0 + 1e-6 || y1 <= y0 + 1e-6 || z1 <= z0 + 1e-6 {
            return;
        }
        self.volume_m3 += (x1 - x0) * (y1 - y0) * (z1 - z0);
        // +Y (Front)
        self.push_quad(
            [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
            [0.0, 1.0, 0.0],
        );
        // -Y (Rear)
        self.push_quad(
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            [0.0, -1.0, 0.0],
        );
        // +X (Right)
        self.push_quad(
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
            [1.0, 0.0, 0.0],
        );
        // -X (Left)
        self.push_quad(
            [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
            [-1.0, 0.0, 0.0],
        );
        // +Z (Top)
        self.push_quad(
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            [0.0, 0.0, 1.0],
        );
        // -Z (Bottom)
        self.push_quad(
            [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
            [0.0, 0.0, -1.0],
        );
    }

    /// Extrude a convex/star counter-clockwise 2D polygon `(y, z)` across `x in [x0, x1]`.
    fn add_prism_yz(&mut self, x0: f64, x1: f64, poly_yz: &[[f64; 2]]) {
        let n = poly_yz.len();
        if n < 3 || x1 <= x0 + 1e-6 {
            return;
        }
        let mut area2 = 0.0;
        let mut cy = 0.0;
        let mut cz = 0.0;
        for i in 0..n {
            let p0 = poly_yz[i];
            let p1 = poly_yz[(i + 1) % n];
            area2 += p0[0] * p1[1] - p1[0] * p0[1];
            cy += p0[0];
            cz += p0[1];
        }
        cy /= n as f64;
        cz /= n as f64;
        let ccw = area2 >= 0.0;
        self.volume_m3 += 0.5 * area2.abs() * (x1 - x0);

        // Side caps at x1 (+X) and x0 (-X): in (y, z), (+Y) x (+Z) = +X
        for i in 0..n {
            let p0 = poly_yz[i];
            let p1 = poly_yz[(i + 1) % n];
            if ccw {
                self.push_tri(
                    [[x1, cy, cz], [x1, p0[0], p0[1]], [x1, p1[0], p1[1]]],
                    [1.0, 0.0, 0.0],
                );
                self.push_tri(
                    [[x0, cy, cz], [x0, p1[0], p1[1]], [x0, p0[0], p0[1]]],
                    [-1.0, 0.0, 0.0],
                );
            } else {
                self.push_tri(
                    [[x1, cy, cz], [x1, p1[0], p1[1]], [x1, p0[0], p0[1]]],
                    [1.0, 0.0, 0.0],
                );
                self.push_tri(
                    [[x0, cy, cz], [x0, p0[0], p0[1]], [x0, p1[0], p1[1]]],
                    [-1.0, 0.0, 0.0],
                );
            }

            // Perimeter ribbon face between p0 and p1
            let dy = p1[0] - p0[0];
            let dz = p1[1] - p0[1];
            let len = (dy * dy + dz * dz).sqrt().max(1e-12);
            let (ny, nz) = if ccw {
                (dz / len, -dy / len)
            } else {
                (-dz / len, dy / len)
            };
            if ccw {
                self.push_quad(
                    [
                        [x0, p0[0], p0[1]],
                        [x1, p0[0], p0[1]],
                        [x1, p1[0], p1[1]],
                        [x0, p1[0], p1[1]],
                    ],
                    [0.0, ny, nz],
                );
            } else {
                self.push_quad(
                    [
                        [x0, p0[0], p0[1]],
                        [x0, p1[0], p1[1]],
                        [x1, p1[0], p1[1]],
                        [x1, p0[0], p0[1]],
                    ],
                    [0.0, ny, nz],
                );
            }
        }
    }

    /// Add a single rectangular band `[u0..u1] x [v0..v1]` extruded across `w in [w0..w1]` with a circular
    /// bore `(cu, cv, r_hole)` and optional front counterbore rebate `(r_rebate, rebate_depth)` on the `w1` face.
    /// `axis` selects plane orientation:
    /// - `0`: `(u, v, w) = (X, Z, Y)` for vertical front/rear/internal baffles (`+w = +Y` forward normal)
    /// - `1`: `(u, v, w) = (X, Y, Z)` for horizontal perforated window braces (`+w = +Z` upward normal)
    #[allow(clippy::too_many_arguments)]
    fn add_band_with_circular_bore(
        &mut self,
        axis: u8,
        u0: f64,
        u1: f64,
        v0: f64,
        v1: f64,
        w0: f64,
        w1: f64,
        cu: f64,
        cv: f64,
        r_hole_raw: f64,
        r_rebate_raw: f64,
        rebate_depth_raw: f64,
    ) {
        if u1 <= u0 + 1e-6 || v1 <= v0 + 1e-6 || w1 <= w0 + 1e-6 {
            return;
        }
        let margin = ((cu - u0).min(u1 - cu)).min((cv - v0).min(v1 - cv));
        if margin <= 0.004 || r_hole_raw <= 0.002 {
            if axis == 0 {
                self.add_box([u0, w0, v0], [u1, w1, v1]);
            } else {
                self.add_box([u0, v0, w0], [u1, v1, w1]);
            }
            return;
        }

        let r_hole = r_hole_raw.min(0.88 * margin);
        let has_rebate = rebate_depth_raw > 1e-4 && r_rebate_raw > r_hole + 0.001;
        let r_reb = if has_rebate {
            r_rebate_raw.min(0.95 * margin)
        } else {
            r_hole
        };
        let reb_d = if has_rebate {
            rebate_depth_raw.min(0.65 * (w1 - w0))
        } else {
            0.0
        };
        let w_reb = w1 - reb_d;

        // Collect 36 uniform ray angles + the 4 exact corner angles so outer rectangle is exact!
        let mut angles: Vec<f64> = (0..36).map(|i| 2.0 * PI * (i as f64) / 36.0).collect();
        for &( uc, vc ) in &[(u1, v1), (u0, v1), (u0, v0), (u1, v0)] {
            let mut a = (vc - cv).atan2(uc - cu);
            if a < 0.0 {
                a += 2.0 * PI;
            }
            if angles.iter().all(|&ex| (ex - a).abs() > 1e-4 && (ex - a - 2.0 * PI).abs() > 1e-4) {
                angles.push(a);
            }
        }
        angles.sort_by(|a, b| a.partial_cmp(b).unwrap());

        let map_pt = |u: f64, v: f64, w: f64| -> [f64; 3] {
            if axis == 0 {
                // Note: for (X, Z, Y), (u, v) = (x, z); in (x, z), (+X) x (+Z) = -Y, so swap winding for +w!
                [u, w, v]
            } else {
                // For (X, Y, Z), (+X) x (+Y) = +Z = +w!
                [u, v, w]
            }
        };
        let map_n = |nu: f64, nv: f64, nw: f64| -> [f64; 3] {
            if axis == 0 {
                [nu, nw, nv]
            } else {
                [nu, nv, nw]
            }
        };
        let emit_quad = |s: &mut Self, q: [[f64; 3]; 4], n: [f64; 3]| {
            if axis == 0 {
                // Reverse winding because det([e_x, e_z, e_y]) = -1
                s.push_quad([q[0], q[3], q[2], q[1]], n);
            } else {
                s.push_quad(q, n);
            }
        };

        let outer_ray = |ang: f64| -> [f64; 2] {
            let du = ang.cos();
            let dv = ang.sin();
            let tu = if du > 1e-12 {
                (u1 - cu) / du
            } else if du < -1e-12 {
                (u0 - cu) / du
            } else {
                f64::INFINITY
            };
            let tv = if dv > 1e-12 {
                (v1 - cv) / dv
            } else if dv < -1e-12 {
                (v0 - cv) / dv
            } else {
                f64::INFINITY
            };
            let t = tu.min(tv);
            [
                (cu + t * du).clamp(u0, u1),
                (cv + t * dv).clamp(v0, v1),
            ]
        };

        let m = angles.len();
        for i in 0..m {
            let a0 = angles[i];
            let a1 = angles[(i + 1) % m];
            let p_out0 = outer_ray(a0);
            let p_out1 = outer_ray(a1);
            let c0 = a0.cos();
            let s0 = a0.sin();
            let c1 = a1.cos();
            let s1 = a1.sin();
            let cm = (0.5 * (a0 + if a1 < a0 { a1 + 2.0 * PI } else { a1 })).cos();
            let sm = (0.5 * (a0 + if a1 < a0 { a1 + 2.0 * PI } else { a1 })).sin();

            // 1. Front face (+w) from r_reb to outer boundary
            emit_quad(
                self,
                [
                    map_pt(cu + r_reb * c0, cv + r_reb * s0, w1),
                    map_pt(p_out0[0], p_out0[1], w1),
                    map_pt(p_out1[0], p_out1[1], w1),
                    map_pt(cu + r_reb * c1, cv + r_reb * s1, w1),
                ],
                map_n(0.0, 0.0, 1.0),
            );

            // 2. Optional CNC flush-mount counterbore rebate wall + shelf
            if has_rebate {
                emit_quad(
                    self,
                    [
                        map_pt(cu + r_reb * c0, cv + r_reb * s0, w_reb),
                        map_pt(cu + r_reb * c0, cv + r_reb * s0, w1),
                        map_pt(cu + r_reb * c1, cv + r_reb * s1, w1),
                        map_pt(cu + r_reb * c1, cv + r_reb * s1, w_reb),
                    ],
                    map_n(-cm, -sm, 0.0),
                );
                emit_quad(
                    self,
                    [
                        map_pt(cu + r_hole * c0, cv + r_hole * s0, w_reb),
                        map_pt(cu + r_reb * c0, cv + r_reb * s0, w_reb),
                        map_pt(cu + r_reb * c1, cv + r_reb * s1, w_reb),
                        map_pt(cu + r_hole * c1, cv + r_hole * s1, w_reb),
                    ],
                    map_n(0.0, 0.0, 1.0),
                );
            }

            // 3. Inner cylindrical bore wall at r_hole from w0 to w_reb
            emit_quad(
                self,
                [
                    map_pt(cu + r_hole * c0, cv + r_hole * s0, w0),
                    map_pt(cu + r_hole * c0, cv + r_hole * s0, w_reb),
                    map_pt(cu + r_hole * c1, cv + r_hole * s1, w_reb),
                    map_pt(cu + r_hole * c1, cv + r_hole * s1, w0),
                ],
                map_n(-cm, -sm, 0.0),
            );

            // 4. Back face (-w) from r_hole to outer boundary
            emit_quad(
                self,
                [
                    map_pt(cu + r_hole * c0, cv + r_hole * s0, w0),
                    map_pt(cu + r_hole * c1, cv + r_hole * s1, w0),
                    map_pt(p_out1[0], p_out1[1], w0),
                    map_pt(p_out0[0], p_out0[1], w0),
                ],
                map_n(0.0, 0.0, -1.0),
            );
        }

        // 5. Outer 4 perimeter edges of the rectangular band
        emit_quad(
            self,
            [
                map_pt(u0, v0, w0),
                map_pt(u1, v0, w0),
                map_pt(u1, v0, w1),
                map_pt(u0, v0, w1),
            ],
            map_n(0.0, -1.0, 0.0),
        );
        emit_quad(
            self,
            [
                map_pt(u1, v0, w0),
                map_pt(u1, v1, w0),
                map_pt(u1, v1, w1),
                map_pt(u1, v0, w1),
            ],
            map_n(1.0, 0.0, 0.0),
        );
        emit_quad(
            self,
            [
                map_pt(u1, v1, w0),
                map_pt(u0, v1, w0),
                map_pt(u0, v1, w1),
                map_pt(u1, v1, w1),
            ],
            map_n(0.0, 1.0, 0.0),
        );
        emit_quad(
            self,
            [
                map_pt(u0, v1, w0),
                map_pt(u0, v0, w0),
                map_pt(u0, v0, w1),
                map_pt(u0, v1, w1),
            ],
            map_n(-1.0, 0.0, 0.0),
        );

        let gross = (u1 - u0) * (v1 - v0) * (w1 - w0);
        let hole_vol = PI * r_hole * r_hole * (w1 - w0)
            + PI * (r_reb * r_reb - r_hole * r_hole) * reb_d;
        self.volume_m3 += (gross - hole_vol).max(0.05 * gross);
    }

    /// Revolve a closed counter-clockwise 2D profile `(r, dy)` (`r >= 0`) around a `Y`-axis line passing through `origin`.
    fn add_revolved_y(&mut self, origin: [f64; 3], profile_ry: &[[f64; 2]], segs: usize) {
        let m = profile_ry.len();
        if m < 3 || segs < 8 {
            return;
        }
        // Pappus centroid theorem for exact revolved solid volume: V = 2 * pi * r_centroid * Area
        let mut area2 = 0.0;
        let mut r_weighted = 0.0;
        for i in 0..m {
            let [r0, y0] = profile_ry[i];
            let [r1, y1] = profile_ry[(i + 1) % m];
            let cross = r0 * y1 - r1 * y0;
            area2 += cross;
            r_weighted += (r0 + r1) * cross;
        }
        if area2.abs() > 1e-12 {
            let area = 0.5 * area2.abs();
            let r_bar = (r_weighted / (3.0 * area2)).abs();
            self.volume_m3 += 2.0 * PI * r_bar * area;
        }
        let ccw = area2 >= 0.0;

        for i in 0..m {
            let [r0, dy0] = profile_ry[i];
            let [r1, dy1] = profile_ry[(i + 1) % m];
            let dr = r1 - r0;
            let dy = dy1 - dy0;
            let len = (dr * dr + dy * dy).sqrt();
            if len < 1e-8 || (r0 < 1e-6 && r1 < 1e-6) {
                continue;
            }
            // Outward 2D normal in (r, y) plane:
            let (nr, ny) = if ccw {
                (dy / len, -dr / len)
            } else {
                (-dy / len, dr / len)
            };

            for s in 0..segs {
                let a0 = 2.0 * PI * (s as f64) / (segs as f64);
                let a1 = 2.0 * PI * ((s + 1) as f64) / (segs as f64);
                let am = 0.5 * (a0 + a1);
                let (s0, c0) = a0.sin_cos();
                let (s1, c1) = a1.sin_cos();
                let (sm, cm) = am.sin_cos();

                let p00 = [origin[0] + r0 * c0, origin[1] + dy0, origin[2] + r0 * s0];
                let p10 = [origin[0] + r0 * c1, origin[1] + dy0, origin[2] + r0 * s1];
                let p11 = [origin[0] + r1 * c1, origin[1] + dy1, origin[2] + r1 * s1];
                let p01 = [origin[0] + r1 * c0, origin[1] + dy1, origin[2] + r1 * s0];
                let n3 = [nr * cm, ny, nr * sm];

                // Check orientation: tangent_theta = (-sin, 0, cos), tangent_edge = (dr*cos, dy, dr*sin)
                // t_edge x t_theta = (-dy*sin? Wait: (dr*c, dy, dr*s) x (-s, 0, c) = (dy*c, -dr*s^2 - dr*c^2, dy*s) = (dy*c, -dr, dy*s)!)
                // That matches (nr*c, ny, nr*s) when ccw (`nr = +dy/len, ny = -dr/len`)!
                // In push_quad([q0, q1, q2, q3]), (q1 - q0) x (q2 - q0) should point along n3:
                // Let q0 = p00, q1 = p01 (along edge), q2 = p11 (along +theta): (p01-p00) x (p11-p01) = t_edge x t_theta!
                if ccw {
                    self.push_quad([p00, p01, p11, p10], n3);
                } else {
                    self.push_quad([p00, p10, p11, p01], n3);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        self,
        part_id: &str,
        name: &str,
        role: &str,
        layer: &str,
        material_name: &str,
        color_hex: &str,
        opacity: f32,
        thickness_mm: f64,
        cut_dims_mm: [f64; 3],
        density_kg_m3: f64,
        explode_offset_m: [f64; 3],
        notes: &str,
    ) -> (VisualSubMesh, f64) {
        let vol = self.volume_m3;
        let mass_kg = (vol * density_kg_m3) as f32;
        (
            VisualSubMesh {
                name: name.into(),
                role: role.into(),
                color_hex: color_hex.into(),
                opacity,
                part_id: part_id.into(),
                layer: layer.into(),
                material_name: material_name.into(),
                thickness_mm: thickness_mm as f32,
                cut_dims_mm: [
                    cut_dims_mm[0] as f32,
                    cut_dims_mm[1] as f32,
                    cut_dims_mm[2] as f32,
                ],
                mass_kg,
                explode_offset_m: [
                    explode_offset_m[0] as f32,
                    explode_offset_m[1] as f32,
                    explode_offset_m[2] as f32,
                ],
                notes: notes.into(),
                positions: self.positions,
                normals: self.normals,
                indices: self.indices,
            },
            vol,
        )
    }
}

#[derive(Clone, Debug)]
struct BaffleOpening {
    way_label: String,
    cx: f64,
    cz: f64,
    /// `"circle"` or `"rect_slot"`.
    is_rect: bool,
    r_bore: f64,
    r_rebate: f64,
    rebate_depth: f64,
    rect_w: f64,
    rect_h: f64,
}

/// Build a full engineering-grade solid finite-thickness 3D cabinet assembly,
/// 2D orthographic CAD cross-section blueprints, and Kirchhoff-Mindlin structural summary!
pub fn build_detailed_cabinet_cad(
    spec: &SpeakerCabinetSpec,
    drivers: &[DriverSpec],
) -> VisualCabinetModel {
    let [w, d, h] = spec.dims_m;
    let c = &spec.construction;
    let wall_t = c.wall_thickness_m.clamp(0.008, 0.050);
    let baffle_t = c.front_baffle_thickness_m.clamp(0.010, 0.065);
    let part_t = c.internal_partition_thickness_m.clamp(0.008, 0.045);
    let brace_t = c.brace_thickness_m.clamp(0.010, 0.045);
    let rebate_d = c.driver_rebate_depth_m.clamp(0.0, 0.55 * baffle_t);
    let damp_t = c.damping_lining_thickness_m.clamp(0.0, 0.060);

    let enc_mat = &c.enclosure_material;
    let baf_mat = &c.baffle_material;
    let max_dim = w.max(d).max(h);

    // Rabbet engagement depth (50% of outer wall thickness for RabbetDado / InterlockingCncTab)
    let rab = match c.joinery {
        JoineryKind::RabbetDado | JoineryKind::InterlockingCncTab => 0.5 * wall_t,
        JoineryKind::Miter45 => 0.0,
    };

    let is_tapped_horn = spec
        .ways
        .iter()
        .any(|wy| matches!(wy.enclosure, WayEnclosure::TappedHorn { .. }));
    let is_folded_horn = !is_tapped_horn
        && (spec.visual_fold_count > 0
            || spec
                .ways
                .iter()
                .any(|wy| matches!(wy.enclosure, WayEnclosure::FoldedHorn { .. })));
    let is_dual_opposed = spec.ways.len() == 1
        && spec.ways[0].driver_count >= 2
        && matches!(spec.ways[0].enclosure, WayEnclosure::Sealed { .. });

    let hx = 0.5 * w;
    let hy = 0.5 * d;
    let in_hx = hx - wall_t;
    let in_y0 = -hy + if is_dual_opposed { baffle_t } else { wall_t };
    let in_y1 = hy - baffle_t;
    let in_z0 = wall_t;
    let in_z1 = h - wall_t;
    let cardioid_way = spec.ways.iter().find_map(|wy| {
        if let WayEnclosure::CardioidSlot {
            slot_flow_resistivity,
            port,
            ..
        } = &wy.enclosure
        {
            Some((wy.local_acoustic_offset.z, *slot_flow_resistivity, port.clone()))
        } else {
            None
        }
    });

    let mut submeshes: Vec<VisualSubMesh> = Vec::new();
    let mut shell_vol = 0.0;
    let mut internal_vol = 0.0;
    let mut damping_vol = 0.0;
    let mut drivers_vol = 0.0;
    let mut woodwork_mass = 0.0;
    let mut drivers_mass = 0.0;
    let mut damping_hw_mass = 0.0;

    // ------------------------------------------------------------------------
    // 1. OUTER ENCLOSURE PANELS (Left, Right, Top, Bottom, Rear + Terminal Pocket)
    // ------------------------------------------------------------------------
    for (side_sign, part_id, name) in [
        (-1.0_f64, "left_wall", "Left Side Wall"),
        (1.0_f64, "right_wall", "Right Side Wall"),
    ] {
        let mut sb = SolidBuilder::default();
        let (x0, x1) = if side_sign < 0.0 {
            (-hx, -in_hx)
        } else {
            (in_hx, hx)
        };
        if let Some((z_slot, _, _)) = &cardioid_way {
            // Side wall with CNC-routed acoustic cardioid resistive slot opening!
            let sy0 = -0.14 * d;
            let sy1 = 0.04 * d;
            let sz0 = (z_slot - 0.11).max(in_z0 + 0.02);
            let sz1 = (z_slot + 0.11).min(in_z1 - 0.02);
            sb.add_box([x0, -hy, 0.0], [x1, hy, sz0]);
            sb.add_box([x0, -hy, sz1], [x1, hy, h]);
            sb.add_box([x0, -hy, sz0], [x1, sy0, sz1]);
            sb.add_box([x0, sy1, sz0], [x1, hy, sz1]);
            // Two horizontal structural ribs across the resistive slot
            for frac in [0.34, 0.67] {
                let zr = sz0 + frac * (sz1 - sz0);
                sb.add_box([x0, sy0, zr - 0.005], [x1, sy1, zr + 0.005]);
            }
        } else {
            sb.add_box([x0, -hy, 0.0], [x1, hy, h]);
        }
        let (sm, vol) = sb.finish(
            part_id,
            name,
            "shell",
            "outer_shell",
            &enc_mat.name,
            &enc_mat.color_hex,
            0.34,
            wall_t * 1000.0,
            [h * 1000.0, d * 1000.0, wall_t * 1000.0],
            enc_mat.density_kg_m3,
            [side_sign * 0.24 * max_dim, 0.0, 0.0],
            if cardioid_way.is_some() {
                "CNC-slotted cardioid vent + perimeter dado housing"
            } else {
                c.joinery.label()
            },
        );
        woodwork_mass += sm.mass_kg as f64;
        shell_vol += vol;
        submeshes.push(sm);
    }

    // Top & Bottom Panels (seated into side-wall rabbets `[-in_hx - rab .. +in_hx + rab]`)
    let tb_hx = in_hx + rab;
    for (is_top, part_id, name) in [(true, "top_panel", "Top Panel"), (false, "bottom_panel", "Bottom Panel")] {
        let mut sb = SolidBuilder::default();
        let (z0, z1) = if is_top { (in_z1, h) } else { (0.0, in_z0) };
        sb.add_box([-tb_hx, -hy, z0], [tb_hx, hy, z1]);
        let (sm, vol) = sb.finish(
            part_id,
            name,
            "shell",
            "outer_shell",
            &enc_mat.name,
            &enc_mat.color_hex,
            0.34,
            wall_t * 1000.0,
            [d * 1000.0, 2.0 * tb_hx * 1000.0, wall_t * 1000.0],
            enc_mat.density_kg_m3,
            [0.0, 0.0, if is_top { 0.22 * max_dim } else { -0.18 * max_dim }],
            c.joinery.label(),
        );
        woodwork_mass += sm.mass_kg as f64;
        shell_vol += vol;
        submeshes.push(sm);
    }

    // Rear Panel (`y in [-hy, in_y0]`) with recessed CNC speakON / active DSP plate cutout + optional rear port!
    {
        let mut sb = SolidBuilder::default();
        let rx0 = -tb_hx;
        let rx1 = tb_hx;
        let rz0 = in_z0 - rab;
        let rz1 = in_z1 + rab;
        let term_w = (0.14_f64).min(0.45 * w);
        let term_h = 0.11_f64.min(0.22 * h);

        // Check if any port exits the rear panel (`local_normal.y < -0.5`)
        let rear_port = spec.ways.iter().find_map(|wy| match &wy.enclosure {
            WayEnclosure::Vented { port, .. } if port.local_normal.y < -0.5 => Some(port),
            WayEnclosure::CardioidSlot { port: Some(p), .. } if p.local_normal.y < -0.5 => Some(p),
            _ => None,
        });

        let term_zc = if rear_port.is_some() {
            safe_clamp(0.58 * h, in_z0 + 0.18, in_z1 - 0.09)
        } else {
            safe_clamp(0.28 * h, in_z0 + 0.09, in_z1 - 0.09)
        };

        if is_dual_opposed {
            let drv = spec
                .ways
                .first()
                .and_then(|wy| drivers.iter().find(|dr| dr.id == wy.driver_id));
            let r_cone = drv
                .map(|dr| dr.small_signal.piston_radius_m())
                .unwrap_or(0.125)
                .min(0.76 * in_hx);
            let zc = spec
                .ways
                .first()
                .map(|wy| wy.local_acoustic_offset.z)
                .unwrap_or(0.5 * h);
            sb.add_band_with_circular_bore(
                0,
                rx0,
                rx1,
                rz0,
                rz1,
                -hy,
                in_y0,
                0.0,
                zc,
                r_cone,
                r_cone,
                0.0,
            );
        } else if let Some(rp) = rear_port {
            let r_port = (rp.area_m2 / PI).sqrt().min(0.32 * w);
            let pz = safe_clamp(rp.local_exit_offset.z, in_z0 + r_port + 0.015, term_zc - 0.5 * term_h - r_port - 0.02);
            let z_split = 0.5 * (pz + r_port + term_zc - 0.5 * term_h);
            sb.add_band_with_circular_bore(
                0,
                rx0,
                rx1,
                rz0,
                z_split,
                -hy,
                in_y0,
                rp.local_exit_offset.x,
                pz,
                r_port,
                r_port + 0.008,
                0.005,
            );
            // Upper rear panel with recessed connector pocket
            sb.add_box([rx0, -hy, z_split], [rx1, in_y0, term_zc - 0.5 * term_h]);
            sb.add_box([rx0, -hy, term_zc + 0.5 * term_h], [rx1, in_y0, rz1]);
            sb.add_box([rx0, -hy, term_zc - 0.5 * term_h], [-0.5 * term_w, in_y0, term_zc + 0.5 * term_h]);
            sb.add_box([0.5 * term_w, -hy, term_zc - 0.5 * term_h], [rx1, in_y0, term_zc + 0.5 * term_h]);
            // Recessed pocket backing lip
            sb.add_box(
                [-0.5 * term_w, in_y0 - 0.45 * wall_t, term_zc - 0.5 * term_h],
                [0.5 * term_w, in_y0, term_zc + 0.5 * term_h],
            );
        } else {
            sb.add_box([rx0, -hy, rz0], [rx1, in_y0, term_zc - 0.5 * term_h]);
            sb.add_box([rx0, -hy, term_zc + 0.5 * term_h], [rx1, in_y0, rz1]);
            sb.add_box([rx0, -hy, term_zc - 0.5 * term_h], [-0.5 * term_w, in_y0, term_zc + 0.5 * term_h]);
            sb.add_box([0.5 * term_w, -hy, term_zc - 0.5 * term_h], [rx1, in_y0, term_zc + 0.5 * term_h]);
            sb.add_box(
                [-0.5 * term_w, in_y0 - 0.45 * wall_t, term_zc - 0.5 * term_h],
                [0.5 * term_w, in_y0, term_zc + 0.5 * term_h],
            );
        }

        let rear_mat = if is_dual_opposed { baf_mat } else { enc_mat };
        let rear_t = if is_dual_opposed { baffle_t } else { wall_t };
        let (sm, vol) = sb.finish(
            "rear_panel",
            if is_dual_opposed {
                "Rear Opposed Subwoofer Baffle"
            } else {
                "Rear Panel"
            },
            if is_dual_opposed { "baffle" } else { "shell" },
            if is_dual_opposed {
                "front_baffle"
            } else {
                "outer_shell"
            },
            &rear_mat.name,
            &rear_mat.color_hex,
            if is_dual_opposed { 0.80 } else { 0.34 },
            rear_t * 1000.0,
            [(rz1 - rz0) * 1000.0, (rx1 - rx0) * 1000.0, rear_t * 1000.0],
            rear_mat.density_kg_m3,
            [0.0, -0.25 * max_dim, 0.0],
            if is_dual_opposed {
                "CNC-bored rear force-canceling subwoofer baffle"
            } else {
                "Rabbeted perimeter + CNC recessed speakON pocket"
            },
        );
        woodwork_mass += sm.mass_kg as f64;
        shell_vol += vol;
        submeshes.push(sm);

        if !is_dual_opposed {
            // Recessed 3.0 mm Aluminum speakON / Amp Connector Plate
            let mut hw = SolidBuilder::default();
            hw.add_box(
                [-0.5 * term_w + 0.002, in_y0 - 0.52 * wall_t - 0.003, term_zc - 0.5 * term_h + 0.002],
                [0.5 * term_w - 0.002, in_y0 - 0.52 * wall_t, term_zc + 0.5 * term_h - 0.002],
            );
            for sx in [-0.026_f64, 0.026_f64] {
                if sx.abs() + 0.016 < 0.5 * term_w {
                    hw.add_revolved_y(
                        [sx, in_y0 - 0.52 * wall_t - 0.003, term_zc],
                        &[[0.009, -0.014], [0.013, -0.014], [0.013, 0.0], [0.009, 0.0]],
                        20,
                    );
                }
            }
            let (hw_sm, _) = hw.finish(
                "terminal_plate",
                "Recessed NL4 / DSP Input Plate",
                "hardware",
                "hardware",
                "3.0 mm Black Anodized 6061-T6 Aluminum",
                "#475569",
                0.95,
                3.0,
                [term_w * 1000.0, term_h * 1000.0, 3.0],
                2700.0,
                [0.0, -0.36 * max_dim, 0.0],
                "Gasketed airtight terminal cup + dual Neutrik NL4MP",
            );
            damping_hw_mass += hw_sm.mass_kg as f64 + 0.65; // + bolts, gasket & feet
            submeshes.push(hw_sm);
        } else {
            damping_hw_mass += 0.85; // Bottom-mounted Neutrik NL4 + isolation feet
        }
    }

    // ------------------------------------------------------------------------
    // 2. ARCHITECTURE-SPECIFIC BAFFLE, INTERNAL HORN / CHAMBERS, BRACES & DRIVERS
    // ------------------------------------------------------------------------
    let mut blueprint_openings: Vec<BaffleOpening> = Vec::new();

    if is_tapped_horn {
        // ====================================================================
        // TAPPED BASS HORN ARCHITECTURE (e.g. Keystone-18TH Dual-Side Loading)
        // Rear cone feeds closed throat -> rear turnaround -> tap junction;
        // Front cone feeds directly into mouth flare for λ/2 phase-coherent sum!
        // ====================================================================
        let z_mouth_top = 0.44 * h;
        let z_tap_floor = 0.485 * h;
        let y_tap_baffle = 0.16 * d; // Near-mouth tap bulkhead!
        let y_rear_turn = in_y0 + 0.23 * d;

        // 2a. Upper-Front Horn Closure Wall (`z in [z_mouth_top .. in_z1 + rab]`)
        {
            let mut sb = SolidBuilder::default();
            sb.add_box([-tb_hx, in_y1, z_mouth_top], [tb_hx, hy, in_z1 + rab]);
            let (sm, vol) = sb.finish(
                "front_baffle",
                "Upper-Front Tapped-Horn Closure Wall",
                "baffle",
                "front_baffle",
                &baf_mat.name,
                &baf_mat.color_hex,
                0.78,
                baffle_t * 1000.0,
                [(in_z1 + rab - z_mouth_top) * 1000.0, 2.0 * tb_hx * 1000.0, baffle_t * 1000.0],
                baf_mat.density_kg_m3,
                [0.0, 0.26 * max_dim, 0.0],
                "Forms closed upper tap flare + lower 3,800 cm² tapped-horn mouth",
            );
            woodwork_mass += sm.mass_kg as f64;
            shell_vol += vol;
            submeshes.push(sm);

            blueprint_openings.push(BaffleOpening {
                way_label: "Tapped Horn Mouth".into(),
                cx: 0.0,
                cz: 0.5 * (in_z0 + z_mouth_top),
                is_rect: true,
                r_bore: 0.0,
                r_rebate: 0.0,
                rebate_depth: 0.0,
                rect_w: 2.0 * in_hx,
                rect_h: z_mouth_top - in_z0,
            });
        }

        // 2b. Internal Near-Mouth Tap Driver Baffle (`y_tap_baffle`, `z in [z_tap_floor .. in_z1]`)
        let drv = spec
            .ways
            .first()
            .and_then(|wy| drivers.iter().find(|dr| dr.id == wy.driver_id));
        let r_cone = drv.map(|dr| dr.small_signal.piston_radius_m()).unwrap_or(0.185);
        let z_drv = 0.5 * (z_tap_floor + in_z1);
        let r_bore = r_cone.min(0.42 * (in_z1 - z_tap_floor));
        {
            let mut sb = SolidBuilder::default();
            sb.add_band_with_circular_bore(
                0,
                -in_hx,
                in_hx,
                z_tap_floor,
                in_z1,
                y_tap_baffle - baffle_t,
                y_tap_baffle,
                0.0,
                z_drv,
                r_bore,
                r_bore + 0.018,
                rebate_d,
            );
            let (sm, vol) = sb.finish(
                "tap_driver_baffle",
                "Internal Tap-Junction Driver Baffle",
                "internal_horn",
                "internal_horn",
                &baf_mat.name,
                &baf_mat.color_hex,
                0.92,
                baffle_t * 1000.0,
                [(in_z1 - z_tap_floor) * 1000.0, 2.0 * in_hx * 1000.0, baffle_t * 1000.0],
                baf_mat.density_kg_m3,
                [0.0, 0.14 * max_dim, 0.08 * max_dim],
                "Dual-side loading: rear cone feeds closed throat; front cone feeds mouth tap!",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2c. Tapped-Horn Center Fold Divider (`y_rear_turn .. y_tap_baffle`, tapering down toward rear turnaround)
        {
            let mut sb = SolidBuilder::default();
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [y_rear_turn, 0.36 * h],
                    [y_tap_baffle, z_tap_floor - part_t],
                    [y_tap_baffle, z_tap_floor],
                    [y_rear_turn, 0.36 * h + part_t],
                ],
            );
            // Upper throat progressive compression ramp behind driver magnet
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y0 + 0.14 * d, in_z1 - 0.11 * h],
                    [y_tap_baffle - baffle_t, in_z1],
                    [in_y0 + 0.14 * d, in_z1],
                ],
            );
            let (sm, vol) = sb.finish(
                "tapped_horn_divider",
                "Tapped-Horn Expanding Throat-to-Tap Divider",
                "internal_horn",
                "internal_horn",
                &enc_mat.name,
                "#dea868",
                0.92,
                part_t * 1000.0,
                [(y_tap_baffle - y_rear_turn) * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, -0.06 * max_dim, 0.04 * max_dim],
                "2.15 m expanding throat-to-tap channel (720 → 2,100 cm²) + throat wedge",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2d. Rear 180-Degree Turnaround Miter Reflectors (Upper & Lower Rear Corners)
        {
            let mut sb = SolidBuilder::default();
            let leg_u = 0.14 * d;
            let leg_l = 0.15 * d;
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y0, in_z1],
                    [in_y0, in_z1 - leg_u],
                    [in_y0 + leg_u, in_z1],
                ],
            );
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y0, in_z0],
                    [in_y0 + leg_l, in_z0],
                    [in_y0, in_z0 + leg_l],
                ],
            );
            // Upper-front tap-to-mouth deflector above front cone
            let leg_f = 0.11 * d;
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y1 - leg_f, in_z1],
                    [in_y1, in_z1 - leg_f],
                    [in_y1, in_z1],
                ],
            );
            let (sm, vol) = sb.finish(
                "tapped_corner_reflectors",
                "45° Turnaround & Tap-Mouth Deflectors (×3)",
                "internal_horn",
                "internal_horn",
                &enc_mat.name,
                "#cfa063",
                0.94,
                part_t * 1000.0,
                [leg_l * 1.414 * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, -0.14 * max_dim, -0.06 * max_dim],
                "Smooths 180° rear turnaround and guides front cone wave down into mouth",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2e. Center Mouth & Lower Channel Tie Brace
        if c.brace_count > 0 {
            let mut sb = SolidBuilder::default();
            let hb = 0.5 * brace_t;
            sb.add_prism_yz(
                -hb,
                hb,
                &[
                    [y_rear_turn + 0.05, in_z0],
                    [hy - 0.02, in_z0],
                    [hy - 0.02, z_mouth_top],
                    [y_tap_baffle, z_tap_floor - part_t],
                    [y_rear_turn + 0.05, 0.36 * h],
                ],
            );
            let (sm, vol) = sb.finish(
                "tapped_tie_brace",
                "Center Mouth V-Splitter & Divider Tie Brace",
                "brace",
                "bracing",
                &enc_mat.name,
                "#e2b879",
                0.94,
                brace_t * 1000.0,
                [(hy - y_rear_turn) * 1000.0, z_mouth_top * 1000.0, brace_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, 0.24 * max_dim, -0.06 * max_dim],
                "Locks bottom panel, tap divider, and front closure into a rigid box girder",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2f. High-Excursion 18" Tapped-Horn Subwoofer at `y_tap_baffle`
        let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
            "tapped_sub",
            "18\" High-Xmax Tapped-Horn Sub",
            drv,
            [0.0, y_tap_baffle, z_drv],
            1.0,
            r_bore,
            rebate_d,
            [0.0, 0.16 * max_dim, 0.10 * max_dim],
        );
        drivers_vol += d_vol;
        drivers_mass += d_mass;
        submeshes.extend(drv_sms);
    } else if is_folded_horn {
        // ====================================================================
        // FOLDED BASS HORN ARCHITECTURE (e.g. TerraHorn-18: 3-Fold Serpentine)
        // ====================================================================
        let z_mouth_top = 0.435 * h;
        let z_ch_floor = 0.495 * h;
        let y_ch_baffle = -0.055 * d; // Internal sealed-chamber front baffle
        let y_fold1_gap = in_y1 - 0.175 * d;
        let y_fold2_gap = in_y0 + 0.215 * d;

        // 2a. Upper-Front Closed Horn Wall (`baffle_t` thick, `z in [z_mouth_top .. in_z1 + rab]`)
        {
            let mut sb = SolidBuilder::default();
            sb.add_box([-tb_hx, in_y1, z_mouth_top], [tb_hx, hy, in_z1 + rab]);
            let (sm, vol) = sb.finish(
                "front_baffle",
                "Upper-Front Horn Closure Baffle",
                "baffle",
                "front_baffle",
                &baf_mat.name,
                &baf_mat.color_hex,
                0.76,
                baffle_t * 1000.0,
                [(in_z1 + rab - z_mouth_top) * 1000.0, 2.0 * tb_hx * 1000.0, baffle_t * 1000.0],
                baf_mat.density_kg_m3,
                [0.0, 0.26 * max_dim, 0.0],
                "Double-laminated rabbeted front horn closure + Fold-1 pressure wall",
            );
            woodwork_mass += sm.mass_kg as f64;
            shell_vol += vol;
            submeshes.push(sm);

            blueprint_openings.push(BaffleOpening {
                way_label: "Folded Horn Mouth".into(),
                cx: 0.0,
                cz: 0.5 * (in_z0 + z_mouth_top),
                is_rect: true,
                r_bore: 0.0,
                r_rebate: 0.0,
                rebate_depth: 0.0,
                rect_w: 2.0 * in_hx,
                rect_h: z_mouth_top - in_z0,
            });
        }

        // 2b. Internal 24 mm Driver Throat Baffle (`y in [y_ch_baffle - baffle_t .. y_ch_baffle]`, `z in [z_ch_floor .. in_z1]`)
        let drv = spec
            .ways
            .first()
            .and_then(|wy| drivers.iter().find(|dr| dr.id == wy.driver_id));
        let r_cone = drv.map(|dr| dr.small_signal.piston_radius_m()).unwrap_or(0.185);
        let z_drv = 0.5 * (z_ch_floor + in_z1);
        let r_bore = r_cone.min(0.42 * (in_z1 - z_ch_floor));
        {
            let mut sb = SolidBuilder::default();
            sb.add_band_with_circular_bore(
                0,
                -in_hx,
                in_hx,
                z_ch_floor,
                in_z1,
                y_ch_baffle - baffle_t,
                y_ch_baffle,
                0.0,
                z_drv,
                r_bore,
                r_bore + 0.018,
                rebate_d,
            );
            let (sm, vol) = sb.finish(
                "internal_driver_baffle",
                "Internal Horn Throat Driver Baffle",
                "internal_horn",
                "internal_horn",
                &baf_mat.name,
                &baf_mat.color_hex,
                0.92,
                baffle_t * 1000.0,
                [(in_z1 - z_ch_floor) * 1000.0, 2.0 * in_hx * 1000.0, baffle_t * 1000.0],
                baf_mat.density_kg_m3,
                [0.0, 0.06 * max_dim, 0.08 * max_dim],
                "CNC-rebated internal compression-chamber driver bulkhead + T-nuts",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2c. Sealed Rear Chamber Floor + Fold-1 Tongue Partition (`z_ch_floor`)
        {
            let mut sb = SolidBuilder::default();
            // Horizontal rear-chamber floor (`in_y0 .. y_ch_baffle`) + sloping Fold-1 tongue (`y_ch_baffle .. y_fold1_gap`)
            sb.add_box([-in_hx, in_y0, z_ch_floor - part_t], [in_hx, y_ch_baffle, z_ch_floor]);
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [y_ch_baffle, z_ch_floor - part_t],
                    [y_fold1_gap, z_ch_floor + 0.055 * h - part_t],
                    [y_fold1_gap, z_ch_floor + 0.055 * h],
                    [y_ch_baffle, z_ch_floor],
                ],
            );
            let (sm, vol) = sb.finish(
                "horn_partition_1",
                "Chamber Floor & Fold-1 Salmon Ramp",
                "internal_horn",
                "internal_horn",
                &enc_mat.name,
                "#dea868",
                0.92,
                part_t * 1000.0,
                [(y_fold1_gap - in_y0) * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, 0.12 * max_dim, 0.04 * max_dim],
                "Dadoed into side walls; forms sealed 54 L rear chamber + Throat Segment 1",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2d. Fold-2 / Mouth Flare Partition (`y_fold2_gap .. hy` meeting `z_mouth_top`)
        {
            let mut sb = SolidBuilder::default();
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [y_fold2_gap, 0.245 * h],
                    [hy, z_mouth_top - part_t],
                    [hy, z_mouth_top],
                    [y_fold2_gap, 0.245 * h + part_t],
                ],
            );
            let (sm, vol) = sb.finish(
                "horn_partition_2",
                "Fold-2 Exponential Mouth Divider",
                "internal_horn",
                "internal_horn",
                &enc_mat.name,
                "#dea868",
                0.92,
                part_t * 1000.0,
                [((hy - y_fold2_gap).hypot(z_mouth_top - 0.245 * h)) * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, 0.16 * max_dim, -0.04 * max_dim],
                "Separates Mid Return Channel from Final Exponential Mouth Flare",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2e. Three 45-Degree Mitered Corner Reflectors (eliminating HF fold reflections!)
        {
            let mut sb = SolidBuilder::default();
            let leg1 = 0.11 * d;
            // Upper-front Fold-1 corner reflector `(in_y1, in_z1)`
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y1 - leg1, in_z1],
                    [in_y1, in_z1 - leg1],
                    [in_y1, in_z1],
                ],
            );
            // Mid-rear Fold-2 upper reflector `(in_y0, z_ch_floor - part_t)`
            let leg2 = 0.10 * d;
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y0, z_ch_floor - part_t],
                    [in_y0, z_ch_floor - part_t - leg2],
                    [in_y0 + leg2, z_ch_floor - part_t],
                ],
            );
            // Lower-rear Fold-3 bottom reflector `(in_y0, in_z0)`
            let leg3 = 0.13 * d;
            sb.add_prism_yz(
                -in_hx,
                in_hx,
                &[
                    [in_y0, in_z0],
                    [in_y0 + leg3, in_z0],
                    [in_y0, in_z0 + leg3],
                ],
            );
            let (sm, vol) = sb.finish(
                "corner_reflectors",
                "45° Mitered Horn Fold Reflectors (×3)",
                "internal_horn",
                "internal_horn",
                &enc_mat.name,
                "#cfa063",
                0.94,
                part_t * 1000.0,
                [leg3 * 1.414 * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, -0.10 * max_dim, -0.08 * max_dim],
                "45° mitered corner wedges suppress standing-wave reflections at all 3 folds",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2f. Center Mouth V-Splitter & Rear-Chamber Stiffening Braces (`brace_t` thick!)
        if c.brace_count > 0 {
            let mut sb = SolidBuilder::default();
            // Vertical center splitter brace tying Bottom Panel to Fold-2 Mouth Divider
            let hb = 0.5 * brace_t;
            sb.add_prism_yz(
                -hb,
                hb,
                &[
                    [y_fold2_gap + 0.06, in_z0],
                    [hy - 0.02, in_z0],
                    [hy - 0.02, z_mouth_top - part_t],
                    [y_fold2_gap + 0.06, 0.245 * h + 0.02],
                ],
            );
            // Upper throat splitter fin
            sb.add_prism_yz(
                -hb,
                hb,
                &[
                    [y_ch_baffle + 0.04, z_ch_floor + 0.03],
                    [in_y1 - 0.04, z_ch_floor + 0.06],
                    [in_y1 - 0.04, in_z1],
                    [y_ch_baffle + 0.04, in_z1],
                ],
            );
            let (sm, vol) = sb.finish(
                "horn_tie_braces",
                "Center Horn Splitter & Tie Braces",
                "brace",
                "bracing",
                &enc_mat.name,
                "#e2b879",
                0.94,
                brace_t * 1000.0,
                [(hy - y_fold2_gap) * 1000.0, z_mouth_top * 1000.0, brace_t * 1000.0],
                enc_mat.density_kg_m3,
                [0.0, 0.28 * max_dim, -0.06 * max_dim],
                "Halves unsupported horn panel span, pushing f_11 > 420 Hz",
            );
            woodwork_mass += sm.mass_kg as f64;
            internal_vol += vol;
            submeshes.push(sm);
        }

        // 2g. Porous Acoustic Damping Lining inside the Sealed Rear Chamber
        if damp_t > 0.002 {
            let mut sb = SolidBuilder::default();
            sb.add_box(
                [-in_hx + 0.004, in_y0, z_ch_floor + 0.004],
                [in_hx - 0.004, in_y0 + damp_t, in_z1 - 0.004],
            );
            sb.add_box(
                [-in_hx + 0.004, in_y0 + damp_t, in_z1 - damp_t],
                [in_hx - 0.004, y_ch_baffle - baffle_t - 0.008, in_z1],
            );
            let (sm, vol) = sb.finish(
                "rear_chamber_damping",
                "Rear-Chamber Mineral-Wool Lining",
                "damping",
                "damping",
                "48 kg/m³ Acoustic Mineral Wool",
                "#3b82f6",
                0.55,
                damp_t * 1000.0,
                [(in_z1 - z_ch_floor) * 1000.0, 2.0 * in_hx * 1000.0, damp_t * 1000.0],
                48.0,
                [0.0, -0.14 * max_dim, 0.14 * max_dim],
                "Absorbs back-wave cavity resonances above 180 Hz inside sealed rear chamber",
            );
            damping_hw_mass += sm.mass_kg as f64;
            damping_vol += vol;
            submeshes.push(sm);
        }

        // 2h. Detailed 18" Horn Subwoofer Transducer mounted on Internal Throat Baffle
        let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
            "sub_horn",
            "18\" Horn Subwoofer",
            drv,
            [0.0, y_ch_baffle, z_drv],
            1.0,
            r_bore,
            rebate_d,
            [0.0, -0.12 * max_dim, 0.10 * max_dim],
        );
        drivers_vol += d_vol;
        drivers_mass += d_mass;
        submeshes.extend(drv_sms);
    } else {
        // ====================================================================
        // DIRECT-RADIATING / MULTI-WAY / WAVEGUIDE / VENTED / CARDIOID CABINET
        // ====================================================================
        // Collect front-baffle openings (ports + per-way drivers/waveguides) sorted along Z!
        struct CutBand {
            zc: f64,
            xc: f64,
            half_z: f64,
            is_rect_port: bool,
            rect_w: f64,
            rect_h: f64,
            r_bore: f64,
            r_rebate: f64,
            reb_d: f64,
            label: String,
        }
        let mut bands: Vec<CutBand> = Vec::new();

        // Front-firing ports
        for wy in &spec.ways {
            if let WayEnclosure::Vented { port, .. } = &wy.enclosure {
                if port.local_normal.y >= 0.0 {
                    let pw = (port.area_m2 * 3.6).sqrt().min(2.0 * in_hx - 0.03);
                    let ph = (port.area_m2 / pw.max(0.02)).clamp(0.022, 0.11);
                    let pzc = port
                        .local_exit_offset
                        .z
                        .clamp(in_z0 + 0.5 * ph + 0.008, 0.30 * h);
                    bands.push(CutBand {
                        zc: pzc,
                        xc: port.local_exit_offset.x,
                        half_z: 0.5 * ph + 0.006,
                        is_rect_port: true,
                        rect_w: pw,
                        rect_h: ph,
                        r_bore: 0.0,
                        r_rebate: 0.0,
                        reb_d: 0.0,
                        label: format!("{} Slot Port", wy.label),
                    });
                }
            }
        }

        // Per-way front apertures
        for wy in &spec.ways {
            let drv = drivers.iter().find(|dr| dr.id == wy.driver_id);
            let r_cone = drv.map(|dr| dr.small_signal.piston_radius_m()).unwrap_or(0.08);
            match &wy.enclosure {
                WayEnclosure::WaveguideLoaded { waveguide, .. } => {
                    let r_m = (waveguide.mouth_area_m2 / PI)
                        .sqrt()
                        .min(0.88 * in_hx);
                    bands.push(CutBand {
                        zc: wy.local_acoustic_offset.z,
                        xc: wy.local_acoustic_offset.x,
                        half_z: r_m + 0.008,
                        is_rect_port: false,
                        rect_w: 0.0,
                        rect_h: 0.0,
                        r_bore: r_m * 0.96,
                        r_rebate: r_m * 1.04,
                        reb_d: rebate_d,
                        label: wy.label.clone(),
                    });
                }
                _ => {
                    let r_b = r_cone.min(0.85 * in_hx);
                    bands.push(CutBand {
                        zc: wy.local_acoustic_offset.z,
                        xc: wy.local_acoustic_offset.x,
                        half_z: r_b * 1.15 + 0.008,
                        is_rect_port: false,
                        rect_w: 0.0,
                        rect_h: 0.0,
                        r_bore: r_b,
                        r_rebate: r_b * 1.13,
                        reb_d: rebate_d,
                        label: wy.label.clone(),
                    });
                }
            }
        }

        bands.sort_by(|a, b| a.zc.partial_cmp(&b.zc).unwrap());

        // Build solid Front Baffle (`y in [in_y1, hy]`) with exact circular/slot bores + CNC rebates!
        {
            let mut sb = SolidBuilder::default();
            let bx0 = -tb_hx;
            let bx1 = tb_hx;
            let bz_min = in_z0 - rab;
            let bz_max = in_z1 + rab;
            let mut cur_z = bz_min;

            for (idx, b) in bands.iter().enumerate() {
                let next_limit = if idx + 1 < bands.len() {
                    0.5 * (b.zc + bands[idx + 1].zc)
                } else {
                    bz_max
                };
                let z_lo = (b.zc - b.half_z).max(cur_z);
                let z_hi = (b.zc + b.half_z).min(next_limit);
                if z_lo > cur_z + 1e-4 {
                    sb.add_box([bx0, in_y1, cur_z], [bx1, hy, z_lo]);
                }
                if b.is_rect_port {
                    let px0 = b.xc - 0.5 * b.rect_w;
                    let px1 = b.xc + 0.5 * b.rect_w;
                    let pz0 = (b.zc - 0.5 * b.rect_h).max(z_lo + 0.002);
                    let pz1 = (b.zc + 0.5 * b.rect_h).min(z_hi - 0.002);
                    sb.add_box([bx0, in_y1, z_lo], [bx1, hy, pz0]);
                    sb.add_box([bx0, in_y1, pz1], [bx1, hy, z_hi]);
                    sb.add_box([bx0, in_y1, pz0], [px0, hy, pz1]);
                    sb.add_box([px1, in_y1, pz0], [bx1, hy, pz1]);
                    blueprint_openings.push(BaffleOpening {
                        way_label: b.label.clone(),
                        cx: b.xc,
                        cz: b.zc,
                        is_rect: true,
                        r_bore: 0.0,
                        r_rebate: 0.0,
                        rebate_depth: 0.0,
                        rect_w: b.rect_w,
                        rect_h: b.rect_h,
                    });
                } else {
                    let r_avail = ((z_hi - b.zc).min(b.zc - z_lo) * 0.92).min(0.88 * (bx1 - bx0) * 0.5);
                    let r_bore = b.r_bore.min(0.88 * r_avail);
                    let r_reb = b.r_rebate.min(r_avail);
                    sb.add_band_with_circular_bore(
                        0,
                        bx0,
                        bx1,
                        z_lo,
                        z_hi,
                        in_y1,
                        hy,
                        b.xc,
                        b.zc,
                        r_bore,
                        r_reb,
                        b.reb_d,
                    );
                    blueprint_openings.push(BaffleOpening {
                        way_label: b.label.clone(),
                        cx: b.xc,
                        cz: b.zc,
                        is_rect: false,
                        r_bore,
                        r_rebate: r_reb,
                        rebate_depth: b.reb_d,
                        rect_w: 0.0,
                        rect_h: 0.0,
                    });
                }
                cur_z = z_hi;
            }
            if bz_max > cur_z + 1e-4 {
                sb.add_box([bx0, in_y1, cur_z], [bx1, hy, bz_max]);
            }

            let (sm, vol) = sb.finish(
                "front_baffle",
                "Front Acoustic Baffle",
                "baffle",
                "front_baffle",
                &baf_mat.name,
                &baf_mat.color_hex,
                0.82,
                baffle_t * 1000.0,
                [(bz_max - bz_min) * 1000.0, (bx1 - bx0) * 1000.0, baffle_t * 1000.0],
                baf_mat.density_kg_m3,
                [0.0, 0.25 * max_dim, 0.0],
                &format!(
                    "{:.1} mm CNC flush counterbore rebates + {:.0} mm edge diffraction roundover",
                    rebate_d * 1000.0,
                    spec.edge_round_m * 1000.0
                ),
            );
            woodwork_mass += sm.mass_kg as f64;
            shell_vol += vol;
            submeshes.push(sm);
        }

        // Per-way Internal Sub-Enclosures, Solid OS-SE Waveguides, Thick-Walled Ports & Transducers!
        for (w_idx, wy) in spec.ways.iter().enumerate() {
            let drv = drivers.iter().find(|dr| dr.id == wy.driver_id);
            let r_cone = drv.map(|dr| dr.small_signal.piston_radius_m()).unwrap_or(0.08);
            let cx = wy.local_acoustic_offset.x;
            let cz = wy.local_acoustic_offset.z;

            // Find actual clamped bore radius on front baffle
            let r_bore = blueprint_openings
                .iter()
                .find(|op| !op.is_rect && (op.cz - cz).abs() < 0.02)
                .map(|op| op.r_bore)
                .unwrap_or(r_cone.min(0.82 * in_hx));

            match &wy.enclosure {
                WayEnclosure::WaveguideLoaded {
                    rear_volume_m3,
                    waveguide,
                    ..
                } => {
                    // Solid 3D Revolved OS-SE / Conical Waveguide Block!
                    let r_th = (waveguide.throat_area_m2 / PI).sqrt().max(0.012);
                    let r_mo = r_bore;
                    let wg_len = waveguide.length_m.min(0.68 * (in_y1 - in_y0));
                    let r_outer = (r_mo * 1.04).min(in_hx - 0.002);

                    let mut wg = SolidBuilder::default();
                    let mut prof: Vec<[f64; 2]> = Vec::new();
                    let n_steps = 12usize;
                    // Inner OS-SE flare from throat (`dy = -wg_len`) to mouth (`dy = 0.0`)
                    for k in 0..=n_steps {
                        let u = (k as f64) / (n_steps as f64);
                        let r_in = (r_th * r_th + u.powf(1.55) * (r_mo * r_mo - r_th * r_th)).sqrt();
                        prof.push([r_in, -wg_len + u * wg_len]);
                    }
                    // Outer flange + solid rear tapered wall (`min 12 mm` wall thickness!)
                    prof.push([r_outer, 0.0]);
                    prof.push([r_outer, -rebate_d.max(0.008)]);
                    prof.push([(r_th + 0.018).min(r_outer), -wg_len]);
                    wg.add_revolved_y([cx, hy, cz], &prof, 32);

                    let wg_is_alu = waveguide.length_m < 0.08 || baf_mat.kind == PanelMaterialKind::CastAluminum6061;
                    let (wg_mat_name, wg_col, wg_rho) = if wg_is_alu {
                        ("CNC 6061-T6 Billet Aluminum", "#93c5fd", 2700.0)
                    } else {
                        (enc_mat.name.as_str(), "#60a5fa", enc_mat.density_kg_m3)
                    };
                    let (wg_sm, wg_vol) = wg.finish(
                        &format!("waveguide_{w_idx}"),
                        &format!("{} Solid Flare Block", wy.label),
                        "waveguide",
                        "port_waveguide",
                        wg_mat_name,
                        wg_col,
                        0.93,
                        ((r_outer - r_th) * 0.45 * 1000.0).max(12.0),
                        [2.0 * r_outer * 1000.0, 2.0 * r_outer * 1000.0, wg_len * 1000.0],
                        wg_rho,
                        [0.0, 0.34 * max_dim, 0.0],
                        "Oblate-Spheroidal constant-directivity CNC flare + throat flange",
                    );
                    if wg_is_alu {
                        damping_hw_mass += wg_sm.mass_kg as f64;
                    } else {
                        woodwork_mass += wg_sm.mass_kg as f64;
                    }
                    internal_vol += wg_vol;
                    submeshes.push(wg_sm);

                    // Isolated rear chamber if `rear_volume_m3 > 2.5 L` (e.g. Synergy Kick/Mid horn sub-enclosure!)
                    if *rear_volume_m3 > 0.0025 && spec.ways.len() > 1 && w_idx > 0 {
                        let ch_h = (2.2 * r_mo).min(0.32 * h);
                        let ch_d = (wg_len + 0.14).min(in_y1 - in_y0 - 0.02);
                        let mut cb = SolidBuilder::default();
                        let z_lo = (cz - 0.5 * ch_h).max(in_z0 + 0.02);
                        let z_hi = (cz + 0.5 * ch_h).min(in_z1 - 0.01);
                        let y_back = in_y1 - ch_d;
                        cb.add_box([-in_hx, y_back, z_lo - part_t], [in_hx, in_y1, z_lo]);
                        if z_hi + part_t < in_z1 - 0.01 {
                            cb.add_box([-in_hx, y_back, z_hi], [in_hx, in_y1, z_hi + part_t]);
                        }
                        cb.add_box([-in_hx, y_back - part_t, z_lo - part_t], [in_hx, y_back, z_hi + part_t]);
                        let (cb_sm, cb_vol) = cb.finish(
                            &format!("subchamber_{w_idx}"),
                            &format!("{} Sealed Sub-Chamber", wy.label),
                            "internal_horn",
                            "internal_horn",
                            &enc_mat.name,
                            "#cfa063",
                            0.88,
                            part_t * 1000.0,
                            [ch_d * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                            enc_mat.density_kg_m3,
                            [0.0, 0.08 * max_dim, 0.0],
                            "Airtight internal sub-enclosure isolating mid/kick horn driver",
                        );
                        woodwork_mass += cb_sm.mass_kg as f64;
                        internal_vol += cb_vol;
                        submeshes.push(cb_sm);
                    }

                    // Compression / Dome / Horn-throat driver behind waveguide throat!
                    let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
                        &wy.way_id,
                        &wy.label,
                        drv,
                        [cx, hy - wg_len, cz],
                        1.0,
                        r_th.max(0.55 * r_cone),
                        0.0,
                        [0.0, 0.18 * max_dim, 0.0],
                    );
                    drivers_vol += d_vol;
                    drivers_mass += d_mass;
                    submeshes.extend(drv_sms);
                }

                WayEnclosure::Sealed { volume_m3, .. } => {
                    // Isolated internal sealed midrange sub-enclosure when `w_idx > 0` (e.g. Aether-83M 4" Mid!)
                    if w_idx > 0 && *volume_m3 < 0.012 {
                        let half_zh = (r_bore * 1.45).max(0.055);
                        let z_lo = (cz - half_zh).max(in_z0 + 0.05);
                        let z_hi = (cz + half_zh).min(in_z1 - 0.02);
                        let target_depth = (volume_m3 / ((2.0 * in_hx) * (z_hi - z_lo)).max(1e-4))
                            .clamp(0.11, 0.65 * (in_y1 - in_y0));
                        let y_back = in_y1 - target_depth;

                        let mut cb = SolidBuilder::default();
                        cb.add_box([-in_hx, y_back, z_lo - part_t], [in_hx, in_y1, z_lo]);
                        cb.add_box([-in_hx, y_back, z_hi], [in_hx, in_y1, z_hi + part_t]);
                        cb.add_box(
                            [-in_hx, y_back - part_t, z_lo - part_t],
                            [in_hx, y_back, z_hi + part_t],
                        );
                        let (cb_sm, cb_vol) = cb.finish(
                            &format!("mid_chamber_{w_idx}"),
                            &format!("{} Isolated Sub-Enclosure ({:.1} L)", wy.label, volume_m3 * 1000.0),
                            "internal_horn",
                            "internal_horn",
                            &enc_mat.name,
                            "#cfa063",
                            0.90,
                            part_t * 1000.0,
                            [target_depth * 1000.0, 2.0 * in_hx * 1000.0, part_t * 1000.0],
                            enc_mat.density_kg_m3,
                            [0.0, 0.12 * max_dim, 0.0],
                            "Isolates midrange cone from high-SPL woofer cabinet back-pressure",
                        );
                        woodwork_mass += cb_sm.mass_kg as f64;
                        internal_vol += cb_vol;
                        submeshes.push(cb_sm);
                    }

                    let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
                        &wy.way_id,
                        if is_dual_opposed {
                            "Front Opposed Subwoofer (+Y)"
                        } else {
                            &wy.label
                        },
                        drv,
                        [cx, hy, cz],
                        1.0,
                        r_bore,
                        rebate_d,
                        [0.0, 0.36 * max_dim, 0.0],
                    );
                    drivers_vol += d_vol;
                    drivers_mass += d_mass;
                    submeshes.extend(drv_sms);

                    if is_dual_opposed {
                        let (rear_sms, r_vol, r_mass) = build_transducer_submeshes(
                            "rear_opposed_sub",
                            "Rear Opposed Subwoofer (-Y)",
                            drv,
                            [cx, -hy, cz],
                            -1.0,
                            r_bore,
                            0.0,
                            [0.0, -0.36 * max_dim, 0.0],
                        );
                        drivers_vol += r_vol;
                        drivers_mass += r_mass;
                        submeshes.extend(rear_sms);

                        // CNC 6061-T6 Force-Canceling Motor Coupling Tie-Cradle between opposed T-yokes
                        let mut tie = SolidBuilder::default();
                        let y_span = (0.34 * d).max(0.05);
                        for sx in [-0.055_f64, 0.055_f64] {
                            tie.add_box(
                                [sx - 0.008, -0.5 * y_span, cz - 0.014],
                                [sx + 0.008, 0.5 * y_span, cz + 0.014],
                            );
                        }
                        let (tie_sm, tie_vol) = tie.finish(
                            "force_cancel_tie_bar",
                            "6061-T6 Force-Canceling Motor Tie-Bars (×2)",
                            "brace",
                            "bracing",
                            "CNC 6061-T6 Billet Aluminum",
                            "#93c5fd",
                            0.96,
                            16.0,
                            [y_span * 1000.0, 28.0, 16.0],
                            2700.0,
                            [0.0, 0.0, 0.14 * max_dim],
                            "Couples opposed magnet backplates so F_front + F_rear = 0 N",
                        );
                        damping_hw_mass += tie_sm.mass_kg as f64;
                        internal_vol += tie_vol;
                        submeshes.push(tie_sm);
                    }
                }

                WayEnclosure::Vented { port, .. } => {
                    // Thick-walled flared slot/duct port (`part_t` real wall thickness!)
                    let mut pb = SolidBuilder::default();
                    let p_len = port.length_m.min(0.84 * (in_y1 - in_y0));
                    if port.local_normal.y >= 0.0 {
                        let pw = (port.area_m2 * 3.6).sqrt().min(2.0 * in_hx - 0.03);
                        let ph = (port.area_m2 / pw.max(0.02)).clamp(0.022, 0.11);
                        let pzc = port
                            .local_exit_offset
                            .z
                            .clamp(in_z0 + 0.5 * ph + 0.008, 0.30 * h);
                        let px0 = port.local_exit_offset.x - 0.5 * pw;
                        let px1 = port.local_exit_offset.x + 0.5 * pw;
                        let pz0 = pzc - 0.5 * ph;
                        let pz1 = pzc + 0.5 * ph;
                        let py0 = in_y1 - p_len;

                        // Port roof, floor (if raised above bottom panel), left & right duct walls + internal flare lip!
                        pb.add_box([px0 - part_t, py0, pz1], [px1 + part_t, in_y1, pz1 + part_t]);
                        if pz0 > in_z0 + 0.004 {
                            pb.add_box(
                                [px0 - part_t, py0, (pz0 - part_t).max(in_z0)],
                                [px1 + part_t, in_y1, pz0],
                            );
                        }
                        pb.add_box([px0 - part_t, py0, pz0], [px0, in_y1, pz1]);
                        pb.add_box([px1, py0, pz0], [px1 + part_t, in_y1, pz1]);
                        // Flared internal exit bell (`flare_radius_m`)
                        let fl = port.flare_radius_m.clamp(0.008, 0.026);
                        pb.add_prism_yz(
                            px0 - part_t,
                            px1 + part_t,
                            &[
                                [py0 - 0.8 * fl, pz1 + part_t + 0.6 * fl],
                                [py0, pz1],
                                [py0, pz1 + part_t],
                            ],
                        );
                        let (p_sm, p_vol) = pb.finish(
                            &format!("port_duct_{w_idx}"),
                            &format!("{} Thick-Walled Flared Slot Port", wy.label),
                            "port",
                            "port_waveguide",
                            &enc_mat.name,
                            "#34d399",
                            0.90,
                            part_t * 1000.0,
                            [p_len * 1000.0, (pw + 2.0 * part_t) * 1000.0, part_t * 1000.0],
                            enc_mat.density_kg_m3,
                            [0.0, 0.16 * max_dim, -0.06 * max_dim],
                            &format!(
                                "L = {:.0} mm · S_p = {:.0} cm² · R_flare = {:.0} mm low-turbulence exit",
                                port.length_m * 1000.0,
                                port.area_m2 * 10_000.0,
                                port.flare_radius_m * 1000.0
                            ),
                        );
                        woodwork_mass += p_sm.mass_kg as f64;
                        internal_vol += p_vol;
                        submeshes.push(p_sm);
                    }

                    let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
                        &wy.way_id,
                        if is_dual_opposed {
                            "Front Opposed Subwoofer (+Y)"
                        } else {
                            &wy.label
                        },
                        drv,
                        [cx, hy, cz],
                        1.0,
                        r_bore,
                        rebate_d,
                        [0.0, 0.36 * max_dim, 0.0],
                    );
                    drivers_vol += d_vol;
                    drivers_mass += d_mass;
                    submeshes.extend(drv_sms);

                    if is_dual_opposed {
                        let (rear_sms, r_vol, r_mass) = build_transducer_submeshes(
                            "rear_opposed_sub",
                            "Rear Opposed Subwoofer (-Y)",
                            drv,
                            [cx, -hy, cz],
                            -1.0,
                            r_bore,
                            0.0,
                            [0.0, -0.36 * max_dim, 0.0],
                        );
                        drivers_vol += r_vol;
                        drivers_mass += r_mass;
                        submeshes.extend(rear_sms);

                        // CNC 6061-T6 Force-Canceling Motor Coupling Tie-Cradle between opposed T-yokes
                        let mut tie = SolidBuilder::default();
                        let y_span = (0.34 * d).max(0.05);
                        for sx in [-0.055_f64, 0.055_f64] {
                            tie.add_box(
                                [sx - 0.008, -0.5 * y_span, cz - 0.014],
                                [sx + 0.008, 0.5 * y_span, cz + 0.014],
                            );
                        }
                        let (tie_sm, tie_vol) = tie.finish(
                            "force_cancel_tie_bar",
                            "6061-T6 Force-Canceling Motor Tie-Bars (×2)",
                            "brace",
                            "bracing",
                            "CNC 6061-T6 Billet Aluminum",
                            "#93c5fd",
                            0.96,
                            16.0,
                            [y_span * 1000.0, 28.0, 16.0],
                            2700.0,
                            [0.0, 0.0, 0.14 * max_dim],
                            "Couples opposed magnet backplates so F_front + F_rear = 0 N",
                        );
                        damping_hw_mass += tie_sm.mass_kg as f64;
                        internal_vol += tie_vol;
                        submeshes.push(tie_sm);
                    }
                }

                WayEnclosure::CardioidSlot { port, .. } => {
                    // Internal Resistive Porous Damping Blocks behind Left & Right Cardioid Slots!
                    let mut rb = SolidBuilder::default();
                    let pad_t = damp_t.max(0.026);
                    let sy0 = -0.15 * d;
                    let sy1 = 0.05 * d;
                    let sz0 = (cz - 0.115).max(in_z0 + 0.02);
                    let sz1 = (cz + 0.115).min(in_z1 - 0.02);
                    rb.add_box([-in_hx, sy0, sz0], [-in_hx + pad_t, sy1, sz1]);
                    rb.add_box([in_hx - pad_t, sy0, sz0], [in_hx, sy1, sz1]);
                    let (rb_sm, rb_vol) = rb.finish(
                        "cardioid_resistive_pads",
                        "Calibrated Cardioid Flow-Resistive Side Blocks (×2)",
                        "damping",
                        "damping",
                        "Calibrated Sintered Melamine / Mineral Pad (14.5 kPa·s/m²)",
                        "#fb7185",
                        0.86,
                        pad_t * 1000.0,
                        [(sz1 - sz0) * 1000.0, (sy1 - sy0) * 1000.0, pad_t * 1000.0],
                        95.0,
                        [0.0, 0.0, 0.12 * max_dim],
                        "Delays & attenuates rear wave to cancel 80–350 Hz front-wall SBIR",
                    );
                    damping_hw_mass += rb_sm.mass_kg as f64;
                    damping_vol += rb_vol;
                    submeshes.push(rb_sm);

                    // Optional rear-firing LF reflex port tube (`6 mm` wall PVC/ABS flared tube)
                    if let Some(rp) = port {
                        let r_in = (rp.area_m2 / PI).sqrt().min(0.28 * w);
                        let r_out = r_in + 0.006;
                        let plen = rp.length_m.min(0.75 * (in_y1 - in_y0));
                        let pz = rp.local_exit_offset.z.clamp(in_z0 + r_out + 0.01, 0.25 * h);
                        let mut pt = SolidBuilder::default();
                        pt.add_revolved_y(
                            [rp.local_exit_offset.x, in_y0, pz],
                            &[[r_in, 0.0], [r_in, plen], [r_out + 0.008, plen], [r_out, plen - 0.018], [r_out, 0.0]],
                            28,
                        );
                        let (pt_sm, pt_vol) = pt.finish(
                            "rear_sub_port",
                            "Rear Sub-Bass Flared Port Tube",
                            "port",
                            "port_waveguide",
                            "6.0 mm Molded ABS Flared Duct",
                            "#34d399",
                            0.90,
                            6.0,
                            [plen * 1000.0, 2.0 * r_out * 1000.0, 6.0],
                            1060.0,
                            [0.0, -0.20 * max_dim, -0.05 * max_dim],
                            "Extends sub-bass below 80 Hz cardioid crossover band",
                        );
                        damping_hw_mass += pt_sm.mass_kg as f64;
                        internal_vol += pt_vol;
                        submeshes.push(pt_sm);
                    }

                    // Front cardioid woofer + if `driver_count >= 2` (like 8C!), internal/rear boundary sub woofer!
                    let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
                        &wy.way_id,
                        &wy.label,
                        drv,
                        [cx, hy, cz],
                        1.0,
                        r_bore,
                        rebate_d,
                        [0.0, 0.36 * max_dim, 0.0],
                    );
                    drivers_vol += d_vol;
                    drivers_mass += d_mass;
                    submeshes.extend(drv_sms);

                    if wy.driver_count >= 2 {
                        // Internal isobaric / boundary-coupled second woofer bulkhead
                        let y_iso = -0.04 * d;
                        let (iso_sms, ivol, imass) = build_transducer_submeshes(
                            "lf_iso_sub",
                            "Internal Coupled LF Woofer #2",
                            drv,
                            [cx, y_iso, (cz - 0.05).max(in_z0 + r_bore + 0.02)],
                            1.0,
                            r_bore * 0.92,
                            0.0,
                            [0.0, -0.10 * max_dim, 0.0],
                        );
                        drivers_vol += ivol;
                        drivers_mass += imass;
                        submeshes.extend(iso_sms);
                    }
                }

                _ => {
                    let (drv_sms, d_vol, d_mass) = build_transducer_submeshes(
                        &wy.way_id,
                        if is_dual_opposed {
                            "Front Opposed Subwoofer (+Y)"
                        } else {
                            &wy.label
                        },
                        drv,
                        [cx, hy, cz],
                        1.0,
                        r_bore,
                        rebate_d,
                        [0.0, 0.36 * max_dim, 0.0],
                    );
                    drivers_vol += d_vol;
                    drivers_mass += d_mass;
                    submeshes.extend(drv_sms);

                    if is_dual_opposed {
                        let (rear_sms, r_vol, r_mass) = build_transducer_submeshes(
                            "rear_opposed_sub",
                            "Rear Opposed Subwoofer (-Y)",
                            drv,
                            [cx, -hy, cz],
                            -1.0,
                            r_bore,
                            0.0,
                            [0.0, -0.36 * max_dim, 0.0],
                        );
                        drivers_vol += r_vol;
                        drivers_mass += r_mass;
                        submeshes.extend(rear_sms);

                        // CNC 6061-T6 Force-Canceling Motor Coupling Tie-Cradle between opposed T-yokes
                        let mut tie = SolidBuilder::default();
                        let y_span = (0.34 * d).max(0.05);
                        for sx in [-0.055_f64, 0.055_f64] {
                            tie.add_box(
                                [sx - 0.008, -0.5 * y_span, cz - 0.014],
                                [sx + 0.008, 0.5 * y_span, cz + 0.014],
                            );
                        }
                        let (tie_sm, tie_vol) = tie.finish(
                            "force_cancel_tie_bar",
                            "6061-T6 Force-Canceling Motor Tie-Bars (×2)",
                            "brace",
                            "bracing",
                            "CNC 6061-T6 Billet Aluminum",
                            "#93c5fd",
                            0.96,
                            16.0,
                            [y_span * 1000.0, 28.0, 16.0],
                            2700.0,
                            [0.0, 0.0, 0.14 * max_dim],
                            "Couples opposed magnet backplates so F_front + F_rear = 0 N",
                        );
                        damping_hw_mass += tie_sm.mass_kg as f64;
                        internal_vol += tie_vol;
                        submeshes.push(tie_sm);
                    }
                }
            }
        }

        // Horizontal Perforated Window-Matrix Braces (`c.brace_count`)!
        if c.brace_count > 0 {
            let mut bb = SolidBuilder::default();
            let by0 = in_y0 + damp_t + 0.008;
            let by1 = in_y1 - 0.085; // clears front driver baskets
            if by1 > by0 + 0.06 {
                for bi in 0..c.brace_count {
                    // Place braces in clear vertical spans away from driver centers
                    let mut z_cand = in_z0 + ((bi + 1) as f64 / (c.brace_count + 1) as f64) * (in_z1 - in_z0);
                    for wy in &spec.ways {
                        if (z_cand - wy.local_acoustic_offset.z).abs() < 0.055 {
                            z_cand += if z_cand >= wy.local_acoustic_offset.z {
                                0.062
                            } else {
                                -0.062
                            };
                        }
                    }
                    z_cand = z_cand.clamp(in_z0 + 0.075, in_z1 - 0.075);
                    let r_win = (0.28 * (by1 - by0)).min(0.26 * in_hx);
                    // Left & Right circular airflow windows in the horizontal brace!
                    bb.add_band_with_circular_bore(
                        1,
                        -in_hx,
                        0.0,
                        by0,
                        by1,
                        z_cand - 0.5 * brace_t,
                        z_cand + 0.5 * brace_t,
                        -0.5 * in_hx,
                        0.5 * (by0 + by1),
                        r_win,
                        0.0,
                        0.0,
                    );
                    bb.add_band_with_circular_bore(
                        1,
                        0.0,
                        in_hx,
                        by0,
                        by1,
                        z_cand - 0.5 * brace_t,
                        z_cand + 0.5 * brace_t,
                        0.5 * in_hx,
                        0.5 * (by0 + by1),
                        r_win,
                        0.0,
                        0.0,
                    );
                }
                let (b_sm, b_vol) = bb.finish(
                    "window_braces",
                    &format!("Perforated Window-Matrix Braces (×{})", c.brace_count),
                    "brace",
                    "bracing",
                    &enc_mat.name,
                    "#e2b879",
                    0.93,
                    brace_t * 1000.0,
                    [(by1 - by0) * 1000.0, 2.0 * in_hx * 1000.0, brace_t * 1000.0],
                    enc_mat.density_kg_m3,
                    [0.0, -0.08 * max_dim, 0.15 * max_dim],
                    "Ties Left, Right & Rear walls across mid-span with twin CNC airflow cutouts",
                );
                woodwork_mass += b_sm.mass_kg as f64;
                internal_vol += b_vol;
                submeshes.push(b_sm);
            }
        }

        // Internal Rear & Top Porous Acoustic Wall Lining (`damp_t`)
        if damp_t > 0.002 && cardioid_way.is_none() {
            let mut db = SolidBuilder::default();
            db.add_box(
                [-in_hx + 0.006, in_y0, in_z0 + 0.06],
                [in_hx - 0.006, in_y0 + damp_t, in_z1 - damp_t - 0.004],
            );
            db.add_box(
                [-in_hx + 0.006, in_y0, in_z1 - damp_t],
                [in_hx - 0.006, in_y1 - 0.06, in_z1],
            );
            let (d_sm, d_vol) = db.finish(
                "acoustic_lining",
                "Porous Standing-Wave Wall Lining",
                "damping",
                "damping",
                "40 kg/m³ Melamine / Polyester Acoustic Foam",
                "#38bdf8",
                0.48,
                damp_t * 1000.0,
                [(in_z1 - in_z0 - 0.06) * 1000.0, 2.0 * in_hx * 1000.0, damp_t * 1000.0],
                40.0,
                [0.0, -0.15 * max_dim, 0.10 * max_dim],
                "Damps internal half-wave pipe resonances without choking port airflow",
            );
            damping_hw_mass += d_sm.mass_kg as f64;
            damping_vol += d_vol;
            submeshes.push(d_sm);
        }
    }

    // ------------------------------------------------------------------------
    // 3. COMPUTE KIRCHHOFF-MINDLIN STRUCTURAL SUMMARY & 2D CAD BLUEPRINTS
    // ------------------------------------------------------------------------
    let structural = compute_structural_summary(
        spec,
        shell_vol,
        internal_vol,
        drivers_vol + damping_vol,
        woodwork_mass,
        drivers_mass,
        damping_hw_mass,
    );

    let sections_2d = build_2d_blueprints(
        spec,
        drivers,
        &blueprint_openings,
        is_tapped_horn,
        is_folded_horn,
        cardioid_way.is_some(),
        is_dual_opposed,
    );

    VisualCabinetModel {
        model_id: spec.id.clone(),
        title: spec.name.clone(),
        subtitle: spec.subtitle.clone(),
        dims_m: spec.dims_m,
        structural,
        sections_2d,
        submeshes,
    }
}

/// Build realistic two-part 3D transducer solid geometry:
/// 1. `Cast Basket, Steel Plates, Magnet Ring (NdFeB/Ferrite) & Copper Voice Coil` (`layer = "driver_motor"`)
/// 2. `Finite-Thickness Curvi-Linear Cone, Half-Roll Surround & Dustcap` (`layer = "driver_cone"`)
#[allow(clippy::too_many_arguments)]
fn build_transducer_submeshes(
    id_prefix: &str,
    label: &str,
    drv: Option<&DriverSpec>,
    mount_front_center: [f64; 3],
    dir_y: f64,
    r_bore: f64,
    rebate_d: f64,
    explode_base: [f64; 3],
) -> (Vec<VisualSubMesh>, f64, f64) {
    let is_neo = drv
        .map(|d| d.name.to_lowercase().contains("neo") || d.name.to_lowercase().contains("beryllium"))
        .unwrap_or(false);
    let is_hf_dome = r_bore < 0.028;

    let r_flange = r_bore * (if rebate_d > 1e-4 { 1.12 } else { 1.05 });
    let flange_t = rebate_d.max(0.005);
    let cone_depth = if is_hf_dome {
        0.005
    } else {
        (0.36 * r_bore).clamp(0.012, 0.072)
    };
    let r_vc = if is_hf_dome {
        0.65 * r_bore
    } else {
        (0.28 * r_bore).clamp(0.016, 0.058)
    };
    let basket_depth = cone_depth + (0.28 * r_bore).clamp(0.014, 0.052);
    let plate_t = (0.09 * r_bore).clamp(0.005, 0.016);
    let mag_h = if is_neo {
        (0.18 * r_bore).clamp(0.010, 0.032)
    } else {
        (0.26 * r_bore).clamp(0.014, 0.044)
    };
    let r_mag_out = if is_neo {
        (r_vc * 1.68).max(0.42 * r_bore)
    } else {
        (r_vc * 2.15).max(0.58 * r_bore)
    };
    let r_vent = (0.34 * r_vc).max(0.004);
    let s = dir_y.signum();

    // 1. Cast Basket + Steel Plates + Magnet Ring + Vented Pole Piece
    let mut motor = SolidBuilder::default();
    // Outer cast flange ring
    motor.add_revolved_y(
        mount_front_center,
        &[
            [r_bore * 0.96, -s * flange_t],
            [r_flange, -s * flange_t],
            [r_flange, 0.0],
            [r_bore * 0.96, 0.0],
        ],
        28,
    );

    if !is_hf_dome {
        // 6 angled cast-aluminum basket spokes from outer flange to top plate
        for k in 0..6 {
            let ang = 2.0 * PI * (k as f64) / 6.0;
            let (sa, ca) = ang.sin_cos();
            let spoke_hw = (0.08 * r_bore).clamp(0.004, 0.014);
            let r0 = r_bore * 0.98;
            let r1 = r_mag_out * 0.88;
            let y0 = mount_front_center[1] - s * flange_t;
            let y1 = mount_front_center[1] - s * basket_depth;
            let tx = -sa * spoke_hw;
            let tz = ca * spoke_hw;
            let cx = mount_front_center[0];
            let cz = mount_front_center[2];
            motor.add_box(
                [
                    (cx + r1 * ca).min(cx + r0 * ca) - spoke_hw,
                    y1.min(y0),
                    (cz + r1 * sa).min(cz + r0 * sa) - spoke_hw,
                ],
                [
                    (cx + r1 * ca).max(cx + r0 * ca) + spoke_hw,
                    y0.max(y1),
                    (cz + r1 * sa).max(cz + r0 * sa) + spoke_hw,
                ],
            );
            let _ = (tx, tz);
        }
    }

    // Top plate + Magnet ring + T-yoke backplate with center cooling vent!
    let y_top0 = -s * basket_depth;
    let y_top1 = y_top0 - s * plate_t;
    let y_mag1 = y_top1 - s * mag_h;
    let y_back1 = y_mag1 - s * plate_t;
    motor.add_revolved_y(
        mount_front_center,
        &[
            [r_vc + 0.0028, y_top1.min(y_top0)],
            [r_mag_out, y_top1.min(y_top0)],
            [r_mag_out, y_top0.max(y_top1)],
            [r_vc + 0.0028, y_top0.max(y_top1)],
        ],
        28,
    );
    motor.add_revolved_y(
        mount_front_center,
        &[
            [r_vc + 0.006, y_mag1.min(y_top1)],
            [r_mag_out * 1.03, y_mag1.min(y_top1)],
            [r_mag_out * 1.03, y_top1.max(y_mag1)],
            [r_vc + 0.006, y_top1.max(y_mag1)],
        ],
        28,
    );
    // T-yoke backplate + hollow center pole piece (`r_vent .. r_vc - 0.0015`)
    motor.add_revolved_y(
        mount_front_center,
        &[
            [r_vent, y_back1.min(y_top0)],
            [r_mag_out * 0.98, y_back1.min(y_mag1)],
            [r_mag_out * 0.98, y_mag1.max(y_back1)],
            [r_vc - 0.0014, y_mag1.max(y_back1)],
            [r_vc - 0.0014, y_top0.max(y_top1)],
            [r_vent, y_top0.max(y_top1)],
        ],
        28,
    );

    // Realistic physical transducer mass from motor size, Bl & magnet type
    let est_motor_mass_kg = drv
        .map(|d| {
            let sd_cm2 = d.small_signal.sd_m2 * 10_000.0;
            let bl = d.small_signal.bl_t_m;
            if sd_cm2 > 900.0 {
                if is_neo { 11.8 + 0.04 * bl } else { 15.2 + 0.06 * bl }
            } else if sd_cm2 > 600.0 {
                if is_neo { 7.4 } else { 9.8 }
            } else if sd_cm2 > 180.0 {
                if is_neo { 2.8 } else { 3.9 }
            } else if sd_cm2 > 35.0 {
                0.95
            } else {
                0.58
            }
        })
        .unwrap_or(3.2);

    let motor_vol = motor.volume_m3.max(1e-5);
    let eff_motor_rho = est_motor_mass_kg / motor_vol;
    let total_depth = basket_depth + 2.0 * plate_t + mag_h;
    let (motor_sm, m_vol) = motor.finish(
        &format!("{id_prefix}_motor"),
        &format!("{label} Cast Frame & {} Motor", if is_neo { "NdFeB" } else { "Ferrite" }),
        "motor",
        "driver_motor",
        if is_neo {
            "Die-Cast Aluminum Basket + Sintered NdFeB Radial Motor"
        } else {
            "Die-Cast Aluminum Basket + Low-Carbon Steel / Sr-Ferrite Motor"
        },
        if is_neo { "#94a3b8" } else { "#64748b" },
        0.97,
        plate_t * 1000.0,
        [2.0 * r_flange * 1000.0, 2.0 * r_flange * 1000.0, total_depth * 1000.0],
        eff_motor_rho,
        explode_base,
        &format!(
            "Ø{:.0} mm VC · Vented pole piece · Flush-mounted in {:.1} mm CNC rebate",
            2.0 * r_vc * 1000.0,
            rebate_d * 1000.0
        ),
    );

    // 2. Finite-Thickness Diaphragm Cone + Surround + Dustcap + Copper Voice Coil!
    let mut cone = SolidBuilder::default();
    let cone_t = if is_hf_dome { 0.0012 } else { 0.0026 };
    if is_hf_dome {
        cone.add_revolved_y(
            mount_front_center,
            &[
                [0.001, s * 0.005],
                [r_bore * 0.85, 0.0],
                [r_bore * 0.85, -s * 0.002],
                [0.001, s * 0.003],
            ],
            28,
        );
    } else {
        let r_sur_in = r_bore * 0.86;
        // Curvi-linear finite-thickness cone + half-roll surround + convex dustcap + voice-coil former!
        cone.add_revolved_y(
            mount_front_center,
            &[
                [0.002, -s * (cone_depth * 0.62)],
                [r_vc, -s * cone_depth],
                [0.5 * (r_vc + r_sur_in), -s * (0.46 * cone_depth)],
                [r_sur_in, -s * 0.003],
                [0.5 * (r_sur_in + r_bore * 0.97), s * 0.005],
                [r_bore * 0.97, -s * 0.002],
                [r_bore * 0.97, -s * (0.002 + cone_t)],
                [0.5 * (r_sur_in + r_bore * 0.97), s * 0.005 - s * cone_t],
                [r_sur_in, -s * (0.003 + cone_t)],
                [0.5 * (r_vc + r_sur_in), -s * (0.46 * cone_depth + cone_t)],
                [r_vc + 0.002, -s * (basket_depth + plate_t + 0.35 * mag_h)],
                [r_vc, -s * (basket_depth + plate_t + 0.35 * mag_h)],
                [r_vc, -s * (cone_depth + cone_t)],
                [0.002, -s * (cone_depth * 0.62 + cone_t)],
            ],
            32,
        );
    }

    let mms = drv.map(|d| d.small_signal.mms_kg).unwrap_or(0.045);
    let c_vol_raw = cone.volume_m3.max(1e-6);
    let (cone_sm, c_vol) = cone.finish(
        &format!("{id_prefix}_cone"),
        &format!("{label} Diaphragm, Surround & Voice Coil"),
        "cone",
        "driver_cone",
        if is_hf_dome {
            "Pure Beryllium / Titanium Dome + Copper-Clad Alu Coil"
        } else {
            "Curvi-Linear Fiber/Alu Cone + Santoprene Surround + Copper VC"
        },
        if is_hf_dome { "#f59e0b" } else { "#cbd5e1" },
        0.98,
        cone_t * 1000.0,
        [2.0 * r_bore * 1000.0, 2.0 * r_bore * 1000.0, cone_depth * 1000.0],
        mms / c_vol_raw,
        [
            explode_base[0],
            explode_base[1] + 0.09 * s,
            explode_base[2],
        ],
        &format!("M_ms = {:.1} g moving assembly + copper voice coil", mms * 1000.0),
    );

    let tot_mass = motor_sm.mass_kg as f64 + cone_sm.mass_kg as f64;
    (vec![motor_sm, cone_sm], m_vol + c_vol, tot_mass)
}

/// Compute Kirchhoff-Mindlin thick-plate bending modal resonances (`f_mn`) & cabinet wall coloration (`dB`).
pub fn compute_structural_summary(
    spec: &SpeakerCabinetSpec,
    shell_vol_m3: f64,
    internal_vol_m3: f64,
    drv_damp_vol_m3: f64,
    woodwork_mass_kg: f64,
    drivers_mass_kg: f64,
    damping_hw_mass_kg: f64,
) -> CabinetStructuralSummary {
    let [w, d, h] = spec.dims_m;
    let c = &spec.construction;
    let m_enc = &c.enclosure_material;
    let m_baf = &c.baffle_material;

    let hw = c.wall_thickness_m.max(0.006);
    let hb = c.front_baffle_thickness_m.max(0.008);
    let e_pa = m_enc.youngs_modulus_gpa * 1.0e9;
    let nu = m_enc.poisson_ratio.clamp(0.15, 0.45);
    let rho = m_enc.density_kg_m3.max(200.0);
    let eta = m_enc.loss_factor_eta.clamp(0.004, 0.25);

    // Kirchhoff flexural rigidity D = E * h^3 / (12 * (1 - nu^2))
    let d_flex = e_pa * hw.powi(3) / (12.0 * (1.0 - nu * nu));
    let e_baf = m_baf.youngs_modulus_gpa * 1.0e9;
    let nu_b = m_baf.poisson_ratio.clamp(0.15, 0.45);
    let d_baffle = e_baf * hb.powi(3) / (12.0 * (1.0 - nu_b * nu_b));

    // Largest unbraced side/rear panel span: `(d - 2*hw)` by `(h - 2*hw)`
    let a_unbraced = (d - 2.0 * hw).max(0.10);
    let b_unbraced = (h - 2.0 * hw).max(0.10);

    // Effective braced panel sub-spans divided by internal folded-horn walls, sub-chambers, and window braces!
    let fold_divs = if spec.visual_fold_count > 0 {
        spec.visual_fold_count
    } else {
        spec.ways.len().saturating_sub(1)
    };
    let z_divs = (1 + c.brace_count + fold_divs).max(1) as f64;
    let y_divs = if c.brace_count > 0 || spec.visual_fold_count > 0 {
        2.0
    } else {
        1.0
    };
    let a_braced = (a_unbraced / y_divs).max(0.09);
    let b_braced = (b_unbraced / z_divs.sqrt().max(1.35 * (z_divs - 1.0).min(1.0) + 0.65 * z_divs * 0.5))
        .min(b_unbraced / (1.0 + 0.65 * (z_divs - 1.0)))
        .max(0.09);

    let gamma_bc = c.joinery.boundary_stiffness_factor();

    let mindlin_fmn = |m: usize, n: usize, span_a: f64, span_b: f64, thick: f64, d_val: f64| -> f64 {
        let k2 = (m as f64 / span_a).powi(2) + (n as f64 / span_b).powi(2);
        let f_kirchhoff = gamma_bc * (PI / 2.0) * k2 * (d_val / (rho * thick)).sqrt();
        // Mindlin transverse-shear & rotary-inertia thick-plate correction (kappa = 5/6)
        let shear_corr = 1.0
            + (PI * PI * thick * thick / 12.0) * k2 * (1.0 + 2.0 / ((5.0 / 6.0) * (1.0 - nu)));
        f_kirchhoff / shear_corr.sqrt()
    };

    let unbraced_f11 = mindlin_fmn(1, 1, a_unbraced, b_unbraced, hw, d_flex);
    let braced_f11 = mindlin_fmn(1, 1, a_braced, b_braced, hw, d_flex);

    // Low-frequency stiffness-controlled + mass-law panel Sound Transmission Loss estimate (dB)
    let areal_mass = rho * hw;
    let panel_stl_low_freq_db = 20.0 * (areal_mass * braced_f11 * 0.14).max(1.0).log10() + 8.5;

    // 80-point logarithmic sweep 20..5000 Hz evaluating radiated cabinet wall modal coloration (dB re Direct Output)
    let n_pts = 80usize;
    let mut modal_freqs_hz = Vec::with_capacity(n_pts);
    let mut braced_coloration_db = Vec::with_capacity(n_pts);
    let mut unbraced_coloration_db = Vec::with_capacity(n_pts);

    // Reference thin unbraced comparison (`2/3` wall thickness, `eta = 0.018`, unbraced span)
    let hw_ref = (0.67 * hw).max(0.009);
    let d_ref = e_pa * hw_ref.powi(3) / (12.0 * (1.0 - nu * nu));

    for i in 0..n_pts {
        let u = (i as f64) / ((n_pts - 1) as f64);
        let f = 20.0 * (5000.0_f64 / 20.0).powf(u);
        modal_freqs_hz.push(f);

        let eval_panel_rel_db = |span_a: f64, span_b: f64, thick: f64, d_stiff: f64, loss_eta: f64| -> f64 {
            let mut sum_energy = 0.0;
            // Odd-odd volume-displacing modes dominate monopole/dipole cabinet coloration!
            for &(m, n, weight) in &[(1usize, 1usize, 1.0), (1, 3, 0.34), (3, 1, 0.34), (2, 2, 0.16), (3, 3, 0.12)] {
                let f_mn = mindlin_fmn(m, n, span_a, span_b, thick, d_stiff);
                let r = f / f_mn;
                // Dimensionless modal accelerance `(f / f_mn)^2 / sqrt((1 - r^2)^2 + (eta * r)^2)`
                // weighted by internal acoustic rolloff at high frequencies + radiation efficiency sigma(ka)
                let denom = ((1.0 - r * r).powi(2) + (loss_eta * loss_eta)).sqrt();
                let accel = (r * r) / denom;
                let ka_panel = 2.0 * PI * f * (span_a * span_b).sqrt() / 343.0;
                let rad_eff = (ka_panel * ka_panel / (1.0 + ka_panel * ka_panel)).clamp(0.04, 1.0);
                // Internal box pressure falls above mid/bass passband (~600 Hz) due to porous lining & crossover
                let internal_exc = 1.0 / (1.0 + (f / 550.0).powi(2)).sqrt();
                let mass_atten = 14.0 / (rho * thick).max(4.0);
                let amp = weight * accel * rad_eff.sqrt() * internal_exc * mass_atten * 0.011;
                sum_energy += amp * amp;
            }
            (10.0 * sum_energy.max(1.0e-7).log10()).clamp(-65.0, -4.0)
        };

        braced_coloration_db.push(eval_panel_rel_db(a_braced, b_braced, hw, d_flex, eta));
        unbraced_coloration_db.push(eval_panel_rel_db(
            a_unbraced,
            b_unbraced,
            hw_ref,
            d_ref,
            0.018,
        ));
    }

    let gross_l = w * d * h * 1000.0;
    let shell_l = shell_vol_m3 * 1000.0;
    let internal_l = internal_vol_m3 * 1000.0;
    let dd_l = drv_damp_vol_m3 * 1000.0;
    let net_air_l = (gross_l - shell_l - internal_l - dd_l).max(0.2 * gross_l);
    let total_mass_kg = woodwork_mass_kg + drivers_mass_kg + damping_hw_mass_kg;

    CabinetStructuralSummary {
        enclosure_material_name: m_enc.name.clone(),
        baffle_material_name: m_baf.name.clone(),
        joinery_label: c.joinery.label().into(),
        finish_label: m_enc.finish.clone(),
        density_kg_m3: rho,
        youngs_modulus_gpa: m_enc.youngs_modulus_gpa,
        poisson_ratio: nu,
        loss_factor_eta: eta,
        baffle_density_kg_m3: m_baf.density_kg_m3,
        baffle_youngs_modulus_gpa: m_baf.youngs_modulus_gpa,
        wall_thickness_mm: hw * 1000.0,
        baffle_thickness_mm: hb * 1000.0,
        partition_thickness_mm: c.internal_partition_thickness_m * 1000.0,
        brace_thickness_mm: c.brace_thickness_m * 1000.0,
        rebate_depth_mm: c.driver_rebate_depth_m * 1000.0,
        damping_thickness_mm: c.damping_lining_thickness_m * 1000.0,
        brace_count: c.brace_count,
        flexural_rigidity_nm: d_flex,
        baffle_rigidity_nm: d_baffle,
        gross_external_volume_l: gross_l,
        shell_wall_displacement_l: shell_l,
        internal_partitions_displacement_l: internal_l,
        drivers_and_damping_displacement_l: dd_l,
        net_internal_air_volume_l: net_air_l,
        woodwork_mass_kg,
        drivers_mass_kg,
        damping_and_hardware_mass_kg: damping_hw_mass_kg,
        total_mass_kg,
        largest_unbraced_span_mm: [a_unbraced * 1000.0, b_unbraced * 1000.0],
        largest_braced_span_mm: [a_braced * 1000.0, b_braced * 1000.0],
        unbraced_f11_hz: unbraced_f11,
        braced_f11_hz: braced_f11,
        panel_stl_low_freq_db,
        modal_freqs_hz,
        braced_coloration_db,
        unbraced_coloration_db,
    }
}

fn rect_poly(u0: f64, v0: f64, u1: f64, v1: f64) -> Vec<[f32; 2]> {
    vec![
        [u0 as f32, v0 as f32],
        [u1 as f32, v0 as f32],
        [u1 as f32, v1 as f32],
        [u0 as f32, v1 as f32],
    ]
}

fn circle_poly(cu: f64, cv: f64, r: f64, n: usize) -> Vec<[f32; 2]> {
    (0..n)
        .map(|i| {
            let a = 2.0 * PI * (i as f64) / (n as f64);
            [(cu + r * a.cos()) as f32, (cv + r * a.sin()) as f32]
        })
        .collect()
}

/// Generate exact millimeter 2D Orthographic CAD Cross-Section & Elevation Blueprints:
/// 1. `side_yz`: Centerline Vertical Section `X = 0` (`Y` horizontal `-D/2..+D/2`, `Z` vertical `0..H`)
/// 2. `plan_xy`: Mid-Cabinet Horizontal Plan Section (`X` horizontal `-W/2..+W/2`, `Y` vertical `-D/2..+D/2`)
/// 3. `front_xz`: Front Baffle CNC Machining Elevation (`X` horizontal `-W/2..+W/2`, `Z` vertical `0..H`)
fn build_2d_blueprints(
    spec: &SpeakerCabinetSpec,
    drivers: &[DriverSpec],
    openings: &[BaffleOpening],
    is_tapped_horn: bool,
    is_folded_horn: bool,
    is_cardioid: bool,
    is_dual_opposed: bool,
) -> Vec<CrossSectionBlueprint2D> {
    let [w, d, h] = [
        spec.dims_m[0] * 1000.0,
        spec.dims_m[1] * 1000.0,
        spec.dims_m[2] * 1000.0,
    ];
    let c = &spec.construction;
    let wt = c.wall_thickness_m * 1000.0;
    let bt = c.front_baffle_thickness_m * 1000.0;
    let pt = c.internal_partition_thickness_m * 1000.0;
    let brt = c.brace_thickness_m * 1000.0;
    let rebt = c.driver_rebate_depth_m * 1000.0;
    let dt = c.damping_lining_thickness_m * 1000.0;

    let enc_hk = c.enclosure_material.kind.hatch_key();
    let baf_hk = c.baffle_material.kind.hatch_key();
    let enc_col = &c.enclosure_material.color_hex;
    let baf_col = &c.baffle_material.color_hex;

    let hx = 0.5 * w;
    let hy = 0.5 * d;
    let in_y0 = -hy + if is_dual_opposed { bt } else { wt };
    let in_y1 = hy - bt;
    let in_z0 = wt;
    let in_z1 = h - wt;

    // ========================================================================
    // VIEW 1: SIDE CROSS-SECTION (X = 0 mm, Y–Z Plane)
    // ========================================================================
    let mut side_polys = Vec::new();
    let mut side_paths = Vec::new();
    let mut side_dims = Vec::new();
    let mut side_labels = Vec::new();

    // Top, Bottom & Rear finite-thickness walls
    side_polys.push(SectionPolygon2D {
        part_id: "top_panel".into(),
        label: format!("Top Panel ({wt:.1} mm)"),
        material_kind: enc_hk.into(),
        color_hex: enc_col.clone(),
        thickness_mm: wt as f32,
        points_mm: rect_poly(-hy, in_z1, hy, h),
        is_dashed: false,
    });
    side_polys.push(SectionPolygon2D {
        part_id: "bottom_panel".into(),
        label: format!("Bottom Panel ({wt:.1} mm)"),
        material_kind: enc_hk.into(),
        color_hex: enc_col.clone(),
        thickness_mm: wt as f32,
        points_mm: rect_poly(-hy, 0.0, hy, in_z0),
        is_dashed: false,
    });
    if is_dual_opposed {
        let zc_mm = spec
            .ways
            .first()
            .map(|wy| wy.local_acoustic_offset.z * 1000.0)
            .unwrap_or(0.5 * h);
        let r_mm = openings
            .first()
            .map(|op| op.r_bore * 1000.0)
            .unwrap_or(0.32 * h);
        side_polys.push(SectionPolygon2D {
            part_id: "rear_panel".into(),
            label: format!("Rear Opposed Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(-hy, in_z0, in_y0, (zc_mm - r_mm).max(in_z0 + 4.0)),
            is_dashed: false,
        });
        side_polys.push(SectionPolygon2D {
            part_id: "rear_panel".into(),
            label: format!("Rear Opposed Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(-hy, (zc_mm + r_mm).min(in_z1 - 4.0), in_y0, in_z1),
            is_dashed: false,
        });
    } else {
        side_polys.push(SectionPolygon2D {
            part_id: "rear_panel".into(),
            label: format!("Rear Panel ({wt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: enc_col.clone(),
            thickness_mm: wt as f32,
            points_mm: rect_poly(-hy, in_z0, in_y0, in_z1),
            is_dashed: false,
        });
    }

    let push_driver_yz_dir =
        |polys: &mut Vec<SectionPolygon2D>, y_mount: f64, dir: f64, zc: f64, r_mm: f64, reb_mm: f64, lbl: &str| {
            let depth = (0.36 * r_mm).clamp(8.0, 68.0);
            let b_depth = depth + (0.28 * r_mm).clamp(12.0, 48.0);
            let r_vc = (0.28 * r_mm).clamp(12.0, 54.0);
            let r_mag = (r_vc * 1.85).max(0.48 * r_mm);
            let mag_h = (0.22 * r_mm).clamp(10.0, 36.0);
            let pl_t = (0.09 * r_mm).clamp(4.5, 14.0);
            let s = dir.signum();

            for sgn in [-1.0_f64, 1.0_f64] {
                let z_in = zc + sgn * (r_vc + 2.5);
                let z_out = zc + sgn * r_mag;
                let ym0 = y_mount - s * (b_depth + 2.0 * pl_t + mag_h);
                let ym1 = y_mount - s * b_depth;
                polys.push(SectionPolygon2D {
                    part_id: "driver_motor".into(),
                    label: format!("{lbl} Magnet & Steel Plates"),
                    material_kind: "magnet".into(),
                    color_hex: "#94a3b8".into(),
                    thickness_mm: (pl_t * 2.0 + mag_h) as f32,
                    points_mm: rect_poly(ym0.min(ym1), z_in.min(z_out), ym0.max(ym1), z_in.max(z_out)),
                    is_dashed: false,
                });
                let yf0 = y_mount - s * reb_mm.max(4.5);
                polys.push(SectionPolygon2D {
                    part_id: "driver_motor".into(),
                    label: format!("{lbl} Cast Flange"),
                    material_kind: "aluminum".into(),
                    color_hex: "#cbd5e1".into(),
                    thickness_mm: reb_mm.max(4.5) as f32,
                    points_mm: rect_poly(
                        yf0.min(y_mount),
                        (zc + sgn * r_mm * 0.96).min(zc + sgn * r_mm * 1.11),
                        yf0.max(y_mount),
                        (zc + sgn * r_mm * 0.96).max(zc + sgn * r_mm * 1.11),
                    ),
                    is_dashed: false,
                });
                let yvc0 = y_mount - s * (b_depth + pl_t + 0.4 * mag_h);
                let yvc1 = y_mount - s * depth;
                polys.push(SectionPolygon2D {
                    part_id: "driver_cone".into(),
                    label: format!("{lbl} Copper Voice Coil"),
                    material_kind: "copper".into(),
                    color_hex: "#f59e0b".into(),
                    thickness_mm: 2.2,
                    points_mm: rect_poly(
                        yvc0.min(yvc1),
                        (zc + sgn * r_vc).min(zc + sgn * (r_vc + 2.2)),
                        yvc0.max(yvc1),
                        (zc + sgn * r_vc).max(zc + sgn * (r_vc + 2.2)),
                    ),
                    is_dashed: false,
                });
                let zv0 = zc + sgn * (0.32 * r_vc).max(4.0);
                let zv1 = zc + sgn * (r_vc - 1.2);
                polys.push(SectionPolygon2D {
                    part_id: "driver_motor".into(),
                    label: format!("{lbl} Vented Pole Piece"),
                    material_kind: "steel".into(),
                    color_hex: "#64748b".into(),
                    thickness_mm: (zv1 - zv0).abs() as f32,
                    points_mm: rect_poly(ym0.min(ym1), zv0.min(zv1), ym0.max(ym1), zv0.max(zv1)),
                    is_dashed: false,
                });
            }
            let ct = 2.6;
            polys.push(SectionPolygon2D {
                part_id: "driver_cone".into(),
                label: format!("{lbl} Diaphragm Cone"),
                material_kind: "cone".into(),
                color_hex: "#e2e8f0".into(),
                thickness_mm: ct as f32,
                points_mm: vec![
                    [(y_mount - s * 2.0) as f32, (zc + r_mm * 0.94) as f32],
                    [(y_mount - s * depth) as f32, (zc + r_vc) as f32],
                    [(y_mount - s * 0.58 * depth) as f32, zc as f32],
                    [(y_mount - s * depth) as f32, (zc - r_vc) as f32],
                    [(y_mount - s * 2.0) as f32, (zc - r_mm * 0.94) as f32],
                    [(y_mount - s * (2.0 + ct)) as f32, (zc - r_mm * 0.94) as f32],
                    [(y_mount - s * (depth + ct)) as f32, (zc - r_vc) as f32],
                    [(y_mount - s * (0.58 * depth + ct)) as f32, zc as f32],
                    [(y_mount - s * (depth + ct)) as f32, (zc + r_vc) as f32],
                    [(y_mount - s * (2.0 + ct)) as f32, (zc + r_mm * 0.94) as f32],
                ],
                is_dashed: false,
            });
        };

    let push_driver_yz_section =
        |polys: &mut Vec<SectionPolygon2D>, y_mount: f64, zc: f64, r_mm: f64, reb_mm: f64, lbl: &str| {
            push_driver_yz_dir(polys, y_mount, 1.0, zc, r_mm, reb_mm, lbl);
        };

    if is_tapped_horn {
        let z_mouth_top = 0.44 * h;
        let z_tap_floor = 0.485 * h;
        let y_tap = 0.16 * d;
        let y_turn = in_y0 + 0.23 * d;

        side_polys.push(SectionPolygon2D {
            part_id: "front_baffle".into(),
            label: format!("Upper-Front Closure Wall ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(in_y1, z_mouth_top, hy, in_z1),
            is_dashed: false,
        });
        let z_drv = 0.5 * (z_tap_floor + in_z1);
        let r_drv = (0.41 * (in_z1 - z_tap_floor)).min(205.0);
        side_polys.push(SectionPolygon2D {
            part_id: "tap_driver_baffle".into(),
            label: format!("Tap-Junction Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(y_tap - bt, z_tap_floor, y_tap, z_drv - r_drv),
            is_dashed: false,
        });
        side_polys.push(SectionPolygon2D {
            part_id: "tap_driver_baffle".into(),
            label: format!("Tap-Junction Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(y_tap - bt, z_drv + r_drv, y_tap, in_z1),
            is_dashed: false,
        });
        side_polys.push(SectionPolygon2D {
            part_id: "tapped_horn_divider".into(),
            label: format!("Tapped-Horn Center Divider ({pt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: "#dea868".into(),
            thickness_mm: pt as f32,
            points_mm: vec![
                [y_turn as f32, (0.36 * h) as f32],
                [y_tap as f32, (z_tap_floor - pt) as f32],
                [y_tap as f32, z_tap_floor as f32],
                [y_turn as f32, (0.36 * h + pt) as f32],
            ],
            is_dashed: false,
        });
        let lu = 0.14 * d;
        let ll = 0.15 * d;
        let lf = 0.11 * d;
        for pts in [
            vec![[in_y0 as f32, in_z1 as f32], [in_y0 as f32, (in_z1 - lu) as f32], [(in_y0 + lu) as f32, in_z1 as f32]],
            vec![[in_y0 as f32, in_z0 as f32], [(in_y0 + ll) as f32, in_z0 as f32], [in_y0 as f32, (in_z0 + ll) as f32]],
            vec![[(in_y1 - lf) as f32, in_z1 as f32], [in_y1 as f32, (in_z1 - lf) as f32], [in_y1 as f32, in_z1 as f32]],
        ] {
            side_polys.push(SectionPolygon2D {
                part_id: "tapped_corner_reflectors".into(),
                label: "45° Turnaround Reflector".into(),
                material_kind: enc_hk.into(),
                color_hex: "#cfa063".into(),
                thickness_mm: pt as f32,
                points_mm: pts,
                is_dashed: false,
            });
        }
        push_driver_yz_section(&mut side_polys, y_tap, z_drv, r_drv, rebt, "18\" Tapped-Horn Sub");

        // Rear-Cone 2.15 m λ/2 Phase-Inverting Tap Path + Front-Cone Direct Mouth Path!
        side_paths.push(SectionPath2D {
            label: "Rear Cone → 2.15 m λ/2 Phase-Inverting Throat Path".into(),
            color_hex: "#f472b6".into(),
            points_mm: vec![
                [(y_tap - 85.0) as f32, z_drv as f32],
                [(in_y0 + 85.0) as f32, (0.68 * h) as f32],
                [(in_y0 + 85.0) as f32, (0.18 * h) as f32],
                [(hy + 32.0) as f32, (0.20 * h) as f32],
            ],
            dashed: true,
            arrow_end: true,
        });
        side_paths.push(SectionPath2D {
            label: "Front Cone → 0.38 m Direct Tap-to-Mouth Sum".into(),
            color_hex: "#38bdf8".into(),
            points_mm: vec![
                [(y_tap + 20.0) as f32, z_drv as f32],
                [(in_y1 - 55.0) as f32, (0.52 * h) as f32],
                [(hy + 32.0) as f32, (0.26 * h) as f32],
            ],
            dashed: false,
            arrow_end: true,
        });
        side_labels.push(SectionLabel2D {
            pos_mm: [(0.5 * (in_y0 + y_tap - bt)) as f32, (in_z1 - 40.0) as f32],
            text: "Closed Throat (Rear Wave)".into(),
            color_hex: "#f472b6".into(),
        });
        side_labels.push(SectionLabel2D {
            pos_mm: [(hy - 130.0) as f32, (0.09 * h) as f32],
            text: "In-Phase Tap Mouth →".into(),
            color_hex: "#34d399".into(),
        });
    } else if is_folded_horn {
        let z_mouth_top = 0.435 * h;
        let z_ch_floor = 0.495 * h;
        let y_ch_baf = -0.055 * d;
        let y_f1 = in_y1 - 0.175 * d;
        let y_f2 = in_y0 + 0.215 * d;

        // Upper-front closure baffle
        side_polys.push(SectionPolygon2D {
            part_id: "front_baffle".into(),
            label: format!("Upper-Front Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(in_y1, z_mouth_top, hy, in_z1),
            is_dashed: false,
        });
        // Internal driver throat baffle (split above & below 18" cutout!)
        let z_drv = 0.5 * (z_ch_floor + in_z1);
        let r_drv = (0.41 * (in_z1 - z_ch_floor)).min(205.0);
        side_polys.push(SectionPolygon2D {
            part_id: "internal_driver_baffle".into(),
            label: format!("Internal Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(y_ch_baf - bt, z_ch_floor, y_ch_baf, z_drv - r_drv),
            is_dashed: false,
        });
        side_polys.push(SectionPolygon2D {
            part_id: "internal_driver_baffle".into(),
            label: format!("Internal Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(y_ch_baf - bt, z_drv + r_drv, y_ch_baf, in_z1),
            is_dashed: false,
        });
        // Partition 1 (Chamber floor + Fold-1 Salmon tongue)
        side_polys.push(SectionPolygon2D {
            part_id: "horn_partition_1".into(),
            label: format!("Chamber Floor & Fold-1 Ramp ({pt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: "#dea868".into(),
            thickness_mm: pt as f32,
            points_mm: vec![
                [in_y0 as f32, (z_ch_floor - pt) as f32],
                [y_ch_baf as f32, (z_ch_floor - pt) as f32],
                [y_f1 as f32, (z_ch_floor + 0.055 * h - pt) as f32],
                [y_f1 as f32, (z_ch_floor + 0.055 * h) as f32],
                [y_ch_baf as f32, z_ch_floor as f32],
                [in_y0 as f32, z_ch_floor as f32],
            ],
            is_dashed: false,
        });
        // Partition 2 (Fold-2 Exponential Mouth Divider)
        side_polys.push(SectionPolygon2D {
            part_id: "horn_partition_2".into(),
            label: format!("Fold-2 Mouth Divider ({pt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: "#dea868".into(),
            thickness_mm: pt as f32,
            points_mm: vec![
                [y_f2 as f32, (0.245 * h) as f32],
                [hy as f32, (z_mouth_top - pt) as f32],
                [hy as f32, z_mouth_top as f32],
                [y_f2 as f32, (0.245 * h + pt) as f32],
            ],
            is_dashed: false,
        });
        // Three 45° corner reflectors
        let l1 = 0.11 * d;
        let l2 = 0.10 * d;
        let l3 = 0.13 * d;
        for pts in [
            vec![[(in_y1 - l1) as f32, in_z1 as f32], [in_y1 as f32, (in_z1 - l1) as f32], [in_y1 as f32, in_z1 as f32]],
            vec![[in_y0 as f32, (z_ch_floor - pt) as f32], [in_y0 as f32, (z_ch_floor - pt - l2) as f32], [(in_y0 + l2) as f32, (z_ch_floor - pt) as f32]],
            vec![[in_y0 as f32, in_z0 as f32], [(in_y0 + l3) as f32, in_z0 as f32], [in_y0 as f32, (in_z0 + l3) as f32]],
        ] {
            side_polys.push(SectionPolygon2D {
                part_id: "corner_reflectors".into(),
                label: "45° Miter Reflector".into(),
                material_kind: enc_hk.into(),
                color_hex: "#cfa063".into(),
                thickness_mm: pt as f32,
                points_mm: pts,
                is_dashed: false,
            });
        }
        // Damping lining in sealed chamber
        if dt > 2.0 {
            side_polys.push(SectionPolygon2D {
                part_id: "rear_chamber_damping".into(),
                label: format!("Mineral-Wool Lining ({dt:.0} mm)"),
                material_kind: "damping".into(),
                color_hex: "#38bdf8".into(),
                thickness_mm: dt as f32,
                points_mm: rect_poly(in_y0, z_ch_floor, in_y0 + dt, in_z1),
                is_dashed: false,
            });
        }
        push_driver_yz_section(&mut side_polys, y_ch_baf, z_drv, r_drv, rebt, "18\" Horn Sub");

        // Continuous 2.25 m Acoustic Horn Centerline Path!
        side_paths.push(SectionPath2D {
            label: "2,250 mm Expanding Horn Centerline".into(),
            color_hex: "#38bdf8".into(),
            points_mm: vec![
                [(y_ch_baf + 35.0) as f32, z_drv as f32],
                [(in_y1 - 65.0) as f32, (0.72 * h) as f32],
                [(in_y1 - 65.0) as f32, (0.42 * h) as f32],
                [(in_y0 + 75.0) as f32, (0.36 * h) as f32],
                [(in_y0 + 75.0) as f32, (0.13 * h) as f32],
                [(hy + 35.0) as f32, (0.21 * h) as f32],
            ],
            dashed: true,
            arrow_end: true,
        });
        side_labels.push(SectionLabel2D {
            pos_mm: [(0.5 * (in_y0 + y_ch_baf - bt)) as f32, (in_z1 - 42.0) as f32],
            text: "Sealed V_rear = 54 L".into(),
            color_hex: "#93c5fd".into(),
        });
        side_labels.push(SectionLabel2D {
            pos_mm: [(hy - 135.0) as f32, (0.09 * h) as f32],
            text: "4,900 cm² Horn Mouth →".into(),
            color_hex: "#34d399".into(),
        });
    } else {
        // Front baffle sectioned around openings (with real CNC counterbore step!)
        let mut cur_z = in_z0;
        for op in openings {
            let cz_mm = op.cz * 1000.0;
            let (z_lo, z_hi) = if op.is_rect {
                let hh = 0.5 * op.rect_h * 1000.0;
                (cz_mm - hh, cz_mm + hh)
            } else {
                let r_mm = op.r_bore * 1000.0;
                (cz_mm - r_mm, cz_mm + r_mm)
            };
            if z_lo > cur_z + 1.0 {
                side_polys.push(SectionPolygon2D {
                    part_id: "front_baffle".into(),
                    label: format!("Front Baffle ({bt:.1} mm)"),
                    material_kind: baf_hk.into(),
                    color_hex: baf_col.clone(),
                    thickness_mm: bt as f32,
                    points_mm: rect_poly(in_y1, cur_z, hy, z_lo),
                    is_dashed: false,
                });
            }
            cur_z = z_hi;
        }
        if in_z1 > cur_z + 1.0 {
            side_polys.push(SectionPolygon2D {
                part_id: "front_baffle".into(),
                label: format!("Front Baffle ({bt:.1} mm)"),
                material_kind: baf_hk.into(),
                color_hex: baf_col.clone(),
                thickness_mm: bt as f32,
                points_mm: rect_poly(in_y1, cur_z, hy, in_z1),
                is_dashed: false,
            });
        }

        // Internal ports, sub-chambers, waveguides, braces & drivers in Y–Z section
        for (w_idx, wy) in spec.ways.iter().enumerate() {
            let drv = drivers.iter().find(|dr| dr.id == wy.driver_id);
            let r_mm = (drv.map(|dr| dr.small_signal.piston_radius_m()).unwrap_or(0.08) * 1000.0)
                .min(0.42 * w);
            let zc_mm = wy.local_acoustic_offset.z * 1000.0;

            match &wy.enclosure {
                WayEnclosure::WaveguideLoaded { waveguide, .. } => {
                    let wg_l = (waveguide.length_m * 1000.0).min(0.68 * (in_y1 - in_y0));
                    let r_th = ((waveguide.throat_area_m2 / PI).sqrt() * 1000.0).max(12.0);
                    let r_mo = ((waveguide.mouth_area_m2 / PI).sqrt() * 1000.0).min(0.44 * w);
                    for sgn in [-1.0_f64, 1.0_f64] {
                        side_polys.push(SectionPolygon2D {
                            part_id: format!("waveguide_{w_idx}"),
                            label: format!("{} Solid OS-SE Block", wy.label),
                            material_kind: "aluminum".into(),
                            color_hex: "#93c5fd".into(),
                            thickness_mm: 14.0,
                            points_mm: vec![
                                [(hy - wg_l) as f32, (zc_mm + sgn * r_th) as f32],
                                [(hy - 0.45 * wg_l) as f32, (zc_mm + sgn * (r_th + 0.36 * (r_mo - r_th))) as f32],
                                [hy as f32, (zc_mm + sgn * r_mo) as f32],
                                [hy as f32, (zc_mm + sgn * (r_mo + 8.0)) as f32],
                                [(hy - wg_l) as f32, (zc_mm + sgn * (r_th + 16.0)) as f32],
                            ],
                            is_dashed: false,
                        });
                    }
                    push_driver_yz_section(&mut side_polys, hy - wg_l, zc_mm, r_th * 1.15, 0.0, &wy.label);
                }
                WayEnclosure::Sealed { volume_m3, .. } => {
                    if w_idx > 0 && *volume_m3 < 0.012 {
                        let hz = (r_mm * 1.42).max(55.0);
                        let dep = (volume_m3 * 1e9 / ((w - 2.0 * wt) * 2.0 * hz).max(1e3)).clamp(110.0, 0.65 * (in_y1 - in_y0));
                        let yb = in_y1 - dep;
                        side_polys.push(SectionPolygon2D {
                            part_id: format!("mid_chamber_{w_idx}"),
                            label: format!("Sealed Mid Chamber ({pt:.1} mm walls)"),
                            material_kind: enc_hk.into(),
                            color_hex: "#cfa063".into(),
                            thickness_mm: pt as f32,
                            points_mm: vec![
                                [in_y1 as f32, (zc_mm + hz) as f32],
                                [(yb - pt) as f32, (zc_mm + hz) as f32],
                                [(yb - pt) as f32, (zc_mm - hz - pt) as f32],
                                [in_y1 as f32, (zc_mm - hz - pt) as f32],
                                [in_y1 as f32, (zc_mm - hz) as f32],
                                [yb as f32, (zc_mm - hz) as f32],
                                [yb as f32, (zc_mm + hz - pt) as f32],
                                [in_y1 as f32, (zc_mm + hz - pt) as f32],
                            ],
                            is_dashed: false,
                        });
                    }
                    push_driver_yz_section(&mut side_polys, hy, zc_mm, r_mm, rebt, &wy.label);
                    if is_dual_opposed {
                        push_driver_yz_dir(&mut side_polys, -hy, -1.0, zc_mm, r_mm, 0.0, "Rear Opposed Sub");
                        let ys = (0.34 * d).max(50.0);
                        side_polys.push(SectionPolygon2D {
                            part_id: "force_cancel_tie_bar".into(),
                            label: "6061-T6 Force-Canceling Motor Tie-Bar".into(),
                            material_kind: "aluminum".into(),
                            color_hex: "#93c5fd".into(),
                            thickness_mm: 16.0,
                            points_mm: rect_poly(-0.5 * ys, zc_mm - 12.0, 0.5 * ys, zc_mm + 12.0),
                            is_dashed: false,
                        });
                        side_labels.push(SectionLabel2D {
                            pos_mm: [0.0, (zc_mm + r_mm * 0.52) as f32],
                            text: "← F_rear + F_front = 0 N →".into(),
                            color_hex: "#93c5fd".into(),
                        });
                    }
                }
                WayEnclosure::Vented { port, .. } => {
                    if port.local_normal.y >= 0.0 {
                        let plen = (port.length_m * 1000.0).min(0.84 * (in_y1 - in_y0));
                        let pw = ((port.area_m2 * 3.6).sqrt() * 1000.0).min(w - 2.0 * wt - 30.0);
                        let ph = ((port.area_m2 * 1e6) / pw.max(20.0)).clamp(22.0, 110.0);
                        let pzc = (port.local_exit_offset.z * 1000.0).clamp(in_z0 + 0.5 * ph + 8.0, 0.30 * h);
                        side_polys.push(SectionPolygon2D {
                            part_id: format!("port_duct_{w_idx}"),
                            label: format!("Flared Port Wall ({pt:.1} mm)"),
                            material_kind: enc_hk.into(),
                            color_hex: "#34d399".into(),
                            thickness_mm: pt as f32,
                            points_mm: rect_poly(in_y1 - plen, pzc + 0.5 * ph, in_y1, pzc + 0.5 * ph + pt),
                            is_dashed: false,
                        });
                        side_paths.push(SectionPath2D {
                            label: format!("Port L = {:.0} mm", plen),
                            color_hex: "#34d399".into(),
                            points_mm: vec![
                                [(in_y1 - plen - 18.0) as f32, pzc as f32],
                                [(hy + 22.0) as f32, pzc as f32],
                            ],
                            dashed: true,
                            arrow_end: true,
                        });
                    }
                    push_driver_yz_section(&mut side_polys, hy, zc_mm, r_mm, rebt, &wy.label);
                }
                _ => {
                    push_driver_yz_section(&mut side_polys, hy, zc_mm, r_mm, rebt, &wy.label);
                }
            }
        }

        // Window braces in Y–Z section
        if c.brace_count > 0 {
            let by0 = in_y0 + dt + 8.0;
            let by1 = in_y1 - 85.0;
            if by1 > by0 + 50.0 {
                for bi in 0..c.brace_count {
                    let mut zc = in_z0 + ((bi + 1) as f64 / (c.brace_count + 1) as f64) * (in_z1 - in_z0);
                    for wy in &spec.ways {
                        if (zc - wy.local_acoustic_offset.z * 1000.0).abs() < 55.0 {
                            zc += 60.0;
                        }
                    }
                    zc = zc.clamp(in_z0 + 75.0, in_z1 - 75.0);
                    side_polys.push(SectionPolygon2D {
                        part_id: "window_braces".into(),
                        label: format!("Window Brace ({brt:.1} mm)"),
                        material_kind: enc_hk.into(),
                        color_hex: "#e2b879".into(),
                        thickness_mm: brt as f32,
                        points_mm: rect_poly(by0, zc - 0.5 * brt, by1, zc + 0.5 * brt),
                        is_dashed: false,
                    });
                }
            }
        }

        // Porous rear wall lining
        if dt > 2.0 && !is_cardioid {
            side_polys.push(SectionPolygon2D {
                part_id: "acoustic_lining".into(),
                label: format!("Acoustic Lining ({dt:.0} mm)"),
                material_kind: "damping".into(),
                color_hex: "#38bdf8".into(),
                thickness_mm: dt as f32,
                points_mm: rect_poly(in_y0, in_z0 + 60.0, in_y0 + dt, in_z1 - dt),
                is_dashed: false,
            });
        }
    }

    // Side Section Millimeter Dimensions
    side_dims.push(SectionDimension2D {
        p0_mm: [-hy as f32, 0.0],
        p1_mm: [hy as f32, 0.0],
        offset_mm: -38.0,
        label: format!("D = {d:.0} mm"),
    });
    side_dims.push(SectionDimension2D {
        p0_mm: [-hy as f32, 0.0],
        p1_mm: [-hy as f32, h as f32],
        offset_mm: -44.0,
        label: format!("H = {h:.0} mm"),
    });
    side_labels.push(SectionLabel2D {
        pos_mm: [0.0, (h + 22.0) as f32],
        text: format!("Wall {wt:.1} mm · Baffle {bt:.1} mm · Partition {pt:.1} mm"),
        color_hex: "#fbbf24".into(),
    });

    // ========================================================================
    // VIEW 2: HORIZONTAL PLAN SECTION (X–Y Plane)
    // ========================================================================
    let mut plan_polys = Vec::new();
    let mut plan_dims = Vec::new();
    let mut plan_labels = Vec::new();

    if is_cardioid {
        // Slotted side walls + resistive porous blocks!
        let sy0 = -0.14 * d;
        let sy1 = 0.04 * d;
        for (sgn, pid) in [(-1.0_f64, "left_wall"), (1.0_f64, "right_wall")] {
            let x_out = if sgn < 0.0 { -hx } else { hx - wt };
            let x_in = x_out + wt;
            plan_polys.push(SectionPolygon2D {
                part_id: pid.into(),
                label: format!("Side Wall ({wt:.1} mm)"),
                material_kind: enc_hk.into(),
                color_hex: enc_col.clone(),
                thickness_mm: wt as f32,
                points_mm: rect_poly(x_out, -hy, x_in, sy0),
                is_dashed: false,
            });
            plan_polys.push(SectionPolygon2D {
                part_id: pid.into(),
                label: format!("Side Wall ({wt:.1} mm)"),
                material_kind: enc_hk.into(),
                color_hex: enc_col.clone(),
                thickness_mm: wt as f32,
                points_mm: rect_poly(x_out, sy1, x_in, hy),
                is_dashed: false,
            });
            // Resistive porous block inside side slot
            let pad = dt.max(26.0);
            let px0 = if sgn < 0.0 { -hx + wt } else { hx - wt - pad };
            plan_polys.push(SectionPolygon2D {
                part_id: "cardioid_resistive_pads".into(),
                label: format!("Cardioid Resistive Block ({pad:.0} mm)"),
                material_kind: "damping".into(),
                color_hex: "#fb7185".into(),
                thickness_mm: pad as f32,
                points_mm: rect_poly(px0, sy0 - 6.0, px0 + pad, sy1 + 6.0),
                is_dashed: false,
            });
        }
        plan_labels.push(SectionLabel2D {
            pos_mm: [0.0, (0.5 * (sy0 + sy1)) as f32],
            text: "← Resistive Cardioid Side Slots (σ = 14.5 kPa·s/m²) →".into(),
            color_hex: "#fb7185".into(),
        });
    } else {
        plan_polys.push(SectionPolygon2D {
            part_id: "left_wall".into(),
            label: format!("Left Wall ({wt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: enc_col.clone(),
            thickness_mm: wt as f32,
            points_mm: rect_poly(-hx, -hy, -hx + wt, hy),
            is_dashed: false,
        });
        plan_polys.push(SectionPolygon2D {
            part_id: "right_wall".into(),
            label: format!("Right Wall ({wt:.1} mm)"),
            material_kind: enc_hk.into(),
            color_hex: enc_col.clone(),
            thickness_mm: wt as f32,
            points_mm: rect_poly(hx - wt, -hy, hx, hy),
            is_dashed: false,
        });
    }

    let rab_mm = match c.joinery {
        JoineryKind::RabbetDado | JoineryKind::InterlockingCncTab => 0.5 * wt,
        JoineryKind::Miter45 => 0.0,
    };
    plan_polys.push(SectionPolygon2D {
        part_id: "rear_panel".into(),
        label: format!("Rear Panel ({wt:.1} mm)"),
        material_kind: enc_hk.into(),
        color_hex: enc_col.clone(),
        thickness_mm: wt as f32,
        points_mm: rect_poly(-hx + wt - rab_mm, -hy, hx - wt + rab_mm, in_y0),
        is_dashed: false,
    });
    plan_polys.push(SectionPolygon2D {
        part_id: "front_baffle".into(),
        label: format!("Front Baffle ({bt:.1} mm)"),
        material_kind: baf_hk.into(),
        color_hex: baf_col.clone(),
        thickness_mm: bt as f32,
        points_mm: rect_poly(-hx + wt - rab_mm, in_y1, hx - wt + rab_mm, hy),
        is_dashed: false,
    });

    if is_tapped_horn {
        let y_tap = 0.16 * d;
        plan_polys.push(SectionPolygon2D {
            part_id: "tap_driver_baffle".into(),
            label: format!("Tap-Junction Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(-hx + wt, y_tap - bt, hx - wt, y_tap),
            is_dashed: false,
        });
        if c.brace_count > 0 {
            plan_polys.push(SectionPolygon2D {
                part_id: "tapped_tie_brace".into(),
                label: format!("Center Mouth Splitter ({brt:.1} mm)"),
                material_kind: enc_hk.into(),
                color_hex: "#e2b879".into(),
                thickness_mm: brt as f32,
                points_mm: rect_poly(-0.5 * brt, in_y0 + 0.25 * d, 0.5 * brt, hy - 15.0),
                is_dashed: false,
            });
        }
    } else if is_folded_horn {
        let y_ch_baf = -0.055 * d;
        plan_polys.push(SectionPolygon2D {
            part_id: "internal_driver_baffle".into(),
            label: format!("Internal Driver Baffle ({bt:.1} mm)"),
            material_kind: baf_hk.into(),
            color_hex: baf_col.clone(),
            thickness_mm: bt as f32,
            points_mm: rect_poly(-hx + wt, y_ch_baf - bt, hx - wt, y_ch_baf),
            is_dashed: false,
        });
        if c.brace_count > 0 {
            plan_polys.push(SectionPolygon2D {
                part_id: "horn_tie_braces".into(),
                label: format!("Center Mouth Splitter ({brt:.1} mm)"),
                material_kind: enc_hk.into(),
                color_hex: "#e2b879".into(),
                thickness_mm: brt as f32,
                points_mm: rect_poly(-0.5 * brt, in_y0 + 0.25 * d, 0.5 * brt, hy - 15.0),
                is_dashed: false,
            });
        }
    } else if c.brace_count > 0 {
        let by0 = in_y0 + dt + 8.0;
        let by1 = in_y1 - 85.0;
        if by1 > by0 + 50.0 {
            plan_polys.push(SectionPolygon2D {
                part_id: "window_braces".into(),
                label: format!("Window Brace Plan ({brt:.1} mm)"),
                material_kind: enc_hk.into(),
                color_hex: "#e2b879".into(),
                thickness_mm: brt as f32,
                points_mm: rect_poly(-hx + wt, by0, hx - wt, by1),
                is_dashed: true,
            });
            let r_win = (0.28 * (by1 - by0)).min(0.26 * (hx - wt));
            for sx in [-0.5 * (hx - wt), 0.5 * (hx - wt)] {
                plan_polys.push(SectionPolygon2D {
                    part_id: "window_cutout".into(),
                    label: "CNC Airflow Window".into(),
                    material_kind: "outline".into(),
                    color_hex: "#38bdf8".into(),
                    thickness_mm: 0.0,
                    points_mm: circle_poly(sx, 0.5 * (by0 + by1), r_win, 28),
                    is_dashed: true,
                });
            }
        }
    }

    plan_dims.push(SectionDimension2D {
        p0_mm: [-hx as f32, -hy as f32],
        p1_mm: [hx as f32, -hy as f32],
        offset_mm: -38.0,
        label: format!("W = {w:.0} mm (Inner {:.0} mm)", w - 2.0 * wt),
    });
    plan_dims.push(SectionDimension2D {
        p0_mm: [-hx as f32, -hy as f32],
        p1_mm: [-hx as f32, hy as f32],
        offset_mm: -42.0,
        label: format!("D = {d:.0} mm"),
    });

    // ========================================================================
    // VIEW 3: FRONT BAFFLE CNC ELEVATION (X–Z Plane)
    // ========================================================================
    let mut front_polys = Vec::new();
    let mut front_dims = Vec::new();
    let mut front_labels = Vec::new();

    front_polys.push(SectionPolygon2D {
        part_id: "front_baffle".into(),
        label: format!("Front Baffle Face ({w:.0} × {h:.0} mm)"),
        material_kind: baf_hk.into(),
        color_hex: baf_col.clone(),
        thickness_mm: bt as f32,
        points_mm: rect_poly(-hx, 0.0, hx, h),
        is_dashed: false,
    });
    // Hidden dashed inner wall boundary showing `wall_t` thickness on all 4 sides!
    front_polys.push(SectionPolygon2D {
        part_id: "inner_wall_line".into(),
        label: format!("Inner Wall Clear Span ({wt:.1} mm inset)"),
        material_kind: "outline".into(),
        color_hex: "#fbbf24".into(),
        thickness_mm: wt as f32,
        points_mm: rect_poly(-hx + wt, wt, hx - wt, h - wt),
        is_dashed: true,
    });

    for op in openings {
        let cx_mm = op.cx * 1000.0;
        let cz_mm = op.cz * 1000.0;
        if op.is_rect {
            let rw = op.rect_w * 1000.0;
            let rh = op.rect_h * 1000.0;
            front_polys.push(SectionPolygon2D {
                part_id: "port_mouth".into(),
                label: format!("{} ({rw:.0}×{rh:.0} mm)", op.way_label),
                material_kind: "steel".into(),
                color_hex: "#34d399".into(),
                thickness_mm: 0.0,
                points_mm: rect_poly(cx_mm - 0.5 * rw, cz_mm - 0.5 * rh, cx_mm + 0.5 * rw, cz_mm + 0.5 * rh),
                is_dashed: false,
            });
            front_labels.push(SectionLabel2D {
                pos_mm: [cx_mm as f32, cz_mm as f32],
                text: format!("{}: {rw:.0}×{rh:.0} mm", op.way_label),
                color_hex: "#34d399".into(),
            });
        } else {
            let rb = op.r_bore * 1000.0;
            let rreb = op.r_rebate * 1000.0;
            if op.rebate_depth > 1e-4 {
                front_polys.push(SectionPolygon2D {
                    part_id: "cnc_rebate".into(),
                    label: format!("CNC Rebate Ø{:.0} × {:.1} mm", 2.0 * rreb, op.rebate_depth * 1000.0),
                    material_kind: "outline".into(),
                    color_hex: "#38bdf8".into(),
                    thickness_mm: (op.rebate_depth * 1000.0) as f32,
                    points_mm: circle_poly(cx_mm, cz_mm, rreb, 36),
                    is_dashed: true,
                });
            }
            front_polys.push(SectionPolygon2D {
                part_id: "driver_bore".into(),
                label: format!("{} Cutout Ø{:.0} mm", op.way_label, 2.0 * rb),
                material_kind: "steel".into(),
                color_hex: "#cbd5e1".into(),
                thickness_mm: bt as f32,
                points_mm: circle_poly(cx_mm, cz_mm, rb, 36),
                is_dashed: false,
            });
            front_labels.push(SectionLabel2D {
                pos_mm: [cx_mm as f32, cz_mm as f32],
                text: format!("Ø{:.0} mm (Z={cz_mm:.0})", 2.0 * rb),
                color_hex: "#f8fafc".into(),
            });
        }
    }

    front_dims.push(SectionDimension2D {
        p0_mm: [-hx as f32, 0.0],
        p1_mm: [hx as f32, 0.0],
        offset_mm: -38.0,
        label: format!("W = {w:.0} mm"),
    });
    front_dims.push(SectionDimension2D {
        p0_mm: [-hx as f32, 0.0],
        p1_mm: [-hx as f32, h as f32],
        offset_mm: -44.0,
        label: format!("H = {h:.0} mm"),
    });

    vec![
        CrossSectionBlueprint2D {
            view_id: "side_yz".into(),
            title: "Side Cross-Section (X = 0 mm)".into(),
            plane_caption: "Vertical Y–Z Symmetry Section (+Y Right = Front Baffle)".into(),
            u_label: "Y Depth (mm)".into(),
            v_label: "Z Height (mm)".into(),
            bounds_mm: [-hy as f32, hy as f32, 0.0, h as f32],
            polygons: side_polys,
            paths: side_paths,
            dimensions: side_dims,
            labels: side_labels,
        },
        CrossSectionBlueprint2D {
            view_id: "plan_xy".into(),
            title: "Horizontal Plan Section (X–Y)".into(),
            plane_caption: "Mid-Height Horizontal Cut (+Y Top = Front Baffle)".into(),
            u_label: "X Width (mm)".into(),
            v_label: "Y Depth (mm)".into(),
            bounds_mm: [-hx as f32, hx as f32, -hy as f32, hy as f32],
            polygons: plan_polys,
            paths: Vec::new(),
            dimensions: plan_dims,
            labels: plan_labels,
        },
        CrossSectionBlueprint2D {
            view_id: "front_xz".into(),
            title: "Front Baffle CNC Elevation (X–Z)".into(),
            plane_caption: "Through-Bores, Counterbore Rebates & Hidden Wall Inset".into(),
            u_label: "X Width (mm)".into(),
            v_label: "Z Height (mm)".into(),
            bounds_mm: [-hx as f32, hx as f32, 0.0, h as f32],
            polygons: front_polys,
            paths: Vec::new(),
            dimensions: front_dims,
            labels: front_labels,
        },
    ]
}
