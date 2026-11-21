import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { items } from "./clinical";
import { invoices, services } from "./billing";
import { integrationEnvironmentEnum } from "./regulatory";
import { auditColumns, facilities } from "./tenancy";

export const taxTreatmentEnum = pgEnum("tax_treatment", [
  "vat_standard",
  "vat_zero",
  "exempt",
  "out_of_scope",
]);

export const etimsDocumentTypeEnum = pgEnum("etims_document_type", [
  "invoice",
  "credit_note",
  "debit_note",
]);

export const etimsModeEnum = pgEnum("etims_mode", ["oscu", "vscu"]);

export const etimsQueueStatusEnum = pgEnum("etims_queue_status", [
  "pending",
  "transmitting",
  "transmitted",
  "acknowledged",
  "rejected",
  "failed",
  "cancelled",
]);

export const etimsOutboxStatusEnum = pgEnum("etims_outbox_status", [
  "pending",
  "sent",
  "failed",
]);

/** Facility-owned, effective-dated tax codes used to derive invoice tax. */
export const taxCodes = pgTable(
  "tax_codes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    rate: numeric("rate", { precision: 6, scale: 4 }).notNull().default("0"),
    treatment: taxTreatmentEnum("treatment").notNull(),
    kraCode: varchar("kra_code", { length: 32 }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    active: boolean("active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeDateIdx: uniqueIndex("tax_codes_facility_code_date_idx").on(
      table.facilityId,
      table.code,
      table.effectiveFrom,
    ),
    facilityActiveIdx: index("tax_codes_facility_active_idx").on(
      table.facilityId,
      table.active,
      table.effectiveFrom,
    ),
  }),
);

/** Optional per-service or per-item override of the facility default tax code. */
export const taxCodeApplicabilities = pgTable(
  "tax_code_applicabilities",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    taxCodeId: uuid("tax_code_id")
      .notNull()
      .references(() => taxCodes.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityServiceDateIdx: uniqueIndex("tax_applicability_service_date_idx")
      .on(table.facilityId, table.serviceId, table.effectiveFrom)
      .where(sql`${table.serviceId} is not null`),
    facilityItemDateIdx: uniqueIndex("tax_applicability_item_date_idx")
      .on(table.facilityId, table.itemId, table.effectiveFrom)
      .where(sql`${table.itemId} is not null`),
    facilityIdx: index("tax_applicability_facility_idx").on(table.facilityId, table.active),
  }),
);

/**
 * Durable eTIMS document queue. Financial fields are snapshot data: once a
 * document is acknowledged it is never edited, only superseded by a credit note.
 */
export const etimsInvoiceQueue = pgTable(
  "etims_invoice_queue",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    invoiceNo: varchar("invoice_no", { length: 40 }).notNull(),
    creditNoteOf: uuid("credit_note_of"),
    documentType: etimsDocumentTypeEnum("document_type").notNull().default("invoice"),
    integrationMode: etimsModeEnum("integration_mode").notNull().default("oscu"),
    environment: integrationEnvironmentEnum("environment").notNull().default("sandbox"),
    buyerPin: varchar("buyer_pin", { length: 16 }),
    buyerName: text("buyer_name"),
    buyerType: varchar("buyer_type", { length: 32 }),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    status: etimsQueueStatusEnum("status").notNull().default("pending"),
    kraControlNo: varchar("kra_control_no", { length: 64 }),
    kraSignature: text("kra_signature"),
    qrUrl: text("qr_url"),
    cuNo: varchar("cu_no", { length: 64 }),
    responseCode: varchar("response_code", { length: 64 }),
    responseMessage: text("response_message"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    transmittedAt: timestamp("transmitted_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityStatusIdx: index("etims_queue_facility_status_idx").on(
      table.facilityId,
      table.status,
      table.enqueuedAt,
    ),
    facilityInvoiceIdx: index("etims_queue_facility_invoice_idx").on(
      table.facilityId,
      table.invoiceId,
      table.documentType,
    ),
    controlNoIdx: uniqueIndex("etims_queue_control_no_idx")
      .on(table.facilityId, table.kraControlNo)
      .where(sql`${table.kraControlNo} is not null`),
  }),
);

/** Immutable tax-line snapshot attached to an eTIMS queue document. */
export const etimsInvoiceLines = pgTable(
  "etims_invoice_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => etimsInvoiceQueue.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    taxCode: varchar("tax_code", { length: 32 }),
    taxTreatment: taxTreatmentEnum("tax_treatment"),
    taxRate: numeric("tax_rate", { precision: 6, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  },
  (table) => ({
    queueLineIdx: uniqueIndex("etims_lines_queue_line_idx").on(table.queueId, table.lineNo),
    facilityIdx: index("etims_lines_facility_idx").on(table.facilityId, table.queueId),
  }),
);

/** Durable KRA request outbox. `request_payload` is byte-for-byte what is sent. */
export const etimsOutbox = pgTable(
  "etims_outbox",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => etimsInvoiceQueue.id, { onDelete: "restrict" }),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    environment: integrationEnvironmentEnum("environment").notNull(),
    mode: etimsModeEnum("mode").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    status: etimsOutboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityStatusIdx: index("etims_outbox_facility_status_idx").on(
      table.facilityId,
      table.status,
      table.nextAttemptAt,
    ),
    queueIdx: uniqueIndex("etims_outbox_queue_idx").on(table.queueId),
  }),
);

/** Append-only record of every KRA call and its exact request/response envelope. */
export const etimsTransmissionLog = pgTable(
  "etims_transmission_log",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => etimsInvoiceQueue.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    environment: integrationEnvironmentEnum("environment").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    httpStatus: integer("http_status"),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityQueueIdx: index("etims_log_facility_queue_idx").on(
      table.facilityId,
      table.queueId,
      table.attempt,
    ),
  }),
);

export type TaxCode = typeof taxCodes.$inferSelect;
export type EtimsQueueRow = typeof etimsInvoiceQueue.$inferSelect;
export type EtimsQueueLine = typeof etimsInvoiceLines.$inferSelect;
export type EtimsOutboxRow = typeof etimsOutbox.$inferSelect;
export type EtimsTransmissionLogRow = typeof etimsTransmissionLog.$inferSelect;
