import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import { matchesThreeWay } from "@/lib/procurement";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { ForbiddenError } from "@/server/auth/guards";
import {
  facilities,
  goodsReceiptLines,
  goodsReceipts,
  itemBatches,
  items,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequisitionApprovals,
  purchaseRequisitionLines,
  purchaseRequisitions,
  reorderLevels,
  rfqLines,
  rfqs,
  stockLedger,
  stores,
  supplierInvoiceLines,
  supplierInvoices,
  supplierPayments,
  supplierQuoteLines,
  supplierQuotes,
  suppliers,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { postJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { assertFinanceApprovalLimit } from "./finance";
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

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");

const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

function assertDifferentActor(action: string, current: string, prior: string | null): void {
  if (prior && current === prior) {
    throw new ForbiddenError(`The same user cannot ${action}`);
  }
}

async function loadFacility(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const facility = rows[0];
  if (!facility) throw new Error("Facility not found");
  return facility;
}

function moneyFromCents(cents: number): string {
  return fromCents(cents);
}

async function auditAndEvent(
  tx: CommandTransaction,
  input: {
    facilityId: string;
    userId: string;
    ip?: string | null;
    deviceId?: string | null;
    action: string;
    entity: string;
    entityId: string;
    details: Record<string, unknown>;
    eventType: string;
    event: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(tx, {
    facilityId: input.facilityId,
    userId: input.userId,
    action: input.action,
    module: "procurement",
    entity: input.entity,
    entityId: input.entityId,
    details: input.details,
    ip: input.ip,
    deviceId: input.deviceId,
  });
  await publishEvent(tx, {
    type: input.eventType,
    facilityId: input.facilityId,
    ...input.event,
  });
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export const createSupplierSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1, "A supplier code is required")
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores"),
  name: z.string().trim().min(1, "A supplier name is required").max(200),
  contactName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.email().max(255).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});

export type CreateSupplierInput = z.input<typeof createSupplierSchema>;

export async function createSupplier(
  input: CreateSupplierInput,
  options: CommandOptions = {},
): Promise<{ supplierId: string; code: string; name: string }> {
  const values = createSupplierSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createSupplier",
    async (tx) => {
      const id = newId();
      await tx.insert(suppliers).values({
        id,
        facilityId: values.facilityId,
        code: values.code.toUpperCase(),
        name: values.name,
        contactName: values.contactName ?? null,
        phone: values.phone ?? null,
        email: values.email ?? null,
        address: values.address ?? null,
        paymentTermsDays: values.paymentTermsDays,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.supplier.create",
        entity: "suppliers",
        entityId: id,
        details: { code: values.code.toUpperCase(), name: values.name },
        eventType: "procurement.supplier.created",
        event: { supplierId: id },
      });
      return { supplierId: id, code: values.code.toUpperCase(), name: values.name };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Requisitions                                                        */
/* ------------------------------------------------------------------ */

const requisitionLineSchema = z.object({
  itemId: z.uuid(),
  quantity: positiveInt,
  unitCost: money,
  note: z.string().trim().max(500).nullable().optional(),
});

export const createPurchaseRequisitionSchema = z.object({
  ...baseSchema,
  department: z.string().trim().min(1).max(120),
  justification: z.string().trim().min(1).max(2000),
  lines: z.array(requisitionLineSchema).min(1).max(100),
});

export type CreatePurchaseRequisitionInput = z.input<typeof createPurchaseRequisitionSchema>;

export async function createPurchaseRequisition(
  input: CreatePurchaseRequisitionInput,
  options: CommandOptions = {},
): Promise<{ requisitionId: string; requisitionNo: string; total: string }> {
  const values = createPurchaseRequisitionSchema.parse(input);
  const userId = actorId(values);
  const totalCents = values.lines.reduce(
    (sum, line) => sum + toCents(line.unitCost) * line.quantity,
    0,
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPurchaseRequisition",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const itemIds = [...new Set(values.lines.map((line) => line.itemId))];
      const known = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.facilityId, values.facilityId), inArray(items.id, itemIds)));
      if (known.length !== itemIds.length) throw new Error("One or more items are not available");

      const requisitionNo = await nextFormattedNumber(tx, facility, "requisition");
      const requisitionId = newId();
      await tx.insert(purchaseRequisitions).values({
        id: requisitionId,
        facilityId: values.facilityId,
        requisitionNo,
        department: values.department,
        justification: values.justification,
        totalAmount: moneyFromCents(totalCents),
        requestedBy: userId,
        createdBy: userId,
      });
      await tx.insert(purchaseRequisitionLines).values(
        values.lines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          requisitionId,
          itemId: line.itemId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: moneyFromCents(toCents(line.unitCost) * line.quantity),
          note: line.note ?? null,
          createdBy: userId,
        })),
      );
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.requisition.create",
        entity: "purchase_requisitions",
        entityId: requisitionId,
        details: { requisitionNo, department: values.department, total: moneyFromCents(totalCents) },
        eventType: "procurement.requisition.created",
        event: { requisitionId, requisitionNo },
      });
      return { requisitionId, requisitionNo, total: moneyFromCents(totalCents) };
    },
    options,
  );
}

export const approvePurchaseRequisitionSchema = z.object({
  ...baseSchema,
  requisitionId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export type ApprovePurchaseRequisitionInput = z.input<typeof approvePurchaseRequisitionSchema>;

export async function approvePurchaseRequisition(
  input: ApprovePurchaseRequisitionInput,
  options: CommandOptions = {},
): Promise<{ requisitionId: string; status: "approved" | "rejected" }> {
  const values = approvePurchaseRequisitionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approvePurchaseRequisition",
    async (tx) => {
      const rows = await tx
        .select()
        .from(purchaseRequisitions)
        .where(
          and(
            eq(purchaseRequisitions.id, values.requisitionId),
            eq(purchaseRequisitions.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const requisition = rows[0];
      if (!requisition) throw new Error("Requisition not found");
      if (requisition.status !== "draft") throw new Error("Only draft requisitions can be decided");
      assertDifferentActor("approve their own requisition", userId, requisition.requestedBy);

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approveRequisition",
        toCents(requisition.totalAmount),
      );
      if (values.decision === "rejected" && !values.reason?.trim()) {
        throw new Error("A reason is required to reject a requisition");
      }

      await tx
        .update(purchaseRequisitions)
        .set({
          status: values.decision,
          approvedBy: values.decision === "approved" ? userId : null,
          approvedAt: values.decision === "approved" ? new Date() : null,
          rejectedReason: values.decision === "rejected" ? values.reason!.trim() : null,
          updatedAt: new Date(),
          version: sql`${purchaseRequisitions.version} + 1`,
        })
        .where(eq(purchaseRequisitions.id, values.requisitionId));
      await tx.insert(purchaseRequisitionApprovals).values({
        id: newId(),
        facilityId: values.facilityId,
        requisitionId: values.requisitionId,
        decision: values.decision,
        actorId: userId,
        reason: values.reason?.trim() ?? null,
        createdBy: userId,
      });
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: `procurement.requisition.${values.decision}`,
        entity: "purchase_requisitions",
        entityId: values.requisitionId,
        details: {
          requisitionNo: requisition.requisitionNo,
          reason: values.reason?.trim() ?? null,
          approvalRole: approval?.role ?? null,
        },
        eventType: `procurement.requisition.${values.decision}`,
        event: { requisitionId: values.requisitionId, decision: values.decision },
      });
      return { requisitionId: values.requisitionId, status: values.decision };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* RFQs and supplier quotes                                            */
/* ------------------------------------------------------------------ */

export const createRfqSchema = z.object({
  ...baseSchema,
  requisitionId: z.uuid(),
  closingDate: isoDate.nullable().optional(),
});

export type CreateRfqInput = z.input<typeof createRfqSchema>;

export async function createRfq(
  input: CreateRfqInput,
  options: CommandOptions = {},
): Promise<{ rfqId: string; rfqNo: string; lineCount: number }> {
  const values = createRfqSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createRfq",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const requisitionRows = await tx
        .select()
        .from(purchaseRequisitions)
        .where(
          and(
            eq(purchaseRequisitions.id, values.requisitionId),
            eq(purchaseRequisitions.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      const requisition = requisitionRows[0];
      if (!requisition) throw new Error("Requisition not found");
      if (requisition.status !== "approved") throw new Error("Only approved requisitions can be quoted");

      const existing = await tx
        .select({ id: rfqs.id })
        .from(rfqs)
        .where(eq(rfqs.requisitionId, values.requisitionId))
        .limit(1);
      if (existing.length) throw new Error("An RFQ already exists for this requisition");

      const lines = await tx
        .select()
        .from(purchaseRequisitionLines)
        .where(eq(purchaseRequisitionLines.requisitionId, values.requisitionId));
      const rfqNo = await nextFormattedNumber(tx, facility, "rfq");
      const rfqId = newId();
      await tx.insert(rfqs).values({
        id: rfqId,
        facilityId: values.facilityId,
        rfqNo,
        requisitionId: values.requisitionId,
        closingDate: values.closingDate ?? null,
        issuedBy: userId,
        createdBy: userId,
      });
      await tx.insert(rfqLines).values(
        lines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          rfqId,
          itemId: line.itemId,
          quantity: line.quantity,
          note: line.note,
          createdBy: userId,
        })),
      );
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.rfq.create",
        entity: "rfqs",
        entityId: rfqId,
        details: { rfqNo, requisitionNo: requisition.requisitionNo, lineCount: lines.length },
        eventType: "procurement.rfq.created",
        event: { rfqId, rfqNo },
      });
      return { rfqId, rfqNo, lineCount: lines.length };
    },
    options,
  );
}

const quoteLineSchema = z.object({
  itemId: z.uuid(),
  quantity: positiveInt,
  unitCost: money,
  leadTimeDays: nonNegativeInt.nullable().optional(),
});

export const recordSupplierQuoteSchema = z.object({
  ...baseSchema,
  rfqId: z.uuid(),
  supplierId: z.uuid(),
  quoteNo: z.string().trim().max(64).nullable().optional(),
  lines: z.array(quoteLineSchema).min(1).max(100),
});

export type RecordSupplierQuoteInput = z.input<typeof recordSupplierQuoteSchema>;

export async function recordSupplierQuote(
  input: RecordSupplierQuoteInput,
  options: CommandOptions = {},
): Promise<{ quoteId: string; total: string }> {
  const values = recordSupplierQuoteSchema.parse(input);
  const userId = actorId(values);
  const totalCents = values.lines.reduce(
    (sum, line) => sum + toCents(line.unitCost) * line.quantity,
    0,
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordSupplierQuote",
    async (tx) => {
      const rfqRows = await tx
        .select()
        .from(rfqs)
        .where(and(eq(rfqs.id, values.rfqId), eq(rfqs.facilityId, values.facilityId)))
        .limit(1);
      const rfq = rfqRows[0];
      if (!rfq) throw new Error("RFQ not found");
      if (rfq.status !== "open") throw new Error("The RFQ is closed");

      const supplierRows = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, values.supplierId),
            eq(suppliers.facilityId, values.facilityId),
            eq(suppliers.active, true),
          ),
        )
        .limit(1);
      if (!supplierRows.length) throw new Error("Supplier not found");

      const required = await tx
        .select({ itemId: rfqLines.itemId, quantity: rfqLines.quantity })
        .from(rfqLines)
        .where(eq(rfqLines.rfqId, values.rfqId));
      const suppliedItems = new Set(values.lines.map((line) => line.itemId));
      if (suppliedItems.size !== values.lines.length) throw new Error("A quote cannot repeat an item");
      for (const line of required) {
        const quoted = values.lines.find((candidate) => candidate.itemId === line.itemId);
        if (!quoted || quoted.quantity !== line.quantity) {
          throw new Error("A quote must cover every RFQ line at the requested quantity");
        }
      }
      if (values.lines.length !== required.length) {
        throw new Error("A quote must cover every RFQ line at the requested quantity");
      }

      const quoteId = newId();
      await tx.insert(supplierQuotes).values({
        id: quoteId,
        facilityId: values.facilityId,
        rfqId: values.rfqId,
        supplierId: values.supplierId,
        quoteNo: values.quoteNo ?? null,
        totalAmount: moneyFromCents(totalCents),
        receivedBy: userId,
        createdBy: userId,
      });
      await tx.insert(supplierQuoteLines).values(
        values.lines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          quoteId,
          itemId: line.itemId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: moneyFromCents(toCents(line.unitCost) * line.quantity),
          leadTimeDays: line.leadTimeDays ?? null,
          createdBy: userId,
        })),
      );
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.quote.record",
        entity: "supplier_quotes",
        entityId: quoteId,
        details: { rfqNo: rfq.rfqNo, quoteNo: values.quoteNo ?? null, total: moneyFromCents(totalCents) },
        eventType: "procurement.quote.recorded",
        event: { quoteId, rfqId: values.rfqId },
      });
      return { quoteId, total: moneyFromCents(totalCents) };
    },
    options,
  );
}

export const selectSupplierQuoteSchema = z.object({
  ...baseSchema,
  quoteId: z.uuid(),
  reason: z.string().trim().min(1).max(1000),
});

export type SelectSupplierQuoteInput = z.input<typeof selectSupplierQuoteSchema>;

export async function selectSupplierQuote(
  input: SelectSupplierQuoteInput,
  options: CommandOptions = {},
): Promise<{ quoteId: string; rfqId: string }> {
  const values = selectSupplierQuoteSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "selectSupplierQuote",
    async (tx) => {
      const quoteRows = await tx
        .select()
        .from(supplierQuotes)
        .where(
          and(
            eq(supplierQuotes.id, values.quoteId),
            eq(supplierQuotes.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const quote = quoteRows[0];
      if (!quote) throw new Error("Supplier quote not found");
      if (quote.status !== "received") throw new Error("Only received quotes can be selected");

      const rfqRows = await tx
        .select()
        .from(rfqs)
        .where(eq(rfqs.id, quote.rfqId))
        .limit(1)
        .for("update");
      const rfq = rfqRows[0];
      if (!rfq || rfq.status !== "open") throw new Error("The RFQ is closed");

      await tx
        .update(supplierQuotes)
        .set({ status: "selected", updatedAt: new Date(), version: sql`${supplierQuotes.version} + 1` })
        .where(eq(supplierQuotes.id, quote.id));
      await tx
        .update(supplierQuotes)
        .set({ status: "rejected", updatedAt: new Date(), version: sql`${supplierQuotes.version} + 1` })
        .where(
          and(
            eq(supplierQuotes.rfqId, quote.rfqId),
            eq(supplierQuotes.status, "received"),
            sql`${supplierQuotes.id} <> ${quote.id}::uuid`,
          ),
        );
      await tx
        .update(rfqs)
        .set({ status: "closed", updatedAt: new Date(), version: sql`${rfqs.version} + 1` })
        .where(eq(rfqs.id, quote.rfqId));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.quote.select",
        entity: "supplier_quotes",
        entityId: quote.id,
        details: { rfqNo: rfq.rfqNo, reason: values.reason, total: quote.totalAmount },
        eventType: "procurement.quote.selected",
        event: { quoteId: quote.id, rfqId: quote.rfqId },
      });
      return { quoteId: quote.id, rfqId: quote.rfqId };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Purchase orders                                                     */
/* ------------------------------------------------------------------ */

export const createPurchaseOrderSchema = z.object({
  ...baseSchema,
  quoteId: z.uuid(),
  expectedDate: isoDate.nullable().optional(),
});

export type CreatePurchaseOrderInput = z.input<typeof createPurchaseOrderSchema>;

export async function createPurchaseOrder(
  input: CreatePurchaseOrderInput,
  options: CommandOptions = {},
): Promise<{ purchaseOrderId: string; poNo: string; total: string }> {
  const values = createPurchaseOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPurchaseOrder",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const quoteRows = await tx
        .select()
        .from(supplierQuotes)
        .where(
          and(
            eq(supplierQuotes.id, values.quoteId),
            eq(supplierQuotes.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const quote = quoteRows[0];
      if (!quote) throw new Error("Supplier quote not found");
      if (quote.status !== "selected") throw new Error("Only a selected quote can become an LPO");

      const existing = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.quoteId, quote.id))
        .limit(1);
      if (existing.length) throw new Error("A purchase order already exists for this quote");

      const rfqRows = await tx.select().from(rfqs).where(eq(rfqs.id, quote.rfqId)).limit(1);
      const rfq = rfqRows[0];
      if (!rfq) throw new Error("RFQ not found");
      const requisitionRows = await tx
        .select()
        .from(purchaseRequisitions)
        .where(eq(purchaseRequisitions.id, rfq.requisitionId))
        .limit(1)
        .for("update");
      const requisition = requisitionRows[0];
      if (!requisition || requisition.status !== "approved") {
        throw new Error("The linked requisition is not approved");
      }
      assertDifferentActor("purchase against their own requisition", userId, requisition.requestedBy);

      const quoteLines = await tx
        .select()
        .from(supplierQuoteLines)
        .where(eq(supplierQuoteLines.quoteId, quote.id));
      if (!quoteLines.length) throw new Error("The selected quote has no lines");
      const totalCents = quoteLines.reduce(
        (sum, line) => sum + toCents(line.unitCost) * line.quantity,
        0,
      );
      const poNo = await nextFormattedNumber(tx, facility, "purchaseOrder");
      const purchaseOrderId = newId();
      await tx.insert(purchaseOrders).values({
        id: purchaseOrderId,
        facilityId: values.facilityId,
        poNo,
        requisitionId: requisition.id,
        quoteId: quote.id,
        supplierId: quote.supplierId,
        totalAmount: moneyFromCents(totalCents),
        expectedDate: values.expectedDate ?? null,
        orderedBy: userId,
        createdBy: userId,
      });
      await tx.insert(purchaseOrderLines).values(
        quoteLines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          purchaseOrderId,
          itemId: line.itemId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: moneyFromCents(toCents(line.unitCost) * line.quantity),
          createdBy: userId,
        })),
      );
      await tx
        .update(purchaseRequisitions)
        .set({
          status: "ordered",
          updatedAt: new Date(),
          version: sql`${purchaseRequisitions.version} + 1`,
        })
        .where(eq(purchaseRequisitions.id, requisition.id));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.purchaseOrder.create",
        entity: "purchase_orders",
        entityId: purchaseOrderId,
        details: { poNo, total: moneyFromCents(totalCents), supplierId: quote.supplierId },
        eventType: "procurement.purchaseOrder.created",
        event: { purchaseOrderId, poNo },
      });
      return { purchaseOrderId, poNo, total: moneyFromCents(totalCents) };
    },
    options,
  );
}

export const approvePurchaseOrderSchema = z.object({
  ...baseSchema,
  purchaseOrderId: z.uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type ApprovePurchaseOrderInput = z.input<typeof approvePurchaseOrderSchema>;

export async function approvePurchaseOrder(
  input: ApprovePurchaseOrderInput,
  options: CommandOptions = {},
): Promise<{ purchaseOrderId: string; status: "approved" }> {
  const values = approvePurchaseOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approvePurchaseOrder",
    async (tx) => {
      const rows = await tx
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.id, values.purchaseOrderId),
            eq(purchaseOrders.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order) throw new Error("Purchase order not found");
      if (order.status !== "draft") throw new Error("Only draft purchase orders can be approved");
      assertDifferentActor("approve their own purchase order", userId, order.orderedBy);

      if (order.requisitionId) {
        const requisitionRows = await tx
          .select({ requestedBy: purchaseRequisitions.requestedBy })
          .from(purchaseRequisitions)
          .where(eq(purchaseRequisitions.id, order.requisitionId))
          .limit(1);
        assertDifferentActor(
          "approve a purchase order arising from their own requisition",
          userId,
          requisitionRows[0]?.requestedBy ?? null,
        );
      }

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "approvePurchaseOrder",
        toCents(order.totalAmount),
      );
      await tx
        .update(purchaseOrders)
        .set({
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
          version: sql`${purchaseOrders.version} + 1`,
        })
        .where(eq(purchaseOrders.id, order.id));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.purchaseOrder.approve",
        entity: "purchase_orders",
        entityId: order.id,
        details: {
          poNo: order.poNo,
          note: values.note ?? null,
          approvalRole: approval?.role ?? null,
        },
        eventType: "procurement.purchaseOrder.approved",
        event: { purchaseOrderId: order.id, poNo: order.poNo },
      });
      return { purchaseOrderId: order.id, status: "approved" as const };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Goods received notes                                                */
/* ------------------------------------------------------------------ */

const receiptLineSchema = z.object({
  purchaseOrderLineId: z.uuid(),
  batchNo: z.string().trim().min(1).max(64),
  expiryDate: isoDate.nullable().optional(),
  quantity: positiveInt,
  unitCost: money,
  note: z.string().trim().max(500).nullable().optional(),
});

export const receiveGoodsSchema = z.object({
  ...baseSchema,
  purchaseOrderId: z.uuid(),
  storeId: z.uuid(),
  lines: z.array(receiptLineSchema).min(1).max(100),
  note: z.string().trim().max(1000).nullable().optional(),
});

export type ReceiveGoodsInput = z.input<typeof receiveGoodsSchema>;

export async function receiveGoods(
  input: ReceiveGoodsInput,
  options: CommandOptions = {},
): Promise<{ goodsReceiptId: string; grnNo: string; total: string }> {
  const values = receiveGoodsSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "receiveGoods",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const orderRows = await tx
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.id, values.purchaseOrderId),
            eq(purchaseOrders.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const order = orderRows[0];
      if (!order) throw new Error("Purchase order not found");
      if (order.status !== "approved" && order.status !== "partially_received") {
        throw new Error("Only approved purchase orders can receive goods");
      }
      assertDifferentActor("receive goods against their own purchase order", userId, order.orderedBy);
      assertDifferentActor("receive goods they approved", userId, order.approvedBy);

      const storeRows = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, values.storeId), eq(stores.facilityId, values.facilityId)))
        .limit(1);
      if (!storeRows.length) throw new Error("Store not found");

      const orderLineRows = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      const orderLines = new Map(orderLineRows.map((line) => [line.id, line]));
      if (new Set(values.lines.map((line) => line.purchaseOrderLineId)).size !== values.lines.length) {
        throw new Error("A purchase order line can be received only once in a GRN");
      }

      const totalCents = values.lines.reduce(
        (sum, line) => sum + toCents(line.unitCost) * line.quantity,
        0,
      );
      const grnNo = await nextFormattedNumber(tx, facility, "goodsReceipt");
      const goodsReceiptId = newId();
      await tx.insert(goodsReceipts).values({
        id: goodsReceiptId,
        facilityId: values.facilityId,
        grnNo,
        purchaseOrderId: order.id,
        storeId: values.storeId,
        totalAmount: moneyFromCents(totalCents),
        receivedBy: userId,
        note: values.note ?? null,
        createdBy: userId,
      });

      for (const line of values.lines) {
        const orderLine = orderLines.get(line.purchaseOrderLineId);
        if (!orderLine || orderLine.facilityId !== values.facilityId) {
          throw new Error("Purchase order line not found");
        }
        const remaining = orderLine.quantity - orderLine.receivedQuantity;
        if (line.quantity > remaining) {
          throw new Error("Received quantity exceeds the outstanding purchase order quantity");
        }

        const batchRows = await tx
          .select()
          .from(itemBatches)
          .where(
            and(
              eq(itemBatches.facilityId, values.facilityId),
              eq(itemBatches.itemId, orderLine.itemId),
              eq(itemBatches.batchNo, line.batchNo),
            ),
          )
          .limit(1)
          .for("update");
        const batch = batchRows[0];
        const batchId = batch?.id ?? newId();
        if (batch) {
          await tx
            .update(itemBatches)
            .set({
              unitCost: line.unitCost,
              expiryDate: line.expiryDate ?? batch.expiryDate,
              updatedAt: new Date(),
              version: sql`${itemBatches.version} + 1`,
            })
            .where(eq(itemBatches.id, batch.id));
        } else {
          await tx.insert(itemBatches).values({
            id: batchId,
            facilityId: values.facilityId,
            itemId: orderLine.itemId,
            batchNo: line.batchNo,
            expiryDate: line.expiryDate ?? null,
            unitCost: line.unitCost,
            createdBy: userId,
          });
        }

        const goodsReceiptLineId = newId();
        await tx.insert(goodsReceiptLines).values({
          id: goodsReceiptLineId,
          facilityId: values.facilityId,
          goodsReceiptId,
          purchaseOrderLineId: orderLine.id,
          itemId: orderLine.itemId,
          batchId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: moneyFromCents(toCents(line.unitCost) * line.quantity),
          expiryDate: line.expiryDate ?? null,
          note: line.note ?? null,
          createdBy: userId,
        });
        await tx.insert(stockLedger).values({
          id: newId(),
          facilityId: values.facilityId,
          storeId: values.storeId,
          itemId: orderLine.itemId,
          batchId,
          qtyDelta: line.quantity,
          reason: "receive",
          refType: "goods_receipt",
          refId: goodsReceiptLineId,
          note: line.note ?? `GRN ${grnNo}`,
          createdBy: userId,
        });
        const newReceived = orderLine.receivedQuantity + line.quantity;
        await tx
          .update(purchaseOrderLines)
          .set({
            receivedQuantity: newReceived,
            updatedAt: new Date(),
            version: sql`${purchaseOrderLines.version} + 1`,
          })
          .where(eq(purchaseOrderLines.id, orderLine.id));
      }

      const finalLines = await tx
        .select({ quantity: purchaseOrderLines.quantity, received: purchaseOrderLines.receivedQuantity })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      const fullyReceived = finalLines.every((line) => line.received >= line.quantity);
      await tx
        .update(purchaseOrders)
        .set({
          status: fullyReceived ? "received" : "partially_received",
          updatedAt: new Date(),
          version: sql`${purchaseOrders.version} + 1`,
        })
        .where(eq(purchaseOrders.id, order.id));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.goodsReceipt.create",
        entity: "goods_receipts",
        entityId: goodsReceiptId,
        details: { grnNo, poNo: order.poNo, total: moneyFromCents(totalCents), storeId: values.storeId },
        eventType: "procurement.goodsReceipt.created",
        event: { goodsReceiptId, grnNo, purchaseOrderId: order.id },
      });
      return { goodsReceiptId, grnNo, total: moneyFromCents(totalCents) };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Supplier invoices and payments                                      */
/* ------------------------------------------------------------------ */

const invoiceLineSchema = z.object({
  goodsReceiptLineId: z.uuid(),
  quantity: positiveInt,
  unitCost: money,
});

export const recordSupplierInvoiceSchema = z.object({
  ...baseSchema,
  purchaseOrderId: z.uuid(),
  goodsReceiptId: z.uuid(),
  supplierId: z.uuid(),
  invoiceNo: z.string().trim().min(1).max(64),
  invoiceDate: isoDate,
  lines: z.array(invoiceLineSchema).min(1).max(100),
});

export type RecordSupplierInvoiceInput = z.input<typeof recordSupplierInvoiceSchema>;

export async function recordSupplierInvoice(
  input: RecordSupplierInvoiceInput,
  options: CommandOptions = {},
): Promise<{
  supplierInvoiceId: string;
  invoiceNo: string;
  total: string;
  journalEntryId: string;
  journalEntryNo: string;
}> {
  const values = recordSupplierInvoiceSchema.parse(input);
  const userId = actorId(values);
  const totalCents = values.lines.reduce(
    (sum, line) => sum + toCents(line.unitCost) * line.quantity,
    0,
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordSupplierInvoice",
    async (tx) => {
      const orderRows = await tx
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.id, values.purchaseOrderId),
            eq(purchaseOrders.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const order = orderRows[0];
      if (!order) throw new Error("Purchase order not found");
      if (order.status !== "received" && order.status !== "partially_received") {
        throw new Error("Goods must be received before an invoice can be matched");
      }
      if (order.supplierId !== values.supplierId) {
        throw new Error("The invoice supplier does not match the purchase order");
      }

      const receiptRows = await tx
        .select()
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.id, values.goodsReceiptId),
            eq(goodsReceipts.facilityId, values.facilityId),
            eq(goodsReceipts.purchaseOrderId, order.id),
          ),
        )
        .limit(1);
      const receipt = receiptRows[0];
      if (!receipt) throw new Error("Goods receipt not found for this purchase order");

      const receiptLines = await tx
        .select()
        .from(goodsReceiptLines)
        .where(eq(goodsReceiptLines.goodsReceiptId, receipt.id));
      const orderLines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      const orderLineById = new Map(orderLines.map((line) => [line.id, line]));
      const receiptLineById = new Map(receiptLines.map((line) => [line.id, line]));
      if (new Set(values.lines.map((line) => line.goodsReceiptLineId)).size !== values.lines.length) {
        throw new Error("A goods receipt line can be invoiced only once");
      }
      if (values.lines.length !== receiptLines.length) {
        throw new Error("Three-way match failed: the invoice must cover every received line");
      }

      for (const line of values.lines) {
        const received = receiptLineById.get(line.goodsReceiptLineId);
        const ordered = received ? orderLineById.get(received.purchaseOrderLineId) : undefined;
        if (!received || !ordered) {
          throw new Error("Three-way match failed: unknown goods receipt line");
        }
        const matched = matchesThreeWay(
          {
            quantity: ordered.quantity,
            unitCostCents: toCents(ordered.unitCost),
          },
          {
            quantity: received.quantity,
            unitCostCents: toCents(received.unitCost),
          },
          {
            quantity: line.quantity,
            unitCostCents: toCents(line.unitCost),
          },
        );
        if (!matched) {
          throw new Error("Three-way match failed: order, receipt and invoice details differ");
        }
      }

      const invoiceId = newId();
      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: values.invoiceDate,
        description: `Supplier invoice ${values.invoiceNo} for ${order.poNo}`,
        lines: [
          {
            systemRole: "inventory",
            debit: moneyFromCents(totalCents),
            description: `Goods received under ${receipt.grnNo}`,
          },
          {
            systemRole: "accounts_payable",
            credit: moneyFromCents(totalCents),
            description: `Amount owed to supplier for ${values.invoiceNo}`,
          },
        ],
        sourceType: "supplier_invoice",
        sourceId: invoiceId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      await tx.insert(supplierInvoices).values({
        id: invoiceId,
        facilityId: values.facilityId,
        invoiceNo: values.invoiceNo,
        supplierId: values.supplierId,
        purchaseOrderId: order.id,
        goodsReceiptId: receipt.id,
        invoiceDate: values.invoiceDate,
        amount: moneyFromCents(totalCents),
        recordedBy: userId,
        journalEntryId: journal.entryId,
        createdBy: userId,
      });
      await tx.insert(supplierInvoiceLines).values(
        values.lines.map((line) => {
          const received = receiptLineById.get(line.goodsReceiptLineId)!;
          return {
            id: newId(),
            facilityId: values.facilityId,
            invoiceId,
            goodsReceiptLineId: line.goodsReceiptLineId,
            itemId: received.itemId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            lineTotal: moneyFromCents(toCents(line.unitCost) * line.quantity),
            createdBy: userId,
          };
        }),
      );
      await tx
        .update(goodsReceipts)
        .set({ status: "invoiced", updatedAt: new Date(), version: sql`${goodsReceipts.version} + 1` })
        .where(eq(goodsReceipts.id, receipt.id));
      await tx
        .update(purchaseOrders)
        .set({
          status: "invoiced",
          updatedAt: new Date(),
          version: sql`${purchaseOrders.version} + 1`,
        })
        .where(eq(purchaseOrders.id, order.id));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.supplierInvoice.record",
        entity: "supplier_invoices",
        entityId: invoiceId,
        details: {
          invoiceNo: values.invoiceNo,
          poNo: order.poNo,
          grnNo: receipt.grnNo,
          total: moneyFromCents(totalCents),
          journalEntryNo: journal.entryNo,
        },
        eventType: "procurement.supplierInvoice.recorded",
        event: { supplierInvoiceId: invoiceId, invoiceNo: values.invoiceNo, journalEntryId: journal.entryId },
      });
      return {
        supplierInvoiceId: invoiceId,
        invoiceNo: values.invoiceNo,
        total: moneyFromCents(totalCents),
        journalEntryId: journal.entryId,
        journalEntryNo: journal.entryNo,
      };
    },
    options,
  );
}

export const recordSupplierPaymentSchema = z.object({
  ...baseSchema,
  supplierInvoiceId: z.uuid(),
  amount: money,
  paymentDate: isoDate,
  method: z.enum(["cash", "bank"]),
  reference: z.string().trim().max(120).nullable().optional(),
});

export type RecordSupplierPaymentInput = z.input<typeof recordSupplierPaymentSchema>;

export async function recordSupplierPayment(
  input: RecordSupplierPaymentInput,
  options: CommandOptions = {},
): Promise<{ supplierPaymentId: string; paymentNo: string; journalEntryId: string }> {
  const values = recordSupplierPaymentSchema.parse(input);
  const userId = actorId(values);
  const amountCents = toCents(values.amount);
  if (amountCents <= 0) throw new Error("A payment must be greater than zero");

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordSupplierPayment",
    async (tx) => {
      const facility = await loadFacility(tx, values.facilityId);
      const invoiceRows = await tx
        .select()
        .from(supplierInvoices)
        .where(
          and(
            eq(supplierInvoices.id, values.supplierInvoiceId),
            eq(supplierInvoices.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const invoice = invoiceRows[0];
      if (!invoice) throw new Error("Supplier invoice not found");
      if (invoice.status === "paid") throw new Error("The invoice is already fully paid");
      assertDifferentActor("prepare and pay the same supplier invoice", userId, invoice.recordedBy);

      const outstandingCents = toCents(invoice.amount) - toCents(invoice.paidAmount);
      if (amountCents > outstandingCents) {
        throw new Error("Payment exceeds the outstanding invoice balance");
      }

      const approval = await assertFinanceApprovalLimit(
        tx,
        values.facilityId,
        userId,
        "recordSupplierPayment",
        amountCents,
      );
      const journal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: values.paymentDate,
        description: `Supplier payment ${invoice.invoiceNo}`,
        lines: [
          {
            systemRole: "accounts_payable",
            debit: values.amount,
            description: `Settlement of ${invoice.invoiceNo}`,
          },
          {
            systemRole: values.method,
            credit: values.amount,
            description: `Paid by ${values.method}`,
          },
        ],
        sourceType: "supplier_payment",
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        approval,
      });

      const paymentNo = await nextFormattedNumber(tx, facility, "supplierPayment");
      const supplierPaymentId = newId();
      await tx.insert(supplierPayments).values({
        id: supplierPaymentId,
        facilityId: values.facilityId,
        paymentNo,
        supplierId: invoice.supplierId,
        invoiceId: invoice.id,
        method: values.method,
        amount: values.amount,
        paymentDate: values.paymentDate,
        reference: values.reference ?? null,
        recordedBy: userId,
        journalEntryId: journal.entryId,
        createdBy: userId,
      });

      const paidCents = toCents(invoice.paidAmount) + amountCents;
      const fullyPaid = paidCents >= toCents(invoice.amount);
      await tx
        .update(supplierInvoices)
        .set({
          paidAmount: moneyFromCents(paidCents),
          status: fullyPaid ? "paid" : "partially_paid",
          updatedAt: new Date(),
          version: sql`${supplierInvoices.version} + 1`,
        })
        .where(eq(supplierInvoices.id, invoice.id));
      await tx
        .update(purchaseOrders)
        .set({
          status: "paid",
          updatedAt: new Date(),
          version: sql`${purchaseOrders.version} + 1`,
        })
        .where(eq(purchaseOrders.id, invoice.purchaseOrderId));
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.supplierPayment.record",
        entity: "supplier_payments",
        entityId: supplierPaymentId,
        details: {
          paymentNo,
          invoiceNo: invoice.invoiceNo,
          amount: values.amount,
          journalEntryNo: journal.entryNo,
          approvalRole: approval?.role ?? null,
        },
        eventType: "procurement.supplierPayment.recorded",
        event: { supplierPaymentId, paymentNo, invoiceId: invoice.id },
      });
      return { supplierPaymentId, paymentNo, journalEntryId: journal.entryId };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Reorder levels                                                      */
/* ------------------------------------------------------------------ */

export const setReorderLevelSchema = z.object({
  ...baseSchema,
  itemId: z.uuid(),
  storeId: z.uuid(),
  minimumQuantity: nonNegativeInt,
  active: z.boolean().default(true),
});

export type SetReorderLevelInput = z.input<typeof setReorderLevelSchema>;

export async function setReorderLevel(
  input: SetReorderLevelInput,
  options: CommandOptions = {},
): Promise<{ reorderLevelId: string; itemId: string; storeId: string; minimumQuantity: number }> {
  const values = setReorderLevelSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setReorderLevel",
    async (tx) => {
      const itemRows = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, values.itemId), eq(items.facilityId, values.facilityId)))
        .limit(1);
      const storeRows = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, values.storeId), eq(stores.facilityId, values.facilityId)))
        .limit(1);
      if (!itemRows.length || !storeRows.length) throw new Error("Item or store not found");

      const existing = await tx
        .select({ id: reorderLevels.id })
        .from(reorderLevels)
        .where(
          and(
            eq(reorderLevels.facilityId, values.facilityId),
            eq(reorderLevels.itemId, values.itemId),
            eq(reorderLevels.storeId, values.storeId),
          ),
        )
        .limit(1);
      const reorderLevelId = existing[0]?.id ?? newId();
      if (existing.length) {
        await tx
          .update(reorderLevels)
          .set({
            minimumQuantity: values.minimumQuantity,
            active: values.active,
            updatedAt: new Date(),
            version: sql`${reorderLevels.version} + 1`,
          })
          .where(eq(reorderLevels.id, reorderLevelId));
      } else {
        await tx.insert(reorderLevels).values({
          id: reorderLevelId,
          facilityId: values.facilityId,
          itemId: values.itemId,
          storeId: values.storeId,
          minimumQuantity: values.minimumQuantity,
          active: values.active,
          createdBy: userId,
        });
      }
      await auditAndEvent(tx, {
        facilityId: values.facilityId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        action: "procurement.reorderLevel.set",
        entity: "reorder_levels",
        entityId: reorderLevelId,
        details: {
          itemId: values.itemId,
          storeId: values.storeId,
          minimumQuantity: values.minimumQuantity,
          active: values.active,
        },
        eventType: "procurement.reorderLevel.updated",
        event: { reorderLevelId, itemId: values.itemId },
      });
      return {
        reorderLevelId,
        itemId: values.itemId,
        storeId: values.storeId,
        minimumQuantity: values.minimumQuantity,
      };
    },
    options,
  );
}
