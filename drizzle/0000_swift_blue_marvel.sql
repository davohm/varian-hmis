CREATE TYPE "public"."department_kind" AS ENUM('opd', 'triage', 'reception', 'lab', 'pharmacy', 'cashier', 'admin', 'other');--> statement-breakpoint
CREATE TYPE "public"."store_kind" AS ENUM('pharmacy', 'main', 'lab');--> statement-breakpoint
CREATE TYPE "public"."write_authority" AS ENUM('cloud', 'clinic');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"user_id" text,
	"action" varchar(128) NOT NULL,
	"module" varchar(64) NOT NULL,
	"entity" varchar(64) NOT NULL,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"device_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"command" varchar(128) NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "department_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"county" text,
	"phone" varchar(50),
	"email" varchar(255),
	"write_authority" "write_authority" DEFAULT 'cloud' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Africa/Nairobi' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "facilities_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"facility_id" uuid NOT NULL,
	"scope" varchar(64) NOT NULL,
	"year" integer NOT NULL,
	"next_value" integer NOT NULL,
	CONSTRAINT "number_sequences_facility_id_scope_year_pk" PRIMARY KEY("facility_id","scope","year")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "store_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_facility_created_idx" ON "audit_log" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("facility_id","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_facility_code_idx" ON "branches" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "branches_facility_idx" ON "branches" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "command_log_facility_created_idx" ON "command_log" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_facility_branch_name_idx" ON "departments" USING btree ("facility_id","branch_id","name");--> statement-breakpoint
CREATE INDEX "departments_facility_idx" ON "departments" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_code_idx" ON "facilities" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_department_name_idx" ON "rooms" USING btree ("department_id","name");--> statement-breakpoint
CREATE INDEX "rooms_facility_idx" ON "rooms" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_facility_branch_name_idx" ON "stores" USING btree ("facility_id","branch_id","name");--> statement-breakpoint
CREATE INDEX "stores_facility_idx" ON "stores" USING btree ("facility_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION next_number(p_facility_id uuid, p_scope text)
RETURNS integer
LANGUAGE sql
AS $$
  INSERT INTO number_sequences (facility_id, scope, year, next_value)
  VALUES (p_facility_id, p_scope, EXTRACT(YEAR FROM now())::int, 2)
  ON CONFLICT (facility_id, scope, year)
  DO UPDATE SET next_value = number_sequences.next_value + 1
  RETURNING next_value - 1;
$$;