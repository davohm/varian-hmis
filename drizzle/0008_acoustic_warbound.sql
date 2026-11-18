CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_ms bigint;
  v_rand_a text;
  v_variant text;
  v_rand_b text;
BEGIN
  v_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_rand_a := lpad(to_hex((random() * 4095)::int), 3, '0');
  v_variant := to_hex((8 + floor(random() * 4)::int)::int);
  v_rand_b := lpad(to_hex((random() * 1152921504606846975::numeric)::bigint), 15, '0');
  RETURN (lpad(to_hex(v_ms), 12, '0') || '7' || v_rand_a || v_variant || v_rand_b)::uuid;
END;
$$;--> statement-breakpoint
CREATE TYPE "public"."sync_outbox_status" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TABLE "facility_sync_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"facility_id" uuid NOT NULL,
	"device_key" varchar(128) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_outbox" (
	"outbox_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"facility_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"operation" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "sync_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_received" (
	"outbox_id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facility_sync_tokens" ADD CONSTRAINT "facility_sync_tokens_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_received" ADD CONSTRAINT "sync_received_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facility_sync_tokens_facility_device_idx" ON "facility_sync_tokens" USING btree ("facility_id","device_key");--> statement-breakpoint
CREATE INDEX "sync_outbox_pending_idx" ON "sync_outbox" USING btree ("status","next_attempt_at","created_at","outbox_id");--> statement-breakpoint
CREATE INDEX "sync_outbox_facility_idx" ON "sync_outbox" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_outbox_record_idx" ON "sync_outbox" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "sync_received_facility_idx" ON "sync_received" USING btree ("facility_id","received_at");--> statement-breakpoint
CREATE TABLE "sync_tables" (
	"table_name" text PRIMARY KEY NOT NULL,
	"append_only" boolean DEFAULT false NOT NULL,
	"business_key" text[],
	"capture" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
INSERT INTO "sync_tables" ("table_name", "append_only", "business_key", "capture") VALUES
  ('facilities', false, NULL, true),
  ('branches', false, NULL, true),
  ('departments', false, NULL, true),
  ('rooms', false, NULL, true),
  ('stores', false, NULL, true),
  ('patients', false, NULL, true),
  ('next_of_kin', false, NULL, true),
  ('encounters', false, NULL, true),
  ('queue_entries', false, NULL, true),
  ('triage_vitals', false, NULL, true),
  ('clinical_notes', false, NULL, true),
  ('diagnoses', false, NULL, true),
  ('lab_tests', false, NULL, true),
  ('lab_orders', false, NULL, true),
  ('lab_order_items', false, NULL, true),
  ('lab_results', false, NULL, true),
  ('items', false, NULL, true),
  ('item_batches', false, NULL, true),
  ('stock_ledger', true, NULL, true),
  ('prescriptions', false, NULL, true),
  ('dispenses', true, NULL, true),
  ('services', false, NULL, true),
  ('price_lists', false, NULL, true),
  ('prices', false, NULL, true),
  ('charges', false, NULL, true),
  ('invoices', false, NULL, true),
  ('payments', true, NULL, true),
  ('cashier_sessions', false, NULL, true),
  ('audit_log', true, NULL, true),
  ('number_sequences', false, ARRAY['facility_id', 'scope', 'year'], true),
  ('user', false, NULL, false),
  ('account', false, NULL, false),
  ('staff_profiles', false, NULL, false),
  ('staff_role_scopes', false, NULL, false);--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_payload jsonb;
  v_facility_id uuid;
  v_record_id text;
BEGIN
  IF coalesce(current_setting('varian.sync_apply', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM sync_tables
    WHERE table_name = TG_TABLE_NAME AND enabled = true AND capture = true
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_payload := to_jsonb(OLD);
  ELSE
    v_payload := to_jsonb(NEW);
  END IF;

  IF TG_TABLE_NAME = 'facilities' THEN
    v_facility_id := (v_payload->>'id')::uuid;
  ELSE
    v_facility_id := (v_payload->>'facility_id')::uuid;
  END IF;

  IF v_facility_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'number_sequences' THEN
    v_record_id := concat_ws(':', v_payload->>'facility_id', v_payload->>'scope', v_payload->>'year');
  ELSE
    v_record_id := v_payload->>'id';
  END IF;

  INSERT INTO sync_outbox (
    outbox_id, facility_id, table_name, record_id, operation,
    payload, status, attempts, next_attempt_at, created_at
  )
  VALUES (
    uuidv7(), v_facility_id, TG_TABLE_NAME, v_record_id, TG_OP,
    v_payload, 'pending', 0, now(), now()
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION apply_sync_row(
  p_table_name text,
  p_payload jsonb,
  p_force boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_registry sync_tables%ROWTYPE;
  v_updates text;
  v_sql text;
  v_has_version boolean;
BEGIN
  SELECT * INTO v_registry
  FROM sync_tables
  WHERE table_name = p_table_name AND enabled = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table % is not registered for sync', p_table_name;
  END IF;

  SELECT string_agg(format('%I = EXCLUDED.%I', c.column_name, c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO v_updates
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = p_table_name
    AND c.column_name <> 'id'
    AND c.column_name <> ALL(coalesce(v_registry.business_key, ARRAY[]::text[]));

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = p_table_name AND c.column_name = 'version'
  ) INTO v_has_version;

  IF v_registry.append_only THEN
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (id) DO NOTHING',
      p_table_name, p_table_name
    );
  ELSIF p_table_name = 'number_sequences' THEN
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (facility_id, scope, year) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, EXCLUDED.next_value)',
      p_table_name, p_table_name
    );
  ELSIF v_has_version AND NOT p_force THEN
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (id) DO UPDATE SET %s WHERE %I.version <= EXCLUDED.version',
      p_table_name, p_table_name, v_updates, p_table_name
    );
  ELSE
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (id) DO UPDATE SET %s',
      p_table_name, p_table_name, v_updates
    );
  END IF;

  EXECUTE v_sql USING p_payload;
  RETURN true;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_sync_row(
  p_table_name text,
  p_payload jsonb,
  p_force boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_registry sync_tables%ROWTYPE;
  v_has_version boolean;
  v_existing_version integer;
  v_incoming_version integer;
BEGIN
  SELECT * INTO v_registry
  FROM sync_tables
  WHERE table_name = p_table_name AND enabled = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table % is not registered for sync', p_table_name;
  END IF;

  IF v_registry.append_only THEN
    RAISE EXCEPTION 'Table % is append-only and cannot receive deletes', p_table_name;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = p_table_name AND c.column_name = 'version'
  ) INTO v_has_version;

  IF p_table_name = 'number_sequences' THEN
    EXECUTE format(
      'DELETE FROM %I WHERE facility_id = ($1->>''facility_id'')::uuid AND scope = ($1->>''scope'') AND year = ($1->>''year'')::int AND next_value <= ($1->>''next_value'')::int',
      p_table_name
    ) USING p_payload;
    RETURN true;
  END IF;

  IF v_has_version AND NOT p_force THEN
    EXECUTE format('SELECT version FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name)
      INTO v_existing_version USING p_payload;
    IF NOT FOUND THEN RETURN false; END IF;
    v_incoming_version := (p_payload->>'version')::int;
    IF v_incoming_version IS NULL OR v_incoming_version < v_existing_version THEN
      RETURN false;
    END IF;
  END IF;

  EXECUTE format('DELETE FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name) USING p_payload;
  RETURN true;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT table_name FROM sync_tables WHERE capture = true AND enabled = true LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change_trigger ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER capture_change_trigger AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_change()',
      t
    );
  END LOOP;
END;
$$;
