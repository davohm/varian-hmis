import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { FINANCE_READ_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { listBranches } from "@/server/queries/admin";
import {
  getFinancialStatements,
  listCostCenters,
  listFiscalPeriods,
  type StatementFilters,
} from "@/server/queries/finance";

export const dynamic = "force-dynamic";

const optionalUuid = z.string().uuid();

function uuidParam(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  const parsed = optionalUuid.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must be a valid identifier`);
  return parsed.data;
}

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(FINANCE_READ_ROLES);
    const url = new URL(request.url);
    const filters: StatementFilters = {
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      periodId: uuidParam(url.searchParams.get("periodId"), "Period"),
      costCenterId: uuidParam(url.searchParams.get("costCenterId"), "Cost centre"),
      branchId: uuidParam(url.searchParams.get("branchId"), "Branch"),
    };

    const [statements, periods, costCenters, branches] = await Promise.all([
      getFinancialStatements(db, facilityId, filters),
      listFiscalPeriods(db, facilityId),
      listCostCenters(db, facilityId),
      listBranches(db, facilityId),
    ]);

    return NextResponse.json({ statements, periods, costCenters, branches });
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
