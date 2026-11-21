import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";

import { fromCents, toCents } from "@/lib/billing";
import {
  accountBalance,
  trialBalanceIsBalanced,
  type FinanceApprovalAction,
  type FinanceApprovalRole,
  type NormalBalance,
} from "@/lib/finance";
import { db } from "@/server/db/client";
import {
  bankAccounts,
  bankReconciliations,
  bankTransactions,
  branches,
  costCenters,
  fiscalPeriods,
  financeApprovalLimits,
  journalEntries,
  journalLines,
  ledgerAccounts,
} from "@/server/db/schema";

export type FinanceDatabase = typeof db;

/* ------------------------------------------------------------------ */
/* Chart of accounts and dimensions                                    */
/* ------------------------------------------------------------------ */

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: NormalBalance;
  systemRole: string | null;
  active: boolean;
}

export async function listLedgerAccounts(
  database: FinanceDatabase,
  facilityId: string,
  options: { includeInactive?: boolean } = {},
): Promise<LedgerAccountRow[]> {
  const conditions: SQL[] = [eq(ledgerAccounts.facilityId, facilityId)];
  if (!options.includeInactive) conditions.push(eq(ledgerAccounts.active, true));
  return database
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      normalBalance: ledgerAccounts.normalBalance,
      systemRole: ledgerAccounts.systemRole,
      active: ledgerAccounts.active,
    })
    .from(ledgerAccounts)
    .where(and(...conditions))
    .orderBy(asc(ledgerAccounts.code));
}

export interface CostCenterRow {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
}

export async function listCostCenters(
  database: FinanceDatabase,
  facilityId: string,
): Promise<CostCenterRow[]> {
  return database
    .select({
      id: costCenters.id,
      code: costCenters.code,
      name: costCenters.name,
      branchId: costCenters.branchId,
      active: costCenters.active,
    })
    .from(costCenters)
    .where(eq(costCenters.facilityId, facilityId))
    .orderBy(asc(costCenters.code));
}

export interface FiscalPeriodRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed";
  closedAt: string | null;
  closedBy: string | null;
}

export async function listFiscalPeriods(
  database: FinanceDatabase,
  facilityId: string,
): Promise<FiscalPeriodRow[]> {
  const rows = await database
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.facilityId, facilityId))
    .orderBy(desc(fiscalPeriods.startDate));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedBy: row.closedBy,
  }));
}

/* ------------------------------------------------------------------ */
/* Journals                                                            */
/* ------------------------------------------------------------------ */

export interface JournalRow {
  id: string;
  entryNo: string;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string | null;
  status: "posted" | "reversed";
  reversalReason: string | null;
  reversedEntryId: string | null;
  postedBy: string | null;
  debit: string;
  credit: string;
  lineCount: number;
}

export interface JournalFilters {
  from?: string;
  to?: string;
  sourceType?: string;
  limit?: number;
}

export async function listJournals(
  database: FinanceDatabase,
  facilityId: string,
  filters: JournalFilters = {},
): Promise<JournalRow[]> {
  const conditions: SQL[] = [eq(journalEntries.facilityId, facilityId)];
  if (filters.from) conditions.push(gte(journalEntries.entryDate, filters.from));
  if (filters.to) conditions.push(lte(journalEntries.entryDate, filters.to));
  if (filters.sourceType) conditions.push(eq(journalEntries.sourceType, filters.sourceType));

  const rows = await database
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      status: journalEntries.status,
      reversalReason: journalEntries.reversalReason,
      reversedEntryId: journalEntries.reversedEntryId,
      postedBy: journalEntries.postedBy,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      lineCount: sql<number>`count(${journalLines.id})::int`,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions))
    .groupBy(journalEntries.id)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNo))
    .limit(Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 500));

  return rows.map((row) => ({
    ...row,
    debit: fromCents(toCents(row.debit)),
    credit: fromCents(toCents(row.credit)),
  }));
}

export interface JournalLineRow {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  description: string | null;
  debit: string;
  credit: string;
}

export interface JournalDetail extends JournalRow {
  lines: JournalLineRow[];
}

export async function getJournal(
  database: FinanceDatabase,
  facilityId: string,
  entryId: string,
): Promise<JournalDetail | null> {
  const headers = await database
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.facilityId, facilityId)))
    .limit(1);
  const entry = headers[0];
  if (!entry) return null;

  const lines = await database
    .select({
      id: journalLines.id,
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      accountCode: ledgerAccounts.code,
      accountName: ledgerAccounts.name,
      costCenterId: journalLines.costCenterId,
      description: journalLines.description,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(and(eq(journalLines.entryId, entryId), eq(journalLines.facilityId, facilityId)))
    .orderBy(asc(journalLines.lineNo));

  const debit = lines.reduce((total, line) => total + toCents(line.debit), 0);
  const credit = lines.reduce((total, line) => total + toCents(line.credit), 0);

  return {
    id: entry.id,
    entryNo: entry.entryNo,
    entryDate: entry.entryDate,
    description: entry.description,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    status: entry.status,
    reversalReason: entry.reversalReason,
    reversedEntryId: entry.reversedEntryId,
    postedBy: entry.postedBy,
    debit: fromCents(debit),
    credit: fromCents(credit),
    lineCount: lines.length,
    lines,
  };
}

/* ------------------------------------------------------------------ */
/* Trial balance and general ledger                                    */
/* ------------------------------------------------------------------ */

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  normalBalance: NormalBalance;
  debit: string;
  credit: string;
  balance: string;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  debit: string;
  credit: string;
  balanced: boolean;
}

/**
 * Trial balance in the classic layout: each account shows the net of its debits
 * and credits on the correct side, so the two columns always equal.
 */
export async function getTrialBalance(
  database: FinanceDatabase,
  facilityId: string,
  filters: { from?: string; to?: string } = {},
): Promise<TrialBalance> {
  const conditions: SQL[] = [eq(journalLines.facilityId, facilityId)];
  if (filters.from) conditions.push(gte(journalEntries.entryDate, filters.from));
  if (filters.to) conditions.push(lte(journalEntries.entryDate, filters.to));

  const raw = await database
    .select({
      accountId: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      normalBalance: ledgerAccounts.normalBalance,
      debitTotal: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      creditTotal: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(and(...conditions))
    .groupBy(
      ledgerAccounts.id,
      ledgerAccounts.code,
      ledgerAccounts.name,
      ledgerAccounts.type,
      ledgerAccounts.normalBalance,
    )
    .orderBy(asc(ledgerAccounts.code));

  const rows: TrialBalanceRow[] = raw.map((row) => {
    const net = toCents(row.debitTotal) - toCents(row.creditTotal);
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normalBalance,
      debit: fromCents(net > 0 ? net : 0),
      credit: fromCents(net < 0 ? -net : 0),
      balance: accountBalance(row.debitTotal, row.creditTotal, row.normalBalance),
    };
  });

  const debit = fromCents(rows.reduce((total, row) => total + toCents(row.debit), 0));
  const credit = fromCents(rows.reduce((total, row) => total + toCents(row.credit), 0));

  return {
    rows,
    debit,
    credit,
    balanced: trialBalanceIsBalanced(rows),
  };
}

export interface GeneralLedgerRow {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  lineDescription: string | null;
  costCenterId: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface GeneralLedger {
  account: LedgerAccountRow;
  openingBalance: string;
  closingBalance: string;
  rows: GeneralLedgerRow[];
}

export async function getGeneralLedger(
  database: FinanceDatabase,
  facilityId: string,
  accountId: string,
  filters: { from?: string; to?: string } = {},
): Promise<GeneralLedger | null> {
  const accounts = await database
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      normalBalance: ledgerAccounts.normalBalance,
      systemRole: ledgerAccounts.systemRole,
      active: ledgerAccounts.active,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.facilityId, facilityId)))
    .limit(1);
  const account = accounts[0];
  if (!account) return null;

  let openingCents = 0;
  if (filters.from) {
    const opening = await database
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(
        and(
          eq(journalLines.facilityId, facilityId),
          eq(journalLines.accountId, accountId),
          sql`${journalEntries.entryDate} < ${filters.from}`,
        ),
      );
    openingCents = toCents(opening[0]?.debit ?? 0) - toCents(opening[0]?.credit ?? 0);
  }

  const conditions: SQL[] = [
    eq(journalLines.facilityId, facilityId),
    eq(journalLines.accountId, accountId),
  ];
  if (filters.from) conditions.push(gte(journalEntries.entryDate, filters.from));
  if (filters.to) conditions.push(lte(journalEntries.entryDate, filters.to));

  const lines = await database
    .select({
      entryId: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      lineDescription: journalLines.description,
      costCenterId: journalLines.costCenterId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo), asc(journalLines.lineNo));

  let running = openingCents;
  const rows: GeneralLedgerRow[] = lines.map((line) => {
    running += toCents(line.debit) - toCents(line.credit);
    return { ...line, runningBalance: fromCents(running) };
  });

  return {
    account,
    openingBalance: fromCents(openingCents),
    closingBalance: fromCents(running),
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* Financial statements                                                */
/* ------------------------------------------------------------------ */

export interface StatementFilters {
  from?: string;
  to?: string;
  periodId?: string;
  costCenterId?: string;
  branchId?: string;
}

export interface ResolvedStatementFilters {
  from: string;
  to: string;
  asOf: string;
  periodId: string | null;
  costCenterId: string | null;
  branchId: string | null;
  dimensionLabel: string | null;
}

interface StatementScope extends ResolvedStatementFilters {
  branchCostCenterIds: string[];
}

export interface StatementAccountLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  normalBalance: NormalBalance;
  systemRole: string | null;
  amount: string;
}

export interface StatementSection {
  key: string;
  label: string;
  lines: StatementAccountLine[];
  total: string;
}

export interface BalanceSheet {
  asOf: string;
  sections: StatementSection[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  accumulatedSurplus: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

export interface IncomeStatement {
  from: string;
  to: string;
  revenue: StatementSection;
  expenses: StatementSection;
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

export type CashFlowCategory = "operating" | "investing" | "financing";

export interface CashFlowLine {
  id: string;
  entryId: string;
  entryNo: string;
  date: string;
  description: string;
  accountCode: string;
  accountName: string;
  category: CashFlowCategory;
  direction: "receipt" | "payment";
  amount: string;
}

export interface CashFlowSection {
  key: CashFlowCategory;
  label: string;
  receipts: string;
  payments: string;
  net: string;
  lines: CashFlowLine[];
}

export interface CashFlowStatement {
  from: string;
  to: string;
  openingCash: string;
  netCashFlow: string;
  closingCash: string;
  ledgerCash: string;
  balanced: boolean;
  sections: CashFlowSection[];
}

export interface FinancialStatements {
  filters: ResolvedStatementFilters;
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  cashFlow: CashFlowStatement;
}

const CASH_FLOW_CATEGORIES: Array<{ key: CashFlowCategory; label: string }> = [
  { key: "operating", label: "Operating activities" },
  { key: "investing", label: "Investing activities" },
  { key: "financing", label: "Financing activities" },
];

const OPERATING_SYSTEM_ROLES = new Set([
  "patient_receivable",
  "insurance_receivable",
  "accounts_payable",
  "patient_deposits",
]);

function statementTodayIso(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function resolveStatementScope(
  database: FinanceDatabase,
  facilityId: string,
  filters: StatementFilters,
): Promise<StatementScope> {
  let from = filters.from;
  let to = filters.to;
  let periodId: string | null = null;

  if (filters.periodId) {
    const periods = await database
      .select({
        id: fiscalPeriods.id,
        startDate: fiscalPeriods.startDate,
        endDate: fiscalPeriods.endDate,
      })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.facilityId, facilityId), eq(fiscalPeriods.id, filters.periodId)))
      .limit(1);
    const period = periods[0];
    if (!period) throw new Error("Fiscal period not found in this facility");
    periodId = period.id;
    from = period.startDate;
    to = period.endDate;
  }

  from = from ?? `${statementTodayIso().slice(0, 4)}-01-01`;
  to = to ?? statementTodayIso();
  if (from > to) throw new Error("Statement start date must not be after the end date");

  let costCenterId: string | null = null;
  let branchId: string | null = null;
  let dimensionLabel: string | null = null;
  let branchCostCenterIds: string[] = [];

  if (filters.costCenterId) {
    const centers = await database
      .select({ id: costCenters.id, code: costCenters.code, name: costCenters.name })
      .from(costCenters)
      .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.id, filters.costCenterId)))
      .limit(1);
    const center = centers[0];
    if (!center) throw new Error("Cost centre not found in this facility");
    costCenterId = center.id;
    dimensionLabel = `${center.code} — ${center.name}`;
  } else if (filters.branchId) {
    const rows = await database
      .select({ id: branches.id, code: branches.code, name: branches.name })
      .from(branches)
      .where(and(eq(branches.facilityId, facilityId), eq(branches.id, filters.branchId)))
      .limit(1);
    const branch = rows[0];
    if (!branch) throw new Error("Branch not found in this facility");
    branchId = branch.id;
    branchCostCenterIds = (
      await database
        .select({ id: costCenters.id })
        .from(costCenters)
        .where(
          and(eq(costCenters.facilityId, facilityId), eq(costCenters.branchId, branch.id)),
        )
    ).map((row) => row.id);
    dimensionLabel = `${branch.code} — ${branch.name}`;
  }

  return {
    from,
    to,
    asOf: to,
    periodId,
    costCenterId,
    branchId,
    dimensionLabel,
    branchCostCenterIds,
  };
}

function statementDimensionCondition(scope: StatementScope): SQL | undefined {
  if (scope.costCenterId) return eq(journalLines.costCenterId, scope.costCenterId);
  if (scope.branchId) {
    return scope.branchCostCenterIds.length > 0
      ? inArray(journalLines.costCenterId, scope.branchCostCenterIds)
      : sql`false`;
  }
  return undefined;
}

interface StatementAccountTotal extends StatementAccountLine {
  debit: string;
  credit: string;
}

async function aggregateStatementAccounts(
  database: FinanceDatabase,
  facilityId: string,
  scope: StatementScope,
  range: { from?: string; to?: string },
): Promise<StatementAccountTotal[]> {
  const conditions: SQL[] = [eq(journalLines.facilityId, facilityId)];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));
  const dimension = statementDimensionCondition(scope);
  if (dimension) conditions.push(dimension);

  const rows = await database
    .select({
      accountId: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      normalBalance: ledgerAccounts.normalBalance,
      systemRole: ledgerAccounts.systemRole,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(and(...conditions))
    .groupBy(
      ledgerAccounts.id,
      ledgerAccounts.code,
      ledgerAccounts.name,
      ledgerAccounts.type,
      ledgerAccounts.normalBalance,
      ledgerAccounts.systemRole,
    )
    .orderBy(asc(ledgerAccounts.code));

  return rows.map((row) => ({
    accountId: row.accountId,
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normalBalance,
    systemRole: row.systemRole,
    debit: row.debit,
    credit: row.credit,
    amount: accountBalance(row.debit, row.credit, row.normalBalance),
  }));
}

function statementLines(totals: StatementAccountTotal[], type: string): StatementAccountLine[] {
  return totals
    .filter((row) => row.type === type && toCents(row.amount) !== 0)
    .map(({ accountId, code, name, type: rowType, normalBalance, systemRole, amount }) => ({
      accountId,
      code,
      name,
      type: rowType,
      normalBalance,
      systemRole,
      amount,
    }));
}

function sumStatementLines(lines: Array<{ amount: string }>): string {
  return fromCents(lines.reduce((total, line) => total + toCents(line.amount), 0));
}

function buildStatementSection(
  key: string,
  label: string,
  lines: StatementAccountLine[],
): StatementSection {
  return { key, label, lines, total: sumStatementLines(lines) };
}

function classifyContraAccount(type: string, systemRole: string | null): CashFlowCategory {
  if (systemRole && OPERATING_SYSTEM_ROLES.has(systemRole)) return "operating";
  if (type === "revenue" || type === "expense") return "operating";
  if (type === "asset") return "investing";
  if (type === "liability" || type === "equity") return "financing";
  return "operating";
}

async function getCashAccountIds(
  database: FinanceDatabase,
  facilityId: string,
): Promise<Set<string>> {
  const [accounts, bankLinks] = await Promise.all([
    listLedgerAccounts(database, facilityId, { includeInactive: true }),
    database
      .select({ ledgerAccountId: bankAccounts.ledgerAccountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.facilityId, facilityId)),
  ]);
  const ids = new Set(
    accounts
      .filter(
        (account) =>
          account.systemRole === "cash" ||
          account.systemRole === "bank" ||
          account.code === "1000" ||
          account.code === "1010",
      )
      .map((account) => account.id),
  );
  for (const link of bankLinks) ids.add(link.ledgerAccountId);
  return ids;
}

interface CashPostingRow {
  id: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  lineDescription: string | null;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

async function getCashPostings(
  database: FinanceDatabase,
  facilityId: string,
  scope: StatementScope,
  cashAccountIds: Set<string>,
): Promise<CashPostingRow[]> {
  if (cashAccountIds.size === 0) return [];
  const conditions: SQL[] = [
    eq(journalLines.facilityId, facilityId),
    gte(journalEntries.entryDate, scope.from),
    lte(journalEntries.entryDate, scope.to),
    inArray(journalLines.accountId, [...cashAccountIds]),
  ];
  const dimension = statementDimensionCondition(scope);
  if (dimension) conditions.push(dimension);

  return database
    .select({
      id: journalLines.id,
      entryId: journalLines.entryId,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      lineDescription: journalLines.description,
      accountCode: ledgerAccounts.code,
      accountName: ledgerAccounts.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo), asc(journalLines.lineNo));
}

interface ContraRow {
  entryId: string;
  accountId: string;
  type: string;
  systemRole: string | null;
  debit: string;
  credit: string;
}

async function getContraRows(
  database: FinanceDatabase,
  facilityId: string,
  entryIds: string[],
): Promise<Map<string, ContraRow[]>> {
  const grouped = new Map<string, ContraRow[]>();
  if (entryIds.length === 0) return grouped;
  const rows = await database
    .select({
      entryId: journalLines.entryId,
      accountId: journalLines.accountId,
      type: ledgerAccounts.type,
      systemRole: ledgerAccounts.systemRole,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(
      and(eq(journalLines.facilityId, facilityId), inArray(journalLines.entryId, entryIds)),
    );
  for (const row of rows) {
    const list = grouped.get(row.entryId) ?? [];
    list.push(row);
    grouped.set(row.entryId, list);
  }
  return grouped;
}

async function getOpeningCash(
  database: FinanceDatabase,
  facilityId: string,
  scope: StatementScope,
  cashAccountIds: Set<string>,
): Promise<number> {
  if (cashAccountIds.size === 0) return 0;
  const conditions: SQL[] = [
    eq(journalLines.facilityId, facilityId),
    inArray(journalLines.accountId, [...cashAccountIds]),
    lt(journalEntries.entryDate, scope.from),
  ];
  const dimension = statementDimensionCondition(scope);
  if (dimension) conditions.push(dimension);
  const rows = await database
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions));
  return toCents(rows[0]?.debit ?? 0) - toCents(rows[0]?.credit ?? 0);
}

function buildCashFlow(
  scope: StatementScope,
  postings: CashPostingRow[],
  contraRows: Map<string, ContraRow[]>,
  cashAccountIds: Set<string>,
  openingCashCents: number,
  asOfTotals: StatementAccountTotal[],
): CashFlowStatement {
  const lines: CashFlowLine[] = [];
  for (const posting of postings) {
    const delta = toCents(posting.debit) - toCents(posting.credit);
    if (delta === 0) continue;

    const weights: Record<CashFlowCategory, number> = {
      operating: 0,
      investing: 0,
      financing: 0,
    };
    for (const contra of contraRows.get(posting.entryId) ?? []) {
      if (cashAccountIds.has(contra.accountId)) continue;
      const category = classifyContraAccount(contra.type, contra.systemRole);
      weights[category] += Math.abs(toCents(contra.debit) - toCents(contra.credit));
    }
    let category: CashFlowCategory = "operating";
    let bestWeight = -1;
    for (const option of CASH_FLOW_CATEGORIES) {
      if (weights[option.key] > bestWeight) {
        bestWeight = weights[option.key];
        category = option.key;
      }
    }

    lines.push({
      id: posting.id,
      entryId: posting.entryId,
      entryNo: posting.entryNo,
      date: posting.entryDate,
      description: posting.lineDescription || posting.description,
      accountCode: posting.accountCode,
      accountName: posting.accountName,
      category,
      direction: delta > 0 ? "receipt" : "payment",
      amount: fromCents(Math.abs(delta)),
    });
  }

  const sections = CASH_FLOW_CATEGORIES.map(({ key, label }) => {
    const sectionLines = lines.filter((line) => line.category === key);
    const receipts = sumStatementLines(
      sectionLines.filter((line) => line.direction === "receipt"),
    );
    const payments = sumStatementLines(
      sectionLines.filter((line) => line.direction === "payment"),
    );
    return {
      key,
      label,
      receipts,
      payments,
      net: fromCents(toCents(receipts) - toCents(payments)),
      lines: sectionLines,
    };
  });

  const netCashFlowCents = lines.reduce(
    (total, line) =>
      total + (line.direction === "receipt" ? toCents(line.amount) : -toCents(line.amount)),
    0,
  );
  const ledgerCashCents = asOfTotals
    .filter((row) => cashAccountIds.has(row.accountId))
    .reduce((total, row) => total + toCents(row.amount), 0);

  return {
    from: scope.from,
    to: scope.to,
    openingCash: fromCents(openingCashCents),
    netCashFlow: fromCents(netCashFlowCents),
    closingCash: fromCents(openingCashCents + netCashFlowCents),
    ledgerCash: fromCents(ledgerCashCents),
    balanced: openingCashCents + netCashFlowCents === ledgerCashCents,
    sections,
  };
}

function publicStatementFilters(scope: StatementScope): ResolvedStatementFilters {
  const { branchCostCenterIds: _branchCostCenterIds, ...filters } = scope;
  void _branchCostCenterIds;
  return filters;
}

/** Balance sheet, income statement and direct cash flow from the posted ledger. */
export async function getFinancialStatements(
  database: FinanceDatabase,
  facilityId: string,
  filters: StatementFilters = {},
): Promise<FinancialStatements> {
  const scope = await resolveStatementScope(database, facilityId, filters);
  const [asOfTotals, periodTotals, cashAccountIds] = await Promise.all([
    aggregateStatementAccounts(database, facilityId, scope, { to: scope.asOf }),
    aggregateStatementAccounts(database, facilityId, scope, {
      from: scope.from,
      to: scope.to,
    }),
    getCashAccountIds(database, facilityId),
  ]);

  const assetLines = statementLines(asOfTotals, "asset");
  const liabilityLines = statementLines(asOfTotals, "liability");
  const equityLines = statementLines(asOfTotals, "equity");
  const accumulatedSurplusCents = asOfTotals.reduce((total, row) => {
    if (row.type === "revenue") return total + toCents(row.amount);
    if (row.type === "expense") return total - toCents(row.amount);
    return total;
  }, 0);
  const accumulatedSurplus = fromCents(accumulatedSurplusCents);
  if (accumulatedSurplusCents !== 0) {
    equityLines.push({
      accountId: "accumulated-surplus",
      code: "EARN",
      name: "Accumulated surplus",
      type: "equity",
      normalBalance: "credit",
      systemRole: null,
      amount: accumulatedSurplus,
    });
  }

  const sections = [
    buildStatementSection("assets", "Assets", assetLines),
    buildStatementSection("liabilities", "Liabilities", liabilityLines),
    buildStatementSection("equity", "Equity", equityLines),
  ];
  const totalAssets = sumStatementLines(assetLines);
  const totalLiabilities = sumStatementLines(liabilityLines);
  const totalEquity = sumStatementLines(equityLines);
  const balanceSheet: BalanceSheet = {
    asOf: scope.asOf,
    sections,
    totalAssets,
    totalLiabilities,
    totalEquity,
    accumulatedSurplus,
    totalLiabilitiesAndEquity: fromCents(
      toCents(totalLiabilities) + toCents(totalEquity),
    ),
    balanced: toCents(totalAssets) === toCents(totalLiabilities) + toCents(totalEquity),
  };

  const revenueLines = statementLines(periodTotals, "revenue");
  const expenseLines = statementLines(periodTotals, "expense");
  const totalRevenue = sumStatementLines(revenueLines);
  const totalExpenses = sumStatementLines(expenseLines);
  const incomeStatement: IncomeStatement = {
    from: scope.from,
    to: scope.to,
    revenue: buildStatementSection("revenue", "Revenue", revenueLines),
    expenses: buildStatementSection("expenses", "Expenses", expenseLines),
    totalRevenue,
    totalExpenses,
    netIncome: fromCents(toCents(totalRevenue) - toCents(totalExpenses)),
  };

  const cashPostings = await getCashPostings(database, facilityId, scope, cashAccountIds);
  const contraRows = await getContraRows(
    database,
    facilityId,
    [...new Set(cashPostings.map((row) => row.entryId))],
  );
  const openingCashCents = await getOpeningCash(database, facilityId, scope, cashAccountIds);
  const cashFlow = buildCashFlow(
    scope,
    cashPostings,
    contraRows,
    cashAccountIds,
    openingCashCents,
    asOfTotals,
  );

  return {
    filters: publicStatementFilters(scope),
    balanceSheet,
    incomeStatement,
    cashFlow,
  };
}

/* ------------------------------------------------------------------ */
/* Banking                                                             */
/* ------------------------------------------------------------------ */

export interface BankAccountRow {
  id: string;
  name: string;
  kind: string;
  accountNumber: string | null;
  currency: string;
  ledgerAccountId: string;
  ledgerAccountCode: string;
  openingBalance: string;
  ledgerBalance: string;
  active: boolean;
}

export async function listBankAccounts(
  database: FinanceDatabase,
  facilityId: string,
): Promise<BankAccountRow[]> {
  const rows = await database
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      kind: bankAccounts.kind,
      accountNumber: bankAccounts.accountNumber,
      currency: bankAccounts.currency,
      ledgerAccountId: bankAccounts.ledgerAccountId,
      ledgerAccountCode: ledgerAccounts.code,
      openingBalance: bankAccounts.openingBalance,
      active: bankAccounts.active,
    })
    .from(bankAccounts)
    .innerJoin(ledgerAccounts, eq(bankAccounts.ledgerAccountId, ledgerAccounts.id))
    .where(eq(bankAccounts.facilityId, facilityId))
    .orderBy(asc(bankAccounts.name));

  const balances = await database
    .select({
      accountId: journalLines.accountId,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalLines.facilityId, facilityId))
    .groupBy(journalLines.accountId);
  const balanceMap = new Map(
    balances.map((row) => [
      row.accountId,
      toCents(row.debit) - toCents(row.credit),
    ]),
  );

  return rows.map((row) => ({
    ...row,
    ledgerBalance: fromCents(
      toCents(row.openingBalance) + (balanceMap.get(row.ledgerAccountId) ?? 0),
    ),
  }));
}

export interface BankTransactionRow {
  id: string;
  bankAccountId: string;
  txnDate: string;
  description: string;
  amount: string;
  reference: string | null;
  sourceType: string;
  reconciled: boolean;
  reconciliationId: string | null;
}

export async function listBankTransactions(
  database: FinanceDatabase,
  facilityId: string,
  bankAccountId?: string,
  limit = 100,
): Promise<BankTransactionRow[]> {
  const conditions: SQL[] = [eq(bankTransactions.facilityId, facilityId)];
  if (bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, bankAccountId));
  return database
    .select({
      id: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      txnDate: bankTransactions.txnDate,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      reference: bankTransactions.reference,
      sourceType: bankTransactions.sourceType,
      reconciled: bankTransactions.reconciled,
      reconciliationId: bankTransactions.reconciliationId,
    })
    .from(bankTransactions)
    .where(and(...conditions))
    .orderBy(desc(bankTransactions.txnDate), desc(bankTransactions.createdAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 500));
}

export interface BankReconciliationRow {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  periodStart: string;
  periodEnd: string;
  statementBalance: string;
  ledgerBalance: string;
  difference: string;
  status: "open" | "completed";
  completedAt: string | null;
  note: string | null;
}

export async function listBankReconciliations(
  database: FinanceDatabase,
  facilityId: string,
): Promise<BankReconciliationRow[]> {
  const rows = await database
    .select({
      id: bankReconciliations.id,
      bankAccountId: bankReconciliations.bankAccountId,
      bankAccountName: bankAccounts.name,
      periodStart: bankReconciliations.periodStart,
      periodEnd: bankReconciliations.periodEnd,
      statementBalance: bankReconciliations.statementBalance,
      ledgerBalance: bankReconciliations.ledgerBalance,
      difference: bankReconciliations.difference,
      status: bankReconciliations.status,
      completedAt: bankReconciliations.completedAt,
      note: bankReconciliations.note,
    })
    .from(bankReconciliations)
    .innerJoin(bankAccounts, eq(bankReconciliations.bankAccountId, bankAccounts.id))
    .where(eq(bankReconciliations.facilityId, facilityId))
    .orderBy(desc(bankReconciliations.periodEnd));

  return rows.map((row) => ({
    ...row,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  }));
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface FinanceOverview {
  cash: string;
  bank: string;
  patientReceivable: string;
  insuranceReceivable: string;
  accountsPayable: string;
  revenue: string;
  journalCount: number;
  openPeriods: number;
  unreconciledBankTransactions: number;
  trialBalanceBalanced: boolean;
  hasChartOfAccounts: boolean;
}

/** Cash, bank, receivables and revenue from the posted ledger. */
export async function getFinanceOverview(
  database: FinanceDatabase,
  facilityId: string,
): Promise<FinanceOverview> {
  const accounts = await listLedgerAccounts(database, facilityId, { includeInactive: true });
  const systemAccounts = new Map(
    accounts.filter((account) => account.systemRole).map((account) => [account.systemRole!, account]),
  );

  const balances = await database
    .select({
      accountId: journalLines.accountId,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalLines.facilityId, facilityId))
    .groupBy(journalLines.accountId);
  const balanceMap = new Map(
    balances.map((row) => [row.accountId, { debit: row.debit, credit: row.credit }]),
  );

  const signed = (role: string): string => {
    const account = systemAccounts.get(role);
    if (!account) return "0.00";
    const totals = balanceMap.get(account.id) ?? { debit: "0", credit: "0" };
    return accountBalance(totals.debit, totals.credit, account.normalBalance);
  };

  const [journalTotals] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.facilityId, facilityId));

  const [periodTotals] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.facilityId, facilityId), eq(fiscalPeriods.status, "open")));

  const [unreconciled] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(
      and(eq(bankTransactions.facilityId, facilityId), eq(bankTransactions.reconciled, false)),
    );

  const trial = await getTrialBalance(database, facilityId);

  return {
    cash: signed("cash"),
    bank: signed("bank"),
    patientReceivable: signed("patient_receivable"),
    insuranceReceivable: signed("insurance_receivable"),
    accountsPayable: signed("accounts_payable"),
    revenue: signed("service_revenue"),
    journalCount: journalTotals?.count ?? 0,
    openPeriods: periodTotals?.count ?? 0,
    unreconciledBankTransactions: unreconciled?.count ?? 0,
    trialBalanceBalanced: trial.balanced,
    hasChartOfAccounts: accounts.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Approval limits                                                     */
/* ------------------------------------------------------------------ */

export interface FinanceApprovalLimitRow {
  id: string;
  action: FinanceApprovalAction;
  role: FinanceApprovalRole;
  maxAmount: string;
  active: boolean;
}

/** Every configured ceiling for a facility, ordered for display. */
export async function listFinanceApprovalLimits(
  database: FinanceDatabase,
  facilityId: string,
): Promise<FinanceApprovalLimitRow[]> {
  const rows = await database
    .select({
      id: financeApprovalLimits.id,
      action: financeApprovalLimits.action,
      role: financeApprovalLimits.role,
      maxAmount: financeApprovalLimits.maxAmount,
      active: financeApprovalLimits.active,
    })
    .from(financeApprovalLimits)
    .where(eq(financeApprovalLimits.facilityId, facilityId))
    .orderBy(asc(financeApprovalLimits.action), asc(financeApprovalLimits.role));
  return rows as FinanceApprovalLimitRow[];
}
