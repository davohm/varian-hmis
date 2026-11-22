"use client";

import { useEffect, useState } from "react";

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
  SUBTLE_BUTTON_CLASS,
  todayIso,
} from "@/components/procurement/procurement-types";

interface ReceiptLineState {
  batchNo: string;
  expiryDate: string;
  quantity: string;
  unitCost: string;
}

interface InvoiceLineState {
  quantity: string;
  unitCost: string;
}

export function ReceivingPanel({
  data,
  canWrite,
  busy,
  run,
  selectPurchaseOrder,
  selectGoodsReceipt,
  selectSupplierInvoice,
}: Pick<
  ProcurementPanelProps,
  | "data"
  | "canWrite"
  | "busy"
  | "run"
  | "selectPurchaseOrder"
  | "selectGoodsReceipt"
  | "selectSupplierInvoice"
>) {
  const [receiptPoId, setReceiptPoId] = useState("");
  const [receiptStoreId, setReceiptStoreId] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [receiptLines, setReceiptLines] = useState<Record<string, ReceiptLineState>>({});

  const [invoiceGrnId, setInvoiceGrnId] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [invoiceLines, setInvoiceLines] = useState<Record<string, InvoiceLineState>>({});

  const [paymentInvoiceId, setPaymentInvoiceId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank">("bank");
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentReference, setPaymentReference] = useState("");

  const poDetail = data.purchaseOrderDetail;
  const grnDetail = data.goodsReceiptDetail;

  useEffect(() => {
    if (!poDetail || poDetail.id !== receiptPoId) return;
    setReceiptLines(
      Object.fromEntries(
        poDetail.lines.map((line) => [
          line.id,
          {
            batchNo: `GRN-${poDetail.poNo}-${line.id.slice(0, 6)}`,
            expiryDate: "",
            quantity: String(Math.max(line.quantity - (line.receivedQuantity ?? 0), 0)),
            unitCost: line.unitCost ?? "0",
          },
        ]),
      ),
    );
  }, [poDetail, receiptPoId]);

  useEffect(() => {
    if (!grnDetail || grnDetail.id !== invoiceGrnId) return;
    setInvoiceLines(
      Object.fromEntries(
        grnDetail.lines.map((line) => [
          line.id,
          { quantity: String(line.quantity), unitCost: line.unitCost ?? "0" },
        ]),
      ),
    );
  }, [grnDetail, invoiceGrnId]);

  async function receive(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!poDetail || poDetail.id !== receiptPoId) {
      await run("receiveGoods", {}, "Select a purchase order first");
      return;
    }
    const ok = await run(
      "receiveGoods",
      {
        purchaseOrderId: receiptPoId,
        storeId: receiptStoreId,
        note: receiptNote || null,
        lines: poDetail.lines.map((line) => ({
          purchaseOrderLineId: line.id,
          batchNo: receiptLines[line.id]?.batchNo ?? "GRN-BATCH",
          expiryDate: receiptLines[line.id]?.expiryDate || null,
          quantity: Number(receiptLines[line.id]?.quantity ?? 0),
          unitCost: receiptLines[line.id]?.unitCost ?? "0",
        })),
      },
      "Goods received and stock ledger updated",
    );
    if (ok) {
      setReceiptNote("");
    }
  }

  async function invoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!grnDetail || grnDetail.id !== invoiceGrnId) {
      await run("recordSupplierInvoice", {}, "Select a goods receipt first");
      return;
    }
    const order = data.purchaseOrders.find((row) => row.id === grnDetail.purchaseOrderId);
    if (!order) {
      await run("recordSupplierInvoice", {}, "Purchase order not found");
      return;
    }
    const ok = await run(
      "recordSupplierInvoice",
      {
        purchaseOrderId: order.id,
        goodsReceiptId: grnDetail.id,
        supplierId: order.supplierId,
        invoiceNo,
        invoiceDate,
        lines: grnDetail.lines.map((line) => ({
          goodsReceiptLineId: line.id,
          quantity: Number(invoiceLines[line.id]?.quantity ?? 0),
          unitCost: invoiceLines[line.id]?.unitCost ?? "0",
        })),
      },
      "Supplier invoice posted to accounts payable",
    );
    if (ok) setInvoiceNo("");
  }

  async function pay(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "recordSupplierPayment",
      {
        supplierInvoiceId: paymentInvoiceId,
        amount: paymentAmount,
        paymentDate,
        method: paymentMethod,
        reference: paymentReference || null,
      },
      "Supplier payment posted",
    );
    if (ok) {
      setPaymentAmount("");
      setPaymentReference("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="grid gap-4 xl:grid-cols-3">
          <Panel title="Receive goods" description="Receipts append to the stock ledger.">
            <form onSubmit={receive} className="space-y-3">
              <Field label="Approved LPO">
                <select
                  className={INPUT_CLASS}
                  value={receiptPoId}
                  onChange={(event) => {
                    setReceiptPoId(event.target.value);
                    selectPurchaseOrder(event.target.value);
                  }}
                  required
                >
                  <option value="">Select an LPO</option>
                  {data.purchaseOrders
                    .filter((order) => order.status === "approved" || order.status === "partially_received")
                    .map((order) => (
                      <option key={order.id} value={order.id}>
                        {order.poNo} — {order.supplierName}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Destination store">
                <select
                  className={INPUT_CLASS}
                  value={receiptStoreId}
                  onChange={(event) => setReceiptStoreId(event.target.value)}
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
              {poDetail && poDetail.id === receiptPoId ? (
                <div className="space-y-2">
                  {poDetail.lines.map((line) => {
                    const state = receiptLines[line.id];
                    return (
                      <div
                        key={line.id}
                        className="grid gap-2 rounded-lg border border-border p-2 md:grid-cols-4"
                      >
                        <p className="self-center text-xs text-foreground">
                          {line.itemName ?? line.itemId}
                          <span className="block text-muted-foreground">
                            Outstanding {line.quantity - (line.receivedQuantity ?? 0)}
                          </span>
                        </p>
                        <Field label="Batch">
                          <input
                            className={INPUT_CLASS}
                            value={state?.batchNo ?? ""}
                            onChange={(event) =>
                              setReceiptLines((current) => ({
                                ...current,
                                [line.id]: {
                                  batchNo: event.target.value,
                                  expiryDate: state?.expiryDate ?? "",
                                  quantity: state?.quantity ?? "0",
                                  unitCost: state?.unitCost ?? "0",
                                },
                              }))
                            }
                            required
                          />
                        </Field>
                        <Field label="Expiry">
                          <input
                            type="date"
                            className={INPUT_CLASS}
                            value={state?.expiryDate ?? ""}
                            onChange={(event) =>
                              setReceiptLines((current) => ({
                                ...current,
                                [line.id]: {
                                  batchNo: state?.batchNo ?? "",
                                  expiryDate: event.target.value,
                                  quantity: state?.quantity ?? "0",
                                  unitCost: state?.unitCost ?? "0",
                                },
                              }))
                            }
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Qty">
                            <input
                              type="number"
                              min={1}
                              className={INPUT_CLASS}
                              value={state?.quantity ?? "0"}
                              onChange={(event) =>
                                setReceiptLines((current) => ({
                                  ...current,
                                  [line.id]: {
                                    batchNo: state?.batchNo ?? "",
                                    expiryDate: state?.expiryDate ?? "",
                                    quantity: event.target.value,
                                    unitCost: state?.unitCost ?? "0",
                                  },
                                }))
                              }
                              required
                            />
                          </Field>
                          <Field label="Unit cost">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              className={INPUT_CLASS}
                              value={state?.unitCost ?? "0"}
                              onChange={(event) =>
                                setReceiptLines((current) => ({
                                  ...current,
                                  [line.id]: {
                                    batchNo: state?.batchNo ?? "",
                                    expiryDate: state?.expiryDate ?? "",
                                    quantity: state?.quantity ?? "0",
                                    unitCost: event.target.value,
                                  },
                                }))
                              }
                              required
                            />
                          </Field>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Select an LPO to load its lines.</p>
              )}
              <Field label="Note" hint="Optional">
                <input
                  className={INPUT_CLASS}
                  value={receiptNote}
                  onChange={(event) => setReceiptNote(event.target.value)}
                />
              </Field>
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Receive goods
              </button>
            </form>
          </Panel>

          <Panel title="Supplier invoice" description="Three-way match before AP posting.">
            <form onSubmit={invoice} className="space-y-3">
              <Field label="Goods receipt">
                <select
                  className={INPUT_CLASS}
                  value={invoiceGrnId}
                  onChange={(event) => {
                    setInvoiceGrnId(event.target.value);
                    selectGoodsReceipt(event.target.value);
                  }}
                  required
                >
                  <option value="">Select a GRN</option>
                  {data.goodsReceipts
                    .filter((receipt) => receipt.status === "received")
                    .map((receipt) => (
                      <option key={receipt.id} value={receipt.id}>
                        {receipt.grnNo} — {receipt.poNo}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Invoice number">
                  <input
                    className={INPUT_CLASS}
                    value={invoiceNo}
                    onChange={(event) => setInvoiceNo(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Invoice date">
                  <input
                    type="date"
                    className={INPUT_CLASS}
                    value={invoiceDate}
                    onChange={(event) => setInvoiceDate(event.target.value)}
                    required
                  />
                </Field>
              </div>
              {grnDetail && grnDetail.id === invoiceGrnId ? (
                <div className="space-y-2">
                  {grnDetail.lines.map((line) => (
                    <div
                      key={line.id}
                      className="grid grid-cols-[1fr_70px_90px] items-end gap-2 rounded-lg border border-border p-2"
                    >
                      <p className="text-xs text-foreground">
                        {line.itemName ?? line.itemId}
                        <span className="block text-muted-foreground">Batch {line.batchNo}</span>
                      </p>
                      <Field label="Qty">
                        <input
                          type="number"
                          min={1}
                          className={INPUT_CLASS}
                          value={invoiceLines[line.id]?.quantity ?? "0"}
                          onChange={(event) =>
                            setInvoiceLines((current) => ({
                              ...current,
                              [line.id]: {
                                quantity: event.target.value,
                                unitCost: current[line.id]?.unitCost ?? "0",
                              },
                            }))
                          }
                          required
                        />
                      </Field>
                      <Field label="Unit cost">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={INPUT_CLASS}
                          value={invoiceLines[line.id]?.unitCost ?? "0"}
                          onChange={(event) =>
                            setInvoiceLines((current) => ({
                              ...current,
                              [line.id]: {
                                quantity: current[line.id]?.quantity ?? "0",
                                unitCost: event.target.value,
                              },
                            }))
                          }
                          required
                        />
                      </Field>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Select a GRN to load received lines.</p>
              )}
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Post supplier invoice
              </button>
            </form>
          </Panel>

          <Panel title="Supplier payment" description="Payments debit AP and credit cash or bank.">
            <form onSubmit={pay} className="space-y-3">
              <Field label="Unpaid invoice">
                <select
                  className={INPUT_CLASS}
                  value={paymentInvoiceId}
                  onChange={(event) => {
                    setPaymentInvoiceId(event.target.value);
                    selectSupplierInvoice(event.target.value);
                    const invoice = data.supplierInvoices.find((row) => row.id === event.target.value);
                    setPaymentAmount(
                      invoice
                        ? String((Number(invoice.amount) - Number(invoice.paidAmount)).toFixed(2))
                        : "",
                    );
                  }}
                  required
                >
                  <option value="">Select an invoice</option>
                  {data.supplierInvoices
                    .filter((invoice) => invoice.status !== "paid")
                    .map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.invoiceNo} — {formatMoney(Number(invoice.amount) - Number(invoice.paidAmount))}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Amount">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={INPUT_CLASS}
                    value={paymentAmount}
                    onChange={(event) => setPaymentAmount(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Method">
                  <select
                    className={INPUT_CLASS}
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value as "cash" | "bank")}
                  >
                    <option value="bank">Bank</option>
                    <option value="cash">Cash</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Payment date">
                  <input
                    type="date"
                    className={INPUT_CLASS}
                    value={paymentDate}
                    onChange={(event) => setPaymentDate(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Reference" hint="Optional">
                  <input
                    className={INPUT_CLASS}
                    value={paymentReference}
                    onChange={(event) => setPaymentReference(event.target.value)}
                  />
                </Field>
              </div>
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Record payment
              </button>
            </form>
          </Panel>
        </div>
      ) : null}

      <Panel title="Goods received notes" testId="procurement-grn-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>GRN</th>
                <th scope="col" className={TH_CLASS}>LPO</th>
                <th scope="col" className={TH_CLASS}>Store</th>
                <th scope="col" className={TH_CLASS}>Total</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.goodsReceipts.length === 0 ? (
                <EmptyRow colSpan={6} message="No goods receipts have been recorded yet." />
              ) : (
                data.goodsReceipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{receipt.grnNo}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{receipt.poNo}</td>
                    <td className={TD_CLASS}>{receipt.storeName}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(receipt.totalAmount)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={receipt.status === "invoiced" ? "success" : "info"}>
                        {receipt.status}
                      </StatusPill>
                    </td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        className={SUBTLE_BUTTON_CLASS}
                        onClick={() => selectGoodsReceipt(receipt.id)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Supplier invoices and payments" testId="procurement-invoice-list">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Invoice</th>
                  <th scope="col" className={TH_CLASS}>Supplier</th>
                  <th scope="col" className={TH_CLASS}>Outstanding</th>
                  <th scope="col" className={TH_CLASS}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.supplierInvoices.length === 0 ? (
                  <EmptyRow colSpan={4} message="No supplier invoices have been posted." />
                ) : (
                  data.supplierInvoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{invoice.invoiceNo}</td>
                      <td className={TD_CLASS}>{invoice.supplierName}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(Number(invoice.amount) - Number(invoice.paidAmount))}
                      </td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={invoice.status === "paid" ? "success" : "warning"}>
                          {invoice.status.replace("_", " ")}
                        </StatusPill>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Payment</th>
                  <th scope="col" className={TH_CLASS}>Invoice</th>
                  <th scope="col" className={TH_CLASS}>Amount</th>
                  <th scope="col" className={TH_CLASS}>Date</th>
                </tr>
              </thead>
              <tbody>
                {data.supplierPayments.length === 0 ? (
                  <EmptyRow colSpan={4} message="No supplier payments have been recorded." />
                ) : (
                  data.supplierPayments.map((payment) => (
                    <tr key={payment.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{payment.paymentNo}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{payment.invoiceNo}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(payment.amount)}
                      </td>
                      <td className={TD_CLASS}>{formatDate(payment.paymentDate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </div>
  );
}
