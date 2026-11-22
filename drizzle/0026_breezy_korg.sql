ALTER TABLE "claims" ADD COLUMN "submitted_by" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "approved_by" text;