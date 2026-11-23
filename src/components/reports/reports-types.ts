import type {
  ApprovalInboxRow,
  ErpReportData,
  ReportDrillDownData,
  SavedReportViewRow,
} from "@/lib/erp-reporting";
export interface ReportCatalogueRow {
  reportCode: string;
  name: string;
  domain: string;
  schedule: string;
  periodType: string;
  authority: string | null;
  outputFormats: string[];
  enabled: boolean;
}

export interface MohReportRunRow {
  id: string;
  reportCode: string;
  reportName: string;
  branchId: string | null;
  periodStart: string;
  periodEnd: string;
  epiWeek: number | null;
  epiYear: number | null;
  month: number | null;
  year: number | null;
  status: string;
  rowCount: number | null;
  checksum: string | null;
  generatedAt: string | null;
  submittedAt: string | null;
  acknowledgementRef: string | null;
  exportedFile: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface MohReportCellRow {
  id: string;
  section: string | null;
  rowCode: string | null;
  rowLabel: string | null;
  colKey: string | null;
  colLabel: string | null;
  valueNumeric: string | null;
  valueText: string | null;
  sortOrder: number;
  isTotal: boolean | null;
  sourceQuery: string | null;
}

export interface ReportsApiData {
  catalogue: ReportCatalogueRow[];
  savedViews: SavedReportViewRow[];
  approvalInbox: ApprovalInboxRow[];
  reportData: ErpReportData | null;
  drillDown: ReportDrillDownData | null;
  mohRuns?: MohReportRunRow[];
  mohCells?: MohReportCellRow[];
  mohAuditTrail?: Array<{ id: string; action: string; entity: string; entityId: string | null; createdAt: string; actorId: string | null; details: unknown }>;
}

export function formatMoney(value: string | number | null | undefined): string {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(amount)) return String(value ?? "0.00");
  return new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export async function postReportsCommand<T>(command: string, input: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "reports-station" },
    body: JSON.stringify({ command, input }),
  });
  const payload = (await response.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? "Report command failed");
  return payload?.result as T;
}
