import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findCommand, listAudit, recordAudit, recordCommand } from "../src/server/audit";
import { newId } from "../src/lib/uuid";
import { cleanupTestFacility, createTestDatabase, insertTestFacility, type TestDatabase } from "./helpers";

describe("audit and command log", () => {
  let ctx: TestDatabase;

  beforeAll(() => {
    ctx = createTestDatabase();
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  it("appends an audit row with full context", async () => {
    const facility = await insertTestFacility(ctx.db);

    try {
      const entityId = newId();
      const auditId = await recordAudit(ctx.db, {
        facilityId: facility.id,
        userId: "staff-1",
        action: "patient.register",
        module: "reception",
        entity: "patients",
        entityId,
        details: { mrn: "FAM-26-00042" },
        deviceId: "station-reception",
        ip: "192.168.1.20",
      });

      const rows = await listAudit(ctx.db, facility.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: auditId,
        facility_id: facility.id,
        user_id: "staff-1",
        action: "patient.register",
        module: "reception",
        entity: "patients",
        entity_id: entityId,
        details: { mrn: "FAM-26-00042" },
        device_id: "station-reception",
        ip: "192.168.1.20",
      });
    } finally {
      await cleanupTestFacility(ctx.db, facility.id);
    }
  });

  it("replays a stored command result for the same idempotency key", async () => {
    const facility = await insertTestFacility(ctx.db);
    const idempotencyKey = newId();
    const result = { patientId: newId(), mrn: "FAM-26-00043" };

    try {
      await recordCommand(ctx.db, {
        facilityId: facility.id,
        idempotencyKey,
        command: "registerPatient",
        result,
      });
      await recordCommand(ctx.db, {
        facilityId: facility.id,
        idempotencyKey,
        command: "registerPatient",
        result: { patientId: newId(), mrn: "FAM-26-00099" },
      });

      const stored = await findCommand(ctx.db, facility.id, idempotencyKey);
      expect(stored).toMatchObject({
        idempotency_key: idempotencyKey,
        facility_id: facility.id,
        command: "registerPatient",
        result,
      });
    } finally {
      await cleanupTestFacility(ctx.db, facility.id);
    }
  });
});
