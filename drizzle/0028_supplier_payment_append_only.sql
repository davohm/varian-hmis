-- Supplier payments are part of the payment ledger: a correction is a new
-- payment or reversal, never an edit to a posted row. Billing payments already
-- have this database guard; supplier payments need the same one.
CREATE OR REPLACE FUNCTION "supplier_payments_append_only"() RETURNS trigger AS $$
BEGIN
	-- Test fixtures use the same maintenance escape hatch as the other ledger
	-- triggers so they can tear down a disposable facility.
	IF current_setting('varian.ledger_cleanup', true) = 'on' THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'supplier_payments is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "supplier_payments_append_only_trigger" ON "supplier_payments";--> statement-breakpoint
CREATE TRIGGER "supplier_payments_append_only_trigger" BEFORE UPDATE OR DELETE ON "supplier_payments" FOR EACH ROW EXECUTE FUNCTION "supplier_payments_append_only"();
