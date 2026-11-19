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
import {
  formatDate,
  PAYER_KINDS,
  STATUS_TONE,
  type RevenuePanelProps,
} from "@/components/revenue/revenue-types";
import { useRevenueCommand } from "@/components/revenue/use-revenue-command";

export function PayersPanel({ data, canWrite, refresh }: RevenuePanelProps) {
  const { busy, run } = useRevenueCommand(refresh);
  const [showPayer, setShowPayer] = useState(false);
  const [showContract, setShowContract] = useState(false);
  const [benefitContractId, setBenefitContractId] = useState("");
  const [payer, setPayer] = useState({ code: "", name: "", kind: "insurer", contactName: "", phone: "", email: "" });
  const [contract, setContract] = useState({ payerId: "", contractNo: "", startDate: "", endDate: "" });
  const [benefit, setBenefit] = useState({ category: "", copayPercent: "0", annualLimit: "", perVisitLimit: "" });

  async function createPayer(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "createPayer",
      {
        code: payer.code.trim(),
        name: payer.name.trim(),
        kind: payer.kind,
        contactName: payer.contactName.trim() || null,
        phone: payer.phone.trim() || null,
        email: payer.email.trim() || null,
      },
      "Payer created",
    );
    if (ok) {
      setPayer({ code: "", name: "", kind: "insurer", contactName: "", phone: "", email: "" });
      setShowPayer(false);
    }
  }

  async function createContract(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "createPayerContract",
      {
        payerId: contract.payerId,
        contractNo: contract.contractNo.trim(),
        startDate: contract.startDate,
        endDate: contract.endDate,
      },
      "Contract created",
    );
    if (ok) {
      setContract({ payerId: "", contractNo: "", startDate: "", endDate: "" });
      setShowContract(false);
    }
  }

  async function addBenefit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "createPayerBenefit",
      {
        contractId: benefitContractId,
        category: benefit.category.trim(),
        copayPercent: benefit.copayPercent || "0",
        annualLimit: benefit.annualLimit || null,
        perVisitLimit: benefit.perVisitLimit || null,
      },
      "Benefit added",
    );
    if (ok) {
      setBenefit({ category: "", copayPercent: "0", annualLimit: "", perVisitLimit: "" });
      setBenefitContractId("");
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel
        title="Payers"
        description="Insurers, schemes and corporate accounts."
        testId="revenue-payers-panel"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={() => setShowPayer((current) => !current)}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="revenue-new-payer"
            >
              New payer
            </button>
          ) : null
        }
      >
        {showPayer ? (
          <form onSubmit={(event) => void createPayer(event)} className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="revenue-payer-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Code">
                <input required value={payer.code} onChange={(event) => setPayer({ ...payer, code: event.target.value })} className={INPUT_CLASS} aria-label="Code" />
              </Field>
              <Field label="Name">
                <input required value={payer.name} onChange={(event) => setPayer({ ...payer, name: event.target.value })} className={INPUT_CLASS} aria-label="Name" />
              </Field>
              <Field label="Kind">
                <select value={payer.kind} onChange={(event) => setPayer({ ...payer, kind: event.target.value })} className={INPUT_CLASS} aria-label="Kind">
                  {PAYER_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
              </Field>
              <Field label="Contact name">
                <input value={payer.contactName} onChange={(event) => setPayer({ ...payer, contactName: event.target.value })} className={INPUT_CLASS} aria-label="Contact name" />
              </Field>
              <Field label="Phone">
                <input value={payer.phone} onChange={(event) => setPayer({ ...payer, phone: event.target.value })} className={INPUT_CLASS} aria-label="Phone" />
              </Field>
              <Field label="Email">
                <input type="email" value={payer.email} onChange={(event) => setPayer({ ...payer, email: event.target.value })} className={INPUT_CLASS} aria-label="Email" />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowPayer(false)} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-create-payer">Create payer</button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="revenue-payers-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Code</th>
                <th className={TH_CLASS}>Name</th>
                <th className={TH_CLASS}>Kind</th>
                <th className={TH_CLASS}>Contracts</th>
                <th className={TH_CLASS}>Status</th>
                {canWrite ? <th className={TH_CLASS}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.payers.length === 0 ? (
                <EmptyRow colSpan={canWrite ? 6 : 5} message="No payers yet. Add an insurer or scheme to begin." />
              ) : (
                data.payers.map((row) => (
                  <tr key={row.id} data-testid={`revenue-payer-${row.code}`}>
                    <td className={`${TD_CLASS} font-mono`}>{row.code}</td>
                    <td className={TD_CLASS}>{row.name}</td>
                    <td className={TD_CLASS}>{row.kind}</td>
                    <td className={TD_CLASS}>{row.contractCount}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={row.active ? "success" : "neutral"}>{row.active ? "Active" : "Inactive"}</StatusPill>
                    </td>
                    {canWrite ? (
                      <td className={TD_CLASS}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run("updatePayer", { payerId: row.id, active: !row.active }, row.active ? "Payer deactivated" : "Payer activated")}
                          className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                          data-testid={`revenue-toggle-payer-${row.code}`}
                        >
                          {row.active ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel
          title="Contracts"
          description="Active agreements and their benefit schedules."
          testId="revenue-contracts-panel"
          action={
            canWrite ? (
              <button
                type="button"
                onClick={() => setShowContract((current) => !current)}
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid="revenue-new-contract"
              >
                New contract
              </button>
            ) : null
          }
        >
          {showContract ? (
            <form onSubmit={(event) => void createContract(event)} className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="revenue-contract-form">
              <Field label="Payer">
                <select required value={contract.payerId} onChange={(event) => setContract({ ...contract, payerId: event.target.value })} className={INPUT_CLASS} aria-label="Payer">
                  <option value="">Select a payer</option>
                  {data.payers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </Field>
              <Field label="Contract number">
                <input required value={contract.contractNo} onChange={(event) => setContract({ ...contract, contractNo: event.target.value })} className={INPUT_CLASS} aria-label="Contract number" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Start date">
                  <input required type="date" value={contract.startDate} onChange={(event) => setContract({ ...contract, startDate: event.target.value })} className={INPUT_CLASS} aria-label="Start date" />
                </Field>
                <Field label="End date">
                  <input required type="date" value={contract.endDate} onChange={(event) => setContract({ ...contract, endDate: event.target.value })} className={INPUT_CLASS} aria-label="End date" />
                </Field>
              </div>
              <div className="flex justify-end">
                <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-create-contract">Create contract</button>
              </div>
            </form>
          ) : null}
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS} data-testid="revenue-contracts-table">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Contract</th>
                  <th className={TH_CLASS}>Payer</th>
                  <th className={TH_CLASS}>Period</th>
                  <th className={TH_CLASS}>Benefits</th>
                  <th className={TH_CLASS}>Status</th>
                  {canWrite ? <th className={TH_CLASS}>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.contracts.length === 0 ? (
                  <EmptyRow colSpan={canWrite ? 6 : 5} message="No payer contracts on file." />
                ) : (
                  data.contracts.map((row) => (
                    <tr key={row.id} data-testid={`revenue-contract-${row.contractNo}`}>
                      <td className={`${TD_CLASS} font-mono`}>{row.contractNo}</td>
                      <td className={TD_CLASS}>{row.payerName}</td>
                      <td className={`${TD_CLASS} text-xs`}>{formatDate(row.startDate)} – {formatDate(row.endDate)}</td>
                      <td className={TD_CLASS}>{row.benefitCount}</td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusPill>
                      </td>
                      {canWrite ? (
                        <td className={TD_CLASS}>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setBenefitContractId(row.id)}
                              className="text-xs font-medium text-primary hover:underline"
                              data-testid={`revenue-add-benefit-${row.contractNo}`}
                            >
                              Add benefit
                            </button>
                            {row.status !== "suspended" ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void run("setPayerContractStatus", { contractId: row.id, status: "suspended" }, "Contract suspended")}
                                className="text-xs font-medium text-muted-foreground hover:underline"
                              >
                                Suspend
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void run("setPayerContractStatus", { contractId: row.id, status: "active" }, "Contract activated")}
                                className="text-xs font-medium text-muted-foreground hover:underline"
                              >
                                Activate
                              </button>
                            )}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {benefitContractId ? (
            <form onSubmit={(event) => void addBenefit(event)} className="mt-3 grid gap-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="revenue-benefit-form">
              <p className="text-xs font-medium text-muted-foreground">
                Benefit for {data.contracts.find((row) => row.id === benefitContractId)?.contractNo ?? "contract"}
              </p>
              <Field label="Category">
                <input required value={benefit.category} onChange={(event) => setBenefit({ ...benefit, category: event.target.value })} className={INPUT_CLASS} aria-label="Benefit category" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Copay %">
                  <input type="number" min="0" max="100" step="0.01" value={benefit.copayPercent} onChange={(event) => setBenefit({ ...benefit, copayPercent: event.target.value })} className={INPUT_CLASS} aria-label="Copay percent" />
                </Field>
                <Field label="Annual limit">
                  <input type="number" min="0" step="0.01" value={benefit.annualLimit} onChange={(event) => setBenefit({ ...benefit, annualLimit: event.target.value })} className={INPUT_CLASS} aria-label="Annual limit" />
                </Field>
                <Field label="Per-visit limit">
                  <input type="number" min="0" step="0.01" value={benefit.perVisitLimit} onChange={(event) => setBenefit({ ...benefit, perVisitLimit: event.target.value })} className={INPUT_CLASS} aria-label="Per-visit limit" />
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setBenefitContractId("")} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
                <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">Add benefit</button>
              </div>
            </form>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
