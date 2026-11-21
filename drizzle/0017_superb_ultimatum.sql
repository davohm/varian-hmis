CREATE TYPE "public"."etims_document_type" AS ENUM('invoice', 'credit_note', 'debit_note');--> statement-breakpoint
CREATE TYPE "public"."etims_mode" AS ENUM('oscu', 'vscu');--> statement-breakpoint
CREATE TYPE "public"."etims_outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."etims_queue_status" AS ENUM('pending', 'transmitting', 'transmitted', 'acknowledged', 'rejected', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tax_treatment" AS ENUM('vat_standard', 'vat_zero', 'exempt', 'out_of_scope');--> statement-breakpoint
CREATE TABLE "etims_invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tax_code" varchar(32),
	"tax_treatment" "tax_treatment",
	"tax_rate" numeric(6, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "etims_invoice_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"invoice_id" uuid,
	"invoice_no" varchar(40) NOT NULL,
	"credit_note_of" uuid,
	"document_type" "etims_document_type" DEFAULT 'invoice' NOT NULL,
	"integration_mode" "etims_mode" DEFAULT 'oscu' NOT NULL,
	"environment" "integration_environment" DEFAULT 'sandbox' NOT NULL,
	"buyer_pin" varchar(16),
	"buyer_name" text,
	"buyer_type" varchar(32),
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "etims_queue_status" DEFAULT 'pending' NOT NULL,
	"kra_control_no" varchar(64),
	"kra_signature" text,
	"qr_url" text,
	"cu_no" varchar(64),
	"response_code" varchar(64),
	"response_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transmitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etims_invoice_queue_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "etims_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"environment" "integration_environment" NOT NULL,
	"mode" "etims_mode" NOT NULL,
	"request_payload" jsonb NOT NULL,
	"status" "etims_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etims_outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "etims_transmission_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"environment" "integration_environment" NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb,
	"http_status" integer,
	"outcome" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_code_applicabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"service_id" uuid,
	"item_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(6, 4) DEFAULT '0' NOT NULL,
	"treatment" "tax_treatment" NOT NULL,
	"kra_code" varchar(32),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
DROP INDEX "invoices_active_encounter_idx";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "finalized_by" text;--> statement-breakpoint
ALTER TABLE "etims_invoice_lines" ADD CONSTRAINT "etims_invoice_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_invoice_lines" ADD CONSTRAINT "etims_invoice_lines_queue_id_etims_invoice_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."etims_invoice_queue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_invoice_queue" ADD CONSTRAINT "etims_invoice_queue_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_invoice_queue" ADD CONSTRAINT "etims_invoice_queue_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_outbox" ADD CONSTRAINT "etims_outbox_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_outbox" ADD CONSTRAINT "etims_outbox_queue_id_etims_invoice_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."etims_invoice_queue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_transmission_log" ADD CONSTRAINT "etims_transmission_log_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_transmission_log" ADD CONSTRAINT "etims_transmission_log_queue_id_etims_invoice_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."etims_invoice_queue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_applicabilities" ADD CONSTRAINT "tax_code_applicabilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_applicabilities" ADD CONSTRAINT "tax_code_applicabilities_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_applicabilities" ADD CONSTRAINT "tax_code_applicabilities_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_applicabilities" ADD CONSTRAINT "tax_code_applicabilities_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "etims_lines_queue_line_idx" ON "etims_invoice_lines" USING btree ("queue_id","line_no");--> statement-breakpoint
CREATE INDEX "etims_lines_facility_idx" ON "etims_invoice_lines" USING btree ("facility_id","queue_id");--> statement-breakpoint
CREATE INDEX "etims_queue_facility_status_idx" ON "etims_invoice_queue" USING btree ("facility_id","status","enqueued_at");--> statement-breakpoint
CREATE INDEX "etims_queue_facility_invoice_idx" ON "etims_invoice_queue" USING btree ("facility_id","invoice_id","document_type");--> statement-breakpoint
CREATE UNIQUE INDEX "etims_queue_control_no_idx" ON "etims_invoice_queue" USING btree ("facility_id","kra_control_no") WHERE "etims_invoice_queue"."kra_control_no" is not null;--> statement-breakpoint
CREATE INDEX "etims_outbox_facility_status_idx" ON "etims_outbox" USING btree ("facility_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "etims_outbox_queue_idx" ON "etims_outbox" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "etims_log_facility_queue_idx" ON "etims_transmission_log" USING btree ("facility_id","queue_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_applicability_service_date_idx" ON "tax_code_applicabilities" USING btree ("facility_id","service_id","effective_from") WHERE "tax_code_applicabilities"."service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_applicability_item_date_idx" ON "tax_code_applicabilities" USING btree ("facility_id","item_id","effective_from") WHERE "tax_code_applicabilities"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "tax_applicability_facility_idx" ON "tax_code_applicabilities" USING btree ("facility_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_codes_facility_code_date_idx" ON "tax_codes" USING btree ("facility_id","code","effective_from");--> statement-breakpoint
CREATE INDEX "tax_codes_facility_active_idx" ON "tax_codes" USING btree ("facility_id","active","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_active_encounter_idx" ON "invoices" USING btree ("facility_id","encounter_id") WHERE "invoices"."status" in ('open', 'partial') and "invoices"."finalized_at" is null;