CREATE TYPE "public"."goods_receipt_status" AS ENUM('received', 'invoiced');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'approved', 'partially_received', 'received', 'invoiced', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('received', 'selected', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."requisition_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."requisition_status" AS ENUM('draft', 'approved', 'rejected', 'ordered');--> statement-breakpoint
CREATE TYPE "public"."rfq_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."supplier_invoice_status" AS ENUM('posted', 'partially_paid', 'paid');--> statement-breakpoint
CREATE TYPE "public"."supplier_payment_method" AS ENUM('cash', 'bank');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'procurement_officer' BEFORE 'auditor';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'store_manager' BEFORE 'auditor';--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"expiry_date" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"grn_no" varchar(40) NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "goods_receipt_status" DEFAULT 'received' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"po_no" varchar(40) NOT NULL,
	"requisition_id" uuid,
	"quote_id" uuid,
	"supplier_id" uuid NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"expected_date" date,
	"ordered_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requisition_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"decision" "requisition_decision" NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requisition_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requisitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"requisition_no" varchar(40) NOT NULL,
	"department" varchar(120) NOT NULL,
	"justification" text NOT NULL,
	"status" "requisition_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reorder_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"minimum_quantity" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"rfq_no" varchar(40) NOT NULL,
	"requisition_id" uuid NOT NULL,
	"status" "rfq_status" DEFAULT 'open' NOT NULL,
	"closing_date" date,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"goods_receipt_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"invoice_no" varchar(64) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"status" "supplier_invoice_status" DEFAULT 'posted' NOT NULL,
	"invoice_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"recorded_by" text NOT NULL,
	"journal_entry_id" uuid,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"payment_no" varchar(40) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" "supplier_payment_method" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"reference" text,
	"recorded_by" text NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_quote_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"lead_time_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"quote_no" varchar(64),
	"status" "quote_status" DEFAULT 'received' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" varchar(50),
	"email" varchar(255),
	"address" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_id_item_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."item_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_quote_id_supplier_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."supplier_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_approvals" ADD CONSTRAINT "purchase_requisition_approvals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_approvals" ADD CONSTRAINT "purchase_requisition_approvals_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ADD CONSTRAINT "supplier_quote_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ADD CONSTRAINT "supplier_quote_lines_quote_id_supplier_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."supplier_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ADD CONSTRAINT "supplier_quote_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_goods_receipt_idx" ON "goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_facility_idx" ON "goods_receipt_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_facility_no_idx" ON "goods_receipts" USING btree ("facility_id","grn_no");--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_order_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_purchase_order_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_facility_idx" ON "purchase_order_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_facility_no_idx" ON "purchase_orders" USING btree ("facility_id","po_no");--> statement-breakpoint
CREATE INDEX "purchase_orders_facility_status_idx" ON "purchase_orders" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("facility_id","supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_requisition_approvals_requisition_idx" ON "purchase_requisition_approvals" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "purchase_requisition_approvals_facility_idx" ON "purchase_requisition_approvals" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "purchase_requisition_lines_requisition_idx" ON "purchase_requisition_lines" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "purchase_requisition_lines_facility_idx" ON "purchase_requisition_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_requisitions_facility_no_idx" ON "purchase_requisitions" USING btree ("facility_id","requisition_no");--> statement-breakpoint
CREATE INDEX "purchase_requisitions_facility_status_idx" ON "purchase_requisitions" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_levels_facility_item_store_idx" ON "reorder_levels" USING btree ("facility_id","item_id","store_id");--> statement-breakpoint
CREATE INDEX "reorder_levels_facility_idx" ON "reorder_levels" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "rfq_lines_rfq_idx" ON "rfq_lines" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "rfq_lines_facility_idx" ON "rfq_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_facility_no_idx" ON "rfqs" USING btree ("facility_id","rfq_no");--> statement-breakpoint
CREATE INDEX "rfqs_requisition_idx" ON "rfqs" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_invoice_idx" ON "supplier_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_facility_idx" ON "supplier_invoice_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_facility_invoice_no_idx" ON "supplier_invoices" USING btree ("facility_id","invoice_no");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_idx" ON "supplier_invoices" USING btree ("facility_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_purchase_order_idx" ON "supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_facility_no_idx" ON "supplier_payments" USING btree ("facility_id","payment_no");--> statement-breakpoint
CREATE INDEX "supplier_payments_invoice_idx" ON "supplier_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("facility_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_quote_lines_quote_idx" ON "supplier_quote_lines" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "supplier_quote_lines_facility_idx" ON "supplier_quote_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_quotes_rfq_supplier_idx" ON "supplier_quotes" USING btree ("rfq_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_quotes_facility_idx" ON "supplier_quotes" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_facility_code_idx" ON "suppliers" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "suppliers_facility_name_idx" ON "suppliers" USING btree ("facility_id","name");--> statement-breakpoint

-- Procurement documents are facility-owned, audited and synced through the
-- existing outbox. Supplier payments are append-only; the remaining document
-- history is protected from physical deletion and retired by status instead.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture", "no_hard_delete")
VALUES
  ('suppliers', false, NULL, true, false),
  ('purchase_requisitions', false, NULL, true, true),
  ('purchase_requisition_lines', false, NULL, true, true),
  ('purchase_requisition_approvals', false, NULL, true, true),
  ('rfqs', false, NULL, true, true),
  ('rfq_lines', false, NULL, true, true),
  ('supplier_quotes', false, NULL, true, true),
  ('supplier_quote_lines', false, NULL, true, true),
  ('purchase_orders', false, NULL, true, true),
  ('purchase_order_lines', false, NULL, true, true),
  ('goods_receipts', false, NULL, true, true),
  ('goods_receipt_lines', false, NULL, true, true),
  ('supplier_invoices', false, NULL, true, true),
  ('supplier_invoice_lines', false, NULL, true, true),
  ('supplier_payments', true, NULL, true, true),
  ('reorder_levels', false, NULL, true, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture,
  no_hard_delete = EXCLUDED.no_hard_delete;--> statement-breakpoint

DO $$
DECLARE
  procurement_table text;
BEGIN
  FOREACH procurement_table IN ARRAY ARRAY[
    'suppliers', 'purchase_requisitions', 'purchase_requisition_lines',
    'purchase_requisition_approvals', 'rfqs', 'rfq_lines',
    'supplier_quotes', 'supplier_quote_lines', 'purchase_orders',
    'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines',
    'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments',
    'reorder_levels'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', procurement_table);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      procurement_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
  protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'purchase_requisitions', 'purchase_requisition_lines',
    'purchase_requisition_approvals', 'rfqs', 'rfq_lines',
    'supplier_quotes', 'supplier_quote_lines', 'purchase_orders',
    'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines',
    'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments',
    'reorder_levels'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protected_record_no_delete_trigger ON %I', protected_table);
    EXECUTE format(
      'CREATE TRIGGER protected_record_no_delete_trigger BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protected_record_no_delete()',
      protected_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

-- Existing facilities created before Phase 14 need the inventory system
-- account so supplier invoice postings can resolve it at journal time.
INSERT INTO "ledger_accounts" (
  "id", "facility_id", "code", "name", "type", "normal_balance",
  "system_role", "active", "created_at", "updated_at", "created_by", "version"
)
SELECT
  uuidv7(), f.id, '1300', 'Inventory', 'asset', 'debit', 'inventory',
  true, now(), now(), 'migration-0027', 1
FROM "facilities" f
WHERE NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la.facility_id = f.id AND la.code = '1300'
)
AND NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la.facility_id = f.id AND la.system_role = 'inventory'
);