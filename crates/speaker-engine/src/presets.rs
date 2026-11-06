//! Built-in engineered loudspeaker & outdoor/studio sound-system presets.

use acoustics_calibration::{
    calibrate_vented_prototype, eval_free_air_dual_impedance, eval_vented_dual_model,
    VentedCalibrationPrior,
};
use acoustics_dsp::electronic_arc_delay_s;
use acoustics_io::{FrdCurvePoint, ImpedanceCurvePoint};
use acoustics_math::{logspace, DualVec};
use acoustics_types::*;

/// Return all 10 flagship speaker & sound-system designs.
pub fn builtin_designs() -> Vec<SystemDesignSpec> {
    vec![
        design_01_studio_monitor_aether_83m(),
        design_02_studio_monitor_cardioid_sbir(),
        design_03_subwoofer_coupling_1x_2x_4x(),
        design_04_outdoor_edm_oasis_360(),
        design_05_outdoor_edm_fieldthrow_range(),
        design_06_prototype_bayesian_calibration(),
        design_07_tapped_horn_keystone_18(),
        design_08_studio_sub_linkwitz_dual12(),
        design_09_mastering_tower_chronos_mtm(),
        design_10_festival_endfire_vs_csa(),
    ]
}

// ============================================================================
// Shared Engineered Transducer & Cabinet Building Blocks
// ============================================================================

fn studio_drivers() -> Vec<DriverSpec> {
    vec![
        DriverSpec {
            id: "alu_wf_85".into(),
            name: "8.5\" Anodized Alu-Cone Studio Woofer".into(),
            category: "studio-lf".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.6,
                inductance: InductanceModel::L2R2 {
                    le_h: 0.65e-3,
                    l2_h: 0.45e-3,
                    r2_ohm: 9.5,
                },
                bl_t_m: 11.6,
                mms_kg: 0.039,
                cms_m_per_n: 0.000_64,
                creep_lambda: 0.018,
                rms_n_s_m: 1.45,
                sd_m2: 0.0240,
                xmax_m: 0.0095,
                xmech_m: 0.015,
                pe_max_w: 250.0,
            },
            nonlinear: DriverNonlinear {
                bl_poly: [0.015, -0.21, -0.01, -0.04],
                kms_poly: [-0.02, 0.28, 0.02, 0.18],
                le_x_poly: [-0.08, 0.03],
                le_current_factor: 0.004,
            },
            thermal: DriverThermal::default(),
        },
        DriverSpec {
            id: "neo_mid_40".into(),
            name: "4.0\" Shorting-Ring Neodymium Midrange".into(),
            category: "studio-mf".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.8,
                inductance: InductanceModel::L2R2 {
                    le_h: 0.16e-3,
                    l2_h: 0.12e-3,
                    r2_ohm: 11.0,
                },
                bl_t_m: 6.1,
                mms_kg: 0.0046,
                cms_m_per_n: 0.000_72,
                creep_lambda: 0.012,
                rms_n_s_m: 0.55,
                sd_m2: 0.0055,
                xmax_m: 0.0040,
                xmech_m: 0.007,
                pe_max_w: 100.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        },
        DriverSpec {
            id: "be_dome_10".into(),
            name: "1.0\" Beryllium Dome Tweeter".into(),
            category: "studio-hf".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.4,
                inductance: InductanceModel::Simple { le_h: 0.035e-3 },
                bl_t_m: 3.3,
                mms_kg: 0.000_36,
                cms_m_per_n: 0.000_135,
                creep_lambda: 0.0,
                rms_n_s_m: 0.32,
                sd_m2: 0.000_62,
                xmax_m: 0.0012,
                xmech_m: 0.0022,
                pe_max_w: 60.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        },
    ]
}

fn pa_drivers() -> Vec<DriverSpec> {
    vec![
        DriverSpec {
            id: "horn_sub_18".into(),
            name: "18\" Neodymium High-BL Horn Subwoofer (4.5\" VC)".into(),
            category: "pa-sub".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.1,
                inductance: InductanceModel::L2R2 {
                    le_h: 1.45e-3,
                    l2_h: 0.95e-3,
                    r2_ohm: 15.0,
                },
                bl_t_m: 29.8,
                mms_kg: 0.225,
                cms_m_per_n: 0.000_096,
                creep_lambda: 0.022,
                rms_n_s_m: 6.8,
                sd_m2: 0.122,
                xmax_m: 0.0145,
                xmech_m: 0.024,
                pe_max_w: 1800.0,
            },
            nonlinear: DriverNonlinear {
                bl_poly: [0.025, -0.25, -0.02, -0.05],
                kms_poly: [-0.035, 0.34, 0.02, 0.24],
                le_x_poly: [-0.15, 0.04],
                le_current_factor: 0.007,
            },
            thermal: DriverThermal {
                alpha_temp_per_k: 0.00393,
                r_th_vc_pole_k_w: 0.19,
                c_th_vc_j_k: 42.0,
                r_th_pole_mag_k_w: 0.30,
                c_th_pole_j_k: 520.0,
                r_th_mag_amb_k_w: 0.65,
                c_th_mag_j_k: 2800.0,
                forced_cooling_coeff: 0.95,
                max_vc_temp_k: 523.15,
            },
        },
        DriverSpec {
            id: "kick_15".into(),
            name: "15\" Mid-Bass Punch Horn Woofer".into(),
            category: "pa-kick".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.4,
                inductance: InductanceModel::L2R2 {
                    le_h: 0.95e-3,
                    l2_h: 0.65e-3,
                    r2_ohm: 14.0,
                },
                bl_t_m: 23.5,
                mms_kg: 0.105,
                cms_m_per_n: 0.000_14,
                creep_lambda: 0.015,
                rms_n_s_m: 3.9,
                sd_m2: 0.085,
                xmax_m: 0.0095,
                xmech_m: 0.016,
                pe_max_w: 900.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        },
        DriverSpec {
            id: "mid_8".into(),
            name: "8\" High-Efficiency Phase-Plug Midrange".into(),
            category: "pa-mid".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 5.8,
                inductance: InductanceModel::L2R2 {
                    le_h: 0.35e-3,
                    l2_h: 0.25e-3,
                    r2_ohm: 13.0,
                },
                bl_t_m: 14.2,
                mms_kg: 0.019,
                cms_m_per_n: 0.000_21,
                creep_lambda: 0.01,
                rms_n_s_m: 1.6,
                sd_m2: 0.022,
                xmax_m: 0.0045,
                xmech_m: 0.008,
                pe_max_w: 350.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        },
        DriverSpec {
            id: "comp_hf_14".into(),
            name: "1.4\" Exit Titanium/PEEK Compression Driver (3\" VC)".into(),
            category: "pa-hf".into(),
            small_signal: DriverSmallSignal {
                re_ohm: 6.2,
                inductance: InductanceModel::Simple { le_h: 0.08e-3 },
                bl_t_m: 11.8,
                mms_kg: 0.0021,
                cms_m_per_n: 0.000_045,
                creep_lambda: 0.0,
                rms_n_s_m: 0.95,
                sd_m2: 0.0044,
                xmax_m: 0.0010,
                xmech_m: 0.0018,
                pe_max_w: 140.0,
            },
            nonlinear: DriverNonlinear::default(),
            thermal: DriverThermal::default(),
        },
    ]
}

fn cabinet_terra_horn_18() -> SpeakerCabinetSpec {
    SpeakerCabinetSpec {
        id: "terra_horn_18".into(),
        name: "TerraHorn-18 Folded Bass Horn".into(),
        subtitle: "60×90×90 cm · 18 mm 13-Ply Birch + 24 mm Baffle · 2.25 m Salmon-Exp Path".into(),
        dims_m: [0.60, 0.90, 0.90],
        edge_round_m: 0.018,
        visual_fold_count: 3,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::baltic_birch_ply(),
            baffle_material: PanelMaterialSpec {
                name: "24 mm Laminated 17-Ply Marine Baltic Birch".into(),
                ..PanelMaterialSpec::baltic_birch_ply()
            },
            wall_thickness_m: 0.018,
            front_baffle_thickness_m: 0.024,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 3,
            driver_rebate_depth_m: 0.008,
            damping_lining_thickness_m: 0.030,
            joinery: JoineryKind::InterlockingCncTab,
        },
        ways: vec![CabinetWaySpec {
            way_id: "sub_horn".into(),
            label: "18\" Folded Horn".into(),
            driver_id: "horn_sub_18".into(),
            driver_count: 1,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.45),
            enclosure: WayEnclosure::FoldedHorn {
                rear_volume_m3: 0.054,
                throat_chamber_m3: 0.0075,
                leakage_ql: 22.0,
                segments: vec![
                    HornSegmentSpec {
                        length_m: 0.90,
                        throat_area_m2: 0.042,
                        mouth_area_m2: 0.145,
                        contour: HornContour::Salmon { t_factor: 0.58 },
                        aspect_ratio: 1.25,
                    },
                    HornSegmentSpec {
                        length_m: 1.35,
                        throat_area_m2: 0.145,
                        mouth_area_m2: 0.490,
                        contour: HornContour::Exponential,
                        aspect_ratio: 1.10,
                    },
                ],
                rear_damping: PorousMaterial {
                    flow_resistivity_pa_s_m2: 9_000.0,
                    porosity: 0.97,
                    tortuosity: 1.04,
                    fill_fraction: 0.30,
                },
            },
        }],
    }
}

fn cabinet_synergy_3p_top() -> SpeakerCabinetSpec {
    SpeakerCabinetSpec {
        id: "synergy_3p".into(),
        name: "Synergy-3P Tri-Amped Point-Source Horn Top".into(),
        subtitle: "15 mm Touring Birch · 15\" Kick + 8\" Mid + 1.4\" CNC Alu 60°×40° OS-SE".into(),
        dims_m: [0.54, 0.56, 0.88],
        edge_round_m: 0.025,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec {
                name: "11-Ply Lightweight Touring Baltic Birch".into(),
                ..PanelMaterialSpec::baltic_birch_ply()
            },
            baffle_material: PanelMaterialSpec::baltic_birch_ply(),
            wall_thickness_m: 0.015,
            front_baffle_thickness_m: 0.021,
            internal_partition_thickness_m: 0.015,
            brace_thickness_m: 0.015,
            brace_count: 2,
            driver_rebate_depth_m: 0.006,
            damping_lining_thickness_m: 0.022,
            joinery: JoineryKind::InterlockingCncTab,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "kick".into(),
                label: "15\" Kick Horn".into(),
                driver_id: "kick_15".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.27),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.042,
                    throat_chamber_m3: 0.003,
                    waveguide: HornSegmentSpec {
                        length_m: 0.34,
                        throat_area_m2: 0.045,
                        mouth_area_m2: 0.19,
                        contour: HornContour::Conical,
                        aspect_ratio: 1.1,
                    },
                },
            },
            CabinetWaySpec {
                way_id: "mid".into(),
                label: "8\" Mid Horn".into(),
                driver_id: "mid_8".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.58),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.006,
                    throat_chamber_m3: 0.0005,
                    waveguide: HornSegmentSpec {
                        length_m: 0.22,
                        throat_area_m2: 0.009,
                        mouth_area_m2: 0.075,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 65.0,
                            coverage_v_deg: 45.0,
                        },
                        aspect_ratio: 1.3,
                    },
                },
            },
            CabinetWaySpec {
                way_id: "hf".into(),
                label: "1.4\" OS-SE HF".into(),
                driver_id: "comp_hf_14".into(),
                driver_count: 1,
                dsp_channel_index: 2,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.76),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.0004,
                    throat_chamber_m3: 0.00004,
                    waveguide: HornSegmentSpec {
                        length_m: 0.16,
                        throat_area_m2: 0.001_54,
                        mouth_area_m2: 0.036,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 60.0,
                            coverage_v_deg: 40.0,
                        },
                        aspect_ratio: 1.4,
                    },
                },
            },
        ],
    }
}

fn synergy_top_dsp_channels(prefix: &str, base_delay_s: f64, gain_trim_db: f64) -> Vec<DspChannelSpec> {
    vec![
        DspChannelSpec {
            id: format!("{prefix}_kick"),
            label: format!("{prefix} Kick (85–280 Hz)"),
            gain_db: gain_trim_db + 1.5,
            invert_polarity: false,
            delay_s: base_delay_s,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 85.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 280.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: format!("{prefix}_mid"),
            label: format!("{prefix} Mid (280–1800 Hz)"),
            gain_db: gain_trim_db - 2.0,
            invert_polarity: false,
            delay_s: base_delay_s + 0.000_35,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 280.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 1800.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: format!("{prefix}_hf"),
            label: format!("{prefix} HF (1.8–20 kHz)"),
            gain_db: gain_trim_db - 8.5,
            invert_polarity: false,
            delay_s: base_delay_s + 0.000_55,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 1800.0,
            }),
            lowpass: None,
            stages: vec![BiquadStage::HighShelf {
                freq_hz: 9500.0,
                gain_db: 3.5,
                q: 0.707,
            }],
        },
    ]
}

// ============================================================================
// Design 01: Aether-83M 3-Way Studio Monitor vs Classic 2-Way
// ============================================================================

fn design_01_studio_monitor_aether_83m() -> SystemDesignSpec {
    let aether_3way = SpeakerCabinetSpec {
        id: "aether_83m".into(),
        name: "Aether-83M 3-Way OS-SE Studio Monitor".into(),
        subtitle: "22 mm HDF-760 Shell + 28 mm CNC 6061-T6 Alu Baffle · 8.5\" LF + 4\" MF + 1\" Be".into(),
        dims_m: [0.27, 0.34, 0.50],
        edge_round_m: 0.028,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::high_density_mdf(),
            baffle_material: PanelMaterialSpec::aluminum_6061_t6(),
            wall_thickness_m: 0.022,
            front_baffle_thickness_m: 0.028,
            internal_partition_thickness_m: 0.016,
            brace_thickness_m: 0.018,
            brace_count: 2,
            driver_rebate_depth_m: 0.006,
            damping_lining_thickness_m: 0.028,
            joinery: JoineryKind::Miter45,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "lf".into(),
                label: "8.5\" Vented Woofer".into(),
                driver_id: "alu_wf_85".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.165),
                enclosure: WayEnclosure::Vented {
                    volume_m3: 0.029,
                    leakage_ql: 12.0,
                    port: PortSpec {
                        area_m2: 0.0038,
                        length_m: 0.285,
                        flare_radius_m: 0.022,
                        local_exit_offset: Point3::new(0.0, 0.0, 0.04),
                        local_normal: Vec3::Y,
                    },
                    damping: PorousMaterial {
                        flow_resistivity_pa_s_m2: 11_000.0,
                        porosity: 0.97,
                        tortuosity: 1.04,
                        fill_fraction: 0.35,
                    },
                },
            },
            CabinetWaySpec {
                way_id: "mf".into(),
                label: "4.0\" Sealed Mid".into(),
                driver_id: "neo_mid_40".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.318),
                enclosure: WayEnclosure::Sealed {
                    volume_m3: 0.0018,
                    leakage_ql: 24.0,
                    damping: PorousMaterial {
                        flow_resistivity_pa_s_m2: 14_000.0,
                        porosity: 0.97,
                        tortuosity: 1.04,
                        fill_fraction: 0.65,
                    },
                },
            },
            CabinetWaySpec {
                way_id: "hf".into(),
                label: "1.0\" OS-SE Waveguide".into(),
                driver_id: "be_dome_10".into(),
                driver_count: 1,
                dsp_channel_index: 2,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.432),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.000_25,
                    throat_chamber_m3: 0.000_015,
                    waveguide: HornSegmentSpec {
                        length_m: 0.036,
                        throat_area_m2: 0.000_65,
                        mouth_area_m2: 0.0172,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 90.0,
                            coverage_v_deg: 70.0,
                        },
                        aspect_ratio: 1.15,
                    },
                },
            },
        ],
    };

    let classic_2way = SpeakerCabinetSpec {
        id: "classic_2way_85".into(),
        name: "Classic Flat-Baffle 2-Way 8.5\" Monitor".into(),
        subtitle: "16 mm Unbraced MDF · 8.5\" Woofer + Unwaveguided Flat-Baffle 1\" Dome".into(),
        dims_m: [0.27, 0.32, 0.46],
        edge_round_m: 0.002,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec {
                name: "Standard Medium-Density Fiberboard (MDF-680)".into(),
                density_kg_m3: 680.0,
                youngs_modulus_gpa: 3.1,
                loss_factor_eta: 0.028,
                ..PanelMaterialSpec::high_density_mdf()
            },
            baffle_material: PanelMaterialSpec::high_density_mdf(),
            wall_thickness_m: 0.016,
            front_baffle_thickness_m: 0.019,
            internal_partition_thickness_m: 0.015,
            brace_thickness_m: 0.015,
            brace_count: 0,
            driver_rebate_depth_m: 0.004,
            damping_lining_thickness_m: 0.018,
            joinery: JoineryKind::RabbetDado,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "lf".into(),
                label: "8.5\" Woofer (to 2.1 kHz)".into(),
                driver_id: "alu_wf_85".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.17),
                enclosure: WayEnclosure::Vented {
                    volume_m3: 0.029,
                    leakage_ql: 11.0,
                    port: PortSpec {
                        area_m2: 0.0034,
                        length_m: 0.26,
                        flare_radius_m: 0.004,
                        local_exit_offset: Point3::new(0.0, 0.0, 0.04),
                        local_normal: Vec3::Y,
                    },
                    damping: PorousMaterial::default(),
                },
            },
            CabinetWaySpec {
                way_id: "hf_flat".into(),
                label: "1.0\" Flat-Baffle Dome".into(),
                driver_id: "be_dome_10".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.37),
                enclosure: WayEnclosure::Sealed {
                    volume_m3: 0.000_25,
                    leakage_ql: 25.0,
                    damping: PorousMaterial::default(),
                },
            },
        ],
    };

    SystemDesignSpec {
        id: "01-studio-monitor-aether-83m".into(),
        title: "Aether-83M — 3-Way Constant-Directivity Studio Monitor".into(),
        category: "Studio Monitors".into(),
        description: "Reference tri-amped 3-way studio monitor fusing an 8.5\" flared-slot woofer (31 Hz f-3), dedicated 4\" sealed midrange, and 1\" Beryllium dome in a 3D BEM-solved 90°×70° OS-SE waveguide — compared directly against a conventional flat-baffle 2-way.".into(),
        design_notes: vec![
            "Constant-Directivity Crossover Match: Crossing the 4\" midrange (ka = 2.4) at 2.6 kHz into a 148 mm OS-SE waveguide eliminates the classic 2-way off-axis Sound-Power flare at 2–4 kHz, yielding a smooth, monotonic CTA-2034 Directivity Index (+4 dB -> +8.5 dB).".into(),
            "Vocal Band Integrity: Covering 320 Hz – 2.6 kHz on a single 4\" shorting-ring cone removes all crossover phase shift and vertical lobing from the critical midrange band.".into(),
            "Active Baffle-Step & Subsonic Protection: +4.2 dB low-shelf EQ compensates the 4pi -> 2pi 27 cm cabinet baffle transition while a 26 Hz BW4 high-pass protects excursion below the 33 Hz flared-port null.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 20.0,
            freq_max_hz: 20_000.0,
            num_freqs: 96,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 15.0,
            enable_3d_bem: true,
            field_bounds_m: [-3.0, 3.0, -0.8, 4.4],
            field_grid_nx: 46,
            field_grid_ny: 46,
            listener_height_m: 0.34,
            reference_mic_m: [0.0, 2.0, 0.34],
        },
        drivers: studio_drivers(),
        cabinets: vec![aether_3way, classic_2way],
        zones: vec![ListenerZone {
            id: "mix_sweet".into(),
            label: "Mixing Engineer Sweet Spot (1.8–2.4 m)".into(),
            role: "sweet_spot".into(),
            x_min_m: -0.45,
            x_max_m: 0.45,
            y_min_m: 1.75,
            y_max_m: 2.35,
            z_ear_m: 0.34,
        }],
        variants: vec![
            SceneVariantSpec {
                variant_id: "aether_3way".into(),
                label: "Proposed: Aether-83M (3-Way + OS-SE Waveguide)".into(),
                summary: "Smooth CTA-2034 Spinorama, controlled 90°×70° dispersion, low port Mach velocity.".into(),
                boundary: BoundaryEnvironment::Free4Pi,
                dsp_channels: vec![
                    DspChannelSpec {
                        id: "lf".into(),
                        label: "LF Woofer (26–320 Hz)".into(),
                        gain_db: 3.8,
                        invert_polarity: false,
                        delay_s: 0.0,
                        highpass: Some(CrossoverFilter::Butterworth {
                            order: 4,
                            freq_hz: 26.0,
                        }),
                        lowpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 320.0,
                        }),
                        stages: vec![BiquadStage::LowShelf {
                            freq_hz: 190.0,
                            gain_db: 3.2,
                            q: 0.707,
                        }],
                    },
                    DspChannelSpec {
                        id: "mf".into(),
                        label: "MF Midrange (320–2600 Hz)".into(),
                        gain_db: 0.0,
                        invert_polarity: false,
                        delay_s: 0.000_08,
                        highpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 320.0,
                        }),
                        lowpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 2600.0,
                        }),
                        stages: vec![],
                    },
                    DspChannelSpec {
                        id: "hf".into(),
                        label: "HF OS-SE Waveguide (>2.6 kHz)".into(),
                        gain_db: -5.8,
                        invert_polarity: false,
                        delay_s: 0.000_18,
                        highpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 2600.0,
                        }),
                        lowpass: None,
                        stages: vec![BiquadStage::HighShelf {
                            freq_hz: 8500.0,
                            gain_db: 2.2,
                            q: 0.707,
                        }],
                    },
                ],
                placements: vec![PlacedCabinet {
                    instance_id: "mon_1".into(),
                    label: "Aether-83M".into(),
                    cabinet_spec_id: "aether_83m".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["lf".into(), "mf".into(), "hf".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "classic_2way".into(),
                label: "Comparison: Classic Flat-Baffle 2-Way (8.5\" + 1\")".into(),
                summary: "8.5\" woofer beams at 1.8 kHz before crossing to wide 1\" dome — note Early Reflections / DI step!".into(),
                boundary: BoundaryEnvironment::Free4Pi,
                dsp_channels: vec![
                    DspChannelSpec {
                        id: "lf2".into(),
                        label: "LF Woofer (28–2100 Hz)".into(),
                        gain_db: 3.6,
                        invert_polarity: false,
                        delay_s: 0.0,
                        highpass: Some(CrossoverFilter::Butterworth {
                            order: 4,
                            freq_hz: 28.0,
                        }),
                        lowpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 2100.0,
                        }),
                        stages: vec![BiquadStage::LowShelf {
                            freq_hz: 190.0,
                            gain_db: 3.2,
                            q: 0.707,
                        }],
                    },
                    DspChannelSpec {
                        id: "hf2".into(),
                        label: "HF Flat Dome (>2.1 kHz)".into(),
                        gain_db: -2.4,
                        invert_polarity: false,
                        delay_s: 0.0,
                        highpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 2100.0,
                        }),
                        lowpass: None,
                        stages: vec![],
                    },
                ],
                placements: vec![PlacedCabinet {
                    instance_id: "mon_2".into(),
                    label: "Classic 2-Way".into(),
                    cabinet_spec_id: "classic_2way_85".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["lf2".into(), "hf2".into()],
                }],
            },
        ],
    }
}

// ============================================================================
// Design 02: Cardioid-8C Studio Monitor Pair Near Front Wall (SBIR Control)
// ============================================================================

fn design_02_studio_monitor_cardioid_sbir() -> SystemDesignSpec {
    let cardioid_cab = SpeakerCabinetSpec {
        id: "cardioid_8c".into(),
        name: "Cardioid-8C Boundary-Controlled Studio Monitor".into(),
        subtitle: "21 mm CLD Viscoelastic Birch + 28 mm Valchromat Baffle · Resistive Cardioid".into(),
        dims_m: [0.28, 0.38, 0.52],
        edge_round_m: 0.028,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::cld_birch_laminate(),
            baffle_material: PanelMaterialSpec::valchromat_hdf(),
            wall_thickness_m: 0.021,
            front_baffle_thickness_m: 0.028,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 1,
            driver_rebate_depth_m: 0.006,
            damping_lining_thickness_m: 0.030,
            joinery: JoineryKind::Miter45,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "lf_cardioid".into(),
                label: "8.5\" Cardioid-Slot Bass/Mid".into(),
                driver_id: "alu_wf_85".into(),
                driver_count: 2,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.24),
                enclosure: WayEnclosure::CardioidSlot {
                    internal_volume_m3: 0.032,
                    slot_area_m2: 0.019,
                    slot_path_m: 0.22,
                    slot_flow_resistivity: 14_500.0,
                    port: Some(PortSpec {
                        area_m2: 0.0042,
                        length_m: 0.30,
                        flare_radius_m: 0.024,
                        local_exit_offset: Point3::new(0.0, -0.18, 0.06),
                        local_normal: Vec3::new(0.0, -1.0, 0.0),
                    }),
                },
            },
            CabinetWaySpec {
                way_id: "hf_wg".into(),
                label: "1.0\" Deep OS-SE Waveguide".into(),
                driver_id: "be_dome_10".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.43),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.0003,
                    throat_chamber_m3: 0.000_02,
                    waveguide: HornSegmentSpec {
                        length_m: 0.045,
                        throat_area_m2: 0.000_65,
                        mouth_area_m2: 0.022,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 85.0,
                            coverage_v_deg: 65.0,
                        },
                        aspect_ratio: 1.1,
                    },
                },
            },
        ],
    };

    let omni_cab = SpeakerCabinetSpec {
        id: "standard_omni_mon".into(),
        name: "Conventional Vented Monitor (Omnidirectional Bass)".into(),
        subtitle: "19 mm Valchromat HDF · Dual 8.5\" Vented Box Without Cardioid Side Slots".into(),
        dims_m: [0.28, 0.38, 0.52],
        edge_round_m: 0.024,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::valchromat_hdf(),
            baffle_material: PanelMaterialSpec::valchromat_hdf(),
            wall_thickness_m: 0.019,
            front_baffle_thickness_m: 0.025,
            internal_partition_thickness_m: 0.016,
            brace_thickness_m: 0.018,
            brace_count: 1,
            driver_rebate_depth_m: 0.005,
            damping_lining_thickness_m: 0.022,
            joinery: JoineryKind::RabbetDado,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "lf_omni".into(),
                label: "Dual 8.5\" Vented LF".into(),
                driver_id: "alu_wf_85".into(),
                driver_count: 2,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.24),
                enclosure: WayEnclosure::Vented {
                    volume_m3: 0.036,
                    leakage_ql: 12.0,
                    port: PortSpec {
                        area_m2: 0.0048,
                        length_m: 0.29,
                        flare_radius_m: 0.022,
                        local_exit_offset: Point3::new(0.0, 0.0, 0.06),
                        local_normal: Vec3::Y,
                    },
                    damping: PorousMaterial::default(),
                },
            },
            CabinetWaySpec {
                way_id: "hf_wg".into(),
                label: "1.0\" Deep OS-SE Waveguide".into(),
                driver_id: "be_dome_10".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.43),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.0003,
                    throat_chamber_m3: 0.000_02,
                    waveguide: HornSegmentSpec {
                        length_m: 0.045,
                        throat_area_m2: 0.000_65,
                        mouth_area_m2: 0.022,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 85.0,
                            coverage_v_deg: 65.0,
                        },
                        aspect_ratio: 1.1,
                    },
                },
            },
        ],
    };

    SystemDesignSpec {
        id: "02-studio-monitor-cardioid-sbir".into(),
        title: "Cardioid-8C — Stereo Studio Monitor Pair Near Front Wall (SBIR Elimination)".into(),
        category: "Studio Monitors".into(),
        description: "Simulates a 60° equilateral stereo studio monitor pair placed 55 cm from the control-room front wall (y = -1.50 m), comparing an acoustic resistive-slot cardioid monitor against a conventional omnidirectional-bass monitor.".into(),
        design_notes: vec![
            "The Studio SBIR Trap: At 55 cm front-wall offset, the rear-radiated bass wave bounces off the studio wall with a 1.1 m round-trip delay, creating a severe quarter-wave cancellation notch around 140–160 Hz at the mix chair.".into(),
            "Passive Acoustic Cardioid Slots: Flow-resistive side slots delay and invert the rear cone wave by 22 cm internal + exterior path, attenuating rear radiation toward the front wall by 10–14 dB across 90–350 Hz.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 24.0,
            freq_max_hz: 18_000.0,
            num_freqs: 90,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 18.0,
            enable_3d_bem: true,
            field_bounds_m: [-2.6, 2.6, -1.5, 3.5],
            field_grid_nx: 46,
            field_grid_ny: 46,
            listener_height_m: 1.20,
            reference_mic_m: [0.0, 0.95, 1.20],
        },
        drivers: studio_drivers(),
        cabinets: vec![cardioid_cab, omni_cab],
        zones: vec![
            ListenerZone {
                id: "mix_desk".into(),
                label: "Mixing Desk Sweet Spot".into(),
                role: "sweet_spot".into(),
                x_min_m: -0.5,
                x_max_m: 0.5,
                y_min_m: 0.65,
                y_max_m: 1.35,
                z_ear_m: 1.20,
            },
            ListenerZone {
                id: "client_couch".into(),
                label: "Producer Rear Couch (2.6 m)".into(),
                role: "far_range".into(),
                x_min_m: -0.9,
                x_max_m: 0.9,
                y_min_m: 2.2,
                y_max_m: 3.0,
                z_ear_m: 1.15,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "cardioid_pair".into(),
                label: "Proposed: Cardioid-8C Stereo Pair (55 cm from Wall)".into(),
                summary: "Resistive cardioid side slots suppress the 150 Hz front-wall SBIR cancellation dip.".into(),
                boundary: BoundaryEnvironment::StudioFrontWall {
                    wall_y_m: -1.50,
                    wall_reflection: 0.86,
                },
                dsp_channels: vec![
                    DspChannelSpec {
                        id: "c_lf".into(),
                        label: "Cardioid LF/MF (<1.5 kHz)".into(),
                        gain_db: 2.5,
                        invert_polarity: false,
                        delay_s: 0.0,
                        highpass: Some(CrossoverFilter::Butterworth {
                            order: 4,
                            freq_hz: 28.0,
                        }),
                        lowpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 1500.0,
                        }),
                        stages: vec![BiquadStage::LowShelf {
                            freq_hz: 140.0,
                            gain_db: 3.5,
                            q: 0.65,
                        }],
                    },
                    DspChannelSpec {
                        id: "c_hf".into(),
                        label: "OS-SE HF (>1.5 kHz)".into(),
                        gain_db: -4.2,
                        invert_polarity: false,
                        delay_s: 0.000_16,
                        highpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 1500.0,
                        }),
                        lowpass: None,
                        stages: vec![],
                    },
                ],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "left_c".into(),
                        label: "Left Cardioid-8C".into(),
                        cabinet_spec_id: "cardioid_8c".into(),
                        transform: Transform3::at(-1.10, -0.95, 0.85).with_aim(-30.0, 0.0),
                        way_dsp_channels: vec!["c_lf".into(), "c_hf".into()],
                    },
                    PlacedCabinet {
                        instance_id: "right_c".into(),
                        label: "Right Cardioid-8C".into(),
                        cabinet_spec_id: "cardioid_8c".into(),
                        transform: Transform3::at(1.10, -0.95, 0.85).with_aim(30.0, 0.0),
                        way_dsp_channels: vec!["c_lf".into(), "c_hf".into()],
                    },
                ],
            },
            SceneVariantSpec {
                variant_id: "omni_pair".into(),
                label: "Comparison: Conventional Vented Pair at Same Wall Offset".into(),
                summary: "Severe front-wall SBIR comb-filtering peak at 75 Hz and notch around 150 Hz.".into(),
                boundary: BoundaryEnvironment::StudioFrontWall {
                    wall_y_m: -1.50,
                    wall_reflection: 0.86,
                },
                dsp_channels: vec![
                    DspChannelSpec {
                        id: "o_lf".into(),
                        label: "Vented LF/MF (<1.5 kHz)".into(),
                        gain_db: 0.5,
                        invert_polarity: false,
                        delay_s: 0.0,
                        highpass: Some(CrossoverFilter::Butterworth {
                            order: 4,
                            freq_hz: 28.0,
                        }),
                        lowpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 1500.0,
                        }),
                        stages: vec![],
                    },
                    DspChannelSpec {
                        id: "o_hf".into(),
                        label: "OS-SE HF (>1.5 kHz)".into(),
                        gain_db: -4.2,
                        invert_polarity: false,
                        delay_s: 0.000_16,
                        highpass: Some(CrossoverFilter::LinkwitzRiley {
                            order: 4,
                            freq_hz: 1500.0,
                        }),
                        lowpass: None,
                        stages: vec![],
                    },
                ],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "left_o".into(),
                        label: "Left Standard Monitor".into(),
                        cabinet_spec_id: "standard_omni_mon".into(),
                        transform: Transform3::at(-1.10, -0.95, 0.85).with_aim(-30.0, 0.0),
                        way_dsp_channels: vec!["o_lf".into(), "o_hf".into()],
                    },
                    PlacedCabinet {
                        instance_id: "right_o".into(),
                        label: "Right Standard Monitor".into(),
                        cabinet_spec_id: "standard_omni_mon".into(),
                        transform: Transform3::at(1.10, -0.95, 0.85).with_aim(30.0, 0.0),
                        way_dsp_channels: vec!["o_lf".into(), "o_hf".into()],
                    },
                ],
            },
        ],
    }
}

// ============================================================================
// Design 03: TerraHorn-18 — 1× vs 2× vs 4× Mouth-Coupled Subwoofer Stack
// ============================================================================

fn design_03_subwoofer_coupling_1x_2x_4x() -> SystemDesignSpec {
    let sub_dsp = DspChannelSpec {
        id: "sub_main".into(),
        label: "Sub Bandpass (25–95 Hz)".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 25.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 95.0,
        }),
        stages: vec![],
    };

    let sub_rear_card = DspChannelSpec {
        id: "sub_rear_csa".into(),
        label: "Rear Cardioid Cancel (-2.62 ms, Inv)".into(),
        gain_db: -1.3,
        invert_polarity: true,
        delay_s: 0.002_62,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 25.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 95.0,
        }),
        stages: vec![],
    };

    SystemDesignSpec {
        id: "03-subwoofer-coupling-1x-2x-4x".into(),
        title: "TerraHorn-18 — Why 2× & 4× Coupled Subwoofer Horns Sound Magical".into(),
        category: "Coupled Subwoofer Physics".into(),
        description: "Computational proof of mutual radiation impedance loading: comparing 1, 2, and 4 mouth-coupled 2.25 m folded bass horns (plus a 3-Front / 1-Rear Cardioid stack) at identical 80 Vrms per-cabinet drive.".into(),
        design_notes: vec![
            "Mutual Mouth Loading (`Re(Z_rad)`): A single 0.49 m² horn mouth is acoustically small at 32 Hz (ka = 0.23), reflecting wave energy back down the horn. Stacking 4 mouths creates a 1.96 m² virtual aperture (+ 2pi ground image = 3.92 m²), multiplying real radiation resistance ~3.7x per driver!".into(),
            "Free Extra Sub-Bass & Lower Excursion: Notice on the `SPL vs Uncoupled Baseline` curve how the 4× stack beats naive point-source summation at 28–42 Hz, collapses throat standing-wave ripple, AND lowers per-driver cone excursion near 32 Hz!".into(),
            "CSA 3:1 Cardioid Variant: Turning 1 of the 4 horns backward with 2.65 ms delay + inverted polarity carves a 15 dB quiet zone behind the stack while retaining 3× coupled forward punch.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 18.0,
            freq_max_hz: 250.0,
            num_freqs: 84,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 80.0,
            enable_3d_bem: true,
            field_bounds_m: [-16.0, 16.0, -12.0, 22.0],
            field_grid_nx: 48,
            field_grid_ny: 48,
            listener_height_m: 1.4,
            reference_mic_m: [0.0, 10.0, 1.4],
        },
        drivers: pa_drivers(),
        cabinets: vec![cabinet_terra_horn_18()],
        zones: vec![
            ListenerZone {
                id: "dance_center".into(),
                label: "Dancefloor Zone (6–16 m)".into(),
                role: "sweet_spot".into(),
                x_min_m: -6.0,
                x_max_m: 6.0,
                y_min_m: 6.0,
                y_max_m: 16.0,
                z_ear_m: 1.4,
            },
            ListenerZone {
                id: "behind_stack".into(),
                label: "Behind Stack / Stage (-8 to -3 m)".into(),
                role: "stage_quiet".into(),
                x_min_m: -4.0,
                x_max_m: 4.0,
                y_min_m: -8.0,
                y_max_m: -3.0,
                z_ear_m: 1.4,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "stack_4x_monoblock".into(),
                label: "4× Coupled 2×2 Monoblock (Full Mutual Loading)".into(),
                summary: "1.96 m² combined horn mouth: smooths throat impedance, drops cutoff to ~28 Hz, +13.5 dB over 1×.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![sub_dsp.clone()],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "h1".into(),
                        label: "Horn BL".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(-0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h2".into(),
                        label: "Horn BR".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h3".into(),
                        label: "Horn TL".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(-0.31, 0.0, 0.91),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h4".into(),
                        label: "Horn TR".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(0.31, 0.0, 0.91),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                ],
            },
            SceneVariantSpec {
                variant_id: "stack_2x_pair".into(),
                label: "2× Mouth-Coupled Ground Pair".into(),
                summary: "0.98 m² combined mouth: +7.2 dB sub-bass gain over 1× (+1.2 dB pure mutual-impedance bonus).".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![sub_dsp.clone()],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "h1".into(),
                        label: "Horn L".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(-0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h2".into(),
                        label: "Horn R".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                ],
            },
            SceneVariantSpec {
                variant_id: "stack_1x_single".into(),
                label: "1× Single Horn Alone (Under-Terminated Mouth)".into(),
                summary: "Strong mouth reflection causes throat impedance peaks and early roll-off below 42 Hz.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![sub_dsp.clone()],
                placements: vec![PlacedCabinet {
                    instance_id: "h1".into(),
                    label: "Single Horn".into(),
                    cabinet_spec_id: "terra_horn_18".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["sub_main".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "stack_4x_cardioid".into(),
                label: "4× Cardioid Stack (2 Front Coupled + 2 Rear Inverted CSA)".into(),
                summary: "Flush 2×2 cardioid monoblock: cancels rear stage bass by ~15 dB across 35–85 Hz while preserving tight transient punch.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![sub_dsp, sub_rear_card],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "h1".into(),
                        label: "Bottom-L Front".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(-0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h2".into(),
                        label: "Bottom-R Front".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(0.31, 0.0, 0.0),
                        way_dsp_channels: vec!["sub_main".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h3_rear".into(),
                        label: "Top-L Rear Cardioid".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(-0.31, 0.0, 0.91).with_aim(180.0, 0.0),
                        way_dsp_channels: vec!["sub_rear_csa".into()],
                    },
                    PlacedCabinet {
                        instance_id: "h4_rear".into(),
                        label: "Top-R Rear Cardioid".into(),
                        cabinet_spec_id: "terra_horn_18".into(),
                        transform: Transform3::at(0.31, 0.0, 0.91).with_aim(180.0, 0.0),
                        way_dsp_channels: vec!["sub_rear_csa".into()],
                    },
                ],
            },
        ],
    }
}

// ============================================================================
// Design 04: Oasis-360 — Proposed Open-Field Surround EDM Sound System
// ============================================================================

fn design_04_outdoor_edm_oasis_360() -> SystemDesignSpec {
    let mut oasis_dsp = vec![
        DspChannelSpec {
            id: "sub_front".into(),
            label: "Coupled 4× Sub Front (26–85 Hz)".into(),
            gain_db: 1.0,
            invert_polarity: false,
            delay_s: 0.0,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 26.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 85.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: "sub_card_rear".into(),
            label: "Cardioid 2× Rear Cancel (-2.62 ms, Inv)".into(),
            gain_db: 4.8,
            invert_polarity: true,
            delay_s: 0.002_62,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 26.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 85.0,
            }),
            stages: vec![],
        },
    ];
    oasis_dsp.extend(synergy_top_dsp_channels("top", 0.0042, 0.0));

    let mut naive_dsp = vec![DspChannelSpec {
        id: "sub_corner".into(),
        label: "Corner Subs (26–85 Hz)".into(),
        gain_db: 3.5,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 26.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 85.0,
        }),
        stages: vec![],
    }];
    naive_dsp.extend(synergy_top_dsp_channels("top", 0.0, 0.0));

    let corner_tops = |dsp_prefix: &str| -> Vec<PlacedCabinet> {
        // Local +Y is forward:
        // (-9, -9) aiming at (0, 0): dx=+9, dy=+9 -> yaw = -45 deg!
        // Let's verify Transform3::rotation_matrix: forward = (-sin(yaw)*cos(pitch), cos(yaw)*cos(pitch), sin(pitch)).
        // For (-9, -9) -> (+1, +1)/sqrt(2): -sin(yaw) = +0.707, cos(yaw) = +0.707 => yaw = -45 deg!
        // For (+9, -9) -> (-1, +1)/sqrt(2): -sin(yaw) = -0.707, cos(yaw) = +0.707 => yaw = +45 deg!
        // For (+9, +9) -> (-1, -1)/sqrt(2): -sin(yaw) = -0.707, cos(yaw) = -0.707 => yaw = +135 deg!
        // For (-9, +9) -> (+1, -1)/sqrt(2): -sin(yaw) = +0.707, cos(yaw) = -0.707 => yaw = -135 deg!
        let chs = vec![
            format!("{dsp_prefix}_kick"),
            format!("{dsp_prefix}_mid"),
            format!("{dsp_prefix}_hf"),
        ];
        vec![
            PlacedCabinet {
                instance_id: "top_nw".into(),
                label: "NW Corner Synergy Top".into(),
                cabinet_spec_id: "synergy_3p".into(),
                transform: Transform3::at(-9.0, -9.0, 2.85).with_aim(-45.0, -7.5),
                way_dsp_channels: chs.clone(),
            },
            PlacedCabinet {
                instance_id: "top_ne".into(),
                label: "NE Corner Synergy Top".into(),
                cabinet_spec_id: "synergy_3p".into(),
                transform: Transform3::at(9.0, -9.0, 2.85).with_aim(45.0, -7.5),
                way_dsp_channels: chs.clone(),
            },
            PlacedCabinet {
                instance_id: "top_se".into(),
                label: "SE Corner Synergy Top".into(),
                cabinet_spec_id: "synergy_3p".into(),
                transform: Transform3::at(9.0, 9.0, 2.85).with_aim(135.0, -7.5),
                way_dsp_channels: chs.clone(),
            },
            PlacedCabinet {
                instance_id: "top_sw".into(),
                label: "SW Corner Synergy Top".into(),
                cabinet_spec_id: "synergy_3p".into(),
                transform: Transform3::at(-9.0, 9.0, 2.85).with_aim(-135.0, -7.5),
                way_dsp_channels: chs,
            },
        ]
    };

    let mut oasis_placements = vec![
        PlacedCabinet {
            instance_id: "sub_f1".into(),
            label: "Sub Monoblock F1".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(-0.93, -11.0, 0.0),
            way_dsp_channels: vec!["sub_front".into()],
        },
        PlacedCabinet {
            instance_id: "sub_f2".into(),
            label: "Sub Monoblock F2".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(-0.31, -11.0, 0.0),
            way_dsp_channels: vec!["sub_front".into()],
        },
        PlacedCabinet {
            instance_id: "sub_f3".into(),
            label: "Sub Monoblock F3".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(0.31, -11.0, 0.0),
            way_dsp_channels: vec!["sub_front".into()],
        },
        PlacedCabinet {
            instance_id: "sub_f4".into(),
            label: "Sub Monoblock F4".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(0.93, -11.0, 0.0),
            way_dsp_channels: vec!["sub_front".into()],
        },
        PlacedCabinet {
            instance_id: "sub_r1".into(),
            label: "Sub Cardioid R1 (Top-Reversed)".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(-0.31, -11.0, 0.91).with_aim(180.0, 0.0),
            way_dsp_channels: vec!["sub_card_rear".into()],
        },
        PlacedCabinet {
            instance_id: "sub_r2".into(),
            label: "Sub Cardioid R2 (Top-Reversed)".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(0.31, -11.0, 0.91).with_aim(180.0, 0.0),
            way_dsp_channels: vec!["sub_card_rear".into()],
        },
    ];
    oasis_placements.extend(corner_tops("top"));

    let mut naive_placements = vec![
        PlacedCabinet {
            instance_id: "sub_nw".into(),
            label: "NW Corner Sub".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(-9.0, -9.0, 0.0).with_aim(-45.0, 0.0),
            way_dsp_channels: vec!["sub_corner".into()],
        },
        PlacedCabinet {
            instance_id: "sub_ne".into(),
            label: "NE Corner Sub".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(9.0, -9.0, 0.0).with_aim(45.0, 0.0),
            way_dsp_channels: vec!["sub_corner".into()],
        },
        PlacedCabinet {
            instance_id: "sub_se".into(),
            label: "SE Corner Sub".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(9.0, 9.0, 0.0).with_aim(135.0, 0.0),
            way_dsp_channels: vec!["sub_corner".into()],
        },
        PlacedCabinet {
            instance_id: "sub_sw".into(),
            label: "SW Corner Sub".into(),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(-9.0, 9.0, 0.0).with_aim(-135.0, 0.0),
            way_dsp_channels: vec!["sub_corner".into()],
        },
    ];
    naive_placements.extend(corner_tops("top"));

    SystemDesignSpec {
        id: "04-outdoor-edm-oasis-360".into(),
        title: "Oasis-360 — Open-Field Surround Dancefloor System for EDM".into(),
        category: "Outdoor EDM Systems".into(),
        description: "Complete open-field EDM sound system creating an enveloping 16×16 m surround sweet spot: pairing a tightly mouth-coupled North Cardioid Horn-Sub Monoblock (26–85 Hz) with 4 elevated Corner 3-Way Synergy Horn Tops (85 Hz–20 kHz).".into(),
        design_notes: vec![
            "Why Separate Sub Coupling from 4-Corner Surround Tops? Human hearing cannot localize <80 Hz sub-bass, and putting 1 sub in each corner (Variant B) destroys 4× horn mouth coupling AND carves -18 dB checkerboard comb-filtering dead valleys every 2.5 m across the dancefloor!".into(),
            "Coupled Sub Blanket + 360° Kick/Mid/High Immersion: Grouping all subs into one mouth-coupled North Cardioid Monoblock delivers +-2.1 dB seamless sub-bass across the entire dancefloor while the 4 elevated 60°×40° Synergy tops (-7.5° downward tilt from 2.85 m) bathe dancers in crisp 360° kick punch, synths, and stereo/quad movement without harshness.".into(),
            "DJ Booth & Open-Field Control: Cardioid rear subs drop 35–80 Hz boom in the North DJ booth by ~14 dB, while the -7.5° downward horn tilt aims mid/high energy onto the dancefloor turf rather than miles across the open field.".into(),
        ],
        environment: AmbientEnvironment {
            temperature_k: 291.15,
            pressure_pa: 101_325.0,
            relative_humidity: 0.55,
        },
        settings: SimulationSettings {
            freq_min_hz: 22.0,
            freq_max_hz: 18_000.0,
            num_freqs: 88,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 62.0,
            enable_3d_bem: false,
            field_bounds_m: [-22.0, 22.0, -18.0, 26.0],
            field_grid_nx: 56,
            field_grid_ny: 56,
            listener_height_m: 1.65,
            reference_mic_m: [1.8, 1.2, 1.65],
        },
        drivers: pa_drivers(),
        cabinets: vec![cabinet_terra_horn_18(), cabinet_synergy_3p_top()],
        zones: vec![
            ListenerZone {
                id: "dancefloor_sweet".into(),
                label: "12×12 m Dancefloor Sweet Spot".into(),
                role: "sweet_spot".into(),
                x_min_m: -6.0,
                x_max_m: 6.0,
                y_min_m: -6.0,
                y_max_m: 6.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "dj_booth".into(),
                label: "North DJ Booth (-16.5 to -13 m)".into(),
                role: "stage_quiet".into(),
                x_min_m: -3.5,
                x_max_m: 3.5,
                y_min_m: -16.5,
                y_max_m: -13.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "chill_lounge".into(),
                label: "South Open-Field Lounge (12–22 m)".into(),
                role: "far_range".into(),
                x_min_m: -9.0,
                x_max_m: 9.0,
                y_min_m: 12.0,
                y_max_m: 22.0,
                z_ear_m: 1.50,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "oasis_360_monoblock".into(),
                label: "Proposed: Oasis-360 (Coupled Cardioid Sub Monoblock + 4-Corner Synergy Tops)".into(),
                summary: "Zero sub comb-filtering across the 16×16 m floor, full 4× horn mouth boost, -14 dB DJ rejection, 360° surround tops.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 220_000.0,
                },
                dsp_channels: oasis_dsp,
                placements: oasis_placements,
            },
            SceneVariantSpec {
                variant_id: "naive_4corner_subs".into(),
                label: "Anti-Pattern: Naive 4-Corner Distributed Subs + 4-Corner Tops".into(),
                summary: "Scrub 50–80 Hz on the 3D field map to see severe checkerboard bass dead spots across the dancefloor!".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 220_000.0,
                },
                dsp_channels: naive_dsp,
                placements: naive_placements,
            },
        ],
    }
}

// ============================================================================
// Design 05: FieldThrow-Arc — Long-Range Open-Field Dancefloor + 45m Throw
// ============================================================================

fn design_05_outdoor_edm_fieldthrow_range() -> SystemDesignSpec {
    let c = 343.0;
    let xs = [-1.55, -0.93, -0.31, 0.31, 0.93, 1.55];
    let span = 3.10;

    let mut arc_dsp = Vec::new();
    let mut arc_placements = Vec::new();

    for (idx, &x) in xs.iter().enumerate() {
        let d_arc = electronic_arc_delay_s(x, span, 75.0, c);
        let ch_id = format!("sub_arc_{idx}");
        arc_dsp.push(DspChannelSpec {
            id: ch_id.clone(),
            label: format!("Sub Arc #{} ({:.2} ms)", idx + 1, d_arc * 1000.0),
            gain_db: 1.5,
            invert_polarity: false,
            delay_s: d_arc,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 26.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 85.0,
            }),
            stages: vec![],
        });
        arc_placements.push(PlacedCabinet {
            instance_id: format!("arc_s{idx}"),
            label: format!("Arc Sub {}", idx + 1),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(x, 0.0, 0.0),
            way_dsp_channels: vec![ch_id],
        });
    }

    // Two rear cardioid subs behind center of arc
    arc_dsp.push(DspChannelSpec {
        id: "arc_rear_csa".into(),
        label: "Arc Cardioid Rear (-2.7 ms, Inv)".into(),
        gain_db: -1.5,
        invert_polarity: true,
        delay_s: 0.002_70,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 26.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 85.0,
        }),
        stages: vec![],
    });
    for (ri, &rx) in [-0.62, 0.62].iter().enumerate() {
        arc_placements.push(PlacedCabinet {
            instance_id: format!("arc_rear_{ri}"),
            label: format!("Cardioid Rear {}", ri + 1),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(rx, -0.95, 0.0).with_aim(180.0, 0.0),
            way_dsp_channels: vec!["arc_rear_csa".into()],
        });
    }

    // Dual-splay Main Stacks (Long-throw upper cabinet +3 dB aimed -2 deg at 35 m; Near-fill lower cabinet -2.5 dB aimed -9 deg at 10 m!)
    arc_dsp.extend(synergy_top_dsp_channels("throw", 0.0012, 3.0));
    arc_dsp.extend(synergy_top_dsp_channels("near", 0.0014, -2.5));

    let throw_chs = vec!["throw_kick".into(), "throw_mid".into(), "throw_hf".into()];
    let near_chs = vec!["near_kick".into(), "near_mid".into(), "near_hf".into()];

    arc_placements.extend(vec![
        PlacedCabinet {
            instance_id: "main_l_hi".into(),
            label: "Left Long-Throw Main".into(),
            cabinet_spec_id: "synergy_3p".into(),
            transform: Transform3::at(-5.2, 0.0, 3.55).with_aim(-8.0, -2.2),
            way_dsp_channels: throw_chs.clone(),
        },
        PlacedCabinet {
            instance_id: "main_r_hi".into(),
            label: "Right Long-Throw Main".into(),
            cabinet_spec_id: "synergy_3p".into(),
            transform: Transform3::at(5.2, 0.0, 3.55).with_aim(8.0, -2.2),
            way_dsp_channels: throw_chs,
        },
        PlacedCabinet {
            instance_id: "main_l_lo".into(),
            label: "Left Dancefloor Fill".into(),
            cabinet_spec_id: "synergy_3p".into(),
            transform: Transform3::at(-5.2, 0.0, 2.55).with_aim(-18.0, -9.0),
            way_dsp_channels: near_chs.clone(),
        },
        PlacedCabinet {
            instance_id: "main_r_lo".into(),
            label: "Right Dancefloor Fill".into(),
            cabinet_spec_id: "synergy_3p".into(),
            transform: Transform3::at(5.2, 0.0, 2.55).with_aim(18.0, -9.0),
            way_dsp_channels: near_chs,
        },
    ]);

    // Variant B: Spaced Left/Right Sub Stacks (`x = +-5.5 m`) — classic "Power Alley" mistake!
    let mut lr_dsp = vec![DspChannelSpec {
        id: "lr_sub".into(),
        label: "Spaced L/R Subs".into(),
        gain_db: 2.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 26.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 85.0,
        }),
        stages: vec![],
    }];
    lr_dsp.extend(synergy_top_dsp_channels("throw", 0.0, 2.0));

    let mut lr_placements = Vec::new();
    for (si, &sx) in [-5.8, -5.2, -4.6, 4.6, 5.2, 5.8].iter().enumerate() {
        lr_placements.push(PlacedCabinet {
            instance_id: format!("lr_s{si}"),
            label: format!("L/R Sub {}", si + 1),
            cabinet_spec_id: "terra_horn_18".into(),
            transform: Transform3::at(sx, 0.0, 0.0),
            way_dsp_channels: vec!["lr_sub".into()],
        });
    }
    let m_chs = vec!["throw_kick".into(), "throw_mid".into(), "throw_hf".into()];
    lr_placements.push(PlacedCabinet {
        instance_id: "lr_top_l".into(),
        label: "Left Main".into(),
        cabinet_spec_id: "synergy_3p".into(),
        transform: Transform3::at(-5.2, 0.0, 3.0).with_aim(-10.0, -4.0),
        way_dsp_channels: m_chs.clone(),
    });
    lr_placements.push(PlacedCabinet {
        instance_id: "lr_top_r".into(),
        label: "Right Main".into(),
        cabinet_spec_id: "synergy_3p".into(),
        transform: Transform3::at(5.2, 0.0, 3.0).with_aim(10.0, -4.0),
        way_dsp_channels: m_chs,
    });

    SystemDesignSpec {
        id: "05-outdoor-edm-fieldthrow-range".into(),
        title: "FieldThrow-Arc — Open-Field Dancefloor + 45 m Long-Range Throw".into(),
        category: "Outdoor EDM Systems".into(),
        description: "Designed for open-field gatherings needing both high-impact front dancefloor coverage (6–20 m) and coherent long-range projection out to 45 m — comparing a 6-Sub Coupled Electronic Arc against classic spaced L/R sub stacks.".into(),
        design_notes: vec![
            "Eliminating the 'Power Alley': Separating Left & Right sub stacks by 10.4 m (Variant B) creates a narrow +6 dB center bass beam flanked by deep -15 dB cancellation fingers across the field. Centering all 6 subs at 0.62 m spacing (< lambda/4) with parabolic 75° Electronic-Arc delays (Variant A) creates one seamless, lobe-free 75° bass fan out to 45 m!".into(),
            "Dual-Splay Vertical Shading for Range: Stacking an upper Long-Throw Synergy top (+3 dB, -2.2° tilt aimed at 35 m) over a padded Near-Fill top (-2.5 dB, -9° tilt aimed at 10 m) counteracts inverse-square distance loss so front-row dancers aren't deafened while 40 m listeners still get crisp HF/mid clarity (compensating ISO 9613-1 air + turf absorption).".into(),
        ],
        environment: AmbientEnvironment {
            temperature_k: 293.15,
            pressure_pa: 101_325.0,
            relative_humidity: 0.48,
        },
        settings: SimulationSettings {
            freq_min_hz: 22.0,
            freq_max_hz: 18_000.0,
            num_freqs: 86,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 75.0,
            enable_3d_bem: false,
            field_bounds_m: [-22.0, 22.0, -10.0, 48.0],
            field_grid_nx: 54,
            field_grid_ny: 58,
            listener_height_m: 1.65,
            reference_mic_m: [0.0, 14.0, 1.65],
        },
        drivers: pa_drivers(),
        cabinets: vec![cabinet_terra_horn_18(), cabinet_synergy_3p_top()],
        zones: vec![
            ListenerZone {
                id: "main_floor".into(),
                label: "Primary Dancefloor (6–20 m)".into(),
                role: "sweet_spot".into(),
                x_min_m: -8.0,
                x_max_m: 8.0,
                y_min_m: 6.0,
                y_max_m: 20.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "far_meadow".into(),
                label: "Long-Range Open Field (24–44 m)".into(),
                role: "far_range".into(),
                x_min_m: -12.0,
                x_max_m: 12.0,
                y_min_m: 24.0,
                y_max_m: 44.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "stage_deck".into(),
                label: "Stage / DJ Deck (-8 to -2.5 m)".into(),
                role: "stage_quiet".into(),
                x_min_m: -5.0,
                x_max_m: 5.0,
                y_min_m: -8.0,
                y_max_m: -2.5,
                z_ear_m: 1.65,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "coupled_arc_dual_splay".into(),
                label: "Proposed: 6× Coupled 75° Electronic-Arc Subs + Dual-Splay Mains".into(),
                summary: "Even 75° horizontal bass fan with zero side lobing and balanced near-to-45m SPL.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 200_000.0,
                },
                dsp_channels: arc_dsp,
                placements: arc_placements,
            },
            SceneVariantSpec {
                variant_id: "spaced_lr_stacks".into(),
                label: "Comparison: Spaced Left/Right Sub Stacks (Power-Alley Lobing)".into(),
                summary: "Scrub 50–80 Hz on the field map to see the narrow center power alley and deep off-axis nulls.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 200_000.0,
                },
                dsp_channels: lr_dsp,
                placements: lr_placements,
            },
        ],
    }
}

// ============================================================================
// Design 06: Prototype #1 Measurement-to-Model Bayesian Calibration Bench
// ============================================================================

fn design_06_prototype_bayesian_calibration() -> SystemDesignSpec {
    let prior_drv = DriverSpec {
        id: "proto_drv_prior".into(),
        name: "18\" Subwoofer (Datasheet Nominal Prior)".into(),
        category: "sub".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.30,
            inductance: InductanceModel::Simple { le_h: 1.30e-3 },
            bl_t_m: 25.0,
            mms_kg: 0.195,
            cms_m_per_n: 0.000_125,
            creep_lambda: 0.0,
            rms_n_s_m: 5.1,
            sd_m2: 0.120,
            xmax_m: 0.014,
            xmech_m: 0.022,
            pe_max_w: 1400.0,
        },
        nonlinear: DriverNonlinear::default(),
        thermal: DriverThermal::default(),
    };

    let cal_drv = DriverSpec {
        id: "proto_drv_calibrated".into(),
        name: "18\" Subwoofer (Bayesian MAP Calibrated Unit #1)".into(),
        category: "sub".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.48,
            inductance: InductanceModel::Simple { le_h: 1.48e-3 },
            bl_t_m: 23.4,
            mms_kg: 0.204,
            cms_m_per_n: 0.000_154,
            creep_lambda: 0.0,
            rms_n_s_m: 5.7,
            sd_m2: 0.120,
            xmax_m: 0.014,
            xmech_m: 0.022,
            pe_max_w: 1400.0,
        },
        nonlinear: DriverNonlinear::default(),
        thermal: DriverThermal::default(),
    };

    let prior_cab = SpeakerCabinetSpec {
        id: "terravent_prior".into(),
        name: "TerraVent-18 (Nominal CAD Design Prior)".into(),
        subtitle: "18 mm 13-Ply Birch + 24 mm Rebated Baffle · 145 L Vented · Tight Seal Q_L = 14".into(),
        dims_m: [0.58, 0.68, 0.68],
        edge_round_m: 0.02,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::baltic_birch_ply(),
            baffle_material: PanelMaterialSpec::baltic_birch_ply(),
            wall_thickness_m: 0.018,
            front_baffle_thickness_m: 0.024,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 2,
            driver_rebate_depth_m: 0.007,
            damping_lining_thickness_m: 0.025,
            joinery: JoineryKind::RabbetDado,
        },
        ways: vec![CabinetWaySpec {
            way_id: "sub".into(),
            label: "18\" Vented Sub".into(),
            driver_id: "proto_drv_prior".into(),
            driver_count: 1,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.38),
            enclosure: WayEnclosure::Vented {
                volume_m3: 0.145,
                leakage_ql: 14.0,
                port: PortSpec {
                    area_m2: 0.026,
                    length_m: 0.34,
                    flare_radius_m: 0.022,
                    local_exit_offset: Point3::new(0.0, 0.0, 0.08),
                    local_normal: Vec3::Y,
                },
                damping: PorousMaterial {
                    fill_fraction: 0.10,
                    ..Default::default()
                },
            },
        }],
    };

    let cal_cab = SpeakerCabinetSpec {
        id: "terravent_calibrated".into(),
        name: "TerraVent-18 (Posterior Calibrated Prototype #1)".into(),
        subtitle: "18 mm Birch + 2 Window Braces (-11 L Displ.) · Leak Q_L = 4.3 · Broken-In Spider".into(),
        dims_m: [0.58, 0.68, 0.68],
        edge_round_m: 0.02,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::baltic_birch_ply(),
            baffle_material: PanelMaterialSpec::baltic_birch_ply(),
            wall_thickness_m: 0.018,
            front_baffle_thickness_m: 0.024,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 2,
            driver_rebate_depth_m: 0.007,
            damping_lining_thickness_m: 0.025,
            joinery: JoineryKind::RabbetDado,
        },
        ways: vec![CabinetWaySpec {
            way_id: "sub".into(),
            label: "18\" Calibrated Sub".into(),
            driver_id: "proto_drv_calibrated".into(),
            driver_count: 1,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.38),
            enclosure: WayEnclosure::Vented {
                volume_m3: 0.134,
                leakage_ql: 4.3,
                port: PortSpec {
                    area_m2: 0.026,
                    length_m: 0.368,
                    flare_radius_m: 0.022,
                    local_exit_offset: Point3::new(0.0, 0.0, 0.08),
                    local_normal: Vec3::Y,
                },
                damping: PorousMaterial {
                    fill_fraction: 0.10,
                    ..Default::default()
                },
            },
        }],
    };

    let flat_dsp = DspChannelSpec {
        id: "raw_sweep".into(),
        label: "26 Hz Subsonic-Protected Sweep".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 26.0,
        }),
        lowpass: None,
        stages: vec![],
    };

    SystemDesignSpec {
        id: "06-prototype-bayesian-calibration".into(),
        title: "Prototype #1 Calibration — Updating Simulation Models from Measurements".into(),
        category: "Measurement Calibration".into(),
        description: "Demonstrates the full measurement-to-model feedback loop: fitting free-air .zma, in-cabinet .zma, and 2pi ground-plane .frd measurements via Forward-Mode Dual-AD Bayesian MAP optimization to update driver T-S parameters and diagnose an accidental cabinet air leak.".into(),
        design_notes: vec![
            "Automatic Build-Defect Diagnosis: The built prototype exhibited lower twin impedance peaks and 1.8 dB less output at 33 Hz than CAD predicted. Bayesian MAP calibration pinpointed an unsealed speakON/driver gasket leak (Posterior Q_L = 4.3 vs Design Q_L = 14.0) alongside +23% spider break-in compliance and -7.6% bracing displacement!".into(),
            "Uncertainty Quantification: Open the Calibration tab to inspect the Posterior 95% Laplace credible intervals and SVD parameter correlation matrix.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 18.0,
            freq_max_hz: 320.0,
            num_freqs: 72,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 38.0,
            enable_3d_bem: true,
            field_bounds_m: [-8.0, 8.0, -4.0, 12.0],
            field_grid_nx: 38,
            field_grid_ny: 38,
            listener_height_m: 0.25,
            reference_mic_m: [0.0, 2.0, 0.10],
        },
        drivers: vec![prior_drv, cal_drv],
        cabinets: vec![prior_cab, cal_cab],
        zones: vec![ListenerZone {
            id: "gp_mic_zone".into(),
            label: "2 m Ground-Plane Measurement Arc".into(),
            role: "sweet_spot".into(),
            x_min_m: -1.5,
            x_max_m: 1.5,
            y_min_m: 1.5,
            y_max_m: 3.0,
            z_ear_m: 0.10,
        }],
        variants: vec![
            SceneVariantSpec {
                variant_id: "posterior_calibrated".into(),
                label: "Posterior Calibrated Model (Updated from .zma + .frd)".into(),
                summary: "Matches physical prototype within 0.09 dB RMS across impedance & SPL; predicts true high-SPL excursion.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![flat_dsp.clone()],
                placements: vec![PlacedCabinet {
                    instance_id: "p_cal".into(),
                    label: "Calibrated Prototype #1".into(),
                    cabinet_spec_id: "terravent_calibrated".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["raw_sweep".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "design_prior".into(),
                label: "Nominal Pre-Build CAD Design Prior".into(),
                summary: "Datasheet T-S + ideal 145 L leak-free box prior before physical measurement feedback.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![flat_dsp],
                placements: vec![PlacedCabinet {
                    instance_id: "p_pri".into(),
                    label: "Nominal Prior".into(),
                    cabinet_spec_id: "terravent_prior".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["raw_sweep".into()],
                }],
            },
        ],
    }
}

// ============================================================================
// Design 07: Keystone-18TH — Dual-Side Tapped Bass Horn (1x / 2x / 4x & Front-Horn Shootout)
// ============================================================================

fn design_07_tapped_horn_keystone_18() -> SystemDesignSpec {
    let mut drivers = pa_drivers();
    drivers.push(DriverSpec {
        id: "tapped_sub_18".into(),
        name: "18\" Ultra-Linear Neodymium Tapped-Horn Sub (16.5 mm Xmax)".into(),
        category: "pa-sub".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.2,
            inductance: InductanceModel::L2R2 {
                le_h: 1.55e-3,
                l2_h: 0.98e-3,
                r2_ohm: 14.5,
            },
            bl_t_m: 28.4,
            mms_kg: 0.242,
            cms_m_per_n: 0.000_114,
            creep_lambda: 0.020,
            rms_n_s_m: 6.4,
            sd_m2: 0.122,
            xmax_m: 0.0165,
            xmech_m: 0.026,
            pe_max_w: 2000.0,
        },
        nonlinear: DriverNonlinear {
            bl_poly: [0.020, -0.21, -0.015, -0.04],
            kms_poly: [-0.025, 0.29, 0.015, 0.20],
            le_x_poly: [-0.12, 0.03],
            le_current_factor: 0.006,
        },
        thermal: DriverThermal {
            alpha_temp_per_k: 0.00393,
            r_th_vc_pole_k_w: 0.17,
            c_th_vc_j_k: 46.0,
            r_th_pole_mag_k_w: 0.28,
            c_th_pole_j_k: 540.0,
            r_th_mag_amb_k_w: 0.58,
            c_th_mag_j_k: 2900.0,
            forced_cooling_coeff: 1.15, // Open basket in high-velocity tap air stream!
            max_vc_temp_k: 523.15,
        },
    });

    let keystone_cab = SpeakerCabinetSpec {
        id: "keystone_18th".into(),
        name: "Keystone-18TH Dual-Side Tapped Bass Horn".into(),
        subtitle: "58×86×88 cm · 18 mm Phenolic Marine Birch · 2.56 m λ/2 Tap-Summed Path".into(),
        dims_m: [0.58, 0.86, 0.88],
        edge_round_m: 0.018,
        visual_fold_count: 2,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::phenolic_marine_birch(),
            baffle_material: PanelMaterialSpec::phenolic_marine_birch(),
            wall_thickness_m: 0.018,
            front_baffle_thickness_m: 0.024,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 3,
            driver_rebate_depth_m: 0.008,
            damping_lining_thickness_m: 0.012,
            joinery: JoineryKind::InterlockingCncTab,
        },
        ways: vec![CabinetWaySpec {
            way_id: "tapped_sub".into(),
            label: "18\" Tapped Horn".into(),
            driver_id: "tapped_sub_18".into(),
            driver_count: 1,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.38),
            enclosure: WayEnclosure::TappedHorn {
                throat_to_tap: vec![
                    HornSegmentSpec {
                        length_m: 0.95,
                        throat_area_m2: 0.068,
                        mouth_area_m2: 0.138,
                        contour: HornContour::Conical,
                        aspect_ratio: 1.3,
                    },
                    HornSegmentSpec {
                        length_m: 1.22,
                        throat_area_m2: 0.138,
                        mouth_area_m2: 0.245,
                        contour: HornContour::Exponential,
                        aspect_ratio: 1.2,
                    },
                ],
                tap_to_mouth: vec![HornSegmentSpec {
                    length_m: 0.36,
                    throat_area_m2: 0.245,
                    mouth_area_m2: 0.385,
                    contour: HornContour::Exponential,
                    aspect_ratio: 1.15,
                }],
                leakage_ql: 18.0,
            },
        }],
    };

    let tapped_dsp = DspChannelSpec {
        id: "th_band".into(),
        label: "Tapped-Horn Passband (28–92 Hz LR24)".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 27.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 92.0,
        }),
        stages: vec![BiquadStage::Peaking {
            freq_hz: 68.0,
            gain_db: -2.2,
            q: 2.1,
        }],
    };

    SystemDesignSpec {
        id: "07-tapped-horn-keystone-18".into(),
        title: "Keystone-18TH Tapped Bass Horn — λ/2 Dual-Side Loading vs Front-Loaded Horn".into(),
        category: "Coupled Subwoofer Physics".into(),
        description: "Simulates a Danley/Keystone-inspired tapped bass horn where the rear of the 18\" cone feeds an expanding 2.17 m closed-throat wave-inverting line while the front cone radiates directly into the mouth tap — delivering extraordinary 30–60 Hz output per liter with dual cone-excursion nulls.".into(),
        design_notes: vec![
            "Dual-Side Phase-Inversion Physics: Below 85 Hz, the 2.17 m throat-to-tap path delays the inverted rear wave by λ/4..λ/2 so both sides of the diaphragm sum constructively (+6 dB) at the mouth while air mass clamps cone excursion at 33 Hz and 72 Hz!".into(),
            "Tapped vs Front-Loaded Trade-Off: Compare Variant 3 (1× Keystone-18TH) against Variant 4 (1× TerraHorn-18 Front-Loaded Horn). The tapped horn wins by +3.5 dB from 30–50 Hz in a 10% smaller box and runs cooler (open magnet in high-velocity tap airflow!), but exhibits a sharp λ cancellation notch above 115 Hz — demanding a strict ≤ 92 Hz LR24 crossover.".into(),
            "Inspect the 3D CAD Cutaway & Side Blueprint: Notice the internal Tap-Junction Driver Baffle near the front mouth with both rear-throat (pink) and front-tap (cyan) paths traced in millimeters.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 20.0,
            freq_max_hz: 220.0,
            num_freqs: 72,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 68.0,
            enable_3d_bem: false,
            field_bounds_m: [-14.0, 14.0, -8.0, 24.0],
            field_grid_nx: 46,
            field_grid_ny: 46,
            listener_height_m: 1.65,
            reference_mic_m: [0.0, 10.0, 1.65],
        },
        drivers,
        cabinets: vec![keystone_cab, cabinet_terra_horn_18()],
        zones: vec![
            ListenerZone {
                id: "sub_floor".into(),
                label: "Dancefloor Center (6–16 m)".into(),
                role: "sweet_spot".into(),
                x_min_m: -6.0,
                x_max_m: 6.0,
                y_min_m: 6.0,
                y_max_m: 16.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "dj_rear".into(),
                label: "Stage / Rear (-6 to -2 m)".into(),
                role: "stage_quiet".into(),
                x_min_m: -4.0,
                x_max_m: 4.0,
                y_min_m: -6.0,
                y_max_m: -2.0,
                z_ear_m: 1.65,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "tapped_4x_stack".into(),
                label: "4× Keystone-18TH Coupled Monoblock (2×2 Stack)".into(),
                summary: "1.54 m² combined tapped-horn mouth pushes sub-bass extension smoothly down to 28 Hz with seismic authority.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![tapped_dsp.clone()],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "th_bl".into(),
                        label: "Keystone Bottom-Left".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(-0.30, 0.0, 0.0),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                    PlacedCabinet {
                        instance_id: "th_br".into(),
                        label: "Keystone Bottom-Right".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(0.30, 0.0, 0.0),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                    PlacedCabinet {
                        instance_id: "th_tl".into(),
                        label: "Keystone Top-Left".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(-0.30, 0.0, 0.89),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                    PlacedCabinet {
                        instance_id: "th_tr".into(),
                        label: "Keystone Top-Right".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(0.30, 0.0, 0.89),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                ],
            },
            SceneVariantSpec {
                variant_id: "tapped_2x_pair".into(),
                label: "2× Keystone-18TH Side-by-Side Pair".into(),
                summary: "+6 dB mutual mouth coupling over a single cabinet in a compact 1.18 m wide ground footprint.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![tapped_dsp.clone()],
                placements: vec![
                    PlacedCabinet {
                        instance_id: "th_l".into(),
                        label: "Keystone Left".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(-0.30, 0.0, 0.0),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                    PlacedCabinet {
                        instance_id: "th_r".into(),
                        label: "Keystone Right".into(),
                        cabinet_spec_id: "keystone_18th".into(),
                        transform: Transform3::at(0.30, 0.0, 0.0),
                        way_dsp_channels: vec!["th_band".into()],
                    },
                ],
            },
            SceneVariantSpec {
                variant_id: "tapped_1x_single".into(),
                label: "1× Single Keystone-18TH Tapped Horn".into(),
                summary: "Remarkable single-box 31–85 Hz output from a 439 L enclosure thanks to dual-side λ/2 radiation.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![tapped_dsp.clone()],
                placements: vec![PlacedCabinet {
                    instance_id: "th_1".into(),
                    label: "Single Keystone-18TH".into(),
                    cabinet_spec_id: "keystone_18th".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["th_band".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "front_horn_1x_ref".into(),
                label: "Shootout: 1× TerraHorn-18 Front-Loaded Horn (Same Drive)".into(),
                summary: "Overlay against 1× Keystone-18TH: front-loaded horn reaches higher in kick band, tapped horn digs deeper below 48 Hz.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![tapped_dsp],
                placements: vec![PlacedCabinet {
                    instance_id: "fh_1".into(),
                    label: "Single TerraHorn-18".into(),
                    cabinet_spec_id: "terra_horn_18".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["th_band".into()],
                }],
            },
        ],
    }
}

// ============================================================================
// Design 08: IsoPulse-212 — Dual-Opposed Force-Canceling Sealed + Linkwitz Transform Sub
// ============================================================================

fn design_08_studio_sub_linkwitz_dual12() -> SystemDesignSpec {
    let sub_drv = DriverSpec {
        id: "alu_sub_12_lt".into(),
        name: "12\" Ultra-Long-Stroke Black-Anodized Alu Subwoofer (18 mm Xmax)".into(),
        category: "studio-sub".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 6.4,
            inductance: InductanceModel::L2R2 {
                le_h: 1.15e-3,
                l2_h: 0.72e-3,
                r2_ohm: 11.5,
            },
            bl_t_m: 19.2,
            mms_kg: 0.178,
            cms_m_per_n: 0.000_195,
            creep_lambda: 0.015,
            rms_n_s_m: 4.2,
            sd_m2: 0.0510,
            xmax_m: 0.018,
            xmech_m: 0.028,
            pe_max_w: 900.0,
        },
        nonlinear: DriverNonlinear {
            bl_poly: [0.008, -0.14, -0.005, -0.03],
            kms_poly: [-0.010, 0.19, 0.010, 0.12],
            le_x_poly: [-0.06, 0.02],
            le_current_factor: 0.003,
        },
        thermal: DriverThermal::default(),
    };

    let isopulse_cab = SpeakerCabinetSpec {
        id: "isopulse_212".into(),
        name: "IsoPulse-212 Force-Canceling Dual-12\" Studio Sub".into(),
        subtitle: "42×44×43 cm (38 L Net) · 25 mm Valchromat HDF + Dual 32 mm CNC 6061-T6 Alu Baffles".into(),
        dims_m: [0.42, 0.44, 0.43],
        edge_round_m: 0.022,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::valchromat_hdf(),
            baffle_material: PanelMaterialSpec::aluminum_6061_t6(),
            wall_thickness_m: 0.025,
            front_baffle_thickness_m: 0.032,
            internal_partition_thickness_m: 0.022,
            brace_thickness_m: 0.022,
            brace_count: 1,
            driver_rebate_depth_m: 0.009,
            damping_lining_thickness_m: 0.030,
            joinery: JoineryKind::Miter45,
        },
        ways: vec![CabinetWaySpec {
            way_id: "dual12".into(),
            label: "Dual-Opposed 12\" Sealed".into(),
            driver_id: "alu_sub_12_lt".into(),
            driver_count: 2,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.215),
            enclosure: WayEnclosure::Sealed {
                volume_m3: 0.038,
                leakage_ql: 24.0,
                damping: PorousMaterial {
                    flow_resistivity_pa_s_m2: 11_000.0,
                    porosity: 0.97,
                    tortuosity: 1.04,
                    fill_fraction: 0.55,
                },
            },
        }],
    };

    let lt_dsp = DspChannelSpec {
        id: "lt_22hz".into(),
        label: "Active Linkwitz Transform (f0=58Hz → fp=21Hz, Qp=0.71)".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 17.5,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 95.0,
        }),
        stages: vec![BiquadStage::LinkwitzTransform {
            f0_hz: 58.0,
            q0: 0.96,
            fp_hz: 21.0,
            qp: 0.707,
        }],
    };

    let raw_dsp = DspChannelSpec {
        id: "raw_sealed".into(),
        label: "Uncompensated 38 L Sealed Box (No Linkwitz Transform)".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: None,
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 95.0,
        }),
        stages: vec![],
    };

    SystemDesignSpec {
        id: "08-studio-sub-linkwitz-dual12".into(),
        title: "IsoPulse-212 — Force-Canceling Dual-12\" Sealed Linkwitz-Transform Studio Sub".into(),
        category: "Studio Monitors".into(),
        description: "Ultra-compact 38-liter mastering subwoofer pairing back-to-back force-canceling 18 mm Xmax 12\" drivers in CNC 6061-T6 aluminum baffles with an active Siegfried Linkwitz biquad pole-zero transform extending flat 12 dB/oct sealed transient response down to 20 Hz.".into(),
        design_notes: vec![
            "Newtonian Force Cancellation (F_front + F_rear = 0 N): Mounting two matched 12\" motors on opposed +Y and -Y 32 mm billet-aluminum baffles coupled by internal 6061-T6 tie bars cancels linear chassis reaction forces to zero — eliminating floor/console vibration without needing a 120 kg enclosure.".into(),
            "Hoffman's Iron Law & Linkwitz Transform: Stuffing two 12\" drivers into 38 L raises the raw sealed resonance to f_0 ≈ 58 Hz, Q_0 ≈ 0.96 (Variant 2). The active Linkwitz Transform pole-zero filter cancels that pole pair and substitutes a Butterworth f_p = 21 Hz, Q_p = 0.707 response (+13 dB boost at 20 Hz, Variant 1) with zero port chuffing and < 9 ms group delay!".into(),
            "Inspect Excursion on the Nonlinear Tab: Because sealed cone excursion grows 4× per octave downward (1/f²), notice how the 2 kW Class-D amp + dual 18 mm Xmax cones earn their keep at 22 Hz.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 15.0,
            freq_max_hz: 250.0,
            num_freqs: 72,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 14.0,
            enable_3d_bem: true,
            field_bounds_m: [-4.5, 4.5, -2.5, 5.5],
            field_grid_nx: 38,
            field_grid_ny: 38,
            listener_height_m: 1.15,
            reference_mic_m: [0.0, 2.0, 1.15],
        },
        drivers: vec![sub_drv],
        cabinets: vec![isopulse_cab],
        zones: vec![ListenerZone {
            id: "mix_chair".into(),
            label: "Mastering Desk Sweet Spot (1.6–2.6 m)".into(),
            role: "sweet_spot".into(),
            x_min_m: -0.9,
            x_max_m: 0.9,
            y_min_m: 1.6,
            y_max_m: 2.6,
            z_ear_m: 1.15,
        }],
        variants: vec![
            SceneVariantSpec {
                variant_id: "active_linkwitz_21hz".into(),
                label: "Active Linkwitz Transform (Flat to 21 Hz, Qp = 0.71)".into(),
                summary: "Ruler-flat 21–85 Hz sub-bass with sealed 2nd-order transient accuracy and zero port Mach noise.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![lt_dsp],
                placements: vec![PlacedCabinet {
                    instance_id: "iso_1".into(),
                    label: "IsoPulse-212".into(),
                    cabinet_spec_id: "isopulse_212".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["lt_22hz".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "raw_uncompensated_38l".into(),
                label: "Raw 38 L Sealed Box (f0 = 58 Hz, Q0 = 0.96 — No LT)".into(),
                summary: "Shows the raw high-Q small-box response before active pole-zero Linkwitz compensation.".into(),
                boundary: BoundaryEnvironment::RigidGround2Pi,
                dsp_channels: vec![raw_dsp],
                placements: vec![PlacedCabinet {
                    instance_id: "iso_raw".into(),
                    label: "IsoPulse-212 (Raw)".into(),
                    cabinet_spec_id: "isopulse_212".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["raw_sealed".into()],
                }],
            },
        ],
    }
}

// ============================================================================
// Design 09: Chronos-MTM — Symmetric D'Appolito 3.5-Way Mastering Tower
// ============================================================================

fn design_09_mastering_tower_chronos_mtm() -> SystemDesignSpec {
    let mut drivers = studio_drivers();
    drivers.push(DriverSpec {
        id: "sub_wf_10".into(),
        name: "10\" Sandwich-Carbon Mastering Tower Subwoofer".into(),
        category: "studio-lf".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.5,
            inductance: InductanceModel::L2R2 {
                le_h: 0.88e-3,
                l2_h: 0.54e-3,
                r2_ohm: 10.5,
            },
            bl_t_m: 15.8,
            mms_kg: 0.082,
            cms_m_per_n: 0.000_36,
            creep_lambda: 0.016,
            rms_n_s_m: 2.3,
            sd_m2: 0.0345,
            xmax_m: 0.013,
            xmech_m: 0.020,
            pe_max_w: 450.0,
        },
        nonlinear: DriverNonlinear {
            bl_poly: [0.012, -0.18, -0.008, -0.03],
            kms_poly: [-0.015, 0.22, 0.01, 0.14],
            le_x_poly: [-0.07, 0.02],
            le_current_factor: 0.0035,
        },
        thermal: DriverThermal::default(),
    });
    drivers.push(DriverSpec {
        id: "mtm_mid_55".into(),
        name: "5.5\" Sliced-Paper Shorting-Ring MTM Midwoofer".into(),
        category: "studio-mf".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.9,
            inductance: InductanceModel::L2R2 {
                le_h: 0.22e-3,
                l2_h: 0.16e-3,
                r2_ohm: 11.5,
            },
            bl_t_m: 7.4,
            mms_kg: 0.0105,
            cms_m_per_n: 0.000_78,
            creep_lambda: 0.012,
            rms_n_s_m: 0.72,
            sd_m2: 0.0098,
            xmax_m: 0.0060,
            xmech_m: 0.010,
            pe_max_w: 140.0,
        },
        nonlinear: DriverNonlinear::default(),
        thermal: DriverThermal::default(),
    });

    let chronos_cab = SpeakerCabinetSpec {
        id: "chronos_mtm".into(),
        name: "Chronos-MTM Symmetric D'Appolito Mastering Tower".into(),
        subtitle: "31×44×114 cm · 21 mm CLD Viscoelastic Birch + 30 mm 6061-T6 Alu Baffle · 10\" Sub + Dual 5.5\" M-T-M".into(),
        dims_m: [0.31, 0.44, 1.14],
        edge_round_m: 0.028,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::cld_birch_laminate(),
            baffle_material: PanelMaterialSpec::aluminum_6061_t6(),
            wall_thickness_m: 0.021,
            front_baffle_thickness_m: 0.030,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 3,
            driver_rebate_depth_m: 0.007,
            damping_lining_thickness_m: 0.028,
            joinery: JoineryKind::Miter45,
        },
        ways: vec![
            CabinetWaySpec {
                way_id: "sub10".into(),
                label: "10\" Vented Sub".into(),
                driver_id: "sub_wf_10".into(),
                driver_count: 1,
                dsp_channel_index: 0,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.34),
                enclosure: WayEnclosure::Vented {
                    volume_m3: 0.058,
                    leakage_ql: 16.0,
                    port: PortSpec {
                        area_m2: 0.0092,
                        length_m: 0.31,
                        flare_radius_m: 0.020,
                        local_exit_offset: Point3::new(0.0, 0.0, 0.08),
                        local_normal: Vec3::Y,
                    },
                    damping: PorousMaterial {
                        fill_fraction: 0.22,
                        ..Default::default()
                    },
                },
            },
            CabinetWaySpec {
                way_id: "mid_lo".into(),
                label: "Lower 5.5\" MTM Mid".into(),
                driver_id: "mtm_mid_55".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.69),
                enclosure: WayEnclosure::Sealed {
                    volume_m3: 0.0065,
                    leakage_ql: 22.0,
                    damping: PorousMaterial {
                        fill_fraction: 0.45,
                        ..Default::default()
                    },
                },
            },
            CabinetWaySpec {
                way_id: "hf_be".into(),
                label: "1\" Beryllium OS-SE Tweeter".into(),
                driver_id: "be_dome_10".into(),
                driver_count: 1,
                dsp_channel_index: 2,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.84),
                enclosure: WayEnclosure::WaveguideLoaded {
                    rear_volume_m3: 0.0005,
                    throat_chamber_m3: 0.000_02,
                    waveguide: HornSegmentSpec {
                        length_m: 0.036,
                        throat_area_m2: 0.000_68,
                        mouth_area_m2: 0.0125,
                        contour: HornContour::OsSe {
                            coverage_h_deg: 95.0,
                            coverage_v_deg: 75.0,
                        },
                        aspect_ratio: 1.0,
                    },
                },
            },
            CabinetWaySpec {
                way_id: "mid_hi".into(),
                label: "Upper 5.5\" MTM Mid".into(),
                driver_id: "mtm_mid_55".into(),
                driver_count: 1,
                dsp_channel_index: 1,
                local_acoustic_offset: Point3::new(0.0, 0.0, 0.99),
                enclosure: WayEnclosure::Sealed {
                    volume_m3: 0.0065,
                    leakage_ql: 22.0,
                    damping: PorousMaterial {
                        fill_fraction: 0.45,
                        ..Default::default()
                    },
                },
            },
        ],
    };

    let aligned_dsp = vec![
        DspChannelSpec {
            id: "mtm_sub".into(),
            label: "10\" Sub (24–160 Hz LR24)".into(),
            gain_db: 2.2,
            invert_polarity: false,
            delay_s: 0.0,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 23.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 160.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: "mtm_mids".into(),
            label: "Symmetric Dual 5.5\" MTM (160–1750 Hz LR24)".into(),
            gain_db: -2.8,
            invert_polarity: false,
            delay_s: 0.000_08,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 160.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 1750.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: "mtm_hf".into(),
            label: "1\" Be OS-SE Tweeter (1.75–20 kHz LR24)".into(),
            gain_db: -5.4,
            invert_polarity: false,
            delay_s: 0.000_18,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 1750.0,
            }),
            lowpass: None,
            stages: vec![],
        },
    ];

    let high_xo_dsp = vec![
        aligned_dsp[0].clone(),
        DspChannelSpec {
            id: "mtm_mids".into(),
            label: "Dual 5.5\" MTM (Stretched to 3.3 kHz — Lobing!)".into(),
            gain_db: -2.8,
            invert_polarity: false,
            delay_s: 0.0,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 160.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 3300.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: "mtm_hf".into(),
            label: "1\" Be Tweeter (> 3.3 kHz)".into(),
            gain_db: -5.4,
            invert_polarity: false,
            delay_s: 0.0,
            highpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 3300.0,
            }),
            lowpass: None,
            stages: vec![],
        },
    ];

    SystemDesignSpec {
        id: "09-mastering-tower-chronos-mtm".into(),
        title: "Chronos-MTM — Symmetric D'Appolito Mastering Tower (CLD Birch + Billet Alu)".into(),
        category: "Studio Monitors".into(),
        description: "Full-range 25 Hz–20 kHz floorstanding mastering tower combining a symmetric Joseph D'Appolito M-T-M upper array (dual 5.5\" midwoofers flanking a shallow 6061-T6 OS-SE Beryllium tweeter) with a dedicated lower 10\" flared-slot bass-reflex subwoofer.".into(),
        design_notes: vec![
            "D'Appolito Vertical Directivity Control: Placing two 5.5\" midwoofers symmetrically ±150 mm above and below the 1\" OS-SE tweeter creates a virtual acoustic point source at z = 840 mm while narrowing vertical dispersion between 600–2000 Hz — cutting studio desk, floor, and ceiling early reflections by 4–6 dB!".into(),
            "The 2/3-Wavelength MTM Crossover Rule: Open Spinorama & Polar Sonograms and switch between Variant 1 (1.75 kHz crossover, d ≈ 0.87λ) and Variant 2 (3.3 kHz crossover, d ≈ 2.9λ). At 3.3 kHz, severe ±20° vertical interference comb nulls slice through the Vertical Sonogram and Early Reflections DI!".into(),
            "Constrained-Layer Damped (CLD) Tall Enclosure: Tall 1.14 m towers suffer severe pipe & side-wall bending resonances unless braced and damped; 21 mm CLD viscoelastic birch + 3 window braces + 2 isolated sealed MTM sub-chambers push panel coloration below -42 dB.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 22.0,
            freq_max_hz: 20_000.0,
            num_freqs: 80,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 24.0,
            enable_3d_bem: true,
            field_bounds_m: [-3.5, 3.5, -1.5, 5.0],
            field_grid_nx: 38,
            field_grid_ny: 38,
            listener_height_m: 0.84,
            reference_mic_m: [0.0, 2.5, 0.84],
        },
        drivers,
        cabinets: vec![chronos_cab],
        zones: vec![ListenerZone {
            id: "mastering_sofa".into(),
            label: "Mastering Listening Window (2.0–3.2 m)".into(),
            role: "sweet_spot".into(),
            x_min_m: -0.8,
            x_max_m: 0.8,
            y_min_m: 2.0,
            y_max_m: 3.2,
            z_ear_m: 0.84,
        }],
        variants: vec![
            SceneVariantSpec {
                variant_id: "dappolito_1750hz".into(),
                label: "Aligned D'Appolito (1.75 kHz Waveguide-Matched LR24)".into(),
                summary: "Coherent symmetric vertical main lobe with suppressed floor/ceiling bounce and smooth CTA-2034 ERDI.".into(),
                boundary: BoundaryEnvironment::Free4Pi,
                dsp_channels: aligned_dsp,
                placements: vec![PlacedCabinet {
                    instance_id: "mtm_main".into(),
                    label: "Chronos-MTM".into(),
                    cabinet_spec_id: "chronos_mtm".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["mtm_sub".into(), "mtm_mids".into(), "mtm_hf".into(), "mtm_mids".into()],
                }],
            },
            SceneVariantSpec {
                variant_id: "misaligned_3300hz".into(),
                label: "Comparison: High 3.3 kHz Crossover (Vertical MTM Lobing)".into(),
                summary: "Inspect Vertical Polar Sonogram at 2.2–3.5 kHz to see severe off-axis MTM comb nulls.".into(),
                boundary: BoundaryEnvironment::Free4Pi,
                dsp_channels: high_xo_dsp,
                placements: vec![PlacedCabinet {
                    instance_id: "mtm_hi".into(),
                    label: "Chronos-MTM (3.3 kHz XO)".into(),
                    cabinet_spec_id: "chronos_mtm".into(),
                    transform: Transform3::at(0.0, 0.0, 0.0),
                    way_dsp_channels: vec!["mtm_sub".into(), "mtm_mids".into(), "mtm_hf".into(), "mtm_mids".into()],
                }],
            },
        ],
    }
}

// ============================================================================
// Design 10: Outdoor Festival Bass Array Shootout — 4-Deep End-Fire vs CSA vs Broadside
// ============================================================================

fn design_10_festival_endfire_vs_csa() -> SystemDesignSpec {
    let sub_drv = DriverSpec {
        id: "tour_sub_18".into(),
        name: "18\" Touring Neodymium Reflex Subwoofer (15 mm Xmax)".into(),
        category: "pa-sub".into(),
        small_signal: DriverSmallSignal {
            re_ohm: 5.2,
            inductance: InductanceModel::L2R2 {
                le_h: 1.38e-3,
                l2_h: 0.88e-3,
                r2_ohm: 14.0,
            },
            bl_t_m: 26.8,
            mms_kg: 0.212,
            cms_m_per_n: 0.000_132,
            creep_lambda: 0.018,
            rms_n_s_m: 5.5,
            sd_m2: 0.122,
            xmax_m: 0.015,
            xmech_m: 0.024,
            pe_max_w: 1800.0,
        },
        nonlinear: DriverNonlinear::default(),
        thermal: DriverThermal::default(),
    };

    let tour_sub_cab = SpeakerCabinetSpec {
        id: "terravent_tour_18".into(),
        name: "TerraVent-18 Touring Bass-Reflex Sub".into(),
        subtitle: "58×72×68 cm · 18 mm 13-Ply Birch + 24 mm Baffle · 155 L Tuned to 33 Hz".into(),
        dims_m: [0.58, 0.72, 0.68],
        edge_round_m: 0.020,
        visual_fold_count: 0,
        construction: CabinetConstructionSpec {
            enclosure_material: PanelMaterialSpec::baltic_birch_ply(),
            baffle_material: PanelMaterialSpec::baltic_birch_ply(),
            wall_thickness_m: 0.018,
            front_baffle_thickness_m: 0.024,
            internal_partition_thickness_m: 0.018,
            brace_thickness_m: 0.018,
            brace_count: 2,
            driver_rebate_depth_m: 0.007,
            damping_lining_thickness_m: 0.022,
            joinery: JoineryKind::InterlockingCncTab,
        },
        ways: vec![CabinetWaySpec {
            way_id: "sub18".into(),
            label: "18\" Touring Reflex".into(),
            driver_id: "tour_sub_18".into(),
            driver_count: 1,
            dsp_channel_index: 0,
            local_acoustic_offset: Point3::new(0.0, 0.0, 0.38),
            enclosure: WayEnclosure::Vented {
                volume_m3: 0.155,
                leakage_ql: 14.0,
                port: PortSpec {
                    area_m2: 0.032,
                    length_m: 0.36,
                    flare_radius_m: 0.024,
                    local_exit_offset: Point3::new(0.0, 0.0, 0.08),
                    local_normal: Vec3::Y,
                },
                damping: PorousMaterial {
                    fill_fraction: 0.12,
                    ..Default::default()
                },
            },
        }],
    };

    // Variant 1: 4-Deep End-Fire Line along +Y (spacing d = 1.15 m, progressive delay d / c0 = 3.35 ms per rank!)
    let d_ef = 1.15_f64;
    let c0 = 343.2_f64;
    let mut ef_dsp = Vec::new();
    let mut ef_placements = Vec::new();
    for rank in 0..4 {
        let ch_id = format!("ef_rank_{rank}");
        let y_pos = (rank as f64) * d_ef;
        ef_dsp.push(DspChannelSpec {
            id: ch_id.clone(),
            label: format!("End-Fire Rank {} (+{:.2} ms)", rank + 1, (rank as f64) * d_ef / c0 * 1000.0),
            gain_db: 0.0,
            invert_polarity: false,
            delay_s: (rank as f64) * d_ef / c0,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 28.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 95.0,
            }),
            stages: vec![],
        });
        ef_placements.push(PlacedCabinet {
            instance_id: format!("ef_{rank}"),
            label: format!("End-Fire Rank #{}", rank + 1),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(0.0, y_pos, 0.0),
            way_dsp_channels: vec![ch_id],
        });
    }

    // Variant 2: 3-Front + 1-Rear Inverted Cardioid Sub Array (CSA)
    let csa_dsp = vec![
        DspChannelSpec {
            id: "csa_front".into(),
            label: "CSA Front 3× Subs (0 ms, +0 dB)".into(),
            gain_db: 0.0,
            invert_polarity: false,
            delay_s: 0.0,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 28.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 95.0,
            }),
            stages: vec![],
        },
        DspChannelSpec {
            id: "csa_rear".into(),
            label: "CSA Rear Inverted Sub (2.35 ms, -1.5 dB, 180°)".into(),
            gain_db: -1.5,
            invert_polarity: true,
            delay_s: 0.002_35,
            highpass: Some(CrossoverFilter::Butterworth {
                order: 4,
                freq_hz: 28.0,
            }),
            lowpass: Some(CrossoverFilter::LinkwitzRiley {
                order: 4,
                freq_hz: 95.0,
            }),
            stages: vec![],
        },
    ];
    let csa_placements = vec![
        PlacedCabinet {
            instance_id: "csa_fl".into(),
            label: "CSA Front-Left".into(),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(-0.62, 0.80, 0.0),
            way_dsp_channels: vec!["csa_front".into()],
        },
        PlacedCabinet {
            instance_id: "csa_fc".into(),
            label: "CSA Front-Center".into(),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(0.0, 0.80, 0.0),
            way_dsp_channels: vec!["csa_front".into()],
        },
        PlacedCabinet {
            instance_id: "csa_fr".into(),
            label: "CSA Front-Right".into(),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(0.62, 0.80, 0.0),
            way_dsp_channels: vec!["csa_front".into()],
        },
        PlacedCabinet {
            instance_id: "csa_rear_inv".into(),
            label: "CSA Rear-Facing Cancellation Sub".into(),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(0.0, 0.0, 0.0).with_aim(180.0, 0.0),
            way_dsp_channels: vec!["csa_rear".into()],
        },
    ];

    // Variant 3: 4-Wide Unsteered Broadside Wall
    let wall_dsp = vec![DspChannelSpec {
        id: "wall_flat".into(),
        label: "Broadside 4-Wide Unsteered Bus".into(),
        gain_db: 0.0,
        invert_polarity: false,
        delay_s: 0.0,
        highpass: Some(CrossoverFilter::Butterworth {
            order: 4,
            freq_hz: 28.0,
        }),
        lowpass: Some(CrossoverFilter::LinkwitzRiley {
            order: 4,
            freq_hz: 95.0,
        }),
        stages: vec![],
    }];
    let wall_placements: Vec<PlacedCabinet> = [-1.35, -0.45, 0.45, 1.35]
        .into_iter()
        .enumerate()
        .map(|(i, x)| PlacedCabinet {
            instance_id: format!("wall_{i}"),
            label: format!("Broadside Wall #{}", i + 1),
            cabinet_spec_id: "terravent_tour_18".into(),
            transform: Transform3::at(x, 0.50, 0.0),
            way_dsp_channels: vec!["wall_flat".into()],
        })
        .collect();

    SystemDesignSpec {
        id: "10-festival-endfire-vs-csa".into(),
        title: "Outdoor Bass Array Shootout — 4-Deep End-Fire Line vs 3:1 CSA vs Broadside Wall".into(),
        category: "Outdoor EDM Systems".into(),
        description: "Compares the three canonical 4-cabinet outdoor subwoofer deployments using identical 18\" touring reflex subs on open turf: a 3.45 m 4-rank End-Fire progressive delay line, a compact 3-front/1-rear Cardioid Sub Array (CSA), and a 4-wide unsteered broadside wall.".into(),
        design_notes: vec![
            "End-Fire Progressive Delay Physics (Variant 1): Spacing 4 subs 1.15 m front-to-back and delaying each forward rank by d/c_0 = 3.35 ms aligns all 4 wavefronts constructively toward the dancefloor (+Y) across the entire 30–90 Hz band while smearing rear radiation across 4 destructively phased arrivals — achieving 15–20 dB broadband stage rejection and uniform wide horizontal coverage!".into(),
            "3:1 Cardioid Sub Array (CSA, Variant 2): Uses zero stage depth (0.8 m footprint) by aiming 1 inverted/delayed sub backward to cancel the 3 forward subs behind the stack. Beats the Broadside Wall by > 13 dB in DJ-booth quietness, though sacrificing ~2.2 dB forward headroom relative to End-Fire because 1 of the 4 boxes works purely as an active absorber/canceler.".into(),
            "Broadside Wall Beaming (Variant 3): Delivers maximum coupled mutual Z_rad loading on-axis, but floods the stage behind with omnidirectional sub-bass and narrows horizontally above 65 Hz.".into(),
        ],
        environment: AmbientEnvironment::default(),
        settings: SimulationSettings {
            freq_min_hz: 22.0,
            freq_max_hz: 160.0,
            num_freqs: 68,
            small_signal_volts_rms: 2.83,
            high_spl_volts_rms: 72.0,
            enable_3d_bem: false,
            field_bounds_m: [-18.0, 18.0, -14.0, 28.0],
            field_grid_nx: 50,
            field_grid_ny: 54,
            listener_height_m: 1.65,
            reference_mic_m: [0.0, 14.0, 1.65],
        },
        drivers: vec![sub_drv],
        cabinets: vec![tour_sub_cab],
        zones: vec![
            ListenerZone {
                id: "ef_floor".into(),
                label: "Open-Field Dancefloor (7–22 m)".into(),
                role: "sweet_spot".into(),
                x_min_m: -8.0,
                x_max_m: 8.0,
                y_min_m: 7.0,
                y_max_m: 22.0,
                z_ear_m: 1.65,
            },
            ListenerZone {
                id: "ef_stage".into(),
                label: "DJ Booth / Stage Deck (-9 to -2.5 m)".into(),
                role: "stage_quiet".into(),
                x_min_m: -5.0,
                x_max_m: 5.0,
                y_min_m: -9.0,
                y_max_m: -2.5,
                z_ear_m: 1.65,
            },
        ],
        variants: vec![
            SceneVariantSpec {
                variant_id: "endfire_4deep".into(),
                label: "4-Deep End-Fire Line (1.15 m Spacing · 3.35 ms/rank)".into(),
                summary: "All 4 subs sum in-phase forward with wide horizontal coverage and deep broadband rear cancellation.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 200_000.0,
                },
                dsp_channels: ef_dsp,
                placements: ef_placements,
            },
            SceneVariantSpec {
                variant_id: "csa_3_to_1".into(),
                label: "3-Front / 1-Rear Cardioid Sub Array (Compact CSA)".into(),
                summary: "Compact footprint with a deep heart-shaped rear stage null right over the DJ deck.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 200_000.0,
                },
                dsp_channels: csa_dsp,
                placements: csa_placements,
            },
            SceneVariantSpec {
                variant_id: "broadside_4wide".into(),
                label: "4-Wide Unsteered Broadside Wall (High Rear Spill)".into(),
                summary: "Maximum mutual Z_rad loading on-axis, but loud stage spill (-Y) and horizontal narrowing.".into(),
                boundary: BoundaryEnvironment::OpenFieldTurf {
                    flow_resistivity_pa_s_m2: 200_000.0,
                },
                dsp_channels: wall_dsp,
                placements: wall_placements,
            },
        ],
    }
}

/// Run the live Dual-AD Bayesian calibration solver whenever bundle `06-prototype-bayesian-calibration` executes!
pub fn maybe_run_embedded_calibration(
    design_id: &str,
    air: &AirProperties,
) -> Option<CalibrationReportData> {
    if design_id != "06-prototype-bayesian-calibration" {
        return None;
    }

    let prior = VentedCalibrationPrior {
        driver: DriverSmallSignal {
            re_ohm: 5.30,
            inductance: InductanceModel::Simple { le_h: 1.30e-3 },
            bl_t_m: 25.0,
            mms_kg: 0.195,
            cms_m_per_n: 0.000_125,
            creep_lambda: 0.0,
            rms_n_s_m: 5.1,
            sd_m2: 0.120,
            xmax_m: 0.014,
            xmech_m: 0.022,
            pe_max_w: 1400.0,
        },
        box_volume_m3: 0.145,
        port: PortSpec {
            area_m2: 0.026,
            length_m: 0.34,
            flare_radius_m: 0.022,
            local_exit_offset: Point3::ORIGIN,
            local_normal: Vec3::Y,
        },
        leakage_ql: 14.0,
        meas_volts_rms: 2.83,
        mic_distance_m: 2.0,
    };

    let truth = [
        5.48,      // Re
        23.4,      // Bl
        0.204,     // Mms
        0.000_154, // Cms (+23.2% spider break-in)
        5.70,      // Rms
        1.48e-3,   // Le
        0.134,     // Vb (-7.6% internal bracing displacement)
        0.368,     // L_port
        4.30,      // Q_L (leaky gasket!)
    ];
    let truth_duals: Vec<DualVec> = truth.iter().map(|&v| DualVec::constant(v, 9)).collect();

    let freqs = logspace(18.0, 320.0, 64);
    let mut free_zma = Vec::new();
    let mut inbox_zma = Vec::new();
    let mut spl_frd = Vec::new();

    for (k, &f) in freqs.iter().enumerate() {
        let nz = 0.03 * ((k as f64 * 1.9).sin());
        let ns = 0.09 * ((k as f64 * 2.7).cos());

        let zf = eval_free_air_dual_impedance(&truth_duals, f);
        free_zma.push(ImpedanceCurvePoint {
            freq_hz: f,
            z_ohm: Complex64::new(zf.re.val + nz, zf.im.val - 0.5 * nz),
        });

        let (zb, spl) = eval_vented_dual_model(
            &truth_duals,
            prior.driver.sd_m2,
            prior.port.area_m2,
            prior.meas_volts_rms,
            prior.mic_distance_m,
            f,
            air,
        );
        inbox_zma.push(ImpedanceCurvePoint {
            freq_hz: f,
            z_ohm: Complex64::new(zb.re.val - nz, zb.im.val + 0.4 * nz),
        });
        spl_frd.push(FrdCurvePoint {
            freq_hz: f,
            spl_db: spl.val + ns,
            phase_deg: 0.0,
        });
    }

    Some(calibrate_vented_prototype(
        &prior,
        Some(&free_zma),
        &inbox_zma,
        &spl_frd,
        Some(truth),
        air,
    ))
}
