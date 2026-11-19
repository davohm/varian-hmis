CREATE TYPE "public"."adjudication_category" AS ENUM('approved', 'reduced', 'rejected', 'info');--> statement-breakpoint
CREATE TYPE "public"."facility_ownership" AS ENUM('public', 'faith_based', 'private', 'ngo');--> statement-breakpoint
CREATE TYPE "public"."integration_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."integration_name" AS ENUM('etims', 'khis', 'sha_portal', 'sms', 'payments');--> statement-breakpoint
CREATE TYPE "public"."licence_status" AS ENUM('active', 'expiring', 'expired', 'suspended', 'pending');--> statement-breakpoint
CREATE TYPE "public"."regulator_code" AS ENUM('kmpdc', 'ppb', 'kmlttb', 'nck', 'rpb', 'other');--> statement-breakpoint
CREATE TYPE "public"."setting_data_type" AS ENUM('text', 'integer', 'decimal', 'boolean', 'date', 'enum', 'json');--> statement-breakpoint
CREATE TYPE "public"."setting_domain" AS ENUM('regulatory', 'privacy', 'reporting', 'tax', 'sha', 'payroll', 'quality');--> statement-breakpoint
CREATE TYPE "public"."support_service_type" AS ENUM('pharmacy', 'laboratory', 'imaging', 'ambulance', 'mortuary', 'theatre');--> statement-breakpoint
CREATE TABLE "facility_identifiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"identifier_type" text NOT NULL,
	"value" text NOT NULL,
	"issuing_authority" text,
	"valid_from" date,
	"valid_to" date,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_licences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"licence_type" text NOT NULL,
	"licence_no" varchar(64) NOT NULL,
	"issue_date" date,
	"expiry_date" date NOT NULL,
	"status" "licence_status" DEFAULT 'pending' NOT NULL,
	"supersedes_id" uuid,
	"document_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_regulatory_profiles" (
	"facility_id" uuid PRIMARY KEY NOT NULL,
	"kmpdc_number" varchar(64),
	"kmhfl_id" varchar(64),
	"keph_level" smallint,
	"facility_category" text,
	"ownership" "facility_ownership",
	"county" text,
	"sub_county" text,
	"constituency" text,
	"ward" text,
	"licence_no" varchar(64),
	"licence_issue_date" date,
	"licence_expiry_date" date,
	"licence_status" "licence_status" DEFAULT 'pending' NOT NULL,
	"indemnity_provider" text,
	"indemnity_no" varchar(64),
	"indemnity_expiry_date" date,
	"sha_facility_code" varchar(64),
	"sha_empanelment_status" text,
	"odpc_registration_no" varchar(64),
	"odpc_category" text,
	"odpc_expiry_date" date,
	"kra_pin" varchar(11),
	"tcc_no" varchar(64),
	"tcc_expiry_date" date,
	"nssf_employer_code" varchar(64),
	"shif_employer_code" varchar(64),
	"kemsa_supplier_code" varchar(64),
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "facility_regulatory_profiles_kmpdc_number_unique" UNIQUE("kmpdc_number")
);
--> statement-breakpoint
CREATE TABLE "facility_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"domain" "setting_domain" NOT NULL,
	"key" text NOT NULL,
	"value_text" text,
	"value_numeric" numeric(14, 4),
	"value_json" jsonb,
	"data_type" "setting_data_type" NOT NULL,
	"allowed_values" text[],
	"min_value" numeric(14, 4),
	"max_value" numeric(14, 4),
	"regex" text,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"integration" "integration_name" NOT NULL,
	"environment" "integration_environment" NOT NULL,
	"base_url" text,
	"spec_version" text,
	"mode" text,
	"credential_ref" text,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"backoff_seconds" integer[] DEFAULT '{30,120,600,1800,3600}'::integer[] NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licence_alert_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"warn_days" integer[] NOT NULL,
	"block_days" integer[] NOT NULL,
	"notify_roles" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practitioner_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"regulator" "regulator_code" NOT NULL,
	"profession" text NOT NULL,
	"registration_no" varchar(64) NOT NULL,
	"annual_licence_no" varchar(64),
	"licence_issue_date" date,
	"licence_expiry_date" date,
	"licence_status" "licence_status" DEFAULT 'pending' NOT NULL,
	"cpd_points" numeric(6, 1),
	"cpd_cycle" varchar(32),
	"cpd_status" text,
	"specialist_recognition" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sha_adjudication_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"description" text NOT NULL,
	"category" "adjudication_category" NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"action_hint" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statutory_fee_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'KES' NOT NULL,
	"renewal_month" integer,
	"renewal_day" integer,
	"penalty_note" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statutory_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"rate_type" text NOT NULL,
	"band_order" integer NOT NULL,
	"lower_bound" numeric(14, 2) NOT NULL,
	"upper_bound" numeric(14, 2),
	"rate_percent" numeric(6, 3) NOT NULL,
	"fixed_amount" numeric(12, 2),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"legal_reference" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_service_licences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"service_type" "support_service_type" NOT NULL,
	"licence_no" varchar(64) NOT NULL,
	"issuing_authority" text NOT NULL,
	"issue_date" date,
	"expiry_date" date NOT NULL,
	"status" "licence_status" DEFAULT 'pending' NOT NULL,
	"conditions" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facility_identifiers" ADD CONSTRAINT "facility_identifiers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_licences" ADD CONSTRAINT "facility_licences_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_licences" ADD CONSTRAINT "facility_licences_supersedes_id_facility_licences_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."facility_licences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_regulatory_profiles" ADD CONSTRAINT "facility_regulatory_profiles_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_settings" ADD CONSTRAINT "facility_settings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_alert_rules" ADD CONSTRAINT "licence_alert_rules_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_registrations" ADD CONSTRAINT "practitioner_registrations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_registrations" ADD CONSTRAINT "practitioner_registrations_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sha_adjudication_codes" ADD CONSTRAINT "sha_adjudication_codes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_fee_schedules" ADD CONSTRAINT "statutory_fee_schedules_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_service_licences" ADD CONSTRAINT "support_service_licences_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facility_identifiers_unique_idx" ON "facility_identifiers" USING btree ("facility_id","identifier_type","value");--> statement-breakpoint
CREATE INDEX "facility_licences_facility_idx" ON "facility_licences" USING btree ("facility_id","licence_type");--> statement-breakpoint
CREATE INDEX "facility_licences_expiry_idx" ON "facility_licences" USING btree ("facility_id","expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_licences_unique_idx" ON "facility_licences" USING btree ("facility_id","licence_type","licence_no");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_settings_unique_idx" ON "facility_settings" USING btree ("facility_id","domain","key","effective_from");--> statement-breakpoint
CREATE INDEX "facility_settings_domain_idx" ON "facility_settings" USING btree ("facility_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_settings_unique_idx" ON "integration_settings" USING btree ("facility_id","integration","environment");--> statement-breakpoint
CREATE INDEX "licence_alert_rules_facility_idx" ON "licence_alert_rules" USING btree ("facility_id","subject_type");--> statement-breakpoint
CREATE UNIQUE INDEX "practitioner_registrations_unique_idx" ON "practitioner_registrations" USING btree ("facility_id","staff_profile_id","regulator");--> statement-breakpoint
CREATE INDEX "practitioner_registrations_expiry_idx" ON "practitioner_registrations" USING btree ("facility_id","licence_expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sha_adjudication_codes_unique_idx" ON "sha_adjudication_codes" USING btree ("facility_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_fee_schedules_unique_idx" ON "statutory_fee_schedules" USING btree ("facility_id","authority","category","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_rates_unique_idx" ON "statutory_rates" USING btree ("facility_id","rate_type","band_order","effective_from");--> statement-breakpoint
CREATE INDEX "support_service_licences_facility_idx" ON "support_service_licences" USING btree ("facility_id","service_type");--> statement-breakpoint
CREATE INDEX "support_service_licences_expiry_idx" ON "support_service_licences" USING btree ("facility_id","expiry_date");