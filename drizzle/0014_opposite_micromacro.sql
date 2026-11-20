CREATE TYPE "public"."budget_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."admin_section" ADD VALUE 'regulatory';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'regulatory_officer' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"cost_center_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"branch_id" uuid,
	"cost_center_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"status" "budget_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(8) DEFAULT 'KES' NOT NULL,
	"enforce" boolean DEFAULT true NOT NULL,
	"note" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"rejected_reason" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_budget_account_idx" ON "budget_lines" USING btree ("budget_id","account_id","cost_center_id");--> statement-breakpoint
CREATE INDEX "budget_lines_facility_idx" ON "budget_lines" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_facility_code_idx" ON "budgets" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "budgets_facility_period_idx" ON "budgets" USING btree ("facility_id","period_id");--> statement-breakpoint
CREATE INDEX "budgets_facility_status_idx" ON "budgets" USING btree ("facility_id","status");