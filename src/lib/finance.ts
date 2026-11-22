/** Shared finance and revenue-cycle rules used by commands, queries and UI. */

import { fromCents, toCents } from "@/lib/billing";

export const LEDGER_ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["debit", "credit"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

export const LEDGER_ACCOUNT_TYPE_LABELS: Record<LedgerAccountType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

/** Assets and expenses increase on the debit side; everything else credits. */
export function normalBalanceFor(type: LedgerAccountType): NormalBalance {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

export const FISCAL_PERIOD_STATUSES = ["open", "closed"] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

export const JOURNAL_STATUSES = ["posted", "reversed"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const BUDGET_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

/* ------------------------------------------------------------------ */
/* Finance approval limits                                             */
/* ------------------------------------------------------------------ */

/**
 * The finance commands whose value can be capped by role. Automation uses
 * postJournal directly and is deliberately not capped here: limits govern a
 * person acting through a manual command.
 */
export const FINANCE_APPROVAL_ACTIONS = [
  "postManualJournal",
  "reverseJournal",
  "approveRequisition",
  "approvePurchaseOrder",
  "recordSupplierPayment",
  "approvePayrollRun",
] as const;
export type FinanceApprovalAction = (typeof FINANCE_APPROVAL_ACTIONS)[number];

export const FINANCE_APPROVAL_ACTION_LABELS: Record<FinanceApprovalAction, string> = {
  postManualJournal: "Post manual journal",
  reverseJournal: "Reverse journal",
  approveRequisition: "Approve requisition",
  approvePurchaseOrder: "Approve purchase order",
  recordSupplierPayment: "Record supplier payment",
  approvePayrollRun: "Approve payroll run",
};

/** Roles that can hold a finance or procurement approval limit. Limits are never defaulted. */
export const FINANCE_APPROVAL_ROLES = [
  "accountant",
  "finance_officer",
  "procurement_officer",
  "store_manager",
  "hr_officer",
  "payroll_officer",
  "admin",
] as const;
export type FinanceApprovalRole = (typeof FINANCE_APPROVAL_ROLES)[number];

export const FINANCE_APPROVAL_ROLE_LABELS: Record<FinanceApprovalRole, string> = {
  accountant: "Accountant",
  finance_officer: "Finance Officer",
  procurement_officer: "Procurement Officer",
  store_manager: "Store Manager",
  hr_officer: "HR Officer",
  payroll_officer: "Payroll Officer",
  admin: "Administrator",
};

export function isFinanceApprovalAction(value: string): value is FinanceApprovalAction {
  return (FINANCE_APPROVAL_ACTIONS as readonly string[]).includes(value);
}

export function isFinanceApprovalRole(value: string): value is FinanceApprovalRole {
  return (FINANCE_APPROVAL_ROLES as readonly string[]).includes(value);
}

export interface JournalLineInput {
  debit: string | number;
  credit: string | number;
}

export interface JournalTotals {
  debitCents: number;
  creditCents: number;
  debit: string;
  credit: string;
  balanced: boolean;
}

/** A journal is valid only when both sides are non-zero and exactly equal. */
export function journalTotals(lines: JournalLineInput[]): JournalTotals {
  let debitCents = 0;
  let creditCents = 0;
  for (const line of lines) {
    debitCents += toCents(line.debit);
    creditCents += toCents(line.credit);
  }
  return {
    debitCents,
    creditCents,
    debit: fromCents(debitCents),
    credit: fromCents(creditCents),
    balanced: debitCents > 0 && debitCents === creditCents,
  };
}

export function assertBalancedJournal(lines: JournalLineInput[]): JournalTotals {
  if (lines.length < 2) throw new Error("A journal needs at least two lines");
  for (const line of lines) {
    const debit = toCents(line.debit);
    const credit = toCents(line.credit);
    if (debit < 0 || credit < 0) throw new Error("Journal amounts cannot be negative");
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new Error("Each journal line must have either a debit or a credit, not both");
    }
  }
  const totals = journalTotals(lines);
  if (!totals.balanced) {
    throw new Error(
      `Journal is not balanced: debits ${totals.debit} do not equal credits ${totals.credit}`,
    );
  }
  return totals;
}

/** Signed balance in the account's own normal direction. */
export function accountBalance(
  debit: string | number,
  credit: string | number,
  normalBalance: NormalBalance,
): string {
  const difference = toCents(debit) - toCents(credit);
  return fromCents(normalBalance === "debit" ? difference : -difference);
}

export interface TrialBalanceRowLike {
  debit: string;
  credit: string;
}

/** The proof of the ledger: total debits must equal total credits. */
export function trialBalanceIsBalanced(rows: TrialBalanceRowLike[]): boolean {
  const debit = rows.reduce((total, row) => total + toCents(row.debit), 0);
  const credit = rows.reduce((total, row) => total + toCents(row.credit), 0);
  return debit === credit;
}

/* ------------------------------------------------------------------ */
/* Revenue cycle                                                       */
/* ------------------------------------------------------------------ */

export const PAYER_KINDS = ["cash", "corporate", "insurer", "sha"] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

export const PAYER_KIND_LABELS: Record<PayerKind, string> = {
  cash: "Cash / self-pay",
  corporate: "Corporate",
  insurer: "Insurer",
  sha: "SHA",
};

export const PAYER_CONTRACT_STATUSES = ["active", "suspended", "expired"] as const;
export type PayerContractStatus = (typeof PAYER_CONTRACT_STATUSES)[number];

export const PREAUTH_STATUSES = ["requested", "approved", "declined", "expired"] as const;
export type PreAuthStatus = (typeof PREAUTH_STATUSES)[number];

export const PREAUTH_STATUS_LABELS: Record<PreAuthStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
};

export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "accepted",
  "queried",
  "rejected",
  "resubmitted",
  "paid",
  "closed",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  accepted: "Accepted",
  queried: "Queried",
  rejected: "Rejected",
  resubmitted: "Resubmitted",
  paid: "Paid",
  closed: "Closed",
};

/**
 * The only legal moves through the claim lifecycle. A rejected or queried
 * claim can be worked and resubmitted; paid and closed are terminal.
 */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted", "closed"],
  submitted: ["accepted", "queried", "rejected"],
  queried: ["resubmitted", "rejected", "closed"],
  resubmitted: ["accepted", "queried", "rejected"],
  accepted: ["paid", "closed"],
  rejected: ["resubmitted", "closed"],
  paid: ["closed"],
  closed: [],
};

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!canTransitionClaim(from, to)) {
    throw new Error(`A claim cannot move from ${from} to ${to}`);
  }
}

export const CLAIM_DENIAL_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  upheld: "Upheld",
  overturned: "Overturned",
};

export function claimOutstanding(total: string | number, paid: string | number): string {
  return fromCents(Math.max(0, toCents(total) - toCents(paid)));
}

/* ------------------------------------------------------------------ */
/* Default chart of accounts                                           */
/* ------------------------------------------------------------------ */

export interface DefaultLedgerAccount {
  code: string;
  name: string;
  type: LedgerAccountType;
  systemRole: string | null;
}

/**
 * A minimal, Kenya-appropriate chart of accounts. The system roles are what
 * invoice, payment and claim automation resolve at posting time.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: DefaultLedgerAccount[] = [
  { code: "1000", name: "Cash on hand", type: "asset", systemRole: "cash" },
  { code: "1010", name: "Bank account", type: "asset", systemRole: "bank" },
  {
    code: "1100",
    name: "Accounts receivable — patients",
    type: "asset",
    systemRole: "patient_receivable",
  },
  {
    code: "1200",
    name: "Insurance and scheme receivable",
    type: "asset",
    systemRole: "insurance_receivable",
  },
  { code: "1300", name: "Inventory", type: "asset", systemRole: "inventory" },
  {
    code: "2000",
    name: "Accounts payable",
    type: "liability",
    systemRole: "accounts_payable",
  },
  {
    code: "2100",
    name: "Patient deposits",
    type: "liability",
    systemRole: "patient_deposits",
  },
  {
    code: "2110",
    name: "Payroll payable",
    type: "liability",
    systemRole: "payroll_payable",
  },
  {
    code: "2120",
    name: "PAYE payable",
    type: "liability",
    systemRole: "paye_payable",
  },
  {
    code: "2130",
    name: "NSSF payable",
    type: "liability",
    systemRole: "nssf_payable",
  },
  {
    code: "2140",
    name: "SHIF payable",
    type: "liability",
    systemRole: "shif_payable",
  },
  {
    code: "2150",
    name: "Housing levy payable",
    type: "liability",
    systemRole: "housing_levy_payable",
  },
  { code: "3000", name: "Retained earnings", type: "equity", systemRole: null },
  {
    code: "4000",
    name: "Service revenue",
    type: "revenue",
    systemRole: "service_revenue",
  },
  { code: "5000", name: "Clinical supplies", type: "expense", systemRole: null },
  {
    code: "5100",
    name: "Salaries and wages",
    type: "expense",
    systemRole: "salaries_expense",
  },
  {
    code: "5110",
    name: "Employer NSSF contribution",
    type: "expense",
    systemRole: "nssf_expense",
  },
  { code: "5200", name: "Rent", type: "expense", systemRole: null },
  { code: "5300", name: "Utilities", type: "expense", systemRole: null },
];

export const DEFAULT_COST_CENTER = { code: "GEN", name: "General" };

/** Calendar-year period name and range for a given ISO date. */
export function fiscalYearFor(date: string): { name: string; startDate: string; endDate: string } {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error(`Invalid fiscal date: ${date}`);
  }
  return {
    name: `FY ${year}`,
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}
