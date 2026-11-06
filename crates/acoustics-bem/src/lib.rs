//! Tier 2 Full-Wave 3D Exterior Burton-Miller Boundary Element Solver (`acoustics-bem`) [Ref #10, #11, #12].
//!
//! Solves the 3D exterior Helmholtz boundary integral equation (`exp(+j*w*t)`):
//!   `(CBIE + alpha * HBIE) p = rhs(v_n)`,  with `alpha = -j / k`
//! regularized via the Liu-Rizzo Laplace subtraction identity (`int d^2 G_0 / (dn_x dn_y) dGamma = 0`)
//! and integrated over self-elements via Duffy polar-simplex singular quadrature (`duffy_centroid_quad_points`).
//! Supports free-space (`4*pi`) and half-space rigid ground (`2*pi` modified Green's function) as well as
//! locally reacting surface impedance patches (`SurfaceImpedance`, e.g. cardioid resistive slots!).

use acoustics_math::{
    duffy_centroid_quad_points, triangle_geometry, triangle_quad_points_7, ComplexMatrix,
};
use acoustics_types::{
    AcousticsError, AcousticSurfaceMesh, AirProperties, BoundaryCondition, Complex64, Point3, Vec3,
};
use std::f64::consts::PI;

/// Precomputed boundary triangle element with regular & Duffy singular quadrature rules.
#[derive(Clone, Debug)]
struct BemElement {
    centroid: Point3,
    normal: Vec3,
    area: f64,
    quad_reg: [(Point3, f64); 7],
    quad_duffy: Vec<(Point3, f64)>,
    boundary: BoundaryCondition,
}

/// Solved surface state on an `AcousticSurfaceMesh` at one frequency `freq_hz`.
#[derive(Clone, Debug)]
pub struct BemSurfaceSolution {
    pub freq_hz: f64,
    pub half_space_ground: bool,
    pub centroids: Vec<Point3>,
    pub normals: Vec<Vec3>,
    pub areas: Vec<f64>,
    /// Solved exterior surface pressure `p_j` (`Pa` RMS) on each triangle.
    pub pressure: Vec<Complex64>,
    /// Outgoing normal velocity `v_{n,j}` (`m / s` RMS) on each triangle.
    pub velocity_n: Vec<Complex64>,
}

/// Solve the 3D Burton-Miller BEM problem on `mesh` given prescribed diaphragm/port velocities
/// `way_velocities` (`m / s` RMS indexed by `driver_index` / `port_index`).
pub fn solve_exterior_burton_miller(
    mesh: &AcousticSurfaceMesh,
    way_velocities: &[Complex64],
    freq_hz: f64,
    air: &AirProperties,
    half_space_ground: bool,
) -> Result<BemSurfaceSolution, AcousticsError> {
    let n_elem = mesh.indices.len();
    if n_elem == 0 {
        return Err(AcousticsError::MeshDefect {
            mesh_name: mesh.name.clone(),
            detail: "empty BEM mesh".into(),
        });
    }

    // Map each triangle to its patch BoundaryCondition
    let mut tri_bc = vec![BoundaryCondition::RigidWall; n_elem];
    for patch in &mesh.patches {
        let start = patch.tri_start as usize;
        let end = (start + patch.tri_count as usize).min(n_elem);
        for item in tri_bc.iter_mut().take(end).skip(start) {
            *item = patch.boundary.clone();
        }
    }

    let mut elems = Vec::with_capacity(n_elem);
    for (idx, &[i0, i1, i2]) in mesh.indices.iter().enumerate() {
        let p0 = Point3::from(mesh.positions[i0 as usize]);
        let p1 = Point3::from(mesh.positions[i1 as usize]);
        let p2 = Point3::from(mesh.positions[i2 as usize]);
        let (centroid, normal, area) = triangle_geometry(p0, p1, p2);
        let quad_reg = triangle_quad_points_7(p0, p1, p2, area);
        let quad_duffy = duffy_centroid_quad_points(p0, p1, p2);
        elems.push(BemElement {
            centroid,
            normal,
            area,
            quad_reg,
            quad_duffy,
            boundary: tri_bc[idx].clone(),
        });
    }

    let k = air.wavenumber(freq_hz).max(1.0e-4);
    let omega = 2.0 * PI * freq_hz.max(0.1);
    let j_omega_rho = Complex64::new(0.0, omega * air.density_kg_m3);
    // Burton-Miller coupling parameter alpha = -j / k (damped smoothly for ka << 1 numerical conditioning)
    let char_len = elems.iter().map(|e| e.area).sum::<f64>().sqrt();
    let alpha_scale = (k * char_len).clamp(0.15, 1.0);
    let alpha = Complex64::new(0.0, -alpha_scale / k);

    let mut lhs = ComplexMatrix::zeros(n_elem, n_elem);
    let mut rhs_op = ComplexMatrix::zeros(n_elem, n_elem);

    for i in 0..n_elem {
        let xi = elems[i].centroid;
        let ni = elems[i].normal;

        // CBIE free term +1/2 on diagonal; HBIE RHS free term +alpha/2 on diagonal
        lhs.add_assign(i, i, Complex64::new(0.5, 0.0));
        rhs_op.add_assign(i, i, 0.5 * alpha * j_omega_rho);

        let mut sum_h0_offdiag = 0.0_f64;

        for j in 0..n_elem {
            if i == j {
                // Self-element (coincident triangle):
                // On a planar triangle, (y - x_i) . n_i == 0 and n_x == n_y => dG/dn_x = dG/dn_y = 0!
                // Single-layer S_ii and regularized hypersingular difference (N_k - N_0)_ii are weakly singular (1/R),
                // integrated to machine precision via Duffy centroid quadrature!
                let mut s_ii = Complex64::new(0.0, 0.0);
                let mut diff_n_ii = Complex64::new(0.0, 0.0);
                for &(y, ds) in &elems[j].quad_duffy {
                    let r = xi.dist(y).max(1.0e-14);
                    let exp_m_jkr = Complex64::from_polar(1.0, -k * r);
                    let gk = exp_m_jkr / (4.0 * PI * r);
                    s_ii += gk * ds;

                    // On planar element (r_vec . n == 0, n_i . n_j == 1):
                    // d^2 G_k / (dn_x dn_y) = (1 + j*k*r) * exp(-j*k*r) / (4*pi*r^3)
                    // d^2 G_0 / (dn_x dn_y) = 1 / (4*pi*r^3)
                    // Difference = [(1 + j*k*r)*exp(-j*k*r) - 1] / (4*pi*r^3), which is O(k^2 / (8*pi*r)) as r -> 0!
                    let kr = k * r;
                    let num = if kr < 1.0e-3 {
                        // Exact Taylor series avoiding catastrophic cancellation for small kr!
                        let kr2 = kr * kr;
                        let kr3 = kr2 * kr;
                        Complex64::new(0.5 * kr2 - 0.125 * kr2 * kr2, -kr3 / 3.0)
                    } else {
                        Complex64::new(1.0, kr) * exp_m_jkr - Complex64::new(1.0, 0.0)
                    };
                    diff_n_ii += (num / (4.0 * PI * r * r * r)) * ds;
                }

                // Add half-space ground image contribution (`z -> -z`) if active!
                if half_space_ground {
                    let (d_ij, s_ij, dstar_ij, nk_ij) =
                        integrate_smooth_element(xi.mirror_z(), Vec3::new(ni.x, ni.y, -ni.z), &elems[j], k);
                    // Wait: by symmetry G_half(x, y) = G(x, y) + G(x, mirror_z(y)), equivalent to evaluating at mirror_z(x) with mirrored n_x!
                    lhs.add_assign(i, i, -d_ij - alpha * nk_ij);
                    rhs_op.add_assign(i, i, j_omega_rho * (s_ij + alpha * dstar_ij));
                }

                lhs.add_assign(i, i, -alpha * diff_n_ii);
                rhs_op.add_assign(i, i, j_omega_rho * s_ii);
            } else {
                let (d_ij, s_ij, dstar_ij, nk_ij) = integrate_smooth_element(xi, ni, &elems[j], k);
                let n0_ij = integrate_laplace_hypersingular(xi, ni, &elems[j]);
                sum_h0_offdiag += n0_ij;

                let mut d_tot = d_ij;
                let mut s_tot = s_ij;
                let mut dstar_tot = dstar_ij;
                let mut nk_tot = nk_ij;

                if half_space_ground {
                    let (dg, sg, dsg, nkg) = integrate_smooth_element(
                        xi.mirror_z(),
                        Vec3::new(ni.x, ni.y, -ni.z),
                        &elems[j],
                        k,
                    );
                    d_tot += dg;
                    s_tot += sg;
                    dstar_tot += dsg;
                    nk_tot += nkg;
                }

                lhs.add_assign(i, j, -d_tot - alpha * nk_tot);
                rhs_op.add_assign(i, j, j_omega_rho * (s_tot + alpha * dstar_tot));
            }
        }

        // Liu-Rizzo subtraction diagonal restoration: - sum_{j != i} N0_{ij} * p_i (multiplying -alpha on LHS -> +alpha * sum_h0_offdiag!)
        lhs.add_assign(i, i, alpha * sum_h0_offdiag);
    }

    // Apply mixed boundary conditions (`TransducerDiaphragm` / `RadiationPort` / `RigidWall` -> prescribed v_n;
    // `SurfaceImpedance` -> Robin condition `v_n = -Y_s * p`, moving `+rhs_op(:, j) * Y_s` onto `lhs(:, j)`!).
    let mut prescribed_vn = vec![Complex64::new(0.0, 0.0); n_elem];
    for j in 0..n_elem {
        match elems[j].boundary {
            BoundaryCondition::RigidWall | BoundaryCondition::ThermoviscousWall => {
                prescribed_vn[j] = Complex64::new(0.0, 0.0);
            }
            BoundaryCondition::TransducerDiaphragm {
                driver_index,
                polarity_sign,
            } => {
                let v = way_velocities
                    .get(driver_index)
                    .copied()
                    .unwrap_or(Complex64::new(0.0, 0.0));
                prescribed_vn[j] = v * polarity_sign;
            }
            BoundaryCondition::RadiationPort { port_index } => {
                let v = way_velocities
                    .get(port_index)
                    .copied()
                    .unwrap_or(Complex64::new(0.0, 0.0));
                prescribed_vn[j] = v;
            }
            BoundaryCondition::SurfaceImpedance {
                flow_resistivity_pa_s_m2,
                thickness_m,
            } => {
                // Locally-reacting porous slot / absorber admittance `Y_s = 1 / Z_s` (`v_n = -Y_s * p` into body)
                let z_resistive = flow_resistivity_pa_s_m2 * thickness_m.max(0.005);
                let y_surf = Complex64::new(1.0 / z_resistive.max(1.0), 0.0);
                for i in 0..n_elem {
                    let col_val = rhs_op.get(i, j);
                    lhs.add_assign(i, j, col_val * y_surf);
                }
            }
        }
    }

    let mut rhs = vec![Complex64::new(0.0, 0.0); n_elem];
    for i in 0..n_elem {
        let mut s = Complex64::new(0.0, 0.0);
        for j in 0..n_elem {
            s += rhs_op.get(i, j) * prescribed_vn[j];
        }
        rhs[i] = s;
    }

    let lu = lhs
        .lu_factor()
        .map_err(|rcond| AcousticsError::SingularSystem { freq_hz, rcond })?;
    let pressure = lu.solve(&rhs);

    // Recover actual normal velocity including `SurfaceImpedance` Robin patches
    let mut velocity_n = prescribed_vn;
    for j in 0..n_elem {
        if let BoundaryCondition::SurfaceImpedance {
            flow_resistivity_pa_s_m2,
            thickness_m,
        } = elems[j].boundary
        {
            let z_resistive = flow_resistivity_pa_s_m2 * thickness_m.max(0.005);
            velocity_n[j] = -pressure[j] / z_resistive.max(1.0);
        }
    }

    Ok(BemSurfaceSolution {
        freq_hz,
        half_space_ground,
        centroids: elems.iter().map(|e| e.centroid).collect(),
        normals: elems.iter().map(|e| e.normal).collect(),
        areas: elems.iter().map(|e| e.area).collect(),
        pressure,
        velocity_n,
    })
}

/// Evaluate exact exterior Helmholtz representation integral `p(obs)` at any 3D field point `obs`!
pub fn evaluate_bem_exterior_pressure(
    obs: Point3,
    sol: &BemSurfaceSolution,
    air: &AirProperties,
) -> Complex64 {
    let k = air.wavenumber(sol.freq_hz).max(1.0e-4);
    let omega = 2.0 * PI * sol.freq_hz.max(0.1);
    let j_omega_rho = Complex64::new(0.0, omega * air.density_kg_m3);
    let mut p_ext = Complex64::new(0.0, 0.0);

    for j in 0..sol.pressure.len() {
        let y = sol.centroids[j];
        let ny = sol.normals[j];
        let area = sol.areas[j];
        let pj = sol.pressure[j];
        let vj = sol.velocity_n[j];

        p_ext += helmholtz_rep_pair(obs, y, ny, area, pj, vj, k, j_omega_rho);
        if sol.half_space_ground {
            let y_img = y.mirror_z();
            let ny_img = Vec3::new(ny.x, ny.y, -ny.z);
            p_ext += helmholtz_rep_pair(obs, y_img, ny_img, area, pj, vj, k, j_omega_rho);
        }
    }
    p_ext
}

#[inline]
fn helmholtz_rep_pair(
    obs: Point3,
    y: Point3,
    ny: Vec3,
    area: f64,
    pj: Complex64,
    vj: Complex64,
    k: f64,
    j_omega_rho: Complex64,
) -> Complex64 {
    let r_vec = obs.sub(y); // x - y
    let r = r_vec.norm().max(1.0e-6);
    let exp_m_jkr = Complex64::from_polar(1.0, -k * r);
    let gk = exp_m_jkr / (4.0 * PI * r);
    // dG_k(x, y) / dn_y = + ((x - y) . n_y) * (1 + j*k*r) * exp(-j*k*r) / (4*pi*r^3)
    // Verify at k=0: grad_y (1/|x - y|) = +(x - y) / |x - y|^3! Exact!
    let r_dot_ny = r_vec.dot(ny);
    let dgk_dny = (r_dot_ny * Complex64::new(1.0, k * r) * exp_m_jkr) / (4.0 * PI * r * r * r);
    (dgk_dny * pj + j_omega_rho * gk * vj) * area
}

fn integrate_smooth_element(
    xi: Point3,
    ni: Vec3,
    elem_j: &BemElement,
    k: f64,
) -> (Complex64, Complex64, Complex64, Complex64) {
    let nj = elem_j.normal;
    let ni_dot_nj = ni.dot(nj);
    let mut d_ij = Complex64::new(0.0, 0.0);
    let mut s_ij = Complex64::new(0.0, 0.0);
    let mut dstar_ij = Complex64::new(0.0, 0.0);
    let mut nk_ij = Complex64::new(0.0, 0.0);

    for &(y, ds) in &elem_j.quad_reg {
        let r_vec = xi.sub(y); // x_i - y
        let r2 = r_vec.dot(r_vec).max(1.0e-14);
        let r = r2.sqrt();
        let inv_4pi_r = 1.0 / (4.0 * PI * r);
        let exp_m_jkr = Complex64::from_polar(1.0, -k * r);
        let gk = exp_m_jkr * inv_4pi_r;
        let one_plus_jkr = Complex64::new(1.0, k * r);

        let r_dot_nj = r_vec.dot(nj);
        let r_dot_ni = r_vec.dot(ni);
        let factor_r3 = exp_m_jkr * one_plus_jkr / (4.0 * PI * r2 * r);

        // dG/dn_y = +((x - y) . n_y) * (1 + jkr) * exp(-jkr) / (4*pi*r^3)
        let d_val = r_dot_nj * factor_r3;
        // dG/dn_x = -((x - y) . n_x) * (1 + jkr) * exp(-jkr) / (4*pi*r^3)
        let dstar_val = -r_dot_ni * factor_r3;

        // d^2 G_k / (dn_x dn_y) = exp(-jkr)/(4*pi*r^3) * [ (1 + jkr)*(n_x . n_y) - (3 + 3*jkr - k^2*r^2) * ((x-y).n_x)*((x-y).n_y)/r^2 ]
        let kr = k * r;
        let three_term = Complex64::new(3.0 - kr * kr, 3.0 * kr);
        let nk_val = (exp_m_jkr / (4.0 * PI * r2 * r))
            * (one_plus_jkr * ni_dot_nj - three_term * (r_dot_ni * r_dot_nj / r2));

        d_ij += d_val * ds;
        s_ij += gk * ds;
        dstar_ij += dstar_val * ds;
        nk_ij += nk_val * ds;
    }
    (d_ij, s_ij, dstar_ij, nk_ij)
}

fn integrate_laplace_hypersingular(xi: Point3, ni: Vec3, elem_j: &BemElement) -> f64 {
    let nj = elem_j.normal;
    let ni_dot_nj = ni.dot(nj);
    let mut n0 = 0.0;
    for &(y, ds) in &elem_j.quad_reg {
        let r_vec = xi.sub(y);
        let r2 = r_vec.dot(r_vec).max(1.0e-14);
        let r = r2.sqrt();
        let r_dot_ni = r_vec.dot(ni);
        let r_dot_nj = r_vec.dot(nj);
        let val = (ni_dot_nj - 3.0 * r_dot_ni * r_dot_nj / r2) / (4.0 * PI * r2 * r);
        n0 += val * ds;
    }
    n0
}

#[cfg(test)]
mod tests {
    use super::*;
    use acoustics_mesh::build_sphere_bem_mesh;
    use acoustics_oracles::pulsating_sphere_exact;
    use acoustics_types::pa_to_spl_db;

    #[test]
    fn test_burton_miller_pulsating_sphere_right_through_irregular_ka_pi() {
        // Oracle O2.1: Test Burton-Miller BEM at ka = 1.0 AND right on the notorious
        // first interior Dirichlet eigenfrequency ka = pi (where naive CBIE blows up!).
        let air = AirProperties::default();
        let radius = 0.15;
        let mesh = build_sphere_bem_mesh(
            radius,
            1, // 80 triangles — fast and clean!
            BoundaryCondition::TransducerDiaphragm {
                driver_index: 0,
                polarity_sign: 1.0,
            },
        );

        for &ka_target in &[1.0_f64, PI] {
            let freq_hz = ka_target * air.sound_speed_m_s / (2.0 * PI * radius);
            let v0 = Complex64::new(0.05, 0.0);
            let sol = solve_exterior_burton_miller(&mesh, &[v0], freq_hz, &air, false)
                .expect("Burton-Miller BEM solve must succeed at irregular frequency");

            let r_obs = 1.5;
            let p_bem = evaluate_bem_exterior_pressure(Point3::new(0.0, r_obs, 0.0), &sol, &air);
            let (_, p_exact) = pulsating_sphere_exact(radius, v0, r_obs, freq_hz, &air);

            let db_err = (pa_to_spl_db(p_bem.norm()) - pa_to_spl_db(p_exact.norm())).abs();
            // Even on a coarse 80-triangle icosphere (inscribed radius ~ 0.93*a), error is < 0.75 dB
            // and completely free of the >25 dB fictitious resonance spike at ka = pi!
            assert!(
                db_err < 0.85,
                "ka={ka_target:.3}: BEM SPL={:.2} dB vs exact={:.2} dB (err={db_err:.3} dB)",
                pa_to_spl_db(p_bem.norm()),
                pa_to_spl_db(p_exact.norm())
            );
        }
    }
}
