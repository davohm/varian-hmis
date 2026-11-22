import {
  date,
  index,
  jsonb,
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

import { costCenters, journalEntries } from "./finance";
import { employees } from "./hr";
import { auditColumns, facilities } from "./tenancy";

export const payrollRunStatusEnum = pgEnum("payroll_run_status", [
  "draft",
  "approved",
  "posted",
  "cancelled",
]);

export const payrollDecisionEnum = pgEnum("payroll_decision", ["approved", "rejected"]);

/**
 * A run is prepared, approved and posted by separate actors. Money is never
 * edited after approval: a correction is a new run, not a change to posted pay.
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runNo: varchar("run_no", { length: 40 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    description: text("description"),
    status: payrollRunStatusEnum("status").notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    totalGross: numeric("total_gross", { precision: 14, scale: 2 }).notNull(),
    totalDeductions: numeric("total_deductions", { precision: 14, scale: 2 }).notNull(),
    totalNet: numeric("total_net", { precision: 14, scale: 2 }).notNull(),
    totalEmployerCost: numeric("total_employer_cost", { precision: 14, scale: 2 }).notNull(),
    missingRateTypes: jsonb("missing_rate_types").$type<string[]>().notNull().default([]),
    preparedBy: text("prepared_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedBy: text("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("payroll_runs_facility_no_idx").on(table.facilityId, table.runNo),
    facilityStatusIdx: index("payroll_runs_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

/** Calculated pay lines are evidence: append-only, never edited in place. */
export const payrollLines = pgTable(
  "payroll_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    employeeNo: varchar("employee_no", { length: 32 }).notNull(),
    employeeName: varchar("employee_name", { length: 240 }).notNull(),
    basicSalary: numeric("basic_salary", { precision: 14, scale: 2 }).notNull(),
    allowances: numeric("allowances", { precision: 14, scale: 2 }).notNull(),
    grossPay: numeric("gross_pay", { precision: 14, scale: 2 }).notNull(),
    paye: numeric("paye", { precision: 14, scale: 2 }).notNull(),
    nssfEmployee: numeric("nssf_employee", { precision: 14, scale: 2 }).notNull(),
    nssfEmployer: numeric("nssf_employer", { precision: 14, scale: 2 }).notNull(),
    shif: numeric("shif", { precision: 14, scale: 2 }).notNull(),
    housingLevy: numeric("housing_levy", { precision: 14, scale: 2 }).notNull(),
    otherDeductions: numeric("other_deductions", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    netPay: numeric("net_pay", { precision: 14, scale: 2 }).notNull(),
    employerCost: numeric("employer_cost", { precision: 14, scale: 2 }).notNull(),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    missingRateTypes: jsonb("missing_rate_types").$type<string[]>().notNull().default([]),
    ...auditColumns,
  },
  (table) => ({
    runEmployeeIdx: uniqueIndex("payroll_lines_run_employee_idx").on(
      table.runId,
      table.employeeId,
    ),
    facilityIdx: index("payroll_lines_facility_idx").on(table.facilityId),
  }),
);

/** A payslip is an immutable snapshot issued from a posted run. */
export const payslips = pgTable(
  "payslips",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "restrict" }),
    lineId: uuid("line_id")
      .notNull()
      .references(() => payrollLines.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    slipNo: varchar("slip_no", { length: 40 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    snapshot: jsonb("snapshot").notNull(),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("payslips_facility_no_idx").on(table.facilityId, table.slipNo),
    runIdx: index("payslips_run_idx").on(table.runId),
  }),
);

export const payrollRunApprovals = pgTable(
  "payroll_run_approvals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "restrict" }),
    decision: payrollDecisionEnum("decision").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    runIdx: index("payroll_run_approvals_run_idx").on(table.runId),
    facilityIdx: index("payroll_run_approvals_facility_idx").on(table.facilityId),
  }),
);
