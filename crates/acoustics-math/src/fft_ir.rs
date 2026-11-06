//! FFT / IFFT impulse response synthesis from log-spaced complex frequency transfer functions.

use num_complex::Complex64;
use rustfft::FftPlanner;
use std::f64::consts::PI;

/// Synthesize a causal discrete-time FIR impulse response (`n_taps` at `sample_rate_hz`)
/// by log-linear complex magnitude + unwrapped-phase interpolation of `H(f_k)` (`exp(+j*w*t)`).
/// Used to generate listening-position virtual-mic IRs for browser WebAudio auralization!
pub fn transfer_function_to_fir(
    freqs_hz: &[f64],
    h_complex: &[Complex64],
    sample_rate_hz: u32,
    n_taps: usize,
) -> Vec<f32> {
    assert_eq!(freqs_hz.len(), h_complex.len());
    let n_fft = n_taps.next_power_of_two().max(512);
    let fs = sample_rate_hz as f64;
    let df = fs / (n_fft as f64);

    // Unwrap phase across input frequencies so linear interpolation preserves delay!
    let mags: Vec<f64> = h_complex.iter().map(|z| z.norm()).collect();
    let mut phases: Vec<f64> = h_complex.iter().map(|z| z.arg()).collect();
    for i in 1..phases.len() {
        let mut diff = phases[i] - phases[i - 1];
        while diff > PI {
            diff -= 2.0 * PI;
        }
        while diff < -PI {
            diff += 2.0 * PI;
        }
        phases[i] = phases[i - 1] + diff;
    }

    let mut spectrum = vec![Complex64::new(0.0, 0.0); n_fft];
    let half = n_fft / 2;

    for bin in 1..half {
        let f = (bin as f64) * df;
        let (mag, ph) = interp_mag_phase(freqs_hz, &mags, &phases, f);
        // Gentle high-cut rolloff near Nyquist for clean transient causality
        let nyq_taper = if f > 0.42 * fs {
            let u = ((f - 0.42 * fs) / (0.08 * fs)).clamp(0.0, 1.0);
            0.5 * (1.0 + (PI * u).cos())
        } else {
            1.0
        };
        let z = Complex64::from_polar(mag * nyq_taper, ph);
        spectrum[bin] = z;
        spectrum[n_fft - bin] = z.conj();
    }

    let mut planner = FftPlanner::<f64>::new();
    // Under exp(+j*w*t), inverse transform uses exp(+j*2*pi*k*n/N) -> rustfft `plan_fft_inverse`!
    let ifft = planner.plan_fft_inverse(n_fft);
    ifft.process(&mut spectrum);

    // Apply small pre-delay circular shift (2 ms) + Hann tail window so peak isn't clipped at t=0
    let pre_samples = ((0.002 * fs) as usize).min(n_taps / 8);
    let inv_n = 1.0 / (n_fft as f64);
    let mut taps = vec![0.0_f32; n_taps];
    let mut peak = 0.0_f32;

    for i in 0..n_taps {
        let src_idx = (i + n_fft - pre_samples) % n_fft;
        let tail_w = if i > (n_taps * 3) / 4 {
            let u = (i - (n_taps * 3) / 4) as f64 / ((n_taps / 4).max(1) as f64);
            0.5 * (1.0 + (PI * u).cos())
        } else {
            1.0
        };
        let v = (spectrum[src_idx].re * inv_n * tail_w) as f32;
        taps[i] = v;
        peak = peak.max(v.abs());
    }

    // Normalize relative to 2.0 Pa peak ceiling while preserving relative mic-to-mic level differences!
    // If extremely hot (e.g. 135 dB SPL in Pascal units ~ 112 Pa), scale by fixed calibration constant 1/150.0.
    let fixed_scale = if peak > 150.0 { 1.0 / peak } else { 1.0 / 150.0 };
    if peak > 0.0 && peak * fixed_scale < 0.02 {
        // Small-signal 2.83V run: normalize peak cleanly to 0.75 while keeping headroom
        let norm = 0.75 / peak;
        for v in &mut taps {
            *v *= norm;
        }
    } else {
        for v in &mut taps {
            *v *= fixed_scale;
        }
    }
    taps
}

fn interp_mag_phase(freqs: &[f64], mags: &[f64], phases: &[f64], f: f64) -> (f64, f64) {
    if freqs.is_empty() {
        return (0.0, 0.0);
    }
    if f <= freqs[0] {
        // High-pass roll-off below f_min (2nd-order acoustic slope)
        let ratio = (f / freqs[0]).max(0.0);
        return (mags[0] * ratio * ratio, phases[0] * ratio);
    }
    let last = freqs.len() - 1;
    if f >= freqs[last] {
        let ratio = freqs[last] / f;
        return (mags[last] * ratio, phases[last] * (f / freqs[last]));
    }
    let idx = match freqs.binary_search_by(|probe| probe.total_cmp(&f)) {
        Ok(i) => return (mags[i], phases[i]),
        Err(i) => i - 1,
    };
    let f0 = freqs[idx];
    let f1 = freqs[idx + 1];
    let t = (f.ln() - f0.ln()) / (f1.ln() - f0.ln()).max(1.0e-12);
    let mag = mags[idx] * (1.0 - t) + mags[idx + 1] * t;
    let ph = phases[idx] * (1.0 - t) + phases[idx + 1] * t;
    (mag, ph)
}
