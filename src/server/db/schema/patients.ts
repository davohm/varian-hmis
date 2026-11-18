import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { auditColumns, branches, facilities, rooms } from "./tenancy";

export const sexEnum = pgEnum("sex", ["male", "female", "other"]);
export const payerTypeEnum = pgEnum("payer_type", ["cash", "sha", "insurance"]);
export const encounterStatusEnum = pgEnum("encounter_status", [
  "open",
  "discharged",
  "referred",
  "cancelled",
]);
export const queuePriorityEnum = pgEnum("queue_priority", ["red", "yellow", "green", "normal"]);
export const queueStatusEnum = pgEnum("queue_status", [
  "waiting",
  "called",
  "in_service",
  "done",
  "cancelled",
]);

export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    mrn: varchar("mrn", { length: 32 }).notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    otherNames: text("other_names"),
    dob: date("dob", { mode: "string" }),
    dobEstimated: boolean("dob_estimated").notNull().default(false),
    sex: sexEnum("sex").notNull(),
    nationalId: varchar("national_id", { length: 64 }),
    phone: varchar("phone", { length: 30 }),
    email: varchar("email", { length: 255 }),
    address: text("address"),
    payerType: payerTypeEnum("payer_type").notNull().default("cash"),
    payerMemberNo: varchar("payer_member_no", { length: 64 }),
    allergies: text("allergies").array(),
    bloodGroup: varchar("blood_group", { length: 8 }),
    ...auditColumns,
  },
  (table) => ({
    facilityMrnIdx: uniqueIndex("patients_facility_mrn_idx").on(table.facilityId, table.mrn),
    facilityPhoneIdx: index("patients_facility_phone_idx").on(table.facilityId, table.phone),
    facilityNationalIdIdx: index("patients_facility_national_id_idx").on(
      table.facilityId,
      table.nationalId,
    ),
    facilityNameIdx: index("patients_facility_name_idx").on(
      table.facilityId,
      table.lastName,
      table.firstName,
    ),
  }),
);

export const nextOfKin = pgTable(
  "next_of_kin",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    relationship: text("relationship").notNull(),
    phone: varchar("phone", { length: 30 }),
    ...auditColumns,
  },
  (table) => ({
    facilityPatientIdx: index("next_of_kin_facility_patient_idx").on(
      table.facilityId,
      table.patientId,
    ),
  }),
);

export const encounters = pgTable(
  "encounters",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    encounterNo: varchar("encounter_no", { length: 40 }).notNull(),
    status: encounterStatusEnum("status").notNull().default("open"),
    payerType: payerTypeEnum("payer_type").notNull().default("cash"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterNoIdx: uniqueIndex("encounters_facility_encounter_no_idx").on(
      table.facilityId,
      table.encounterNo,
    ),
    facilityPatientIdx: index("encounters_facility_patient_idx").on(
      table.facilityId,
      table.patientId,
    ),
    facilityStatusIdx: index("encounters_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const queueEntries = pgTable(
  "queue_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    department: text("department").notNull(),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "restrict" }),
    priority: queuePriorityEnum("priority").notNull().default("normal"),
    status: queueStatusEnum("status").notNull().default("waiting"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    calledAt: timestamp("called_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityQueueIdx: index("queue_entries_facility_queue_idx").on(
      table.facilityId,
      table.department,
      table.status,
      table.priority,
      table.queuedAt,
    ),
    facilityEncounterIdx: index("queue_entries_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityPatientIdx: index("queue_entries_facility_patient_idx").on(
      table.facilityId,
      table.patientId,
    ),
  }),
);

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;
export type NextOfKin = typeof nextOfKin.$inferSelect;
export type NewNextOfKin = typeof nextOfKin.$inferInsert;
export type Encounter = typeof encounters.$inferSelect;
export type NewEncounter = typeof encounters.$inferInsert;
export type QueueEntry = typeof queueEntries.$inferSelect;
export type NewQueueEntry = typeof queueEntries.$inferInsert;
