import type { ErpReportCode } from "./reporting";

export type ErpReportValue = string | number | boolean | null;

export interface ErpReportColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

export interface ErpReportDrillDown {
  sourceType: string;
  sourceId: string;
  label: string;
}

export interface ErpReportRow {
  key: string;
  label: string;
  section: string;
  values: Record<string, ErpReportValue>;
  drillDown?: ErpReportDrillDown;
}

export interface ErpReportData {
  reportCode: ErpReportCode;
  name: string;
  from: string;
  to: string;
  columns: ErpReportColumn[];
  rows: ErpReportRow[];
  totals: Record<string, string>;
  reconciled: boolean;
  reconciliationNote: string;
  sourceCounts: Record<string, number>;
  generatedAt: string;
}

export interface ErpReportFilters {
  from?: string;
  to?: string;
  asOf?: string;
  periodId?: string;
  accountId?: string;
  costCenterId?: string;
  branchId?: string;
}

export interface ApprovalInboxRow {
  id: string;
  kind: string;
  documentNo: string;
  title: string;
  status: string;
  requester: string;
  amount: string;
  createdAt: string;
  ageDays: number;
  href: string;
}

export interface ReportDrillDownRow {
  id: string;
  entryNo: string | null;
  entryDate: string | null;
  description: string | null;
  accountCode: string | null;
  accountName: string | null;
  debit: string;
  credit: string;
  postedBy: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

export interface ReportDrillDownAuditRow {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  actorId: string | null;
}

export interface ReportDrillDownData {
  sourceType: string;
  sourceId: string;
  journalRows: ReportDrillDownRow[];
  auditRows: ReportDrillDownAuditRow[];
  debit: string;
  credit: string;
  entryCount: number;
}

export interface SavedReportViewRow {
  id: string;
  reportCode: string;
  name: string;
  ownerId: string;
  shared: boolean;
  filters: Record<string, unknown>;
  columns: string[] | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function defaultReportFilters(filters: ErpReportFilters = {}): {
  from: string;
  to: string;
  asOf: string;
} {
  const to = filters.to ?? todayIso();
  const from = filters.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw new Error("Report start date must not be after the end date");
  return { from, to, asOf: filters.asOf ?? to };
}

function csvCell(value: ErpReportValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** CSV export is derived from the same cells used on screen and in the run row. */
export function reportDataToCsv(data: ErpReportData): string {
  const lines = [
    ["Report", data.name],
    ["Report code", data.reportCode],
    ["Period", `${data.from} to ${data.to}`],
    ["Generated at", data.generatedAt],
    ["Reconciled", data.reconciled ? "yes" : "no"],
    [],
    [...data.columns.map((column) => column.label), "Drill-down"],
    ...data.rows.map((row) => [
      ...data.columns.map((column) => csvCell(row.values[column.key] ?? null)),
      row.drillDown ? `${row.drillDown.sourceType}:${row.drillDown.sourceId}` : "",
    ]),
    [],
    ["Total", ...data.columns.map((column) => csvCell(data.totals[column.key] ?? null))],
  ];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
