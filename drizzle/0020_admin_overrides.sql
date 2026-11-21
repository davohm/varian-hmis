CREATE TYPE "public"."admin_override_status" AS ENUM('proposed', 'applied', 'rejected', 'conflicted');--> statement-breakpoint
CREATE TABLE "admin_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"changes" jsonb NOT NULL,
	"based_on_version" integer NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" "admin_override_status" DEFAULT 'proposed' NOT NULL,
	"decision_by" text,
	"decision_reason" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_overrides" ADD CONSTRAINT "admin_overrides_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_overrides_facility_idx" ON "admin_overrides" USING btree ("facility_id","status","created_at");--> statement-breakpoint
-- Proposals travel from cloud to branch through the dedicated pull channel.
-- Branch decisions travel back through the ordinary outbox.
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture")
VALUES ('admin_overrides', false, NULL, true)
ON CONFLICT ("table_name") DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture;--> statement-breakpoint
CREATE TRIGGER "capture_change_trigger" AFTER INSERT OR UPDATE OR DELETE ON "admin_overrides"
FOR EACH ROW EXECUTE FUNCTION capture_change();