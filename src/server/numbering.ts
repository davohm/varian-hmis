import { sql, type SQL } from "drizzle-orm";

export type DbExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

export type NumberScope =
  | "mrn"
  | "encounter"
  | "invoice"
  | "receipt"
  | "sample"
  | "journal"
  | "claim"
  | "preauth"
  | "remittance"
  | "requisition"
  | "rfq"
  | "purchaseOrder"
  | "goodsReceipt"
  | "supplierInvoice"
  | "supplierPayment"
  | "employee"
  | "payrollRun"
  | "payslip"
  | "breach";

const scopeFormat: Record<NumberScope, { infix: string; width: number }> = {
  mrn: { infix: "", width: 5 },
  encounter: { infix: "E", width: 6 },
  invoice: { infix: "I", width: 6 },
  receipt: { infix: "R", width: 6 },
  sample: { infix: "S", width: 6 },
  journal: { infix: "J", width: 6 },
  claim: { infix: "C", width: 6 },
  preauth: { infix: "PA", width: 6 },
  remittance: { infix: "RM", width: 6 },
  requisition: { infix: "RQ", width: 6 },
  rfq: { infix: "RFQ", width: 5 },
  purchaseOrder: { infix: "PO", width: 6 },
  goodsReceipt: { infix: "GRN", width: 5 },
  supplierInvoice: { infix: "SINV", width: 5 },
  supplierPayment: { infix: "SPAY", width: 5 },
  employee: { infix: "EMP", width: 5 },
  payrollRun: { infix: "PAY", width: 6 },
  payslip: { infix: "PSL", width: 6 },
  breach: { infix: "BR", width: 5 },
};

function readValue(result: unknown): number {
  const rows = (result as { rows?: Array<{ value?: number | string }> }).rows;
  const value = rows?.[0]?.value;
  if (value === undefined || value === null) {
    throw new Error("next_number() returned no value");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid next_number() value: ${String(value)}`);
  }
  return parsed;
}

/**
 * Allocate the next gap-free number inside the caller's transaction.
 * The PostgreSQL function performs the locking upsert atomically.
 */
export async function allocateNumber(
  db: DbExecutor,
  facilityId: string,
  scope: NumberScope | string,
): Promise<number> {
  if (!facilityId) throw new Error("facilityId is required");
  if (!scope) throw new Error("scope is required");

  const result = await db.execute(
    sql`SELECT next_number(${facilityId}::uuid, ${scope}::text) AS value`,
  );
  return readValue(result);
}

export const nextNumber = allocateNumber;

export function formatNumber(
  facilityCode: string,
  scope: NumberScope,
  value: number,
  date: Date = new Date(),
): string {
  const config = scopeFormat[scope];
  const year = String(date.getFullYear()).slice(-2);
  const core = config.infix
    ? `${facilityCode}-${config.infix}-${year}`
    : `${facilityCode}-${year}`;
  return `${core}-${String(value).padStart(config.width, "0")}`;
}

export async function nextFormattedNumber(
  db: DbExecutor,
  facility: { id: string; code: string },
  scope: NumberScope,
  prefix?: string,
): Promise<string> {
  const value = await allocateNumber(db, facility.id, scope);
  return formatNumber(prefix?.trim() || facility.code, scope, value);
}
