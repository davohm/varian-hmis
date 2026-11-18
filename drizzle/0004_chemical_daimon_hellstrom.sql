CREATE TYPE "public"."item_kind" AS ENUM('drug', 'consumable', 'reagent');--> statement-breakpoint
CREATE TYPE "public"."lab_item_status" AS ENUM('ordered', 'collected', 'resulted', 'verified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lab_order_status" AS ENUM('ordered', 'collected', 'in_progress', 'resulted', 'verified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lab_result_flag" AS ENUM('N', 'H', 'L', 'HH', 'LL');--> statement-breakpoint
CREATE TYPE "public"."prescription_status" AS ENUM('prescribed', 'partial', 'dispensed', 'cancelled');--> statement-breakpoint
CREATE TABLE "clinical_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"subjective" text,
	"objective" text,
	"assessment" text,
	"plan" text,
	"author_id" text NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"icd10_code" varchar(16) NOT NULL,
	"description" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"diagnosed_by" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icd10_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(16) NOT NULL,
	"description" text NOT NULL,
	"chapter" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"kind" "item_kind" DEFAULT 'drug' NOT NULL,
	"unit" text DEFAULT 'unit' NOT NULL,
	"strength" text,
	"form" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"lab_order_id" uuid NOT NULL,
	"lab_test_id" uuid NOT NULL,
	"status" "lab_item_status" DEFAULT 'ordered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"status" "lab_order_status" DEFAULT 'ordered' NOT NULL,
	"clinical_notes" text,
	"ordered_by" text NOT NULL,
	"sample_id" text,
	"collected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"lab_order_item_id" uuid NOT NULL,
	"parameter" text NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	"ref_range" text,
	"flag" "lab_result_flag" DEFAULT 'N' NOT NULL,
	"entered_by" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"sample_type" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"dose" text NOT NULL,
	"route" text NOT NULL,
	"frequency" text NOT NULL,
	"duration_days" integer,
	"quantity" integer NOT NULL,
	"instructions" text,
	"status" "prescription_status" DEFAULT 'prescribed' NOT NULL,
	"prescribed_by" text NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_lab_order_id_lab_orders_id_fk" FOREIGN KEY ("lab_order_id") REFERENCES "public"."lab_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_lab_test_id_lab_tests_id_fk" FOREIGN KEY ("lab_test_id") REFERENCES "public"."lab_tests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_order_item_id_lab_order_items_id_fk" FOREIGN KEY ("lab_order_item_id") REFERENCES "public"."lab_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_notes_facility_encounter_idx" ON "clinical_notes" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "diagnoses_facility_encounter_idx" ON "diagnoses" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "diagnoses_facility_code_idx" ON "diagnoses" USING btree ("facility_id","icd10_code");--> statement-breakpoint
CREATE UNIQUE INDEX "icd10_codes_code_idx" ON "icd10_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "icd10_codes_description_idx" ON "icd10_codes" USING btree ("description");--> statement-breakpoint
CREATE INDEX "items_code_idx" ON "items" USING btree ("code");--> statement-breakpoint
CREATE INDEX "items_facility_idx" ON "items" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "lab_order_items_facility_order_idx" ON "lab_order_items" USING btree ("facility_id","lab_order_id");--> statement-breakpoint
CREATE INDEX "lab_orders_facility_encounter_idx" ON "lab_orders" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "lab_orders_facility_status_idx" ON "lab_orders" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "lab_results_facility_item_idx" ON "lab_results" USING btree ("facility_id","lab_order_item_id");--> statement-breakpoint
CREATE INDEX "lab_tests_code_idx" ON "lab_tests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "lab_tests_facility_idx" ON "lab_tests" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "prescriptions_facility_encounter_idx" ON "prescriptions" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "prescriptions_facility_status_idx" ON "prescriptions" USING btree ("facility_id","status");