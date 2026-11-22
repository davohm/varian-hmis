/**
 * Pure payroll arithmetic. No statutory value lives here: every rate is read
 * from the facility's admin-entered statutory_rates at run time. An unset rate
 * contributes zero and is reported in missingRateTypes so the run can be
 * reviewed before approval instead of silently under-deducing.
 */

import { fromCents, toCents } from "@/lib/billing";

export const PAYROLL_RATE_TYPES = [
  "paye_band",
  "nssf_tier",
  "nssf_employer",
  "shif",
  "housing_levy",
] as const;
export type PayrollRateType = (typeof PAYROLL_RATE_TYPES)[number];

export const PAYROLL_RATE_TYPE_LABELS: Record<PayrollRateType, string> = {
  paye_band: "PAYE bands",
  nssf_tier: "NSSF employee",
  nssf_employer: "NSSF employer",
  shif: "SHIF",
  housing_levy: "Housing levy",
};

export interface PayrollRateRow {
  rateType: string;
  bandOrder: number;
  lowerBound: string;
  upperBound: string | null;
  ratePercent: string;
  fixedAmount: string | null;
}

export interface PayrollCalculationInput {
  basicCents: number;
  allowancesCents: number;
  otherDeductionCents?: number;
  rates: PayrollRateRow[];
}

export interface PayrollCalculation {
  gross: string;
  paye: string;
  nssfEmployee: string;
  nssfEmployer: string;
  shif: string;
  housingLevy: string;
  otherDeductions: string;
  netPay: string;
  employerCost: string;
  missingRateTypes: PayrollRateType[];
  grossCents: number;
  netCents: number;
}

/** Bands are inclusive at both ends; an open upper bound means "and above". */
function matchingBand(rates: PayrollRateRow[], type: PayrollRateType, grossCents: number) {
  return rates
    .filter((rate) => rate.rateType === type)
    .filter((rate) => {
      const lower = toCents(rate.lowerBound);
      const upper = rate.upperBound === null ? null : toCents(rate.upperBound);
      return grossCents >= lower && (upper === null || grossCents <= upper);
    })
    .sort((a, b) => b.bandOrder - a.bandOrder || toCents(b.lowerBound) - toCents(a.lowerBound))[0];
}

function bandAmountCents(rate: PayrollRateRow, grossCents: number): number {
  const lower = toCents(rate.lowerBound);
  const fixed = rate.fixedAmount === null ? 0 : toCents(rate.fixedAmount);
  const percent = Number(rate.ratePercent);
  const taxable = percent > 0 ? Math.max(0, grossCents - lower) : 0;
  return fixed + Math.round((taxable * percent) / 100);
}

function chargeCents(
  rates: PayrollRateRow[],
  type: PayrollRateType,
  grossCents: number,
): { cents: number; missing: boolean } {
  const band = matchingBand(rates, type, grossCents);
  if (!band) return { cents: 0, missing: true };
  return { cents: bandAmountCents(band, grossCents), missing: false };
}

export function calculatePayroll(input: PayrollCalculationInput): PayrollCalculation {
  const grossCents = input.basicCents + input.allowancesCents;
  const otherDeductionCents = Math.max(0, input.otherDeductionCents ?? 0);

  const paye = chargeCents(input.rates, "paye_band", grossCents);
  const nssfEmployee = chargeCents(input.rates, "nssf_tier", grossCents);
  const nssfEmployer = chargeCents(input.rates, "nssf_employer", grossCents);
  const shif = chargeCents(input.rates, "shif", grossCents);
  const housingLevy = chargeCents(input.rates, "housing_levy", grossCents);

  const deductionCents =
    paye.cents + nssfEmployee.cents + shif.cents + housingLevy.cents + otherDeductionCents;
  const netCents = grossCents - deductionCents;
  if (netCents < 0) {
    throw new Error("Statutory deductions and other deductions exceed gross pay");
  }

  const missingRateTypes = PAYROLL_RATE_TYPES.filter(
    (type) =>
      (type === "paye_band" && paye.missing) ||
      (type === "nssf_tier" && nssfEmployee.missing) ||
      (type === "nssf_employer" && nssfEmployer.missing) ||
      (type === "shif" && shif.missing) ||
      (type === "housing_levy" && housingLevy.missing),
  );

  return {
    gross: fromCents(grossCents),
    paye: fromCents(paye.cents),
    nssfEmployee: fromCents(nssfEmployee.cents),
    nssfEmployer: fromCents(nssfEmployer.cents),
    shif: fromCents(shif.cents),
    housingLevy: fromCents(housingLevy.cents),
    otherDeductions: fromCents(otherDeductionCents),
    netPay: fromCents(netCents),
    employerCost: fromCents(grossCents + nssfEmployer.cents),
    missingRateTypes,
    grossCents,
    netCents,
  };
}
