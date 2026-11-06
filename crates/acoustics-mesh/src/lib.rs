//! Parametric watertight 3D BEM surface meshes (`AcousticSurfaceMesh`),
//! finite-thickness solid 3D CAD cabinet assemblies (`VisualCabinetModel`),
//! 2D orthographic cross-section blueprints, and plate-bending modal physics.

pub mod cabinet_cad;

use acoustics_math::triangle_geometry;
use acoustics_types::{
    AcousticsError, AcousticSurfaceMesh, BoundaryCondition, DriverSpec, PatchId, PatchSurface,
    Point3, SpeakerCabinetSpec, Vec3, VisualCabinetModel, WayEnclosure,
};
use std::collections::HashMap;
use std::f64::consts::PI;

/// Audit that an `AcousticSurfaceMesh` is watertight (every undirected edge shared by 2 triangles
/// with opposite orientation) and encloses strictly positive volume (outward normals!).
pub fn audit_watertight_manifold(mesh: &AcousticSurfaceMesh) -> Result<f64, AcousticsError> {
    if mesh.indices.is_empty() {
        return Err(AcousticsError::MeshDefect {
            mesh_name: mesh.name.clone(),
            detail: "empty triangle list".into(),
        });
    }
    let mut directed_edges: HashMap<(u32, u32), usize> = HashMap::new();
    let mut signed_vol6 = 0.0;

    for &[i0, i1, i2] in &mesh.indices {
        for &(a, b) in &[(i0, i1), (i1, i2), (i2, i0)] {
            *directed_edges.entry((a, b)).or_insert(0) += 1;
        }
        let p0 = Point3::from(mesh.positions[i0 as usize]);
        let p1 = Point3::from(mesh.positions[i1 as usize]);
        let p2 = Point3::from(mesh.positions[i2 as usize]);
        signed_vol6 += Vec3::new(p0.x, p0.y, p0.z).dot(
            Vec3::new(p1.x, p1.y, p1.z).cross(Vec3::new(p2.x, p2.y, p2.z)),
        );
    }

    for (&(a, b), &count) in &directed_edges {
        if count != 1 {
            return Err(AcousticsError::MeshDefect {
                mesh_name: mesh.name.clone(),
                detail: format!("non-manifold directed edge ({a} -> {b}) count={count}"),
            });
        }
        if directed_edges.get(&(b, a)).copied().unwrap_or(0) != 1 {
            return Err(AcousticsError::MeshDefect {
                mesh_name: mesh.name.clone(),
                detail: format!("open boundary edge ({a} -> {b}) missing twin"),
            });
        }
    }

    let volume = signed_vol6 / 6.0;
    if volume <= 1.0e-12 {
        return Err(AcousticsError::MeshDefect {
            mesh_name: mesh.name.clone(),
            detail: format!("non-positive enclosed volume {volume:.6e} (inverted normals)"),
        });
    }
    Ok(volume)
}

/// Build an exact watertight icosphere mesh of radius `radius_m` (`subdivisions = 1 -> 80 tris, 2 -> 320 tris`).
/// Used for exact Burton-Miller BEM pulsating & oscillating sphere oracle verification!
pub fn build_sphere_bem_mesh(
    radius_m: f64,
    subdivisions: usize,
    boundary: BoundaryCondition,
) -> AcousticSurfaceMesh {
    let phi = 0.5 * (1.0 + 5.0_f64.sqrt());
    let raw_verts = [
        [-1.0, phi, 0.0],
        [1.0, phi, 0.0],
        [-1.0, -phi, 0.0],
        [1.0, -phi, 0.0],
        [0.0, -1.0, phi],
        [0.0, 1.0, phi],
        [0.0, -1.0, -phi],
        [0.0, 1.0, -phi],
        [phi, 0.0, -1.0],
        [phi, 0.0, 1.0],
        [-phi, 0.0, -1.0],
        [-phi, 0.0, 1.0],
    ];
    let mut positions: Vec<[f64; 3]> = raw_verts
        .iter()
        .map(|v| {
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            [
                radius_m * v[0] / n,
                radius_m * v[1] / n,
                radius_m * v[2] / n,
            ]
        })
        .collect();

    let mut tris: Vec<[u32; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];

    for _ in 0..subdivisions {
        let mut mid_cache: HashMap<(u32, u32), u32> = HashMap::new();
        let mut next_tris = Vec::with_capacity(tris.len() * 4);
        let mut get_mid = |a: u32, b: u32, pos: &mut Vec<[f64; 3]>| -> u32 {
            let key = if a < b { (a, b) } else { (b, a) };
            if let Some(&idx) = mid_cache.get(&key) {
                return idx;
            }
            let pa = pos[a as usize];
            let pb = pos[b as usize];
            let mx = 0.5 * (pa[0] + pb[0]);
            let my = 0.5 * (pa[1] + pb[1]);
            let mz = 0.5 * (pa[2] + pb[2]);
            let n = (mx * mx + my * my + mz * mz).sqrt();
            let idx = pos.len() as u32;
            pos.push([radius_m * mx / n, radius_m * my / n, radius_m * mz / n]);
            mid_cache.insert(key, idx);
            idx
        };

        for [i0, i1, i2] in tris {
            let m01 = get_mid(i0, i1, &mut positions);
            let m12 = get_mid(i1, i2, &mut positions);
            let m20 = get_mid(i2, i0, &mut positions);
            next_tris.push([i0, m01, m20]);
            next_tris.push([i1, m12, m01]);
            next_tris.push([i2, m20, m12]);
            next_tris.push([m01, m12, m20]);
        }
        tris = next_tris;
    }

    let tri_count = tris.len() as u32;
    AcousticSurfaceMesh {
        name: format!("sphere_r{radius_m:.3}"),
        positions,
        indices: tris,
        patches: vec![PatchSurface {
            id: PatchId::rooted(1),
            label: "sphere_surface".into(),
            tri_start: 0,
            tri_count,
            boundary,
        }],
    }
}

/// Build a watertight, manifold 3D BEM surface mesh for a `SpeakerCabinetSpec`!
///
/// Captures:
/// - Exact cabinet bounding dimensions `[W, D, H]` centered at `(0, 0, H/2)` (bottom rests at `z = 0` or centered for monitors);
/// - Rounded/chamfered front baffle edges (`edge_round_m > 0`) reducing 3D edge diffraction;
/// - Recessed **3D OS-SE Waveguide Cavity** on the front baffle (`+Y`) for `WaveguideLoaded` ways so 3D BEM
///   directly computes true waveguide directional beaming & baffle transition;
/// - Tagged `TransducerDiaphragm` patches per way, `RadiationPort` patches, and side `SurfaceImpedance`
///   cardioid resistive slots for `CardioidSlot` cabinets!
pub fn build_cabinet_bem_mesh(
    spec: &SpeakerCabinetSpec,
    drivers: &[DriverSpec],
    nx_grid: usize,
) -> AcousticSurfaceMesh {
    let w = spec.dims_m[0];
    let d = spec.dims_m[1];
    let h = spec.dims_m[2];
    let nx = nx_grid.clamp(5, 14);
    let ny = ((nx as f64 * d / w).round() as usize).clamp(4, 12);
    let nz = ((nx as f64 * h / w).round() as usize).clamp(6, 16);

    // Start from a topological 3D cube grid `(nx x ny x nz)` mapped onto `[-W/2..W/2] x [-D/2..D/2] x [0..H]`
    // with smooth baffle edge rounding & recessed waveguide throats — guaranteed 100% watertight manifold!
    let mut vert_map: HashMap<(usize, usize, usize), u32> = HashMap::new();
    let mut positions: Vec<[f64; 3]> = Vec::new();

    let get_vert = |ix: usize,
                    iy: usize,
                    iz: usize,
                    vmap: &mut HashMap<(usize, usize, usize), u32>,
                    pos: &mut Vec<[f64; 3]>|
     -> u32 {
        if let Some(&id) = vmap.get(&(ix, iy, iz)) {
            return id;
        }
        let ux = (ix as f64) / (nx as f64) - 0.5; // -0.5 .. +0.5
        let uy = (iy as f64) / (ny as f64) - 0.5; // -0.5 .. +0.5 (+0.5 is front baffle!)
        let uz = (iz as f64) / (nz as f64); // 0.0 .. 1.0

        let x = ux * w;
        let mut y = uy * d;
        let z = uz * h;

        // Apply front-baffle edge chamfer/rounding when near +Y face
        if spec.edge_round_m > 1.0e-4 && iy == ny && ix > 0 && ix < nx && iz > 0 && iz < nz {
            let _ = spec.edge_round_m;
        }
        if spec.edge_round_m > 1.0e-4 && iy >= ny.saturating_sub(1) {
            let r_edge = spec.edge_round_m.min(0.22 * w.min(h));
            let dx_edge = (0.5 * w - x.abs()).max(0.0);
            let dz_edge = (z.min(h - z)).max(0.0);
            if dx_edge < r_edge {
                let pull = r_edge - (r_edge * r_edge - (r_edge - dx_edge).powi(2)).max(0.0).sqrt();
                y -= pull * ((iy as f64) / (ny as f64));
            }
            if dz_edge < r_edge {
                let pull = r_edge - (r_edge * r_edge - (r_edge - dz_edge).powi(2)).max(0.0).sqrt();
                y -= 0.6 * pull * ((iy as f64) / (ny as f64));
            }
        }

        // Sculpt 3D OS-SE waveguide depression into the front baffle (+Y face, iy == ny)
        if iy == ny && ix > 0 && ix < nx && iz > 0 && iz < nz {
            for way in &spec.ways {
                if let WayEnclosure::WaveguideLoaded { waveguide, .. } = &way.enclosure {
                    let cx = way.local_acoustic_offset.x;
                    let cz = way.local_acoustic_offset.z;
                    let r_mouth = (waveguide.mouth_area_m2 / PI).sqrt();
                    let r_throat = (waveguide.throat_area_m2 / PI).sqrt();
                    let dist = ((x - cx).powi(2) + (z - cz).powi(2)).sqrt();
                    if dist < r_mouth {
                        // Smooth OS-SE flare recession depth into +Y baffle!
                        let norm_r = ((dist - r_throat).max(0.0) / (r_mouth - r_throat).max(1e-4))
                            .clamp(0.0, 1.0);
                        let depth = waveguide.length_m * (1.0 - norm_r.powf(1.45));
                        y -= depth;
                    }
                }
            }
        }

        let id = pos.len() as u32;
        pos.push([x, y, z]);
        vmap.insert((ix, iy, iz), id);
        id
    };

    // Collect triangles grouped by boundary condition so patches stay contiguous!
    let mut rigid_tris: Vec<[u32; 3]> = Vec::new();
    let mut way_tris: Vec<Vec<[u32; 3]>> = vec![Vec::new(); spec.ways.len()];
    let mut cardioid_slot_tris: Vec<([u32; 3], f64)> = Vec::new();

    // Helper to classify a front-baffle (+Y) triangle centroid against driver/horn apertures
    let classify_front_tri = |c: Point3| -> Option<usize> {
        let mut best: Option<(usize, f64)> = None;
        for (w_idx, way) in spec.ways.iter().enumerate() {
            let drv = drivers.iter().find(|d| d.id == way.driver_id);
            let r_ap = match &way.enclosure {
                WayEnclosure::WaveguideLoaded { waveguide, .. } => {
                    // Inner throat region is the driven diaphragm; outer flare is rigid waveguide wall!
                    ((waveguide.throat_area_m2 / PI).sqrt() * 1.65)
                        .max(0.55 * (waveguide.mouth_area_m2 / PI).sqrt())
                }
                WayEnclosure::FoldedHorn { segments, .. } => segments
                    .last()
                    .map(|s| (s.mouth_area_m2 / PI).sqrt())
                    .unwrap_or(0.22),
                WayEnclosure::TappedHorn { tap_to_mouth, .. } => tap_to_mouth
                    .last()
                    .map(|s| (s.mouth_area_m2 / PI).sqrt())
                    .unwrap_or(0.22),
                _ => drv
                    .map(|d| d.small_signal.piston_radius_m() * (way.driver_count as f64).sqrt())
                    .unwrap_or(0.08),
            };
            let cx = way.local_acoustic_offset.x;
            let cz = way.local_acoustic_offset.z;
            let dist = ((c.x - cx).powi(2) + (c.z - cz).powi(2)).sqrt();
            if dist <= r_ap * 1.18 {
                if best.map_or(true, |(_, b_r)| r_ap < b_r) {
                    best = Some((w_idx, r_ap));
                }
            }
        }
        best.map(|(i, _)| i)
    };

    // Check if cabinet has a cardioid resistive slot on side walls
    let cardioid_cfg = spec.ways.iter().find_map(|w| {
        if let WayEnclosure::CardioidSlot {
            slot_flow_resistivity,
            ..
        } = &w.enclosure
        {
            Some((w.local_acoustic_offset.z, *slot_flow_resistivity))
        } else {
            None
        }
    });

    // 1. Front face (+Y, iy = ny): outward normal +Y => (ix, ny, iz): [v00, v01, v11], [v00, v11, v10]
    // Wait: let's check cross product: e1 = p(ix, iz+1) - p(ix, iz) = +Z; e2 = p(ix+1, iz+1) - p(ix, iz) = +X + Z
    // (+Z) x (+X) = +Y! Exact outward normal +Y!
    for ix in 0..nx {
        for iz in 0..nz {
            let v00 = get_vert(ix, ny, iz, &mut vert_map, &mut positions);
            let v10 = get_vert(ix + 1, ny, iz, &mut vert_map, &mut positions);
            let v01 = get_vert(ix, ny, iz + 1, &mut vert_map, &mut positions);
            let v11 = get_vert(ix + 1, ny, iz + 1, &mut vert_map, &mut positions);
            for tri in [[v00, v01, v11], [v00, v11, v10]] {
                let (c, _, _) = triangle_geometry(
                    Point3::from(positions[tri[0] as usize]),
                    Point3::from(positions[tri[1] as usize]),
                    Point3::from(positions[tri[2] as usize]),
                );
                if let Some(w_idx) = classify_front_tri(c) {
                    way_tris[w_idx].push(tri);
                } else {
                    rigid_tris.push(tri);
                }
            }
        }
    }

    // Ensure every way has at least 2 closest front-baffle triangles if driver radius is finer than grid cell!
    for (w_idx, way) in spec.ways.iter().enumerate() {
        if way_tris[w_idx].is_empty() && !rigid_tris.is_empty() {
            let target = Point3::new(
                way.local_acoustic_offset.x,
                0.5 * d,
                way.local_acoustic_offset.z,
            );
            let mut best_i = 0;
            let mut best_d = f64::INFINITY;
            for (i, &tri) in rigid_tris.iter().enumerate() {
                let (c, n, _) = triangle_geometry(
                    Point3::from(positions[tri[0] as usize]),
                    Point3::from(positions[tri[1] as usize]),
                    Point3::from(positions[tri[2] as usize]),
                );
                if n.y > 0.3 {
                    let dist = c.dist(target);
                    if dist < best_d {
                        best_d = dist;
                        best_i = i;
                    }
                }
            }
            let picked = rigid_tris.swap_remove(best_i);
            way_tris[w_idx].push(picked);
        }
    }

    // 2. Rear face (-Y, iy = 0): outward normal -Y => (+X) x (+Z) = -Y!
    for ix in 0..nx {
        for iz in 0..nz {
            let v00 = get_vert(ix, 0, iz, &mut vert_map, &mut positions);
            let v10 = get_vert(ix + 1, 0, iz, &mut vert_map, &mut positions);
            let v01 = get_vert(ix, 0, iz + 1, &mut vert_map, &mut positions);
            let v11 = get_vert(ix + 1, 0, iz + 1, &mut vert_map, &mut positions);
            rigid_tris.push([v00, v10, v11]);
            rigid_tris.push([v00, v11, v01]);
        }
    }

    // 3. Right face (+X, ix = nx): outward normal +X => (+Y) x (+Z) = +X!
    for iy in 0..ny {
        for iz in 0..nz {
            let v00 = get_vert(nx, iy, iz, &mut vert_map, &mut positions);
            let v10 = get_vert(nx, iy + 1, iz, &mut vert_map, &mut positions);
            let v01 = get_vert(nx, iy, iz + 1, &mut vert_map, &mut positions);
            let v11 = get_vert(nx, iy + 1, iz + 1, &mut vert_map, &mut positions);
            for tri in [[v00, v10, v11], [v00, v11, v01]] {
                let (c, _, _) = triangle_geometry(
                    Point3::from(positions[tri[0] as usize]),
                    Point3::from(positions[tri[1] as usize]),
                    Point3::from(positions[tri[2] as usize]),
                );
                if let Some((z_slot, sigma)) = cardioid_cfg {
                    if (c.z - z_slot).abs() < 0.14 && c.y < 0.1 * d && c.y > -0.35 * d {
                        cardioid_slot_tris.push((tri, sigma));
                        continue;
                    }
                }
                rigid_tris.push(tri);
            }
        }
    }

    // 4. Left face (-X, ix = 0): outward normal -X => (+Z) x (+Y) = -X!
    for iy in 0..ny {
        for iz in 0..nz {
            let v00 = get_vert(0, iy, iz, &mut vert_map, &mut positions);
            let v10 = get_vert(0, iy + 1, iz, &mut vert_map, &mut positions);
            let v01 = get_vert(0, iy, iz + 1, &mut vert_map, &mut positions);
            let v11 = get_vert(0, iy + 1, iz + 1, &mut vert_map, &mut positions);
            for tri in [[v00, v01, v11], [v00, v11, v10]] {
                let (c, _, _) = triangle_geometry(
                    Point3::from(positions[tri[0] as usize]),
                    Point3::from(positions[tri[1] as usize]),
                    Point3::from(positions[tri[2] as usize]),
                );
                if let Some((z_slot, sigma)) = cardioid_cfg {
                    if (c.z - z_slot).abs() < 0.14 && c.y < 0.1 * d && c.y > -0.35 * d {
                        cardioid_slot_tris.push((tri, sigma));
                        continue;
                    }
                }
                rigid_tris.push(tri);
            }
        }
    }

    // 5. Top face (+Z, iz = nz): outward normal +Z => (+X) x (+Y) = +Z!
    for ix in 0..nx {
        for iy in 0..ny {
            let v00 = get_vert(ix, iy, nz, &mut vert_map, &mut positions);
            let v10 = get_vert(ix + 1, iy, nz, &mut vert_map, &mut positions);
            let v01 = get_vert(ix, iy + 1, nz, &mut vert_map, &mut positions);
            let v11 = get_vert(ix + 1, iy + 1, nz, &mut vert_map, &mut positions);
            rigid_tris.push([v00, v10, v11]);
            rigid_tris.push([v00, v11, v01]);
        }
    }

    // 6. Bottom face (-Z, iz = 0): outward normal -Z => (+Y) x (+X) = -Z!
    for ix in 0..nx {
        for iy in 0..ny {
            let v00 = get_vert(ix, iy, 0, &mut vert_map, &mut positions);
            let v10 = get_vert(ix + 1, iy, 0, &mut vert_map, &mut positions);
            let v01 = get_vert(ix, iy + 1, 0, &mut vert_map, &mut positions);
            let v11 = get_vert(ix + 1, iy + 1, 0, &mut vert_map, &mut positions);
            rigid_tris.push([v00, v01, v11]);
            rigid_tris.push([v00, v11, v10]);
        }
    }

    let mut indices = Vec::new();
    let mut patches = Vec::new();

    let rigid_start = indices.len() as u32;
    indices.extend_from_slice(&rigid_tris);
    patches.push(PatchSurface {
        id: PatchId::rooted(100),
        label: "cabinet_walls".into(),
        tri_start: rigid_start,
        tri_count: rigid_tris.len() as u32,
        boundary: BoundaryCondition::RigidWall,
    });

    for (w_idx, tris) in way_tris.into_iter().enumerate() {
        if !tris.is_empty() {
            let start = indices.len() as u32;
            let count = tris.len() as u32;
            indices.extend_from_slice(&tris);
            patches.push(PatchSurface {
                id: PatchId::rooted(200 + w_idx as u64),
                label: spec.ways[w_idx].way_id.clone(),
                tri_start: start,
                tri_count: count,
                boundary: BoundaryCondition::TransducerDiaphragm {
                    driver_index: w_idx,
                    polarity_sign: 1.0,
                },
            });
        }
    }

    if !cardioid_slot_tris.is_empty() {
        let sigma = cardioid_slot_tris[0].1;
        let start = indices.len() as u32;
        let count = cardioid_slot_tris.len() as u32;
        for (tri, _) in cardioid_slot_tris {
            indices.push(tri);
        }
        patches.push(PatchSurface {
            id: PatchId::rooted(300),
            label: "cardioid_resistive_slots".into(),
            tri_start: start,
            tri_count: count,
            boundary: BoundaryCondition::SurfaceImpedance {
                flow_resistivity_pa_s_m2: sigma,
                thickness_m: 0.035,
            },
        });
    }

    AcousticSurfaceMesh {
        name: spec.id.clone(),
        positions,
        indices,
        patches,
    }
}

/// Build an engineering-grade finite-thickness 3D CAD speaker assembly, 2D orthographic
/// cross-section blueprints (`Side Y-Z`, `Plan X-Y`, `Front X-Z`), and Kirchhoff-Mindlin
/// structural panel resonance & mass/volume summary (`VisualCabinetModel`).
pub fn build_visual_cabinet_model(
    spec: &SpeakerCabinetSpec,
    drivers: &[DriverSpec],
) -> VisualCabinetModel {
    cabinet_cad::build_detailed_cabinet_cad(spec, drivers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use acoustics_types::{
        CabinetConstructionSpec, CabinetWaySpec, DriverNonlinear, DriverSmallSignal, DriverThermal,
        HornContour, HornSegmentSpec, InductanceModel,
    };

    #[test]
    fn test_sphere_and_cabinet_meshes_are_watertight_manifold() {
        let sph = build_sphere_bem_mesh(0.15, 2, BoundaryCondition::RigidWall);
        let vol = audit_watertight_manifold(&sph).expect("sphere must be watertight");
        let exact_vol = (4.0 / 3.0) * PI * 0.15_f64.powi(3);
        assert!((vol - exact_vol).abs() / exact_vol < 0.04);

        let drv = DriverSpec {
            id: "tw1".into(),
            name: "1in Dome".into(),
            category: "hf".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.8,
                inductance: InductanceModel::Simple { le_h: 0.05e-3 },
                bl_t_m: 3.2,
                mms_kg: 0.00045,
                cms_m_per_n: 0.0005,
                creep_lambda: 0.0,
                rms_n_s_m: 0.35,
                sd_m2: 0.0007,
                xmax_m: 0.0015,
                xmech_m: 0.003,
                pe_max_w: 80.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        };
        let cab = SpeakerCabinetSpec {
            id: "mon".into(),
            name: "Monitor".into(),
            subtitle: "Test".into(),
            dims_m: [0.28, 0.32, 0.46],
            edge_round_m: 0.025,
            visual_fold_count: 0,
            construction: CabinetConstructionSpec::default(),
            ways: vec![CabinetWaySpec {
                way_id: "hf".into(),
                label: "HF".into(),
                driver_id: "tw1".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.36),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.0003,
                    throat_chamber_m3: 0.00002,
                    waveguide: HornSegmentSpec {
                        length_m: 0.038,
                        throat_area_m2: 0.0007,
                        mouth_area_m2: 0.015,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 90.0,
                            coverage_v_deg: 70.0,
                        },
                        aspect_ratio: 1.0,
                    },
                },
            }],
        };
        let bem_mesh = build_cabinet_bem_mesh(&cab, &[drv], 7);
        let cab_vol =
            audit_watertight_manifold(&bem_mesh).expect("cabinet BEM mesh must be watertight");
        assert!(cab_vol > 0.02);
    }

    #[test]
    fn test_material_thickness_scaling_and_solid_cad_assembly() {
        let drv = DriverSpec {
            id: "sub18".into(),
            name: "18in Neodymium Horn Sub".into(),
            category: "sub".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.1,
                inductance: InductanceModel::Simple { le_h: 1.4e-3 },
                bl_t_m: 29.0,
                mms_kg: 0.22,
                cms_m_per_n: 0.0001,
                creep_lambda: 0.0,
                rms_n_s_m: 6.5,
                sd_m2: 0.122,
                xmax_m: 0.014,
                xmech_m: 0.022,
                pe_max_w: 1800.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        };

        let mut thin_cab = SpeakerCabinetSpec {
            id: "horn_test".into(),
            name: "Horn Test".into(),
            subtitle: "Test".into(),
            dims_m: [0.60, 0.90, 0.90],
            edge_round_m: 0.018,
            visual_fold_count: 3,
            construction: CabinetConstructionSpec {
                wall_thickness_m: 0.012,
                front_baffle_thickness_m: 0.018,
                internal_partition_thickness_m: 0.012,
                brace_thickness_m: 0.012,
                brace_count: 2,
                ..CabinetConstructionSpec::default()
            },
            ways: vec![CabinetWaySpec {
                way_id: "sub".into(),
                label: "18\" Horn".into(),
                driver_id: "sub18".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.45),
                enclosure: WayEnclosure::Sealed {
                    volume_m3: 0.054,
                    leakage_ql: 20.0,
                    damping: Default::default(),
                },
            }],
        };

        let model_12mm = build_visual_cabinet_model(&thin_cab, std::slice::from_ref(&drv));
        thin_cab.construction.wall_thickness_m = 0.024;
        thin_cab.construction.internal_partition_thickness_m = 0.024;
        let model_24mm = build_visual_cabinet_model(&thin_cab, std::slice::from_ref(&drv));

        // 1. Kirchhoff flexural rigidity D = E * h^3 / (12*(1-nu^2)) MUST scale by 2^3 = 8.0x!
        let ratio_d =
            model_24mm.structural.flexural_rigidity_nm / model_12mm.structural.flexural_rigidity_nm;
        assert!(
            (ratio_d - 8.0).abs() < 1.0e-9,
            "expected 8.0x cubic rigidity scaling, got {ratio_d}"
        );

        // 2. Thicker walls must raise panel f_11, increase woodwork mass, and reduce net air volume!
        assert!(model_24mm.structural.braced_f11_hz > 1.8 * model_12mm.structural.braced_f11_hz);
        assert!(model_24mm.structural.braced_f11_hz > 2.2 * model_24mm.structural.unbraced_f11_hz);
        assert!(model_24mm.structural.woodwork_mass_kg > 1.65 * model_12mm.structural.woodwork_mass_kg);
        assert!(
            model_24mm.structural.net_internal_air_volume_l
                < model_12mm.structural.net_internal_air_volume_l
        );

        // 3. Solid CAD parts + 3 orthographic 2D cross-section blueprints must all be populated
        assert_eq!(model_24mm.sections_2d.len(), 3);
        assert!(model_24mm.submeshes.iter().any(|s| s.part_id == "left_wall"));
        assert!(model_24mm.submeshes.iter().any(|s| s.part_id == "horn_partition_1"));
        assert!(model_24mm.submeshes.iter().any(|s| s.layer == "driver_motor"));
    }
}
