/** Shared laboratory rules used by the lab commands, queries and workspace. */

import type { LabParameter } from "@/server/db/schema/clinical";

export const LAB_FLAGS = ["N", "H", "L", "HH", "LL"] as const;
export type LabFlag = (typeof LAB_FLAGS)[number];

export type LabOrderStatus =
  | "ordered"
  | "collected"
  | "in_progress"
  | "resulted"
  | "verified"
  | "cancelled";

export const LAB_ORDER_STATUS_LABELS: Record<string, string> = {
  ordered: "Ordered",
  collected: "Sample collected",
  in_progress: "In progress",
  resulted: "Resulted",
  verified: "Verified",
  cancelled: "Cancelled",
};

export const LAB_WORKLIST_FILTERS = ["pending", "verified", "cancelled", "all"] as const;
export type LabWorklistFilter = (typeof LAB_WORKLIST_FILTERS)[number];

export const LAB_WORKLIST_FILTER_LABELS: Record<LabWorklistFilter, string> = {
  pending: "Pending",
  verified: "Verified",
  cancelled: "Cancelled",
  all: "All",
};

/** A pending order still needs laboratory work or verification. */
export const LAB_PENDING_STATUSES: readonly LabOrderStatus[] = [
  "ordered",
  "collected",
  "in_progress",
  "resulted",
];

export function labStatusesForFilter(
  filter: LabWorklistFilter,
): readonly LabOrderStatus[] | null {
  if (filter === "all") return null;
  if (filter === "pending") return LAB_PENDING_STATUSES;
  return [filter];
}

/** Stable, URL-safe suffix for parameter inputs and test ids. */
export function slugifyParameter(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "parameter"
  );
}

/** A parameter is numeric when at least one reference or critical bound exists. */
export function isNumericParameter(parameter: LabParameter): boolean {
  return [parameter.refLow, parameter.refHigh, parameter.criticalLow, parameter.criticalHigh].some(
    (value) => value !== null && value !== undefined,
  );
}

function formatBound(value: number): string {
  return String(value);
}

/** Human-readable reference range, e.g. `12 - 17`, `<= 0` or `>= 3.9`. */
export function formatRefRange(parameter: LabParameter): string | null {
  const { refLow, refHigh } = parameter;
  if (refLow == null && refHigh == null) return null;
  if (refLow == null) return `<= ${formatBound(refHigh as number)}`;
  if (refHigh == null) return `>= ${formatBound(refLow)}`;
  return `${formatBound(refLow)} - ${formatBound(refHigh)}`;
}

/**
 * Auto-flag a value against the parameter definition.
 *
 * Critical bounds win over reference bounds; the bounds themselves are
 * inclusive. Parameters without numeric bounds accept free text and never flag.
 */
export function evaluateLabFlag(value: string, parameter: LabParameter): LabFlag {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`A value is required for ${parameter.name}`);

  if (!isNumericParameter(parameter)) return "N";

  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${parameter.name} requires a numeric value`);
  }

  const { criticalHigh, criticalLow, refHigh, refLow } = parameter;
  if (criticalHigh != null && numeric >= criticalHigh) return "HH";
  if (criticalLow != null && numeric <= criticalLow) return "LL";
  if (refHigh != null && numeric > refHigh) return "H";
  if (refLow != null && numeric < refLow) return "L";
  return "N";
}

/** A sample can be collected once, before any laboratory processing. */
export function canCollectLabOrder(status: string): boolean {
  return status === "ordered";
}

/** Processing starts after collection and before results are entered. */
export function canStartLabProcessing(status: string): boolean {
  return status === "collected";
}

/** Results stay editable until verification; entered values can be corrected. */
export function canEnterLabResults(status: string): boolean {
  return status === "collected" || status === "in_progress" || status === "resulted";
}

/** Only a complete, resulted order can be verified. */
export function canVerifyLabResults(status: string): boolean {
  return status === "resulted";
}

/** Flag severity, used to highlight abnormal and critical results. */
export function isCriticalLabFlag(flag: string | null | undefined): boolean {
  return flag === "HH" || flag === "LL";
}
