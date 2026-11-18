CREATE TYPE "public"."stock_reason" AS ENUM('receive', 'dispense', 'adjust', 'transfer_in', 'transfer_out', 'reversal');--> statement-breakpoint
CREATE TABLE "dispenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"dispensed_by" text NOT NULL,
	"note" text,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_no" varchar(64) NOT NULL,
	"expiry_date" date,
	"unit_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty_delta" integer NOT NULL,
	"reason" "stock_reason" NOT NULL,
	"ref_type" varchar(32),
	"ref_id" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_batch_id_item_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."item_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batches" ADD CONSTRAINT "item_batches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batches" ADD CONSTRAINT "item_batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_batch_id_item_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."item_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispenses_facility_prescription_idx" ON "dispenses" USING btree ("facility_id","prescription_id");--> statement-breakpoint
CREATE INDEX "dispenses_facility_batch_idx" ON "dispenses" USING btree ("facility_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_batches_facility_item_batch_idx" ON "item_batches" USING btree ("facility_id","item_id","batch_no");--> statement-breakpoint
CREATE INDEX "item_batches_facility_item_expiry_idx" ON "item_batches" USING btree ("facility_id","item_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_ledger_facility_store_item_idx" ON "stock_ledger" USING btree ("facility_id","store_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_facility_batch_idx" ON "stock_ledger" USING btree ("facility_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_facility_ref_idx" ON "stock_ledger" USING btree ("facility_id","ref_type","ref_id");--> statement-breakpoint
CREATE VIEW "public"."stock_balances" AS (select "facility_id", "store_id", "item_id", "batch_id", coalesce(sum("qty_delta"), 0)::int as "quantity" from "stock_ledger" group by "stock_ledger"."facility_id", "stock_ledger"."store_id", "stock_ledger"."item_id", "stock_ledger"."batch_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stock_ledger_append_only"() RETURNS trigger AS $$
BEGIN
	-- Test fixtures need to remove their facility; production never sets this.
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'stock_ledger is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "stock_ledger_append_only_trigger" BEFORE UPDATE OR DELETE ON "stock_ledger" FOR EACH ROW EXECUTE FUNCTION "stock_ledger_append_only"();