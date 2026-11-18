import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { encounters } from "./patients";
import { auditColumns, facilities } from "./tenancy";

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
