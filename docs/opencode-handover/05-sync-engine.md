# 05 — Sync Engine (Clinic Server ↔ Cloud)

Only used when `APP_MODE=clinic`. Clinic always initiates over outbound HTTPS — no port forwarding, no VPN, no database replication.

## Outbound: clinic → cloud
1. Trigger `capture_change()` on synced tables inserts into `sync_outbox` (full row as `payload`).
2. `scripts/sync-worker.ts` (systemd service) loop every 10 s:
   - `GET {CLOUD_URL}/api/health`; offline → sleep.
   - Read oldest 100 `pending` rows ordered by `created_at, outbox_id`.
   - `POST {CLOUD_URL}/api/sync/batch` with `{ facilityId, deviceKey, rows }`, header `Authorization: Bearer <FACILITY_SYNC_TOKEN>`.
   - Cloud, in one transaction: verify token ↔ facility, upsert each row by `id` where incoming `version >= existing`, record `outbox_id` in `sync_received` (dedup), return accepted IDs.
   - Mark accepted `synced`; others `attempts++`, `last_error`, exponential backoff (max 5 min). After 10 attempts → `failed`, shown in Sync monitor with Retry.
3. Append-only tables (`stock_ledger`, `payments`, `audit_log`) are insert-only on the cloud — never updated.

## Inbound: cloud → clinic
Every 5 min when online: `GET /api/sync/pull?since=<last_pulled_at>` returns changed rows for catalogs and staff:
`items, lab_tests, services, price_lists, prices, user, account, staff_profiles, staff_role_scopes, facilities, branches, stores`.
Applied in one local transaction; then `sync_state.last_pulled_at` updated. Inbound writes do not re-enter the outbox (`SET LOCAL varian.sync_apply = 'on'` skipped by trigger).

## Conflict rules
- A facility's clinical/financial data is written only by its authority → no conflicts by design.
- Catalogs/staff are owned by the cloud → cloud wins.
- Switching a facility between `cloud` and `clinic` mode is an admin procedure: drain outbox, freeze, flip `write_authority`, export/import.

## Monitoring
Admin → Sync: online status, pending count, oldest pending age, last success, failed rows with payload preview and Retry. Alert banner if oldest pending > 24 h.
