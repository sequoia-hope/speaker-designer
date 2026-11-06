//! Core numerical methods for computational electroacoustics:
//! - Acoustic special functions (`J_0, J_1, Y_0, Y_1, H_1`, complex `J_1/J_0`, spherical `h_n^(2)`)
//! - Dense complex LU (`ComplexMatrix`) & real Jacobi SVD (`RealMatrix`)
//! - Regular Dunavant & Duffy singular surface triangle quadratures [Ref #12]
//! - Forward-mode Dual automatic differentiation (`DualVec`, `DualComplex`)
//! - Scaled Trust-Region Levenberg-Marquardt Bayesian MAP optimizer [Ref #30]
//! - Minimum-phase / FFT impulse-response synthesis (`fft_ir`)

pub mod fft_ir;
pub mod linalg;
pub mod optimize;
pub mod quadrature;
pub mod special;

pub use fft_ir::*;
pub use linalg::*;
pub use optimize::*;
pub use quadrature::*;
pub use special::*;

/// Generate `n` logarithmically spaced frequencies from `f_min` to `f_max` (inclusive).
pub fn logspace(f_min: f64, f_max: f64, n: usize) -> Vec<f64> {
    if n <= 1 {
        return vec![f_min];
    }
    let ratio = f_max / f_min;
    (0..n)
        .map(|i| f_min * ratio.powf(i as f64 / (n - 1) as f64))
        .collect()
}
