-- Clinical, financial, regulatory and audit history is never physically
-- removed. A branch records a status change, void, reversal or newer version;
-- the cloud applies the same event through the normal outbox. The database is
-- the final guard so a bad command or sync payload cannot bypass that rule.

ALTER TABLE "sync_tables" ADD COLUMN IF NOT EXISTS "no_hard_delete" boolean DEFAULT false NOT NULL;--> statement-breakpoint

UPDATE sync_tables
SET no_hard_delete = true
WHERE table_name IN (
  'patients', 'next_of_kin', 'encounters', 'queue_entries', 'triage_vitals',
  'clinical_notes', 'diagnoses', 'lab_orders', 'lab_order_items', 'lab_results',
  'prescriptions', 'dispenses', 'item_batches',
  'charges', 'invoices', 'payments', 'cashier_sessions', 'claims', 'claim_lines',
  'claim_denials', 'pre_authorizations', 'remittances',
  'stock_ledger', 'journal_entries', 'journal_lines', 'bank_transactions',
  'bank_reconciliations', 'etims_invoice_queue', 'etims_invoice_lines',
  'etims_outbox', 'etims_transmission_log', 'report_runs', 'report_cells',
  'audit_log', 'chart_access_log', 'data_consents', 'data_subject_requests',
  'data_breaches', 'transfer_assessments', 'data_sharing_agreements',
  'retention_policies', 'birth_notifications', 'death_notifications',
  'notifiable_events', 'facility_licences'
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION protected_record_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Test fixtures use the same maintenance escape hatch as the legacy ledger
  -- triggers so they can tear down a disposable facility.
  IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Table % cannot be hard-deleted; use a reversal, status change or new version instead of DELETE', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
  protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'patients', 'next_of_kin', 'encounters', 'queue_entries', 'triage_vitals',
    'clinical_notes', 'diagnoses', 'lab_orders', 'lab_order_items', 'lab_results',
    'prescriptions', 'dispenses', 'item_batches',
    'charges', 'invoices', 'payments', 'cashier_sessions', 'claims', 'claim_lines',
    'claim_denials', 'pre_authorizations', 'remittances',
    'stock_ledger', 'journal_entries', 'journal_lines', 'bank_transactions',
    'bank_reconciliations', 'etims_invoice_queue', 'etims_invoice_lines',
    'etims_outbox', 'etims_transmission_log', 'report_runs', 'report_cells',
    'audit_log', 'chart_access_log', 'data_consents', 'data_subject_requests',
    'data_breaches', 'transfer_assessments', 'data_sharing_agreements',
    'retention_policies', 'birth_notifications', 'death_notifications',
    'notifiable_events', 'facility_licences'
  ]::text[]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protected_record_no_delete_trigger ON %I', protected_table);
    EXECUTE format(
      'CREATE TRIGGER protected_record_no_delete_trigger BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protected_record_no_delete()',
      protected_table
    );
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION delete_sync_row(
  p_table_name text,
  p_payload jsonb,
  p_force boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_registry sync_tables%ROWTYPE;
  v_key_columns text[];
  v_key_predicate text;
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

  IF v_registry.no_hard_delete THEN
    RAISE EXCEPTION 'Table % cannot be hard-deleted; use a reversal, status change or new version instead of DELETE', p_table_name;
  END IF;

  v_key_columns := coalesce(v_registry.business_key, ARRAY['id']::text[]);

  SELECT string_agg(
           format('%I = ($1->>''%s'')::%s', a.attname, a.attname, format_type(a.atttypid, a.atttypmod)),
           ' AND ' ORDER BY k.ordinality
         )
  INTO v_key_predicate
  FROM unnest(v_key_columns) WITH ORDINALITY AS k(column_name, ordinality)
  JOIN pg_attribute a
    ON a.attrelid = format('%I.%I', 'public', p_table_name)::regclass
   AND a.attname = k.column_name
   AND a.attnum > 0
   AND NOT a.attisdropped;

  IF v_key_predicate IS NULL THEN
    RAISE EXCEPTION 'Sync key columns % do not exist on %', v_key_columns, p_table_name;
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
    EXECUTE format('SELECT version FROM %I WHERE %s', p_table_name, v_key_predicate)
      INTO v_existing_version USING p_payload;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN false; END IF;
    v_incoming_version := nullif(p_payload->>'version', '')::integer;
    IF v_incoming_version IS NULL OR v_incoming_version <= v_existing_version THEN
      RETURN false;
    END IF;
  END IF;

  EXECUTE format('DELETE FROM %I WHERE %s', p_table_name, v_key_predicate) USING p_payload;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;
