export const CONSENT_TYPES = [
  "treatment",
  "data_processing",
  "payer_sharing",
  "research",
  "sms",
  "biometrics",
  "photography",
  "minor",
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

export const DSAR_TYPES = [
  "access",
  "correction",
  "erasure",
  "portability",
  "objection",
] as const;

export type DataSubjectRequestType = (typeof DSAR_TYPES)[number];

export const DSAR_STATUSES = [
  "received",
  "verifying",
  "in_progress",
  "completed",
  "rejected",
] as const;

export type DataSubjectRequestStatus = (typeof DSAR_STATUSES)[number];

export const BREACH_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];

export const BREACH_STATUSES = [
  "open",
  "contained",
  "notified",
  "closed",
] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

export const SHARING_COUNTERPARTY_TYPES = [
  "processor",
  "controller",
  "joint_controller",
  "payer",
  "regulator",
  "other",
] as const;

export const PATIENT_RESTRICTION_ENTITY = "patient_restriction";

export function isConsentType(value: string): value is ConsentType {
  return (CONSENT_TYPES as readonly string[]).includes(value);
}

export function isDsarType(value: string): value is DataSubjectRequestType {
  return (DSAR_TYPES as readonly string[]).includes(value);
}

export function isDsarStatus(value: string): value is DataSubjectRequestStatus {
  return (DSAR_STATUSES as readonly string[]).includes(value);
}

export function isBreachSeverity(value: string): value is BreachSeverity {
  return (BREACH_SEVERITIES as readonly string[]).includes(value);
}

export function isBreachStatus(value: string): value is BreachStatus {
  return (BREACH_STATUSES as readonly string[]).includes(value);
}

export function toDateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function isWithinRange(
  today: string,
  validFrom: string | Date | null | undefined,
  validTo: string | Date | null | undefined,
): boolean {
  const from = validFrom == null ? null : toDateOnly(validFrom);
  const to = validTo == null ? null : toDateOnly(validTo);
  if (from && today < from) return false;
  if (to && today > to) return false;
  return true;
}

export interface ConsentLike {
  granted: boolean;
  withdrawnAt: Date | string | null;
  validFrom: Date | string | null;
  validTo: Date | string | null;
}

export function isConsentValid(consent: ConsentLike, onDate: Date | string = new Date()): boolean {
  const today = toDateOnly(onDate);
  return (
    consent.granted === true &&
    consent.withdrawnAt == null &&
    isWithinRange(today, consent.validFrom, consent.validTo)
  );
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addDaysToTimestamp(value: Date | string, days: number): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(value.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function hoursBetween(from: Date | string, to: Date | string): number {
  const a = typeof from === "string" ? new Date(from).getTime() : from.getTime();
  const b = typeof to === "string" ? new Date(to).getTime() : to.getTime();
  return (b - a) / 3_600_000;
}
