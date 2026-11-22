import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newIdempotencyKey } from "../src/lib/uuid";
import { postManualJournal } from "../src/server/commands/finance";
import { generateErpReport, saveReportView } from "../src/server/commands/reporting";
import { createCostCenter, createLedgerAccount } from "../src/server/commands/finance";
import { getApprovalInbox, getErpReportData, getReportDrillDown, listReportCatalogue, listSavedReportViews } from "../src/server/queries/reporting";
import { cleanupTestFacility, createTestDatabase, insertTestBranch, insertTestFacility, type TestDatabase } from "./helpers";

const ACTOR = { userId: "test-user", ip: "127.0.0.1", deviceId: "vitest" };

describe("ERP reporting", () => {
  let ctx: TestDatabase;

  beforeAll(() => {
    ctx = createTestDatabase();
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  it("lists ERP catalogue and generates a trial balance snapshot with drill-down", async () => {
    const facility = await insertTestFacility(ctx.db);
    await insertTestBranch(ctx.db, facility.id);
    try {
      const cash = await createLedgerAccount(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          code: "1000",
          name: "Cash",
          type: "asset",
        },
        { database: ctx.db },
      );
      const revenue = await createLedgerAccount(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          code: "4000",
          name: "Revenue",
          type: "revenue",
        },
        { database: ctx.db },
      );
      const costCenter = await createCostCenter(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          code: "GEN",
          name: "General",
        },
        { database: ctx.db },
      );

      await postManualJournal(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          entryDate: "2026-11-01",
          description: "Cash sale",
          lines: [
            { accountId: cash.accountId, costCenterId: costCenter.costCenterId, debit: "100.00", credit: "0.00" },
            { accountId: revenue.accountId, costCenterId: costCenter.costCenterId, debit: "0.00", credit: "100.00" },
          ],
        },
        { database: ctx.db },
      );

      const catalogue = await listReportCatalogue(ctx.db);
      expect(catalogue.some((row) => row.reportCode === "ERP_TRIAL_BALANCE")).toBe(true);

      const report = await getErpReportData(ctx.db, facility.id, "ERP_TRIAL_BALANCE", {
        from: "2026-11-01",
        to: "2026-11-30",
      });
      expect(report.reconciled).toBe(true);
      expect(report.rows.length).toBeGreaterThan(0);

      const generated = await generateErpReport(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          reportCode: "ERP_TRIAL_BALANCE",
          filters: { from: "2026-11-01", to: "2026-11-30" },
        },
        { database: ctx.db },
      );
      expect(generated.rowCount).toBeGreaterThan(0);

      const cashRow = report.rows.find((row) => String(row.values.account).includes("1000"));
      expect(cashRow?.drillDown?.sourceType).toBe("ledger_account");
      if (cashRow?.drillDown) {
        const drill = await getReportDrillDown(
          ctx.db,
          facility.id,
          cashRow.drillDown.sourceType,
          cashRow.drillDown.sourceId,
        );
        expect(drill.journalRows.length).toBeGreaterThan(0);
      }

      const saved = await saveReportView(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          reportCode: "ERP_TRIAL_BALANCE",
          name: "Month end TB",
          shared: false,
          filters: { from: "2026-11-01", to: "2026-11-30" },
        },
        { database: ctx.db },
      );
      expect(saved.viewId).toBeTruthy();

      const views = await listSavedReportViews(ctx.db, facility.id, ACTOR.userId, "ERP_TRIAL_BALANCE");
      expect(views.some((view) => view.name === "Month end TB")).toBe(true);

      const inbox = await getApprovalInbox(ctx.db, facility.id);
      expect(Array.isArray(inbox)).toBe(true);
    } finally {
      await cleanupTestFacility(ctx.db, facility.id);
    }
  });
});
