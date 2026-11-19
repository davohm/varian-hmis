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
  formatMoney,
  STATUS_TONE,
  type RevenuePanelProps,
  type RevenueTab,
} from "@/components/revenue/revenue-types";
import { useRevenueCommand } from "@/components/revenue/use-revenue-command";

interface SettlementPanelProps extends RevenuePanelProps {
  activeTab: RevenueTab;
}

export function SettlementPanel({
  data,
  canWrite,
  refresh,
  openTab,
  selectClaim,
  activeTab,
}: SettlementPanelProps) {
  const { busy, run } = useRevenueCommand(refresh);
  const [denialId, setDenialId] = useState("");
  const [resolution, setResolution] = useState({ status: "overturned", note: "" });

  async function resolveDenial(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "resolveClaimDenial",
      {
        denialId,
        status: resolution.status,
        resolutionNote: resolution.note.trim() || null,
      },
      `Denial ${resolution.status}`,
    );
    if (ok) {
      setDenialId("");
      setResolution({ status: "overturned", note: "" });
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel
        title="Remittances"
        description="Payer payments posted against claims."
        testId="revenue-remittances-panel"
        action={
          <button
            type="button"
            onClick={() => openTab("claims")}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted"
          >
            Open a claim
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="revenue-remittances-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Receipt no</th>
                <th className={TH_CLASS}>Claim</th>
                <th className={TH_CLASS}>Payer</th>
                <th className={TH_CLASS}>Amount</th>
                <th className={TH_CLASS}>Received</th>
              </tr>
            </thead>
            <tbody>
              {data.remittances.length === 0 ? (
                <EmptyRow colSpan={5} message="No remittances received yet." />
              ) : (
                data.remittances.map((row) => (
                  <tr key={row.id}>
                    <td className={`${TD_CLASS} font-mono`}>{row.remittanceNo}</td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        onClick={() => {
                          selectClaim(row.claimId);
                          openTab("claims");
                        }}
                        className="font-mono text-primary hover:underline"
                      >
                        {row.claimNo}
                      </button>
                    </td>
                    <td className={TD_CLASS}>{row.payerName}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.amount)}</td>
                    <td className={`${TD_CLASS} text-xs`}>{formatDate(row.receivedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Claim denials"
        description="Rejections awaiting resolution."
        testId="revenue-denials-panel"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="revenue-denials-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Claim</th>
                <th className={TH_CLASS}>Reason</th>
                <th className={TH_CLASS}>Amount</th>
                <th className={TH_CLASS}>Status</th>
                {canWrite ? <th className={TH_CLASS}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.denials.length === 0 ? (
                <EmptyRow colSpan={canWrite ? 5 : 4} message="No claim denials recorded." />
              ) : (
                data.denials.map((row) => (
                  <tr key={row.id} data-testid={`revenue-denial-${row.id}`}>
                    <td className={`${TD_CLASS} font-mono`}>{row.claimNo}</td>
                    <td className={TD_CLASS}>{row.reason}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>{formatMoney(row.amount)}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusPill>
                    </td>
                    {canWrite ? (
                      <td className={TD_CLASS}>
                        {row.status === "open" ? (
                          <button
                            type="button"
                            onClick={() => setDenialId(row.id)}
                            className="text-xs font-medium text-primary hover:underline"
                            data-testid={`revenue-resolve-denial-${row.id}`}
                          >
                            Resolve
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {row.resolutionNote ?? "—"}
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {denialId ? (
          <form
            onSubmit={(event) => void resolveDenial(event)}
            className="mt-3 grid gap-3 rounded-lg border border-border bg-muted/30 p-3"
            data-testid="revenue-denial-resolution-form"
          >
            <Field label="Resolution">
              <select value={resolution.status} onChange={(event) => setResolution({ ...resolution, status: event.target.value })} className={INPUT_CLASS} aria-label="Resolution">
                <option value="overturned">Overturned</option>
                <option value="upheld">Upheld</option>
              </select>
            </Field>
            <Field label="Resolution note" hint="Optional">
              <input value={resolution.note} onChange={(event) => setResolution({ ...resolution, note: event.target.value })} className={INPUT_CLASS} aria-label="Resolution note" />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDenialId("")} className="h-9 rounded-lg border border-border px-3 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="revenue-save-resolution">Save resolution</button>
            </div>
          </form>
        ) : null}
        {activeTab === "denials" && canWrite && data.denials.some((row) => row.status === "open") ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Record a denial from the claim detail panel, then resolve it here.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
