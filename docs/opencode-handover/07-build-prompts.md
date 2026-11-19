# 07 — OpenCode Build Prompts

Paste one prompt at a time. Before each, tell OpenCode: *"Read docs/opencode-handover/*.md first. Follow them exactly. Write tests for every business rule."*

### Prompt 1 — Scaffold
Create a Next.js 15 App Router TypeScript project with Tailwind v4, shadcn/ui, Lucide, Sonner, ESLint, Vitest, Playwright. Add Drizzle ORM + drizzle-kit with `pg` for PostgreSQL 17 and a `docker-compose.yml` running `postgres:17`. Implement the tenancy/admin tables from 03, `uuidv7` helper, `next_number()` numbering with a concurrency test (50 parallel calls → no gaps/duplicates), and `audit.ts`. Add `scripts/seed.ts` with facility FAM "Family Afya Modern Medical Centre", Main Branch, stores Pharmacy/Main Store/Lab.

### Prompt 2 — Auth & shell
Integrate Better Auth per 04 (Drizzle adapter, admin plugin, sign-up disabled). Add staff_profiles and staff_role_scopes, guards, login page, seed one user per role. Build the app shell per 06: role sidebar, facility/branch switcher, status pill, user menu. Add Playwright test: each role only sees its screens; forbidden actions return 403.

### Prompt 3 — Reception
Patients, next_of_kin, encounters, queue_entries. Commands: `registerPatient`, `startVisit`, `queuePatient` (idempotent via command_log). Search with pg_trgm, duplicate warning, MRN allocation. SSE `/api/events` with LISTEN/NOTIFY. Test: registering on one browser shows in the triage queue of another within 2 s.

### Prompt 4 — Triage
Triage queue, vitals form with BMI and range highlighting, category, comments, next steps, route to doctor queue.

### Prompt 5 — Doctor
Consultation screen with pinned banner, SOAP notes, ICD-10 picker (seed a CSV), lab order and prescription dialogs, results panel, visit history, discharge/refer outcome.

### Prompt 6 — Laboratory
Lab test catalog with parameters, worklist, sample collection, result entry with auto-flags, verification; doctor sees verified results live.

### Prompt 7 — Pharmacy & stock
Items, batches, stock_ledger (append-only) and `stock_balances` view. Receive, adjust, transfer. Dispense with FEFO suggestion, partial dispense, label print. Test: cannot dispense more than batch balance; concurrent dispenses never go negative (row lock).

### Prompt 8 — Cashier
Services, price lists per payer, auto charges from consultation/lab/dispense, invoices, payments (split tender), receipts with sequential numbers, reversals, cashier sessions and end-of-day report, 80 mm receipt print.

### Prompt 9 — Admin
Facilities/branches/departments/rooms/stores CRUD, staff management with role scopes, catalogs and price lists, audit log viewer with filters.

### Prompt 10 — Clinic mode & sync
`APP_MODE`, `sync_outbox` triggers, sync-worker, cloud `/api/sync/batch` and `/api/sync/pull`, Sync monitor page per 05. Test: run two Postgres instances, unplug cloud, complete a full patient journey, reconnect, assert cloud has identical rows with no duplicates.

### Prompt 11 — Hardening
Backups script, error boundaries, empty/loading states, print styles, performance pass (100k patients seed), accessibility pass, README for operators.

## ERP extensions

The ERP scope is specified in [09-erp-scope.md](09-erp-scope.md). Do not start these prompts until V1 passes its full verification.

### Prompt 12 — Finance foundation
Ledger accounts, fiscal periods, journals, journal lines, cost centres, posting commands, trial balance and general ledger. Add finance roles, approval limits, period-close and reversal tests.

### Prompt 13 — Revenue cycle
Payers, contracts, benefits, pre-authorisations, claims, claim lines, remittances and denials. Connect claims to encounters, invoices and payments. Add claim-lifecycle and segregation-of-duties tests.

### Prompt 14 — Procurement and inventory
Suppliers, requisitions, approvals, RFQs, LPOs, goods receipts, supplier invoices and payments. Extend the existing stock ledger. Add three-way matching, reorder and valuation tests.

### Prompt 15 — HR and payroll
Employees, contracts, attendance, shifts, leave, payroll runs, payslips and payroll lines. Add statutory summaries, cost-centre allocation, restricted access and approval tests.

### Prompt 16 — Assets and maintenance
Assets, assignments, depreciation entries, maintenance orders and disposal. Add depreciation and audit-history tests.

### Prompt 17 — ERP reporting and controls
Report catalogue, saved views, exports, approval dashboards and drill-down. Add financial statements, ageing, stock valuation and budget-variance reports.

## Kenya readiness extensions

The Kenyan requirements are specified in [10-kenya-facility-readiness.md](10-kenya-facility-readiness.md), with the full data model, commands, business rules, UI scope and acceptance criteria for each prompt. Run these one at a time, after the ERP prompts. Do not start them until V1 and the ERP prompts pass their full verification. Every unconfirmed regulator value listed in doc 10 §10 is an admin-editable, validated field with a safe default — build the field, never hard-code the answer, and never wait on one to start.

### Prompt 18 — Kenya master data, licences and regulatory identifiers
Facility regulatory profile (KMPDC number, KEPH level, licence category, county/sub-county, licence and indemnity expiry), practitioner registrations (annual practice licence, CPD), support-service licences (pharmacy, laboratory, imaging), facility identifiers (KRA PIN, NSSF, ODPC), licence alert rules, and a readiness guard used by billing, claims and reporting. Also the admin configuration surface where every unconfirmed regulator value in doc 10 §10 is entered, validated and versioned — nothing is hard-coded and no build waits on an answer.

### Prompt 19 — Data protection (ODPC)
Consent capture and withdrawal, data-subject requests with a clock, breach register with ODPC notification, retention policies, data-sharing agreements, cross-border transfer assessment for clinic→cloud, DPO role and privacy workspace, and per-record chart access audit.

### Prompt 20 — MOH statutory reporting
Report catalogue and generic run/cell store; generators for MOH 705A, 705B, 717, 505 (IDSR), 710A, 710B, 416 and 735 with the exact MOH envelope and arithmetic identities; IDSR immediate notifiable-event triggers; births and deaths notification registers; CSV/XLSX/PDF export, submission and void. Remaining forms follow in Prompt 20b.

### Prompt 21 — eTIMS electronic tax invoicing
Tax code master, eTIMS invoice envelope and durable queue, OSCU/VSCU adapters with sandbox and production targets, automatic enqueue on invoice finalisation, idempotent retry with backoff, credit notes instead of edits, and the KRA transactions screen.

### Prompt 22 — SHA / SHIF revenue cycle
Empanelment per fund, benefit packages and tariffs, SHA claim references and adjudication, pre-authorisation references, remittance allocation, denial rework, payment-report reconciliation to the general ledger, and waiver/exemption approval with separation of duties.
