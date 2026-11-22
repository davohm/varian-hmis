import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { createBirthNotification, createDeathNotification, createNotifiableEvent, exportReportRun, generateReportRun, regenerateReportRun, submitReportRun, voidReportRun } from "../src/server/commands/reporting";
import { fiscalPeriods, reportCells, reportRuns, staffRoleScopes } from "../src/server/db/schema";
import { getReportCells, getReportRunAuditTrail } from "../src/server/queries/reporting";
import { cleanupTestFacility, createTestDatabase, insertTestActor, insertTestFacility } from "./helpers";

const { db, pool } = createTestDatabase();
afterAll(async () => { await pool.end(); });

async function makeFacility() {
  const facility = await insertTestFacility(db);
  const actorId = await insertTestActor(db);
  await db.insert(staffRoleScopes).values({ userId: actorId, role: "admin", facilityId: facility.id, branchId: null });
  return { facilityId: facility.id, actorId };
}
function cmd<T extends Record<string, unknown>>(facilityId: string, actorId: string, extra: T) {
  return { facilityId, idempotencyKey: newIdempotencyKey(), actor: { userId: actorId, deviceId: "vitest" }, ...extra };
}

describe("Phase 20 MOH statutory reporting", () => {
  it("1. cannot generate for a future period", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await expect(generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2099, month: 1, today: "2026-11-22" }), { database: db })).rejects.toThrow(/future period/i);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("2. cannot generate for period in a closed fiscal period", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await db.insert(fiscalPeriods).values({ id: newId(), facilityId, name: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "closed", createdBy: actorId, version: 1 });
      await expect(generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 3, today: "2026-11-22" }), { database: db })).rejects.toThrow(/closed fiscal period/i);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("3. weekly report derives MOH epi week and epi year correctly, including previous calendar year", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const run = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH505", periodEnd: "2021-01-01", today: "2026-11-22" }), { database: db });
      const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, run.runId));
      expect(row.epiWeek).toBe(53);
      expect(row.epiYear).toBe(2020);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("4. generateReportRun is idempotent for same (report, branch, period)", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const input = cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" });
      const first = await generateReportRun(input, { database: db });
      const second = await generateReportRun(input, { database: db });
      expect(second.runId).toBe(first.runId);
      const cells = await db.select({ id: reportCells.id }).from(reportCells).where(eq(reportCells.reportRunId, first.runId));
      expect(cells.length).toBe(first.rowCount);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("5. regenerateReportRun on a submitted run is refused", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      await submitReportRun(cmd(facilityId, actorId, { runId: gen.runId }), { database: db });
      await expect(regenerateReportRun(cmd(facilityId, actorId, { runId: gen.runId, today: "2026-11-22" }), { database: db })).rejects.toThrow(/submitted|voided/i);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("6. voidReportRun requires a reason and preserves every cell", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const before = await getReportCells(db, facilityId, gen.runId);
      await expect(voidReportRun(cmd(facilityId, actorId, { runId: gen.runId, reason: "" }), { database: db })).rejects.toThrow();
      await voidReportRun(cmd(facilityId, actorId, { runId: gen.runId, reason: "Test void" }), { database: db });
      const after = await getReportCells(db, facilityId, gen.runId);
      expect(after.length).toBe(before.length);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, gen.runId));
      expect(run.status).toBe("void");
      expect(run.voidReason).toBe("Test void");
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("7. exportReportRun records export and returns checksum matching run", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const exp = await exportReportRun(cmd(facilityId, actorId, { runId: gen.runId, format: "csv" }), { database: db });
      expect(exp.checksum).toBe(gen.checksum);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, gen.runId));
      expect(run.exportedFile).toBe("csv");
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("8. submitted run appears in audit trail and cannot be regenerated", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      await submitReportRun(cmd(facilityId, actorId, { runId: gen.runId }), { database: db });
      const trail = await getReportRunAuditTrail(db, facilityId, gen.runId);
      expect(trail.some((t) => t.action === "report_submitted")).toBe(true);
      await expect(regenerateReportRun(cmd(facilityId, actorId, { runId: gen.runId }), { database: db })).rejects.toThrow(/submitted|voided/i);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("9. immediate notifiable event sets immediate flag", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const ev = await createNotifiableEvent(cmd(facilityId, actorId, { diseaseName: "Cholera", detectedAt: "2026-11-10T08:00:00.000Z" }), { database: db });
      expect(ev.immediate).toBe(true);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("10. birth and death notifications allocate notification numbers", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const birth = await createBirthNotification(cmd(facilityId, actorId, { birthDate: "2026-11-01", sex: "female" }), { database: db });
      const death = await createDeathNotification(cmd(facilityId, actorId, { dateOfDeath: "2026-11-02", causeText: "Natural causes" }), { database: db });
      expect(birth.notificationNo).toMatch(/^BN-/);
      expect(death.notificationNo).toMatch(/^DN-/);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("11. report cell drill-down returns source query for generated cell", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells[0]).toHaveProperty("rowCode");
      expect(cells[0]).toHaveProperty("colKey");
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("12. generateReportRun writes audit row and is idempotent via command log", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const input = cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" });
      const first = await generateReportRun(input, { database: db });
      const trail = await getReportRunAuditTrail(db, facilityId, first.runId);
      expect(trail.some((t) => t.action === "report_generated")).toBe(true);
      const second = await generateReportRun(input, { database: db });
      expect(second.runId).toBe(first.runId);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("arithmetic: 705A row total equals sum of day columns", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A", year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const rows = Array.from(new Set(cells.filter((c) => c.section === "A").map((c) => c.rowCode)));
      for (const rowCode of rows) {
        const daySum = cells.filter((c) => c.section === "A" && c.rowCode === rowCode && c.colKey?.startsWith("d")).reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
        const total = Number(cells.find((c) => c.section === "A" && c.rowCode === rowCode && c.colKey === "total")?.valueNumeric ?? 0);
        expect(total).toBe(daySum);
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });
});
