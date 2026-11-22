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

export interface ReportsApiData {
  catalogue: ReportCatalogueRow[];
  savedViews: SavedReportViewRow[];
  approvalInbox: ApprovalInboxRow[];
  reportData: ErpReportData | null;
  drillDown: ReportDrillDownData | null;
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
