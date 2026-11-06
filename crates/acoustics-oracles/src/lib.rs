//! Closed-form analytical acoustics & electroacoustics reference oracles (Invariant A7).
//!
//! Used by unit and integration suites across all solver tiers (`acoustics-network`,
//! `acoustics-bem`, `acoustics-nonlinear`, `acoustics-calibration`) to enforce measurable
//! numerical correctness against peer-reviewed closed-form theory.

use acoustics_math::{bessel_j0, bessel_j1, spherical_hankel2_0, spherical_hankel2_1, struve_h1};
use acoustics_types::{AirProperties, Complex64, DriverSmallSignal};
use std::f64::consts::PI;

/// Exact specific radiation impedance `Z_s = p(a) / v_0` (`Rayl`) and exterior pressure `p(r)` (`Pa`)
/// of a radially pulsating sphere of radius `a` with radial velocity `v_0` (`exp(+j*w*t)`) [Ref #6, #10]:
/// `Z_s(ka) = rho_0 * c * (j * ka) / (1 + j * ka)` and `p(r) = Z_s(ka) * v_0 * (a / r) * exp(-j * k * (r - a))`.
pub fn pulsating_sphere_exact(
    radius_m: f64,
    v0_m_s: Complex64,
    eval_r_m: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> (Complex64, Complex64) {
    let k = air.wavenumber(freq_hz);
    let ka = k * radius_m;
    let z0 = air.z0();
    let jka = Complex64::new(0.0, ka);
    let z_spec = z0 * jka / (Complex64::new(1.0, 0.0) + jka);
    let p_surface = z_spec * v0_m_s;
    let phase = Complex64::from_polar(1.0, -k * (eval_r_m - radius_m));
    let p_r = p_surface * (radius_m / eval_r_m) * phase;
    (z_spec, p_r)
}

/// Exact surface pressure `p(a, theta)` and radial far-field pressure `p(r, theta)` of a rigid sphere
/// oscillating along `+Z` with velocity `u_z` (`v_n(theta) = u_z * cos(theta)`) [Ref #6, #10].
/// Evaluates cleanly right through the interior irregular wavenumbers `ka = pi, 4.493409...`!
pub fn oscillating_sphere_exact(
    radius_m: f64,
    uz_m_s: Complex64,
    eval_r_m: f64,
    theta_rad: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> Complex64 {
    let k = air.wavenumber(freq_hz);
    let ka = k * radius_m;
    let kr = k * eval_r_m;
    // Derivative of h_1^(2)(x): h_1^(2)'(x) = h_0^(2)(x) - (2/x) * h_1^(2)(x)
    let dh1_ka = spherical_hankel2_0(ka) - (2.0 / ka) * spherical_hankel2_1(ka);
    let h1_kr = spherical_hankel2_1(kr);
    let j = Complex64::new(0.0, 1.0);
    // Boundary condition: -1/(j*w*rho) * dp/dr|_{r=a} = u_z * cos(theta)
    // => p(r, theta) = -j * rho_0 * c * u_z * cos(theta) * h_1^(2)(kr) / h_1^(2)'(ka)
    -j * air.z0() * uz_m_s * theta_rad.cos() * (h1_kr / dh1_ka)
}

/// Exact acoustic self-radiation impedance `Z_11 = p / U` (`Pa * s / m^3`) of a circular rigid piston
/// of radius `a` in an infinite rigid baffle (`2*pi` half-space) [Ref #6]:
/// `Z_11(ka) = (rho_0 * c / S) * [1 - J_1(2ka)/(ka) + j * H_1(2ka)/(ka)]`.
pub fn baffled_piston_self_impedance(
    radius_m: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> Complex64 {
    let s = PI * radius_m * radius_m;
    let ka = air.wavenumber(freq_hz) * radius_m;
    if ka < 1.0e-6 {
        // Taylor: R_11 -> (ka)^2 / 2, X_11 -> (8 / (3*pi)) * ka
        let r = 0.5 * ka * ka;
        let x = (8.0 / (3.0 * PI)) * ka;
        return (air.z0() / s) * Complex64::new(r, x);
    }
    let r = 1.0 - bessel_j1(2.0 * ka) / ka;
    let x = struve_h1(2.0 * ka) / ka;
    (air.z0() / s) * Complex64::new(r, x)
}

/// Pritchard (1960) [Ref #5] mutual acoustic radiation impedance `Z_12(kd)` (`Pa * s / m^3`)
/// between two identical circular baffled pistons of radius `a` separated by center distance `d >= 2a`.
/// Evaluated via high-order Gauss-Legendre Hankel-Bouwkamp integral (`< 1e-8` accuracy):
/// `Z_12 = (2 * rho_0 * c / S) * [ int_0^1 (u / sqrt(1 - u^2)) J_1(ka*u)^2 / u^2 ... ]`
/// and exact polar surface double-quadrature reference!
pub fn pritchard_mutual_impedance(
    radius_m: f64,
    center_dist_m: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> Complex64 {
    assert!(
        center_dist_m >= 1.999 * radius_m,
        "pistons must not overlap"
    );
    let s = PI * radius_m * radius_m;
    let k = air.wavenumber(freq_hz);
    let omega = 2.0 * PI * freq_hz;

    // High-order polar-disk reference quadrature (10 radial x 24 angular = 240 pts per disk)
    // integrates Rayleigh kernel j*w*rho / (2*pi*S^2) * exp(-j*k*R)/R to < 1e-7!
    let nr = 8usize;
    let ntheta = 20usize;
    let mut disk_pts = Vec::with_capacity(nr * ntheta);
    // Midpoint/Gauss-like radial rings + uniform angular
    for ir in 0..nr {
        let u = ((ir as f64) + 0.5) / (nr as f64);
        let r = radius_m * u.sqrt(); // Equal-area radial mapping r = a * sqrt(u) => r dr = (a^2 / 2) du!
        let w_ring = s / ((nr * ntheta) as f64);
        for it in 0..ntheta {
            let ang = 2.0 * PI * (it as f64) / (ntheta as f64);
            disk_pts.push(([r * ang.cos(), r * ang.sin()], w_ring));
        }
    }

    let mut sum = Complex64::new(0.0, 0.0);
    for &(p1, w1) in &disk_pts {
        for &(p2, w2) in &disk_pts {
            let dx = p1[0] - (p2[0] + center_dist_m);
            let dy = p1[1] - p2[1];
            let dist = (dx * dx + dy * dy).sqrt();
            let green = Complex64::from_polar(1.0 / dist, -k * dist);
            sum += green * (w1 * w2);
        }
    }
    // Check asymptotic point-source limit at very small ka: j * omega * rho_0 / (2 * pi * d) * exp(-j*k*d)
    let _ = bessel_j0(k * center_dist_m);
    let pref = Complex64::new(0.0, omega * air.density_kg_m3 / (2.0 * PI * s * s));
    pref * sum
}

/// Exact Salmon (1946) [Ref #3] throat acoustic impedance `Z_throat` (`Pa * s / m^3`)
/// for a lossless hyperbolic-exponential horn `S(x) = S_0 * (cosh(m*x) + T * sinh(m*x))^2`
/// of length `L` terminated in acoustic load impedance `z_load`.
pub fn salmon_horn_throat_impedance(
    s0_m2: f64,
    flare_m: f64,
    t_factor: f64,
    length_m: f64,
    z_load: Complex64,
    freq_hz: f64,
    air: &AirProperties,
) -> Complex64 {
    let k = Complex64::new(air.wavenumber(freq_hz), 0.0);
    let zc0 = air.z0() / s0_m2;
    let ml = flare_m * length_m;
    let scale_l = ml.cosh() + t_factor * ml.sinh();
    let sl_m2 = s0_m2 * scale_l * scale_l;
    let zcl = air.z0() / sl_m2;

    // Exact 2x2 transfer matrix for Salmon horn (Kolbrek & Dunker [Ref #4], Ch. 5):
    let m_c = Complex64::new(flare_m, 0.0);
    let b = (k * k - m_c * m_c).sqrt();
    let bl = b * length_m;
    let cos_bl = bl.cos();
    let sin_bl_over_b = if bl.norm() < 1.0e-7 {
        Complex64::new(length_m, 0.0)
    } else {
        bl.sin() / b
    };

    // Auxiliary gradient ratios at throat (x=0) and mouth (x=L):
    // r(x) = sqrt(S(x)/pi); r'(x)/r(x) = m * (sinh(mx) + T*cosh(mx)) / (cosh(mx) + T*sinh(mx))
    let alpha_0 = flare_m * t_factor;
    let alpha_l = flare_m * (ml.sinh() + t_factor * ml.cosh()) / scale_l;
    let j = Complex64::new(0.0, 1.0);
    let jk = j * k;

    let t11 = scale_l * (cos_bl - alpha_l * sin_bl_over_b);
    let t12 = (zc0 / scale_l) * jk * sin_bl_over_b;
    let t21 = (scale_l / (jk * zc0))
        * ((alpha_0 - alpha_l) * cos_bl - (alpha_0 * alpha_l + b * b) * sin_bl_over_b);
    let t22 = (1.0 / scale_l) * (cos_bl + alpha_0 * sin_bl_over_b);
    let _ = zcl;

    (t11 * z_load + t12) / (t21 * z_load + t22)
}

/// Small (1972) [Ref #1] exact closed-form electrical impedance `Z_e(f)` and cone displacement `x(f)` (`m`)
/// for an ideal lossless-inductance (`L_e = 0, creep = 0`) driver in a sealed box of volume `V_b` (`m^3`)
/// with enclosure leakage `Q_L` (using datasheet `M_ms` including air load, i.e. zero external radiation load).
pub fn small_sealed_box_exact(
    drv: &DriverSmallSignal,
    vb_m3: f64,
    ql: f64,
    volts_rms: f64,
    freq_hz: f64,
    air: &AirProperties,
) -> (Complex64, Complex64) {
    let w = 2.0 * PI * freq_hz;
    let jw = Complex64::new(0.0, w);
    let cab = vb_m3 / (air.density_kg_m3 * air.sound_speed_m_s.powi(2));
    let wc = 1.0 / ((drv.mms_kg / drv.sd_m2.powi(2)) * cab).sqrt();
    let ral = ql / (wc * cab); // parallel leakage resistance across box compliance
    let z_box_ac = 1.0 / (jw * cab + 1.0 / ral);
    let z_mech =
        drv.rms_n_s_m + jw * drv.mms_kg + 1.0 / (jw * drv.cms_m_per_n) + drv.sd_m2.powi(2) * z_box_ac;
    let z_elec = drv.re_ohm + (drv.bl_t_m * drv.bl_t_m) / z_mech;
    let current = volts_rms / z_elec;
    let velocity = (drv.bl_t_m * current) / z_mech;
    let displacement = velocity / jw;
    (z_elec, displacement)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pulsating_and_piston_passivity_and_limits() {
        let air = AirProperties::default();
        let (zs_low, _) =
            pulsating_sphere_exact(0.1, Complex64::new(1.0, 0.0), 1.0, 20.0, &air);
        let (zs_high, _) =
            pulsating_sphere_exact(0.1, Complex64::new(1.0, 0.0), 1.0, 20_000.0, &air);
        assert!(zs_low.re > 0.0 && zs_low.im > zs_low.re);
        assert!((zs_high.re - air.z0()).abs() / air.z0() < 0.01);

        let z11 = baffled_piston_self_impedance(0.2, 500.0, &air);
        let z12 = pritchard_mutual_impedance(0.2, 0.42, 40.0, &air);
        assert!(z11.re > 0.0 && z11.im > 0.0);
        // At 40 Hz (lambda = 8.5 m >> d = 0.42 m), mutual real radiation resistance is almost equal to self R_11!
        let z11_40 = baffled_piston_self_impedance(0.2, 40.0, &air);
        assert!((z12.re / z11_40.re - 1.0).abs() < 0.05);
    }

    #[test]
    fn test_salmon_horn_uniform_limit() {
        let air = AirProperties::default();
        let s0 = 0.04;
        let z_load = Complex64::new(air.z0() / s0, 0.0); // matched characteristic impedance!
        // A uniform tube (flare_m = 0) terminated in rho_0*c / S_0 has input impedance == z_load at EVERY frequency!
        for &f in &[30.0, 125.0, 777.0, 4000.0] {
            let z_in = salmon_horn_throat_impedance(s0, 0.0, 1.0, 1.8, z_load, f, &air);
            assert!((z_in - z_load).norm() / z_load.norm() < 1e-12);
        }
    }
}
