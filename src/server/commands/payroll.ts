import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import {
  calculatePayroll,
  PAYROLL_RATE_TYPES,
  type PayrollRateRow,
  type PayrollRateType,
} from "@/lib/payroll";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { ForbiddenError } from "@/server/auth/guards";
import {
  costCenters,
  employees,
  facilities,
  payrollLines,
  payrollRunApprovals,
  payrollRuns,
  payslips,
  statutoryRates,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { postJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { assertFinanceApprovalLimit } from "./finance";
import { activeContractForEmployee } from "./hr";
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
    module: "payroll",
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

async function loadRates(
  tx: CommandTransaction,
  facilityId: string,
  onDate: string,
): Promise<PayrollRateRow[]> {
  const rows = await tx
    .select({
      rateType: statutoryRates.rateType,
      bandOrder: statutoryRates.bandOrder,
      lowerBound: statutoryRates.lowerBound,
      upperBound: statutoryRates.upperBound,
      ratePercent: statutoryRates.ratePercent,
      fixedAmount: statutoryRates.fixedAmount,
    })
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.facilityId, facilityId),
        eq(statutoryRates.active, true),
        inArray(statutoryRates.rateType, [...PAYROLL_RATE_TYPES]),
        sql`${statutoryRates.effectiveFrom} <= ${onDate}::date`,
        sql`(${statutoryRates.effectiveTo} is null or ${statutoryRates.effectiveTo} >= ${onDate}::date)`,
      ),
    )
    .orderBy(asc(statutoryRates.rateType), asc(statutoryRates.bandOrder));
  return rows.map((rate) => ({
    rateType: rate.rateType,
    bandOrder: rate.bandOrder,
    lowerBound: rate.lowerBound,
    upperBound: rate.upperBound,
    ratePercent: rate.ratePercent,
    fixedAmount: rate.fixedAmount,
  }));
}

async function defaultCostCenter(
  tx: CommandTransaction,
  facilityId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: costCenters.id, code: costCenters.code })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.active, true)))
    .orderBy(asc(costCenters.code));
  return (rows.find((row) => row.code === "GEN") ?? rows[0])?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Prepare a run                                                       */
/* ------------------------------------------------------------------ */

const allocationSchema = z.object({
  employeeId: z.uuid(),
  costCenterId: z.uuid().nullable().optional(),
  allowances: money.optional(),
});

export const createPayrollRunSchema = z.object({
  ...baseSchema,
  periodStart: isoDate,
  periodEnd: isoDate,
  description: z.string().trim().max(500).nullable().optional(),
  allocations: z.array(allocationSchema).max(500).default([]),
});

export type CreatePayrollRunInput = z.input<typeof createPayrollRunSchema>;

export interface PayrollRunResult {
  runId: string;
  runNo: string;
  employeeCount: number;
  totalGross: string;
  totalNet: string;
  missingRateTypes: PayrollRateType[];
}

export async function createPayrollRun(
  input: CreatePayrollRunInput,
  options: CommandOptions = {},
): Promise<PayrollRunResult> {
  const values = createPayrollRunSchema.parse(input);
  const userId = actorId(values);
  if (values.periodEnd < values.periodStart) {
    throw new Error("The payroll period end cannot be before its start");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPayrollRun",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const allocationIds = [...new Set(values.allocations.map((item) => item.employeeId))];
      if (allocationIds.length) {
        const known = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(eq(employees.facilityId, values.facilityId), inArray(employees.id, allocationIds)),
          );
        if (known.length !== allocationIds.length) {
          throw new Error("One or more payroll allocations reference an unknown employee");
        }
      }
      const overrideCenterIds = [
        ...new Set(
          values.allocations
            .map((item) => item.costCenterId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (overrideCenterIds.length) {
        const centers = await tx
          .select({ id: costCenters.id })
          .from(costCenters)
          .where(
            and(
              eq(costCenters.facilityId, values.facilityId),
              inArray(costCenters.id, overrideCenterIds),
            ),
          );
        if (centers.length !== overrideCenterIds.length) {
          throw new Error("One or more cost centres are not available at this facility");
        }
      }

      const staff = await tx
        .select({ id: employees.id, employeeNo: employees.employeeNo, firstName: employees.firstName, lastName: employees.lastName })
        .from(employees)
        .where(
          and(eq(employees.facilityId, values.facilityId), eq(employees.employmentStatus, "active")),
        )
        .orderBy(asc(employees.employeeNo));
      if (staff.length === 0) throw new Error("There are no active employees to pay");

      const rates = await loadRates(tx, values.facilityId, values.periodEnd);
      const defaultCenter = await defaultCostCenter(tx, values.facilityId);
      const allocationByEmployee = new Map(values.allocations.map((item) => [item.employeeId, item]));
      const prepared: Array<{
        employee: (typeof staff)[number];
        costCenterId: string | null;
        basicCents: number;
        allowancesCents: number;
        calculation: ReturnType<typeof calculatePayroll>;
      }> = [];

      for (const employee of staff) {
        const contract = await activeContractForEmployee(
          tx,
          values.facilityId,
          employee.id,
          values.periodEnd,
        );
        if (!contract) continue;
        const allocation = allocationByEmployee.get(employee.id);
        const basicCents = toCents(contract.basicSalary);
        const allowancesCents = allocation?.allowances ? toCents(allocation.allowances) : 0;
        const calculation = calculatePayroll({ basicCents, allowancesCents, rates });
        prepared.push({
          employee,
          costCenterId: allocation?.costCenterId ?? defaultCenter,
          basicCents,
          allowancesCents,
          calculation,
        });
      }
      if (prepared.length === 0) {
        throw new Error("No active employee has a contract covering the payroll period");
      }

      const totalGrossCents = prepared.reduce((sum, row) => sum + row.calculation.grossCents, 0);
      const totalNetCents = prepared.reduce((sum, row) => sum + row.calculation.netCents, 0);
      const totalDeductionCents = prepared.reduce(
        (sum, row) =>
          sum + (row.calculation.grossCents - row.calculation.netCents),
        0,
      );
      const totalEmployerCents = prepared.reduce(
        (sum, row) => sum + toCents(row.calculation.employerCost),
        0,
      );
      const missingRateTypes = [
        ...new Set(prepared.flatMap((row) => row.calculation.missingRateTypes)),
      ];

      const runNo = await nextFormattedNumber(tx, facility, "payrollRun");
      const runId = newId();
      await tx.insert(payrollRuns).values({
        id: runId,
        facilityId: values.facilityId,
        runNo,
        periodStart: values.periodStart,
        periodEnd: values.periodEnd,
        description: values.description ?? null,
        status: "draft",
        totalGross: fromCents(totalGrossCents),
        totalDeductions: fromCents(totalDeductionCents),
        totalNet: fromCents(totalNetCents),
        totalEmployerCost: fromCents(totalEmployerCents),
        missingRateTypes,
        preparedBy: userId,
        createdBy: userId,
      });

      await tx.insert(payrollLines).values(
        prepared.map((row) => ({
          id: newId(),
          facilityId: values.facilityId,
          runId,
          employeeId: row.employee.id,
          employeeNo: row.employee.employeeNo,
          employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
          basicSalary: fromCents(row.basicCents),
          allowances: fromCents(row.allowancesCents),
          grossPay: row.calculation.gross,
          paye: row.calculation.paye,
          nssfEmployee: row.calculation.nssfEmployee,
          nssfEmployer: row.calculation.nssfEmployer,
          shif: row.calculation.shif,
          housingLevy: row.calculation.housingLevy,
          otherDeductions: row.calculation.otherDeductions,
          netPay: row.calculation.netPay,
          employerCost: row.calculation.employerCost,
          costCenterId: row.costCenterId,
          missingRateTypes: row.calculation.missingRateTypes,
          createdBy: userId,
        })),
      );

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "payroll.run.create",
        entity: "payroll_runs",
        entityId: runId,
        details: {
          runNo,
          periodStart: values.periodStart,
          periodEnd: values.periodEnd,
          employeeCount: prepared.length,
          missingRateTypes,
        },
        eventType: "payroll.run.created",
        event: { runId, runNo, employeeCount: prepared.length },
      });
      return {
        runId,
        runNo,
        employeeCount: prepared.length,
        totalGross: fromCents(totalGrossCents),
        totalNet: fromCents(totalNetCents),
        missingRateTypes,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Approve and post                                                    */
/* ------------------------------------------------------------------ */

export const approvePayrollRunSchema = z.object({
  ...baseSchema,
  runId: z.uuid(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type ApprovePayrollRunInput = z.input<typeof approvePayrollRunSchema>;

export async function approvePayrollRun(
  input: ApprovePayrollRunInput,
  options: CommandOptions = {},
): Promise<{ runId: string; status: "approved"; approvalRole: string | null }> {
  const values = approvePayrollRunSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approvePayrollRun",
    async (tx) => {
      const rows = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, values.runId), eq(payrollRuns.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const run = rows[0];
      if (!run) throw new Error("Payroll run not found");
      if (run.status !== "draft") throw new Error("Only draft payroll runs can be approved");
      assertDifferentActor("approve their own payroll run", userId, run.preparedBy);

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approvePayrollRun",
        toCents(run.totalNet),
      );

      await tx
        .update(payrollRuns)
        .set({
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
          version: sql`${payrollRuns.version} + 1`,
        })
        .where(eq(payrollRuns.id, values.runId));
      await tx.insert(payrollRunApprovals).values({
        id: newId(),
        facilityId: values.facilityId,
        runId: values.runId,
        decision: "approved",
        actorId: userId,
        reason: values.reason ?? null,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "payroll.run.approve",
        entity: "payroll_runs",
        entityId: values.runId,
        details: { runNo: run.runNo, role: approval?.role ?? null },
        eventType: "payroll.run.approved",
        event: { runId: values.runId, runNo: run.runNo },
      });
      return { runId: values.runId, status: "approved" as const, approvalRole: approval?.role ?? null };
    },
    options,
  );
}

export const postPayrollRunSchema = z.object({
  ...baseSchema,
  runId: z.uuid(),
});

export type PostPayrollRunInput = z.input<typeof postPayrollRunSchema>;

export interface PostedPayrollResult {
  runId: string;
  entryId: string;
  entryNo: string;
  slipCount: number;
}

export async function postPayrollRun(
  input: PostPayrollRunInput,
  options: CommandOptions = {},
): Promise<PostedPayrollResult> {
  const values = postPayrollRunSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "postPayrollRun",
    async (tx) => {
      const rows = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, values.runId), eq(payrollRuns.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const run = rows[0];
      if (!run) throw new Error("Payroll run not found");
      if (run.status !== "approved") throw new Error("Only approved payroll runs can be posted");

      const lines = await tx
        .select()
        .from(payrollLines)
        .where(and(eq(payrollLines.facilityId, values.facilityId), eq(payrollLines.runId, run.id)));
      if (lines.length === 0) throw new Error("The payroll run has no lines");

      // One expense pair per cost centre keeps departmental costing intact.
      // The credit side is grouped by payable account because deductions are
      // facility obligations, not departmental expenses.
      const byCenter = new Map<string, { gross: number; employer: number }>();
      let totalPaye = 0;
      let totalNssfEmployee = 0;
      let totalNssfEmployer = 0;
      let totalShif = 0;
      let totalHousing = 0;
      for (const line of lines) {
        const key = line.costCenterId ?? "";
        const group = byCenter.get(key) ?? { gross: 0, employer: 0 };
        group.gross += toCents(line.grossPay);
        group.employer += toCents(line.nssfEmployer);
        byCenter.set(key, group);
        totalPaye += toCents(line.paye);
        totalNssfEmployee += toCents(line.nssfEmployee);
        totalNssfEmployer += toCents(line.nssfEmployer);
        totalShif += toCents(line.shif);
        totalHousing += toCents(line.housingLevy);
      }

      const journalLines: Array<{
        systemRole: string;
        debit?: string;
        credit?: string;
        costCenterId?: string | null;
        description?: string;
      }> = [];
      for (const [centerId, totals] of byCenter) {
        journalLines.push({
          systemRole: "salaries_expense",
          debit: fromCents(totals.gross),
          costCenterId: centerId || null,
          description: "Gross salaries",
        });
        if (totals.employer > 0) {
          journalLines.push({
            systemRole: "nssf_expense",
            debit: fromCents(totals.employer),
            costCenterId: centerId || null,
            description: "Employer NSSF",
          });
        }
      }
      journalLines.push(
        { systemRole: "payroll_payable", credit: fromCents(toCents(run.totalNet)), description: "Net pay" },
        { systemRole: "paye_payable", credit: fromCents(totalPaye), description: "PAYE" },
        {
          systemRole: "nssf_payable",
          credit: fromCents(totalNssfEmployee + totalNssfEmployer),
          description: "NSSF",
        },
        { systemRole: "shif_payable", credit: fromCents(totalShif), description: "SHIF" },
        {
          systemRole: "housing_levy_payable",
          credit: fromCents(totalHousing),
          description: "Housing levy",
        },
      );

      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: run.periodEnd,
        description: `Payroll ${run.runNo} (${run.periodStart} to ${run.periodEnd})`,
        lines: journalLines,
        sourceType: "payroll",
        sourceId: run.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      const facility = await loadFacility(tx, values.facilityId);
      for (const line of lines) {
        const slipNo = await nextFormattedNumber(tx, facility, "payslip");
        await tx.insert(payslips).values({
          id: newId(),
          facilityId: values.facilityId,
          runId: run.id,
          lineId: line.id,
          employeeId: line.employeeId,
          slipNo,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          issuedAt: new Date(),
          snapshot: {
            runNo: run.runNo,
            employeeNo: line.employeeNo,
            employeeName: line.employeeName,
            basicSalary: line.basicSalary,
            allowances: line.allowances,
            grossPay: line.grossPay,
            paye: line.paye,
            nssfEmployee: line.nssfEmployee,
            nssfEmployer: line.nssfEmployer,
            shif: line.shif,
            housingLevy: line.housingLevy,
            otherDeductions: line.otherDeductions,
            netPay: line.netPay,
            employerCost: line.employerCost,
            missingRateTypes: line.missingRateTypes,
          },
          createdBy: userId,
        });
      }

      await tx
        .update(payrollRuns)
        .set({
          status: "posted",
          postedBy: userId,
          postedAt: new Date(),
          journalEntryId: journal.entryId,
          updatedAt: new Date(),
          version: sql`${payrollRuns.version} + 1`,
        })
        .where(eq(payrollRuns.id, run.id));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "payroll.run.post",
        entity: "payroll_runs",
        entityId: run.id,
        details: { runNo: run.runNo, entryNo: journal.entryNo, slipCount: lines.length },
        eventType: "payroll.run.posted",
        event: { runId: run.id, runNo: run.runNo, entryId: journal.entryId },
      });
      return { runId: run.id, entryId: journal.entryId, entryNo: journal.entryNo, slipCount: lines.length };
    },
    options,
  );
}
