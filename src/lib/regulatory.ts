/**
 * Kenyan regulatory rules that do not need a database.
 *
 * Everything here is pure so it can be unit-tested without Postgres, and so
 * commands and queries share one definition of "expiring", "expired" and
 * "missing" instead of drifting apart.
 */

export const REGULATORY_DOMAINS = [
  "kmpdc",
  "sha",
  "odpc",
  "tax",
  "pharmacy",
  "laboratory",
  "imaging",
  "quality",
] as const;

export type RegulatoryDomain = (typeof REGULATORY_DOMAINS)[number];

export const READINESS_STATUSES = ["compliant", "expiring", "expired", "missing"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const LICENCE_STATUSES = ["active", "expiring", "expired", "suspended", "pending"] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

export const REGULATOR_CODES = ["kmpdc", "ppb", "kmlttb", "nck", "rpb", "other"] as const;
export type RegulatorCode = (typeof REGULATOR_CODES)[number];

export const SUPPORT_SERVICE_TYPES = [
  "pharmacy",
  "laboratory",
  "imaging",
  "ambulance",
  "mortuary",
  "theatre",
] as const;
export type SupportServiceType = (typeof SUPPORT_SERVICE_TYPES)[number];

export const FACILITY_OWNERSHIPS = ["public", "faith_based", "private", "ngo"] as const;
export type FacilityOwnership = (typeof FACILITY_OWNERSHIPS)[number];

export const KEPH_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** KMPDC facility licence categories published for the 2025 renewal cycle. */
export const KMPDC_FACILITY_CATEGORIES = [
  "dispensary",
  "faith_based_dispensary",
  "medical_clinic",
  "eye_clinic",
  "dental_clinic",
  "mobile_clinic",
  "health_centre",
  "basic_health_centre",
  "medical_centre",
  "comprehensive_centre",
  "dental_centre",
  "funeral_home",
  "maternity_home",
  "nursing_home",
  "cottage_hospital",
  "faith_based_level_4",
  "hospital_level_4",
  "faith_based_specialised_tertiary",
  "hospital_level_5",
  "eye_hospital_level_5",
] as const;
export type KmpdcFacilityCategory = (typeof KMPDC_FACILITY_CATEGORIES)[number];

/** KRA PIN: P, nine digits, one uppercase letter. */
export const KRA_PIN_PATTERN = /^P\d{9}[A-Z]$/;

export function normalizeKraPin(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidKraPin(value: string | null | undefined): boolean {
  if (!value) return false;
  return KRA_PIN_PATTERN.test(normalizeKraPin(value));
}

/** Whole-day difference; negative means the target is in the past. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const start = startOfDay(from);
  const end = startOfDay(to);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export function daysUntil(expiry: Date | string | null | undefined, today: Date | string = new Date()): number | null {
  if (!expiry) return null;
  return daysBetween(today, expiry);
}

function startOfDay(value: Date | string): Date {
  const date = typeof value === "string" ? parseIsoDate(value) : value;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return new Date(value);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/**
 * Derive the licence state from its expiry date.
 *
 * `pending` means no expiry has been recorded yet, which the readiness view
 * reports as `missing` rather than pretending the facility is compliant.
 */
export function licenceStatusFor(
  expiryDate: Date | string | null | undefined,
  today: Date | string = new Date(),
  warnDays = 30,
): LicenceStatus {
  const days = daysUntil(expiryDate, today);
  if (days === null) return "pending";
  if (days < 0) return "expired";
  if (days <= warnDays) return "expiring";
  return "active";
}

/** Map a licence state onto the four readiness states the UI understands. */
export function readinessFor(status: LicenceStatus): ReadinessStatus {
  switch (status) {
    case "active":
      return "compliant";
    case "expiring":
      return "expiring";
    case "expired":
    case "suspended":
      return "expired";
    case "pending":
    default:
      return "missing";
  }
}

export interface ReadinessDomainResult {
  domain: RegulatoryDomain;
  status: ReadinessStatus;
  daysToExpiry: number | null;
  detail: string;
}

export interface ReadinessInput {
  today?: Date | string;
  warnDays?: number;
  /** Domain-specific expiry and recorded status. Missing fields mean `missing`. */
  kmpdc?: { expiry: Date | string | null; status?: LicenceStatus };
  odpc?: { expiry: Date | string | null; status?: LicenceStatus };
  sha?: { status?: "active" | "suspended" | "expired" | "terminated" | null };
  tax?: { kraPin?: string | null };
  pharmacy?: { expiry: Date | string | null; status?: LicenceStatus };
  laboratory?: { expiry: Date | string | null; status?: LicenceStatus };
  imaging?: { expiry: Date | string | null; status?: LicenceStatus };
  quality?: { certExpiry?: Date | string | null };
}

/** Compute the readiness of every domain from the recorded regulator facts. */
export function deriveReadiness(input: ReadinessInput = {}): ReadinessDomainResult[] {
  const today = input.today ?? new Date();
  const warnDays = input.warnDays ?? 30;

  const fromLicence = (
    domain: RegulatoryDomain,
    value: { expiry: Date | string | null; status?: LicenceStatus } | undefined,
    detail: string,
  ): ReadinessDomainResult => {
    if (!value?.expiry && !value?.status) {
      return { domain, status: "missing", daysToExpiry: null, detail: `${detail}: not recorded` };
    }
    const status = value.status ?? licenceStatusFor(value.expiry, today, warnDays);
    return {
      domain,
      status: readinessFor(status),
      daysToExpiry: daysUntil(value.expiry, today),
      detail,
    };
  };

  const shaStatus = input.sha?.status ?? null;
  const sha: ReadinessDomainResult = shaStatus
    ? {
        domain: "sha",
        status: shaStatus === "active" ? "compliant" : shaStatus === "suspended" ? "expired" : "expired",
        daysToExpiry: null,
        detail: "SHA empanelment",
      }
    : { domain: "sha", status: "missing", daysToExpiry: null, detail: "SHA empanelment: not recorded" };

  return [
    fromLicence("kmpdc", input.kmpdc, "KMPDC facility licence"),
    sha,
    fromLicence("odpc", input.odpc, "ODPC data-protection registration"),
    input.tax?.kraPin && isValidKraPin(input.tax.kraPin)
      ? { domain: "tax", status: "compliant", daysToExpiry: null, detail: "KRA PIN recorded" }
      : { domain: "tax", status: "missing", daysToExpiry: null, detail: "KRA PIN: not recorded" },
    fromLicence("pharmacy", input.pharmacy, "Pharmacy licence (PPB)"),
    fromLicence("laboratory", input.laboratory, "Laboratory licence (KMLTTB)"),
    fromLicence("imaging", input.imaging, "Imaging licence (Radiation Protection Board)"),
    fromLicence("quality", input.quality?.certExpiry ? { expiry: input.quality.certExpiry } : undefined, "Quality certification"),
  ];
}

export type SettingDomain =
  | "regulatory"
  | "privacy"
  | "reporting"
  | "tax"
  | "sha"
  | "payroll"
  | "quality";

export const SETTING_DOMAINS: SettingDomain[] = [
  "regulatory",
  "privacy",
  "reporting",
  "tax",
  "sha",
  "payroll",
  "quality",
];

export type SettingDataType = "text" | "integer" | "decimal" | "boolean" | "date" | "enum" | "json";

export interface RegulatorySettingDefinition {
  domain: SettingDomain;
  key: string;
  label: string;
  description: string;
  dataType: SettingDataType;
  required: boolean;
  secret?: boolean;
  allowedValues?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  defaultValue: string | number | boolean | null;
}

/**
 * The regulator values this build could not confirm from a primary source.
 * Each is a seeded row an administrator edits; none is hard-coded in logic.
 */
export const REGULATORY_SETTINGS: RegulatorySettingDefinition[] = [
  {
    domain: "regulatory",
    key: "licence_warn_days",
    label: "Licence warning window (days)",
    description: "A licence inside this window is reported as expiring rather than compliant.",
    dataType: "integer",
    required: true,
    min: 1,
    max: 365,
    defaultValue: 30,
  },
  {
    domain: "regulatory",
    key: "enforcement_mode",
    label: "Enforcement mode",
    description: "Enforced blocks billing and claiming on an expired licence. Advisory only warns.",
    dataType: "enum",
    required: true,
    allowedValues: ["advisory", "enforced"],
    defaultValue: "enforced",
  },
  {
    domain: "reporting",
    key: "khis_submission_mode",
    label: "KHIS submission mode",
    description: "Manual means staff upload the exported file. API means Varian submits to KHIS directly.",
    dataType: "enum",
    required: true,
    allowedValues: ["manual", "api"],
    defaultValue: "manual",
  },
  {
    domain: "reporting",
    key: "khis_api_url",
    label: "KHIS API URL",
    description: "Required only when the submission mode is API.",
    dataType: "text",
    required: false,
    pattern: "^https?://",
    defaultValue: null,
  },
  {
    domain: "reporting",
    key: "khis_org_unit_id",
    label: "KHIS organisation unit",
    description: "The DHIS2 organisation unit identifier for this facility.",
    dataType: "text",
    required: false,
    defaultValue: null,
  },
  {
    domain: "quality",
    key: "quality_bill_status",
    label: "Quality Bill status",
    description: "Tracking only. The draft Quality Healthcare and Patient Safety Bill is never enforced in logic.",
    dataType: "enum",
    required: true,
    allowedValues: ["pending", "enacted", "withdrawn"],
    defaultValue: "pending",
  },
  {
    domain: "privacy",
    key: "dsar_sla_days",
    label: "Data-subject request SLA (days)",
    description: "Days from receipt to the due date on an access, correction or erasure request.",
    dataType: "integer",
    required: true,
    min: 1,
    max: 180,
    defaultValue: 30,
  },
  {
    domain: "privacy",
    key: "breach_notification_hours",
    label: "Breach notification window (hours)",
    description: "Hours from discovery before an un-notified breach is flagged as overdue.",
    dataType: "integer",
    required: true,
    min: 1,
    max: 720,
    defaultValue: 72,
  },
  {
    domain: "privacy",
    key: "consent_validity_months",
    label: "Consent validity (months)",
    description: "How long a recorded consent stays current before it must be renewed.",
    dataType: "integer",
    required: true,
    min: 1,
    max: 120,
    defaultValue: 12,
  },
  {
    domain: "tax",
    key: "invoice_prefix",
    label: "Invoice prefix",
    description: "The facility's invoice series prefix, used on every tax invoice.",
    dataType: "text",
    required: true,
    pattern: "^[A-Z]{2,6}$",
    defaultValue: "FAH",
  },
];

export function settingDefinition(domain: SettingDomain, key: string) {
  return REGULATORY_SETTINGS.find((setting) => setting.domain === domain && setting.key === key);
}

export interface SettingValueColumns {
  valueText: string | null;
  valueNumeric: number | null;
  valueJson: unknown | null;
}

export type SettingValidation =
  | { ok: true; columns: SettingValueColumns }
  | { ok: false; error: string };

/** Validate and coerce one setting value according to its definition. */
export function validateSettingValue(
  definition: RegulatorySettingDefinition,
  raw: unknown,
): SettingValidation {
  const empty = raw === null || raw === undefined || raw === "";
  if (empty) {
    if (definition.required) return { ok: false, error: `${definition.label} is required` };
    return { ok: true, columns: { valueText: null, valueNumeric: null, valueJson: null } };
  }

  switch (definition.dataType) {
    case "integer": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(value)) return { ok: false, error: `${definition.label} must be a whole number` };
      if (definition.min !== undefined && value < definition.min) {
        return { ok: false, error: `${definition.label} must be at least ${definition.min}` };
      }
      if (definition.max !== undefined && value > definition.max) {
        return { ok: false, error: `${definition.label} must be at most ${definition.max}` };
      }
      return { ok: true, columns: { valueText: String(value), valueNumeric: value, valueJson: null } };
    }
    case "decimal": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return { ok: false, error: `${definition.label} must be a number` };
      if (definition.min !== undefined && value < definition.min) {
        return { ok: false, error: `${definition.label} must be at least ${definition.min}` };
      }
      if (definition.max !== undefined && value > definition.max) {
        return { ok: false, error: `${definition.label} must be at most ${definition.max}` };
      }
      return { ok: true, columns: { valueText: String(value), valueNumeric: value, valueJson: null } };
    }
    case "boolean": {
      const value = raw === true || raw === "true" || raw === "1" || raw === 1;
      return { ok: true, columns: { valueText: String(value), valueNumeric: null, valueJson: null } };
    }
    case "enum": {
      const value = String(raw).trim();
      if (definition.allowedValues && !definition.allowedValues.includes(value)) {
        return {
          ok: false,
          error: `${definition.label} must be one of ${definition.allowedValues.join(", ")}`,
        };
      }
      return { ok: true, columns: { valueText: value, valueNumeric: null, valueJson: null } };
    }
    case "date": {
      const value = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: `${definition.label} must be a date (YYYY-MM-DD)` };
      }
      return { ok: true, columns: { valueText: value, valueNumeric: null, valueJson: null } };
    }
    case "json": {
      try {
        const value = typeof raw === "string" ? JSON.parse(raw) : raw;
        return { ok: true, columns: { valueText: null, valueNumeric: null, valueJson: value } };
      } catch {
        return { ok: false, error: `${definition.label} must be valid JSON` };
      }
    }
    case "text":
    default: {
      const value = String(raw).trim();
      if (definition.pattern && !new RegExp(definition.pattern).test(value)) {
        return { ok: false, error: `${definition.label} has an invalid format` };
      }
      return { ok: true, columns: { valueText: value, valueNumeric: null, valueJson: null } };
    }
  }
}

/** Resolve a stored setting row to the value the UI shows. */
export function settingDisplayValue(row: {
  valueText: string | null;
  valueNumeric: unknown;
  valueJson: unknown;
  dataType: SettingDataType;
}): string {
  if (row.dataType === "json") return row.valueJson == null ? "" : JSON.stringify(row.valueJson);
  if (row.dataType === "integer" || row.dataType === "decimal") {
    return row.valueNumeric == null ? (row.valueText ?? "") : String(row.valueNumeric);
  }
  return row.valueText ?? "";
}
