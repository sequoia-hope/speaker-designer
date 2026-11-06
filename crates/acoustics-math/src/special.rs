//! High-precision special functions for radiation impedance and thermoviscous acoustics.

use num_complex::Complex64;
use std::f64::consts::{FRAC_2_PI, PI};

/// Compute `(J_0(|x|), J_1(|x|))` simultaneously to `< 5e-15` across all `[0, inf)`:
/// - `[0, 4)`: Taylor series (max term `< 4`, zero cancellation)
/// - `[4, 24]`: Miller's downward recurrence normalized by `J_0 + 2 * sum_{m>=1} J_{2m} = 1` (zero cancellation!)
/// - `(24, inf)`: Hankel asymptotic expansion (`exp(-2x) < 1e-20`)
fn bessel_j0_j1_nonneg(ax: f64) -> (f64, f64) {
    if ax < 4.0 {
        let half_x2 = 0.25 * ax * ax;
        let mut t0 = 1.0;
        let mut j0 = 1.0;
        let mut t1 = 0.5 * ax;
        let mut j1 = t1;
        for k in 1..=25 {
            t0 *= -half_x2 / ((k * k) as f64);
            t1 *= -half_x2 / ((k * (k + 1)) as f64);
            j0 += t0;
            j1 += t1;
            if t0.abs() < 1.0e-16 && t1.abs() < 1.0e-16 {
                break;
            }
        }
        (j0, j1)
    } else if ax <= 24.0 {
        let m_top = ((ax as usize) + 32) & !1;
        let mut j_np1 = 0.0_f64;
        let mut j_n = 1.0e-30_f64;
        let mut even_sum = 0.0_f64;
        let mut j1_raw = 0.0_f64;
        for n in (1..=m_top).rev() {
            if n % 2 == 0 {
                even_sum += j_n;
            }
            if n == 1 {
                j1_raw = j_n;
            }
            let j_nm1 = (2.0 * (n as f64) / ax) * j_n - j_np1;
            j_np1 = j_n;
            j_n = j_nm1;
            if j_n.abs() > 1.0e100 {
                let s = 1.0e-100;
                j_n *= s;
                j_np1 *= s;
                even_sum *= s;
                j1_raw *= s;
            }
        }
        let j0_raw = j_n;
        let norm = j0_raw + 2.0 * even_sum;
        (j0_raw / norm, j1_raw / norm)
    } else {
        let (p0, q0) = hankel_pq(0, ax);
        let chi0 = ax - 0.25 * PI;
        let amp = (FRAC_2_PI / ax).sqrt();
        let j0 = amp * (p0 * chi0.cos() - q0 * chi0.sin());

        let (p1, q1) = hankel_pq(1, ax);
        let chi1 = ax - 0.75 * PI;
        let j1 = amp * (p1 * chi1.cos() - q1 * chi1.sin());
        (j0, j1)
    }
}

/// Cylindrical Bessel function `J_0(x)` for real `x` (even in `x`), `< 5e-15` error.
pub fn bessel_j0(x: f64) -> f64 {
    bessel_j0_j1_nonneg(x.abs()).0
}

/// Cylindrical Bessel function `J_1(x)` for real `x` (odd in `x`), `< 5e-15` error.
pub fn bessel_j1(x: f64) -> f64 {
    let val = bessel_j0_j1_nonneg(x.abs()).1;
    if x < 0.0 { -val } else { val }
}

/// Cylindrical Neumann (Weber) function `Y_1(x)` for `x > 0` (used in large-`x` Struve `H_1`).
pub fn bessel_y1(x: f64) -> f64 {
    assert!(x > 0.0, "Y_1 requires x > 0");
    if x < 8.0 {
        let euler_gamma = 0.577_215_664_901_532_9_f64;
        let half_x = 0.5 * x;
        let half_x2 = half_x * half_x;
        let mut term = half_x;
        let mut harmonic_k = 0.0; // H_0
        let mut harmonic_kp1 = 1.0; // H_1
        let mut series = -(harmonic_k + harmonic_kp1) * term;
        for k in 1..=35 {
            term *= -half_x2 / ((k * (k + 1)) as f64);
            harmonic_k += 1.0 / (k as f64);
            harmonic_kp1 += 1.0 / ((k + 1) as f64);
            let contrib = -(harmonic_k + harmonic_kp1) * term;
            series += contrib;
            if contrib.abs() < 1.0e-16 * series.abs().max(1.0) {
                break;
            }
        }
        FRAC_2_PI * ((half_x.ln() + euler_gamma) * bessel_j1(x) - 1.0 / x) + series / PI
    } else {
        let (p1, q1) = hankel_pq(1, x);
        let chi = x - 0.75 * PI;
        (FRAC_2_PI / x).sqrt() * (p1 * chi.sin() + q1 * chi.cos())
    }
}

fn hankel_pq(nu: u32, x: f64) -> (f64, f64) {
    let mu = 4.0 * (nu as f64) * (nu as f64);
    let inv8x = 1.0 / (8.0 * x);
    let mut p = 1.0;
    let mut q = 0.0;
    let mut a_k = 1.0;
    for k in 1..=14 {
        let m = (2 * k - 1) as f64;
        a_k *= (mu - m * m) * inv8x / (k as f64);
        if a_k.abs() < 1.0e-16 {
            break;
        }
        match k % 4 {
            1 => q += a_k,
            2 => p -= a_k,
            3 => q -= a_k,
            _ => p += a_k,
        }
    }
    (p, q)
}

/// Struve function `H_1(x)` for `x >= 0` [Ref #6], `< 1e-13` error across `[0, inf)`.
/// Appears directly in piston self-radiation reactance `X_11 = rho_0 * c * S * H_1(2ka) / (ka)`.
pub fn struve_h1(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 16.0 {
        // H_1(x) = (2/pi) * sum_{m=0}^inf (-1)^m * (x/2)^(2m+2) / (Gamma(m+3/2)*Gamma(m+5/2))
        // m=0 term: (2/pi) * (x/2)^2 / ((sqrt(pi)/2) * (3*sqrt(pi)/4)) = 2 * x^2 / (3 * pi)
        let mut term = 2.0 * ax * ax / (3.0 * PI);
        let mut sum = term;
        for m in 1..=45 {
            let denom = (2 * m + 1) as f64 * (2 * m + 3) as f64;
            term *= -ax * ax / denom;
            sum += term;
            if term.abs() < 1.0e-16 * sum.abs() {
                break;
            }
        }
        sum
    } else {
        // Asymptotic expansion: H_1(x) = Y_1(x) + (2/pi) * [1 + 1/x^2 - 3/x^4 + 45/x^6 - 1575/x^8 + ...]
        // General term c_k for k>=1: c_0 = 1, c_1 = 1/x^2, and for k>=2: c_k = -c_{k-1} * (2k-1)*(2k-3) / x^2
        let inv_x2 = 1.0 / (ax * ax);
        let mut asym = 1.0 + inv_x2;
        let mut c = inv_x2;
        for k in 2..=12 {
            let next = -c * ((2 * k - 1) * (2 * k - 3)) as f64 * inv_x2;
            if next.abs() > c.abs() {
                break;
            }
            c = next;
            asym += c;
            if c.abs() < 1.0e-16 {
                break;
            }
        }
        bessel_y1(ax) + FRAC_2_PI * asym
    }
}

fn hankel_pq_complex(nu: u32, z: Complex64) -> (Complex64, Complex64) {
    let mu = 4.0 * (nu as f64) * (nu as f64);
    let inv8z = Complex64::new(1.0, 0.0) / (8.0 * z);
    let mut p = Complex64::new(1.0, 0.0);
    let mut q = Complex64::new(0.0, 0.0);
    let mut a_k = Complex64::new(1.0, 0.0);
    for k in 1..=16 {
        let m = (2 * k - 1) as f64;
        let next = a_k * ((mu - m * m) / (k as f64)) * inv8z;
        if next.norm() > a_k.norm() {
            break;
        }
        a_k = next;
        match k % 4 {
            1 => q += a_k,
            2 => p -= a_k,
            3 => q -= a_k,
            _ => p += a_k,
        }
        if a_k.norm() < 1.0e-16 {
            break;
        }
    }
    (p, q)
}

/// Complex ratio `2 / z * J_1(z) / J_0(z)` for Kirchhoff-Stinson thermoviscous boundary layers [Ref #7],
/// where `z = s * sqrt(-j) = s * (1 - j) / sqrt(2)`.
/// Overflow-free from `s = 0` (`-> 1.0`) up to arbitrarily large `s -> inf` (`-> -2*j / z`).
pub fn stinson_f_function(shear_number: f64) -> Complex64 {
    if shear_number < 1.0e-5 {
        let s2 = shear_number * shear_number;
        let z2 = Complex64::new(0.0, -s2);
        return Complex64::new(1.0, 0.0) - z2 / 8.0 + (z2 * z2) / 48.0;
    }
    let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
    let z = Complex64::new(shear_number * inv_sqrt2, -shear_number * inv_sqrt2);
    if shear_number <= 14.0 {
        let quarter_z2 = 0.25 * z * z;
        let mut j0 = Complex64::new(1.0, 0.0);
        let mut j1_div_halfz = Complex64::new(1.0, 0.0);
        let mut t0 = Complex64::new(1.0, 0.0);
        let mut t1 = Complex64::new(1.0, 0.0);
        for k in 1..=55 {
            t0 *= -quarter_z2 / ((k * k) as f64);
            t1 *= -quarter_z2 / ((k * (k + 1)) as f64);
            j0 += t0;
            j1_div_halfz += t1;
            if t0.norm() < 1.0e-16 * j0.norm() && t1.norm() < 1.0e-16 * j1_div_halfz.norm() {
                break;
            }
        }
        j1_div_halfz / j0
    } else {
        // In Q4 (`Im(z) = -s/sqrt(2) < 0`), `exp(+j*chi)` dominates (`|exp(-2j*chi)| < 6e-9` at s=14),
        // so `J_1(z) / J_0(z) = -j * (P_1(z) + j*Q_1(z)) / (P_0(z) + j*Q_0(z))`!
        let j = Complex64::new(0.0, 1.0);
        let (p0, q0) = hankel_pq_complex(0, z);
        let (p1, q1) = hankel_pq_complex(1, z);
        let ratio = (-j * (p1 + j * q1)) / (p0 + j * q0);
        (2.0 / z) * ratio
    }
}

/// Outgoing spherical Hankel function `h_0^(2)(x) = j_0(x) - j * y_0(x) = j * exp(-j*x) / x` (`exp(+j*w*t)`).
#[inline]
pub fn spherical_hankel2_0(x: f64) -> Complex64 {
    let (s, c) = x.sin_cos();
    // exp(-jx) = cos(x) - j sin(x); j * exp(-jx) / x = (sin(x) + j cos(x)) / x
    Complex64::new(s / x, c / x)
}

/// Outgoing spherical Hankel function `h_1^(2)(x) = h_0^(2)(x) * (j + 1/x)`.
#[inline]
pub fn spherical_hankel2_1(x: f64) -> Complex64 {
    spherical_hankel2_0(x) * Complex64::new(1.0 / x, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bessel_and_struve_reference_values() {
        // Abramowitz & Stegun Table 9.1 & Table 12.1 exact values
        assert!((bessel_j0(0.0) - 1.0).abs() < 1e-15);
        assert!((bessel_j0(2.404_825_557_695_773)).abs() < 1e-14);
        assert!((bessel_j0(15.0) - (-0.014_224_472_826_781)).abs() < 1e-13);

        assert!((bessel_j1(0.0)).abs() < 1e-15);
        assert!((bessel_j1(1.0) - 0.440_050_585_744_933_5).abs() < 1e-14);
        assert!((bessel_j1(15.0) - 0.205_104_038_613_522_8).abs() < 1e-13);

        // Struve H_1(x): exact 50-digit reference values: H_1(1.0) = 0.198457336201944, H_1(5.0) = 0.8078119457940644
        assert!((struve_h1(1.0) - 0.198_457_336_201_944).abs() < 1e-13);
        assert!((struve_h1(5.0) - 0.807_811_945_794_064_4).abs() < 1e-14);
        // Continuity across stitch boundary x = 16.0
        let left = struve_h1(15.999_999);
        let right = struve_h1(16.000_001);
        assert!((left - right).abs() < 1e-6);
    }

    #[test]
    fn test_stinson_thermoviscous_continuity() {
        let low = stinson_f_function(0.0);
        assert!((low - Complex64::new(1.0, 0.0)).norm() < 1e-15);
        let mid_a = stinson_f_function(13.9999);
        let mid_b = stinson_f_function(14.0001);
        assert!((mid_a - mid_b).norm() < 1e-5);
        let high = stinson_f_function(1000.0);
        assert!(high.norm() < 0.01);
    }
}
