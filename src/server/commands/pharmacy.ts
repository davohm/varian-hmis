import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  allocateFefo,
  buildDispenseLabel,
  canDispensePrescription,
  canReverseDispense,
  isBatchExpired,
  prescriptionStatusAfterDispense,
  remainingQuantity,
  sumAllocations,
  type BatchCandidate,
} from "@/lib/pharmacy";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import {
  dispenses,
  encounters,
  facilities,
  itemBatches,
  items,
  patients,
  prescriptions,
  stockLedger,
  stores,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

interface LoadedStore {
  id: string;
  name: string;
  kind: string;
}

async function loadStore(
  tx: CommandTransaction,
  facilityId: string,
  storeId: string,
): Promise<LoadedStore> {
  const rows = await tx
    .select({ id: stores.id, name: stores.name, kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.facilityId, facilityId)))
    .limit(1);
  const store = rows[0];
  if (!store) throw new Error("Store not found in this facility");
  return store;
}

/** Default to the facility's pharmacy store when a command does not name one. */
async function resolveStore(
  tx: CommandTransaction,
  facilityId: string,
  storeId?: string | null,
): Promise<LoadedStore> {
  if (storeId) return loadStore(tx, facilityId, storeId);
  const rows = await tx
    .select({ id: stores.id, name: stores.name, kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.facilityId, facilityId), eq(stores.kind, "pharmacy")))
    .orderBy(asc(stores.createdAt))
    .limit(1);
  const store = rows[0];
  if (!store) throw new Error("No pharmacy store is configured for this facility");
  return store;
}

interface LoadedItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  strength: string | null;
  form: string | null;
}

async function loadItem(
  tx: CommandTransaction,
  facilityId: string,
  itemId: string,
): Promise<LoadedItem> {
  const rows = await tx
    .select({
      id: items.id,
      code: items.code,
      name: items.name,
      unit: items.unit,
      strength: items.strength,
      form: items.form,
    })
    .from(items)
    .where(
      and(
        eq(items.id, itemId),
        or(isNull(items.facilityId), eq(items.facilityId, facilityId)),
      ),
    )
    .limit(1);
  const item = rows[0];
  if (!item) throw new Error("Item not found in this facility");
  return item;
}

interface LoadedBatch extends BatchCandidate {
  unitCost: string;
}

interface LoadedBatchRow extends LoadedBatch {
  itemId: string;
}

/**
 * Lock every batch of one item in the canonical FEFO order. Every command that
 * changes a batch balance calls this first, so concurrent dispenses serialise
 * on the same rows in the same order and cannot deadlock or oversell.
 */
async function lockItemBatches(
  tx: CommandTransaction,
  facilityId: string,
  itemId: string,
): Promise<LoadedBatch[]> {
  const rows = await tx
    .select({
      id: itemBatches.id,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      unitCost: itemBatches.unitCost,
      createdAt: itemBatches.createdAt,
    })
    .from(itemBatches)
    .where(and(eq(itemBatches.facilityId, facilityId), eq(itemBatches.itemId, itemId)))
    .orderBy(
      sql`${itemBatches.expiryDate} asc nulls last`,
      asc(itemBatches.createdAt),
      asc(itemBatches.id),
    )
    .for("update");
  return rows.map((row) => ({
    id: row.id,
    batchNo: row.batchNo,
    expiryDate: row.expiryDate,
    unitCost: row.unitCost,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function loadBalances(
  tx: CommandTransaction,
  facilityId: string,
  storeId: string,
  batchIds: string[],
): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await tx
    .select({
      batchId: stockLedger.batchId,
      quantity: sql<number>`coalesce(sum(${stockLedger.qtyDelta}), 0)::int`,
    })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.facilityId, facilityId),
        eq(stockLedger.storeId, storeId),
        inArray(stockLedger.batchId, batchIds),
      ),
    )
    .groupBy(stockLedger.batchId);
  const balances = new Map<string, number>();
  for (const row of rows) {
    if (row.batchId) balances.set(row.batchId, Number(row.quantity));
  }
  return balances;
}

async function loadBatch(
  tx: CommandTransaction,
  facilityId: string,
  batchId: string,
): Promise<LoadedBatchRow> {
  const rows = await tx
    .select({
      id: itemBatches.id,
      itemId: itemBatches.itemId,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      unitCost: itemBatches.unitCost,
      createdAt: itemBatches.createdAt,
    })
    .from(itemBatches)
    .where(and(eq(itemBatches.id, batchId), eq(itemBatches.facilityId, facilityId)))
    .limit(1);
  const batch = rows[0];
  if (!batch) throw new Error("Batch not found in this facility");
  return {
    id: batch.id,
    itemId: batch.itemId,
    batchNo: batch.batchNo,
    expiryDate: batch.expiryDate,
    unitCost: batch.unitCost,
    createdAt: batch.createdAt.toISOString(),
  };
}

interface LedgerInput {
  facilityId: string;
  storeId: string;
  itemId: string;
  batchId: string;
  qtyDelta: number;
  reason: "receive" | "dispense" | "adjust" | "transfer_in" | "transfer_out" | "reversal";
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  userId: string;
}

async function appendLedger(tx: CommandTransaction, input: LedgerInput): Promise<string> {
  const id = newId();
  await tx.insert(stockLedger).values({
    id,
    facilityId: input.facilityId,
    storeId: input.storeId,
    itemId: input.itemId,
    batchId: input.batchId,
    qtyDelta: input.qtyDelta,
    reason: input.reason,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    note: input.note ?? null,
    createdBy: input.userId,
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

export const receiveStockSchema = z.object({
  ...baseSchema,
  storeId: z.uuid().optional(),
  itemId: z.uuid(),
  batchNo: z.string().trim().min(1).max(64),
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry must be a date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  unitCost: z.number().min(0).max(1_000_000).optional(),
  quantity: z.number().int().min(1).max(1_000_000),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type ReceiveStockInput = z.input<typeof receiveStockSchema>;
export interface ReceiveStockResult {
  batchId: string;
  storeId: string;
  itemId: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
  balance: number;
}

export async function receiveStock(
  input: ReceiveStockInput,
  options: CommandOptions = {},
): Promise<ReceiveStockResult> {
  const values = receiveStockSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "receiveStock",
    async (tx) => {
      const store = await resolveStore(tx, values.facilityId, values.storeId);
      await loadItem(tx, values.facilityId, values.itemId);

      const expiryDate = values.expiryDate ?? null;
      const unitCost = values.unitCost != null ? values.unitCost.toFixed(2) : null;
      const [batch] = await tx
        .insert(itemBatches)
        .values({
          id: newId(),
          facilityId: values.facilityId,
          itemId: values.itemId,
          batchNo: values.batchNo,
          expiryDate,
          unitCost: unitCost ?? "0",
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [itemBatches.facilityId, itemBatches.itemId, itemBatches.batchNo],
          set: {
            // Keep an existing expiry/cost when the receiver does not supply one.
            expiryDate:
              expiryDate != null
                ? sql`excluded.expiry_date`
                : sql`${itemBatches.expiryDate}`,
            unitCost:
              unitCost != null ? sql`excluded.unit_cost` : sql`${itemBatches.unitCost}`,
            updatedAt: new Date(),
            version: sql`${itemBatches.version} + 1`,
          },
        })
        .returning({
          id: itemBatches.id,
          batchNo: itemBatches.batchNo,
          expiryDate: itemBatches.expiryDate,
        });

      await appendLedger(tx, {
        facilityId: values.facilityId,
        storeId: store.id,
        itemId: values.itemId,
        batchId: batch.id,
        qtyDelta: values.quantity,
        reason: "receive",
        refType: "receive",
        note: values.note ?? null,
        userId,
      });

      const balance =
        (await loadBalances(tx, values.facilityId, store.id, [batch.id])).get(batch.id) ?? 0;

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "stock.receive",
        module: "pharmacy",
        entity: "item_batches",
        entityId: batch.id,
        details: {
          storeId: store.id,
          itemId: values.itemId,
          batchNo: batch.batchNo,
          quantity: values.quantity,
          balance,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "stock.received",
        facilityId: values.facilityId,
        storeId: store.id,
        itemId: values.itemId,
        batchId: batch.id,
        quantity: values.quantity,
        balance,
      });

      return {
        batchId: batch.id,
        storeId: store.id,
        itemId: values.itemId,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        quantity: values.quantity,
        balance,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Adjusting                                                           */
/* ------------------------------------------------------------------ */

export const adjustStockSchema = z.object({
  ...baseSchema,
  storeId: z.uuid().optional(),
  batchId: z.uuid(),
  qtyDelta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0, "An adjustment must change the quantity"),
  note: z.string().trim().min(1, "A reason is required for a stock adjustment").max(1_000),
});

export type AdjustStockInput = z.input<typeof adjustStockSchema>;
export interface AdjustStockResult {
  batchId: string;
  storeId: string;
  qtyDelta: number;
  balance: number;
}

export async function adjustStock(
  input: AdjustStockInput,
  options: CommandOptions = {},
): Promise<AdjustStockResult> {
  const values = adjustStockSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "adjustStock",
    async (tx) => {
      const store = await resolveStore(tx, values.facilityId, values.storeId);
      const batch = await loadBatch(tx, values.facilityId, values.batchId);

      await lockItemBatches(tx, values.facilityId, batch.itemId);
      const balances = await loadBalances(tx, values.facilityId, store.id, [batch.id]);
      const current = balances.get(batch.id) ?? 0;
      const balance = current + values.qtyDelta;
      if (balance < 0) {
        throw new Error(
          `Adjustment would make the batch balance negative (${current} on hand)`,
        );
      }

      await appendLedger(tx, {
        facilityId: values.facilityId,
        storeId: store.id,
        itemId: batch.itemId,
        batchId: batch.id,
        qtyDelta: values.qtyDelta,
        reason: "adjust",
        refType: "adjust",
        note: values.note,
        userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "stock.adjust",
        module: "pharmacy",
        entity: "item_batches",
        entityId: batch.id,
        details: {
          storeId: store.id,
          itemId: batch.itemId,
          qtyDelta: values.qtyDelta,
          balance,
          note: values.note,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "stock.adjusted",
        facilityId: values.facilityId,
        storeId: store.id,
        itemId: batch.itemId,
        batchId: batch.id,
        qtyDelta: values.qtyDelta,
        balance,
      });

      return { batchId: batch.id, storeId: store.id, qtyDelta: values.qtyDelta, balance };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Transfers                                                           */
/* ------------------------------------------------------------------ */

export const transferStockSchema = z
  .object({
    ...baseSchema,
    fromStoreId: z.uuid(),
    toStoreId: z.uuid(),
    batchId: z.uuid(),
    quantity: z.number().int().min(1).max(1_000_000),
    note: z.string().trim().max(1_000).nullable().optional(),
  })
  .refine((values) => values.fromStoreId !== values.toStoreId, {
    message: "Choose two different stores for a transfer",
    path: ["toStoreId"],
  });

export type TransferStockInput = z.input<typeof transferStockSchema>;
export interface TransferStockResult {
  transferId: string;
  batchId: string;
  fromStoreId: string;
  toStoreId: string;
  quantity: number;
  fromBalance: number;
  toBalance: number;
}

export async function transferStock(
  input: TransferStockInput,
  options: CommandOptions = {},
): Promise<TransferStockResult> {
  const values = transferStockSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "transferStock",
    async (tx) => {
      const fromStore = await loadStore(tx, values.facilityId, values.fromStoreId);
      const toStore = await loadStore(tx, values.facilityId, values.toStoreId);
      const batch = await loadBatch(tx, values.facilityId, values.batchId);

      await lockItemBatches(tx, values.facilityId, batch.itemId);
      const balances = await loadBalances(tx, values.facilityId, fromStore.id, [batch.id]);
      const current = balances.get(batch.id) ?? 0;
      if (current < values.quantity) {
        throw new Error(
          `Insufficient stock in ${fromStore.name}: ${current} available, ${values.quantity} requested`,
        );
      }

      const transferId = newId();
      const ref = { refType: "transfer", refId: transferId, note: values.note ?? null };
      await appendLedger(tx, {
        facilityId: values.facilityId,
        storeId: fromStore.id,
        itemId: batch.itemId,
        batchId: batch.id,
        qtyDelta: -values.quantity,
        reason: "transfer_out",
        ...ref,
        userId,
      });
      await appendLedger(tx, {
        facilityId: values.facilityId,
        storeId: toStore.id,
        itemId: batch.itemId,
        batchId: batch.id,
        qtyDelta: values.quantity,
        reason: "transfer_in",
        ...ref,
        userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "stock.transfer",
        module: "pharmacy",
        entity: "item_batches",
        entityId: batch.id,
        details: {
          transferId,
          fromStoreId: fromStore.id,
          toStoreId: toStore.id,
          itemId: batch.itemId,
          quantity: values.quantity,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "stock.transferred",
        facilityId: values.facilityId,
        transferId,
        itemId: batch.itemId,
        batchId: batch.id,
        quantity: values.quantity,
      });

      return {
        transferId,
        batchId: batch.id,
        fromStoreId: fromStore.id,
        toStoreId: toStore.id,
        quantity: values.quantity,
        fromBalance: current - values.quantity,
        toBalance: values.quantity,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Dispensing                                                          */
/* ------------------------------------------------------------------ */

interface LoadedPrescription {
  id: string;
  encounterId: string;
  itemId: string;
  quantity: number;
  status: "prescribed" | "partial" | "dispensed" | "cancelled";
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  instructions: string | null;
}

async function loadPrescriptionForUpdate(
  tx: CommandTransaction,
  facilityId: string,
  prescriptionId: string,
): Promise<LoadedPrescription> {
  const rows = await tx
    .select({
      id: prescriptions.id,
      encounterId: prescriptions.encounterId,
      itemId: prescriptions.itemId,
      quantity: prescriptions.quantity,
      status: prescriptions.status,
      dose: prescriptions.dose,
      route: prescriptions.route,
      frequency: prescriptions.frequency,
      durationDays: prescriptions.durationDays,
      instructions: prescriptions.instructions,
    })
    .from(prescriptions)
    .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.facilityId, facilityId)))
    .limit(1)
    .for("update");
  const prescription = rows[0];
  if (!prescription) throw new Error("Prescription not found in this facility");
  return prescription;
}

async function loadDispensedQuantity(
  tx: CommandTransaction,
  facilityId: string,
  prescriptionId: string,
): Promise<number> {
  const rows = await tx
    .select({
      quantity: sql<number>`coalesce(sum(${dispenses.quantity}), 0)::int`,
    })
    .from(dispenses)
    .where(
      and(
        eq(dispenses.facilityId, facilityId),
        eq(dispenses.prescriptionId, prescriptionId),
        isNull(dispenses.reversedAt),
      ),
    );
  return Number(rows[0]?.quantity ?? 0);
}

interface PatientLabelContext {
  encounterNo: string;
  patientId: string;
  mrn: string;
  patientName: string;
  facilityName: string;
}

async function loadPatientLabelContext(
  tx: CommandTransaction,
  facilityId: string,
  encounterId: string,
): Promise<PatientLabelContext> {
  const rows = await tx
    .select({
      encounterNo: encounters.encounterNo,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      facilityName: facilities.name,
    })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .innerJoin(facilities, eq(facilities.id, encounters.facilityId))
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("Encounter not found in this facility");
  return {
    encounterNo: row.encounterNo,
    patientId: row.patientId,
    mrn: row.mrn,
    patientName: `${row.firstName} ${row.lastName}`.trim(),
    facilityName: row.facilityName,
  };
}

export const dispensePrescriptionSchema = z.object({
  ...baseSchema,
  prescriptionId: z.uuid(),
  storeId: z.uuid().optional(),
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  allocations: z
    .array(
      z.object({
        batchId: z.uuid(),
        quantity: z.number().int().min(1).max(1_000_000),
      }),
    )
    .max(100)
    .optional(),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type DispensePrescriptionInput = z.input<typeof dispensePrescriptionSchema>;
export interface DispenseAllocation {
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
}
export interface DispensePrescriptionResult {
  prescriptionId: string;
  status: "prescribed" | "partial" | "dispensed";
  dispensedQuantity: number;
  totalDispensed: number;
  remaining: number;
  allocations: DispenseAllocation[];
  label: ReturnType<typeof buildDispenseLabel>;
}

export async function dispensePrescription(
  input: DispensePrescriptionInput,
  options: CommandOptions = {},
): Promise<DispensePrescriptionResult> {
  const values = dispensePrescriptionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "dispensePrescription",
    async (tx) => {
      const prescription = await loadPrescriptionForUpdate(
        tx,
        values.facilityId,
        values.prescriptionId,
      );
      if (prescription.status === "cancelled") {
        throw new Error("This prescription is cancelled");
      }
      if (!canDispensePrescription(prescription.status)) {
        throw new Error("This prescription is already fully dispensed");
      }

      const item = await loadItem(tx, values.facilityId, prescription.itemId);
      const store = await resolveStore(tx, values.facilityId, values.storeId);
      const batches = await lockItemBatches(tx, values.facilityId, prescription.itemId);
      const batchById = new Map(batches.map((batch) => [batch.id, batch]));
      const balances = await loadBalances(
        tx,
        values.facilityId,
        store.id,
        batches.map((batch) => batch.id),
      );

      const alreadyDispensed = await loadDispensedQuantity(
        tx,
        values.facilityId,
        prescription.id,
      );
      const remaining = remainingQuantity(prescription.quantity, alreadyDispensed);
      if (remaining <= 0) throw new Error("This prescription is already fully dispensed");

      const picked: Array<{ batchId: string; quantity: number }> = [];
      let requested: number;

      if (values.allocations && values.allocations.length > 0) {
        const seen = new Set<string>();
        for (const allocation of values.allocations) {
          if (seen.has(allocation.batchId)) {
            throw new Error("A batch can only appear once in a dispense");
          }
          seen.add(allocation.batchId);
          const batch = batchById.get(allocation.batchId);
          if (!batch) throw new Error("Batch does not belong to this medicine");
          if (isBatchExpired(batch.expiryDate)) {
            throw new Error(`Batch ${batch.batchNo} has expired`);
          }
          const available = balances.get(batch.id) ?? 0;
          if (available < allocation.quantity) {
            throw new Error(
              `Batch ${batch.batchNo} has only ${available} in stock (${allocation.quantity} requested)`,
            );
          }
          picked.push(allocation);
        }
        requested = sumAllocations(picked);
        if (values.quantity != null && values.quantity !== requested) {
          throw new Error("The allocated quantity does not match the requested quantity");
        }
        if (requested > remaining) {
          throw new Error(`Only ${remaining} remaining on this prescription`);
        }
      } else {
        requested = values.quantity ?? remaining;
        if (requested > remaining) {
          throw new Error(`Only ${remaining} remaining on this prescription`);
        }
        const availableBatches = batches
          .filter((batch) => !isBatchExpired(batch.expiryDate))
          .map((batch) => ({
            batchId: batch.id,
            available: balances.get(batch.id) ?? 0,
          }))
          .filter((batch) => batch.available > 0);
        picked.push(...allocateFefo(availableBatches, requested));
        const available = sumAllocations(picked);
        if (available < requested) {
          throw new Error(
            `Insufficient stock: only ${available} available, ${requested} requested`,
          );
        }
      }

      if (requested <= 0) throw new Error("Nothing to dispense");

      const now = new Date();
      const allocations: DispenseAllocation[] = [];
      for (const allocation of picked) {
        const batch = batchById.get(allocation.batchId)!;
        await tx.insert(dispenses).values({
          id: newId(),
          facilityId: values.facilityId,
          prescriptionId: prescription.id,
          batchId: batch.id,
          storeId: store.id,
          quantity: allocation.quantity,
          dispensedBy: userId,
          note: values.note ?? null,
        });
        await appendLedger(tx, {
          facilityId: values.facilityId,
          storeId: store.id,
          itemId: prescription.itemId,
          batchId: batch.id,
          qtyDelta: -allocation.quantity,
          reason: "dispense",
          refType: "prescription",
          refId: prescription.id,
          note: values.note ?? null,
          userId,
        });
        allocations.push({
          batchId: batch.id,
          batchNo: batch.batchNo,
          expiryDate: batch.expiryDate,
          quantity: allocation.quantity,
        });
      }

      const totalDispensed = alreadyDispensed + requested;
      const status = prescriptionStatusAfterDispense(prescription.quantity, totalDispensed);
      await tx
        .update(prescriptions)
        .set({
          status,
          updatedAt: now,
          version: sql`${prescriptions.version} + 1`,
        })
        .where(
          and(
            eq(prescriptions.id, prescription.id),
            eq(prescriptions.facilityId, values.facilityId),
          ),
        );

      const context = await loadPatientLabelContext(
        tx,
        values.facilityId,
        prescription.encounterId,
      );
      const label = buildDispenseLabel({
        facilityName: context.facilityName,
        patientName: context.patientName,
        mrn: context.mrn,
        encounterNo: context.encounterNo,
        itemName: item.name,
        strength: item.strength,
        form: item.form,
        unit: item.unit,
        dose: prescription.dose,
        route: prescription.route,
        frequency: prescription.frequency,
        durationDays: prescription.durationDays,
        quantity: requested,
        instructions: prescription.instructions,
        dispensedAt: now,
        prescriptionId: prescription.id,
        pharmacist: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "prescription.dispense",
        module: "pharmacy",
        entity: "prescriptions",
        entityId: prescription.id,
        details: {
          encounterId: prescription.encounterId,
          patientId: context.patientId,
          storeId: store.id,
          itemId: prescription.itemId,
          quantity: requested,
          totalDispensed,
          status,
          allocations,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "prescription.dispensed",
        facilityId: values.facilityId,
        encounterId: prescription.encounterId,
        patientId: context.patientId,
        prescriptionId: prescription.id,
        itemId: prescription.itemId,
        status,
        quantity: requested,
        remaining: prescription.quantity - totalDispensed,
      });

      return {
        prescriptionId: prescription.id,
        status: status as DispensePrescriptionResult["status"],
        dispensedQuantity: requested,
        totalDispensed,
        remaining: prescription.quantity - totalDispensed,
        allocations,
        label,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Reversing a dispense                                                */
/* ------------------------------------------------------------------ */

export const reverseDispenseSchema = z.object({
  ...baseSchema,
  prescriptionId: z.uuid(),
  note: z.string().trim().min(1, "A reason is required to reverse a dispense").max(1_000),
});

export type ReverseDispenseInput = z.input<typeof reverseDispenseSchema>;
export interface ReverseDispenseResult {
  prescriptionId: string;
  status: "prescribed";
  reversedQuantity: number;
}

export async function reverseDispense(
  input: ReverseDispenseInput,
  options: CommandOptions = {},
): Promise<ReverseDispenseResult> {
  const values = reverseDispenseSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "reverseDispense",
    async (tx) => {
      const prescription = await loadPrescriptionForUpdate(
        tx,
        values.facilityId,
        values.prescriptionId,
      );
      if (!canReverseDispense(prescription.status)) {
        throw new Error("This prescription has no dispensed stock to reverse");
      }

      const activeRows = await tx
        .select({
          id: dispenses.id,
          batchId: dispenses.batchId,
          storeId: dispenses.storeId,
          quantity: dispenses.quantity,
        })
        .from(dispenses)
        .where(
          and(
            eq(dispenses.facilityId, values.facilityId),
            eq(dispenses.prescriptionId, prescription.id),
            isNull(dispenses.reversedAt),
          ),
        )
        .orderBy(asc(dispenses.createdAt));
      if (activeRows.length === 0) {
        throw new Error("This prescription has no dispensed stock to reverse");
      }

      await lockItemBatches(tx, values.facilityId, prescription.itemId);

      const now = new Date();
      let reversedQuantity = 0;
      for (const row of activeRows) {
        await appendLedger(tx, {
          facilityId: values.facilityId,
          storeId: row.storeId,
          itemId: prescription.itemId,
          batchId: row.batchId,
          qtyDelta: row.quantity,
          reason: "reversal",
          refType: "prescription",
          refId: prescription.id,
          note: values.note,
          userId,
        });
        await tx
          .update(dispenses)
          .set({ reversedAt: now, reversedBy: userId })
          .where(and(eq(dispenses.id, row.id), eq(dispenses.facilityId, values.facilityId)));
        reversedQuantity += row.quantity;
      }

      await tx
        .update(prescriptions)
        .set({
          status: "prescribed",
          updatedAt: now,
          version: sql`${prescriptions.version} + 1`,
        })
        .where(
          and(
            eq(prescriptions.id, prescription.id),
            eq(prescriptions.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "prescription.reverse",
        module: "pharmacy",
        entity: "prescriptions",
        entityId: prescription.id,
        details: {
          encounterId: prescription.encounterId,
          itemId: prescription.itemId,
          reversedQuantity,
          note: values.note,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "prescription.reversed",
        facilityId: values.facilityId,
        encounterId: prescription.encounterId,
        prescriptionId: prescription.id,
        itemId: prescription.itemId,
        quantity: reversedQuantity,
      });

      return { prescriptionId: prescription.id, status: "prescribed", reversedQuantity };
    },
    options,
  );
}
