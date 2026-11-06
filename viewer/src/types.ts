export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform3 {
  position: Point3;
  yaw_deg: number;
  pitch_deg: number;
  roll_deg: number;
}

export interface PlacedCabinet {
  instance_id: string;
  label: string;
  cabinet_spec_id: string;
  transform: Transform3;
  way_dsp_channels: string[];
}

export interface ListenerZone {
  id: string;
  label: string;
  role: string;
  x_min_m: number;
  x_max_m: number;
  y_min_m: number;
  y_max_m: number;
  z_ear_m: number;
}

export interface VisualSubMesh {
  name: string;
  role: string;
  color_hex: string;
  opacity: number;
  part_id: string;
  layer: string;
  material_name: string;
  thickness_mm: number;
  cut_dims_mm: [number, number, number];
  mass_kg: number;
  explode_offset_m: [number, number, number];
  notes: string;
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface SectionPolygon2D {
  part_id: string;
  label: string;
  material_kind: string;
  color_hex: string;
  thickness_mm: number;
  points_mm: [number, number][];
  is_dashed: boolean;
}

export interface SectionPath2D {
  label: string;
  color_hex: string;
  points_mm: [number, number][];
  dashed: boolean;
  arrow_end: boolean;
}

export interface SectionDimension2D {
  p0_mm: [number, number];
  p1_mm: [number, number];
  offset_mm: number;
  label: string;
}

export interface SectionLabel2D {
  pos_mm: [number, number];
  text: string;
  color_hex: string;
}

export interface CrossSectionBlueprint2D {
  view_id: string;
  title: string;
  plane_caption: string;
  u_label: string;
  v_label: string;
  bounds_mm: [number, number, number, number];
  polygons: SectionPolygon2D[];
  paths: SectionPath2D[];
  dimensions: SectionDimension2D[];
  labels: SectionLabel2D[];
}

export interface CabinetStructuralSummary {
  enclosure_material_name: string;
  baffle_material_name: string;
  joinery_label: string;
  finish_label: string;
  density_kg_m3: number;
  youngs_modulus_gpa: number;
  poisson_ratio: number;
  loss_factor_eta: number;
  baffle_density_kg_m3: number;
  baffle_youngs_modulus_gpa: number;
  wall_thickness_mm: number;
  baffle_thickness_mm: number;
  partition_thickness_mm: number;
  brace_thickness_mm: number;
  rebate_depth_mm: number;
  damping_thickness_mm: number;
  brace_count: number;
  flexural_rigidity_nm: number;
  baffle_rigidity_nm: number;
  gross_external_volume_l: number;
  shell_wall_displacement_l: number;
  internal_partitions_displacement_l: number;
  drivers_and_damping_displacement_l: number;
  net_internal_air_volume_l: number;
  woodwork_mass_kg: number;
  drivers_mass_kg: number;
  damping_and_hardware_mass_kg: number;
  total_mass_kg: number;
  largest_unbraced_span_mm: [number, number];
  largest_braced_span_mm: [number, number];
  unbraced_f11_hz: number;
  braced_f11_hz: number;
  panel_stl_low_freq_db: number;
  modal_freqs_hz: number[];
  braced_coloration_db: number[];
  unbraced_coloration_db: number[];
}

export interface VisualCabinetModel {
  model_id: string;
  title: string;
  subtitle: string;
  dims_m: [number, number, number];
  structural: CabinetStructuralSummary;
  sections_2d: CrossSectionBlueprint2D[];
  submeshes: VisualSubMesh[];
}

export interface SpinoramaData {
  freqs_hz: number[];
  on_axis_db: number[];
  listening_window_db: number[];
  early_reflections_db: number[];
  sound_power_db: number[];
  directivity_index_db: number[];
  erdi_db: number[];
}

export interface DirectivityBalloonData {
  freqs_hz: number[];
  angles_deg: number[];
  horizontal_spl_db: number[][];
  vertical_spl_db: number[][];
  balloon_freqs_hz: number[];
  theta_deg: number[];
  phi_deg: number[];
  balloon_spl_db: number[][];
  solver_method: string;
}

export interface VariantSweepCurves {
  freqs_hz: number[];
  spl_small_signal_db: number[];
  spl_high_drive_db: number[];
  spl_uncoupled_baseline_db: number[];
  phase_deg: number[];
  group_delay_ms: number[];
  per_way_spl_db: [string, number[]][];
  impedance_mag_ohm: number[];
  impedance_phase_deg: number[];
  normalized_radiation_resistance: number[];
  cone_excursion_mm: number[];
  xmax_limit_mm: number;
  port_mach: number[];
  thd_percent: number[];
  hd2_db_rel: number[];
  hd3_db_rel: number[];
  dc_shift_mm: number[];
  vc_temp_c: number[];
  power_compression_db: number[];
  dsp_mag_db: [string, number[]][];
}

export interface SpatialFieldData {
  bounds_m: [number, number, number, number];
  nx: number;
  ny: number;
  z_ear_m: number;
  slice_freqs_hz: number[];
  spl_slices_db: number[][];
  wave_real_slices: number[][];
  transient_times_ms: number[];
  transient_frames: number[][];
}

export interface ZoneMetrics {
  zone_id: string;
  label: string;
  role: string;
  bass_mean_spl_db: number;
  bass_spatial_std_db: number;
  bass_min_max_spread_db: number;
  mid_high_mean_spl_db: number;
  mid_high_spatial_std_db: number;
}

export interface VirtualMicImpulse {
  label: string;
  position_m: [number, number, number];
  sample_rate_hz: number;
  taps: number[];
}

export interface SimulatedVariant {
  variant_id: string;
  label: string;
  summary: string;
  placements: PlacedCabinet[];
  curves: VariantSweepCurves;
  spinorama: SpinoramaData;
  directivity: DirectivityBalloonData;
  spatial_field: SpatialFieldData;
  zone_metrics: ZoneMetrics[];
  virtual_mics: VirtualMicImpulse[];
}

export interface CalibratedParameterRow {
  name: string;
  unit: string;
  prior_value: number;
  posterior_value: number;
  ci95_low: number;
  ci95_high: number;
  ground_truth: number | null;
}

export interface CalibrationReportData {
  summary: string;
  freqs_hz: number[];
  prior_z_mag_ohm: number[];
  measured_z_mag_ohm: number[];
  posterior_z_mag_ohm: number[];
  prior_spl_db: number[];
  measured_spl_db: number[];
  posterior_spl_db: number[];
  prior_rms_error_db: number;
  posterior_rms_error_db: number;
  parameters: CalibratedParameterRow[];
  parameter_names: string[];
  correlation_matrix: number[][];
  diagnostics: string[];
}

export interface SimulationBundle {
  schema_version: number;
  id: string;
  title: string;
  category: string;
  description: string;
  design_notes: string[];
  reference_mic_m: [number, number, number];
  high_spl_volts_rms: number;
  zones: ListenerZone[];
  cabinet_models: VisualCabinetModel[];
  variants: SimulatedVariant[];
  calibration: CalibrationReportData | null;
}

export interface SimulationManifestEntry {
  id: string;
  title: string;
  category: string;
  subtitle: string;
  bundle_path: string;
  variant_count: number;
  has_calibration: boolean;
}

export interface SimulationManifest {
  generated_at: string;
  simulations: SimulationManifestEntry[];
}

export type PanelMaterialKind =
  | 'baltic_birch13_ply'
  | 'high_density_mdf'
  | 'valchromat_hdf'
  | 'phenolic_marine_birch'
  | 'cast_aluminum6061'
  | 'cld_birch_viscoelastic';

export type JoineryKind = 'rabbet_dado' | 'miter45' | 'interlocking_cnc_tab';

export interface ParametricBaselineInfo {
  design_id: string;
  cabinet_idx: number;
  cabinet_id: string;
  cabinet_name: string;
  variant_idx: number;
  variant_label: string;
  topology: string;
  has_linkwitz_transform: boolean;
  placement_count: number;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  edge_round_mm: number;
  enclosure_material: PanelMaterialKind;
  baffle_material: PanelMaterialKind;
  wall_thickness_mm: number;
  baffle_thickness_mm: number;
  brace_count: number;
  joinery: JoineryKind;
  base_chamber_liters: number;
  port_length_mm: number;
  port_area_cm2: number;
  port_flare_mm: number;
  horn_path_length_m: number;
  horn_mouth_area_cm2: number;
  slot_area_cm2: number;
  slot_path_mm: number;
  slot_flow_resistivity: number;
  lt_target_fp_hz: number;
  lt_target_qp: number;
  primary_driver_name: string;
  primary_bl_tm: number;
  primary_mms_g: number;
  high_spl_volts_rms: number;
}

export interface ParametricPatch {
  cabinet_idx: number;
  variant_idx: number;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  edge_round_mm: number;
  enclosure_material: PanelMaterialKind;
  baffle_material: PanelMaterialKind;
  wall_thickness_mm: number;
  baffle_thickness_mm: number;
  brace_count: number;
  joinery: JoineryKind;
  chamber_volume_scale: number;
  port_length_mm: number;
  port_area_cm2: number;
  port_flare_mm: number;
  horn_length_scale: number;
  horn_mouth_scale: number;
  slot_area_cm2: number;
  slot_path_mm: number;
  slot_flow_resistivity: number;
  lt_target_fp_hz: number;
  lt_target_qp: number;
  motor_bl_scale: number;
  moving_mass_scale: number;
  high_spl_volts_rms: number;
  lf_gain_trim_db: number;
  crossover_scale: number;
  sub_delay_trim_ms: number;
  array_spacing_scale: number;
  include_3d_bem: boolean;
}

export interface ParametricSimulationOutput {
  high_spl_volts_rms: number;
  cabinet_models: VisualCabinetModel[];
  simulated_variant: SimulatedVariant;
  modified_toml: string;
}

export interface DesignEncyclopediaEntry {
  design_id: string;
  short_name: string;
  archetype: string;
  family_badge: string;
  use_case: string;
  bandwidth_spec: string;
  radiation_pattern: string;
  efficiency_class: string;
  physics_principle: string;
  why_it_sounds_distinct: string;
  strengths: string[];
  tradeoffs: string[];
  heritage_inspirations: string[];
  material_rationale: string;
  simulator_experiments: string[];
}

export interface TopologyReferenceCard {
  id: string;
  name: string;
  kind: 'enclosure' | 'sub_array';
  rolloff_slope: string;
  typical_sensitivity: string;
  group_delay_profile: string;
  rear_rejection: string;
  mechanism_summary: string;
  when_to_choose: string;
  example_design_ids: string[];
}

export interface DesignEncyclopediaDatabase {
  schema_version: number;
  designs: DesignEncyclopediaEntry[];
  topologies: TopologyReferenceCard[];
}
