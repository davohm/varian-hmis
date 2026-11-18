import { index, integer, numeric, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { encounters } from "./patients";
import { auditColumns, facilities } from "./tenancy";

export const triageCategoryEnum = pgEnum("triage_category", ["red", "yellow", "green"]);

export const triageVitals = pgTable(
  "triage_vitals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    systolic: integer("systolic"),
    diastolic: integer("diastolic"),
    heartRate: integer("heart_rate"),
    respRate: integer("resp_rate"),
    temperature: numeric("temperature", { precision: 4, scale: 1 }),
    spo2: integer("spo2"),
    weightKg: numeric("weight_kg", { precision: 5, scale: 2 }),
    heightCm: numeric("height_cm", { precision: 5, scale: 1 }),
    bmi: numeric("bmi", { precision: 6, scale: 1 }),
    painScore: integer("pain_score"),
    muacCm: numeric("muac_cm", { precision: 4, scale: 1 }),
    category: triageCategoryEnum("category").notNull(),
    chiefComplaint: text("chief_complaint").notNull(),
    comments: text("comments"),
    nextSteps: text("next_steps"),
    recordedBy: text("recorded_by").notNull(),
    ...auditColumns,
  },
  (table) => ({
    facilityEncounterIdx: index("triage_vitals_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityCreatedIdx: index("triage_vitals_facility_created_idx").on(
      table.facilityId,
      table.createdAt,
    ),
  }),
);

export type TriageVitals = typeof triageVitals.$inferSelect;
export type NewTriageVitals = typeof triageVitals.$inferInsert;
export type TriageCategory = (typeof triageCategoryEnum.enumValues)[number];
