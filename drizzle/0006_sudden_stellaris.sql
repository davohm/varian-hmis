CREATE TYPE "public"."invoice_status" AS ENUM('open', 'partial', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'mpesa', 'card', 'insurance');--> statement-breakpoint
CREATE TYPE "public"."service_kind" AS ENUM('consultation', 'lab', 'procedure', 'drug');--> statement-breakpoint
CREATE TABLE "cashier_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid,
	"user_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"opening_float" numeric(12, 2) DEFAULT '0' NOT NULL,
	"counted_cash" numeric(12, 2),
	"expected_cash" numeric(12, 2),
	"variance" numeric(12, 2),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"invoice_id" uuid,
	"source_type" varchar(32) NOT NULL,
	"source_id" text NOT NULL,
	"service_id" uuid,
	"item_id" uuid,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"invoice_no" varchar(40) NOT NULL,
	"subtotal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"paid" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"cashier_session_id" uuid,
	"receipt_no" varchar(40) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"received_by" text NOT NULL,
	"reversed_payment_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payer_type" "payer_type" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"service_id" uuid,
	"item_id" uuid,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"kind" "service_kind" NOT NULL,
	"default_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cashier_sessions" ADD CONSTRAINT "cashier_sessions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_sessions" ADD CONSTRAINT "cashier_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cashier_session_id_cashier_sessions_id_fk" FOREIGN KEY ("cashier_session_id") REFERENCES "public"."cashier_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_payment_id_payments_id_fk" FOREIGN KEY ("reversed_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_sessions_open_idx" ON "cashier_sessions" USING btree ("facility_id","user_id") WHERE "cashier_sessions"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "cashier_sessions_facility_opened_idx" ON "cashier_sessions" USING btree ("facility_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_active_source_idx" ON "charges" USING btree ("facility_id","source_type","source_id") WHERE "charges"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "charges_facility_encounter_idx" ON "charges" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "charges_facility_invoice_idx" ON "charges" USING btree ("facility_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_facility_invoice_no_idx" ON "invoices" USING btree ("facility_id","invoice_no");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_active_encounter_idx" ON "invoices" USING btree ("facility_id","encounter_id") WHERE "invoices"."status" in ('open', 'partial');--> statement-breakpoint
CREATE INDEX "invoices_facility_status_idx" ON "invoices" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "invoices_facility_encounter_idx" ON "invoices" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_facility_receipt_no_idx" ON "payments" USING btree ("facility_id","receipt_no");--> statement-breakpoint
CREATE INDEX "payments_facility_invoice_idx" ON "payments" USING btree ("facility_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_facility_session_idx" ON "payments" USING btree ("facility_id","cashier_session_id");--> statement-breakpoint
CREATE INDEX "payments_reversed_idx" ON "payments" USING btree ("facility_id","reversed_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_facility_payer_idx" ON "price_lists" USING btree ("facility_id","payer_type");--> statement-breakpoint
CREATE INDEX "price_lists_facility_idx" ON "price_lists" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_price_list_service_idx" ON "prices" USING btree ("price_list_id","service_id") WHERE "prices"."service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "prices_price_list_item_idx" ON "prices" USING btree ("price_list_id","item_id") WHERE "prices"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "prices_facility_idx" ON "prices" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_facility_code_idx" ON "services" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "services_code_idx" ON "services" USING btree ("code");--> statement-breakpoint
CREATE INDEX "services_facility_idx" ON "services" USING btree ("facility_id");
CREATE OR REPLACE FUNCTION "payments_append_only"() RETURNS trigger AS $$
BEGIN
	-- Test fixtures need to remove their facility; production never sets this.
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'payments is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "payments_append_only_trigger" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION "payments_append_only"();
