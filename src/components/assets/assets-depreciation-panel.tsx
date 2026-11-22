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

export function DepreciationPanel({
  data,
  canWrite,
  busy,
  run,
  selectRun,
}: AssetsPanelProps) {
  const [period, setPeriod] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [assetId, setAssetId] = useState("");

  const detail = data.runDetail;

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createDepreciationRun",
      {
        period,
        description: description.trim() || null,
        assetIds: assetId ? [assetId] : [],
      },
      "Depreciation run prepared",
    );
    if (ok) setDescription("");
  }

  async function approve(runId: string) {
    await run("approveDepreciationRun", { runId, reason: null }, "Depreciation run approved");
  }

  async function post(runId: string) {
    await run("postDepreciationRun", { runId }, "Depreciation posted to the ledger");
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Prepare depreciation"
          description="Straight-line amounts use each asset's remaining depreciable cost. A period can be calculated once per asset."
          testId="depreciation-create-panel"
        >
          <form onSubmit={prepare} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Period">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={period}
                  onChange={(event) => setPeriod(event.target.value)}
                  required
                />
              </Field>
              <Field label="Asset" hint="Leave blank for all active assets">
                <select
                  className={INPUT_CLASS}
                  value={assetId}
                  onChange={(event) => setAssetId(event.target.value)}
                >
                  <option value="">All active assets</option>
                  {data.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.assetNo} · {asset.name}
                    </option>
                  ))}
                </select>
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
              Prepare depreciation run
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Depreciation runs"
        description="Preparation, approval and posting are separate actions with different actors."
        testId="depreciation-run-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Run</th>
                <th scope="col" className={TH_CLASS}>Period</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Assets</th>
                <th scope="col" className={TH_CLASS}>Amount</th>
                <th scope="col" className={TH_CLASS}>Journal</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.length === 0 ? (
                <EmptyRow colSpan={7} message="No depreciation runs have been prepared yet." />
              ) : (
                data.runs.map((row) => {
                  const isPreparer = row.preparedBy === data.viewerId;
                  return (
                    <tr key={row.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.runNo}</td>
                      <td className={TD_CLASS}>{formatDate(row.period)}</td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={assetStatusTone(row.status)}>{row.status}</StatusPill>
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {row.assetCount}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(row.totalAmount)}
                      </td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.entryNo ?? "None"}</td>
                      <td className={TD_CLASS}>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            onClick={() => selectRun(row.id)}
                          >
                            View
                          </button>
                          {canWrite && row.status === "draft" ? (
                            <button
                              type="button"
                              className={SUBTLE_BUTTON_CLASS}
                              disabled={busy || isPreparer}
                              title={isPreparer ? "A different user must approve this run" : undefined}
                              onClick={() => void approve(row.id)}
                            >
                              Approve
                            </button>
                          ) : null}
                          {canWrite && row.status === "approved" ? (
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              disabled={busy}
                              onClick={() => void post(row.id)}
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
          description="Entries are immutable once the run is posted."
          testId="depreciation-run-detail"
        >
          <div className="mb-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <span>Period {formatDate(detail.period)}</span>
            <span>Total {formatMoney(detail.totalAmount)}</span>
            <span>Prepared by {detail.preparedBy}</span>
          </div>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Asset</th>
                  <th scope="col" className={TH_CLASS}>Cost centre</th>
                  <th scope="col" className={TH_CLASS}>Opening</th>
                  <th scope="col" className={TH_CLASS}>Charge</th>
                  <th scope="col" className={TH_CLASS}>Closing</th>
                </tr>
              </thead>
              <tbody>
                {detail.entries.length === 0 ? (
                  <EmptyRow colSpan={5} message="This run has no depreciation entries." />
                ) : (
                  detail.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className={TD_CLASS}>
                        <span className="block text-sm text-foreground">
                          {entry.assetName ?? "Asset"}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {entry.assetNo ?? "None"}
                        </span>
                      </td>
                      <td className={TD_CLASS}>{entry.costCenterName ?? "None"}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(entry.openingCarryingAmount)}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(entry.depreciationAmount)}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(entry.closingCarryingAmount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {detail.approvals.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {detail.approvals.map((approval) => (
                <li
                  key={approval.id}
                  className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="font-medium">
                    {approval.decision} · {approval.role}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {approval.actorId} · limit {formatMoney(approval.maxAmount)} ·{" "}
                    {formatDate(approval.decidedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
