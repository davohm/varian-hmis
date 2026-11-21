-- Sync hardening for multi-branch production rollout.
-- 1. suppress cloud outbox pollution from direct cloud-mode writes
-- 2. strict, row-count-checked version guards in the SQL apply functions
-- 3. register every facility-scoped ERP/regulatory/reporting/tax table

CREATE OR REPLACE FUNCTION capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_payload jsonb;
  v_facility_id uuid;
  v_record_id text;
  v_write_authority text;
  v_append_only boolean;
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
    v_write_authority := v_payload->>'write_authority';
  ELSE
    v_facility_id := (v_payload->>'facility_id')::uuid;
    SELECT write_authority::text INTO v_write_authority
    FROM facilities WHERE id = v_facility_id;
  END IF;

  IF v_facility_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- The cloud hub never drains its own outbox. Direct writes to a
  -- cloud-authority facility must therefore not be captured at all. The node
  -- role comes from the connection (varian.node_role), not from facility data,
  -- so clinic databases keep capturing normally.
  IF coalesce(current_setting('varian.node_role', true), '') = 'cloud'
     AND v_write_authority = 'cloud' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT append_only INTO v_append_only
  FROM sync_tables WHERE table_name = TG_TABLE_NAME;
  IF TG_OP = 'DELETE' AND coalesce(v_append_only, false) THEN
    RETURN OLD;
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
  v_existing_version integer;
  v_incoming_version integer;
  v_rows bigint;
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

  -- EXECUTE does not set FOUND, so use ROW_COUNT. Equal versions are stale:
  -- only a strictly newer version may replace an existing row.
  IF v_has_version AND NOT p_force THEN
    EXECUTE format('SELECT version FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name)
      INTO v_existing_version USING p_payload;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      v_incoming_version := nullif(p_payload->>'version', '')::integer;
      IF v_incoming_version IS NULL OR v_incoming_version <= v_existing_version THEN
        RETURN false;
      END IF;
    END IF;
  END IF;

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
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (id) DO UPDATE SET %s WHERE %I.version < EXCLUDED.version',
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
  v_rows bigint;
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
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
  END IF;

  IF v_has_version AND NOT p_force THEN
    EXECUTE format('SELECT version FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name)
      INTO v_existing_version USING p_payload;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN false; END IF;
    v_incoming_version := nullif(p_payload->>'version', '')::integer;
    IF v_incoming_version IS NULL OR v_incoming_version <= v_existing_version THEN
      RETURN false;
    END IF;
  END IF;

  EXECUTE format('DELETE FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name) USING p_payload;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;--> statement-breakpoint

INSERT INTO sync_tables (table_name, append_only, business_key, capture) VALUES
  ('facilities', false, NULL, true),
  ('branches', false, NULL, true),
  ('departments', false, NULL, true),
  ('rooms', false, NULL, true),
  ('stores', false, NULL, true),
  ('devices', false, NULL, true),
  ('facility_settings', false, NULL, true),
  ('facility_identifiers', false, NULL, true),
  ('facility_licences', false, NULL, true),
  ('facility_regulatory_profiles', false, NULL, true),
  ('support_service_licences', false, NULL, true),
  ('licence_alert_rules', false, NULL, true),
  ('statutory_rates', false, NULL, true),
  ('statutory_fee_schedules', false, NULL, true),
  ('sha_adjudication_codes', false, NULL, true),
  ('integration_settings', false, NULL, true),
  ('admin_section_permissions', false, NULL, true),
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
  ('payers', false, NULL, true),
  ('payer_contracts', false, NULL, true),
  ('payer_benefits', false, NULL, true),
  ('claims', false, NULL, true),
  ('claim_lines', false, NULL, true),
  ('claim_denials', false, NULL, true),
  ('pre_authorizations', false, NULL, true),
  ('remittances', true, NULL, true),
  ('etims_invoice_queue', false, NULL, true),
  ('etims_invoice_lines', true, NULL, true),
  ('etims_outbox', false, NULL, true),
  ('etims_transmission_log', true, NULL, true),
  ('tax_codes', false, NULL, true),
  ('tax_code_applicabilities', false, NULL, true),
  ('ledger_accounts', false, NULL, true),
  ('cost_centers', false, NULL, true),
  ('fiscal_periods', false, NULL, true),
  ('journal_entries', true, NULL, true),
  ('journal_lines', true, NULL, true),
  ('bank_accounts', false, NULL, true),
  ('bank_transactions', true, NULL, true),
  ('bank_reconciliations', false, NULL, true),
  ('budgets', false, NULL, true),
  ('budget_lines', false, NULL, true),
  ('report_definitions', false, NULL, true),
  ('report_runs', false, NULL, true),
  ('report_cells', false, NULL, true),
  ('birth_notifications', false, NULL, true),
  ('death_notifications', false, NULL, true),
  ('notifiable_events', false, NULL, true),
  ('audit_log', true, NULL, true),
  ('number_sequences', false, ARRAY['facility_id', 'scope', 'year'], true),
  ('data_consents', false, NULL, true),
  ('data_subject_requests', false, NULL, true),
  ('data_breaches', false, NULL, true),
  ('retention_policies', false, NULL, true),
  ('data_sharing_agreements', false, NULL, true),
  ('transfer_assessments', false, NULL, true),
  ('chart_access_log', true, NULL, true),
  ('practitioner_registrations', false, NULL, true),
  ('user', false, NULL, false),
  ('account', false, NULL, false),
  ('staff_profiles', false, NULL, false),
  ('staff_role_scopes', false, NULL, false),
  ('report_catalogue', false, NULL, false),
  ('icd10_codes', false, NULL, false)
ON CONFLICT (table_name) DO UPDATE SET
  append_only = EXCLUDED.append_only,
  business_key = EXCLUDED.business_key,
  capture = EXCLUDED.capture;--> statement-breakpoint

-- stock_balances is a view over stock_ledger; it cannot have row triggers.
DELETE FROM sync_tables WHERE table_name = 'stock_balances';--> statement-breakpoint

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
