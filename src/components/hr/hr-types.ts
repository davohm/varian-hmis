import { formatDate, formatMoney, todayIso } from "@/components/finance/finance-types";

export type HrTab = "overview" | "employees" | "contracts" | "rota" | "leave";

export interface HrOverview {
  activeEmployees: number;
  openPositions: number;
  pendingLeave: number;
  attendanceToday: number;
  contractsExpiring: number;
}

export interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  nationalId: string | null;
  phone: string | null;
  bankName: string | null;
  employmentStatus: string;
  dateOfJoining: string | null;
}

export interface PositionRow {
  id: string;
  code: string;
  title: string;
  departmentName: string | null;
  grade: string | null;
  active: boolean;
}

export interface ContractRow {
  id: string;
  employeeName: string;
  positionTitle: string;
  contractType: string;
  startDate: string;
  endDate: string | null;
  basicSalary: string;
  active: boolean;
}

export interface ShiftTemplateRow {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

export interface AttendanceRow {
  id: string;
  employeeName: string;
  workDate: string;
  status: string;
  hoursWorked: string;
  note: string | null;
}

export interface LeaveRequestRow {
  id: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  rejectedReason: string | null;
}

export interface PayrollEmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  basicSalary: string | null;
}

export interface HrData {
  overview: HrOverview | null;
  employees: EmployeeRow[];
  positions: PositionRow[];
  contracts: ContractRow[];
  shiftTemplates: ShiftTemplateRow[];
  attendance: AttendanceRow[];
  leave: LeaveRequestRow[];
  payrollEmployees: PayrollEmployeeRow[];
}

export type RunHrCommand = (
  command: string,
  input: Record<string, unknown>,
  successMessage: string,
) => Promise<boolean>;

export interface HrPanelProps {
  data: HrData;
  canWrite: boolean;
  busy: boolean;
  run: RunHrCommand;
}

export class HrCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "HrCommandError";
  }
}

/** Posts a scoped HR command. Facility and actor are injected by the API. */
export async function postHrCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/hr", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "hr-station" },
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
    throw new HrCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}

export const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export const SUBTLE_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export { formatDate, formatMoney, todayIso };
