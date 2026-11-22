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
  formatMoney,
  type ProcurementPanelProps,
  SUBTLE_BUTTON_CLASS,
} from "@/components/procurement/procurement-types";

function orderTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "paid" || status === "received") return "success";
  if (status === "approved") return "info";
  if (status === "draft" || status === "partially_received" || status === "invoiced") {
    return "warning";
  }
  if (status === "cancelled") return "danger";
  return "neutral";
}

export function OrdersPanel({
  data,
  canWrite,
  busy,
  run,
  selectPurchaseOrder,
}: Pick<ProcurementPanelProps, "data" | "canWrite" | "busy" | "run" | "selectPurchaseOrder">) {
  const [quoteId, setQuoteId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const detail = data.purchaseOrderDetail;

  async function createOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createPurchaseOrder",
      { quoteId, expectedDate: expectedDate || null },
      "Purchase order created",
    );
    if (ok) {
      setQuoteId("");
      setExpectedDate("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel title="Create LPO" description="A selected quote becomes a draft purchase order.">
          <form onSubmit={createOrder} className="grid gap-3 md:grid-cols-2">
            <Field label="Selected supplier quote">
              <select
                className={INPUT_CLASS}
                value={quoteId}
                onChange={(event) => setQuoteId(event.target.value)}
                required
              >
                <option value="">Select a quote</option>
                {data.quotes
                  .filter((quote) => quote.status === "selected")
                  .map((quote) => (
                    <option key={quote.id} value={quote.id}>
                      {quote.supplierName} · {formatMoney(quote.totalAmount)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Expected date" hint="Optional">
              <input
                type="date"
                className={INPUT_CLASS}
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </Field>
            <div className="md:col-span-2">
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Create LPO
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Purchase orders"
        description="Approve LPOs before goods are received; the approver must be a different actor."
        testId="procurement-order-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>LPO</th>
                <th scope="col" className={TH_CLASS}>Supplier</th>
                <th scope="col" className={TH_CLASS}>Total</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.purchaseOrders.length === 0 ? (
                <EmptyRow colSpan={5} message="No purchase orders have been raised yet." />
              ) : (
                data.purchaseOrders.map((order) => (
                  <tr key={order.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{order.poNo}</td>
                    <td className={TD_CLASS}>{order.supplierName}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(order.totalAmount)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={orderTone(order.status)}>
                        {order.status.replace("_", " ")}
                      </StatusPill>
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={SUBTLE_BUTTON_CLASS}
                          onClick={() => selectPurchaseOrder(order.id)}
                        >
                          View
                        </button>
                        {canWrite && order.status === "draft" ? (
                          <>
                            <input
                              aria-label={`Approval note for ${order.poNo}`}
                              className={`${INPUT_CLASS} w-40`}
                              placeholder="Approval note"
                              value={notes[order.id] ?? ""}
                              onChange={(event) =>
                                setNotes((current) => ({
                                  ...current,
                                  [order.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              disabled={busy}
                              onClick={() =>
                                run(
                                  "approvePurchaseOrder",
                                  {
                                    purchaseOrderId: order.id,
                                    note: notes[order.id]?.trim() || null,
                                  },
                                  "LPO approved",
                                )
                              }
                            >
                              Approve
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
          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted/30 p-3">
            <p className="mb-2 text-sm font-medium text-foreground">
              {detail.poNo} · {detail.supplierName}
            </p>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Item</th>
                  <th scope="col" className={TH_CLASS}>Ordered</th>
                  <th scope="col" className={TH_CLASS}>Received</th>
                  <th scope="col" className={TH_CLASS}>Unit cost</th>
                  <th scope="col" className={TH_CLASS}>Line total</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.id}>
                    <td className={TD_CLASS}>{line.itemName ?? line.itemId}</td>
                    <td className={TD_CLASS}>{line.quantity}</td>
                    <td className={TD_CLASS}>{line.receivedQuantity ?? 0}</td>
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
        ) : null}
      </Panel>
    </div>
  );
}
