import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { invoices } from "./billing";
import { patients } from "./patients";
import { auditColumns, facilities } from "./tenancy";

/** Fund codes published by the Social Health Authority. Admin-managed, never guessed. */
export const shaFundEnum = pgEnum("sha_fund", ["phf", "shif", "eccif"]);
export const shaEmpanelmentStatusEnum = pgEnum("sha_empanelment_status", [
  "active",
  "suspended",
  "expired",
  "terminated",
]);
export const shaCoverageEnum = pgEnum("sha_coverage", ["full", "partial", "excluded"]);
export const shaCareTypeEnum = pgEnum("sha_care_type", ["inpatient", "outpatient"]);
export const shaReconciliationStatusEnum = pgEnum("sha_reconciliation_status", [
  "pending",
  "matched",
  "variance",
  "posted",
]);
export const shaReconciliationLineStatusEnum = pgEnum("sha_reconciliation_line_status", [
  "matched",
  "unmatched",
  "variance",
]);
export const shaEligibilityEnum = pgEnum("sha_eligibility", ["eligible", "ineligible", "unknown"]);
export const shaWaiverKindEnum = pgEnum("sha_waiver_kind", ["waiver", "exemption"]);
export const shaWaiverStatusEnum = pgEnum("sha_waiver_status", ["requested", "approved", "rejected"]);

export const shaEmpanelments = pgTable(
  "sha_empanelments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    kmpdcNumber: varchar("kmpdc_number", { length: 64 }),
    fund: shaFundEnum("fund").notNull(),
    schemeCode: varchar("scheme_code", { length: 64 }).notNull(),
    schemeName: text("scheme_name"),
    contractNo: varchar("contract_no", { length: 64 }),
    contractStatus: shaEmpanelmentStatusEnum("contract_status").notNull().default("active"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    expiryDate: date("expiry_date", { mode: "string" }),
    tariffVersion: varchar("tariff_version", { length: 64 }),
    qualityCertProgram: text("quality_cert_program"),
    qualityCertExpiry: date("quality_cert_expiry", { mode: "string" }),
    bankAccountId: uuid("bank_account_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closureReason: text("closure_reason"),
    ...auditColumns,
  },
  (table) => ({
    facilityFundSchemeIdx: uniqueIndex("sha_empanelments_facility_fund_scheme_idx").on(
      table.facilityId,
      table.fund,
      table.schemeCode,
    ),
    facilityIdx: index("sha_empanelments_facility_idx").on(table.facilityId),
  }),
);

export const benefitPackages = pgTable(
  "benefit_packages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    fund: shaFundEnum("fund").notNull(),
    packageCode: varchar("package_code", { length: 64 }).notNull(),
    name: text("name").notNull(),
    careLevel: varchar("care_level", { length: 64 }),
    careType: shaCareTypeEnum("care_type").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityFundPackageIdx: uniqueIndex("benefit_packages_facility_fund_package_idx").on(
      table.facilityId,
      table.fund,
      table.packageCode,
      table.effectiveFrom,
    ),
    facilityIdx: index("benefit_packages_facility_idx").on(table.facilityId),
  }),
);

export const benefitPackageItems = pgTable(
  "benefit_package_items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    benefitPackageId: uuid("benefit_package_id")
      .notNull()
      .references(() => benefitPackages.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id"),
    itemId: uuid("item_id"),
    shaServiceCode: varchar("sha_service_code", { length: 64 }),
    category: varchar("category", { length: 64 }),
    description: text("description"),
    coverage: shaCoverageEnum("coverage").notNull(),
    limitAmount: numeric("limit_amount", { precision: 12, scale: 2 }),
    limitDays: numeric("limit_days", { precision: 6, scale: 0 }),
    limitVisits: numeric("limit_visits", { precision: 6, scale: 0 }),
    requiresPreauth: boolean("requires_preauth").notNull().default(false),
    preauthThreshold: numeric("preauth_threshold", { precision: 12, scale: 2 }),
    coPayPercent: numeric("co_pay_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    packageIdx: index("benefit_package_items_package_idx").on(
      table.facilityId,
      table.benefitPackageId,
    ),
    codeIdx: index("benefit_package_items_code_idx").on(
      table.facilityId,
      table.benefitPackageId,
      table.shaServiceCode,
    ),
  }),
);

export const shaEligibilityChecks = pgTable(
  "sha_eligibility_checks",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id"),
    empanelmentId: uuid("empanelment_id").references(() => shaEmpanelments.id, {
      onDelete: "restrict",
    }),
    fund: shaFundEnum("fund"),
    memberRef: varchar("member_ref", { length: 64 }),
    eligibility: shaEligibilityEnum("eligibility").notNull(),
    checkRef: varchar("check_ref", { length: 64 }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    patientIdx: index("sha_eligibility_checks_patient_idx").on(table.facilityId, table.patientId),
  }),
);

export const shaWaivers = pgTable(
  "sha_waivers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    kind: shaWaiverKindEnum("kind").notNull(),
    claimId: uuid("claim_id"),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    status: shaWaiverStatusEnum("status").notNull().default("requested"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityIdx: index("sha_waivers_facility_idx").on(table.facilityId),
  }),
);

export const shaPaymentReconciliation = pgTable(
  "sha_payment_reconciliation",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    kmpdcNumber: varchar("kmpdc_number", { length: 64 }).notNull(),
    reportPeriod: varchar("report_period", { length: 32 }).notNull(),
    reportRef: varchar("report_ref", { length: 64 }),
    shaReportedAmount: numeric("sha_reported_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    facilityInvoicedAmount: numeric("facility_invoiced_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    matchedAmount: numeric("matched_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    unmatchedAmount: numeric("unmatched_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    variance: numeric("variance", { precision: 12, scale: 2 }).notNull().default("0"),
    status: shaReconciliationStatusEnum("status").notNull().default("pending"),
    journalEntryId: uuid("journal_entry_id"),
    generatedBy: text("generated_by"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    facilityPeriodIdx: uniqueIndex("sha_reconciliation_facility_period_idx").on(
      table.facilityId,
      table.kmpdcNumber,
      table.reportPeriod,
    ),
  }),
);

export const shaReconciliationLines = pgTable(
  "sha_reconciliation_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    reconciliationId: uuid("reconciliation_id")
      .notNull()
      .references(() => shaPaymentReconciliation.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id"),
    claimNo: varchar("claim_no", { length: 40 }),
    shaAmount: numeric("sha_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    facilityAmount: numeric("facility_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    variance: numeric("variance", { precision: 12, scale: 2 }).notNull().default("0"),
    status: shaReconciliationLineStatusEnum("status").notNull().default("unmatched"),
    reason: text("reason"),
    ...auditColumns,
  },
  (table) => ({
    reconciliationIdx: index("sha_reconciliation_lines_reconciliation_idx").on(
      table.facilityId,
      table.reconciliationId,
    ),
  }),
);

export type ShaEmpanelment = typeof shaEmpanelments.$inferSelect;
export type BenefitPackage = typeof benefitPackages.$inferSelect;
export type BenefitPackageItem = typeof benefitPackageItems.$inferSelect;
export type ShaPaymentReconciliationRow = typeof shaPaymentReconciliation.$inferSelect;
