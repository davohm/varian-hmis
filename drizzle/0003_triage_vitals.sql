CREATE TYPE "public"."triage_category" AS ENUM('red', 'yellow', 'green');--> statement-breakpoint
CREATE TABLE "triage_vitals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"systolic" integer,
	"diastolic" integer,
	"heart_rate" integer,
	"resp_rate" integer,
	"temperature" numeric(4, 1),
	"spo2" integer,
	"weight_kg" numeric(5, 2),
	"height_cm" numeric(5, 1),
	"bmi" numeric(6, 1),
	"pain_score" integer,
	"muac_cm" numeric(4, 1),
	"category" "triage_category" NOT NULL,
	"chief_complaint" text NOT NULL,
	"comments" text,
	"next_steps" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triage_vitals" ADD CONSTRAINT "triage_vitals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_vitals" ADD CONSTRAINT "triage_vitals_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "triage_vitals_facility_encounter_idx" ON "triage_vitals" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "triage_vitals_facility_created_idx" ON "triage_vitals" USING btree ("facility_id","created_at");