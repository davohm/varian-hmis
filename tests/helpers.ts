import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  account,
  auditLog,
  branches,
  cashierSessions,
  charges,
  clinicalNotes,
  commandLog,
  departments,
  diagnoses,
  dispenses,
  encounters,
  facilities,
  facilitySyncTokens,
  invoices,
  itemBatches,
  items,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  nextOfKin,
  numberSequences,
  patients,
  payments,
  prescriptions,
  priceLists,
  prices,
  queueEntries,
  rooms,
  services,
  session,
  stockLedger,
  staffProfiles,
  staffRoleScopes,
  stores,
  syncOutbox,
  syncReceived,
  triageVitals,
  user,
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

export async function insertTestActor(db: TestDatabase["db"]) {
  const id = newId();
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  await db.insert(user).values({
    id,
    name: `Test Admin ${suffix}`,
    email: `admin-${suffix}@test.local`,
    emailVerified: true,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(staffProfiles).values({
    id: newId(),
    userId: id,
    staffNumber: `ADM-${suffix}`.toUpperCase(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function deleteTestActor(db: TestDatabase["db"], userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(staffRoleScopes).where(eq(staffRoleScopes.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(staffProfiles).where(eq(staffProfiles.userId, userId));
    await tx.delete(user).where(eq(user.id, userId));
  });
}

export async function cleanupTestFacility(db: TestDatabase["db"], facilityId: string) {
  await db.transaction(async (tx) => {
    // The stock and payment ledgers reject deletes outside test cleanup, and
    // sync capture must not recreate outbox rows for rows being torn down.
    await tx.execute(sql`SET LOCAL varian.ledger_cleanup = 'on'`);
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

    const scopedUsers = await tx
      .select({ userId: staffRoleScopes.userId })
      .from(staffRoleScopes)
      .where(eq(staffRoleScopes.facilityId, facilityId));
    const userIds = scopedUsers.map((row) => row.userId);
    await tx.delete(staffRoleScopes).where(eq(staffRoleScopes.facilityId, facilityId));
    if (userIds.length) {
      await tx.delete(session).where(inArray(session.userId, userIds));
      await tx.delete(account).where(inArray(account.userId, userIds));
      await tx.delete(staffProfiles).where(inArray(staffProfiles.userId, userIds));
      await tx.delete(user).where(inArray(user.id, userIds));
    }
    // Reversals reference the payment they reverse, so clear them first.
    await tx
      .delete(payments)
      .where(and(eq(payments.facilityId, facilityId), isNotNull(payments.reversedPaymentId)));
    await tx.delete(payments).where(eq(payments.facilityId, facilityId));
    await tx.delete(charges).where(eq(charges.facilityId, facilityId));
    await tx.delete(invoices).where(eq(invoices.facilityId, facilityId));
    await tx.delete(cashierSessions).where(eq(cashierSessions.facilityId, facilityId));
    await tx.delete(prices).where(eq(prices.facilityId, facilityId));
    await tx.delete(priceLists).where(eq(priceLists.facilityId, facilityId));
    await tx.delete(services).where(eq(services.facilityId, facilityId));
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
    await tx.delete(syncOutbox).where(eq(syncOutbox.facilityId, facilityId));
    await tx.delete(syncReceived).where(eq(syncReceived.facilityId, facilityId));
    await tx.delete(facilitySyncTokens).where(eq(facilitySyncTokens.facilityId, facilityId));
    await tx.delete(facilities).where(eq(facilities.id, facilityId));
  });
}
