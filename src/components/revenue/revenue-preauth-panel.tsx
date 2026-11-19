"use client";

import { useState, type FormEvent } from "react";

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
import { PatientPicker } from "@/components/revenue/revenue-patient-picker";
import {
  formatDate,
  formatMoney,
  STATUS_TONE,
  type PatientResult,
  type RevenuePanelProps,
} from "@/components/revenue/revenue-types";
import { useRevenueCommand } from "@/components/revenue/use-revenue-command";

export function PreAuthorizationPanel({ data, canWrite, refresh }: RevenuePanelProps) {
  const { busy, run } = useRevenueCommand(refresh);
  const [showForm, setShowForm] = useState(false);
  const [patient, setPatient] = useState<PatientResult | null>(null);
  const [request, setRequest] = useState({
    payerId: "",
    contractId: "",
    requestedAmount: "",
    reference: "",
    expiresAt: "",
    notes: "",
  });
  const [decisionId, setDecisionId] = useState("");
  const [decision, setDecision] = useState({ approvedAmount: "", notes: "" });

  async function submitRequest(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "requestPreAuthorization",
      {
        payerId: request.payerId,
        contractId: request.contractId || null,
        patientId: patient?.id,
        requestedAmount: request.requestedAmount,
        reference: request.reference.trim() || null,
        expiresAt: request.expiresAt || null,
        notes: request.notes.trim() || null,
      },
      "Pre-authorisation requested",
    );
    if (ok) {
      setRequest({ payerId: "", contractId: "", requestedAmount: "", reference: "", expiresAt: "", notes: "" });
      setPatient(null);
      setShowForm(false);
    }
  }

  async function submitDecision(approved: boolean) {
    const ok = await run(
      "decidePreAuthorization",
      {
        preAuthId: decisionId,
        decision: approved ? "approved" : "declined",
        approvedAmount: approved ? decision.approvedAmount || null : null,
        notes: decision.notes.trim() || null,
      },
      approved ? "Pre-authorisation approved" : "Pre-authorisation declined",
    );
    if (ok) {
      setDecisionId("");
      setDecision({ approvedAmount: "", notes: "" });
    }
  }

  return (
    <Panel
      title="Pre-authorisations"
      description="Payer approvals requested before high-cost care."
      testId="revenue-preauth-panel"
      action={
        canWrite ? (
          <button
            type="button"
            onClick={() => setShowForm((current) => !current)}
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="revenue-new-preauth"
          >
            Request pre-authorisation
          </button>
        ) : null
      }
    >
      {showForm ? (
        <form onSubmit={(event) => void submitRequest(event)} className="mb-4 space-y-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="revenue-preauth-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Payer">
              <select required value={request.payerId} onChange={(event) => setRequest({ ...request, payerId: event.target.value, contractId: "" })} className={INPUT_CLASS} aria-label="Payer">
                <option value="">Select a payer</option>
                {data.payers.filter((payer) => payer.active).map((payer) => (
                  <option key={payer.id} value={payer.id}>{payer.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Contract" hint="Optional">
              <select value={request.contractId} onChange={(event) => setRequest({ ...request, contractId: event.target.value })} className={INPUT_CLASS} aria-label="Contract">
                <option value="">No contract</option>
                {data.contracts.filter((item) => item.payerId === request.payerId).map((item) => (
                  <option key={item.id} value={item.id}>{item.contractNo}</option>
                ))}
              </select>
            </Field>
          </div>
          <PatientPicker onPatientChange={setPatient} testId="revenue-preauth" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Requested amount">
              <input required type="number" min="0.01" step="0.01" value={request.requestedAmount} onChange={(event) => setRequest({ ...request, requestedAmount: event.target.value })} className={INPUT_CLASS} aria-label="Requested amount" />
            </Field>
            <Field label="Reference" hint="Payer reference, optional">
              <input value={request.reference} onChange={(event) => setRequest({ ...request, reference: event.target.value })} className={INPUT_CLASS} aria-label="Reference" />
            </Field>
            <Field label="Expires on" hint="Optional">
              <input type="date" value={request.expiresAt} onChange={(event) => setRequest({ ...request, expiresAt: event.target.value })} className={INPUT_CLASS} aria-label="Expires on" />
            </Field>
          </div>
          <Field label="Notes" hint="Optional clinical or administrative context">
            <textarea rows={2} value={request.notes} onChange={(event) => setRequest({ ...request, notes: event.target.value })} className={`${INPUT_CLASS} h-auto py-2`} aria-label="Notes" />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
            <button type="submit" disabled={busy || !patient} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-request-preauth">Request authorisation</button>
          </div>
        </form>
      ) : null}
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS} data-testid="revenue-preauth-table">
          <thead>
            <tr>
              <th className={TH_CLASS}>Auth no</th>
              <th className={TH_CLASS}>Payer</th>
              <th className={TH_CLASS}>Patient</th>
              <th className={TH_CLASS}>Requested</th>
              <th className={TH_CLASS}>Approved</th>
              <th className={TH_CLASS}>Expires</th>
              <th className={TH_CLASS}>Status</th>
              {canWrite ? <th className={TH_CLASS}>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.preAuthorizations.length === 0 ? (
              <EmptyRow colSpan={canWrite ? 8 : 7} message="No pre-authorisations requested yet." />
            ) : (
              data.preAuthorizations.map((row) => (
                <tr key={row.id} data-testid={`revenue-preauth-${row.authNo}`}>
                  <td className={`${TD_CLASS} font-mono`}>{row.authNo}</td>
                  <td className={TD_CLASS}>{row.payerName}</td>
                  <td className={TD_CLASS}>{row.patientName}</td>
                  <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.requestedAmount)}</td>
                  <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{row.approvedAmount ? formatMoney(row.approvedAmount) : "—"}</td>
                  <td className={`${TD_CLASS} text-xs`}>{row.expiresAt ? formatDate(row.expiresAt) : "—"}</td>
                  <td className={TD_CLASS}>
                    <StatusPill tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusPill>
                  </td>
                  {canWrite ? (
                    <td className={TD_CLASS}>
                      {row.status === "requested" ? (
                        <button
                          type="button"
                          onClick={() => setDecisionId(row.id)}
                          className="text-xs font-medium text-primary hover:underline"
                          data-testid={`revenue-decide-preauth-${row.authNo}`}
                        >
                          Decide
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {decisionId ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitDecision(true);
          }}
          className="mt-3 grid gap-3 rounded-lg border border-border bg-muted/30 p-3"
          data-testid="revenue-preauth-decision-form"
        >
          <p className="text-xs font-medium text-muted-foreground">
            Decision for {data.preAuthorizations.find((row) => row.id === decisionId)?.authNo ?? "request"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Approved amount">
              <input required type="number" min="0.01" step="0.01" value={decision.approvedAmount} onChange={(event) => setDecision({ ...decision, approvedAmount: event.target.value })} className={INPUT_CLASS} aria-label="Approved amount" />
            </Field>
            <Field label="Decision note" hint="Optional">
              <input value={decision.notes} onChange={(event) => setDecision({ ...decision, notes: event.target.value })} className={INPUT_CLASS} aria-label="Decision note" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDecisionId("")} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
            <button type="button" disabled={busy} onClick={() => void submitDecision(false)} className="h-9 rounded-lg border border-[var(--status-critical)] px-3 text-sm font-medium text-[var(--status-critical-foreground)] disabled:opacity-50" data-testid="revenue-decline-preauth">Decline</button>
            <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-approve-preauth">Approve</button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
