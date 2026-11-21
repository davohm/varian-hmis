import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import {
  closeFiscalPeriod,
  completeBankReconciliation,
  createBankAccount,
  createCostCenter,
  createLedgerAccount,
  openBankReconciliation,
  openFiscalPeriod,
  postManualJournal,
  recordBankTransaction,
  setFinanceApprovalLimit,
  reverseJournal,
  updateLedgerAccount,
} from "@/server/commands/finance";
import {
  getFinanceOverview,
  getGeneralLedger,
  getTrialBalance,
  listFinanceApprovalLimits,
  listBankAccounts,
  listBankReconciliations,
  listBankTransactions,
  listCostCenters,
  listFiscalPeriods,
  listJournals,
  listLedgerAccounts,
} from "@/server/queries/finance";

import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  createLedgerAccount: (input) => createLedgerAccount(input as Parameters<typeof createLedgerAccount>[0]),
  updateLedgerAccount: (input) => updateLedgerAccount(input as Parameters<typeof updateLedgerAccount>[0]),
  createCostCenter: (input) => createCostCenter(input as Parameters<typeof createCostCenter>[0]),
  openFiscalPeriod: (input) => openFiscalPeriod(input as Parameters<typeof openFiscalPeriod>[0]),
  closeFiscalPeriod: (input) => closeFiscalPeriod(input as Parameters<typeof closeFiscalPeriod>[0]),
  postManualJournal: (input) => postManualJournal(input as Parameters<typeof postManualJournal>[0]),
  reverseJournal: (input) => reverseJournal(input as Parameters<typeof reverseJournal>[0]),
  createBankAccount: (input) => createBankAccount(input as Parameters<typeof createBankAccount>[0]),
  recordBankTransaction: (input) =>
    recordBankTransaction(input as Parameters<typeof recordBankTransaction>[0]),
  openBankReconciliation: (input) =>
    openBankReconciliation(input as Parameters<typeof openBankReconciliation>[0]),
  completeBankReconciliation: (input) =>
    completeBankReconciliation(input as Parameters<typeof completeBankReconciliation>[0]),
  setFinanceApprovalLimit: (input) =>
    setFinanceApprovalLimit(input as Parameters<typeof setFinanceApprovalLimit>[0]),
};

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(FINANCE_READ_ROLES);
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const accountId = url.searchParams.get("accountId") ?? undefined;

    const [
      overview,
      accounts,
      costCenters,
      periods,
      journals,
      bankAccounts,
      bankTransactions,
      reconciliations,
      trialBalance,
      generalLedger,
      approvalLimits,
    ] = await Promise.all([
      getFinanceOverview(db, facilityId).catch(() => null),
      listLedgerAccounts(db, facilityId),
      listCostCenters(db, facilityId),
      listFiscalPeriods(db, facilityId),
      listJournals(db, facilityId, { from, to }),
      listBankAccounts(db, facilityId),
      listBankTransactions(db, facilityId),
      listBankReconciliations(db, facilityId),
      getTrialBalance(db, facilityId, { from, to }),
      accountId ? getGeneralLedger(db, facilityId, accountId, { from, to }) : Promise.resolve(null),
      listFinanceApprovalLimits(db, facilityId),
    ]);

    return NextResponse.json({
      overview,
      accounts,
      costCenters,
      periods,
      journals,
      bankAccounts,
      bankTransactions,
      reconciliations,
      trialBalance,
      generalLedger,
      approvalLimits,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(request, FINANCE_WRITE_ROLES, commands, "Invalid finance command");
}
