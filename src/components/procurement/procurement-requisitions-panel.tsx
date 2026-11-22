"use client";

import { useState } from "react";

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
import {
  BUTTON_CLASS,
  formatMoney,
  type ProcurementPanelProps,
  SUBTLE_BUTTON_CLASS,
} from "@/components/procurement/procurement-types";

interface DraftLine {
  itemId: string;
  quantity: string;
  unitCost: string;
}

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "approved" || status === "ordered") return "success";
  if (status === "rejected") return "danger";
  if (status === "draft") return "warning";
  return "neutral";
}

export function RequisitionsPanel({
  data,
  canWrite,
  busy,
  run,
  selectRequisition,
}: Pick<
  ProcurementPanelProps,
  "data" | "canWrite" | "busy" | "run" | "selectRequisition"
>) {
  const [department, setDepartment] = useState("");
  const [justification, setJustification] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: "", quantity: "1", unitCost: "0" }]);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createPurchaseRequisition",
      {
        department,
        justification,
        lines: lines.map((line) => ({
          itemId: line.itemId,
          quantity: Number(line.quantity),
          unitCost: line.unitCost,
        })),
      },
      "Requisition raised",
    );
    if (ok) {
      setDepartment("");
      setJustification("");
      setLines([{ itemId: "", quantity: "1", unitCost: "0" }]);
    }
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    const reason = reasons[id]?.trim() ?? "";
    if (decision === "rejected" && !reason) {
      await run("approvePurchaseRequisition", { requisitionId: id, decision }, "Missing reason");
      return;
    }
    const ok = await run(
      "approvePurchaseRequisition",
      { requisitionId: id, decision, reason: reason || null },
      decision === "approved" ? "Requisition approved" : "Requisition rejected",
    );
    if (ok) setReasons((current) => ({ ...current, [id]: "" }));
  }

  const detail = data.requisitionDetail;

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel title="New requisition" description="The requester cannot approve their own request.">
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Requesting department">
                <input
                  className={INPUT_CLASS}
                  value={department}
                  onChange={(event) => setDepartment(event.target.value)}
                  placeholder="e.g. Pharmacy"
                  required
                />
              </Field>
              <Field label="Justification">
                <input
                  className={INPUT_CLASS}
                  value={justification}
                  onChange={(event) => setJustification(event.target.value)}
                  placeholder="Why these items are needed"
                  required
                />
              </Field>
            </div>
            <div className="space-y-2">
              <SubHeading
                title="Line items"
                description="Add one or more items with estimated unit cost."
                action={
                  <button
                    type="button"
                    className={SUBTLE_BUTTON_CLASS}
                    onClick={() =>
                      setLines((current) => [
                        ...current,
                        { itemId: "", quantity: "1", unitCost: "0" },
                      ])
                    }
                  >
                    Add line
                  </button>
                }
              />
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto]">
                  <Field label={`Item ${index + 1}`}>
                    <select
                      className={INPUT_CLASS}
                      value={line.itemId}
                      onChange={(event) => updateLine(index, { itemId: event.target.value })}
                      required
                    >
                      <option value="">Select an item</option>
                      {data.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} — {item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Quantity">
                    <input
                      type="number"
                      min={1}
                      className={INPUT_CLASS}
                      value={line.quantity}
                      onChange={(event) => updateLine(index, { quantity: event.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Unit cost">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className={INPUT_CLASS}
                      value={line.unitCost}
                      onChange={(event) => updateLine(index, { unitCost: event.target.value })}
                      required
                    />
                  </Field>
                  <div className="flex items-end">
                    <button
                      type="button"
                      className={SUBTLE_BUTTON_CLASS}
                      onClick={() =>
                        setLines((current) => current.filter((_, i) => i !== index))
                      }
                      disabled={lines.length === 1}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Raise requisition
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Requisitions"
        description="Select a requisition to inspect its lines and decision trail."
        testId="procurement-requisition-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Number</th>
                <th scope="col" className={TH_CLASS}>Department</th>
                <th scope="col" className={TH_CLASS}>Total</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.requisitions.length === 0 ? (
                <EmptyRow colSpan={5} message="No requisitions have been raised yet." />
              ) : (
                data.requisitions.map((requisition) => (
                  <tr key={requisition.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{requisition.requisitionNo}</td>
                    <td className={TD_CLASS}>{requisition.department}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(requisition.totalAmount)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={statusTone(requisition.status)}>
                        {requisition.status.replace("_", " ")}
                      </StatusPill>
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={SUBTLE_BUTTON_CLASS}
                          onClick={() => selectRequisition(requisition.id)}
                        >
                          View
                        </button>
                        {canWrite && requisition.status === "draft" ? (
                          <>
                            <input
                              aria-label={`Rejection reason for ${requisition.requisitionNo}`}
                              className={`${INPUT_CLASS} w-40`}
                              placeholder="Rejection reason"
                              value={reasons[requisition.id] ?? ""}
                              onChange={(event) =>
                                setReasons((current) => ({
                                  ...current,
                                  [requisition.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              disabled={busy}
                              onClick={() => decide(requisition.id, "approved")}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className={SUBTLE_BUTTON_CLASS}
                              disabled={busy}
                              onClick={() => decide(requisition.id, "rejected")}
                            >
                              Reject
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {detail ? (
          <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">
              {detail.requisitionNo} · {detail.department}
            </p>
            <p className="text-xs text-muted-foreground">{detail.justification}</p>
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>Item</th>
                    <th scope="col" className={TH_CLASS}>Quantity</th>
                    <th scope="col" className={TH_CLASS}>Unit cost</th>
                    <th scope="col" className={TH_CLASS}>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={line.id}>
                      <td className={TD_CLASS}>{line.itemName ?? line.itemId}</td>
                      <td className={TD_CLASS}>{line.quantity}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(line.unitCost ?? 0)}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(line.lineTotal ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.approvals.length ? (
              <p className="text-xs text-muted-foreground">
                Decision trail:{" "}
                {detail.approvals
                  .map((approval) => `${approval.decision} by ${approval.actorId.slice(0, 8)}`)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
