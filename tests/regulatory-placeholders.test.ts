import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { newIdempotencyKey } from "../src/lib/uuid";
import { loadRegulatoryTestPlaceholders } from "../src/server/commands/regulatory";
import {
  facilityIdentifiers,
  facilityRegulatoryProfiles,
  facilities,
  staffRoleScopes,
  syncOutbox,
} from "../src/server/db/schema";
import { getFacilityReadinessStatus } from "../src/server/queries/regulatory";
import {
  cleanupTestFacility,
  createTestDatabase,
  insertTestActor,
  insertTestFacility,
} from "./helpers";

const { db, pool } = createTestDatabase();

afterAll(async () => {
  await pool.end();
});

function code(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function makeFacility(prefix: string, writeAuthority: "clinic" | "cloud" = "clinic") {
  const facility = await insertTestFacility(db);
  await db
    .update(facilities)
    .set({ code: code(prefix), writeAuthority })
    .where(eq(facilities.id, facility.id));
  const actorId = await insertTestActor(db);
  await db.insert(staffRoleScopes).values({
    userId: actorId,
    role: "admin",
    facilityId: facility.id,
    branchId: null,
  });
  return { facilityId: facility.id, actorId };
}

function input(facilityId: string, actorId: string) {
  return {
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    actor: { userId: actorId, deviceId: "vitest" },
  };
}

describe("regulatory placeholder sandbox", () => {
  it("loads TEST values only into REGDEMO facilities and suppresses outbox capture", async () => {
    const { facilityId, actorId } = await makeFacility("REGDEMO");
    const [before] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncOutbox)
      .where(eq(syncOutbox.facilityId, facilityId));
    try {
      const first = await loadRegulatoryTestPlaceholders(
        input(facilityId, actorId),
        { database: db, mode: "clinic" },
      );

      expect(first.placeholder).toBe(true);
      expect(first.rows).toMatchObject({
        profile: 1,
        licences: 3,
        practitioners: 1,
        supportServices: 3,
        identifiers: 3,
        alertRules: 1,
        statutoryRates: 1,
        statutoryFees: 1,
        shaCodes: 1,
        integrations: 1,
      });

      const [profile] = await db
        .select()
        .from(facilityRegulatoryProfiles)
        .where(eq(facilityRegulatoryProfiles.facilityId, facilityId));
      expect(profile?.kmpdcNumber).toBe("TEST-KMPDC-0001");
      expect(profile?.county).toBe("TEST COUNTY");
      expect(profile?.kraPin).toBe("P000000000T");

      const [outbox] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(syncOutbox)
        .where(eq(syncOutbox.facilityId, facilityId));
      expect(outbox?.count).toBe(before?.count);

      // Prove capture is active for this facility: a normal write still queues.
      await db.update(facilities).set({ name: "TEST PLACEHOLDER renamed" }).where(eq(facilities.id, facilityId));
      const [afterControl] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(syncOutbox)
        .where(eq(syncOutbox.facilityId, facilityId));
      expect(afterControl?.count).toBeGreaterThan(outbox?.count ?? 0);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("replays the same idempotency key without duplicating rows", async () => {
    const { facilityId, actorId } = await makeFacility("REGDEMO");
    const command = input(facilityId, actorId);
    try {
      const first = await loadRegulatoryTestPlaceholders(command, { database: db, mode: "clinic" });
      const replay = await loadRegulatoryTestPlaceholders(command, { database: db, mode: "clinic" });
      expect(replay).toEqual(first);

      const licences = await db.execute(sql`
        SELECT count(*)::int AS count FROM facility_licences WHERE facility_id = ${facilityId}::uuid
      `);
      expect((licences as unknown as { rows: Array<{ count: number }> }).rows[0]?.count).toBe(3);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("rejects cloud mode and non-REGDEMO facilities", async () => {
    const { facilityId, actorId } = await makeFacility("PHARM");
    try {
      await expect(
        loadRegulatoryTestPlaceholders(input(facilityId, actorId), {
          database: db,
          mode: "cloud",
        }),
      ).rejects.toThrow("Regulatory placeholders can only be loaded from a clinic-mode node");

      await expect(
        loadRegulatoryTestPlaceholders(input(facilityId, actorId), {
          database: db,
          mode: "clinic",
        }),
      ).rejects.toThrow("Regulatory placeholders can only be loaded into a REGDEMO- test facility");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("derives quality readiness from the quality_certificate identifier", async () => {
    const { facilityId } = await makeFacility("REGDEMO");
    const today = "2026-11-21";
    const isoPlus = (days: number) => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    try {
      await db.insert(facilityIdentifiers).values({
        facilityId,
        identifierType: "quality_certificate",
        value: `TEST-QUALITY-${randomUUID().slice(0, 8)}`,
        validTo: isoPlus(10),
        status: "active",
        createdBy: "vitest",
      });

      const expiring = await getFacilityReadinessStatus(db, facilityId, { today });
      const quality = expiring.domains.find((domain) => domain.domain === "quality");
      expect(quality?.status).toBe("expiring");
      expect(quality?.daysToExpiry).toBe(10);

      await db.insert(facilityIdentifiers).values({
        facilityId,
        identifierType: "quality_certificate",
        value: `TEST-QUALITY-${randomUUID().slice(0, 8)}`,
        validTo: isoPlus(200),
        status: "active",
        createdBy: "vitest",
      });

      const compliant = await getFacilityReadinessStatus(db, facilityId, { today });
      const latest = compliant.domains.find((domain) => domain.domain === "quality");
      expect(latest?.status).toBe("compliant");
      expect(latest?.daysToExpiry).toBe(200);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });
});
