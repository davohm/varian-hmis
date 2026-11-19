# 09 — ERP Scope and Delivery Roadmap

## 1. Purpose

Varian HMIS is a clinical and ERP platform. The ERP scope extends the existing clinical system with the business capabilities a Kenyan facility needs to run safely and account for money, stock, people and assets. It is not a separate product and must not bypass the clinical architecture.

The ERP build follows the same rules as V1:

- Every operational row carries `facility_id`.
- Every write goes through a server-side command with an idempotency key, one transaction, an audit row and an outbox row.
- Financial and stock records are append-only. Corrections use reversals, never hard deletes.
- Number sequences are allocated by the facility's write authority only.
- Access is scoped by facility, branch, department and, where relevant, store or cost centre.
- ERP data must sync between clinic and cloud with the same zero-duplicate guarantees as clinical data.

## 2. ERP capability map

| Domain | Required capabilities | Primary users |
|---|---|---|
| Finance and accounting | Chart of accounts, journals, general ledger, trial balance, financial periods, cost centres, budgets, bank accounts, bank reconciliation, petty cash, accounts receivable, accounts payable, tax and eTIMS integration | accountant, finance officer, auditor |
| Revenue cycle | Payer contracts, price lists, pre-authorisation, claims, claim lines, remittances, denials, patient debtors, statements, refunds and waivers | revenue-cycle officer, cashier, finance officer |
| Procurement and inventory | Requisitions, approvals, RFQ, supplier quotes, LPOs, goods received notes, supplier invoices, returns, stock transfers, reorder levels, stock takes, valuation, batch and expiry control | procurement officer, store manager, pharmacy manager |
| HR and payroll | Employee master, contracts, positions, attendance, shifts and duty rota, leave, payroll runs, statutory deductions, payslips and cost allocation | HR officer, payroll officer |
| Assets and maintenance | Asset register, assignment, location, depreciation, maintenance schedules, service history, revaluation and disposal | asset manager, finance officer |
| Management reporting | Financial statements, budget variance, payer ageing, supplier ageing, stock valuation, payroll summaries, ERP dashboards and drill-down reports | managers, auditors, directors |

## 3. Domain requirements

### 3.1 Finance and accounting

- Maintain a chart of accounts with account codes, types, normal balances and active status.
- Support journals with debit and credit lines, dimensions (facility, branch, department, cost centre), references and attachments.
- Post only to open financial periods. Closing a period must be an audited command.
- Produce a trial balance, general ledger, income statement, balance sheet and cash-flow view from posted journals.
- Support bank accounts, bank transactions, reconciliation sessions and unreconciled-item reports.
- Support petty cash floats, requests, approvals, disbursements, retirements and reconciliations.
- Support accounts receivable and payable with ageing, statements and settlement allocation.
- Support budgets by period and cost centre, with budget-vs-actual reporting.
- Support tax codes and KRA eTIMS invoice signing as an integration boundary.
- Never allow editing or deleting a posted journal. Reverse it with a linked reversal entry.

### 3.2 Revenue cycle and insurance

- Maintain payers, schemes, corporate clients, contracts, benefit limits and member/card details.
- Support payer-specific price lists and service coverage rules.
- Support pre-authorisation requests, approvals, references and expiry.
- Build claims from encounters, invoices, diagnoses, procedures and supporting documents.
- Track claim lifecycle: draft, submitted, accepted, queried, rejected, resubmitted, paid and closed.
- Record remittances and allocate them to claim lines and invoices.
- Track denials and rework reasons.
- Support patient debtors, statements, refunds, waivers and exemptions with approval trails.
- Keep clinical, billing and claim records linked but independently auditable.

### 3.3 Procurement and inventory

- Support purchase requisitions with requesting department, justification, line items and approval thresholds.
- Support RFQs, supplier quotes, comparison and supplier selection.
- Support LPOs, goods received notes, supplier invoices and three-way matching.
- Extend the existing append-only stock ledger; do not create a second stock source of truth.
- Support stock transfers, adjustments, returns, stock takes and reorder levels.
- Track batch numbers, expiry dates and unit costs.
- Produce stock valuation, reorder, expiry, slow-moving and variance reports.
- Enforce segregation of duties: requester, approver, purchaser and receiver must not be the same person where thresholds require separation.

### 3.4 HR and payroll

- Maintain employees, positions, departments, contracts, identifiers and bank details.
- Maintain shift templates, duty rota, attendance and leave.
- Support payroll runs with earnings, deductions, statutory contributions, employer costs and cost-centre allocation.
- Produce payslips and payroll summaries.
- Keep payroll data access tightly restricted and audited.
- Support integration with an external payroll provider where statutory calculations are better maintained outside the app.

### 3.5 Assets and maintenance

- Maintain an asset register with category, tag, serial number, location, custodian, acquisition cost and useful life.
- Support assignment, transfer and return.
- Calculate and post depreciation entries without deleting historical entries.
- Schedule preventive maintenance, record work orders, parts and service history.
- Support revaluation, impairment and disposal with approval and audit.

### 3.6 Management reporting

- Provide a report catalogue grouped by finance, revenue cycle, procurement, inventory, HR, assets and statutory returns.
- Every report must support facility, branch, department, period and relevant status filters.
- Support saved views, export to CSV/Excel/PDF and print-friendly layouts.
- Provide drill-down from summary figures to source transactions.
- Provide an approvals inbox and an audit activity view for managers.
- Kenya statutory reports remain first-class: MOH returns, IDSR, immunisation, eye clinic, workload and claims reports must be generated from structured operational data rather than re-keyed.

## 4. Roles and segregation of duties

Add these ERP roles alongside the existing clinical roles:

- `accountant`
- `finance_officer`
- `revenue_cycle_officer`
- `procurement_officer`
- `store_manager`
- `hr_officer`
- `payroll_officer`
- `asset_manager`
- `auditor`

Rules:

- A user may hold multiple roles and scopes, as with clinical staff.
- Approval limits are data-driven by role, amount and facility.
- The same user cannot both prepare and approve a payment, payroll run or high-value purchase.
- Auditors get read-only access to ledgers, approvals and audit trails.
- Every approval and rejection is audited with reason and timestamp.

## 5. Shared data model additions

Names are indicative; final migrations must follow the conventions in `03-database-schema.md`.

### Finance

- `ledger_accounts`
- `fiscal_periods`
- `journal_batches`
- `journal_lines`
- `cost_centers`
- `budgets`
- `bank_accounts`
- `bank_transactions`
- `bank_reconciliations`
- `petty_cash_floats`
- `petty_cash_transactions`

### Revenue cycle

- `payers`
- `payer_contracts`
- `payer_benefits`
- `pre_authorizations`
- `claims`
- `claim_lines`
- `remittances`
- `claim_denials`

### Procurement and inventory

- `suppliers`
- `purchase_requisitions`
- `purchase_requisition_lines`
- `rfqs`
- `supplier_quotes`
- `purchase_orders`
- `purchase_order_lines`
- `goods_receipts`
- `goods_receipt_lines`
- `supplier_invoices`
- `supplier_payments`

Existing `stock_ledger`, `stock_balances`, `items`, `item_batches` and `stores` remain the stock source of truth.

### HR and payroll

- `employees`
- `employment_contracts`
- `positions`
- `attendance_records`
- `shift_assignments`
- `leave_requests`
- `payroll_runs`
- `payslips`
- `payroll_lines`

### Assets

- `assets`
- `asset_assignments`
- `depreciation_entries`
- `maintenance_orders`
- `maintenance_events`

## 6. Delivery phases

### ERP-1 — Finance foundation and revenue cycle

Chart of accounts, journals, general ledger, fiscal periods, cost centres, trial balance, bank accounts and reconciliation, payers, pre-authorisation, claims and remittances.

**Exit criteria:** a cash and insurance encounter can produce an invoice, claim, journal posting and trial balance without manual re-entry.

### ERP-2 — Procurement and inventory

Requisitions, approvals, RFQ, LPO, goods received, supplier invoices, payments, returns, stock transfers, reorder levels, stock takes and valuation.

**Exit criteria:** a purchase from requisition to payment updates stock, supplier balance and general ledger in one auditable chain.

### ERP-3 — HR and payroll

Employee master, contracts, attendance, shifts, leave, payroll runs, statutory deductions, payslips and cost allocation.

**Exit criteria:** a payroll run produces payslips, statutory summaries, cost-centre postings and an audited approval trail.

### ERP-4 — Assets and maintenance

Asset register, assignment, depreciation, maintenance schedules, work orders and disposal.

**Exit criteria:** an asset can be acquired, assigned, depreciated, maintained and disposed of with a complete audit history.

### ERP-5 — Management reporting and controls

Financial statements, budget variance, ageing, stock valuation, payroll summaries, approval dashboards and drill-down reporting.

**Exit criteria:** managers can move from an ERP summary figure to the underlying transactions and audit trail.

## 7. UI/UX requirements

- Use role-based workspaces and task-first navigation, not a mega-menu of every ERP function.
- Use a persistent approvals inbox with clear status, amount, requester, age and next action.
- Use consistent data tables with saved filters, column selection and export.
- Use clear document states and immutable-document indicators.
- Use inline validation and confirmation for irreversible or high-value actions.
- Use print-ready documents for invoices, receipts, LPOs, GRNs, payslips and statements.
- Use accessible, responsive layouts and preserve the Varian palette.
- Before implementing any UI or UX, load the relevant installed OpenCode skill(s) as required by `AGENTS.md`.

## 8. Build sequence after V1

Run these prompts one at a time after V1 passes its full verification.

### Prompt 12 — Finance foundation

Add ledger accounts, fiscal periods, journals, journal lines, cost centres and the posting command. Implement trial balance and general ledger queries. Add finance roles, approval limits and tests for period close, reversal and balanced journals.

### Prompt 13 — Revenue cycle

Add payers, contracts, benefits, pre-authorisations, claims, claim lines, remittances and denials. Connect claims to encounters, invoices and payments. Add claim-lifecycle tests and segregation-of-duties tests.

### Prompt 14 — Procurement and inventory

Add suppliers, requisitions, approvals, RFQs, LPOs, goods receipts, supplier invoices and payments. Extend the existing stock ledger. Add three-way matching, reorder and valuation tests.

### Prompt 15 — HR and payroll

Add employees, contracts, attendance, shifts, leave, payroll runs, payslips and payroll lines. Add statutory summaries, cost-centre allocation, restricted access and approval tests.

### Prompt 16 — Assets and maintenance

Add assets, assignments, depreciation entries, maintenance orders and disposal. Add depreciation and audit-history tests.

### Prompt 17 — ERP reporting and controls

Add the report catalogue, saved views, exports, approval dashboards and drill-down. Add financial statements, ageing, stock valuation and budget-variance reports.

## 9. Non-negotiable acceptance

- V1 clinical acceptance criteria continue to pass.
- No ERP write bypasses a command, audit row or outbox row.
- No posted financial entry can be edited or deleted.
- Stock balances are derived only from the append-only stock ledger.
- Claims and payments are traceable to their source encounters and invoices.
- Payroll and high-value payments require separation of duties.
- Closed periods reject new postings.
- ERP reports reconcile to the general ledger, stock ledger and source documents.
- UI work follows the installed UI/UX skills and the Varian design system.
