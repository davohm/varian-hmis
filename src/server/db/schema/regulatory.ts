import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { staffProfiles } from "./staff";
import { auditColumns, facilities } from "./tenancy";

export const facilityOwnershipEnum = pgEnum("facility_ownership", [
  "public",
  "faith_based",
  "private",
  "ngo",
]);

export const regulatorEnum = pgEnum("regulator_code", [
  "kmpdc",
  "ppb",
  "kmlttb",
  "nck",
  "rpb",
  "other",
]);

export const supportServiceTypeEnum = pgEnum("support_service_type", [
  "pharmacy",
  "laboratory",
  "imaging",
  "ambulance",
  "mortuary",
  "theatre",
]);

export const licenceStatusEnum = pgEnum("licence_status", [
  "active",
  "expiring",
  "expired",
  "suspended",
  "pending",
]);

export const settingDomainEnum = pgEnum("setting_domain", [
  "regulatory",
  "privacy",
  "reporting",
  "tax",
  "sha",
  "payroll",
  "quality",
]);

export const settingDataTypeEnum = pgEnum("setting_data_type", [
  "text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "enum",
  "json",
]);

export const adjudicationCategoryEnum = pgEnum("adjudication_category", [
  "approved",
  "reduced",
  "rejected",
  "info",
]);

export const integrationNameEnum = pgEnum("integration_name", [
  "etims",
  "khis",
  "sha_portal",
  "sms",
  "payments",
]);

export const integrationEnvironmentEnum = pgEnum("integration_environment", [
  "sandbox",
  "production",
]);

/**
 * One row per facility. Holds the legal identity every downstream control
 * keys off: KMPDC licence, KEPH level, ODPC registration, KRA PIN and the
 * statutory employer codes. Unconfirmed values stay null and surface as
 * `missing` in the readiness view rather than being guessed.
 */
export const facilityRegulatoryProfiles = pgTable(
  "facility_regulatory_profiles",
  {
    facilityId: uuid("facility_id")
      .primaryKey()
      .references(() => facilities.id, { onDelete: "cascade" }),
    kmpdcNumber: varchar("kmpdc_number", { length: 64 }).unique(),
    kmhflId: varchar("kmhfl_id", { length: 64 }),
    kephLevel: smallint("keph_level"),
    facilityCategory: text("facility_category"),
    ownership: facilityOwnershipEnum("ownership"),
    county: text("county"),
    subCounty: text("sub_county"),
    constituency: text("constituency"),
    ward: text("ward"),
    licenceNo: varchar("licence_no", { length: 64 }),
    licenceIssueDate: date("licence_issue_date"),
    licenceExpiryDate: date("licence_expiry_date"),
    licenceStatus: licenceStatusEnum("licence_status").notNull().default("pending"),
    indemnityProvider: text("indemnity_provider"),
    indemnityNo: varchar("indemnity_no", { length: 64 }),
    indemnityExpiryDate: date("indemnity_expiry_date"),
    shaFacilityCode: varchar("sha_facility_code", { length: 64 }),
    shaEmpanelmentStatus: text("sha_empanelment_status"),
    odpcRegistrationNo: varchar("odpc_registration_no", { length: 64 }),
    odpcCategory: text("odpc_category"),
    odpcExpiryDate: date("odpc_expiry_date"),
    kraPin: varchar("kra_pin", { length: 11 }),
    tccNo: varchar("tcc_no", { length: 64 }),
    tccExpiryDate: date("tcc_expiry_date"),
    nssfEmployerCode: varchar("nssf_employer_code", { length: 64 }),
    shifEmployerCode: varchar("shif_employer_code", { length: 64 }),
    kemsaSupplierCode: varchar("kemsa_supplier_code", { length: 64 }),
    updatedBy: text("updated_by"),
    ...auditColumns,
  },
);

/**
 * Append-only licence history. The profile keeps the current snapshot so
 * downstream controls can read one row, while every renewal leaves the
 * previous licence untouched and linked through `supersedes_id`.
 */
export const facilityLicences = pgTable(
  "facility_licences",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    licenceType: text("licence_type").notNull(),
    licenceNo: varchar("licence_no", { length: 64 }).notNull(),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date").notNull(),
    status: licenceStatusEnum("status").notNull().default("pending"),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => facilityLicences.id, {
      onDelete: "restrict",
    }),
    documentRef: text("document_ref"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityTypeIdx: index("facility_licences_facility_idx").on(
      table.facilityId,
      table.licenceType,
    ),
    facilityExpiryIdx: index("facility_licences_expiry_idx").on(
      table.facilityId,
      table.expiryDate,
    ),
    facilityTypeNoIdx: uniqueIndex("facility_licences_unique_idx").on(
      table.facilityId,
      table.licenceType,
      table.licenceNo,
    ),
  }),
);

export const practitionerRegistrations = pgTable(  "practitioner_registrations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    staffProfileId: uuid("staff_profile_id")
      .notNull()
      .references(() => staffProfiles.id, { onDelete: "restrict" }),
    regulator: regulatorEnum("regulator").notNull(),
    profession: text("profession").notNull(),
    registrationNo: varchar("registration_no", { length: 64 }).notNull(),
    annualLicenceNo: varchar("annual_licence_no", { length: 64 }),
    licenceIssueDate: date("licence_issue_date"),
    licenceExpiryDate: date("licence_expiry_date"),
    licenceStatus: licenceStatusEnum("licence_status").notNull().default("pending"),
    cpdPoints: numeric("cpd_points", { precision: 6, scale: 1 }),
    cpdCycle: varchar("cpd_cycle", { length: 32 }),
    cpdStatus: text("cpd_status"),
    specialistRecognition: text("specialist_recognition"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityStaffRegulatorIdx: uniqueIndex("practitioner_registrations_unique_idx").on(
      table.facilityId,
      table.staffProfileId,
      table.regulator,
    ),
    facilityExpiryIdx: index("practitioner_registrations_expiry_idx").on(
      table.facilityId,
      table.licenceExpiryDate,
    ),
  }),
);

export const supportServiceLicences = pgTable(
  "support_service_licences",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    serviceType: supportServiceTypeEnum("service_type").notNull(),
    licenceNo: varchar("licence_no", { length: 64 }).notNull(),
    issuingAuthority: text("issuing_authority").notNull(),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date").notNull(),
    status: licenceStatusEnum("status").notNull().default("pending"),
    conditions: text("conditions"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityServiceIdx: index("support_service_licences_facility_idx").on(
      table.facilityId,
      table.serviceType,
    ),
    facilityExpiryIdx: index("support_service_licences_expiry_idx").on(
      table.facilityId,
      table.expiryDate,
    ),
  }),
);

export const facilityIdentifiers = pgTable(
  "facility_identifiers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    identifierType: text("identifier_type").notNull(),
    value: text("value").notNull(),
    issuingAuthority: text("issuing_authority"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    status: text("status"),
    ...auditColumns,
  },
  (table) => ({
    facilityTypeValueIdx: uniqueIndex("facility_identifiers_unique_idx").on(
      table.facilityId,
      table.identifierType,
      table.value,
    ),
  }),
);

export const licenceAlertRules = pgTable(
  "licence_alert_rules",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    warnDays: integer("warn_days").array().notNull(),
    blockDays: integer("block_days").array().notNull(),
    notifyRoles: text("notify_roles").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilitySubjectIdx: index("licence_alert_rules_facility_idx").on(
      table.facilityId,
      table.subjectType,
    ),
  }),
);

export const facilitySettings = pgTable(
  "facility_settings",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    domain: settingDomainEnum("domain").notNull(),
    key: text("key").notNull(),
    valueText: text("value_text"),
    valueNumeric: numeric("value_numeric", { precision: 14, scale: 4 }),
    valueJson: jsonb("value_json"),
    dataType: settingDataTypeEnum("data_type").notNull(),
    allowedValues: text("allowed_values").array(),
    minValue: numeric("min_value", { precision: 14, scale: 4 }),
    maxValue: numeric("max_value", { precision: 14, scale: 4 }),
    regex: text("regex"),
    isRequired: boolean("is_required").notNull().default(false),
    isSecret: boolean("is_secret").notNull().default(false),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    updatedBy: text("updated_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityDomainKeyIdx: uniqueIndex("facility_settings_unique_idx").on(
      table.facilityId,
      table.domain,
      table.key,
      table.effectiveFrom,
    ),
    facilityDomainIdx: index("facility_settings_domain_idx").on(table.facilityId, table.domain),
  }),
);

export const statutoryRates = pgTable(
  "statutory_rates",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    rateType: text("rate_type").notNull(),
    bandOrder: integer("band_order").notNull(),
    lowerBound: numeric("lower_bound", { precision: 14, scale: 2 }).notNull(),
    upperBound: numeric("upper_bound", { precision: 14, scale: 2 }),
    ratePercent: numeric("rate_percent", { precision: 6, scale: 3 }).notNull(),
    fixedAmount: numeric("fixed_amount", { precision: 12, scale: 2 }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    legalReference: text("legal_reference"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityRateBandIdx: uniqueIndex("statutory_rates_unique_idx").on(
      table.facilityId,
      table.rateType,
      table.bandOrder,
      table.effectiveFrom,
    ),
  }),
);

export const statutoryFeeSchedules = pgTable(
  "statutory_fee_schedules",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    authority: text("authority").notNull(),
    category: text("category").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("KES"),
    renewalMonth: integer("renewal_month"),
    renewalDay: integer("renewal_day"),
    penaltyNote: text("penalty_note"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceUrl: text("source_url"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityAuthorityCategoryIdx: uniqueIndex("statutory_fee_schedules_unique_idx").on(
      table.facilityId,
      table.authority,
      table.category,
      table.effectiveFrom,
    ),
  }),
);

export const shaAdjudicationCodes = pgTable(
  "sha_adjudication_codes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    description: text("description").notNull(),
    category: adjudicationCategoryEnum("category").notNull(),
    retryable: boolean("retryable").notNull().default(false),
    actionHint: text("action_hint"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("sha_adjudication_codes_unique_idx").on(
      table.facilityId,
      table.code,
    ),
  }),
);

export const integrationSettings = pgTable(
  "integration_settings",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    integration: integrationNameEnum("integration").notNull(),
    environment: integrationEnvironmentEnum("environment").notNull(),
    baseUrl: text("base_url"),
    specVersion: text("spec_version"),
    mode: text("mode"),
    credentialRef: text("credential_ref"),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    maxAttempts: integer("max_attempts").notNull().default(5),
    backoffSeconds: integer("backoff_seconds").array().notNull().default(sql`'{30,120,600,1800,3600}'::integer[]`),
    enabled: boolean("enabled").notNull().default(false),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastVerifiedBy: text("last_verified_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityIntegrationEnvIdx: uniqueIndex("integration_settings_unique_idx").on(
      table.facilityId,
      table.integration,
      table.environment,
    ),
  }),
);
