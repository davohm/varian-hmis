# Varian HMIS operator guide

Local development and clinic-server runbook. Commands below are run from the repository root.
Maintainer note: `npm run db:backup` and `npm run db:seed:performance` are being added to
`package.json`; the underlying scripts are `scripts/backup.ts` and `scripts/seed-performance.ts`.

## 1. Local development database

Use the local PostgreSQL 17 instance (not the deployment container).

- URL: `postgresql://postgres:postgres@localhost:5432/varian-hmis-db`
- `DATABASE_URL` lives in `.env.local` (copy from `.env.example`).
- Windows binaries: `C:\Program Files\PostgreSQL\17\bin\psql.exe`, `pg_dump.exe`, `pg_restore.exe`.

Check connectivity:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" "$env:DATABASE_URL" -c "select version();"
```

Default facility: **Family Afya Modern Medical Centre – Main Branch** (`FAM`).
One write authority per facility: `clinic` in local mode, `cloud` otherwise.

## 2. Environment variables

Core: `DATABASE_URL`, `APP_MODE` (`cloud` | `clinic`), `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
Sync (clinic): `SYNC_ENABLED`, `CLOUD_URL`, `FACILITY_ID`, `FACILITY_SYNC_TOKEN`,
`FACILITY_DEVICE_KEY`, `SYNC_BATCH_SIZE`, `SYNC_POLL_MS`, `SYNC_PULL_MS`, `SYNC_TIMEOUT_MS`.

Backups:

| Variable | Meaning | Default |
| --- | --- | --- |
| `BACKUP_ENCRYPTION_KEY` | base64 AES-256 key, required for live backups | none |
| `BACKUP_DIR` | output directory | `./backups` |
| `BACKUP_RETENTION_DAYS` | number of daily backups to keep (1–365) | `14` |
| `PG_BIN_DIR` | directory holding `pg_dump` / `pg_restore` / `psql` | PostgreSQL 17 install path |
| `PG_DUMP_BIN`, `PG_RESTORE_BIN`, `PSQL_BIN` | full binary path overrides | from `PG_BIN_DIR` |

Generate a key once and store it outside the database host:

```bash
openssl rand -base64 32
```

Never paste `DATABASE_URL` or `BACKUP_ENCRYPTION_KEY` into tickets, chat or shell history.
The backup script passes credentials to PostgreSQL through `PG*` environment variables, not argv,
and redacts secrets from its own logs.

## 3. Schema and seed

```bash
npm run db:generate     # create a migration from schema changes
npm run db:migrate      # apply migrations
npm run db:seed         # facilities, staff, catalogues, prices, stock
npm run dev             # local server
```

`db:seed` is idempotent. Do not run `db:generate` on a production database without review.

## 4. Daily encrypted backups

One backup per run, custom-format `pg_dump`, verified with `pg_restore --list`, then encrypted
with AES-256-GCM. Retention keeps the newest dump per UTC day, up to `BACKUP_RETENTION_DAYS`.
Files with unknown names are never deleted.

```bash
npm run db:backup -- --once            # scheduled one-shot run
npm run db:backup -- --dry-run --once  # show the plan, write nothing
```

`--once` is the explicit one-shot form used by schedulers; the script is one-shot by default.
A failed dump, failed TOC verification or invalid key exits nonzero and leaves no partial dump.

Linux cron (02:15 every day):

```cron
15 2 * * * cd /srv/varian-hmis && /usr/bin/npm run db:backup -- --once >> /var/log/varian-backup.log 2>&1
```

Windows Task Scheduler: create a basic task with action
`Program: C:\Program Files\nodejs\npm.cmd`,
`Arguments: run db:backup -- --once`,
`Start in: C:\Users\Dev\Documents\Webapps\varian-hmis`,
trigger daily at 02:15. Set `BACKUP_DIR` to a USB or network path in `.env.local`.

### Retention and restore verification

Inspect a backup without decrypting to disk (metadata is in plaintext only before encryption):

1. Decrypt the `.dump.enc` file with the key from the operator secret store:

```bash
node -e "const fs=require('fs'),c=require('crypto');const b=fs.readFileSync(process.argv[1]);const k=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,'base64');const d=c.createDecipheriv('aes-256-gcm',k,b.subarray(6,18));d.setAuthTag(b.subarray(18,34));fs.writeFileSync(process.argv[2],Buffer.concat([d.update(b.subarray(34)),d.final()]));" backups/varian-hmis-2026-11-19T02-15-00Z.dump.enc restore.dump
```

2. List its contents:

```bash
& "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --list restore.dump
```

3. Restore into an **empty scratch database**, never over production:

```bash
& "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --dbname "postgresql://postgres:postgres@localhost:5432/varian-hmis-restore-test" restore.dump
```

Delete `restore.dump` afterwards; it contains unencrypted patient data.

## 5. Sync worker

```bash
npm run sync:once      # one push/pull cycle, prints JSON result
npm run sync:worker    # continuous worker
```

Clinic mode requires `SYNC_ENABLED=true`, `CLOUD_URL`, `FACILITY_ID` and `FACILITY_SYNC_TOKEN`.
There is one write authority per facility; a non-empty `result.errors` from `sync:once` exits 1.

## 6. Performance seed (opt-in)

Generates up to 100,000 deterministic patients for facility `FAM` with fixed UUIDv7 IDs and
`ON CONFLICT DO NOTHING`; reruns add nothing and never delete or update existing rows.

```bash
npm run db:seed:performance -- --yes                     # 100,000 patients, batches of 1,000
npm run db:seed:performance -- --yes --count=10000 --batch=500
PERF_SEED_CONFIRM=1 npm run db:seed:performance
npm run db:seed:performance -- --dry-run --yes           # show plan only
```

Run `npm run db:seed` first so `FAM` exists. Use only on disposable local/test databases.

## 7. Common failures and recovery

| Symptom | Check / fix |
| --- | --- |
| `DATABASE_URL is not set` | Copy `.env.example` to `.env.local`; confirm the URL scheme is `postgres://` or `postgresql://`. |
| `pg_dump` not found | Set `PG_BIN_DIR` or `PG_DUMP_BIN` / `PG_RESTORE_BIN` to the PostgreSQL 17 binaries. |
| `BACKUP_ENCRYPTION_KEY` error | Generate a fresh 32-byte base64 key; do not reuse a key after loss, and keep old keys for old archives. |
| `pg_restore --list` verification failed | Keep the database quiescent, re-run; check disk space and that the pg_dump/pg_restore major versions match. |
| Duplicate MRN during seeding | Use the performance seed, which derives MRNs and IDs from an index; do not re-run ad-hoc inserts. |
| Backup directory permission denied | Point `BACKUP_DIR` at a writable local/USB path; permissions are set to owner-only on new archives. |
| Port 5432 busy | Stop the other PostgreSQL service; use only the local PG 17 instance for development. |
| Sync worker refuses to start | Verify clinic env vars and that the cloud has a matching facility/device token. |

After any incident, preserve the failing command's exit code and log excerpt (redacted), note the
last successful backup filename and its SHA-256, and escalate to the platform/database owner.
Never restore directly onto the live database without a verified scratch restore first.
