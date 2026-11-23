import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { items } from "./clinical";
import { encounters } from "./patients";
import { payerTypeEnum } from "./patients";
import { auditColumns, branches, facilities } from "./tenancy";

export const serviceKindEnum = pgEnum("service_kind", [
  "consultation",
  "lab",
  "procedure",
  "drug",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", ["open", "partial", "paid", "void"]);

export const paymentMethodEnum = pgEnum("payment_method", ["cash", "mpesa", "card", "insurance"]);

/** Billable catalogue. A null facility means the service is shared by every facility. */
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    kind: serviceKindEnum("kind").notNull(),
    defaultPrice: numeric("default_price", { precision: 12, scale: 2 }).notNull().default("0"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("services_facility_code_idx").on(table.facilityId, table.code),
    codeIdx: index("services_code_idx").on(table.code),
    facilityIdx: index("services_facility_idx").on(table.facilityId),
  }),
);

/** One negotiated price list per payer type at a facility. */
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    payerType: payerTypeEnum("payer_type").notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityPayerIdx: uniqueIndex("price_lists_facility_payer_idx").on(
      table.facilityId,
      table.payerType,
    ),
    facilityIdx: index("price_lists_facility_idx").on(table.facilityId),
  }),
);

/** A price row points at either a service or a stock item, never both. */
export const prices = pgTable(
  "prices",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    /** Voided prices are retained for invoice history and never hard-deleted. */
    active: boolean("active").notNull().default(true),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (table) => ({
    activeIdx: index("prices_active_idx").on(table.facilityId, table.active),
    priceListServiceIdx: uniqueIndex("prices_price_list_service_idx")
      .on(table.priceListId, table.serviceId)
      .where(sql`${table.serviceId} is not null`),
    priceListItemIdx: uniqueIndex("prices_price_list_item_idx")
      .on(table.priceListId, table.itemId)
      .where(sql`${table.itemId} is not null`),
    facilityIdx: index("prices_facility_idx").on(table.facilityId),
  }),
);

/** One cashier drawer session per user. `closed_at` null means it is still open. */
export const cashierSessions = pgTable(
  "cashier_sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    userId: text("user_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    openingFloat: numeric("opening_float", { precision: 12, scale: 2 }).notNull().default("0"),
    countedCash: numeric("counted_cash", { precision: 12, scale: 2 }),
    expectedCash: numeric("expected_cash", { precision: 12, scale: 2 }),
    variance: numeric("variance", { precision: 12, scale: 2 }),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    openSessionIdx: uniqueIndex("cashier_sessions_open_idx")
      .on(table.facilityId, table.userId)
      .where(sql`${table.closedAt} is null`),
    facilityOpenedIdx: index("cashier_sessions_facility_opened_idx").on(
      table.facilityId,
      table.openedAt,
    ),
  }),
);

/** A visit is invoiced at most once while the invoice is still open or partial. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    invoiceNo: varchar("invoice_no", { length: 40 }).notNull(),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0"),
    paid: numeric("paid", { precision: 12, scale: 2 }).notNull().default("0"),
    status: invoiceStatusEnum("status").notNull().default("open"),
    isShaClaimable: boolean("is_sha_claimable").notNull().default(false),
    notes: text("notes"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityInvoiceNoIdx: uniqueIndex("invoices_facility_invoice_no_idx").on(
      table.facilityId,
      table.invoiceNo,
    ),
    activeEncounterIdx: uniqueIndex("invoices_active_encounter_idx")
      .on(table.facilityId, table.encounterId)
      .where(sql`${table.status} in ('open', 'partial') and ${table.finalizedAt} is null`),
    facilityStatusIdx: index("invoices_facility_status_idx").on(table.facilityId, table.status),
    facilityEncounterIdx: index("invoices_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
  }),
);

/**
 * A billable line. Auto charges are keyed by their source row, so re-running the
 * sync cannot duplicate a consultation, a lab test or a dispensed medicine.
 * Voided charges stay on the record and are excluded from invoice totals.
 */
export const charges = pgTable(
  "charges",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: text("source_id").notNull(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    ...auditColumns,
  },
  (table) => ({
    activeSourceIdx: uniqueIndex("charges_active_source_idx")
      .on(table.facilityId, table.sourceType, table.sourceId)
      .where(sql`${table.voidedAt} is null`),
    facilityEncounterIdx: index("charges_facility_encounter_idx").on(
      table.facilityId,
      table.encounterId,
    ),
    facilityInvoiceIdx: index("charges_facility_invoice_idx").on(
      table.facilityId,
      table.invoiceId,
    ),
  }),
);

/**
 * Append-only payment ledger. A reversal is a new negative row that points at
 * the payment it reverses, so a receipt can never be edited or deleted. A
 * database trigger rejects updates and deletes (see migration 0006).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    cashierSessionId: uuid("cashier_session_id").references(() => cashierSessions.id, {
      onDelete: "restrict",
    }),
    receiptNo: varchar("receipt_no", { length: 40 }).notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    method: paymentMethodEnum("method").notNull(),
    reference: text("reference"),
    receivedBy: text("received_by").notNull(),
    reversedPaymentId: uuid("reversed_payment_id").references(
      (): AnyPgColumn => payments.id,
      { onDelete: "restrict" },
    ),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityReceiptNoIdx: uniqueIndex("payments_facility_receipt_no_idx").on(
      table.facilityId,
      table.receiptNo,
    ),
    facilityInvoiceIdx: index("payments_facility_invoice_idx").on(
      table.facilityId,
      table.invoiceId,
    ),
    facilitySessionIdx: index("payments_facility_session_idx").on(
      table.facilityId,
      table.cashierSessionId,
    ),
    reversedIdx: index("payments_reversed_idx").on(table.facilityId, table.reversedPaymentId),
  }),
);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type PriceList = typeof priceLists.$inferSelect;
export type NewPriceList = typeof priceLists.$inferInsert;
export type Price = typeof prices.$inferSelect;
export type NewPrice = typeof prices.$inferInsert;
export type CashierSession = typeof cashierSessions.$inferSelect;
export type NewCashierSession = typeof cashierSessions.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type Charge = typeof charges.$inferSelect;
export type NewCharge = typeof charges.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
