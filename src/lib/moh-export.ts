import { computeReportChecksum } from "./reporting";

export interface ExportCell {
  section: string | null;
  rowCode: string | null;
  rowLabel: string | null;
  colKey: string | null;
  colLabel: string | null;
  valueNumeric: string | null;
  valueText: string | null;
  sortOrder: number;
  isTotal: boolean | null;
}

export interface MohExportMeta {
  facilityName?: string | null;
  county?: string | null;
  subCounty?: string | null;
  ward?: string | null;
  mflCode?: string | null;
  epiWeek?: string | null;
  epiYear?: number | null;
  weekEnding?: string | null;
  month?: string | null;
  year?: number | null;
}

function esc(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function exportChecksum(cells: ExportCell[]) {
  return computeReportChecksum(cells.map((c) => ({ section: c.section, rowCode: c.rowCode, colKey: c.colKey, valueNumeric: c.valueNumeric, valueText: c.valueText, sortOrder: c.sortOrder, isTotal: c.isTotal })));
}

export function cellsToCsv(cells: ExportCell[]) {
  const header = ["section", "rowCode", "rowLabel", "colKey", "colLabel", "valueNumeric", "valueText", "isTotal"];
  const lines = [header.join(",")];
  for (const c of cells) {
    const row = [c.section, c.rowCode, c.rowLabel, c.colKey, c.colLabel, c.valueNumeric, c.valueText, c.isTotal ? "true" : "false"].map((v) => JSON.stringify(v ?? ""));
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function buildGrid(cells: ExportCell[]) {
  const sections = Array.from(new Set(cells.map((c) => c.section ?? "")));
  return sections.map((section) => {
    const sc = cells.filter((c) => (c.section ?? "") === section);
    const colKeys = Array.from(new Set(sc.map((c) => c.colKey ?? "")));
    const colLabels = colKeys.map((k) => sc.find((c) => (c.colKey ?? "") === k)?.colLabel ?? k);
    const rowKeys = Array.from(new Set(sc.map((c) => c.rowCode ?? "")));
    const rows = rowKeys.map((rk) => {
      const rc = sc.filter((c) => (c.rowCode ?? "") === rk);
      const first = rc[0];
      const values = colKeys.map((ck) => {
        const cell = rc.find((c) => (c.colKey ?? "") === ck);
        return cell?.valueNumeric ?? cell?.valueText ?? "";
      });
      return { rowCode: rk, rowLabel: first?.rowLabel ?? rk, isTotal: !!first?.isTotal, values };
    });
    return { section, colKeys, colLabels, rows };
  });
}

function letterhead(meta?: MohExportMeta) {
  if (!meta) return "";
  const parts = [
    meta.facilityName ? `<div><strong>Facility:</strong> ${esc(meta.facilityName)}</div>` : "",
    meta.mflCode ? `<div><strong>MFL Code:</strong> ${esc(meta.mflCode)}</div>` : "",
    meta.county ? `<div><strong>County:</strong> ${esc(meta.county)}</div>` : "",
    meta.subCounty ? `<div><strong>Sub-County:</strong> ${esc(meta.subCounty)}</div>` : "",
    meta.ward ? `<div><strong>Ward:</strong> ${esc(meta.ward)}</div>` : "",
    meta.epiWeek ? `<div><strong>Epi Week:</strong> ${esc(meta.epiWeek)}${meta.epiYear ? ` / ${meta.epiYear}` : ""}</div>` : "",
    meta.weekEnding ? `<div><strong>Week Ending:</strong> ${esc(meta.weekEnding)}</div>` : "",
    meta.month ? `<div><strong>Month/Period:</strong> ${esc(meta.month)}${meta.year ? ` ${meta.year}` : ""}</div>` : "",
  ].filter(Boolean);
  return parts.length ? `<div class="letterhead">${parts.join("")}</div>` : "";
}

function gridHtml(cells: ExportCell[]) {
  const grids = buildGrid(cells);
  return grids.map((g) => {
    const head = `<tr><th>Row</th><th>Description</th>${g.colLabels.map((l) => `<th class="num">${esc(l)}</th>`).join("")}</tr>`;
    const body = g.rows.map((r) => `<tr class="${r.isTotal ? "total" : ""}"><td>${esc(r.rowCode)}</td><td>${esc(r.rowLabel)}</td>${r.values.map((v) => `<td class="num">${esc(String(v ?? ""))}</td>`).join("")}</tr>`).join("");
    return `<h3 class="section">Section ${esc(g.section || "-")}</h3><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }).join("\n");
}

export function cellsToXlsHtml(reportCode: string, periodLabel: string, cells: ExportCell[], meta?: MohExportMeta) {
  const lh = meta ? `<table border="0" cellpadding="2" style="margin-bottom:8px"><tr><td><b>Facility</b></td><td>${esc(meta.facilityName ?? "")}</td><td><b>County</b></td><td>${esc(meta.county ?? "")}</td><td><b>Sub-County</b></td><td>${esc(meta.subCounty ?? "")}</td></tr><tr><td><b>MFL</b></td><td>${esc(meta.mflCode ?? "")}</td><td><b>Epi Week</b></td><td>${esc(meta.epiWeek ?? "")}</td><td><b>Week Ending</b></td><td>${esc(meta.weekEnding ?? periodLabel)}</td></tr></table>` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(reportCode)}</title></head><body><h2>${esc(reportCode)} ${esc(periodLabel)}</h2>${lh}${gridHtml(cells)}<p>Submitted By: ____________ Date: ______ Signature: ______ &nbsp; Received By: ____________ Date: ______ Signature: ______</p></body></html>`;
}

export function cellsToPrintHtml(reportCode: string, reportName: string, periodLabel: string, checksum: string | null, cells: ExportCell[], meta?: MohExportMeta) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(reportCode)}</title><style>
  body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}h2{font-size:14px;margin:4px 0 12px;color:#444}
  h3.section{font-size:12px;margin:14px 0 4px}
  table{width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px}th,td{border:1px solid #333;padding:2px 3px;vertical-align:top}th{background:#eee}
  .num{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:bold;background:#f5f5f5}
  .meta{font-size:11px;color:#444;margin-bottom:12px}.letterhead{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 12px;font-size:11px;margin:8px 0 12px;padding:8px;border:1px solid #999}
  .sig{display:flex;gap:48px;margin-top:24px;font-size:12px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px}
  @media print{body{margin:0}.no-print{display:none}@page{size:auto;margin:10mm}}
  </style></head><body>
  <div class="no-print" style="margin-bottom:12px"><button onclick="window.print()">Print / Save PDF</button></div>
  <h1>${esc(reportName)} (${esc(reportCode)})</h1><h2>${esc(periodLabel)}</h2>
  ${letterhead(meta)}
  <div class="meta">Checksum: ${esc(checksum ?? "")} - Cells: ${cells.length} - Generated from operational records</div>
  ${gridHtml(cells)}
  <div class="sig"><div>Submitted By / Name / Date / Signature</div><div>Received By / Name / Date / Signature</div></div>
  </body></html>`;
}
