import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { ADMIN_SECTIONS } from "../../../lib/admin-sections";
import { newId } from "../../../lib/uuid";
import { user } from "./auth";
import { branches, facilities } from "./tenancy";

export const roleEnum = pgEnum("staff_role", [
  "receptionist",
  "triage_nurse",
  "doctor",
  "lab_tech",
  "pharmacist",
  "cashier",
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "procurement_officer",
  "store_manager",
  "hr_officer",
  "payroll_officer",
  "asset_manager",
  "auditor",
  "regulatory_officer",
  "dpo",
  "admin",
]);

export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    staffNumber: varchar("staff_number", { length: 32 }).notNull().unique(),
    phone: varchar("phone", { length: 50 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    staffNumberIdx: uniqueIndex("staff_profiles_staff_number_idx").on(table.staffNumber),
  }),
);

export const staffRoleScopes = pgTable(
  "staff_role_scopes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("staff_role_scopes_user_idx").on(table.userId),
    facilityIdx: index("staff_role_scopes_facility_idx").on(table.facilityId),
    uniqueAllBranches: uniqueIndex("staff_role_scopes_unique_all_branches")
      .on(table.userId, table.role, table.facilityId)
      .where(sql`${table.branchId} is null`),
    uniqueBranch: uniqueIndex("staff_role_scopes_unique_branch")
      .on(table.userId, table.role, table.facilityId, table.branchId)
      .where(sql`${table.branchId} is not null`),
  }),
);

export const adminSectionEnum = pgEnum("admin_section", ADMIN_SECTIONS);

/**
 * Explicit per-section grants. No rows for a user/facility means legacy full
 * administration access; any row means only the listed sections are allowed.
 */
export const adminSectionPermissions = pgTable(
  "admin_section_permissions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    section: adminSectionEnum("section").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userFacilityIdx: index("admin_section_permissions_user_facility_idx").on(
      table.userId,
      table.facilityId,
    ),
    uniqueGrant: uniqueIndex("admin_section_permissions_unique")
      .on(table.userId, table.facilityId, table.section),
  }),
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityIdx: index("devices_facility_idx").on(table.facilityId),
  }),
);

export type Role = (typeof roleEnum.enumValues)[number];
export const ALL_ROLES: Role[] = roleEnum.enumValues;
