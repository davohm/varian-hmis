# Varian HMIS

Varian HMIS is a Next.js-based hospital/facility management information system for Kenyan healthcare facilities. It covers patient registration and reception, triage, clinical encounters, laboratory, pharmacy, billing/cashier workflows, revenue cycle, finance, administration, sync, and facility readiness features.

## Project plan

See [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) for phase status and pending work, including the new **Phase 0 — Initial Configuration** first-run setup.

## Tech stack

- **Web:** Next.js 15 (App Router), React 19, TypeScript
- **Database:** PostgreSQL with Drizzle ORM
- **Auth:** Better Auth
- **Validation/forms:** Zod, React Hook Form
- **Testing:** Vitest, Playwright

## Prerequisites

- Node.js (LTS recommended)
- npm
- PostgreSQL

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local environment configuration:

   ```bash
   cp .env.example .env.local
   ```

   Update `.env.local` for your environment. At minimum set:

   - `DATABASE_URL` – PostgreSQL connection string
   - `APP_MODE` – e.g. `cloud`
   - `BETTER_AUTH_URL` – app base URL (local: `http://localhost:3000`)
   - `BETTER_AUTH_SECRET` – long random secret

   For local/automated test servers you may set `AUTH_RATE_LIMIT=off` where needed (never in production).

3. Apply database migrations:

   ```bash
   npm run db:migrate
   ```

4. Seed baseline data:

   ```bash
   npm run db:seed
   ```

5. Start the development server:

   ```bash
   npm run dev
   ```

## Common scripts

- `npm run dev` – start Next.js dev server
- `npm run build` / `npm start` – production build and serve
- `npm run lint` – run ESLint
- `npm run typecheck` – run TypeScript checks
- `npm test` – run Vitest suite
- `npm run test:watch` – run Vitest in watch mode
- `npm run test:e2e` – run Playwright tests (seeds DB first)
- `npm run db:generate` – generate Drizzle migrations
- `npm run db:migrate` – apply Drizzle migrations
- `npm run db:seed` – seed database
- `npm run db:seed:performance` – seed performance dataset
- `npm run db:backup` – run backup script
- `npm run sync:worker` / `npm run sync:once` – clinic/cloud sync worker

## Privacy & data protection (Kenya ODPC)

The HMIS includes data protection controls aligned with Kenya facility-readiness Prompt 19 (ODPC/data protection). Key capabilities:

### Roles, access, and administration

- **DPO role:** `dpo` is a supported role with privacy administration access via RBAC.
- **Privacy admin workspace:** `/admin/privacy` provides operational views and actions for **Consents**, **Data subject requests**, **Breaches**, **Retention**, **Sharing agreements**, **Transfers**, and **Access log**.
- **Privacy settings:** facility privacy configuration is managed under the privacy/regulatory settings domain (e.g. DSAR SLA, breach notification timing, consent validity settings as configured).

### Consent capture and status

- **Registration consent capture:** reception registration captures versioned consent records (with stored consent text hash). Adult registration supports treatment consent; minors require guardian/next-of-kin details and granted minor consent as enforced by registration flows.
- **Consent status derivation:** encounter/patient privacy status is derived as `current` when a valid required consent exists (`treatment` for adults, `minor` for minors), `missing` when required consent is not valid, and `restricted` when a patient restriction/legal hold applies.
- **Restricted state:** patient restrictions are represented via retention policy records (restriction entity/legal hold) and take precedence in surfaced privacy status.

### Restricted chart access and auditing

- **Encounter details:** doctor and cashier encounter detail APIs expose `privacy` status and enforce restricted-chart access controls.
- **Reason prompt and audited access:** when a chart is restricted and no access reason is supplied, detail endpoints return `403` with `code: "chart_access_reason_required"` and privacy context. The UI prompts staff for a reason and retries with `?reason=...`; successful restricted access is recorded in the chart access/audit trail (e.g. `logChartAccess`).
- **UI indicators:** patient/visit surfaces display consent/restricted state as **Consent: current/missing/Restricted** using text and color (never color alone).

### Sharing and integration safeguards

- **Payer sharing enforcement:** revenue/pre-authorization and claim submission flows refuse payer data sharing without a valid `payer_sharing` consent and, where applicable, a usable sharing agreement.
- **Commands, audit, and sync:** privacy and regulatory writes follow command patterns with idempotency, auditing, and outbox/event integration where applicable; sensitive records follow append-only/no-hard-delete constraints as specified by the data model and commands.

### Notes

- Privacy behavior depends on configured facility settings, role scopes, and available patient/consent records.
- For implementation details, see `docs/opencode-handover/10-kenya-facility-readiness.md` (Prompt 19) and the privacy schema/commands/queries under `src/server` and `src/lib/privacy.ts`.
