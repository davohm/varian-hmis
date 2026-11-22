import { formatDate, formatMoney, todayIso } from "@/components/finance/finance-types";

export type PayrollTab = "overview" | "runs" | "rates";

export interface PayrollOverview {
  draftRuns: number;
  approvedRuns: number;
  postedRuns: number;
  lastNetPay: string;
  activeEmployees: number;
  missingRateTypes: string[];
}

export interface PayrollRunRow {
  id: string;
  runNo: string;
  periodStart: string;
  periodEnd: string;
  description: string | null;
  status: string;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  totalEmployerCost: string;
  missingRateTypes: string[];
  preparedBy: string;
  approvedBy: string | null;
  postedBy: string | null;
  entryNo: string | null;
  createdAt: string;
}

export interface PayrollLineRow {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  basicSalary: string;
  allowances: string;
  grossPay: string;
  paye: string;
  nssfEmployee: string;
  nssfEmployer: string;
  shif: string;
  housingLevy: string;
  netPay: string;
  employerCost: string;
  costCenterName: string | null;
  missingRateTypes: string[];
}

export interface PayslipRow {
  id: string;
  slipNo: string;
  employeeName: string;
  issuedAt: string;
  snapshot: Record<string, unknown>;
}

export interface RunApprovalRow {
  id: string;
  decision: string;
  actorId: string;
  reason: string | null;
  decidedAt: string;
}

export interface PayrollRunDetail extends PayrollRunRow {
  lines: PayrollLineRow[];
  payslips: PayslipRow[];
  approvals: RunApprovalRow[];
}

export interface StatutoryRateRow {
  id: string;
  rateType: string;
  bandOrder: number;
  lowerBound: string;
  upperBound: string | null;
  ratePercent: string;
  fixedAmount: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  legalReference: string | null;
  active: boolean;
}

export interface PayrollEmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  basicSalary: string | null;
}

export interface CostCenterRow {
  id: string;
  code: string;
  name: string;
}

export interface PayrollData {
  viewerId: string;
  overview: PayrollOverview | null;
  runs: PayrollRunRow[];
  detail: PayrollRunDetail | null;
  rates: StatutoryRateRow[];
  costCenters: CostCenterRow[];
  employees: PayrollEmployeeRow[];
}

export type RunPayrollCommand = (
  command: string,
  input: Record<string, unknown>,
  successMessage: string,
) => Promise<boolean>;

export interface PayrollPanelProps {
  data: PayrollData;
  canWrite: boolean;
  busy: boolean;
  run: RunPayrollCommand;
  selectRun: (runId: string) => void;
}

export class PayrollCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "PayrollCommandError";
  }
}

/** Posts a scoped payroll command. Facility and actor are injected by the API. */
export async function postPayrollCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/payroll", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "payroll-station" },
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
    throw new PayrollCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}

export const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export const SUBTLE_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export { formatDate, formatMoney, todayIso };
