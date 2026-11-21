import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  PAYMENT_METHODS,
  fromCents,
  invoiceStatus,
  lineAmount,
  sessionExpectedCash,
  toCents,
  validateTenders,
  varianceAmount,
  type PaymentMethod,
} from "@/lib/billing";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { recalculateInvoice, syncEncounterCharges } from "@/server/charges";
import {
  cashierSessions,
  charges,
  encounters,
  facilities,
  facilitySettings,
  invoices,
  payments,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { reverseJournalsForSource, tryPostJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";
import { assertFacilityReady } from "./regulatory";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

/** Cash stays in the till; every other tender lands in the bank. */
function tenderAccountRole(method: PaymentMethod): string {
  return method === "cash" ? "cash" : "bank";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

/** Invoice numbering uses the effective tax setting, not the facility code. */
async function loadInvoicePrefix(tx: CommandTransaction, facilityId: string): Promise<string> {
  const date = today();
  const rows = await tx
    .select({ valueText: facilitySettings.valueText })
    .from(facilitySettings)
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, "tax"),
        eq(facilitySettings.key, "invoice_prefix"),
        lte(facilitySettings.effectiveFrom, date),
        or(isNull(facilitySettings.effectiveTo), sql`${facilitySettings.effectiveTo} >= ${date}`),
      ),
    )
    .orderBy(desc(facilitySettings.effectiveFrom))
    .limit(1);
  const prefix = rows[0]?.valueText?.trim();
  if (!prefix || !/^[A-Z]{2,6}$/.test(prefix)) {
    throw new Error("tax.invoice_prefix must be configured before invoices can be numbered");
  }
  return prefix;
}

async function loadOpenSession(
  tx: CommandTransaction,
  facilityId: string,
  userId: string,
): Promise<typeof cashierSessions.$inferSelect> {
  const rows = await tx
    .select()
    .from(cashierSessions)
    .where(
      and(
        eq(cashierSessions.facilityId, facilityId),
        eq(cashierSessions.userId, userId),
        isNull(cashierSessions.closedAt),
      ),
    )
    .limit(1)
    .for("update");
  const session = rows[0];
  if (!session) throw new Error("Open a cashier session before taking payments");
  return session;
}

interface SessionTotals {
  methods: Array<{ method: PaymentMethod; amount: string; count: number }>;
  expectedCash: string;
}

async function loadSessionTotals(
  tx: CommandTransaction,
  facilityId: string,
  sessionId: string,
  openingFloat: string,
): Promise<SessionTotals> {
  const rows = await tx
    .select({ method: payments.method, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.facilityId, facilityId), eq(payments.cashierSessionId, sessionId)));

  const totals = new Map<PaymentMethod, { cents: number; count: number }>();
  for (const method of PAYMENT_METHODS) totals.set(method, { cents: 0, count: 0 });
  for (const row of rows) {
    const entry = totals.get(row.method)!;
    entry.cents += toCents(row.amount);
    entry.count += 1;
  }

  return {
    methods: PAYMENT_METHODS.map((method) => ({
      method,
      amount: fromCents(totals.get(method)!.cents),
      count: totals.get(method)!.count,
    })),
    expectedCash: sessionExpectedCash(
      openingFloat,
      rows.map((row) => ({ method: row.method, amount: row.amount })),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

export const openInvoiceSchema = z.object({
  ...baseSchema,
  encounterId: z.uuid(),
  notes: z.string().trim().max(1_000).nullable().optional(),
});

export type OpenInvoiceInput = z.input<typeof openInvoiceSchema>;
export interface OpenInvoiceResult {
  invoiceId: string;
  invoiceNo: string;
  total: string;
  paid: string;
  status: "open" | "partial" | "paid";
  chargeCount: number;
}

export async function openInvoice(
  input: OpenInvoiceInput,
  options: CommandOptions = {},
): Promise<OpenInvoiceResult> {
  const values = openInvoiceSchema.parse(input);
  const userId = actorId(values);

  await assertFacilityReady(
    { facilityId: values.facilityId, action: "billing", actor: values.actor },
    options,
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "openInvoice",
    async (tx) => {
      // Lock the visit so two cashiers cannot raise two invoices at once.
      const encounterRows = await tx
        .select({ id: encounters.id, encounterNo: encounters.encounterNo })
        .from(encounters)
        .where(
          and(
            eq(encounters.id, values.encounterId),
            eq(encounters.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const encounter = encounterRows[0];
      if (!encounter) throw new Error("Encounter not found in this facility");

      await syncEncounterCharges(tx, {
        facilityId: values.facilityId,
        encounterId: encounter.id,
        actor: {
          userId,
          ip: values.actor.ip,
          deviceId: values.actor.deviceId,
        },
      });

      const activeRows = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.facilityId, values.facilityId),
            eq(invoices.encounterId, encounter.id),
            inArray(invoices.status, ["open", "partial"]),
            isNull(invoices.finalizedAt),
          ),
        )
        .limit(1)
        .for("update");
      const invoice = activeRows[0];

      if (invoice) {
        const unbilled = await tx
          .select({ id: charges.id })
          .from(charges)
          .where(
            and(
              eq(charges.facilityId, values.facilityId),
              eq(charges.encounterId, encounter.id),
              isNull(charges.invoiceId),
              isNull(charges.voidedAt),
            ),
          );
        if (unbilled.length > 0) {
          await tx
            .update(charges)
            .set({
              invoiceId: invoice.id,
              updatedAt: new Date(),
              version: sql`${charges.version} + 1`,
            })
            .where(
              and(
                eq(charges.facilityId, values.facilityId),
                inArray(
                  charges.id,
                  unbilled.map((row) => row.id),
                ),
              ),
            );
        }
        const totals = await recalculateInvoice(tx, values.facilityId, invoice.id);
        return {
          invoiceId: invoice.id,
          invoiceNo: invoice.invoiceNo,
          total: totals?.total ?? invoice.total,
          paid: totals?.paid ?? invoice.paid,
          status: (totals?.status ?? invoice.status) as OpenInvoiceResult["status"],
          chargeCount: unbilled.length,
        };
      }

      const billable = await tx
        .select({ id: charges.id, amount: charges.amount })
        .from(charges)
        .where(
          and(
            eq(charges.facilityId, values.facilityId),
            eq(charges.encounterId, encounter.id),
            isNull(charges.invoiceId),
            isNull(charges.voidedAt),
          ),
        )
        .orderBy(asc(charges.createdAt));
      if (billable.length === 0) {
        throw new Error("There is nothing to bill for this visit");
      }

      const facility = await loadFacility(tx, values.facilityId);
      const prefix = await loadInvoicePrefix(tx, values.facilityId);
      const invoiceNo = await nextFormattedNumber(tx, facility, "invoice", prefix);
      const total = fromCents(
        billable.reduce((sum, charge) => sum + toCents(charge.amount), 0),
      );
      const status = invoiceStatus(total, "0.00");
      const invoiceId = newId();

      await tx.insert(invoices).values({
        id: invoiceId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        invoiceNo,
        subtotal: total,
        total,
        paid: "0.00",
        status,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });

      await tx
        .update(charges)
        .set({
          invoiceId,
          updatedAt: new Date(),
          version: sql`${charges.version} + 1`,
        })
        .where(
          and(
            eq(charges.facilityId, values.facilityId),
            inArray(
              charges.id,
              billable.map((row) => row.id),
            ),
          ),
        );

      await tryPostJournal(tx, {
        facilityId: values.facilityId,
        entryDate: today(),
        description: `Invoice ${invoiceNo} for ${encounter.encounterNo}`,
        sourceType: "invoice",
        sourceId: invoiceId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        lines: [
          {
            systemRole: "patient_receivable",
            debit: total,
            description: `Receivable ${invoiceNo}`,
          },
          {
            systemRole: "service_revenue",
            credit: total,
            description: `Revenue ${invoiceNo}`,
          },
        ],
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "invoice.open",
        module: "cashier",
        entity: "invoices",
        entityId: invoiceId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          invoiceNo,
          total,
          chargeCount: billable.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "invoice.opened",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        invoiceId,
        invoiceNo,
        total,
      });

      return {
        invoiceId,
        invoiceNo,
        total,
        paid: "0.00",
        status,
        chargeCount: billable.length,
      };
    },
    options,
  );
}

export const voidInvoiceSchema = z.object({
  ...baseSchema,
  invoiceId: z.uuid(),
  reason: z.string().trim().min(1, "A reason is required to void an invoice").max(1_000),
});

export type VoidInvoiceInput = z.input<typeof voidInvoiceSchema>;
export interface VoidInvoiceResult {
  invoiceId: string;
  status: "void";
  voidedCharges: number;
}

export async function voidInvoice(
  input: VoidInvoiceInput,
  options: CommandOptions = {},
): Promise<VoidInvoiceResult> {
  const values = voidInvoiceSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "voidInvoice",
    async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const invoice = rows[0];
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.status === "void") throw new Error("This invoice is already void");
      if (invoice.finalizedAt) {
        throw new Error("A finalised invoice cannot be voided; issue a credit note instead");
      }
      if (toCents(invoice.paid) !== 0) {
        throw new Error("Reverse the payments before voiding this invoice");
      }

      const now = new Date();
      await tx
        .update(invoices)
        .set({
          status: "void",
          voidedAt: now,
          voidedBy: userId,
          notes: values.reason,
          updatedAt: now,
          version: sql`${invoices.version} + 1`,
        })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.facilityId, values.facilityId)));

      const voidedCharges = await tx
        .update(charges)
        .set({
          voidedAt: now,
          voidedBy: userId,
          updatedAt: now,
          version: sql`${charges.version} + 1`,
        })
        .where(
          and(
            eq(charges.facilityId, values.facilityId),
            eq(charges.invoiceId, invoice.id),
            isNull(charges.voidedAt),
          ),
        )
        .returning({ id: charges.id });

      const reversalEntryNos = await reverseJournalsForSource(tx, {
        facilityId: values.facilityId,
        sourceType: "invoice",
        sourceId: invoice.id,
        entryDate: today(),
        reason: `Invoice ${invoice.invoiceNo} voided: ${values.reason}`,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "invoice.void",
        module: "cashier",
        entity: "invoices",
        entityId: invoice.id,
        details: {
          encounterId: invoice.encounterId,
          invoiceNo: invoice.invoiceNo,
          reason: values.reason,
          voidedCharges: voidedCharges.length,
          reversalEntries: reversalEntryNos,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "invoice.voided",
        facilityId: values.facilityId,
        encounterId: invoice.encounterId,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
      });

      return {
        invoiceId: invoice.id,
        status: "void" as const,
        voidedCharges: voidedCharges.length,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export const takePaymentSchema = z.object({
  ...baseSchema,
  invoiceId: z.uuid(),
  tenders: z
    .array(
      z.object({
        method: z.enum(PAYMENT_METHODS),
        amount: z.number().positive().max(1_000_000_000),
        reference: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(5),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type TakePaymentInput = z.input<typeof takePaymentSchema>;
export interface PaymentRecord {
  paymentId: string;
  receiptNo: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
}
export interface TakePaymentResult {
  invoiceId: string;
  invoiceNo: string;
  payments: PaymentRecord[];
  total: string;
  paid: string;
  outstanding: string;
  status: "open" | "partial" | "paid";
}

export async function takePayment(
  input: TakePaymentInput,
  options: CommandOptions = {},
): Promise<TakePaymentResult> {
  const values = takePaymentSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "takePayment",
    async (tx) => {
      const session = await loadOpenSession(tx, values.facilityId, userId);

      const rows = await tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const invoice = rows[0];
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.status === "void") throw new Error("This invoice is void");

      const totals = await recalculateInvoice(tx, values.facilityId, invoice.id);
      const total = totals?.total ?? invoice.total;
      const paid = totals?.paid ?? invoice.paid;
      validateTenders(total, paid, values.tenders);

      const facility = await loadFacility(tx, values.facilityId);
      const now = new Date();
      const created: PaymentRecord[] = [];

      for (const tender of values.tenders) {
        const paymentId = newId();
        const receiptNo = await nextFormattedNumber(tx, facility, "receipt");
        const amount = fromCents(toCents(tender.amount));
        await tx.insert(payments).values({
          id: paymentId,
          facilityId: values.facilityId,
          invoiceId: invoice.id,
          cashierSessionId: session.id,
          receiptNo,
          amount,
          method: tender.method,
          reference: tender.reference?.trim() || null,
          receivedBy: userId,
          note: values.note?.trim() || null,
          createdAt: now,
        });
        created.push({
          paymentId,
          receiptNo,
          amount,
          method: tender.method,
          reference: tender.reference?.trim() || null,
        });
      }

      const updated = await recalculateInvoice(tx, values.facilityId, invoice.id);
      const finalTotal = updated?.total ?? total;
      const finalPaid = updated?.paid ?? paid;
      const outstanding = fromCents(Math.max(0, toCents(finalTotal) - toCents(finalPaid)));

      const tenderTotal = fromCents(
        created.reduce((sum, payment) => sum + toCents(payment.amount), 0),
      );
      await tryPostJournal(tx, {
        facilityId: values.facilityId,
        entryDate: today(),
        description: `Payment for invoice ${invoice.invoiceNo}`,
        sourceType: "payment",
        sourceId: created[0]?.paymentId ?? invoice.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        lines: [
          ...created.map((payment) => ({
            systemRole: tenderAccountRole(payment.method),
            debit: payment.amount,
            description: `${payment.method} ${payment.receiptNo}`,
          })),
          {
            systemRole: "patient_receivable",
            credit: tenderTotal,
            description: `Settle ${invoice.invoiceNo}`,
          },
        ],
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payment.receive",
        module: "cashier",
        entity: "invoices",
        entityId: invoice.id,
        details: {
          encounterId: invoice.encounterId,
          invoiceNo: invoice.invoiceNo,
          sessionId: session.id,
          payments: created,
          total: finalTotal,
          paid: finalPaid,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      for (const payment of created) {
        await publishEvent(tx, {
          type: "payment.received",
          facilityId: values.facilityId,
          encounterId: invoice.encounterId,
          invoiceId: invoice.id,
          paymentId: payment.paymentId,
          receiptNo: payment.receiptNo,
          amount: payment.amount,
          method: payment.method,
        });
      }

      return {
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        payments: created,
        total: finalTotal,
        paid: finalPaid,
        outstanding,
        status: (updated?.status ?? invoiceStatus(finalTotal, finalPaid)) as TakePaymentResult["status"],
      };
    },
    options,
  );
}

export const reversePaymentSchema = z.object({
  ...baseSchema,
  paymentId: z.uuid(),
  reason: z.string().trim().min(1, "A reason is required to reverse a payment").max(1_000),
});

export type ReversePaymentInput = z.input<typeof reversePaymentSchema>;
export interface ReversePaymentResult {
  reversalPaymentId: string;
  receiptNo: string;
  invoiceId: string;
  invoiceNo: string;
  amount: string;
  total: string;
  paid: string;
  outstanding: string;
  status: "open" | "partial" | "paid";
}

export async function reversePayment(
  input: ReversePaymentInput,
  options: CommandOptions = {},
): Promise<ReversePaymentResult> {
  const values = reversePaymentSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "reversePayment",
    async (tx) => {
      const rows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, values.paymentId), eq(payments.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const payment = rows[0];
      if (!payment) throw new Error("Payment not found in this facility");
      if (payment.reversedPaymentId) throw new Error("A reversal cannot be reversed");
      if (toCents(payment.amount) <= 0) throw new Error("Only a received payment can be reversed");

      const already = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.facilityId, values.facilityId),
            eq(payments.reversedPaymentId, payment.id),
          ),
        )
        .limit(1);
      if (already[0]) throw new Error("This payment has already been reversed");

      const session = await loadOpenSession(tx, values.facilityId, userId);

      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, payment.invoiceId), eq(invoices.facilityId, values.facilityId)),
        )
        .limit(1)
        .for("update");
      const invoice = invoiceRows[0];
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.status === "void") throw new Error("This invoice is void");

      const facility = await loadFacility(tx, values.facilityId);
      const receiptNo = await nextFormattedNumber(tx, facility, "receipt");
      const reversalId = newId();
      const amount = fromCents(-toCents(payment.amount));

      await tx.insert(payments).values({
        id: reversalId,
        facilityId: values.facilityId,
        invoiceId: invoice.id,
        cashierSessionId: session.id,
        receiptNo,
        amount,
        method: payment.method,
        reference: payment.receiptNo,
        receivedBy: userId,
        reversedPaymentId: payment.id,
        note: values.reason,
      });

      const updated = await recalculateInvoice(tx, values.facilityId, invoice.id);
      const total = updated?.total ?? invoice.total;
      const paid = updated?.paid ?? invoice.paid;
      const outstanding = fromCents(Math.max(0, toCents(total) - toCents(paid)));

      const reversalAmount = fromCents(Math.abs(toCents(payment.amount)));
      await tryPostJournal(tx, {
        facilityId: values.facilityId,
        entryDate: today(),
        description: `Reversal of receipt ${payment.receiptNo}`,
        sourceType: "payment_reversal",
        sourceId: reversalId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        lines: [
          {
            systemRole: "patient_receivable",
            debit: reversalAmount,
            description: `Restore ${invoice.invoiceNo}`,
          },
          {
            systemRole: tenderAccountRole(payment.method),
            credit: reversalAmount,
            description: `Reverse ${payment.receiptNo}`,
          },
        ],
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payment.reverse",
        module: "cashier",
        entity: "payments",
        entityId: payment.id,
        details: {
          invoiceId: invoice.id,
          invoiceNo: invoice.invoiceNo,
          originalReceiptNo: payment.receiptNo,
          reversalReceiptNo: receiptNo,
          amount,
          reason: values.reason,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "payment.reversed",
        facilityId: values.facilityId,
        encounterId: invoice.encounterId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        reversalPaymentId: reversalId,
        receiptNo,
        amount,
      });

      return {
        reversalPaymentId: reversalId,
        receiptNo,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        amount,
        total,
        paid,
        outstanding,
        status: (updated?.status ?? invoiceStatus(total, paid)) as ReversePaymentResult["status"],
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Cashier sessions                                                    */
/* ------------------------------------------------------------------ */

export const openCashierSessionSchema = z.object({
  ...baseSchema,
  openingFloat: z.number().min(0).max(1_000_000_000).default(0),
  branchId: z.uuid().nullable().optional(),
});

export type OpenCashierSessionInput = z.input<typeof openCashierSessionSchema>;
export interface OpenCashierSessionResult {
  sessionId: string;
  openedAt: string;
  openingFloat: string;
  alreadyOpen: boolean;
}

export async function openCashierSession(
  input: OpenCashierSessionInput,
  options: CommandOptions = {},
): Promise<OpenCashierSessionResult> {
  const values = openCashierSessionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "openCashierSession",
    async (tx) => {
      const existingRows = await tx
        .select()
        .from(cashierSessions)
        .where(
          and(
            eq(cashierSessions.facilityId, values.facilityId),
            eq(cashierSessions.userId, userId),
            isNull(cashierSessions.closedAt),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing) {
        return {
          sessionId: existing.id,
          openedAt: existing.openedAt.toISOString(),
          openingFloat: existing.openingFloat,
          alreadyOpen: true,
        };
      }

      const sessionId = newId();
      const openingFloat = fromCents(toCents(values.openingFloat));
      const now = new Date();
      await tx.insert(cashierSessions).values({
        id: sessionId,
        facilityId: values.facilityId,
        branchId: values.branchId ?? null,
        userId,
        openedAt: now,
        openingFloat,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "cashier_session.open",
        module: "cashier",
        entity: "cashier_sessions",
        entityId: sessionId,
        details: { openingFloat },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "cashier_session.opened",
        facilityId: values.facilityId,
        sessionId,
        userId,
        openingFloat,
      });

      return {
        sessionId,
        openedAt: now.toISOString(),
        openingFloat,
        alreadyOpen: false,
      };
    },
    options,
  );
}

export const closeCashierSessionSchema = z.object({
  ...baseSchema,
  sessionId: z.uuid(),
  countedCash: z.number().min(0).max(1_000_000_000),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type CloseCashierSessionInput = z.input<typeof closeCashierSessionSchema>;
export interface CloseCashierSessionResult {
  sessionId: string;
  closedAt: string;
  openingFloat: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  methods: SessionTotals["methods"];
}

export async function closeCashierSession(
  input: CloseCashierSessionInput,
  options: CommandOptions = {},
): Promise<CloseCashierSessionResult> {
  const values = closeCashierSessionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "closeCashierSession",
    async (tx) => {
      const rows = await tx
        .select()
        .from(cashierSessions)
        .where(
          and(
            eq(cashierSessions.id, values.sessionId),
            eq(cashierSessions.facilityId, values.facilityId),
            eq(cashierSessions.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      const session = rows[0];
      if (!session) throw new Error("Cashier session not found");
      if (session.closedAt) throw new Error("This cashier session is already closed");

      const totals = await loadSessionTotals(
        tx,
        values.facilityId,
        session.id,
        session.openingFloat,
      );
      const countedCash = fromCents(toCents(values.countedCash));
      const variance = varianceAmount(countedCash, totals.expectedCash);
      const now = new Date();

      await tx
        .update(cashierSessions)
        .set({
          closedAt: now,
          countedCash,
          expectedCash: totals.expectedCash,
          variance,
          note: values.note?.trim() || null,
          updatedAt: now,
          version: sql`${cashierSessions.version} + 1`,
        })
        .where(
          and(eq(cashierSessions.id, session.id), eq(cashierSessions.facilityId, values.facilityId)),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "cashier_session.close",
        module: "cashier",
        entity: "cashier_sessions",
        entityId: session.id,
        details: {
          openingFloat: session.openingFloat,
          expectedCash: totals.expectedCash,
          countedCash,
          variance,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "cashier_session.closed",
        facilityId: values.facilityId,
        sessionId: session.id,
        expectedCash: totals.expectedCash,
        countedCash,
        variance,
      });

      return {
        sessionId: session.id,
        closedAt: now.toISOString(),
        openingFloat: session.openingFloat,
        expectedCash: totals.expectedCash,
        countedCash,
        variance,
        methods: totals.methods,
      };
    },
    options,
  );
}

/** Unused by the UI, kept for callers that need a single line total. */
export { lineAmount };
