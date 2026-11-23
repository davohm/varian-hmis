import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  SHA_APPROVAL_ROLES,
  SHA_CLAIM_ROLES,
  SHA_ELIGIBILITY_ROLES,
  SHA_FINANCE_ROLES,
  SHA_READ_ROLES,
  SHA_SETUP_ROLES,
} from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  approveExemption,
  approveWaiver,
  createBenefitPackage,
  createEmpanelment,
  createShaClaim,
  decideShaPreAuthorization,
  recordShaAdjudication,
  recordShaDenial,
  recordShaRemittance,
  reconcileShaPaymentReport,
  requestShaPreAuthorization,
  requestShaWaiver,
  reworkShaClaim,
  submitShaClaim,
  updateEmpanelmentStatus,
  verifyShaEligibility,
} from "@/server/commands/sha";
import { db } from "@/server/db/client";
import type { Role } from "@/server/db/schema";
import { searchPatients } from "@/server/queries/patients";
import {
  getBenefitPackage,
  getPatientBenefitCoverage,
  getShaClaim,
  getShaClaimAging,
  getShaReconciliation,
  listBenefitPackages,
  listEmpanelments,
  listShaAdjudicationCodes,
  listShaClaims,
  listShaEligibilityChecks,
  listShaPreAuthorizations,
  listShaReconciliations,
  listShaRemittances,
  listShaWaivers,
} from "@/server/queries/sha";
import {
  listPayerContracts,
  listPayers,
  listRevenueEncounters,
} from "@/server/queries/revenue";

export const dynamic = "force-dynamic";

type ShaCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commands: Record<string, ShaCommand> = {
  createEmpanelment: (input) => createEmpanelment(input as Parameters<typeof createEmpanelment>[0]),
  updateEmpanelmentStatus: (input) =>
    updateEmpanelmentStatus(input as Parameters<typeof updateEmpanelmentStatus>[0]),
  createBenefitPackage: (input) =>
    createBenefitPackage(input as Parameters<typeof createBenefitPackage>[0]),
  verifyShaEligibility: (input) =>
    verifyShaEligibility(input as Parameters<typeof verifyShaEligibility>[0]),
  requestShaWaiver: (input) => requestShaWaiver(input as Parameters<typeof requestShaWaiver>[0]),
  approveWaiver: (input) => approveWaiver(input as Parameters<typeof approveWaiver>[0]),
  approveExemption: (input) => approveExemption(input as Parameters<typeof approveExemption>[0]),
  requestShaPreAuthorization: (input) =>
    requestShaPreAuthorization(input as Parameters<typeof requestShaPreAuthorization>[0]),
  decideShaPreAuthorization: (input) =>
    decideShaPreAuthorization(input as Parameters<typeof decideShaPreAuthorization>[0]),
  createShaClaim: (input) => createShaClaim(input as Parameters<typeof createShaClaim>[0]),
  submitShaClaim: (input) => submitShaClaim(input as Parameters<typeof submitShaClaim>[0]),
  recordShaAdjudication: (input) =>
    recordShaAdjudication(input as Parameters<typeof recordShaAdjudication>[0]),
  recordShaDenial: (input) => recordShaDenial(input as Parameters<typeof recordShaDenial>[0]),
  reworkShaClaim: (input) => reworkShaClaim(input as Parameters<typeof reworkShaClaim>[0]),
  recordShaRemittance: (input) =>
    recordShaRemittance(input as Parameters<typeof recordShaRemittance>[0]),
  reconcileShaPaymentReport: (input) =>
    reconcileShaPaymentReport(input as Parameters<typeof reconcileShaPaymentReport>[0]),
};

/** Role-based separation of duties on top of each command's actor-based checks. */
const commandRoles: Record<string, Role[]> = {
  createEmpanelment: SHA_SETUP_ROLES,
  updateEmpanelmentStatus: SHA_SETUP_ROLES,
  createBenefitPackage: SHA_SETUP_ROLES,
  verifyShaEligibility: SHA_ELIGIBILITY_ROLES,
  requestShaWaiver: SHA_ELIGIBILITY_ROLES,
  approveWaiver: SHA_APPROVAL_ROLES,
  approveExemption: SHA_APPROVAL_ROLES,
  requestShaPreAuthorization: SHA_CLAIM_ROLES,
  decideShaPreAuthorization: SHA_APPROVAL_ROLES,
  createShaClaim: SHA_CLAIM_ROLES,
  submitShaClaim: SHA_CLAIM_ROLES,
  recordShaAdjudication: SHA_APPROVAL_ROLES,
  recordShaDenial: SHA_CLAIM_ROLES,
  reworkShaClaim: SHA_CLAIM_ROLES,
  recordShaRemittance: SHA_FINANCE_ROLES,
  reconcileShaPaymentReport: SHA_FINANCE_ROLES,
};

const commandRequestSchema = z.object({
  command: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(SHA_READ_ROLES);
    const url = new URL(request.url);
    const claimId = url.searchParams.get("claimId") ?? undefined;
    const patientId = url.searchParams.get("patientId") ?? undefined;
    const reconciliationId = url.searchParams.get("reconciliationId") ?? undefined;
    const packageId = url.searchParams.get("packageId") ?? undefined;
    const query = url.searchParams.get("q")?.trim() ?? "";

    const [
      empanelments,
      benefitPackages,
      eligibilityChecks,
      preAuthorizations,
      claims,
      claimDetail,
      remittances,
      waivers,
      reconciliations,
      reconciliation,
      adjudicationCodes,
      ageing,
      coverage,
      benefitPackage,
      payers,
      contracts,
      encounters,
      patients,
    ] = await Promise.all([
      listEmpanelments(db, facilityId),
      listBenefitPackages(db, facilityId),
      listShaEligibilityChecks(db, facilityId),
      listShaPreAuthorizations(db, facilityId),
      listShaClaims(db, facilityId),
      claimId ? getShaClaim(db, facilityId, claimId) : Promise.resolve(null),
      listShaRemittances(db, facilityId),
      listShaWaivers(db, facilityId),
      listShaReconciliations(db, facilityId),
      getShaReconciliation(db, facilityId, reconciliationId),
      listShaAdjudicationCodes(db, facilityId),
      getShaClaimAging(db, facilityId),
      patientId ? getPatientBenefitCoverage(db, facilityId, patientId) : Promise.resolve(null),
      packageId ? getBenefitPackage(db, facilityId, packageId) : Promise.resolve(null),
      listPayers(db, facilityId),
      listPayerContracts(db, facilityId),
      listRevenueEncounters(db, facilityId),
      query.length > 0 ? searchPatients(db, facilityId, query, 10) : Promise.resolve([]),
    ]);

    return NextResponse.json({
      empanelments,
      benefitPackages,
      eligibilityChecks,
      preAuthorizations,
      claims,
      claimDetail,
      remittances,
      waivers,
      reconciliations,
      reconciliation,
      adjudicationCodes,
      ageing,
      coverage,
      benefitPackage,
      payers,
      contracts,
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
  try {
    const body = commandRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: "Invalid SHA command", issues: body.error.issues }, { status: 400 });
    }

    const roles = commandRoles[body.data.command];
    if (!roles) {
      return NextResponse.json({ error: "Unknown SHA command" }, { status: 400 });
    }
    const run = commands[body.data.command];
    if (!run) {
      return NextResponse.json({ error: "Unknown SHA command" }, { status: 400 });
    }

    const { facilityId, staff } = await requireApiFacility(roles);
    const { facilityId: _facility, actor: _actor, ...cleanInput } = body.data.input;
    void _facility;
    void _actor;

    const result = await run({
      ...cleanInput,
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid SHA command", issues: error.issues }, { status: 400 });
    }
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
