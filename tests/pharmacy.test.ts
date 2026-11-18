import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  allocateFefo,
  buildDispenseLabel,
  canDispensePrescription,
  canReverseDispense,
  compareFefo,
  isBatchExpired,
  prescriptionStatusAfterDispense,
  remainingQuantity,
  sumAllocations,
} from "../src/lib/pharmacy";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { cancelPrescription, prescribe } from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import {
  adjustStock,
  dispensePrescription,
  receiveStock,
  reverseDispense,
  transferStock,
} from "../src/server/commands/pharmacy";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import {
  dispenses,
  itemBatches,
  items,
  prescriptions,
  stockBalances,
  stockLedger,
  stores,
} from "../src/server/db/schema";
import {
  getPrescriptionDetail,
  getPrescriptionQueue,
  listStock,
} from "../src/server/queries/pharmacy";

import {
  cleanupTestFacility,
  createTestDatabase,
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

const ACTOR = { userId: "vitest", deviceId: "pharmacy-station" };

interface PharmacyFixture {
  facility: { id: string; code: string };
  branchId: string;
  pharmacyStoreId: string;
  mainStoreId: string;
  drug: { id: string; code: string; name: string; unit: string };
  otherDrug: { id: string; code: string; name: string; unit: string };
}

async function insertStore(
  facilityId: string,
  branchId: string,
  name: string,
  kind: "pharmacy" | "main" | "lab",
): Promise<string> {
  const id = newId();
  await ctx.db.insert(stores).values({
    id,
    facilityId,
    branchId,
    name,
    kind,
    createdBy: "vitest",
  });
  return id;
}

/**
 * A facility with its own pharmacy and main stores and two medicines, so every
 * stock rule can be exercised without depending on seed data.
 */
async function withPharmacyFacility<T>(
  run: (fixture: PharmacyFixture) => Promise<T>,
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const pharmacyStoreId = await insertStore(facility.id, branchId, "Pharmacy", "pharmacy");
  const mainStoreId = await insertStore(facility.id, branchId, "Main Store", "main");

  const drug = {
    id: newId(),
    code: `PARA${suffix}`,
    name: `Paracetamol ${suffix}`,
    unit: "tablet",
  };
  const otherDrug = {
    id: newId(),
    code: `AMOX${suffix}`,
    name: `Amoxicillin ${suffix}`,
    unit: "capsule",
  };

  await ctx.db.insert(items).values([
    {
      id: drug.id,
      facilityId: facility.id,
      code: drug.code,
      name: drug.name,
      kind: "drug",
      unit: drug.unit,
      strength: "500 mg",
      form: "Tablet",
      createdBy: "vitest",
    },
    {
      id: otherDrug.id,
      facilityId: facility.id,
      code: otherDrug.code,
      name: otherDrug.name,
      kind: "drug",
      unit: otherDrug.unit,
      strength: "250 mg",
      form: "Capsule",
      createdBy: "vitest",
    },
  ]);

  try {
    return await run({
      facility,
      branchId,
      pharmacyStoreId,
      mainStoreId,
      drug,
      otherDrug,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

function patientInput(
  facilityId: string,
  overrides: Partial<RegisterPatientInput> = {},
): RegisterPatientInput {
  return {
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    firstName: "Amina",
    lastName: "Otieno",
    dob: "1990-04-12",
    sex: "female",
    phone: "0712345678",
    nationalId: `ID-${newId().slice(0, 8)}`,
    allergies: [],
    bloodGroup: "O+",
    actor: ACTOR,
    ...overrides,
  };
}

interface PharmacyVisit {
  patientId: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
}

/** Register, start a visit and triage it so the encounter is open. */
async function createPharmacyVisit(
  fixture: PharmacyFixture,
  overrides: Partial<RegisterPatientInput> = {},
): Promise<PharmacyVisit> {
  const registered = await registerPatient(patientInput(fixture.facility.id, overrides), {
    database: ctx.db,
  });
  const visit = await startVisit(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      patientId: registered.patientId,
      branchId: fixture.branchId,
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  const triage = await queuePatient(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      encounterId: visit.encounterId,
      department: "Triage",
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  await recordTriageVitals(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      queueEntryId: triage.queueEntryId,
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
      chiefComplaint: "Fever for two days",
      comments: "No red flags",
      nextSteps: "Doctor review",
    },
    { database: ctx.db },
  );

  return {
    patientId: registered.patientId,
    mrn: registered.mrn,
    encounterId: visit.encounterId,
    encounterNo: visit.encounterNo,
  };
}

async function prescribeDrug(
  fixture: PharmacyFixture,
  visit: PharmacyVisit,
  quantity: number,
  itemId: string = fixture.drug.id,
) {
  return prescribe(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      itemId,
      dose: "1 tablet",
      route: "oral",
      frequency: "three times daily",
      durationDays: 5,
      quantity,
      instructions: "Take after food",
    },
    { database: ctx.db },
  );
}

async function receive(
  fixture: PharmacyFixture,
  batchNo: string,
  quantity: number,
  options: { expiryDate?: string | null; itemId?: string; storeId?: string; unitCost?: number } = {},
) {
  return receiveStock(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      storeId: options.storeId ?? fixture.pharmacyStoreId,
      itemId: options.itemId ?? fixture.drug.id,
      batchNo,
      expiryDate: options.expiryDate ?? null,
      unitCost: options.unitCost,
      quantity,
    },
    { database: ctx.db },
  );
}

async function balanceOf(
  facilityId: string,
  storeId: string,
  batchId: string,
): Promise<number> {
  const rows = await ctx.db
    .select({ quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.facilityId, facilityId),
        eq(stockBalances.storeId, storeId),
        eq(stockBalances.batchId, batchId),
      ),
    );
  return rows[0] ? Number(rows[0].quantity) : 0;
}

async function prescriptionStatus(prescriptionId: string): Promise<string> {
  const rows = await ctx.db
    .select({ status: prescriptions.status })
    .from(prescriptions)
    .where(eq(prescriptions.id, prescriptionId));
  return rows[0]?.status ?? "missing";
}

function isoOffsetDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */

describe("pharmacy rules", () => {
  it("sorts batches first-expired-first-out with undated batches last", () => {
    const soon = { id: "b", batchNo: "B", expiryDate: "2026-01-10", createdAt: "2026-01-01" };
    const later = { id: "c", batchNo: "C", expiryDate: "2026-03-10", createdAt: "2026-01-02" };
    const none = { id: "d", batchNo: "D", expiryDate: null, createdAt: "2026-01-03" };

    expect(compareFefo(soon, later)).toBeLessThan(0);
    expect(compareFefo(none, later)).toBeGreaterThan(0);

    const sorted = [none, later, soon].sort(compareFefo);
    expect(sorted.map((batch) => batch.batchNo)).toEqual(["B", "C", "D"]);
  });

  it("breaks FEFO ties on arrival time then id so stations agree", () => {
    const first = { id: "z", batchNo: "Z", expiryDate: "2026-01-10", createdAt: "2026-01-01" };
    const second = { id: "a", batchNo: "A", expiryDate: "2026-01-10", createdAt: "2026-01-02" };
    const sameTime = { id: "b", batchNo: "B", expiryDate: "2026-01-10", createdAt: "2026-01-01" };

    expect(compareFefo(first, second)).toBeLessThan(0);
    // Same arrival time: "b" sorts before "z" so every station picks the same row.
    expect(compareFefo(sameTime, first)).toBeLessThan(0);
  });

  it("allocates greedily across batches and stops when covered", () => {
    const allocations = allocateFefo(
      [
        { batchId: "a", available: 5 },
        { batchId: "b", available: 0 },
        { batchId: "c", available: 8 },
      ],
      9,
    );
    expect(allocations).toEqual([
      { batchId: "a", quantity: 5 },
      { batchId: "c", quantity: 4 },
    ]);
    expect(sumAllocations(allocations)).toBe(9);
  });

  it("treats a batch as expired from the day after its expiry date", () => {
    expect(isBatchExpired("2026-11-18", new Date("2026-11-18T09:00:00"))).toBe(false);
    expect(isBatchExpired("2026-11-17", new Date("2026-11-18T09:00:00"))).toBe(true);
    expect(isBatchExpired(null)).toBe(false);
  });

  it("moves a prescription through prescribed, partial and dispensed", () => {
    expect(prescriptionStatusAfterDispense(10, 0)).toBe("prescribed");
    expect(prescriptionStatusAfterDispense(10, 4)).toBe("partial");
    expect(prescriptionStatusAfterDispense(10, 10)).toBe("dispensed");
    expect(remainingQuantity(10, 4)).toBe(6);
    expect(remainingQuantity(10, 12)).toBe(0);
    expect(canDispensePrescription("partial")).toBe(true);
    expect(canDispensePrescription("dispensed")).toBe(false);
    expect(canReverseDispense("dispensed")).toBe(true);
    expect(canReverseDispense("prescribed")).toBe(false);
  });

  it("builds a printable label from the dispense context", () => {
    const label = buildDispenseLabel({
      facilityName: "Family Afya",
      patientName: "Amina Otieno",
      mrn: "FAM-000123",
      encounterNo: "FAM-V-26-000001",
      itemName: "Paracetamol",
      strength: "500 mg",
      form: "Tablet",
      unit: "tablet",
      dose: "1 tablet",
      route: "oral",
      frequency: "three times daily",
      durationDays: 5,
      quantity: 15,
      instructions: "Take after food",
      dispensedAt: new Date("2026-11-18T10:00:00.000Z"),
      prescriptionId: "rx-1",
      pharmacist: "user-1",
    });

    expect(label).toMatchObject({
      facilityName: "Family Afya",
      patientName: "Amina Otieno",
      mrn: "FAM-000123",
      itemName: "Paracetamol",
      quantity: 15,
      dispensedAt: "2026-11-18T10:00:00.000Z",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

describe("receiveStock", () => {
  it("creates a batch and a receive ledger row", async () => {
    await withPharmacyFacility(async (fixture) => {
      const result = await receive(fixture, "BATCH-A", 120, {
        expiryDate: isoOffsetDays(90),
        unitCost: 2.5,
      });

      expect(result.batchNo).toBe("BATCH-A");
      expect(result.quantity).toBe(120);
      expect(result.balance).toBe(120);
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, result.batchId)).toBe(
        120,
      );

      const ledger = await ctx.db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.batchId, result.batchId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        facilityId: fixture.facility.id,
        storeId: fixture.pharmacyStoreId,
        itemId: fixture.drug.id,
        qtyDelta: 120,
        reason: "receive",
        createdBy: "vitest",
      });
    });
  });

  it("reuses an existing batch number and keeps its expiry when omitted", async () => {
    await withPharmacyFacility(async (fixture) => {
      const expiry = isoOffsetDays(30);
      const first = await receive(fixture, "BATCH-A", 50, { expiryDate: expiry });
      const second = await receive(fixture, "BATCH-A", 25);

      expect(second.batchId).toBe(first.batchId);
      expect(second.balance).toBe(75);
      expect(second.expiryDate).toBe(expiry);

      const batches = await ctx.db
        .select()
        .from(itemBatches)
        .where(eq(itemBatches.id, first.batchId));
      expect(batches).toHaveLength(1);
      expect(batches[0].expiryDate).toBe(expiry);
    });
  });

  it("replays an idempotent receive without adding stock twice", async () => {
    await withPharmacyFacility(async (fixture) => {
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        itemId: fixture.drug.id,
        batchNo: "BATCH-A",
        quantity: 40,
      };

      const first = await receiveStock(input, { database: ctx.db });
      const replay = await receiveStock(input, { database: ctx.db });
      expect(replay).toEqual(first);

      const ledger = await ctx.db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.batchId, first.batchId));
      expect(ledger).toHaveLength(1);
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, first.batchId)).toBe(40);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Adjusting and transferring                                          */
/* ------------------------------------------------------------------ */

describe("adjustStock and transferStock", () => {
  it("adjusts a balance in both directions and rejects going negative", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 20);

      const removed = await adjustStock(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          batchId: batch.batchId,
          qtyDelta: -8,
          note: "Breakage",
        },
        { database: ctx.db },
      );
      expect(removed.balance).toBe(12);

      const added = await adjustStock(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          batchId: batch.batchId,
          qtyDelta: 3,
          note: "Count correction",
        },
        { database: ctx.db },
      );
      expect(added.balance).toBe(15);

      await expect(
        adjustStock(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            batchId: batch.batchId,
            qtyDelta: -16,
            note: "Too much",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/negative/);

      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(
        15,
      );
    });
  });

  it("requires a reason for an adjustment", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 5);
      await expect(
        adjustStock(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            batchId: batch.batchId,
            qtyDelta: -1,
            note: "   ",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/reason/i);
    });
  });

  it("writes a paired transfer that moves the balance between stores", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 50);

      const result = await transferStock(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          fromStoreId: fixture.pharmacyStoreId,
          toStoreId: fixture.mainStoreId,
          batchId: batch.batchId,
          quantity: 15,
          note: "Restock main",
        },
        { database: ctx.db },
      );

      expect(result.fromBalance).toBe(35);
      expect(result.toBalance).toBe(15);
      expect(
        await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId),
      ).toBe(35);
      expect(await balanceOf(fixture.facility.id, fixture.mainStoreId, batch.batchId)).toBe(15);

      const transferRows = await ctx.db
        .select()
        .from(stockLedger)
        .where(
          and(
            eq(stockLedger.facilityId, fixture.facility.id),
            eq(stockLedger.refId, result.transferId),
          ),
        );
      expect(transferRows).toHaveLength(2);
      expect(transferRows.map((row) => row.reason).sort()).toEqual([
        "transfer_in",
        "transfer_out",
      ]);
      expect(transferRows.reduce((total, row) => total + row.qtyDelta, 0)).toBe(0);
    });
  });

  it("rejects a transfer that exceeds the source balance or uses one store", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 5);

      await expect(
        transferStock(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            fromStoreId: fixture.pharmacyStoreId,
            toStoreId: fixture.mainStoreId,
            batchId: batch.batchId,
            quantity: 6,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Insufficient stock/);

      await expect(
        transferStock(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            fromStoreId: fixture.pharmacyStoreId,
            toStoreId: fixture.pharmacyStoreId,
            batchId: batch.batchId,
            quantity: 1,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/different stores/);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Dispensing                                                          */
/* ------------------------------------------------------------------ */

describe("dispensePrescription", () => {
  it("dispenses across batches in FEFO order and returns a label", async () => {
    await withPharmacyFacility(async (fixture) => {
      const soon = await receive(fixture, "BATCH-SOON", 10, { expiryDate: isoOffsetDays(10) });
      const later = await receive(fixture, "BATCH-LATER", 10, {
        expiryDate: isoOffsetDays(60),
      });
      const undated = await receive(fixture, "BATCH-NONE", 10);

      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 12);

      const result = await dispensePrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
        },
        { database: ctx.db },
      );

      expect(result.status).toBe("dispensed");
      expect(result.dispensedQuantity).toBe(12);
      expect(result.remaining).toBe(0);
      expect(result.allocations.map((entry) => [entry.batchNo, entry.quantity])).toEqual([
        ["BATCH-SOON", 10],
        ["BATCH-LATER", 2],
      ]);
      expect(result.label).toMatchObject({
        patientName: "Amina Otieno",
        mrn: visit.mrn,
        encounterNo: visit.encounterNo,
        itemName: fixture.drug.name,
        strength: "500 mg",
        form: "Tablet",
        unit: "tablet",
        dose: "1 tablet",
        route: "oral",
        frequency: "three times daily",
        durationDays: 5,
        quantity: 12,
        instructions: "Take after food",
      });

      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, soon.batchId)).toBe(0);
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, later.batchId)).toBe(
        8,
      );
      expect(
        await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, undated.batchId),
      ).toBe(10);
    });
  });

  it("supports partial dispense and closes the prescription on the final fill", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 20);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 10);

      const first = await dispensePrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
          quantity: 4,
        },
        { database: ctx.db },
      );
      expect(first.status).toBe("partial");
      expect(first.totalDispensed).toBe(4);
      expect(first.remaining).toBe(6);
      expect(await prescriptionStatus(rx.prescriptionId)).toBe("partial");
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(
        16,
      );

      const second = await dispensePrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
        },
        { database: ctx.db },
      );
      expect(second.status).toBe("dispensed");
      expect(second.dispensedQuantity).toBe(6);
      expect(await prescriptionStatus(rx.prescriptionId)).toBe("dispensed");

      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already fully dispensed/);
    });
  });

  it("cannot dispense more than a batch balance", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 5);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 20);

      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
            allocations: [{ batchId: batch.batchId, quantity: 6 }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/only 5 in stock/);

      // Auto-allocation also refuses to go past what is on hand.
      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Insufficient stock/);

      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(5);
      expect(await prescriptionStatus(rx.prescriptionId)).toBe("prescribed");
    });
  });

  it("never lets concurrent dispenses take the balance negative", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 5);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 20);

      const attempts = Array.from({ length: 8 }, () =>
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
            quantity: 1,
          },
          { database: ctx.db },
        )
          .then(() => "ok" as const)
          .catch(() => "rejected" as const),
      );

      const outcomes = await Promise.all(attempts);
      const succeeded = outcomes.filter((outcome) => outcome === "ok").length;
      const rejected = outcomes.filter((outcome) => outcome === "rejected").length;

      expect(succeeded).toBe(5);
      expect(rejected).toBe(3);
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(0);

      const negative = await ctx.db
        .select({ batchId: stockBalances.batchId, quantity: stockBalances.quantity })
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.facilityId, fixture.facility.id),
            sql`${stockBalances.quantity} < 0`,
          ),
        );
      expect(negative).toHaveLength(0);

      const dispensed = await ctx.db
        .select({ quantity: dispenses.quantity })
        .from(dispenses)
        .where(eq(dispenses.prescriptionId, rx.prescriptionId));
      expect(dispensed.reduce((total, row) => total + row.quantity, 0)).toBe(5);
    });
  });

  it("rejects expired batches and skips them in the FEFO suggestion", async () => {
    await withPharmacyFacility(async (fixture) => {
      const expired = await receive(fixture, "BATCH-EXPIRED", 10, {
        expiryDate: "2020-01-01",
      });
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 4);

      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
            allocations: [{ batchId: expired.batchId, quantity: 4 }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/expired/);

      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Insufficient stock/);

      const detail = await getPrescriptionDetail(ctx.db, fixture.facility.id, rx.prescriptionId);
      expect(detail?.batches.find((batch) => batch.id === expired.batchId)?.expired).toBe(true);
      expect(detail?.prescription.availableStock).toBe(0);
    });
  });

  it("refuses a cancelled prescription", async () => {
    await withPharmacyFacility(async (fixture) => {
      await receive(fixture, "BATCH-A", 10);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 5);

      await cancelPrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          prescriptionId: rx.prescriptionId,
        },
        { database: ctx.db },
      );

      await expect(
        dispensePrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/cancelled/);
    });
  });

  it("keeps facilities isolated", async () => {
    await withPharmacyFacility(async (fixture) => {
      await receive(fixture, "BATCH-A", 10);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 5);

      const other = await insertTestFacility(ctx.db);
      try {
        await expect(
          dispensePrescription(
            {
              facilityId: other.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              prescriptionId: rx.prescriptionId,
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/Prescription not found/);
      } finally {
        await cleanupTestFacility(ctx.db, other.id);
      }
    });
  });

  it("replays an idempotent dispense without taking stock twice", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 10);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 5);

      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        prescriptionId: rx.prescriptionId,
        quantity: 3,
      };

      const first = await dispensePrescription(input, { database: ctx.db });
      const replay = await dispensePrescription(input, { database: ctx.db });
      expect(replay).toEqual(first);
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(7);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Reversal                                                            */
/* ------------------------------------------------------------------ */

describe("reverseDispense", () => {
  it("restores stock and reopens a partially dispensed prescription", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 10);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 10);

      await dispensePrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
          quantity: 4,
        },
        { database: ctx.db },
      );
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(6);

      const reversed = await reverseDispense(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
          note: "Patient declined",
        },
        { database: ctx.db },
      );
      expect(reversed.status).toBe("prescribed");
      expect(reversed.reversedQuantity).toBe(4);
      expect(await prescriptionStatus(rx.prescriptionId)).toBe("prescribed");
      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(10);

      const rows = await ctx.db
        .select()
        .from(dispenses)
        .where(eq(dispenses.prescriptionId, rx.prescriptionId));
      expect(rows).toHaveLength(1);
      expect(rows[0].reversedAt).not.toBeNull();
      expect(rows[0].reversedBy).toBe("vitest");

      const reversalRows = await ctx.db
        .select()
        .from(stockLedger)
        .where(
          and(
            eq(stockLedger.facilityId, fixture.facility.id),
            eq(stockLedger.reason, "reversal"),
          ),
        );
      expect(reversalRows).toHaveLength(1);
      expect(reversalRows[0].qtyDelta).toBe(4);
    });
  });

  it("requires a reason and refuses a prescription with nothing dispensed", async () => {
    await withPharmacyFacility(async (fixture) => {
      await receive(fixture, "BATCH-A", 10);
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 5);

      await expect(
        reverseDispense(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
            note: "   ",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/reason/i);

      await expect(
        reverseDispense(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            prescriptionId: rx.prescriptionId,
            note: "Nothing to reverse",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/no dispensed stock/);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Append-only ledger and queries                                      */
/* ------------------------------------------------------------------ */

describe("stock ledger and queries", () => {
  it("rejects updates and deletes on the ledger", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 10);

      async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
        try {
          await promise;
        } catch (error) {
          const cause = (error as { cause?: unknown }).cause;
          const detail = cause instanceof Error ? cause.message : String(cause ?? "");
          return `${(error as Error).message} ${detail}`;
        }
        throw new Error("Expected the ledger write to be rejected");
      }

      expect(
        await rejectionMessage(
          ctx.db
            .update(stockLedger)
            .set({ qtyDelta: 999 })
            .where(eq(stockLedger.batchId, batch.batchId)),
        ),
      ).toMatch(/append-only/);

      expect(
        await rejectionMessage(
          ctx.db.delete(stockLedger).where(eq(stockLedger.batchId, batch.batchId)),
        ),
      ).toMatch(/append-only/);

      expect(await balanceOf(fixture.facility.id, fixture.pharmacyStoreId, batch.batchId)).toBe(10);
    });
  });

  it("lists the queue and stock with live balances", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 30, { expiryDate: isoOffsetDays(45) });
      const visit = await createPharmacyVisit(fixture);
      const rx = await prescribeDrug(fixture, visit, 6);

      const queue = await getPrescriptionQueue(ctx.db, fixture.facility.id);
      const queued = queue.find((entry) => entry.prescriptionId === rx.prescriptionId);
      expect(queued).toMatchObject({
        patientName: "Amina Otieno",
        mrn: visit.mrn,
        quantity: 6,
        dispensedQuantity: 0,
        remaining: 6,
        status: "prescribed",
        availableStock: 30,
      });

      await dispensePrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: rx.prescriptionId,
          quantity: 2,
        },
        { database: ctx.db },
      );

      const detail = await getPrescriptionDetail(ctx.db, fixture.facility.id, rx.prescriptionId);
      expect(detail?.prescription).toMatchObject({
        dispensedQuantity: 2,
        remaining: 4,
        status: "partial",
        availableStock: 28,
      });
      expect(detail?.dispenses).toHaveLength(1);
      expect(detail?.dispenses[0]).toMatchObject({
        batchId: batch.batchId,
        batchNo: "BATCH-A",
        quantity: 2,
      });

      const stock = await listStock(ctx.db, fixture.facility.id, {
        storeId: fixture.pharmacyStoreId,
        search: "BATCH-A",
      });
      expect(stock).toHaveLength(1);
      expect(stock[0]).toMatchObject({
        batchId: batch.batchId,
        batchNo: "BATCH-A",
        itemId: fixture.drug.id,
        quantity: 28,
        expired: false,
      });
    });
  });

  it("scopes stock listings to the requested store", async () => {
    await withPharmacyFacility(async (fixture) => {
      const batch = await receive(fixture, "BATCH-A", 20);
      await transferStock(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          fromStoreId: fixture.pharmacyStoreId,
          toStoreId: fixture.mainStoreId,
          batchId: batch.batchId,
          quantity: 5,
        },
        { database: ctx.db },
      );

      const pharmacy = await listStock(ctx.db, fixture.facility.id, {
        storeId: fixture.pharmacyStoreId,
      });
      const main = await listStock(ctx.db, fixture.facility.id, { storeId: fixture.mainStoreId });
      expect(pharmacy[0]?.quantity).toBe(15);
      expect(main[0]?.quantity).toBe(5);
    });
  });
});
