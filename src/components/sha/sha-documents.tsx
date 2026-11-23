"use client";

import { Printer } from "lucide-react";

import { formatDate, formatMoney, type ShaClaimDetail } from "@/components/sha/sha-types";

const DOCUMENT_CLASS =
  "sha-document rounded-xl border border-border bg-white p-6 text-black shadow-sm sm:p-8";

function PrintBar({ label }: { label: string }) {
  return (
    <div className="sha-hide-print mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Printer className="size-4" aria-hidden="true" />
        Print / save PDF
      </button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
        {label}
      </div>
      <div className="mt-0.5 break-words text-xs font-medium">{value || "—"}</div>
    </div>
  );
}

export function ShaClaimDocument({ claim }: { claim: ShaClaimDetail }) {
  return (
    <section data-testid="sha-claim-document" aria-label="Printable SHA claim form">
      <PrintBar label="Print-ready SHA claim form. Facility and patient identifiers are shown as recorded." />
      <div className={DOCUMENT_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-black pb-3">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.2em] uppercase">
              Social Health Authority
            </div>
            <h2 className="mt-1 text-lg font-bold tracking-tight">Claim form / SHA-01</h2>
          </div>
          <div className="text-right text-xs">
            <div className="font-semibold">{claim.shaClaimRef ?? "Pending SHA reference"}</div>
            <div>{claim.claimNo}</div>
            <div>{claim.fund?.toUpperCase() ?? "FUND"}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Facility" value={claim.empanelment?.schemeCode} />
          <Detail label="KMPDC no." value={claim.empanelment?.kmpdcNumber} />
          <Detail label="Contract no." value={claim.empanelment?.contractNo} />
          <Detail label="Tariff version" value={claim.tariffVersion ?? claim.empanelment?.tariffVersion} />
          <Detail label="Patient" value={claim.patientName} />
          <Detail label="MRN" value={claim.mrn} />
          <Detail label="Encounter" value={claim.encounterNo} />
          <Detail label="Invoice" value={claim.invoiceNo} />
          <Detail label="Benefit package" value={claim.benefitPackage?.name} />
          <Detail label="Pre-authorisation" value={claim.preAuth?.shaAuthRef ?? claim.preAuth?.authNo} />
          <Detail label="Submitted" value={claim.submittedAt ? formatDate(claim.submittedAt) : null} />
          <Detail label="Status" value={claim.status} />
        </div>

        <table className="sha-document-table mt-5 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className="text-left">SHA code</th>
              <th scope="col" className="text-left">Description</th>
              <th scope="col" className="text-right">Qty</th>
              <th scope="col" className="text-right">Unit price</th>
              <th scope="col" className="text-right">Billed</th>
              <th scope="col" className="text-right">Approved</th>
            </tr>
          </thead>
          <tbody>
            {claim.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.shaServiceCode ?? "—"}</td>
                <td>{line.description}</td>
                <td className="text-right">{line.quantity}</td>
                <td className="text-right">{formatMoney(line.unitPrice)}</td>
                <td className="text-right">{formatMoney(line.amount)}</td>
                <td className="text-right">{formatMoney(line.approvedAmount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4} className="text-right">Totals</th>
              <td className="text-right font-semibold">{formatMoney(claim.total)}</td>
              <td className="text-right font-semibold">{formatMoney(claim.approvedAmount)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
          <Detail label="Billed to SHA" value={formatMoney(claim.billedAmount)} />
          <Detail label="Patient co-pay" value={formatMoney(claim.patientCoPay)} />
          <Detail label="Adjudication" value={claim.adjudicationCode ?? "Pending"} />
        </div>

        <div className="mt-8 grid gap-8 text-[11px] sm:grid-cols-2">
          <div className="border-t border-black pt-2">Prepared by / signature</div>
          <div className="border-t border-black pt-2">Facility stamp / date</div>
        </div>
      </div>
    </section>
  );
}

export function ShaRemittanceDocument({ claim }: { claim: ShaClaimDetail }) {
  const total = claim.remittances.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const reportRef = claim.remittances.find((item) => item.shaPaymentReportRef)?.shaPaymentReportRef;
  const bankReference = claim.remittances.find((item) => item.bankReference)?.bankReference;

  return (
    <section data-testid="sha-remittance-document" aria-label="Printable SHA remittance advice">
      <PrintBar label="Print-ready remittance advice for the selected SHA claim." />
      <div className={DOCUMENT_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-black pb-3">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.2em] uppercase">
              Social Health Authority
            </div>
            <h2 className="mt-1 text-lg font-bold tracking-tight">Remittance advice</h2>
          </div>
          <div className="text-right text-xs">
            <div className="font-semibold">{reportRef ?? claim.shaClaimRef ?? claim.claimNo}</div>
            <div>{claim.claimNo}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Facility" value={claim.empanelment?.schemeCode} />
          <Detail label="KMPDC no." value={claim.empanelment?.kmpdcNumber} />
          <Detail label="Patient" value={claim.patientName} />
          <Detail label="MRN" value={claim.mrn} />
          <Detail label="Payment report" value={reportRef} />
          <Detail label="Bank reference" value={bankReference} />
          <Detail label="Paid total" value={formatMoney(total.toFixed(2))} />
          <Detail label="Claim status" value={claim.status} />
        </div>

        <table className="sha-document-table mt-5 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className="text-left">Receipt no.</th>
              <th scope="col" className="text-left">Claim line</th>
              <th scope="col" className="text-left">Received</th>
              <th scope="col" className="text-left">Reference</th>
              <th scope="col" className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {claim.remittances.map((item) => (
              <tr key={item.id}>
                <td>{item.remittanceNo}</td>
                <td>
                  {claim.lines.find((line) => line.id === item.claimLineId)?.description ?? "Claim level"}
                </td>
                <td>{formatDate(item.paymentDate ?? item.receivedAt)}</td>
                <td>{item.reference ?? item.bankReference ?? "—"}</td>
                <td className="text-right">{formatMoney(item.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4} className="text-right">Total received</th>
              <td className="text-right font-semibold">{formatMoney(total.toFixed(2))}</td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
          <Detail label="Approved" value={formatMoney(claim.approvedAmount)} />
          <Detail label="Previously paid" value={formatMoney((Number(claim.paidAmount) - total).toFixed(2))} />
          <Detail label="Balance" value={formatMoney(claim.outstanding)} />
        </div>

        <div className="mt-8 grid gap-8 text-[11px] sm:grid-cols-2">
          <div className="border-t border-black pt-2">Received by / signature</div>
          <div className="border-t border-black pt-2">Bank stamp / date</div>
        </div>
      </div>
    </section>
  );
}
