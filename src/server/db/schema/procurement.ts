import {
  boolean,
  date,
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
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { itemBatches, items } from "./clinical";
import { auditColumns, facilities, stores } from "./tenancy";

export const requisitionStatusEnum = pgEnum("requisition_status", [
  "draft",
  "approved",
  "rejected",
  "ordered",
]);

export const requisitionDecisionEnum = pgEnum("requisition_decision", ["approved", "rejected"]);

export const rfqStatusEnum = pgEnum("rfq_status", ["open", "closed"]);

export const quoteStatusEnum = pgEnum("quote_status", ["received", "selected", "rejected"]);

export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "draft",
  "approved",
  "partially_received",
  "received",
  "invoiced",
  "paid",
  "cancelled",
]);

export const goodsReceiptStatusEnum = pgEnum("goods_receipt_status", ["received", "invoiced"]);

export const supplierInvoiceStatusEnum = pgEnum("supplier_invoice_status", [
  "posted",
  "partially_paid",
  "paid",
]);

export const supplierPaymentMethodEnum = pgEnum("supplier_payment_method", ["cash", "bank"]);

/**
 * Supplier master. Each row belongs to one facility; cloud-owned catalogues can
 * still be pulled to branches through the normal sync registry.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 255 }),
    address: text("address"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("suppliers_facility_code_idx").on(table.facilityId, table.code),
    facilityNameIdx: index("suppliers_facility_name_idx").on(table.facilityId, table.name),
  }),
);

export const purchaseRequisitions = pgTable(
  "purchase_requisitions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    requisitionNo: varchar("requisition_no", { length: 40 }).notNull(),
    department: varchar("department", { length: 120 }).notNull(),
    justification: text("justification").notNull(),
    status: requisitionStatusEnum("status").notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("purchase_requisitions_facility_no_idx").on(
      table.facilityId,
      table.requisitionNo,
    ),
    facilityStatusIdx: index("purchase_requisitions_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const purchaseRequisitionLines = pgTable(
  "purchase_requisition_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    requisitionIdx: index("purchase_requisition_lines_requisition_idx").on(table.requisitionId),
    facilityIdx: index("purchase_requisition_lines_facility_idx").on(table.facilityId),
  }),
);

export const purchaseRequisitionApprovals = pgTable(
  "purchase_requisition_approvals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: "restrict" }),
    decision: requisitionDecisionEnum("decision").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    requisitionIdx: index("purchase_requisition_approvals_requisition_idx").on(
      table.requisitionId,
    ),
    facilityIdx: index("purchase_requisition_approvals_facility_idx").on(table.facilityId),
  }),
);

export const rfqs = pgTable(
  "rfqs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    rfqNo: varchar("rfq_no", { length: 40 }).notNull(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: "restrict" }),
    status: rfqStatusEnum("status").notNull().default("open"),
    closingDate: date("closing_date", { mode: "string" }),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("rfqs_facility_no_idx").on(table.facilityId, table.rfqNo),
    requisitionIdx: index("rfqs_requisition_idx").on(table.requisitionId),
  }),
);

export const rfqLines = pgTable(
  "rfq_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    rfqIdx: index("rfq_lines_rfq_idx").on(table.rfqId),
    facilityIdx: index("rfq_lines_facility_idx").on(table.facilityId),
  }),
);

export const supplierQuotes = pgTable(
  "supplier_quotes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    quoteNo: varchar("quote_no", { length: 64 }),
    status: quoteStatusEnum("status").notNull().default("received"),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    receivedBy: text("received_by").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    rfqSupplierIdx: uniqueIndex("supplier_quotes_rfq_supplier_idx").on(
      table.rfqId,
      table.supplierId,
    ),
    facilityIdx: index("supplier_quotes_facility_idx").on(table.facilityId),
  }),
);

export const supplierQuoteLines = pgTable(
  "supplier_quote_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    leadTimeDays: integer("lead_time_days"),
    ...auditColumns,
  },
  (table) => ({
    quoteIdx: index("supplier_quote_lines_quote_idx").on(table.quoteId),
    facilityIdx: index("supplier_quote_lines_facility_idx").on(table.facilityId),
  }),
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    poNo: varchar("po_no", { length: 40 }).notNull(),
    requisitionId: uuid("requisition_id").references(() => purchaseRequisitions.id, {
      onDelete: "restrict",
    }),
    quoteId: uuid("quote_id").references(() => supplierQuotes.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    status: purchaseOrderStatusEnum("status").notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    expectedDate: date("expected_date", { mode: "string" }),
    orderedBy: text("ordered_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("purchase_orders_facility_no_idx").on(table.facilityId, table.poNo),
    facilityStatusIdx: index("purchase_orders_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
    supplierIdx: index("purchase_orders_supplier_idx").on(table.facilityId, table.supplierId),
  }),
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    ...auditColumns,
  },
  (table) => ({
    purchaseOrderIdx: index("purchase_order_lines_purchase_order_idx").on(table.purchaseOrderId),
    facilityIdx: index("purchase_order_lines_facility_idx").on(table.facilityId),
  }),
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    grnNo: varchar("grn_no", { length: 40 }).notNull(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    status: goodsReceiptStatusEnum("status").notNull().default("received"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    receivedBy: text("received_by").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("goods_receipts_facility_no_idx").on(table.facilityId, table.grnNo),
    purchaseOrderIdx: index("goods_receipts_purchase_order_idx").on(table.purchaseOrderId),
  }),
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "restrict" }),
    purchaseOrderLineId: uuid("purchase_order_line_id")
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").references(() => itemBatches.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    expiryDate: date("expiry_date", { mode: "string" }),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    goodsReceiptIdx: index("goods_receipt_lines_goods_receipt_idx").on(table.goodsReceiptId),
    facilityIdx: index("goods_receipt_lines_facility_idx").on(table.facilityId),
  }),
);

export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    invoiceNo: varchar("invoice_no", { length: 64 }).notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "restrict" }),
    status: supplierInvoiceStatusEnum("status").notNull().default("posted"),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    recordedBy: text("recorded_by").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    facilityInvoiceNoIdx: uniqueIndex("supplier_invoices_facility_invoice_no_idx").on(
      table.facilityId,
      table.invoiceNo,
    ),
    supplierIdx: index("supplier_invoices_supplier_idx").on(table.facilityId, table.supplierId),
    purchaseOrderIdx: index("supplier_invoices_purchase_order_idx").on(table.purchaseOrderId),
  }),
);

export const supplierInvoiceLines = pgTable(
  "supplier_invoice_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    goodsReceiptLineId: uuid("goods_receipt_line_id")
      .notNull()
      .references(() => goodsReceiptLines.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    ...auditColumns,
  },
  (table) => ({
    invoiceIdx: index("supplier_invoice_lines_invoice_idx").on(table.invoiceId),
    facilityIdx: index("supplier_invoice_lines_facility_idx").on(table.facilityId),
  }),
);

/** Supplier payments are append-only: corrections use a new reverse payment. */
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    paymentNo: varchar("payment_no", { length: 40 }).notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    method: supplierPaymentMethodEnum("method").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    reference: text("reference"),
    recordedBy: text("recorded_by").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    ...auditColumns,
  },
  (table) => ({
    facilityNoIdx: uniqueIndex("supplier_payments_facility_no_idx").on(
      table.facilityId,
      table.paymentNo,
    ),
    invoiceIdx: index("supplier_payments_invoice_idx").on(table.invoiceId),
    supplierIdx: index("supplier_payments_supplier_idx").on(table.facilityId, table.supplierId),
  }),
);

export const reorderLevels = pgTable(
  "reorder_levels",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    minimumQuantity: integer("minimum_quantity").notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityItemStoreIdx: uniqueIndex("reorder_levels_facility_item_store_idx").on(
      table.facilityId,
      table.itemId,
      table.storeId,
    ),
    facilityIdx: index("reorder_levels_facility_idx").on(table.facilityId),
  }),
);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type PurchaseRequisition = typeof purchaseRequisitions.$inferSelect;
export type NewPurchaseRequisition = typeof purchaseRequisitions.$inferInsert;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type NewGoodsReceipt = typeof goodsReceipts.$inferInsert;
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type NewSupplierInvoice = typeof supplierInvoices.$inferInsert;
export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type NewSupplierPayment = typeof supplierPayments.$inferInsert;
export type ReorderLevel = typeof reorderLevels.$inferSelect;
export type NewReorderLevel = typeof reorderLevels.$inferInsert;
