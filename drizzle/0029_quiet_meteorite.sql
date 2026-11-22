CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'half_day', 'leave');--> statement-breakpoint
CREATE TYPE "public"."contract_type" AS ENUM('permanent', 'fixed_term', 'internship', 'locum');--> statement-breakpoint
CREATE TYPE "public"."employment_status" AS ENUM('active', 'on_leave', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('requested', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."leave_type" AS ENUM('annual', 'sick', 'maternity', 'paternity', 'unpaid', 'compassionate');--> statement-breakpoint
CREATE TYPE "public"."payroll_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'approved', 'posted', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'hr_officer' BEFORE 'auditor';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'payroll_officer' BEFORE 'auditor';--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"hours_worked" numeric(5, 2) DEFAULT '0' NOT NULL,
	"shift_assignment_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"employee_no" varchar(32) NOT NULL,
	"user_id" text,
	"first_name" varchar(120) NOT NULL,
	"last_name" varchar(120) NOT NULL,
	"national_id" varchar(64),
	"phone" varchar(50),
	"email" varchar(255),
	"bank_name" varchar(120),
	"bank_branch" varchar(120),
	"bank_account_number" varchar(64),
	"employment_status" "employment_status" DEFAULT 'active' NOT NULL,
	"date_of_joining" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employment_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"contract_type" "contract_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"basic_salary" numeric(14, 2) NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type" "leave_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"days" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "leave_status" DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"title" varchar(160) NOT NULL,
	"department_id" uuid,
	"grade" varchar(32),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_template_id" uuid NOT NULL,
	"assigned_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"end_time" varchar(5) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_no" varchar(32) NOT NULL,
	"employee_name" varchar(240) NOT NULL,
	"basic_salary" numeric(14, 2) NOT NULL,
	"allowances" numeric(14, 2) NOT NULL,
	"gross_pay" numeric(14, 2) NOT NULL,
	"paye" numeric(14, 2) NOT NULL,
	"nssf_employee" numeric(14, 2) NOT NULL,
	"nssf_employer" numeric(14, 2) NOT NULL,
	"shif" numeric(14, 2) NOT NULL,
	"housing_levy" numeric(14, 2) NOT NULL,
	"other_deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_pay" numeric(14, 2) NOT NULL,
	"employer_cost" numeric(14, 2) NOT NULL,
	"cost_center_id" uuid,
	"missing_rate_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_run_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"decision" "payroll_decision" NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_no" varchar(40) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"description" text,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"total_gross" numeric(14, 2) NOT NULL,
	"total_deductions" numeric(14, 2) NOT NULL,
	"total_net" numeric(14, 2) NOT NULL,
	"total_employer_cost" numeric(14, 2) NOT NULL,
	"missing_rate_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prepared_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"slip_no" varchar(40) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_assignment_id_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_template_id_shift_templates_id_fk" FOREIGN KEY ("shift_template_id") REFERENCES "public"."shift_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_approvals" ADD CONSTRAINT "payroll_run_approvals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_approvals" ADD CONSTRAINT "payroll_run_approvals_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_line_id_payroll_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."payroll_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_employee_date_idx" ON "attendance_records" USING btree ("facility_id","employee_id","work_date");--> statement-breakpoint
CREATE INDEX "attendance_records_facility_date_idx" ON "attendance_records" USING btree ("facility_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_facility_no_idx" ON "employees" USING btree ("facility_id","employee_no");--> statement-breakpoint
CREATE INDEX "employees_facility_status_idx" ON "employees" USING btree ("facility_id","employment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_user_idx" ON "employees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "employment_contracts_employee_idx" ON "employment_contracts" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employment_contracts_facility_idx" ON "employment_contracts" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "leave_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "leave_requests_facility_status_idx" ON "leave_requests" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_facility_code_idx" ON "positions" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "positions_facility_idx" ON "positions" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_assignments_employee_date_idx" ON "shift_assignments" USING btree ("facility_id","employee_id","assigned_date");--> statement-breakpoint
CREATE INDEX "shift_assignments_facility_idx" ON "shift_assignments" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_templates_facility_code_idx" ON "shift_templates" USING btree ("facility_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_lines_run_employee_idx" ON "payroll_lines" USING btree ("run_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_facility_idx" ON "payroll_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "payroll_run_approvals_run_idx" ON "payroll_run_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payroll_run_approvals_facility_idx" ON "payroll_run_approvals" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_facility_no_idx" ON "payroll_runs" USING btree ("facility_id","run_no");--> statement-breakpoint
CREATE INDEX "payroll_runs_facility_status_idx" ON "payroll_runs" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_facility_no_idx" ON "payslips" USING btree ("facility_id","slip_no");--> statement-breakpoint
CREATE INDEX "payslips_run_idx" ON "payslips" USING btree ("run_id");--> statement-breakpoint

-- HR and payroll rows are facility-owned, synced through the existing outbox,
-- and never physically deleted. Retire people and contracts with a status;
-- correct payroll with a new run rather than editing a posted line.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture", "no_hard_delete")
VALUES
  ('employees', false, NULL, true, true),
  ('positions', false, NULL, true, true),
  ('employment_contracts', false, NULL, true, true),
  ('shift_templates', false, NULL, true, true),
  ('shift_assignments', false, NULL, true, true),
  ('attendance_records', false, NULL, true, true),
  ('leave_requests', false, NULL, true, true),
  ('payroll_runs', false, NULL, true, true),
  ('payroll_lines', true, NULL, true, true),
  ('payslips', true, NULL, true, true),
  ('payroll_run_approvals', true, NULL, true, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture,
  no_hard_delete = EXCLUDED.no_hard_delete;--> statement-breakpoint

DO $$
DECLARE
  hr_table text;
BEGIN
  FOREACH hr_table IN ARRAY ARRAY[
    'employees', 'positions', 'employment_contracts', 'shift_templates',
    'shift_assignments', 'attendance_records', 'leave_requests',
    'payroll_runs', 'payroll_lines', 'payslips', 'payroll_run_approvals'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', hr_table);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      hr_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS protected_record_no_delete_trigger ON %I', hr_table);
    EXECUTE format(
      'CREATE TRIGGER protected_record_no_delete_trigger BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protected_record_no_delete()',
      hr_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "payroll_records_append_only"() RETURNS trigger AS $$
BEGIN
  IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'payroll records are append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
DECLARE
  payroll_table text;
BEGIN
  FOREACH payroll_table IN ARRAY ARRAY[
    'payroll_lines', 'payslips', 'payroll_run_approvals'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_records_append_only_trigger ON %I', payroll_table);
    EXECUTE format(
      'CREATE TRIGGER payroll_records_append_only_trigger BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_records_append_only()',
      payroll_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

-- Facilities installed before Phase 15 already have code 5100 with no system
-- role. Map it and add the payroll accounts without overwriting local edits.
UPDATE "ledger_accounts" la
SET "system_role" = 'salaries_expense', "updated_at" = now(), "version" = la."version" + 1
WHERE la."code" = '5100'
  AND la."system_role" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ledger_accounts" other
    WHERE other."facility_id" = la."facility_id" AND other."system_role" = 'salaries_expense'
  );--> statement-breakpoint

INSERT INTO "ledger_accounts" (
  "id", "facility_id", "code", "name", "type", "normal_balance",
  "system_role", "active", "created_at", "updated_at", "created_by", "version"
)
SELECT
  uuidv7(), f.id, account."code", account."name",
  account."type"::ledger_account_type, account."normal_balance"::normal_balance,
  account."system_role", true, now(), now(), 'migration-0029', 1
FROM "facilities" f
CROSS JOIN (
  VALUES
    ('2110', 'Payroll payable', 'liability', 'credit', 'payroll_payable'),
    ('2120', 'PAYE payable', 'liability', 'credit', 'paye_payable'),
    ('2130', 'NSSF payable', 'liability', 'credit', 'nssf_payable'),
    ('2140', 'SHIF payable', 'liability', 'credit', 'shif_payable'),
    ('2150', 'Housing levy payable', 'liability', 'credit', 'housing_levy_payable'),
    ('5110', 'Employer NSSF contribution', 'expense', 'debit', 'nssf_expense')
) AS account("code", "name", "type", "normal_balance", "system_role")
WHERE NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la."facility_id" = f.id AND la."code" = account."code"
)
AND NOT EXISTS (
  SELECT 1 FROM "ledger_accounts" la
  WHERE la."facility_id" = f.id AND la."system_role" = account."system_role"
);