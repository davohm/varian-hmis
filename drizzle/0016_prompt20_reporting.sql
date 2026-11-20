CREATE TABLE "birth_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid,
	"encounter_id" uuid,
	"child_mrn" text,
	"sex" text,
	"birth_weight_kg" numeric(5, 2),
	"birth_date" date,
	"notification_no" text,
	"notified_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "death_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid,
	"encounter_id" uuid,
	"date_of_death" date,
	"cause_code" text,
	"cause_text" text,
	"place_of_death" text,
	"notification_no" text,
	"notified_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifiable_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid,
	"encounter_id" uuid,
	"disease_code" text,
	"disease_name" text NOT NULL,
	"classification" text,
	"onset_date" date,
	"detected_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"reported_to" text,
	"method" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_catalogue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"schedule" text NOT NULL,
	"period_type" text NOT NULL,
	"source_entities" text[],
	"output_formats" text[],
	"authority" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"template_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_cells" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"report_run_id" uuid NOT NULL,
	"section" text,
	"row_code" text,
	"row_label" text,
	"col_key" text,
	"col_label" text,
	"value_numeric" numeric(14, 2),
	"value_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_total" boolean DEFAULT false NOT NULL,
	"source_query" text
);
--> statement-breakpoint
CREATE TABLE "report_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section" text,
	"row_code" text,
	"row_label" text,
	"col_key" text,
	"col_label" text,
	"aggregation" text,
	"filter" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_total" boolean DEFAULT false NOT NULL,
	"formula" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"branch_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"epi_week" integer,
	"epi_year" integer,
	"month" integer,
	"year" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"checksum" text,
	"generated_by" text,
	"generated_at" timestamp with time zone,
	"exported_file" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"acknowledgement_ref" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "birth_notifications" ADD CONSTRAINT "birth_notifications_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birth_notifications" ADD CONSTRAINT "birth_notifications_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birth_notifications" ADD CONSTRAINT "birth_notifications_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_notifications" ADD CONSTRAINT "death_notifications_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_notifications" ADD CONSTRAINT "death_notifications_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_notifications" ADD CONSTRAINT "death_notifications_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifiable_events" ADD CONSTRAINT "notifiable_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifiable_events" ADD CONSTRAINT "notifiable_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifiable_events" ADD CONSTRAINT "notifiable_events_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cells" ADD CONSTRAINT "report_cells_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cells" ADD CONSTRAINT "report_cells_report_run_id_report_runs_id_fk" FOREIGN KEY ("report_run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_report_id_report_catalogue_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report_catalogue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_id_report_catalogue_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report_catalogue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "birth_notifications_facility_birth_date_idx" ON "birth_notifications" USING btree ("facility_id","birth_date");--> statement-breakpoint
CREATE INDEX "birth_notifications_facility_notification_idx" ON "birth_notifications" USING btree ("facility_id","notification_no");--> statement-breakpoint
CREATE INDEX "death_notifications_facility_date_idx" ON "death_notifications" USING btree ("facility_id","date_of_death");--> statement-breakpoint
CREATE INDEX "death_notifications_facility_notification_idx" ON "death_notifications" USING btree ("facility_id","notification_no");--> statement-breakpoint
CREATE INDEX "notifiable_events_facility_detected_idx" ON "notifiable_events" USING btree ("facility_id","detected_at");--> statement-breakpoint
CREATE INDEX "notifiable_events_facility_status_idx" ON "notifiable_events" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "report_catalogue_report_code_idx" ON "report_catalogue" USING btree ("report_code");--> statement-breakpoint
CREATE INDEX "report_cells_run_idx" ON "report_cells" USING btree ("report_run_id");--> statement-breakpoint
CREATE INDEX "report_cells_facility_run_idx" ON "report_cells" USING btree ("facility_id","report_run_id");--> statement-breakpoint
CREATE INDEX "report_cells_run_row_col_idx" ON "report_cells" USING btree ("report_run_id","row_code","col_key");--> statement-breakpoint
CREATE INDEX "report_definitions_facility_report_idx" ON "report_definitions" USING btree ("facility_id","report_id");--> statement-breakpoint
CREATE INDEX "report_runs_facility_report_period_idx" ON "report_runs" USING btree ("facility_id","report_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "report_runs_facility_branch_idx" ON "report_runs" USING btree ("facility_id","branch_id");--> statement-breakpoint
CREATE INDEX "report_runs_facility_status_idx" ON "report_runs" USING btree ("facility_id","status");