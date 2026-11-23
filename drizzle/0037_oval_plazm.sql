CREATE TABLE "sha_co_pay_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"empanelment_id" uuid NOT NULL,
	"benefit_package_id" uuid NOT NULL,
	"eligibility_check_id" uuid,
	"payer_id" uuid,
	"fund" "sha_fund" NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_patient_pay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_coverage" varchar(16);--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_billed_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_patient_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_preauth_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "pre_auth_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "co_pay_assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_empanelment_id_sha_empanelments_id_fk" FOREIGN KEY ("empanelment_id") REFERENCES "public"."sha_empanelments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_benefit_package_id_benefit_packages_id_fk" FOREIGN KEY ("benefit_package_id") REFERENCES "public"."benefit_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_co_pay_assessments" ADD CONSTRAINT "sha_co_pay_assessments_eligibility_check_id_sha_eligibility_checks_id_fk" FOREIGN KEY ("eligibility_check_id") REFERENCES "public"."sha_eligibility_checks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sha_co_pay_assessments_patient_idx" ON "sha_co_pay_assessments" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE INDEX "sha_co_pay_assessments_invoice_idx" ON "sha_co_pay_assessments" USING btree ("facility_id","invoice_id");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_empanelment_id_sha_empanelments_id_fk" FOREIGN KEY ("empanelment_id") REFERENCES "public"."sha_empanelments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_benefit_package_id_benefit_packages_id_fk" FOREIGN KEY ("benefit_package_id") REFERENCES "public"."benefit_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_pre_auth_id_pre_authorizations_id_fk" FOREIGN KEY ("pre_auth_id") REFERENCES "public"."pre_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_co_pay_assessment_id_sha_co_pay_assessments_id_fk" FOREIGN KEY ("co_pay_assessment_id") REFERENCES "public"."sha_co_pay_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_waiver_id_sha_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."sha_waivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_benefit_package_id_benefit_packages_id_fk" FOREIGN KEY ("benefit_package_id") REFERENCES "public"."benefit_packages"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- SHA master and cycle evidence is regulatory/financial history: no hard deletes.
INSERT INTO sync_tables (table_name, append_only, business_key, capture, enabled, no_hard_delete) VALUES
  ('sha_co_pay_assessments', true, NULL, true, true, true),
  ('sha_empanelments', false, NULL, true, true, true),
  ('benefit_packages', false, NULL, true, true, true),
  ('benefit_package_items', false, NULL, true, true, true),
  ('sha_eligibility_checks', true, NULL, true, true, true),
  ('sha_waivers', false, NULL, true, true, true),
  ('sha_payment_reconciliation', false, NULL, true, true, true),
  ('sha_reconciliation_lines', true, NULL, true, true, true),
  ('sha_adjudication_codes', false, NULL, true, true, true)
ON CONFLICT (table_name) DO UPDATE SET
  append_only = EXCLUDED.append_only,
  capture = EXCLUDED.capture,
  enabled = EXCLUDED.enabled,
  no_hard_delete = true;--> statement-breakpoint
DO $$
DECLARE
  protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'sha_co_pay_assessments', 'sha_empanelments', 'benefit_packages',
    'benefit_package_items', 'sha_eligibility_checks', 'sha_waivers',
    'sha_payment_reconciliation', 'sha_reconciliation_lines', 'sha_adjudication_codes'
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
-- The new co-pay table must participate in outbox capture on every node.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT table_name FROM sync_tables WHERE capture = true AND enabled = true LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      t
    );
  END LOOP;
END;
$$;