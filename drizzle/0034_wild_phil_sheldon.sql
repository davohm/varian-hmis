CREATE TYPE "public"."sha_care_type" AS ENUM('inpatient', 'outpatient');--> statement-breakpoint
CREATE TYPE "public"."sha_coverage" AS ENUM('full', 'partial', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."sha_eligibility" AS ENUM('eligible', 'ineligible', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."sha_empanelment_status" AS ENUM('active', 'suspended', 'expired', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."sha_fund" AS ENUM('phf', 'shif', 'eccif');--> statement-breakpoint
CREATE TYPE "public"."sha_reconciliation_line_status" AS ENUM('matched', 'unmatched', 'variance');--> statement-breakpoint
CREATE TYPE "public"."sha_reconciliation_status" AS ENUM('pending', 'matched', 'variance', 'posted');--> statement-breakpoint
CREATE TYPE "public"."sha_waiver_kind" AS ENUM('waiver', 'exemption');--> statement-breakpoint
CREATE TYPE "public"."sha_waiver_status" AS ENUM('requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "benefit_package_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"benefit_package_id" uuid NOT NULL,
	"service_id" uuid,
	"item_id" uuid,
	"sha_service_code" varchar(64),
	"category" varchar(64),
	"description" text,
	"coverage" "sha_coverage" NOT NULL,
	"limit_amount" numeric(12, 2),
	"limit_days" numeric(6, 0),
	"limit_visits" numeric(6, 0),
	"requires_preauth" boolean DEFAULT false NOT NULL,
	"preauth_threshold" numeric(12, 2),
	"co_pay_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benefit_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"fund" "sha_fund" NOT NULL,
	"package_code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"care_level" varchar(64),
	"care_type" "sha_care_type" NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_eligibility_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_id" uuid,
	"empanelment_id" uuid,
	"fund" "sha_fund",
	"member_ref" varchar(64),
	"eligibility" "sha_eligibility" NOT NULL,
	"check_ref" varchar(64),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_empanelments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kmpdc_number" varchar(64),
	"fund" "sha_fund" NOT NULL,
	"scheme_code" varchar(64) NOT NULL,
	"scheme_name" text,
	"contract_no" varchar(64),
	"contract_status" "sha_empanelment_status" DEFAULT 'active' NOT NULL,
	"effective_from" date NOT NULL,
	"expiry_date" date,
	"tariff_version" varchar(64),
	"quality_cert_program" text,
	"quality_cert_expiry" date,
	"bank_account_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_payment_reconciliation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kmpdc_number" varchar(64) NOT NULL,
	"report_period" varchar(32) NOT NULL,
	"report_ref" varchar(64),
	"sha_reported_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"facility_invoiced_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"matched_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"unmatched_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"variance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "sha_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"journal_entry_id" uuid,
	"generated_by" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_reconciliation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"claim_id" uuid,
	"claim_no" varchar(40),
	"sha_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"facility_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"variance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "sha_reconciliation_line_status" DEFAULT 'unmatched' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_waivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" "sha_waiver_kind" NOT NULL,
	"claim_id" uuid,
	"invoice_id" uuid,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"status" "sha_waiver_status" DEFAULT 'requested' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "is_sha_claimable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_denials" ADD COLUMN "sha_denial_code" varchar(32);--> statement-breakpoint
ALTER TABLE "claim_denials" ADD COLUMN "adjudication_reason" text;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "sha_service_code" varchar(64);--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "unit_price" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "quantity" numeric(12, 2) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD COLUMN "denial_code" varchar(32);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "sha_claim_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "fund" varchar(16);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "empanelment_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "tariff_version" varchar(64);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "submission_batch" varchar(64);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "adjudication_status" varchar(32);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "adjudication_code" varchar(32);--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "billed_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "patient_co_pay" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "waiver_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD COLUMN "fund" varchar(16);--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD COLUMN "sha_empanelment_id" uuid;--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD COLUMN "tariff_version" varchar(64);--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD COLUMN "sha_package_id" uuid;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD COLUMN "sha_auth_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD COLUMN "fund" varchar(16);--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD COLUMN "benefit_package_id" uuid;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD COLUMN "sha_status" varchar(32);--> statement-breakpoint
ALTER TABLE "remittances" ADD COLUMN "sha_payment_report_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "remittances" ADD COLUMN "bank_reference" varchar(64);--> statement-breakpoint
ALTER TABLE "remittances" ADD COLUMN "payment_date" date;--> statement-breakpoint
ALTER TABLE "benefit_package_items" ADD CONSTRAINT "benefit_package_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_package_items" ADD CONSTRAINT "benefit_package_items_benefit_package_id_benefit_packages_id_fk" FOREIGN KEY ("benefit_package_id") REFERENCES "public"."benefit_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_packages" ADD CONSTRAINT "benefit_packages_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_eligibility_checks" ADD CONSTRAINT "sha_eligibility_checks_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_eligibility_checks" ADD CONSTRAINT "sha_eligibility_checks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_eligibility_checks" ADD CONSTRAINT "sha_eligibility_checks_empanelment_id_sha_empanelments_id_fk" FOREIGN KEY ("empanelment_id") REFERENCES "public"."sha_empanelments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_empanelments" ADD CONSTRAINT "sha_empanelments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_payment_reconciliation" ADD CONSTRAINT "sha_payment_reconciliation_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_reconciliation_lines" ADD CONSTRAINT "sha_reconciliation_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_reconciliation_lines" ADD CONSTRAINT "sha_reconciliation_lines_reconciliation_id_sha_payment_reconciliation_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."sha_payment_reconciliation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_waivers" ADD CONSTRAINT "sha_waivers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_waivers" ADD CONSTRAINT "sha_waivers_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benefit_package_items_package_idx" ON "benefit_package_items" USING btree ("facility_id","benefit_package_id");--> statement-breakpoint
CREATE INDEX "benefit_package_items_code_idx" ON "benefit_package_items" USING btree ("facility_id","benefit_package_id","sha_service_code");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_packages_facility_fund_package_idx" ON "benefit_packages" USING btree ("facility_id","fund","package_code","effective_from");--> statement-breakpoint
CREATE INDEX "benefit_packages_facility_idx" ON "benefit_packages" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "sha_eligibility_checks_patient_idx" ON "sha_eligibility_checks" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sha_empanelments_facility_fund_scheme_idx" ON "sha_empanelments" USING btree ("facility_id","fund","scheme_code");--> statement-breakpoint
CREATE INDEX "sha_empanelments_facility_idx" ON "sha_empanelments" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sha_reconciliation_facility_period_idx" ON "sha_payment_reconciliation" USING btree ("facility_id","kmpdc_number","report_period");--> statement-breakpoint
CREATE INDEX "sha_reconciliation_lines_reconciliation_idx" ON "sha_reconciliation_lines" USING btree ("facility_id","reconciliation_id");--> statement-breakpoint
CREATE INDEX "sha_waivers_facility_idx" ON "sha_waivers" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_facility_sha_ref_idx" ON "claims" USING btree ("facility_id","sha_claim_ref");
-- Register SHA tables with the sync engine and install capture triggers.
INSERT INTO sync_tables (table_name, append_only, business_key, capture, enabled) VALUES
  ('sha_empanelments', false, NULL, true, true),
  ('benefit_packages', false, NULL, true, true),
  ('benefit_package_items', false, NULL, true, true),
  ('sha_eligibility_checks', true, NULL, true, true),
  ('sha_waivers', false, NULL, true, true),
  ('sha_payment_reconciliation', false, NULL, true, true),
  ('sha_reconciliation_lines', true, NULL, true, true)
ON CONFLICT (table_name) DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture,
  enabled = EXCLUDED.enabled;--> statement-breakpoint

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
