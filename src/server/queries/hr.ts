import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  attendanceRecords,
  departments,
  employees,
  employmentContracts,
  leaveRequests,
  positions,
  shiftTemplates,
} from "@/server/db/schema";

export type HrDatabase = typeof db;

export interface HrOverview {
  activeEmployees: number;
  openPositions: number;
  pendingLeave: number;
  attendanceToday: number;
  contractsExpiring: number;
}

export async function getHrOverview(
  database: HrDatabase,
  facilityId: string,
  today: string,
): Promise<HrOverview> {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::int FROM employees
        WHERE facility_id = ${facilityId}::uuid AND employment_status = 'active') AS active_employees,
      (SELECT count(*)::int FROM positions
        WHERE facility_id = ${facilityId}::uuid AND active = true) AS open_positions,
      (SELECT count(*)::int FROM leave_requests
        WHERE facility_id = ${facilityId}::uuid AND status = 'requested') AS pending_leave,
      (SELECT count(*)::int FROM attendance_records
        WHERE facility_id = ${facilityId}::uuid AND work_date = ${today}::date) AS attendance_today,
      (SELECT count(*)::int FROM employment_contracts
        WHERE facility_id = ${facilityId}::uuid AND active = true
          AND end_date IS NOT NULL AND end_date <= (${today}::date + interval '30 days')::date)
        AS contracts_expiring
  `);
  const row = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};
  return {
    activeEmployees: Number(row.active_employees ?? 0),
    openPositions: Number(row.open_positions ?? 0),
    pendingLeave: Number(row.pending_leave ?? 0),
    attendanceToday: Number(row.attendance_today ?? 0),
    contractsExpiring: Number(row.contracts_expiring ?? 0),
  };
}

export interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  nationalId: string | null;
  phone: string | null;
  bankName: string | null;
  employmentStatus: string;
  dateOfJoining: string | null;
}

export async function listEmployees(
  database: HrDatabase,
  facilityId: string,
): Promise<EmployeeRow[]> {
  return database
    .select({
      id: employees.id,
      employeeNo: employees.employeeNo,
      name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
      nationalId: employees.nationalId,
      phone: employees.phone,
      bankName: employees.bankName,
      employmentStatus: employees.employmentStatus,
      dateOfJoining: employees.dateOfJoining,
    })
    .from(employees)
    .where(eq(employees.facilityId, facilityId))
    .orderBy(employees.employeeNo);
}

export interface PositionRow {
  id: string;
  code: string;
  title: string;
  departmentName: string | null;
  grade: string | null;
  active: boolean;
}

export async function listPositions(
  database: HrDatabase,
  facilityId: string,
): Promise<PositionRow[]> {
  return database
    .select({
      id: positions.id,
      code: positions.code,
      title: positions.title,
      departmentName: departments.name,
      grade: positions.grade,
      active: positions.active,
    })
    .from(positions)
    .leftJoin(departments, eq(positions.departmentId, departments.id))
    .where(eq(positions.facilityId, facilityId))
    .orderBy(positions.code);
}

export interface ContractRow {
  id: string;
  employeeName: string;
  positionTitle: string;
  contractType: string;
  startDate: string;
  endDate: string | null;
  basicSalary: string;
  active: boolean;
}

export async function listContracts(
  database: HrDatabase,
  facilityId: string,
): Promise<ContractRow[]> {
  return database
    .select({
      id: employmentContracts.id,
      employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
      positionTitle: positions.title,
      contractType: employmentContracts.contractType,
      startDate: employmentContracts.startDate,
      endDate: employmentContracts.endDate,
      basicSalary: employmentContracts.basicSalary,
      active: employmentContracts.active,
    })
    .from(employmentContracts)
    .innerJoin(employees, eq(employmentContracts.employeeId, employees.id))
    .innerJoin(positions, eq(employmentContracts.positionId, positions.id))
    .where(eq(employmentContracts.facilityId, facilityId))
    .orderBy(desc(employmentContracts.startDate))
    .limit(200);
}

export interface ShiftTemplateRow {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

export async function listShiftTemplates(
  database: HrDatabase,
  facilityId: string,
): Promise<ShiftTemplateRow[]> {
  return database
    .select({
      id: shiftTemplates.id,
      code: shiftTemplates.code,
      name: shiftTemplates.name,
      startTime: shiftTemplates.startTime,
      endTime: shiftTemplates.endTime,
      active: shiftTemplates.active,
    })
    .from(shiftTemplates)
    .where(eq(shiftTemplates.facilityId, facilityId))
    .orderBy(shiftTemplates.code);
}

export interface AttendanceRow {
  id: string;
  employeeName: string;
  workDate: string;
  status: string;
  hoursWorked: string;
  note: string | null;
}

export async function listAttendance(
  database: HrDatabase,
  facilityId: string,
): Promise<AttendanceRow[]> {
  return database
    .select({
      id: attendanceRecords.id,
      employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
      workDate: attendanceRecords.workDate,
      status: attendanceRecords.status,
      hoursWorked: attendanceRecords.hoursWorked,
      note: attendanceRecords.note,
    })
    .from(attendanceRecords)
    .innerJoin(employees, eq(attendanceRecords.employeeId, employees.id))
    .where(eq(attendanceRecords.facilityId, facilityId))
    .orderBy(desc(attendanceRecords.workDate))
    .limit(200);
}

export interface LeaveRequestRow {
  id: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  rejectedReason: string | null;
}

export async function listLeaveRequests(
  database: HrDatabase,
  facilityId: string,
): Promise<LeaveRequestRow[]> {
  return database
    .select({
      id: leaveRequests.id,
      employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
      leaveType: leaveRequests.leaveType,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      days: leaveRequests.days,
      reason: leaveRequests.reason,
      status: leaveRequests.status,
      requestedBy: leaveRequests.requestedBy,
      decidedBy: leaveRequests.decidedBy,
      rejectedReason: leaveRequests.rejectedReason,
    })
    .from(leaveRequests)
    .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
    .where(eq(leaveRequests.facilityId, facilityId))
    .orderBy(desc(leaveRequests.startDate))
    .limit(200);
}

/** Payroll needs a compact employee picker with the current pay basis. */
export async function listPayrollEmployees(
  database: HrDatabase,
  facilityId: string,
): Promise<Array<{ id: string; employeeNo: string; name: string; basicSalary: string | null }>> {
  const result = await database.execute(sql`
    SELECT e.id, e.employee_no AS "employeeNo",
           e.first_name || ' ' || e.last_name AS name,
           (SELECT c.basic_salary::text FROM employment_contracts c
              WHERE c.employee_id = e.id AND c.active = true
              ORDER BY c.start_date DESC LIMIT 1) AS "basicSalary"
    FROM employees e
    WHERE e.facility_id = ${facilityId}::uuid AND e.employment_status = 'active'
    ORDER BY e.employee_no
  `);
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map((row) => ({
    id: String(row.id),
    employeeNo: String(row.employeeNo),
    name: String(row.name),
    basicSalary: row.basicSalary === null ? null : String(row.basicSalary),
  }));
}

export async function getAttendanceForEmployee(
  database: HrDatabase,
  facilityId: string,
  employeeId: string,
  startDate: string,
  endDate: string,
) {
  return database
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.facilityId, facilityId),
        eq(attendanceRecords.employeeId, employeeId),
        sql`${attendanceRecords.workDate} between ${startDate}::date and ${endDate}::date`,
      ),
    );
}
