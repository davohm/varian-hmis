CREATE TYPE "public"."eye_visit_type" AS ENUM('new', 'revisit', 'review', 'walk_in');--> statement-breakpoint
CREATE TYPE "public"."eye_visual_acuity" AS ENUM('normal', 'low_vision', 'blind');--> statement-breakpoint
CREATE TYPE "public"."immunization_status" AS ENUM('administered', 'void');--> statement-breakpoint
CREATE TABLE "eye_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visit_type" "eye_visit_type" DEFAULT 'new' NOT NULL,
	"visual_acuity" "eye_visual_acuity" DEFAULT 'normal' NOT NULL,
	"va_right" varchar(32),
	"va_left" varchar(32),
	"disability_type" text,
	"diagnosis_code" varchar(64) NOT NULL,
	"impression" text,
	"management" text,
	"referral" text,
	"county" text,
	"residence" text,
	"phone" varchar(30),
	"registered_by" text,
	"seen_by" text,
	"time_registered" timestamp with time zone,
	"time_seen" timestamp with time zone,
	"last_stage" varchar(64),
	"admitted_at" timestamp with time zone,
	"discharged_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "immunizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"encounter_id" uuid,
	"patient_id" uuid NOT NULL,
	"item_id" uuid,
	"batch_id" uuid,
	"antigen_code" varchar(32) NOT NULL,
	"dose_code" varchar(32) NOT NULL,
	"administered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "immunization_status" DEFAULT 'administered' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eye_assessments" ADD CONSTRAINT "eye_assessments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eye_assessments" ADD CONSTRAINT "eye_assessments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eye_assessments" ADD CONSTRAINT "eye_assessments_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eye_assessments" ADD CONSTRAINT "eye_assessments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_batch_id_item_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."item_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eye_assessments_facility_date_idx" ON "eye_assessments" USING btree ("facility_id","visited_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eye_assessments_encounter_idx" ON "eye_assessments" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "eye_assessments_diagnosis_idx" ON "eye_assessments" USING btree ("facility_id","diagnosis_code","visited_at");--> statement-breakpoint
CREATE INDEX "immunizations_facility_date_idx" ON "immunizations" USING btree ("facility_id","administered_at");--> statement-breakpoint
CREATE INDEX "immunizations_facility_antigen_idx" ON "immunizations" USING btree ("facility_id","antigen_code","administered_at");--> statement-breakpoint
CREATE INDEX "immunizations_encounter_idx" ON "immunizations" USING btree ("facility_id","encounter_id");