import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { fromCents, invoiceStatus, lineAmount, toCents } from "@/lib/billing";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import type { CommandTransaction } from "@/server/commands/run";
import {
  charges,
  dispenses,
  encounters,
  invoices,
  items,
  labOrderItems,
  labOrders,
  labTests,
  payments,
  prescriptions,
  priceLists,
  prices,
  services,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";

type PayerType = "cash" | "sha" | "insurance";

export interface ChargeSyncActor {
  userId: string;
  ip?: string | null;
  deviceId?: string | null;
}

export interface ChargeSyncResult {
  created: number;
  updated: number;
  voided: number;
  total: string;
}

interface ServiceRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  defaultPrice: string;
}

interface DesiredCharge {
  sourceType: "consultation" | "lab" | "drug";
  sourceId: string;
  serviceId: string | null;
  itemId: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
}

/**
 * One negotiated list per payer type, with cash as the fallback when a payer
 * list has not been configured yet.
 */
export async function resolvePriceList(
  tx: CommandTransaction,
  facilityId: string,
  payerType: string,
): Promise<string | null> {
  const find = async (payer: string) => {
    const rows = await tx
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.facilityId, facilityId),
          eq(priceLists.payerType, payer as PayerType),
          eq(priceLists.active, true),
        ),
      )
      .orderBy(asc(priceLists.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  };

  const direct = await find(payerType);
  if (direct) return direct;
  if (payerType !== "cash") return find("cash");
  return null;
}

/** Facility services win over shared rows when both define the same code. */
async function loadServices(
  tx: CommandTransaction,
  facilityId: string,
): Promise<ServiceRow[]> {
  return tx
    .select({
      id: services.id,
      code: services.code,
      name: services.name,
      kind: services.kind,
      defaultPrice: services.defaultPrice,
    })
    .from(services)
    .where(
      and(
        or(isNull(services.facilityId), eq(services.facilityId, facilityId)),
        eq(services.active, true),
      ),
    )
    .orderBy(
      sql`case when ${services.facilityId} = ${facilityId}::uuid then 0 else 1 end`,
      asc(services.code),
    );
}

/** Active negotiated prices used when materialising encounter charges. */
export async function loadPriceMaps(
  tx: CommandTransaction,
  facilityId: string,
  priceListId: string | null,
): Promise<{ byService: Map<string, string>; byItem: Map<string, string> }> {
  const byService = new Map<string, string>();
  const byItem = new Map<string, string>();
  if (!priceListId) return { byService, byItem };

  const rows = await tx
    .select({ serviceId: prices.serviceId, itemId: prices.itemId, amount: prices.amount })
    .from(prices)
    .where(
      and(
        eq(prices.facilityId, facilityId),
        eq(prices.priceListId, priceListId),
        eq(prices.active, true),
      ),
    );

  for (const row of rows) {
    if (row.serviceId) byService.set(row.serviceId, row.amount);
    if (row.itemId) byItem.set(row.itemId, row.amount);
  }
  return { byService, byItem };
}

/**
 * Work out the billable lines a completed visit should carry. Rows that have
 * no configured service or price are skipped rather than charged at zero.
 */
async function desiredCharges(
  tx: CommandTransaction,
  facilityId: string,
  encounterId: string,
  payerType: string,
): Promise<DesiredCharge[]> {
  const priceListId = await resolvePriceList(tx, facilityId, payerType);
  const serviceRows = await loadServices(tx, facilityId);
  const { byService, byItem } = await loadPriceMaps(tx, facilityId, priceListId);

  const serviceByCode = new Map<string, ServiceRow>();
  for (const service of serviceRows) {
    if (!serviceByCode.has(service.code)) serviceByCode.set(service.code, service);
  }

  const priceFor = (service: ServiceRow): string =>
    byService.get(service.id) ?? service.defaultPrice;

  const desired: DesiredCharge[] = [];

  const consultation = serviceRows.find((service) => service.kind === "consultation");
  if (consultation) {
    desired.push({
      sourceType: "consultation",
      sourceId: encounterId,
      serviceId: consultation.id,
      itemId: null,
      description: consultation.name,
      quantity: 1,
      unitPrice: priceFor(consultation),
    });
  }

  const labRows = await tx
    .select({
      itemId: labOrderItems.id,
      testCode: labTests.code,
      testName: labTests.name,
    })
    .from(labOrderItems)
    .innerJoin(labOrders, eq(labOrders.id, labOrderItems.labOrderId))
    .innerJoin(labTests, eq(labTests.id, labOrderItems.labTestId))
    .where(
      and(
        eq(labOrderItems.facilityId, facilityId),
        eq(labOrders.encounterId, encounterId),
        ne(labOrders.status, "cancelled"),
        ne(labOrderItems.status, "cancelled"),
      ),
    );

  for (const lab of labRows) {
    const service = serviceByCode.get(lab.testCode);
    if (!service) continue;
    desired.push({
      sourceType: "lab",
      sourceId: lab.itemId,
      serviceId: service.id,
      itemId: null,
      description: service.name || lab.testName,
      quantity: 1,
      unitPrice: priceFor(service),
    });
  }

  const prescriptionRows = await tx
    .select({
      id: prescriptions.id,
      itemId: prescriptions.itemId,
      itemName: items.name,
      strength: items.strength,
      form: items.form,
    })
    .from(prescriptions)
    .innerJoin(items, eq(items.id, prescriptions.itemId))
    .where(
      and(
        eq(prescriptions.facilityId, facilityId),
        eq(prescriptions.encounterId, encounterId),
        ne(prescriptions.status, "cancelled"),
      ),
    );

  if (prescriptionRows.length > 0) {
    const dispensedRows = await tx
      .select({
        prescriptionId: dispenses.prescriptionId,
        quantity: sql<number>`coalesce(sum(${dispenses.quantity}), 0)::int`,
      })
      .from(dispenses)
      .where(
        and(
          eq(dispenses.facilityId, facilityId),
          inArray(
            dispenses.prescriptionId,
            prescriptionRows.map((row) => row.id),
          ),
          isNull(dispenses.reversedAt),
        ),
      )
      .groupBy(dispenses.prescriptionId);
    const dispensedByPrescription = new Map(
      dispensedRows.map((row) => [row.prescriptionId, Number(row.quantity)]),
    );

    for (const prescription of prescriptionRows) {
      const quantity = dispensedByPrescription.get(prescription.id) ?? 0;
      if (quantity <= 0) continue;
      const unitPrice = byItem.get(prescription.itemId);
      if (unitPrice == null) continue;
      const label = `${prescription.itemName}${prescription.strength ? ` — ${prescription.strength}` : ""}${prescription.form ? ` (${prescription.form})` : ""}`;
      desired.push({
        sourceType: "drug",
        sourceId: prescription.id,
        serviceId: null,
        itemId: prescription.itemId,
        description: label,
        quantity,
        unitPrice,
      });
    }
  }

  return desired;
}

/** Recompute an invoice from its non-voided charges and net payment ledger. */
export async function recalculateInvoice(
  tx: CommandTransaction,
  facilityId: string,
  invoiceId: string,
): Promise<{ total: string; paid: string; status: string } | null> {
  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, facilityId)))
    .limit(1)
    .for("update");
  const invoice = rows[0];
  if (!invoice) return null;
  if (invoice.status === "void") {
    return { total: invoice.total, paid: invoice.paid, status: invoice.status };
  }

  const [chargeSum] = await tx
    .select({ amount: sql<string>`coalesce(sum(${charges.amount}), 0)::numeric(12, 2)` })
    .from(charges)
    .where(and(eq(charges.facilityId, facilityId), eq(charges.invoiceId, invoiceId), isNull(charges.voidedAt)));

  const [paymentSum] = await tx
    .select({ amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(12, 2)` })
    .from(payments)
    .where(and(eq(payments.facilityId, facilityId), eq(payments.invoiceId, invoiceId)));

  const total = fromCents(toCents(chargeSum?.amount ?? "0"));
  const paid = fromCents(toCents(paymentSum?.amount ?? "0"));
  const status = invoiceStatus(total, paid);

  await tx
    .update(invoices)
    .set({
      subtotal: total,
      total,
      paid,
      status,
      updatedAt: new Date(),
      version: sql`${invoices.version} + 1`,
    })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, facilityId)));

  return { total, paid, status };
}

/**
 * Materialise the visit's billable lines and keep them in step with the
 * clinical record. Safe to call after every clinical write: it only touches
 * charges that are not already locked on a paid or void invoice.
 */
export async function syncEncounterCharges(
  tx: CommandTransaction,
  input: {
    facilityId: string;
    encounterId: string;
    actor: ChargeSyncActor;
  },
): Promise<ChargeSyncResult> {
  const { facilityId, encounterId } = input;
  const userId = input.actor.userId;

  const encounterRows = await tx
    .select({ id: encounters.id, payerType: encounters.payerType })
    .from(encounters)
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
    .limit(1);
  const encounter = encounterRows[0];
  if (!encounter) throw new Error("Encounter not found in this facility");

  const desired = await desiredCharges(tx, facilityId, encounterId, encounter.payerType);

  const existingRows = await tx
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, facilityId),
        eq(charges.encounterId, encounterId),
        isNull(charges.voidedAt),
      ),
    );
  const existingByKey = new Map(
    existingRows.map((charge) => [`${charge.sourceType}:${charge.sourceId}`, charge]),
  );

  const invoiceIds = [
    ...new Set(existingRows.map((charge) => charge.invoiceId).filter((id): id is string => Boolean(id))),
  ];
  const lockedInvoices = new Set<string>();
  if (invoiceIds.length > 0) {
    const invoiceRows = await tx
      .select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.facilityId, facilityId), inArray(invoices.id, invoiceIds)));
    for (const invoice of invoiceRows) {
      if (invoice.status === "paid" || invoice.status === "void") lockedInvoices.add(invoice.id);
    }
  }

  const now = new Date();
  let created = 0;
  let updated = 0;
  let voided = 0;
  const affectedInvoices = new Set<string>();

  for (const line of desired) {
    const key = `${line.sourceType}:${line.sourceId}`;
    const existing = existingByKey.get(key);
    const amount = lineAmount(line.unitPrice, line.quantity);

    if (!existing) {
      await tx.insert(charges).values({
        id: newId(),
        facilityId,
        encounterId,
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        serviceId: line.serviceId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount,
        createdBy: userId,
      });
      created += 1;
      continue;
    }

    existingByKey.delete(key);
    if (existing.invoiceId && lockedInvoices.has(existing.invoiceId)) continue;

    const changed =
      existing.quantity !== line.quantity ||
      toCents(existing.unitPrice) !== toCents(line.unitPrice) ||
      toCents(existing.amount) !== toCents(amount) ||
      existing.description !== line.description;
    if (!changed) continue;

    await tx
      .update(charges)
      .set({
        serviceId: line.serviceId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount,
        updatedAt: now,
        version: sql`${charges.version} + 1`,
      })
      .where(and(eq(charges.id, existing.id), eq(charges.facilityId, facilityId)));
    updated += 1;
    if (existing.invoiceId) affectedInvoices.add(existing.invoiceId);
  }

  // Anything left no longer has a source (cancelled order, reversed dispense).
  for (const stale of existingByKey.values()) {
    if (stale.invoiceId && lockedInvoices.has(stale.invoiceId)) continue;
    await tx
      .update(charges)
      .set({
        voidedAt: now,
        voidedBy: userId,
        updatedAt: now,
        version: sql`${charges.version} + 1`,
      })
      .where(and(eq(charges.id, stale.id), eq(charges.facilityId, facilityId)));
    voided += 1;
    if (stale.invoiceId) affectedInvoices.add(stale.invoiceId);
  }

  for (const invoiceId of affectedInvoices) {
    await recalculateInvoice(tx, facilityId, invoiceId);
  }

  const total = desired.reduce((sum, line) => sum + toCents(line.unitPrice) * line.quantity, 0);

  if (created + updated + voided > 0) {
    await recordAudit(tx, {
      facilityId,
      userId,
      action: "charge.sync",
      module: "cashier",
      entity: "charges",
      entityId: encounterId,
      details: { encounterId, created, updated, voided },
      deviceId: input.actor.deviceId,
      ip: input.actor.ip,
    });
    await publishEvent(tx, {
      type: "charge.synced",
      facilityId,
      encounterId,
      created,
      updated,
      voided,
    });
  }

  return { created, updated, voided, total: fromCents(total) };
}
