CREATE TYPE "public"."asset_approval_subject" AS ENUM('depreciation_run', 'valuation', 'disposal');--> statement-breakpoint
CREATE TYPE "public"."asset_assignment_event" AS ENUM('assigned', 'transferred', 'returned');--> statement-breakpoint
CREATE TYPE "public"."asset_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."asset_payment_method" AS ENUM('none', 'cash', 'bank', 'accrued');--> statement-breakpoint
CREATE TYPE "public"."asset_process_status" AS ENUM('requested', 'approved', 'posted', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('in_service', 'stored', 'maintenance', 'disposed', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."asset_valuation_kind" AS ENUM('revaluation', 'impairment');--> statement-breakpoint
CREATE TYPE "public"."depreciation_run_status" AS ENUM('draft', 'approved', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_event_type" AS ENUM('scheduled', 'started', 'completed', 'note');--> statement-breakpoint
CREATE TYPE "public"."maintenance_order_status" AS ENUM('open', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_order_type" AS ENUM('preventive', 'corrective', 'inspection');--> statement-breakpoint
CREATE TYPE "public"."maintenance_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'asset_manager' BEFORE 'auditor';--> statement-breakpoint
CREATE TABLE "asset_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"subject_type" "asset_approval_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"decision" "asset_decision" NOT NULL,
	"actor_id" text NOT NULL,
	"role" varchar(32) NOT NULL,
	"max_amount" numeric(14, 2) NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"event_type" "asset_assignment_event" NOT NULL,
	"from_employee_id" uuid,
	"to_employee_id" uuid,
	"from_location" text,
	"to_location" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performed_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_disposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"disposal_no" varchar(40) NOT NULL,
	"method" varchar(32) NOT NULL,
	"disposal_date" date NOT NULL,
	"proceeds" numeric(14, 2) DEFAULT '0' NOT NULL,
	"proceeds_method" "asset_payment_method" DEFAULT 'cash' NOT NULL,
	"carrying_amount" numeric(14, 2) NOT NULL,
	"gain_loss" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" "asset_process_status" DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"completed_by" text,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_valuations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"valuation_no" varchar(40) NOT NULL,
	"kind" "asset_valuation_kind" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"carrying_before" numeric(14, 2) NOT NULL,
	"carrying_after" numeric(14, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text NOT NULL,
	"status" "asset_process_status" DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"posted_by" text,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_no" varchar(40) NOT NULL,
	"category" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"tag_no" varchar(80),
	"serial_no" varchar(120),
	"location" text NOT NULL,
	"custodian_employee_id" uuid,
	"custodian_name" varchar(120),
	"department_id" uuid,
	"cost_center_id" uuid,
	"acquisition_date" date NOT NULL,
	"acquisition_cost" numeric(14, 2) NOT NULL,
	"residual_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"accumulated_depreciation" numeric(14, 2) DEFAULT '0' NOT NULL,
	"carrying_amount" numeric(14, 2) NOT NULL,
	"status" "asset_status" DEFAULT 'in_service' NOT NULL,
	"last_depreciation_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"period" date NOT NULL,
	"opening_carrying_amount" numeric(14, 2) NOT NULL,
	"depreciation_amount" numeric(14, 2) NOT NULL,
	"closing_carrying_amount" numeric(14, 2) NOT NULL,
	"useful_life_months" integer NOT NULL,
	"cost_center_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depreciation_run_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"decision" "asset_decision" NOT NULL,
	"actor_id" text NOT NULL,
	"role" varchar(32) NOT NULL,
	"max_amount" numeric(14, 2) NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depreciation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_no" varchar(40) NOT NULL,
	"period" date NOT NULL,
	"description" text,
	"status" "depreciation_run_status" DEFAULT 'draft' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"asset_count" integer NOT NULL,
	"journal_entry_id" uuid,
	"prepared_by" text NOT NULL,
	"approved_by" text,
	"posted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"order_id" uuid,
	"event_type" "maintenance_event_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"parts_used" text,
	"cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"performed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"order_no" varchar(40) NOT NULL,
	"type" "maintenance_order_type" NOT NULL,
	"priority" "maintenance_priority" DEFAULT 'normal' NOT NULL,
	"status" "maintenance_order_status" DEFAULT 'open' NOT NULL,
	"scheduled_date" date,
	"requested_by" text NOT NULL,
	"assigned_to_employee_id" uuid,
	"vendor_name" varchar(160),
	"description" text NOT NULL,
	"parts_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"labor_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_method" "asset_payment_method" DEFAULT 'none' NOT NULL,
	"journal_entry_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_approvals" ADD CONSTRAINT "asset_approvals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_from_employee_id_employees_id_fk" FOREIGN KEY ("from_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_to_employee_id_employees_id_fk" FOREIGN KEY ("to_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_custodian_employee_id_employees_id_fk" FOREIGN KEY ("custodian_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_run_id_depreciation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."depreciation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_run_approvals" ADD CONSTRAINT "depreciation_run_approvals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_run_approvals" ADD CONSTRAINT "depreciation_run_approvals_run_id_depreciation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."depreciation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_order_id_maintenance_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."maintenance_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_assigned_to_employee_id_employees_id_fk" FOREIGN KEY ("assigned_to_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_approvals_subject_idx" ON "asset_approvals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "asset_approvals_facility_idx" ON "asset_approvals" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "asset_assignments_asset_occurred_idx" ON "asset_assignments" USING btree ("asset_id","occurred_at");--> statement-breakpoint
CREATE INDEX "asset_assignments_facility_idx" ON "asset_assignments" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_disposals_facility_disposal_no_idx" ON "asset_disposals" USING btree ("facility_id","disposal_no");--> statement-breakpoint
CREATE INDEX "asset_disposals_asset_idx" ON "asset_disposals" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_disposals_facility_status_idx" ON "asset_disposals" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_valuations_facility_valuation_no_idx" ON "asset_valuations" USING btree ("facility_id","valuation_no");--> statement-breakpoint
CREATE INDEX "asset_valuations_asset_idx" ON "asset_valuations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_valuations_facility_status_idx" ON "asset_valuations" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_facility_asset_no_idx" ON "assets" USING btree ("facility_id","asset_no");--> statement-breakpoint
CREATE INDEX "assets_facility_tag_idx" ON "assets" USING btree ("facility_id","tag_no");--> statement-breakpoint
CREATE INDEX "assets_facility_category_idx" ON "assets" USING btree ("facility_id","category");--> statement-breakpoint
CREATE INDEX "assets_facility_status_idx" ON "assets" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "assets_custodian_idx" ON "assets" USING btree ("custodian_employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_entries_run_asset_idx" ON "depreciation_entries" USING btree ("run_id","asset_id");--> statement-breakpoint
CREATE INDEX "depreciation_entries_facility_period_idx" ON "depreciation_entries" USING btree ("facility_id","period");--> statement-breakpoint
CREATE INDEX "depreciation_run_approvals_run_idx" ON "depreciation_run_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "depreciation_run_approvals_facility_idx" ON "depreciation_run_approvals" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_runs_facility_run_no_idx" ON "depreciation_runs" USING btree ("facility_id","run_no");--> statement-breakpoint
CREATE INDEX "depreciation_runs_facility_period_idx" ON "depreciation_runs" USING btree ("facility_id","period");--> statement-breakpoint
CREATE INDEX "maintenance_events_asset_occurred_idx" ON "maintenance_events" USING btree ("asset_id","occurred_at");--> statement-breakpoint
CREATE INDEX "maintenance_events_order_idx" ON "maintenance_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "maintenance_events_facility_idx" ON "maintenance_events" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_orders_facility_order_no_idx" ON "maintenance_orders" USING btree ("facility_id","order_no");--> statement-breakpoint
CREATE INDEX "maintenance_orders_asset_idx" ON "maintenance_orders" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_orders_facility_status_idx" ON "maintenance_orders" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_orders_scheduled_idx" ON "maintenance_orders" USING btree ("facility_id","scheduled_date");
--> statement-breakpoint

-- Asset register and lifecycle history are facility-owned, synced through the
-- existing outbox, and never physically deleted. Event tables are append-only.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture", "no_hard_delete")
VALUES
  ('assets', false, NULL, true, true),
  ('asset_assignments', true, NULL, true, true),
  ('depreciation_runs', false, NULL, true, true),
  ('depreciation_entries', true, NULL, true, true),
  ('depreciation_run_approvals', true, NULL, true, true),
  ('maintenance_orders', false, NULL, true, true),
  ('maintenance_events', true, NULL, true, true),
  ('asset_valuations', false, NULL, true, true),
  ('asset_disposals', false, NULL, true, true),
  ('asset_approvals', true, NULL, true, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture,
  no_hard_delete = EXCLUDED.no_hard_delete;--> statement-breakpoint

DO $$
DECLARE
  asset_table text;
BEGIN
  FOREACH asset_table IN ARRAY ARRAY[
    'assets', 'asset_assignments', 'depreciation_runs', 'depreciation_entries',
    'depreciation_run_approvals', 'maintenance_orders', 'maintenance_events',
    'asset_valuations', 'asset_disposals', 'asset_approvals'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', asset_table);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      asset_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS protected_record_no_delete_trigger ON %I', asset_table);
    EXECUTE format(
      'CREATE TRIGGER protected_record_no_delete_trigger BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protected_record_no_delete()',
      asset_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "asset_records_append_only"() RETURNS trigger AS $$
BEGIN
  IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'asset records are append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
DECLARE
  asset_event_table text;
BEGIN
  FOREACH asset_event_table IN ARRAY ARRAY[
    'asset_assignments', 'depreciation_entries', 'depreciation_run_approvals',
    'maintenance_events', 'asset_approvals'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS asset_records_append_only_trigger ON %I', asset_event_table);
    EXECUTE format(
      'CREATE TRIGGER asset_records_append_only_trigger BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION asset_records_append_only()',
      asset_event_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

-- Facilities installed before Phase 16 keep their own chart numbering. Map
-- matching uncoded accounts first, then add only the missing system accounts.
UPDATE "ledger_accounts" la
SET "system_role" = chart."system_role", "updated_at" = now(), "version" = la."version" + 1
FROM (VALUES
  ('1220', 'asset_proceeds_receivable'),
  ('1400', 'fixed_asset'),
  ('1410', 'accumulated_depreciation'),
  ('3120', 'revaluation_reserve'),
  ('5400', 'depreciation_expense'),
  ('5410', 'impairment_expense'),
  ('5420', 'maintenance_expense'),
  ('6100', 'disposal_gain'),
  ('6200', 'disposal_loss')
) AS chart("code", "system_role")
WHERE la."code" = chart."code"
  AND la."system_role" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ledger_accounts" other
    WHERE other."facility_id" = la."facility_id"
      AND other."system_role" = chart."system_role"
  );--> statement-breakpoint

INSERT INTO "ledger_accounts" (
  "id", "facility_id", "code", "name", "type", "normal_balance",
  "system_role", "active", "created_at", "updated_at", "created_by", "version"
)
SELECT
  uuidv7(), f.id, account."code", account."name",
  account."type"::ledger_account_type, account."normal_balance"::normal_balance,
  account."system_role", true, now(), now(), 'migration-0030', 1
FROM "facilities" f
CROSS JOIN (
  VALUES
    ('1220', 'Asset disposal proceeds receivable', 'asset', 'debit', 'asset_proceeds_receivable'),
    ('1400', 'Fixed assets', 'asset', 'debit', 'fixed_asset'),
    ('1410', 'Accumulated depreciation', 'asset', 'debit', 'accumulated_depreciation'),
    ('3120', 'Asset revaluation reserve', 'equity', 'credit', 'revaluation_reserve'),
    ('5400', 'Depreciation expense', 'expense', 'debit', 'depreciation_expense'),
    ('5410', 'Asset impairment expense', 'expense', 'debit', 'impairment_expense'),
    ('5420', 'Maintenance expense', 'expense', 'debit', 'maintenance_expense'),
    ('6100', 'Asset disposal gain', 'revenue', 'credit', 'disposal_gain'),
    ('6200', 'Asset disposal loss', 'expense', 'debit', 'disposal_loss')
) AS account("code", "name", "type", "normal_balance", "system_role")
WHERE NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la."facility_id" = f.id AND la."code" = account."code"
)
AND NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la."facility_id" = f.id AND la."system_role" = account."system_role"
);