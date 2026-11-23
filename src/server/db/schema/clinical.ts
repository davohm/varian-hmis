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
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { encounters, patients } from "./patients";
import { auditColumns, branches, facilities, stores } from "./tenancy";

export const labOrderStatusEnum = pgEnum("lab_order_status", [
  "ordered",
  "collected",
  "in_progress",
  "resulted",
  "verified",
  "cancelled",
]);

export const labItemStatusEnum = pgEnum("lab_item_status", [
  "ordered",
  "collected",
  "resulted",
  "verified",
  "cancelled",
]);

export const labResultFlagEnum = pgEnum("lab_result_flag", ["N", "H", "L", "HH", "LL"]);

export const itemKindEnum = pgEnum("item_kind", ["drug", "consumable", "reagent"]);

export const prescriptionStatusEnum = pgEnum("prescription_status", [
  "prescribed",
  "partial",
  "dispensed",
  "cancelled",
]);

/** Every stock movement carries one of these reasons; the ledger is append-only. */
export const stockReasonEnum = pgEnum("stock_reason", [
  "receive",
  "dispense",
  "adjust",
  "transfer_in",
  "transfer_out",
  "reversal",
]);

/** A lab parameter definition carried inside `lab_tests.parameters`. */
export interface LabParameter {
  name: string;
  unit: string;
  refLow: number | null;
  refHigh: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
}

/** Global ICD-10 catalogue, seeded from `data/icd10.csv`. */
export const icd10Codes = pgTable(
  "icd10_codes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    code: varchar("code", { length: 16 }).notNull(),
    description: text("description").notNull(),
    chapter: text("chapter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeIdx: uniqueIndex("icd10_codes_code_idx").on(table.code),
    descriptionIdx: index("icd10_codes_description_idx").on(table.description),
  }),
);

export const clinicalNotes = pgTable(
  "clinical_notes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    subjective: text("subjective"),
    objective: text("objective"),
    assessment: text("assessment"),
    plan: text("plan"),
    authorId: text("author_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterIdx: index("clinical_notes_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
  }),
);

export const diagnoses = pgTable(
  "diagnoses",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    icd10Code: varchar("icd10_code", { length: 16 }).notNull(),
    description: text("description").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    diagnosedBy: text("diagnosed_by").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterIdx: index("diagnoses_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityCodeIdx: index("diagnoses_facility_code_idx").on(table.facilityId, table.icd10Code),
  }),
);

export const labTests = pgTable(
  "lab_tests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    // A null facility means the catalogue row is shared by every facility.
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    sampleType: text("sample_type").notNull(),
    parameters: jsonb("parameters").$type<LabParameter[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    codeIdx: index("lab_tests_code_idx").on(table.code),
    facilityIdx: index("lab_tests_facility_idx").on(table.facilityId),
  }),
);

export const labOrders = pgTable(
  "lab_orders",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    status: labOrderStatusEnum("status").notNull().default("ordered"),
    clinicalNotes: text("clinical_notes"),
    orderedBy: text("ordered_by").notNull(),
    sampleId: text("sample_id"),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterIdx: index("lab_orders_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityStatusIdx: index("lab_orders_facility_status_idx").on(table.facilityId, table.status),
  }),
);

export const labOrderItems = pgTable(
  "lab_order_items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    labOrderId: uuid("lab_order_id")
      .notNull()
      .references(() => labOrders.id, { onDelete: "restrict" }),
    labTestId: uuid("lab_test_id")
      .notNull()
      .references(() => labTests.id, { onDelete: "restrict" }),
    status: labItemStatusEnum("status").notNull().default("ordered"),
    ...auditColumns,
  },
  (table) => ({
    facilityOrderIdx: index("lab_order_items_facility_order_idx").on(
      table.facilityId,
      table.labOrderId,
    ),
  }),
);

export const labResults = pgTable(
  "lab_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    labOrderItemId: uuid("lab_order_item_id")
      .notNull()
      .references(() => labOrderItems.id, { onDelete: "restrict" }),
    parameter: text("parameter").notNull(),
    value: text("value").notNull(),
    unit: text("unit"),
    refRange: text("ref_range"),
    flag: labResultFlagEnum("flag").notNull().default("N"),
    enteredBy: text("entered_by").notNull(),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityItemIdx: index("lab_results_facility_item_idx").on(
      table.facilityId,
      table.labOrderItemId,
    ),
  }),
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    // A null facility means the catalogue row is shared by every facility.
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    kind: itemKindEnum("kind").notNull().default("drug"),
    unit: text("unit").notNull().default("unit"),
    strength: text("strength"),
    form: text("form"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    codeIdx: index("items_code_idx").on(table.code),
    facilityIdx: index("items_facility_idx").on(table.facilityId),
  }),
);

export const prescriptions = pgTable(
  "prescriptions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    dose: text("dose").notNull(),
    route: text("route").notNull(),
    frequency: text("frequency").notNull(),
    durationDays: integer("duration_days"),
    quantity: integer("quantity").notNull(),
    instructions: text("instructions"),
    status: prescriptionStatusEnum("status").notNull().default("prescribed"),
    prescribedBy: text("prescribed_by").notNull(),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterIdx: index("prescriptions_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityStatusIdx: index("prescriptions_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const itemBatches = pgTable(
  "item_batches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    batchNo: varchar("batch_no", { length: 64 }).notNull(),
    // A null expiry means the item does not expire (consumables, reagents).
    expiryDate: date("expiry_date", { mode: "string" }),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull().default("0"),
    ...auditColumns,
  },
  (table) => ({
    facilityItemBatchIdx: uniqueIndex("item_batches_facility_item_batch_idx").on(
      table.facilityId,
      table.itemId,
      table.batchNo,
    ),
    facilityItemExpiryIdx: index("item_batches_facility_item_expiry_idx").on(
      table.facilityId,
      table.itemId,
      table.expiryDate,
    ),
  }),
);

/**
 * Append-only stock ledger. Balances are never stored on a row: they are the
 * sum of every movement, exposed through the `stock_balances` view. A database
 * trigger rejects updates (see migration 0005) so history cannot be rewritten.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").references(() => itemBatches.id, { onDelete: "restrict" }),
    qtyDelta: integer("qty_delta").notNull(),
    reason: stockReasonEnum("reason").notNull(),
    refType: varchar("ref_type", { length: 32 }),
    refId: text("ref_id"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityStoreItemIdx: index("stock_ledger_facility_store_item_idx").on(
      table.facilityId,
      table.storeId,
      table.itemId,
    ),
    facilityBatchIdx: index("stock_ledger_facility_batch_idx").on(table.facilityId, table.batchId),
    facilityRefIdx: index("stock_ledger_facility_ref_idx").on(
      table.facilityId,
      table.refType,
      table.refId,
    ),
  }),
);

/**
 * One allocation row per batch used to fill a prescription. A prescription may
 * be dispensed over several visits (partial), and a dispense can be reversed;
 * reversed rows are kept and excluded from the dispensed total.
 */
export const dispenses = pgTable(
  "dispenses",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => itemBatches.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    dispensedBy: text("dispensed_by").notNull(),
    note: text("note"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityPrescriptionIdx: index("dispenses_facility_prescription_idx").on(
      table.facilityId,
      table.prescriptionId,
    ),
    facilityBatchIdx: index("dispenses_facility_batch_idx").on(table.facilityId, table.batchId),
  }),
);

/**
 * Live balance per store, item and batch. Never written directly; every row is
 * the sum of the append-only ledger.
 */
export const stockBalances = pgView("stock_balances").as((qb) =>
  qb
    .select({
      facilityId: stockLedger.facilityId,
      storeId: stockLedger.storeId,
      itemId: stockLedger.itemId,
      batchId: stockLedger.batchId,
      quantity: sql<number>`coalesce(sum(${stockLedger.qtyDelta}), 0)::int`.as("quantity"),
    })
    .from(stockLedger)
    .groupBy(
      stockLedger.facilityId,
      stockLedger.storeId,
      stockLedger.itemId,
      stockLedger.batchId,
    ),
);

/** MOH 710A/EPI immunisations recorded against a patient visit. */
export const immunizationStatusEnum = pgEnum("immunization_status", ["administered", "void"]);

export const immunizations = pgTable(
  "immunizations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").references(() => itemBatches.id, { onDelete: "restrict" }),
    antigenCode: varchar("antigen_code", { length: 32 }).notNull(),
    doseCode: varchar("dose_code", { length: 32 }).notNull(),
    administeredAt: timestamp("administered_at", { withTimezone: true }).notNull().defaultNow(),
    status: immunizationStatusEnum("status").notNull().default("administered"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityDateIdx: index("immunizations_facility_date_idx").on(table.facilityId, table.administeredAt),
    facilityAntigenIdx: index("immunizations_facility_antigen_idx").on(table.facilityId, table.antigenCode, table.administeredAt),
    encounterIdx: index("immunizations_encounter_idx").on(table.facilityId, table.encounterId),
  }),
);

/** MOH 735/416 eye clinic assessment supporting the statutory summaries. */
export const eyeVisitTypeEnum = pgEnum("eye_visit_type", ["new", "revisit", "review", "walk_in"]);
export const eyeVisualAcuityEnum = pgEnum("eye_visual_acuity", ["normal", "low_vision", "blind"]);

export const eyeAssessments = pgTable(
  "eye_assessments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    visitedAt: timestamp("visited_at", { withTimezone: true }).notNull().defaultNow(),
    visitType: eyeVisitTypeEnum("visit_type").notNull().default("new"),
    visualAcuity: eyeVisualAcuityEnum("visual_acuity").notNull().default("normal"),
    vaRight: varchar("va_right", { length: 32 }),
    vaLeft: varchar("va_left", { length: 32 }),
    disabilityType: text("disability_type"),
    diagnosisCode: varchar("diagnosis_code", { length: 64 }).notNull(),
    impression: text("impression"),
    management: text("management"),
    referral: text("referral"),
    county: text("county"),
    residence: text("residence"),
    phone: varchar("phone", { length: 30 }),
    registeredBy: text("registered_by"),
    seenBy: text("seen_by"),
    timeRegistered: timestamp("time_registered", { withTimezone: true }),
    timeSeen: timestamp("time_seen", { withTimezone: true }),
    lastStage: varchar("last_stage", { length: 64 }),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    dischargedAt: timestamp("discharged_at", { withTimezone: true }),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityDateIdx: index("eye_assessments_facility_date_idx").on(table.facilityId, table.visitedAt),
    encounterIdx: uniqueIndex("eye_assessments_encounter_idx").on(table.facilityId, table.encounterId),
    diagnosisIdx: index("eye_assessments_diagnosis_idx").on(table.facilityId, table.diagnosisCode, table.visitedAt),
  }),
);

export type Immunization = typeof immunizations.$inferSelect;
export type NewImmunization = typeof immunizations.$inferInsert;
export type EyeAssessment = typeof eyeAssessments.$inferSelect;
export type NewEyeAssessment = typeof eyeAssessments.$inferInsert;

export type ItemBatch = typeof itemBatches.$inferSelect;
export type NewItemBatch = typeof itemBatches.$inferInsert;
export type StockLedgerEntry = typeof stockLedger.$inferSelect;
export type NewStockLedgerEntry = typeof stockLedger.$inferInsert;
export type Dispense = typeof dispenses.$inferSelect;
export type NewDispense = typeof dispenses.$inferInsert;

export type Icd10Code = typeof icd10Codes.$inferSelect;
export type NewIcd10Code = typeof icd10Codes.$inferInsert;
export type ClinicalNote = typeof clinicalNotes.$inferSelect;
export type NewClinicalNote = typeof clinicalNotes.$inferInsert;
export type Diagnosis = typeof diagnoses.$inferSelect;
export type NewDiagnosis = typeof diagnoses.$inferInsert;
export type LabTest = typeof labTests.$inferSelect;
export type NewLabTest = typeof labTests.$inferInsert;
export type LabOrder = typeof labOrders.$inferSelect;
export type NewLabOrder = typeof labOrders.$inferInsert;
export type LabOrderItem = typeof labOrderItems.$inferSelect;
export type NewLabOrderItem = typeof labOrderItems.$inferInsert;
export type LabResult = typeof labResults.$inferSelect;
export type NewLabResult = typeof labResults.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Prescription = typeof prescriptions.$inferSelect;
export type NewPrescription = typeof prescriptions.$inferInsert;
