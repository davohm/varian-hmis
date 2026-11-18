CREATE TYPE "public"."encounter_status" AS ENUM('open', 'discharged', 'referred', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payer_type" AS ENUM('cash', 'sha', 'insurance');--> statement-breakpoint
CREATE TYPE "public"."queue_priority" AS ENUM('red', 'yellow', 'green', 'normal');--> statement-breakpoint
CREATE TYPE "public"."queue_status" AS ENUM('waiting', 'called', 'in_service', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TABLE "encounters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_no" varchar(40) NOT NULL,
	"status" "encounter_status" DEFAULT 'open' NOT NULL,
	"payer_type" "payer_type" DEFAULT 'cash' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_of_kin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"mrn" varchar(32) NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"other_names" text,
	"dob" date,
	"dob_estimated" boolean DEFAULT false NOT NULL,
	"sex" "sex" NOT NULL,
	"national_id" varchar(64),
	"phone" varchar(30),
	"email" varchar(255),
	"address" text,
	"payer_type" "payer_type" DEFAULT 'cash' NOT NULL,
	"payer_member_no" varchar(64),
	"allergies" text[],
	"blood_group" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"department" text NOT NULL,
	"room_id" uuid,
	"priority" "queue_priority" DEFAULT 'normal' NOT NULL,
	"status" "queue_status" DEFAULT 'waiting' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_of_kin" ADD CONSTRAINT "next_of_kin_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_of_kin" ADD CONSTRAINT "next_of_kin_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounters_facility_encounter_no_idx" ON "encounters" USING btree ("facility_id","encounter_no");--> statement-breakpoint
CREATE INDEX "encounters_facility_patient_idx" ON "encounters" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE INDEX "encounters_facility_status_idx" ON "encounters" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "next_of_kin_facility_patient_idx" ON "next_of_kin" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_facility_mrn_idx" ON "patients" USING btree ("facility_id","mrn");--> statement-breakpoint
CREATE INDEX "patients_facility_phone_idx" ON "patients" USING btree ("facility_id","phone");--> statement-breakpoint
CREATE INDEX "patients_facility_national_id_idx" ON "patients" USING btree ("facility_id","national_id");--> statement-breakpoint
CREATE INDEX "patients_facility_name_idx" ON "patients" USING btree ("facility_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "queue_entries_facility_queue_idx" ON "queue_entries" USING btree ("facility_id","department","status","priority","queued_at");--> statement-breakpoint
CREATE INDEX "queue_entries_facility_encounter_idx" ON "queue_entries" USING btree ("facility_id","encounter_id");--> statement-breakpoint
CREATE INDEX "queue_entries_facility_patient_idx" ON "queue_entries" USING btree ("facility_id","patient_id");
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_full_name_trgm_idx ON patients USING gin ((lower(first_name || ' ' || coalesce(other_names, '') || ' ' || last_name)) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_first_name_trgm_idx ON patients USING gin (lower(first_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_last_name_trgm_idx ON patients USING gin (lower(last_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_phone_trgm_idx ON patients USING gin (lower(coalesce(phone, '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_national_id_trgm_idx ON patients USING gin (lower(coalesce(national_id, '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patients_mrn_trgm_idx ON patients USING gin (lower(mrn) gin_trgm_ops);--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_queue_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_row jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_row := to_jsonb(OLD);
  ELSE
    changed_row := to_jsonb(NEW);
  END IF;
  PERFORM pg_notify('varian_events', json_build_object(
    'type', 'queue_changed',
    'facilityId', changed_row->>'facility_id',
    'queueEntryId', changed_row->>'id',
    'encounterId', changed_row->>'encounter_id',
    'patientId', changed_row->>'patient_id',
    'department', changed_row->>'department',
    'status', changed_row->>'status'
  )::text);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS queue_entries_notify ON queue_entries;--> statement-breakpoint
CREATE TRIGGER queue_entries_notify AFTER INSERT OR UPDATE OR DELETE ON queue_entries FOR EACH ROW EXECUTE FUNCTION notify_queue_change();