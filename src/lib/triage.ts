export const TRIAGE_CATEGORIES = ["red", "yellow", "green"] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_CATEGORY_LABELS: Record<TriageCategory, string> = {
  red: "Emergency",
  yellow: "Priority",
  green: "Non-urgent",
};

export const TRIAGE_CATEGORY_RANK: Record<TriageCategory, number> = {
  green: 0,
  yellow: 1,
  red: 2,
};

export const MEASUREMENT_KEYS = [
  "systolic",
  "diastolic",
  "heartRate",
  "respRate",
  "temperature",
  "spo2",
  "weightKg",
  "heightCm",
  "painScore",
  "muacCm",
] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export const VITAL_KEYS = [...MEASUREMENT_KEYS, "bmi"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

export const VITAL_INPUT_LIMITS: Record<MeasurementKey, { min: number; max: number }> = {
  systolic: { min: 40, max: 300 },
  diastolic: { min: 20, max: 200 },
  heartRate: { min: 20, max: 250 },
  respRate: { min: 4, max: 80 },
  temperature: { min: 30, max: 45 },
  spo2: { min: 50, max: 100 },
  weightKg: { min: 0.5, max: 400 },
  heightCm: { min: 20, max: 250 },
  painScore: { min: 0, max: 10 },
  muacCm: { min: 5, max: 60 },
};

export type VitalFlag = "normal" | "warning" | "critical";
export type VitalDirection = "low" | "high" | null;

export interface VitalInput {
  systolic?: number | null;
  diastolic?: number | null;
  heartRate?: number | null;
  respRate?: number | null;
  temperature?: number | null;
  spo2?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  painScore?: number | null;
  muacCm?: number | null;
}

export interface VitalRange {
  criticalLow?: number;
  warningLow?: number;
  warningHigh?: number;
  criticalHigh?: number;
}

export interface VitalDefinition {
  label: string;
  unit: string;
  range: VitalRange;
}

export const VITAL_DEFINITIONS: Record<VitalKey, VitalDefinition> = {
  systolic: {
    label: "Systolic",
    unit: "mmHg",
    range: { criticalLow: 70, warningLow: 90, warningHigh: 139, criticalHigh: 179 },
  },
  diastolic: {
    label: "Diastolic",
    unit: "mmHg",
    range: { criticalLow: 40, warningLow: 60, warningHigh: 89, criticalHigh: 119 },
  },
  heartRate: {
    label: "Heart rate",
    unit: "bpm",
    range: { criticalLow: 40, warningLow: 60, warningHigh: 100, criticalHigh: 130 },
  },
  respRate: {
    label: "Respiratory rate",
    unit: "breaths/min",
    range: { criticalLow: 8, warningLow: 12, warningHigh: 20, criticalHigh: 29 },
  },
  temperature: {
    label: "Temperature",
    unit: "°C",
    range: { criticalLow: 35, warningLow: 36.1, warningHigh: 37.5, criticalHigh: 38.5 },
  },
  spo2: {
    label: "SpO₂",
    unit: "%",
    range: { criticalLow: 90, warningLow: 95 },
  },
  weightKg: {
    label: "Weight",
    unit: "kg",
    range: {},
  },
  heightCm: {
    label: "Height",
    unit: "cm",
    range: {},
  },
  bmi: {
    label: "BMI",
    unit: "kg/m²",
    range: { criticalLow: 16, warningLow: 18.5, warningHigh: 24.9, criticalHigh: 40 },
  },
  painScore: {
    label: "Pain score",
    unit: "0–10",
    range: { warningHigh: 3, criticalHigh: 6 },
  },
  muacCm: {
    label: "MUAC",
    unit: "cm",
    range: { criticalLow: 11.5, warningLow: 12.5 },
  },
};

export interface VitalAssessment {
  key: VitalKey;
  label: string;
  unit: string;
  value: number;
  flag: VitalFlag;
  direction: VitalDirection;
}

export function calculateBmi(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number | null {
  if (weightKg == null || heightCm == null) return null;
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm)) return null;
  if (weightKg <= 0 || heightCm <= 0) return null;

  const heightMetres = heightCm / 100;
  const bmi = weightKg / (heightMetres * heightMetres);
  return Math.round(bmi * 10) / 10;
}

function classify(value: number, range: VitalRange): { flag: VitalFlag; direction: VitalDirection } {
  if (range.criticalLow !== undefined && value < range.criticalLow) {
    return { flag: "critical", direction: "low" };
  }
  if (range.criticalHigh !== undefined && value > range.criticalHigh) {
    return { flag: "critical", direction: "high" };
  }
  if (range.warningLow !== undefined && value < range.warningLow) {
    return { flag: "warning", direction: "low" };
  }
  if (range.warningHigh !== undefined && value > range.warningHigh) {
    return { flag: "warning", direction: "high" };
  }
  return { flag: "normal", direction: null };
}

export function assessVitals(input: VitalInput): Partial<Record<VitalKey, VitalAssessment>> {
  const bmi = calculateBmi(input.weightKg, input.heightCm);
  const values: Record<VitalKey, number | null | undefined> = {
    systolic: input.systolic,
    diastolic: input.diastolic,
    heartRate: input.heartRate,
    respRate: input.respRate,
    temperature: input.temperature,
    spo2: input.spo2,
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    bmi,
    painScore: input.painScore,
    muacCm: input.muacCm,
  };

  const assessments: Partial<Record<VitalKey, VitalAssessment>> = {};

  for (const key of VITAL_KEYS) {
    const value = values[key];
    if (value == null || !Number.isFinite(value)) continue;

    const definition = VITAL_DEFINITIONS[key];
    const classification = classify(value, definition.range);
    assessments[key] = {
      key,
      label: definition.label,
      unit: definition.unit,
      value,
      flag: classification.flag,
      direction: classification.direction,
    };
  }

  return assessments;
}

export function deriveTriageCategory(
  assessments: Partial<Record<VitalKey, VitalAssessment>>,
): TriageCategory {
  const values = Object.values(assessments);
  if (values.some((assessment) => assessment?.flag === "critical")) return "red";
  if (values.some((assessment) => assessment?.flag === "warning")) return "yellow";
  return "green";
}

export function hasAnyVital(input: VitalInput): boolean {
  return MEASUREMENT_KEYS.some((key) => input[key] != null);
}

export function isCategoryAtLeast(
  category: TriageCategory,
  minimum: TriageCategory,
): boolean {
  return TRIAGE_CATEGORY_RANK[category] >= TRIAGE_CATEGORY_RANK[minimum];
}

export function formatBmi(bmi: number | null): string {
  return bmi == null ? "—" : bmi.toFixed(1);
}

export function ageFromDob(dob: string | null, now: Date = new Date()): number | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;

  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;

  return age >= 0 ? age : null;
}
