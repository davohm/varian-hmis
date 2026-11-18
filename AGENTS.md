# Varian HMIS — project instructions

## Documentation
Read `docs/opencode-handover/README.md` first, then the numbered files `01`–`08` in order. Follow them exactly. The build sequence is the 11 sequential prompts in `docs/opencode-handover/07-build-prompts.md`; run one prompt at a time.

## Development database
Use the **local PostgreSQL 17 instance** as the dev database. A second Postgres container is for deployment only — do not start one for local development.

- URL: `postgresql://postgres:postgres@localhost:5432/varian-hmis-db`
- Host/port: `localhost:5432`
- User / password: `postgres` / `postgres`
- `psql` binary: `C:\Program Files\PostgreSQL\17\bin\psql.exe`
- Connection was verified working on 2026-11-18.
- `DATABASE_URL` for the app lives in `.env.local`.

## Non-negotiables
- UUIDv7 primary keys; `facility_id` on every operational row.
- All clinical/financial writes go through server-side commands with an idempotency key, one transaction, an audit row, and an outbox row.
- Stock and payments are append-only ledgers; no hard deletes of clinical/financial records.
- One write authority per facility (`clinic` in local mode, `cloud` otherwise).
- Default facility: **Family Afya Modern Medical Centre – Main Branch** (`FAM`).

## Design
Use the global Varian HMIS palette from `~/.config/opencode/AGENTS.md` (navy `#022f5b`, mint `#7ac7a1`, off-white `#fcf9f4`). It overrides the older palette in `docs/opencode-handover/06-ui-design-system.md`.
