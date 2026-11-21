import { and, asc, desc, eq, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { EtimsQueueStatus, EtimsDocumentType, TaxTreatment } from "@/lib/tax";
import type { AppDatabase } from "@/server/db/client";
import {
  encounters,
  etimsInvoiceLines,
  etimsInvoiceQueue,
  facilities,
  integrationSettings,
  invoices,
  patients,
  taxCodes,
} from "@/server/db/schema";

export type TaxDatabase = AppDatabase;

export const transactionFilterSchema = z.object({
  queueId: z.uuid().optional(),
  status: z.enum([
    "pending",
    "transmitting",
    "transmitted",
    "acknowledged",
    "rejected",
    "failed",
    "cancelled",
  ]).optional(),
  documentType: z.enum(["invoice", "credit_note", "debit_note"]).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(120).optional(),
});

export type TransactionFilters = z.infer<typeof transactionFilterSchema>;

export interface EtimsTransactionRow {
  transNo: string;
  queueId: string;
  invoiceNo: string;
  company: string;
  date: string;
  patient: string;
  amount: string;
  status: EtimsQueueStatus;
  documentType: EtimsDocumentType;
  environment: "sandbox" | "production";
  attempts: number;
  kraControlNo: string | null;
  kraSignature: string | null;
  qrUrl: string | null;
  cuNo: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  buyerName: string | null;
  creditNoteOf: string | null;
}

export interface EtimsTransactionLine {
  lineNo: number;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
  taxCode: string | null;
  taxTreatment: TaxTreatment | null;
  taxRate: string;
  taxAmount: string;
}

export interface EtimsTransactionDetail extends EtimsTransactionRow {
  invoiceId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
  lines: EtimsTransactionLine[];
}

const patientName = sql<string>`trim(concat_ws(' ', ${patients.firstName}, ${patients.lastName}))`;

function transactionSelection(database: TaxDatabase) {
  return database
    .select({
      transNo: sql<string>`'ET-' || replace(${etimsInvoiceQueue.id}::text, '-', '')::text`.as("trans_no"),
      queueId: etimsInvoiceQueue.id,
      invoiceNo: etimsInvoiceQueue.invoiceNo,
      company: facilities.name,
      date: etimsInvoiceQueue.enqueuedAt,
      patient: patientName.as("patient"),
      amount: etimsInvoiceQueue.totalAmount,
      status: etimsInvoiceQueue.status,
      documentType: etimsInvoiceQueue.documentType,
      environment: etimsInvoiceQueue.environment,
      attempts: etimsInvoiceQueue.attempts,
      kraControlNo: etimsInvoiceQueue.kraControlNo,
      kraSignature: etimsInvoiceQueue.kraSignature,
      qrUrl: etimsInvoiceQueue.qrUrl,
      cuNo: etimsInvoiceQueue.cuNo,
      lastError: etimsInvoiceQueue.lastError,
      nextAttemptAt: etimsInvoiceQueue.nextAttemptAt,
      buyerName: etimsInvoiceQueue.buyerName,
      creditNoteOf: etimsInvoiceQueue.creditNoteOf,
      invoiceId: etimsInvoiceQueue.invoiceId,
      responseCode: etimsInvoiceQueue.responseCode,
      responseMessage: etimsInvoiceQueue.responseMessage,
    })
    .from(etimsInvoiceQueue)
    .innerJoin(facilities, eq(etimsInvoiceQueue.facilityId, facilities.id))
    .leftJoin(invoices, eq(etimsInvoiceQueue.invoiceId, invoices.id))
    .leftJoin(encounters, eq(invoices.encounterId, encounters.id))
    .leftJoin(patients, eq(encounters.patientId, patients.id));
}

function mapTransaction(row: {
  transNo: string;
  queueId: string;
  invoiceNo: string;
  company: string;
  date: Date;
  patient: string | null;
  amount: string;
  status: EtimsQueueStatus;
  documentType: EtimsDocumentType;
  environment: "sandbox" | "production";
  attempts: number;
  kraControlNo: string | null;
  kraSignature: string | null;
  qrUrl: string | null;
  cuNo: string | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  buyerName: string | null;
  creditNoteOf: string | null;
  invoiceId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
}): EtimsTransactionDetail {
  return {
    ...row,
    patient: row.patient || row.buyerName || "—",
    date: row.date.toISOString(),
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    lines: [],
  };
}

export async function listEtimsTransactions(
  database: TaxDatabase,
  facilityId: string,
  filters: TransactionFilters = {},
): Promise<EtimsTransactionRow[]> {
  const conditions = [eq(etimsInvoiceQueue.facilityId, facilityId)];
  if (filters.queueId) conditions.push(eq(etimsInvoiceQueue.id, filters.queueId));
  if (filters.status) conditions.push(eq(etimsInvoiceQueue.status, filters.status));
  if (filters.documentType) {
    conditions.push(eq(etimsInvoiceQueue.documentType, filters.documentType));
  }
  if (filters.environment) conditions.push(eq(etimsInvoiceQueue.environment, filters.environment));
  if (filters.from) {
    conditions.push(sql`${etimsInvoiceQueue.enqueuedAt} >= ${`${filters.from}T00:00:00.000Z`}::timestamptz`);
  }
  if (filters.to) {
    conditions.push(sql`${etimsInvoiceQueue.enqueuedAt} <= ${`${filters.to}T23:59:59.999Z`}::timestamptz`);
  }
  if (filters.search) {
    const needle = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(etimsInvoiceQueue.invoiceNo, needle),
        ilike(etimsInvoiceQueue.buyerName, needle),
        ilike(sql`${patients.firstName} || ' ' || ${patients.lastName}`, needle),
      )!,
    );
  }

  const rows = await transactionSelection(database)
    .where(and(...conditions))
    .orderBy(desc(etimsInvoiceQueue.enqueuedAt))
    .limit(250);
  return rows.map((row) => mapTransaction(row));
}

export async function getEtimsTransactionDetail(
  database: TaxDatabase,
  facilityId: string,
  queueId: string,
): Promise<EtimsTransactionDetail | null> {
  const rows = await transactionSelection(database)
    .where(and(eq(etimsInvoiceQueue.facilityId, facilityId), eq(etimsInvoiceQueue.id, queueId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const lines = await database
    .select({
      lineNo: etimsInvoiceLines.lineNo,
      description: etimsInvoiceLines.description,
      quantity: etimsInvoiceLines.quantity,
      unitPrice: etimsInvoiceLines.unitPrice,
      amount: etimsInvoiceLines.amount,
      taxCode: etimsInvoiceLines.taxCode,
      taxTreatment: etimsInvoiceLines.taxTreatment,
      taxRate: etimsInvoiceLines.taxRate,
      taxAmount: etimsInvoiceLines.taxAmount,
    })
    .from(etimsInvoiceLines)
    .where(
      and(eq(etimsInvoiceLines.facilityId, facilityId), eq(etimsInvoiceLines.queueId, queueId)),
    )
    .orderBy(asc(etimsInvoiceLines.lineNo));

  return { ...mapTransaction(row), lines };
}

export async function listTaxCodes(database: TaxDatabase, facilityId: string) {
  return database
    .select({
      id: taxCodes.id,
      code: taxCodes.code,
      name: taxCodes.name,
      rate: taxCodes.rate,
      treatment: taxCodes.treatment,
      kraCode: taxCodes.kraCode,
      effectiveFrom: taxCodes.effectiveFrom,
      effectiveTo: taxCodes.effectiveTo,
      active: taxCodes.active,
      isDefault: taxCodes.isDefault,
      version: taxCodes.version,
    })
    .from(taxCodes)
    .where(eq(taxCodes.facilityId, facilityId))
    .orderBy(asc(taxCodes.code), desc(taxCodes.effectiveFrom));
}

export async function listFinalisableInvoices(database: TaxDatabase, facilityId: string) {
  return database
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      total: invoices.total,
      status: invoices.status,
      createdAt: invoices.createdAt,
      patient: patientName.as("patient"),
      finalizedAt: invoices.finalizedAt,
    })
    .from(invoices)
    .innerJoin(encounters, eq(invoices.encounterId, encounters.id))
    .innerJoin(patients, eq(encounters.patientId, patients.id))
    .where(
      and(
        eq(invoices.facilityId, facilityId),
        isNull(invoices.finalizedAt),
        inArray(invoices.status, ["open", "partial", "paid"]),
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(100);
}

export async function listEtimsIntegrations(database: TaxDatabase, facilityId: string) {
  return database
    .select({
      id: integrationSettings.id,
      environment: integrationSettings.environment,
      baseUrl: integrationSettings.baseUrl,
      specVersion: integrationSettings.specVersion,
      mode: integrationSettings.mode,
      credentialRef: integrationSettings.credentialRef,
      timeoutMs: integrationSettings.timeoutMs,
      maxAttempts: integrationSettings.maxAttempts,
      backoffSeconds: integrationSettings.backoffSeconds,
      enabled: integrationSettings.enabled,
      lastVerifiedAt: integrationSettings.lastVerifiedAt,
    })
    .from(integrationSettings)
    .where(
      and(
        eq(integrationSettings.facilityId, facilityId),
        eq(integrationSettings.integration, "etims"),
      ),
    )
    .orderBy(asc(integrationSettings.environment));
}

/** Counts used by the KRA screen's compact summary strip. */
export async function getEtimsSummary(database: TaxDatabase, facilityId: string) {
  const rows = await database
    .select({
      status: etimsInvoiceQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(etimsInvoiceQueue)
    .where(eq(etimsInvoiceQueue.facilityId, facilityId))
    .groupBy(etimsInvoiceQueue.status);

  const byStatus = new Map(rows.map((row) => [row.status, row.count]));
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    acknowledged: byStatus.get("acknowledged") ?? 0,
    pending: byStatus.get("pending") ?? 0,
    failed: (byStatus.get("failed") ?? 0) + (byStatus.get("rejected") ?? 0),
  };
}

/** Restricts a reconciliation report to the same facility as the caller. */
export async function isQueueInFacility(
  database: TaxDatabase,
  facilityId: string,
  queueId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: etimsInvoiceQueue.id })
    .from(etimsInvoiceQueue)
    .where(and(eq(etimsInvoiceQueue.facilityId, facilityId), eq(etimsInvoiceQueue.id, queueId)))
    .limit(1);
  return rows.length > 0;
}

export async function pendingBefore(
  database: TaxDatabase,
  facilityId: string,
  threshold: Date,
) {
  return database
    .select({ id: etimsInvoiceQueue.id })
    .from(etimsInvoiceQueue)
    .where(
      and(
        eq(etimsInvoiceQueue.facilityId, facilityId),
        eq(etimsInvoiceQueue.status, "pending"),
        lte(etimsInvoiceQueue.enqueuedAt, threshold),
      ),
    );
}
