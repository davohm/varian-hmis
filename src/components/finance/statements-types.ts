/** Shapes returned by /api/finance/statements and used by the statements UI. */

import type { CostCenterRow, FiscalPeriodRow } from "@/components/finance/finance-types";
import { formatMoney } from "@/components/finance/finance-types";

export type StatementTab = "balance" | "income" | "cash";

export interface BranchRow {
  id: string;
  code: string;
  name: string;
  isMain: boolean;
  active: boolean;
}

export interface StatementFilterValues {
  from: string;
  to: string;
  asOf: string;
  periodId: string | null;
  costCenterId: string | null;
  branchId: string | null;
  dimensionLabel: string | null;
}

export interface StatementAccountLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  normalBalance: "debit" | "credit";
  systemRole: string | null;
  amount: string;
}

export interface StatementSection {
  key: string;
  label: string;
  lines: StatementAccountLine[];
  total: string;
}

export interface BalanceSheet {
  asOf: string;
  sections: StatementSection[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  accumulatedSurplus: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

export interface IncomeStatement {
  from: string;
  to: string;
  revenue: StatementSection;
  expenses: StatementSection;
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

export type CashFlowCategory = "operating" | "investing" | "financing";

export interface CashFlowLine {
  id: string;
  entryId: string;
  entryNo: string;
  date: string;
  description: string;
  accountCode: string;
  accountName: string;
  category: CashFlowCategory;
  direction: "receipt" | "payment";
  amount: string;
}

export interface CashFlowSection {
  key: CashFlowCategory;
  label: string;
  receipts: string;
  payments: string;
  net: string;
  lines: CashFlowLine[];
}

export interface CashFlowStatement {
  from: string;
  to: string;
  openingCash: string;
  netCashFlow: string;
  closingCash: string;
  ledgerCash: string;
  balanced: boolean;
  sections: CashFlowSection[];
}

export interface FinancialStatementsData {
  filters: StatementFilterValues;
  balanceSheet: BalanceSheet;
  incomeStatement: IncomeStatement;
  cashFlow: CashFlowStatement;
}

export interface StatementsResponse {
  statements: FinancialStatementsData;
  periods: FiscalPeriodRow[];
  costCenters: CostCenterRow[];
  branches: BranchRow[];
}

export { formatMoney };
