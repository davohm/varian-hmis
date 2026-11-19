import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { REVENUE_READ_ROLES, REVENUE_WRITE_ROLES } from "@/lib/navigation";
import { handleErpCommand } from "@/app/api/finance/_shared";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  createClaim,
  createPayer,
  createPayerBenefit,
  createPayerContract,
  decidePreAuthorization,
  recordClaimDenial,
  recordRemittance,
  requestPreAuthorization,
  resolveClaimDenial,
  setPayerContractStatus,
  transitionClaim,
  updatePayer,
} from "@/server/commands/revenue";
import { db } from "@/server/db/client";
import { searchPatients } from "@/server/queries/patients";
import {
  getClaim,
  getRevenueOverview,
  listClaimDenials,
  listClaims,
  listPayerContracts,
  listPayers,
  listPreAuthorizations,
  listRemittances,
  listRevenueEncounters,
} from "@/server/queries/revenue";

export const dynamic = "force-dynamic";

type RevenueCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commands: Record<string, RevenueCommand> = {
  createPayer: (input) => createPayer(input as Parameters<typeof createPayer>[0]),
  updatePayer: (input) => updatePayer(input as Parameters<typeof updatePayer>[0]),
  createPayerContract: (input) =>
    createPayerContract(input as Parameters<typeof createPayerContract>[0]),
  setPayerContractStatus: (input) =>
    setPayerContractStatus(input as Parameters<typeof setPayerContractStatus>[0]),
  createPayerBenefit: (input) => createPayerBenefit(input as Parameters<typeof createPayerBenefit>[0]),
  requestPreAuthorization: (input) =>
    requestPreAuthorization(input as Parameters<typeof requestPreAuthorization>[0]),
  decidePreAuthorization: (input) =>
    decidePreAuthorization(input as Parameters<typeof decidePreAuthorization>[0]),
  createClaim: (input) => createClaim(input as Parameters<typeof createClaim>[0]),
  transitionClaim: (input) => transitionClaim(input as Parameters<typeof transitionClaim>[0]),
  recordRemittance: (input) => recordRemittance(input as Parameters<typeof recordRemittance>[0]),
  recordClaimDenial: (input) => recordClaimDenial(input as Parameters<typeof recordClaimDenial>[0]),
  resolveClaimDenial: (input) => resolveClaimDenial(input as Parameters<typeof resolveClaimDenial>[0]),
};

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(REVENUE_READ_ROLES);
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const status = url.searchParams.get("status") ?? undefined;
    const payerId = url.searchParams.get("payerId") ?? undefined;
    const claimId = url.searchParams.get("claimId") ?? undefined;

    const [
      overview,
      payers,
      contracts,
      preAuthorizations,
      claims,
      claimDetail,
      remittances,
      denials,
      encounters,
      patients,
    ] = await Promise.all([
      getRevenueOverview(db, facilityId).catch(() => null),
      listPayers(db, facilityId),
      listPayerContracts(db, facilityId),
      listPreAuthorizations(db, facilityId),
      listClaims(db, facilityId, { status, payerId }),
      claimId ? getClaim(db, facilityId, claimId) : Promise.resolve(null),
      listRemittances(db, facilityId),
      listClaimDenials(db, facilityId),
      listRevenueEncounters(db, facilityId),
      query.length > 0 ? searchPatients(db, facilityId, query, 10) : Promise.resolve([]),
    ]);

    return NextResponse.json({
      overview,
      payers,
      contracts,
      preAuthorizations,
      claims,
      claimDetail,
      remittances,
      denials,
      encounters,
      patients,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(request, REVENUE_WRITE_ROLES, commands, "Invalid revenue command");
}
