-- Some facility-scoped tables (e.g. facility_regulatory_profiles) are keyed by
-- facility_id rather than id. Use sync_tables.business_key as the row identity
-- everywhere in the sync engine, with 'id' as the default.

UPDATE sync_tables SET business_key = ARRAY['facility_id'] WHERE table_name = 'facility_regulatory_profiles';--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_registry sync_tables%ROWTYPE;
  v_payload jsonb;
  v_facility_id uuid;
  v_record_id text;
  v_write_authority text;
  v_key_columns text[];
BEGIN
  IF coalesce(current_setting('varian.sync_apply', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO v_registry
  FROM sync_tables
  WHERE table_name = TG_TABLE_NAME AND enabled = true AND capture = true;

  IF NOT FOUND THEN
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

  IF TG_OP = 'DELETE' AND coalesce(v_registry.append_only, false) THEN
    RETURN OLD;
  END IF;

  v_key_columns := coalesce(v_registry.business_key, ARRAY['id']::text[]);
  SELECT string_agg(v_payload->>k.column_name, ':' ORDER BY k.ordinality)
  INTO v_record_id
  FROM unnest(v_key_columns) WITH ORDINALITY AS k(column_name, ordinality);

  IF v_record_id IS NULL OR v_record_id = '' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
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
  v_key_columns text[];
  v_key_predicate text;
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

  SELECT string_agg(format('%I = EXCLUDED.%I', c.column_name, c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO v_updates
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = p_table_name
    AND c.column_name <> 'id'
    AND c.column_name <> ALL(v_key_columns);

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = p_table_name AND c.column_name = 'version'
  ) INTO v_has_version;

  -- EXECUTE does not set FOUND, so use ROW_COUNT. Equal versions are stale:
  -- only a strictly newer version may replace an existing row.
  IF v_has_version AND NOT p_force THEN
    EXECUTE format('SELECT version FROM %I WHERE %s', p_table_name, v_key_predicate)
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
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (%s) DO NOTHING',
      p_table_name, p_table_name, array_to_string(v_key_columns, ', ')
    );
  ELSIF p_table_name = 'number_sequences' THEN
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (facility_id, scope, year) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, EXCLUDED.next_value)',
      p_table_name, p_table_name
    );
  ELSIF v_has_version AND NOT p_force THEN
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (%s) DO UPDATE SET %s WHERE %I.version < EXCLUDED.version',
      p_table_name, p_table_name, array_to_string(v_key_columns, ', '), v_updates, p_table_name
    );
  ELSE
    v_sql := format(
      'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1::jsonb) ON CONFLICT (%s) DO UPDATE SET %s',
      p_table_name, p_table_name, array_to_string(v_key_columns, ', '), v_updates
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