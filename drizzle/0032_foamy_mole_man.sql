ALTER TYPE "public"."staff_role" ADD VALUE 'super_admin';--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "physical_location" text;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "telephone" varchar(50);--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "manager_name" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "registration_details" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "physical_address" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "currency" varchar(3) DEFAULT 'KES' NOT NULL;