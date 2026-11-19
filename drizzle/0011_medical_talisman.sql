CREATE TYPE "public"."admin_section" AS ENUM('setup', 'staff', 'catalogs', 'prices', 'audit', 'sync');--> statement-breakpoint
CREATE TABLE "admin_section_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"facility_id" uuid NOT NULL,
	"section" "admin_section" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "admin_section_permissions" ADD CONSTRAINT "admin_section_permissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_section_permissions" ADD CONSTRAINT "admin_section_permissions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_section_permissions_user_facility_idx" ON "admin_section_permissions" USING btree ("user_id","facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_section_permissions_unique" ON "admin_section_permissions" USING btree ("user_id","facility_id","section");--> statement-breakpoint
CREATE INDEX "prices_active_idx" ON "prices" USING btree ("facility_id","active");