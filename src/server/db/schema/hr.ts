import {
  boolean,
  date,
  index,
  integer,
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

import { user } from "./auth";
import { auditColumns, departments, facilities } from "./tenancy";

export const employmentStatusEnum = pgEnum("employment_status", [
  "active",
  "on_leave",
  "suspended",
  "terminated",
]);

export const contractTypeEnum = pgEnum("contract_type", [
  "permanent",
  "fixed_term",
  "internship",
  "locum",
]);

export const attendanceStatusEnum = pgEnum("attendance_status", [
  "present",
  "absent",
  "half_day",
  "leave",
]);

export const leaveTypeEnum = pgEnum("leave_type", [
  "annual",
  "sick",
  "maternity",
  "paternity",
  "unpaid",
  "compassionate",
]);

export const leaveStatusEnum = pgEnum("leave_status", [
  "requested",
  "approved",
  "rejected",
  "cancelled",
]);

/**
 * Employee master. Payroll data is personnel data: rows are retired with a
 * status change, never physically deleted, and access is restricted by role.
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    employeeNo: varchar("employee_no", { length: 32 }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    firstName: varchar("first_name", { length: 120 }).notNull(),
    lastName: varchar("last_name", { length: 120 }).notNull(),
    nationalId: varchar("national_id", { length: 64 }),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 255 }),
    bankName: varchar("bank_name", { length: 120 }),
    bankBranch: varchar("bank_branch", { length: 120 }),
    bankAccountNumber: varchar("bank_account_number", { length: 64 }),
    employmentStatus: employmentStatusEnum("employment_status").notNull().default("active"),
    dateOfJoining: date("date_of_joining"),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("employees_facility_no_idx").on(table.facilityId, table.employeeNo),
    facilityStatusIdx: index("employees_facility_status_idx").on(
      table.facilityId,
      table.employmentStatus,
    ),
    userIdx: uniqueIndex("employees_user_idx").on(table.userId),
  }),
);

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    grade: varchar("grade", { length: 32 }),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("positions_facility_code_idx").on(table.facilityId, table.code),
    facilityIdx: index("positions_facility_idx").on(table.facilityId),
  }),
);

export const employmentContracts = pgTable(
  "employment_contracts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    contractType: contractTypeEnum("contract_type").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    basicSalary: numeric("basic_salary", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    employeeIdx: index("employment_contracts_employee_idx").on(table.employeeId),
    facilityIdx: index("employment_contracts_facility_idx").on(table.facilityId),
  }),
);

export const shiftTemplates = pgTable(
  "shift_templates",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    startTime: varchar("start_time", { length: 5 }).notNull(),
    endTime: varchar("end_time", { length: 5 }).notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("shift_templates_facility_code_idx").on(
      table.facilityId,
      table.code,
    ),
  }),
);

export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    shiftTemplateId: uuid("shift_template_id")
      .notNull()
      .references(() => shiftTemplates.id, { onDelete: "restrict" }),
    assignedDate: date("assigned_date").notNull(),
    ...auditColumns,
  },
  (table) => ({
    employeeDateIdx: uniqueIndex("shift_assignments_employee_date_idx").on(
      table.facilityId,
      table.employeeId,
      table.assignedDate,
    ),
    facilityIdx: index("shift_assignments_facility_idx").on(table.facilityId),
  }),
);

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    workDate: date("work_date").notNull(),
    status: attendanceStatusEnum("status").notNull(),
    hoursWorked: numeric("hours_worked", { precision: 5, scale: 2 }).notNull().default("0"),
    shiftAssignmentId: uuid("shift_assignment_id").references(() => shiftAssignments.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    employeeDateIdx: uniqueIndex("attendance_records_employee_date_idx").on(
      table.facilityId,
      table.employeeId,
      table.workDate,
    ),
    facilityDateIdx: index("attendance_records_facility_date_idx").on(
      table.facilityId,
      table.workDate,
    ),
  }),
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    leaveType: leaveTypeEnum("leave_type").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    days: integer("days").notNull(),
    reason: text("reason").notNull(),
    status: leaveStatusEnum("status").notNull().default("requested"),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    ...auditColumns,
  },
  (table) => ({
    employeeIdx: index("leave_requests_employee_idx").on(table.employeeId),
    facilityStatusIdx: index("leave_requests_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);
