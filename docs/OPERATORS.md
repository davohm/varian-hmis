# Varian HMIS operator guide

Local development and clinic-server runbook. Commands below are run from the repository root.

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

Linux systemd templates are provided in `deploy/varian-backup.service` and
`deploy/varian-backup.timer`. Install them once per node:

```bash
sudo install -m 600 /path/to/backup.env /etc/varian-hmis/backup.env
sudo install -m 644 deploy/varian-backup.service /etc/systemd/system/varian-backup.service
sudo install -m 644 deploy/varian-backup.timer /etc/systemd/system/varian-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now varian-backup.timer
systemctl list-timers varian-backup.timer
```

The environment file must contain `DATABASE_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_DIR`,
`BACKUP_RETENTION_DAYS=14`, and, on Debian/Ubuntu, `PG_BIN_DIR=/usr/lib/postgresql/17/bin`.
If `BACKUP_DIR` is not `/var/backups/varian-hmis`, update `ReadWritePaths` in the installed service
unit. Keep the environment file root-readable only. Confirm the first scheduled run through
`journalctl -u varian-backup.service -n 50 --no-pager` and the `phase: "complete"` JSON line.

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

Run a scratch restore **monthly and after every PostgreSQL/Docker upgrade**. Record the backup
filename, SHA-256 from the `phase: "complete"` log line, restore date, scratch database name and
operator. A backup is not considered verified until `pg_restore --list` shows a real table of
contents and the scratch database starts and answers queries. Drop the scratch database after the
check; never restore over a live branch or HQ database.

## 5. Sync worker

```bash
npm run sync:once      # one push/pull cycle, prints JSON result
npm run sync:worker    # continuous worker
```

Clinic mode requires `SYNC_ENABLED=true`, `CLOUD_URL`, `FACILITY_ID` and `FACILITY_SYNC_TOKEN`.
There is one write authority per facility; a non-empty `result.errors` from `sync:once` exits 1.

Deployed branch nodes use `SYNC_BATCH_SIZE=50` and `SYNC_TIMEOUT_MS=60000`. Smaller batches stop a
large catch-up push from timing out on a slow link; the cloud endpoint still rejects batches above
100 rows. `SYNC_POLL_MS=10000` and `SYNC_PULL_MS=300000` are unchanged. The Compose sync-worker
service has `restart: unless-stopped` and rotated JSON logs (`10m` × 5 files per branch).

Monitor the sync worker on every branch:

```bash
docker compose -p <project> -f deploy/docker-compose.branch.yml logs -f --tail=100 sync-worker
docker compose -p <project> -f deploy/docker-compose.branch.yml ps sync-worker
```

Alert when the worker container restarts unexpectedly, when `cloud offline` persists beyond the
site's expected outage window, when a `cycle` log line contains a non-empty `errors` array, or when
Admin → Sync shows `failed` rows or no recent success for a facility. Retry failed rows from the
Sync monitor after connectivity returns, then confirm the outbox drains.

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

## 8. KRA eTIMS sandbox / production switch

Each facility has two `integration_settings` rows for `integration = 'etims'`: one `sandbox` and
one `production`. They are separate configuration: target URL, spec version, OSCU/VSCU mode,
timeout, retry count, backoff array and `enabled` flag. `db:seed` creates a local sandbox stub
(`sandbox://kra.etims.local`) and a disabled production placeholder; it never enables production.

Credentials are **never** stored in `integration_settings`, the browser or the repository. The
`credential_ref` column only names a server environment variable:

| Variable | Purpose |
| --- | --- |
| `ETIMS_SANDBOX_API_KEY` | sandbox bearer credential, looked up by `credential_ref` |
| `ETIMS_PRODUCTION_API_KEY` | production bearer credential, looked up by `credential_ref` |
| `ETIMS_PRODUCTION_BASE_URL` | expected production target; a sandbox run refuses this URL |
| `ETIMS_ALLOW_PRODUCTION` | must be exactly `true` before any production transmission |

### Switch to production

1. Finish the full sandbox flow on `/finance/tax`: generate a signature, inspect the QR/control
   number, retry a forced failure and print the invoice.
2. Set the facility's production row `base_url`, `spec_version`, `mode`, `max_attempts` and
   `backoff_seconds` to the KRA-issued values. Keep `enabled = false` until step 4.
3. Store `ETIMS_PRODUCTION_API_KEY` in the server's secret store and set
   `ETIMS_PRODUCTION_BASE_URL` to the same URL as the production row. Restart the server.
4. Confirm the production URL contains no `sandbox` or `/prod` test alias, then set the production
   row's `enabled = true` and `ETIMS_ALLOW_PRODUCTION=true` on the server. Restart again.
5. In `/finance/tax`, choose **Production (guarded)** for one real invoice and verify the control
   number and QR. Acknowledged documents are immutable; corrections are credit notes only.

### Return to sandbox

Set the production row's `enabled = false` and remove `ETIMS_ALLOW_PRODUCTION` from the server.
Existing acknowledged documents and their credit-note links remain untouched. A sandbox run can
never write to the production target: the client refuses sandbox requests that resolve to the
configured production URL, and production requests without the explicit allow flag.

## 9. Nairobi HQ with Ruaka and Thika branch nodes

The three-node topology, Cloudflare Tunnel front door, branch provisioning and sync verification
are documented in `docs/DEPLOYMENT.md`. In short: HQ runs `APP_MODE=cloud` with `FAM` as the only
cloud-authority facility; Ruaka (`RUA`) and Thika (`THK`) run separate clinic-mode stacks with
their own databases and `write_authority = clinic`. Provision their sync tokens from HQ with
`npm run provision:branches`, then verify each node with `npm run sync:once`.

## 10. Regulatory placeholder sandbox

`REGDEMO-001` is a **local test fixture** in the FAM branch database. It is not a physical site, is
not part of the cloud topology, and its invented values are never valid for billing, claims or
compliance evidence. All commands against a `REGDEMO-` facility suppress outbox capture, so edits
made through Admin → Regulatory stay in that database and never reach Neon.

Provision or refresh it from the branch machine:

```bash
npx tsx scripts/seed-regulatory-test-placeholders.ts
```

Then switch **Active facility** to `REGDEMO-001` on `/admin/regulatory`. The page shows a red
`TEST PLACEHOLDER DATA` banner and a **Load TEST placeholders** action. That action is idempotent
and re-applies the obviously invented KMPDC, ODPC, SHA, PPB, KMLTTB, RPB, quality and statutory
values. `FAM` remains empty where regulator values are unconfirmed; enter those only from documents
supplied by the facility. Document upload is not implemented yet — use **Document reference** to
point to the signed source.

## 11. SHA / SHIF revenue cycle

The SHA workspace is at `/finance/revenue/sha`, linked from Finance → Revenue cycle. It supports the
SHA funds `phf`, `shif` and `eccif`. Every regulator-supplied value (KMPDC number, scheme code,
contract number, tariff version, benefit coverage, co-pay percentages, pre-authorisation thresholds
and adjudication codes) is entered by an administrator from SHA documentation. The system supplies
only safe defaults and never guesses an unconfirmed regulator value.

### One-time setup

1. On **Admin → Regulatory**, enter the facility's KMPDC number and keep the facility licence
   active. `createEmpanelment` refuses to save an empanelment without both.
2. In **Empanelment**, record the fund, scheme code/name, contract number, effective dates, tariff
   version and optional quality-certification details. An empanelment can be suspended, expired or
   terminated; closing requires a reason, and a terminated empanelment cannot be reopened.
3. In **Eligibility → Benefit packages**, record the package, care type, effective period and its
   itemised services. Each item declares `coverage` (`full`, `partial` or `excluded`), unit price,
   co-pay percentage, and optional `requiresPreauth` / `preauthThreshold` values.
4. Seed the facility's SHA adjudication codes (approved, reduced, rejected, info) from SHA's
   published reason list. Denials cannot be recorded with an unconfigured code.

### Roles and separation of duties

| Role | SHA access |
| --- | --- |
| `revenue_cycle_officer` | Owns the workspace: setup, eligibility, pre-auth, claims, denials and rework |
| `finance_officer`, `accountant` | Read access plus remittance and reconciliation |
| `cashier` | Verifies eligibility and records patient co-pay |
| `admin` | Full access |

Separation of duties is enforced in the command layer, not only in the UI: a claim preparer cannot
submit or adjudicate that claim, a claim approver cannot record its remittance, a pre-auth requester
cannot decide their own request, and a waiver requester cannot approve or use their own waiver.

### Daily flow

1. **Eligibility** — record the SHA check result against the patient, payer and empanelment. A valid
   `payer_sharing` consent is required before any claim shares patient data with the payer.
2. **Pre-authorisation** — request and approve an authorisation for expensive or preauth-required
   lines. The claim builder shows per-line coverage (covered / co-pay / excluded / pre-auth
   required) before submission.
3. **Claims** — build the claim from an encounter and an SHA-claimable invoice. Excluded or unlisted
   lines are rejected unless explicitly marked patient-pay, in which case they become co-pay and are
   never billed to SHA. Line amounts reconcile to the cent. Submission allocates
   `shaClaimRef = SHA-<claimNo>` exactly once; rework copies it unchanged to a new linked draft.
4. **Denials** — record the configured rejection code, reason and optional line. Rework creates a new
   draft via `supersedes_claim_id`; the original claim is never edited.
5. **Remittances** — allocate each receipt to claim lines and sum to the receipt amount. A payment
   above the approved balance is refused and audited until an independent approver approves a
   waiver/exemption covering the excess.
6. **Reconciliation** — import the SHA payment report by KMPDC number and period. Lines match on
   KMPDC + period + `shaClaimRef`; unmatched cash stays as a variance row and is never silently
   written off. The screen shows SHA reported vs facility invoiced vs matched vs variance. Cash is
   posted to the general ledger only when it has not already been posted by a remittance carrying
   the same report reference.

Claim and remittance documents are print-ready from the workspace and include the facility,
empanelment, claim/remittance references, line coverage and totals.

### Controls and verification

All SHA writes go through `src/server/commands/sha.ts` with an idempotency key, one transaction, an
audit row and a sync outbox row. There are no hard deletes of SHA clinical or financial records.
Replaying a command with the same idempotency key returns the original result.

Migrations `0034_wild_phil_sheldon.sql`, `0035_rapid_spiral.sql` and `0036_curly_jane_foster.sql`
install the SHA schema on local and cloud databases. Verify after a release with:

```bash
npx tsc --noEmit
npm run lint
npm run build
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/varian-hmis-db'; $env:DIRECT_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/varian-hmis-db'; npm test
```

Never run the test suite against the Neon connection string. `tests/sha.test.ts` covers all 15
Prompt 22 business rules and the full eligibility → pre-auth → claim → adjudication → remittance →
ledger posting → reconciliation journey with a balanced trial balance. Authenticated screenshots and
a changelog entry are N/A for this backend/admin ERP phase.
