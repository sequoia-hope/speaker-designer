//! Electro-mechano-acoustic transducer schemas (Small-Signal + Klippel Nonlinear + 3-Node Thermal).

use serde::{Deserialize, Serialize};

/// Lossy voice-coil inductance & eddy-current impedance model [Ref #8].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum InductanceModel {
    /// Classical lossless series inductance `j * omega * le_h`.
    Simple { le_h: f64 },
    /// Thorborg / Klippel two-element eddy-current shunt (`Le` in series with `L2 || R2`).
    /// Realizable directly in both frequency-domain MNA and time-domain ODE integration!
    L2R2 { le_h: f64, l2_h: f64, r2_ohm: f64 },
    /// Leach (2002) skin-effect lossy inductance `Z_L = K * (j * omega)^alpha` (`0 < alpha < 1`).
    Leach { k_leach: f64, alpha: f64 },
    /// Wright (1990) four-parameter empirical eddy-current model.
    Wright {
        kr: f64,
        er: f64,
        kx: f64,
        ex: f64,
    },
}

impl Default for InductanceModel {
    fn default() -> Self {
        Self::L2R2 {
            le_h: 0.8e-3,
            l2_h: 0.6e-3,
            r2_ohm: 12.0,
        }
    }
}

/// Small-signal linear electro-mechanical transducer parameters in SI units [Ref #1, #9].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DriverSmallSignal {
    /// DC voice-coil resistance at 293.15 K (`Ohm`).
    pub re_ohm: f64,
    /// Lossy inductance / eddy-current model.
    #[serde(default)]
    pub inductance: InductanceModel,
    /// Force factor `B * l` (`T * m` = `N / A`).
    pub bl_t_m: f64,
    /// Moving mass `M_ms` (`kg`, standard datasheet total moving mass; dry `M_md` derived automatically).
    pub mms_kg: f64,
    /// Mechanical suspension compliance `C_ms` (`m / N`).
    pub cms_m_per_n: f64,
    /// Viscoelastic logarithmic suspension creep factor (`dimensionless`, typically `0.0..0.08`) [Ref #9].
    #[serde(default)]
    pub creep_lambda: f64,
    /// Mechanical suspension resistance `R_ms` (`N * s / m`).
    pub rms_n_s_m: f64,
    /// Effective projected piston area `S_d` (`m^2`).
    pub sd_m2: f64,
    /// One-way linear excursion limit `X_max` (`m`).
    pub xmax_m: f64,
    /// One-way hard mechanical damage limit `X_mech` (`m`).
    pub xmech_m: f64,
    /// Continuous thermal power rating (`W`).
    #[serde(default = "default_pe_w")]
    pub pe_max_w: f64,
}

fn default_pe_w() -> f64 {
    500.0
}

impl DriverSmallSignal {
    /// Equivalent piston radius `a = sqrt(S_d / pi)` (`m`).
    #[inline]
    pub fn piston_radius_m(&self) -> f64 {
        (self.sd_m2 / std::f64::consts::PI).sqrt()
    }

    /// Dry diaphragm + voice-coil mass `M_md` (`kg`), subtracting standard infinite-baffle air load
    /// `2 * (8/3) * rho_0 * a^3` so 3D mutual/BEM radiation mass is never double-counted!
    #[inline]
    pub fn dry_mass_kg(&self, air_density: f64) -> f64 {
        let a = self.piston_radius_m();
        let air_load = (16.0 / 3.0) * air_density * a.powi(3);
        (self.mms_kg - air_load).max(0.25 * self.mms_kg)
    }

    /// Nominal free-air resonance `f_s` (`Hz`).
    #[inline]
    pub fn fs_hz(&self) -> f64 {
        1.0 / (2.0 * std::f64::consts::PI * (self.mms_kg * self.cms_m_per_n).sqrt())
    }

    /// Electrical Q factor `Q_es` at `f_s`.
    #[inline]
    pub fn qes(&self) -> f64 {
        let ws = 2.0 * std::f64::consts::PI * self.fs_hz();
        (ws * self.mms_kg * self.re_ohm) / (self.bl_t_m * self.bl_t_m)
    }

    /// Mechanical Q factor `Q_ms` at `f_s`.
    #[inline]
    pub fn qms(&self) -> f64 {
        let ws = 2.0 * std::f64::consts::PI * self.fs_hz();
        (ws * self.mms_kg) / self.rms_n_s_m
    }

    /// Total Q factor `Q_ts`.
    #[inline]
    pub fn qts(&self) -> f64 {
        let qes = self.qes();
        let qms = self.qms();
        (qes * qms) / (qes + qms)
    }

    /// Equivalent compliance volume `V_as` (`m^3`) at given air properties.
    #[inline]
    pub fn vas_m3(&self, rho0: f64, c: f64) -> f64 {
        rho0 * c * c * self.cms_m_per_n * self.sd_m2 * self.sd_m2
    }
}

/// Klippel large-signal nonlinear motor & suspension polynomial coefficients [Ref #20].
/// Normalized to `X_max` (`u = x / X_max`) so coefficients are dimensionless and immediately interpretable!
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DriverNonlinear {
    /// `Bl(x) = Bl_0 * (1 + b1*(x/Xmax) + b2*(x/Xmax)^2 + b3*(x/Xmax)^3 + b4*(x/Xmax)^4)`.
    /// Typically `b2 < 0` (~ `-0.22` to `-0.35` so `Bl` drops ~30% at `X_max`), `b1` captures coil offset asymmetry.
    pub bl_poly: [f64; 4],
    /// `K_ms(x) = K_ms0 * (1 + k1*(x/Xmax) + k2*(x/Xmax)^2 + k3*(x/Xmax)^3 + k4*(x/Xmax)^4)`.
    /// Typically `k2 > 0, k4 > 0` (progressive spider stiffening at high excursion).
    pub kms_poly: [f64; 4],
    /// `L_e(x, i) = L_e0 * (1 + l1*(x/Xmax) + l2*(x/Xmax)^2) * (1 + li * i)`.
    ///Typically `l1 < 0` (inductance higher when coil moves inward over iron pole piece -> reluctance force!).
    pub le_x_poly: [f64; 2],
    pub le_current_factor: f64,
}

impl Default for DriverNonlinear {
    fn default() -> Self {
        Self {
            bl_poly: [0.03, -0.26, -0.02, -0.06],
            kms_poly: [-0.04, 0.35, 0.03, 0.25],
            le_x_poly: [-0.18, 0.05],
            le_current_factor: 0.008,
        }
    }
}

/// Three-node forced-convection electro-thermal model (`Voice Coil -> Pole/Gap -> Magnet -> Ambient`) [Ref #22].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DriverThermal {
    /// Temperature coefficient of voice-coil resistance (`1 / K`; Copper = `0.00393`, Aluminum = `0.00403`).
    pub alpha_temp_per_k: f64,
    /// Thermal resistance coil-to-gap at zero air velocity (`K / W`).
    pub r_th_vc_pole_k_w: f64,
    /// Thermal capacitance of voice coil + former (`J / K`).
    pub c_th_vc_j_k: f64,
    /// Thermal resistance pole/gap-to-magnet (`K / W`).
    pub r_th_pole_mag_k_w: f64,
    /// Thermal capacitance of pole/top-plate (`J / K`).
    pub c_th_pole_j_k: f64,
    /// Thermal resistance magnet-to-ambient (`K / W`).
    pub r_th_mag_amb_k_w: f64,
    /// Thermal capacitance of magnet assembly (`J / K`).
    pub c_th_mag_j_k: f64,
    /// Forced air-convection cooling coefficient `gamma_conv` (`(s / m)^0.6`) reducing `r_th_vc_pole` when cone moves!
    pub forced_cooling_coeff: f64,
    /// Safe continuous voice-coil temperature limit (`K`, e.g. `493.15 K` = `220 C`).
    pub max_vc_temp_k: f64,
}

impl Default for DriverThermal {
    fn default() -> Self {
        Self {
            alpha_temp_per_k: 0.00393,
            r_th_vc_pole_k_w: 0.28,
            c_th_vc_j_k: 24.0,
            r_th_pole_mag_k_w: 0.45,
            c_th_pole_j_k: 380.0,
            r_th_mag_amb_k_w: 0.95,
            c_th_mag_j_k: 2200.0,
            forced_cooling_coeff: 0.85,
            max_vc_temp_k: 503.15,
        }
    }
}

/// Complete transducer specification combining small-signal, large-signal, and thermal physics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DriverSpec {
    pub id: String,
    pub name: String,
    /// Nominal diameter in inches or descriptive category (`"18-inchhorn-sub"`, `"8.5-inch-woofer"`, `"1-inch-dome"`).
    pub category: String,
    pub small_signal: DriverSmallSignal,
    #[serde(default)]
    pub nonlinear: DriverNonlinear,
    #[serde(default)]
    pub thermal: DriverThermal,
}
