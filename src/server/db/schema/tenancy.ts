import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

export const writeAuthorityEnum = pgEnum("write_authority", ["cloud", "clinic"]);
export const departmentKindEnum = pgEnum("department_kind", [
  "opd",
  "triage",
  "reception",
  "lab",
  "pharmacy",
  "cashier",
  "admin",
  "other",
]);
export const storeKindEnum = pgEnum("store_kind", ["pharmacy", "main", "lab"]);

export const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by"),
  version: integer("version").notNull().default(1),
};

export const facilities = pgTable(
  "facilities",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    code: varchar("code", { length: 32 }).notNull().unique(),
    name: text("name").notNull(),
    county: text("county"),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 255 }),
    writeAuthority: writeAuthorityEnum("write_authority").notNull().default("cloud"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Africa/Nairobi"),
    ...auditColumns,
  },
  (table) => ({
    codeIdx: uniqueIndex("facilities_code_idx").on(table.code),
  }),
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    isMain: boolean("is_main").notNull().default(false),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("branches_facility_code_idx").on(table.facilityId, table.code),
    facilityIdx: index("branches_facility_idx").on(table.facilityId),
  }),
);

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: departmentKindEnum("kind").notNull(),
    ...auditColumns,
  },
  (table) => ({
    facilityBranchNameIdx: uniqueIndex("departments_facility_branch_name_idx").on(
      table.facilityId,
      table.branchId,
      table.name,
    ),
    facilityIdx: index("departments_facility_idx").on(table.facilityId),
  }),
);

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    ...auditColumns,
  },
  (table) => ({
    departmentNameIdx: uniqueIndex("rooms_department_name_idx").on(table.departmentId, table.name),
    facilityIdx: index("rooms_facility_idx").on(table.facilityId),
  }),
);

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: storeKindEnum("kind").notNull(),
    ...auditColumns,
  },
  (table) => ({
    facilityBranchNameIdx: uniqueIndex("stores_facility_branch_name_idx").on(
      table.facilityId,
      table.branchId,
      table.name,
    ),
    facilityIdx: index("stores_facility_idx").on(table.facilityId),
  }),
);

export const numberSequences = pgTable(
  "number_sequences",
  {
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    scope: varchar("scope", { length: 64 }).notNull(),
    year: integer("year").notNull(),
    nextValue: integer("next_value").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.facilityId, table.scope, table.year] }),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    userId: text("user_id"),
    action: varchar("action", { length: 128 }).notNull(),
    module: varchar("module", { length: 64 }).notNull(),
    entity: varchar("entity", { length: 64 }).notNull(),
    entityId: text("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    deviceId: text("device_id"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityCreatedIdx: index("audit_log_facility_created_idx").on(table.facilityId, table.createdAt),
    entityIdx: index("audit_log_entity_idx").on(table.facilityId, table.entity, table.entityId),
  }),
);

export const commandLog = pgTable(
  "command_log",
  {
    idempotencyKey: uuid("idempotency_key").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    command: varchar("command", { length: 128 }).notNull(),
    result: jsonb("result").$type<unknown>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityCreatedIdx: index("command_log_facility_created_idx").on(table.facilityId, table.createdAt),
  }),
);

export type Facility = typeof facilities.$inferSelect;
export type NewFacility = typeof facilities.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
