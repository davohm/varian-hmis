-- Neon's pooled endpoint rejects custom GUCs in the startup packet. The node
-- role is now advertised through `application_name`, which PgBouncer tracks.
-- Keep the older custom setting as a fallback so existing unpooled/local
-- connections and test helpers continue to behave identically.

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
  -- role comes from the connection, not from facility data, so clinic
  -- databases keep capturing normally even when a test facility is flagged
  -- cloud. `varian.node_role` remains as a fallback for unpooled connections;
  -- `application_name = varian-cloud` is the Neon-pool-compatible signal.
  IF coalesce(current_setting('varian.node_role', true), '') = 'cloud'
     OR coalesce(current_setting('application_name', true), '') = 'varian-cloud' THEN
    IF v_write_authority = 'cloud' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
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
$$;
