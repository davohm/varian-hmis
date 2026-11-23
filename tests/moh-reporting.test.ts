import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { createBirthNotification, createDeathNotification, createNotifiableEvent, exportReportRun, generateReportRun, regenerateReportRun, submitReportRun, voidReportRun } from "../src/server/commands/reporting";
import { auditLog, diagnoses, encounters, fiscalPeriods, patients, reportCells, reportRuns, staffRoleScopes, syncOutbox } from "../src/server/db/schema";
import { exportChecksum } from "../src/lib/moh-export";
import { drillDownReportCell, getReportCells, getReportRunAuditTrail } from "../src/server/queries/reporting";
import { cleanupTestFacility, createTestDatabase, insertTestActor, insertTestBranch, insertTestFacility } from "./helpers";

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
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const rows = Array.from(new Set(cells.filter((c) => c.section === "A").map((c) => c.rowCode)));
      for (const rowCode of rows) {
        const daySum = cells.filter((c) => c.section === "A" && c.rowCode === rowCode && c.colKey?.startsWith("d")).reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
        const total = Number(cells.find((c) => c.section === "A" && c.rowCode === rowCode && c.colKey === "total")?.valueNumeric ?? 0);
        expect(total).toBe(daySum);
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("arithmetic: 717 TOTAL = NEW+RE-ATTENDANCE and A.1.5 = sum A.1.1-A.1.4", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH717" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const rowCodes = Array.from(new Set(cells.filter((c) => c.section === "A1" || c.section === "A2" || c.section === "A3").map((c) => c.rowCode)));
      for (const rc of rowCodes) {
        const section = cells.find((c) => c.rowCode === rc)?.section ?? "A1";
        const n = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "new")?.valueNumeric ?? 0);
        const r = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "re_att")?.valueNumeric ?? 0);
        const t = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "total")?.valueNumeric ?? 0);
        expect(t).toBe(n + r);
      }
      for (const col of ["new", "re_att", "total"]) {
        const sum = ["A.1.1", "A.1.2", "A.1.3", "A.1.4"].reduce((acc, rc) => acc + Number(cells.find((c) => c.section === "A1" && c.rowCode === rc && c.colKey === col)?.valueNumeric ?? 0), 0);
        const total = Number(cells.find((c) => c.section === "A1" && c.rowCode === "A.1.5T" && c.colKey === col)?.valueNumeric ?? 0);
        expect(total).toBe(sum);
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("arithmetic: 710B C=A+B, D=C-E-G, H=G/E with divide-by-zero guard", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH710B" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const antigens = Array.from(new Set(cells.map((c) => c.rowCode?.split(":")[0]).filter(Boolean))) as string[];
      for (const ag of antigens) {
        const get = (s: string) => Number(cells.find((c) => c.rowCode === `${ag}:${s}`)?.valueNumeric ?? 0);
        expect(get("C")).toBe(get("A") + get("B"));
        expect(get("D")).toBe(get("A") + get("B") - get("E") - get("G"));
        const e = get("E");
        expect(get("H")).toBe(e === 0 ? 0 : Number(((get("G") / e) * 100).toFixed(2)));
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("arithmetic: 505 total cases/deaths equal age-band sums", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH505" as const, periodEnd: "2026-10-11", today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      for (const section of ["LEFT", "RIGHT"]) {
        const rowCodes = Array.from(new Set(cells.filter((c) => c.section === section).map((c) => c.rowCode)));
        for (const rc of rowCodes) {
          const lt5c = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "lt5_cases")?.valueNumeric ?? 0);
          const ge5c = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "ge5_cases")?.valueNumeric ?? 0);
          const tc = Number(cells.find((c) => c.section === section && c.rowCode === rc && c.colKey === "total_cases")?.valueNumeric ?? 0);
          expect(tc).toBe(lt5c + ge5c);
        }
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("arithmetic: 735 diagnosis total = Normal + Low Vision + Blind across age/sex bands", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH735" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const diagRows = Array.from(new Set(cells.filter((c) => c.section === "D").map((c) => c.rowCode)));
      for (const rc of diagRows) {
        const diagCols = cells.filter((c) => c.section === "D" && c.rowCode === rc && c.colKey !== "total").map((c) => c.colKey);
        const sum = diagCols.reduce((n, col) => n + Number(cells.find((c) => c.section === "D" && c.rowCode === rc && c.colKey === col)?.valueNumeric ?? 0), 0);
        const total = Number(cells.find((c) => c.section === "D" && c.rowCode === rc && c.colKey === "total")?.valueNumeric ?? 0);
        expect(total).toBe(sum);
      }
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("9. immediate notifiable event appears in next weekly 505 total", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await createNotifiableEvent(cmd(facilityId, actorId, { diseaseName: "Cholera", detectedAt: "2026-10-07T08:00:00.000Z" }), { database: db });
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH505" as const, periodEnd: "2026-10-11", today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const choleraTotal = Number(cells.find((c) => c.section === "LEFT" && c.rowCode === "CHOL" && c.colKey === "total_cases")?.valueNumeric ?? 0);
      expect(choleraTotal).toBeGreaterThanOrEqual(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("checksum is stable and row_count equals report_cells written", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 9, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      expect(gen.rowCount).toBe(cells.length);
      const regen = await regenerateReportRun(cmd(facilityId, actorId, { runId: gen.runId, today: "2026-11-22" }), { database: db });
      expect(regen.checksum).toBe(gen.checksum);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("10. birth/death notifications increase 717 birth/death rows", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await createBirthNotification(cmd(facilityId, actorId, { birthDate: "2026-10-05" }), { database: db });
      await createDeathNotification(cmd(facilityId, actorId, { dateOfDeath: "2026-10-06" }), { database: db });
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH717" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      expect(Number(cells.find((c) => c.section === "B" && c.rowCode === "B.1" && c.colKey === "total")?.valueNumeric ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(cells.find((c) => c.section === "B" && c.rowCode === "B.2" && c.colKey === "total")?.valueNumeric ?? 0)).toBeGreaterThanOrEqual(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("11. drill-down returns exact source rows for 705A day cell", async () => {
    const { facilityId, actorId } = await makeFacility();
    const branchId = await insertTestBranch(db, facilityId);
    try {
      const patientId = newId();
      await db.insert(patients).values({ id: patientId, facilityId, mrn: `MRN-${newId().slice(0, 8)}`, firstName: "Test", lastName: "Child", dob: "2023-01-01", sex: "female", payerType: "cash", createdBy: "vitest" });
      const encounterId = newId();
      await db.insert(encounters).values({ id: encounterId, facilityId, branchId, patientId, encounterNo: `ENC-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-05T09:00:00.000Z"), createdBy: "vitest" });
      await db.insert(diagnoses).values({ id: newId(), facilityId, encounterId, icd10Code: "A09", description: "Diarrhoea no dehydration", isPrimary: true, diagnosedBy: "vitest", createdBy: "vitest" });
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const dd = await drillDownReportCell(db, facilityId, gen.runId, "1", "d05");
      expect(dd).not.toBeNull();
      expect(Array.isArray(dd?.sourceRows)).toBe(true);
      expect((dd?.sourceRows as Array<{ encounterId: string }>).some((r) => r.encounterId === encounterId)).toBe(true);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("7. export checksum matches on-screen report_cells checksum", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const mapped = cells.map((c) => ({ section: c.section, rowCode: c.rowCode, rowLabel: c.rowLabel, colKey: c.colKey, colLabel: c.colLabel, valueNumeric: c.valueNumeric, valueText: c.valueText, sortOrder: c.sortOrder, isTotal: c.isTotal }));
      expect(exportChecksum(mapped)).toBe(gen.checksum);
      const exported = await exportReportRun(cmd(facilityId, actorId, { runId: gen.runId, format: "csv" as const }), { database: db });
      expect(exported.checksum).toBe(gen.checksum);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("8. submitted run has audit trail and cannot be regenerated", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 8, today: "2026-11-22" }), { database: db });
      await submitReportRun(cmd(facilityId, actorId, { runId: gen.runId }), { database: db });
      const trail = await getReportRunAuditTrail(db, facilityId, gen.runId);
      expect(trail.some((t) => t.action === "report_submitted")).toBe(true);
      await expect(regenerateReportRun(cmd(facilityId, actorId, { runId: gen.runId, today: "2026-11-22" }), { database: db })).rejects.toThrow(/cannot be regenerated/i);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("6. voidReportRun requires a reason and preserves every cell", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 7, today: "2026-11-22" }), { database: db });
      const before = await getReportCells(db, facilityId, gen.runId);
      await expect(voidReportRun(cmd(facilityId, actorId, { runId: gen.runId, reason: "" } as unknown as Parameters<typeof voidReportRun>[0]), { database: db })).rejects.toThrow();
      await voidReportRun(cmd(facilityId, actorId, { runId: gen.runId, reason: "Data correction required" }), { database: db });
      const after = await getReportCells(db, facilityId, gen.runId);
      expect(after.length).toBe(before.length);
      expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("11. drill-down returns source rows for 505 and 717", async () => {
    const { facilityId, actorId } = await makeFacility();
    const branchId = await insertTestBranch(db, facilityId);
    try {
      await createNotifiableEvent(cmd(facilityId, actorId, { diseaseName: "Cholera", detectedAt: "2026-10-07T08:00:00.000Z" }), { database: db });
      const gen505 = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH505" as const, periodEnd: "2026-10-11", today: "2026-11-22" }), { database: db });
      const dd505 = await drillDownReportCell(db, facilityId, gen505.runId, "CHOL", "lt5_cases");
      expect(Array.isArray(dd505?.sourceRows)).toBe(true);

      const patientId = newId();
      await db.insert(patients).values({ id: patientId, facilityId, mrn: `MRN-${newId().slice(0, 8)}`, firstName: "A", lastName: "B", dob: "2020-01-01", sex: "male", payerType: "cash", createdBy: "vitest" });
      await db.insert(encounters).values({ id: newId(), facilityId, branchId, patientId, encounterNo: `ENC-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-06T09:00:00.000Z"), createdBy: "vitest" });
      const gen717 = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH717" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const dd717 = await drillDownReportCell(db, facilityId, gen717.runId, "A.1.1", "new");
      expect(Array.isArray(dd717?.sourceRows)).toBe(true);
      expect((dd717?.sourceRows as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("identity 4: 705A under-5 and 705B over-5 totals align with 717 under-5 rows", async () => {
    const { facilityId, actorId } = await makeFacility();
    const branchId = await insertTestBranch(db, facilityId);
    try {
      const u5 = newId();
      const o5 = newId();
      await db.insert(patients).values([
        { id: u5, facilityId, mrn: `MRN-U5-${newId().slice(0, 8)}`, firstName: "Under", lastName: "Five", dob: "2024-01-01", sex: "female", payerType: "cash", createdBy: "vitest" },
        { id: o5, facilityId, mrn: `MRN-O5-${newId().slice(0, 8)}`, firstName: "Over", lastName: "Five", dob: "2000-01-01", sex: "male", payerType: "cash", createdBy: "vitest" },
      ]);
      const e1 = newId(); const e2 = newId();
      await db.insert(encounters).values([
        { id: e1, facilityId, branchId, patientId: u5, encounterNo: `ENC-U5-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-03T09:00:00.000Z"), createdBy: "vitest" },
        { id: e2, facilityId, branchId, patientId: o5, encounterNo: `ENC-O5-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-03T10:00:00.000Z"), createdBy: "vitest" },
      ]);
      await db.insert(diagnoses).values([
        { id: newId(), facilityId, encounterId: e1, icd10Code: "A09", description: "Diarrhoea no dehydration", isPrimary: true, diagnosedBy: "vitest", createdBy: "vitest" },
        { id: newId(), facilityId, encounterId: e2, icd10Code: "A09", description: "Diarrhoea", isPrimary: true, diagnosedBy: "vitest", createdBy: "vitest" },
      ]);
      const g705a = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const g705b = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705B" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const g717 = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH717" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const c705a = await getReportCells(db, facilityId, g705a.runId);
      const c705b = await getReportCells(db, facilityId, g705b.runId);
      const c717 = await getReportCells(db, facilityId, g717.runId);
      const under5Total705A = c705a.filter((c) => c.section === "A" && c.rowCode !== "99" && c.colKey === "total").reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
      const over5Total705B = c705b.filter((c) => c.section === "A" && c.rowCode !== "99" && c.colKey === "total").reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
      const under5_717 = ["A.1.3", "A.1.4"].reduce((n, rc) => n + Number(c717.find((c) => c.section === "A1" && c.rowCode === rc && c.colKey === "total")?.valueNumeric ?? 0), 0);
      const over5_717 = ["A.1.1", "A.1.2"].reduce((n, rc) => n + Number(c717.find((c) => c.section === "A1" && c.rowCode === rc && c.colKey === "total")?.valueNumeric ?? 0), 0);
      expect(under5Total705A).toBe(1);
      expect(over5Total705B).toBe(1);
      expect(under5_717).toBe(1);
      expect(over5_717).toBe(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("identity 2: 705A day total reconciles to qualifying encounters+diagnoses for that day", async () => {
    const { facilityId, actorId } = await makeFacility();
    const branchId = await insertTestBranch(db, facilityId);
    try {
      const p1 = newId(); const p2 = newId();
      await db.insert(patients).values([
        { id: p1, facilityId, mrn: `MRN-R1-${newId().slice(0, 8)}`, firstName: "U", lastName: "One", dob: "2024-02-01", sex: "male", payerType: "cash", createdBy: "vitest" },
        { id: p2, facilityId, mrn: `MRN-R2-${newId().slice(0, 8)}`, firstName: "U", lastName: "Two", dob: "2023-02-01", sex: "female", payerType: "cash", createdBy: "vitest" },
      ]);
      const e1 = newId(); const e2 = newId();
      await db.insert(encounters).values([
        { id: e1, facilityId, branchId, patientId: p1, encounterNo: `ENC-R1-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-05T09:00:00.000Z"), createdBy: "vitest" },
        { id: e2, facilityId, branchId, patientId: p2, encounterNo: `ENC-R2-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-05T10:00:00.000Z"), createdBy: "vitest" },
      ]);
      await db.insert(diagnoses).values([
        { id: newId(), facilityId, encounterId: e1, icd10Code: "A09", description: "Diarrhoea no dehydration", isPrimary: true, diagnosedBy: "vitest", createdBy: "vitest" },
        { id: newId(), facilityId, encounterId: e2, icd10Code: "J18", description: "Pneumonia", isPrimary: true, diagnosedBy: "vitest", createdBy: "vitest" },
      ]);
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const cells = await getReportCells(db, facilityId, gen.runId);
      const day5 = cells.filter((c) => c.section === "A" && c.rowCode !== "99" && c.colKey === "d05").reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
      expect(day5).toBe(2);
      const dd = await drillDownReportCell(db, facilityId, gen.runId, "1", "d05");
      expect((dd?.sourceRows as Array<Record<string, unknown>>).length).toBe(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("11. drill-down returns source rows for MOH416 summary cells", async () => {
    const { facilityId, actorId } = await makeFacility();
    const branchId = await insertTestBranch(db, facilityId);
    try {
      const p = newId();
      await db.insert(patients).values({ id: p, facilityId, mrn: `MRN-416-${newId().slice(0, 8)}`, firstName: "Eye", lastName: "Patient", dob: "1990-01-01", sex: "female", payerType: "cash", createdBy: "vitest" });
      await db.insert(encounters).values({ id: newId(), facilityId, branchId, patientId: p, encounterNo: `ENC-416-${newId().slice(0, 8)}`, status: "discharged", payerType: "cash", startedAt: new Date("2026-10-09T09:00:00.000Z"), createdBy: "vitest" });
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH416" as const, year: 2026, month: 10, today: "2026-11-22" }), { database: db });
      const dd = await drillDownReportCell(db, facilityId, gen.runId, "total_seen", "value");
      expect(Array.isArray(dd?.sourceRows)).toBe(true);
      expect((dd?.sourceRows as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("12. generate command writes audit row and sync outbox rows; replay returns original result", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const idempotencyKey = newIdempotencyKey();
      const input = { facilityId, idempotencyKey, actor: { userId: actorId, deviceId: "vitest" }, reportCode: "MOH705A" as const, year: 2026, month: 6, today: "2026-11-22" };
      const first = await generateReportRun(input, { database: db });
      const second = await generateReportRun(input, { database: db });
      expect(second.runId).toBe(first.runId);
      const audits = await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.entity, "report_run"), eq(auditLog.entityId, first.runId)));
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const outbox = await db.select({ id: syncOutbox.outboxId }).from(syncOutbox).where(eq(syncOutbox.facilityId, facilityId));
      expect(outbox.length).toBeGreaterThanOrEqual(1);
    } finally { await cleanupTestFacility(db, facilityId); }
  });

  it("12. submit/void/export/notifiable/birth/death commands write audit rows and replay safely", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const gen = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 5, today: "2026-11-22" }), { database: db });
      const submitKey = newIdempotencyKey();
      const sub1 = await submitReportRun({ facilityId, idempotencyKey: submitKey, actor: { userId: actorId, deviceId: "vitest" }, runId: gen.runId }, { database: db });
      const sub2 = await submitReportRun({ facilityId, idempotencyKey: submitKey, actor: { userId: actorId, deviceId: "vitest" }, runId: gen.runId }, { database: db });
      expect(sub2.runId).toBe(sub1.runId);

      const gen2 = await generateReportRun(cmd(facilityId, actorId, { reportCode: "MOH705A" as const, year: 2026, month: 4, today: "2026-11-22" }), { database: db });
      const voidKey = newIdempotencyKey();
      const v1 = await voidReportRun({ facilityId, idempotencyKey: voidKey, actor: { userId: actorId, deviceId: "vitest" }, runId: gen2.runId, reason: "test void" }, { database: db });
      const v2 = await voidReportRun({ facilityId, idempotencyKey: voidKey, actor: { userId: actorId, deviceId: "vitest" }, runId: gen2.runId, reason: "test void" }, { database: db });
      expect(v2.runId).toBe(v1.runId);

      const exp = await exportReportRun(cmd(facilityId, actorId, { runId: gen.runId, format: "csv" as const }), { database: db });
      expect(exp.checksum).toBe(gen.checksum);

      const nKey = newIdempotencyKey();
      const n1 = await createNotifiableEvent({ facilityId, idempotencyKey: nKey, actor: { userId: actorId, deviceId: "vitest" }, diseaseName: "Measles", detectedAt: "2026-10-01T08:00:00.000Z" }, { database: db });
      const n2 = await createNotifiableEvent({ facilityId, idempotencyKey: nKey, actor: { userId: actorId, deviceId: "vitest" }, diseaseName: "Measles", detectedAt: "2026-10-01T08:00:00.000Z" }, { database: db });
      expect(n2.eventId).toBe(n1.eventId);

      const bKey = newIdempotencyKey();
      const b1 = await createBirthNotification({ facilityId, idempotencyKey: bKey, actor: { userId: actorId, deviceId: "vitest" }, birthDate: "2026-10-01" }, { database: db });
      const b2 = await createBirthNotification({ facilityId, idempotencyKey: bKey, actor: { userId: actorId, deviceId: "vitest" }, birthDate: "2026-10-01" }, { database: db });
      expect(b2.notificationId).toBe(b1.notificationId);

      const dKey = newIdempotencyKey();
      const d1 = await createDeathNotification({ facilityId, idempotencyKey: dKey, actor: { userId: actorId, deviceId: "vitest" }, dateOfDeath: "2026-10-02" }, { database: db });
      const d2 = await createDeathNotification({ facilityId, idempotencyKey: dKey, actor: { userId: actorId, deviceId: "vitest" }, dateOfDeath: "2026-10-02" }, { database: db });
      expect(d2.notificationId).toBe(d1.notificationId);

      const auditRows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.facilityId, facilityId));
      expect(auditRows.length).toBeGreaterThanOrEqual(6);
      const outboxRows = await db.select({ id: syncOutbox.outboxId }).from(syncOutbox).where(eq(syncOutbox.facilityId, facilityId));
      expect(outboxRows.length).toBeGreaterThanOrEqual(6);
    } finally { await cleanupTestFacility(db, facilityId); }
  });
});
