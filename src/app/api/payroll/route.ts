import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { PAYROLL_READ_ROLES, PAYROLL_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  approvePayrollRun,
  createPayrollRun,
  postPayrollRun,
} from "@/server/commands/payroll";
import { db } from "@/server/db/client";
import { listPayrollEmployees } from "@/server/queries/hr";
import {
  getPayrollOverview,
  getPayrollRun,
  listPayrollCostCenters,
  listPayrollRuns,
  listStatutoryRates,
} from "@/server/queries/payroll";

import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  createPayrollRun: (input) =>
    createPayrollRun(input as Parameters<typeof createPayrollRun>[0]),
  approvePayrollRun: (input) =>
    approvePayrollRun(input as Parameters<typeof approvePayrollRun>[0]),
  postPayrollRun: (input) => postPayrollRun(input as Parameters<typeof postPayrollRun>[0]),
};

export async function GET(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(PAYROLL_READ_ROLES);
    const viewerId = staff.user.id;
    const runId = new URL(request.url).searchParams.get("runId") ?? undefined;
    const [overview, runs, detail, rates, costCenters, employees] = await Promise.all([
      getPayrollOverview(db, facilityId),
      listPayrollRuns(db, facilityId),
      runId ? getPayrollRun(db, facilityId, runId) : Promise.resolve(null),
      listStatutoryRates(db, facilityId),
      listPayrollCostCenters(db, facilityId),
      listPayrollEmployees(db, facilityId),
    ]);

    return NextResponse.json({
      viewerId,
      overview,
      runs,
      detail,
      rates,
      costCenters,
      employees,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(request, PAYROLL_WRITE_ROLES, commands, "Invalid payroll command");
}
