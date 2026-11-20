import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import {
  PAYMENT_METHODS,
  fromCents,
  outstandingAmount,
  sessionExpectedCash,
  toCents,
  type PaymentMethod,
  type ReceiptData,
} from "@/lib/billing";
import { isConsentValid, PATIENT_RESTRICTION_ENTITY } from "@/lib/privacy";
import { db } from "@/server/db/client";
import {
  branches,
  cashierSessions,
  charges,
  dataConsents,
  encounters,
  facilities,
  invoices,
  patients,
  payments,
  priceLists,
  prices,
  retentionPolicies,
  user,
} from "@/server/db/schema";

export type BillingDatabase = typeof db;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function isMinorDob(dob: string | null | undefined, onDate: Date = new Date()): boolean {
  if (!dob) return false;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const ageMs = onDate.getTime() - birth.getTime();
  return ageMs / (365.25 * 24 * 60 * 60 * 1000) < 18;
}

async function getEncounterPrivacyStatus(
  database: BillingDatabase,
  facilityId: string,
  patientId: string,
  dob: string | null,
): Promise<EncounterPrivacyStatus> {
  const [restrictionRows, consentRows] = await Promise.all([
    database
      .select({ id: retentionPolicies.id })
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.facilityId, facilityId),
          eq(retentionPolicies.entity, PATIENT_RESTRICTION_ENTITY),
          eq(retentionPolicies.triggerEvent, patientId),
          eq(retentionPolicies.legalHold, true),
        ),
      )
      .limit(1),
    database
      .select({
        granted: dataConsents.granted,
        withdrawnAt: dataConsents.withdrawnAt,
        validFrom: dataConsents.validFrom,
        validTo: dataConsents.validTo,
      })
      .from(dataConsents)
      .where(
        and(
          eq(dataConsents.facilityId, facilityId),
          eq(dataConsents.patientId, patientId),
          eq(dataConsents.consentType, isMinorDob(dob) ? "minor" : "treatment"),
        ),
      ),
  ]);

  const restricted = restrictionRows.length > 0;
  if (restricted) {
    return { restricted: true, consentStatus: "restricted" };
  }
  const hasCurrent = consentRows.some((row) => isConsentValid(row));
  return { restricted: false, consentStatus: hasCurrent ? "current" : "missing" };
}

function patientName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

/* ------------------------------------------------------------------ */
/* Cashier queue                                                       */
/* ------------------------------------------------------------------ */

export interface CashierQueueItem {
  encounterId: string;
  encounterNo: string;
  encounterStatus: string;
  payerType: string;
  startedAt: string;
  endedAt: string | null;
  patientId: string;
  mrn: string;
  patientName: string;
  dob: string | null;
  sex: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  invoiceStatus: string | null;
  total: string;
  paid: string;
  outstanding: string;
  unbilledCount: number;
  unbilledTotal: string;
}

/**
 * Visits the cashier can act on: anything with unbilled charges, or an
 * invoice that is still open or part paid. Fully settled visits drop off.
 */
export async function getCashierQueue(
  database: BillingDatabase,
  facilityId: string,
  term = "",
): Promise<CashierQueueItem[]> {
  const search = term.trim();
  const conditions = [eq(encounters.facilityId, facilityId)];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      or(
        sql`${patients.mrn} ilike ${pattern}`,
        sql`${patients.firstName} ilike ${pattern}`,
        sql`${patients.lastName} ilike ${pattern}`,
        sql`${encounters.encounterNo} ilike ${pattern}`,
      )!,
    );
  }

  const encounterRows = await database
    .select({
      encounterId: encounters.id,
      encounterNo: encounters.encounterNo,
      encounterStatus: encounters.status,
      payerType: encounters.payerType,
      startedAt: encounters.startedAt,
      endedAt: encounters.endedAt,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      sex: patients.sex,
    })
    .from(encounters)
    .innerJoin(
      patients,
      and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)),
    )
    .where(and(...conditions))
    .orderBy(asc(encounters.startedAt))
    .limit(200);

  if (encounterRows.length === 0) return [];
  const encounterIds = encounterRows.map((row) => row.encounterId);

  const chargeRows = await database
    .select({
      encounterId: charges.encounterId,
      total: sql<string>`coalesce(sum(${charges.amount}), 0)::numeric(12, 2)`,
      unbilledTotal: sql<string>`coalesce(sum(${charges.amount}) filter (where ${charges.invoiceId} is null), 0)::numeric(12, 2)`,
      unbilledCount: sql<number>`(count(*) filter (where ${charges.invoiceId} is null))::int`,
    })
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, facilityId),
        inArray(charges.encounterId, encounterIds),
        isNull(charges.voidedAt),
      ),
    )
    .groupBy(charges.encounterId);
  const chargesByEncounter = new Map(chargeRows.map((row) => [row.encounterId, row]));

  const invoiceRows = await database
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.facilityId, facilityId),
        inArray(invoices.encounterId, encounterIds),
        inArray(invoices.status, ["open", "partial"]),
      ),
    );
  const invoiceByEncounter = new Map(invoiceRows.map((row) => [row.encounterId, row]));

  const queue: CashierQueueItem[] = [];
  for (const row of encounterRows) {
    const charge = chargesByEncounter.get(row.encounterId);
    const invoice = invoiceByEncounter.get(row.encounterId);
    const unbilledCount = charge?.unbilledCount ?? 0;
    const unbilledTotal = fromCents(toCents(charge?.unbilledTotal ?? "0"));
    if (unbilledCount === 0 && !invoice) continue;

    const total = fromCents(toCents(invoice?.total ?? "0") + toCents(unbilledTotal));
    const paid = fromCents(toCents(invoice?.paid ?? "0"));
    queue.push({
      encounterId: row.encounterId,
      encounterNo: row.encounterNo,
      encounterStatus: row.encounterStatus,
      payerType: row.payerType,
      startedAt: row.startedAt.toISOString(),
      endedAt: iso(row.endedAt),
      patientId: row.patientId,
      mrn: row.mrn,
      patientName: patientName(row.firstName, row.lastName),
      dob: row.dob,
      sex: row.sex,
      invoiceId: invoice?.id ?? null,
      invoiceNo: invoice?.invoiceNo ?? null,
      invoiceStatus: invoice?.status ?? null,
      total,
      paid,
      outstanding: outstandingAmount(total, paid),
      unbilledCount,
      unbilledTotal,
    });
  }
  return queue;
}

/* ------------------------------------------------------------------ */
/* Bill detail                                                         */
/* ------------------------------------------------------------------ */

export interface BillChargeView {
  id: string;
  invoiceId: string | null;
  sourceType: string;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
  voidedAt: string | null;
  createdAt: string;
}

export interface BillPaymentView {
  id: string;
  invoiceId: string;
  receiptNo: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  receivedBy: string;
  cashierName: string | null;
  reversedPaymentId: string | null;
  reversedReceiptNo: string | null;
  note: string | null;
  createdAt: string;
}

export interface BillInvoiceView {
  id: string;
  invoiceNo: string;
  status: string;
  subtotal: string;
  total: string;
  paid: string;
  outstanding: string;
  notes: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
}

export type EncounterConsentStatus = "current" | "missing" | "restricted";

export interface EncounterPrivacyStatus {
  restricted: boolean;
  consentStatus: EncounterConsentStatus;
}

export interface EncounterBill {
  encounterId: string;
  encounterNo: string;
  encounterStatus: string;
  payerType: string;
  startedAt: string;
  endedAt: string;
  patientId: string;
  mrn: string;
  patientName: string;
  dob: string | null;
  sex: string;
  invoice: BillInvoiceView | null;
  charges: BillChargeView[];
  payments: BillPaymentView[];
  unbilledTotal: string;
  outstanding: string;
  privacy: EncounterPrivacyStatus;
}

async function loadPayments(
  database: BillingDatabase,
  facilityId: string,
  invoiceIds: string[],
): Promise<BillPaymentView[]> {
  if (invoiceIds.length === 0) return [];
  const rows = await database
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      receiptNo: payments.receiptNo,
      amount: payments.amount,
      method: payments.method,
      reference: payments.reference,
      receivedBy: payments.receivedBy,
      cashierName: user.name,
      reversedPaymentId: payments.reversedPaymentId,
      note: payments.note,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .leftJoin(user, eq(user.id, payments.receivedBy))
    .where(and(eq(payments.facilityId, facilityId), inArray(payments.invoiceId, invoiceIds)))
    // Split-tender payments can share a created_at inside one transaction, so
    // the receipt sequence is the stable tie-breaker for the bill view.
    .orderBy(asc(payments.createdAt), asc(payments.receiptNo));

  const receiptByPaymentId = new Map(rows.map((row) => [row.id, row.receiptNo]));
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoiceId,
    receiptNo: row.receiptNo,
    amount: row.amount,
    method: row.method,
    reference: row.reference,
    receivedBy: row.receivedBy,
    cashierName: row.cashierName ?? null,
    reversedPaymentId: row.reversedPaymentId,
    reversedReceiptNo: row.reversedPaymentId
      ? (receiptByPaymentId.get(row.reversedPaymentId) ?? null)
      : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }));
}

function toBillInvoice(invoice: typeof invoices.$inferSelect): BillInvoiceView {
  return {
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    status: invoice.status,
    subtotal: invoice.subtotal,
    total: invoice.total,
    paid: invoice.paid,
    outstanding: outstandingAmount(invoice.total, invoice.paid),
    notes: invoice.notes,
    createdAt: invoice.createdAt.toISOString(),
    voidedAt: iso(invoice.voidedAt),
    voidedBy: invoice.voidedBy,
  };
}

/** The bill the cashier sees for one visit, including voided lines. */
export async function getEncounterBill(
  database: BillingDatabase,
  facilityId: string,
  encounterId: string,
): Promise<EncounterBill | null> {
  const encounterRows = await database
    .select({
      encounterId: encounters.id,
      encounterNo: encounters.encounterNo,
      encounterStatus: encounters.status,
      payerType: encounters.payerType,
      startedAt: encounters.startedAt,
      endedAt: encounters.endedAt,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      sex: patients.sex,
    })
    .from(encounters)
    .innerJoin(
      patients,
      and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)),
    )
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
    .limit(1);
  const encounter = encounterRows[0];
  if (!encounter) return null;

  const invoiceRows = await database
    .select()
    .from(invoices)
    .where(and(eq(invoices.facilityId, facilityId), eq(invoices.encounterId, encounter.encounterId)))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  const invoice = invoiceRows[0] ?? null;

  const chargeRows = await database
    .select({
      id: charges.id,
      invoiceId: charges.invoiceId,
      sourceType: charges.sourceType,
      description: charges.description,
      quantity: charges.quantity,
      unitPrice: charges.unitPrice,
      amount: charges.amount,
      voidedAt: charges.voidedAt,
      createdAt: charges.createdAt,
    })
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, facilityId),
        eq(charges.encounterId, encounter.encounterId),
      ),
    )
    .orderBy(asc(charges.createdAt));

  const invoiceIds = (
    await database
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.facilityId, facilityId),
          eq(invoices.encounterId, encounter.encounterId),
        ),
      )
  ).map((row) => row.id);

  const paymentRows = await loadPayments(database, facilityId, invoiceIds);
  const unbilledTotal = fromCents(
    chargeRows
      .filter((row) => !row.voidedAt && row.invoiceId == null)
      .reduce((total, row) => total + toCents(row.amount), 0),
  );

  const privacy = await getEncounterPrivacyStatus(database, facilityId, encounter.patientId, encounter.dob);

  return {
    encounterId: encounter.encounterId,
    encounterNo: encounter.encounterNo,
    encounterStatus: encounter.encounterStatus,
    payerType: encounter.payerType,
    startedAt: encounter.startedAt.toISOString(),
    endedAt: encounter.endedAt?.toISOString() ?? "",
    patientId: encounter.patientId,
    mrn: encounter.mrn,
    patientName: patientName(encounter.firstName, encounter.lastName),
    dob: encounter.dob,
    sex: encounter.sex,
    invoice: invoice ? toBillInvoice(invoice) : null,
    charges: chargeRows.map((row) => ({
      id: row.id,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      amount: row.amount,
      voidedAt: iso(row.voidedAt),
      createdAt: row.createdAt.toISOString(),
    })),
    payments: paymentRows,
    unbilledTotal,
    outstanding: fromCents(
      Math.max(0, toCents(invoice?.total ?? "0") + toCents(unbilledTotal) - toCents(invoice?.paid ?? "0")),
    ),
    privacy,
  };
}

/** One invoice with its lines and ledger, scoped to the facility. */
export async function getInvoiceDetail(
  database: BillingDatabase,
  facilityId: string,
  invoiceId: string,
): Promise<EncounterBill | null> {
  const rows = await database
    .select({ encounterId: invoices.encounterId })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, facilityId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return getEncounterBill(database, facilityId, row.encounterId);
}

/* ------------------------------------------------------------------ */
/* Receipts                                                            */
/* ------------------------------------------------------------------ */

export interface ReceiptView extends ReceiptData {
  paymentId: string;
  invoiceId: string;
  isReversal: boolean;
}

/**
 * Everything the 80 mm receipt needs, resolved in one call. The payment row is
 * immutable, so a reprinted receipt always matches the original.
 */
export async function getReceipt(
  database: BillingDatabase,
  facilityId: string,
  paymentId: string,
): Promise<ReceiptView | null> {
  const rows = await database
    .select({
      payment: payments,
      invoice: invoices,
      encounterNo: encounters.encounterNo,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      facilityName: facilities.name,
      facilityPhone: facilities.phone,
      branchName: branches.name,
      cashierName: user.name,
    })
    .from(payments)
    .innerJoin(invoices, and(eq(invoices.id, payments.invoiceId), eq(invoices.facilityId, payments.facilityId)))
    .innerJoin(encounters, and(eq(encounters.id, invoices.encounterId), eq(encounters.facilityId, invoices.facilityId)))
    .innerJoin(patients, and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)))
    .innerJoin(facilities, eq(facilities.id, payments.facilityId))
    .leftJoin(branches, eq(branches.id, encounters.branchId))
    .leftJoin(user, eq(user.id, payments.receivedBy))
    .where(and(eq(payments.id, paymentId), eq(payments.facilityId, facilityId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const lineRows = await database
    .select({
      description: charges.description,
      quantity: charges.quantity,
      unitPrice: charges.unitPrice,
      amount: charges.amount,
    })
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, facilityId),
        eq(charges.invoiceId, row.invoice.id),
        isNull(charges.voidedAt),
      ),
    )
    .orderBy(asc(charges.createdAt));

  const paymentRows = await database
    .select({
      receiptNo: payments.receiptNo,
      method: payments.method,
      amount: payments.amount,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.facilityId, facilityId), eq(payments.invoiceId, row.invoice.id)))
    .orderBy(asc(payments.createdAt));

  return {
    paymentId: row.payment.id,
    invoiceId: row.invoice.id,
    isReversal: row.payment.reversedPaymentId != null,
    facilityName: row.facilityName,
    facilityPhone: row.facilityPhone,
    branchName: row.branchName,
    patientName: patientName(row.firstName, row.lastName),
    mrn: row.mrn,
    encounterNo: row.encounterNo,
    invoiceNo: row.invoice.invoiceNo,
    receiptNo: row.payment.receiptNo,
    issuedAt: row.payment.createdAt.toISOString(),
    cashier: row.cashierName ?? row.payment.receivedBy,
    lines: lineRows.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
    total: row.invoice.total,
    paid: row.invoice.paid,
    outstanding: outstandingAmount(row.invoice.total, row.invoice.paid),
    payment: {
      method: row.payment.method,
      amount: row.payment.amount,
      reference: row.payment.reference,
    },
    payments: paymentRows.map((payment) => ({
      receiptNo: payment.receiptNo,
      method: payment.method,
      amount: payment.amount,
      receivedAt: payment.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Cashier sessions                                                    */
/* ------------------------------------------------------------------ */

export interface SessionMethodTotal {
  method: PaymentMethod;
  amount: string;
  count: number;
}

export interface CashierSessionView {
  sessionId: string;
  userId: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  note: string | null;
  isOpen: boolean;
  totals: SessionMethodTotal[];
  totalCollected: string;
  paymentCount: number;
}

async function sessionTotals(
  database: BillingDatabase,
  facilityId: string,
  sessionId: string,
): Promise<{ totals: SessionMethodTotal[]; totalCollected: string; paymentCount: number }> {
  const rows = await database
    .select({ method: payments.method, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.facilityId, facilityId), eq(payments.cashierSessionId, sessionId)));

  const totals = PAYMENT_METHODS.map((method) => {
    const matching = rows.filter((row) => row.method === method);
    return {
      method,
      amount: fromCents(matching.reduce((total, row) => total + toCents(row.amount), 0)),
      count: matching.length,
    };
  });

  return {
    totals,
    totalCollected: fromCents(rows.reduce((total, row) => total + toCents(row.amount), 0)),
    paymentCount: rows.length,
  };
}

function toSessionView(
  session: typeof cashierSessions.$inferSelect,
  totals: Awaited<ReturnType<typeof sessionTotals>>,
): CashierSessionView {
  return {
    sessionId: session.id,
    userId: session.userId,
    openedAt: session.openedAt.toISOString(),
    closedAt: iso(session.closedAt),
    openingFloat: session.openingFloat,
    expectedCash: session.expectedCash,
    countedCash: session.countedCash,
    variance: session.variance,
    note: session.note,
    isOpen: session.closedAt == null,
    totals: totals.totals,
    totalCollected: totals.totalCollected,
    paymentCount: totals.paymentCount,
  };
}

/** The signed-in cashier's open drawer, if they have one. */
export async function getOpenCashierSession(
  database: BillingDatabase,
  facilityId: string,
  userId: string,
): Promise<CashierSessionView | null> {
  const rows = await database
    .select()
    .from(cashierSessions)
    .where(
      and(
        eq(cashierSessions.facilityId, facilityId),
        eq(cashierSessions.userId, userId),
        isNull(cashierSessions.closedAt),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  return toSessionView(session, await sessionTotals(database, facilityId, session.id));
}

/** Recent sessions at the facility, newest first. */
export async function listCashierSessions(
  database: BillingDatabase,
  facilityId: string,
  limit = 10,
): Promise<CashierSessionView[]> {
  const rows = await database
    .select()
    .from(cashierSessions)
    .where(eq(cashierSessions.facilityId, facilityId))
    .orderBy(desc(cashierSessions.openedAt))
    .limit(Math.min(Math.max(limit, 1), 50));

  const views: CashierSessionView[] = [];
  for (const row of rows) {
    views.push(toSessionView(row, await sessionTotals(database, facilityId, row.id)));
  }
  return views;
}

export interface EndOfDayPayment {
  paymentId: string;
  receiptNo: string;
  invoiceId: string;
  invoiceNo: string;
  encounterNo: string;
  mrn: string;
  patientName: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
  receivedAt: string;
  isReversal: boolean;
}

export interface EndOfDayReport {
  session: CashierSessionView;
  payments: EndOfDayPayment[];
  totals: SessionMethodTotal[];
  totalCollected: string;
  totalReversed: string;
  netCollected: string;
  cashExpected: string;
  invoiceCount: number;
  paidInvoiceCount: number;
  invoiceTotal: string;
  invoicePaid: string;
}

/** Drawer reconciliation plus every receipt issued in the session. */
export async function getEndOfDayReport(
  database: BillingDatabase,
  facilityId: string,
  sessionId: string,
): Promise<EndOfDayReport | null> {
  const rows = await database
    .select()
    .from(cashierSessions)
    .where(and(eq(cashierSessions.id, sessionId), eq(cashierSessions.facilityId, facilityId)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;

  const totals = await sessionTotals(database, facilityId, session.id);

  const paymentRows = await database
    .select({
      paymentId: payments.id,
      receiptNo: payments.receiptNo,
      invoiceId: invoices.id,
      invoiceNo: invoices.invoiceNo,
      encounterNo: encounters.encounterNo,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      method: payments.method,
      amount: payments.amount,
      reference: payments.reference,
      receivedAt: payments.createdAt,
      reversedPaymentId: payments.reversedPaymentId,
    })
    .from(payments)
    .innerJoin(invoices, and(eq(invoices.id, payments.invoiceId), eq(invoices.facilityId, payments.facilityId)))
    .innerJoin(encounters, and(eq(encounters.id, invoices.encounterId), eq(encounters.facilityId, invoices.facilityId)))
    .innerJoin(patients, and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)))
    .where(and(eq(payments.facilityId, facilityId), eq(payments.cashierSessionId, session.id)))
    .orderBy(asc(payments.createdAt));

  const invoiceIds = [...new Set(paymentRows.map((row) => row.invoiceId))];
  const invoiceRows = invoiceIds.length
    ? await database
        .select({ id: invoices.id, status: invoices.status, total: invoices.total, paid: invoices.paid })
        .from(invoices)
        .where(and(eq(invoices.facilityId, facilityId), inArray(invoices.id, invoiceIds)))
    : [];

  const totalCollected = fromCents(
    paymentRows.filter((row) => toCents(row.amount) > 0).reduce((total, row) => total + toCents(row.amount), 0),
  );
  const totalReversed = fromCents(
    paymentRows.filter((row) => toCents(row.amount) < 0).reduce((total, row) => total + toCents(row.amount), 0),
  );

  return {
    session: toSessionView(session, totals),
    payments: paymentRows.map((row) => ({
      paymentId: row.paymentId,
      receiptNo: row.receiptNo,
      invoiceId: row.invoiceId,
      invoiceNo: row.invoiceNo,
      encounterNo: row.encounterNo,
      mrn: row.mrn,
      patientName: patientName(row.firstName, row.lastName),
      method: row.method,
      amount: row.amount,
      reference: row.reference,
      receivedAt: row.receivedAt.toISOString(),
      isReversal: row.reversedPaymentId != null,
    })),
    totals: totals.totals,
    totalCollected,
    totalReversed,
    netCollected: fromCents(toCents(totalCollected) + toCents(totalReversed)),
    cashExpected: sessionExpectedCash(
      session.openingFloat,
      paymentRows.map((row) => ({ method: row.method, amount: row.amount })),
    ),
    invoiceCount: invoiceRows.length,
    paidInvoiceCount: invoiceRows.filter((row) => row.status === "paid").length,
    invoiceTotal: fromCents(invoiceRows.reduce((total, row) => total + toCents(row.total), 0)),
    invoicePaid: fromCents(invoiceRows.reduce((total, row) => total + toCents(row.paid), 0)),
  };
}

/* ------------------------------------------------------------------ */
/* Catalogue (used by the workspace to explain a line)                 */
/* ------------------------------------------------------------------ */

export interface PriceListSummary {
  id: string;
  name: string;
  payerType: string;
  active: boolean;
  priceCount: number;
}

export async function listPriceLists(
  database: BillingDatabase,
  facilityId: string,
): Promise<PriceListSummary[]> {
  const rows = await database
    .select({
      id: priceLists.id,
      name: priceLists.name,
      payerType: priceLists.payerType,
      active: priceLists.active,
      priceCount: sql<number>`count(${prices.id})::int`,
    })
    .from(priceLists)
    .leftJoin(prices, eq(prices.priceListId, priceLists.id))
    .where(eq(priceLists.facilityId, facilityId))
    .groupBy(priceLists.id, priceLists.name, priceLists.payerType, priceLists.active)
    .orderBy(asc(priceLists.payerType));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    payerType: row.payerType,
    active: row.active,
    priceCount: Number(row.priceCount),
  }));
}

/** Kept for callers that only need the active invoice of an encounter. */
export async function getActiveInvoiceId(
  database: BillingDatabase,
  facilityId: string,
  encounterId: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.facilityId, facilityId),
        eq(invoices.encounterId, encounterId),
        inArray(invoices.status, ["open", "partial"]),
        ne(invoices.status, "void"),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}
