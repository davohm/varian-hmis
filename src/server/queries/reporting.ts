import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { fromCents, sumAmounts, toCents } from "@/lib/billing";
import {
  type ApprovalInboxRow,
  type ErpReportData,
  type ErpReportFilters,
  type ErpReportRow,
  type ReportDrillDownAuditRow,
  type ReportDrillDownData,
  type ReportDrillDownRow,
  type SavedReportViewRow,
  defaultReportFilters,
} from "@/lib/erp-reporting";
import {
  PROMPT17_ERP_REPORTS,
  PROMPT20_REPORTS,
  computeReportChecksum,
  type ErpReportCode,
} from "@/lib/reporting";
import type { db } from "@/server/db/client";
import {
  assetDisposals,
  assetValuations,
  auditLog,
  branches,
  budgetLines,
  budgets,
  depreciationRuns,
  facilities,
  facilityRegulatoryProfiles,
  journalEntries,
  journalLines,
  ledgerAccounts,
  birthNotifications,
  deathNotifications,
  diagnoses,
  encounters,
  notifiableEvents,
  patients,
  payrollRuns,
  purchaseOrders,
  purchaseRequisitions,
  reportCatalogue,
  reportCells,
  reportRuns,
  reportSavedViews,
  supplierInvoices,
  suppliers,
} from "@/server/db/schema";
import { listBudgetDetails } from "@/server/queries/budgets";
import { getFinancialStatements, getTrialBalance } from "@/server/queries/finance";
import { listPayrollRuns } from "@/server/queries/payroll";
import { getStockValuation } from "@/server/queries/procurement";
import { getRevenueOverview } from "@/server/queries/revenue";
import { fetchMohSources, mohSourceRowsForCell } from "@/server/reporting/moh-sources";

export type ReportingDatabase = typeof db;

interface ReportCatalogueRow {
  reportCode: string;
  name: string;
  domain: string;
  schedule: string;
  periodType: string;
  authority: string | null;
  outputFormats: string[];
  enabled: boolean;
}

function asIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function ageDays(createdAt: Date | string | null | undefined, now = Date.now()): number {
  if (!createdAt) return 0;
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

function money(value: string | number | null | undefined): string {
  return fromCents(toCents(value ?? "0"));
}

async function ensureErpCatalogue(database: ReportingDatabase): Promise<void> {
  await database
    .insert(reportCatalogue)
    .values(
      PROMPT17_ERP_REPORTS.map((report) => ({
        reportCode: report.reportCode,
        name: report.name,
        domain: report.domain,
        schedule: report.schedule,
        periodType: report.periodType,
        sourceEntities: [...report.sourceEntities],
        outputFormats: [...report.outputFormats],
        authority: report.authority ?? null,
        enabled: true,
        templateVersion: report.templateVersion ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: reportCatalogue.reportCode,
      set: {
        name: sql`excluded.name`,
        domain: sql`excluded.domain`,
        schedule: sql`excluded.schedule`,
        periodType: sql`excluded.period_type`,
        sourceEntities: sql`excluded.source_entities`,
        outputFormats: sql`excluded.output_formats`,
        authority: sql`excluded.authority`,
        enabled: sql`excluded.enabled`,
        templateVersion: sql`excluded.template_version`,
        updatedAt: sql`now()`,
      },
    });
}

export async function listReportCatalogue(
  database: ReportingDatabase,
): Promise<ReportCatalogueRow[]> {
  await ensureErpCatalogue(database);
  await ensureMohCatalogueRows(database);
  const rows = await database
    .select({
      reportCode: reportCatalogue.reportCode,
      name: reportCatalogue.name,
      domain: reportCatalogue.domain,
      schedule: reportCatalogue.schedule,
      periodType: reportCatalogue.periodType,
      authority: reportCatalogue.authority,
      outputFormats: reportCatalogue.outputFormats,
      enabled: reportCatalogue.enabled,
    })
    .from(reportCatalogue)
    .orderBy(asc(reportCatalogue.domain), asc(reportCatalogue.name));

  return rows.map((row) => ({ ...row, outputFormats: row.outputFormats ?? [] }));
}

export async function listSavedReportViews(
  database: ReportingDatabase,
  facilityId: string,
  ownerId: string,
  reportCode?: string,
): Promise<SavedReportViewRow[]> {
  const conditions = [
    eq(reportSavedViews.facilityId, facilityId),
    eq(reportSavedViews.active, true),
    sql`(${reportSavedViews.ownerId} = ${ownerId} OR ${reportSavedViews.shared} = true)`,
  ];
  if (reportCode) conditions.push(eq(reportSavedViews.reportCode, reportCode));

  const rows = await database
    .select()
    .from(reportSavedViews)
    .where(and(...conditions))
    .orderBy(desc(reportSavedViews.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    reportCode: row.reportCode,
    name: row.name,
    ownerId: row.ownerId,
    shared: row.shared,
    filters: (row.filters ?? {}) as Record<string, unknown>,
    columns: row.columns ?? null,
    active: row.active,
    createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: asIso(row.updatedAt) ?? new Date().toISOString(),
  }));
}

export async function getApprovalInbox(
  database: ReportingDatabase,
  facilityId: string,
): Promise<ApprovalInboxRow[]> {
  const now = Date.now();
  const [
    budgetRows,
    requisitionRows,
    poRows,
    payrollRows,
    depreciationRows,
    valuationRows,
    disposalRows,
  ] = await Promise.all([
    database
      .select({
        id: budgets.id,
        code: budgets.code,
        name: budgets.name,
        status: budgets.status,
        amount: sql<string>`coalesce(sum(${budgetLines.amount}), 0)::text`,
        requester: budgets.submittedBy,
        createdAt: budgets.createdAt,
      })
      .from(budgets)
      .leftJoin(budgetLines, eq(budgetLines.budgetId, budgets.id))
      .where(and(eq(budgets.facilityId, facilityId), eq(budgets.status, "submitted")))
      .groupBy(budgets.id, budgets.code, budgets.name, budgets.status, budgets.submittedBy, budgets.createdAt)
      .orderBy(desc(budgets.createdAt)),
    database
      .select({
        id: purchaseRequisitions.id,
        requisitionNo: purchaseRequisitions.requisitionNo,
        department: purchaseRequisitions.department,
        status: purchaseRequisitions.status,
        amount: purchaseRequisitions.totalAmount,
        requester: purchaseRequisitions.requestedBy,
        createdAt: purchaseRequisitions.createdAt,
      })
      .from(purchaseRequisitions)
      .where(and(eq(purchaseRequisitions.facilityId, facilityId), eq(purchaseRequisitions.status, "draft")))
      .orderBy(desc(purchaseRequisitions.createdAt)),
    database
      .select({
        id: purchaseOrders.id,
        poNo: purchaseOrders.poNo,
        status: purchaseOrders.status,
        amount: purchaseOrders.totalAmount,
        requester: purchaseOrders.orderedBy,
        createdAt: purchaseOrders.createdAt,
      })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.facilityId, facilityId), eq(purchaseOrders.status, "draft")))
      .orderBy(desc(purchaseOrders.createdAt)),
    database
      .select({
        id: payrollRuns.id,
        runNo: payrollRuns.runNo,
        status: payrollRuns.status,
        amount: payrollRuns.totalNet,
        requester: payrollRuns.preparedBy,
        createdAt: payrollRuns.createdAt,
      })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.facilityId, facilityId), eq(payrollRuns.status, "draft")))
      .orderBy(desc(payrollRuns.createdAt)),
    database
      .select({
        id: depreciationRuns.id,
        runNo: depreciationRuns.runNo,
        status: depreciationRuns.status,
        amount: depreciationRuns.totalAmount,
        requester: depreciationRuns.preparedBy,
        createdAt: depreciationRuns.createdAt,
      })
      .from(depreciationRuns)
      .where(and(eq(depreciationRuns.facilityId, facilityId), eq(depreciationRuns.status, "draft")))
      .orderBy(desc(depreciationRuns.createdAt)),
    database
      .select({
        id: assetValuations.id,
        valuationNo: assetValuations.valuationNo,
        kind: assetValuations.kind,
        status: assetValuations.status,
        amount: assetValuations.amount,
        requester: assetValuations.requestedBy,
        createdAt: assetValuations.createdAt,
      })
      .from(assetValuations)
      .where(and(eq(assetValuations.facilityId, facilityId), eq(assetValuations.status, "requested")))
      .orderBy(desc(assetValuations.createdAt)),
    database
      .select({
        id: assetDisposals.id,
        disposalNo: assetDisposals.disposalNo,
        method: assetDisposals.method,
        status: assetDisposals.status,
        amount: assetDisposals.proceeds,
        requester: assetDisposals.requestedBy,
        createdAt: assetDisposals.createdAt,
      })
      .from(assetDisposals)
      .where(and(eq(assetDisposals.facilityId, facilityId), eq(assetDisposals.status, "requested")))
      .orderBy(desc(assetDisposals.createdAt)),
  ]);

  const rows: ApprovalInboxRow[] = [
    ...budgetRows.map((row) => ({
      id: row.id,
      kind: "Budget",
      documentNo: row.code,
      title: row.name,
      status: row.status,
      requester: row.requester ?? "Unknown",
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/finance/budgets",
    })),
    ...requisitionRows.map((row) => ({
      id: row.id,
      kind: "Purchase requisition",
      documentNo: row.requisitionNo,
      title: row.department,
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/procurement",
    })),
    ...poRows.map((row) => ({
      id: row.id,
      kind: "Purchase order",
      documentNo: row.poNo,
      title: "Purchase order approval",
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/procurement",
    })),
    ...payrollRows.map((row) => ({
      id: row.id,
      kind: "Payroll run",
      documentNo: row.runNo,
      title: "Payroll approval",
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/payroll",
    })),
    ...depreciationRows.map((row) => ({
      id: row.id,
      kind: "Depreciation run",
      documentNo: row.runNo,
      title: "Depreciation approval",
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/assets",
    })),
    ...valuationRows.map((row) => ({
      id: row.id,
      kind: "Asset valuation",
      documentNo: row.valuationNo,
      title: `${row.kind} valuation`,
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/assets",
    })),
    ...disposalRows.map((row) => ({
      id: row.id,
      kind: "Asset disposal",
      documentNo: row.disposalNo,
      title: `${row.method} disposal`,
      status: row.status,
      requester: row.requester,
      amount: money(row.amount),
      createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
      ageDays: ageDays(row.createdAt, now),
      href: "/assets",
    })),
  ];

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function statementRows(
  sections: Array<{ label: string; lines: Array<{ accountId: string; code: string; name: string; amount: string }> }>,
  key: "amount" | "current" | "prior" = "amount",
): ErpReportRow[] {
  const rows: ErpReportRow[] = [];
  for (const section of sections) {
    for (const line of section.lines) {
      rows.push({
        key: `${section.label}:${line.accountId}`,
        label: line.name,
        section: section.label,
        drillDown: { sourceType: "ledger_account", sourceId: line.accountId, label: line.name },
        values: {
          account: `${line.code} ${line.name}`,
          [key]: line.amount,
        },
      });
    }
  }
  return rows;
}

async function getFinancialStatementsReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { from, to } = defaultReportFilters(filters);
  const statements = await getFinancialStatements(database, facilityId, {
    from,
    to,
    periodId: filters.periodId,
    costCenterId: filters.costCenterId,
    branchId: filters.branchId,
  });

  const rows: ErpReportRow[] = [
    ...statementRows(statements.balanceSheet.sections),
    ...statementRows([
      {
        label: `Income - ${statements.incomeStatement.revenue.label}`,
        lines: statements.incomeStatement.revenue.lines,
      },
    ]),
    ...statementRows([
      {
        label: `Expense - ${statements.incomeStatement.expenses.label}`,
        lines: statements.incomeStatement.expenses.lines,
      },
    ]),
  ];

  return {
    reportCode: "ERP_FINANCIAL_STATEMENTS",
    name: "Financial statements",
    from: statements.filters.from,
    to: statements.filters.to,
    columns: [
      { key: "account", label: "Account / section" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows,
    totals: {
      account: "Net income",
      amount: statements.incomeStatement.netIncome,
    },
    reconciled: statements.balanceSheet.balanced && statements.cashFlow.balanced,
    reconciliationNote: statements.balanceSheet.balanced
      ? "Balance sheet is balanced and cash flow reconciles to the ledger cash balance."
      : "Balance sheet is out of balance; investigate journal postings before relying on this report.",
    sourceCounts: {
      balanceSheetLines: statements.balanceSheet.sections.reduce((n, s) => n + s.lines.length, 0),
      incomeStatementLines:
        statements.incomeStatement.revenue.lines.length +
        statements.incomeStatement.expenses.lines.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function getTrialBalanceReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { from, to } = defaultReportFilters(filters);
  const trial = await getTrialBalance(database, facilityId, { from, to });
  return {
    reportCode: "ERP_TRIAL_BALANCE",
    name: "Trial balance",
    from,
    to,
    columns: [
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit", align: "right" },
      { key: "credit", label: "Credit", align: "right" },
      { key: "balance", label: "Balance", align: "right" },
    ],
    rows: trial.rows.map((row) => ({
      key: row.accountId,
      label: row.name,
      section: row.type,
      drillDown: { sourceType: "ledger_account", sourceId: row.accountId, label: row.name },
      values: {
        account: `${row.code} ${row.name}`,
        debit: row.debit,
        credit: row.credit,
        balance: row.balance,
      },
    })),
    totals: {
      account: "Total",
      debit: trial.debit,
      credit: trial.credit,
      balance: trial.balanced ? "0.00" : "Out of balance",
    },
    reconciled: trial.balanced,
    reconciliationNote: trial.balanced
      ? "Total debits equal total credits."
      : "Total debits do not equal total credits; investigate posted journals.",
    sourceCounts: { accounts: trial.rows.length },
    generatedAt: new Date().toISOString(),
  };
}

async function getBudgetVarianceReportData(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { from, to } = defaultReportFilters(filters);
  const details = await listBudgetDetails(database, facilityId, {});
  const rows: ErpReportRow[] = [];
  for (const budget of details) {
    for (const line of budget.lines) {
      rows.push({
        key: `${budget.id}:${line.id}`,
        label: line.accountName,
        section: budget.name,
        drillDown: { sourceType: "budget", sourceId: budget.id, label: budget.name },
        values: {
          budget: budget.name,
          account: `${line.accountCode} ${line.accountName}`,
          costCenter: line.costCenterName ?? "Unassigned",
          budgeted: line.amount,
          actual: line.actual,
          variance: line.variance,
        },
      });
    }
  }
  const totals = rows.reduce(
    (acc, row) => {
      acc.budgeted += toCents(row.values.budgeted as string);
      acc.actual += toCents(row.values.actual as string);
      acc.variance += toCents(row.values.variance as string);
      return acc;
    },
    { budgeted: 0, actual: 0, variance: 0 },
  );
  return {
    reportCode: "ERP_BUDGET_VARIANCE",
    name: "Budget variance",
    from,
    to,
    columns: [
      { key: "budget", label: "Budget" },
      { key: "account", label: "Account" },
      { key: "costCenter", label: "Cost centre" },
      { key: "budgeted", label: "Budget", align: "right" },
      { key: "actual", label: "Actual", align: "right" },
      { key: "variance", label: "Variance", align: "right" },
    ],
    rows,
    totals: {
      budget: "Total",
      account: "",
      costCenter: "",
      budgeted: fromCents(totals.budgeted),
      actual: fromCents(totals.actual),
      variance: fromCents(totals.variance),
    },
    reconciled: true,
    reconciliationNote: "Actuals are derived from posted journal lines for each budget account and cost centre.",
    sourceCounts: { budgets: details.length, lines: rows.length },
    generatedAt: new Date().toISOString(),
  };
}

async function getPayrollSummaryReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { from, to } = defaultReportFilters(filters);
  const runs = await listPayrollRuns(database, facilityId);
  const rows: ErpReportRow[] = runs
    .filter((run) => run.periodEnd >= from && run.periodStart <= to)
    .map((run) => ({
      key: run.id,
      label: run.runNo,
      section: run.status,
      drillDown: { sourceType: "payroll_run", sourceId: run.id, label: run.runNo },
      values: {
        runNo: run.runNo,
        period: `${run.periodStart} to ${run.periodEnd}`,
        status: run.status,
        gross: run.totalGross,
        deductions: run.totalDeductions,
        net: run.totalNet,
        employerCost: run.totalEmployerCost,
      },
    }));
  const totals = rows.reduce(
    (acc, row) => {
      acc.gross += toCents(row.values.gross as string);
      acc.deductions += toCents(row.values.deductions as string);
      acc.net += toCents(row.values.net as string);
      acc.employerCost += toCents(row.values.employerCost as string);
      return acc;
    },
    { gross: 0, deductions: 0, net: 0, employerCost: 0 },
  );
  return {
    reportCode: "ERP_PAYROLL_SUMMARY",
    name: "Payroll summary",
    from,
    to,
    columns: [
      { key: "runNo", label: "Run" },
      { key: "period", label: "Period" },
      { key: "status", label: "Status" },
      { key: "gross", label: "Gross", align: "right" },
      { key: "deductions", label: "Deductions", align: "right" },
      { key: "net", label: "Net", align: "right" },
      { key: "employerCost", label: "Employer cost", align: "right" },
    ],
    rows,
    totals: {
      runNo: "Total",
      period: "",
      status: "",
      gross: fromCents(totals.gross),
      deductions: fromCents(totals.deductions),
      net: fromCents(totals.net),
      employerCost: fromCents(totals.employerCost),
    },
    reconciled: true,
    reconciliationNote: "Payroll totals are read from approved/posted payroll runs and their immutable payslip lines.",
    sourceCounts: { runs: rows.length },
    generatedAt: new Date().toISOString(),
  };
}

async function getSupplierAgeingReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { asOf } = defaultReportFilters(filters);
  const rows = await database
    .select({
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      paymentTermsDays: suppliers.paymentTermsDays,
      invoiceId: supplierInvoices.id,
      invoiceDate: supplierInvoices.invoiceDate,
      totalAmount: supplierInvoices.amount,
      paidAmount: supplierInvoices.paidAmount,
      status: supplierInvoices.status,
    })
    .from(supplierInvoices)
    .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
    .where(
      and(
        eq(supplierInvoices.facilityId, facilityId),
        lte(supplierInvoices.invoiceDate, asOf),
        inArray(supplierInvoices.status, ["posted", "partially_paid"]),
      ),
    )
    .orderBy(asc(suppliers.name), asc(supplierInvoices.invoiceDate));

  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
  const bySupplier = new Map<string, ErpReportRow & { buckets: number[] }>();
  for (const row of rows) {
    const outstandingCents = Math.max(0, toCents(row.totalAmount) - toCents(row.paidAmount));
    if (outstandingCents === 0) continue;
    const dueMs = new Date(`${row.invoiceDate}T00:00:00Z`).getTime() + row.paymentTermsDays * 86_400_000;
    const overdueDays = Math.max(0, Math.floor((asOfMs - dueMs) / 86_400_000));
    const bucket = overdueDays <= 30 ? 0 : overdueDays <= 60 ? 1 : overdueDays <= 90 ? 2 : 3;
    const current = bySupplier.get(row.supplierId) ?? {
      key: row.supplierId,
      label: row.supplierName,
      section: "Suppliers",
      values: {},
      drillDown: { sourceType: "supplier", sourceId: row.supplierId, label: row.supplierName },
      buckets: [0, 0, 0, 0, 0],
    };
    current.buckets[bucket] += outstandingCents;
    current.buckets[4] += outstandingCents;
    bySupplier.set(row.supplierId, current);
  }

  const reportRows = [...bySupplier.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      section: row.section,
      drillDown: row.drillDown,
      values: {
        supplier: row.label,
        current: fromCents(row.buckets[0]),
        days31to60: fromCents(row.buckets[1]),
        days61to90: fromCents(row.buckets[2]),
        days90plus: fromCents(row.buckets[3]),
        total: fromCents(row.buckets[4]),
      },
    }))
    .sort((a, b) => toCents(String(b.values.total)) - toCents(String(a.values.total)));

  const totals = reportRows.reduce(
    (acc, row) => {
      acc.current += toCents(String(row.values.current));
      acc.days31to60 += toCents(String(row.values.days31to60));
      acc.days61to90 += toCents(String(row.values.days61to90));
      acc.days90plus += toCents(String(row.values.days90plus));
      acc.total += toCents(String(row.values.total));
      return acc;
    },
    { current: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0 },
  );

  return {
    reportCode: "ERP_SUPPLIER_AGEING",
    name: "Supplier ageing",
    from: asOf,
    to: asOf,
    columns: [
      { key: "supplier", label: "Supplier" },
      { key: "current", label: "0-30 days", align: "right" },
      { key: "days31to60", label: "31-60 days", align: "right" },
      { key: "days61to90", label: "61-90 days", align: "right" },
      { key: "days90plus", label: "90+ days", align: "right" },
      { key: "total", label: "Outstanding", align: "right" },
    ],
    rows: reportRows,
    totals: {
      supplier: "Total",
      current: fromCents(totals.current),
      days31to60: fromCents(totals.days31to60),
      days61to90: fromCents(totals.days61to90),
      days90plus: fromCents(totals.days90plus),
      total: fromCents(totals.total),
    },
    reconciled: true,
    reconciliationNote: "Outstanding balances are derived from posted supplier invoices minus recorded supplier payments.",
    sourceCounts: { invoices: rows.length, suppliers: reportRows.length },
    generatedAt: new Date().toISOString(),
  };
}

async function getClaimAgeingReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const overview = await getRevenueOverview(database, facilityId);
  const { asOf } = defaultReportFilters(filters);
  const rows: ErpReportRow[] = overview.ageing.map((bucket) => ({
    key: bucket.label,
    label: bucket.label,
    section: "Ageing",
    values: {
      bucket: bucket.label,
      claims: bucket.claimCount,
      outstanding: bucket.outstanding,
    },
  }));
  return {
    reportCode: "ERP_CLAIM_AGEING",
    name: "Payer and claim ageing",
    from: asOf,
    to: asOf,
    columns: [
      { key: "bucket", label: "Age bucket" },
      { key: "claims", label: "Claims", align: "right" },
      { key: "outstanding", label: "Outstanding", align: "right" },
    ],
    rows,
    totals: {
      bucket: "Total",
      claims: String(overview.openClaims),
      outstanding: overview.outstanding,
    },
    reconciled: true,
    reconciliationNote: "Open claim ageing is based on active claim balances and remittance allocations recorded in the revenue cycle.",
    sourceCounts: { openClaims: overview.openClaims },
    generatedAt: new Date().toISOString(),
  };
}

async function getStockValuationReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { asOf } = defaultReportFilters(filters);
  const rows = await getStockValuation(database, facilityId);
  const reportRows: ErpReportRow[] = rows.map((row) => ({
    key: `${row.itemId}:${row.batchId}`,
    label: row.itemName,
    section: "Stock",
    drillDown: row.batchId
      ? { sourceType: "item_batch", sourceId: row.batchId, label: row.itemName }
      : undefined,
    values: {
      item: row.itemName,
      code: row.itemCode,
      batch: row.batchNo,
      expiry: row.expiryDate ?? "",
      quantity: row.quantity,
      unitCost: row.unitCost,
      value: row.value,
    },
  }));
  const total = sumAmounts(rows.map((row) => row.value));
  return {
    reportCode: "ERP_STOCK_VALUATION",
    name: "Stock valuation",
    from: asOf,
    to: asOf,
    columns: [
      { key: "item", label: "Item" },
      { key: "code", label: "Code" },
      { key: "batch", label: "Batch" },
      { key: "expiry", label: "Expiry" },
      { key: "quantity", label: "Qty", align: "right" },
      { key: "unitCost", label: "Unit cost", align: "right" },
      { key: "value", label: "Value", align: "right" },
    ],
    rows: reportRows,
    totals: { item: "Total", code: "", batch: "", expiry: "", quantity: "", unitCost: "", value: total },
    reconciled: true,
    reconciliationNote: "Stock value is derived from append-only stock ledger balances and batch unit costs.",
    sourceCounts: { rows: rows.length },
    generatedAt: new Date().toISOString(),
  };
}

async function getApprovalInboxReport(
  database: ReportingDatabase,
  facilityId: string,
  filters: ErpReportFilters,
): Promise<ErpReportData> {
  const { asOf } = defaultReportFilters(filters);
  const rows = await getApprovalInbox(database, facilityId);
  return {
    reportCode: "ERP_APPROVAL_INBOX",
    name: "Approval inbox",
    from: asOf,
    to: asOf,
    columns: [
      { key: "kind", label: "Type" },
      { key: "documentNo", label: "Document" },
      { key: "requester", label: "Requester" },
      { key: "status", label: "Status" },
      { key: "ageDays", label: "Age (days)", align: "right" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: rows.map((row) => ({
      key: `${row.kind}:${row.id}`,
      label: row.documentNo,
      section: row.kind,
      values: {
        kind: row.kind,
        documentNo: row.documentNo,
        requester: row.requester,
        status: row.status,
        ageDays: row.ageDays,
        amount: row.amount,
      },
    })),
    totals: {
      kind: "Total",
      documentNo: `${rows.length} items`,
      requester: "",
      status: "",
      ageDays: "",
      amount: sumAmounts(rows.map((row) => row.amount)),
    },
    reconciled: true,
    reconciliationNote: "Pending approvals are aggregated from source documents; approve or reject in the owning workspace.",
    sourceCounts: { items: rows.length },
    generatedAt: new Date().toISOString(),
  };
}

export async function getErpReportData(
  database: ReportingDatabase,
  facilityId: string,
  reportCode: ErpReportCode,
  filters: ErpReportFilters = {},
): Promise<ErpReportData> {
  await ensureErpCatalogue(database);
  switch (reportCode) {
    case "ERP_FINANCIAL_STATEMENTS":
      return getFinancialStatementsReport(database, facilityId, filters);
    case "ERP_TRIAL_BALANCE":
      return getTrialBalanceReport(database, facilityId, filters);
    case "ERP_SUPPLIER_AGEING":
      return getSupplierAgeingReport(database, facilityId, filters);
    case "ERP_CLAIM_AGEING":
      return getClaimAgeingReport(database, facilityId, filters);
    case "ERP_STOCK_VALUATION":
      return getStockValuationReport(database, facilityId, filters);
    case "ERP_BUDGET_VARIANCE":
      return getBudgetVarianceReportData(database, facilityId, filters);
    case "ERP_PAYROLL_SUMMARY":
      return getPayrollSummaryReport(database, facilityId, filters);
    case "ERP_APPROVAL_INBOX":
      return getApprovalInboxReport(database, facilityId, filters);
  }
}

export function reportRowsToCells(data: ErpReportData) {
  return data.rows.map((row, index) => ({
    section: row.section,
    rowCode: row.key,
    rowLabel: row.label,
    colKey: "row",
    colLabel: "Row",
    valueText: JSON.stringify({
      values: row.values,
      drillDown: row.drillDown ?? null,
    }),
    sortOrder: index,
    isTotal: false,
  }));
}

export function reportChecksum(data: ErpReportData): string {
  return computeReportChecksum(
    data.rows.map((row, index) => ({
      section: row.section,
      rowCode: row.key,
      colKey: "row",
      valueText: JSON.stringify(row.values),
      sortOrder: index,
      isTotal: false,
    })),
  );
}

async function findJournalIdsForSource(
  database: ReportingDatabase,
  facilityId: string,
  sourceType: string,
  sourceId: string,
): Promise<string[]> {
  if (sourceType === "journal_entry") return [sourceId];
  if (sourceType === "ledger_account") {
    const rows = await database
      .select({ id: journalLines.entryId })
      .from(journalLines)
      .where(and(eq(journalLines.facilityId, facilityId), eq(journalLines.accountId, sourceId)))
      .limit(100);
    return rows.map((row) => row.id);
  }
  if (sourceType === "payroll_run") {
    const rows = await database
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.facilityId, facilityId),
          eq(journalEntries.sourceType, "payroll"),
          eq(journalEntries.sourceId, sourceId),
        ),
      )
      .limit(100);
    return rows.map((row) => row.id);
  }
  const rows = await database
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.facilityId, facilityId),
        eq(journalEntries.sourceType, sourceType),
        eq(journalEntries.sourceId, sourceId),
      ),
    )
    .limit(100);
  return rows.map((row) => row.id);
}

export async function getReportDrillDown(
  database: ReportingDatabase,
  facilityId: string,
  sourceType: string,
  sourceId: string,
): Promise<ReportDrillDownData> {
  const entryIds = await findJournalIdsForSource(database, facilityId, sourceType, sourceId);
  const journalRows: ReportDrillDownRow[] = entryIds.length
    ? (
        await database
          .select({
            id: journalLines.id,
            entryNo: journalEntries.entryNo,
            entryDate: journalEntries.entryDate,
            description: journalEntries.description,
            accountCode: ledgerAccounts.code,
            accountName: ledgerAccounts.name,
            debit: journalLines.debit,
            credit: journalLines.credit,
            postedBy: journalEntries.postedBy,
            sourceType: journalEntries.sourceType,
            sourceId: journalEntries.sourceId,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
          .where(
            and(
              eq(journalLines.facilityId, facilityId),
              inArray(journalLines.entryId, entryIds),
            ),
          )
          .orderBy(desc(journalEntries.entryDate), asc(journalEntries.entryNo))
          .limit(200)
      ).map((row) => ({
        id: row.id,
        entryNo: row.entryNo,
        entryDate: row.entryDate,
        description: row.description,
        accountCode: row.accountCode,
        accountName: row.accountName,
        debit: money(row.debit),
        credit: money(row.credit),
        postedBy: row.postedBy,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
      }))
    : [];

  const debit = sumAmounts(journalRows.map((row) => row.debit));
  const credit = sumAmounts(journalRows.map((row) => row.credit));

  const auditRows: ReportDrillDownAuditRow[] = (
    await database
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        createdAt: auditLog.createdAt,
        actorId: auditLog.userId,
      })
      .from(auditLog)
      .where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.entityId, sourceId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(50)
  ).map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId ?? sourceId,
    createdAt: asIso(row.createdAt) ?? new Date().toISOString(),
    actorId: row.actorId,
  }));

  return {
    sourceType,
    sourceId,
    journalRows,
    auditRows,
    debit,
    credit,
    entryCount: new Set(journalRows.map((row) => row.entryNo)).size,
  };
}

export async function getReportRun(
  database: ReportingDatabase,
  facilityId: string,
  runId: string,
) {
  const [run] = await database
    .select({
      id: reportRuns.id,
      reportCode: reportCatalogue.reportCode,
      reportName: reportCatalogue.name,
      periodStart: reportRuns.periodStart,
      periodEnd: reportRuns.periodEnd,
      status: reportRuns.status,
      rowCount: reportRuns.rowCount,
      checksum: reportRuns.checksum,
      generatedAt: reportRuns.generatedAt,
      exportedFile: reportRuns.exportedFile,
    })
    .from(reportRuns)
    .innerJoin(reportCatalogue, eq(reportCatalogue.id, reportRuns.reportId))
    .where(and(eq(reportRuns.facilityId, facilityId), eq(reportRuns.id, runId)))
    .limit(1);

  if (!run) return null;

  const cells = await database
    .select()
    .from(reportCells)
    .where(and(eq(reportCells.facilityId, facilityId), eq(reportCells.reportRunId, runId)))
    .orderBy(asc(reportCells.sortOrder));

  return {
    ...run,
    generatedAt: asIso(run.generatedAt),
    cells,
  };
}


// ---------------------------------------------------------------------------
// Phase 20 â€” MOH statutory reporting queries
// ---------------------------------------------------------------------------

async function ensureMohCatalogueRows(database: ReportingDatabase) {
  await database.insert(reportCatalogue).values(PROMPT20_REPORTS.map((r) => ({
    reportCode: r.reportCode, name: r.name, domain: r.domain, schedule: r.schedule, periodType: r.periodType,
    sourceEntities: [...r.sourceEntities], outputFormats: [...r.outputFormats], authority: r.authority ?? null, enabled: true, templateVersion: r.templateVersion ?? null,
  }))).onConflictDoUpdate({ target: reportCatalogue.reportCode, set: { name: sql`excluded.name`, domain: sql`excluded.domain`, schedule: sql`excluded.schedule`, periodType: sql`excluded.period_type`, sourceEntities: sql`excluded.source_entities`, outputFormats: sql`excluded.output_formats`, authority: sql`excluded.authority`, enabled: sql`excluded.enabled`, templateVersion: sql`excluded.template_version`, updatedAt: sql`now()` } });
}

export async function getReportCatalogue(database: ReportingDatabase) {
  await ensureErpCatalogue(database);
  await ensureMohCatalogueRows(database);
  return database.select({ id: reportCatalogue.id, reportCode: reportCatalogue.reportCode, name: reportCatalogue.name, domain: reportCatalogue.domain, schedule: reportCatalogue.schedule, periodType: reportCatalogue.periodType, authority: reportCatalogue.authority, outputFormats: reportCatalogue.outputFormats, enabled: reportCatalogue.enabled, templateVersion: reportCatalogue.templateVersion }).from(reportCatalogue).orderBy(asc(reportCatalogue.domain), asc(reportCatalogue.reportCode));
}

export async function listReportRuns(database: ReportingDatabase, facilityId: string, options: { reportCode?: string; branchId?: string; status?: string; limit?: number } = {}) {
  const conditions = [eq(reportRuns.facilityId, facilityId)];
  if (options.branchId) conditions.push(eq(reportRuns.branchId, options.branchId));
  if (options.status) conditions.push(eq(reportRuns.status, options.status));
  const rows = await database.select({
    id: reportRuns.id, reportCode: reportCatalogue.reportCode, reportName: reportCatalogue.name, branchId: reportRuns.branchId,
    periodStart: reportRuns.periodStart, periodEnd: reportRuns.periodEnd, epiWeek: reportRuns.epiWeek, epiYear: reportRuns.epiYear,
    month: reportRuns.month, year: reportRuns.year, status: reportRuns.status, rowCount: reportRuns.rowCount, checksum: reportRuns.checksum,
    generatedBy: reportRuns.generatedBy, generatedAt: reportRuns.generatedAt, submittedAt: reportRuns.submittedAt, submittedBy: reportRuns.submittedBy,
    acknowledgementRef: reportRuns.acknowledgementRef, exportedFile: reportRuns.exportedFile, voidedAt: reportRuns.voidedAt, voidReason: reportRuns.voidReason,
  }).from(reportRuns).innerJoin(reportCatalogue, eq(reportCatalogue.id, reportRuns.reportId)).where(and(...conditions, ...(options.reportCode ? [eq(reportCatalogue.reportCode, options.reportCode)] : []))).orderBy(desc(reportRuns.generatedAt)).limit(options.limit ?? 100);
  return rows.map((r) => ({ ...r, generatedAt: asIso(r.generatedAt), submittedAt: asIso(r.submittedAt), voidedAt: asIso(r.voidedAt) }));
}

export async function getReportCells(database: ReportingDatabase, facilityId: string, runId: string) {
  return database.select().from(reportCells).where(and(eq(reportCells.facilityId, facilityId), eq(reportCells.reportRunId, runId))).orderBy(asc(reportCells.sortOrder));
}

function ageAt(date: Date | string | null, ref: Date): number {
  if (!date) return 999;
  const d = date instanceof Date ? date : new Date(date);
  let age = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
function matches705A(row: string, diagnosis: string | null) {
  const d = (diagnosis ?? "").toLowerCase();
  const map: Record<string, string[]> = { "1":["diarrhoea no dehydration","diarrhea no dehydration"],"2":["diarrhoea some dehydration","diarrhea some dehydration"],"3":["diarrhoea severe dehydration","diarrhea severe dehydration"],"4":["cholera"],"5":["dysentery","bloody diarrhoea"],"6":["gastroenteritis"],"7":["pneumonia"],"8":["severe pneumonia"],"9":["upper respiratory","urti"],"10":["lower respiratory","lrti"],"11":["asthma"],"12":["presumed tuberculosis","tuberculosis"],"13":["suspected malaria"],"14":["tested for malaria"],"15":["confirmed malaria"],"16":["ear infection","otitis"],"17":["malnutrition"],"18":["anaemia","anemia"],"19":["meningococcal meningitis"],"20":["meningitis"] };
  const needles = map[row];
  if (!needles) return row === "25" ? !!d : false;
  return needles.some((n) => d.includes(n));
}
function matches705B(row: string, diagnosis: string | null) {
  const d = (diagnosis ?? "").toLowerCase();
  const map: Record<string, string[]> = { "1":["diarrhoea","diarrhea"],"2":["tuberculosis"],"3":["dysentery","bloody diarrhoea"],"4":["cholera"],"5":["meningococcal meningitis"],"6":["meningitis"],"7":["tetanus"],"8":["poliomyelitis","afp"],"9":["chicken pox","varicella"],"10":["measles"],"11":["hepatitis"],"12":["mumps"],"13":["suspected malaria"],"14":["confirmed malaria"],"15":["malaria in pregnancy"],"16":["amoebiasis"],"17":["typhoid"],"18":["sexually transmitted","sti"],"19":["urinary tract","uti"],"20":["bilharzia","schistosomiasis"],"21":["intestinal worms","helminth"],"22":["malnutrition"],"23":["anaemia","anemia"],"24":["eye infection","eye condition"],"25":["ear infection","ear condition"],"26":["upper respiratory","urti"],"27":["asthma"],"28":["pneumonia"],"29":["other lower respiratory"],"30":["abortion"],"31":["puerperium","childbirth"],"32":["hypertension"],"33":["mental disorder"],"34":["dental"],"35":["jiggers"],"36":["skin"],"37":["arthritis","joint pain"],"38":["poisoning"],"39":["road traffic"],"40":["death due to road traffic"],"41":["injury"],"42":["sexual violence"],"43":["violence related"],"44":["burn"],"45":["snake bite"],"46":["dog bite"],"47":["diabetes"],"48":["epilepsy"],"49":["convulsive"],"50":["rheumatic fever"],"51":["brucellosis"],"52":["rickets"],"53":["cerebral palsy"] };
  const needles = map[row];
  if (!needles) return row === "54" ? !!d : false;
  return needles.some((n) => d.includes(n));
}

export async function drillDownReportCell(database: ReportingDatabase, facilityId: string, runId: string, rowCode: string, colKey: string) {
  const [cell] = await database.select().from(reportCells).where(and(eq(reportCells.facilityId, facilityId), eq(reportCells.reportRunId, runId), eq(reportCells.rowCode, rowCode), eq(reportCells.colKey, colKey))).limit(1);
  if (!cell) return null;
  const [run] = await database.select({ reportId: reportRuns.reportId, branchId: reportRuns.branchId, periodStart: reportRuns.periodStart, periodEnd: reportRuns.periodEnd }).from(reportRuns).where(and(eq(reportRuns.facilityId, facilityId), eq(reportRuns.id, runId))).limit(1);
  const [cat] = run ? await database.select({ reportCode: reportCatalogue.reportCode }).from(reportCatalogue).where(eq(reportCatalogue.id, run.reportId)).limit(1) : [undefined];
  const reportCode = cat?.reportCode;
  if (run && (reportCode === "MOH705A" || reportCode === "MOH705B") && colKey.startsWith("d")) {
    const day = colKey.slice(1);
    const dateStr = `${String(run.periodStart).slice(0, 7)}-${day}`;
    const rows = await database.select({ encounterId: encounters.id, startedAt: encounters.startedAt, patientId: encounters.patientId, dob: patients.dob, sex: patients.sex, diagnosis: diagnoses.description, icd10: diagnoses.icd10Code })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .leftJoin(diagnoses, eq(diagnoses.encounterId, encounters.id))
      .where(and(eq(encounters.facilityId, facilityId), gte(encounters.startedAt, new Date(`${dateStr}T00:00:00.000Z`)), lte(encounters.startedAt, new Date(`${dateStr}T23:59:59.999Z`))));
    const matched = rows.filter((r) => {
      const started = r.startedAt instanceof Date ? r.startedAt : new Date(String(r.startedAt));
      const age = ageAt(r.dob, started);
      if (reportCode === "MOH705A" && age >= 5) return false;
      if (reportCode === "MOH705B" && age < 5) return false;
      if (rowCode === "99") return !!r.diagnosis;
      return reportCode === "MOH705A" ? matches705A(rowCode, r.diagnosis) : matches705B(rowCode, r.diagnosis);
    }).map((r) => ({ encounterId: r.encounterId, patientId: r.patientId, startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt), sex: r.sex, diagnosis: r.diagnosis, icd10: r.icd10 }));
    return { cell, sourceQuery: cell.sourceQuery, sourceRows: matched };
  }
  if (run && reportCode === "MOH505") {
    const diseaseMap: Record<string, string[]> = { AJ: ["acute jaundice"], AM: ["acute malnutrition"], AEFI: ["aefi", "adverse events following immunization"], AFP: ["afp", "poliomyelitis", "acute flaccid paralysis"], ANT: ["anthrax"], CHOL: ["cholera"], DENG: ["dengue"], DYS: ["dysentery", "bacillary"], GWD: ["guinea worm"], MAL: ["malaria"], MATD: ["maternal death"], MEA: ["measles"], NEOD: ["neonatal death"], NNT: ["neonatal tetanus"], PLG: ["plague"], RAB: ["rabies"], RVF: ["rift valley fever"], SARI: ["sari"], MDRTB: ["mdr", "xdr", "tuberculosis"], TYP: ["typhoid"], VHF: ["vhf", "viral haemorrhagic"], YF: ["yellow fever"] };
    const needles = diseaseMap[rowCode] ?? [];
    const rows = await database.select().from(notifiableEvents).where(and(eq(notifiableEvents.facilityId, facilityId), gte(notifiableEvents.detectedAt, new Date(`${String(run.periodStart)}T00:00:00.000Z`)), lte(notifiableEvents.detectedAt, new Date(`${String(run.periodEnd)}T23:59:59.999Z`))));
    const matched = rows.filter((r) => {
      const name = (r.diseaseName ?? r.diseaseCode ?? "").toLowerCase();
      if (rowCode === "OTH") return !Object.values(diseaseMap).flat().some((n) => name.includes(n));
      return needles.some((n) => name.includes(n));
    }).map((r) => ({ eventId: r.id, diseaseName: r.diseaseName, detectedAt: r.detectedAt instanceof Date ? r.detectedAt.toISOString() : String(r.detectedAt), status: r.status, patientId: r.patientId }));
    return { cell, sourceQuery: cell.sourceQuery, sourceRows: matched };
  }
  if (run && reportCode === "MOH717") {
    const periodStart = new Date(`${String(run.periodStart)}T00:00:00.000Z`);
    const periodEnd = new Date(`${String(run.periodEnd)}T23:59:59.999Z`);
    if (rowCode === "B.1") {
      const rows = await database.select({ id: birthNotifications.id, birthDate: birthNotifications.birthDate, patientId: birthNotifications.patientId }).from(birthNotifications).where(and(eq(birthNotifications.facilityId, facilityId), gte(birthNotifications.birthDate, String(run.periodStart)), lte(birthNotifications.birthDate, String(run.periodEnd))));
      return { cell, sourceQuery: cell.sourceQuery, sourceRows: rows };
    }
    if (rowCode === "B.2") {
      const rows = await database.select({ id: deathNotifications.id, dateOfDeath: deathNotifications.dateOfDeath, patientId: deathNotifications.patientId }).from(deathNotifications).where(and(eq(deathNotifications.facilityId, facilityId), gte(deathNotifications.dateOfDeath, String(run.periodStart)), lte(deathNotifications.dateOfDeath, String(run.periodEnd))));
      return { cell, sourceQuery: cell.sourceQuery, sourceRows: rows };
    }
    const rows = await database.select({ id: encounters.id, startedAt: encounters.startedAt, patientId: encounters.patientId, dob: patients.dob, sex: patients.sex })
      .from(encounters).innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(and(eq(encounters.facilityId, facilityId), gte(encounters.startedAt, periodStart), lte(encounters.startedAt, periodEnd)));
    const patientIds = Array.from(new Set(rows.map((r) => r.patientId)));
    const priorByPatient = new Set<string>();
    if (patientIds.length > 0) {
      const prior = await database.select({ patientId: encounters.patientId }).from(encounters).where(and(eq(encounters.facilityId, facilityId), inArray(encounters.patientId, patientIds), lt(encounters.startedAt, periodStart)));
      for (const p of prior) priorByPatient.add(p.patientId);
    }
    const matched = rows.filter((r) => {
      const started = r.startedAt instanceof Date ? r.startedAt : new Date(String(r.startedAt));
      const age = ageAt(r.dob, started);
      const male = (r.sex ?? "").toLowerCase() === "male";
      const revisit = priorByPatient.has(r.patientId);
      const colMatch = colKey === "total" ? true : colKey === "new" ? !revisit : colKey === "re_att" ? revisit : true;
      if (!colMatch) return false;
      if (rowCode === "A.1.1") return age >= 5 && male;
      if (rowCode === "A.1.2") return age >= 5 && !male;
      if (rowCode === "A.1.3") return age < 5 && male;
      if (rowCode === "A.1.4") return age < 5 && !male;
      if (rowCode === "A.1.5T") return true;
      if (rowCode === "A.1.60") return age >= 60;
      return false;
    }).map((r) => ({ encounterId: r.id, patientId: r.patientId, startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt), sex: r.sex, revisit: priorByPatient.has(r.patientId) }));
    return { cell, sourceQuery: cell.sourceQuery, sourceRows: matched };
  }
  if (
    run &&
    (reportCode === "MOH710A" || reportCode === "MOH710B" || reportCode === "MOH735" || reportCode === "MOH416")
  ) {
    const periodInput = {
      facilityId,
      branchId: run.branchId,
      periodStart: String(run.periodStart),
      periodEnd: String(run.periodEnd),
    };
    const sources = await fetchMohSources(database, periodInput);
    const sourceRows = mohSourceRowsForCell(reportCode, periodInput, {
      section: cell.section,
      rowCode: cell.rowCode,
      colKey: cell.colKey,
    }, sources);
    return {
      cell,
      sourceQuery: cell.sourceQuery ?? `${reportCode} operational source rows`,
      sourceRows,
    };
  }
  return { cell, sourceQuery: cell.sourceQuery, sourceRows: [] };
}

export async function listNotifiableEvents(database: ReportingDatabase, facilityId: string, options: { status?: string; limit?: number } = {}) {
  const conditions = [eq(notifiableEvents.facilityId, facilityId)];
  if (options.status) conditions.push(eq(notifiableEvents.status, options.status));
  const rows = await database.select().from(notifiableEvents).where(and(...conditions)).orderBy(desc(notifiableEvents.detectedAt)).limit(options.limit ?? 100);
  return rows.map((r) => ({ ...r, detectedAt: asIso(r.detectedAt), reportedAt: asIso(r.reportedAt), createdAt: asIso(r.createdAt), updatedAt: asIso(r.updatedAt) }));
}

export async function listOverdueNotifiableEvents(database: ReportingDatabase, facilityId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await database.select().from(notifiableEvents).where(and(eq(notifiableEvents.facilityId, facilityId), eq(notifiableEvents.status, "draft"), lte(notifiableEvents.detectedAt, cutoff))).orderBy(asc(notifiableEvents.detectedAt));
  return rows.map((r) => ({ ...r, detectedAt: asIso(r.detectedAt), reportedAt: asIso(r.reportedAt) }));
}

export async function getReportRunAuditTrail(database: ReportingDatabase, facilityId: string, runId: string) {
  const rows = await database.select({ id: auditLog.id, action: auditLog.action, entity: auditLog.entity, entityId: auditLog.entityId, createdAt: auditLog.createdAt, actorId: auditLog.userId, details: auditLog.details }).from(auditLog).where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.entity, "report_run"), eq(auditLog.entityId, runId))).orderBy(desc(auditLog.createdAt));
  return rows.map((r) => ({ ...r, createdAt: asIso(r.createdAt) ?? "" }));
}

export interface ReportRunMeta {
  runId: string;
  reportCode: string;
  reportName: string;
  authority: string | null;
  periodType: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  epiWeek: number | null;
  epiYear: number | null;
  month: number | null;
  year: number | null;
  checksum: string | null;
  generatedAt: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  acknowledgementRef: string | null;
  facilityName: string | null;
  branchName: string | null;
  county: string | null;
  subCounty: string | null;
  ward: string | null;
  kmhflId: string | null;
}

export async function getReportRunMeta(
  database: ReportingDatabase,
  facilityId: string,
  runId: string,
): Promise<ReportRunMeta | null> {
  const [row] = await database
    .select({
      runId: reportRuns.id,
      reportCode: reportCatalogue.reportCode,
      reportName: reportCatalogue.name,
      authority: reportCatalogue.authority,
      periodType: reportCatalogue.periodType,
      status: reportRuns.status,
      periodStart: reportRuns.periodStart,
      periodEnd: reportRuns.periodEnd,
      epiWeek: reportRuns.epiWeek,
      epiYear: reportRuns.epiYear,
      month: reportRuns.month,
      year: reportRuns.year,
      checksum: reportRuns.checksum,
      generatedAt: reportRuns.generatedAt,
      submittedAt: reportRuns.submittedAt,
      submittedBy: reportRuns.submittedBy,
      acknowledgementRef: reportRuns.acknowledgementRef,
      branchId: reportRuns.branchId,
      facilityName: facilities.name,
      county: facilityRegulatoryProfiles.county,
      subCounty: facilityRegulatoryProfiles.subCounty,
      ward: facilityRegulatoryProfiles.ward,
      kmhflId: facilityRegulatoryProfiles.kmhflId,
    })
    .from(reportRuns)
    .innerJoin(reportCatalogue, eq(reportCatalogue.id, reportRuns.reportId))
    .innerJoin(facilities, eq(facilities.id, reportRuns.facilityId))
    .leftJoin(
      facilityRegulatoryProfiles,
      eq(facilityRegulatoryProfiles.facilityId, reportRuns.facilityId),
    )
    .where(and(eq(reportRuns.facilityId, facilityId), eq(reportRuns.id, runId)))
    .limit(1);
  if (!row) return null;

  let branchName: string | null = null;
  if (row.branchId) {
    const [branch] = await database
      .select({ name: branches.name })
      .from(branches)
      .where(and(eq(branches.facilityId, facilityId), eq(branches.id, row.branchId)))
      .limit(1);
    branchName = branch?.name ?? null;
  }

  return {
    runId: row.runId,
    reportCode: row.reportCode,
    reportName: row.reportName,
    authority: row.authority ?? null,
    periodType: row.periodType,
    status: row.status,
    periodStart: String(row.periodStart),
    periodEnd: String(row.periodEnd),
    epiWeek: row.epiWeek ?? null,
    epiYear: row.epiYear ?? null,
    month: row.month ?? null,
    year: row.year ?? null,
    checksum: row.checksum ?? null,
    generatedAt: asIso(row.generatedAt),
    submittedAt: asIso(row.submittedAt),
    submittedBy: row.submittedBy ?? null,
    acknowledgementRef: row.acknowledgementRef ?? null,
    facilityName: row.facilityName ?? null,
    branchName,
    county: row.county ?? null,
    subCounty: row.subCounty ?? null,
    ward: row.ward ?? null,
    kmhflId: row.kmhflId ?? null,
  };
}
