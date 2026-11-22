import { createHash } from "node:crypto";

export const REPORT_RUN_STATUSES = ["draft", "generated", "exported", "submitted", "void"] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

export const NOTIFIABLE_EVENT_STATUSES = ["draft", "submitted", "closed"] as const;
export type NotifiableEventStatus = (typeof NOTIFIABLE_EVENT_STATUSES)[number];

export const NOTIFICATION_STATUSES = ["draft", "submitted", "void"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const REPORT_DOMAINS = [
  "morbidity",
  "workload",
  "idsr",
  "epi",
  "eye",
  "inpatient",
  "child_welfare",
  "diabetes",
  "tb",
] as const;

export const REPORT_OUTPUT_FORMATS = ["screen", "print", "csv", "xlsx", "pdf"] as const;

export interface ReportCatalogueSeed {
  reportCode: string;
  name: string;
  domain: string;
  schedule: "daily" | "weekly" | "monthly" | "quarterly";
  periodType: "day" | "epi_week" | "month";
  sourceEntities: string[];
  outputFormats: string[];
  authority: string;
  templateVersion: string;
}

/** Prompt 20 in-scope statutory reports. */
export const PROMPT20_REPORTS: readonly ReportCatalogueSeed[] = [
  {
    reportCode: "MOH705A",
    name: "MOH 705A Under-5 Daily Outpatient Morbidity",
    domain: "morbidity",
    schedule: "daily",
    periodType: "month",
    sourceEntities: ["encounters", "diagnoses", "patients"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH705B",
    name: "MOH 705B Over-5 Daily Outpatient Morbidity",
    domain: "morbidity",
    schedule: "daily",
    periodType: "month",
    sourceEntities: ["encounters", "diagnoses", "patients"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH717",
    name: "MOH 717 Monthly Workload",
    domain: "workload",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["encounters", "patients", "queue_entries", "departments"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH505",
    name: "MOH 505 IDSR Weekly Epidemic Monitoring",
    domain: "idsr",
    schedule: "weekly",
    periodType: "epi_week",
    sourceEntities: ["notifiable_events", "diagnoses", "encounters", "patients", "lab_orders", "lab_results"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH710A",
    name: "MOH 710A Immunization and Vitamin A Coverage",
    domain: "epi",
    schedule: "daily",
    periodType: "month",
    sourceEntities: ["encounters", "immunizations"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH710B",
    name: "MOH 710B Antigen Movement and Wastage",
    domain: "epi",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["stock_ledger", "item_batches", "items", "immunizations"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH416",
    name: "MOH 416 Eye Clinic Register",
    domain: "eye",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["encounters", "patients", "diagnoses", "clinical_notes", "queue_entries"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
  {
    reportCode: "MOH735",
    name: "MOH 735 Eye Services Summary",
    domain: "eye",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["encounters", "patients", "diagnoses", "clinical_notes"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "MOH",
    templateVersion: "2024.1",
  },
] as const;

/** Prompt 17 management and control reports. Codes are stable sync keys. */
export const ERP_REPORT_CODES = [
  "ERP_FINANCIAL_STATEMENTS",
  "ERP_TRIAL_BALANCE",
  "ERP_SUPPLIER_AGEING",
  "ERP_CLAIM_AGEING",
  "ERP_STOCK_VALUATION",
  "ERP_BUDGET_VARIANCE",
  "ERP_PAYROLL_SUMMARY",
  "ERP_APPROVAL_INBOX",
] as const;

export type ErpReportCode = (typeof ERP_REPORT_CODES)[number];

export function isErpReportCode(value: string): value is ErpReportCode {
  return (ERP_REPORT_CODES as readonly string[]).includes(value);
}

/** Prompt 17 catalogue seeds; these share the Prompt 20 catalogue table. */
export const PROMPT17_ERP_REPORTS: readonly ReportCatalogueSeed[] = [
  {
    reportCode: "ERP_FINANCIAL_STATEMENTS",
    name: "Financial statements",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["journal_entries", "journal_lines", "ledger_accounts"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_TRIAL_BALANCE",
    name: "Trial balance",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["journal_entries", "journal_lines", "ledger_accounts"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_SUPPLIER_AGEING",
    name: "Supplier ageing",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["suppliers", "supplier_invoices", "supplier_payments"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_CLAIM_AGEING",
    name: "Payer and claim ageing",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["payers", "claims", "remittances"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_STOCK_VALUATION",
    name: "Stock valuation",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["stock_ledger", "item_batches", "items"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_BUDGET_VARIANCE",
    name: "Budget variance",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["budgets", "budget_lines", "journal_lines"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_PAYROLL_SUMMARY",
    name: "Payroll summary",
    domain: "erp",
    schedule: "monthly",
    periodType: "month",
    sourceEntities: ["payroll_runs", "payroll_lines", "payslips"],
    outputFormats: ["screen", "print", "csv", "xlsx", "pdf"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
  {
    reportCode: "ERP_APPROVAL_INBOX",
    name: "Approval inbox",
    domain: "erp",
    schedule: "daily",
    periodType: "day",
    sourceEntities: [
      "budgets",
      "purchase_requisitions",
      "purchase_orders",
      "payroll_runs",
      "depreciation_runs",
      "asset_valuations",
      "asset_disposals",
    ],
    outputFormats: ["screen", "print", "csv"],
    authority: "Varian ERP",
    templateVersion: "2026.11",
  },
] as const;

export interface EpiWeekInfo {
  epiWeek: number;
  epiYear: number;
  /** ISO week ending date (Sunday), YYYY-MM-DD. */
  weekEnding: string;
  /** ISO week starting date (Monday), YYYY-MM-DD. */
  weekStart: string;
}

function assertIsoDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
}

/** Formats a UTC date as YYYY-MM-DD. */
export function toIsoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDateUtc(date: string): Date {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * ISO 8601 epidemiological week: Monday start, week 1 contains Jan 4.
 * Returns the epi week/year for the given date and the week bounds.
 */
export function getEpiWeek(date: string): EpiWeekInfo {
  const d = parseIsoDateUtc(date);

  const weekStartDate = new Date(d);
  const dayNr = (d.getUTCDay() + 6) % 7; // Monday = 0
  weekStartDate.setUTCDate(d.getUTCDate() - dayNr);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);

  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dayNr + 3);
  const epiYear = thursday.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(epiYear, 0, 4));
  const firstThursdayDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNr + 3);

  const epiWeek = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604800000);

  return {
    epiWeek,
    epiYear,
    weekStart: toIsoDate(weekStartDate),
    weekEnding: toIsoDate(weekEndDate),
  };
}

export interface MonthPeriod {
  periodStart: string;
  periodEnd: string;
  month: number;
  year: number;
}

export function getMonthPeriod(year: number, month: number): MonthPeriod {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    periodStart: toIsoDate(start),
    periodEnd: toIsoDate(end),
    month,
    year,
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isFutureDate(date: string, today: string = toIsoDate(new Date())): boolean {
  assertIsoDate(date);
  assertIsoDate(today);
  return date > today;
}

export function periodOverlapsClosedFiscalPeriod(
  periodStart: string,
  periodEnd: string,
  closedPeriods: Array<{ startDate: string; endDate: string }>,
): boolean {
  return closedPeriods.some(
    (period) => !(periodEnd < period.startDate || periodStart > period.endDate),
  );
}

export interface ChecksumCell {
  section?: string | null;
  rowCode?: string | null;
  colKey?: string | null;
  valueNumeric?: string | number | null;
  valueText?: string | null;
  sortOrder?: number | null;
  isTotal?: boolean | null;
}

function normalizeNumeric(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  // Normalize to avoid "1" vs "1.00" instability.
  return String(Number(num.toFixed(6)));
}

/** Stable checksum for identical cell inputs (order-independent). */
export function computeReportChecksum(cells: ChecksumCell[]): string {
  const normalized = cells
    .map((cell) => ({
      section: cell.section ?? null,
      rowCode: cell.rowCode ?? null,
      colKey: cell.colKey ?? null,
      valueNumeric: normalizeNumeric(cell.valueNumeric),
      valueText: cell.valueText ?? null,
      sortOrder: cell.sortOrder ?? 0,
      isTotal: Boolean(cell.isTotal),
    }))
    .sort((a, b) => {
      const ka = `${a.section ?? ""}|${a.sortOrder}|${a.rowCode ?? ""}|${a.colKey ?? ""}`;
      const kb = `${b.section ?? ""}|${b.sortOrder}|${b.rowCode ?? ""}|${b.colKey ?? ""}`;
      return ka.localeCompare(kb);
    });

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
