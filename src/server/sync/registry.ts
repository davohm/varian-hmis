/**
 * Explicit allow-lists for every table the sync engine may touch. SQL triggers
 * read the same list from sync_tables; keeping the names as literals here means
 * dynamic table identifiers can never come from an HTTP request.
 *
 * SYNC_OUTBOUND_TABLES must stay identical to the set of sync_tables rows with
 * capture = true. tests/sync.test.ts asserts that invariant so schema and code
 * cannot drift apart silently.
 */

export const SYNC_OUTBOUND_TABLES = [
  // Tenancy and setup
  "facilities",
  "branches",
  "departments",
  "rooms",
  "stores",
  "devices",
  "facility_settings",
  "facility_identifiers",
  "facility_licences",
  "facility_regulatory_profiles",
  "support_service_licences",
  "licence_alert_rules",
  "statutory_rates",
  "statutory_fee_schedules",
  "sha_adjudication_codes",
  "integration_settings",
  "admin_section_permissions",
  // Patients and clinical
  "patients",
  "next_of_kin",
  "encounters",
  "queue_entries",
  "triage_vitals",
  "clinical_notes",
  "diagnoses",
  "lab_tests",
  "lab_orders",
  "lab_order_items",
  "lab_results",
  "items",
  "item_batches",
  "stock_ledger",
  "prescriptions",
  "dispenses",
  // Billing and revenue
  "services",
  "price_lists",
  "prices",
  "charges",
  "invoices",
  "payments",
  "cashier_sessions",
  "payers",
  "payer_contracts",
  "payer_benefits",
  "claims",
  "claim_lines",
  "claim_denials",
  "pre_authorizations",
  "remittances",
  "etims_invoice_queue",
  "etims_invoice_lines",
  "etims_outbox",
  "etims_transmission_log",
  "tax_codes",
  "tax_code_applicabilities",
  // Finance and reporting
  "ledger_accounts",
  "cost_centers",
  "fiscal_periods",
  "journal_entries",
  "journal_lines",
  "bank_accounts",
  "bank_transactions",
  "bank_reconciliations",
  "budgets",
  "budget_lines",
  "finance_approval_limits",
  // Procurement and inventory
  "suppliers",
  "purchase_requisitions",
  "purchase_requisition_lines",
  "purchase_requisition_approvals",
  "rfqs",
  "rfq_lines",
  "supplier_quotes",
  "supplier_quote_lines",
  "purchase_orders",
  "purchase_order_lines",
  "goods_receipts",
  "goods_receipt_lines",
  "supplier_invoices",
  "supplier_invoice_lines",
  "supplier_payments",
  "reorder_levels",
  // HR and payroll
  "employees",
  "positions",
  "employment_contracts",
  "shift_templates",
  "shift_assignments",
  "attendance_records",
  "leave_requests",
  "payroll_runs",
  "payroll_lines",
  "payslips",
  "payroll_run_approvals",
  // Assets, depreciation, maintenance and disposal history.
  "assets",
  "asset_assignments",
  "depreciation_runs",
  "depreciation_entries",
  "depreciation_run_approvals",
  "maintenance_orders",
  "maintenance_events",
  "asset_valuations",
  "asset_disposals",
  "asset_approvals",
  "report_definitions",
  "report_runs",
  "report_cells",
  "birth_notifications",
  "death_notifications",
  "notifiable_events",
  // Privacy and audit
  "audit_log",
  "number_sequences",
  "data_consents",
  "data_subject_requests",
  "data_breaches",
  "retention_policies",
  "data_sharing_agreements",
  "transfer_assessments",
  "chart_access_log",
  "practitioner_registrations",
  "admin_overrides",
] as const;

/**
 * Cloud-owned tables pulled by every clinic. Staff/auth rows are scoped by the
 * facility's staff_role_scopes in pull.ts, never pulled facility-agnostically.
 */
export const SYNC_INBOUND_TABLES = [
  "facilities",
  "branches",
  "stores",
  "items",
  "lab_tests",
  "services",
  "price_lists",
  "prices",
  "user",
  "account",
  "staff_profiles",
  "staff_role_scopes",
] as const;

export const SYNC_APPEND_ONLY_TABLES = [
  "audit_log",
  "dispenses",
  "payments",
  "stock_ledger",
  "chart_access_log",
  "journal_entries",
  "journal_lines",
  "remittances",
  "bank_transactions",
  "etims_invoice_lines",
  "etims_transmission_log",
  "supplier_payments",
  "payroll_lines",
  "payslips",
  "payroll_run_approvals",
  "asset_assignments",
  "depreciation_entries",
  "depreciation_run_approvals",
  "maintenance_events",
  "asset_approvals",
] as const;

/**
 * Tables holding clinical, financial, regulatory or audit history. Rows are
 * retired with a status change, a void/reversal entry, or a newer version;
 * a physical DELETE is never a valid lifecycle event for them.
 *
 * Keep this list identical to the sync_tables.no_hard_delete flags installed
 * by the SQL migrations. Draft/setup tables such as budget_lines are excluded
 * because replacing draft lines is a normal reversible edit.
 */
export const SYNC_NO_HARD_DELETE_TABLES = [
  // Patient chart and clinical record chain
  "patients",
  "next_of_kin",
  "encounters",
  "queue_entries",
  "triage_vitals",
  "clinical_notes",
  "diagnoses",
  "lab_orders",
  "lab_order_items",
  "lab_results",
  "prescriptions",
  "dispenses",
  "item_batches",
  // Billing and revenue cycle
  "charges",
  "invoices",
  "payments",
  "cashier_sessions",
  "claims",
  "claim_lines",
  "claim_denials",
  "pre_authorizations",
  "remittances",
  // Stock, finance, tax and reporting trails
  "stock_ledger",
  "journal_entries",
  "journal_lines",
  "bank_transactions",
  "bank_reconciliations",
  "etims_invoice_queue",
  "etims_invoice_lines",
  "etims_outbox",
  "etims_transmission_log",
  "report_runs",
  "report_cells",
  // Privacy, audit and regulatory evidence
  "audit_log",
  "chart_access_log",
  "data_consents",
  "data_subject_requests",
  "data_breaches",
  "transfer_assessments",
  "data_sharing_agreements",
  "retention_policies",
  "birth_notifications",
  "death_notifications",
  "notifiable_events",
  "facility_licences",
  // Procurement document history; use status changes and reversals, not DELETE.
  "purchase_requisitions",
  "purchase_requisition_lines",
  "purchase_requisition_approvals",
  "rfqs",
  "rfq_lines",
  "supplier_quotes",
  "supplier_quote_lines",
  "purchase_orders",
  "purchase_order_lines",
  "goods_receipts",
  "goods_receipt_lines",
  "supplier_invoices",
  "supplier_invoice_lines",
  "supplier_payments",
  "reorder_levels",
  // Personnel and payroll history; retire by status, never delete.
  "employees",
  "positions",
  "employment_contracts",
  "shift_templates",
  "shift_assignments",
  "attendance_records",
  "leave_requests",
  "payroll_runs",
  "payroll_lines",
  "payslips",
  "payroll_run_approvals",
  // Asset register and lifecycle history; retire by status, never delete.
  "assets",
  "asset_assignments",
  "depreciation_runs",
  "depreciation_entries",
  "depreciation_run_approvals",
  "maintenance_orders",
  "maintenance_events",
  "asset_valuations",
  "asset_disposals",
  "asset_approvals",
] as const;

export const SYNC_BUSINESS_KEY_TABLES = {
  facility_regulatory_profiles: ["facility_id"],
  number_sequences: ["facility_id", "scope", "year"],
} as const;

export const SYNC_TABLE_NAMES = [
  ...new Set([...SYNC_OUTBOUND_TABLES, ...SYNC_INBOUND_TABLES]),
] as const;

export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

const outbound = new Set<string>(SYNC_OUTBOUND_TABLES);
const inbound = new Set<string>(SYNC_INBOUND_TABLES);
const appendOnly = new Set<string>(SYNC_APPEND_ONLY_TABLES);
const noHardDelete = new Set<string>(SYNC_NO_HARD_DELETE_TABLES);

export function isSyncTableName(value: string): value is SyncTableName {
  return (SYNC_TABLE_NAMES as readonly string[]).includes(value);
}

export function isOutboundSyncTable(value: string): boolean {
  return outbound.has(value);
}

export function isInboundSyncTable(value: string): boolean {
  return inbound.has(value);
}

export function isAppendOnlySyncTable(value: string): boolean {
  return appendOnly.has(value);
}

export function isNoHardDeleteSyncTable(value: string): boolean {
  return noHardDelete.has(value);
}

/** Auth/staff tables intentionally cannot be pushed from a clinic. */
export function facilityColumnForTable(tableName: string): string | null {
  if (tableName === "facilities") return "id";
  if (["user", "account", "staff_profiles"].includes(tableName)) return null;
  return "facility_id";
}
