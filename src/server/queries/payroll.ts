import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  costCenters,
  journalEntries,
  payrollLines,
  payrollRunApprovals,
  payrollRuns,
  payslips,
  statutoryRates,
} from "@/server/db/schema";

export type PayrollDatabase = typeof db;

export interface PayrollOverview {
  draftRuns: number;
  approvedRuns: number;
  postedRuns: number;
  lastNetPay: string;
  activeEmployees: number;
  missingRateTypes: string[];
}

export async function getPayrollOverview(
  database: PayrollDatabase,
  facilityId: string,
): Promise<PayrollOverview> {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::int FROM payroll_runs
        WHERE facility_id = ${facilityId}::uuid AND status = 'draft') AS draft_runs,
      (SELECT count(*)::int FROM payroll_runs
        WHERE facility_id = ${facilityId}::uuid AND status = 'approved') AS approved_runs,
      (SELECT count(*)::int FROM payroll_runs
        WHERE facility_id = ${facilityId}::uuid AND status = 'posted') AS posted_runs,
      (SELECT coalesce(total_net, '0') FROM payroll_runs
        WHERE facility_id = ${facilityId}::uuid AND status = 'posted'
        ORDER BY period_end DESC, created_at DESC LIMIT 1) AS last_net_pay,
      (SELECT count(*)::int FROM employees
        WHERE facility_id = ${facilityId}::uuid AND employment_status = 'active') AS active_employees,
      (SELECT coalesce(array_agg(DISTINCT rate)::text[], '{}')
        FROM payroll_runs pr
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(pr.missing_rate_types) = 'array'
            THEN pr.missing_rate_types ELSE '[]'::jsonb END
        ) AS rate
        WHERE pr.facility_id = ${facilityId}::uuid) AS missing_rates
  `);
  const row = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};
  return {
    draftRuns: Number(row.draft_runs ?? 0),
    approvedRuns: Number(row.approved_runs ?? 0),
    postedRuns: Number(row.posted_runs ?? 0),
    lastNetPay: String(row.last_net_pay ?? "0.00"),
    activeEmployees: Number(row.active_employees ?? 0),
    missingRateTypes: Array.isArray(row.missing_rates)
      ? row.missing_rates.map(String)
      : [],
  };
}

export interface PayrollRunRow {
  id: string;
  runNo: string;
  periodStart: string;
  periodEnd: string;
  description: string | null;
  status: string;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  totalEmployerCost: string;
  missingRateTypes: string[];
  preparedBy: string;
  approvedBy: string | null;
  postedBy: string | null;
  entryNo: string | null;
  createdAt: string;
}

export async function listPayrollRuns(
  database: PayrollDatabase,
  facilityId: string,
): Promise<PayrollRunRow[]> {
  const rows = await database
    .select({
      id: payrollRuns.id,
      runNo: payrollRuns.runNo,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      description: payrollRuns.description,
      status: payrollRuns.status,
      totalGross: payrollRuns.totalGross,
      totalDeductions: payrollRuns.totalDeductions,
      totalNet: payrollRuns.totalNet,
      totalEmployerCost: payrollRuns.totalEmployerCost,
      missingRateTypes: payrollRuns.missingRateTypes,
      preparedBy: payrollRuns.preparedBy,
      approvedBy: payrollRuns.approvedBy,
      postedBy: payrollRuns.postedBy,
      entryNo: journalEntries.entryNo,
      createdAt: payrollRuns.createdAt,
    })
    .from(payrollRuns)
    .leftJoin(journalEntries, eq(payrollRuns.journalEntryId, journalEntries.id))
    .where(eq(payrollRuns.facilityId, facilityId))
    .orderBy(desc(payrollRuns.createdAt))
    .limit(100);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export interface PayrollLineRow {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  basicSalary: string;
  allowances: string;
  grossPay: string;
  paye: string;
  nssfEmployee: string;
  nssfEmployer: string;
  shif: string;
  housingLevy: string;
  netPay: string;
  employerCost: string;
  costCenterName: string | null;
  missingRateTypes: string[];
}

export interface PayslipRow {
  id: string;
  slipNo: string;
  employeeName: string;
  issuedAt: string;
  snapshot: Record<string, unknown>;
}

export interface PayrollRunDetail extends PayrollRunRow {
  lines: PayrollLineRow[];
  payslips: PayslipRow[];
  approvals: Array<{
    id: string;
    decision: string;
    actorId: string;
    reason: string | null;
    decidedAt: string;
  }>;
}

export async function getPayrollRun(
  database: PayrollDatabase,
  facilityId: string,
  runId: string,
): Promise<PayrollRunDetail | null> {
  const runs = await listPayrollRuns(database, facilityId);
  const run = runs.find((row) => row.id === runId);
  if (!run) return null;

  const lines = await database
    .select({
      id: payrollLines.id,
      employeeId: payrollLines.employeeId,
      employeeNo: payrollLines.employeeNo,
      employeeName: payrollLines.employeeName,
      basicSalary: payrollLines.basicSalary,
      allowances: payrollLines.allowances,
      grossPay: payrollLines.grossPay,
      paye: payrollLines.paye,
      nssfEmployee: payrollLines.nssfEmployee,
      nssfEmployer: payrollLines.nssfEmployer,
      shif: payrollLines.shif,
      housingLevy: payrollLines.housingLevy,
      netPay: payrollLines.netPay,
      employerCost: payrollLines.employerCost,
      costCenterName: costCenters.name,
      missingRateTypes: payrollLines.missingRateTypes,
    })
    .from(payrollLines)
    .leftJoin(costCenters, eq(payrollLines.costCenterId, costCenters.id))
    .where(and(eq(payrollLines.facilityId, facilityId), eq(payrollLines.runId, runId)))
    .orderBy(payrollLines.employeeNo);

  const slips = await database
    .select({
      id: payslips.id,
      slipNo: payslips.slipNo,
      employeeName: payrollLines.employeeName,
      issuedAt: payslips.issuedAt,
      snapshot: payslips.snapshot,
    })
    .from(payslips)
    .innerJoin(payrollLines, eq(payslips.lineId, payrollLines.id))
    .where(and(eq(payslips.facilityId, facilityId), eq(payslips.runId, runId)))
    .orderBy(payslips.slipNo);

  const approvals = await database
    .select({
      id: payrollRunApprovals.id,
      decision: payrollRunApprovals.decision,
      actorId: payrollRunApprovals.actorId,
      reason: payrollRunApprovals.reason,
      decidedAt: payrollRunApprovals.decidedAt,
    })
    .from(payrollRunApprovals)
    .where(and(eq(payrollRunApprovals.facilityId, facilityId), eq(payrollRunApprovals.runId, runId)))
    .orderBy(payrollRunApprovals.decidedAt);

  return {
    ...run,
    lines,
    payslips: slips.map((slip) => ({
      ...slip,
      issuedAt: slip.issuedAt.toISOString(),
      snapshot: slip.snapshot as Record<string, unknown>,
    })),
    approvals: approvals.map((approval) => ({
      ...approval,
      decidedAt: approval.decidedAt.toISOString(),
    })),
  };
}

export async function listStatutoryRates(
  database: PayrollDatabase,
  facilityId: string,
): Promise<
  Array<{
    id: string;
    rateType: string;
    bandOrder: number;
    lowerBound: string;
    upperBound: string | null;
    ratePercent: string;
    fixedAmount: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    legalReference: string | null;
    active: boolean;
  }>
> {
  return database
    .select({
      id: statutoryRates.id,
      rateType: statutoryRates.rateType,
      bandOrder: statutoryRates.bandOrder,
      lowerBound: statutoryRates.lowerBound,
      upperBound: statutoryRates.upperBound,
      ratePercent: statutoryRates.ratePercent,
      fixedAmount: statutoryRates.fixedAmount,
      effectiveFrom: statutoryRates.effectiveFrom,
      effectiveTo: statutoryRates.effectiveTo,
      legalReference: statutoryRates.legalReference,
      active: statutoryRates.active,
    })
    .from(statutoryRates)
    .where(eq(statutoryRates.facilityId, facilityId))
    .orderBy(statutoryRates.rateType, statutoryRates.bandOrder)
    .limit(200);
}

export async function listPayrollCostCenters(
  database: PayrollDatabase,
  facilityId: string,
): Promise<Array<{ id: string; code: string; name: string }>> {
  return database
    .select({ id: costCenters.id, code: costCenters.code, name: costCenters.name })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.active, true)))
    .orderBy(costCenters.code);
}
