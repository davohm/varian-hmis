import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  openCashierSession,
  openInvoice,
  takePayment,
} from "../src/server/commands/billing";
import {
  dischargeEncounter,
  orderLabTests,
  prescribe,
  saveClinicalNote,
  startConsultation,
} from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import {
  collectLabSample,
  enterLabResults,
  verifyLabResults,
} from "../src/server/commands/lab";
import { registerPatient } from "../src/server/commands/patients";
import {
  dispensePrescription,
  receiveStock,
} from "../src/server/commands/pharmacy";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import { createDatabase } from "../src/server/db/client";
import {
  branches,
  cashierSessions,
  charges,
  clinicalNotes,
  dispenses,
  encounters,
  facilities,
  facilitySyncTokens,
  invoices,
  items,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  patients,
  payments,
  priceLists,
  prices,
  prescriptions,
  queueEntries,
  services,
  stockLedger,
  stores,
  syncOutbox,
  triageVitals,
} from "../src/server/db/schema";
import { DATABASE_URL } from "../src/server/env";
import { seedRegulatoryDefaults } from "../src/server/regulatory-seed";
import { applySyncBatch } from "../src/server/sync/batch";
import { hashSyncToken } from "../src/server/sync/auth";
import { listPendingRows } from "../src/server/sync/outbox";
import type { SyncRow } from "../src/server/sync/types";
import {
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
} from "../src/server/sync/version";
import { runSyncCycle } from "../src/server/sync/worker";

import { cleanupTestFacility, createTestDatabase, type TestDatabase } from "./helpers";

const JOURNEY_DATABASE_NAME = "varian-hmis-journey-test";
const TOKEN = "journey-token-for-deterministic-tests";
const DEVICE = "clinic-server";
const ACTOR = { userId: "vitest", deviceId: "journey-station" };

let cloud: TestDatabase;
let clinic: ReturnType<typeof createDatabase>;

function journeyDatabaseUrl(): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${JOURNEY_DATABASE_NAME}`;
  return url.toString();
}

async function ensureClinicDatabase(): Promise<void> {
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      JOURNEY_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${JOURNEY_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

interface JourneyFixture {
  id: string;
  code: string;
  branchId: string;
  pharmacyStoreId: string;
  labTestId: string;
  drugId: string;
  consultationServiceId: string;
  labServiceId: string;
}

async function insertFixture(
  database: TestDatabase["db"],
  params: {
    id: string;
    code: string;
    branchId: string;
    pharmacyStoreId: string;
    labTestId: string;
    drugId: string;
    consultationServiceId: string;
    labServiceId: string;
    facilityAuthority: "cloud" | "clinic";
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    // Fixture rows are shared setup, not part of the patient journey outbox.
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
    await tx.insert(facilities).values({
      id: params.id,
      code: params.code,
      name: `Journey ${params.code}`,
      writeAuthority: params.facilityAuthority,
      active: true,
      createdBy: "vitest",
    });
    await tx.insert(branches).values({
      id: params.branchId,
      facilityId: params.id,
      code: "MAIN",
      name: "Main Branch",
      isMain: true,
      createdBy: "vitest",
    });
    await seedRegulatoryDefaults(
      tx as unknown as Parameters<typeof seedRegulatoryDefaults>[0],
      params.id,
      { createdBy: "vitest" },
    );
    await tx.insert(stores).values({
      id: params.pharmacyStoreId,
      facilityId: params.id,
      branchId: params.branchId,
      name: "Pharmacy",
      kind: "pharmacy",
      createdBy: "vitest",
    });
    await tx.insert(labTests).values({
      id: params.labTestId,
      facilityId: params.id,
      code: `HGB-${params.code}`,
      name: "Haemoglobin",
      sampleType: "Whole blood (EDTA)",
      parameters: [
        {
          name: "Haemoglobin",
          unit: "g/dL",
          refLow: 12,
          refHigh: 17,
          criticalLow: 7,
          criticalHigh: 20,
        },
      ],
      createdBy: "vitest",
    });
    await tx.insert(items).values({
      id: params.drugId,
      facilityId: params.id,
      code: `PARA-${params.code}`,
      name: "Paracetamol",
      kind: "drug",
      unit: "tablet",
      strength: "500 mg",
      form: "Tablet",
      createdBy: "vitest",
    });
    await tx.insert(services).values([
      {
        id: params.consultationServiceId,
        facilityId: params.id,
        code: `CONS-${params.code}`,
        name: "Consultation",
        kind: "consultation",
        defaultPrice: "1000.00",
        createdBy: "vitest",
      },
      {
        id: params.labServiceId,
        facilityId: params.id,
        code: `HGB-${params.code}`,
        name: "Laboratory: Haemoglobin",
        kind: "lab",
        defaultPrice: "800.00",
        createdBy: "vitest",
      },
    ]);
    const priceListId = newId();
    await tx.insert(priceLists).values({
      id: priceListId,
      facilityId: params.id,
      name: "Cash price list",
      payerType: "cash",
      createdBy: "vitest",
    });
    await tx.insert(prices).values([
      {
        id: newId(),
        facilityId: params.id,
        priceListId,
        serviceId: params.consultationServiceId,
        itemId: null,
        amount: "1000.00",
        createdBy: "vitest",
      },
      {
        id: newId(),
        facilityId: params.id,
        priceListId,
        serviceId: params.labServiceId,
        itemId: null,
        amount: "800.00",
        createdBy: "vitest",
      },
      {
        id: newId(),
        facilityId: params.id,
        priceListId,
        serviceId: null,
        itemId: params.drugId,
        amount: "2.00",
        createdBy: "vitest",
      },
    ]);
  });
}

async function withJourneyFacility<T>(run: (fixture: JourneyFixture) => Promise<T>): Promise<T> {
  const id = newId();
  const code = `JRN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const fixture: JourneyFixture = {
    id,
    code,
    branchId: newId(),
    pharmacyStoreId: newId(),
    labTestId: newId(),
    drugId: newId(),
    consultationServiceId: newId(),
    labServiceId: newId(),
  };

  // The cloud row must be clinic-authority so the sync token authorises. The
  // isolated branch row stays cloud-authority because the test process runs in
  // APP_MODE=cloud while exercising the real command pipeline.
  await insertFixture(cloud.db, { ...fixture, facilityAuthority: "clinic" });
  await insertFixture(clinic.db, { ...fixture, facilityAuthority: "cloud" });
  await cloud.db.insert(facilitySyncTokens).values({
    facilityId: id,
    deviceKey: DEVICE,
    tokenHash: hashSyncToken(TOKEN),
    active: true,
  });

  try {
    return await run(fixture);
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

function reconnectFetch() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
}

async function syncUntilDrained(facilityId: string): Promise<{ pushed: number; cycles: number }> {
  const fetchImpl = reconnectFetch();
  let pushed = 0;
  let cycles = 0;
  for (; cycles < 10; cycles += 1) {
    const result = await runSyncCycle({
      database: clinic.db,
      facilityId,
      token: TOKEN,
      deviceKey: DEVICE,
      cloudUrl: "http://cloud.test",
      batchSize: 100,
      timeoutMs: 5_000,
      fetchImpl,
    });
    expect(result.online).toBe(true);
    expect(result.errors).toEqual([]);
    pushed += result.pushed;
    if (result.pushed === 0) break;
  }
  expect(await listPendingRows(clinic.db, 1_000, facilityId)).toHaveLength(0);
  return { pushed, cycles: cycles + 1 };
}

beforeAll(async () => {
  await ensureClinicDatabase();
  cloud = createTestDatabase();
  clinic = createDatabase(journeyDatabaseUrl(), "clinic");
  await migrate(clinic.db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
});

afterAll(async () => {
  await Promise.all([cloud?.pool.end(), clinic?.pool.end()]);
});

describe("full offline patient journey and reconnect", () => {
  it(
    "carries registration, triage, lab, pharmacy, billing and payment to the cloud exactly once",
    async () => {
      await withJourneyFacility(async (fixture) => {
        const registered = await registerPatient({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          firstName: "Amina",
          lastName: "Otieno",
          dob: "1990-04-12",
          sex: "female",
          phone: "0712345678",
        }, { database: clinic.db });

        const visit = await startVisit({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          patientId: registered.patientId,
          branchId: fixture.branchId,
          payerType: "cash",
        }, { database: clinic.db });

        const triageQueue = await queuePatient({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          department: "Triage",
        }, { database: clinic.db });

        const vitals = await recordTriageVitals({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
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
          nextSteps: "Doctor review and laboratory tests",
        }, { database: clinic.db });

        await startConsultation({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          queueEntryId: vitals.doctorQueueEntryId,
        }, { database: clinic.db });

        const note = await saveClinicalNote({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          subjective: "Headache for two days",
          objective: "Alert and afebrile",
          assessment: "Tension-type headache",
          plan: "Paracetamol, laboratory review and review if worsening",
          sign: true,
        }, { database: clinic.db });

        const labOrder = await orderLabTests({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labTestIds: [fixture.labTestId],
          clinicalNotes: "Rule out anaemia",
        }, { database: clinic.db });

        await collectLabSample({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: labOrder.labOrderId,
        }, { database: clinic.db });

        const [labOrderItem] = await clinic.db
          .select()
          .from(labOrderItems)
          .where(eq(labOrderItems.labOrderId, labOrder.labOrderId));
        expect(labOrderItem).toBeDefined();

        await enterLabResults({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: labOrder.labOrderId,
          results: [
            {
              labOrderItemId: labOrderItem!.id,
              parameter: "Haemoglobin",
              value: "14.2",
            },
          ],
        }, { database: clinic.db });

        const verifiedLab = await verifyLabResults({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: labOrder.labOrderId,
        }, { database: clinic.db });
        expect(verifiedLab.status).toBe("verified");

        const prescription = await prescribe({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          itemId: fixture.drugId,
          dose: "1 tablet",
          route: "oral",
          frequency: "three times daily",
          durationDays: 5,
          quantity: 10,
          instructions: "Take after food",
        }, { database: clinic.db });

        await receiveStock({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          storeId: fixture.pharmacyStoreId,
          itemId: fixture.drugId,
          batchNo: "JOURNEY-BATCH",
          quantity: 100,
          unitCost: 2,
        }, { database: clinic.db });

        const dispensed = await dispensePrescription({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: prescription.prescriptionId,
          storeId: fixture.pharmacyStoreId,
          quantity: 10,
        }, { database: clinic.db });
        expect(dispensed.status).toBe("dispensed");

        await openCashierSession({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          branchId: fixture.branchId,
          openingFloat: 0,
        }, { database: clinic.db });

        const invoice = await openInvoice({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
        }, { database: clinic.db });
        expect(invoice.chargeCount).toBeGreaterThan(0);

        const paid = await takePayment({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: invoice.invoiceId,
          tenders: [{ method: "cash", amount: Number(invoice.total) }],
        }, { database: clinic.db });
        expect(paid.status).toBe("paid");

        await dischargeEncounter({
          facilityId: fixture.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          outcome: "discharged",
          outcomeNotes: "Laboratory result reviewed and medicine dispensed",
        }, { database: clinic.db });

        const pendingBefore = await listPendingRows(clinic.db, 1_000, fixture.id);
        expect(pendingBefore.length).toBeGreaterThan(0);
        for (const tableName of [
          "patients",
          "encounters",
          "queue_entries",
          "triage_vitals",
          "clinical_notes",
          "lab_orders",
          "lab_results",
          "prescriptions",
          "dispenses",
          "stock_ledger",
          "invoices",
          "charges",
          "payments",
          "audit_log",
        ]) {
          expect(
            pendingBefore.some((row) => row.tableName === tableName),
            `missing ${tableName} in outbox`,
          ).toBe(true);
        }

        const offlineFetch = (async () => new Response(JSON.stringify({ status: "error" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
        const offline = await runSyncCycle({
          database: clinic.db,
          facilityId: fixture.id,
          token: TOKEN,
          deviceKey: DEVICE,
          cloudUrl: "http://cloud.test",
          batchSize: 100,
          timeoutMs: 100,
          fetchImpl: offlineFetch,
        });
        expect(offline).toMatchObject({ online: false, pushed: 0, pulled: 0 });
        expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toHaveLength(0);

        const synced = await syncUntilDrained(fixture.id);
        expect(synced.pushed).toBe(pendingBefore.length);

        expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toHaveLength(1);
        expect(await cloud.db.select().from(encounters).where(eq(encounters.id, visit.encounterId))).toMatchObject([
          { id: visit.encounterId, status: "discharged" },
        ]);
        expect(await cloud.db.select().from(triageVitals).where(eq(triageVitals.encounterId, visit.encounterId))).toHaveLength(1);
        expect(await cloud.db.select().from(clinicalNotes).where(eq(clinicalNotes.id, note.noteId))).toHaveLength(1);
        expect(await cloud.db.select().from(queueEntries).where(eq(queueEntries.encounterId, visit.encounterId))).toHaveLength(2);
        expect(await cloud.db.select().from(labOrders).where(eq(labOrders.id, labOrder.labOrderId))).toMatchObject([
          { id: labOrder.labOrderId, status: "verified" },
        ]);
        expect(await cloud.db.select().from(labResults).where(eq(labResults.facilityId, fixture.id))).toHaveLength(1);
        expect(await cloud.db.select().from(prescriptions).where(eq(prescriptions.facilityId, fixture.id))).toHaveLength(1);
        expect(await cloud.db.select().from(dispenses).where(eq(dispenses.facilityId, fixture.id))).toHaveLength(1);
        expect((await cloud.db.select().from(stockLedger).where(eq(stockLedger.facilityId, fixture.id))).length).toBeGreaterThan(0);
        expect(await cloud.db.select().from(invoices).where(eq(invoices.id, invoice.invoiceId))).toHaveLength(1);
        expect(await cloud.db.select().from(charges).where(eq(charges.facilityId, fixture.id))).toHaveLength(invoice.chargeCount);
        expect(await cloud.db.select().from(payments).where(eq(payments.facilityId, fixture.id))).toHaveLength(1);
        expect(await cloud.db.select().from(cashierSessions).where(eq(cashierSessions.facilityId, fixture.id))).toHaveLength(1);

        expect(await cloud.db.select().from(syncOutbox).where(eq(syncOutbox.facilityId, fixture.id))).toHaveLength(0);

        const replay = await runSyncCycle({
          database: clinic.db,
          facilityId: fixture.id,
          token: TOKEN,
          deviceKey: DEVICE,
          cloudUrl: "http://cloud.test",
          batchSize: 100,
          timeoutMs: 5_000,
          fetchImpl: reconnectFetch(),
        });
        expect(replay.online).toBe(true);
        expect(replay.errors).toEqual([]);
        expect(replay.pushed).toBe(0);
        expect(await cloud.db.select().from(patients).where(eq(patients.id, registered.patientId))).toHaveLength(1);
        expect(await cloud.db.select().from(encounters).where(eq(encounters.id, visit.encounterId))).toHaveLength(1);
        expect(await cloud.db.select().from(payments).where(eq(payments.facilityId, fixture.id))).toHaveLength(1);
      });
    },
    60_000,
  );
});
