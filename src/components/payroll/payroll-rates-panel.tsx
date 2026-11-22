"use client";

import { AlertTriangle, ExternalLink } from "lucide-react";
import Link from "next/link";

import {
  EmptyRow,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  PAYROLL_RATE_TYPES,
  PAYROLL_RATE_TYPE_LABELS,
  type PayrollRateType,
} from "@/lib/payroll";
import {
  formatDate,
  formatMoney,
  type PayrollData,
} from "@/components/payroll/payroll-types";

function isPayrollRateType(rateType: string): rateType is PayrollRateType {
  return (PAYROLL_RATE_TYPES as readonly string[]).includes(rateType);
}

function isTestOnly(input: { rateType: string; legalReference: string | null }): boolean {
  const reference = (input.legalReference ?? "").toLowerCase();
  return (
    !isPayrollRateType(input.rateType) ||
    reference.includes("test") ||
    reference.includes("placeholder") ||
    reference.includes("demo")
  );
}

export function RatesPanel({ rates }: Pick<PayrollData, "rates">) {
  const payrollRates = rates.filter((rate) => isPayrollRateType(rate.rateType));
  const testRates = rates.filter(isTestOnly);
  const coveredTypes = new Set(payrollRates.filter((rate) => rate.active).map((rate) => rate.rateType));
  const missing = PAYROLL_RATE_TYPES.filter((type) => !coveredTypes.has(type));

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-4 text-sm text-[var(--status-warning-foreground)]">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 space-y-2">
            <p className="font-medium">Rates are administered, not inferred.</p>
            <p>
              Payroll reads admin-entered statutory rates at run time. Unset rates contribute zero
              and appear as warnings on the run. Placeholder or test rows are never valid payroll or
              compliance evidence.
            </p>
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              Open administration <ExternalLink className="size-3" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>

      {missing.length > 0 ? (
        <Panel title="Missing payroll rate types" description="These contribute zero until an administrator enters them.">
          <div className="flex flex-wrap gap-2">
            {missing.map((type) => (
              <StatusPill key={type} tone="warning">
                {PAYROLL_RATE_TYPE_LABELS[type]}
              </StatusPill>
            ))}
          </div>
        </Panel>
      ) : null}

      {testRates.length > 0 ? (
        <Panel title="Test-only rows" description="Excluded from payroll arithmetic and never compliance evidence.">
          <div className="space-y-2">
            {testRates.map((rate) => (
              <div key={rate.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium">{rate.rateType}</span>
                <StatusPill tone="danger">test only</StatusPill>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Statutory rate register" description="Effective-dated rows entered in Administration → Regulatory → Statutory tables." testId="payroll-rate-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Type</th>
                <th scope="col" className={TH_CLASS}>Band</th>
                <th scope="col" className={TH_CLASS}>Range</th>
                <th scope="col" className={TH_CLASS}>Rate</th>
                <th scope="col" className={TH_CLASS}>Effective</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rates.length === 0 ? (
                <EmptyRow colSpan={6} message="No statutory rates have been entered at this facility." />
              ) : (
                rates.map((rate) => (
                  <tr key={rate.id}>
                    <td className={TD_CLASS}>
                      {isPayrollRateType(rate.rateType)
                        ? PAYROLL_RATE_TYPE_LABELS[rate.rateType]
                        : rate.rateType}
                    </td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>{rate.bandOrder}</td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>
                      {formatMoney(rate.lowerBound)} – {rate.upperBound === null ? "above" : formatMoney(rate.upperBound)}
                    </td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>
                      {rate.ratePercent}% {rate.fixedAmount ? `+ ${formatMoney(rate.fixedAmount)}` : ""}
                    </td>
                    <td className={TD_CLASS}>
                      {formatDate(rate.effectiveFrom)}
                      {rate.effectiveTo ? ` – ${formatDate(rate.effectiveTo)}` : ""}
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap gap-1">
                        <StatusPill tone={rate.active ? "success" : "neutral"}>
                          {rate.active ? "active" : "inactive"}
                        </StatusPill>
                        {isTestOnly(rate) ? <StatusPill tone="danger">test only</StatusPill> : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
