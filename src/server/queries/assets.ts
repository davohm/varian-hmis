import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
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
  journalEntries,
  maintenanceEvents,
  maintenanceOrders,
} from "@/server/db/schema";

export type AssetDatabase = typeof db;

export interface AssetOverview {
  totalAssets: number;
  inService: number;
  underMaintenance: number;
  disposed: number;
  netBookValue: string;
  openMaintenanceOrders: number;
  pendingApprovals: number;
}

export async function getAssetOverview(
  database: AssetDatabase,
  facilityId: string,
): Promise<AssetOverview> {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::int FROM assets WHERE facility_id = ${facilityId}::uuid) AS total_assets,
      (SELECT count(*)::int FROM assets
        WHERE facility_id = ${facilityId}::uuid AND status = 'in_service') AS in_service,
      (SELECT count(*)::int FROM assets
        WHERE facility_id = ${facilityId}::uuid AND status = 'maintenance') AS under_maintenance,
      (SELECT count(*)::int FROM assets
        WHERE facility_id = ${facilityId}::uuid AND status = 'disposed') AS disposed,
      (SELECT coalesce(sum(carrying_amount), '0') FROM assets
        WHERE facility_id = ${facilityId}::uuid
          AND status NOT IN ('disposed', 'written_off')) AS net_book_value,
      (SELECT count(*)::int FROM maintenance_orders
        WHERE facility_id = ${facilityId}::uuid AND status IN ('open', 'in_progress')) AS open_orders,
      (
        (SELECT count(*)::int FROM depreciation_runs
          WHERE facility_id = ${facilityId}::uuid AND status = 'draft')
        + (SELECT count(*)::int FROM asset_valuations
          WHERE facility_id = ${facilityId}::uuid AND status = 'requested')
        + (SELECT count(*)::int FROM asset_disposals
          WHERE facility_id = ${facilityId}::uuid AND status = 'requested')
      ) AS pending_approvals
  `);
  const row = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};
  return {
    totalAssets: Number(row.total_assets ?? 0),
    inService: Number(row.in_service ?? 0),
    underMaintenance: Number(row.under_maintenance ?? 0),
    disposed: Number(row.disposed ?? 0),
    netBookValue: String(row.net_book_value ?? "0.00"),
    openMaintenanceOrders: Number(row.open_orders ?? 0),
    pendingApprovals: Number(row.pending_approvals ?? 0),
  };
}

export interface AssetRow {
  id: string;
  assetNo: string;
  category: string;
  name: string;
  tagNo: string | null;
  serialNo: string | null;
  location: string;
  custodianName: string | null;
  departmentName: string | null;
  costCenterName: string | null;
  acquisitionDate: string;
  acquisitionCost: string;
  accumulatedDepreciation: string;
  carryingAmount: string;
  status: string;
  lastDepreciationDate: string | null;
  createdAt: string;
}

export async function listAssets(
  database: AssetDatabase,
  facilityId: string,
): Promise<AssetRow[]> {
  const rows = await database
    .select({
      id: assets.id,
      assetNo: assets.assetNo,
      category: assets.category,
      name: assets.name,
      tagNo: assets.tagNo,
      serialNo: assets.serialNo,
      location: assets.location,
      custodianName: assets.custodianName,
      departmentName: departments.name,
      costCenterName: costCenters.name,
      acquisitionDate: assets.acquisitionDate,
      acquisitionCost: assets.acquisitionCost,
      residualValue: assets.residualValue,
      usefulLifeMonths: assets.usefulLifeMonths,
      accumulatedDepreciation: assets.accumulatedDepreciation,
      carryingAmount: assets.carryingAmount,
      status: assets.status,
      lastDepreciationDate: assets.lastDepreciationDate,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .leftJoin(departments, eq(assets.departmentId, departments.id))
    .leftJoin(costCenters, eq(assets.costCenterId, costCenters.id))
    .where(eq(assets.facilityId, facilityId))
    .orderBy(asc(assets.assetNo))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export interface AssetAssignmentRow {
  id: string;
  eventType: string;
  fromLocation: string | null;
  toLocation: string;
  custodianName: string | null;
  performedBy: string;
  occurredAt: string;
  note: string | null;
}

export interface AssetMaintenanceOrderRow {
  id: string;
  orderNo: string;
  type: string;
  priority: string;
  status: string;
  scheduledDate: string | null;
  assetName: string;
  description: string;
  totalCost: string;
  entryNo: string | null;
  createdAt: string;
}

export async function listMaintenanceOrders(
  database: AssetDatabase,
  facilityId: string,
  assetId?: string,
): Promise<AssetMaintenanceOrderRow[]> {
  const rows = await database
    .select({
      id: maintenanceOrders.id,
      orderNo: maintenanceOrders.orderNo,
      type: maintenanceOrders.type,
      priority: maintenanceOrders.priority,
      status: maintenanceOrders.status,
      scheduledDate: maintenanceOrders.scheduledDate,
      assetName: assets.name,
      description: maintenanceOrders.description,
      totalCost: maintenanceOrders.totalCost,
      entryNo: journalEntries.entryNo,
      createdAt: maintenanceOrders.createdAt,
    })
    .from(maintenanceOrders)
    .innerJoin(assets, eq(maintenanceOrders.assetId, assets.id))
    .leftJoin(journalEntries, eq(maintenanceOrders.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(maintenanceOrders.facilityId, facilityId),
        assetId ? eq(maintenanceOrders.assetId, assetId) : undefined,
      ),
    )
    .orderBy(desc(maintenanceOrders.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export interface AssetDetail extends AssetRow {
  assignments: AssetAssignmentRow[];
  maintenanceOrders: AssetMaintenanceOrderRow[];
  maintenanceEvents: Array<{
    id: string;
    eventType: string;
    description: string;
    cost: string;
    occurredAt: string;
  }>;
  valuations: AssetValuationRow[];
  disposals: AssetDisposalRow[];
}

export async function getAssetDetail(
  database: AssetDatabase,
  facilityId: string,
  assetId: string,
): Promise<AssetDetail | null> {
  const asset = (await listAssets(database, facilityId)).find((row) => row.id === assetId);
  if (!asset) return null;

  const [assignments, events, valuations, disposals, orders] = await Promise.all([
    database
      .select({
        id: assetAssignments.id,
        eventType: assetAssignments.eventType,
        fromLocation: assetAssignments.fromLocation,
        toLocation: assetAssignments.toLocation,
        custodianName: employees.firstName,
        custodianLastName: employees.lastName,
        performedBy: assetAssignments.performedBy,
        occurredAt: assetAssignments.occurredAt,
        note: assetAssignments.note,
      })
      .from(assetAssignments)
      .leftJoin(employees, eq(assetAssignments.toEmployeeId, employees.id))
      .where(and(eq(assetAssignments.facilityId, facilityId), eq(assetAssignments.assetId, assetId)))
      .orderBy(asc(assetAssignments.occurredAt)),
    database
      .select({
        id: maintenanceEvents.id,
        eventType: maintenanceEvents.eventType,
        description: maintenanceEvents.description,
        cost: maintenanceEvents.cost,
        occurredAt: maintenanceEvents.occurredAt,
      })
      .from(maintenanceEvents)
      .where(and(eq(maintenanceEvents.facilityId, facilityId), eq(maintenanceEvents.assetId, assetId)))
      .orderBy(asc(maintenanceEvents.occurredAt)),
    database
      .select({
        id: assetValuations.id,
        assetId: assetValuations.assetId,
        valuationNo: assetValuations.valuationNo,
        assetNo: assets.assetNo,
        kind: assetValuations.kind,
        amount: assetValuations.amount,
        carryingBefore: assetValuations.carryingBefore,
        carryingAfter: assetValuations.carryingAfter,
        status: assetValuations.status,
        requestedBy: assetValuations.requestedBy,
        approvedBy: assetValuations.approvedBy,
        entryNo: journalEntries.entryNo,
        effectiveFrom: assetValuations.effectiveFrom,
        createdAt: assetValuations.createdAt,
      })
      .from(assetValuations)
      .innerJoin(assets, eq(assetValuations.assetId, assets.id))
      .leftJoin(journalEntries, eq(assetValuations.journalEntryId, journalEntries.id))
      .where(and(eq(assetValuations.facilityId, facilityId), eq(assetValuations.assetId, assetId)))
      .orderBy(desc(assetValuations.createdAt)),
    database
      .select({
        id: assetDisposals.id,
        assetId: assetDisposals.assetId,
        disposalNo: assetDisposals.disposalNo,
        assetNo: assets.assetNo,
        method: assetDisposals.method,
        disposalDate: assetDisposals.disposalDate,
        proceeds: assetDisposals.proceeds,
        carryingAmount: assetDisposals.carryingAmount,
        gainLoss: assetDisposals.gainLoss,
        status: assetDisposals.status,
        requestedBy: assetDisposals.requestedBy,
        approvedBy: assetDisposals.approvedBy,
        entryNo: journalEntries.entryNo,
        createdAt: assetDisposals.createdAt,
      })
      .from(assetDisposals)
      .innerJoin(assets, eq(assetDisposals.assetId, assets.id))
      .leftJoin(journalEntries, eq(assetDisposals.journalEntryId, journalEntries.id))
      .where(and(eq(assetDisposals.facilityId, facilityId), eq(assetDisposals.assetId, assetId)))
      .orderBy(desc(assetDisposals.createdAt)),
    listMaintenanceOrders(database, facilityId, assetId),
  ]);

  return {
    ...asset,
    assignments: assignments.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      fromLocation: row.fromLocation,
      toLocation: row.toLocation,
      custodianName:
        row.custodianName || row.custodianLastName
          ? `${row.custodianName ?? ""} ${row.custodianLastName ?? ""}`.trim()
          : null,
      performedBy: row.performedBy,
      occurredAt: row.occurredAt.toISOString(),
      note: row.note,
    })),
    maintenanceOrders: orders,
    maintenanceEvents: events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    })),
    valuations: valuations.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    disposals: disposals.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export interface DepreciationRunRow {
  id: string;
  runNo: string;
  period: string;
  description: string | null;
  status: string;
  totalAmount: string;
  assetCount: number;
  entryNo: string | null;
  preparedBy: string;
  approvedBy: string | null;
  postedBy: string | null;
  createdAt: string;
}

export async function listDepreciationRuns(
  database: AssetDatabase,
  facilityId: string,
): Promise<DepreciationRunRow[]> {
  const rows = await database
    .select({
      id: depreciationRuns.id,
      runNo: depreciationRuns.runNo,
      period: depreciationRuns.period,
      description: depreciationRuns.description,
      status: depreciationRuns.status,
      totalAmount: depreciationRuns.totalAmount,
      assetCount: depreciationRuns.assetCount,
      entryNo: journalEntries.entryNo,
      preparedBy: depreciationRuns.preparedBy,
      approvedBy: depreciationRuns.approvedBy,
      postedBy: depreciationRuns.postedBy,
      createdAt: depreciationRuns.createdAt,
    })
    .from(depreciationRuns)
    .leftJoin(journalEntries, eq(depreciationRuns.journalEntryId, journalEntries.id))
    .where(eq(depreciationRuns.facilityId, facilityId))
    .orderBy(desc(depreciationRuns.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export interface DepreciationEntryRow {
  id: string;
  assetNo: string | null;
  assetName: string | null;
  openingCarryingAmount: string;
  depreciationAmount: string;
  closingCarryingAmount: string;
  costCenterName: string | null;
}

export interface DepreciationRunDetail extends DepreciationRunRow {
  entries: DepreciationEntryRow[];
  approvals: Array<{
    id: string;
    decision: string;
    actorId: string;
    role: string;
    maxAmount: string;
    decidedAt: string;
  }>;
}

export async function getDepreciationRun(
  database: AssetDatabase,
  facilityId: string,
  runId: string,
): Promise<DepreciationRunDetail | null> {
  const run = (await listDepreciationRuns(database, facilityId)).find((row) => row.id === runId);
  if (!run) return null;

  const [entries, approvals] = await Promise.all([
    database
      .select({
        id: depreciationEntries.id,
        assetNo: assets.assetNo,
        assetName: assets.name,
        openingCarryingAmount: depreciationEntries.openingCarryingAmount,
        depreciationAmount: depreciationEntries.depreciationAmount,
        closingCarryingAmount: depreciationEntries.closingCarryingAmount,
        costCenterName: costCenters.name,
      })
      .from(depreciationEntries)
      .innerJoin(assets, eq(depreciationEntries.assetId, assets.id))
      .leftJoin(costCenters, eq(depreciationEntries.costCenterId, costCenters.id))
      .where(
        and(eq(depreciationEntries.facilityId, facilityId), eq(depreciationEntries.runId, runId)),
      )
      .orderBy(asc(assets.assetNo)),
    database
      .select({
        id: depreciationRunApprovals.id,
        decision: depreciationRunApprovals.decision,
        actorId: depreciationRunApprovals.actorId,
        role: depreciationRunApprovals.role,
        maxAmount: depreciationRunApprovals.maxAmount,
        decidedAt: depreciationRunApprovals.decidedAt,
      })
      .from(depreciationRunApprovals)
      .where(
        and(
          eq(depreciationRunApprovals.facilityId, facilityId),
          eq(depreciationRunApprovals.runId, runId),
        ),
      )
      .orderBy(asc(depreciationRunApprovals.decidedAt)),
  ]);

  return {
    ...run,
    entries,
    approvals: approvals.map((row) => ({ ...row, decidedAt: row.decidedAt.toISOString() })),
  };
}

export interface AssetValuationRow {
  id: string;
  assetId: string;
  valuationNo: string;
  assetNo: string;
  kind: string;
  amount: string;
  carryingBefore: string;
  carryingAfter: string;
  status: string;
  entryNo: string | null;
  effectiveFrom: string;
  createdAt: string;
}

export interface AssetDisposalRow {
  id: string;
  assetId: string;
  disposalNo: string;
  assetNo: string;
  method: string;
  disposalDate: string;
  proceeds: string;
  carryingAmount: string;
  gainLoss: string;
  status: string;
  entryNo: string | null;
  createdAt: string;
}

export async function listAssetValuations(
  database: AssetDatabase,
  facilityId: string,
): Promise<AssetValuationRow[]> {
  const rows = await database
    .select({
      id: assetValuations.id,
      assetId: assetValuations.assetId,
      valuationNo: assetValuations.valuationNo,
      assetNo: assets.assetNo,
      kind: assetValuations.kind,
      amount: assetValuations.amount,
      carryingBefore: assetValuations.carryingBefore,
      carryingAfter: assetValuations.carryingAfter,
      status: assetValuations.status,
      entryNo: journalEntries.entryNo,
      effectiveFrom: assetValuations.effectiveFrom,
      createdAt: assetValuations.createdAt,
    })
    .from(assetValuations)
    .innerJoin(assets, eq(assetValuations.assetId, assets.id))
    .leftJoin(journalEntries, eq(assetValuations.journalEntryId, journalEntries.id))
    .where(eq(assetValuations.facilityId, facilityId))
    .orderBy(desc(assetValuations.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function listAssetDisposals(
  database: AssetDatabase,
  facilityId: string,
): Promise<AssetDisposalRow[]> {
  const rows = await database
    .select({
      id: assetDisposals.id,
      assetId: assetDisposals.assetId,
      disposalNo: assetDisposals.disposalNo,
      assetNo: assets.assetNo,
      method: assetDisposals.method,
      disposalDate: assetDisposals.disposalDate,
      proceeds: assetDisposals.proceeds,
      carryingAmount: assetDisposals.carryingAmount,
      gainLoss: assetDisposals.gainLoss,
      status: assetDisposals.status,
      entryNo: journalEntries.entryNo,
      createdAt: assetDisposals.createdAt,
    })
    .from(assetDisposals)
    .innerJoin(assets, eq(assetDisposals.assetId, assets.id))
    .leftJoin(journalEntries, eq(assetDisposals.journalEntryId, journalEntries.id))
    .where(eq(assetDisposals.facilityId, facilityId))
    .orderBy(desc(assetDisposals.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function listAssetEmployees(
  database: AssetDatabase,
  facilityId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await database
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(eq(employees.facilityId, facilityId))
    .orderBy(asc(employees.employeeNo))
    .limit(500);
  return rows.map((row) => ({
    id: row.id,
    name: `${row.firstName} ${row.lastName}`.trim(),
  }));
}

export async function listAssetCostCenters(
  database: AssetDatabase,
  facilityId: string,
): Promise<Array<{ id: string; code: string; name: string }>> {
  return database
    .select({ id: costCenters.id, code: costCenters.code, name: costCenters.name })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.active, true)))
    .orderBy(asc(costCenters.code));
}

export async function listAssetDepartments(
  database: AssetDatabase,
  facilityId: string,
): Promise<Array<{ id: string; name: string }>> {
  return database
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(eq(departments.facilityId, facilityId))
    .orderBy(asc(departments.name));
}
