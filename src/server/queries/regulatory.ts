import { and, asc, desc, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";

import {
  REGULATORY_SETTINGS,
  deriveReadiness,
  settingDefinition,
  settingDisplayValue,
  type ReadinessDomainResult,
  type RegulatoryDomain,
  type SettingDataType,
  type SettingDomain,
} from "@/lib/regulatory";
import { db } from "@/server/db/client";
import {
  facilityIdentifiers,
  facilityLicences,
  facilityRegulatoryProfiles,
  facilitySettings,
  integrationSettings,
  licenceAlertRules,
  practitionerRegistrations,
  shaAdjudicationCodes,
  staffProfiles,
  staffRoleScopes,
  statutoryFeeSchedules,
  statutoryRates,
  supportServiceLicences,
  user,
} from "@/server/db/schema";

export type RegulatoryDatabase = typeof db;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Facility profile and licences                                       */
/* ------------------------------------------------------------------ */

export interface FacilityRegulatoryProfileRow {
  facilityId: string;
  kmpdcNumber: string | null;
  kmhflId: string | null;
  kephLevel: number | null;
  facilityCategory: string | null;
  ownership: string | null;
  county: string | null;
  subCounty: string | null;
  constituency: string | null;
  ward: string | null;
  licenceNo: string | null;
  licenceIssueDate: string | null;
  licenceExpiryDate: string | null;
  licenceStatus: string;
  indemnityProvider: string | null;
  indemnityNo: string | null;
  indemnityExpiryDate: string | null;
  shaFacilityCode: string | null;
  shaEmpanelmentStatus: string | null;
  odpcRegistrationNo: string | null;
  odpcCategory: string | null;
  odpcExpiryDate: string | null;
  kraPin: string | null;
  tccNo: string | null;
  tccExpiryDate: string | null;
  nssfEmployerCode: string | null;
  shifEmployerCode: string | null;
  kemsaSupplierCode: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export async function getFacilityRegulatoryProfile(
  database: RegulatoryDatabase,
  facilityId: string,
): Promise<FacilityRegulatoryProfileRow | null> {
  const rows = await database
    .select()
    .from(facilityRegulatoryProfiles)
    .where(eq(facilityRegulatoryProfiles.facilityId, facilityId))
    .limit(1);
  return (rows[0] as FacilityRegulatoryProfileRow | undefined) ?? null;
}

export async function listFacilityLicences(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { licenceType?: string } = {},
) {
  const filters: SQL[] = [eq(facilityLicences.facilityId, facilityId)];
  if (options.licenceType) filters.push(eq(facilityLicences.licenceType, options.licenceType));

  return database
    .select()
    .from(facilityLicences)
    .where(and(...filters))
    .orderBy(desc(facilityLicences.expiryDate));
}

/* ------------------------------------------------------------------ */
/* Practitioners and support services                                  */
/* ------------------------------------------------------------------ */

/** Staff a practitioner registration can point at, scoped to the facility. */
export async function listFacilityStaffProfiles(
  database: RegulatoryDatabase,
  facilityId: string,
) {
  return database
    .select({
      staffProfileId: staffProfiles.id,
      name: user.name,
      staffNumber: staffProfiles.staffNumber,
      role: staffRoleScopes.role,
    })
    .from(staffProfiles)
    .innerJoin(user, eq(staffProfiles.userId, user.id))
    .innerJoin(
      staffRoleScopes,
      and(
        eq(staffRoleScopes.userId, staffProfiles.userId),
        eq(staffRoleScopes.facilityId, facilityId),
      ),
    )
    .orderBy(asc(user.name));
}

export async function listPractitionerRegistrations(  database: RegulatoryDatabase,
  facilityId: string,
  options: { regulator?: string; expiringWithinDays?: number; today?: string } = {},
) {
  const filters: SQL[] = [eq(practitionerRegistrations.facilityId, facilityId)];
  if (options.regulator) {
    filters.push(
      eq(
        practitionerRegistrations.regulator,
        options.regulator as typeof practitionerRegistrations.regulator.enumValues[number],
      ),
    );
  }
  if (options.expiringWithinDays !== undefined) {
    const today = options.today ?? todayIso();
    const until = new Date(`${today}T00:00:00.000Z`);
    until.setUTCDate(until.getUTCDate() + options.expiringWithinDays);
    filters.push(
      lte(practitionerRegistrations.licenceExpiryDate, until.toISOString().slice(0, 10)),
    );
  }

  return database
    .select()
    .from(practitionerRegistrations)
    .where(and(...filters))
    .orderBy(asc(practitionerRegistrations.licenceExpiryDate));
}

export async function listSupportServiceLicences(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { serviceType?: string } = {},
) {
  const filters: SQL[] = [eq(supportServiceLicences.facilityId, facilityId)];
  if (options.serviceType) {
    filters.push(
      eq(
        supportServiceLicences.serviceType,
        options.serviceType as typeof supportServiceLicences.serviceType.enumValues[number],
      ),
    );
  }

  return database
    .select()
    .from(supportServiceLicences)
    .where(and(...filters))
    .orderBy(asc(supportServiceLicences.expiryDate));
}

export async function listLicenceAlertRules(
  database: RegulatoryDatabase,
  facilityId: string,
) {
  return database
    .select()
    .from(licenceAlertRules)
    .where(eq(licenceAlertRules.facilityId, facilityId))
    .orderBy(asc(licenceAlertRules.subjectType));
}

export async function getFacilityIdentifiers(  database: RegulatoryDatabase,
  facilityId: string,
) {
  return database
    .select()
    .from(facilityIdentifiers)
    .where(eq(facilityIdentifiers.facilityId, facilityId))
    .orderBy(asc(facilityIdentifiers.identifierType));
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface FacilitySettingRow {
  id: string;
  domain: SettingDomain;
  key: string;
  valueText: string | null;
  valueNumeric: string | null;
  valueJson: unknown;
  dataType: SettingDataType;
  allowedValues: string[] | null;
  minValue: string | null;
  maxValue: string | null;
  regex: string | null;
  isRequired: boolean;
  isSecret: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  /** Human-readable value, never a secret. */
  displayValue: string;
  /** The label the settings screen renders. */
  label: string;
  description: string;
  /** True when the definition is required but no row is in force. */
  missing: boolean;
}

/** The row in force on a date: latest `effective_from` not after it. */
export async function getFacilitySetting(
  database: RegulatoryDatabase,
  facilityId: string,
  domain: SettingDomain,
  key: string,
  onDate: string = todayIso(),
): Promise<FacilitySettingRow | null> {
  const rows = await database
    .select()
    .from(facilitySettings)
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, domain),
        eq(facilitySettings.key, key),
        lte(facilitySettings.effectiveFrom, onDate),
        or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, onDate)),
      ),
    )
    .orderBy(desc(facilitySettings.effectiveFrom))
    .limit(1);

  const row = rows[0];
  return row ? decorateSetting(row) : null;
}

function decorateSetting(row: {
  id: string;
  domain: string;
  key: string;
  valueText: string | null;
  valueNumeric: string | null;
  valueJson: unknown;
  dataType: string;
  allowedValues: string[] | null;
  minValue: string | null;
  maxValue: string | null;
  regex: string | null;
  isRequired: boolean;
  isSecret: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): FacilitySettingRow {
  const definition = settingDefinition(row.domain as SettingDomain, row.key);
  return {
    ...row,
    domain: row.domain as SettingDomain,
    dataType: row.dataType as SettingDataType,
    displayValue: settingDisplayValue({
      valueText: row.valueText,
      valueNumeric: row.valueNumeric,
      valueJson: row.valueJson,
      dataType: row.dataType as SettingDataType,
    }),
    label: definition?.label ?? row.key,
    description: definition?.description ?? "",
    missing: false,
  };
}

/**
 * Every setting in force on a date, including the definitions that have no row
 * yet. A fresh facility therefore renders the whole screen and reports
 * `missing` instead of throwing.
 */
export async function listFacilitySettings(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { domain?: SettingDomain; onDate?: string } = {},
): Promise<FacilitySettingRow[]> {
  const onDate = options.onDate ?? todayIso();
  const filters: SQL[] = [
    eq(facilitySettings.facilityId, facilityId),
    lte(facilitySettings.effectiveFrom, onDate),
    or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, onDate))!,
  ];
  if (options.domain) filters.push(eq(facilitySettings.domain, options.domain));

  const rows = await database
    .selectDistinctOn([facilitySettings.domain, facilitySettings.key])
    .from(facilitySettings)
    .where(and(...filters))
    .orderBy(
      asc(facilitySettings.domain),
      asc(facilitySettings.key),
      desc(facilitySettings.effectiveFrom),
    );

  const inForce = new Map(rows.map((row) => [`${row.domain}:${row.key}`, decorateSetting(row)]));

  for (const definition of REGULATORY_SETTINGS) {
    if (options.domain && definition.domain !== options.domain) continue;
    const key = `${definition.domain}:${definition.key}`;
    if (inForce.has(key)) continue;
    inForce.set(key, {
      id: "",
      domain: definition.domain,
      key: definition.key,
      valueText: null,
      valueNumeric: null,
      valueJson: null,
      dataType: definition.dataType,
      allowedValues: definition.allowedValues ?? null,
      minValue: definition.min !== undefined ? String(definition.min) : null,
      maxValue: definition.max !== undefined ? String(definition.max) : null,
      regex: definition.pattern ?? null,
      isRequired: definition.required,
      isSecret: definition.secret ?? false,
      effectiveFrom: onDate,
      effectiveTo: null,
      updatedBy: null,
      updatedAt: new Date(0),
      displayValue: "",
      label: definition.label,
      description: definition.description,
      missing: true,
    });
  }

  return [...inForce.values()].sort((a, b) =>
    `${a.domain}:${a.key}`.localeCompare(`${b.domain}:${b.key}`),
  );
}

/* ------------------------------------------------------------------ */
/* Statutory tables                                                    */
/* ------------------------------------------------------------------ */

export async function listStatutoryRates(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { rateType?: string; onDate?: string } = {},
) {
  const onDate = options.onDate ?? todayIso();
  const filters: SQL[] = [
    eq(statutoryRates.facilityId, facilityId),
    eq(statutoryRates.active, true),
    lte(statutoryRates.effectiveFrom, onDate),
    or(isNull(statutoryRates.effectiveTo), gte(statutoryRates.effectiveTo, onDate))!,
  ];
  if (options.rateType) filters.push(eq(statutoryRates.rateType, options.rateType));

  return database
    .select()
    .from(statutoryRates)
    .where(and(...filters))
    .orderBy(asc(statutoryRates.rateType), asc(statutoryRates.bandOrder));
}

export async function listStatutoryFeeSchedules(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { authority?: string } = {},
) {
  const filters: SQL[] = [eq(statutoryFeeSchedules.facilityId, facilityId)];
  if (options.authority) filters.push(eq(statutoryFeeSchedules.authority, options.authority));

  return database
    .select()
    .from(statutoryFeeSchedules)
    .where(and(...filters))
    .orderBy(asc(statutoryFeeSchedules.authority), asc(statutoryFeeSchedules.category));
}

export async function listShaAdjudicationCodes(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { includeInactive?: boolean } = {},
) {
  const filters: SQL[] = [eq(shaAdjudicationCodes.facilityId, facilityId)];
  if (!options.includeInactive) filters.push(eq(shaAdjudicationCodes.active, true));

  return database
    .select()
    .from(shaAdjudicationCodes)
    .where(and(...filters))
    .orderBy(asc(shaAdjudicationCodes.code));
}

export async function getIntegrationSetting(
  database: RegulatoryDatabase,
  facilityId: string,
  integration: typeof integrationSettings.integration.enumValues[number],
  environment: typeof integrationSettings.environment.enumValues[number],
) {
  const rows = await database
    .select()
    .from(integrationSettings)
    .where(
      and(
        eq(integrationSettings.facilityId, facilityId),
        eq(integrationSettings.integration, integration),
        eq(integrationSettings.environment, environment),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listIntegrationSettings(
  database: RegulatoryDatabase,
  facilityId: string,
) {
  return database
    .select()
    .from(integrationSettings)
    .where(eq(integrationSettings.facilityId, facilityId))
    .orderBy(asc(integrationSettings.integration), asc(integrationSettings.environment));
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

export interface ReadinessReport {
  facilityId: string;
  asOf: string;
  warnDays: number;
  domains: ReadinessDomainResult[];
  overall: "compliant" | "attention" | "blocked";
}

async function readinessWarnDays(
  database: RegulatoryDatabase,
  facilityId: string,
): Promise<number> {
  const setting = await getFacilitySetting(
    database,
    facilityId,
    "regulatory",
    "licence_warn_days",
  );
  const value = setting?.valueNumeric ? Number(setting.valueNumeric) : 30;
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export async function getFacilityReadinessStatus(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { today?: string } = {},
): Promise<ReadinessReport> {
  const asOf = options.today ?? todayIso();
  const [profile, licences, identifiers, warnDays] = await Promise.all([
    getFacilityRegulatoryProfile(database, facilityId),
    database
      .select()
      .from(supportServiceLicences)
      .where(
        and(
          eq(supportServiceLicences.facilityId, facilityId),
          eq(supportServiceLicences.active, true),
        ),
      ),
    database
      .select()
      .from(facilityIdentifiers)
      .where(eq(facilityIdentifiers.facilityId, facilityId)),
    readinessWarnDays(database, facilityId),
  ]);

  const latestByType = new Map<string, { expiryDate: string | null; status: string }>();
  for (const licence of licences) {
    const current = latestByType.get(licence.serviceType);
    if (!current || (licence.expiryDate ?? "") > (current.expiryDate ?? "")) {
      latestByType.set(licence.serviceType, {
        expiryDate: licence.expiryDate,
        status: licence.status,
      });
    }
  }

  const qualityCertificate = identifiers
    .filter((identifier) => identifier.identifierType === "quality_certificate" && identifier.validTo)
    .sort((a, b) => (b.validTo ?? "").localeCompare(a.validTo ?? ""))[0];

  const domains = deriveReadiness({
    today: asOf,
    warnDays,
    kmpdc: profile?.licenceExpiryDate
      ? { expiry: profile.licenceExpiryDate, status: profile.licenceStatus as never }
      : undefined,
    odpc: profile?.odpcExpiryDate
      ? { expiry: profile.odpcExpiryDate }
      : undefined,
    sha: profile?.shaEmpanelmentStatus
      ? {
          status: profile.shaEmpanelmentStatus as
            | "active"
            | "suspended"
            | "expired"
            | "terminated",
        }
      : undefined,
    tax: { kraPin: profile?.kraPin ?? null },
    pharmacy: latestByType.get("pharmacy")
      ? {
          expiry: latestByType.get("pharmacy")!.expiryDate,
          status: latestByType.get("pharmacy")!.status as never,
        }
      : undefined,
    laboratory: latestByType.get("laboratory")
      ? {
          expiry: latestByType.get("laboratory")!.expiryDate,
          status: latestByType.get("laboratory")!.status as never,
        }
      : undefined,
    imaging: latestByType.get("imaging")
      ? {
          expiry: latestByType.get("imaging")!.expiryDate,
          status: latestByType.get("imaging")!.status as never,
        }
      : undefined,
    quality: qualityCertificate
      ? { certExpiry: qualityCertificate.validTo }
      : undefined,
  });

  const overall = domains.some((domain) => domain.status === "expired")
    ? "blocked"
    : domains.some((domain) => domain.status === "expiring" || domain.status === "missing")
      ? "attention"
      : "compliant";

  return { facilityId, asOf, warnDays, domains, overall };
}

/* ------------------------------------------------------------------ */
/* Expiring licences                                                   */
/* ------------------------------------------------------------------ */

export interface ExpiringLicenceRow {
  subjectType: "facility" | "practitioner" | "support_service";
  id: string;
  reference: string;
  label: string;
  expiryDate: string;
  daysToExpiry: number;
  status: string;
}

/**
 * Every licence inside the requested window, across all three subject types.
 * A licence expiring today (0 days) is inside a 0-day window; a licence that
 * expired yesterday is never returned.
 */
export async function listExpiringLicences(
  database: RegulatoryDatabase,
  facilityId: string,
  options: { withinDays?: number; subjectType?: ExpiringLicenceRow["subjectType"]; today?: string } = {},
): Promise<ExpiringLicenceRow[]> {
  const today = options.today ?? todayIso();
  const withinDays = options.withinDays ?? 30;
  const until = new Date(`${today}T00:00:00.000Z`);
  until.setUTCDate(until.getUTCDate() + withinDays);
  const untilIso = until.toISOString().slice(0, 10);
  const subject = options.subjectType;

  const rows: ExpiringLicenceRow[] = [];
  const msPerDay = 86_400_000;
  const days = (expiry: string) =>
    Math.round(
      (Date.parse(`${expiry}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / msPerDay,
    );

  if (!subject || subject === "facility") {
    const facilityRows = await database
      .select()
      .from(facilityLicences)
      .where(
        and(
          eq(facilityLicences.facilityId, facilityId),
          gte(facilityLicences.expiryDate, today),
          lte(facilityLicences.expiryDate, untilIso),
        ),
      );
    for (const row of facilityRows) {
      rows.push({
        subjectType: "facility",
        id: row.id,
        reference: row.licenceNo,
        label: row.licenceType,
        expiryDate: row.expiryDate,
        daysToExpiry: days(row.expiryDate),
        status: row.status,
      });
    }
  }

  if (!subject || subject === "practitioner") {
    const practitionerRows = await database
      .select()
      .from(practitionerRegistrations)
      .where(
        and(
          eq(practitionerRegistrations.facilityId, facilityId),
          eq(practitionerRegistrations.active, true),
          gte(practitionerRegistrations.licenceExpiryDate, today),
          lte(practitionerRegistrations.licenceExpiryDate, untilIso),
        ),
      );
    for (const row of practitionerRows) {
      if (!row.licenceExpiryDate) continue;
      rows.push({
        subjectType: "practitioner",
        id: row.id,
        reference: row.registrationNo,
        label: `${row.profession} (${row.regulator})`,
        expiryDate: row.licenceExpiryDate,
        daysToExpiry: days(row.licenceExpiryDate),
        status: row.licenceStatus,
      });
    }
  }

  if (!subject || subject === "support_service") {
    const serviceRows = await database
      .select()
      .from(supportServiceLicences)
      .where(
        and(
          eq(supportServiceLicences.facilityId, facilityId),
          eq(supportServiceLicences.active, true),
          gte(supportServiceLicences.expiryDate, today),
          lte(supportServiceLicences.expiryDate, untilIso),
        ),
      );
    for (const row of serviceRows) {
      rows.push({
        subjectType: "support_service",
        id: row.id,
        reference: row.licenceNo,
        label: row.serviceType,
        expiryDate: row.expiryDate,
        daysToExpiry: days(row.expiryDate),
        status: row.status,
      });
    }
  }

  return rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

export type { RegulatoryDomain };
