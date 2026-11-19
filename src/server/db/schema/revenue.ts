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

import { charges, invoices, services } from "./billing";
import { encounters, patients } from "./patients";
import { auditColumns, facilities } from "./tenancy";

export const payerKindEnum = pgEnum("payer_kind", [
  "cash",
  "corporate",
  "insurer",
  "sha",
]);

export const payerContractStatusEnum = pgEnum("payer_contract_status", [
  "active",
  "suspended",
  "expired",
]);

export const preAuthStatusEnum = pgEnum("preauth_status", [
  "requested",
  "approved",
  "declined",
  "expired",
]);

export const claimStatusEnum = pgEnum("claim_status", [
  "draft",
  "submitted",
  "accepted",
  "queried",
  "rejected",
  "resubmitted",
  "paid",
  "closed",
]);

export const claimDenialStatusEnum = pgEnum("claim_denial_status", [
  "open",
  "upheld",
  "overturned",
]);

export const payers = pgTable(
  "payers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    kind: payerKindEnum("kind").notNull().default("insurer"),
    contactName: text("contact_name"),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 255 }),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("payers_facility_code_idx").on(table.facilityId, table.code),
    facilityIdx: index("payers_facility_idx").on(table.facilityId),
  }),
);

export const payerContracts = pgTable(
  "payer_contracts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "restrict" }),
    contractNo: varchar("contract_no", { length: 64 }).notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    status: payerContractStatusEnum("status").notNull().default("active"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityContractIdx: uniqueIndex("payer_contracts_facility_contract_idx").on(
      table.facilityId,
      table.contractNo,
    ),
    payerIdx: index("payer_contracts_payer_idx").on(table.facilityId, table.payerId),
  }),
);

export const payerBenefits = pgTable(
  "payer_benefits",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => payerContracts.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    category: varchar("category", { length: 64 }).notNull(),
    annualLimit: numeric("annual_limit", { precision: 12, scale: 2 }),
    perVisitLimit: numeric("per_visit_limit", { precision: 12, scale: 2 }),
    copayPercent: numeric("copay_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    contractIdx: index("payer_benefits_contract_idx").on(table.facilityId, table.contractId),
  }),
);

export const preAuthorizations = pgTable(
  "pre_authorizations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id").references(() => payerContracts.id, {
      onDelete: "restrict",
    }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "restrict" }),
    authNo: varchar("auth_no", { length: 40 }).notNull(),
    requestedAmount: numeric("requested_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    approvedAmount: numeric("approved_amount", { precision: 12, scale: 2 }),
    status: preAuthStatusEnum("status").notNull().default("requested"),
    reference: text("reference"),
    expiresAt: date("expires_at", { mode: "string" }),
    notes: text("notes"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityAuthNoIdx: uniqueIndex("pre_authorizations_facility_auth_no_idx").on(
      table.facilityId,
      table.authNo,
    ),
    patientIdx: index("pre_authorizations_patient_idx").on(table.facilityId, table.patientId),
    payerIdx: index("pre_authorizations_payer_idx").on(table.facilityId, table.payerId),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id").references(() => payerContracts.id, {
      onDelete: "restrict",
    }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    claimNo: varchar("claim_no", { length: 40 }).notNull(),
    status: claimStatusEnum("status").notNull().default("draft"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0"),
    approvedAmount: numeric("approved_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityClaimNoIdx: uniqueIndex("claims_facility_claim_no_idx").on(
      table.facilityId,
      table.claimNo,
    ),
    invoiceIdx: index("claims_invoice_idx").on(table.facilityId, table.invoiceId),
    statusIdx: index("claims_status_idx").on(table.facilityId, table.status),
    patientIdx: index("claims_patient_idx").on(table.facilityId, table.patientId),
  }),
);

export const claimLines = pgTable(
  "claim_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    chargeId: uuid("charge_id").references(() => charges.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    approvedAmount: numeric("approved_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    denialReason: text("denial_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("claim_lines_claim_idx").on(table.facilityId, table.claimId),
    chargeIdx: index("claim_lines_charge_idx").on(table.facilityId, table.chargeId),
  }),
);

/** Immutable cash received against a claim. Corrections are new rows. */
export const remittances = pgTable(
  "remittances",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    claimLineId: uuid("claim_line_id").references(() => claimLines.id, {
      onDelete: "restrict",
    }),
    remittanceNo: varchar("remittance_no", { length: 40 }).notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    reference: text("reference"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityRemittanceNoIdx: uniqueIndex("remittances_facility_remittance_no_idx").on(
      table.facilityId,
      table.remittanceNo,
    ),
    claimIdx: index("remittances_claim_idx").on(table.facilityId, table.claimId),
  }),
);

export const claimDenials = pgTable(
  "claim_denials",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "restrict" }),
    claimLineId: uuid("claim_line_id").references(() => claimLines.id, {
      onDelete: "restrict",
    }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    reason: text("reason").notNull(),
    status: claimDenialStatusEnum("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("claim_denials_claim_idx").on(table.facilityId, table.claimId),
    statusIdx: index("claim_denials_status_idx").on(table.facilityId, table.status),
  }),
);

export type Payer = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
export type PayerContract = typeof payerContracts.$inferSelect;
export type NewPayerContract = typeof payerContracts.$inferInsert;
export type PayerBenefit = typeof payerBenefits.$inferSelect;
export type NewPayerBenefit = typeof payerBenefits.$inferInsert;
export type PreAuthorization = typeof preAuthorizations.$inferSelect;
export type NewPreAuthorization = typeof preAuthorizations.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimLine = typeof claimLines.$inferSelect;
export type NewClaimLine = typeof claimLines.$inferInsert;
export type Remittance = typeof remittances.$inferSelect;
export type NewRemittance = typeof remittances.$inferInsert;
export type ClaimDenial = typeof claimDenials.$inferSelect;
export type NewClaimDenial = typeof claimDenials.$inferInsert;
