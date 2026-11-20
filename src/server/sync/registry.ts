/**
 * Explicit allow-lists for every table the sync engine may touch. SQL triggers
 * read the same list from sync_tables; keeping the names as literals here means
 * dynamic table identifiers can never come from an HTTP request.
 */

export const SYNC_OUTBOUND_TABLES = [
  "facilities",
  "branches",
  "departments",
  "rooms",
  "stores",
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
  "services",
  "price_lists",
  "prices",
  "charges",
  "invoices",
  "payments",
  "cashier_sessions",
  "audit_log",
  "number_sequences",
  "data_consents",
  "data_subject_requests",
  "data_breaches",
  "retention_policies",
  "data_sharing_agreements",
  "transfer_assessments",
  "chart_access_log",
] as const;

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
] as const;

export const SYNC_BUSINESS_KEY_TABLES = {
  number_sequences: ["facility_id", "scope", "year"],
} as const;

export const SYNC_TABLE_NAMES = [
  ...new Set([...SYNC_OUTBOUND_TABLES, ...SYNC_INBOUND_TABLES]),
] as const;

export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

const outbound = new Set<string>(SYNC_OUTBOUND_TABLES);
const inbound = new Set<string>(SYNC_INBOUND_TABLES);
const appendOnly = new Set<string>(SYNC_APPEND_ONLY_TABLES);

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

export function facilityColumnForTable(tableName: string): string | null {
  if (tableName === "facilities") return "id";
  if (["user", "account", "staff_profiles"].includes(tableName)) return null;
  return "facility_id";
}
