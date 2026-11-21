/** Shapes returned by /api/finance and the shared command client. */

import type { FinanceApprovalAction, FinanceApprovalRole } from "@/lib/finance";

export type FinanceTab =
  | "accounts"
  | "periods"
  | "journals"
  | "trial"
  | "ledger"
  | "banking"
  | "limits";

export interface FinanceApprovalLimitRow {
  id: string;
  action: FinanceApprovalAction;
  role: FinanceApprovalRole;
  maxAmount: string;
  active: boolean;
}

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: "debit" | "credit";
  systemRole: string | null;
  active: boolean;
}

export interface CostCenterRow {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
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

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  normalBalance: "debit" | "credit";
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

export interface FinanceData {
  overview: FinanceOverview | null;
  accounts: LedgerAccountRow[];
  costCenters: CostCenterRow[];
  periods: FiscalPeriodRow[];
  journals: JournalRow[];
  bankAccounts: BankAccountRow[];
  bankTransactions: BankTransactionRow[];
  reconciliations: BankReconciliationRow[];
  trialBalance: TrialBalance | null;
  generalLedger: GeneralLedger | null;
  approvalLimits: FinanceApprovalLimitRow[];
}

export interface FinancePanelProps {
  data: FinanceData;
  canWrite: boolean;
  refresh: () => Promise<void>;
  openTab: (tab: FinanceTab) => void;
  accountId: string;
  onAccountChange: (id: string) => void;
}

const formatterByCurrency = new Map<string, Intl.NumberFormat>();

export function formatMoney(value: string | number, currency = "KES"): string {
  let formatter = formatterByCurrency.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-KE", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
    formatterByCurrency.set(currency, formatter);
  }
  return formatter.format(Number(value) || 0);
}

export function todayIso(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function monthStartIso(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-01`;
}

export function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}

export class FinanceCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "FinanceCommandError";
  }
}

/** Posts a scoped finance command. Facility and actor are injected by the API. */
export async function postFinanceCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/finance", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "finance-station" },
    body: JSON.stringify({ command, input }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: string;
    issues?: Array<{ message?: string; path?: Array<string | number> }>;
  } | null;
  if (!response.ok || !body) {
    const issues = (body?.issues ?? [])
      .map((issue) =>
        issue.path && issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message ?? "invalid"}`
          : (issue.message ?? "invalid"),
      )
      .filter(Boolean);
    throw new FinanceCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}
