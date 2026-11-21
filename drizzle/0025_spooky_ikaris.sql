CREATE TABLE "finance_approval_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"action" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"max_amount" numeric(14, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_approval_limits" ADD CONSTRAINT "finance_approval_limits_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_approval_limits_facility_action_role_idx" ON "finance_approval_limits" USING btree ("facility_id","action","role");--> statement-breakpoint
CREATE INDEX "finance_approval_limits_facility_idx" ON "finance_approval_limits" USING btree ("facility_id");--> statement-breakpoint
-- Approval limit changes are facility-owned configuration and sync like other finance rows.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture")
VALUES ('finance_approval_limits', false, NULL, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture;--> statement-breakpoint
CREATE TRIGGER "capture_change_trigger" AFTER INSERT OR UPDATE OR DELETE ON "finance_approval_limits"
FOR EACH ROW EXECUTE FUNCTION capture_change();
