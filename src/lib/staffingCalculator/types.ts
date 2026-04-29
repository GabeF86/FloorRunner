// Shared types for the per-facility staffing calculators.
// Each facility (Lankenau, Paoli, BMH, Riddle) defines its own algorithm
// because the site categories, ratios, and special-role conventions differ.

export type StaffType = 'MD' | 'CRNA';

export interface StaffAssignment {
  id: string;
  type: StaffType;
  role: string;            // e.g. "OR Supv 1", "OB MD", "Endo CRNA 2"
  site: string;            // e.g. "Main OR", "OB", "Endo", "Float"
  isSolo?: boolean;
  isFloat?: boolean;
  is8101?: boolean;        // Lankenau-specific schedule-runner flag
  isFloorRunner?: boolean; // Paoli-specific schedule-runner flag
  isCardiac?: boolean;
  isAddOn?: boolean;
  isTEE?: boolean;
  supervisedBy?: string | null;  // id of MD supervising this CRNA
  supervises?: string[];          // ids of CRNAs this MD supervises
  notes?: string;
}

export interface Contingency {
  fromId: string;
  toId: string;
  type: string;
  label: string;
}

export interface BreakSource {
  label: string;
  count: number;
  breaks: number;
  detail: string;
}

export interface BreakAnalysis {
  demand: number;
  capacity: number;
  sources: BreakSource[];
  gap: number;
  pct: number;
  severity: 'ok' | 'tight' | 'warning' | 'critical';
  unrelieved: number;
}

export interface CalculatorOutput {
  totalMDs: number;
  totalCRNAs: number;
  totalStaff: number;
  assignments: StaffAssignment[];
  notes: string[];
  contingencies: Contingency[];
  breakAnalysis: BreakAnalysis;
}

// Each facility's cfg shape is its own thing — Lankenau has APC/Cardiac/EP+TEE,
// Paoli has Endo+TEE/Neuro Lab/EP Lab, etc. We keep it as a generic record so
// each module can declare its own fields, and the page renders inputs based on
// the schema below.
export type CalculatorConfig = Record<string, number | boolean>;

export interface AvailableStaff {
  mds: number;
  crnas: number;
}

// Describes one input field on the configuration panel.
// `kind` controls the input widget; `bounds` only applies to numbers.
export interface ConfigField {
  key: string;
  label: string;
  section: string;          // group heading (e.g. "MAIN OR", "APC")
  kind: 'number' | 'toggle';
  defaultValue: number | boolean;
  min?: number;
  max?: number;
  helpText?: string;
  // If set, the field only renders when this predicate is true. Lets us
  // hide DCCV/TEE toggle when EP rooms = 0, etc.
  visibleWhen?: (cfg: CalculatorConfig) => boolean;
  // Optional accent color for the stepper buttons / toggle.
  accentColor?: string;
}

// Lane definition for the by-site visualization. Each entry corresponds to
// a `StaffAssignment.site` value the algorithm produces. Order = visual
// order in the diagram; sites with zero MDs/CRNAs are skipped at render time.
export interface SiteCatalogEntry {
  key: string;          // matches StaffAssignment.site
  label: string;        // human label shown in the lane
  color: string;        // accent color for the lane border + MD outline
  icon?: string;        // optional emoji
}

// One facility's full module — schema + algorithm + display metadata.
// Adding a new facility means dropping a file matching this shape into
// staffingCalculator/ and registering it in index.ts.
export interface FacilityCalculator {
  facilityId: string;       // matches `Site.hospital` strings used elsewhere
  facilityName: string;     // display label
  abbreviation: string;     // top-bar pill text (e.g. "Lank")
  schema: ConfigField[];
  defaultConfig: CalculatorConfig;
  /** Pure function — returns the output for a given cfg + available staff. */
  calculate: (cfg: CalculatorConfig, avail: AvailableStaff) => CalculatorOutput;
  // Marker so the UI can disable/grey out facilities that aren't built yet.
  status: 'ready' | 'placeholder';
  // Drives the by-site diagram. Optional — without it, lanes render in the
  // order assignments appear, with neutral colors.
  siteCatalog?: SiteCatalogEntry[];
}
