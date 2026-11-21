import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  applyAdminOverride,
  proposeAdminOverride,
  rejectAdminOverride,
} from "../src/server/commands/admin";
import { createDatabase } from "../src/server/db/client";
import {
  adminOverrides,
  auditLog,
  branches,
  facilities,
  patients,
  syncOutbox,
} from "../src/server/db/schema";
import { DATABASE_URL } from "../src/server/env";
import { applyPullRows, readPullRows } from "../src/server/sync/pull";

import { cleanupTestFacility, createTestDatabase, type TestDatabase } from "./helpers";

const OVERRIDE_DATABASE_NAME = "varian-hmis-override-test";

let cloud: TestDatabase;
let clinic: ReturnType<typeof createDatabase>;

function overrideDatabaseUrl(): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${OVERRIDE_DATABASE_NAME}`;
  return url.toString();
}

async function ensureClinicDatabase(): Promise<void> {
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      OVERRIDE_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${OVERRIDE_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

interface Fixture {
  facilityId: string;
  patientId: string;
}

async function withPairedFacility<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const facilityId = newId();
  const patientId = newId();
  const code = `OVR-${randomUUID().slice(0, 8).toUpperCase()}`;
  const branchId = newId();

  for (const [db, name] of [[cloud.db, "Cloud"], [clinic.db, "Branch"]] as const) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
      await tx.insert(facilities).values({
        id: facilityId,
        code,
        name: `${name} ${code}`,
        writeAuthority: "clinic",
        active: true,
        createdBy: "vitest",
      });
      await tx.insert(branches).values({
        id: branchId,
        facilityId,
        code: "MAIN",
        name: "Main Branch",
        isMain: true,
        createdBy: "vitest",
      });
      await tx.insert(patients).values({
        id: patientId,
        facilityId,
        mrn: `${code}-P001`,
        firstName: "Amina",
        lastName: "Otieno",
        sex: "female",
        version: 3,
        createdBy: "vitest",
      });
    });
  }

  try {
    return await run({ facilityId, patientId });
  } finally {
    await cleanupTestFacility(cloud.db, facilityId);
    await cleanupTestFacility(clinic.db, facilityId);
  }
}

async function propose(
  facilityId: string,
  patientId: string,
  changes: Record<string, string | boolean | number | null>,
  basedOnVersion = 3,
) {
  return proposeAdminOverride({
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    tableName: "patients",
    recordId: patientId,
    changes,
    basedOnVersion,
    reason: "Correct the patient's registered details",
    actor: { userId: "central-admin" },
  }, { database: cloud.db, mode: "cloud" });
}

async function deliverOverrides(facilityId: string, limit = 100) {
  const first = await readPullRows(cloud.db, facilityId, {}, limit);
  const second = first.overrideCursor
    ? await readPullRows(cloud.db, facilityId, first.cursors, limit, first.overrideCursor)
    : null;
  const overrides = [...first.overrides, ...(second?.overrides ?? [])];
  await clinic.db.transaction(async (tx) => {
    await applyPullRows(
      tx,
      [],
      facilityId,
      undefined,
      undefined,
      overrides,
      second?.overrideCursor ?? first.overrideCursor,
    );
  });
  return overrides;
}

beforeAll(async () => {
  await ensureClinicDatabase();
  cloud = createTestDatabase();
  clinic = createDatabase(overrideDatabaseUrl(), "clinic");
  await migrate(clinic.db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
});

afterAll(async () => {
  await Promise.all([cloud.pool.end(), clinic.pool.end()]);
});

describe("admin override channel", () => {
  it("proposes only against the exact cloud version and audits the proposal", async () => {
    await withPairedFacility(async ({ facilityId, patientId }) => {
      await expect(
        propose(facilityId, patientId, { first_name: "Wrong base" }, 2),
      ).rejects.toThrow(/expected version 2, found 3/);

      const proposal = await propose(facilityId, patientId, { first_name: "Amina W." });
      expect(proposal).toMatchObject({ status: "proposed" });

      const stored = await cloud.db
        .select()
        .from(adminOverrides)
        .where(eq(adminOverrides.id, proposal.overrideId));
      expect(stored[0]).toMatchObject({
        facilityId,
        tableName: "patients",
        recordId: patientId,
        changes: { first_name: "Amina W." },
        basedOnVersion: 3,
        status: "proposed",
        version: 1,
      });

      const audits = await cloud.db
        .select()
        .from(auditLog)
        .where(and(
          eq(auditLog.facilityId, facilityId),
          eq(auditLog.action, "admin.override.propose"),
        ));
      expect(audits).toHaveLength(1);
      expect(audits[0].entityId).toBe(proposal.overrideId);
    });
  });

  it("refuses forbidden tables and non-allow-listed fields", async () => {
    await withPairedFacility(async ({ facilityId, patientId }) => {
      await expect(proposeAdminOverride({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        tableName: "clinical_notes",
        recordId: patientId,
        changes: { assessment: "Changed by central admin" },
        basedOnVersion: 3,
        reason: "This must not be allowed",
        actor: { userId: "central-admin" },
      }, { database: cloud.db, mode: "cloud" })).rejects.toThrow(/clinical_notes cannot be changed/);

      await expect(propose(
        facilityId,
        patientId,
        { first_name: "Amina", payer_type: "insurance" },
      )).rejects.toThrow(/payer_type cannot be changed/);

      const stored = await cloud.db
        .select()
        .from(adminOverrides)
        .where(eq(adminOverrides.facilityId, facilityId));
      expect(stored).toHaveLength(0);
    });
  });

  it("delivers proposals through pull, applies an exact-version change and queues the branch outbox rows", async () => {
    await withPairedFacility(async ({ facilityId, patientId }) => {
      const firstProposal = await propose(facilityId, patientId, { first_name: "Amina W." });
      const secondProposal = await propose(facilityId, patientId, { last_name: "Odhiambo" });

      const page = await readPullRows(cloud.db, facilityId, {}, 1);
      expect(page.overrides).toHaveLength(1);
      expect(page.overrideCursor).toBeDefined();
      expect(page.overrides[0]).toMatchObject({
        id: firstProposal.overrideId,
        tableName: "patients",
        changes: { first_name: "Amina W." },
        basedOnVersion: 3,
        status: "proposed",
      });

      const nextPage = await readPullRows(
        cloud.db,
        facilityId,
        page.cursors,
        1,
        page.overrideCursor,
      );
      expect(nextPage.overrides.map((override) => override.id)).toContain(secondProposal.overrideId);

      await clinic.db.transaction(async (tx) => {
        await applyPullRows(
          tx,
          [],
          facilityId,
          undefined,
          undefined,
          [...page.overrides, ...nextPage.overrides],
          nextPage.overrideCursor,
        );
      });

      const delivered = await clinic.db
        .select()
        .from(adminOverrides)
        .where(eq(adminOverrides.facilityId, facilityId));
      expect(delivered).toHaveLength(2);
      expect(delivered.every((row) => row.status === "proposed")).toBe(true);

      const applied = await applyAdminOverride({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        overrideId: firstProposal.overrideId,
        actor: { userId: "branch-admin" },
      }, { database: clinic.db, mode: "clinic" });
      expect(applied).toEqual({ status: "applied", version: 4 });

      const patientRows = await clinic.db
        .select()
        .from(patients)
        .where(eq(patients.id, patientId));
      expect(patientRows[0]).toMatchObject({ firstName: "Amina W.", version: 4 });

      const outbox = await clinic.db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.facilityId, facilityId));
      expect(outbox.some((row) => row.tableName === "patients" && row.operation === "UPDATE")).toBe(true);
      expect(outbox.some((row) => row.tableName === "admin_overrides" && row.recordId === firstProposal.overrideId)).toBe(true);
      expect(outbox.some((row) => row.tableName === "audit_log" && row.lastError === null)).toBe(true);

      const applyAudits = await clinic.db
        .select()
        .from(auditLog)
        .where(and(
          eq(auditLog.facilityId, facilityId),
          eq(auditLog.action, "admin.override.apply"),
        ));
      expect(applyAudits).toHaveLength(1);
      expect(applyAudits[0].entityId).toBe(patientId);
    });
  });

  it("records a version conflict and leaves the branch record untouched", async () => {
    await withPairedFacility(async ({ facilityId, patientId }) => {
      const applied = await propose(facilityId, patientId, { first_name: "Amina W." });
      const conflicted = await propose(facilityId, patientId, { last_name: "Odhiambo" });
      await deliverOverrides(facilityId);

      expect(await applyAdminOverride({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        overrideId: applied.overrideId,
        actor: { userId: "branch-admin" },
      }, { database: clinic.db, mode: "clinic" })).toEqual({ status: "applied", version: 4 });

      const result = await applyAdminOverride({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        overrideId: conflicted.overrideId,
        actor: { userId: "branch-admin" },
      }, { database: clinic.db, mode: "clinic" });
      expect(result).toEqual({ status: "conflicted", expectedVersion: 3, actualVersion: 4 });

      const rows = await clinic.db
        .select()
        .from(patients)
        .where(eq(patients.id, patientId));
      expect(rows[0]).toMatchObject({ firstName: "Amina W.", lastName: "Otieno", version: 4 });

      const conflictAudit = await clinic.db
        .select()
        .from(auditLog)
        .where(and(
          eq(auditLog.facilityId, facilityId),
          eq(auditLog.action, "admin.override.conflict"),
        ));
      expect(conflictAudit).toHaveLength(1);

      const decisionRows = await clinic.db
        .select()
        .from(adminOverrides)
        .where(eq(adminOverrides.id, conflicted.overrideId));
      expect(decisionRows[0]).toMatchObject({ status: "conflicted" });
      expect(decisionRows[0].decisionReason).toContain("version 4");
    });
  });

  it("rejects a proposal without touching the branch record", async () => {
    await withPairedFacility(async ({ facilityId, patientId }) => {
      const proposal = await propose(facilityId, patientId, { first_name: "Changed" });
      await deliverOverrides(facilityId);

      expect(await rejectAdminOverride({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        overrideId: proposal.overrideId,
        decisionReason: "Patient confirmed the original name",
        actor: { userId: "branch-admin" },
      }, { database: clinic.db, mode: "clinic" })).toEqual({ status: "rejected" });

      const rows = await clinic.db
        .select()
        .from(patients)
        .where(eq(patients.id, patientId));
      expect(rows[0]).toMatchObject({ firstName: "Amina", version: 3 });

      const decision = await clinic.db
        .select()
        .from(adminOverrides)
        .where(eq(adminOverrides.id, proposal.overrideId));
      expect(decision[0]).toMatchObject({
        status: "rejected",
        decisionReason: "Patient confirmed the original name",
      });

      const rejectAudits = await clinic.db
        .select()
        .from(auditLog)
        .where(and(
          eq(auditLog.facilityId, facilityId),
          eq(auditLog.action, "admin.override.reject"),
        ));
      expect(rejectAudits).toHaveLength(1);

      const rowsFrom = await clinic.db.execute(sql`
        SELECT count(*)::int AS count
        FROM sync_outbox
        WHERE facility_id = ${facilityId}::uuid AND table_name = 'patients'
      `);
      expect(Number((rowsFrom as { rows?: Array<{ count?: number }> }).rows?.[0]?.count ?? 0)).toBe(0);
    });
  });
});
