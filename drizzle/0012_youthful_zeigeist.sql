CREATE TYPE "public"."bank_reconciliation_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TYPE "public"."fiscal_period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('posted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."claim_denial_status" AS ENUM('open', 'upheld', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('draft', 'submitted', 'accepted', 'queried', 'rejected', 'resubmitted', 'paid', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payer_contract_status" AS ENUM('active', 'suspended', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payer_kind" AS ENUM('cash', 'corporate', 'insurer', 'sha');--> statement-breakpoint
CREATE TYPE "public"."preauth_status" AS ENUM('requested', 'approved', 'declined', 'expired');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'accountant' BEFORE 'admin';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'finance_officer' BEFORE 'admin';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'revenue_cycle_officer' BEFORE 'admin';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'auditor' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(32) DEFAULT 'bank' NOT NULL,
	"account_number" varchar(64),
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"opening_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"statement_balance" numeric(12, 2) NOT NULL,
	"ledger_balance" numeric(12, 2) NOT NULL,
	"difference" numeric(12, 2) NOT NULL,
	"status" "bank_reconciliation_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"txn_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reference" text,
	"source_type" varchar(32) DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"reconciled" boolean DEFAULT false NOT NULL,
	"reconciliation_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_centers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "fiscal_period_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"entry_no" varchar(40) NOT NULL,
	"entry_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"description" text NOT NULL,
	"source_type" varchar(32) DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"status" "journal_status" DEFAULT 'posted' NOT NULL,
	"reversed_entry_id" uuid,
	"reversal_reason" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"cost_center_id" uuid,
	"description" text,
	"debit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"normal_balance" "normal_balance" NOT NULL,
	"system_role" varchar(32),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_denials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"claim_line_id" uuid,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reason" text NOT NULL,
	"status" "claim_denial_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"charge_id" uuid,
	"service_id" uuid,
	"description" text NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"approved_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"denial_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"contract_id" uuid,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"invoice_id" uuid,
	"claim_no" varchar(40) NOT NULL,
	"status" "claim_status" DEFAULT 'draft' NOT NULL,
	"total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"approved_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"paid_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer_benefits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"service_id" uuid,
	"category" varchar(64) NOT NULL,
	"annual_limit" numeric(12, 2),
	"per_visit_limit" numeric(12, 2),
	"copay_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"contract_no" varchar(64) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "payer_contract_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"kind" "payer_kind" DEFAULT 'insurer' NOT NULL,
	"contact_name" text,
	"phone" varchar(50),
	"email" varchar(255),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pre_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"contract_id" uuid,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"auth_no" varchar(40) NOT NULL,
	"requested_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"approved_amount" numeric(12, 2),
	"status" "preauth_status" DEFAULT 'requested' NOT NULL,
	"reference" text,
	"expires_at" date,
	"notes" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remittances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"claim_line_id" uuid,
	"remittance_no" varchar(40) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reference" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciliation_id_bank_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."bank_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversed_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_denials" ADD CONSTRAINT "claim_denials_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_denials" ADD CONSTRAINT "claim_denials_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_denials" ADD CONSTRAINT "claim_denials_claim_line_id_claim_lines_id_fk" FOREIGN KEY ("claim_line_id") REFERENCES "public"."claim_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_contract_id_payer_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."payer_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_benefits" ADD CONSTRAINT "payer_benefits_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_benefits" ADD CONSTRAINT "payer_benefits_contract_id_payer_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."payer_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_benefits" ADD CONSTRAINT "payer_benefits_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD CONSTRAINT "payer_contracts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_contracts" ADD CONSTRAINT "payer_contracts_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payers" ADD CONSTRAINT "payers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_contract_id_payer_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."payer_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_claim_line_id_claim_lines_id_fk" FOREIGN KEY ("claim_line_id") REFERENCES "public"."claim_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_facility_name_idx" ON "bank_accounts" USING btree ("facility_id","name");--> statement-breakpoint
CREATE INDEX "bank_accounts_facility_idx" ON "bank_accounts" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_account_period_idx" ON "bank_reconciliations" USING btree ("facility_id","bank_account_id","period_start");--> statement-breakpoint
CREATE INDEX "bank_transactions_account_date_idx" ON "bank_transactions" USING btree ("facility_id","bank_account_id","txn_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_reconciliation_idx" ON "bank_transactions" USING btree ("facility_id","reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_centers_facility_code_idx" ON "cost_centers" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "cost_centers_facility_idx" ON "cost_centers" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_facility_name_idx" ON "fiscal_periods" USING btree ("facility_id","name");--> statement-breakpoint
CREATE INDEX "fiscal_periods_facility_range_idx" ON "fiscal_periods" USING btree ("facility_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_facility_entry_no_idx" ON "journal_entries" USING btree ("facility_id","entry_no");--> statement-breakpoint
CREATE INDEX "journal_entries_facility_date_idx" ON "journal_entries" USING btree ("facility_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_period_idx" ON "journal_entries" USING btree ("facility_id","period_id");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("facility_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_reversed_idx" ON "journal_entries" USING btree ("facility_id","reversed_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_idx" ON "journal_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("facility_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("facility_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_facility_code_idx" ON "ledger_accounts" USING btree ("facility_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_facility_system_role_idx" ON "ledger_accounts" USING btree ("facility_id","system_role") WHERE "ledger_accounts"."system_role" is not null;--> statement-breakpoint
CREATE INDEX "ledger_accounts_facility_type_idx" ON "ledger_accounts" USING btree ("facility_id","type");--> statement-breakpoint
CREATE INDEX "claim_denials_claim_idx" ON "claim_denials" USING btree ("facility_id","claim_id");--> statement-breakpoint
CREATE INDEX "claim_denials_status_idx" ON "claim_denials" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "claim_lines_claim_idx" ON "claim_lines" USING btree ("facility_id","claim_id");--> statement-breakpoint
CREATE INDEX "claim_lines_charge_idx" ON "claim_lines" USING btree ("facility_id","charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_facility_claim_no_idx" ON "claims" USING btree ("facility_id","claim_no");--> statement-breakpoint
CREATE INDEX "claims_invoice_idx" ON "claims" USING btree ("facility_id","invoice_id");--> statement-breakpoint
CREATE INDEX "claims_status_idx" ON "claims" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "claims_patient_idx" ON "claims" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE INDEX "payer_benefits_contract_idx" ON "payer_benefits" USING btree ("facility_id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_contracts_facility_contract_idx" ON "payer_contracts" USING btree ("facility_id","contract_no");--> statement-breakpoint
CREATE INDEX "payer_contracts_payer_idx" ON "payer_contracts" USING btree ("facility_id","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payers_facility_code_idx" ON "payers" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "payers_facility_idx" ON "payers" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pre_authorizations_facility_auth_no_idx" ON "pre_authorizations" USING btree ("facility_id","auth_no");--> statement-breakpoint
CREATE INDEX "pre_authorizations_patient_idx" ON "pre_authorizations" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE INDEX "pre_authorizations_payer_idx" ON "pre_authorizations" USING btree ("facility_id","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remittances_facility_remittance_no_idx" ON "remittances" USING btree ("facility_id","remittance_no");--> statement-breakpoint
CREATE INDEX "remittances_claim_idx" ON "remittances" USING btree ("facility_id","claim_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_lines_append_only"() RETURNS trigger AS $$
BEGIN
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'journal_lines is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "journal_lines_append_only_trigger" BEFORE UPDATE OR DELETE ON "journal_lines" FOR EACH ROW EXECUTE FUNCTION "journal_lines_append_only"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_entries_immutable"() RETURNS trigger AS $$
BEGIN
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'journal_entries cannot be deleted; reverse the entry instead';
	END IF;
	IF NEW.entry_no <> OLD.entry_no
		OR NEW.entry_date <> OLD.entry_date
		OR NEW.period_id <> OLD.period_id
		OR NEW.description <> OLD.description
		OR NEW.source_type <> OLD.source_type
		OR COALESCE(NEW.source_id, '') <> COALESCE(OLD.source_id, '')
		OR NEW.posted_at <> OLD.posted_at
		OR COALESCE(NEW.posted_by, '') <> COALESCE(OLD.posted_by, '')
	THEN
		RAISE EXCEPTION 'journal_entries is immutable; reverse the entry instead';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_immutable_trigger" BEFORE UPDATE OR DELETE ON "journal_entries" FOR EACH ROW EXECUTE FUNCTION "journal_entries_immutable"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "remittances_append_only"() RETURNS trigger AS $$
BEGIN
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'remittances is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "remittances_append_only_trigger" BEFORE UPDATE OR DELETE ON "remittances" FOR EACH ROW EXECUTE FUNCTION "remittances_append_only"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bank_transactions_immutable"() RETURNS trigger AS $$
BEGIN
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bank_transactions cannot be deleted';
	END IF;
	IF NEW.txn_date <> OLD.txn_date
		OR NEW.amount <> OLD.amount
		OR NEW.bank_account_id <> OLD.bank_account_id
		OR NEW.description <> OLD.description
	THEN
		RAISE EXCEPTION 'bank_transactions is immutable apart from reconciliation flags';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_transactions_immutable_trigger" BEFORE UPDATE OR DELETE ON "bank_transactions" FOR EACH ROW EXECUTE FUNCTION "bank_transactions_immutable"();
