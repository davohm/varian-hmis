# 03 — Database Schema (PostgreSQL 17, Drizzle)

## Conventions
- `id uuid primary key` generated in app with `uuidv7()`.
- Every operational table: `facility_id uuid not null`, `created_at`, `updated_at`, `created_by text`, `version int default 1`.
- Money `numeric(12,2)`; timestamps `timestamptz`.
- No hard deletes on clinical/financial rows: use `status` / `voided_at` + reversal rows.
- Indexes on `(facility_id, <lookup>)`; `pg_trgm` GIN on patient names.

## Tables

### Tenancy & admin
- `facilities(id, code unique, name, county, phone, email, write_authority 'cloud'|'clinic', timezone)`
- `branches(id, facility_id, code, name, is_main)`
- `departments(id, facility_id, branch_id, name, kind)` — opd, triage, lab, pharmacy, cashier…
- `rooms(id, facility_id, department_id, name)`
- `stores(id, facility_id, branch_id, name, kind 'pharmacy'|'main'|'lab')`
- `number_sequences(facility_id, scope, year, next_value, primary key(facility_id, scope, year))`
- `audit_log(id, facility_id, user_id, action, module, entity, entity_id, details jsonb, device_id, ip, created_at)`
- `command_log(idempotency_key uuid primary key, facility_id, command, result jsonb, created_at)`

### Auth (Better Auth generates `user`, `session`, `account`, `verification`)
- `staff_profiles(id, user_id unique, staff_number, phone, is_active)`
- `staff_role_scopes(id, user_id, role, facility_id, branch_id null)` — unique(user_id, role, facility_id, branch_id)
- `devices(id, facility_id, name, last_seen_at, revoked_at)`

### Patients & queue
- `patients(id, facility_id, mrn, first_name, last_name, other_names, dob, dob_estimated, sex, national_id, phone, email, address, payer_type, payer_member_no, allergies text[], blood_group, unique(facility_id, mrn))`
- `next_of_kin(id, facility_id, patient_id, name, relationship, phone)`
- `encounters(id, facility_id, branch_id, patient_id, encounter_no, status 'open'|'discharged'|'referred'|'cancelled', payer_type, started_at, ended_at, outcome)`
- `queue_entries(id, facility_id, encounter_id, patient_id, department, room_id, priority 'red'|'yellow'|'green'|'normal', status 'waiting'|'called'|'in_service'|'done'|'cancelled', queued_at, called_at, done_at)`

### Clinical
- `triage_vitals(id, facility_id, encounter_id, systolic, diastolic, heart_rate, resp_rate, temperature numeric(4,1), spo2, weight_kg, height_cm, bmi, pain_score, muac_cm, category, chief_complaint, comments, next_steps, recorded_by)`
- `clinical_notes(id, facility_id, encounter_id, subjective, objective, assessment, plan, author_id, signed_at)`
- `diagnoses(id, facility_id, encounter_id, icd10_code, description, is_primary)`
- `lab_tests(id, facility_id null=global, code, name, sample_type, parameters jsonb)` — parameter: name, unit, ref_low, ref_high, critical_low, critical_high
- `lab_orders(id, facility_id, encounter_id, status 'ordered'|'collected'|'in_progress'|'resulted'|'verified'|'cancelled', clinical_notes, ordered_by, sample_id, collected_at)`
- `lab_order_items(id, facility_id, lab_order_id, lab_test_id, status)`
- `lab_results(id, facility_id, lab_order_item_id, parameter, value, unit, ref_range, flag 'N'|'H'|'L'|'HH'|'LL', entered_by, verified_by, verified_at)`

### Pharmacy & stock
- `items(id, facility_id null=global, code, name, kind 'drug'|'consumable'|'reagent', unit, strength, form)`
- `item_batches(id, facility_id, item_id, batch_no, expiry_date, unit_cost)`
- `stock_ledger(id, facility_id, store_id, item_id, batch_id, qty_delta int, reason 'receive'|'dispense'|'adjust'|'transfer_in'|'transfer_out'|'reversal', ref_type, ref_id, created_by, created_at)` — append-only; balances via view `stock_balances`.
- `prescriptions(id, facility_id, encounter_id, item_id, dose, route, frequency, duration_days, quantity, instructions, status 'prescribed'|'partial'|'dispensed'|'cancelled', prescribed_by)`
- `dispenses(id, facility_id, prescription_id, batch_id, store_id, quantity, dispensed_by, note)`

### Billing
- `services(id, facility_id null, code, name, kind 'consultation'|'lab'|'procedure'|'drug')`
- `price_lists(id, facility_id, name, payer_type)`; `prices(id, price_list_id, service_id null, item_id null, amount)`
- `charges(id, facility_id, encounter_id, source_type, source_id, description, quantity, unit_price, amount, voided_at)`
- `invoices(id, facility_id, encounter_id, invoice_no, total, paid, status 'open'|'partial'|'paid'|'void')`
- `payments(id, facility_id, invoice_id, cashier_session_id, receipt_no, amount, method 'cash'|'mpesa'|'card'|'insurance', reference, received_by, reversed_payment_id null)` — append-only
- `cashier_sessions(id, facility_id, user_id, opened_at, closed_at, opening_float, counted_cash, expected_cash)`

### Sync (clinic mode)
- `sync_outbox(outbox_id uuid, facility_id, table_name, record_id, operation, payload jsonb, status 'pending'|'synced'|'failed', attempts, last_error, created_at, synced_at)`
- `sync_state(key primary key, value jsonb)` — e.g. `last_pulled_at`

## Numbering (no gaps, no repeats)
`next_number(facility_id, scope)` inside the command transaction:
```sql
INSERT INTO number_sequences (facility_id, scope, year, next_value)
VALUES ($1, $2, extract(year from now())::int, 2)
ON CONFLICT (facility_id, scope, year)
DO UPDATE SET next_value = number_sequences.next_value + 1
RETURNING next_value - 1;
```
Formats: MRN `FAM-26-00042`, encounter `FAM-E-26-000123`, invoice `FAM-I-26-000123`, receipt `FAM-R-26-000123`. Only the write authority allocates numbers, so clinic and cloud never clash.
