//! Moist air thermophysical properties and ISO 9613-1 outdoor atmospheric attenuation [Ref #29].

use serde::{Deserialize, Serialize};

/// Ambient environmental state in SI units.
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AmbientEnvironment {
    /// Ambient air temperature in Kelvin (293.15 K = 20.0 C).
    pub temperature_k: f64,
    /// Barometric static pressure in Pascals (101_325.0 Pa = 1 atm).
    pub pressure_pa: f64,
    /// Relative humidity in `[0.0, 1.0]` (e.g. `0.50` = 50% RH).
    pub relative_humidity: f64,
}

impl Default for AmbientEnvironment {
    fn default() -> Self {
        Self {
            temperature_k: 293.15,
            pressure_pa: 101_325.0,
            relative_humidity: 0.50,
        }
    }
}

/// Derived thermophysical air constants at a specific `AmbientEnvironment` [Ref #29].
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AirProperties {
    pub env: AmbientEnvironment,
    /// Equilibrium density `rho_0` (`kg / m^3`).
    pub density_kg_m3: f64,
    /// Adiabatic speed of sound `c` (`m / s`).
    pub sound_speed_m_s: f64,
    /// Dynamic shear viscosity `mu` (`Pa * s`).
    pub viscosity_pa_s: f64,
    /// Thermal conductivity `kappa` (`W / (m * K)`).
    pub thermal_conductivity: f64,
    /// Specific heat ratio `gamma = Cp / Cv`.
    pub gamma: f64,
    /// Isobaric specific heat `Cp` (`J / (kg * K)`).
    pub cp_j_kg_k: f64,
    /// Prandtl number `Pr = mu * Cp / kappa`.
    pub prandtl: f64,
}

impl Default for AirProperties {
    fn default() -> Self {
        Self::from_environment(AmbientEnvironment::default())
    }
}

impl AirProperties {
    /// Compute moist-air properties via Cramer (1993) / ISO 9613-1 [Ref #29].
    pub fn from_environment(env: AmbientEnvironment) -> Self {
        let t = env.temperature_k.clamp(233.15, 343.15);
        let p = env.pressure_pa.clamp(50_000.0, 120_000.0);
        let rh = env.relative_humidity.clamp(0.0, 1.0);

        // Saturation vapor pressure (ISO 9613-1 Eq. B.2)
        let t01 = 273.16;
        let c_sat = -6.8346 * (t01 / t).powf(1.261) + 4.6151;
        let p_sat = 101_325.0 * 10.0_f64.powf(c_sat);
        let h_molar = rh * p_sat / p; // molar fraction of water vapor

        // Molar mass of moist air (dry air 0.02896546 kg/mol, water 0.01801528 kg/mol)
        let r_univ = 8.314_462_618;
        let m_mix = 0.028_965_46 * (1.0 - h_molar) + 0.018_015_28 * h_molar;
        let r_spec = r_univ / m_mix;
        let density_kg_m3 = p / (r_spec * t);

        // Specific heat ratio of moist air (Cramer 1993)
        let gamma = 1.400_3 - 4.5e-5 * (t - 273.15) - 0.058 * h_molar;
        let sound_speed_m_s = (gamma * r_spec * t).sqrt();
        let cp_j_kg_k = gamma * r_spec / (gamma - 1.0);

        // Sutherland's law for dynamic viscosity & thermal conductivity
        let viscosity_pa_s = 1.827e-5 * (291.15 + 120.0) / (t + 120.0) * (t / 291.15).powf(1.5);
        let thermal_conductivity = 0.0241 * (t / 273.15).powf(0.86);
        let prandtl = viscosity_pa_s * cp_j_kg_k / thermal_conductivity;

        Self {
            env,
            density_kg_m3,
            sound_speed_m_s,
            viscosity_pa_s,
            thermal_conductivity,
            gamma,
            cp_j_kg_k,
            prandtl,
        }
    }

    /// Characteristic plane-wave specific acoustic impedance `rho_0 * c` (`Rayl`).
    #[inline]
    pub fn z0(&self) -> f64 {
        self.density_kg_m3 * self.sound_speed_m_s
    }

    /// Wavenumber `k = 2 * pi * f / c` (`rad / m`).
    #[inline]
    pub fn wavenumber(&self, freq_hz: f64) -> f64 {
        2.0 * std::f64::consts::PI * freq_hz / self.sound_speed_m_s
    }

    /// ISO 9613-1:1993 outdoor atmospheric sound attenuation coefficient in `dB / m` [Ref #29].
    /// Critical for accurate open-field range & high-frequency throw modeling at 15–60 m.
    pub fn atmospheric_attenuation_db_per_m(&self, freq_hz: f64) -> f64 {
        let t = self.env.temperature_k;
        let t0 = 293.15;
        let t01 = 273.16;
        let p_pa = self.env.pressure_pa;
        let pr = 101_325.0;
        let p_rel = p_pa / pr;
        let t_rel = t / t0;

        let c_sat = -6.8346 * (t01 / t).powf(1.261) + 4.6151;
        let h_pct = (self.env.relative_humidity * 100.0).clamp(0.5, 100.0) * 10.0_f64.powf(c_sat)
            / p_rel;

        // Oxygen and Nitrogen vibrational relaxation frequencies (Hz)
        let f_ro = p_rel * (24.0 + 4.04e4 * h_pct * (0.02 + h_pct) / (0.391 + h_pct));
        let f_rn = p_rel
            * t_rel.powf(-0.5)
            * (9.0 + 280.0 * h_pct * (-4.170 * (t_rel.powf(-1.0 / 3.0) - 1.0)).exp());

        let f2 = freq_hz * freq_hz;
        let term_class = 1.84e-11 * (1.0 / p_rel) * t_rel.sqrt();
        let term_o2 = 0.01275 * (-2239.1 / t).exp() / (f_ro + f2 / f_ro);
        let term_n2 = 0.1068 * (-3352.0 / t).exp() / (f_rn + f2 / f_rn);

        8.686 * f2 * (term_class + t_rel.powf(-2.5) * (term_o2 + term_n2))
    }
}
