import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  auditLog,
  branches,
  clinicalNotes,
  commandLog,
  departments,
  diagnoses,
  dispenses,
  encounters,
  facilities,
  itemBatches,
  items,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  nextOfKin,
  numberSequences,
  patients,
  prescriptions,
  queueEntries,
  rooms,
  stockLedger,
  stores,
  triageVitals,
} from "../src/server/db/schema";

export function createTestDatabase() {
  return createDatabase(DATABASE_URL);
}

export type TestDatabase = ReturnType<typeof createTestDatabase>;

export async function insertTestFacility(db: TestDatabase["db"]) {
  const id = newId();
  const code = `TEST-${randomUUID().slice(0, 8).toUpperCase()}`;

  await db.insert(facilities).values({
    id,
    code,
    name: `Test Facility ${code}`,
    writeAuthority: "cloud",
    createdBy: "vitest",
  });

  return { id, code };
}

export async function insertTestBranch(db: TestDatabase["db"], facilityId: string) {
  const id = newId();
  await db.insert(branches).values({
    id,
    facilityId,
    code: `MAIN-${randomUUID().slice(0, 6).toUpperCase()}`,
    name: "Main Branch",
    isMain: true,
    createdBy: "vitest",
  });
  return id;
}

export async function cleanupTestFacility(db: TestDatabase["db"], facilityId: string) {
  await db.transaction(async (tx) => {
    // The stock ledger trigger rejects deletes outside test cleanup.
    await tx.execute(sql`SET LOCAL varian.ledger_cleanup = 'on'`);
    await tx.delete(dispenses).where(eq(dispenses.facilityId, facilityId));
    await tx.delete(stockLedger).where(eq(stockLedger.facilityId, facilityId));
    await tx.delete(itemBatches).where(eq(itemBatches.facilityId, facilityId));
    await tx.delete(labResults).where(eq(labResults.facilityId, facilityId));
    await tx.delete(labOrderItems).where(eq(labOrderItems.facilityId, facilityId));
    await tx.delete(labOrders).where(eq(labOrders.facilityId, facilityId));
    await tx.delete(prescriptions).where(eq(prescriptions.facilityId, facilityId));
    await tx.delete(diagnoses).where(eq(diagnoses.facilityId, facilityId));
    await tx.delete(clinicalNotes).where(eq(clinicalNotes.facilityId, facilityId));
    await tx.delete(items).where(eq(items.facilityId, facilityId));
    await tx.delete(labTests).where(eq(labTests.facilityId, facilityId));
    await tx.delete(triageVitals).where(eq(triageVitals.facilityId, facilityId));
    await tx.delete(queueEntries).where(eq(queueEntries.facilityId, facilityId));
    await tx.delete(encounters).where(eq(encounters.facilityId, facilityId));
    await tx.delete(nextOfKin).where(eq(nextOfKin.facilityId, facilityId));
    await tx.delete(patients).where(eq(patients.facilityId, facilityId));
    await tx.delete(auditLog).where(eq(auditLog.facilityId, facilityId));
    await tx.delete(commandLog).where(eq(commandLog.facilityId, facilityId));
    await tx.delete(numberSequences).where(eq(numberSequences.facilityId, facilityId));
    await tx.delete(stores).where(eq(stores.facilityId, facilityId));
    await tx.delete(rooms).where(eq(rooms.facilityId, facilityId));
    await tx.delete(departments).where(eq(departments.facilityId, facilityId));
    await tx.delete(branches).where(eq(branches.facilityId, facilityId));
    await tx.delete(facilities).where(eq(facilities.id, facilityId));
  });
}
