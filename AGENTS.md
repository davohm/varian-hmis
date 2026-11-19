# Varian HMIS — project instructions

## Documentation
Read `docs/opencode-handover/README.md` first, then the numbered files `01`–`10` in order. Follow them exactly. The V1 build sequence is the 11 sequential prompts in `docs/opencode-handover/07-build-prompts.md`; run one prompt at a time. ERP extensions are specified in `docs/opencode-handover/09-erp-scope.md`. Kenyan regulatory requirements and build prompts 18–22 are in `docs/opencode-handover/10-kenya-facility-readiness.md`; every unconfirmed regulator value there is an admin-editable field with a safe default, never a hard-coded guess or a build blocker.

## Scope
Varian HMIS is a clinical and ERP platform, not a clinical-only app. The ERP scope covers finance and revenue cycle, procurement and inventory, HR and payroll, assets and maintenance, and management reporting. Build ERP capabilities on the same facility-scoped, audited, idempotent, ledger-first architecture as the clinical modules.

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

## UI/UX skills
Always use the relevant installed OpenCode skills when building or changing UI and UX. Load the skill(s) before designing or editing screens, components, layouts, motion, accessibility or interaction patterns — do not rely on generic ad-hoc styling. Start with `tastemaker` for visual direction, then the closest focused skills for the task, such as `emil-design-eng`, `design-system-*`, `accessibility-audit`, `animate`, `gestures` or the relevant `illustration-*` skill. Apply the Varian palette and existing design-system conventions on top of the skill guidance.
