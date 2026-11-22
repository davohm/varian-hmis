import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CHART_OF_ACCOUNTS, normalBalanceFor } from "../src/lib/finance";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { createCostCenter, setFinanceApprovalLimit } from "../src/server/commands/finance";
import {
  addMaintenanceNote,
  approveAssetDisposal,
  approveAssetValuation,
  approveDepreciationRun,
  assignAsset,
  completeAssetDisposal,
  completeMaintenanceOrder,
  createAsset,
  createDepreciationRun,
  createMaintenanceOrder,
  postAssetValuation,
  postDepreciationRun,
  requestAssetDisposal,
  requestAssetValuation,
  startMaintenanceOrder,
  type CreateAssetInput,
} from "../src/server/commands/assets";
import {
  assetApprovals,
  assetAssignments,
  assets,
  auditLog,
  employees,
  journalLines,
  ledgerAccounts,
  staffRoleScopes,
  syncOutbox,
  user,
} from "../src/server/db/schema";
import {
  getAssetDetail,
  getDepreciationRun,
} from "../src/server/queries/assets";
import {
  cleanupTestFacility,
  createTestDatabase,
  insertTestActor,
  insertTestBranch,
  insertTestFacility,
  type TestDatabase,
} from "./helpers";

let ctx: TestDatabase;

beforeAll(() => {
  ctx = createTestDatabase();
});

afterAll(async () => {
  await ctx.pool.end();
});

interface Actor {
  userId: string;
  deviceId: string;
  ip: string;
}

interface AssetFixture {
  facility: { id: string; code: string };
  branchId: string;
  costCenterId: string;
  employeeId: string;
  admin: Actor;
  preparer: Actor;
  approver: Actor;
}

function actorOf(userId: string, label: string): Actor {
  return { userId, deviceId: `assets-${label}`, ip: "127.0.0.1" };
}

async function insertRoleActor(
  facilityId: string,
  role: "admin" | "asset_manager",
  label: string,
): Promise<Actor> {
  const userId = await insertTestActor(ctx.db);
  if (role !== "admin") {
    await ctx.db.update(user).set({ role: "user" }).where(eq(user.id, userId));
  }
  await ctx.db.insert(staffRoleScopes).values({ userId, role, facilityId });
  return actorOf(userId, label);
}

async function withFixture<T>(run: (fixture: AssetFixture) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  try {
    const branchId = await insertTestBranch(ctx.db, facility.id);
    const admin = await insertRoleActor(facility.id, "admin", "admin");
    const preparer = await insertRoleActor(facility.id, "asset_manager", "preparer");
    const approver = await insertRoleActor(facility.id, "asset_manager", "approver");

    // Seed the chart directly: these are accounting fixtures, not commands
    // under test, and one insert keeps the suite from competing for the DB.
    await ctx.db.insert(ledgerAccounts).values(
      DEFAULT_CHART_OF_ACCOUNTS.map((account) => ({
        id: newId(),
        facilityId: facility.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: normalBalanceFor(account.type),
        systemRole: account.systemRole,
        createdBy: admin.userId,
      })),
    );

    const costCenter = await createCostCenter(
      {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: admin,
        code: "GEN",
        name: "General",
        branchId,
      },
      { database: ctx.db },
    );

    const employeeId = newId();
    await ctx.db.insert(employees).values({
      id: employeeId,
      facilityId: facility.id,
      employeeNo: `EMP-${newId().slice(0, 8)}`.toUpperCase(),
      firstName: "Custodian",
      lastName: "Test",
      createdBy: "vitest-assets",
    });

    return await run({
      facility,
      branchId,
      costCenterId: costCenter.costCenterId,
      employeeId,
      admin,
      preparer,
      approver,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

function assetInput(
  fixture: AssetFixture,
  label: string,
  overrides: Partial<CreateAssetInput> = {},
): CreateAssetInput {
  return {
    facilityId: fixture.facility.id,
    idempotencyKey: newIdempotencyKey(),
    actor: fixture.preparer,
    category: "Equipment",
    name: label,
    location: "Main store",
    acquisitionDate: "2026-01-01",
    acquisitionCost: "120000.00",
    residualValue: "0.00",
    usefulLifeMonths: 12,
    ...overrides,
  };
}

async function setApprovalLimit(
  fixture: AssetFixture,
  action: "approveDepreciationRun" | "approveAssetValuation" | "approveAssetDisposal",
  maxAmount: string,
): Promise<void> {
  await setFinanceApprovalLimit(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: fixture.admin,
      action,
      role: "asset_manager",
      maxAmount,
    },
    { database: ctx.db },
  );
}

/** Drizzle wraps driver errors, so walk the cause chain for the database message. */
async function expectDatabaseError(promise: PromiseLike<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
    return;
  }
  throw new Error(`Expected database error matching ${pattern.toString()}`);
}

async function journalRoles(entryId: string) {
  const lines = await ctx.db
    .select({
      systemRole: ledgerAccounts.systemRole,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
    .where(eq(journalLines.entryId, entryId));

  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const role = line.systemRole ?? "unmapped";
    const current = totals.get(role) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.debit);
    current.credit += Number(line.credit);
    totals.set(role, current);
  }
  return { totals, debit: Number(lines.reduce((sum, line) => sum + Number(line.debit), 0)), credit: Number(lines.reduce((sum, line) => sum + Number(line.credit), 0)) };
}

describe("assets and maintenance", () => {
  it("creates an asset, mirrors assignment history, and replays idempotently", async () => {
    await withFixture(async (fixture) => {
      const input = assetInput(fixture, "X-ray unit", {
        tagNo: "TAG-001",
        serialNo: "SER-001",
        custodianEmployeeId: fixture.employeeId,
        notes: "Test fixture asset",
      });
      const created = await createAsset(input, { database: ctx.db });
      expect(created.assetNo).toMatch(/^TEST-[A-F0-9]{8}-AST-\d{2}-\d{5}$/);
      expect(created.carryingAmount).toBe("120000.00");

      const replay = await createAsset(input, { database: ctx.db });
      expect(replay).toEqual(created);

      const initial = await getAssetDetail(ctx.db, fixture.facility.id, created.assetId);
      expect(initial).toMatchObject({
        assetNo: created.assetNo,
        category: "Equipment",
        name: "X-ray unit",
        custodianName: "Custodian Test",
        acquisitionCost: "120000.00",
        accumulatedDepreciation: "0.00",
        carryingAmount: "120000.00",
        status: "in_service",
      });
      expect(initial?.assignments).toHaveLength(1);
      expect(initial?.assignments[0]).toMatchObject({
        eventType: "assigned",
        toLocation: "Main store",
        custodianName: "Custodian Test",
        performedBy: fixture.preparer.userId,
      });

      const moved = await assignAsset(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          assetId: created.assetId,
          eventType: "transferred",
          toEmployeeId: null,
          toLocation: "Radiology department",
          note: "Moved after commissioning",
        },
        { database: ctx.db },
      );

      const current = await getAssetDetail(ctx.db, fixture.facility.id, moved.assetId);
      expect(current?.location).toBe("Radiology department");
      expect(current?.custodianName).toBeNull();
      expect(current?.assignments).toHaveLength(2);
      expect(current?.assignments[1]).toMatchObject({
        eventType: "transferred",
        fromLocation: "Main store",
        toLocation: "Radiology department",
        custodianName: null,
        note: "Moved after commissioning",
      });

      const outbox = await ctx.db
        .select()
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.facilityId, fixture.facility.id),
            eq(syncOutbox.tableName, "asset_assignments"),
            eq(syncOutbox.recordId, moved.assignmentId),
          ),
        );
      expect(outbox.length).toBeGreaterThan(0);
    });
  });

  it("enforces depreciation SoD and limits, then posts a balanced journal", async () => {
    await withFixture(async (fixture) => {
      const asset = await createAsset(assetInput(fixture, "Ultrasound machine"), {
        database: ctx.db,
      });
      const run = await createDepreciationRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          period: "2026-01-31",
          assetIds: [asset.assetId],
          description: "January depreciation",
        },
        { database: ctx.db },
      );
      expect(run.runNo).toMatch(/^TEST-[A-F0-9]{8}-DEP-\d{2}-\d{5}$/);
      expect(run).toMatchObject({ assetCount: 1, totalAmount: "10000.00" });

      await expect(
        approveDepreciationRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            runId: run.runId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own depreciation run/i);

      await setApprovalLimit(fixture, "approveDepreciationRun", "5000.00");
      await expect(
        approveDepreciationRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.admin,
            runId: run.runId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/approval limit is configured for your role/i);
      await expect(
        approveDepreciationRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.approver,
            runId: run.runId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds your approval limit/i);

      await setApprovalLimit(fixture, "approveDepreciationRun", "20000.00");
      const approval = await approveDepreciationRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.approver,
          runId: run.runId,
          reason: "Within delegated authority",
        },
        { database: ctx.db },
      );
      expect(approval).toMatchObject({ status: "approved", approvalRole: "asset_manager" });

      const posted = await postDepreciationRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          runId: run.runId,
        },
        { database: ctx.db },
      );
      expect(posted.entryNo).toMatch(/-J-\d{2}-\d{6}$/);
      expect(posted.assetCount).toBe(1);

      const detail = await getDepreciationRun(ctx.db, fixture.facility.id, run.runId);
      expect(detail).toMatchObject({
        status: "posted",
        entryNo: posted.entryNo,
        approvedBy: fixture.approver.userId,
        postedBy: fixture.admin.userId,
      });
      expect(detail?.entries).toHaveLength(1);
      expect(detail?.entries[0]).toMatchObject({
        depreciationAmount: "10000.00",
        openingCarryingAmount: "120000.00",
        closingCarryingAmount: "110000.00",
      });
      expect(detail?.approvals).toHaveLength(1);
      expect(detail?.approvals[0]).toMatchObject({
        actorId: fixture.approver.userId,
        role: "asset_manager",
        maxAmount: "20000.00",
        decision: "approved",
      });

      const current = await getAssetDetail(ctx.db, fixture.facility.id, asset.assetId);
      expect(current).toMatchObject({
        accumulatedDepreciation: "10000.00",
        carryingAmount: "110000.00",
        lastDepreciationDate: "2026-01-31",
      });

      const journal = await journalRoles(posted.entryId);
      expect(journal.totals.get("depreciation_expense")?.debit).toBe(10000);
      expect(journal.totals.get("accumulated_depreciation")?.credit).toBe(10000);
      expect(journal.debit).toBe(journal.credit);
      expect(journal.debit).toBe(10000);

      await expect(
        createDepreciationRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            period: "2026-01-31",
            assetIds: [asset.assetId],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/no asset has depreciation remaining/i);
    });
  });

  it("records maintenance events and posts the completed cost to the ledger", async () => {
    await withFixture(async (fixture) => {
      const asset = await createAsset(
        assetInput(fixture, "Generator", { acquisitionCost: "50000.00" }),
        { database: ctx.db },
      );
      const order = await createMaintenanceOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          assetId: asset.assetId,
          type: "corrective",
          priority: "high",
          scheduledDate: "2026-02-01",
          description: "Replace faulty alternator",
          partsCost: "2000.00",
          laborCost: "3000.00",
          paymentMethod: "none",
        },
        { database: ctx.db },
      );
      expect(order.orderNo).toMatch(/^TEST-[A-F0-9]{8}-MO-\d{2}-\d{5}$/);

      await startMaintenanceOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          orderId: order.orderId,
          note: "Technician on site",
        },
        { database: ctx.db },
      );
      const inMaintenance = await getAssetDetail(ctx.db, fixture.facility.id, asset.assetId);
      expect(inMaintenance?.status).toBe("maintenance");

      await expect(
        completeMaintenanceOrder(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            orderId: order.orderId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/select how the maintenance cost was paid/i);

      await addMaintenanceNote(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          orderId: order.orderId,
          description: "Part fitted and tested",
        },
        { database: ctx.db },
      );

      const completed = await completeMaintenanceOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          orderId: order.orderId,
          paymentMethod: "bank",
          note: "Work finished",
        },
        { database: ctx.db },
      );
      expect(completed).toMatchObject({ totalCost: "5000.00" });
      expect(completed.entryNo).toMatch(/-J-\d{2}-\d{6}$/);

      const detail = await getAssetDetail(ctx.db, fixture.facility.id, asset.assetId);
      expect(detail?.status).toBe("in_service");
      expect(detail?.maintenanceOrders).toHaveLength(1);
      expect(detail?.maintenanceOrders[0]).toMatchObject({
        orderNo: order.orderNo,
        status: "completed",
        totalCost: "5000.00",
        entryNo: completed.entryNo,
      });
      expect(detail?.maintenanceEvents.map((event) => event.eventType)).toEqual([
        "scheduled",
        "started",
        "note",
        "completed",
      ]);

      const journal = await journalRoles(completed.entryId!);
      expect(journal.totals.get("maintenance_expense")?.debit).toBe(5000);
      expect(journal.totals.get("bank")?.credit).toBe(5000);
      expect(journal.debit).toBe(journal.credit);
      expect(journal.debit).toBe(5000);
    });
  });

  it("approves and posts a revaluation with the correct GL accounts", async () => {
    await withFixture(async (fixture) => {
      const asset = await createAsset(
        assetInput(fixture, "CT scanner", { acquisitionCost: "60000.00" }),
        { database: ctx.db },
      );
      await expect(
        requestAssetValuation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            assetId: asset.assetId,
            kind: "impairment",
            amount: "70000.00",
            effectiveFrom: "2026-02-01",
            reason: "Exceeds carrying amount",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/impairment cannot exceed the carrying amount/i);

      const valuation = await requestAssetValuation(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          assetId: asset.assetId,
          kind: "revaluation",
          amount: "10000.00",
          effectiveFrom: "2026-02-01",
          reason: "Independent valuation",
        },
        { database: ctx.db },
      );
      expect(valuation.valuationNo).toMatch(/^TEST-[A-F0-9]{8}-AVL-\d{2}-\d{5}$/);
      expect(valuation.carryingAfter).toBe("70000.00");

      await expect(
        approveAssetValuation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            valuationId: valuation.valuationId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own valuation/i);

      await setApprovalLimit(fixture, "approveAssetValuation", "5000.00");
      await expect(
        approveAssetValuation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.approver,
            valuationId: valuation.valuationId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds your approval limit/i);

      await setApprovalLimit(fixture, "approveAssetValuation", "20000.00");
      await approveAssetValuation(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.approver,
          valuationId: valuation.valuationId,
        },
        { database: ctx.db },
      );

      const posted = await postAssetValuation(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          valuationId: valuation.valuationId,
        },
        { database: ctx.db },
      );
      const journal = await journalRoles(posted.entryId);
      expect(journal.totals.get("fixed_asset")?.debit).toBe(10000);
      expect(journal.totals.get("revaluation_reserve")?.credit).toBe(10000);
      expect(journal.debit).toBe(journal.credit);

      const current = await getAssetDetail(ctx.db, fixture.facility.id, asset.assetId);
      expect(current).toMatchObject({ acquisitionCost: "70000.00", carryingAmount: "70000.00" });
      expect(current?.valuations).toHaveLength(1);
      expect(current?.valuations[0]).toMatchObject({
        kind: "revaluation",
        status: "posted",
        entryNo: posted.entryNo,
      });

      const approvals = await ctx.db
        .select()
        .from(assetApprovals)
        .where(
          and(
            eq(assetApprovals.facilityId, fixture.facility.id),
            eq(assetApprovals.subjectType, "valuation"),
            eq(assetApprovals.subjectId, valuation.valuationId),
          ),
        );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        actorId: fixture.approver.userId,
        role: "asset_manager",
        maxAmount: "20000.00",
      });
    });
  });

  it("approves and completes a disposal with proceeds and gain recognition", async () => {
    await withFixture(async (fixture) => {
      const asset = await createAsset(assetInput(fixture, "Old ambulance"), {
        database: ctx.db,
      });
      await ctx.db
        .update(assets)
        .set({
          accumulatedDepreciation: "10000.00",
          carryingAmount: "110000.00",
          lastDepreciationDate: "2026-01-31",
        })
        .where(eq(assets.id, asset.assetId));

      await expect(
        requestAssetDisposal(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            assetId: asset.assetId,
            method: "sale",
            disposalDate: "2026-03-01",
            proceeds: "130000.00",
            proceedsMethod: "none",
            reason: "Sold to dealer",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/select how the disposal proceeds were received/i);

      const disposal = await requestAssetDisposal(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          assetId: asset.assetId,
          method: "sale",
          disposalDate: "2026-03-01",
          proceeds: "130000.00",
          proceedsMethod: "bank",
          reason: "Sold to dealer",
        },
        { database: ctx.db },
      );
      expect(disposal.disposalNo).toMatch(/^TEST-[A-F0-9]{8}-DSP-\d{2}-\d{5}$/);
      expect(disposal.gainLoss).toBe("20000.00");

      await expect(
        approveAssetDisposal(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            disposalId: disposal.disposalId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own disposal/i);

      await setApprovalLimit(fixture, "approveAssetDisposal", "100000.00");
      await expect(
        approveAssetDisposal(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.approver,
            disposalId: disposal.disposalId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds your approval limit/i);

      await setApprovalLimit(fixture, "approveAssetDisposal", "150000.00");
      await approveAssetDisposal(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.approver,
          disposalId: disposal.disposalId,
        },
        { database: ctx.db },
      );

      const completed = await completeAssetDisposal(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          disposalId: disposal.disposalId,
        },
        { database: ctx.db },
      );
      expect(completed.gainLoss).toBe("20000.00");
      expect(completed.entryNo).toMatch(/-J-\d{2}-\d{6}$/);

      const journal = await journalRoles(completed.entryId);
      expect(journal.totals.get("accumulated_depreciation")?.debit).toBe(10000);
      expect(journal.totals.get("bank")?.debit).toBe(130000);
      expect(journal.totals.get("fixed_asset")?.credit).toBe(120000);
      expect(journal.totals.get("disposal_gain")?.credit).toBe(20000);
      expect(journal.debit).toBe(journal.credit);
      expect(journal.debit).toBe(140000);

      const current = await getAssetDetail(ctx.db, fixture.facility.id, asset.assetId);
      expect(current).toMatchObject({ status: "disposed", carryingAmount: "0.00" });
      expect(current?.disposals).toHaveLength(1);
      expect(current?.disposals[0]).toMatchObject({
        method: "sale",
        status: "completed",
        entryNo: completed.entryNo,
      });

      await expect(
        requestAssetDisposal(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            assetId: asset.assetId,
            method: "sale",
            disposalDate: "2026-03-02",
            proceeds: "0.00",
            proceedsMethod: "none",
            reason: "Duplicate request",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already been retired/i);
    });
  });

  it("protects asset history and registers every asset table for sync", async () => {
    await withFixture(async (fixture) => {
      const asset = await createAsset(assetInput(fixture, "Infusion pump"), {
        database: ctx.db,
      });
      const assignment = await assignAsset(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          assetId: asset.assetId,
          eventType: "assigned",
          toEmployeeId: fixture.employeeId,
          toLocation: "Ward 3",
        },
        { database: ctx.db },
      );

      await expectDatabaseError(
        ctx.db
          .update(assetAssignments)
          .set({ note: "rewritten history" })
          .where(eq(assetAssignments.id, assignment.assignmentId)),
        /asset records are append-only/i,
      );
      await expectDatabaseError(
        ctx.db.delete(assets).where(eq(assets.id, asset.assetId)),
        /cannot be hard-deleted/i,
      );

      const rows = (await ctx.db.execute(sql`
        SELECT table_name, capture, no_hard_delete, append_only
        FROM sync_tables
        WHERE table_name IN (
          'assets', 'asset_assignments', 'depreciation_runs', 'depreciation_entries',
          'depreciation_run_approvals', 'maintenance_orders', 'maintenance_events',
          'asset_valuations', 'asset_disposals', 'asset_approvals'
        )
        ORDER BY table_name
      `)) as { rows: Array<Record<string, unknown>> };
      expect(rows.rows).toHaveLength(10);
      const appendOnly = new Set([
        "asset_approvals",
        "asset_assignments",
        "depreciation_entries",
        "depreciation_run_approvals",
        "maintenance_events",
      ]);
      for (const row of rows.rows) {
        expect(row.capture).toBe(true);
        expect(row.no_hard_delete).toBe(true);
        expect(row.append_only).toBe(appendOnly.has(String(row.table_name)));
      }

      const actions = (
        await ctx.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.facilityId, fixture.facility.id))
      ).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(["asset.create", "asset.assign"]));
    });
  });
});
