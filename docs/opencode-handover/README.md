# Varian HMIS — OpenCode Handover Pack

Specification for rebuilding Varian HMIS from scratch on:

- **Next.js 15** (App Router, React 19, Server Actions, Route Handlers)
- **PostgreSQL 17** with **Drizzle ORM** + Drizzle Kit migrations
- **Better Auth** (email/password, admin-provisioned staff, RBAC)
- Tailwind CSS v4, shadcn/ui, Lucide, Sonner

## Read in order
1. [01-prd.md](01-prd.md) — product requirements, users, modules, acceptance criteria
2. [02-architecture.md](02-architecture.md) — topology, cloud vs clinic-server modes, folder layout
3. [03-database-schema.md](03-database-schema.md) — Postgres 17 schema, numbering, ledgers
4. [04-auth-and-rbac.md](04-auth-and-rbac.md) — Better Auth setup, roles, guards, offline sign-in
5. [05-sync-engine.md](05-sync-engine.md) — clinic server → cloud outbox sync
6. [06-ui-design-system.md](06-ui-design-system.md) — clinical design language
7. [07-build-prompts.md](07-build-prompts.md) — sequential prompts to paste into OpenCode
8. [08-deployment.md](08-deployment.md) — cloud + mini-PC clinic deployment
9. [09-erp-scope.md](09-erp-scope.md) — ERP domains, data model, phases and post-V1 build prompts
10. [10-kenya-facility-readiness.md](10-kenya-facility-readiness.md) — Kenyan regulatory requirements (KMPDC, ODPC, SHA, KRA, MOH) and build prompts 18–22

## Non-negotiables
- One write authority per facility (clinic server in local mode, cloud otherwise).
- UUIDv7 primary keys; every operational row carries `facility_id`.
- Clinical/financial writes go through server-side commands with an idempotency key.
- Stock and payments are append-only ledgers.
- Default facility: **Family Afya Modern Medical Centre – Main Branch** (code `FAM`).
