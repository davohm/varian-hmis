"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { reportDataToCsv, type ErpReportFilters } from "@/lib/erp-reporting";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney, type MohReportCellRow, type MohReportMeta, type MohReportRunRow, type ReportsApiData } from "@/components/reports/reports-types";
import { useReportsCommand } from "@/components/reports/use-reports-command";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function defaultFrom(to: string) { return `${to.slice(0, 4)}-01-01`; }
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatPeriod(meta: MohReportMeta | null, run: MohReportRunRow | null) {
  if (!meta && !run) return "—";
  const m = meta;
  const periodType = m?.periodType ?? (run?.epiWeek ? "epi_week" : "month");
  if (periodType === "epi_week") {
    const wk = m?.epiWeek ?? run?.epiWeek;
    const yr = m?.epiYear ?? run?.epiYear;
    return wk && yr ? `Epi week ${wk} / ${yr}` : `${m?.periodStart ?? run?.periodStart ?? ""} to ${m?.periodEnd ?? run?.periodEnd ?? ""}`;
  }
  if (periodType === "month") {
    const month = m?.month ?? run?.month;
    const year = m?.year ?? run?.year;
    if (month && year) return new Date(year, month - 1, 1).toLocaleString("en-KE", { month: "long", year: "numeric" });
  }
  return `${m?.periodStart ?? run?.periodStart ?? ""} to ${m?.periodEnd ?? run?.periodEnd ?? ""}`;
}

const MOH_SECTION_LABELS: Record<string, string> = {
  A: "Section A", B: "Section B", B_ADULT: "Adults", B_PAEDS: "Paediatrics", SUMMARY: "Summary",
  REGISTER: "Register", QUEUE: "Queue", AGE: "Age", VISUAL_ACUITY: "Visual acuity",
  DIAGNOSIS: "Diagnosis", RESIDENCY: "Residency", DOCTORS: "Doctors", BRANCHES: "Branches",
};

function sectionLabel(key: string | null) {
  if (!key) return "Report";
  return MOH_SECTION_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayCellValue(cell: MohReportCellRow | undefined) {
  if (!cell) return "";
  if (cell.valueText != null && cell.valueText !== "") return cell.valueText;
  if (cell.valueNumeric == null || cell.valueNumeric === "") return "";
  const n = Number(cell.valueNumeric);
  if (!Number.isFinite(n)) return String(cell.valueNumeric);
  return Number.isInteger(n) ? String(n) : String(n);
}

function MohStatutorySheet({
  meta, run, cells, onDrill,
}: {
  meta: MohReportMeta | null;
  run: MohReportRunRow | null;
  cells: MohReportCellRow[];
  onDrill: (rowCode: string, colKey: string) => void;
}) {
  const sections = useMemo(() => {
    const ordered: Array<{ key: string; cells: MohReportCellRow[] }> = [];
    const byKey = new Map<string, MohReportCellRow[]>();
    for (const cell of [...cells].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const key = cell.section ?? "__default__";
      if (!byKey.has(key)) {
        const arr: MohReportCellRow[] = [];
        byKey.set(key, arr);
        ordered.push({ key, cells: arr });
      }
      byKey.get(key)!.push(cell);
    }
    return ordered.map((section) => {
      const colKeys: string[] = [];
      const colLabels = new Map<string, string>();
      const rows: Array<{ rowCode: string; rowLabel: string; isTotal: boolean; byCol: Map<string, MohReportCellRow> }> = [];
      const rowMap = new Map<string, (typeof rows)[number]>();
      for (const cell of section.cells) {
        const colKey = cell.colKey ?? "value";
        if (!colKeys.includes(colKey)) {
          colKeys.push(colKey);
          colLabels.set(colKey, cell.colLabel ?? colKey);
        }
        const rowCode = cell.rowCode ?? `__row_${cell.id}`;
        let row = rowMap.get(rowCode);
        if (!row) {
          row = { rowCode, rowLabel: cell.rowLabel ?? rowCode, isTotal: Boolean(cell.isTotal), byCol: new Map() };
          rowMap.set(rowCode, row);
          rows.push(row);
        }
        row.byCol.set(colKey, cell);
        if (cell.isTotal) row.isTotal = true;
        if (cell.rowLabel) row.rowLabel = cell.rowLabel;
      }
      return { key: section.key, colKeys, colLabels, rows };
    });
  }, [cells]);

  const period = formatPeriod(meta, run);
  const facilityName = meta?.facilityName ?? "Facility";
  const reportTitle = meta?.reportName ?? run?.reportName ?? "MOH Report";
  const reportCode = meta?.reportCode ?? run?.reportCode ?? "";

  return (
    <div className="moh-sheet space-y-4 rounded-md border bg-white p-4 text-black print:border-0 print:p-0">
      <div className="space-y-1 border-b pb-3 text-center">
        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground print:text-black">Ministry of Health / Statutory Return</div>
        <h3 className="text-lg font-semibold leading-tight">{reportTitle} {reportCode ? <span className="text-muted-foreground print:text-black">({reportCode})</span> : null}</h3>
        <div className="text-sm">{facilityName}{meta?.branchName ? ` — ${meta.branchName}` : ""}</div>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4 print:grid-cols-4">
        <div><span className="text-muted-foreground print:text-black">County:</span> {meta?.county ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">Sub-county:</span> {meta?.subCounty ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">Ward:</span> {meta?.ward ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">MFL/KMHFL:</span> {meta?.kmhflId ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">Period:</span> {period}</div>
        <div><span className="text-muted-foreground print:text-black">Dates:</span> {meta?.periodStart ?? run?.periodStart ?? "—"} to {meta?.periodEnd ?? run?.periodEnd ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">Epi week/year:</span> {meta?.epiWeek ?? run?.epiWeek ?? "—"} / {meta?.epiYear ?? run?.epiYear ?? "—"}</div>
        <div><span className="text-muted-foreground print:text-black">Status:</span> {meta?.status ?? run?.status ?? "—"}</div>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No cells for this run.</p>
      ) : sections.map((section) => (
        <div key={section.key} className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground print:text-black">{sectionLabel(section.key === "__default__" ? null : section.key)}</div>
          <div className="overflow-x-auto">
            <table className="moh-sheet-table w-full border-collapse text-[11px]" data-testid={section.key === sections[0]?.key ? "moh-cells-table" : undefined}>
              <thead>
                <tr>
                  <th className="border px-1.5 py-1 text-left font-medium">Row</th>
                  {section.colKeys.map((colKey) => <th key={colKey} className="border px-1.5 py-1 text-left font-medium">{section.colLabels.get(colKey) ?? colKey}</th>)}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.rowCode} className={row.isTotal ? "bg-muted/20 font-medium print:bg-transparent" : ""}>
                    <td className="border px-1.5 py-1 align-top">{row.rowLabel}</td>
                    {section.colKeys.map((colKey) => {
                      const cell = row.byCol.get(colKey);
                      const value = displayCellValue(cell);
                      const canDrill = Boolean(cell?.rowCode && cell?.colKey);
                      return (
                        <td key={colKey} className={`border px-1.5 py-1 align-top ${/^-?\d/.test(value) ? "text-right tabular-nums" : ""}`}>
                          {canDrill ? (
                            <button type="button" className="moh-cell-drill w-full text-inherit underline-offset-2 hover:underline print:no-underline" onClick={() => onDrill(cell!.rowCode!, cell!.colKey!)}>
                              {value || "—"}
                            </button>
                          ) : (value || "")}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="grid gap-4 border-t pt-3 text-xs sm:grid-cols-2 print:grid-cols-2">
        <div className="space-y-1">
          <div className="font-medium">Submitted By</div>
          <div>Name: {meta?.submittedBy ?? "____________________________"}</div>
          <div>Signature: ____________________________</div>
          <div>Date: {meta?.submittedAt ? new Date(meta.submittedAt).toLocaleDateString("en-KE") : "____________________________"}</div>
        </div>
        <div className="space-y-1">
          <div className="font-medium">Received By</div>
          <div>Name: ____________________________</div>
          <div>Signature: ____________________________</div>
          <div>Date / Ref: {meta?.acknowledgementRef ?? "____________________________"}</div>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground print:text-black">
        Generated: {meta?.generatedAt ? new Date(meta.generatedAt).toLocaleString("en-KE") : "—"} · Checksum: {meta?.checksum ?? run?.checksum ?? "—"}
      </div>
    </div>
  );
}
function isMohCode(code: string) { return /^MOH\d/.test(code); }

export function ReportsWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<ReportsApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportCode, setReportCode] = useState<string>("ERP_TRIAL_BALANCE");
  const [to, setTo] = useState(todayIso());
  const [from, setFrom] = useState(defaultFrom(todayIso()));
  const [sourceType, setSourceType] = useState<string | undefined>();
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [viewName, setViewName] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [mohDrill, setMohDrill] = useState<{ rowCode: string; colKey: string; data: unknown } | null>(null);

  const filters = useMemo<ErpReportFilters>(() => ({ from, to, asOf: to }), [from, to]);
  const moh = isMohCode(reportCode);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("reportCode", reportCode);
      params.set("from", from);
      params.set("to", to);
      params.set("asOf", to);
      if (sourceType && sourceId) { params.set("sourceType", sourceType); params.set("sourceId", sourceId); }
      if (selectedRunId) params.set("runId", selectedRunId);
      const response = await fetch(`/api/reports?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) { window.location.href = "/"; return; }
      const payload = (await response.json().catch(() => null)) as ReportsApiData | { error?: string } | null;
      if (!response.ok) throw new Error((payload as { error?: string } | null)?.error ?? "Failed to load reports");
      setData(payload as ReportsApiData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [from, reportCode, selectedRunId, sourceId, sourceType, to]);

  useEffect(() => { void load(); }, [load]);
  const { busy, error: commandError, run } = useReportsCommand(load);

  const report = data?.reportData;
  const drillDown = data?.drillDown;
  const mohRuns = (data?.mohRuns ?? []) as MohReportRunRow[];
  const mohCells = (data?.mohCells ?? []) as MohReportCellRow[];
  const mohMeta = (data?.mohMeta ?? null) as MohReportMeta | null;
  const selectedRun = mohRuns.find((r) => r.id === selectedRunId) ?? null;

  async function handleGenerateErp() { await run("generateErpReport", { reportCode, filters }, "Report generated"); }
  async function handleSaveView() {
    if (!viewName.trim()) return;
    const ok = await run("saveReportView", { reportCode, name: viewName.trim(), shared: false, filters }, "Report view saved");
    if (ok) setViewName("");
  }
  async function handleExportErp() {
    if (!report) return;
    downloadCsv(`${report.reportCode}-${report.to}.csv`, reportDataToCsv(report));
    await run("generateErpReport", { reportCode, filters }, "Report snapshot recorded");
  }

  async function handleGenerateMoh() {
    const year = Number(to.slice(0, 4));
    const month = Number(to.slice(5, 7));
    const result = await run("generateReportRun", { reportCode, year, month, periodStart: from, periodEnd: to, today: todayIso() }, "MOH report generated") as unknown;
    void result;
  }
  async function handleRegenerateMoh() {
    if (!selectedRunId) return;
    await run("regenerateReportRun", { runId: selectedRunId, today: todayIso() }, "MOH report regenerated");
  }
  async function handleSubmitMoh() {
    if (!selectedRunId) return;
    await run("submitReportRun", { runId: selectedRunId }, "MOH report submitted");
  }
  async function handleVoidMoh() {
    if (!selectedRunId) return;
    const reason = window.prompt("Void reason");
    if (!reason?.trim()) return;
    await run("voidReportRun", { runId: selectedRunId, reason: reason.trim() }, "MOH report voided");
  }
  async function handleExportMoh(format: "csv" | "xlsx" | "pdf") {
    if (!selectedRunId) return;
    const ok = await run("exportReportRun", { runId: selectedRunId, format }, `MOH report exported as ${format.toUpperCase()}`);
    if (!ok) return;
    const url = `/api/reports?runId=${encodeURIComponent(selectedRunId)}&export=${format}`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    if (format !== "pdf") anchor.download = `${reportCode}-${selectedRun?.periodEnd ?? to}.${format}`;
    anchor.click();
  }

  return (
    <div className="space-y-6" data-testid="reports-workspace">
      {error ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {commandError ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{commandError}</div> : null}
      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="moh-hide-print">
          <CardHeader>
            <CardTitle>Report catalogue</CardTitle>
            <CardDescription>ERP and MOH statutory reports from posted source records.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="report-code">Report</label>
              <select id="report-code" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={reportCode} onChange={(e) => { setReportCode(e.target.value); setSelectedRunId(undefined); setMohDrill(null); }} data-testid="reports-select">
                {(data?.catalogue ?? []).map((item) => <option key={item.reportCode} value={item.reportCode}>{item.reportCode} — {item.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><label className="text-sm font-medium" htmlFor="report-from">From</label><Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="space-y-2"><label className="text-sm font-medium" htmlFor="report-to">To / As of</label><Input id="report-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); if (!from) setFrom(defaultFrom(e.target.value)); }} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void load()} disabled={loading || busy} data-testid="reports-refresh">Refresh</Button>
              {!moh && canWrite ? <Button variant="secondary" onClick={() => void handleGenerateErp()} disabled={busy || loading} data-testid="reports-generate">Generate snapshot</Button> : null}
              {!moh ? <Button variant="outline" onClick={() => void handleExportErp()} disabled={!report || busy} data-testid="reports-export-csv">Export CSV</Button> : null}
              {moh && canWrite ? <Button variant="secondary" onClick={() => void handleGenerateMoh()} disabled={busy || loading} data-testid="reports-generate-moh">Generate</Button> : null}
              {moh && canWrite ? <Button variant="outline" onClick={() => void handleRegenerateMoh()} disabled={busy || !selectedRunId}>Regenerate</Button> : null}
              {moh && canWrite ? <Button variant="outline" onClick={() => void handleSubmitMoh()} disabled={busy || !selectedRunId}>Submit</Button> : null}
              {moh && canWrite ? <Button variant="outline" onClick={() => void handleVoidMoh()} disabled={busy || !selectedRunId}>Void</Button> : null}
              {moh ? <Button variant="outline" onClick={() => void handleExportMoh("csv")} disabled={busy || !selectedRunId}>Export CSV</Button> : null}
              {moh ? <Button variant="outline" onClick={() => void handleExportMoh("xlsx")} disabled={busy || !selectedRunId}>Export XLSX</Button> : null}
              {moh ? <Button variant="outline" onClick={() => void handleExportMoh("pdf")} disabled={busy || !selectedRunId}>Print/PDF</Button> : null}
              {moh ? <Button variant="outline" onClick={() => window.print()} disabled={!selectedRunId || mohCells.length === 0}>Print sheet</Button> : null}
            </div>
            {!moh && canWrite ? (
              <div className="space-y-2 border-t pt-4">
                <label className="text-sm font-medium" htmlFor="report-view-name">Save view</label>
                <div className="flex gap-2">
                  <Input id="report-view-name" value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Month-end review" />
                  <Button variant="secondary" onClick={() => void handleSaveView()} disabled={busy || !viewName.trim()}>Save</Button>
                </div>
              </div>
            ) : null}
            {!moh ? (
              <div className="space-y-2 border-t pt-4">
                <div className="text-sm font-medium">Saved views</div>
                <div className="space-y-2">
                  {(data?.savedViews ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No saved views yet.</p> : null}
                  {(data?.savedViews ?? []).map((view) => (
                    <button key={view.id} type="button" className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => { setReportCode(view.reportCode); const f = view.filters as Record<string, string>; if (typeof f.from === "string") setFrom(f.from); if (typeof f.to === "string") setTo(f.to); if (typeof f.asOf === "string" && !f.to) setTo(f.asOf); }}>
                      <div className="font-medium">{view.name}</div>
                      <div className="text-xs text-muted-foreground">{view.reportCode}{view.shared ? " • shared" : ""}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2 border-t pt-4">
                <div className="text-sm font-medium">MOH runs</div>
                <div className="space-y-2 max-h-72 overflow-auto">
                  {mohRuns.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
                  {mohRuns.map((r) => (
                    <button key={r.id} type="button" className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40 ${selectedRunId === r.id ? "border-primary bg-muted/30" : ""}`} onClick={() => setSelectedRunId(r.id)}>
                      <div className="font-medium">{r.periodStart} → {r.periodEnd}</div>
                      <div className="text-xs text-muted-foreground">{r.status} • {r.rowCount ?? 0} cells{r.checksum ? ` • ${r.checksum.slice(0, 8)}` : ""}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="moh-hide-print">
              <CardTitle>{moh ? (data?.catalogue?.find((c) => c.reportCode === reportCode)?.name ?? reportCode) : (report?.name ?? "Report")}</CardTitle>
              <CardDescription>
                {moh ? (selectedRun ? `${selectedRun.periodStart} to ${selectedRun.periodEnd} • ${selectedRun.status}${selectedRun.checksum ? ` • checksum ${selectedRun.checksum.slice(0, 12)}` : ""}` : "Generate or select a MOH run.") : (report ? `${report.from} to ${report.to} • ${report.reconciled ? "Reconciled" : "Needs review"}` : "Select a report to load data.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? <p className="text-sm text-muted-foreground">Loading report…</p> : null}
              {!loading && !moh && report ? (
                <div className="space-y-4">
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">{report.reconciliationNote}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="reports-table">
                      <thead><tr className="border-b text-left">{report.columns.map((column) => <th key={column.key} className={`px-2 py-2 font-medium ${column.align === "right" ? "text-right" : ""}`}>{column.label}</th>)}<th className="px-2 py-2 font-medium">Drill-down</th></tr></thead>
                      <tbody>
                        {report.rows.map((row) => (
                          <tr key={row.key} className="border-b last:border-0">
                            {report.columns.map((column) => <td key={column.key} className={`px-2 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""}`}>{String(row.values[column.key] ?? "")}</td>)}
                            <td className="px-2 py-2">{row.drillDown ? <Button variant="ghost" size="sm" onClick={() => { setSourceType(row.drillDown?.sourceType); setSourceId(row.drillDown?.sourceId); }}>View</Button> : <span className="text-muted-foreground">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr className="border-t font-medium">{report.columns.map((column) => <td key={column.key} className={`px-2 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""}`}>{String(report.totals[column.key] ?? "")}</td>)}<td className="px-2 py-2" /></tr></tfoot>
                    </table>
                  </div>
                </div>
              ) : null}
              {!loading && moh ? (
                <div className="space-y-4">
                  <MohStatutorySheet
                    meta={mohMeta}
                    run={selectedRun}
                    cells={mohCells}
                    onDrill={async (rowCode, colKey) => {
                      if (!selectedRunId) return;
                      const res = await fetch(`/api/reports?runId=${encodeURIComponent(selectedRunId)}&drillRowCode=${encodeURIComponent(rowCode)}&drillColKey=${encodeURIComponent(colKey)}`, { cache: "no-store" });
                      const payload = await res.json().catch(() => null);
                      setMohDrill({ rowCode, colKey, data: payload?.cell ?? payload });
                    }}
                  />
                  {mohDrill ? (
                    <div className="moh-hide-print rounded-md border bg-muted/10 p-3 text-xs space-y-2">
                      <div className="flex items-center justify-between"><div className="font-medium">Source drill-down: {mohDrill.rowCode} / {mohDrill.colKey}</div><Button size="sm" variant="ghost" onClick={() => setMohDrill(null)}>Close</Button></div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(mohDrill.data, null, 2)}</pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="moh-hide-print grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Approval inbox</CardTitle><CardDescription>Pending approvals across finance, procurement, payroll and assets.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                {(data?.approvalInbox ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No pending approvals.</p> : null}
                {(data?.approvalInbox ?? []).slice(0, 12).map((item) => (
                  <div key={`${item.kind}-${item.id}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div><div className="font-medium">{item.kind} • {item.documentNo}</div><div className="text-muted-foreground">{item.requester} • {item.ageDays}d • {item.status}</div></div>
                    <div className="text-right"><div className="tabular-nums">{formatMoney(item.amount)}</div><a className="text-xs text-primary underline-offset-4 hover:underline" href={item.href}>Open</a></div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>{moh ? "Run audit trail" : "Drill-down"}</CardTitle><CardDescription>{moh ? (selectedRun ? `Audit trail for ${selectedRun.id.slice(0, 8)}` : "Select a MOH run to see audit trail.") : (drillDown ? `${drillDown.sourceType}:${drillDown.sourceId}` : "Select a row drill-down to inspect journals and audit trail.")}</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                {moh ? (
                  <div className="max-h-64 overflow-auto rounded-md border">
                    <table className="w-full text-xs"><thead><tr className="border-b text-left"><th className="px-2 py-1">When</th><th className="px-2 py-1">Action</th><th className="px-2 py-1">Entity</th></tr></thead>
                      <tbody>
                        {(data?.mohAuditTrail ?? []).map((row) => (
                          <tr key={row.id} className="border-b last:border-0"><td className="px-2 py-1">{new Date(row.createdAt).toLocaleString()}</td><td className="px-2 py-1">{row.action}</td><td className="px-2 py-1">{row.entity}</td></tr>
                        ))}
                        {selectedRunId && (data?.mohAuditTrail ?? []).length === 0 ? <tr><td className="px-2 py-3 text-muted-foreground" colSpan={3}>No audit rows.</td></tr> : null}
                      </tbody>
                    </table>
                  </div>
                ) : drillDown ? (
                  <>
                    <div className="text-sm text-muted-foreground">Entries: {drillDown.entryCount} • Debits {formatMoney(drillDown.debit)} • Credits {formatMoney(drillDown.credit)}</div>
                    <div className="max-h-64 overflow-auto rounded-md border"><table className="w-full text-xs"><thead><tr className="border-b text-left"><th className="px-2 py-1">Entry</th><th className="px-2 py-1">Account</th><th className="px-2 py-1 text-right">Debit</th><th className="px-2 py-1 text-right">Credit</th></tr></thead><tbody>{drillDown.journalRows.map((row) => (<tr key={row.id} className="border-b last:border-0"><td className="px-2 py-1">{row.entryNo ?? ""}</td><td className="px-2 py-1">{row.accountCode} {row.accountName}</td><td className="px-2 py-1 text-right tabular-nums">{formatMoney(row.debit)}</td><td className="px-2 py-1 text-right tabular-nums">{formatMoney(row.credit)}</td></tr>))}</tbody></table></div>
                    <Button variant="outline" size="sm" onClick={() => { setSourceType(undefined); setSourceId(undefined); }}>Clear drill-down</Button>
                  </>
                ) : <p className="text-sm text-muted-foreground">No drill-down selected.</p>}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
