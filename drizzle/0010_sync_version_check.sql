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

  -- A stale version must be a no-op before we try to INSERT the incoming row.
  -- Otherwise a compact DELETE/UPDATE payload would fail NOT NULL constraints
  -- on columns that were not sent.
  IF v_has_version AND NOT p_force THEN
    EXECUTE format('SELECT version FROM %I WHERE id = ($1->>''id'')::uuid', p_table_name)
      INTO v_existing_version
      USING p_payload;
    IF FOUND THEN
      v_incoming_version := nullif(p_payload->>'version', '')::integer;
      IF v_incoming_version IS NULL OR v_incoming_version < v_existing_version THEN
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
$$;
