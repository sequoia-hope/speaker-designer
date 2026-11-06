//! Command-line driver for Speaker Designer (`speaker-cli`).
//!
//! Instantiates speaker & multi-speaker sound-system designs from declarative `.toml` specs,
//! executes multi-tier 3D electro-mechano-acoustic / BEM / nonlinear / spatial simulations,
//! runs measurement-based Bayesian MAP calibration, and updates `simulations/manifest.json`
//! for the local Three.js + Acoustic Workbench viewer.

use acoustics_calibration::{calibrate_vented_prototype, VentedCalibrationPrior};
use acoustics_io::{generate_farina_sweep, parse_frd, parse_zma, write_wav_f32};
use acoustics_types::{
    AirProperties, SimulationManifest, SimulationManifestEntry, SystemDesignSpec, WayEnclosure,
};
use clap::{Parser, Subcommand};
use rayon::prelude::*;
use speaker_engine::{builtin_designs, run_system_simulation};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(
    name = "speaker-cli",
    about = "3D Computational Loudspeaker & Multi-Speaker Sound-System Simulator"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List all built-in speaker & outdoor/studio sound-system presets.
    ListPresets,

    /// Export all built-in designs as editable declarative `.toml` files in `designs/`.
    ExportPresets {
        #[arg(long, default_value = "designs")]
        dir: PathBuf,
    },

    /// Simulate a single `.toml` design file and update `simulations/manifest.json`.
    Simulate {
        /// Path to `.toml` design file.
        design: PathBuf,
        #[arg(long, default_value = "simulations")]
        out_dir: PathBuf,
    },

    /// Export (if missing) and simulate all `.toml` designs in `designs/` in parallel.
    SimulateAll {
        #[arg(long, default_value = "designs")]
        designs_dir: PathBuf,
        #[arg(long, default_value = "simulations")]
        out_dir: PathBuf,
    },

    /// Calibrate a vented speaker design `.toml` against measured `.zma` and `.frd` files.
    Calibrate {
        #[arg(long)]
        design: PathBuf,
        #[arg(long)]
        inbox_zma: PathBuf,
        #[arg(long)]
        frd: PathBuf,
        #[arg(long)]
        free_zma: Option<PathBuf>,
        #[arg(long, default_value_t = 2.83)]
        volts_rms: f64,
        #[arg(long, default_value_t = 2.0)]
        mic_dist_m: f64,
        #[arg(long)]
        out_report_json: Option<PathBuf>,
    },

    /// Generate a synchronized Farina exponential sine sweep `.wav` (+ inverse filter) for real speaker measurements.
    GenerateSweep {
        #[arg(long, default_value_t = 20.0)]
        f1_hz: f64,
        #[arg(long, default_value_t = 20_000.0)]
        f2_hz: f64,
        #[arg(long, default_value_t = 5.0)]
        duration_s: f64,
        #[arg(long, default_value_t = 48_000)]
        sample_rate: u32,
        #[arg(long, default_value = "measurement_sweep.wav")]
        out_wav: PathBuf,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::ListPresets => {
            for d in builtin_designs() {
                println!("{:<36} [{}] {}", d.id, d.category, d.title);
            }
        }
        Commands::ExportPresets { dir } => {
            fs::create_dir_all(&dir)?;
            for d in builtin_designs() {
                let p = dir.join(format!("{}.toml", d.id));
                let txt = toml::to_string_pretty(&d)?;
                fs::write(&p, txt)?;
                println!("wrote {}", p.display());
            }
        }
        Commands::Simulate { design, out_dir } => {
            let txt = fs::read_to_string(&design)?;
            let spec: SystemDesignSpec = toml::from_str(&txt)?;
            println!("Simulating `{}` ({}) ...", spec.id, spec.title);
            let bundle = run_system_simulation(&spec)?;
            write_bundle_and_refresh_manifest(&bundle, &out_dir)?;
            println!(
                "Done -> {}/{}/bundle.json ({} variants)",
                out_dir.display(),
                bundle.id,
                bundle.variants.len()
            );
        }
        Commands::SimulateAll {
            designs_dir,
            out_dir,
        } => {
            fs::create_dir_all(&designs_dir)?;
            for d in builtin_designs() {
                let p = designs_dir.join(format!("{}.toml", d.id));
                if !p.exists() {
                    fs::write(&p, toml::to_string_pretty(&d)?)?;
                }
            }

            let mut paths: Vec<PathBuf> = fs::read_dir(&designs_dir)?
                .filter_map(|e| e.ok().map(|x| x.path()))
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("toml"))
                .collect();
            paths.sort();

            println!("Running {} multi-tier 3D simulations in parallel...", paths.len());
            let specs: Vec<SystemDesignSpec> = paths
                .iter()
                .map(|p| {
                    let t = fs::read_to_string(p)?;
                    Ok(toml::from_str(&t)?)
                })
                .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;

            let bundles: Vec<_> = specs
                .par_iter()
                .map(|spec| {
                    let b = run_system_simulation(spec)
                        .unwrap_or_else(|e| panic!("simulation failed on {}: {e}", spec.id));
                    println!(
                        "  ✓ {} — {} variants, sweet-spot {:.1} dB SPL",
                        b.id,
                        b.variants.len(),
                        b.variants[0]
                            .zone_metrics
                            .first()
                            .map(|z| z.bass_mean_spl_db)
                            .unwrap_or(0.0)
                    );
                    b
                })
                .collect();

            fs::create_dir_all(&out_dir)?;
            for b in &bundles {
                let b_dir = out_dir.join(&b.id);
                fs::create_dir_all(&b_dir)?;
                fs::write(b_dir.join("bundle.json"), serde_json::to_string(b)?)?;
            }
            rebuild_manifest(&out_dir)?;
            println!(
                "All {} simulation bundles written to `{}/` + `manifest.json`.",
                bundles.len(),
                out_dir.display()
            );
        }
        Commands::Calibrate {
            design,
            inbox_zma,
            frd,
            free_zma,
            volts_rms,
            mic_dist_m,
            out_report_json,
        } => {
            let spec: SystemDesignSpec = toml::from_str(&fs::read_to_string(&design)?)?;
            let drv = &spec.drivers[0];
            let cab = &spec.cabinets[0];
            let (vb, port, ql) = match &cab.ways[0].enclosure {
                WayEnclosure::Vented {
                    volume_m3,
                    leakage_ql,
                    port,
                    ..
                } => (*volume_m3, port.clone(), *leakage_ql),
                _ => {
                    return Err("`calibrate` CLI currently expects a `vented` primary way".into());
                }
            };

            let inbox_pts = parse_zma(&fs::read_to_string(&inbox_zma)?)?;
            let frd_pts = parse_frd(&fs::read_to_string(&frd)?)?;
            let free_pts = match free_zma {
                Some(p) => Some(parse_zma(&fs::read_to_string(p)?)?),
                None => None,
            };

            let air = AirProperties::from_environment(spec.environment);
            let prior = VentedCalibrationPrior {
                driver: drv.small_signal.clone(),
                box_volume_m3: vb,
                port,
                leakage_ql: ql,
                meas_volts_rms: volts_rms,
                mic_distance_m: mic_dist_m,
            };
            let report = calibrate_vented_prototype(
                &prior,
                free_pts.as_deref(),
                &inbox_pts,
                &frd_pts,
                None,
                &air,
            );
            println!("=== Bayesian MAP Calibration Complete ===");
            for d in &report.diagnostics {
                println!("  • {d}");
            }
            println!(
                "{:<28} {:>12} {:>12} {:>24}",
                "Parameter", "Prior", "Posterior", "95% Credible Interval"
            );
            for p in &report.parameters {
                println!(
                    "{:<28} {:>10.3} {:<2} {:>10.3} {:<2} [{:>8.3}, {:>8.3}]",
                    p.name, p.prior_value, p.unit, p.posterior_value, p.unit, p.ci95_low, p.ci95_high
                );
            }
            if let Some(out_p) = out_report_json {
                fs::write(&out_p, serde_json::to_string_pretty(&report)?)?;
                println!("Saved JSON report to {}", out_p.display());
            }
        }
        Commands::GenerateSweep {
            f1_hz,
            f2_hz,
            duration_s,
            sample_rate,
            out_wav,
        } => {
            let (sweep, inv) = generate_farina_sweep(f1_hz, f2_hz, duration_s, sample_rate);
            let sweep_f32: Vec<f32> = sweep.iter().map(|&x| (0.9 * x) as f32).collect();
            let inv_f32: Vec<f32> = inv.iter().map(|&x| x as f32).collect();
            write_wav_f32(&out_wav, &sweep_f32, sample_rate)?;
            let inv_path = out_wav.with_extension("inverse.wav");
            write_wav_f32(&inv_path, &inv_f32, sample_rate)?;
            println!(
                "Generated Farina sweep `{}` and inverse filter `{}`",
                out_wav.display(),
                inv_path.display()
            );
        }
    }
    Ok(())
}

fn write_bundle_and_refresh_manifest(
    bundle: &acoustics_types::SimulationBundle,
    out_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let b_dir = out_dir.join(&bundle.id);
    fs::create_dir_all(&b_dir)?;
    fs::write(b_dir.join("bundle.json"), serde_json::to_string(bundle)?)?;
    rebuild_manifest(out_dir)?;
    Ok(())
}

fn rebuild_manifest(out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut entries = Vec::new();
    let mut subdirs: Vec<PathBuf> = fs::read_dir(out_dir)?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| p.is_dir() && p.join("bundle.json").exists())
        .collect();
    subdirs.sort();

    for dir in subdirs {
        let raw = fs::read_to_string(dir.join("bundle.json"))?;
        let b: acoustics_types::SimulationBundle = serde_json::from_str(&raw)?;
        entries.push(SimulationManifestEntry {
            id: b.id.clone(),
            title: b.title.clone(),
            category: b.category.clone(),
            subtitle: b
                .variants
                .first()
                .map(|v| v.summary.clone())
                .unwrap_or_default(),
            bundle_path: format!("simulations/{}/bundle.json", b.id),
            variant_count: b.variants.len(),
            has_calibration: b.calibration.is_some(),
        });
    }

    let manifest = SimulationManifest {
        generated_at: "2026-11-05".into(),
        simulations: entries,
    };
    fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}
