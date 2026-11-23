import { computeReportChecksum } from "@/lib/reporting";

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

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

export function cellsToXlsHtml(reportCode: string, periodLabel: string, cells: ExportCell[]) {
  const rows = cells.map((c) => `<tr${c.isTotal ? ' style="font-weight:bold;background:#f3f4f6"' : ""}><td>${esc(c.section ?? "")}</td><td>${esc(c.rowCode ?? "")}</td><td>${esc(c.rowLabel ?? "")}</td><td>${esc(c.colKey ?? "")}</td><td>${esc(c.colLabel ?? "")}</td><td style="text-align:right">${esc(c.valueNumeric ?? c.valueText ?? "")}</td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(reportCode)}</title></head><body><h2>${esc(reportCode)} ${esc(periodLabel)}</h2><table border="1" cellspacing="0" cellpadding="4"><thead><tr><th>Section</th><th>Row</th><th>Row Label</th><th>Col</th><th>Col Label</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export function cellsToPrintHtml(reportCode: string, reportName: string, periodLabel: string, checksum: string | null, cells: ExportCell[]) {
  const rows = cells.map((c) => `<tr class="${c.isTotal ? "total" : ""}"><td>${esc(c.section ?? "")}</td><td>${esc(c.rowCode ?? "")}</td><td>${esc(c.rowLabel ?? "")}</td><td>${esc(c.colKey ?? "")}</td><td class="num">${esc(c.valueNumeric ?? c.valueText ?? "")}</td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(reportCode)}</title><style>
  body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}h2{font-size:14px;margin:4px 0 16px;color:#444}
  table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #333;padding:3px 4px;vertical-align:top}th{background:#eee}
  .num{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:bold;background:#f5f5f5}
  .meta{font-size:11px;color:#444;margin-bottom:12px}.sig{display:flex;gap:48px;margin-top:24px;font-size:12px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px}
  @media print{body{margin:0}.no-print{display:none}}
  </style></head><body>
  <div class="no-print" style="margin-bottom:12px"><button onclick="window.print()">Print / Save PDF</button></div>
  <h1>${esc(reportName)} (${esc(reportCode)})</h1><h2>${esc(periodLabel)}</h2>
  <div class="meta">Checksum: ${esc(checksum ?? "")} • Cells: ${cells.length} • Generated from operational records</div>
  <table><thead><tr><th>Section</th><th>Row</th><th>Label</th><th>Col</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="sig"><div>Submitted By / Name / Date / Signature</div><div>Received By / Name / Date / Signature</div></div>
  </body></html>`;
}
