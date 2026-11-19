import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { fromCents, toCents } from "@/lib/billing";
import { accountBalance, trialBalanceIsBalanced, type NormalBalance } from "@/lib/finance";
import { db } from "@/server/db/client";
import {
  bankAccounts,
  bankReconciliations,
  bankTransactions,
  costCenters,
  fiscalPeriods,
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
