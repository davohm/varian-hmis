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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function zipStore(entries: Array<{ name: string; data: Uint8Array }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x0021, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function xmlEscape(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(index: number) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function inlineCell(ref: string, value: string) {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

export function cellsToXlsxBytes(reportCode: string, periodLabel: string, cells: ExportCell[], meta?: MohExportMeta) {
  const encoder = new TextEncoder();
  const grids = buildGrid(cells);
  const rowXml: string[] = [];
  let rowNumber = 1;
  const headerMeta: Array<[string, string]> = [
    [reportCode, periodLabel],
    ["Facility", meta?.facilityName ?? ""],
    ["County", meta?.county ?? ""],
    ["Sub-County", meta?.subCounty ?? ""],
    ["MFL", meta?.mflCode ?? ""],
    ["Epi Week", meta?.epiWeek ? `${meta.epiWeek}${meta.epiYear ? ` / ${meta.epiYear}` : ""}` : ""],
    ["Week Ending", meta?.weekEnding ?? ""],
  ];
  for (const [label, value] of headerMeta) {
    rowXml.push(`<row r="${rowNumber}">${inlineCell(`A${rowNumber}`, label)}${inlineCell(`B${rowNumber}`, value)}</row>`);
    rowNumber++;
  }
  for (const grid of grids) {
    rowXml.push(`<row r="${rowNumber}">${inlineCell(`A${rowNumber}`, `Section ${grid.section || "-"}`)}</row>`);
    rowNumber++;
    rowXml.push(`<row r="${rowNumber}">${["Row", "Description", ...grid.colLabels].map((label, i) => inlineCell(`${columnName(i)}${rowNumber}`, label)).join("")}</row>`);
    rowNumber++;
    for (const row of grid.rows) {
      rowXml.push(`<row r="${rowNumber}">${[row.rowCode, row.rowLabel, ...row.values.map((v) => String(v ?? ""))].map((value, i) => inlineCell(`${columnName(i)}${rowNumber}`, value)).join("")}</row>`);
      rowNumber++;
    }
  }
  rowXml.push(`<row r="${rowNumber}">${inlineCell(`A${rowNumber}`, "Submitted By")}${inlineCell(`B${rowNumber}`, "")}${inlineCell(`C${rowNumber}`, "Received By")}</row>`);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="MOH Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml.join("")}</sheetData></worksheet>`;
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rels) },
    { name: "xl/workbook.xml", data: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) },
  ]);
}

function pdfEscape(s: string) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "?").slice(0, 180);
}

export function cellsToPdfBytes(reportCode: string, reportName: string, periodLabel: string, checksum: string | null, cells: ExportCell[], meta?: MohExportMeta) {
  const lines: string[] = [];
  if (meta?.facilityName) lines.push(`Facility: ${meta.facilityName}`);
  if (meta?.county || meta?.subCounty) lines.push(`County: ${meta.county ?? ""} / Sub-County: ${meta.subCounty ?? ""}`);
  if (meta?.epiWeek) lines.push(`Epi Week: ${meta.epiWeek}${meta.epiYear ? ` / ${meta.epiYear}` : ""}`);
  lines.push(`Period: ${periodLabel}`);
  lines.push(`Checksum: ${checksum ?? ""} | Cells: ${cells.length}`);
  for (const grid of buildGrid(cells)) {
    lines.push(`SECTION ${grid.section || "-"}`);
    lines.push(`Row | Description | ${grid.colLabels.join(" | ")}`);
    for (const row of grid.rows) lines.push(`${row.rowCode} | ${row.rowLabel} | ${row.values.map((v) => String(v ?? "")).join(" | ")}`);
  }
  lines.push("Submitted By: ____________  Date: ______  Signature: ______");
  lines.push("Received By: ____________  Date: ______  Signature: ______");

  const perPage = 48;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const pageCount = Math.max(1, pages.length);
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const contentIds = pages.map((_, i) => 4 + i * 2);
  const fontId = 3 + pageCount * 2;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  pages.forEach((pageLines, i) => {
    objects[pageIds[i] - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    const title = i === 0 ? `${reportName} (${reportCode})` : `${reportName} (${reportCode}) - continued`;
    let stream = `BT\n/F1 14 Tf\n40 560 Td\n(${pdfEscape(title)}) Tj\nET\n`;
    stream += `BT\n/F1 9 Tf\n40 535 Td\n`;
    pageLines.forEach((line, j) => {
      stream += `(${pdfEscape(line)}) Tj\n${j === pageLines.length - 1 ? "" : "0 -11 Td\n"}`;
    });
    stream += `ET\n`;
    objects[contentIds[i] - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  });
  objects[fontId - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
