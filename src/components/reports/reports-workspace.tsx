"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { reportDataToCsv, type ErpReportFilters } from "@/lib/erp-reporting";
import type { ErpReportCode } from "@/lib/reporting";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney, type ReportsApiData } from "@/components/reports/reports-types";
import { useReportsCommand } from "@/components/reports/use-reports-command";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function defaultFrom(to: string) {
  return `${to.slice(0, 4)}-01-01`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ReportsWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<ReportsApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportCode, setReportCode] = useState<ErpReportCode>("ERP_TRIAL_BALANCE");
  const [to, setTo] = useState(todayIso());
  const [from, setFrom] = useState(defaultFrom(todayIso()));
  const [sourceType, setSourceType] = useState<string | undefined>();
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [viewName, setViewName] = useState("");

  const filters = useMemo<ErpReportFilters>(() => ({ from, to, asOf: to }), [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("reportCode", reportCode);
      params.set("from", from);
      params.set("to", to);
      params.set("asOf", to);
      if (sourceType && sourceId) {
        params.set("sourceType", sourceType);
        params.set("sourceId", sourceId);
      }
      const response = await fetch(`/api/reports?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        window.location.href = "/";
        return;
      }
      const payload = (await response.json().catch(() => null)) as ReportsApiData | { error?: string } | null;
      if (!response.ok) throw new Error((payload as { error?: string } | null)?.error ?? "Failed to load reports");
      setData(payload as ReportsApiData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [from, reportCode, sourceId, sourceType, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const { busy, error: commandError, run } = useReportsCommand(load);

  const report = data?.reportData;
  const drillDown = data?.drillDown;

  async function handleGenerate() {
    await run("generateErpReport", { reportCode, filters }, "Report generated");
  }

  async function handleSaveView() {
    if (!viewName.trim()) return;
    const ok = await run(
      "saveReportView",
      { reportCode, name: viewName.trim(), shared: false, filters },
      "Report view saved",
    );
    if (ok) setViewName("");
  }

  async function handleExport() {
    if (!report) return;
    const csv = reportDataToCsv(report);
    downloadCsv(`${report.reportCode}-${report.to}.csv`, csv);
    const generated = await run("generateErpReport", { reportCode, filters }, "Report snapshot recorded");
    if (generated) {
      // The latest generated run is recorded; export marking is best-effort after download.
      await load();
    }
  }

  return (
    <div className="space-y-6" data-testid="reports-workspace">
      {error ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {commandError ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{commandError}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Report catalogue</CardTitle>
            <CardDescription>ERP management reports generated from posted source records.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="report-code">Report</label>
              <select
                id="report-code"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={reportCode}
                onChange={(e) => setReportCode(e.target.value as ErpReportCode)}
                data-testid="reports-select"
              >
                {(data?.catalogue ?? []).map((item) => (
                  <option key={item.reportCode} value={item.reportCode}>{item.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="report-from">From</label>
                <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="report-to">To / As of</label>
                <Input id="report-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); if (!from) setFrom(defaultFrom(e.target.value)); }} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void load()} disabled={loading || busy} data-testid="reports-refresh">Refresh</Button>
              {canWrite ? <Button variant="secondary" onClick={() => void handleGenerate()} disabled={busy || loading} data-testid="reports-generate">Generate snapshot</Button> : null}
              <Button variant="outline" onClick={() => void handleExport()} disabled={!report || busy} data-testid="reports-export-csv">Export CSV</Button>
            </div>
            {canWrite ? (
              <div className="space-y-2 border-t pt-4">
                <label className="text-sm font-medium" htmlFor="report-view-name">Save view</label>
                <div className="flex gap-2">
                  <Input id="report-view-name" value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Month-end review" />
                  <Button variant="secondary" onClick={() => void handleSaveView()} disabled={busy || !viewName.trim()}>Save</Button>
                </div>
              </div>
            ) : null}
            <div className="space-y-2 border-t pt-4">
              <div className="text-sm font-medium">Saved views</div>
              <div className="space-y-2">
                {(data?.savedViews ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No saved views yet.</p> : null}
                {(data?.savedViews ?? []).map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40"
                    onClick={() => {
                      setReportCode(view.reportCode as ErpReportCode);
                      const f = view.filters as Record<string, string>;
                      if (typeof f.from === "string") setFrom(f.from);
                      if (typeof f.to === "string") setTo(f.to);
                      if (typeof f.asOf === "string" && !f.to) setTo(f.asOf);
                    }}
                  >
                    <div className="font-medium">{view.name}</div>
                    <div className="text-xs text-muted-foreground">{view.reportCode}{view.shared ? " · shared" : ""}</div>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{report?.name ?? "Report"}</CardTitle>
              <CardDescription>
                {report ? `${report.from} to ${report.to} · ${report.reconciled ? "Reconciled" : "Needs review"}` : "Select a report to load data."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? <p className="text-sm text-muted-foreground">Loading report…</p> : null}
              {!loading && report ? (
                <div className="space-y-4">
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">{report.reconciliationNote}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="reports-table">
                      <thead>
                        <tr className="border-b text-left">
                          {report.columns.map((column) => (
                            <th key={column.key} className={`px-2 py-2 font-medium ${column.align === "right" ? "text-right" : ""}`}>{column.label}</th>
                          ))}
                          <th className="px-2 py-2 font-medium">Drill-down</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.rows.map((row) => (
                          <tr key={row.key} className="border-b last:border-0">
                            {report.columns.map((column) => (
                              <td key={column.key} className={`px-2 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""}`}>
                                {String(row.values[column.key] ?? "")}
                              </td>
                            ))}
                            <td className="px-2 py-2">
                              {row.drillDown ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setSourceType(row.drillDown?.sourceType);
                                    setSourceId(row.drillDown?.sourceId);
                                  }}
                                >
                                  View
                                </Button>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-medium">
                          {report.columns.map((column) => (
                            <td key={column.key} className={`px-2 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""}`}>
                              {String(report.totals[column.key] ?? "")}
                            </td>
                          ))}
                          <td className="px-2 py-2" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Approval inbox</CardTitle>
                <CardDescription>Pending approvals across finance, procurement, payroll and assets.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(data?.approvalInbox ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No pending approvals.</p> : null}
                {(data?.approvalInbox ?? []).slice(0, 12).map((item) => (
                  <div key={`${item.kind}-${item.id}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium">{item.kind} · {item.documentNo}</div>
                      <div className="text-muted-foreground">{item.requester} · {item.ageDays}d · {item.status}</div>
                    </div>
                    <div className="text-right">
                      <div className="tabular-nums">{formatMoney(item.amount)}</div>
                      <a className="text-xs text-primary underline-offset-4 hover:underline" href={item.href}>Open</a>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Drill-down</CardTitle>
                <CardDescription>
                  {drillDown ? `${drillDown.sourceType}:${drillDown.sourceId}` : "Select a row drill-down to inspect journals and audit trail."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {drillDown ? (
                  <>
                    <div className="text-sm text-muted-foreground">
                      Entries: {drillDown.entryCount} · Debits {formatMoney(drillDown.debit)} · Credits {formatMoney(drillDown.credit)}
                    </div>
                    <div className="max-h-64 overflow-auto rounded-md border">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b text-left"><th className="px-2 py-1">Entry</th><th className="px-2 py-1">Account</th><th className="px-2 py-1 text-right">Debit</th><th className="px-2 py-1 text-right">Credit</th></tr></thead>
                        <tbody>
                          {drillDown.journalRows.map((row) => (
                            <tr key={row.id} className="border-b last:border-0">
                              <td className="px-2 py-1">{row.entryNo ?? ""}</td>
                              <td className="px-2 py-1">{row.accountCode} {row.accountName}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{formatMoney(row.debit)}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{formatMoney(row.credit)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="max-h-40 overflow-auto rounded-md border">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b text-left"><th className="px-2 py-1">When</th><th className="px-2 py-1">Action</th><th className="px-2 py-1">Entity</th></tr></thead>
                        <tbody>
                          {drillDown.auditRows.map((row) => (
                            <tr key={row.id} className="border-b last:border-0">
                              <td className="px-2 py-1">{new Date(row.createdAt).toLocaleString()}</td>
                              <td className="px-2 py-1">{row.action}</td>
                              <td className="px-2 py-1">{row.entity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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
