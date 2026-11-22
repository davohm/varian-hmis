import { describe, expect, it } from "vitest";

import {
  ERP_REPORT_CODES,
  PROMPT17_ERP_REPORTS,
  PROMPT20_REPORTS,
  computeReportChecksum,
  daysInMonth,
  getEpiWeek,
  getMonthPeriod,
  isFutureDate,
  periodOverlapsClosedFiscalPeriod,
} from "../src/lib/reporting";

describe("reporting utilities", () => {
  it("exposes the eight prompt 20 statutory reports", () => {
    expect(PROMPT20_REPORTS).toHaveLength(8);
    expect(PROMPT20_REPORTS.map((report) => report.reportCode)).toEqual([
      "MOH705A",
      "MOH705B",
      "MOH717",
      "MOH505",
      "MOH710A",
      "MOH710B",
      "MOH416",
      "MOH735",
    ]);
  });

  it("exposes the prompt 17 ERP management reports", () => {
    expect(PROMPT17_ERP_REPORTS).toHaveLength(8);
    expect(ERP_REPORT_CODES).toEqual([
      "ERP_FINANCIAL_STATEMENTS",
      "ERP_TRIAL_BALANCE",
      "ERP_SUPPLIER_AGEING",
      "ERP_CLAIM_AGEING",
      "ERP_STOCK_VALUATION",
      "ERP_BUDGET_VARIANCE",
      "ERP_PAYROLL_SUMMARY",
      "ERP_APPROVAL_INBOX",
    ]);
  });

  it("derives ISO epi week and epi year, including dates in the previous calendar year", () => {
    expect(getEpiWeek("2020-12-31")).toMatchObject({ epiWeek: 53, epiYear: 2020 });
    expect(getEpiWeek("2021-01-01")).toMatchObject({ epiWeek: 53, epiYear: 2020 });
    expect(getEpiWeek("2021-01-04")).toMatchObject({ epiWeek: 1, epiYear: 2021 });
    expect(getEpiWeek("2014-12-29")).toMatchObject({ epiWeek: 1, epiYear: 2015 });
    expect(getEpiWeek("2015-01-01")).toMatchObject({ epiWeek: 1, epiYear: 2015 });
  });

  it("returns epi week bounds", () => {
    const week = getEpiWeek("2026-03-18");
    expect(week.weekStart <= "2026-03-18").toBe(true);
    expect(week.weekEnding >= "2026-03-18").toBe(true);
    expect(week.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(week.weekEnding).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("builds month periods and day counts", () => {
    expect(getMonthPeriod(2026, 2)).toEqual({
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      month: 2,
      year: 2026,
    });
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("detects future and closed-period overlaps", () => {
    expect(isFutureDate("2026-12-31", "2026-11-20")).toBe(true);
    expect(isFutureDate("2026-11-20", "2026-11-20")).toBe(false);
    expect(isFutureDate("2026-11-19", "2026-11-20")).toBe(false);
    expect(
      periodOverlapsClosedFiscalPeriod("2026-03-01", "2026-03-31", [
        { startDate: "2026-01-01", endDate: "2026-02-28" },
      ]),
    ).toBe(false);
    expect(
      periodOverlapsClosedFiscalPeriod("2026-02-15", "2026-03-15", [
        { startDate: "2026-02-01", endDate: "2026-02-28" },
      ]),
    ).toBe(true);
  });

  it("computes a stable checksum independent of input order", () => {
    const a = computeReportChecksum([
      { section: "A", rowCode: "r1", colKey: "d01", valueNumeric: "2", sortOrder: 1 },
      { section: "A", rowCode: "r2", colKey: "total", valueNumeric: 3, sortOrder: 2, isTotal: true },
    ]);
    const b = computeReportChecksum([
      { section: "A", rowCode: "r2", colKey: "total", valueNumeric: "3.0", sortOrder: 2, isTotal: true },
      { section: "A", rowCode: "r1", colKey: "d01", valueNumeric: 2, sortOrder: 1 },
    ]);
    const c = computeReportChecksum([
      { section: "A", rowCode: "r1", colKey: "d01", valueNumeric: "3", sortOrder: 1 },
      { section: "A", rowCode: "r2", colKey: "total", valueNumeric: 3, sortOrder: 2, isTotal: true },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
