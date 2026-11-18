# 02 — Architecture

```text
                 CLOUD (Next.js + Postgres 17)
   Head-office reporting, catalog master, staff master, backups
                          ^
                          | HTTPS outbound sync (clinic initiates)
                          v
     CLINIC SERVER (mini-PC, static IP e.g. 192.168.1.100)
       Caddy/Nginx (LAN HTTPS) -> Next.js (node) -> Postgres 17
       sync-worker (outbox -> cloud, catalogs <- cloud)
                          ^
                          | LAN HTTP + SSE (no internet needed)
     Reception | Triage | Doctor | Lab | Pharmacy | Cashier (browsers)
```

## Modes (same code, env-selected)
- `APP_MODE=cloud` — clinics with reliable internet connect directly to the cloud.
- `APP_MODE=clinic` — app + Postgres run on the mini-PC; `SYNC_ENABLED=true`.
- A facility is in exactly one mode at a time (`facilities.write_authority`). The cloud rejects writes for facilities whose authority is `clinic` except via the sync endpoint.

## Real-time between stations
Postgres `LISTEN/NOTIFY` on `queue_entries`, `orders`, `prescriptions` → Next.js Route Handler `/api/events` streams SSE to browsers. No third-party realtime service.

## Mutations
- Server Actions call domain commands in `src/server/commands/*`.
- Each command: `zod` validate → auth guard → one DB transaction → audit row → outbox row (trigger) → `NOTIFY`.
- Every command takes `idempotencyKey` (UUID from client); stored in `command_log` (unique), replay returns the original result.

## Folder layout
```text
src/
  app/
    (auth)/login/
    (app)/layout.tsx            # shell: sidebar, facility switcher, user menu
    (app)/reception/ triage/ doctor/ lab/ pharmacy/ cashier/ admin/
    api/auth/[...all]/route.ts  # Better Auth
    api/events/route.ts         # SSE
    api/sync/batch/route.ts     # cloud: receive clinic batches
    api/sync/pull/route.ts      # cloud: serve catalog changes
  server/
    db/ (client.ts, schema/*.ts)
    commands/ (patients.ts, queue.ts, encounters.ts, lab.ts, pharmacy.ts, billing.ts)
    queries/
    auth/ (auth.ts, guards.ts)
    numbering.ts  audit.ts  events.ts
  components/ (ui/, clinical/)
  lib/ (uuid.ts, format.ts, validators/)
scripts/ (seed.ts, sync-worker.ts, backup.sh)
drizzle/ (migrations)
```

## Key libraries
`drizzle-orm`, `drizzle-kit`, `pg`, `better-auth`, `zod`, `uuidv7`, `@tanstack/react-query` (client caching), `react-hook-form`, `sonner`, `date-fns`, `vitest`, `playwright`.
