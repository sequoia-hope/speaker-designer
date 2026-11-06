//! Measurement I/O: `.zma` impedance curves, `.frd` acoustic responses, and
//! Farina (2000) [Ref #27] synchronized exponential sine-sweep `.wav` generation & deconvolution.

use acoustics_types::{pa_to_spl_db, AcousticsError, Complex64, P_REF_PA};
use rustfft::FftPlanner;
use std::f64::consts::PI;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct ImpedanceCurvePoint {
    pub freq_hz: f64,
    pub z_ohm: Complex64,
}

#[derive(Clone, Debug)]
pub struct FrdCurvePoint {
    pub freq_hz: f64,
    pub spl_db: f64,
    pub phase_deg: f64,
}

/// Parse standard `.zma` text (`freq_hz   mag_ohm   phase_deg`, ignoring `#` or `*` header lines).
pub fn parse_zma(text: &str) -> Result<Vec<ImpedanceCurvePoint>, AcousticsError> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with('*')
            || trimmed.starts_with(';')
        {
            continue;
        }
        let cols: Vec<&str> = trimmed.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
        if cols.len() >= 2 {
            if let (Ok(f), Ok(mag)) = (cols[0].parse::<f64>(), cols[1].parse::<f64>()) {
                let ph_deg = cols.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                out.push(ImpedanceCurvePoint {
                    freq_hz: f,
                    z_ohm: Complex64::from_polar(mag, ph_deg.to_radians()),
                });
            }
        }
    }
    if out.is_empty() {
        return Err(AcousticsError::Io("no valid data rows in .zma".into()));
    }
    Ok(out)
}

/// Format an impedance curve in standard `.zma` format.
pub fn format_zma(points: &[ImpedanceCurvePoint], comment: &str) -> String {
    let mut s = format!("* {comment}\n* Freq(Hz)\tMag(Ohm)\tPhase(deg)\n");
    for p in points {
        s.push_str(&format!(
            "{:.4}\t{:.5}\t{:.3}\n",
            p.freq_hz,
            p.z_ohm.norm(),
            p.z_ohm.arg().to_degrees()
        ));
    }
    s
}

/// Parse standard `.frd` text (`freq_hz   spl_db   phase_deg`).
pub fn parse_frd(text: &str) -> Result<Vec<FrdCurvePoint>, AcousticsError> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with('*')
            || trimmed.starts_with(';')
        {
            continue;
        }
        let cols: Vec<&str> = trimmed.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
        if cols.len() >= 2 {
            if let (Ok(f), Ok(spl)) = (cols[0].parse::<f64>(), cols[1].parse::<f64>()) {
                let ph_deg = cols.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                out.push(FrdCurvePoint {
                    freq_hz: f,
                    spl_db: spl,
                    phase_deg: ph_deg,
                });
            }
        }
    }
    if out.is_empty() {
        return Err(AcousticsError::Io("no valid data rows in .frd".into()));
    }
    Ok(out)
}

/// Format an acoustic frequency response in standard `.frd` format.
pub fn format_frd(points: &[FrdCurvePoint], comment: &str) -> String {
    let mut s = format!("* {comment}\n* Freq(Hz)\tSPL(dB)\tPhase(deg)\n");
    for p in points {
        s.push_str(&format!("{:.4}\t{:.3}\t{:.3}\n", p.freq_hz, p.spl_db, p.phase_deg));
    }
    s
}

impl FrdCurvePoint {
    pub fn to_pressure_phasor(&self) -> Complex64 {
        let mag_pa = P_REF_PA * 10.0_f64.powf(self.spl_db / 20.0);
        Complex64::from_polar(mag_pa, self.phase_deg.to_radians())
    }

    pub fn from_pressure_phasor(freq_hz: f64, p: Complex64) -> Self {
        Self {
            freq_hz,
            spl_db: pa_to_spl_db(p.norm()),
            phase_deg: p.arg().to_degrees(),
        }
    }
}

/// Compute Novak et al. (2010) [Ref #28] phase-synchronized sweep rate `L` so `w1 * L = 2 * pi * K_int`.
fn synchronized_sweep_rate(f1_hz: f64, f2_hz: f64, duration_s: f64) -> f64 {
    let k_sync = ((f1_hz * duration_s) / (f2_hz / f1_hz).ln())
        .round()
        .max(1.0);
    k_sync / f1_hz
}

/// Generate a synchronized Farina (2000) / Novak (2010) [Ref #27, #28] exponential sine sweep `x(t)`
/// and its amplitude-modulated matched inverse filter `f_inv(t)` (-6 dB/octave decay).
pub fn generate_farina_sweep(
    f1_hz: f64,
    f2_hz: f64,
    duration_s: f64,
    sample_rate_hz: u32,
) -> (Vec<f64>, Vec<f64>) {
    let fs = sample_rate_hz as f64;
    let n = (duration_s * fs).round() as usize;
    let l_rate = synchronized_sweep_rate(f1_hz, f2_hz, duration_s);
    let w1 = 2.0 * PI * f1_hz;

    let mut sweep = Vec::with_capacity(n);
    for i in 0..n {
        let t = (i as f64) / fs;
        // Short 2% fade-in/out Hann edges to avoid click transients
        let u = (i as f64) / (n.max(1) as f64);
        let win = if u < 0.02 {
            0.5 * (1.0 - (PI * u / 0.02).cos())
        } else if u > 0.98 {
            0.5 * (1.0 - (PI * (1.0 - u) / 0.02).cos())
        } else {
            1.0
        };
        let phase = w1 * l_rate * ((t / l_rate).exp() - 1.0);
        sweep.push(win * phase.sin());
    }

    // Matched inverse filter: time-reversed sweep scaled by exponential -6 dB/octave envelope `exp(-t / l_rate)`
    // normalized so `conv(sweep, inv)` has unit impulse peak at sample `n - 1`!
    let mut inv = vec![0.0; n];
    for i in 0..n {
        let t_orig = ((n - 1 - i) as f64) / fs;
        inv[i] = sweep[n - 1 - i] * (-t_orig / l_rate).exp();
    }
    let norm: f64 = (0..n).map(|k| sweep[k] * inv[n - 1 - k]).sum();
    for v in &mut inv {
        *v /= norm.max(1.0e-12);
    }

    (sweep, inv)
}

/// Deconvolve a recorded Farina/Novak sweep `y(t)` with `f_inv(t)` via linear FFT convolution,
/// returning `(linear_ir, hd2_ir, hd3_ir)` separated cleanly at negative time offsets
/// `dt_m = L * ln(m)` and compensated by harmonic inverse-envelope factor `m` [Ref #27, #28]!
pub fn deconvolve_farina_sweep(
    recorded: &[f64],
    inv_filter: &[f64],
    f1_hz: f64,
    f2_hz: f64,
    duration_s: f64,
    sample_rate_hz: u32,
    ir_window_samples: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n_lin = recorded.len() + inv_filter.len();
    let n_fft = n_lin.next_power_of_two();
    let mut a = vec![Complex64::new(0.0, 0.0); n_fft];
    let mut b = vec![Complex64::new(0.0, 0.0); n_fft];
    for (i, &v) in recorded.iter().enumerate() {
        a[i].re = v;
    }
    for (i, &v) in inv_filter.iter().enumerate() {
        b[i].re = v;
    }

    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let ifft = planner.plan_fft_inverse(n_fft);
    fft.process(&mut a);
    fft.process(&mut b);
    for i in 0..n_fft {
        a[i] *= b[i];
    }
    ifft.process(&mut a);
    let inv_n = 1.0 / (n_fft as f64);
    let conv: Vec<f64> = a.iter().map(|z| z.re * inv_n).collect();

    let t0_idx = inv_filter.len() - 1;
    let l_rate = synchronized_sweep_rate(f1_hz, f2_hz, duration_s);
    let fs = sample_rate_hz as f64;
    let dt2 = (l_rate * 2.0_f64.ln() * fs).round() as usize;
    let dt3 = (l_rate * 3.0_f64.ln() * fs).round() as usize;

    let slice_around = |center: usize, half_pre: usize, len: usize, scale: f64| -> Vec<f64> {
        let start = center.saturating_sub(half_pre);
        (0..len)
            .map(|k| scale * conv.get(start + k).copied().unwrap_or(0.0))
            .collect()
    };

    let pre = (ir_window_samples / 4).max(16);
    let h1 = slice_around(t0_idx, pre, ir_window_samples, 1.0);
    // At lag `-dt_m`, the inverse filter envelope `exp(-(t + dt_m)/L)` is attenuated by `1/m`;
    // multiplying by `m` restores exact harmonic transfer-function amplitude [Ref #28]!
    let h2 = slice_around(t0_idx.saturating_sub(dt2), pre, ir_window_samples, 2.0);
    let h3 = slice_around(t0_idx.saturating_sub(dt3), pre, ir_window_samples, 3.0);
    (h1, h2, h3)
}

/// Write a 32-bit float mono `.wav` file using `hound`.
pub fn write_wav_f32(path: &Path, samples: &[f32], sample_rate_hz: u32) -> Result<(), AcousticsError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate_hz,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer =
        hound::WavWriter::create(path, spec).map_err(|e| AcousticsError::Io(e.to_string()))?;
    for &s in samples {
        writer
            .write_sample(s)
            .map_err(|e| AcousticsError::Io(e.to_string()))?;
    }
    writer
        .finalize()
        .map_err(|e| AcousticsError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_farina_exponential_sweep_harmonic_separation_oracle() {
        // Oracle O5.4: Pass sweep through memoryless cubic/quadratic nonlinearity y = x + 0.08*x^2 + 0.04*x^3
        // and verify that deconvolved h1, h2, h3 separate cleanly!
        // Note: For x(t) = sin(w(t)), x^2 = 0.5*(1 - cos(2w)) -> amplitude 0.04 at 2w;
        // x^3 = 0.75*sin(w) - 0.25*sin(3w) -> amplitude 0.01 at 3w!
        let fs = 16_000u32;
        let (sweep, inv) = generate_farina_sweep(40.0, 4000.0, 0.8, fs);
        let distorted: Vec<f64> = sweep
            .iter()
            .map(|&x| x + 0.08 * x * x + 0.04 * x * x * x)
            .collect();

        let (h1, h2, h3) = deconvolve_farina_sweep(&distorted, &inv, 40.0, 4000.0, 0.8, fs, 256);
        let pk1 = h1.iter().map(|v| v.abs()).fold(0.0_f64, f64::max);
        let pk2 = h2.iter().map(|v| v.abs()).fold(0.0_f64, f64::max);
        let pk3 = h3.iter().map(|v| v.abs()).fold(0.0_f64, f64::max);

        assert!(pk1 > 0.85 && pk1 < 1.15, "pk1={pk1}");
        assert!(pk2 > 0.025 && pk2 < 0.060, "pk2={pk2}");
        assert!(pk3 > 0.005 && pk3 < 0.020, "pk3={pk3}");
    }
}
