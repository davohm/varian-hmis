import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { REPORT_READ_ROLES, REPORT_WRITE_ROLES } from "@/lib/navigation";
import { isErpReportCode } from "@/lib/reporting";
import { cellsToCsv, cellsToPrintHtml, cellsToXlsHtml, exportChecksum } from "@/lib/moh-export";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { archiveReportView, createBirthNotification, createDeathNotification, createNotifiableEvent, exportReportRun, generateErpReport, generateReportRun, markReportExported, regenerateReportRun, saveReportView, submitNotifiableEvent, submitReportRun, voidReportRun } from "@/server/commands/reporting";
import { getApprovalInbox, getErpReportData, getReportDrillDown, getReportCells, getReportRunAuditTrail, listReportCatalogue, listReportRuns, listSavedReportViews } from "@/server/queries/reporting";
import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands = {
  generateErpReport,
  saveReportView,
  archiveReportView,
  markReportExported,
  generateReportRun,
  regenerateReportRun,
  exportReportRun,
  submitReportRun,
  voidReportRun,
  createNotifiableEvent,
  submitNotifiableEvent,
  createBirthNotification,
  createDeathNotification,
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

    const runId = stringParam(params.get("runId"));
    const exportFormat = stringParam(params.get("export"));
    const drillRowCode = stringParam(params.get("drillRowCode"));
    const drillColKey = stringParam(params.get("drillColKey"));

    if (runId && drillRowCode && drillColKey) {
      const { drillDownReportCell } = await import("@/server/queries/reporting");
      const cell = await drillDownReportCell(db, facilityId, runId, drillRowCode, drillColKey);
      return NextResponse.json({ cell });
    }

    if (runId && exportFormat) {
      const [run] = await db.select().from((await import("@/server/db/schema")).reportRuns).where((await import("drizzle-orm")).and((await import("drizzle-orm")).eq((await import("@/server/db/schema")).reportRuns.facilityId, facilityId), (await import("drizzle-orm")).eq((await import("@/server/db/schema")).reportRuns.id, runId))).limit(1);
      if (!run) return NextResponse.json({ error: "Report run not found" }, { status: 404 });
      const [cat] = await db.select().from((await import("@/server/db/schema")).reportCatalogue).where((await import("drizzle-orm")).eq((await import("@/server/db/schema")).reportCatalogue.id, run.reportId)).limit(1);
      const cells = await getReportCells(db, facilityId, runId);
      const mapped = cells.map((c) => ({ section: c.section, rowCode: c.rowCode, rowLabel: c.rowLabel, colKey: c.colKey, colLabel: c.colLabel, valueNumeric: c.valueNumeric, valueText: c.valueText, sortOrder: c.sortOrder, isTotal: c.isTotal }));
      const checksum = exportChecksum(mapped);
      const periodLabel = `${run.periodStart} to ${run.periodEnd}`;
      const filename = `${cat?.reportCode ?? "report"}-${run.periodEnd}.${exportFormat === "xlsx" ? "xls" : exportFormat === "pdf" ? "html" : "csv"}`;
      if (exportFormat === "csv") {
        return new NextResponse(cellsToCsv(mapped), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "X-Report-Checksum": checksum } });
      }
      if (exportFormat === "xlsx") {
        return new NextResponse(cellsToXlsHtml(cat?.reportCode ?? "MOH", periodLabel, mapped), { headers: { "Content-Type": "application/vnd.ms-excel; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "X-Report-Checksum": checksum } });
      }
      if (exportFormat === "pdf") {
        return new NextResponse(cellsToPrintHtml(cat?.reportCode ?? "MOH", cat?.name ?? "MOH Report", periodLabel, checksum, mapped), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `inline; filename="${filename}"`, "X-Report-Checksum": checksum } });
      }
      return NextResponse.json({ error: "Unsupported export format" }, { status: 400 });
    }

    const [catalogue, savedViews, approvalInbox, reportData, drillDown, mohRuns, mohCells, mohAuditTrail] = await Promise.all([
      listReportCatalogue(db),
      listSavedReportViews(db, facilityId, staff.user.id, reportCode),
      getApprovalInbox(db, facilityId),
      reportCode ? getErpReportData(db, facilityId, reportCode, filters) : Promise.resolve(null),
      sourceType && sourceId ? getReportDrillDown(db, facilityId, sourceType, sourceId) : Promise.resolve(null),
      listReportRuns(db, facilityId, { reportCode: reportCodeParam, limit: 50 }),
      runId ? getReportCells(db, facilityId, runId) : Promise.resolve([]),
      runId ? getReportRunAuditTrail(db, facilityId, runId) : Promise.resolve([]),
    ]);

    return NextResponse.json({
      catalogue,
      savedViews,
      approvalInbox,
      reportData,
      drillDown,
      mohRuns,
      mohCells,
      mohAuditTrail,
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
