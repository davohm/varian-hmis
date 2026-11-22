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
  formatMoney,
  type ProcurementPanelProps,
  SUBTLE_BUTTON_CLASS,
} from "@/components/procurement/procurement-types";

type QuoteTone = "neutral" | "success" | "warning" | "info";

function quoteTone(status: string): QuoteTone {
  if (status === "selected") return "success";
  if (status === "rejected") return "danger" as QuoteTone;
  if (status === "received") return "info";
  return "neutral";
}

export function SourcingPanel({
  data,
  canWrite,
  busy,
  run,
  selectRfq,
}: Pick<ProcurementPanelProps, "data" | "canWrite" | "busy" | "run" | "selectRfq">) {
  const [requisitionId, setRequisitionId] = useState("");
  const [closingDate, setClosingDate] = useState("");
  const [quoteRfqId, setQuoteRfqId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [quoteNo, setQuoteNo] = useState("");
  const [unitCosts, setUnitCosts] = useState<Record<string, string>>({});
  const [leadTimes, setLeadTimes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const rfqDetail = data.rfqDetail;

  useEffect(() => {
    if (!rfqDetail) return;
    setUnitCosts(
      Object.fromEntries(rfqDetail.lines.map((line) => [line.itemId, line.unitCost ?? "0"])),
    );
    setLeadTimes(Object.fromEntries(rfqDetail.lines.map((line) => [line.itemId, ""])));
  }, [rfqDetail]);

  async function issueRfq(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createRfq",
      { requisitionId, closingDate: closingDate || null },
      "RFQ issued",
    );
    if (ok) {
      setRequisitionId("");
      setClosingDate("");
    }
  }

  async function submitQuote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rfqDetail || quoteRfqId !== rfqDetail.id) {
      await run("recordSupplierQuote", {}, "Select an RFQ first");
      return;
    }
    const ok = await run(
      "recordSupplierQuote",
      {
        rfqId: quoteRfqId,
        supplierId,
        quoteNo: quoteNo || null,
        lines: rfqDetail.lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity,
          unitCost: unitCosts[line.itemId] ?? "0",
          leadTimeDays: leadTimes[line.itemId] ? Number(leadTimes[line.itemId]) : null,
        })),
      },
      "Supplier quote recorded",
    );
    if (ok) {
      setSupplierId("");
      setQuoteNo("");
    }
  }

  async function selectQuote(quoteId: string) {
    const reason = reasons[quoteId]?.trim() ?? "";
    const ok = await run(
      "selectSupplierQuote",
      { quoteId, reason: reason || "Lowest evaluated compliant quote" },
      "Supplier selected",
    );
    if (ok) setReasons((current) => ({ ...current, [quoteId]: "" }));
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Issue RFQ" description="Only approved requisitions can be quoted.">
            <form onSubmit={issueRfq} className="space-y-3">
              <Field label="Approved requisition">
                <select
                  className={INPUT_CLASS}
                  value={requisitionId}
                  onChange={(event) => setRequisitionId(event.target.value)}
                  required
                >
                  <option value="">Select a requisition</option>
                  {data.requisitions
                    .filter((requisition) => requisition.status === "approved")
                    .map((requisition) => (
                      <option key={requisition.id} value={requisition.id}>
                        {requisition.requisitionNo} — {requisition.department}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Closing date" hint="Optional">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={closingDate}
                  onChange={(event) => setClosingDate(event.target.value)}
                />
              </Field>
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Issue RFQ
              </button>
            </form>
          </Panel>

          <Panel title="Record supplier quote" description="Quotes must cover every RFQ line.">
            <form onSubmit={submitQuote} className="space-y-3">
              <Field label="RFQ">
                <select
                  className={INPUT_CLASS}
                  value={quoteRfqId}
                  onChange={(event) => {
                    setQuoteRfqId(event.target.value);
                    selectRfq(event.target.value);
                  }}
                  required
                >
                  <option value="">Select an RFQ</option>
                  {data.rfqs
                    .filter((rfq) => rfq.status === "open")
                    .map((rfq) => (
                      <option key={rfq.id} value={rfq.id}>
                        {rfq.rfqNo}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Supplier">
                  <select
                    className={INPUT_CLASS}
                    value={supplierId}
                    onChange={(event) => setSupplierId(event.target.value)}
                    required
                  >
                    <option value="">Select a supplier</option>
                    {data.suppliers
                      .filter((supplier) => supplier.active)
                      .map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.code} — {supplier.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Supplier quote number" hint="Optional">
                  <input
                    className={INPUT_CLASS}
                    value={quoteNo}
                    onChange={(event) => setQuoteNo(event.target.value)}
                  />
                </Field>
              </div>
              {rfqDetail ? (
                <div className="space-y-2">
                  {rfqDetail.lines.map((line) => (
                    <div key={line.itemId} className="grid gap-2 md:grid-cols-[2fr_70px_1fr_1fr]">
                      <p className="self-center text-xs text-foreground">
                        {line.itemName ?? line.itemId}
                        <span className="block text-muted-foreground">Qty {line.quantity}</span>
                      </p>
                      <Field label="Unit cost">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={INPUT_CLASS}
                          value={unitCosts[line.itemId] ?? "0"}
                          onChange={(event) =>
                            setUnitCosts((current) => ({
                              ...current,
                              [line.itemId]: event.target.value,
                            }))
                          }
                          required
                        />
                      </Field>
                      <Field label="Lead time (days)">
                        <input
                          type="number"
                          min={0}
                          className={INPUT_CLASS}
                          value={leadTimes[line.itemId] ?? ""}
                          onChange={(event) =>
                            setLeadTimes((current) => ({
                              ...current,
                              [line.itemId]: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Select an RFQ to load its lines.</p>
              )}
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Record quote
              </button>
            </form>
          </Panel>
        </div>
      ) : null}

      <Panel
        title="RFQs and quotations"
        description="Compare supplier quotes before selecting a source."
        testId="procurement-rfq-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>RFQ</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Supplier</th>
                <th scope="col" className={TH_CLASS}>Total</th>
                <th scope="col" className={TH_CLASS}>Quote status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.quotes.length === 0 ? (
                <EmptyRow colSpan={6} message="No supplier quotations have been captured yet." />
              ) : (
                data.quotes.map((quote) => (
                  <tr key={quote.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      {data.rfqs.find((rfq) => rfq.id === quote.rfqId)?.rfqNo ?? quote.rfqId.slice(0, 8)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill
                        tone={
                          data.rfqs.find((rfq) => rfq.id === quote.rfqId)?.status === "closed"
                            ? "neutral"
                            : "info"
                        }
                      >
                        {data.rfqs.find((rfq) => rfq.id === quote.rfqId)?.status ?? "unknown"}
                      </StatusPill>
                    </td>
                    <td className={TD_CLASS}>{quote.supplierName}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(quote.totalAmount)}
                    </td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={quoteTone(quote.status)}>{quote.status}</StatusPill>
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={SUBTLE_BUTTON_CLASS}
                          onClick={() => selectRfq(quote.rfqId)}
                        >
                          View RFQ
                        </button>
                        {canWrite && quote.status === "received" ? (
                          <>
                            <input
                              aria-label={`Selection reason for ${quote.supplierName}`}
                              className={`${INPUT_CLASS} w-44`}
                              placeholder="Selection reason"
                              value={reasons[quote.id] ?? ""}
                              onChange={(event) =>
                                setReasons((current) => ({
                                  ...current,
                                  [quote.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              disabled={busy}
                              onClick={() => selectQuote(quote.id)}
                            >
                              Select
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
      </Panel>
    </div>
  );
}
