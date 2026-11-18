import { and, asc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import {
  isBatchExpired,
  remainingQuantity,
  toIsoDate,
  type BatchCandidate,
} from "@/lib/pharmacy";
import { db } from "@/server/db/client";
import {
  dispenses,
  encounters,
  itemBatches,
  items,
  patients,
  prescriptions,
  stockBalances,
  stores,
} from "@/server/db/schema";

export type PharmacyDatabase = typeof db;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export interface PharmacyStore {
  id: string;
  name: string;
  kind: string;
}

export async function listStores(
  database: PharmacyDatabase,
  facilityId: string,
): Promise<PharmacyStore[]> {
  return database
    .select({ id: stores.id, name: stores.name, kind: stores.kind })
    .from(stores)
    .where(eq(stores.facilityId, facilityId))
    .orderBy(asc(stores.kind), asc(stores.name));
}

export async function findPharmacyStore(
  database: PharmacyDatabase,
  facilityId: string,
): Promise<PharmacyStore | null> {
  const rows = await database
    .select({ id: stores.id, name: stores.name, kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.facilityId, facilityId), eq(stores.kind, "pharmacy")))
    .orderBy(asc(stores.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface StockItemOption {
  id: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
  strength: string | null;
  form: string | null;
}

export async function searchStockItems(
  database: PharmacyDatabase,
  facilityId: string,
  term: string,
  limit = 30,
): Promise<StockItemOption[]> {
  const search = term.trim();
  const conditions = [
    or(isNull(items.facilityId), eq(items.facilityId, facilityId)),
  ];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(or(ilike(items.name, pattern), ilike(items.code, pattern))!);
  }
  return database
    .select({
      id: items.id,
      code: items.code,
      name: items.name,
      kind: items.kind,
      unit: items.unit,
      strength: items.strength,
      form: items.form,
    })
    .from(items)
    .where(and(...conditions))
    .orderBy(asc(items.name))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export interface PrescriptionQueueItem {
  prescriptionId: string;
  encounterId: string;
  encounterNo: string;
  patientId: string;
  mrn: string;
  patientName: string;
  dob: string | null;
  sex: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  strength: string | null;
  form: string | null;
  unit: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number;
  dispensedQuantity: number;
  remaining: number;
  status: string;
  instructions: string | null;
  prescribedBy: string;
  prescribedAt: string;
  availableStock: number;
}

/**
 * Prescriptions that still need stock, newest first, with the live balance of
 * the pharmacy store for each medicine. Expired batches are excluded from the
 * "available" figure because they cannot be dispensed.
 */
export async function getPrescriptionQueue(
  database: PharmacyDatabase,
  facilityId: string,
  term = "",
): Promise<PrescriptionQueueItem[]> {
  const search = term.trim();
  const conditions = [
    eq(prescriptions.facilityId, facilityId),
    inArray(prescriptions.status, ["prescribed", "partial"]),
  ];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      or(
        ilike(patients.mrn, pattern),
        ilike(patients.firstName, pattern),
        ilike(patients.lastName, pattern),
        ilike(encounters.encounterNo, pattern),
        ilike(items.name, pattern),
        ilike(items.code, pattern),
      )!,
    );
  }

  const rows = await database
    .select({
      prescriptionId: prescriptions.id,
      encounterId: prescriptions.encounterId,
      encounterNo: encounters.encounterNo,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      sex: patients.sex,
      itemId: items.id,
      itemCode: items.code,
      itemName: items.name,
      strength: items.strength,
      form: items.form,
      unit: items.unit,
      dose: prescriptions.dose,
      route: prescriptions.route,
      frequency: prescriptions.frequency,
      durationDays: prescriptions.durationDays,
      quantity: prescriptions.quantity,
      status: prescriptions.status,
      instructions: prescriptions.instructions,
      prescribedBy: prescriptions.prescribedBy,
      prescribedAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .innerJoin(items, eq(items.id, prescriptions.itemId))
    .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .where(and(...conditions))
    .orderBy(asc(prescriptions.createdAt));

  if (rows.length === 0) return [];

  const prescriptionIds = rows.map((row) => row.prescriptionId);
  const dispensedRows = await database
    .select({
      prescriptionId: dispenses.prescriptionId,
      quantity: sql<number>`coalesce(sum(${dispenses.quantity}), 0)::int`,
    })
    .from(dispenses)
    .where(
      and(
        eq(dispenses.facilityId, facilityId),
        inArray(dispenses.prescriptionId, prescriptionIds),
        isNull(dispenses.reversedAt),
      ),
    )
    .groupBy(dispenses.prescriptionId);
  const dispensedByPrescription = new Map(
    dispensedRows.map((row) => [row.prescriptionId, Number(row.quantity)]),
  );

  const store = await findPharmacyStore(database, facilityId);
  const itemIds = [...new Set(rows.map((row) => row.itemId))];
  const stockByItem = new Map<string, number>();
  if (store && itemIds.length > 0) {
    const stockRows = await database
      .select({
        itemId: stockBalances.itemId,
        quantity: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)::int`,
      })
      .from(stockBalances)
      .innerJoin(itemBatches, eq(itemBatches.id, stockBalances.batchId))
      .where(
        and(
          eq(stockBalances.facilityId, facilityId),
          eq(stockBalances.storeId, store.id),
          inArray(stockBalances.itemId, itemIds),
          or(isNull(itemBatches.expiryDate), gte(itemBatches.expiryDate, toIsoDate(new Date()))),
        ),
      )
      .groupBy(stockBalances.itemId);
    for (const row of stockRows) stockByItem.set(row.itemId, Number(row.quantity));
  }

  return rows.map((row) => {
    const dispensedQuantity = dispensedByPrescription.get(row.prescriptionId) ?? 0;
    return {
      prescriptionId: row.prescriptionId,
      encounterId: row.encounterId,
      encounterNo: row.encounterNo,
      patientId: row.patientId,
      mrn: row.mrn,
      patientName: `${row.firstName} ${row.lastName}`.trim(),
      dob: row.dob,
      sex: row.sex,
      itemId: row.itemId,
      itemCode: row.itemCode,
      itemName: row.itemName,
      strength: row.strength,
      form: row.form,
      unit: row.unit,
      dose: row.dose,
      route: row.route,
      frequency: row.frequency,
      durationDays: row.durationDays,
      quantity: row.quantity,
      dispensedQuantity,
      remaining: remainingQuantity(row.quantity, dispensedQuantity),
      status: row.status,
      instructions: row.instructions,
      prescribedBy: row.prescribedBy,
      prescribedAt: iso(row.prescribedAt)!,
      availableStock: stockByItem.get(row.itemId) ?? 0,
    };
  });
}

export interface DispenseRecord {
  id: string;
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  storeId: string;
  storeName: string;
  quantity: number;
  dispensedBy: string;
  note: string | null;
  reversedAt: string | null;
  createdAt: string;
}

export interface AvailableBatch extends BatchCandidate {
  unitCost: string;
  available: number;
  expired: boolean;
}

export interface PrescriptionDetail {
  prescription: PrescriptionQueueItem;
  dispenses: DispenseRecord[];
  batches: AvailableBatch[];
}

/** One prescription with its dispense history and the FEFO batches to pick from. */
export async function getPrescriptionDetail(
  database: PharmacyDatabase,
  facilityId: string,
  prescriptionId: string,
): Promise<PrescriptionDetail | null> {
  const rows = await database
    .select({
      prescriptionId: prescriptions.id,
      encounterId: prescriptions.encounterId,
      encounterNo: encounters.encounterNo,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      sex: patients.sex,
      itemId: items.id,
      itemCode: items.code,
      itemName: items.name,
      strength: items.strength,
      form: items.form,
      unit: items.unit,
      dose: prescriptions.dose,
      route: prescriptions.route,
      frequency: prescriptions.frequency,
      durationDays: prescriptions.durationDays,
      quantity: prescriptions.quantity,
      status: prescriptions.status,
      instructions: prescriptions.instructions,
      prescribedBy: prescriptions.prescribedBy,
      prescribedAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .innerJoin(items, eq(items.id, prescriptions.itemId))
    .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .where(
      and(
        eq(prescriptions.id, prescriptionId),
        eq(prescriptions.facilityId, facilityId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const dispensedRows = await database
    .select({
      id: dispenses.id,
      batchId: dispenses.batchId,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      storeId: dispenses.storeId,
      storeName: stores.name,
      quantity: dispenses.quantity,
      dispensedBy: dispenses.dispensedBy,
      note: dispenses.note,
      reversedAt: dispenses.reversedAt,
      createdAt: dispenses.createdAt,
    })
    .from(dispenses)
    .innerJoin(itemBatches, eq(itemBatches.id, dispenses.batchId))
    .innerJoin(stores, eq(stores.id, dispenses.storeId))
    .where(
      and(
        eq(dispenses.facilityId, facilityId),
        eq(dispenses.prescriptionId, prescriptionId),
      ),
    )
    .orderBy(asc(dispenses.createdAt));

  const dispensedQuantity = dispensedRows
    .filter((entry) => entry.reversedAt == null)
    .reduce((total, entry) => total + entry.quantity, 0);

  const store = await findPharmacyStore(database, facilityId);
  const batchRows = await database
    .select({
      id: itemBatches.id,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      unitCost: itemBatches.unitCost,
      createdAt: itemBatches.createdAt,
    })
    .from(itemBatches)
    .where(
      and(
        eq(itemBatches.facilityId, facilityId),
        eq(itemBatches.itemId, row.itemId),
      ),
    )
    .orderBy(
      sql`${itemBatches.expiryDate} asc nulls last`,
      asc(itemBatches.createdAt),
      asc(itemBatches.id),
    );

  const balances = new Map<string, number>();
  if (store && batchRows.length > 0) {
    const balanceRows = await database
      .select({
        batchId: stockBalances.batchId,
        quantity: stockBalances.quantity,
      })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.facilityId, facilityId),
          eq(stockBalances.storeId, store.id),
          inArray(
            stockBalances.batchId,
            batchRows.map((batch) => batch.id),
          ),
        ),
      );
    for (const balance of balanceRows) {
      if (balance.batchId) balances.set(balance.batchId, Number(balance.quantity));
    }
  }

  const batches: AvailableBatch[] = batchRows.map((batch) => ({
    id: batch.id,
    batchNo: batch.batchNo,
    expiryDate: batch.expiryDate,
    unitCost: batch.unitCost,
    createdAt: batch.createdAt.toISOString(),
    available: balances.get(batch.id) ?? 0,
    expired: isBatchExpired(batch.expiryDate),
  }));

  return {
    prescription: {
      prescriptionId: row.prescriptionId,
      encounterId: row.encounterId,
      encounterNo: row.encounterNo,
      patientId: row.patientId,
      mrn: row.mrn,
      patientName: `${row.firstName} ${row.lastName}`.trim(),
      dob: row.dob,
      sex: row.sex,
      itemId: row.itemId,
      itemCode: row.itemCode,
      itemName: row.itemName,
      strength: row.strength,
      form: row.form,
      unit: row.unit,
      dose: row.dose,
      route: row.route,
      frequency: row.frequency,
      durationDays: row.durationDays,
      quantity: row.quantity,
      dispensedQuantity,
      remaining: remainingQuantity(row.quantity, dispensedQuantity),
      status: row.status,
      instructions: row.instructions,
      prescribedBy: row.prescribedBy,
      prescribedAt: iso(row.prescribedAt)!,
      availableStock: batches
        .filter((batch) => !batch.expired)
        .reduce((total, batch) => total + Math.max(0, batch.available), 0),
    },
    dispenses: dispensedRows.map((entry) => ({
      id: entry.id,
      batchId: entry.batchId,
      batchNo: entry.batchNo,
      expiryDate: entry.expiryDate,
      storeId: entry.storeId,
      storeName: entry.storeName,
      quantity: entry.quantity,
      dispensedBy: entry.dispensedBy,
      note: entry.note,
      reversedAt: iso(entry.reversedAt),
      createdAt: iso(entry.createdAt)!,
    })),
    batches,
  };
}

export interface StockRow {
  batchId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  strength: string | null;
  form: string | null;
  unit: string;
  batchNo: string;
  expiryDate: string | null;
  unitCost: string;
  storeId: string;
  storeName: string;
  quantity: number;
  expired: boolean;
}

export interface StockListOptions {
  storeId?: string;
  search?: string;
}

export async function listStock(
  database: PharmacyDatabase,
  facilityId: string,
  options: StockListOptions = {},
): Promise<StockRow[]> {
  const search = options.search?.trim() ?? "";
  const conditions = [eq(stockBalances.facilityId, facilityId)];
  if (options.storeId) conditions.push(eq(stockBalances.storeId, options.storeId));
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      or(
        ilike(items.name, pattern),
        ilike(items.code, pattern),
        ilike(itemBatches.batchNo, pattern),
      )!,
    );
  }

  const rows = await database
    .select({
      batchId: itemBatches.id,
      itemId: items.id,
      itemCode: items.code,
      itemName: items.name,
      strength: items.strength,
      form: items.form,
      unit: items.unit,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      unitCost: itemBatches.unitCost,
      storeId: stores.id,
      storeName: stores.name,
      quantity: stockBalances.quantity,
    })
    .from(stockBalances)
    .innerJoin(itemBatches, eq(itemBatches.id, stockBalances.batchId))
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .innerJoin(stores, eq(stores.id, stockBalances.storeId))
    .where(and(...conditions))
    .orderBy(
      asc(items.name),
      sql`${itemBatches.expiryDate} asc nulls last`,
      asc(itemBatches.batchNo),
      asc(stores.name),
    );

  return rows
    .filter((row) => Number(row.quantity) !== 0)
    .map((row) => ({
      batchId: row.batchId,
      itemId: row.itemId,
      itemCode: row.itemCode,
      itemName: row.itemName,
      strength: row.strength,
      form: row.form,
      unit: row.unit,
      batchNo: row.batchNo,
      expiryDate: row.expiryDate,
      unitCost: row.unitCost,
      storeId: row.storeId,
      storeName: row.storeName,
      quantity: Number(row.quantity),
      expired: isBatchExpired(row.expiryDate),
    }));
}
