# Varian HMIS — Implementation Plan

Status recorded on 2026-11-22. Phase 12 is deployed as `c44f9fd`, Phase 13 as `05360b0`, Phase 14 as `db0d0ec102793eb7681dc4ea822cd1e065eb38e4`, Phase 15 as `542f7b356d8558a3882de0ef5c23d8c52fbf9752`, Phase 16 as `2bc2d666264d7edd2eb89edc09bf4e71bdb70a1d`, and Phase 17 is complete and verified with migration `0031_erp_reporting_controls.sql` in the current ship commit.

## Current phase status

| Status | Phases |
|---|---|
| Complete | 0-19, 21 |
| Partial | 20 |
| Missing | 22 |

### Outstanding work summary

- **Phase 12 — Finance foundation:** complete and deployed as `c44f9fd` — ledger, journals, reversal, periods, statements and data-driven approval limits by facility/role/action with an admin-only configuration panel, audit and sync rows. Migration `0025_spooky_ikaris.sql` has been applied to production Neon and the local FAM branch database; it must be applied to every other target database before enforcement is relied on there.
- **Phase 13 — Revenue cycle:** complete and deployed as `05360b0932f9f99d5300a628bc6d90b66d5a70fb` — payers, contracts, benefits, pre-authorisations, claims, claim lines, remittances and denials, with command-layer segregation of duties enforced by actor identity. Migration `0026_breezy_korg.sql` has been applied to the local dev database, the local FAM branch database and production Neon; it must be applied to every other target database before the new actor columns are relied on there.
- **Phase 14 — Procurement and inventory:** complete and verified — suppliers, requisitions with approvals, RFQs and supplier quotes, LPOs, GRNs against the existing append-only stock ledger, supplier invoices with three-way matching, supplier payments, AP/GL postings, reorder alerts and stock valuation. Migrations `0027_mixed_ironclad.sql` and `0028_supplier_payment_append_only.sql` have been applied to the local dev database, the local FAM branch database and production Neon; other branch databases must apply them before procurement is relied on there.
- **Phase 15 — HR and payroll:** complete and verified — employee/position/contract, rota, attendance and leave records; rate-driven payroll preparation, SoD approval, finance approval ceiling, GL posting and immutable payslips. Migration `0029_quiet_meteorite.sql` has been applied to the local dev database, the local FAM branch database and production Neon; other branch databases must apply migrations `0025`–`0029` before these controls are relied on there.
- **Phase 16 — Assets and maintenance:** complete and verified — asset register with append-only custodian/location events, straight-line depreciation with SoD approval and GL posting, maintenance orders with immutable event history and cost postings, revaluation/impairment and disposal workflows with balanced journals, audit/outbox capture and database-level no-hard-delete/append-only guards. Migration `0030_vengeful_terror.sql` has been applied to the local dev database, the local FAM branch database and production Neon; other branch databases must apply migrations `0025`–`0030` before these controls are relied on there.
- **Phase 17 - ERP reporting and controls:** complete and verified - report catalogue seeded with Prompt 17 ERP reports, saved report views, CSV export, approval inbox, drill-down to journal lines and audit trail, and report generation/snapshot commands through the audited/idempotent command layer. Migration `0031_erp_reporting_controls.sql` has been applied to the local dev database, the local FAM branch database and production Neon; other active branch databases must apply it before relying on Phase 17 controls there.
- **Phase 18 — Kenya master data / licences / IDs:** complete — regulatory schema/commands/queries/lib/seed/UI implemented; `assertFacilityReady` wired into billing, revenue, and MOH report generation; dedicated 19-rule Prompt 18 test suite added and passing.
- **Phase 20 - MOH statutory reporting:** complete — MOH report lib (`src/lib/moh-reporting.ts`), source-backed generators (`src/server/reporting/moh.ts` + `moh-sources.ts`) for 705A/705B/717/505/710A/710B/416/735, command/query surface for generate/regenerate/export/submit/void + notifiable/birth/death notifications and audited/idempotent `recordImmunization`/`recordEyeAssessment` source commands, reporting readiness hook, MOH catalogue seeding, reports API export endpoint with checksum header (`src/lib/moh-export.ts`) and `mohMeta` letterhead metadata, statutory `/reports` sheet preview with facility/county/sub-county/ward/MFL/period header, section-grouped grid, per-cell source drill-down, Submitted By / Received By block and print-only CSS, run list/checksum/audit trail, real binary XLSX and PDF exports, and tests (`tests/moh-reporting.test.ts`, 38 passing) covering arithmetic identities, source reconciliation, 416 breakdown/drill-down and rule 12 audit/outbox/replay. Migration `0033_bored_miracleman.sql` applied locally. Fixed regenerate to preserve report_cells (no hard delete) by voiding old run and creating a new run; MFL export/preview now reads `facilityRegulatoryProfiles.kmhflId`. Full local suite green (31 files / 385 tests). Exact Discovery specimen pixel fidelity is waived because specimen PNGs are not present in the repo; authenticated UI screenshots are N/A for this backend/admin ERP phase.
- **Phase 22 — SHA / SHIF revenue cycle:** not implemented.

### Phase 12 progress (committed as `c44f9fd`)

- Added `finance_approval_limits` (facility + action + role → maximum amount, active flag) with migration `0025_spooky_ikaris.sql`, sync registration and trigger.
- Added `setFinanceApprovalLimit` (admin-only, idempotent, audited) and `listFinanceApprovalLimits` plus `/api/finance` exposure.
- Manual journal posting and reversal now enforce the configured ceiling; the applied role and limit are written to the journal audit details.
- Added an admin-only Approval limits tab in the finance workspace: enforcement state cards, role/action matrix, and a no-default form for entering facility-approved ceilings. The tab is hidden from non-admin finance users and the server still enforces admin-only writes.
- Five new tests cover configuration/replay/update/audit/outbox, non-admin rejection, posting ceilings, unconfigured roles and reversal ceilings. Full suite at that commit: 24 files / 300 tests passing.

### Phase 13 progress (shipped as `05360b0`)

- Added `submitted_by`, `approved_at` and `approved_by` to `claims` with migration `0026_breezy_korg.sql`; the preparer remains the existing `created_by` actor.
- Claim submission is refused when the actor prepared the claim; acceptance is refused when the actor prepared or submitted the claim. Accepted claims record the approver and approval timestamp.
- Pre-authorisation decisions are refused when the actor requested the authorisation.
- Remittance recording is refused when the actor prepared, submitted or approved the claim. All three actors are compared server-side from persisted claim columns, not client input.
- Resubmission rebinds the current submitter, so the next approval is checked against the latest submission.
- Existing revenue lifecycle tests now use distinct actors; six dedicated segregation-of-duties tests cover the recorded actors, each refusal path and successful hand-offs. Full suite: 24 files / 306 tests passing.

### Phase 14 progress (complete and verified)

- Added facility-scoped supplier, requisition, approval, RFQ, quote, LPO, GRN, supplier invoice, supplier payment and reorder-level tables with `0027_mixed_ironclad.sql`; all 16 tables are registered in `sync_tables` with outbox capture, 15 document tables block hard deletes, and supplier payments are append-only.
- Added `0028_supplier_payment_append_only.sql` so supplier payments get the same database-level UPDATE/DELETE guard as billing payments, with the existing test-cleanup escape hatch.
- Numbering scopes `RQ`, `RFQ`, `PO`, `GRN`, `SINV` and `SPAY` share the existing gap-free sequence; the default chart gained the `inventory` system account and existing facilities were backfilled by migration.
- Reused `runCommand`, `postJournal` and the existing `stockLedger`/`stockBalances` machinery: GRNs append stock rows and update batches; supplier invoices post inventory/AP; payments post AP/cash or AP/bank and update invoice/order status. No second mutable stock balance table was introduced.
- Enforced segregation of duties in the command layer: requisition approver ≠ requester, purchaser ≠ requester, PO approver ≠ purchaser/requester, receiver ≠ purchaser/approver, and payment recorder ≠ invoice recorder. Finance approval limits now cover `approveRequisition`, `approvePurchaseOrder` and `recordSupplierPayment`.
- Added the guarded `/api/procurement` workspace and tabbed UI for suppliers, requisitions, sourcing, orders and receiving, following the existing ERP shell and role maps.
- Added `tests/procurement.test.ts` for the full chain, three-way-match rejection, all SoD refusals, approval-limit ceilings, stock valuation, reorder alerts, AP/GL postings, append-only/no-hard-delete guards, audit and outbox rows; extended naming and sync-registry tests. Full suite result is recorded in the ship report.

### Phase 15 progress (complete and verified)

- Added `0029_quiet_meteorite.sql` with 11 HR/payroll tables, UUIDv7 keys, facility scoping, no-hard-delete triggers on every table, append-only UPDATE/DELETE guards on payroll lines, payslips and approvals, explicit sync capture, and backfill of the seven payroll system roles in the default chart. All facilities already installed received the missing payroll accounts without overwriting local chart edits.
- Added restricted `hr_officer` and `payroll_officer` roles with separate `/hr` and `/payroll` workspaces behind guarded API endpoints. Personnel data is readable only by HR, payroll and audit roles; writes remain HR/payroll only and facility/actor are injected server-side.
- HR commands cover positions, employees, contracts, shifts, attendance and leave. A new contract supersedes the prior active contract; absent/leave attendance records zero hours; leave requester ≠ decider; approved leave cannot overlap another approved period; rejected leave requires a reason.
- Payroll rates are read at run time from admin-entered `statutory_rates`; no statutory value is hard-coded. Unset rates compute zero and are carried as `missingRateTypes` warnings through the run, lines and overview. A `test_placeholder_statutory_rate` row is explicitly test-only and is never treated as a statutory rate.
- Payroll preparation uses active contracts covering the period and gap-free `EMP`, `PAY` and `PSL` numbering. Approval requires a different actor from the preparer and is capped by the `approvePayrollRun` finance approval limit for the approver's server-resolved role. Posting writes one balanced journal using the mapped salary, employer-NSSF and payable accounts, then issues append-only payslip snapshots.
- Added `tests/hr-payroll.test.ts` covering HR lifecycle and SoD, admin-rate arithmetic, missing-rate warnings, approval ceiling, balanced GL postings, payslips, audit/outbox rows and database protection guards; extended naming and sync-registry coverage. Full suite result is recorded in the ship report.

### Phase 16 progress (complete and verified)

- Added `0030_vengeful_terror.sql` with ten facility-scoped asset tables, UUIDv7 keys, indexes, explicit outbox capture, no-hard-delete triggers on every table and append-only UPDATE/DELETE guards on assignments, depreciation entries/approvals, maintenance events and asset approvals. Existing facilities were backfilled with the missing asset system accounts without overwriting their chart.
- Added the restricted `asset_manager` role and guarded `/assets` workspace with register, depreciation, maintenance and changes panels. Numbering scopes `AST`, `DEP`, `MO`, `AVL` and `DSP` share the existing gap-free sequence.
- Asset creation records the first custodian event and mirrors the current custodian/location onto the asset row. Later assignments append immutable events and update only the mirrored current state.
- Depreciation preparation computes straight-line amounts from cost, residual and accumulated depreciation; approval requires a different actor and is capped by the `approveDepreciationRun` limit for the approver's server-resolved role. Posting writes one balanced depreciation-expense/accumulated-depreciation journal and updates asset carrying values.
- Maintenance orders move through open, in-progress and completed with immutable event history. Completion posts parts and labour to maintenance expense and cash/bank/AP, returns the asset to service, and refuses a zero-cost order with no payment method.
- Revaluation, impairment and disposal use dedicated approval records, SoD and finance approval ceilings. Posting writes the required fixed-asset, reserve, impairment, proceeds, gain or loss journals and retires disposed assets without deleting history.
- Added `tests/assets.test.ts` covering register history and idempotency, depreciation SoD/limits/GL, maintenance lifecycle and GL, revaluation GL, disposal gain GL, and database/sync protection guards. Full suite: 27 files / 319 tests passing.

### Phase 17 progress (complete and verified)

- Added `0031_erp_reporting_controls.sql` with `report_saved_views` (facility-scoped, UUIDv7, owner/shared filters/columns, active flag, audit columns), sync registry/no-hard-delete trigger registration, and seeded Prompt 17 `ERP_*` report catalogue rows via idempotent upsert.
- Added `/reports` workspace guarded by `REPORT_READ_ROLES` with report catalogue, date/as-of filters, saved views, CSV export, approval inbox, report snapshot generation, and drill-down to source journal lines and audit trail.
- Added `src/server/queries/reporting.ts` and `src/server/commands/reporting.ts` for ERP report data assembly, catalogue ensure/upsert, saved-view/report-run commands, export marking, and audit/event capture through the idempotent command layer.
- ERP report coverage includes financial statements, trial balance, supplier ageing, claim ageing, stock valuation, budget variance, payroll summary, and approval inbox. Existing Prompt 20 statutory report catalogue remains separate.
- Added `tests/erp-reporting.test.ts` and updated `tests/reporting.test.ts` and `tests/helpers.ts`. Local verification: typecheck, lint, build passed; required local full test run `318 passed | 3 failed (321)` with 3 pre-existing/environment failures (`doctor.test.ts` ICD-10 search flake in full suite, passed in isolation; 2 `regulatory-placeholders.test.ts` failures caused by stale local TEST regulatory profile row, cleared and both passed in isolation). Screenshots/changelog: N/A for authenticated backend/admin ERP phase.

## Phase 0 — Initial Configuration (First-Run Setup)

**Status:** Complete and verified (2026-11-22)
**Priority:** High — required for clean first-time installation.
**Placement:** Prerequisite to normal use; runs before the standard login workflow is usable.

### Progress

- Added `super_admin` to `staff_role` schema/enum, RBAC admin-like checks, admin guards/APIs, navigation, shell role maps, and assignable role handling; admin staff commands reject `super_admin` assignment unless the actor is a super admin.
- Extended tenancy schema/admin commands for facility registration details, physical address, logo/branding URL, currency, timezone, write authority; branch physical location, telephone, and optional manager name. Generated and applied migration `drizzle/0032_foamy_mole_man.sql` locally.
- Implemented first-run bootstrap command `bootstrapFirstRun`/`getFirstRunStatus` with idempotent replay, single transaction, command log/audit, super admin + Better Auth credential + staff profile + all admin section permissions, facility/branch creation, default chart/cost center, and regulatory defaults.
- Added install script `npm run setup:first-run -- --config <path>` (JSON config, non-secret summary output) and guided wizard at `/setup` with Admin/Facility/Branches/Review steps. `/login` redirects to `/setup` when first-run is required; `/setup` redirects to `/login` when complete.
- Added `tests/bootstrap.test.ts` covering status guard, schema validation, fresh-DB bootstrap/idempotency/audit/command log/field persistence, and setup API 409 behavior when installed. Full local gates: typecheck pass, lint pass, build pass, `npm test` with required local DB env 327 passed / 1 failed (328) - only known full-suite flake `tests/doctor.test.ts` "searches ICD-10 by code prefix and description substring", passes in isolation. Screenshots/changelog N/A for authenticated backend/admin phase.

### Goal

Provide a guided first-run setup that creates the first super administrator, registers the hospital/facility, configures one or more branches, reviews everything before saving, then commits the records and redirects to the normal login page.

### Required steps

1. **Create the System Administrator**
   - Full name
   - Email address
   - Password and confirmation
   - Phone number

   This becomes the first super administrator.

2. **Register the Hospital / Facility**
   - Hospital name
   - Registration details
   - Physical address
   - Contact information
   - Logo and branding
   - Time zone and currency

3. **Configure Branches**
   - Branch name
   - Branch code
   - Physical location
   - Telephone number
   - Branch manager (optional)

   Allow multiple branches to be added during setup.

4. **Review and Confirm**

   Display a summary of the administrator, facility and branches before saving.

5. **Complete Installation**

   Create the records, assign permissions, and redirect to the normal login page.

### Acceptance criteria

- The setup wizard is available only when no facility and no super administrator exist.
- Administrator name, email, password confirmation and phone number are validated; the password is hashed and never stored or displayed in plain text.
- Facility registration captures all listed fields, including time zone and currency, with admin-entered values only.
- Branch setup supports adding, editing and removing multiple branches before completion.
- The review step shows a clear summary of all entered data and allows the user to go back and correct it.
- Completion creates the administrator, facility and branch records through a server-side command with an idempotency key, one transaction, an audit row and outbox/sync rows where applicable.
- The first administrator receives the super-administrator role and full required permissions.
- On success, the user is redirected to `/login`; the wizard cannot be re-run after installation.
- UI follows the existing Varian palette and uses the installed UI/UX skills before implementation.
- Later changes to the administrator, facility or branches go through the normal admin workflows, not the first-run wizard.

### Open implementation notes

- Logo/branding needs a storage decision: the app currently has no document-upload/storage flow. Until that exists, use a URL or document reference field and do not imply that files are stored.
- Registration details and any regulatory identifiers must be admin-entered. Do not guess or hard-code unconfirmed regulator values.
- Any default data used for testing must be labelled as test-only and must not be presented as compliance evidence.
