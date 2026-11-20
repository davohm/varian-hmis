ALTER TYPE "public"."admin_section" ADD VALUE 'privacy';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'dpo' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE "chart_access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"user_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_type" text,
	"device_id" text,
	"ip" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_breaches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"contained_at" timestamp with time zone,
	"odpc_notified_at" timestamp with time zone,
	"affected_subjects" integer,
	"affected_records" integer,
	"severity" text NOT NULL,
	"description" text,
	"containment" text,
	"root_cause" text,
	"status" text NOT NULL,
	"reported_by" text,
	"odpc_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"consent_version" text NOT NULL,
	"consent_text_hash" text,
	"granted" boolean NOT NULL,
	"granted_at" timestamp with time zone,
	"granted_by" text,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"source" text,
	"document_id" uuid,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sharing_agreements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"counterparty" text NOT NULL,
	"counterparty_type" text,
	"purpose" text,
	"lawful_basis" text,
	"odpc_reference" text,
	"started_on" date,
	"expires_on" date,
	"status" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"status" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"requested_via" text,
	"identity_verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"outcome" text,
	"rejection_reason" text,
	"handled_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"legal_basis" text,
	"retention_years" integer,
	"trigger_event" text,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"destroy_after" date,
	"review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"transfer_path" text,
	"destination_country" text,
	"mechanism" text,
	"lawful_basis" text,
	"assessment_date" date,
	"review_date" date,
	"status" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chart_access_log" ADD CONSTRAINT "chart_access_log_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_access_log" ADD CONSTRAINT "chart_access_log_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_breaches" ADD CONSTRAINT "data_breaches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_consents" ADD CONSTRAINT "data_consents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_consents" ADD CONSTRAINT "data_consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sharing_agreements" ADD CONSTRAINT "data_sharing_agreements_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_assessments" ADD CONSTRAINT "transfer_assessments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_access_log_facility_patient_idx" ON "chart_access_log" USING btree ("facility_id","patient_id","accessed_at");--> statement-breakpoint
CREATE INDEX "chart_access_log_facility_accessed_idx" ON "chart_access_log" USING btree ("facility_id","accessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_breaches_facility_reference_idx" ON "data_breaches" USING btree ("facility_id","reference");--> statement-breakpoint
CREATE INDEX "data_breaches_facility_status_idx" ON "data_breaches" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "data_breaches_facility_severity_idx" ON "data_breaches" USING btree ("facility_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "data_consents_facility_patient_type_version_idx" ON "data_consents" USING btree ("facility_id","patient_id","consent_type","consent_version");--> statement-breakpoint
CREATE INDEX "data_consents_facility_patient_type_idx" ON "data_consents" USING btree ("facility_id","patient_id","consent_type");--> statement-breakpoint
CREATE INDEX "data_consents_facility_idx" ON "data_consents" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "data_sharing_agreements_facility_expiry_idx" ON "data_sharing_agreements" USING btree ("facility_id","expires_on");--> statement-breakpoint
CREATE INDEX "data_sharing_agreements_facility_counterparty_idx" ON "data_sharing_agreements" USING btree ("facility_id","counterparty");--> statement-breakpoint
CREATE INDEX "data_subject_requests_facility_status_idx" ON "data_subject_requests" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "data_subject_requests_facility_due_idx" ON "data_subject_requests" USING btree ("facility_id","due_at");--> statement-breakpoint
CREATE INDEX "data_subject_requests_facility_patient_idx" ON "data_subject_requests" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE INDEX "retention_policies_facility_entity_idx" ON "retention_policies" USING btree ("facility_id","entity");--> statement-breakpoint
CREATE INDEX "retention_policies_facility_review_idx" ON "retention_policies" USING btree ("facility_id","review_at");--> statement-breakpoint
CREATE INDEX "transfer_assessments_facility_review_idx" ON "transfer_assessments" USING btree ("facility_id","review_date");--> statement-breakpoint
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture") VALUES
  ('data_consents', false, NULL, true),
  ('data_subject_requests', false, NULL, true),
  ('data_breaches', false, NULL, true),
  ('retention_policies', false, NULL, true),
  ('data_sharing_agreements', false, NULL, true),
  ('transfer_assessments', false, NULL, true),
  ('chart_access_log', true, NULL, true);--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'data_consents',
    'data_subject_requests',
    'data_breaches',
    'retention_policies',
    'data_sharing_agreements',
    'transfer_assessments',
    'chart_access_log'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      t
    );
  END LOOP;
END;
$$;