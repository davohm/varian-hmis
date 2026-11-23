import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { defaultReportFilters } from "@/lib/erp-reporting";
import { ERP_REPORT_CODES, PROMPT20_REPORTS, getEpiWeek, getMonthPeriod, isFutureDate, periodOverlapsClosedFiscalPeriod, toIsoDate, type ErpReportCode } from "@/lib/reporting";
import { MOH_REPORT_CODES, isMohReportCode, type MohReportCode } from "@/lib/moh-reporting";
import { generateMohReport, mohChecksum } from "@/server/reporting/moh";
import { recordAudit } from "@/server/audit";
import { db } from "@/server/db/client";
import { birthNotifications, branches, deathNotifications, encounters, eyeAssessments, fiscalPeriods, immunizations, notifiableEvents, patients, reportCatalogue, reportCells, reportRuns, reportSavedViews } from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { asExecutor, runCommand, type CommandOptions, type CommandTransaction } from "@/server/commands/run";
import { assertFacilityReady } from "@/server/commands/regulatory";
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

// ---------------------------------------------------------------------------
// Phase 20 â€” MOH statutory reporting
// ---------------------------------------------------------------------------

async function ensureMohCatalogue(tx: CommandTransaction) {
  await tx
    .insert(reportCatalogue)
    .values(PROMPT20_REPORTS.map((r) => ({
      reportCode: r.reportCode,
      name: r.name,
      domain: r.domain,
      schedule: r.schedule,
      periodType: r.periodType,
      sourceEntities: [...r.sourceEntities],
      outputFormats: [...r.outputFormats],
      authority: r.authority ?? null,
      enabled: true,
      templateVersion: r.templateVersion ?? null,
    })))
    .onConflictDoUpdate({
      target: reportCatalogue.reportCode,
      set: { name: sql`excluded.name`, domain: sql`excluded.domain`, schedule: sql`excluded.schedule`, periodType: sql`excluded.period_type`, sourceEntities: sql`excluded.source_entities`, outputFormats: sql`excluded.output_formats`, authority: sql`excluded.authority`, enabled: sql`excluded.enabled`, templateVersion: sql`excluded.template_version`, updatedAt: sql`now()` },
    });
}

async function getMohCatalogueRow(tx: CommandTransaction, reportCode: MohReportCode) {
  await ensureMohCatalogue(tx);
  const [row] = await tx.select().from(reportCatalogue).where(eq(reportCatalogue.reportCode, reportCode)).limit(1);
  if (!row) throw new Error(`Report catalogue entry missing for ${reportCode}`);
  return row;
}

async function assertPeriodNotClosed(tx: CommandTransaction, facilityId: string, periodStart: string, periodEnd: string) {
  const closed = await tx.select({ startDate: fiscalPeriods.startDate, endDate: fiscalPeriods.endDate }).from(fiscalPeriods).where(and(eq(fiscalPeriods.facilityId, facilityId), eq(fiscalPeriods.status, "closed")));
  if (periodOverlapsClosedFiscalPeriod(periodStart, periodEnd, closed.map((p) => ({ startDate: String(p.startDate), endDate: String(p.endDate) })))) {
    throw new Error("A report cannot be generated for a period in a closed fiscal period");
  }
}

function resolveMohPeriod(input: { reportCode: MohReportCode; periodStart?: string; periodEnd?: string; month?: number; year?: number; epiWeek?: number; epiYear?: number; today?: string }) {
  const today = input.today ?? toIsoDate(new Date());
  if (input.reportCode === "MOH505") {
    let info = input.periodEnd ? getEpiWeek(input.periodEnd) : getEpiWeek(today);
    if (input.epiWeek && input.epiYear) {
      const jan4 = new Date(Date.UTC(input.epiYear, 0, 4));
      const dayNr = (jan4.getUTCDay() + 6) % 7;
      jan4.setUTCDate(jan4.getUTCDate() - dayNr + 3 + (input.epiWeek - 1) * 7);
      info = getEpiWeek(toIsoDate(jan4));
    }
    return { periodStart: info.weekStart, periodEnd: info.weekEnding, epiWeek: info.epiWeek, epiYear: info.epiYear, month: null as number | null, year: info.epiYear };
  }
  const year = input.year ?? (input.periodStart ? Number(input.periodStart.slice(0, 4)) : Number(today.slice(0, 4)));
  const month = input.month ?? (input.periodStart ? Number(input.periodStart.slice(5, 7)) : Number(today.slice(5, 7)));
  const mp = getMonthPeriod(year, month);
  return { periodStart: mp.periodStart, periodEnd: mp.periodEnd, epiWeek: null as number | null, epiYear: null as number | null, month: mp.month, year: mp.year };
}

const baseActor = z.object({ userId: z.string().min(1), ip: z.string().optional().nullable(), deviceId: z.string().optional().nullable() });

export const generateReportRunSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: baseActor,
  reportCode: z.enum(MOH_REPORT_CODES),
  branchId: z.string().uuid().nullable().optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2200).optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  epiWeek: z.number().int().min(1).max(53).optional(),
  epiYear: z.number().int().min(2000).max(2200).optional(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function generateReportRun(input: z.input<typeof generateReportRunSchema>, options: CommandOptions = {}) {
  const values = generateReportRunSchema.parse(input);
  await assertFacilityReady({ facilityId: values.facilityId, action: "reporting", actor: { userId: values.actor.userId, deviceId: values.actor.deviceId ?? undefined, ip: values.actor.ip ?? undefined }, today: values.today }, { database: options.database ?? db });
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "generateReportRun", async (tx) => {
    const catalogue = await getMohCatalogueRow(tx, values.reportCode);
    if (!catalogue.enabled) throw new Error("This report is not enabled");
    const period = resolveMohPeriod(values);
    const today = values.today ?? toIsoDate(new Date());
    if (isFutureDate(period.periodEnd, today)) throw new Error("A report cannot be generated for a future period");
    await assertPeriodNotClosed(tx, values.facilityId, period.periodStart, period.periodEnd);

    const existing = await tx.select().from(reportRuns).where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.reportId, catalogue.id), values.branchId ? eq(reportRuns.branchId, values.branchId) : sql`${reportRuns.branchId} is null`, eq(reportRuns.periodStart, period.periodStart), eq(reportRuns.periodEnd, period.periodEnd), sql`${reportRuns.status} != 'void'`)).limit(1);
    if (existing[0]) return { runId: existing[0].id, reportCode: values.reportCode, checksum: existing[0].checksum, rowCount: existing[0].rowCount, idempotent: true };

    const cells = await generateMohReport(tx as unknown as ReportingDatabase, { facilityId: values.facilityId, branchId: values.branchId ?? null, reportCode: values.reportCode, periodStart: period.periodStart, periodEnd: period.periodEnd, month: period.month ?? Number(period.periodStart.slice(5, 7)), year: period.year, epiWeek: period.epiWeek, epiYear: period.epiYear });
    const checksum = mohChecksum(cells);
    const [run] = await tx.insert(reportRuns).values({
      facilityId: values.facilityId, reportId: catalogue.id, branchId: values.branchId ?? null,
      periodStart: period.periodStart, periodEnd: period.periodEnd, epiWeek: period.epiWeek, epiYear: period.epiYear,
      month: period.month, year: period.year, status: "generated", rowCount: cells.length, checksum,
      generatedBy: values.actor.userId, generatedAt: new Date(), createdBy: values.actor.userId, version: 1,
    }).returning({ id: reportRuns.id });
    if (cells.length) {
      await tx.insert(reportCells).values(cells.map((c) => ({ facilityId: values.facilityId, reportRunId: run.id, section: c.section ?? null, rowCode: c.rowCode ?? null, rowLabel: c.rowLabel ?? null, colKey: c.colKey ?? null, colLabel: c.colLabel ?? null, valueNumeric: c.valueNumeric == null ? null : String(c.valueNumeric), valueText: c.valueText ?? null, sortOrder: c.sortOrder, isTotal: Boolean(c.isTotal), sourceQuery: c.sourceQuery ?? null })));
    }
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "report_generated", entity: "report_run", entityId: run.id, details: { reportCode: values.reportCode, periodStart: period.periodStart, periodEnd: period.periodEnd, checksum, rowCount: cells.length } });
    return { runId: run.id, reportCode: values.reportCode, checksum, rowCount: cells.length, idempotent: false };
  }, options);
}

export const regenerateReportRunSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, runId: z.string().uuid(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export async function regenerateReportRun(input: z.input<typeof regenerateReportRunSchema>, options: CommandOptions = {}) {
  const values = regenerateReportRunSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "regenerateReportRun", async (tx) => {
    const [run] = await tx.select().from(reportRuns).where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.id, values.runId))).limit(1);
    if (!run) throw new Error("Report run not found");
    if (run.status === "submitted" || run.status === "void") throw new Error("Submitted or voided runs cannot be regenerated");
    await assertPeriodNotClosed(tx, values.facilityId, String(run.periodStart), String(run.periodEnd));
    const [cat] = await tx.select().from(reportCatalogue).where(eq(reportCatalogue.id, run.reportId)).limit(1);
    if (!cat || !isMohReportCode(cat.reportCode)) throw new Error("Only MOH statutory runs can be regenerated here");
    const reportCode = cat.reportCode as MohReportCode;
    const cells = await generateMohReport(tx as unknown as ReportingDatabase, { facilityId: values.facilityId, branchId: run.branchId, reportCode, periodStart: String(run.periodStart), periodEnd: String(run.periodEnd), month: run.month ?? Number(String(run.periodStart).slice(5, 7)), year: run.year ?? Number(String(run.periodStart).slice(0, 4)), epiWeek: run.epiWeek, epiYear: run.epiYear });
    const checksum = mohChecksum(cells);
    await tx.update(reportRuns).set({ status: "void", voidedAt: new Date(), voidReason: "Regenerated", updatedAt: new Date(), version: sql`${reportRuns.version} + 1` }).where(eq(reportRuns.id, run.id));
    const [newRun] = await tx.insert(reportRuns).values({
      facilityId: values.facilityId, reportId: run.reportId, branchId: run.branchId,
      periodStart: run.periodStart, periodEnd: run.periodEnd, epiWeek: run.epiWeek, epiYear: run.epiYear,
      month: run.month, year: run.year, status: "generated", rowCount: cells.length, checksum,
      generatedBy: values.actor.userId, generatedAt: new Date(), createdBy: values.actor.userId, version: (run.version ?? 1) + 1,
    }).returning({ id: reportRuns.id });
    if (cells.length) await tx.insert(reportCells).values(cells.map((c) => ({ facilityId: values.facilityId, reportRunId: newRun.id, section: c.section ?? null, rowCode: c.rowCode ?? null, rowLabel: c.rowLabel ?? null, colKey: c.colKey ?? null, colLabel: c.colLabel ?? null, valueNumeric: c.valueNumeric == null ? null : String(c.valueNumeric), valueText: c.valueText ?? null, sortOrder: c.sortOrder, isTotal: Boolean(c.isTotal), sourceQuery: c.sourceQuery ?? null })));
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "report_regenerated", entity: "report_run", entityId: newRun.id, details: { reportCode, checksum, rowCount: cells.length, previousRunId: run.id } });
    return { runId: newRun.id, previousRunId: run.id, checksum, rowCount: cells.length };
  }, options);
}

export const submitReportRunSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, runId: z.string().uuid(), acknowledgementRef: z.string().trim().max(120).optional().nullable() });
export async function submitReportRun(input: z.input<typeof submitReportRunSchema>, options: CommandOptions = {}) {
  const values = submitReportRunSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "submitReportRun", async (tx) => {
    const [run] = await tx.select().from(reportRuns).where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.id, values.runId))).limit(1);
    if (!run) throw new Error("Report run not found");
    if (run.status !== "generated" && run.status !== "exported") throw new Error("Only a generated report can be submitted");
    const ref = values.acknowledgementRef?.trim() || `SUB-${run.id.slice(0, 8).toUpperCase()}`;
    await tx.update(reportRuns).set({ status: "submitted", submittedAt: new Date(), submittedBy: values.actor.userId, acknowledgementRef: ref, updatedAt: new Date(), version: sql`${reportRuns.version} + 1` }).where(eq(reportRuns.id, run.id));
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "report_submitted", entity: "report_run", entityId: run.id, details: { acknowledgementRef: ref } });
    return { runId: run.id, acknowledgementRef: ref };
  }, options);
}

export const voidReportRunSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, runId: z.string().uuid(), reason: z.string().trim().min(1).max(500) });
export async function voidReportRun(input: z.input<typeof voidReportRunSchema>, options: CommandOptions = {}) {
  const values = voidReportRunSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "voidReportRun", async (tx) => {
    const [run] = await tx.select().from(reportRuns).where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.id, values.runId))).limit(1);
    if (!run) throw new Error("Report run not found");
    if (run.status === "void") return { runId: run.id, alreadyVoided: true };
    await tx.update(reportRuns).set({ status: "void", voidedAt: new Date(), voidReason: values.reason, updatedAt: new Date(), version: sql`${reportRuns.version} + 1` }).where(eq(reportRuns.id, run.id));
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "report_voided", entity: "report_run", entityId: run.id, details: { reason: values.reason, previousStatus: run.status } });
    return { runId: run.id, alreadyVoided: false };
  }, options);
}

export const exportReportRunSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, runId: z.string().uuid(), format: z.enum(["csv", "xlsx", "pdf"]) });
export async function exportReportRun(input: z.input<typeof exportReportRunSchema>, options: CommandOptions = {}) {
  const values = exportReportRunSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "exportReportRun", async (tx) => {
    const [run] = await tx.select().from(reportRuns).where(and(eq(reportRuns.facilityId, values.facilityId), eq(reportRuns.id, values.runId))).limit(1);
    if (!run) throw new Error("Report run not found");
    await tx.update(reportRuns).set({ status: run.status === "submitted" ? "submitted" : "exported", exportedFile: values.format, updatedAt: new Date(), version: sql`${reportRuns.version} + 1` }).where(eq(reportRuns.id, run.id));
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "report_exported", entity: "report_run", entityId: run.id, details: { format: values.format } });
    return { runId: run.id, format: values.format, checksum: run.checksum };
  }, options);
}

export const createNotifiableEventSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, patientId: z.string().uuid().nullable().optional(), encounterId: z.string().uuid().nullable().optional(), diseaseCode: z.string().trim().max(64).nullable().optional(), diseaseName: z.string().trim().min(1).max(200), classification: z.string().trim().max(120).nullable().optional(), onsetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), detectedAt: z.string().datetime().optional(), notes: z.string().trim().max(2000).nullable().optional() });
export async function createNotifiableEvent(input: z.input<typeof createNotifiableEventSchema>, options: CommandOptions = {}) {
  const values = createNotifiableEventSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "createNotifiableEvent", async (tx) => {
    const immediate = /cholera|measles|polio|afp|vhf|ebola|yellow fever|plague|anthrax|rabies/i.test(values.diseaseName);
    const [row] = await tx.insert(notifiableEvents).values({ facilityId: values.facilityId, patientId: values.patientId ?? null, encounterId: values.encounterId ?? null, diseaseCode: values.diseaseCode ?? null, diseaseName: values.diseaseName, classification: values.classification ?? (immediate ? "immediate" : "weekly"), onsetDate: values.onsetDate ?? null, detectedAt: values.detectedAt ? new Date(values.detectedAt) : new Date(), status: "draft", notes: values.notes ?? null, createdBy: values.actor.userId, version: 1 }).returning({ id: notifiableEvents.id });
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "notifiable_event_created", entity: "notifiable_event", entityId: row.id, details: { diseaseName: values.diseaseName, immediate } });
    return { eventId: row.id, immediate };
  }, options);
}

export const submitNotifiableEventSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, eventId: z.string().uuid(), reportedTo: z.string().trim().min(1).max(200), method: z.string().trim().max(64).nullable().optional() });
export async function submitNotifiableEvent(input: z.input<typeof submitNotifiableEventSchema>, options: CommandOptions = {}) {
  const values = submitNotifiableEventSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "submitNotifiableEvent", async (tx) => {
    const [row] = await tx.select().from(notifiableEvents).where(and(eq(notifiableEvents.facilityId, values.facilityId), eq(notifiableEvents.id, values.eventId))).limit(1);
    if (!row) throw new Error("Notifiable event not found");
    await tx.update(notifiableEvents).set({ status: "submitted", reportedAt: new Date(), reportedTo: values.reportedTo, method: values.method ?? null, updatedAt: new Date(), version: sql`${notifiableEvents.version} + 1` }).where(eq(notifiableEvents.id, row.id));
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "notifiable_event_submitted", entity: "notifiable_event", entityId: row.id, details: { reportedTo: values.reportedTo } });
    return { eventId: row.id };
  }, options);
}

async function allocateNotificationNo(_tx: CommandTransaction, _facilityId: string, prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export const createBirthNotificationSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, patientId: z.string().uuid().nullable().optional(), encounterId: z.string().uuid().nullable().optional(), childMrn: z.string().trim().max(64).nullable().optional(), sex: z.string().trim().max(16).nullable().optional(), birthWeightKg: z.number().nonnegative().nullable().optional(), birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().trim().max(2000).nullable().optional() });
export async function createBirthNotification(input: z.input<typeof createBirthNotificationSchema>, options: CommandOptions = {}) {
  const values = createBirthNotificationSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "createBirthNotification", async (tx) => {
    const notificationNo = await allocateNotificationNo(tx, values.facilityId, "BN");
    const [row] = await tx.insert(birthNotifications).values({ facilityId: values.facilityId, patientId: values.patientId ?? null, encounterId: values.encounterId ?? null, childMrn: values.childMrn ?? null, sex: values.sex ?? null, birthWeightKg: values.birthWeightKg == null ? null : String(values.birthWeightKg), birthDate: values.birthDate, notificationNo, notifiedAt: new Date(), status: "submitted", notes: values.notes ?? null, createdBy: values.actor.userId, version: 1 }).returning({ id: birthNotifications.id, notificationNo: birthNotifications.notificationNo });
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "birth_notification_created", entity: "birth_notification", entityId: row.id, details: { notificationNo: row.notificationNo, birthDate: values.birthDate } });
    return { notificationId: row.id, notificationNo: row.notificationNo };
  }, options);
}

export const createDeathNotificationSchema = z.object({ facilityId: z.string().uuid(), idempotencyKey: z.string().uuid(), actor: baseActor, patientId: z.string().uuid().nullable().optional(), encounterId: z.string().uuid().nullable().optional(), dateOfDeath: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), causeCode: z.string().trim().max(64).nullable().optional(), causeText: z.string().trim().max(500).nullable().optional(), placeOfDeath: z.string().trim().max(200).nullable().optional(), notes: z.string().trim().max(2000).nullable().optional() });
export async function createDeathNotification(input: z.input<typeof createDeathNotificationSchema>, options: CommandOptions = {}) {
  const values = createDeathNotificationSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "createDeathNotification", async (tx) => {
    const notificationNo = await allocateNotificationNo(tx, values.facilityId, "DN");
    const [row] = await tx.insert(deathNotifications).values({ facilityId: values.facilityId, patientId: values.patientId ?? null, encounterId: values.encounterId ?? null, dateOfDeath: values.dateOfDeath, causeCode: values.causeCode ?? null, causeText: values.causeText ?? null, placeOfDeath: values.placeOfDeath ?? null, notificationNo, notifiedAt: new Date(), status: "submitted", notes: values.notes ?? null, createdBy: values.actor.userId, version: 1 }).returning({ id: deathNotifications.id, notificationNo: deathNotifications.notificationNo });
    await auditReport(tx, { facilityId: values.facilityId, userId: values.actor.userId, ip: values.actor.ip, deviceId: values.actor.deviceId, action: "death_notification_created", entity: "death_notification", entityId: row.id, details: { notificationNo: row.notificationNo, dateOfDeath: values.dateOfDeath } });
    return { notificationId: row.id, notificationNo: row.notificationNo };
  }, options);
}

/** Source-record commands for the MOH 710A/EPI summary. */
export const recordImmunizationSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: baseActor,
  branchId: z.string().uuid(),
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  antigenCode: z.string().trim().min(1).max(32),
  doseCode: z.string().trim().min(1).max(32),
  administeredAt: z.string().datetime().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function recordImmunization(input: z.input<typeof recordImmunizationSchema>, options: CommandOptions = {}) {
  const values = recordImmunizationSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "recordImmunization", async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, values.branchId), eq(branches.facilityId, values.facilityId))).limit(1);
    if (!branch) throw new Error("Branch not found for this facility");
    const [patient] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, values.patientId), eq(patients.facilityId, values.facilityId))).limit(1);
    if (!patient) throw new Error("Patient not found for this facility");
    if (values.encounterId) {
      const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(and(eq(encounters.id, values.encounterId), eq(encounters.facilityId, values.facilityId), eq(encounters.patientId, values.patientId))).limit(1);
      if (!encounter) throw new Error("Encounter not found for this patient");
    }
    const [row] = await tx.insert(immunizations).values({
      facilityId: values.facilityId,
      branchId: values.branchId,
      encounterId: values.encounterId ?? null,
      patientId: values.patientId,
      itemId: values.itemId ?? null,
      batchId: values.batchId ?? null,
      antigenCode: values.antigenCode,
      doseCode: values.doseCode,
      administeredAt: values.administeredAt ? new Date(values.administeredAt) : new Date(),
      status: "administered",
      notes: values.notes ?? null,
      createdBy: values.actor.userId,
      version: 1,
    }).returning({ id: immunizations.id });
    await auditReport(tx, {
      facilityId: values.facilityId,
      userId: values.actor.userId,
      ip: values.actor.ip,
      deviceId: values.actor.deviceId,
      action: "immunization_recorded",
      entity: "immunization",
      entityId: row.id,
      details: { patientId: values.patientId, antigenCode: values.antigenCode, doseCode: values.doseCode },
    });
    return { immunizationId: row.id };
  }, options);
}

/** Source-record commands for the MOH 416 register and 735 eye summary. */
export const recordEyeAssessmentSchema = z.object({
  facilityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  actor: baseActor,
  branchId: z.string().uuid(),
  encounterId: z.string().uuid(),
  patientId: z.string().uuid(),
  visitedAt: z.string().datetime().optional(),
  visitType: z.enum(["new", "revisit", "review", "walk_in"]).default("new"),
  visualAcuity: z.enum(["normal", "low_vision", "blind"]).default("normal"),
  vaRight: z.string().trim().max(32).nullable().optional(),
  vaLeft: z.string().trim().max(32).nullable().optional(),
  disabilityType: z.string().trim().max(200).nullable().optional(),
  diagnosisCode: z.string().trim().min(1).max(64),
  impression: z.string().trim().max(500).nullable().optional(),
  management: z.string().trim().max(2000).nullable().optional(),
  referral: z.string().trim().max(500).nullable().optional(),
  county: z.string().trim().max(120).nullable().optional(),
  residence: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  registeredBy: z.string().trim().max(200).nullable().optional(),
  seenBy: z.string().trim().max(200).nullable().optional(),
  timeRegistered: z.string().datetime().nullable().optional(),
  timeSeen: z.string().datetime().nullable().optional(),
  lastStage: z.string().trim().max(64).nullable().optional(),
  admittedAt: z.string().datetime().nullable().optional(),
  dischargedAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function recordEyeAssessment(input: z.input<typeof recordEyeAssessmentSchema>, options: CommandOptions = {}) {
  const values = recordEyeAssessmentSchema.parse(input);
  return runCommand({ facilityId: values.facilityId, idempotencyKey: values.idempotencyKey }, "recordEyeAssessment", async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, values.branchId), eq(branches.facilityId, values.facilityId))).limit(1);
    if (!branch) throw new Error("Branch not found for this facility");
    const [patient] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, values.patientId), eq(patients.facilityId, values.facilityId))).limit(1);
    if (!patient) throw new Error("Patient not found for this facility");
    const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(and(eq(encounters.id, values.encounterId), eq(encounters.facilityId, values.facilityId), eq(encounters.patientId, values.patientId))).limit(1);
    if (!encounter) throw new Error("Encounter not found for this patient");
    const [row] = await tx.insert(eyeAssessments).values({
      facilityId: values.facilityId,
      branchId: values.branchId,
      encounterId: values.encounterId,
      patientId: values.patientId,
      visitedAt: values.visitedAt ? new Date(values.visitedAt) : new Date(),
      visitType: values.visitType,
      visualAcuity: values.visualAcuity,
      vaRight: values.vaRight ?? null,
      vaLeft: values.vaLeft ?? null,
      disabilityType: values.disabilityType ?? null,
      diagnosisCode: values.diagnosisCode,
      impression: values.impression ?? null,
      management: values.management ?? null,
      referral: values.referral ?? null,
      county: values.county ?? null,
      residence: values.residence ?? null,
      phone: values.phone ?? null,
      registeredBy: values.registeredBy ?? null,
      seenBy: values.seenBy ?? null,
      timeRegistered: values.timeRegistered ? new Date(values.timeRegistered) : null,
      timeSeen: values.timeSeen ? new Date(values.timeSeen) : null,
      lastStage: values.lastStage ?? null,
      admittedAt: values.admittedAt ? new Date(values.admittedAt) : null,
      dischargedAt: values.dischargedAt ? new Date(values.dischargedAt) : null,
      notes: values.notes ?? null,
      createdBy: values.actor.userId,
      version: 1,
    }).returning({ id: eyeAssessments.id });
    await auditReport(tx, {
      facilityId: values.facilityId,
      userId: values.actor.userId,
      ip: values.actor.ip,
      deviceId: values.actor.deviceId,
      action: "eye_assessment_recorded",
      entity: "eye_assessment",
      entityId: row.id,
      details: { patientId: values.patientId, diagnosisCode: values.diagnosisCode, visitType: values.visitType },
    });
    return { eyeAssessmentId: row.id };
  }, options);
}
