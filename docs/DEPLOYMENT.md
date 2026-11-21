# Three-node deployment: Nairobi HQ + Ruaka + Thika

This runbook stands up one **cloud-authority HQ** and two **clinic-authority branch nodes** with
the existing sync engine. Cloudflare Tunnel is the only HQ ingress. Branch nodes never accept
inbound sync traffic; their workers push/pull outbound over HTTPS.

## Topology

| Node | Role | `APP_MODE` | `writeAuthority` | Database | Ingress |
| --- | --- | --- | --- | --- | --- |
| Nairobi HQ (`FAM`) | cloud authority, catalog/staff owner | `cloud` | `cloud` | HQ Postgres | Cloudflare Tunnel → `app:3000` |
| Ruaka (`RUA`) | branch workstation server | `clinic` | `clinic` | Ruaka Postgres | Caddy `https://hmis.local` on LAN |
| Thika (`THK`) | branch workstation server | `clinic` | `clinic` | Thika Postgres | Caddy `https://hmis.local` on LAN |

Each facility has exactly one write authority. Clinical and financial mutations use scoped,
idempotent commands, so an offline branch and the HQ can never accept competing writes for the
same facility. Catalog and staff rows flow cloud → branch via `/api/sync/pull`; branch activity
flows branch → cloud via `/api/sync/batch`.

All files under `deploy/` are templates. **Never commit** `.env.hq`, `.env.ruaka`, `.env.thika`,
Cloudflare credentials, or sync tokens.

## 1. Deploy Nairobi HQ

On the HQ host, from the repository root:

```bash
cp deploy/.env.hq.example deploy/.env.hq
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL and TUNNEL_ID
cp deploy/cloudflared/config.yml.example deploy/cloudflared/config.yml
# place the matching Cloudflare tunnel credentials JSON in deploy/cloudflared/
docker compose -p varian-hq -f deploy/docker-compose.hq.yml --env-file deploy/.env.hq up -d
```

The HQ container applies migrations, seeds the `FAM` facility and staff, then starts the app.
Confirm the tunnel hostname resolves and `/api/health` reports `appMode: "cloud"`.

## 2. Provision the branches on HQ

Run once on the HQ host (or any machine with HQ `DATABASE_URL` access):

```bash
APP_MODE=cloud npm run provision:branches
```

The command is idempotent. It creates `RUA` and `THK` facilities with `write_authority = clinic`,
their `MAIN` branches, and one sync token per facility/device. On first run it prints each raw
token **once**; copy them into the matching branch env file immediately. Existing tokens are left
untouched. To rotate deliberately, set `RUAKA_SYNC_TOKEN` / `THIKA_SYNC_TOKEN` and rerun.

## 3. Deploy a branch node

Repeat for Ruaka and Thika with the corresponding env file and Compose project name:

```bash
cp deploy/.env.ruaka.example deploy/.env.ruaka
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, FACILITY_ID, FACILITY_SYNC_TOKEN from step 2
docker compose -p varian-ruaka -f deploy/docker-compose.branch.yml \
  --env-file deploy/.env.ruaka up -d

cp deploy/.env.thika.example deploy/.env.thika
docker compose -p varian-thika -f deploy/docker-compose.branch.yml \
  --env-file deploy/.env.thika up -d
```

The branch app seeds its own facility identity from `SEED_FACILITY_CODE` / `SEED_FACILITY_NAME`
(`RUA`, `THK`) and starts with `write_authority = clinic`. Caddy serves `https://hmis.local` to
station computers using an internal CA; install that CA on each station.

## 4. Verify sync

From each branch node:

```bash
docker compose -p varian-ruaka -f deploy/docker-compose.branch.yml exec sync-worker npm run sync:once
```

A healthy result has `online: true`, empty `errors`, and non-zero `pushed`/`pulled` counts once
branch data exists. On HQ, open the Sync monitor (`/admin/sync`) and confirm both facilities have
no failed rows and a recent last-success time.

Sanity checks:

- HQ `/api/health` → `appMode: "cloud"`; branch `/api/health` → `appMode: "clinic"`.
- A patient registered in Ruaka appears on HQ after one sync cycle.
- A catalog change made on HQ appears in both branches after the pull interval.
- Attempting a direct HQ write for `RUA`/`THK` is refused by the write-authority guard.
- Branch worker uses `SYNC_BATCH_SIZE=50` and `SYNC_TIMEOUT_MS=60000`; its logs are rotating
  (`10m` × 5 files) and the container has `restart: unless-stopped`.

The dedicated offline-journey regression test lives in `tests/offline-journey.test.ts`. It creates
a separate `varian-hmis-journey-test` database and `JRN-*` facilities, runs registration through
triage, lab, pharmacy, invoicing, payment and discharge offline, then drains the outbox on
reconnect and checks cloud parity and replay safety. It never uses `FAM` or the production branch DB.

## 5. Updates and recovery

Roll out images one node at a time, out of hours:

```bash
docker compose -p <project> -f <compose-file> pull
docker compose -p <project> -f <compose-file> up -d
```

Migrations run on container start. Back up each Postgres volume before upgrading. Install the
nightly encrypted backup timer from `deploy/varian-backup.service` and `deploy/varian-backup.timer`
with `BACKUP_RETENTION_DAYS=14`; see `docs/OPERATORS.md` for key storage, scheduler activation and
scratch-restore verification. If a sync token is
lost or compromised, rotate it from the HQ Admin → Sync screen (or `npm run provision:branches`
with an explicit token) and update only that branch's env file, then restart its sync worker.

Never restore a branch database onto HQ or vice versa: write authorities and outbox state differ.
