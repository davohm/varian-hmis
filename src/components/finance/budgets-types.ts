/** Shapes returned by /api/finance/budgets and used by the budgets UI. */

import type { CostCenterRow, FiscalPeriodRow, LedgerAccountRow } from "@/components/finance/finance-types";
import { FinanceCommandError, formatMoney } from "@/components/finance/finance-types";
import { BUDGET_STATUS_LABELS, type BudgetStatus } from "@/lib/finance";

export interface BranchRow {
  id: string;
  code: string;
  name: string;
  isMain: boolean;
  active: boolean;
}

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

export interface BudgetSummary {
  total: string;
  actual: string;
  remaining: string;
  approvedCount: number;
  pendingCount: number;
}

export interface BudgetsResponse {
  budgets: BudgetRow[];
  budget: BudgetDetail | null;
  periods: FiscalPeriodRow[];
  costCenters: CostCenterRow[];
  branches: BranchRow[];
  accounts: LedgerAccountRow[];
  summary: BudgetSummary;
}

export interface BudgetDraftLine {
  accountId: string;
  costCenterId: string;
  amount: string;
  description: string;
}

export function budgetStatusLabel(status: BudgetStatus): string {
  return BUDGET_STATUS_LABELS[status] ?? status;
}

export function budgetStatusTone(status: BudgetStatus): "neutral" | "info" | "success" | "danger" {
  if (status === "approved") return "success";
  if (status === "submitted") return "info";
  if (status === "rejected") return "danger";
  return "neutral";
}

/** Posts a scoped budget command. Facility and actor are injected by the API. */
export async function postBudgetCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/finance/budgets", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "finance-station" },
    body: JSON.stringify({
      command,
      input: { idempotencyKey: crypto.randomUUID(), ...input },
    }),
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

export { formatMoney };
