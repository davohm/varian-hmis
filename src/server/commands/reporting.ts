import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { defaultReportFilters } from "@/lib/erp-reporting";
import { ERP_REPORT_CODES, type ErpReportCode } from "@/lib/reporting";
import { recordAudit } from "@/server/audit";
import { reportCatalogue, reportCells, reportRuns, reportSavedViews } from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { asExecutor, runCommand, type CommandOptions, type CommandTransaction } from "@/server/commands/run";
import {
  getErpReportData,
  reportChecksum,
  reportRowsToCells,
  type ReportingDatabase,
} from "@/server/queries/reporting";

const filtersSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    periodId: z.string().uuid().optional(),
    costCenterId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
  })
  .default({});

async function getCatalogueId(tx: CommandTransaction, reportCode: ErpReportCode): Promise<string> {
  const [row] = await tx
    .select({ id: reportCatalogue.id })
    .from(reportCatalogue)
    .where(eq(reportCatalogue.reportCode, reportCode))
    .limit(1);
  if (!row) throw new Error(`Report catalogue entry missing for ${reportCode}`);
  return row.id;
}

async function auditReport(
  tx: CommandTransaction,
  input: {
    facilityId: string;
    userId: string;
    ip?: string | null;
    deviceId?: string | null;
    action: string;
    entity: string;
    entityId: string;
    details: Record<string, unknown>;
  },
) {
  await recordAudit(asExecutor(tx), {
    facilityId: input.facilityId,
    userId: input.userId,
    action: input.action,
    module: "reporting",
    entity: input.entity,
    entityId: input.entityId,
    details: input.details,
    deviceId: input.deviceId,
    ip: input.ip,
  });
  await publishEvent(asExecutor(tx), {
    type: input.action,
    facilityId: input.facilityId,
    ...input.details,
    entity: input.entity,
    entityId: input.entityId,
  });
}

export const generateErpReportSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: z.object({ userId: z.string().min(1), ip: z.string().optional().nullable(), deviceId: z.string().optional().nullable() }),
  reportCode: z.enum(ERP_REPORT_CODES),
  filters: filtersSchema,
});

export async function generateErpReport(
  input: z.input<typeof generateErpReportSchema>,
  options: CommandOptions = {},
) {
  const values = generateErpReportSchema.parse(input);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "generateErpReport",
    async (tx) => {
      const database = tx as unknown as ReportingDatabase;
      const data = await getErpReportData(database, values.facilityId, values.reportCode, values.filters);
      const { from, to } = defaultReportFilters(values.filters);
      const reportId = await getCatalogueId(tx, values.reportCode);
      const checksum = reportChecksum(data);
      const [run] = await tx
        .insert(reportRuns)
        .values({
          facilityId: values.facilityId,
          reportId,
          periodStart: from,
          periodEnd: to,
          status: "generated",
          rowCount: data.rows.length,
          checksum,
          generatedBy: values.actor.userId,
          generatedAt: new Date(),
          createdBy: values.actor.userId,
          version: 1,
        })
        .returning({ id: reportRuns.id });

      if (data.rows.length > 0) {
        await tx.insert(reportCells).values(
          reportRowsToCells(data).map((cell) => ({
            facilityId: values.facilityId,
            reportRunId: run.id,
            section: cell.section,
            rowCode: cell.rowCode,
            rowLabel: cell.rowLabel,
            colKey: cell.colKey,
            colLabel: cell.colLabel,
            valueText: cell.valueText,
            sortOrder: cell.sortOrder,
            isTotal: cell.isTotal,
          })),
        );
      }

      await auditReport(tx, {
        facilityId: values.facilityId,
        userId: values.actor.userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "report_generated",
        entity: "report_run",
        entityId: run.id,
        details: { reportCode: values.reportCode, from, to, rowCount: data.rows.length, checksum },
      });

      return { runId: run.id, reportCode: values.reportCode, checksum, rowCount: data.rows.length };
    },
    options,
  );
}

export const saveReportViewSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: z.object({ userId: z.string().min(1), ip: z.string().optional().nullable(), deviceId: z.string().optional().nullable() }),
  reportCode: z.enum(ERP_REPORT_CODES),
  name: z.string().trim().min(1).max(120),
  shared: z.boolean().default(false),
  filters: filtersSchema,
  columns: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
});

export async function saveReportView(
  input: z.input<typeof saveReportViewSchema>,
  options: CommandOptions = {},
) {
  const values = saveReportViewSchema.parse(input);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "saveReportView",
    async (tx) => {
      const [existing] = await tx
        .select({ id: reportSavedViews.id })
        .from(reportSavedViews)
        .where(
          and(
            eq(reportSavedViews.facilityId, values.facilityId),
            eq(reportSavedViews.ownerId, values.actor.userId),
            eq(reportSavedViews.name, values.name),
          ),
        )
        .limit(1);

      const [row] = existing
        ? await tx
            .update(reportSavedViews)
            .set({
              reportCode: values.reportCode,
              shared: values.shared,
              filters: values.filters,
              columns: values.columns ?? null,
              active: true,
              updatedAt: new Date(),
              version: sql`${reportSavedViews.version} + 1`,
            })
            .where(eq(reportSavedViews.id, existing.id))
            .returning({ id: reportSavedViews.id })
        : await tx
            .insert(reportSavedViews)
            .values({
              facilityId: values.facilityId,
              reportCode: values.reportCode,
              name: values.name,
              ownerId: values.actor.userId,
              shared: values.shared,
              filters: values.filters,
              columns: values.columns ?? null,
              active: true,
              createdBy: values.actor.userId,
              version: 1,
            })
            .returning({ id: reportSavedViews.id });

      await auditReport(tx, {
        facilityId: values.facilityId,
        userId: values.actor.userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: existing ? "report_view_updated" : "report_view_saved",
        entity: "report_saved_view",
        entityId: row.id,
        details: { reportCode: values.reportCode, name: values.name, shared: values.shared },
      });
      return { viewId: row.id };
    },
    options,
  );
}

export const archiveReportViewSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: z.object({ userId: z.string().min(1), ip: z.string().optional().nullable(), deviceId: z.string().optional().nullable() }),
  viewId: z.string().uuid(),
});

export async function archiveReportView(
  input: z.input<typeof archiveReportViewSchema>,
  options: CommandOptions = {},
) {
  const values = archiveReportViewSchema.parse(input);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "archiveReportView",
    async (tx) => {
      const [view] = await tx
        .select({ id: reportSavedViews.id, ownerId: reportSavedViews.ownerId, name: reportSavedViews.name })
        .from(reportSavedViews)
        .where(and(eq(reportSavedViews.facilityId, values.facilityId), eq(reportSavedViews.id, values.viewId)))
        .limit(1);
      if (!view) throw new Error("Report view not found");
      if (view.ownerId !== values.actor.userId) throw new Error("You can only archive your own saved views");

      await tx
        .update(reportSavedViews)
        .set({ active: false, updatedAt: new Date(), version: sql`${reportSavedViews.version} + 1` })
        .where(eq(reportSavedViews.id, view.id));

      await auditReport(tx, {
        facilityId: values.facilityId,
        userId: values.actor.userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "report_view_archived",
        entity: "report_saved_view",
        entityId: view.id,
        details: { name: view.name },
      });
      return { viewId: view.id };
    },
    options,
  );
}

export const markReportExportedSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: z.object({ userId: z.string().min(1), ip: z.string().optional().nullable(), deviceId: z.string().optional().nullable() }),
  runId: z.string().uuid(),
  format: z.enum(["csv", "print"]),
});

export async function markReportExported(
  input: z.input<typeof markReportExportedSchema>,
  options: CommandOptions = {},
) {
  const values = markReportExportedSchema.parse(input);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "markReportExported",
    async (tx) => {
      const [run] = await tx
        .select({ id: reportRuns.id, status: reportRuns.status })
        .from(reportRuns)
        .where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.id, values.runId)))
        .limit(1);
      if (!run) throw new Error("Report run not found");

      await tx
        .update(reportRuns)
        .set({
          status: "exported",
          exportedFile: values.format,
          updatedAt: new Date(),
          version: sql`${reportRuns.version} + 1`,
        })
        .where(eq(reportRuns.id, run.id));

      await auditReport(tx, {
        facilityId: values.facilityId,
        userId: values.actor.userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "report_exported",
        entity: "report_run",
        entityId: run.id,
        details: { format: values.format },
      });
      return { runId: run.id, format: values.format };
    },
    options,
  );
}

export async function exportReportRunCsv(
  database: ReportingDatabase,
  facilityId: string,
  reportCode: ErpReportCode,
  filters: z.input<typeof filtersSchema>,
) {
  const data = await getErpReportData(database, facilityId, reportCode, filters);
  return { filename: `${reportCode}-${data.to}.csv`, data };
}
