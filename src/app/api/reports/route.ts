import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { REPORT_READ_ROLES, REPORT_WRITE_ROLES } from "@/lib/navigation";
import { isErpReportCode } from "@/lib/reporting";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { archiveReportView, generateErpReport, markReportExported, saveReportView } from "@/server/commands/reporting";
import { getApprovalInbox, getErpReportData, getReportDrillDown, listReportCatalogue, listSavedReportViews } from "@/server/queries/reporting";
import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands = {
  generateErpReport,
  saveReportView,
  archiveReportView,
  markReportExported,
} as const;

function stringParam(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(REPORT_READ_ROLES);
    const params = request.nextUrl.searchParams;
    const reportCodeParam = stringParam(params.get("reportCode"));
    const reportCode = reportCodeParam && isErpReportCode(reportCodeParam) ? reportCodeParam : undefined;
    const sourceType = stringParam(params.get("sourceType"));
    const sourceId = stringParam(params.get("sourceId"));

    const filters = {
      from: stringParam(params.get("from")),
      to: stringParam(params.get("to")),
      asOf: stringParam(params.get("asOf")),
      periodId: stringParam(params.get("periodId")),
      costCenterId: stringParam(params.get("costCenterId")),
      branchId: stringParam(params.get("branchId")),
    };

    const [catalogue, savedViews, approvalInbox, reportData, drillDown] = await Promise.all([
      listReportCatalogue(db),
      listSavedReportViews(db, facilityId, staff.user.id, reportCode),
      getApprovalInbox(db, facilityId),
      reportCode ? getErpReportData(db, facilityId, reportCode, filters) : Promise.resolve(null),
      sourceType && sourceId ? getReportDrillDown(db, facilityId, sourceType, sourceId) : Promise.resolve(null),
    ]);

    return NextResponse.json({
      catalogue,
      savedViews,
      approvalInbox,
      reportData,
      drillDown,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(
    request,
    REPORT_WRITE_ROLES,
    commands as unknown as Record<string, (input: Record<string, unknown>) => Promise<unknown>>,
    "Invalid report command",
  );
}
