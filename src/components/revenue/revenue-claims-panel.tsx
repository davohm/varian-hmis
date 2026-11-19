"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  SubHeading,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import { PatientPicker } from "@/components/revenue/revenue-patient-picker";
import {
  CLAIM_STATUSES,
  formatDate,
  formatMoney,
  STATUS_TONE,
  type PatientResult,
  type RevenuePanelProps,
} from "@/components/revenue/revenue-types";
import { useRevenueCommand } from "@/components/revenue/use-revenue-command";

export function ClaimsPanel({ data, canWrite, refresh, selectClaim, selectedClaimId }: RevenuePanelProps) {
  const { busy, run } = useRevenueCommand(refresh);
  const [showForm, setShowForm] = useState(false);
  const [patient, setPatient] = useState<PatientResult | null>(null);
  const [encounterId, setEncounterId] = useState("");
  const [draft, setDraft] = useState({
    payerId: "",
    contractId: "",
    preAuthId: "",
    invoiceId: "",
    description: "",
    amount: "",
    notes: "",
  });
  const [transition, setTransition] = useState({ to: "submitted", approvedAmount: "", note: "" });
  const [showRemittance, setShowRemittance] = useState(false);
  const [remittance, setRemittance] = useState({ amount: "", reference: "", receivedAt: "" });
  const [showDenial, setShowDenial] = useState(false);
  const [denial, setDenial] = useState({ reason: "", amount: "" });

  const encounters = patient
    ? data.encounters.filter((item) => item.patientId === patient.id)
    : data.encounters;
  const encounter = data.encounters.find((item) => item.id === encounterId) ?? null;

  useEffect(() => {
    if (encounterId && !encounters.some((item) => item.id === encounterId)) setEncounterId("");
  }, [encounterId, encounters]);

  async function createClaim(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "createClaim",
      {
        payerId: draft.payerId,
        contractId: draft.contractId || null,
        preAuthId: draft.preAuthId || null,
        patientId: patient?.id,
        encounterId,
        invoiceId: draft.invoiceId || null,
        notes: draft.notes.trim() || null,
        lines: [{ description: draft.description.trim(), amount: draft.amount }],
      },
      "Claim created",
    );
    if (ok) {
      setDraft({ payerId: "", contractId: "", preAuthId: "", invoiceId: "", description: "", amount: "", notes: "" });
      setPatient(null);
      setEncounterId("");
      setShowForm(false);
    }
  }

  async function applyTransition(event: FormEvent) {
    event.preventDefault();
    await run(
      "transitionClaim",
      {
        claimId: selectedClaimId,
        to: transition.to,
        approvedAmount: transition.approvedAmount || null,
        note: transition.note.trim() || null,
      },
      `Claim marked ${transition.to}`,
    );
  }

  async function recordRemittance(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "recordRemittance",
      {
        claimId: selectedClaimId,
        amount: remittance.amount,
        reference: remittance.reference.trim() || null,
        receivedAt: remittance.receivedAt || undefined,
      },
      "Remittance recorded",
    );
    if (ok) {
      setRemittance({ amount: "", reference: "", receivedAt: "" });
      setShowRemittance(false);
    }
  }

  async function recordDenial(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "recordClaimDenial",
      {
        claimId: selectedClaimId,
        reason: denial.reason.trim(),
        amount: denial.amount || undefined,
      },
      "Denial recorded",
    );
    if (ok) {
      setDenial({ reason: "", amount: "" });
      setShowDenial(false);
    }
  }

  const detail = data.claimDetail;

  return (
    <div className="space-y-4">
      <Panel
        title="Claims"
        description="Draft, submit and settle payer claims."
        testId="revenue-claims-panel"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={() => setShowForm((current) => !current)}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="revenue-new-claim"
            >
              New claim
            </button>
          ) : null
        }
      >
        {showForm ? (
          <form onSubmit={(event) => void createClaim(event)} className="mb-4 space-y-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="revenue-claim-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Payer">
                <select required value={draft.payerId} onChange={(event) => setDraft({ ...draft, payerId: event.target.value, contractId: "", preAuthId: "" })} className={INPUT_CLASS} aria-label="Payer">
                  <option value="">Select a payer</option>
                  {data.payers.filter((payer) => payer.active).map((payer) => (
                    <option key={payer.id} value={payer.id}>{payer.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Contract" hint="Optional">
                <select value={draft.contractId} onChange={(event) => setDraft({ ...draft, contractId: event.target.value })} className={INPUT_CLASS} aria-label="Contract">
                  <option value="">No contract</option>
                  {data.contracts.filter((item) => item.payerId === draft.payerId && item.status === "active").map((item) => (
                    <option key={item.id} value={item.id}>{item.contractNo}</option>
                  ))}
                </select>
              </Field>
            </div>
            <PatientPicker onPatientChange={setPatient} testId="revenue-claim" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Encounter" hint={patient ? "Visits for the selected patient" : "All recent visits"}>
                <select required value={encounterId} onChange={(event) => setEncounterId(event.target.value)} className={INPUT_CLASS} aria-label="Encounter" data-testid="revenue-encounter-select">
                  <option value="">Select an encounter</option>
                  {encounters.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.encounterNo} · {item.patientName} · {formatDate(item.startedAt)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Invoice" hint="Optional — adds the invoice as the claim source">
                <select value={draft.invoiceId} onChange={(event) => setDraft({ ...draft, invoiceId: event.target.value })} className={INPUT_CLASS} aria-label="Invoice" data-testid="revenue-invoice-select">
                  <option value="">No invoice</option>
                  {encounter?.invoiceId ? (
                    <option value={encounter.invoiceId}>{encounter.invoiceNo} · {formatMoney(encounter.invoiceTotal ?? "0")}</option>
                  ) : null}
                </select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pre-authorisation" hint="Optional">
                <select value={draft.preAuthId} onChange={(event) => setDraft({ ...draft, preAuthId: event.target.value })} className={INPUT_CLASS} aria-label="Pre-authorisation">
                  <option value="">None</option>
                  {data.preAuthorizations.filter((item) => item.payerId === draft.payerId && item.status === "approved").map((item) => (
                    <option key={item.id} value={item.id}>{item.authNo} · {formatMoney(item.approvedAmount ?? item.requestedAmount)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Line description">
                <input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className={INPUT_CLASS} aria-label="Line description" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Claim amount">
                <input required type="number" min="0.01" step="0.01" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} className={INPUT_CLASS} aria-label="Claim amount" />
              </Field>
              <Field label="Notes" hint="Optional">
                <input value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} className={INPUT_CLASS} aria-label="Notes" />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
              <button type="submit" disabled={busy || !patient || !encounterId} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-create-claim">Create claim</button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="revenue-claims-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Claim no</th>
                <th className={TH_CLASS}>Payer</th>
                <th className={TH_CLASS}>Patient</th>
                <th className={TH_CLASS}>Status</th>
                <th className={TH_CLASS}>Total</th>
                <th className={TH_CLASS}>Outstanding</th>
                <th className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.claims.length === 0 ? (
                <EmptyRow colSpan={7} message="No claims match the current filters." />
              ) : (
                data.claims.map((row) => (
                  <tr key={row.id} data-testid={`revenue-claim-${row.claimNo}`}>
                    <td className={`${TD_CLASS} font-mono`}>{row.claimNo}</td>
                    <td className={TD_CLASS}>{row.payerName}</td>
                    <td className={TD_CLASS}>{row.patientName}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusPill>
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.total)}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.outstanding)}</td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        onClick={() => selectClaim(row.id)}
                        className="text-xs font-medium text-primary hover:underline"
                        data-testid={`revenue-open-claim-${row.claimNo}`}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {detail ? (
        <Panel
          title={`Claim ${detail.claimNo}`}
          description={`${detail.payerName} · ${detail.patientName} · ${detail.status}`}
          testId="revenue-claim-detail"
          action={
            <button
              type="button"
              onClick={() => selectClaim("")}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted"
            >
              Close
            </button>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Claimed</p>
                <p className="font-mono text-sm font-semibold tabular-nums">{formatMoney(detail.total)}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Approved</p>
                <p className="font-mono text-sm font-semibold tabular-nums">{formatMoney(detail.approvedAmount)}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Paid</p>
                <p className="font-mono text-sm font-semibold tabular-nums">{formatMoney(detail.paidAmount)}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p className="font-mono text-sm font-semibold tabular-nums">{formatMoney(detail.outstanding)}</p>
              </div>
            </div>

            <SubHeading title="Lines" description="Services billed on this claim." />
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS} data-testid="revenue-claim-lines-table">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>Description</th>
                    <th className={TH_CLASS}>Claimed</th>
                    <th className={TH_CLASS}>Approved</th>
                    <th className={TH_CLASS}>Denial reason</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.length === 0 ? (
                    <EmptyRow colSpan={4} message="No lines recorded on this claim." />
                  ) : (
                    detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td className={TD_CLASS}>{line.description}</td>
                        <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(line.amount)}</td>
                        <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(line.approvedAmount)}</td>
                        <td className={TD_CLASS}>{line.denialReason ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <SubHeading title="Remittances" description="Payments received against this claim." />
                <div className="overflow-x-auto">
                  <table className={TABLE_CLASS} data-testid="revenue-claim-remittances-table">
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>No</th>
                        <th className={TH_CLASS}>Amount</th>
                        <th className={TH_CLASS}>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.remittances.length === 0 ? (
                        <EmptyRow colSpan={3} message="No remittances recorded." />
                      ) : (
                        detail.remittances.map((row) => (
                          <tr key={row.id}>
                            <td className={`${TD_CLASS} font-mono`}>{row.remittanceNo}</td>
                            <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.amount)}</td>
                            <td className={`${TD_CLASS} text-xs`}>{formatDate(row.receivedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <SubHeading title="Denials" description="Payer rejections and their status." />
                <div className="overflow-x-auto">
                  <table className={TABLE_CLASS} data-testid="revenue-claim-denials-table">
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Reason</th>
                        <th className={TH_CLASS}>Amount</th>
                        <th className={TH_CLASS}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.denials.length === 0 ? (
                        <EmptyRow colSpan={3} message="No denials recorded." />
                      ) : (
                        detail.denials.map((row) => (
                          <tr key={row.id}>
                            <td className={TD_CLASS}>{row.reason}</td>
                            <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.amount)}</td>
                            <td className={TD_CLASS}>
                              <StatusPill tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusPill>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {canWrite ? (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <SubHeading title="Claim actions" description="Move the claim through its lifecycle or record an outcome." />
                <form onSubmit={(event) => void applyTransition(event)} className="grid gap-3 sm:grid-cols-4" data-testid="revenue-claim-transition-form">
                  <Field label="Next status">
                    <select value={transition.to} onChange={(event) => setTransition({ ...transition, to: event.target.value })} className={INPUT_CLASS} aria-label="Next status" data-testid="revenue-claim-status">
                      {CLAIM_STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </Field>
                  <Field label="Approved amount" hint="For accepted claims">
                    <input type="number" min="0" step="0.01" value={transition.approvedAmount} onChange={(event) => setTransition({ ...transition, approvedAmount: event.target.value })} className={INPUT_CLASS} aria-label="Approved amount" />
                  </Field>
                  <Field label="Note" hint="Optional">
                    <input value={transition.note} onChange={(event) => setTransition({ ...transition, note: event.target.value })} className={INPUT_CLASS} aria-label="Transition note" />
                  </Field>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-apply-transition">Apply status</button>
                  </div>
                </form>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setShowRemittance((current) => !current)} className="inline-flex h-9 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted" data-testid="revenue-record-remittance">Record remittance</button>
                  <button type="button" onClick={() => setShowDenial((current) => !current)} className="inline-flex h-9 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted" data-testid="revenue-record-denial">Record denial</button>
                </div>
                {showRemittance ? (
                  <form onSubmit={(event) => void recordRemittance(event)} className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-4" data-testid="revenue-remittance-form">
                    <Field label="Amount">
                      <input required type="number" min="0.01" step="0.01" value={remittance.amount} onChange={(event) => setRemittance({ ...remittance, amount: event.target.value })} className={INPUT_CLASS} aria-label="Remittance amount" />
                    </Field>
                    <Field label="Reference" hint="Optional">
                      <input value={remittance.reference} onChange={(event) => setRemittance({ ...remittance, reference: event.target.value })} className={INPUT_CLASS} aria-label="Remittance reference" />
                    </Field>
                    <Field label="Received at" hint="Optional">
                      <input type="date" value={remittance.receivedAt} onChange={(event) => setRemittance({ ...remittance, receivedAt: event.target.value })} className={INPUT_CLASS} aria-label="Received at" />
                    </Field>
                    <div className="flex items-end">
                      <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-save-remittance">Save remittance</button>
                    </div>
                  </form>
                ) : null}
                {showDenial ? (
                  <form onSubmit={(event) => void recordDenial(event)} className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-3" data-testid="revenue-denial-form">
                    <Field label="Reason">
                      <input required value={denial.reason} onChange={(event) => setDenial({ ...denial, reason: event.target.value })} className={INPUT_CLASS} aria-label="Denial reason" />
                    </Field>
                    <Field label="Amount" hint="Defaults to the claim total">
                      <input type="number" min="0" step="0.01" value={denial.amount} onChange={(event) => setDenial({ ...denial, amount: event.target.value })} className={INPUT_CLASS} aria-label="Denial amount" />
                    </Field>
                    <div className="flex items-end">
                      <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-save-denial">Save denial</button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
