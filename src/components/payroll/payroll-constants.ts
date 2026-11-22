import type { PayrollData } from "@/components/payroll/payroll-types";

export const EMPTY_PAYROLL_DATA: PayrollData = {
  viewerId: "",
  overview: null,
  runs: [],
  detail: null,
  rates: [],
  costCenters: [],
  employees: [],
};
