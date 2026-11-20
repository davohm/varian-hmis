import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { fromCents, toCents } from "@/lib/billing";
import type { BudgetStatus } from "@/lib/finance";
import type { FinanceDatabase } from "@/server/queries/finance";
import {
  branches,
  budgetLines,
  budgets,
  costCenters,
  fiscalPeriods,
  journalEntries,
  journalLines,
  ledgerAccounts,
} from "@/server/db/schema";

export interface BudgetLineDetail {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string | null;
  amount: string;
  actual: string;
  variance: string;
  description: string | null;
}

export interface BudgetRow {
  id: string;
  code: string;
  name: string;
  periodId: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  branchId: string | null;
  branchName: string | null;
  costCenterId: string | null;
  costCenterName: string | null;
  status: BudgetStatus;
  version: number;
  currency: string;
  enforce: boolean;
  note: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedReason: string | null;
  total: string;
  actual: string;
  variance: string;
  lineCount: number;
  createdAt: string;
}

export interface BudgetDetail extends BudgetRow {
  lines: BudgetLineDetail[];
}

function variance(budgetCents: number, actualCents: number): string {
  return fromCents(budgetCents - actualCents);
}

async function getLineActual(
  database: FinanceDatabase,
  facilityId: string,
  period: { startDate: string; endDate: string },
  accountId: string,
  costCenterId: string | null,
  branchId: string | null,
): Promise<string> {
  const conditions = [
    eq(journalLines.facilityId, facilityId),
    eq(journalLines.accountId, accountId),
    gte(journalEntries.entryDate, period.startDate),
    lte(journalEntries.entryDate, period.endDate),
  ];
  if (costCenterId) {
    conditions.push(eq(journalLines.costCenterId, costCenterId));
  } else if (branchId) {
    const branchCenters = database
      .select({ id: costCenters.id })
      .from(costCenters)
      .where(
        and(eq(costCenters.facilityId, facilityId), eq(costCenters.branchId, branchId)),
      );
    conditions.push(inArray(journalLines.costCenterId, branchCenters));
  }

  const rows = await database
    .select({
      total: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions));
  return rows[0]?.total ?? "0.00";
}

/** Budget line detail with posted actuals and remaining variance. */
export async function getBudgetDetail(
  database: FinanceDatabase,
  facilityId: string,
  budgetId: string,
): Promise<BudgetDetail | null> {
  const rows = await database
    .select({
      id: budgets.id,
      code: budgets.code,
      name: budgets.name,
      periodId: budgets.periodId,
      periodName: fiscalPeriods.name,
      periodStart: fiscalPeriods.startDate,
      periodEnd: fiscalPeriods.endDate,
      branchId: budgets.branchId,
      branchName: branches.name,
      costCenterId: budgets.costCenterId,
      costCenterName: costCenters.name,
      status: budgets.status,
      version: budgets.version,
      currency: budgets.currency,
      enforce: budgets.enforce,
      note: budgets.note,
      submittedAt: budgets.submittedAt,
      submittedBy: budgets.submittedBy,
      approvedAt: budgets.approvedAt,
      approvedBy: budgets.approvedBy,
      rejectedReason: budgets.rejectedReason,
      createdAt: budgets.createdAt,
    })
    .from(budgets)
    .innerJoin(fiscalPeriods, eq(budgets.periodId, fiscalPeriods.id))
    .leftJoin(branches, eq(budgets.branchId, branches.id))
    .leftJoin(costCenters, eq(budgets.costCenterId, costCenters.id))
    .where(and(eq(budgets.facilityId, facilityId), eq(budgets.id, budgetId)))
    .limit(1);
  const budget = rows[0];
  if (!budget) return null;

  const lineRows = await database
    .select({
      id: budgetLines.id,
      accountId: budgetLines.accountId,
      accountCode: ledgerAccounts.code,
      accountName: ledgerAccounts.name,
      costCenterId: budgetLines.costCenterId,
      costCenterCode: costCenters.code,
      costCenterName: costCenters.name,
      amount: budgetLines.amount,
      description: budgetLines.description,
    })
    .from(budgetLines)
    .innerJoin(ledgerAccounts, eq(budgetLines.accountId, ledgerAccounts.id))
    .leftJoin(costCenters, eq(budgetLines.costCenterId, costCenters.id))
    .where(
      and(eq(budgetLines.facilityId, facilityId), eq(budgetLines.budgetId, budgetId)),
    )
    .orderBy(asc(ledgerAccounts.code), asc(costCenters.code));

  const lines: BudgetLineDetail[] = [];
  let totalCents = 0;
  let actualCents = 0;
  for (const line of lineRows) {
    const actual = await getLineActual(
      database,
      facilityId,
      { startDate: budget.periodStart, endDate: budget.periodEnd },
      line.accountId,
      line.costCenterId,
      budget.branchId,
    );
    const lineCents = toCents(line.amount);
    const actualLineCents = toCents(actual);
    totalCents += lineCents;
    actualCents += actualLineCents;
    lines.push({
      id: line.id,
      accountId: line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      costCenterId: line.costCenterId,
      costCenterCode: line.costCenterCode,
      costCenterName: line.costCenterName,
      amount: line.amount,
      actual,
      variance: variance(lineCents, actualLineCents),
      description: line.description,
    });
  }

  return {
    id: budget.id,
    code: budget.code,
    name: budget.name,
    periodId: budget.periodId,
    periodName: budget.periodName,
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd,
    branchId: budget.branchId,
    branchName: budget.branchName,
    costCenterId: budget.costCenterId,
    costCenterName: budget.costCenterName,
    status: budget.status,
    version: budget.version,
    currency: budget.currency,
    enforce: budget.enforce,
    note: budget.note,
    submittedAt: budget.submittedAt?.toISOString() ?? null,
    submittedBy: budget.submittedBy,
    approvedAt: budget.approvedAt?.toISOString() ?? null,
    approvedBy: budget.approvedBy,
    rejectedReason: budget.rejectedReason,
    total: fromCents(totalCents),
    actual: fromCents(actualCents),
    variance: variance(totalCents, actualCents),
    lineCount: lines.length,
    createdAt: budget.createdAt.toISOString(),
    lines,
  };
}

/** Facility budgets with posted actuals derived from immutable journal lines. */
export async function listBudgetDetails(
  database: FinanceDatabase,
  facilityId: string,
  filters: { periodId?: string; status?: BudgetStatus } = {},
): Promise<BudgetDetail[]> {
  const conditions = [eq(budgets.facilityId, facilityId)];
  if (filters.periodId) conditions.push(eq(budgets.periodId, filters.periodId));
  if (filters.status) conditions.push(eq(budgets.status, filters.status));

  const rows = await database
    .select({ id: budgets.id })
    .from(budgets)
    .where(and(...conditions))
    .orderBy(desc(budgets.createdAt));

  const details: BudgetDetail[] = [];
  for (const row of rows) {
    const detail = await getBudgetDetail(database, facilityId, row.id);
    if (detail) details.push(detail);
  }
  return details;
}
