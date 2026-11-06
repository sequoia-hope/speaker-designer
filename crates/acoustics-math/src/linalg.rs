//! Dense complex LU with partial pivoting (`ComplexMatrix`) and real Jacobi SVD (`RealMatrix`).
//! Zero external BLAS/Fortran dependencies; 100% deterministic & `wasm32-unknown-unknown` clean.

use num_complex::Complex64;

/// Contiguous row-major complex dense matrix (`rows x cols`).
#[derive(Clone, Debug)]
pub struct ComplexMatrix {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<Complex64>,
}

impl ComplexMatrix {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            data: vec![Complex64::new(0.0, 0.0); rows * cols],
        }
    }

    pub fn identity(n: usize) -> Self {
        let mut m = Self::zeros(n, n);
        for i in 0..n {
            m.set(i, i, Complex64::new(1.0, 0.0));
        }
        m
    }

    #[inline]
    pub fn get(&self, r: usize, c: usize) -> Complex64 {
        self.data[r * self.cols + c]
    }

    #[inline]
    pub fn set(&mut self, r: usize, c: usize, val: Complex64) {
        self.data[r * self.cols + c] = val;
    }

    #[inline]
    pub fn add_assign(&mut self, r: usize, c: usize, delta: Complex64) {
        self.data[r * self.cols + c] += delta;
    }

    /// Frobenius norm `||A||_F`.
    pub fn frobenius_norm(&self) -> f64 {
        self.data.iter().map(|z| z.norm_sqr()).sum::<f64>().sqrt()
    }

    /// Factor `P * A = L * U` in place and return `ComplexLu` for single or multi-RHS solves.
    pub fn lu_factor(mut self) -> Result<ComplexLu, f64> {
        assert_eq!(self.rows, self.cols, "LU requires square matrix");
        let n = self.rows;
        let mut perm: Vec<usize> = (0..n).collect();
        let norm_a = self.one_norm();
        if norm_a == 0.0 {
            return Err(0.0);
        }

        let mut min_diag = f64::INFINITY;
        let mut max_diag = 0.0_f64;

        for k in 0..n {
            // Partial pivoting down column k
            let mut piv_row = k;
            let mut piv_abs = self.get(k, k).norm();
            for i in (k + 1)..n {
                let v = self.get(i, k).norm();
                if v > piv_abs {
                    piv_abs = v;
                    piv_row = i;
                }
            }
            if piv_abs <= 1.0e-30 * norm_a {
                return Err(piv_abs / norm_a);
            }
            if piv_row != k {
                perm.swap(k, piv_row);
                for j in 0..n {
                    let a = k * n + j;
                    let b = piv_row * n + j;
                    self.data.swap(a, b);
                }
            }

            let pivot = self.get(k, k);
            let p_norm = pivot.norm();
            min_diag = min_diag.min(p_norm);
            max_diag = max_diag.max(p_norm);
            let inv_pivot = Complex64::new(1.0, 0.0) / pivot;

            for i in (k + 1)..n {
                let mult = self.data[i * n + k] * inv_pivot;
                self.data[i * n + k] = mult;
                if mult.norm_sqr() > 0.0 {
                    let row_i = i * n;
                    let row_k = k * n;
                    for j in (k + 1)..n {
                        let ukj = self.data[row_k + j];
                        self.data[row_i + j] -= mult * ukj;
                    }
                }
            }
        }

        let rcond_est = if max_diag > 0.0 {
            min_diag / max_diag
        } else {
            0.0
        };
        Ok(ComplexLu {
            n,
            lu: self.data,
            perm,
            rcond_est,
        })
    }

    pub fn one_norm(&self) -> f64 {
        let mut max_col = 0.0_f64;
        for j in 0..self.cols {
            let s: f64 = (0..self.rows).map(|i| self.get(i, j).norm()).sum();
            max_col = max_col.max(s);
        }
        max_col
    }
}

pub struct ComplexLu {
    pub n: usize,
    lu: Vec<Complex64>,
    perm: Vec<usize>,
    pub rcond_est: f64,
}

impl ComplexLu {
    /// Solve `A * x = b` for a single right-hand side `b`.
    pub fn solve(&self, b: &[Complex64]) -> Vec<Complex64> {
        assert_eq!(b.len(), self.n);
        let n = self.n;
        let mut x: Vec<Complex64> = (0..n).map(|i| b[self.perm[i]]).collect();

        // Forward substitution L * y = P * b
        for i in 0..n {
            let mut sum = x[i];
            let row = i * n;
            for j in 0..i {
                sum -= self.lu[row + j] * x[j];
            }
            x[i] = sum;
        }
        // Backward substitution U * x = y
        for i in (0..n).rev() {
            let mut sum = x[i];
            let row = i * n;
            for j in (i + 1)..n {
                sum -= self.lu[row + j] * x[j];
            }
            x[i] = sum / self.lu[row + i];
        }
        x
    }

    /// Solve `A * X = B` for multiple right-hand columns (extracts Multi-Port 3D BEM `Z_3D` in one shot!).
    pub fn solve_columns(&self, cols: &[Vec<Complex64>]) -> Vec<Vec<Complex64>> {
        cols.iter().map(|c| self.solve(c)).collect()
    }
}

/// Real dense matrix (`rows x cols`) supporting normal equations & Hestenes-Jacobi SVD.
#[derive(Clone, Debug)]
pub struct RealMatrix {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f64>,
}

impl RealMatrix {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            data: vec![0.0; rows * cols],
        }
    }

    #[inline]
    pub fn get(&self, r: usize, c: usize) -> f64 {
        self.data[r * self.cols + c]
    }

    #[inline]
    pub fn set(&mut self, r: usize, c: usize, v: f64) {
        self.data[r * self.cols + c] = v;
    }

    /// Symmetric eigenvalue / SVD solver for symmetric positive semi-definite `S` (`n x n`)
    /// via cyclic Jacobi rotations (`S = V * diag(eigenvalues) * V^T`), sorted descending.
    pub fn symmetric_eigen(&self) -> (Vec<f64>, RealMatrix) {
        assert_eq!(self.rows, self.cols);
        let n = self.rows;
        let mut a = self.clone();
        let mut v = Self::zeros(n, n);
        for i in 0..n {
            v.set(i, i, 1.0);
        }

        for _sweep in 0..60 {
            let mut off_norm = 0.0;
            for p in 0..n {
                for q in (p + 1)..n {
                    let apq = a.get(p, q);
                    off_norm += apq * apq;
                }
            }
            if off_norm.sqrt() < 1.0e-15 {
                break;
            }
            for p in 0..n {
                for q in (p + 1)..n {
                    let apq = a.get(p, q);
                    if apq.abs() < 1.0e-18 {
                        continue;
                    }
                    let app = a.get(p, p);
                    let aqq = a.get(q, q);
                    let tau = (aqq - app) / (2.0 * apq);
                    let t = if tau >= 0.0 {
                        1.0 / (tau + (1.0 + tau * tau).sqrt())
                    } else {
                        -1.0 / (-tau + (1.0 + tau * tau).sqrt())
                    };
                    let c = 1.0 / (1.0 + t * t).sqrt();
                    let s = t * c;

                    a.set(p, p, app - t * apq);
                    a.set(q, q, aqq + t * apq);
                    a.set(p, q, 0.0);
                    a.set(q, p, 0.0);

                    for r in 0..n {
                        if r != p && r != q {
                            let arp = a.get(r, p);
                            let arq = a.get(r, q);
                            a.set(r, p, c * arp - s * arq);
                            a.set(p, r, c * arp - s * arq);
                            a.set(r, q, s * arp + c * arq);
                            a.set(q, r, s * arp + c * arq);
                        }
                        let vrp = v.get(r, p);
                        let vrq = v.get(r, q);
                        v.set(r, p, c * vrp - s * vrq);
                        v.set(r, q, s * vrp + c * vrq);
                    }
                }
            }
        }

        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&i, &j| a.get(j, j).total_cmp(&a.get(i, i)));
        let eigs: Vec<f64> = order.iter().map(|&i| a.get(i, i)).collect();
        let mut v_sorted = Self::zeros(n, n);
        for (new_col, &old_col) in order.iter().enumerate() {
            for r in 0..n {
                v_sorted.set(r, new_col, v.get(r, old_col));
            }
        }
        (eigs, v_sorted)
    }

    /// Solve symmetric positive-definite linear system `H * x = g` via spectral decomposition
    /// with safety floor `reg_floor` (guarantees stability even on rank-deficient parameter subspaces!).
    pub fn solve_spd(&self, rhs: &[f64], reg_floor: f64) -> Vec<f64> {
        let (eigs, v) = self.symmetric_eigen();
        let n = self.rows;
        let mut x = vec![0.0; n];
        for k in 0..n {
            let mut v_t_rhs = 0.0;
            for i in 0..n {
                v_t_rhs += v.get(i, k) * rhs[i];
            }
            let lam = eigs[k].max(reg_floor);
            let coeff = v_t_rhs / lam;
            for i in 0..n {
                x[i] += v.get(i, k) * coeff;
            }
        }
        x
    }

    /// Invert symmetric positive-definite matrix `H` (e.g. Posterior Precision -> Covariance `Sigma_post`).
    pub fn invert_spd(&self, reg_floor: f64) -> RealMatrix {
        let (eigs, v) = self.symmetric_eigen();
        let n = self.rows;
        let mut inv = Self::zeros(n, n);
        for k in 0..n {
            let inv_lam = 1.0 / eigs[k].max(reg_floor);
            for i in 0..n {
                for j in 0..n {
                    let cur = inv.get(i, j);
                    inv.set(i, j, cur + v.get(i, k) * v.get(j, k) * inv_lam);
                }
            }
        }
        inv
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_complex_lu_solve() {
        let mut a = ComplexMatrix::zeros(3, 3);
        a.set(0, 0, Complex64::new(2.0, 1.0));
        a.set(0, 1, Complex64::new(-1.0, 0.5));
        a.set(0, 2, Complex64::new(0.3, -0.2));
        a.set(1, 0, Complex64::new(0.5, -1.2));
        a.set(1, 1, Complex64::new(4.0, 2.0));
        a.set(1, 2, Complex64::new(-0.7, 0.4));
        a.set(2, 0, Complex64::new(-0.2, 0.8));
        a.set(2, 1, Complex64::new(1.1, -0.3));
        a.set(2, 2, Complex64::new(3.5, -1.5));

        let x_true = vec![
            Complex64::new(1.5, -0.5),
            Complex64::new(-2.0, 1.25),
            Complex64::new(0.75, 2.5),
        ];
        let mut b = vec![Complex64::new(0.0, 0.0); 3];
        for i in 0..3 {
            for j in 0..3 {
                b[i] += a.get(i, j) * x_true[j];
            }
        }
        let lu = a.lu_factor().unwrap();
        let x = lu.solve(&b);
        for i in 0..3 {
            assert!((x[i] - x_true[i]).norm() < 1e-14);
        }
    }

    #[test]
    fn test_real_spd_invert() {
        let mut h = RealMatrix::zeros(2, 2);
        h.set(0, 0, 4.0);
        h.set(0, 1, 1.0);
        h.set(1, 0, 1.0);
        h.set(1, 1, 3.0);
        let inv = h.invert_spd(1e-12);
        assert!((inv.get(0, 0) - 3.0 / 11.0).abs() < 1e-14);
        assert!((inv.get(0, 1) - (-1.0 / 11.0)).abs() < 1e-14);
        assert!((inv.get(1, 1) - 4.0 / 11.0).abs() < 1e-14);
    }
}
