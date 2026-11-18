# 08 — Deployment

## Cloud
- Next.js on a Node host (VPS, Railway, Render, or Vercel with a Node runtime for SSE).
- Managed PostgreSQL 17 (e.g. Neon, Crunchy, DigitalOcean, AWS RDS) with PITR backups.
- Env: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_MODE=cloud`.

## Clinic server (per facility)
- Hardware: mini-PC (Intel N100+, 16 GB RAM, 512 GB SSD), UPS ≥ 30 min, gigabit switch, static IP `192.168.1.100`, 4G/fibre router.
- OS: Ubuntu Server 24.04 LTS. Install via `docker compose` (postgres:17, app, caddy, sync-worker) or native systemd services.
- Env: `APP_MODE=clinic`, `SYNC_ENABLED=true`, `CLOUD_URL`, `FACILITY_ID`, `FACILITY_SYNC_TOKEN`, `DATABASE_URL`, `BETTER_AUTH_SECRET`.
- Caddy serves LAN HTTPS with an internal CA (install root cert on stations) at `https://hmis.local`.
- Backups: nightly `pg_dump` encrypted to USB + uploaded to cloud storage when online; keep 14 days.
- Updates: pull a tagged image, run `drizzle-kit migrate`, restart — scheduled out of hours.

## Station computers
Any modern browser bookmarked to `https://hmis.local`. Thermal receipt printer at cashier, label printer at pharmacy.
