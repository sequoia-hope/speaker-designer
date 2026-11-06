//! Active Loudspeaker Management (LMS) DSP transfer functions (`exp(+j*w*t)`)
//! and automated cardioid / end-fire / electronic-arc array calculators [Ref #32].

use acoustics_types::{BiquadStage, Complex64, CrossoverFilter, DspChannelSpec};
use std::f64::consts::{FRAC_1_SQRT_2, PI};

/// Evaluate the exact complex voltage transfer function `H_DSP(omega)` (`exp(+j*w*t)`)
/// of a `DspChannelSpec` at `freq_hz`.
pub fn eval_dsp_channel(spec: &DspChannelSpec, freq_hz: f64) -> Complex64 {
    let w = 2.0 * PI * freq_hz.max(0.1);
    let gain = 10.0_f64.powf(spec.gain_db / 20.0) * if spec.invert_polarity { -1.0 } else { 1.0 };
    let delay_phasor = Complex64::from_polar(1.0, -w * spec.delay_s);
    let mut h = Complex64::new(gain, 0.0) * delay_phasor;

    if let Some(hp) = &spec.highpass {
        h *= eval_crossover(hp, freq_hz, true);
    }
    if let Some(lp) = &spec.lowpass {
        h *= eval_crossover(lp, freq_hz, false);
    }
    for stage in &spec.stages {
        h *= eval_biquad_analog(stage, freq_hz);
    }
    h
}

fn eval_crossover(filter: &CrossoverFilter, freq_hz: f64, is_highpass: bool) -> Complex64 {
    match *filter {
        CrossoverFilter::Butterworth { order, freq_hz: fc } => {
            eval_butterworth(order.max(1), fc, freq_hz, is_highpass)
        }
        CrossoverFilter::LinkwitzRiley { order, freq_hz: fc } => {
            // Linkwitz-Riley of order 2*N is the cascade of two identical Butterworth filters of order N!
            // Note: odd N (e.g. LR12 = 2*BW1, LR36 = 2*BW3) has a natural 180-deg phase flip between LP & HP;
            // LR24 (2*BW2) and LR48 (2*BW4) sum in-phase with exact all-pass unity magnitude!
            let half = (order / 2).max(1);
            let bw = eval_butterworth(half, fc, freq_hz, is_highpass);
            bw * bw
        }
        CrossoverFilter::Bessel { order, freq_hz: fc } => {
            eval_bessel(order.clamp(2, 4), fc, freq_hz, is_highpass)
        }
    }
}

fn eval_butterworth(order: u8, fc_hz: f64, freq_hz: f64, is_highpass: bool) -> Complex64 {
    // Normalized Laplace variable s_n = j * (f / f_c) for LP, or (f_c / (j * f)) for HP!
    let ratio = freq_hz / fc_hz.max(1.0e-3);
    let s = if is_highpass {
        Complex64::new(0.0, -1.0 / ratio.max(1.0e-9))
    } else {
        Complex64::new(0.0, ratio)
    };

    let n = order as usize;
    let mut denom = Complex64::new(1.0, 0.0);
    for k in 1..=(n / 2) {
        let angle = PI * ((2 * k + n - 1) as f64) / ((2 * n) as f64);
        let two_cos = -2.0 * angle.cos(); // positive damping coefficient
        denom *= s * s + two_cos * s + Complex64::new(1.0, 0.0);
    }
    if n % 2 == 1 {
        denom *= s + Complex64::new(1.0, 0.0);
    }
    Complex64::new(1.0, 0.0) / denom
}

fn eval_bessel(order: u8, fc_hz: f64, freq_hz: f64, is_highpass: bool) -> Complex64 {
    // -3 dB frequency-normalized Bessel polynomials
    let ratio = freq_hz / fc_hz.max(1.0e-3);
    let s = if is_highpass {
        Complex64::new(0.0, -1.0 / ratio.max(1.0e-9))
    } else {
        Complex64::new(0.0, ratio)
    };
    match order {
        2 => {
            let sn = s * 1.361_654_128_7;
            Complex64::new(3.0, 0.0) / (sn * sn + 3.0 * sn + 3.0)
        }
        3 => {
            let sn = s * 1.755_672_368_7;
            Complex64::new(15.0, 0.0) / (sn.powi(3) + 6.0 * sn * sn + 15.0 * sn + 15.0)
        }
        _ => {
            let sn = s * 2.113_917_674_9;
            Complex64::new(105.0, 0.0)
                / (sn.powi(4) + 10.0 * sn.powi(3) + 45.0 * sn * sn + 105.0 * sn + 105.0)
        }
    }
}

fn eval_biquad_analog(stage: &BiquadStage, freq_hz: f64) -> Complex64 {
    match *stage {
        BiquadStage::Peaking {
            freq_hz: f0,
            gain_db,
            q,
        } => {
            let s = Complex64::new(0.0, freq_hz / f0.max(1e-3));
            let a = 10.0_f64.powf(gain_db / 40.0);
            let q_safe = q.max(0.05);
            (s * s + (a / q_safe) * s + 1.0) / (s * s + (1.0 / (a * q_safe)) * s + 1.0)
        }
        BiquadStage::LowShelf {
            freq_hz: f0,
            gain_db,
            q,
        } => {
            let s = Complex64::new(0.0, freq_hz / f0.max(1e-3));
            let a = 10.0_f64.powf(gain_db / 40.0);
            let q_safe = q.max(0.1).min(10.0);
            let root_a = a.sqrt();
            a * (s * s + (root_a / q_safe) * s + a)
                / (a * s * s + (root_a / q_safe) * s + 1.0)
        }
        BiquadStage::HighShelf {
            freq_hz: f0,
            gain_db,
            q,
        } => {
            let s = Complex64::new(0.0, freq_hz / f0.max(1e-3));
            let a = 10.0_f64.powf(gain_db / 40.0);
            let q_safe = q.max(0.1).min(10.0);
            let root_a = a.sqrt();
            a * (a * s * s + (root_a / q_safe) * s + 1.0)
                / (s * s + (root_a / q_safe) * s + a)
        }
        BiquadStage::AllPass2 { freq_hz: f0, q } => {
            let s = Complex64::new(0.0, freq_hz / f0.max(1e-3));
            let q_safe = q.max(0.05);
            (s * s - (1.0 / q_safe) * s + 1.0) / (s * s + (1.0 / q_safe) * s + 1.0)
        }
        BiquadStage::LinkwitzTransform {
            f0_hz,
            q0,
            fp_hz,
            qp,
        } => {
            // Exact H_target(s) / H_box(s): unity (0 dB) passband gain for f >> f0,
            // boosting low frequencies by (f0 / fp)^2 to shift sealed pole (f0, q0) -> (fp, qp).
            let f0_safe = f0_hz.max(1e-3);
            let fp_safe = fp_hz.max(1e-3);
            let s0 = Complex64::new(0.0, freq_hz / f0_safe);
            let sp = Complex64::new(0.0, freq_hz / fp_safe);
            let dc_boost = (f0_safe / fp_safe).powi(2);
            let _ = FRAC_1_SQRT_2;
            dc_boost * (s0 * s0 + (1.0 / q0.max(0.05)) * s0 + 1.0)
                / (sp * sp + (1.0 / qp.max(0.05)) * sp + 1.0)
        }
    }
}

/// Compute parabolic electronic-arc steering delay `delay_s` for horizontal subwoofer at coordinate `x_m`
/// inside an array of total span `span_m` targeting horizontal splay angle `coverage_deg` [Ref #32].
pub fn electronic_arc_delay_s(x_m: f64, span_m: f64, coverage_deg: f64, sound_speed: f64) -> f64 {
    if span_m <= 0.05 || coverage_deg <= 1.0 {
        return 0.0;
    }
    let half_angle = 0.5 * coverage_deg.clamp(10.0, 140.0).to_radians();
    // Virtual circular arc radius R = (span / 2) / sin(half_angle)
    let radius = (0.5 * span_m) / half_angle.sin();
    let sagitta = (radius * radius - x_m * x_m).max(0.0).sqrt();
    // Outer elements delayed relative to center element so wavefront curves convexly outward!
    (radius - sagitta) / sound_speed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linkwitz_riley_lr24_and_lr48_allpass_unity_sum() {
        // Oracle O4.1: Complementary LR24 and LR48 low-pass + high-pass sum to flat 0.000 dB!
        for &order in &[4u8, 8u8] {
            let lp = DspChannelSpec {
                id: "lp".into(),
                label: "LP".into(),
                gain_db: 0.0,
                invert_polarity: false,
                delay_s: 0.0,
                highpass: None,
                lowpass: Some(CrossoverFilter::LinkwitzRiley {
                    order,
                    freq_hz: 320.0,
                }),
                stages: vec![],
            };
            let hp = DspChannelSpec {
                id: "hp".into(),
                label: "HP".into(),
                gain_db: 0.0,
                invert_polarity: false,
                delay_s: 0.0,
                highpass: Some(CrossoverFilter::LinkwitzRiley {
                    order,
                    freq_hz: 320.0,
                }),
                lowpass: None,
                stages: vec![],
            };
            for &f in &[20.0, 80.0, 320.0, 1000.0, 12_000.0] {
                let sum = eval_dsp_channel(&lp, f) + eval_dsp_channel(&hp, f);
                assert!(
                    (sum.norm() - 1.0).abs() < 1.0e-13,
                    "LR{} sum mag={} at {f} Hz",
                    order * 6,
                    sum.norm()
                );
            }
        }
    }
}
