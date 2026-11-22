import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { ForbiddenError } from "@/server/auth/guards";
import {
  attendanceRecords,
  employees,
  employmentContracts,
  facilities,
  leaveRequests,
  positions,
  shiftAssignments,
  shiftTemplates,
  user,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { nextFormattedNumber } from "@/server/numbering";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");

const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));

const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM time");

function assertDifferentActor(action: string, current: string, prior: string | null): void {
  if (prior && current === prior) {
    throw new ForbiddenError(`The same user cannot ${action}`);
  }
}

async function loadFacility(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const facility = rows[0];
  if (!facility) throw new Error("Facility not found");
  return facility;
}

async function assertFacilityRow(
  tx: CommandTransaction,
  table: "employees" | "positions" | "shiftTemplates" | "leaveRequests",
  facilityId: string,
  id: string,
): Promise<void> {
  const source = { employees, positions, shiftTemplates, leaveRequests }[table];
  const rows = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.id, id), eq(source.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error(`Unknown ${table.replace(/([A-Z])/g, " $1").toLowerCase()}`);
}

async function auditAndEvent(
  tx: CommandTransaction,
  input: {
    facilityId: string;
    userId: string;
    ip?: string | null;
    deviceId?: string | null;
    action: string;
    entity: string;
    entityId: string;
    details: Record<string, unknown>;
    eventType: string;
    event: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(tx, {
    facilityId: input.facilityId,
    userId: input.userId,
    action: input.action,
    module: "hr",
    entity: input.entity,
    entityId: input.entityId,
    details: input.details,
    ip: input.ip,
    deviceId: input.deviceId,
  });
  await publishEvent(tx, {
    type: input.eventType,
    facilityId: input.facilityId,
    ...input.event,
  });
}

/** Calendar days inclusive of both ends. */
export function leaveDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid leave date");
  return Math.floor((end - start) / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* Positions and employees                                             */
/* ------------------------------------------------------------------ */

export const createPositionSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1, "A position code is required")
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores"),
  title: z.string().trim().min(1).max(160),
  departmentId: z.uuid().nullable().optional(),
  grade: z.string().trim().max(32).nullable().optional(),
});

export type CreatePositionInput = z.input<typeof createPositionSchema>;

export async function createPosition(
  input: CreatePositionInput,
  options: CommandOptions = {},
): Promise<{ positionId: string; code: string; title: string }> {
  const values = createPositionSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPosition",
    async (tx) => {
      const duplicate = await tx
        .select({ id: positions.id })
        .from(positions)
        .where(and(eq(positions.facilityId, values.facilityId), eq(positions.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Position code ${code} already exists`);

      const positionId = newId();
      await tx.insert(positions).values({
        id: positionId,
        facilityId: values.facilityId,
        code,
        title: values.title,
        departmentId: values.departmentId ?? null,
        grade: values.grade ?? null,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.position.create",
        entity: "positions",
        entityId: positionId,
        details: { code, title: values.title },
        eventType: "hr.position.created",
        event: { positionId, code },
      });
      return { positionId, code, title: values.title };
    },
    options,
  );
}

export const createEmployeeSchema = z.object({
  ...baseSchema,
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  nationalId: z.string().trim().max(64).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.email().max(255).nullable().optional(),
  bankName: z.string().trim().max(120).nullable().optional(),
  bankBranch: z.string().trim().max(120).nullable().optional(),
  bankAccountNumber: z.string().trim().max(64).nullable().optional(),
  userId: z.string().nullable().optional(),
  dateOfJoining: isoDate.nullable().optional(),
});

export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;

export async function createEmployee(
  input: CreateEmployeeInput,
  options: CommandOptions = {},
): Promise<{ employeeId: string; employeeNo: string; name: string }> {
  const values = createEmployeeSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createEmployee",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      if (values.userId) {
        const accounts = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, values.userId))
          .limit(1);
        if (!accounts[0]) throw new Error("The linked user account does not exist");
        const linked = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(eq(employees.userId, values.userId))
          .limit(1);
        if (linked[0]) throw new Error("That user is already linked to an employee");
      }

      const employeeNo = await nextFormattedNumber(tx, facility, "employee");
      const employeeId = newId();
      const name = `${values.firstName} ${values.lastName}`;
      await tx.insert(employees).values({
        id: employeeId,
        facilityId: values.facilityId,
        employeeNo,
        userId: values.userId ?? null,
        firstName: values.firstName,
        lastName: values.lastName,
        nationalId: values.nationalId ?? null,
        phone: values.phone ?? null,
        email: values.email ?? null,
        bankName: values.bankName ?? null,
        bankBranch: values.bankBranch ?? null,
        bankAccountNumber: values.bankAccountNumber ?? null,
        dateOfJoining: values.dateOfJoining ?? null,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.employee.create",
        entity: "employees",
        entityId: employeeId,
        details: { employeeNo, name },
        eventType: "hr.employee.created",
        event: { employeeId, employeeNo },
      });
      return { employeeId, employeeNo, name };
    },
    options,
  );
}

export const createEmploymentContractSchema = z.object({
  ...baseSchema,
  employeeId: z.uuid(),
  positionId: z.uuid(),
  contractType: z.enum(["permanent", "fixed_term", "internship", "locum"]),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  basicSalary: money.refine((value) => toCents(value) > 0, "Basic salary must be positive"),
});

export type CreateEmploymentContractInput = z.input<typeof createEmploymentContractSchema>;

export async function createEmploymentContract(
  input: CreateEmploymentContractInput,
  options: CommandOptions = {},
): Promise<{ contractId: string; startDate: string; basicSalary: string }> {
  const values = createEmploymentContractSchema.parse(input);
  const userId = actorId(values);
  if (values.endDate && values.endDate < values.startDate) {
    throw new Error("The contract end date cannot be before its start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createEmploymentContract",
    async (tx) => {
      await assertFacilityRow(tx, "employees", values.facilityId, values.employeeId);
      await assertFacilityRow(tx, "positions", values.facilityId, values.positionId);

      await tx
        .update(employmentContracts)
        .set({ active: false, updatedAt: new Date(), version: sql`${employmentContracts.version} + 1` })
        .where(
          and(
            eq(employmentContracts.facilityId, values.facilityId),
            eq(employmentContracts.employeeId, values.employeeId),
            eq(employmentContracts.active, true),
          ),
        );

      const contractId = newId();
      await tx.insert(employmentContracts).values({
        id: contractId,
        facilityId: values.facilityId,
        employeeId: values.employeeId,
        positionId: values.positionId,
        contractType: values.contractType,
        startDate: values.startDate,
        endDate: values.endDate ?? null,
        basicSalary: values.basicSalary,
        active: true,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.contract.create",
        entity: "employment_contracts",
        entityId: contractId,
        details: {
          employeeId: values.employeeId,
          positionId: values.positionId,
          basicSalary: values.basicSalary,
        },
        eventType: "hr.contract.created",
        event: { contractId, employeeId: values.employeeId },
      });
      return { contractId, startDate: values.startDate, basicSalary: values.basicSalary };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Shifts, attendance and leave                                        */
/* ------------------------------------------------------------------ */

export const createShiftTemplateSchema = z.object({
  ...baseSchema,
  code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  startTime: clockTime,
  endTime: clockTime,
});

export type CreateShiftTemplateInput = z.input<typeof createShiftTemplateSchema>;

export async function createShiftTemplate(
  input: CreateShiftTemplateInput,
  options: CommandOptions = {},
): Promise<{ shiftTemplateId: string; code: string }> {
  const values = createShiftTemplateSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createShiftTemplate",
    async (tx) => {
      const duplicate = await tx
        .select({ id: shiftTemplates.id })
        .from(shiftTemplates)
        .where(and(eq(shiftTemplates.facilityId, values.facilityId), eq(shiftTemplates.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Shift code ${code} already exists`);

      const shiftTemplateId = newId();
      await tx.insert(shiftTemplates).values({
        id: shiftTemplateId,
        facilityId: values.facilityId,
        code,
        name: values.name,
        startTime: values.startTime,
        endTime: values.endTime,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.shift_template.create",
        entity: "shift_templates",
        entityId: shiftTemplateId,
        details: { code, name: values.name },
        eventType: "hr.shift_template.created",
        event: { shiftTemplateId, code },
      });
      return { shiftTemplateId, code };
    },
    options,
  );
}

export const assignShiftSchema = z.object({
  ...baseSchema,
  employeeId: z.uuid(),
  shiftTemplateId: z.uuid(),
  assignedDate: isoDate,
});

export type AssignShiftInput = z.input<typeof assignShiftSchema>;

export async function assignShift(
  input: AssignShiftInput,
  options: CommandOptions = {},
): Promise<{ assignmentId: string; assignedDate: string }> {
  const values = assignShiftSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "assignShift",
    async (tx) => {
      await assertFacilityRow(tx, "employees", values.facilityId, values.employeeId);
      await assertFacilityRow(tx, "shiftTemplates", values.facilityId, values.shiftTemplateId);

      const existing = await tx
        .select({ id: shiftAssignments.id })
        .from(shiftAssignments)
        .where(
          and(
            eq(shiftAssignments.facilityId, values.facilityId),
            eq(shiftAssignments.employeeId, values.employeeId),
            eq(shiftAssignments.assignedDate, values.assignedDate),
          ),
        )
        .limit(1)
        .for("update");
      const assignmentId = existing[0]?.id ?? newId();
      if (existing[0]) {
        await tx
          .update(shiftAssignments)
          .set({
            shiftTemplateId: values.shiftTemplateId,
            updatedAt: new Date(),
            version: sql`${shiftAssignments.version} + 1`,
          })
          .where(eq(shiftAssignments.id, assignmentId));
      } else {
        await tx.insert(shiftAssignments).values({
          id: assignmentId,
          facilityId: values.facilityId,
          employeeId: values.employeeId,
          shiftTemplateId: values.shiftTemplateId,
          assignedDate: values.assignedDate,
          createdBy: userId,
        });
      }
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.shift.assign",
        entity: "shift_assignments",
        entityId: assignmentId,
        details: { employeeId: values.employeeId, assignedDate: values.assignedDate },
        eventType: "hr.shift.assigned",
        event: { assignmentId, employeeId: values.employeeId },
      });
      return { assignmentId, assignedDate: values.assignedDate };
    },
    options,
  );
}

export const recordAttendanceSchema = z.object({
  ...baseSchema,
  employeeId: z.uuid(),
  workDate: isoDate,
  status: z.enum(["present", "absent", "half_day", "leave"]),
  hoursWorked: z.number().min(0).max(24).default(8),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type RecordAttendanceInput = z.input<typeof recordAttendanceSchema>;

export async function recordAttendance(
  input: RecordAttendanceInput,
  options: CommandOptions = {},
): Promise<{ attendanceId: string; workDate: string; status: string }> {
  const values = recordAttendanceSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordAttendance",
    async (tx) => {
      await assertFacilityRow(tx, "employees", values.facilityId, values.employeeId);
      const assignment = await tx
        .select({ id: shiftAssignments.id })
        .from(shiftAssignments)
        .where(
          and(
            eq(shiftAssignments.facilityId, values.facilityId),
            eq(shiftAssignments.employeeId, values.employeeId),
            eq(shiftAssignments.assignedDate, values.workDate),
          ),
        )
        .limit(1);

      const existing = await tx
        .select({ id: attendanceRecords.id })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.facilityId, values.facilityId),
            eq(attendanceRecords.employeeId, values.employeeId),
            eq(attendanceRecords.workDate, values.workDate),
          ),
        )
        .limit(1)
        .for("update");
      const attendanceId = existing[0]?.id ?? newId();
      const hours = values.status === "absent" || values.status === "leave" ? 0 : values.hoursWorked;
      if (existing[0]) {
        await tx
          .update(attendanceRecords)
          .set({
            status: values.status,
            hoursWorked: String(hours),
            shiftAssignmentId: assignment[0]?.id ?? null,
            note: values.note ?? null,
            updatedAt: new Date(),
            version: sql`${attendanceRecords.version} + 1`,
          })
          .where(eq(attendanceRecords.id, attendanceId));
      } else {
        await tx.insert(attendanceRecords).values({
          id: attendanceId,
          facilityId: values.facilityId,
          employeeId: values.employeeId,
          workDate: values.workDate,
          status: values.status,
          hoursWorked: String(hours),
          shiftAssignmentId: assignment[0]?.id ?? null,
          note: values.note ?? null,
          createdBy: userId,
        });
      }
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.attendance.record",
        entity: "attendance_records",
        entityId: attendanceId,
        details: { employeeId: values.employeeId, workDate: values.workDate, status: values.status },
        eventType: "hr.attendance.recorded",
        event: { attendanceId, employeeId: values.employeeId },
      });
      return { attendanceId, workDate: values.workDate, status: values.status };
    },
    options,
  );
}

export const requestLeaveSchema = z.object({
  ...baseSchema,
  employeeId: z.uuid(),
  leaveType: z.enum(["annual", "sick", "maternity", "paternity", "unpaid", "compassionate"]),
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().trim().min(1).max(2000),
});

export type RequestLeaveInput = z.input<typeof requestLeaveSchema>;

export async function requestLeave(
  input: RequestLeaveInput,
  options: CommandOptions = {},
): Promise<{ leaveRequestId: string; days: number; status: string }> {
  const values = requestLeaveSchema.parse(input);
  const userId = actorId(values);
  if (values.endDate < values.startDate) {
    throw new Error("The leave end date cannot be before its start date");
  }
  const days = leaveDays(values.startDate, values.endDate);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestLeave",
    async (tx) => {
      await assertFacilityRow(tx, "employees", values.facilityId, values.employeeId);
      const overlap = await tx
        .select({ id: leaveRequests.id })
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.facilityId, values.facilityId),
            eq(leaveRequests.employeeId, values.employeeId),
            eq(leaveRequests.status, "approved"),
            lte(leaveRequests.startDate, values.endDate),
            gte(leaveRequests.endDate, values.startDate),
          ),
        )
        .limit(1);
      if (overlap[0]) throw new Error("The employee already has approved leave in that period");

      const leaveRequestId = newId();
      await tx.insert(leaveRequests).values({
        id: leaveRequestId,
        facilityId: values.facilityId,
        employeeId: values.employeeId,
        leaveType: values.leaveType,
        startDate: values.startDate,
        endDate: values.endDate,
        days,
        reason: values.reason,
        status: "requested",
        requestedBy: userId,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.leave.request",
        entity: "leave_requests",
        entityId: leaveRequestId,
        details: { employeeId: values.employeeId, days, leaveType: values.leaveType },
        eventType: "hr.leave.requested",
        event: { leaveRequestId, employeeId: values.employeeId },
      });
      return { leaveRequestId, days, status: "requested" };
    },
    options,
  );
}

export const decideLeaveSchema = z.object({
  ...baseSchema,
  leaveRequestId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type DecideLeaveInput = z.input<typeof decideLeaveSchema>;

export async function decideLeave(
  input: DecideLeaveInput,
  options: CommandOptions = {},
): Promise<{ leaveRequestId: string; status: "approved" | "rejected" }> {
  const values = decideLeaveSchema.parse(input);
  const userId = actorId(values);
  if (values.decision === "rejected" && !values.reason?.trim()) {
    throw new Error("A reason is required to reject leave");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "decideLeave",
    async (tx) => {
      const rows = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.id, values.leaveRequestId),
            eq(leaveRequests.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const leave = rows[0];
      if (!leave) throw new Error("Leave request not found");
      if (leave.status !== "requested") throw new Error("Only requested leave can be decided");
      assertDifferentActor("decide their own leave request", userId, leave.requestedBy);

      await tx
        .update(leaveRequests)
        .set({
          status: values.decision,
          decidedBy: userId,
          decidedAt: new Date(),
          rejectedReason: values.decision === "rejected" ? values.reason!.trim() : null,
          updatedAt: new Date(),
          version: sql`${leaveRequests.version} + 1`,
        })
        .where(eq(leaveRequests.id, values.leaveRequestId));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "hr.leave.decide",
        entity: "leave_requests",
        entityId: values.leaveRequestId,
        details: { decision: values.decision, reason: values.reason ?? null },
        eventType: "hr.leave.decided",
        event: { leaveRequestId: values.leaveRequestId, decision: values.decision },
      });
      return { leaveRequestId: values.leaveRequestId, status: values.decision };
    },
    options,
  );
}

/** Active contract used as the pay basis; the latest start date wins. */
export async function activeContractForEmployee(
  tx: CommandTransaction,
  facilityId: string,
  employeeId: string,
  onDate: string,
): Promise<{ id: string; basicSalary: string; positionId: string } | null> {
  const rows = await tx
    .select({
      id: employmentContracts.id,
      basicSalary: employmentContracts.basicSalary,
      positionId: employmentContracts.positionId,
      endDate: employmentContracts.endDate,
    })
    .from(employmentContracts)
    .where(
      and(
        eq(employmentContracts.facilityId, facilityId),
        eq(employmentContracts.employeeId, employeeId),
        eq(employmentContracts.active, true),
        lte(employmentContracts.startDate, onDate),
      ),
    )
    .orderBy(asc(employmentContracts.startDate));
  const latest = rows.at(-1);
  if (!latest) return null;
  if (latest.endDate && latest.endDate < onDate) return null;
  return latest;
}
