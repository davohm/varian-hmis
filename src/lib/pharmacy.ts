/** Shared pharmacy and stock rules used by commands, queries and the workspace. */

import type { PrescriptionStatus } from "./clinical";

export const STOCK_REASONS = [
  "receive",
  "dispense",
  "adjust",
  "transfer_in",
  "transfer_out",
  "reversal",
] as const;

export type StockReason = (typeof STOCK_REASONS)[number];

export const STOCK_REASON_LABELS: Record<StockReason, string> = {
  receive: "Received",
  dispense: "Dispensed",
  adjust: "Adjusted",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  reversal: "Reversal",
};

/** Positive reasons add stock; negative reasons remove it. `adjust` may do either. */
export const STOCK_REASON_DIRECTION: Record<StockReason, "in" | "out" | "both"> = {
  receive: "in",
  dispense: "out",
  adjust: "both",
  transfer_in: "in",
  transfer_out: "out",
  reversal: "in",
};

/** Prescriptions in these states still have quantity left to dispense. */
export const DISPENSABLE_PRESCRIPTION_STATUSES: readonly PrescriptionStatus[] = [
  "prescribed",
  "partial",
];

export function canDispensePrescription(status: PrescriptionStatus): boolean {
  return status === "prescribed" || status === "partial";
}

/** Only a prescription that actually took stock can be reversed. */
export function canReverseDispense(status: PrescriptionStatus): boolean {
  return status === "partial" || status === "dispensed";
}

export function remainingQuantity(prescribed: number, dispensed: number): number {
  return Math.max(0, prescribed - dispensed);
}

/** Dispensing any amount moves the prescription to `partial`; the full amount closes it. */
export function prescriptionStatusAfterDispense(
  prescribed: number,
  dispensed: number,
): PrescriptionStatus {
  if (dispensed <= 0) return "prescribed";
  return dispensed >= prescribed ? "dispensed" : "partial";
}

export function toIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A batch is expired from the day after its expiry date, matching FEFO practice. */
export function isBatchExpired(
  expiryDate: string | null | undefined,
  today: Date = new Date(),
): boolean {
  if (!expiryDate) return false;
  return expiryDate < toIsoDate(today);
}

export interface BatchCandidate {
  id: string;
  batchNo: string;
  expiryDate: string | null;
  createdAt: string;
}

/**
 * First-expired-first-out. A batch with no expiry sorts after dated batches;
 * ties break on arrival time and then id so every station locks in the same
 * order (which is what keeps concurrent dispenses deadlock-free).
 */
export function compareFefo(a: BatchCandidate, b: BatchCandidate): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortFefo<T extends BatchCandidate>(batches: T[]): T[] {
  return [...batches].sort(compareFefo);
}

export interface AvailableBatch {
  batchId: string;
  available: number;
}

/** Greedily take from FEFO-ordered batches until `quantity` is covered. */
export function allocateFefo(
  batches: readonly AvailableBatch[],
  quantity: number,
): Array<{ batchId: string; quantity: number }> {
  const allocations: Array<{ batchId: string; quantity: number }> = [];
  let left = quantity;
  for (const batch of batches) {
    if (left <= 0) break;
    if (batch.available <= 0) continue;
    const take = Math.min(batch.available, left);
    allocations.push({ batchId: batch.batchId, quantity: take });
    left -= take;
  }
  return allocations;
}

export function sumAllocations(
  allocations: ReadonlyArray<{ quantity: number }>,
): number {
  return allocations.reduce((total, allocation) => total + allocation.quantity, 0);
}

/** Printable label content returned by a dispense so any station can reprint it. */
export interface DispenseLabel {
  facilityName: string;
  patientName: string;
  mrn: string;
  encounterNo: string;
  itemName: string;
  strength: string | null;
  form: string | null;
  unit: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number;
  instructions: string | null;
  dispensedAt: string;
  prescriptionId: string;
  pharmacist: string;
}

export interface DispenseLabelInput {
  facilityName: string;
  patientName: string;
  mrn: string;
  encounterNo: string;
  itemName: string;
  strength: string | null;
  form: string | null;
  unit: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number;
  instructions: string | null;
  dispensedAt: Date;
  prescriptionId: string;
  pharmacist: string;
}

export function buildDispenseLabel(input: DispenseLabelInput): DispenseLabel {
  return {
    facilityName: input.facilityName,
    patientName: input.patientName,
    mrn: input.mrn,
    encounterNo: input.encounterNo,
    itemName: input.itemName,
    strength: input.strength,
    form: input.form,
    unit: input.unit,
    dose: input.dose,
    route: input.route,
    frequency: input.frequency,
    durationDays: input.durationDays,
    quantity: input.quantity,
    instructions: input.instructions,
    dispensedAt: input.dispensedAt.toISOString(),
    prescriptionId: input.prescriptionId,
    pharmacist: input.pharmacist,
  };
}

/** `Paracetamol — 500 mg (Tablet)` — the same shape the doctor catalogue uses. */
export function itemDisplayName(item: {
  name: string;
  strength: string | null;
  form: string | null;
}): string {
  if (item.strength && item.form) return `${item.name} — ${item.strength} (${item.form})`;
  if (item.strength) return `${item.name} — ${item.strength}`;
  if (item.form) return `${item.name} (${item.form})`;
  return item.name;
}
