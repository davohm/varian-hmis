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
  assetStatusTone,
  BUTTON_CLASS,
  formatDate,
  formatMoney,
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type AssetsPanelProps,
} from "@/components/assets/assets-types";

export function ChangesPanel({ data, canWrite, busy, run }: AssetsPanelProps) {
  const [valuationAssetId, setValuationAssetId] = useState("");
  const [valuationKind, setValuationKind] = useState("revaluation");
  const [valuationAmount, setValuationAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [valuationReason, setValuationReason] = useState("");

  const [disposalAssetId, setDisposalAssetId] = useState("");
  const [disposalMethod, setDisposalMethod] = useState("sale");
  const [disposalDate, setDisposalDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState("0");
  const [proceedsMethod, setProceedsMethod] = useState("none");
  const [disposalReason, setDisposalReason] = useState("");

  async function requestValuation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "requestAssetValuation",
      {
        assetId: valuationAssetId,
        kind: valuationKind,
        amount: valuationAmount,
        effectiveFrom,
        reason: valuationReason.trim(),
      },
      "Valuation requested",
    );
    if (ok) {
      setValuationAssetId("");
      setValuationAmount("");
      setValuationReason("");
    }
  }

  async function requestDisposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "requestAssetDisposal",
      {
        assetId: disposalAssetId,
        method: disposalMethod.trim(),
        disposalDate,
        proceeds,
        proceedsMethod,
        reason: disposalReason.trim(),
      },
      "Disposal requested",
    );
    if (ok) {
      setDisposalAssetId("");
      setProceeds("0");
      setProceedsMethod("none");
      setDisposalReason("");
    }
  }

  async function approveValuation(id: string) {
    await run("approveAssetValuation", { valuationId: id, reason: null }, "Valuation approved");
  }

  async function postValuation(id: string) {
    await run("postAssetValuation", { valuationId: id }, "Valuation posted to the ledger");
  }

  async function approveDisposal(id: string) {
    await run("approveAssetDisposal", { disposalId: id, reason: null }, "Disposal approved");
  }

  async function completeDisposal(id: string) {
    await run("completeAssetDisposal", { disposalId: id }, "Disposal completed and posted");
  }

  const assetOptions = data.assets.map((asset) => (
    <option key={asset.id} value={asset.id}>
      {asset.assetNo} · {asset.name}
    </option>
  ));

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Request a valuation"
          description="Revaluations debit the asset and credit the revaluation reserve. Impairments are expensed."
          testId="valuation-create-panel"
        >
          <form onSubmit={requestValuation} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Asset">
                <select
                  className={INPUT_CLASS}
                  value={valuationAssetId}
                  onChange={(event) => setValuationAssetId(event.target.value)}
                  required
                >
                  <option value="">Select an asset</option>
                  {assetOptions}
                </select>
              </Field>
              <Field label="Kind">
                <select
                  className={INPUT_CLASS}
                  value={valuationKind}
                  onChange={(event) => setValuationKind(event.target.value)}
                >
                  <option value="revaluation">Revaluation upward</option>
                  <option value="impairment">Impairment</option>
                </select>
              </Field>
              <Field label="Amount">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className={INPUT_CLASS}
                  value={valuationAmount}
                  onChange={(event) => setValuationAmount(event.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Effective date">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                  required
                />
              </Field>
              <Field label="Reason">
                <input
                  className={INPUT_CLASS}
                  value={valuationReason}
                  onChange={(event) => setValuationReason(event.target.value)}
                  maxLength={2000}
                  required
                />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Request valuation
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Asset valuations"
        description="A requested valuation needs a different approver before it can be posted."
        testId="valuation-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Valuation</th>
                <th scope="col" className={TH_CLASS}>Asset</th>
                <th scope="col" className={TH_CLASS}>Kind</th>
                <th scope="col" className={TH_CLASS}>Amount</th>
                <th scope="col" className={TH_CLASS}>Carrying after</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Journal</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.valuations.length === 0 ? (
                <EmptyRow colSpan={8} message="No valuations have been requested yet." />
              ) : (
                data.valuations.map((valuation) => (
                  <tr key={valuation.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{valuation.valuationNo}</td>
                    <td className={TD_CLASS}>{valuation.assetNo}</td>
                    <td className={TD_CLASS}>{valuation.kind}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(valuation.amount)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(valuation.carryingAfter)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={assetStatusTone(valuation.status)}>
                        {valuation.status}
                      </StatusPill>
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      {valuation.entryNo ?? "None"}
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap gap-2">
                        {canWrite && valuation.status === "requested" ? (
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            disabled={busy || valuation.requestedBy === data.viewerId}
                            title={
                              valuation.requestedBy === data.viewerId
                                ? "A different user must approve this valuation"
                                : undefined
                            }
                            onClick={() => void approveValuation(valuation.id)}
                          >
                            Approve
                          </button>
                        ) : null}
                        {canWrite && valuation.status === "approved" ? (
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            disabled={busy}
                            onClick={() => void postValuation(valuation.id)}
                          >
                            Post
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {canWrite ? (
        <Panel
          title="Request a disposal"
          description="Gain or loss is calculated against carrying value. Proceeds without a method are rejected."
          testId="disposal-create-panel"
        >
          <form onSubmit={requestDisposal} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Asset">
                <select
                  className={INPUT_CLASS}
                  value={disposalAssetId}
                  onChange={(event) => setDisposalAssetId(event.target.value)}
                  required
                >
                  <option value="">Select an asset</option>
                  {assetOptions}
                </select>
              </Field>
              <Field label="Method">
                <input
                  className={INPUT_CLASS}
                  value={disposalMethod}
                  onChange={(event) => setDisposalMethod(event.target.value)}
                  maxLength={32}
                  required
                />
              </Field>
              <Field label="Disposal date">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={disposalDate}
                  onChange={(event) => setDisposalDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Proceeds">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className={INPUT_CLASS}
                  value={proceeds}
                  onChange={(event) => setProceeds(event.target.value)}
                />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Proceeds method">
                <select
                  className={INPUT_CLASS}
                  value={proceedsMethod}
                  onChange={(event) => setProceedsMethod(event.target.value)}
                >
                  <option value="none">No proceeds</option>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                  <option value="accrued">Accrued receivable</option>
                </select>
              </Field>
              <Field label="Reason">
                <input
                  className={INPUT_CLASS}
                  value={disposalReason}
                  onChange={(event) => setDisposalReason(event.target.value)}
                  maxLength={2000}
                  required
                />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Request disposal
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Asset disposals"
        description="Completion removes the asset from service and posts the gain or loss."
        testId="disposal-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Disposal</th>
                <th scope="col" className={TH_CLASS}>Asset</th>
                <th scope="col" className={TH_CLASS}>Method</th>
                <th scope="col" className={TH_CLASS}>Date</th>
                <th scope="col" className={TH_CLASS}>Proceeds</th>
                <th scope="col" className={TH_CLASS}>Carrying</th>
                <th scope="col" className={TH_CLASS}>Gain or loss</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.disposals.length === 0 ? (
                <EmptyRow colSpan={9} message="No disposals have been requested yet." />
              ) : (
                data.disposals.map((disposal) => (
                  <tr key={disposal.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{disposal.disposalNo}</td>
                    <td className={TD_CLASS}>{disposal.assetNo}</td>
                    <td className={TD_CLASS}>{disposal.method}</td>
                    <td className={TD_CLASS}>{formatDate(disposal.disposalDate)}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(disposal.proceeds)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(disposal.carryingAmount)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(disposal.gainLoss)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={assetStatusTone(disposal.status)}>
                        {disposal.status}
                      </StatusPill>
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap gap-2">
                        {canWrite && disposal.status === "requested" ? (
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            disabled={busy || disposal.requestedBy === data.viewerId}
                            title={
                              disposal.requestedBy === data.viewerId
                                ? "A different user must approve this disposal"
                                : undefined
                            }
                            onClick={() => void approveDisposal(disposal.id)}
                          >
                            Approve
                          </button>
                        ) : null}
                        {canWrite && disposal.status === "approved" ? (
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            disabled={busy}
                            onClick={() => void completeDisposal(disposal.id)}
                          >
                            Complete
                          </button>
                        ) : null}
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
