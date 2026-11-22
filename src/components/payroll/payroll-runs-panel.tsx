"use client";

import { useState } from "react";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  BUTTON_CLASS,
  formatDate,
  formatMoney,
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type PayrollPanelProps,
  type PayrollRunRow,
} from "@/components/payroll/payroll-types";

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "posted") return "success";
  if (status === "approved") return "warning";
  if (status === "draft") return "neutral";
  return "neutral";
}

function MissingRates({ types }: { types: string[] }) {
  if (types.length === 0) return null;
  return (
    <p className="mt-2 text-xs text-[var(--status-warning-foreground)]">
      Missing statutory rates: {types.join(", ")}. Unset rates compute zero and must be reviewed
      before this run is used as payroll evidence.
    </p>
  );
}

export function RunsPanel({ data, canWrite, busy, run, selectRun }: PayrollPanelProps) {
  const [periodStart, setPeriodStart] = useState(todayIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [description, setDescription] = useState("");

  const detail = data.detail;

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createPayrollRun",
      {
        periodStart,
        periodEnd,
        description: description.trim() || null,
        allocations: [],
      },
      "Payroll run prepared",
    );
    if (ok) setDescription("");
  }

  function beginApproval(runRow: PayrollRunRow) {
    selectRun(runRow.id);
  }

  async function approve(runId: string) {
    await run("approvePayrollRun", { runId, reason: null }, "Payroll run approved");
  }

  async function post(runId: string) {
    await run("postPayrollRun", { runId }, "Payroll posted and payslips issued");
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Prepare payroll run"
          description="Uses each active employee's current contract and facility statutory rates. No rate is hard-coded."
        >
          <form onSubmit={prepare} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Period start">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                  required
                />
              </Field>
              <Field label="Period end">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                  required
                />
              </Field>
              <Field label="Description" hint="Optional">
                <input
                  className={INPUT_CLASS}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={500}
                />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Prepare run
            </button>
          </form>
          <MissingRates types={data.overview?.missingRateTypes ?? []} />
        </Panel>
      ) : null}

      <Panel
        title="Payroll runs"
        description="Preparation, approval and posting are separate actions with different actors."
        testId="payroll-run-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Run</th>
                <th scope="col" className={TH_CLASS}>Period</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Employees</th>
                <th scope="col" className={TH_CLASS}>Net pay</th>
                <th scope="col" className={TH_CLASS}>Journal</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.length === 0 ? (
                <EmptyRow colSpan={7} message="No payroll runs have been prepared yet." />
              ) : (
                data.runs.map((runRow) => {
                  const isPreparer = runRow.preparedBy === data.viewerId;
                  return (
                    <tr key={runRow.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{runRow.runNo}</td>
                      <td className={TD_CLASS}>
                        {formatDate(runRow.periodStart)} – {formatDate(runRow.periodEnd)}
                      </td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={statusTone(runRow.status)}>{runRow.status}</StatusPill>
                      </td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>
                        {detail?.id === runRow.id ? detail.lines.length : "—"}
                      </td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>
                        {formatMoney(runRow.totalNet)}
                      </td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{runRow.entryNo ?? "—"}</td>
                      <td className={TD_CLASS}>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            onClick={() => beginApproval(runRow)}
                          >
                            View
                          </button>
                          {canWrite && runRow.status === "draft" ? (
                            <button
                              type="button"
                              className={SUBTLE_BUTTON_CLASS}
                              disabled={busy || isPreparer}
                              title={isPreparer ? "A different user must approve this run" : undefined}
                              onClick={() => void approve(runRow.id)}
                            >
                              Approve
                            </button>
                          ) : null}
                          {canWrite && runRow.status === "approved" ? (
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              disabled={busy}
                              onClick={() => void post(runRow.id)}
                            >
                              Post
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {detail ? (
        <Panel
          title={`Run detail · ${detail.runNo}`}
          description="Rate-driven calculations and issued payslips are immutable once posted."
          testId="payroll-run-detail"
        >
          <div className="mb-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <span>Gross {formatMoney(detail.totalGross)}</span>
            <span>Deductions {formatMoney(detail.totalDeductions)}</span>
            <span>Employer cost {formatMoney(detail.totalEmployerCost)}</span>
          </div>
          <MissingRates types={detail.missingRateTypes} />
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Employee</th>
                  <th scope="col" className={TH_CLASS}>Basic</th>
                  <th scope="col" className={TH_CLASS}>Allowances</th>
                  <th scope="col" className={TH_CLASS}>Gross</th>
                  <th scope="col" className={TH_CLASS}>PAYE</th>
                  <th scope="col" className={TH_CLASS}>NSSF emp.</th>
                  <th scope="col" className={TH_CLASS}>NSSF er.</th>
                  <th scope="col" className={TH_CLASS}>SHIF</th>
                  <th scope="col" className={TH_CLASS}>Housing</th>
                  <th scope="col" className={TH_CLASS}>Net</th>
                  <th scope="col" className={TH_CLASS}>Cost centre</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.length === 0 ? (
                  <EmptyRow colSpan={11} message="This run has no payroll lines." />
                ) : (
                  detail.lines.map((line) => (
                    <tr key={line.id}>
                      <td className={TD_CLASS}>
                        <span className="block text-sm text-foreground">{line.employeeName}</span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {line.employeeNo}
                        </span>
                      </td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.basicSalary)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.allowances)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.grossPay)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.paye)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.nssfEmployee)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.nssfEmployer)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.shif)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.housingLevy)}</td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(line.netPay)}</td>
                      <td className={TD_CLASS}>{line.costCenterName ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {detail && detail.payslips.length > 0 ? (
        <Panel title="Payslips" description="Append-only snapshots issued when the run is posted." testId="payroll-payslip-list">
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Slip</th>
                  <th scope="col" className={TH_CLASS}>Employee</th>
                  <th scope="col" className={TH_CLASS}>Period</th>
                  <th scope="col" className={TH_CLASS}>Net pay</th>
                  <th scope="col" className={TH_CLASS}>Issued</th>
                </tr>
              </thead>
              <tbody>
                {detail.payslips.map((slip) => (
                  <tr key={slip.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{slip.slipNo}</td>
                    <td className={TD_CLASS}>{slip.employeeName}</td>
                    <td className={TD_CLASS}>
                      {formatDate(detail.periodStart)} – {formatDate(detail.periodEnd)}
                    </td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>
                      {formatMoney(String(slip.snapshot.netPay ?? "0"))}
                    </td>
                    <td className={TD_CLASS}>{formatDate(slip.issuedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {detail && detail.approvals.length > 0 ? (
        <Panel title="Approval history" description="Every decision is recorded with its actor." testId="payroll-approval-list">
          <ul className="space-y-2 text-sm">
            {detail.approvals.map((approval) => (
              <li key={approval.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="font-medium">{approval.decision}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {approval.actorId} · {formatDate(approval.decidedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
