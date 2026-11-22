# Varian HMIS — Implementation Plan

Status recorded in the working tree on 2026-11-22. Phase 12 is committed and deployed as `c44f9fd`; Phase 13 changes are not yet committed.

## Current phase status

| Status | Phases |
|---|---|
| Complete | 1–13, 19, 21 |
| Partial | 17, 18, 20 |
| Missing | 14, 15, 16, 22 |
| New / pending | Phase 0 — Initial Configuration |

### Outstanding work summary

- **Phase 12 — Finance foundation:** complete and deployed as `c44f9fd` — ledger, journals, reversal, periods, statements and data-driven approval limits by facility/role/action with an admin-only configuration panel, audit and sync rows. Migration `0025_spooky_ikaris.sql` has been applied to production Neon and the local FAM branch database; it must be applied to every other target database before enforcement is relied on there.
- **Phase 13 — Revenue cycle:** complete in the working tree — payers, contracts, benefits, pre-authorisations, claims, claim lines, remittances and denials, with command-layer segregation of duties enforced by actor identity. Migration `0026_breezy_korg.sql` has been applied to the local dev database and must be applied to every other target database before the new actor columns are relied on there.
- **Phase 14 — Procurement and inventory:** not implemented.
- **Phase 15 — HR and payroll:** not implemented.
- **Phase 16 — Assets and maintenance:** not implemented.
- **Phase 17 — ERP reporting and controls:** report catalogue, saved views, exports, approval inbox, drill-down, supplier ageing, stock valuation and payroll summaries are missing.
- **Phase 18 — Kenya master data / licences / IDs:** implementation exists, but the dedicated 19-rule test suite is missing and the reporting hook depends on Phase 20.
- **Phase 20 — MOH statutory reporting:** schema and helpers exist, but reporting commands/queries, `/reports` UI, MOH row generators, export/submit/void and drill-down are missing.
- **Phase 22 — SHA / SHIF revenue cycle:** not implemented.

### Phase 12 progress (committed as `c44f9fd`)

- Added `finance_approval_limits` (facility + action + role → maximum amount, active flag) with migration `0025_spooky_ikaris.sql`, sync registration and trigger.
- Added `setFinanceApprovalLimit` (admin-only, idempotent, audited) and `listFinanceApprovalLimits` plus `/api/finance` exposure.
- Manual journal posting and reversal now enforce the configured ceiling; the applied role and limit are written to the journal audit details.
- Added an admin-only Approval limits tab in the finance workspace: enforcement state cards, role/action matrix, and a no-default form for entering facility-approved ceilings. The tab is hidden from non-admin finance users and the server still enforces admin-only writes.
- Five new tests cover configuration/replay/update/audit/outbox, non-admin rejection, posting ceilings, unconfigured roles and reversal ceilings. Full suite at that commit: 24 files / 300 tests passing.

### Phase 13 progress (uncommitted)

- Added `submitted_by`, `approved_at` and `approved_by` to `claims` with migration `0026_breezy_korg.sql`; the preparer remains the existing `created_by` actor.
- Claim submission is refused when the actor prepared the claim; acceptance is refused when the actor prepared or submitted the claim. Accepted claims record the approver and approval timestamp.
- Pre-authorisation decisions are refused when the actor requested the authorisation.
- Remittance recording is refused when the actor prepared, submitted or approved the claim. All three actors are compared server-side from persisted claim columns, not client input.
- Resubmission rebinds the current submitter, so the next approval is checked against the latest submission.
- Existing revenue lifecycle tests now use distinct actors; six dedicated segregation-of-duties tests cover the recorded actors, each refusal path and successful hand-offs. Full suite: 24 files / 306 tests passing.

## Phase 0 — Initial Configuration (First-Run Setup)

**Status:** Pending
**Priority:** High — required for clean first-time installation.
**Placement:** Prerequisite to normal use; runs before the standard login workflow is usable.

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
