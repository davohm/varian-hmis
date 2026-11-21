import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  rotateFacilitySyncToken,
  revokeFacilitySyncToken,
} from "../src/server/commands/admin";
import {
  dischargeEncounter,
  saveClinicalNote,
  startConsultation,
} from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient } from "../src/server/commands/patients";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import { createDatabase } from "../src/server/db/client";
import {
  account,
  auditLog,
  branches,
  clinicalNotes,
  encounters,
  facilities,
  facilitySyncTokens,
  patients,
  queueEntries,
  staffProfiles,
  staffRoleScopes,
  syncOutbox,
  triageVitals,
  user,
} from "../src/server/db/schema";
import { DATABASE_URL } from "../src/server/env";
import { applySyncBatch, SyncBatchError } from "../src/server/sync/batch";
import { authorizeSyncToken, hashSyncToken, SyncAuthError } from "../src/server/sync/auth";
import {
  listFailedOutboxIds,
  listPendingRows,
  markRowsFailed,
  pullCursorStateKey,
  readSyncState,
  retryOutboxRows,
} from "../src/server/sync/outbox";
import { applyPullRows, readPullRows } from "../src/server/sync/pull";
import {
  SYNC_NO_HARD_DELETE_TABLES,
  SYNC_OUTBOUND_TABLES,
} from "../src/server/sync/registry";
import { pullCursorsSchema } from "../src/server/sync/types";
import {
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
} from "../src/server/sync/version";
import { runSyncCycle } from "../src/server/sync/worker";
import type { SyncRow } from "../src/server/sync/types";

import { cleanupTestFacility, createTestDatabase, type TestDatabase } from "./helpers";

const SYNC_DATABASE_NAME = "varian-hmis-sync-test";
const TOKEN = "sync-token-for-deterministic-tests";
const DEVICE = "clinic-server";

let cloud: TestDatabase;
let clinic: ReturnType<typeof createDatabase>;

function syncDatabaseUrl(): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${SYNC_DATABASE_NAME}`;
  return url.toString();
}

async function ensureClinicDatabase(): Promise<void> {
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      SYNC_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${SYNC_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

async function facilityAuthority(executor: TestDatabase["db"], facilityId: string): Promise<string> {
  const result = await executor.execute(sql`
    SELECT write_authority::text AS "writeAuthority"
    FROM facilities
    WHERE id = ${facilityId}::uuid
  `);
  return String(rowsFrom(result)[0]?.writeAuthority);
}

interface PairedFacility {
  id: string;
  code: string;
  branchId: string;
}

async function withPairedFacility<T>(run: (fixture: PairedFacility) => Promise<T>): Promise<T> {
  const id = newId();
  const code = `SYNC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const branchId = newId();

  await cloud.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
    await tx.insert(facilities).values({
      id,
      code,
      name: `Sync Cloud ${code}`,
      writeAuthority: "clinic",
      active: true,
      createdBy: "vitest",
    });
    await tx.insert(branches).values({
      id: branchId,
      facilityId: id,
      code: "MAIN",
      name: "Main Branch",
      isMain: true,
      createdBy: "vitest",
    });
  });
  await clinic.db.insert(facilities).values({
    id,
    code,
    name: `Sync Clinic ${code}`,
    // The test process runs in APP_MODE=cloud, so clinic commands need a cloud
    // facility to exercise the real command pipeline before "going offline".
    writeAuthority: "cloud",
    active: true,
    createdBy: "vitest",
  });
  await clinic.db.insert(branches).values({
    id: branchId,
    facilityId: id,
    code: "MAIN",
    name: "Main Branch",
    isMain: true,
    createdBy: "vitest",
  });
  await cloud.db.insert(facilitySyncTokens).values({
    facilityId: id,
    deviceKey: DEVICE,
    tokenHash: hashSyncToken(TOKEN),
    active: true,
  });

  try {
    return await run({ id, code, branchId });
  } finally {
    await cleanupTestFacility(cloud.db, id);
    await cleanupTestFacility(clinic.db, id);
  }
}

function applyBatchOnCloud(facilityId: string, rows: SyncRow[]) {
  return cloud.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
    return applySyncBatch(tx, facilityId, DEVICE, rows);
  });
}

function outboxRow(
  facilityId: string,
  tableName: string,
  payload: Record<string, unknown>,
  overrides: Partial<SyncRow> = {},
): SyncRow {
  return {
    outboxId: newId(),
    facilityId,
    deviceKey: DEVICE,
    tableName,
    recordId: String(payload.id ?? `${facilityId}:mrn:2026`),
    operation: "INSERT",
    payload,
    ...overrides,
  };
}

beforeAll(async () => {
  await ensureClinicDatabase();
  cloud = createTestDatabase();
  // The test process runs APP_MODE=cloud, but this database represents a
  // branch server and must still capture local writes into its own outbox.
  clinic = createDatabase(syncDatabaseUrl(), "clinic");
  await migrate(clinic.db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
});

afterAll(async () => {
  await Promise.all([cloud.pool.end(), clinic.pool.end()]);
});

describe("sync capture triggers", () => {
  it("captures a full row for local writes and skips inbound applies", async () => {
    await withPairedFacility(async ({ id }) => {
      const suppressedId = newId();
      await clinic.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
        await tx.insert(patients).values({
          id: suppressedId,
          facilityId: id,
          mrn: `${id.slice(0, 6)}-SUPP`,
          firstName: "Suppressed",
          lastName: "Row",
          sex: "female",
          createdBy: "vitest",
        });
      });

      const suppressed = await clinic.db
        .select()
        .from(syncOutbox)
        .where(and(eq(syncOutbox.facilityId, id), eq(syncOutbox.recordId, suppressedId)));
      expect(suppressed).toHaveLength(0);

      const capturedId = newId();
      await clinic.db.insert(patients).values({
        id: capturedId,
        facilityId: id,
        mrn: `${id.slice(0, 6)}-CAP`,
        firstName: "Captured",
        lastName: "Row",
        sex: "male",
        createdBy: "vitest",
      });

      const captured = await clinic.db
        .select()
        .from(syncOutbox)
        .where(and(eq(syncOutbox.facilityId, id), eq(syncOutbox.recordId, capturedId)));
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        tableName: "patients",
        operation: "INSERT",
        status: "pending",
        attempts: 0,
      });
      expect(captured[0].payload).toMatchObject({
        id: capturedId,
        facility_id: id,
        first_name: "Captured",
        created_by: "vitest",
      });
    });
  });
});

describe("sync token authentication", () => {
  it("rejects missing, invalid and mismatched tokens", async () => {
    await withPairedFacility(async ({ id }) => {
      await expect(authorizeSyncToken(cloud.db, null, DEVICE, id)).rejects.toMatchObject({
        status: 401,
      });
      await expect(authorizeSyncToken(cloud.db, "Bearer wrong-token", DEVICE, id)).rejects.toBeInstanceOf(
        SyncAuthError,
      );
      await expect(
        authorizeSyncToken(cloud.db, `Bearer ${TOKEN}`, DEVICE, newId()),
      ).rejects.toMatchObject({ status: 403 });

      const principal = await authorizeSyncToken(cloud.db, `Bearer ${TOKEN}`, DEVICE, id);
      expect(principal).toMatchObject({ facilityId: id, deviceKey: DEVICE });
    });
  });

  it("rejects facilities whose write authority is cloud", async () => {
    await withPairedFacility(async ({ id }) => {
      await cloud.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
        await tx.execute(sql`
          UPDATE facilities SET write_authority = 'cloud'::write_authority WHERE id = ${id}::uuid
        `);
      });
      await expect(
        authorizeSyncToken(cloud.db, `Bearer ${TOKEN}`, DEVICE, id),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it("rejects an expired token and stores only its hash", async () => {
    await withPairedFacility(async ({ id }) => {
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      const result = await rotateFacilitySyncToken({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        deviceKey: DEVICE,
        tokenHash: hashSyncToken("expired-sync-token"),
        expiresAt,
        actor: { userId: "vitest" },
      }, { database: cloud.db, mode: "cloud" });
      expect(result.expiresAt).toBe(expiresAt);

      await expect(
        authorizeSyncToken(cloud.db, "Bearer expired-sync-token", DEVICE, id),
      ).rejects.toMatchObject({ status: 401 });

      const stored = await cloud.db
        .select()
        .from(facilitySyncTokens)
        .where(eq(facilitySyncTokens.id, result.tokenId));
      expect(stored[0]).toMatchObject({
        tokenHash: hashSyncToken("expired-sync-token"),
        active: true,
      });
      expect(stored[0].tokenHash).not.toContain("expired-sync-token");
    });
  });

  it("rotates and revokes a token without accepting the old secret", async () => {
    await withPairedFacility(async ({ id }) => {
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      const first = await rotateFacilitySyncToken({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        deviceKey: DEVICE,
        tokenHash: hashSyncToken(TOKEN),
        expiresAt: future,
        actor: { userId: "vitest" },
      }, { database: cloud.db, mode: "cloud" });
      expect(await authorizeSyncToken(cloud.db, `Bearer ${TOKEN}`, DEVICE, id)).toMatchObject({
        tokenId: first.tokenId,
        facilityId: id,
      });

      const second = await rotateFacilitySyncToken({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        deviceKey: DEVICE,
        tokenHash: hashSyncToken("rotated-sync-token"),
        expiresAt: future,
        actor: { userId: "vitest" },
      }, { database: cloud.db, mode: "cloud" });
      // Rotation replaces the secret on the same credential record, so audit
      // history keeps pointing at one identity.
      expect(second.tokenId).toBe(first.tokenId);
      await expect(
        authorizeSyncToken(cloud.db, `Bearer ${TOKEN}`, DEVICE, id),
      ).rejects.toMatchObject({ status: 401 });
      expect(await authorizeSyncToken(cloud.db, "Bearer rotated-sync-token", DEVICE, id)).toMatchObject({
        tokenId: second.tokenId,
        facilityId: id,
      });

      expect(await revokeFacilitySyncToken({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        deviceKey: DEVICE,
        actor: { userId: "vitest" },
      }, { database: cloud.db, mode: "cloud" })).toEqual({ revoked: 1 });
      await expect(
        authorizeSyncToken(cloud.db, "Bearer rotated-sync-token", DEVICE, id),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});

describe("cloud batch rules", () => {
  it("deduplicates by outbox id and refuses an older version", async () => {
    await withPairedFacility(async ({ id }) => {
      const recordId = newId();
      await cloud.db.insert(patients).values({
        id: recordId,
        facilityId: id,
        mrn: `${id.slice(0, 6)}-VER`,
        firstName: "Newest",
        lastName: "Record",
        sex: "female",
        version: 5,
        createdBy: "vitest",
      });

      const stale = outboxRow(id, "patients", {
        id: recordId,
        facility_id: id,
        mrn: `${id.slice(0, 6)}-VER`,
        first_name: "Stale",
        last_name: "Record",
        dob_estimated: false,
        sex: "female",
        payer_type: "cash",
        version: 3,
        created_by: "vitest",
        updated_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { operation: "UPDATE", version: 3 });

      const first = await applyBatchOnCloud(id, [stale]);
      expect(first.acceptedOutboxIds).toEqual([stale.outboxId]);
      let rows = await cloud.db.select().from(patients).where(eq(patients.id, recordId));
      expect(rows[0]).toMatchObject({ firstName: "Newest", version: 5 });

      const replay = await applyBatchOnCloud(id, [stale]);
      expect(replay.acceptedOutboxIds).toEqual([stale.outboxId]);
      rows = await cloud.db.select().from(patients).where(eq(patients.id, recordId));
      expect(rows).toHaveLength(1);

      const equalVersion = outboxRow(id, "patients", {
        ...stale.payload,
        first_name: "SameVersion",
        version: 5,
      }, { operation: "UPDATE", version: 5 });
      await applyBatchOnCloud(id, [equalVersion]);
      rows = await cloud.db.select().from(patients).where(eq(patients.id, recordId));
      expect(rows[0]).toMatchObject({ firstName: "Newest", version: 5 });

      const current = outboxRow(id, "patients", {
        ...stale.payload,
        first_name: "Newer",
        version: 6,
      }, { operation: "UPDATE", version: 6 });
      await applyBatchOnCloud(id, [current]);
      rows = await cloud.db.select().from(patients).where(eq(patients.id, recordId));
      expect(rows[0]).toMatchObject({ firstName: "Newer", version: 6 });
    });
  });

  it("rejects updates and deletes for append-only tables", async () => {
    await withPairedFacility(async ({ id }) => {
      const recordId = newId();
      await cloud.db.insert(auditLog).values({
        id: recordId,
        facilityId: id,
        action: "seed.audit",
        module: "sync",
        entity: "audit_log",
        createdAt: new Date(),
      });

      const row = outboxRow(id, "audit_log", {
        id: recordId,
        facility_id: id,
        action: "mutated.audit",
        module: "sync",
        entity: "audit_log",
        created_at: new Date().toISOString(),
      }, { operation: "UPDATE", version: undefined });

      await expect(applyBatchOnCloud(id, [row])).rejects.toBeInstanceOf(SyncBatchError);
      const rows = await cloud.db.select().from(auditLog).where(eq(auditLog.id, recordId));
      expect(rows[0]).toMatchObject({ action: "seed.audit" });
    });
  });

  it("merges number sequences with the greatest value", async () => {
    await withPairedFacility(async ({ id }) => {
      const payload = {
        facility_id: id,
        scope: "mrn",
        year: 2026,
        next_value: 42,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await cloud.db.execute(sql`
        INSERT INTO number_sequences (facility_id, scope, year, next_value)
        VALUES (${id}::uuid, 'mrn', 2026, 50)
      `);

      const row = outboxRow(id, "number_sequences", payload, {
        recordId: `${id}:mrn:2026`,
      });
      await applyBatchOnCloud(id, [row]);

      const result = await cloud.db.execute(sql`
        SELECT next_value AS "nextValue"
        FROM number_sequences
        WHERE facility_id = ${id}::uuid AND scope = 'mrn' AND year = 2026
      `);
      expect(rowsFrom(result)[0]?.nextValue).toBe(50);
    });
  });
});

describe("retry state", () => {
  it("backs off failures, fails after ten attempts and resets on retry", async () => {
    await withPairedFacility(async ({ id }) => {
      const recordId = newId();
      const inserted = await clinic.db.insert(syncOutbox).values({
        facilityId: id,
        tableName: "patients",
        recordId,
        operation: "INSERT",
        payload: { id: recordId, facility_id: id },
        status: "pending",
      }).returning({ outboxId: syncOutbox.outboxId });
      const outboxId = inserted[0].outboxId;

      await markRowsFailed(clinic.db, [outboxId], "network down");
      let rows = await clinic.db.select().from(syncOutbox).where(eq(syncOutbox.recordId, recordId));
      expect(rows[0]).toMatchObject({ attempts: 1, status: "pending", lastError: "network down" });
      expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      for (let index = 0; index < 9; index += 1) {
        await markRowsFailed(clinic.db, [outboxId], "network down");
      }
      rows = await clinic.db.select().from(syncOutbox).where(eq(syncOutbox.recordId, recordId));
      expect(rows[0]).toMatchObject({ attempts: 10, status: "failed" });

      const failed = await listFailedOutboxIds(clinic.db, id);
      expect(failed).toContain(outboxId);
      expect(await retryOutboxRows(clinic.db, failed, id)).toBe(1);
      rows = await clinic.db.select().from(syncOutbox).where(eq(syncOutbox.recordId, recordId));
      expect(rows[0]).toMatchObject({ attempts: 0, status: "pending", lastError: null });
    });
  });
});

describe("offline patient journey and reconnect", () => {
  it("pushes the complete local journey once and creates no duplicate cloud rows", async () => {
    await withPairedFacility(async ({ id, code, branchId }) => {
      const actor = { userId: "vitest" };
      const registered = await registerPatient({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        firstName: "Amina",
        lastName: "Otieno",
        dob: "1990-04-12",
        sex: "female",
        phone: "0712345678",
        actor,
      }, { database: clinic.db });
      const visit = await startVisit({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        patientId: registered.patientId,
        branchId,
        actor,
      }, { database: clinic.db });
      const triageQueue = await queuePatient({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        encounterId: visit.encounterId,
        department: "Triage",
        actor,
      }, { database: clinic.db });
      const vitals = await recordTriageVitals({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        actor,
        encounterId: visit.encounterId,
        queueEntryId: triageQueue.queueEntryId,
        systolic: 118,
        diastolic: 76,
        heartRate: 72,
        respRate: 16,
        temperature: 36.8,
        spo2: 98,
        weightKg: 64,
        heightCm: 165,
        painScore: 1,
        category: "green",
        chiefComplaint: "Headache for two days",
        nextSteps: "Doctor review",
      }, { database: clinic.db });
      await startConsultation({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        actor,
        encounterId: visit.encounterId,
        queueEntryId: vitals.doctorQueueEntryId,
      }, { database: clinic.db });
      const note = await saveClinicalNote({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        actor,
        encounterId: visit.encounterId,
        subjective: "Headache for two days",
        objective: "Alert and afebrile",
        assessment: "Tension-type headache",
        plan: "Paracetamol and review",
        sign: true,
      }, { database: clinic.db });
      await dischargeEncounter({
        facilityId: id,
        idempotencyKey: newIdempotencyKey(),
        actor,
        encounterId: visit.encounterId,
        outcome: "discharged",
        outcomeNotes: "Symptoms resolved",
      }, { database: clinic.db });

      expect(registered.mrn).toMatch(new RegExp(`^${code}-\\d{2}-\\d{5}$`));
      const pendingBefore = await listPendingRows(clinic.db, 100, id);
      expect(pendingBefore.length).toBeGreaterThan(0);
      expect(pendingBefore.some((row) => row.tableName === "patients")).toBe(true);
      expect(pendingBefore.some((row) => row.tableName === "triage_vitals")).toBe(true);
      expect(pendingBefore.some((row) => row.tableName === "clinical_notes")).toBe(true);
      expect(pendingBefore.some((row) => row.tableName === "audit_log")).toBe(true);

      const offlineFetch = (async () => new Response(JSON.stringify({ status: "error" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
      const offline = await runSyncCycle({
        database: clinic.db,
        facilityId: id,
        token: TOKEN,
        deviceKey: DEVICE,
        cloudUrl: "http://cloud.test",
        batchSize: 100,
        timeoutMs: 100,
        fetchImpl: offlineFetch,
      });
      expect(offline).toMatchObject({ online: false, pushed: 0, pulled: 0 });
      expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toHaveLength(0);

      const reconnectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/sync/batch")) {
          expect(init?.headers).toMatchObject({
            authorization: `Bearer ${TOKEN}`,
            "x-device-key": DEVICE,
            [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION),
          });
          const body = JSON.parse(String(init?.body)) as {
            facilityId: string;
            deviceKey: string;
            rows: SyncRow[];
          };
          const result = await applyBatchOnCloud(body.facilityId, body.rows);
          return new Response(JSON.stringify(result), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/sync/pull")) {
          expect(init?.headers).toMatchObject({
            authorization: `Bearer ${TOKEN}`,
            "x-device-key": DEVICE,
            [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION),
          });
          return new Response(JSON.stringify({ rows: [], pulledAt: new Date().toISOString() }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION),
            },
          });
        }
        throw new Error(`Unexpected worker request: ${url}`);
      }) as typeof fetch;

      const reconnected = await runSyncCycle({
        database: clinic.db,
        facilityId: id,
        token: TOKEN,
        deviceKey: DEVICE,
        cloudUrl: "http://cloud.test",
        batchSize: 100,
        timeoutMs: 100,
        fetchImpl: reconnectFetch,
      });
      expect(reconnected.online).toBe(true);
      expect(reconnected.errors).toEqual([]);
      expect(reconnected.pushed).toBe(pendingBefore.length);

      expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toMatchObject([
        { id: registered.patientId, mrn: registered.mrn, firstName: "Amina", lastName: "Otieno" },
      ]);
      expect(await cloud.db.select().from(encounters).where(eq(encounters.id, visit.encounterId))).toMatchObject([
        { id: visit.encounterId, status: "discharged", outcome: "Symptoms resolved" },
      ]);
      expect(await cloud.db.select().from(triageVitals).where(eq(triageVitals.encounterId, visit.encounterId))).toHaveLength(1);
      expect(await cloud.db.select().from(clinicalNotes).where(eq(clinicalNotes.id, note.noteId))).toMatchObject([
        { id: note.noteId, assessment: "Tension-type headache" },
      ]);
      const cloudQueueRows = await cloud.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.encounterId, visit.encounterId));
      expect(cloudQueueRows).toHaveLength(2);

      const cloudOutbox = await cloud.db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.facilityId, id));
      expect(cloudOutbox).toHaveLength(0);

      const pendingAfter = await listPendingRows(clinic.db, 100, id);
      expect(pendingAfter).toHaveLength(0);

      const replay = await runSyncCycle({
        database: clinic.db,
        facilityId: id,
        token: TOKEN,
        deviceKey: DEVICE,
        cloudUrl: "http://cloud.test",
        batchSize: 100,
        timeoutMs: 100,
        fetchImpl: reconnectFetch,
      });
      expect(replay.online).toBe(true);
      expect(replay.pushed).toBe(0);
      expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toHaveLength(1);
      expect(await cloud.db.select().from(encounters).where(eq(encounters.id, visit.encounterId))).toHaveLength(1);
      expect(await cloud.db.select().from(clinicalNotes).where(eq(clinicalNotes.id, note.noteId))).toHaveLength(1);

      expect(await facilityAuthority(clinic.db, id)).toBe("cloud");
    });
  });
});

describe("cloud pull keyset pagination", () => {
  it("returns every row across pages, including ties on updated_at", async () => {
    await withPairedFacility(async ({ id, branchId }) => {
      const storeIds = Array.from({ length: 5 }, () => newId());
      const stamp = "2026-06-01T10:00:00.000001Z";
      for (const [index, storeId] of storeIds.entries()) {
        await cloud.db.execute(sql`
          INSERT INTO stores (id, facility_id, branch_id, name, kind, created_at, updated_at)
          VALUES (
            ${storeId}::uuid, ${id}::uuid, ${branchId}::uuid,
            ${`Store ${index}`}, 'main',
            ${stamp}::timestamptz, ${stamp}::timestamptz
          )
        `);
      }

      const first = await readPullRows(cloud.db, id, {}, 2);
      const second = await readPullRows(cloud.db, id, first.cursors, 2);
      const third = await readPullRows(cloud.db, id, second.cursors, 2);
      const fourth = await readPullRows(cloud.db, id, third.cursors, 2);

      const pulledIds = [first, second, third, fourth]
        .flatMap((page) => page.rows)
        .filter((row) => row.tableName === "stores")
        .map((row) => String(row.payload.id));

      expect(first.rows.filter((row) => row.tableName === "stores")).toHaveLength(2);
      expect(second.rows.filter((row) => row.tableName === "stores")).toHaveLength(2);
      expect(third.rows.filter((row) => row.tableName === "stores")).toHaveLength(1);
      expect(fourth.rows.filter((row) => row.tableName === "stores")).toHaveLength(0);
      expect(new Set(pulledIds).size).toBe(storeIds.length);
      expect(pulledIds).toEqual(expect.arrayContaining(storeIds));

      // The cursor keeps microsecond precision so the last row is not re-read.
      expect(third.cursors.stores?.updatedAt).toBe(stamp);
      expect(pullCursorsSchema.safeParse(third.cursors).success).toBe(true);
    });
  });

  it("keeps pull checkpoints per facility", async () => {
    await withPairedFacility(async ({ id: facilityA }) => {
      await withPairedFacility(async ({ id: facilityB }) => {
        const cursorA = { stores: { updatedAt: "2026-06-01T00:00:00.000000Z", id: newId() } };
        const cursorB = { stores: { updatedAt: "2026-07-01T00:00:00.000000Z", id: newId() } };

        await clinic.db.transaction(async (tx) => {
          await applyPullRows(tx, [], facilityA, cursorA, "2026-06-01T00:00:01.000Z");
        });
        await clinic.db.transaction(async (tx) => {
          await applyPullRows(tx, [], facilityB, cursorB, "2026-07-01T00:00:01.000Z");
        });

        const stateA = await readSyncState(clinic.db, pullCursorStateKey(facilityA));
        const stateB = await readSyncState(clinic.db, pullCursorStateKey(facilityB));
        expect(stateA?.tables).toEqual(cursorA);
        expect(stateB?.tables).toEqual(cursorB);
        expect(await readSyncState(clinic.db, pullCursorStateKey(newId()))).toBeNull();
      });
    });
  });

  it("scopes auth rows to the pulling facility and strips provider tokens", async () => {
    await withPairedFacility(async ({ id: facilityA }) => {
      await withPairedFacility(async ({ id: facilityB }) => {
        const suffix = randomUUID().slice(0, 8);
        const userIdA = `pull-a-${suffix}`;
        const userIdB = `pull-b-${suffix}`;
        const now = new Date();

        for (const [userId, facilityId] of [[userIdA, facilityA], [userIdB, facilityB]] as const) {
          await cloud.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
            await tx.insert(user).values({
              id: userId,
              name: `Pull User ${userId}`,
              email: `${userId}@test.local`,
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            });
            await tx.insert(staffProfiles).values({
              id: newId(),
              userId,
              staffNumber: `PULL-${userId}`.toUpperCase().slice(0, 32),
              createdAt: now,
              updatedAt: now,
            });
            await tx.insert(staffRoleScopes).values({
              id: newId(),
              userId,
              role: "admin",
              facilityId,
              createdAt: now,
              updatedAt: now,
            });
            await tx.insert(account).values({
              id: newId(),
              accountId: userId,
              providerId: "credential",
              userId,
              password: "hash-kept-for-offline-login",
              accessToken: "secret-provider-token",
              refreshToken: "secret-refresh-token",
              idToken: "secret-id-token",
              createdAt: now,
              updatedAt: now,
            });
          });
        }

        const page = await readPullRows(cloud.db, facilityA, {}, 1000);
        const pulledUsers = page.rows
          .filter((row) => row.tableName === "user")
          .map((row) => String(row.payload.id));
        expect(pulledUsers).toContain(userIdA);
        expect(pulledUsers).not.toContain(userIdB);

        const pulledAccount = page.rows.find((row) => row.tableName === "account");
        expect(pulledAccount).toBeDefined();
        expect(pulledAccount?.payload).toMatchObject({
          user_id: userIdA,
          password: "hash-kept-for-offline-login",
          access_token: null,
          refresh_token: null,
          id_token: null,
        });
      });
    });
  });
});

describe("sync hardening", () => {
  it("does not capture direct cloud writes to cloud-authority facilities", async () => {
    const cloudNode = createDatabase(DATABASE_URL, "cloud");
    const id = newId();
    const code = `CLOUD-${randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      const roleResult = await cloudNode.db.execute(
        sql`select current_setting('application_name') as application_name`,
      );
      expect(rowsFrom(roleResult)[0]?.application_name).toBe("varian-cloud");

      await cloudNode.db.insert(facilities).values({
        id,
        code,
        name: `Cloud Owned ${code}`,
        writeAuthority: "cloud",
        active: true,
        createdBy: "vitest",
      });
      const recordId = newId();
      await cloudNode.db.insert(patients).values({
        id: recordId,
        facilityId: id,
        mrn: `${code}-DIRECT`,
        firstName: "Direct",
        lastName: "Cloud Write",
        sex: "female",
        createdBy: "vitest",
      });
      const captured = await cloudNode.db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.facilityId, id));
      expect(captured).toHaveLength(0);
    } finally {
      await cleanupTestFacility(cloudNode.db, id);
      await cloudNode.pool.end();
    }
  });

  it("keeps the TypeScript registry in sync with SQL sync_tables", async () => {
    const result = await cloud.db.execute(sql`
      SELECT table_name FROM sync_tables WHERE capture = true ORDER BY table_name
    `);
    const registered = rowsFrom(result).map((row) => String(row.table_name)).sort();
    expect(registered).toEqual([...SYNC_OUTBOUND_TABLES].sort());
  });

  it("keeps the no-hard-delete registry in sync with SQL sync_tables", async () => {
    const result = await cloud.db.execute(sql`
      SELECT table_name FROM sync_tables WHERE no_hard_delete = true ORDER BY table_name
    `);
    const registered = rowsFrom(result).map((row) => String(row.table_name)).sort();
    expect(registered).toEqual([...SYNC_NO_HARD_DELETE_TABLES].sort());
  });

  it("does not delete a missing versioned row", async () => {
    const result = await cloud.db.execute(sql`
      SELECT delete_sync_row('facilities', ${JSON.stringify({ id: newId(), version: 1 })}::jsonb, false) AS deleted
    `);
    expect(rowsFrom(result)[0]?.deleted).toBe(false);
  });

  it("refuses hard deletes of protected clinical records from commands and sync", async () => {
    await withPairedFacility(async ({ id, branchId }) => {
      const patientId = newId();
      const encounterId = newId();
      const noteId = newId();
      await cloud.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
        await tx.insert(patients).values({
          id: patientId,
          facilityId: id,
          mrn: `${id.slice(0, 6)}-NHD`,
          firstName: "No",
          lastName: "Delete",
          sex: "female",
          createdBy: "vitest",
        });
        await tx.insert(encounters).values({
          id: encounterId,
          facilityId: id,
          branchId,
          patientId,
          encounterNo: `${id.slice(0, 6)}-NHD-1`,
          createdBy: "vitest",
        });
        await tx.insert(clinicalNotes).values({
          id: noteId,
          facilityId: id,
          encounterId,
          assessment: "Protected note",
          authorId: "vitest",
          createdBy: "vitest",
        });
      });

      const client = await cloud.pool.connect();
      try {
        await expect(client.query("DELETE FROM clinical_notes WHERE id = $1", [noteId]))
          .rejects.toThrow(/cannot be hard-deleted/);
        await expect(client.query(
          "SELECT delete_sync_row('clinical_notes', $1::jsonb, true) AS deleted",
          [JSON.stringify({ id: noteId, version: 1 })],
        )).rejects.toThrow(/cannot be hard-deleted/);
      } finally {
        client.release();
      }

      const deleteRow = outboxRow(id, "clinical_notes", {
        id: noteId,
        facility_id: id,
        version: 1,
      }, { operation: "DELETE" });
      await expect(applyBatchOnCloud(id, [deleteRow])).rejects.toBeInstanceOf(SyncBatchError);

      const notes = await cloud.db
        .select()
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, noteId));
      expect(notes).toHaveLength(1);
      expect(notes[0].assessment).toBe("Protected note");
    });
  });
});
