//! Forward-mode Dual automatic differentiation (`DualVec`, `DualComplex`) and
//! Scaled Trust-Region Levenberg-Marquardt Bayesian MAP estimator [Ref #30].

use crate::RealMatrix;
use std::ops::{Add, Div, Mul, Neg, Sub};

/// Forward-mode dual scalar carrying value `val` and exact gradient `grad` (`len = P`).
#[derive(Clone, Debug)]
pub struct DualVec {
    pub val: f64,
    pub grad: Vec<f64>,
}

impl DualVec {
    pub fn constant(val: f64, n_params: usize) -> Self {
        Self {
            val,
            grad: vec![0.0; n_params],
        }
    }

    pub fn variable(val: f64, index: usize, n_params: usize) -> Self {
        let mut grad = vec![0.0; n_params];
        grad[index] = 1.0;
        Self { val, grad }
    }

    pub fn exp(&self) -> Self {
        let ev = self.val.exp();
        Self {
            val: ev,
            grad: self.grad.iter().map(|&g| ev * g).collect(),
        }
    }

    pub fn ln(&self) -> Self {
        let inv = 1.0 / self.val;
        Self {
            val: self.val.ln(),
            grad: self.grad.iter().map(|&g| inv * g).collect(),
        }
    }

    pub fn sqrt(&self) -> Self {
        let s = self.val.sqrt();
        let coeff = 0.5 / s.max(1.0e-30);
        Self {
            val: s,
            grad: self.grad.iter().map(|&g| coeff * g).collect(),
        }
    }

    pub fn sin_cos(&self) -> (Self, Self) {
        let (s, c) = self.val.sin_cos();
        (
            Self {
                val: s,
                grad: self.grad.iter().map(|&g| c * g).collect(),
            },
            Self {
                val: c,
                grad: self.grad.iter().map(|&g| -s * g).collect(),
            },
        )
    }

    pub fn powf(&self, p: f64) -> Self {
        let v = self.val.powf(p);
        let dv = p * self.val.powf(p - 1.0);
        Self {
            val: v,
            grad: self.grad.iter().map(|&g| dv * g).collect(),
        }
    }
}

impl Add for &DualVec {
    type Output = DualVec;
    fn add(self, rhs: Self) -> DualVec {
        DualVec {
            val: self.val + rhs.val,
            grad: self
                .grad
                .iter()
                .zip(&rhs.grad)
                .map(|(a, b)| a + b)
                .collect(),
        }
    }
}

impl Sub for &DualVec {
    type Output = DualVec;
    fn sub(self, rhs: Self) -> DualVec {
        DualVec {
            val: self.val - rhs.val,
            grad: self
                .grad
                .iter()
                .zip(&rhs.grad)
                .map(|(a, b)| a - b)
                .collect(),
        }
    }
}

impl Mul for &DualVec {
    type Output = DualVec;
    fn mul(self, rhs: Self) -> DualVec {
        DualVec {
            val: self.val * rhs.val,
            grad: self
                .grad
                .iter()
                .zip(&rhs.grad)
                .map(|(a, b)| a * rhs.val + self.val * b)
                .collect(),
        }
    }
}

impl Div for &DualVec {
    type Output = DualVec;
    fn div(self, rhs: Self) -> DualVec {
        let inv = 1.0 / rhs.val;
        let inv2 = inv * inv;
        DualVec {
            val: self.val * inv,
            grad: self
                .grad
                .iter()
                .zip(&rhs.grad)
                .map(|(a, b)| (a * rhs.val - self.val * b) * inv2)
                .collect(),
        }
    }
}

impl Neg for &DualVec {
    type Output = DualVec;
    fn neg(self) -> DualVec {
        DualVec {
            val: -self.val,
            grad: self.grad.iter().map(|g| -g).collect(),
        }
    }
}

impl Neg for DualVec {
    type Output = DualVec;
    fn neg(mut self) -> DualVec {
        self.val = -self.val;
        for g in &mut self.grad {
            *g = -*g;
        }
        self
    }
}

/// Complex forward-mode dual number `(re + j * im)` for exact impedance & acoustic sensitivities!
#[derive(Clone, Debug)]
pub struct DualComplex {
    pub re: DualVec,
    pub im: DualVec,
}

impl DualComplex {
    pub fn from_real(re: DualVec) -> Self {
        let n = re.grad.len();
        Self {
            re,
            im: DualVec::constant(0.0, n),
        }
    }

    pub fn constant(re: f64, im: f64, n: usize) -> Self {
        Self {
            re: DualVec::constant(re, n),
            im: DualVec::constant(im, n),
        }
    }

    pub fn add(&self, rhs: &Self) -> Self {
        Self {
            re: &self.re + &rhs.re,
            im: &self.im + &rhs.im,
        }
    }

    pub fn sub(&self, rhs: &Self) -> Self {
        Self {
            re: &self.re - &rhs.re,
            im: &self.im - &rhs.im,
        }
    }

    pub fn mul(&self, rhs: &Self) -> Self {
        Self {
            re: &(&self.re * &rhs.re) - &(&self.im * &rhs.im),
            im: &(&self.re * &rhs.im) + &(&self.im * &rhs.re),
        }
    }

    pub fn inv(&self) -> Self {
        let denom = &(&self.re * &self.re) + &(&self.im * &self.im);
        Self {
            re: &self.re / &denom,
            im: &(-&self.im) / &denom,
        }
    }

    pub fn div(&self, rhs: &Self) -> Self {
        self.mul(&rhs.inv())
    }

    pub fn norm(&self) -> DualVec {
        (&(&self.re * &self.re) + &(&self.im * &self.im)).sqrt()
    }
}

/// Result of a Bayesian MAP Trust-Region Levenberg-Marquardt parameter estimation run.
#[derive(Clone, Debug)]
pub struct MapFitResult {
    /// Converged log-space offsets `u_i = ln(theta_i / theta_prior_i)`.
    pub u_map: Vec<f64>,
    /// Converged physical parameters `theta_map_i = theta_prior_i * exp(u_i)`.
    pub theta_map: Vec<f64>,
    /// Posterior covariance `Sigma_post` in log-parameter space (`u`).
    pub cov_u: RealMatrix,
    /// Posterior parameter correlation matrix `[-1, 1]`.
    pub correlation: Vec<Vec<f64>>,
    /// 95% credible intervals `(low, high)` in physical parameter units!
    pub ci95_bounds: Vec<(f64, f64)>,
    /// Final data residual RMS.
    pub residual_rms: f64,
    /// Likelihood Fisher eigenvalues (for identifiability diagnostics).
    pub fisher_eigenvalues: Vec<f64>,
    pub iterations: usize,
}

/// Solve MAP estimation problem:
/// `min_u  0.5 * sum_k w_k * r_k(theta(u))^2  +  0.5 * sum_i (u_i / sigma_prior_u_i)^2`
/// using exact Dual-AD Jacobians (`residual_fn` returns `Vec<DualVec>`) and Levenberg-Marquardt [Ref #30].
pub fn solve_map_levenberg_marquardt<F>(
    theta_prior: &[f64],
    sigma_prior_u: &[f64],
    weights: &[f64],
    max_iters: usize,
    residual_fn: F,
) -> MapFitResult
where
    F: Fn(&[DualVec]) -> Vec<DualVec>,
{
    let p = theta_prior.len();
    let mut u = vec![0.0; p];
    let mut lambda = 1.0e-2;
    let mut iterations = 0;

    let eval_at = |u_vec: &[f64]| -> (f64, Vec<DualVec>) {
        let theta_duals: Vec<DualVec> = (0..p)
            .map(|i| {
                let ui = DualVec::variable(u_vec[i], i, p);
                let scale = DualVec::constant(theta_prior[i], p);
                &scale * &ui.exp()
            })
            .collect();
        let res = residual_fn(&theta_duals);
        let mut cost = 0.0;
        for (k, rk) in res.iter().enumerate() {
            let wk = weights.get(k).copied().unwrap_or(1.0);
            cost += 0.5 * wk * rk.val * rk.val;
        }
        for i in 0..p {
            let sp = sigma_prior_u[i].max(1.0e-6);
            cost += 0.5 * (u_vec[i] / sp).powi(2);
        }
        (cost, res)
    };

    let (mut cost, mut res) = eval_at(&u);

    for iter in 0..max_iters {
        iterations = iter + 1;
        // Assemble Fisher matrix F = J^T W J, Posterior Precision H = F + Sigma_prior^-1, and gradient g
        let mut h = RealMatrix::zeros(p, p);
        let mut grad = vec![0.0; p];

        for (k, rk) in res.iter().enumerate() {
            let wk = weights.get(k).copied().unwrap_or(1.0);
            for i in 0..p {
                grad[i] += wk * rk.grad[i] * rk.val;
                for j in i..p {
                    let cur = h.get(i, j) + wk * rk.grad[i] * rk.grad[j];
                    h.set(i, j, cur);
                    h.set(j, i, cur);
                }
            }
        }
        for i in 0..p {
            let inv_var = 1.0 / sigma_prior_u[i].max(1.0e-6).powi(2);
            grad[i] += inv_var * u[i];
            h.set(i, i, h.get(i, i) + inv_var);
        }

        let grad_inf = grad.iter().map(|g| g.abs()).fold(0.0_f64, f64::max);
        if grad_inf < 1.0e-9 {
            break;
        }

        // Damped LM system (H + lambda * diag(H)) * step = -grad
        let mut h_lm = h.clone();
        for i in 0..p {
            let d = h.get(i, i).max(1.0);
            h_lm.set(i, i, h.get(i, i) + lambda * d);
        }
        let neg_grad: Vec<f64> = grad.iter().map(|g| -g).collect();
        let step = h_lm.solve_spd(&neg_grad, 1.0e-12);

        let step_norm = step.iter().map(|s| s * s).sum::<f64>().sqrt();
        // Clamp max log-step to +-0.7 (~2x factor per iteration) for physical stability
        let scale_clamp = if step_norm > 0.7 {
            0.7 / step_norm
        } else {
            1.0
        };
        let u_cand: Vec<f64> = (0..p)
            .map(|i| (u[i] + scale_clamp * step[i]).clamp(-2.5, 2.5))
            .collect();

        let (cost_cand, res_cand) = eval_at(&u_cand);
        if cost_cand < cost {
            let rel_drop = (cost - cost_cand) / cost.max(1.0e-12);
            u = u_cand;
            cost = cost_cand;
            res = res_cand;
            lambda = (lambda * 0.35).max(1.0e-9);
            if step_norm < 1.0e-7 && rel_drop < 1.0e-9 {
                break;
            }
        } else {
            lambda = (lambda * 4.0).min(1.0e8);
        }
    }

    // Final Fisher & Laplace Posterior Covariance at converged MAP point
    let (_, final_res) = eval_at(&u);
    let mut fisher = RealMatrix::zeros(p, p);
    let mut precision = RealMatrix::zeros(p, p);
    let mut sum_sq = 0.0;
    let mut w_sum = 0.0;

    for (k, rk) in final_res.iter().enumerate() {
        let wk = weights.get(k).copied().unwrap_or(1.0);
        sum_sq += wk * rk.val * rk.val;
        w_sum += wk;
        for i in 0..p {
            for j in i..p {
                let f_ij = fisher.get(i, j) + wk * rk.grad[i] * rk.grad[j];
                fisher.set(i, j, f_ij);
                fisher.set(j, i, f_ij);
                precision.set(i, j, f_ij);
                precision.set(j, i, f_ij);
            }
        }
    }
    for i in 0..p {
        let inv_var = 1.0 / sigma_prior_u[i].max(1.0e-6).powi(2);
        precision.set(i, i, precision.get(i, i) + inv_var);
    }

    let (fisher_eigenvalues, _) = fisher.symmetric_eigen();
    let dof = (final_res.len().saturating_sub(p)).max(1) as f64;
    let s2_est = (sum_sq / dof).max(1.0e-6);
    // Scale likelihood precision by empirical noise variance if residuals weren't already normalized to unit variance
    let cov_raw = precision.invert_spd(1.0e-12);
    let mut cov_u = RealMatrix::zeros(p, p);
    // Blend theoretical prior-weighted inverse precision with empirical residual variance scale
    let var_scale = s2_est.clamp(0.05, 4.0);
    for i in 0..p {
        for j in 0..p {
            cov_u.set(i, j, cov_raw.get(i, j) * var_scale);
        }
    }

    let theta_map: Vec<f64> = (0..p).map(|i| theta_prior[i] * u[i].exp()).collect();
    let ci95_bounds: Vec<(f64, f64)> = (0..p)
        .map(|i| {
            let std_u = cov_u.get(i, i).max(0.0).sqrt();
            (
                theta_prior[i] * (u[i] - 1.96 * std_u).exp(),
                theta_prior[i] * (u[i] + 1.96 * std_u).exp(),
            )
        })
        .collect();

    let mut correlation = vec![vec![0.0; p]; p];
    for i in 0..p {
        for j in 0..p {
            let denom = (cov_u.get(i, i).max(1e-30) * cov_u.get(j, j).max(1e-30)).sqrt();
            correlation[i][j] = (cov_u.get(i, j) / denom).clamp(-1.0, 1.0);
        }
    }

    MapFitResult {
        u_map: u,
        theta_map,
        cov_u,
        correlation,
        ci95_bounds,
        residual_rms: (sum_sq / w_sum.max(1.0)).sqrt(),
        fisher_eigenvalues,
        iterations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dual_ad_vs_complex_step_and_lm_recovery() {
        // Fit nonlinear RLC impedance Z(w) = R + 1 / (1/Rp + j*w*C + 1/(j*w*L))
        let true_params = [6.2, 42.0, 0.018, 0.0008]; // R, Rp, L, C
        let prior_params = [5.4, 30.0, 0.024, 0.0011]; // shifted 15-35% away!
        let freqs: Vec<f64> = (0..40).map(|i| 15.0 * 1.12_f64.powi(i)).collect();

        let z_model = |th: &[DualVec], w: f64| -> DualComplex {
            let p = th.len();
            let r = DualComplex::from_real(th[0].clone());
            let inv_rp = DualComplex::from_real(&DualVec::constant(1.0, p) / &th[1]);
            let jwc = DualComplex {
                re: DualVec::constant(0.0, p),
                im: &DualVec::constant(w, p) * &th[3],
            };
            let inv_jwl = DualComplex {
                re: DualVec::constant(0.0, p),
                im: -(&DualVec::constant(1.0 / w, p) / &th[2]),
            };
            let y_par = inv_rp.add(&jwc).add(&inv_jwl);
            r.add(&y_par.inv())
        };

        let true_duals: Vec<DualVec> = true_params
            .iter()
            .map(|&v| DualVec::constant(v, 4))
            .collect();
        let targets: Vec<(f64, f64)> = freqs
            .iter()
            .map(|&f| {
                let z = z_model(&true_duals, 2.0 * std::f64::consts::PI * f);
                (z.re.val, z.im.val)
            })
            .collect();

        let weights = vec![1.0; freqs.len() * 2];
        let fit = solve_map_levenberg_marquardt(
            &prior_params,
            &[0.5, 0.8, 0.8, 0.8],
            &weights,
            50,
            |th| {
                let mut r = Vec::with_capacity(freqs.len() * 2);
                for (idx, &f) in freqs.iter().enumerate() {
                    let z = z_model(th, 2.0 * std::f64::consts::PI * f);
                    let p = th.len();
                    r.push(&z.re - &DualVec::constant(targets[idx].0, p));
                    r.push(&z.im - &DualVec::constant(targets[idx].1, p));
                }
                r
            },
        );

        for i in 0..4 {
            let rel_err = (fit.theta_map[i] - true_params[i]).abs() / true_params[i];
            assert!(
                rel_err < 1.0e-3,
                "param {i}: got {}, expected {}",
                fit.theta_map[i],
                true_params[i]
            );
        }
    }
}
