-- Preserve the long-standing append-only error for ledger tables. Trigger
-- order is alphabetical by trigger name, so the generic protected-record
-- guard can fire before a table-specific ledger trigger; the registry check
-- makes the message deterministic.
CREATE OR REPLACE FUNCTION protected_record_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_append_only boolean;
BEGIN
  IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT append_only INTO v_append_only
  FROM sync_tables
  WHERE table_name = TG_TABLE_NAME;

  IF coalesce(v_append_only, false) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;

  RAISE EXCEPTION 'Table % cannot be hard-deleted; use a reversal, status change or new version instead of DELETE', TG_TABLE_NAME;
END;
$$;
