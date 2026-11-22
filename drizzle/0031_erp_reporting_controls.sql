CREATE TABLE "report_saved_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"report_code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"owner_id" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" text[],
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_saved_views" ADD CONSTRAINT "report_saved_views_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_saved_views_facility_owner_name_idx" ON "report_saved_views" USING btree ("facility_id","owner_id","name");--> statement-breakpoint
CREATE INDEX "report_saved_views_facility_report_idx" ON "report_saved_views" USING btree ("facility_id","report_code");--> statement-breakpoint

-- Saved report views are facility configuration; they sync through the outbox and
-- are never physically deleted. Catalogue rows below seed Prompt 17 ERP reports.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture", "no_hard_delete")
VALUES ('report_saved_views', false, NULL, true, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture,
  no_hard_delete = EXCLUDED.no_hard_delete;--> statement-breakpoint

DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS capture_change_trigger ON report_saved_views';
  EXECUTE 'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON report_saved_views FOR EACH ROW EXECUTE FUNCTION capture_change()';
  EXECUTE 'DROP TRIGGER IF EXISTS protected_record_no_delete_trigger ON report_saved_views';
  EXECUTE 'CREATE TRIGGER protected_record_no_delete_trigger BEFORE DELETE ON report_saved_views FOR EACH ROW EXECUTE FUNCTION protected_record_no_delete()';
END;
$$;--> statement-breakpoint

INSERT INTO "report_catalogue" (
  "id", "report_code", "name", "domain", "schedule", "period_type",
  "source_entities", "output_formats", "authority", "enabled", "template_version", "created_at", "updated_at"
)
VALUES
  (uuidv7(), 'ERP_FINANCIAL_STATEMENTS', 'Financial statements', 'erp', 'monthly', 'month', ARRAY['journal_entries','journal_lines','ledger_accounts'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_TRIAL_BALANCE', 'Trial balance', 'erp', 'monthly', 'month', ARRAY['journal_entries','journal_lines','ledger_accounts'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_SUPPLIER_AGEING', 'Supplier ageing', 'erp', 'monthly', 'month', ARRAY['suppliers','supplier_invoices','supplier_payments'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_CLAIM_AGEING', 'Payer and claim ageing', 'erp', 'monthly', 'month', ARRAY['payers','claims','remittances'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_STOCK_VALUATION', 'Stock valuation', 'erp', 'monthly', 'month', ARRAY['stock_ledger','item_batches','items'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_BUDGET_VARIANCE', 'Budget variance', 'erp', 'monthly', 'month', ARRAY['budgets','budget_lines','journal_lines'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_PAYROLL_SUMMARY', 'Payroll summary', 'erp', 'monthly', 'month', ARRAY['payroll_runs','payroll_lines','payslips'], ARRAY['screen','print','csv','xlsx','pdf'], 'Varian ERP', true, '2026.11', now(), now()),
  (uuidv7(), 'ERP_APPROVAL_INBOX', 'Approval inbox', 'erp', 'daily', 'day', ARRAY['budgets','purchase_requisitions','purchase_orders','payroll_runs','depreciation_runs','asset_valuations','asset_disposals'], ARRAY['screen','print','csv'], 'Varian ERP', true, '2026.11', now(), now())
ON CONFLICT ("report_code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "domain" = EXCLUDED."domain",
  "schedule" = EXCLUDED."schedule",
  "period_type" = EXCLUDED."period_type",
  "source_entities" = EXCLUDED."source_entities",
  "output_formats" = EXCLUDED."output_formats",
  "authority" = EXCLUDED."authority",
  "enabled" = EXCLUDED."enabled",
  "template_version" = EXCLUDED."template_version",
  "updated_at" = now();
