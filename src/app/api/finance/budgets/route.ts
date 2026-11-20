import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { BUDGET_STATUSES, type BudgetStatus } from "@/lib/finance";
import { fromCents, toCents } from "@/lib/billing";
import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  approveBudget,
  createBudget,
  rejectBudget,
  replaceBudgetLines,
  setBudgetEnforcement,
  submitBudget,
} from "@/server/commands/budgets";
import { db } from "@/server/db/client";
import { listBranches } from "@/server/queries/admin";
import { getBudgetDetail, listBudgetDetails } from "@/server/queries/budgets";
import { listCostCenters, listFiscalPeriods, listLedgerAccounts } from "@/server/queries/finance";

import { handleErpCommand } from "../_shared";

export const dynamic = "force-dynamic";

type BudgetCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commands: Record<string, BudgetCommand> = {
  createBudget: (input) => createBudget(input as Parameters<typeof createBudget>[0]),
  replaceBudgetLines: (input) =>
    replaceBudgetLines(input as Parameters<typeof replaceBudgetLines>[0]),
  submitBudget: (input) => submitBudget(input as Parameters<typeof submitBudget>[0]),
  approveBudget: (input) => approveBudget(input as Parameters<typeof approveBudget>[0]),
  rejectBudget: (input) => rejectBudget(input as Parameters<typeof rejectBudget>[0]),
  setBudgetEnforcement: (input) =>
    setBudgetEnforcement(input as Parameters<typeof setBudgetEnforcement>[0]),
};

const optionalUuid = z.string().uuid();

function uuidParam(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  const parsed = optionalUuid.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must be a valid identifier`);
  return parsed.data;
}

function statusParam(value: string | null): BudgetStatus | undefined {
  if (!value) return undefined;
  const parsed = z.enum(BUDGET_STATUSES).safeParse(value);
  if (!parsed.success) throw new Error("Invalid budget status");
  return parsed.data;
}

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(FINANCE_READ_ROLES);
    const url = new URL(request.url);
    const periodId = uuidParam(url.searchParams.get("periodId"), "Period");
    const budgetId = uuidParam(url.searchParams.get("budgetId"), "Budget");
    const status = statusParam(url.searchParams.get("status"));

    const [budgets, budget, periods, costCenters, branches, accounts] = await Promise.all([
      listBudgetDetails(db, facilityId, { periodId, status }),
      budgetId ? getBudgetDetail(db, facilityId, budgetId) : Promise.resolve(null),
      listFiscalPeriods(db, facilityId),
      listCostCenters(db, facilityId),
      listBranches(db, facilityId),
      listLedgerAccounts(db, facilityId).then((rows) => rows.filter((row) => row.type === "expense")),
    ]);

    const approved = budgets.filter((item) => item.status === "approved");
    const sumMoney = (field: "total" | "actual" | "variance") =>
      fromCents(
        approved.reduce((total, item) => total + toCents(item[field]), 0),
      );

    return NextResponse.json({
      budgets,
      budget,
      periods,
      costCenters,
      branches,
      accounts,
      summary: {
        total: sumMoney("total"),
        actual: sumMoney("actual"),
        remaining: sumMoney("variance"),
        approvedCount: approved.length,
        pendingCount: budgets.filter((item) => item.status === "submitted").length,
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(
    request,
    FINANCE_WRITE_ROLES,
    commands,
    "Invalid budget command",
  );
}
