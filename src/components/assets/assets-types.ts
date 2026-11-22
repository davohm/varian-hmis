import { formatDate, formatMoney, todayIso } from "@/components/finance/finance-types";

export type AssetsTab = "register" | "depreciation" | "maintenance" | "changes";

export interface AssetsOverview {
  totalAssets: number;
  inService: number;
  underMaintenance: number;
  disposed: number;
  netBookValue: string;
  openMaintenanceOrders: number;
  pendingApprovals: number;
}

export interface AssetRow {
  id: string;
  assetNo: string;
  category: string;
  name: string;
  tagNo: string | null;
  serialNo: string | null;
  location: string;
  custodianName: string | null;
  departmentName: string | null;
  costCenterName: string | null;
  acquisitionDate: string;
  acquisitionCost: string;
  residualValue: string;
  usefulLifeMonths: number;
  accumulatedDepreciation: string;
  carryingAmount: string;
  status: string;
  lastDepreciationDate: string | null;
  createdAt: string;
}

export interface AssetAssignmentRow {
  id: string;
  eventType: string;
  fromLocation: string | null;
  toLocation: string;
  custodianName: string | null;
  performedBy: string;
  occurredAt: string;
  note: string | null;
}

export interface MaintenanceOrderRow {
  id: string;
  orderNo: string;
  type: string;
  priority: string;
  status: string;
  scheduledDate: string | null;
  assetName: string;
  description: string;
  totalCost: string;
  entryNo: string | null;
  createdAt: string;
}

export interface MaintenanceEventRow {
  id: string;
  eventType: string;
  description: string;
  cost: string;
  occurredAt: string;
}

export interface AssetValuationRow {
  id: string;
  assetId: string;
  valuationNo: string;
  assetNo: string;
  kind: string;
  amount: string;
  carryingBefore: string;
  carryingAfter: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  entryNo: string | null;
  effectiveFrom: string;
  createdAt: string;
}

export interface AssetDisposalRow {
  id: string;
  assetId: string;
  disposalNo: string;
  assetNo: string;
  method: string;
  disposalDate: string;
  proceeds: string;
  carryingAmount: string;
  gainLoss: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  entryNo: string | null;
  createdAt: string;
}

export interface AssetDetail extends AssetRow {
  assignments: AssetAssignmentRow[];
  maintenanceOrders: MaintenanceOrderRow[];
  maintenanceEvents: MaintenanceEventRow[];
  valuations: AssetValuationRow[];
  disposals: AssetDisposalRow[];
}

export interface DepreciationRunRow {
  id: string;
  runNo: string;
  period: string;
  description: string | null;
  status: string;
  totalAmount: string;
  assetCount: number;
  entryNo: string | null;
  preparedBy: string;
  approvedBy: string | null;
  createdAt: string;
}

export interface DepreciationEntryRow {
  id: string;
  assetNo: string | null;
  assetName: string | null;
  openingCarryingAmount: string;
  depreciationAmount: string;
  closingCarryingAmount: string;
  costCenterName: string | null;
}

export interface DepreciationRunDetail extends DepreciationRunRow {
  entries: DepreciationEntryRow[];
  approvals: Array<{
    id: string;
    decision: string;
    actorId: string;
    role: string;
    maxAmount: string;
    decidedAt: string;
  }>;
}

export interface ReferenceRow {
  id: string;
  name: string;
}

export interface CostCenterReferenceRow {
  id: string;
  code: string;
  name: string;
}

export interface AssetsData {
  viewerId: string;
  overview: AssetsOverview | null;
  assets: AssetRow[];
  runs: DepreciationRunRow[];
  orders: MaintenanceOrderRow[];
  valuations: AssetValuationRow[];
  disposals: AssetDisposalRow[];
  detail: AssetDetail | null;
  runDetail: DepreciationRunDetail | null;
  employees: ReferenceRow[];
  costCenters: CostCenterReferenceRow[];
  departments: ReferenceRow[];
}

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export function assetStatusTone(status: string): StatusTone {
  if (status === "in_service" || status === "posted" || status === "completed") return "success";
  if (status === "maintenance" || status === "approved" || status === "requested" || status === "draft")
    return "warning";
  if (status === "disposed" || status === "written_off" || status === "cancelled") return "danger";
  return "neutral";
}

export type RunAssetsCommand = (
  command: string,
  input: Record<string, unknown>,
  successMessage: string,
) => Promise<boolean>;

export interface AssetsPanelProps {
  data: AssetsData;
  canWrite: boolean;
  busy: boolean;
  run: RunAssetsCommand;
  selectAsset: (assetId: string) => void;
  selectRun: (runId: string) => void;
}

export class AssetsCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "AssetsCommandError";
  }
}

/** Posts a scoped asset command. Facility and actor are injected by the API. */
export async function postAssetsCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "assets-station" },
    body: JSON.stringify({ command, input }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: string;
    issues?: Array<{ message?: string; path?: Array<string | number> }>;
  } | null;
  if (!response.ok || !body) {
    const issues = (body?.issues ?? [])
      .map((issue) =>
        issue.path && issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message ?? "invalid"}`
          : (issue.message ?? "invalid"),
      )
      .filter(Boolean);
    throw new AssetsCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}

export const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export const SUBTLE_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export { formatDate, formatMoney, todayIso };
