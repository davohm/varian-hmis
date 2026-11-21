import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, lineAmount, sumAmounts, toCents } from "@/lib/billing";
import { isValidKraPin, normalizeKraPin } from "@/lib/regulatory";
import {
  DEFAULT_ETIMS_STALE_SECONDS,
  ETIMS_MODES,
  TAX_TREATMENTS,
  type EtimsDocumentLine,
  type EtimsDocumentSnapshot,
  type EtimsIntegrationConfiguration,
  type EtimsRequestPayload,
  type TaxTreatment,
} from "@/lib/tax";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { db } from "@/server/db/client";
import {
  charges,
  encounters,
  etimsInvoiceLines,
  etimsInvoiceQueue,
  etimsOutbox,
  etimsTransmissionLog,
  facilities,
  facilityRegulatoryProfiles,
  integrationSettings,
  invoices,
  patients,
  taxCodeApplicabilities,
  taxCodes,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import {
  buildEtimsRequestPayload,
  createEtimsClient,
  type EtimsClient,
} from "@/server/integrations/etims";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export interface TaxCommandOptions extends CommandOptions {
  etimsClientFactory?: (config: EtimsIntegrationConfiguration) => EtimsClient;
  env?: NodeJS.ProcessEnv;
}

/** All tax commands share the app database unless a test injects one. */
function databaseFor(options: TaxCommandOptions) {
  return options.database ?? db;
}

function derivedKey(key: string, suffix: string): string {
  const hex = createHash("sha256").update(`${key}:${suffix}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

/* ------------------------------------------------------------------ */
/* Tax code master                                                     */
/* ------------------------------------------------------------------ */

const rateSchema = z
  .union([z.string(), z.number()])
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value) && value >= 0 && value <= 100, {
    message: "Tax rate must be between 0 and 100",
  });

export const upsertTaxCodeSchema = z.object({
  ...baseSchema,
  taxCodeId: z.uuid().optional(),
  code: z.string().trim().min(1).max(32).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  rate: rateSchema,
  treatment: z.enum(TAX_TREATMENTS),
  kraCode: z.string().trim().max(32).nullable().optional(),
  effectiveFrom: dateString,
  effectiveTo: dateString.nullable().optional(),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export type UpsertTaxCodeInput = z.input<typeof upsertTaxCodeSchema>;

export interface TaxCodeResult {
  taxCodeId: string;
  code: string;
  version: number;
}

export async function upsertTaxCode(
  input: UpsertTaxCodeInput,
  options: TaxCommandOptions = {},
): Promise<TaxCodeResult> {
  const values = upsertTaxCodeSchema.parse(input);
  const userId = actorId(values);
  if (values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
    throw new Error("The effective end date must be on or after the start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertTaxCode",
    async (tx) => {
      const overlap = await tx
        .select({ id: taxCodes.id })
        .from(taxCodes)
        .where(
          and(
            eq(taxCodes.facilityId, values.facilityId),
            eq(taxCodes.code, values.code),
            values.taxCodeId ? ne(taxCodes.id, values.taxCodeId) : sql`true`,
            lte(taxCodes.effectiveFrom, values.effectiveTo ?? "9999-12-31"),
            sql`(${taxCodes.effectiveTo} is null or ${taxCodes.effectiveTo} >= ${values.effectiveFrom})`,
          ),
        )
        .limit(1);
      if (overlap[0]) {
        throw new Error(`Tax code ${values.code} already has an overlapping effective range`);
      }

      const rate = values.rate.toFixed(4);
      let taxCodeId = values.taxCodeId;
      let version = 1;

      if (taxCodeId) {
        const existing = await tx
          .select({ version: taxCodes.version })
          .from(taxCodes)
          .where(and(eq(taxCodes.id, taxCodeId), eq(taxCodes.facilityId, values.facilityId)))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new Error("Tax code not found in this facility");
        version = existing[0].version + 1;
        await tx
          .update(taxCodes)
          .set({
            name: values.name,
            rate,
            treatment: values.treatment,
            kraCode: values.kraCode ?? null,
            effectiveFrom: values.effectiveFrom,
            effectiveTo: values.effectiveTo ?? null,
            active: values.active,
            isDefault: values.isDefault,
            updatedAt: new Date(),
            version,
          })
          .where(eq(taxCodes.id, taxCodeId));
      } else {
        const inserted = await tx
          .insert(taxCodes)
          .values({
            id: newId(),
            facilityId: values.facilityId,
            code: values.code,
            name: values.name,
            rate,
            treatment: values.treatment,
            kraCode: values.kraCode ?? null,
            effectiveFrom: values.effectiveFrom,
            effectiveTo: values.effectiveTo ?? null,
            active: values.active,
            isDefault: values.isDefault,
            createdBy: userId,
          })
          .returning({ id: taxCodes.id, version: taxCodes.version });
        taxCodeId = inserted[0].id;
        version = inserted[0].version;
      }

      if (values.isDefault) {
        await tx
          .update(taxCodes)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(taxCodes.facilityId, values.facilityId),
              ne(taxCodes.id, taxCodeId!),
              eq(taxCodes.isDefault, true),
            ),
          );
      }

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "tax.upsertTaxCode",
        module: "tax",
        entity: "tax_code",
        entityId: taxCodeId,
        details: { code: values.code, rate, treatment: values.treatment },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { taxCodeId: taxCodeId!, code: values.code, version };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Shared tax snapshot helpers                                         */
/* ------------------------------------------------------------------ */

async function loadKraPin(
  database: NonNullable<TaxCommandOptions["database"]>,
  facilityId: string,
  userId: string,
  actor: z.infer<typeof actorSchema>,
  action: string,
): Promise<string> {
  const rows = await database
    .select({ kraPin: facilityRegulatoryProfiles.kraPin })
    .from(facilityRegulatoryProfiles)
    .where(eq(facilityRegulatoryProfiles.facilityId, facilityId))
    .limit(1);
  const raw = rows[0]?.kraPin ?? null;
  if (isValidKraPin(raw)) return normalizeKraPin(raw!);

  await recordAudit(database, {
    facilityId,
    userId,
    action,
    module: "tax",
    entity: "etims_queue",
    details: { reason: "A valid KRA PIN is required" },
    deviceId: actor.deviceId,
    ip: actor.ip,
  });
  throw new Error("A valid KRA PIN is required before an eTIMS document can be enqueued");
}

async function loadIntegrationConfig(
  tx: CommandTransaction,
  facilityId: string,
  environment: "sandbox" | "production",
): Promise<EtimsIntegrationConfiguration> {
  const rows = await tx
    .select()
    .from(integrationSettings)
    .where(
      and(
        eq(integrationSettings.facilityId, facilityId),
        eq(integrationSettings.integration, "etims"),
        eq(integrationSettings.environment, environment),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.baseUrl) {
    throw new Error(`No eTIMS ${environment} integration is configured for this facility`);
  }
  const mode = ETIMS_MODES.find((value) => value === row.mode) ?? "oscu";
  return {
    id: row.id,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    environment,
    mode,
    specVersion: row.specVersion ?? "oscu-1.0",
    timeoutMs: row.timeoutMs,
    maxAttempts: row.maxAttempts,
    backoffSeconds: row.backoffSeconds,
    credentialRef: row.credentialRef,
  };
}

function resolveTaxRate(rate: string): string {
  const value = Number(rate);
  return Number.isFinite(value) ? value.toFixed(4) : "0.0000";
}

function deriveLineTax(treatment: TaxTreatment, rate: string, amount: string): string {
  if (treatment !== "vat_standard") return "0.00";
  return fromCents(Math.round(toCents(amount) * (Number(rate) / 100)));
}

async function findTaxCodeForCharge(
  tx: CommandTransaction,
  facilityId: string,
  serviceId: string | null,
  itemId: string | null,
  date: string,
): Promise<{ code: string; treatment: TaxTreatment; rate: string }> {
  const conditions = [
    eq(taxCodeApplicabilities.facilityId, facilityId),
    eq(taxCodeApplicabilities.active, true),
    lte(taxCodeApplicabilities.effectiveFrom, date),
    sql`(${taxCodeApplicabilities.effectiveTo} is null or ${taxCodeApplicabilities.effectiveTo} >= ${date})`,
    or(
      serviceId
        ? eq(taxCodeApplicabilities.serviceId, serviceId)
        : sql`false`,
      itemId
        ? eq(taxCodeApplicabilities.itemId, itemId)
        : sql`false`,
    ),
  ];
  const overrides = await tx
    .select({
      code: taxCodes.code,
      treatment: taxCodes.treatment,
      rate: taxCodes.rate,
    })
    .from(taxCodeApplicabilities)
    .innerJoin(taxCodes, eq(taxCodeApplicabilities.taxCodeId, taxCodes.id))
    .where(and(...conditions))
    .orderBy(desc(taxCodeApplicabilities.effectiveFrom))
    .limit(1);
  const override = overrides[0];
  if (override) {
    return {
      code: override.code,
      treatment: override.treatment,
      rate: resolveTaxRate(override.rate),
    };
  }

  const defaults = await tx
    .select({ code: taxCodes.code, treatment: taxCodes.treatment, rate: taxCodes.rate })
    .from(taxCodes)
    .where(
      and(
        eq(taxCodes.facilityId, facilityId),
        eq(taxCodes.active, true),
        eq(taxCodes.isDefault, true),
        lte(taxCodes.effectiveFrom, date),
        sql`(${taxCodes.effectiveTo} is null or ${taxCodes.effectiveTo} >= ${date})`,
      ),
    )
    .orderBy(desc(taxCodes.effectiveFrom))
    .limit(1);
  const fallback = defaults[0];
  if (!fallback) throw new Error("No active default tax code is configured for this facility");
  return {
    code: fallback.code,
    treatment: fallback.treatment,
    rate: resolveTaxRate(fallback.rate),
  };
}

async function buildDocumentSnapshot(
  tx: CommandTransaction,
  values: {
    facilityId: string;
    invoiceId: string;
    kraPin: string;
    idempotencyKey: string;
    queueId: string;
    buyerPin?: string | null;
    buyerName?: string | null;
    buyerType?: string | null;
  },
  requireFinalized = true,
): Promise<EtimsDocumentSnapshot> {
  const invoiceRows = await tx
    .select({
      invoiceId: invoices.id,
      invoiceNo: invoices.invoiceNo,
      total: invoices.total,
      createdAt: invoices.createdAt,
      finalizedAt: invoices.finalizedAt,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      payerType: patients.payerType,
    })
    .from(invoices)
    .innerJoin(facilities, eq(invoices.facilityId, facilities.id))
    .innerJoin(encounters, eq(invoices.encounterId, encounters.id))
    .innerJoin(patients, eq(encounters.patientId, patients.id))
    .where(and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) throw new Error("Invoice not found in this facility");
  if (requireFinalized && !invoice.finalizedAt) {
    throw new Error("An invoice must be finalised before eTIMS enqueue");
  }

  const invoiceDate = invoice.createdAt.toISOString().slice(0, 10);
  const chargeRows = await tx
    .select({
      serviceId: charges.serviceId,
      itemId: charges.itemId,
      description: charges.description,
      quantity: charges.quantity,
      unitPrice: charges.unitPrice,
      amount: charges.amount,
    })
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, values.facilityId),
        eq(charges.invoiceId, values.invoiceId),
        isNull(charges.voidedAt),
      ),
    )
    .orderBy(asc(charges.createdAt), asc(charges.id));

  const lines: EtimsDocumentLine[] = [];
  for (const [index, charge] of chargeRows.entries()) {
    const taxCode = await findTaxCodeForCharge(
      tx,
      values.facilityId,
      charge.serviceId,
      charge.itemId,
      invoiceDate,
    );
    const amount = lineAmount(charge.unitPrice, charge.quantity) || charge.amount;
    const taxAmount = deriveLineTax(taxCode.treatment, taxCode.rate, amount);
    lines.push({
      lineNo: index + 1,
      description: charge.description,
      quantity: charge.quantity,
      unitPrice: charge.unitPrice,
      amount,
      taxCode: taxCode.code,
      taxTreatment: taxCode.treatment,
      taxRate: taxCode.rate,
      taxAmount,
    });
  }
  if (lines.length === 0) throw new Error("A finalised invoice must have at least one charge line");

  const totalAmount = sumAmounts(lines.map((line) => line.amount));
  if (toCents(totalAmount) !== toCents(invoice.total)) {
    throw new Error("The invoice total does not match its active charge lines");
  }
  const taxAmount = sumAmounts(lines.map((line) => line.taxAmount));
  const buyerPin = values.buyerPin?.trim() ? normalizeKraPin(values.buyerPin) : null;
  if (buyerPin && !isValidKraPin(buyerPin)) throw new Error("The buyer KRA PIN is invalid");

  return {
    queueId: values.queueId,
    facilityId: values.facilityId,
    facilityCode: invoice.facilityCode,
    facilityName: invoice.facilityName,
    kraPin: values.kraPin,
    idempotencyKey: values.idempotencyKey,
    invoiceNo: invoice.invoiceNo,
    invoiceDate,
    documentType: "invoice",
    creditNoteOf: null,
    originalInvoiceNo: null,
    buyerPin,
    buyerName: values.buyerName?.trim() || `${invoice.patientFirstName} ${invoice.patientLastName}`,
    buyerType: values.buyerType?.trim() || invoice.payerType,
    currency: "KES",
    totalAmount,
    taxAmount,
    lines,
  };
}

interface QueueInsert {
  facilityId: string;
  idempotencyKey: string;
  invoiceId: string;
  invoiceNo: string;
  documentType: "invoice" | "credit_note" | "debit_note";
  creditNoteOf: string | null;
  environment: "sandbox" | "production";
  config: EtimsIntegrationConfiguration;
  snapshot: EtimsDocumentSnapshot;
  createdBy: string;
}

async function insertQueueDocument(
  tx: CommandTransaction,
  input: QueueInsert,
): Promise<typeof etimsInvoiceQueue.$inferSelect> {
  const existing = await tx
    .select()
    .from(etimsInvoiceQueue)
    .where(
      and(
        eq(etimsInvoiceQueue.facilityId, input.facilityId),
        eq(etimsInvoiceQueue.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const [queue] = await tx
    .insert(etimsInvoiceQueue)
    .values({
      id: newId(),
      facilityId: input.facilityId,
      idempotencyKey: input.idempotencyKey,
      invoiceId: input.invoiceId,
      invoiceNo: input.invoiceNo,
      creditNoteOf: input.creditNoteOf,
      documentType: input.documentType,
      integrationMode: input.config.mode,
      environment: input.environment,
      buyerPin: input.snapshot.buyerPin,
      buyerName: input.snapshot.buyerName,
      buyerType: input.snapshot.buyerType,
      currency: input.snapshot.currency,
      totalAmount: input.snapshot.totalAmount,
      taxAmount: input.snapshot.taxAmount,
      createdBy: input.createdBy,
    })
    .returning();

  await tx.insert(etimsInvoiceLines).values(
    input.snapshot.lines.map((line) => ({
      id: newId(),
      facilityId: input.facilityId,
      queueId: queue.id,
      lineNo: line.lineNo,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxCode: line.taxCode,
      taxTreatment: line.taxTreatment,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
    })),
  );

  const snapshot = { ...input.snapshot, queueId: queue.id };
  const requestPayload: EtimsRequestPayload = buildEtimsRequestPayload(snapshot, input.config);
  await tx.insert(etimsOutbox).values({
    id: newId(),
    facilityId: input.facilityId,
    queueId: queue.id,
    idempotencyKey: input.idempotencyKey,
    environment: input.environment,
    mode: input.config.mode,
    requestPayload,
    nextAttemptAt: new Date(),
  });

  await recordAudit(tx, {
    facilityId: input.facilityId,
    userId: input.createdBy,
    action: "etims.enqueue",
    module: "tax",
    entity: "etims_queue",
    entityId: queue.id,
    details: {
      invoiceNo: queue.invoiceNo,
      documentType: queue.documentType,
      environment: queue.environment,
      totalAmount: queue.totalAmount,
    },
  });
  await publishEvent(tx, {
    type: "tax.etims.enqueued",
    facilityId: input.facilityId,
    queueId: queue.id,
    invoiceNo: queue.invoiceNo,
  });

  return queue;
}

/* ------------------------------------------------------------------ */
/* Finalisation and enqueue                                            */
/* ------------------------------------------------------------------ */

export const finalizeInvoiceSchema = z.object({
  ...baseSchema,
  invoiceId: z.uuid(),
  buyerPin: z.string().trim().max(16).nullable().optional(),
  buyerName: z.string().trim().max(200).nullable().optional(),
  buyerType: z.string().trim().max(32).nullable().optional(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
});

export type FinalizeInvoiceInput = z.input<typeof finalizeInvoiceSchema>;

export interface EtimsQueueResult {
  queueId: string;
  invoiceNo: string;
  documentType: "invoice" | "credit_note" | "debit_note";
  status: string;
  totalAmount: string;
  taxAmount: string;
  environment: "sandbox" | "production";
  integrationMode: "oscu" | "vscu";
}

function queueResult(row: typeof etimsInvoiceQueue.$inferSelect): EtimsQueueResult {
  return {
    queueId: row.id,
    invoiceNo: row.invoiceNo,
    documentType: row.documentType,
    status: row.status,
    totalAmount: row.totalAmount,
    taxAmount: row.taxAmount,
    environment: row.environment,
    integrationMode: row.integrationMode,
  };
}

async function enqueueCore(
  tx: CommandTransaction,
  values: z.infer<typeof enqueueEtimsInvoiceSchema>,
  kraPin: string,
  userId: string,
): Promise<EtimsQueueResult> {
  const existing = await tx
    .select()
    .from(etimsInvoiceQueue)
    .where(
      and(
        eq(etimsInvoiceQueue.facilityId, values.facilityId),
        eq(etimsInvoiceQueue.invoiceId, values.invoiceId),
        eq(etimsInvoiceQueue.documentType, "invoice"),
      ),
    )
    .limit(1);
  if (existing[0]) return queueResult(existing[0]);

  const invoiceRows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)))
    .limit(1)
    .for("update");
  const invoice = invoiceRows[0];
  if (!invoice) throw new Error("Invoice not found in this facility");
  if (invoice.status === "void" || invoice.voidedAt) throw new Error("A void invoice cannot be enqueued");
  if (!invoice.finalizedAt) throw new Error("An invoice must be finalised before eTIMS enqueue");

  const config = await loadIntegrationConfig(tx, values.facilityId, values.environment);
  const placeholder = await buildDocumentSnapshot(tx, {
    facilityId: values.facilityId,
    invoiceId: values.invoiceId,
    kraPin,
    idempotencyKey: values.idempotencyKey,
    queueId: "",
    buyerPin: values.buyerPin,
    buyerName: values.buyerName,
    buyerType: values.buyerType,
  });
  const queue = await insertQueueDocument(tx, {
    facilityId: values.facilityId,
    idempotencyKey: values.idempotencyKey,
    invoiceId: values.invoiceId,
    invoiceNo: invoice.invoiceNo,
    documentType: "invoice",
    creditNoteOf: null,
    environment: values.environment,
    config,
    snapshot: placeholder,
    createdBy: userId,
  });
  return queueResult(queue);
}

export async function finalizeInvoice(
  input: FinalizeInvoiceInput,
  options: TaxCommandOptions = {},
): Promise<EtimsQueueResult> {
  const values = finalizeInvoiceSchema.parse(input);
  const userId = actorId(values);
  const database = databaseFor(options);
  const kraPin = await loadKraPin(
    database,
    values.facilityId,
    userId,
    values.actor,
    "tax.finalize.blocked",
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "finalizeInvoice",
    async (tx) => {
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const invoice = invoiceRows[0];
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.status === "void" || invoice.voidedAt) throw new Error("A void invoice cannot be finalised");
      if (invoice.finalizedAt) throw new Error("This invoice is already finalised");

      const config = await loadIntegrationConfig(tx, values.facilityId, values.environment);
      const snapshot = await buildDocumentSnapshot(
        tx,
        {
          facilityId: values.facilityId,
          invoiceId: values.invoiceId,
          kraPin,
          idempotencyKey: values.idempotencyKey,
          queueId: "",
          buyerPin: values.buyerPin,
          buyerName: values.buyerName,
          buyerType: values.buyerType,
        },
        false,
      );
      await tx
        .update(invoices)
        .set({ finalizedAt: new Date(), finalizedBy: userId, updatedAt: new Date() })
        .where(eq(invoices.id, invoice.id));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "tax.finalizeInvoice",
        module: "tax",
        entity: "invoice",
        entityId: invoice.id,
        details: { invoiceNo: invoice.invoiceNo },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      const queue = await insertQueueDocument(tx, {
        facilityId: values.facilityId,
        idempotencyKey: values.idempotencyKey,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        documentType: "invoice",
        creditNoteOf: null,
        environment: values.environment,
        config,
        snapshot,
        createdBy: userId,
      });
      return queueResult(queue);
    },
    options,
  );
}

export const enqueueEtimsInvoiceSchema = z.object({
  ...baseSchema,
  invoiceId: z.uuid(),
  buyerPin: z.string().trim().max(16).nullable().optional(),
  buyerName: z.string().trim().max(200).nullable().optional(),
  buyerType: z.string().trim().max(32).nullable().optional(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
});

export type EnqueueEtimsInvoiceInput = z.input<typeof enqueueEtimsInvoiceSchema>;

export async function enqueueEtimsInvoice(
  input: EnqueueEtimsInvoiceInput,
  options: TaxCommandOptions = {},
): Promise<EtimsQueueResult> {
  const values = enqueueEtimsInvoiceSchema.parse(input);
  const userId = actorId(values);
  const database = databaseFor(options);
  const kraPin = await loadKraPin(
    database,
    values.facilityId,
    userId,
    values.actor,
    "tax.enqueue.blocked",
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "enqueueEtimsInvoice",
    async (tx) => enqueueCore(tx, values, kraPin, userId),
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Transmission, retry and correction                                  */
/* ------------------------------------------------------------------ */

export const transmitEtimsInvoiceSchema = z.object({
  ...baseSchema,
  queueId: z.uuid(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
});

export type TransmitEtimsInvoiceInput = z.input<typeof transmitEtimsInvoiceSchema>;

export interface TransmitResult {
  queueId: string;
  status: string;
  attempts: number;
  responseCode: string | null;
  responseMessage: string | null;
  kraControlNo: string | null;
  kraSignature: string | null;
  qrUrl: string | null;
  nextAttemptAt: string | null;
}

async function snapshotFromQueue(
  tx: CommandTransaction,
  facilityId: string,
  queue: typeof etimsInvoiceQueue.$inferSelect,
  kraPin: string,
): Promise<EtimsDocumentSnapshot> {
  const lineRows = await tx
    .select()
    .from(etimsInvoiceLines)
    .where(and(eq(etimsInvoiceLines.facilityId, facilityId), eq(etimsInvoiceLines.queueId, queue.id)))
    .orderBy(asc(etimsInvoiceLines.lineNo));
  const invoiceRows = queue.invoiceId
    ? await tx
        .select({ createdAt: invoices.createdAt })
        .from(invoices)
        .where(and(eq(invoices.id, queue.invoiceId), eq(invoices.facilityId, facilityId)))
        .limit(1)
    : [];
  const facilityRows = await tx
    .select({ code: facilities.code, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const originalRows = queue.creditNoteOf
    ? await tx
        .select({ invoiceNo: etimsInvoiceQueue.invoiceNo })
        .from(etimsInvoiceQueue)
        .where(and(eq(etimsInvoiceQueue.id, queue.creditNoteOf), eq(etimsInvoiceQueue.facilityId, facilityId)))
        .limit(1)
    : [];

  return {
    queueId: queue.id,
    facilityId,
    facilityCode: facilityRows[0]?.code ?? "FAC",
    facilityName: facilityRows[0]?.name ?? "Facility",
    kraPin,
    idempotencyKey: queue.idempotencyKey,
    invoiceNo: queue.invoiceNo,
    invoiceDate: (
      queue.documentType === "invoice"
        ? invoiceRows[0]?.createdAt ?? queue.enqueuedAt
        : queue.enqueuedAt
    )
      .toISOString()
      .slice(0, 10),
    documentType: queue.documentType,
    creditNoteOf: queue.creditNoteOf,
    originalInvoiceNo: originalRows[0]?.invoiceNo ?? null,
    buyerPin: queue.buyerPin,
    buyerName: queue.buyerName,
    buyerType: queue.buyerType,
    currency: queue.currency,
    totalAmount: queue.totalAmount,
    taxAmount: queue.taxAmount,
    lines: lineRows.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxCode: line.taxCode,
      taxTreatment: line.taxTreatment,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
    })),
  };
}

async function performTransmission(
  tx: CommandTransaction,
  options: TaxCommandOptions,
  values: { facilityId: string; queueId: string; environment: "sandbox" | "production" },
  userId: string,
  actor: z.infer<typeof actorSchema>,
): Promise<TransmitResult> {
  const queueRows = await tx
    .select()
    .from(etimsInvoiceQueue)
    .where(and(eq(etimsInvoiceQueue.id, values.queueId), eq(etimsInvoiceQueue.facilityId, values.facilityId)))
    .limit(1)
    .for("update");
  const queue = queueRows[0];
  if (!queue) throw new Error("eTIMS document not found in this facility");
  if (queue.environment !== values.environment) {
    throw new Error("The requested environment does not match this eTIMS document");
  }
  if (queue.status === "acknowledged" || queue.status === "transmitted") {
    throw new Error("An acknowledged eTIMS document cannot be transmitted again");
  }
  if (queue.status !== "pending" && queue.status !== "failed") {
    throw new Error(`An eTIMS document in ${queue.status} state cannot be transmitted`);
  }
  if (queue.status === "failed" && queue.nextAttemptAt && queue.nextAttemptAt.getTime() > Date.now()) {
    throw new Error("The retry backoff window has not elapsed");
  }

  const config = await loadIntegrationConfig(tx, values.facilityId, queue.environment);
  if (!config.enabled) throw new Error("The eTIMS integration is disabled for this environment");
  if (queue.attempts >= config.maxAttempts) {
    throw new Error(`Transmission attempt limit of ${config.maxAttempts} has been reached`);
  }

  const profileRows = await tx
    .select({ kraPin: facilityRegulatoryProfiles.kraPin })
    .from(facilityRegulatoryProfiles)
    .where(eq(facilityRegulatoryProfiles.facilityId, values.facilityId))
    .limit(1);
  const kraPin = profileRows[0]?.kraPin;
  if (!isValidKraPin(kraPin)) throw new Error("A valid KRA PIN is required to transmit eTIMS documents");

  const snapshot = await snapshotFromQueue(tx, values.facilityId, queue, normalizeKraPin(kraPin!));
  const outboxRows = await tx
    .select()
    .from(etimsOutbox)
    .where(and(eq(etimsOutbox.queueId, queue.id), eq(etimsOutbox.facilityId, values.facilityId)))
    .limit(1);
  if (!outboxRows[0]) throw new Error("The eTIMS outbox row is missing for this document");

  const client =
    options.etimsClientFactory?.(config) ??
    createEtimsClient(config, { env: options.env ?? process.env });
  const sent = await client.send(snapshot);
  // PostgreSQL jsonb normalises key order, so compare structure rather than text.
  if (!isDeepStrictEqual(sent.requestPayload, outboxRows[0].requestPayload)) {
    throw new Error("The eTIMS outbox payload no longer matches the transmitted request");
  }

  const attempt = queue.attempts + 1;
  await tx.insert(etimsTransmissionLog).values({
    id: newId(),
    facilityId: values.facilityId,
    queueId: queue.id,
    attempt,
    environment: queue.environment,
    requestPayload: sent.requestPayload,
    responsePayload: sent.response.payload,
    httpStatus: sent.response.status,
    outcome: sent.result.outcome,
    createdAt: new Date(),
  });

  const now = new Date();
  const common = {
    attempts: attempt,
    updatedAt: now,
  };
  let nextAttemptAt: Date | null = null;

  if (sent.result.outcome === "acknowledged") {
    await tx
      .update(etimsInvoiceQueue)
      .set({
        ...common,
        status: "acknowledged",
        kraControlNo: sent.result.controlNo,
        kraSignature: sent.result.signature,
        qrUrl: sent.result.qrUrl,
        cuNo: sent.result.cuNo,
        responseCode: sent.result.responseCode,
        responseMessage: sent.result.responseMessage,
        transmittedAt: now,
        acknowledgedAt: now,
        lastError: null,
        nextAttemptAt: null,
      })
      .where(eq(etimsInvoiceQueue.id, queue.id));
    await tx
      .update(etimsOutbox)
      .set({ status: "sent", attempts: attempt, sentAt: now, lastError: null, nextAttemptAt: null })
      .where(eq(etimsOutbox.id, outboxRows[0].id));
  } else if (sent.result.outcome === "rejected") {
    await tx
      .update(etimsInvoiceQueue)
      .set({
        ...common,
        status: "rejected",
        responseCode: sent.result.responseCode,
        responseMessage: sent.result.responseMessage,
        lastError: sent.result.responseMessage,
        nextAttemptAt: null,
      })
      .where(eq(etimsInvoiceQueue.id, queue.id));
    await tx
      .update(etimsOutbox)
      .set({
        status: "failed",
        attempts: attempt,
        lastError: sent.result.responseMessage,
        nextAttemptAt: null,
      })
      .where(eq(etimsOutbox.id, outboxRows[0].id));
  } else {
    const delays = config.backoffSeconds.length ? config.backoffSeconds : [DEFAULT_ETIMS_STALE_SECONDS];
    const delay = delays[Math.min(attempt - 1, delays.length - 1)];
    nextAttemptAt = new Date(now.getTime() + delay * 1000);
    await tx
      .update(etimsInvoiceQueue)
      .set({
        ...common,
        status: "failed",
        responseCode: sent.result.responseCode,
        responseMessage: sent.result.responseMessage,
        lastError: sent.result.responseMessage,
        nextAttemptAt,
      })
      .where(eq(etimsInvoiceQueue.id, queue.id));
    await tx
      .update(etimsOutbox)
      .set({
        status: "failed",
        attempts: attempt,
        lastError: sent.result.responseMessage,
        nextAttemptAt,
      })
      .where(eq(etimsOutbox.id, outboxRows[0].id));
  }

  await recordAudit(tx, {
    facilityId: values.facilityId,
    userId,
    action: `etims.transmit.${sent.result.outcome}`,
    module: "tax",
    entity: "etims_queue",
    entityId: queue.id,
    details: {
      attempt,
      responseCode: sent.result.responseCode,
      controlNo: sent.result.outcome === "acknowledged" ? sent.result.controlNo : null,
    },
    deviceId: actor.deviceId,
    ip: actor.ip,
  });
  await publishEvent(tx, {
    type: "tax.etims.transmitted",
    facilityId: values.facilityId,
    queueId: queue.id,
    outcome: sent.result.outcome,
  });

  const updated = await tx
    .select()
    .from(etimsInvoiceQueue)
    .where(eq(etimsInvoiceQueue.id, queue.id))
    .limit(1);
  const row = updated[0] ?? queue;
  return {
    queueId: row.id,
    status: row.status,
    attempts: row.attempts,
    responseCode: row.responseCode,
    responseMessage: row.responseMessage,
    kraControlNo: row.kraControlNo,
    kraSignature: row.kraSignature,
    qrUrl: row.qrUrl,
    nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
  };
}

export async function transmitEtimsInvoice(
  input: TransmitEtimsInvoiceInput,
  options: TaxCommandOptions = {},
): Promise<TransmitResult> {
  const values = transmitEtimsInvoiceSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "transmitEtimsInvoice",
    async (tx) => performTransmission(tx, options, values, userId, values.actor),
    options,
  );
}

export const retryEtimsInvoiceSchema = z.object({
  ...baseSchema,
  queueId: z.uuid(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
});

export type RetryEtimsInvoiceInput = z.input<typeof retryEtimsInvoiceSchema>;

export async function retryEtimsInvoice(
  input: RetryEtimsInvoiceInput,
  options: TaxCommandOptions = {},
): Promise<TransmitResult> {
  const values = retryEtimsInvoiceSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "retryEtimsInvoice",
    async (tx) => {
      const rows = await tx
        .select()
        .from(etimsInvoiceQueue)
        .where(and(eq(etimsInvoiceQueue.id, values.queueId), eq(etimsInvoiceQueue.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const queue = rows[0];
      if (!queue) throw new Error("eTIMS document not found in this facility");
      if (queue.status !== "failed") {
        throw new Error(`Only failed eTIMS documents can be retried (current state: ${queue.status})`);
      }
      if (queue.nextAttemptAt && queue.nextAttemptAt.getTime() > Date.now()) {
        throw new Error("The retry backoff window has not elapsed");
      }
      return performTransmission(tx, options, values, userId, values.actor);
    },
    options,
  );
}

export const cancelEtimsInvoiceSchema = z.object({
  ...baseSchema,
  queueId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type CancelEtimsInvoiceInput = z.input<typeof cancelEtimsInvoiceSchema>;

export interface CreditNoteResult extends EtimsQueueResult {
  creditNoteOf: string | null;
}

export async function cancelEtimsInvoice(
  input: CancelEtimsInvoiceInput,
  options: TaxCommandOptions = {},
): Promise<CreditNoteResult> {
  const values = cancelEtimsInvoiceSchema.parse(input);
  const userId = actorId(values);
  const database = databaseFor(options);
  const kraPin = await loadKraPin(
    database,
    values.facilityId,
    userId,
    values.actor,
    "tax.credit_note.blocked",
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "cancelEtimsInvoice",
    async (tx) => {
      const originalRows = await tx
        .select()
        .from(etimsInvoiceQueue)
        .where(and(eq(etimsInvoiceQueue.id, values.queueId), eq(etimsInvoiceQueue.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const original = originalRows[0];
      if (!original) throw new Error("eTIMS document not found in this facility");
      if (original.status !== "acknowledged" && original.status !== "transmitted") {
        throw new Error("Only an acknowledged eTIMS document can be corrected with a credit note");
      }

      const existing = await tx
        .select()
        .from(etimsInvoiceQueue)
        .where(
          and(
            eq(etimsInvoiceQueue.facilityId, values.facilityId),
            eq(etimsInvoiceQueue.creditNoteOf, original.id),
            eq(etimsInvoiceQueue.documentType, "credit_note"),
          ),
        )
        .limit(1);
      if (existing[0]) return { ...queueResult(existing[0]), creditNoteOf: original.id };

      const config = await loadIntegrationConfig(tx, values.facilityId, original.environment);
      const originalLines = await tx
        .select()
        .from(etimsInvoiceLines)
        .where(
          and(eq(etimsInvoiceLines.facilityId, values.facilityId), eq(etimsInvoiceLines.queueId, original.id)),
        )
        .orderBy(asc(etimsInvoiceLines.lineNo));
      if (originalLines.length === 0) throw new Error("The original eTIMS document has no tax lines");

      const creditNo = `CN-${original.invoiceNo}-${values.idempotencyKey.slice(0, 8).toUpperCase()}`;
      const snapshot: EtimsDocumentSnapshot = {
        queueId: "",
        facilityId: values.facilityId,
        facilityCode: "",
        facilityName: "",
        kraPin,
        idempotencyKey: values.idempotencyKey,
        invoiceNo: creditNo,
        invoiceDate: new Date().toISOString().slice(0, 10),
        documentType: "credit_note",
        creditNoteOf: original.id,
        originalInvoiceNo: original.invoiceNo,
        buyerPin: original.buyerPin,
        buyerName: original.buyerName,
        buyerType: original.buyerType,
        currency: original.currency,
        totalAmount: original.totalAmount,
        taxAmount: original.taxAmount,
        lines: originalLines.map((line) => ({
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: line.amount,
          taxCode: line.taxCode,
          taxTreatment: line.taxTreatment,
          taxRate: line.taxRate,
          taxAmount: line.taxAmount,
        })),
      };
      const facilityRows = await tx
        .select({ code: facilities.code, name: facilities.name })
        .from(facilities)
        .where(eq(facilities.id, values.facilityId))
        .limit(1);
      snapshot.facilityCode = facilityRows[0]?.code ?? "FAC";
      snapshot.facilityName = facilityRows[0]?.name ?? "Facility";

      const queue = await insertQueueDocument(tx, {
        facilityId: values.facilityId,
        idempotencyKey: values.idempotencyKey,
        invoiceId: original.invoiceId ?? newId(),
        invoiceNo: creditNo,
        documentType: "credit_note",
        creditNoteOf: original.id,
        environment: original.environment,
        config,
        snapshot,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "tax.cancelEtimsInvoice",
        module: "tax",
        entity: "etims_queue",
        entityId: queue.id,
        details: {
          originalQueueId: original.id,
          creditNoteOf: original.invoiceNo,
          reason: values.reason ?? "Correction",
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { ...queueResult(queue), creditNoteOf: original.id };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Status and reconciliation                                           */
/* ------------------------------------------------------------------ */

export const getEtimsInvoiceStatusSchema = z.object({
  facilityId: z.uuid(),
  queueId: z.uuid().optional(),
  invoiceNo: z.string().trim().max(40).optional(),
});

export type GetEtimsInvoiceStatusInput = z.input<typeof getEtimsInvoiceStatusSchema>;

export interface EtimsStatusResult {
  queue: EtimsQueueResult;
  attempts: number;
  lastError: string | null;
  kraControlNo: string | null;
  kraSignature: string | null;
  qrUrl: string | null;
  nextAttemptAt: string | null;
  logs: Array<{
    attempt: number;
    outcome: string;
    httpStatus: number | null;
    responseCode: string | null;
    createdAt: string;
  }>;
}

export async function getEtimsInvoiceStatus(
  input: GetEtimsInvoiceStatusInput,
  options: TaxCommandOptions = {},
): Promise<EtimsStatusResult> {
  const values = getEtimsInvoiceStatusSchema.parse(input);
  if (!values.queueId && !values.invoiceNo) {
    throw new Error("Provide either a queueId or an invoiceNo");
  }
  const database = databaseFor(options);
  const rows = await database
    .select()
    .from(etimsInvoiceQueue)
    .where(
      and(
        eq(etimsInvoiceQueue.facilityId, values.facilityId),
        values.queueId
          ? eq(etimsInvoiceQueue.id, values.queueId)
          : eq(etimsInvoiceQueue.invoiceNo, values.invoiceNo!),
      ),
    )
    .orderBy(desc(etimsInvoiceQueue.createdAt))
    .limit(1);
  const queue = rows[0];
  if (!queue) throw new Error("eTIMS document not found in this facility");
  const logs = await database
    .select({
      attempt: etimsTransmissionLog.attempt,
      outcome: etimsTransmissionLog.outcome,
      httpStatus: etimsTransmissionLog.httpStatus,
      responseCode: etimsTransmissionLog.responsePayload,
      createdAt: etimsTransmissionLog.createdAt,
    })
    .from(etimsTransmissionLog)
    .where(
      and(eq(etimsTransmissionLog.facilityId, values.facilityId), eq(etimsTransmissionLog.queueId, queue.id)),
    )
    .orderBy(desc(etimsTransmissionLog.attempt));

  return {
    queue: queueResult(queue),
    attempts: queue.attempts,
    lastError: queue.lastError,
    kraControlNo: queue.kraControlNo,
    kraSignature: queue.kraSignature,
    qrUrl: queue.qrUrl,
    nextAttemptAt: queue.nextAttemptAt ? queue.nextAttemptAt.toISOString() : null,
    logs: logs.map((log) => ({
      attempt: log.attempt,
      outcome: log.outcome,
      httpStatus: log.httpStatus,
      responseCode:
        log.responseCode && typeof log.responseCode === "object" && "resultCode" in log.responseCode
          ? String((log.responseCode as Record<string, unknown>).resultCode ?? "")
          : null,
      createdAt: log.createdAt.toISOString(),
    })),
  };
}

export const reconcileEtimsQueueSchema = z.object({
  facilityId: z.uuid(),
  staleSeconds: z.number().int().min(1).max(86_400).default(DEFAULT_ETIMS_STALE_SECONDS),
  environment: z.enum(["sandbox", "production"]).optional(),
});

export type ReconcileEtimsQueueInput = z.input<typeof reconcileEtimsQueueSchema>;

export interface ReconcileResult {
  asOf: string;
  staleSeconds: number;
  count: number;
  stale: Array<EtimsQueueResult & { enqueuedAt: string; ageSeconds: number }>;
}

export async function reconcileEtimsQueue(
  input: ReconcileEtimsQueueInput,
  options: TaxCommandOptions = {},
): Promise<ReconcileResult> {
  const values = reconcileEtimsQueueSchema.parse(input);
  const asOf = new Date();
  const threshold = new Date(asOf.getTime() - values.staleSeconds * 1000);
  const database = databaseFor(options);
  const rows = await database
    .select()
    .from(etimsInvoiceQueue)
    .where(
      and(
        eq(etimsInvoiceQueue.facilityId, values.facilityId),
        eq(etimsInvoiceQueue.status, "pending"),
        lte(etimsInvoiceQueue.enqueuedAt, threshold),
        values.environment ? eq(etimsInvoiceQueue.environment, values.environment) : sql`true`,
      ),
    )
    .orderBy(asc(etimsInvoiceQueue.enqueuedAt));

  return {
    asOf: asOf.toISOString(),
    staleSeconds: values.staleSeconds,
    count: rows.length,
    stale: rows.map((row) => ({
      ...queueResult(row),
      enqueuedAt: row.enqueuedAt.toISOString(),
      ageSeconds: Math.max(0, Math.floor((asOf.getTime() - row.enqueuedAt.getTime()) / 1000)),
    })),
  };
}

export const generateEtimsSignatureSchema = z.object({
  ...baseSchema,
  invoiceId: z.uuid(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
  buyerPin: z.string().trim().max(16).nullable().optional(),
  buyerName: z.string().trim().max(200).nullable().optional(),
});

export type GenerateEtimsSignatureInput = z.input<typeof generateEtimsSignatureSchema>;

/** One action for the KRA screen: finalise, enqueue, then transmit. */
export async function generateEtimsSignature(
  input: GenerateEtimsSignatureInput,
  options: TaxCommandOptions = {},
): Promise<TransmitResult> {
  const values = generateEtimsSignatureSchema.parse(input);
  const database = databaseFor(options);
  const invoiceRows = await database
    .select({ finalizedAt: invoices.finalizedAt })
    .from(invoices)
    .where(and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) throw new Error("Invoice not found in this facility");

  const enqueueKey = derivedKey(values.idempotencyKey, "enqueue");
  const transmitKey = derivedKey(values.idempotencyKey, "transmit");
  let queueId: string;

  if (invoice.finalizedAt) {
    const queueRows = await database
      .select()
      .from(etimsInvoiceQueue)
      .where(
        and(
          eq(etimsInvoiceQueue.facilityId, values.facilityId),
          eq(etimsInvoiceQueue.invoiceId, values.invoiceId),
          eq(etimsInvoiceQueue.documentType, "invoice"),
        ),
      )
      .orderBy(desc(etimsInvoiceQueue.createdAt))
      .limit(1);
    const queue = queueRows[0];
    if (queue) {
      queueId = queue.id;
    } else {
      const enqueued = await enqueueEtimsInvoice(
        {
          facilityId: values.facilityId,
          idempotencyKey: enqueueKey,
          actor: values.actor,
          invoiceId: values.invoiceId,
          environment: values.environment,
          buyerPin: values.buyerPin,
          buyerName: values.buyerName,
        },
        options,
      );
      queueId = enqueued.queueId;
    }
  } else {
    const finalized = await finalizeInvoice(
      {
        facilityId: values.facilityId,
        idempotencyKey: values.idempotencyKey,
        actor: values.actor,
        invoiceId: values.invoiceId,
        environment: values.environment,
        buyerPin: values.buyerPin,
        buyerName: values.buyerName,
      },
      options,
    );
    queueId = finalized.queueId;
  }

  return transmitEtimsInvoice(
    {
      facilityId: values.facilityId,
      idempotencyKey: transmitKey,
      actor: values.actor,
      queueId,
      environment: values.environment,
    },
    options,
  );
}
