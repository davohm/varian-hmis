import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  auditLog,
  branches,
  commandLog,
  departments,
  encounters,
  facilities,
  nextOfKin,
  numberSequences,
  patients,
  queueEntries,
  rooms,
  stores,
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
  await db.delete(queueEntries).where(eq(queueEntries.facilityId, facilityId));
  await db.delete(encounters).where(eq(encounters.facilityId, facilityId));
  await db.delete(nextOfKin).where(eq(nextOfKin.facilityId, facilityId));
  await db.delete(patients).where(eq(patients.facilityId, facilityId));
  await db.delete(auditLog).where(eq(auditLog.facilityId, facilityId));
  await db.delete(commandLog).where(eq(commandLog.facilityId, facilityId));
  await db.delete(numberSequences).where(eq(numberSequences.facilityId, facilityId));
  await db.delete(stores).where(eq(stores.facilityId, facilityId));
  await db.delete(rooms).where(eq(rooms.facilityId, facilityId));
  await db.delete(departments).where(eq(departments.facilityId, facilityId));
  await db.delete(branches).where(eq(branches.facilityId, facilityId));
  await db.delete(facilities).where(eq(facilities.id, facilityId));
}
