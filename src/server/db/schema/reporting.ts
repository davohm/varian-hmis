import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { encounters, patients } from "./patients";
import { auditColumns, branches, facilities } from "./tenancy";

export const reportCatalogue = pgTable(
  "report_catalogue",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    reportCode: varchar("report_code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    schedule: text("schedule").notNull(),
    periodType: text("period_type").notNull(),
    sourceEntities: text("source_entities").array(),
    outputFormats: text("output_formats").array(),
    authority: text("authority"),
    enabled: boolean("enabled").notNull().default(true),
    templateVersion: text("template_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reportCodeIdx: uniqueIndex("report_catalogue_report_code_idx").on(table.reportCode),
  }),
);

export const reportRuns = pgTable(
  "report_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportCatalogue.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    epiWeek: integer("epi_week"),
    epiYear: integer("epi_year"),
    month: integer("month"),
    year: integer("year"),
    status: text("status").notNull().default("draft"),
    rowCount: integer("row_count").notNull().default(0),
    checksum: text("checksum"),
    generatedBy: text("generated_by"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    exportedFile: text("exported_file"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: text("submitted_by"),
    acknowledgementRef: text("acknowledgement_ref"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (table) => ({
    facilityReportPeriodIdx: index("report_runs_facility_report_period_idx").on(
      table.facilityId,
      table.reportId,
      table.periodStart,
      table.periodEnd,
    ),
    facilityBranchIdx: index("report_runs_facility_branch_idx").on(table.facilityId, table.branchId),
    facilityStatusIdx: index("report_runs_facility_status_idx").on(table.facilityId, table.status),
  }),
);

export const reportCells = pgTable(
  "report_cells",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    reportRunId: uuid("report_run_id")
      .notNull()
      .references(() => reportRuns.id, { onDelete: "cascade" }),
    section: text("section"),
    rowCode: text("row_code"),
    rowLabel: text("row_label"),
    colKey: text("col_key"),
    colLabel: text("col_label"),
    valueNumeric: numeric("value_numeric", { precision: 14, scale: 2 }),
    valueText: text("value_text"),
    sortOrder: integer("sort_order").notNull().default(0),
    isTotal: boolean("is_total").notNull().default(false),
    sourceQuery: text("source_query"),
  },
  (table) => ({
    runIdx: index("report_cells_run_idx").on(table.reportRunId),
    facilityRunIdx: index("report_cells_facility_run_idx").on(table.facilityId, table.reportRunId),
    runRowColIdx: index("report_cells_run_row_col_idx").on(
      table.reportRunId,
      table.rowCode,
      table.colKey,
    ),
  }),
);

export const reportDefinitions = pgTable(
  "report_definitions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportCatalogue.id, { onDelete: "restrict" }),
    section: text("section"),
    rowCode: text("row_code"),
    rowLabel: text("row_label"),
    colKey: text("col_key"),
    colLabel: text("col_label"),
    aggregation: text("aggregation"),
    filter: text("filter"),
    sortOrder: integer("sort_order").notNull().default(0),
    isTotal: boolean("is_total").notNull().default(false),
    formula: text("formula"),
    ...auditColumns,
  },
  (table) => ({
    facilityReportIdx: index("report_definitions_facility_report_idx").on(
      table.facilityId,
      table.reportId,
    ),
  }),
);

export const notifiableEvents = pgTable(
  "notifiable_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "restrict" }),
    diseaseCode: text("disease_code"),
    diseaseName: text("disease_name").notNull(),
    classification: text("classification"),
    onsetDate: date("onset_date", { mode: "string" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    reportedTo: text("reported_to"),
    method: text("method"),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityDetectedIdx: index("notifiable_events_facility_detected_idx").on(
      table.facilityId,
      table.detectedAt,
    ),
    facilityStatusIdx: index("notifiable_events_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const birthNotifications = pgTable(
  "birth_notifications",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "restrict" }),
    childMrn: text("child_mrn"),
    sex: text("sex"),
    birthWeightKg: numeric("birth_weight_kg", { precision: 5, scale: 2 }),
    birthDate: date("birth_date", { mode: "string" }),
    notificationNo: text("notification_no"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityBirthDateIdx: index("birth_notifications_facility_birth_date_idx").on(
      table.facilityId,
      table.birthDate,
    ),
    facilityNotificationIdx: index("birth_notifications_facility_notification_idx").on(
      table.facilityId,
      table.notificationNo,
    ),
  }),
);

export const deathNotifications = pgTable(
  "death_notifications",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "restrict" }),
    dateOfDeath: date("date_of_death", { mode: "string" }),
    causeCode: text("cause_code"),
    causeText: text("cause_text"),
    placeOfDeath: text("place_of_death"),
    notificationNo: text("notification_no"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityDateIdx: index("death_notifications_facility_date_idx").on(
      table.facilityId,
      table.dateOfDeath,
    ),
    facilityNotificationIdx: index("death_notifications_facility_notification_idx").on(
      table.facilityId,
      table.notificationNo,
    ),
  }),
);

export type ReportCatalogue = typeof reportCatalogue.$inferSelect;
export type ReportRun = typeof reportRuns.$inferSelect;
export type ReportCell = typeof reportCells.$inferSelect;
export type ReportDefinition = typeof reportDefinitions.$inferSelect;
export type NotifiableEvent = typeof notifiableEvents.$inferSelect;
export type BirthNotification = typeof birthNotifications.$inferSelect;
export type DeathNotification = typeof deathNotifications.$inferSelect;
