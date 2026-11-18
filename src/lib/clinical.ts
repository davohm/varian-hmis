/** Shared clinical rules used by the doctor commands, queries and workspace. */

export const SOAP_SECTIONS = [
  {
    key: "subjective",
    label: "Subjective",
    hint: "What the patient reports — history, symptoms and concerns.",
  },
  {
    key: "objective",
    label: "Objective",
    hint: "Examination findings and observations from triage.",
  },
  {
    key: "assessment",
    label: "Assessment",
    hint: "Working diagnosis and clinical reasoning.",
  },
  {
    key: "plan",
    label: "Plan",
    hint: "Investigations, treatment and follow-up.",
  },
] as const;

export type SoapSectionKey = (typeof SOAP_SECTIONS)[number]["key"];

export const PRESCRIPTION_ROUTES = ["oral", "iv", "im", "sc", "topical", "inhaled", "rectal"] as const;
export type PrescriptionRoute = (typeof PRESCRIPTION_ROUTES)[number];

export const PRESCRIPTION_FREQUENCIES = [
  "once daily",
  "twice daily",
  "three times daily",
  "four times daily",
  "every 4 hours",
  "every 6 hours",
  "every 8 hours",
  "as needed",
  "at bedtime",
] as const;

export const DISCHARGE_OUTCOMES = ["discharged", "referred"] as const;
export type DischargeOutcome = (typeof DISCHARGE_OUTCOMES)[number];

export const DISCHARGE_OUTCOME_LABELS: Record<DischargeOutcome, string> = {
  discharged: "Discharged home",
  referred: "Referred onward",
};

export const LAB_ORDER_STATUSES = [
  "ordered",
  "collected",
  "in_progress",
  "resulted",
  "verified",
  "cancelled",
] as const;
export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number];

/** Orders in these states still need laboratory work before a visit can close. */
export const ACTIVE_LAB_ORDER_STATUSES: readonly LabOrderStatus[] = [
  "ordered",
  "collected",
  "in_progress",
];

/** A lab order can be cancelled until a result has been returned. */
export function canCancelLabOrder(status: LabOrderStatus): boolean {
  return status === "ordered" || status === "collected" || status === "in_progress";
}

export const PRESCRIPTION_STATUSES = [
  "prescribed",
  "partial",
  "dispensed",
  "cancelled",
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/** Once any quantity is dispensed the prescription must be reversed, not cancelled. */
export function canCancelPrescription(status: PrescriptionStatus): boolean {
  return status === "prescribed";
}

export const LAB_RESULT_FLAG_LABELS: Record<string, string> = {
  N: "Normal",
  H: "High",
  L: "Low",
  HH: "Critical high",
  LL: "Critical low",
};

export function isAbnormalLabFlag(flag: string | null | undefined): boolean {
  return Boolean(flag && flag !== "N");
}

export const CLINICAL_NOTE_LOCKED_MESSAGE = "A signed clinical note cannot be edited";
export const OUTSTANDING_LAB_MESSAGE =
  "Resolve or cancel outstanding laboratory orders before closing the visit";
export const CLOSED_ENCOUNTER_MESSAGE = "This visit is already closed";
export const OPEN_ENCOUNTER_MESSAGE = "Only open visits can be updated";
