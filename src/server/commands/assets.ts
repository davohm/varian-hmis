import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { ForbiddenError } from "@/server/auth/guards";
import {
  assetApprovals,
  assetAssignments,
  assetDisposals,
  assets,
  assetValuations,
  costCenters,
  departments,
  depreciationEntries,
  depreciationRunApprovals,
  depreciationRuns,
  employees,
  facilities,
  maintenanceEvents,
  maintenanceOrders,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { postJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { assertFinanceApprovalLimit } from "./finance";
import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");

const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));

const nonnegativeMoney = money.refine((value) => toCents(value) >= 0, {
  message: "Amount cannot be negative",
});
const positiveMoney = money.refine((value) => toCents(value) > 0, {
  message: "Amount must be greater than zero",
});

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

function assertDifferentActor(action: string, current: string, prior: string | null): void {
  if (prior && current === prior) {
    throw new ForbiddenError(`The same user cannot ${action}`);
  }
}

function employeeName(row: { firstName: string; lastName: string }): string {
  return `${row.firstName} ${row.lastName}`.trim();
}

async function loadFacility(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const facility = rows[0];
  if (!facility) throw new Error("Facility not found");
  return facility;
}

async function auditAndEvent(
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
    eventType: string;
    event: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(tx, {
    facilityId: input.facilityId,
    userId: input.userId,
    action: input.action,
    module: "assets",
    entity: input.entity,
    entityId: input.entityId,
    details: input.details,
    ip: input.ip,
    deviceId: input.deviceId,
  });
  await publishEvent(tx, {
    type: input.eventType,
    facilityId: input.facilityId,
    ...input.event,
  });
}

async function assertEmployee(
  tx: CommandTransaction,
  facilityId: string,
  employeeId: string | null | undefined,
): Promise<string | null> {
  if (!employeeId) return null;
  const rows = await tx
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(and(eq(employees.facilityId, facilityId), eq(employees.id, employeeId)))
    .limit(1);
  const employee = rows[0];
  if (!employee) throw new Error("The custodian must belong to this facility");
  return employeeName(employee);
}

async function assertDepartment(tx: CommandTransaction, facilityId: string, id?: string | null) {
  if (!id) return;
  const rows = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.facilityId, facilityId), eq(departments.id, id)))
    .limit(1);
  if (rows.length === 0) throw new Error("The department must belong to this facility");
}

async function assertCostCenter(tx: CommandTransaction, facilityId: string, id?: string | null) {
  if (!id) return;
  const rows = await tx
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.id, id)))
    .limit(1);
  if (rows.length === 0) throw new Error("The cost centre must belong to this facility");
}

function approvalSystemRole(method: string): string {
  if (method === "bank") return "bank";
  if (method === "accrued") return "asset_proceeds_receivable";
  if (method === "none") return "cash";
  return "cash";
}

function paymentSystemRole(method: string): string {
  if (method === "bank") return "bank";
  if (method === "accrued") return "accounts_payable";
  return "cash";
}

/* ------------------------------------------------------------------ */
/* Asset register                                                      */
/* ------------------------------------------------------------------ */

export const createAssetSchema = z.object({
  ...baseSchema,
  category: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(500),
  tagNo: z.string().trim().max(80).nullable().optional(),
  serialNo: z.string().trim().max(120).nullable().optional(),
  location: z.string().trim().min(1).max(500),
  custodianEmployeeId: z.uuid().nullable().optional(),
  custodianName: z.string().trim().max(120).nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  costCenterId: z.uuid().nullable().optional(),
  acquisitionDate: isoDate,
  acquisitionCost: positiveMoney,
  residualValue: nonnegativeMoney.optional(),
  usefulLifeMonths: z.number().int().min(1).max(1200),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export type CreateAssetInput = z.input<typeof createAssetSchema>;

export interface CreateAssetResult {
  assetId: string;
  assetNo: string;
  carryingAmount: string;
}

export async function createAsset(
  input: CreateAssetInput,
  options: CommandOptions = {},
): Promise<CreateAssetResult> {
  const values = createAssetSchema.parse(input);
  const userId = actorId(values);
  const residualCents = toCents(values.residualValue ?? "0");
  if (residualCents > toCents(values.acquisitionCost)) {
    throw new Error("Residual value cannot exceed acquisition cost");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createAsset",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const custodianName = await assertEmployee(
        tx,
        values.facilityId,
        values.custodianEmployeeId,
      );
      await assertDepartment(tx, values.facilityId, values.departmentId);
      await assertCostCenter(tx, values.facilityId, values.costCenterId);

      const assetNo = await nextFormattedNumber(tx, facility, "asset");
      const assetId = newId();
      await tx.insert(assets).values({
        id: assetId,
        facilityId: values.facilityId,
        assetNo,
        category: values.category,
        name: values.name,
        tagNo: values.tagNo ?? null,
        serialNo: values.serialNo ?? null,
        location: values.location,
        custodianEmployeeId: values.custodianEmployeeId ?? null,
        custodianName: custodianName ?? values.custodianName ?? null,
        departmentId: values.departmentId ?? null,
        costCenterId: values.costCenterId ?? null,
        acquisitionDate: values.acquisitionDate,
        acquisitionCost: values.acquisitionCost,
        residualValue: values.residualValue ?? "0.00",
        usefulLifeMonths: values.usefulLifeMonths,
        accumulatedDepreciation: "0.00",
        carryingAmount: values.acquisitionCost,
        status: "in_service",
        notes: values.notes ?? null,
        createdBy: userId,
      });

      if (values.custodianEmployeeId || values.custodianName) {
        await tx.insert(assetAssignments).values({
          id: newId(),
          facilityId: values.facilityId,
          assetId,
          eventType: "assigned",
          fromLocation: null,
          toLocation: values.location,
          toEmployeeId: values.custodianEmployeeId ?? null,
          performedBy: userId,
          note: "Initial custodian assignment",
          createdBy: userId,
        });
      }

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.create",
        entity: "assets",
        entityId: assetId,
        details: {
          assetNo,
          category: values.category,
          acquisitionCost: values.acquisitionCost,
          usefulLifeMonths: values.usefulLifeMonths,
        },
        eventType: "asset.created",
        event: { assetId, assetNo },
      });

      return { assetId, assetNo, carryingAmount: values.acquisitionCost };
    },
    options,
  );
}

export const assignAssetSchema = z.object({
  ...baseSchema,
  assetId: z.uuid(),
  eventType: z.enum(["assigned", "transferred", "returned"]),
  toEmployeeId: z.uuid().nullable().optional(),
  toLocation: z.string().trim().min(1).max(500),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type AssignAssetInput = z.input<typeof assignAssetSchema>;

export async function assignAsset(
  input: AssignAssetInput,
  options: CommandOptions = {},
): Promise<{ assetId: string; assignmentId: string }> {
  const values = assignAssetSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "assignAsset",
    async (tx) => {
      const rows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, values.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const asset = rows[0];
      if (!asset) throw new Error("Asset not found");
      if (asset.status === "disposed" || asset.status === "written_off") {
        throw new Error("A retired asset cannot be reassigned");
      }

      const toName = await assertEmployee(tx, values.facilityId, values.toEmployeeId);
      const assignmentId = newId();
      await tx.insert(assetAssignments).values({
        id: assignmentId,
        facilityId: values.facilityId,
        assetId: asset.id,
        eventType: values.eventType,
        fromEmployeeId: asset.custodianEmployeeId,
        toEmployeeId: values.toEmployeeId ?? null,
        fromLocation: asset.location,
        toLocation: values.toLocation,
        performedBy: userId,
        note: values.note ?? null,
        createdBy: userId,
      });

      const returning = values.eventType === "returned";
      await tx
        .update(assets)
        .set({
          custodianEmployeeId: returning ? null : (values.toEmployeeId ?? null),
          custodianName: returning ? null : (toName ?? null),
          location: values.toLocation,
          updatedAt: new Date(),
          version: sql`${assets.version} + 1`,
        })
        .where(eq(assets.id, asset.id));

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.assign",
        entity: "asset_assignments",
        entityId: assignmentId,
        details: {
          assetNo: asset.assetNo,
          eventType: values.eventType,
          toLocation: values.toLocation,
        },
        eventType: "asset.assigned",
        event: { assetId: asset.id, assignmentId },
      });

      return { assetId: asset.id, assignmentId };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Depreciation                                                        */
/* ------------------------------------------------------------------ */

export const createDepreciationRunSchema = z.object({
  ...baseSchema,
  period: isoDate,
  description: z.string().trim().max(500).nullable().optional(),
  assetIds: z.array(z.uuid()).max(500).optional(),
});

export type CreateDepreciationRunInput = z.input<typeof createDepreciationRunSchema>;

export interface DepreciationRunResult {
  runId: string;
  runNo: string;
  assetCount: number;
  totalAmount: string;
}

export async function createDepreciationRun(
  input: CreateDepreciationRunInput,
  options: CommandOptions = {},
): Promise<DepreciationRunResult> {
  const values = createDepreciationRunSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createDepreciationRun",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const requestedIds = values.assetIds ? [...new Set(values.assetIds)] : null;
      const candidateRows = await tx
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.facilityId, values.facilityId),
            inArray(assets.status, ["in_service", "stored", "maintenance"]),
            requestedIds ? inArray(assets.id, requestedIds) : undefined,
          ),
        )
        .orderBy(asc(assets.assetNo));
      if (requestedIds && candidateRows.length !== requestedIds.length) {
        throw new Error("One or more assets are not active at this facility");
      }

      const alreadyRun = await tx
        .select({ assetId: depreciationEntries.assetId })
        .from(depreciationEntries)
        .where(
          and(
            eq(depreciationEntries.facilityId, values.facilityId),
            eq(depreciationEntries.period, values.period),
          ),
        );
      const excluded = new Set(alreadyRun.map((row) => row.assetId));

      const prepared: Array<{
        asset: (typeof candidateRows)[number];
        openingCents: number;
        amountCents: number;
        closingCents: number;
      }> = [];
      for (const asset of candidateRows) {
        if (excluded.has(asset.id)) continue;
        const remainingCents = Math.max(
          0,
          toCents(asset.acquisitionCost) -
            toCents(asset.residualValue) -
            toCents(asset.accumulatedDepreciation),
        );
        const monthlyCents = Math.floor(remainingCents / asset.usefulLifeMonths);
        if (monthlyCents <= 0) continue;
        const openingCents = toCents(asset.carryingAmount);
        const amountCents = Math.min(monthlyCents, remainingCents);
        prepared.push({
          asset,
          openingCents,
          amountCents,
          closingCents: Math.max(0, openingCents - amountCents),
        });
      }
      if (prepared.length === 0) {
        throw new Error("No asset has depreciation remaining for this period");
      }

      const totalCents = prepared.reduce((sum, row) => sum + row.amountCents, 0);
      const runNo = await nextFormattedNumber(tx, facility, "depreciationRun");
      const runId = newId();
      await tx.insert(depreciationRuns).values({
        id: runId,
        facilityId: values.facilityId,
        runNo,
        period: values.period,
        description: values.description ?? null,
        status: "draft",
        totalAmount: fromCents(totalCents),
        assetCount: prepared.length,
        preparedBy: userId,
        createdBy: userId,
      });

      await tx.insert(depreciationEntries).values(
        prepared.map((row) => ({
          id: newId(),
          facilityId: values.facilityId,
          runId,
          assetId: row.asset.id,
          period: values.period,
          openingCarryingAmount: fromCents(row.openingCents),
          depreciationAmount: fromCents(row.amountCents),
          closingCarryingAmount: fromCents(row.closingCents),
          usefulLifeMonths: row.asset.usefulLifeMonths,
          costCenterId: row.asset.costCenterId,
          createdBy: userId,
        })),
      );

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.depreciation.prepare",
        entity: "depreciation_runs",
        entityId: runId,
        details: { runNo, period: values.period, assetCount: prepared.length },
        eventType: "asset.depreciation.prepared",
        event: { runId, runNo, assetCount: prepared.length },
      });

      return {
        runId,
        runNo,
        assetCount: prepared.length,
        totalAmount: fromCents(totalCents),
      };
    },
    options,
  );
}

export const approveDepreciationRunSchema = z.object({
  ...baseSchema,
  runId: z.uuid(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type ApproveDepreciationRunInput = z.input<typeof approveDepreciationRunSchema>;

export async function approveDepreciationRun(
  input: ApproveDepreciationRunInput,
  options: CommandOptions = {},
): Promise<{ runId: string; status: "approved"; approvalRole: string | null }> {
  const values = approveDepreciationRunSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approveDepreciationRun",
    async (tx) => {
      const rows = await tx
        .select()
        .from(depreciationRuns)
        .where(
          and(eq(depreciationRuns.id, values.runId), eq(depreciationRuns.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const run = rows[0];
      if (!run) throw new Error("Depreciation run not found");
      if (run.status !== "draft") throw new Error("Only draft depreciation runs can be approved");
      assertDifferentActor("approve their own depreciation run", userId, run.preparedBy);

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approveDepreciationRun",
        toCents(run.totalAmount),
      );

      await tx
        .update(depreciationRuns)
        .set({
          status: "approved",
          approvedBy: userId,
          updatedAt: new Date(),
          version: sql`${depreciationRuns.version} + 1`,
        })
        .where(eq(depreciationRuns.id, run.id));
      await tx.insert(depreciationRunApprovals).values({
        id: newId(),
        facilityId: values.facilityId,
        runId: run.id,
        decision: "approved",
        actorId: userId,
        role: approval?.role ?? "asset_manager",
        maxAmount: approval?.maxAmount ?? "0.00",
        reason: values.reason ?? null,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.depreciation.approve",
        entity: "depreciation_runs",
        entityId: run.id,
        details: { runNo: run.runNo, role: approval?.role ?? null },
        eventType: "asset.depreciation.approved",
        event: { runId: run.id, runNo: run.runNo },
      });

      return {
        runId: run.id,
        status: "approved" as const,
        approvalRole: approval?.role ?? null,
      };
    },
    options,
  );
}

export const postDepreciationRunSchema = z.object({
  ...baseSchema,
  runId: z.uuid(),
});

export type PostDepreciationRunInput = z.input<typeof postDepreciationRunSchema>;

export interface PostedDepreciationResult {
  runId: string;
  entryId: string;
  entryNo: string;
  assetCount: number;
}

export async function postDepreciationRun(
  input: PostDepreciationRunInput,
  options: CommandOptions = {},
): Promise<PostedDepreciationResult> {
  const values = postDepreciationRunSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "postDepreciationRun",
    async (tx) => {
      const rows = await tx
        .select()
        .from(depreciationRuns)
        .where(
          and(eq(depreciationRuns.id, values.runId), eq(depreciationRuns.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const run = rows[0];
      if (!run) throw new Error("Depreciation run not found");
      if (run.status !== "approved") throw new Error("Only approved depreciation runs can be posted");

      const entries = await tx
        .select()
        .from(depreciationEntries)
        .where(
          and(eq(depreciationEntries.facilityId, values.facilityId), eq(depreciationEntries.runId, run.id)),
        )
        .orderBy(asc(depreciationEntries.assetId));
      if (entries.length === 0) throw new Error("The depreciation run has no entries");

      const byCenter = new Map<string, number>();
      let totalCents = 0;
      for (const entry of entries) {
        const key = entry.costCenterId ?? "";
        byCenter.set(key, (byCenter.get(key) ?? 0) + toCents(entry.depreciationAmount));
        totalCents += toCents(entry.depreciationAmount);
      }

      const journalLines: Array<{
        systemRole: string;
        debit?: string;
        credit?: string;
        costCenterId?: string | null;
        description?: string;
      }> = [];
      for (const [centerId, amountCents] of byCenter) {
        if (amountCents <= 0) continue;
        journalLines.push({
          systemRole: "depreciation_expense",
          debit: fromCents(amountCents),
          costCenterId: centerId || null,
          description: "Straight-line depreciation",
        });
      }
      journalLines.push({
        systemRole: "accumulated_depreciation",
        credit: fromCents(totalCents),
        description: `Depreciation run ${run.runNo}`,
      });

      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: run.period,
        description: `Depreciation ${run.runNo} (${run.period})`,
        lines: journalLines,
        sourceType: "depreciation",
        sourceId: run.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      for (const entry of entries) {
        await tx
          .update(assets)
          .set({
            accumulatedDepreciation: sql`${assets.accumulatedDepreciation} + ${entry.depreciationAmount}`,
            carryingAmount: entry.closingCarryingAmount,
            lastDepreciationDate: run.period,
            updatedAt: new Date(),
            version: sql`${assets.version} + 1`,
          })
          .where(eq(assets.id, entry.assetId));
      }

      await tx
        .update(depreciationRuns)
        .set({
          status: "posted",
          postedBy: userId,
          journalEntryId: journal.entryId,
          updatedAt: new Date(),
          version: sql`${depreciationRuns.version} + 1`,
        })
        .where(eq(depreciationRuns.id, run.id));

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.depreciation.post",
        entity: "depreciation_runs",
        entityId: run.id,
        details: { runNo: run.runNo, entryNo: journal.entryNo, assetCount: entries.length },
        eventType: "asset.depreciation.posted",
        event: { runId: run.id, runNo: run.runNo, entryId: journal.entryId },
      });

      return {
        runId: run.id,
        entryId: journal.entryId,
        entryNo: journal.entryNo,
        assetCount: entries.length,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

export const createMaintenanceOrderSchema = z.object({
  ...baseSchema,
  assetId: z.uuid(),
  type: z.enum(["preventive", "corrective", "inspection"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  scheduledDate: isoDate.nullable().optional(),
  assignedToEmployeeId: z.uuid().nullable().optional(),
  vendorName: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().min(1).max(2000),
  partsCost: nonnegativeMoney.optional(),
  laborCost: nonnegativeMoney.optional(),
  paymentMethod: z.enum(["none", "cash", "bank", "accrued"]).default("none"),
});

export type CreateMaintenanceOrderInput = z.input<typeof createMaintenanceOrderSchema>;

export async function createMaintenanceOrder(
  input: CreateMaintenanceOrderInput,
  options: CommandOptions = {},
): Promise<{ orderId: string; orderNo: string }> {
  const values = createMaintenanceOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createMaintenanceOrder",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const assetRows = await tx
        .select({ id: assets.id, assetNo: assets.assetNo })
        .from(assets)
        .where(and(eq(assets.id, values.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1);
      if (assetRows.length === 0) throw new Error("Asset not found");
      await assertEmployee(tx, values.facilityId, values.assignedToEmployeeId);

      const orderNo = await nextFormattedNumber(tx, facility, "maintenanceOrder");
      const orderId = newId();
      const partsCost = values.partsCost ?? "0.00";
      const laborCost = values.laborCost ?? "0.00";
      await tx.insert(maintenanceOrders).values({
        id: orderId,
        facilityId: values.facilityId,
        assetId: values.assetId,
        orderNo,
        type: values.type,
        priority: values.priority,
        status: "open",
        scheduledDate: values.scheduledDate ?? null,
        requestedBy: userId,
        assignedToEmployeeId: values.assignedToEmployeeId ?? null,
        vendorName: values.vendorName ?? null,
        description: values.description,
        partsCost,
        laborCost,
        totalCost: fromCents(toCents(partsCost) + toCents(laborCost)),
        paymentMethod: values.paymentMethod,
        createdBy: userId,
      });
      await tx.insert(maintenanceEvents).values({
        id: newId(),
        facilityId: values.facilityId,
        assetId: values.assetId,
        orderId,
        eventType: "scheduled",
        description: values.description,
        performedBy: userId,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.maintenance.create",
        entity: "maintenance_orders",
        entityId: orderId,
        details: { orderNo, type: values.type, priority: values.priority },
        eventType: "asset.maintenance.created",
        event: { orderId, orderNo, assetId: values.assetId },
      });

      return { orderId, orderNo };
    },
    options,
  );
}

export const startMaintenanceOrderSchema = z.object({
  ...baseSchema,
  orderId: z.uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type StartMaintenanceOrderInput = z.input<typeof startMaintenanceOrderSchema>;

export async function startMaintenanceOrder(
  input: StartMaintenanceOrderInput,
  options: CommandOptions = {},
): Promise<{ orderId: string; status: "in_progress" }> {
  const values = startMaintenanceOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "startMaintenanceOrder",
    async (tx) => {
      const rows = await tx
        .select()
        .from(maintenanceOrders)
        .where(
          and(eq(maintenanceOrders.id, values.orderId), eq(maintenanceOrders.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order) throw new Error("Maintenance order not found");
      if (order.status !== "open") throw new Error("Only open maintenance orders can be started");

      await tx
        .update(maintenanceOrders)
        .set({
          status: "in_progress",
          startedAt: new Date(),
          updatedAt: new Date(),
          version: sql`${maintenanceOrders.version} + 1`,
        })
        .where(eq(maintenanceOrders.id, order.id));
      await tx
        .update(assets)
        .set({
          status: "maintenance",
          updatedAt: new Date(),
          version: sql`${assets.version} + 1`,
        })
        .where(eq(assets.id, order.assetId));
      await tx.insert(maintenanceEvents).values({
        id: newId(),
        facilityId: values.facilityId,
        assetId: order.assetId,
        orderId: order.id,
        eventType: "started",
        description: values.note?.trim() || "Maintenance work started",
        performedBy: userId,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.maintenance.start",
        entity: "maintenance_orders",
        entityId: order.id,
        details: { orderNo: order.orderNo },
        eventType: "asset.maintenance.started",
        event: { orderId: order.id, assetId: order.assetId },
      });

      return { orderId: order.id, status: "in_progress" as const };
    },
    options,
  );
}

export const completeMaintenanceOrderSchema = z.object({
  ...baseSchema,
  orderId: z.uuid(),
  partsCost: nonnegativeMoney.optional(),
  laborCost: nonnegativeMoney.optional(),
  paymentMethod: z.enum(["none", "cash", "bank", "accrued"]).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type CompleteMaintenanceOrderInput = z.input<typeof completeMaintenanceOrderSchema>;

export interface CompletedMaintenanceResult {
  orderId: string;
  entryId: string | null;
  entryNo: string | null;
  totalCost: string;
}

export async function completeMaintenanceOrder(
  input: CompleteMaintenanceOrderInput,
  options: CommandOptions = {},
): Promise<CompletedMaintenanceResult> {
  const values = completeMaintenanceOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "completeMaintenanceOrder",
    async (tx) => {
      const rows = await tx
        .select()
        .from(maintenanceOrders)
        .where(
          and(eq(maintenanceOrders.id, values.orderId), eq(maintenanceOrders.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order) throw new Error("Maintenance order not found");
      if (order.status !== "in_progress") {
        throw new Error("Only in-progress maintenance orders can be completed");
      }
      const assetRows = await tx
        .select({ id: assets.id, costCenterId: assets.costCenterId })
        .from(assets)
        .where(and(eq(assets.id, order.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1);
      const asset = assetRows[0];
      if (!asset) throw new Error("Asset not found");

      const partsCost = values.partsCost ?? order.partsCost;
      const laborCost = values.laborCost ?? order.laborCost;
      const totalCents = toCents(partsCost) + toCents(laborCost);
      const paymentMethod = values.paymentMethod ?? order.paymentMethod;
      if (totalCents > 0 && paymentMethod === "none") {
        throw new Error("Select how the maintenance cost was paid");
      }

      let journal: { entryId: string; entryNo: string } | null = null;
      if (totalCents > 0) {
        journal = await postJournal(tx, {
          facilityId: values.facilityId,
          entryDate: new Date().toISOString().slice(0, 10),
          description: `Maintenance ${order.orderNo}`,
          lines: [
            {
              systemRole: "maintenance_expense",
              debit: fromCents(totalCents),
              costCenterId: asset.costCenterId,
              description: `Parts and labour for ${order.orderNo}`,
            },
            {
              systemRole: paymentSystemRole(paymentMethod),
              credit: fromCents(totalCents),
              description: "Maintenance settlement",
            },
          ],
          sourceType: "maintenance",
          sourceId: order.id,
          userId,
          ip: values.actor.ip,
          deviceId: values.actor.deviceId,
        });
      }

      await tx
        .update(maintenanceOrders)
        .set({
          status: "completed",
          completedAt: new Date(),
          partsCost,
          laborCost,
          totalCost: fromCents(totalCents),
          paymentMethod,
          journalEntryId: journal?.entryId ?? null,
          updatedAt: new Date(),
          version: sql`${maintenanceOrders.version} + 1`,
        })
        .where(eq(maintenanceOrders.id, order.id));
      await tx
        .update(assets)
        .set({
          status: "in_service",
          updatedAt: new Date(),
          version: sql`${assets.version} + 1`,
        })
        .where(and(eq(assets.id, order.assetId), eq(assets.status, "maintenance")));
      await tx.insert(maintenanceEvents).values({
        id: newId(),
        facilityId: values.facilityId,
        assetId: order.assetId,
        orderId: order.id,
        eventType: "completed",
        description: values.note?.trim() || "Maintenance work completed",
        cost: fromCents(totalCents),
        performedBy: userId,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.maintenance.complete",
        entity: "maintenance_orders",
        entityId: order.id,
        details: {
          orderNo: order.orderNo,
          totalCost: fromCents(totalCents),
          entryNo: journal?.entryNo ?? null,
        },
        eventType: "asset.maintenance.completed",
        event: { orderId: order.id, assetId: order.assetId },
      });

      return {
        orderId: order.id,
        entryId: journal?.entryId ?? null,
        entryNo: journal?.entryNo ?? null,
        totalCost: fromCents(totalCents),
      };
    },
    options,
  );
}

export const addMaintenanceNoteSchema = z.object({
  ...baseSchema,
  orderId: z.uuid(),
  description: z.string().trim().min(1).max(2000),
});

export type AddMaintenanceNoteInput = z.input<typeof addMaintenanceNoteSchema>;

export async function addMaintenanceNote(
  input: AddMaintenanceNoteInput,
  options: CommandOptions = {},
): Promise<{ eventId: string }> {
  const values = addMaintenanceNoteSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "addMaintenanceNote",
    async (tx) => {
      const rows = await tx
        .select()
        .from(maintenanceOrders)
        .where(
          and(eq(maintenanceOrders.id, values.orderId), eq(maintenanceOrders.facilityId, values.facilityId)),
        )
        .limit(1);
      const order = rows[0];
      if (!order) throw new Error("Maintenance order not found");

      const eventId = newId();
      await tx.insert(maintenanceEvents).values({
        id: eventId,
        facilityId: values.facilityId,
        assetId: order.assetId,
        orderId: order.id,
        eventType: "note",
        description: values.description,
        performedBy: userId,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.maintenance.note",
        entity: "maintenance_events",
        entityId: eventId,
        details: { orderNo: order.orderNo },
        eventType: "asset.maintenance.note_added",
        event: { orderId: order.id, eventId },
      });
      return { eventId };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Valuation                                                           */
/* ------------------------------------------------------------------ */

export const requestAssetValuationSchema = z.object({
  ...baseSchema,
  assetId: z.uuid(),
  kind: z.enum(["revaluation", "impairment"]),
  amount: positiveMoney,
  effectiveFrom: isoDate,
  reason: z.string().trim().min(1).max(2000),
});

export type RequestAssetValuationInput = z.input<typeof requestAssetValuationSchema>;

export async function requestAssetValuation(
  input: RequestAssetValuationInput,
  options: CommandOptions = {},
): Promise<{ valuationId: string; valuationNo: string; carryingAfter: string }> {
  const values = requestAssetValuationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestAssetValuation",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const rows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, values.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const asset = rows[0];
      if (!asset) throw new Error("Asset not found");
      if (asset.status === "disposed" || asset.status === "written_off") {
        throw new Error("A retired asset cannot be revalued");
      }

      const amountCents = toCents(values.amount);
      const carryingCents = toCents(asset.carryingAmount);
      const afterCents =
        values.kind === "revaluation" ? carryingCents + amountCents : carryingCents - amountCents;
      if (afterCents < 0) throw new Error("Impairment cannot exceed the carrying amount");

      const valuationNo = await nextFormattedNumber(tx, facility, "assetValuation");
      const valuationId = newId();
      await tx.insert(assetValuations).values({
        id: valuationId,
        facilityId: values.facilityId,
        assetId: asset.id,
        valuationNo,
        kind: values.kind,
        amount: values.amount,
        carryingBefore: asset.carryingAmount,
        carryingAfter: fromCents(afterCents),
        effectiveFrom: values.effectiveFrom,
        reason: values.reason,
        status: "requested",
        requestedBy: userId,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.valuation.request",
        entity: "asset_valuations",
        entityId: valuationId,
        details: { valuationNo, kind: values.kind, amount: values.amount },
        eventType: "asset.valuation.requested",
        event: { valuationId, valuationNo, assetId: asset.id },
      });

      return { valuationId, valuationNo, carryingAfter: fromCents(afterCents) };
    },
    options,
  );
}

export const approveAssetValuationSchema = z.object({
  ...baseSchema,
  valuationId: z.uuid(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type ApproveAssetValuationInput = z.input<typeof approveAssetValuationSchema>;

export async function approveAssetValuation(
  input: ApproveAssetValuationInput,
  options: CommandOptions = {},
): Promise<{ valuationId: string; status: "approved"; approvalRole: string | null }> {
  const values = approveAssetValuationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approveAssetValuation",
    async (tx) => {
      const rows = await tx
        .select()
        .from(assetValuations)
        .where(
          and(eq(assetValuations.id, values.valuationId), eq(assetValuations.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const valuation = rows[0];
      if (!valuation) throw new Error("Asset valuation not found");
      if (valuation.status !== "requested") {
        throw new Error("Only requested valuations can be approved");
      }
      assertDifferentActor("approve their own valuation", userId, valuation.requestedBy);

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approveAssetValuation",
        toCents(valuation.amount),
      );

      await tx
        .update(assetValuations)
        .set({
          status: "approved",
          approvedBy: userId,
          updatedAt: new Date(),
          version: sql`${assetValuations.version} + 1`,
        })
        .where(eq(assetValuations.id, valuation.id));
      await tx.insert(assetApprovals).values({
        id: newId(),
        facilityId: values.facilityId,
        subjectType: "valuation",
        subjectId: valuation.id,
        decision: "approved",
        actorId: userId,
        role: approval?.role ?? "asset_manager",
        maxAmount: approval?.maxAmount ?? "0.00",
        reason: values.reason ?? null,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.valuation.approve",
        entity: "asset_valuations",
        entityId: valuation.id,
        details: { valuationNo: valuation.valuationNo, role: approval?.role ?? null },
        eventType: "asset.valuation.approved",
        event: { valuationId: valuation.id, valuationNo: valuation.valuationNo },
      });

      return {
        valuationId: valuation.id,
        status: "approved" as const,
        approvalRole: approval?.role ?? null,
      };
    },
    options,
  );
}

export const postAssetValuationSchema = z.object({
  ...baseSchema,
  valuationId: z.uuid(),
});

export type PostAssetValuationInput = z.input<typeof postAssetValuationSchema>;

export async function postAssetValuation(
  input: PostAssetValuationInput,
  options: CommandOptions = {},
): Promise<{ valuationId: string; entryId: string; entryNo: string }> {
  const values = postAssetValuationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "postAssetValuation",
    async (tx) => {
      const rows = await tx
        .select()
        .from(assetValuations)
        .where(
          and(eq(assetValuations.id, values.valuationId), eq(assetValuations.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const valuation = rows[0];
      if (!valuation) throw new Error("Asset valuation not found");
      if (valuation.status !== "approved") {
        throw new Error("Only approved valuations can be posted");
      }
      const assetRows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, valuation.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const asset = assetRows[0];
      if (!asset) throw new Error("Asset not found");

      const amount = valuation.amount;
      const lines =
        valuation.kind === "revaluation"
          ? [
              {
                systemRole: "fixed_asset",
                debit: amount,
                description: `Revaluation of ${asset.assetNo}`,
              },
              {
                systemRole: "revaluation_reserve",
                credit: amount,
                description: "Revaluation reserve",
              },
            ]
          : [
              {
                systemRole: "impairment_expense",
                debit: amount,
                description: `Impairment of ${asset.assetNo}`,
              },
              {
                systemRole: "accumulated_depreciation",
                credit: amount,
                description: "Impairment allowance",
              },
            ];

      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: valuation.effectiveFrom,
        description: `${valuation.kind === "revaluation" ? "Revaluation" : "Impairment"} ${valuation.valuationNo}`,
        lines,
        sourceType: "asset_valuation",
        sourceId: valuation.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      const increment =
        valuation.kind === "revaluation"
          ? { acquisitionCost: sql`${assets.acquisitionCost} + ${amount}` }
          : { accumulatedDepreciation: sql`${assets.accumulatedDepreciation} + ${amount}` };
      await tx
        .update(assets)
        .set({
          ...increment,
          carryingAmount: valuation.carryingAfter,
          updatedAt: new Date(),
          version: sql`${assets.version} + 1`,
        })
        .where(eq(assets.id, asset.id));
      await tx
        .update(assetValuations)
        .set({
          status: "posted",
          postedBy: userId,
          journalEntryId: journal.entryId,
          updatedAt: new Date(),
          version: sql`${assetValuations.version} + 1`,
        })
        .where(eq(assetValuations.id, valuation.id));

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.valuation.post",
        entity: "asset_valuations",
        entityId: valuation.id,
        details: {
          valuationNo: valuation.valuationNo,
          kind: valuation.kind,
          entryNo: journal.entryNo,
        },
        eventType: "asset.valuation.posted",
        event: { valuationId: valuation.id, valuationNo: valuation.valuationNo },
      });

      return { valuationId: valuation.id, entryId: journal.entryId, entryNo: journal.entryNo };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Disposal                                                            */
/* ------------------------------------------------------------------ */

export const requestAssetDisposalSchema = z.object({
  ...baseSchema,
  assetId: z.uuid(),
  method: z.string().trim().min(1).max(32),
  disposalDate: isoDate,
  proceeds: nonnegativeMoney.optional(),
  proceedsMethod: z.enum(["none", "cash", "bank", "accrued"]).default("cash"),
  reason: z.string().trim().min(1).max(2000),
});

export type RequestAssetDisposalInput = z.input<typeof requestAssetDisposalSchema>;

export async function requestAssetDisposal(
  input: RequestAssetDisposalInput,
  options: CommandOptions = {},
): Promise<{ disposalId: string; disposalNo: string; gainLoss: string }> {
  const values = requestAssetDisposalSchema.parse(input);
  const userId = actorId(values);
  const proceeds = values.proceeds ?? "0.00";
  if (toCents(proceeds) > 0 && values.proceedsMethod === "none") {
    throw new Error("Select how the disposal proceeds were received");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestAssetDisposal",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const rows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, values.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const asset = rows[0];
      if (!asset) throw new Error("Asset not found");
      if (asset.status === "disposed" || asset.status === "written_off") {
        throw new Error("This asset has already been retired");
      }

      const pending = await tx
        .select({ id: assetDisposals.id })
        .from(assetDisposals)
        .where(
          and(
            eq(assetDisposals.facilityId, values.facilityId),
            eq(assetDisposals.assetId, asset.id),
            inArray(assetDisposals.status, ["requested", "approved"]),
          ),
        )
        .limit(1);
      if (pending.length > 0) throw new Error("This asset already has a pending disposal");

      const disposalNo = await nextFormattedNumber(tx, facility, "assetDisposal");
      const disposalId = newId();
      const gainLossCents = toCents(proceeds) - toCents(asset.carryingAmount);
      await tx.insert(assetDisposals).values({
        id: disposalId,
        facilityId: values.facilityId,
        assetId: asset.id,
        disposalNo,
        method: values.method,
        disposalDate: values.disposalDate,
        proceeds,
        proceedsMethod: values.proceedsMethod,
        carryingAmount: asset.carryingAmount,
        gainLoss: fromCents(gainLossCents),
        reason: values.reason,
        status: "requested",
        requestedBy: userId,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.disposal.request",
        entity: "asset_disposals",
        entityId: disposalId,
        details: { disposalNo, proceeds, carryingAmount: asset.carryingAmount },
        eventType: "asset.disposal.requested",
        event: { disposalId, disposalNo, assetId: asset.id },
      });

      return { disposalId, disposalNo, gainLoss: fromCents(gainLossCents) };
    },
    options,
  );
}

export const approveAssetDisposalSchema = z.object({
  ...baseSchema,
  disposalId: z.uuid(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type ApproveAssetDisposalInput = z.input<typeof approveAssetDisposalSchema>;

export async function approveAssetDisposal(
  input: ApproveAssetDisposalInput,
  options: CommandOptions = {},
): Promise<{ disposalId: string; status: "approved"; approvalRole: string | null }> {
  const values = approveAssetDisposalSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approveAssetDisposal",
    async (tx) => {
      const rows = await tx
        .select()
        .from(assetDisposals)
        .where(
          and(eq(assetDisposals.id, values.disposalId), eq(assetDisposals.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const disposal = rows[0];
      if (!disposal) throw new Error("Asset disposal not found");
      if (disposal.status !== "requested") {
        throw new Error("Only requested disposals can be approved");
      }
      assertDifferentActor("approve their own disposal", userId, disposal.requestedBy);

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approveAssetDisposal",
        toCents(disposal.carryingAmount),
      );

      await tx
        .update(assetDisposals)
        .set({
          status: "approved",
          approvedBy: userId,
          updatedAt: new Date(),
          version: sql`${assetDisposals.version} + 1`,
        })
        .where(eq(assetDisposals.id, disposal.id));
      await tx.insert(assetApprovals).values({
        id: newId(),
        facilityId: values.facilityId,
        subjectType: "disposal",
        subjectId: disposal.id,
        decision: "approved",
        actorId: userId,
        role: approval?.role ?? "asset_manager",
        maxAmount: approval?.maxAmount ?? "0.00",
        reason: values.reason ?? null,
        createdBy: userId,
      });

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.disposal.approve",
        entity: "asset_disposals",
        entityId: disposal.id,
        details: { disposalNo: disposal.disposalNo, role: approval?.role ?? null },
        eventType: "asset.disposal.approved",
        event: { disposalId: disposal.id, disposalNo: disposal.disposalNo },
      });

      return {
        disposalId: disposal.id,
        status: "approved" as const,
        approvalRole: approval?.role ?? null,
      };
    },
    options,
  );
}

export const completeAssetDisposalSchema = z.object({
  ...baseSchema,
  disposalId: z.uuid(),
});

export type CompleteAssetDisposalInput = z.input<typeof completeAssetDisposalSchema>;

export async function completeAssetDisposal(
  input: CompleteAssetDisposalInput,
  options: CommandOptions = {},
): Promise<{ disposalId: string; entryId: string; entryNo: string; gainLoss: string }> {
  const values = completeAssetDisposalSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "completeAssetDisposal",
    async (tx) => {
      const rows = await tx
        .select()
        .from(assetDisposals)
        .where(
          and(eq(assetDisposals.id, values.disposalId), eq(assetDisposals.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const disposal = rows[0];
      if (!disposal) throw new Error("Asset disposal not found");
      if (disposal.status !== "approved") {
        throw new Error("Only approved disposals can be completed");
      }
      const assetRows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, disposal.assetId), eq(assets.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const asset = assetRows[0];
      if (!asset) throw new Error("Asset not found");

      const costCents = toCents(asset.acquisitionCost);
      const accumulatedCents = toCents(asset.accumulatedDepreciation);
      const proceedsCents = toCents(disposal.proceeds);
      const debitCents = accumulatedCents + proceedsCents;
      const creditCents = costCents;

      const lines: Array<{
        systemRole: string;
        debit?: string;
        credit?: string;
        description?: string;
      }> = [];
      if (accumulatedCents > 0) {
        lines.push({
          systemRole: "accumulated_depreciation",
          debit: fromCents(accumulatedCents),
          description: "Remove accumulated depreciation",
        });
      }
      if (proceedsCents > 0) {
        lines.push({
          systemRole: approvalSystemRole(disposal.proceedsMethod),
          debit: fromCents(proceedsCents),
          description: "Disposal proceeds",
        });
      }
      if (costCents > 0) {
        lines.push({
          systemRole: "fixed_asset",
          credit: fromCents(costCents),
          description: "Remove fixed asset cost",
        });
      }
      if (debitCents > creditCents) {
        lines.push({
          systemRole: "disposal_gain",
          credit: fromCents(debitCents - creditCents),
          description: "Gain on disposal",
        });
      }
      if (creditCents > debitCents) {
        lines.push({
          systemRole: "disposal_loss",
          debit: fromCents(creditCents - debitCents),
          description: "Loss on disposal",
        });
      }

      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: disposal.disposalDate,
        description: `Disposal ${disposal.disposalNo} — ${asset.assetNo}`,
        lines,
        sourceType: "asset_disposal",
        sourceId: disposal.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      await tx
        .update(assetDisposals)
        .set({
          status: "completed",
          completedBy: userId,
          journalEntryId: journal.entryId,
          updatedAt: new Date(),
          version: sql`${assetDisposals.version} + 1`,
        })
        .where(eq(assetDisposals.id, disposal.id));
      await tx
        .update(assets)
        .set({
          status: "disposed",
          carryingAmount: "0.00",
          updatedAt: new Date(),
          version: sql`${assets.version} + 1`,
        })
        .where(eq(assets.id, asset.id));

      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "asset.disposal.complete",
        entity: "asset_disposals",
        entityId: disposal.id,
        details: {
          disposalNo: disposal.disposalNo,
          entryNo: journal.entryNo,
          gainLoss: disposal.gainLoss,
        },
        eventType: "asset.disposal.completed",
        event: { disposalId: disposal.id, disposalNo: disposal.disposalNo, assetId: asset.id },
      });

      return {
        disposalId: disposal.id,
        entryId: journal.entryId,
        entryNo: journal.entryNo,
        gainLoss: disposal.gainLoss,
      };
    },
    options,
  );
}
