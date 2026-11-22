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
  type ProcurementPanelProps,
} from "@/components/procurement/procurement-types";

export function StockPanel({
  data,
  canWrite,
  busy,
  run,
}: Pick<ProcurementPanelProps, "data" | "canWrite" | "busy" | "run">) {
  const [itemId, setItemId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [minimum, setMinimum] = useState("10");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "setReorderLevel",
      { itemId, storeId, minimumQuantity: Number(minimum), active: true },
      "Reorder level saved",
    );
    if (ok) {
      setItemId("");
      setStoreId("");
      setMinimum("10");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel title="Reorder level" description="Set the minimum quantity for an item in a store.">
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-[2fr_2fr_1fr_auto]">
            <Field label="Item">
              <select
                className={INPUT_CLASS}
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
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
            <Field label="Store">
              <select
                className={INPUT_CLASS}
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
                required
              >
                <option value="">Select a store</option>
                {data.stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Minimum quantity">
              <input
                type="number"
                min={0}
                className={INPUT_CLASS}
                value={minimum}
                onChange={(event) => setMinimum(event.target.value)}
                required
              />
            </Field>
            <div className="flex items-end">
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Save level
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Reorder monitor"
        description="On-hand quantities come from the append-only stock ledger."
        testId="procurement-reorder-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Item</th>
                <th scope="col" className={TH_CLASS}>Store</th>
                <th scope="col" className={TH_CLASS}>On hand</th>
                <th scope="col" className={TH_CLASS}>Minimum</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.reorderRows.length === 0 ? (
                <EmptyRow colSpan={5} message="No reorder levels have been configured." />
              ) : (
                data.reorderRows.map((row) => (
                  <tr key={`${row.itemId}:${row.storeId}`}>
                    <td className={TD_CLASS}>
                      {row.itemCode} — {row.itemName}
                    </td>
                    <td className={TD_CLASS}>{row.storeName}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {row.quantityOnHand}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {row.minimumQuantity}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={row.reorderNeeded ? "danger" : "success"}>
                        {row.reorderNeeded ? "Reorder" : "OK"}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Stock valuation" testId="procurement-stock-valuation">
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Item</th>
                  <th scope="col" className={TH_CLASS}>Batch</th>
                  <th scope="col" className={TH_CLASS}>Quantity</th>
                  <th scope="col" className={TH_CLASS}>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.stockValuation.length === 0 ? (
                  <EmptyRow colSpan={4} message="No positive stock balances to value." />
                ) : (
                  data.stockValuation.map((row, index) => (
                    <tr key={`${row.batchId ?? "batch"}-${index}`}>
                      <td className={TD_CLASS}>{row.itemName}</td>
                      <td className={TD_CLASS}>
                        {row.batchNo ?? "—"}
                        {row.expiryDate ? (
                          <span className="block text-xs text-muted-foreground">
                            Exp {formatDate(row.expiryDate)}
                          </span>
                        ) : null}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {row.quantity}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(row.value)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Expiry watch" testId="procurement-expiry-report">
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Item</th>
                  <th scope="col" className={TH_CLASS}>Batch</th>
                  <th scope="col" className={TH_CLASS}>Expiry</th>
                  <th scope="col" className={TH_CLASS}>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {data.expiryReport.length === 0 ? (
                  <EmptyRow colSpan={4} message="No on-hand batches to monitor." />
                ) : (
                  data.expiryReport.map((row) => (
                    <tr key={row.batchId}>
                      <td className={TD_CLASS}>{row.itemName}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.batchNo}</td>
                      <td className={TD_CLASS}>{row.expiryDate ? formatDate(row.expiryDate) : "—"}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {row.quantity}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel
        title="Three-way variance"
        description="Order total, received total and invoiced total for each matched chain."
        testId="procurement-variance-report"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>LPO</th>
                <th scope="col" className={TH_CLASS}>GRN</th>
                <th scope="col" className={TH_CLASS}>Ordered</th>
                <th scope="col" className={TH_CLASS}>Received</th>
                <th scope="col" className={TH_CLASS}>Invoiced</th>
              </tr>
            </thead>
            <tbody>
              {data.varianceReport.length === 0 ? (
                <EmptyRow colSpan={5} message="No received orders to compare yet." />
              ) : (
                data.varianceReport.map((row) => {
                  const variance =
                    Number(row.orderedAmount) - Number(row.invoicedAmount) !== 0 ||
                    Number(row.receivedAmount) - Number(row.invoicedAmount) !== 0;
                  return (
                    <tr key={`${row.purchaseOrderId}:${row.goodsReceiptId}`}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.poNo}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.grnNo}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(row.orderedAmount)}
                      </td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(row.receivedAmount)}
                      </td>
                      <td className={TD_CLASS}>
                        <span className="font-mono tabular-nums">
                          {formatMoney(row.invoicedAmount)}
                        </span>
                        <span className="ml-2">
                          <StatusPill tone={variance ? "danger" : "success"}>
                            {variance ? "Variance" : "Matched"}
                          </StatusPill>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
