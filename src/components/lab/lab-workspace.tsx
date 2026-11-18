"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  Search,
  ShieldCheck,
  TestTube2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LAB_RESULT_FLAG_LABELS } from "@/lib/clinical";
import {
  LAB_ORDER_STATUS_LABELS,
  LAB_WORKLIST_FILTERS,
  LAB_WORKLIST_FILTER_LABELS,
  canCollectLabOrder,
  canEnterLabResults,
  canStartLabProcessing,
  canVerifyLabResults,
  evaluateLabFlag,
  formatRefRange,
  isCriticalLabFlag,
  isNumericParameter,
  slugifyParameter,
  type LabFlag,
  type LabWorklistFilter,
} from "@/lib/lab";
import { ageFromDob } from "@/lib/triage";
import type { LabTestOption } from "@/server/queries/clinical";
import type { LabWorklistItem, LabWorklistOrder } from "@/server/queries/lab";
import { cn } from "cn";

const STATUS_STYLES: Record<string, string> = {
  ordered: "border-border bg-secondary text-secondary-foreground",
  collected: "border-border bg-secondary text-secondary-foreground",
  in_progress:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  resulted: "border-border bg-secondary text-secondary-foreground",
  verified:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  cancelled: "border-border bg-muted text-muted-foreground",
};

const FLAG_STYLES: Record<string, string> = {
  N: "border-border bg-muted text-muted-foreground",
  H: "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  L: "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  HH: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  LL: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
};

const CARD_CLASS = "rounded-lg border border-border bg-card";
const SECTION_TITLE_CLASS = "text-sm font-semibold";

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "lab-station" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
      detail?: string;
      issues?: Array<{ message?: string }>;
    } | null;
    const message =
      detail?.issues?.[0]?.message ??
      detail?.detail ??
      detail?.error ??
      `Request failed (${response.status})`;
    if (response.status === 401 || response.status === 403) {
      throw new SessionMismatchError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function handleSessionMismatch(error: unknown): Promise<boolean> {
  if (!(error instanceof SessionMismatchError)) return false;
  toast.error("Your session changed. Returning to your workspace.");
  window.location.assign("/");
  return true;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function patientAge(dob: string | null): string {
  const age = ageFromDob(dob);
  return age == null ? "Age unknown" : `${age} yrs`;
}

function draftKey(itemId: string, parameter: string): string {
  return `${itemId}:${parameter}`;
}

function draftsFromOrder(order: LabWorklistOrder): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const item of order.items) {
    for (const parameter of item.parameters) {
      const result = item.results.find((row) => row.parameter === parameter.name);
      drafts[draftKey(item.id, parameter.name)] = result?.value ?? "";
    }
  }
  return drafts;
}

function previewFlag(parameter: LabWorklistItem["parameters"][number], value: string): LabFlag | null {
  if (!value.trim()) return null;
  try {
    return evaluateLabFlag(value, parameter);
  } catch {
    return null;
  }
}

function itemProgress(item: LabWorklistItem): { done: number; total: number } {
  const done = item.parameters.filter((parameter) =>
    item.results.some((result) => result.parameter === parameter.name && result.value.trim() !== ""),
  ).length;
  return { done, total: item.parameters.length };
}

export function LabWorkspace() {
  const [filter, setFilter] = useState<LabWorklistFilter>("pending");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [orders, setOrders] = useState<LabWorklistOrder[]>([]);
  const [catalog, setCatalog] = useState<LabTestOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The panel keeps the last known copy of the selected order. A refresh can
  // legitimately return a list without it (a verification moves the order from
  // "pending" to "verified"), and dropping the panel mid-action is jarring.
  const [selectedSnapshot, setSelectedSnapshot] = useState<LabWorklistOrder | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const keysRef = useRef<Record<string, string>>({});

  const selected =
    (selectedId ? orders.find((order) => order.id === selectedId) : undefined) ??
    (selectedId ? selectedSnapshot : null);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  function setDirtyValue(value: boolean): void {
    dirtyRef.current = value;
    setDirty(value);
  }

  function keyFor(scope: string): string {
    if (!keysRef.current[scope]) keysRef.current[scope] = crypto.randomUUID();
    return keysRef.current[scope];
  }

  function clearKey(scope: string): void {
    delete keysRef.current[scope];
  }

  const loadWorklist = useCallback(async (filterOverride?: LabWorklistFilter) => {
    const activeFilter = filterOverride ?? filter;
    try {
      const params = new URLSearchParams({ filter: activeFilter });
      const term = debouncedSearch.trim();
      if (term) params.set("q", term);
      const response = await fetch(`/api/lab/worklist?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { orders: LabWorklistOrder[] };
      setOrders(data.orders);

      const current = selectedRef.current;
      if (current) {
        const order = data.orders.find((row) => row.id === current);
        if (order) {
          setSelectedSnapshot(order);
          if (!dirtyRef.current) setDrafts(draftsFromOrder(order));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void loadWorklist();
    const interval = setInterval(() => void loadWorklist(), 30_000);
    const source = new EventSource("/api/events");
    const onLab = () => void loadWorklist();
    const events = [
      "lab_order_created",
      "lab_order_cancelled",
      "lab_sample_collected",
      "lab_processing_started",
      "lab_results_entered",
      "lab_results_verified",
      "queue_changed",
      "encounter_closed",
    ];
    for (const event of events) source.addEventListener(event, onLab);
    return () => {
      clearInterval(interval);
      for (const event of events) source.removeEventListener(event, onLab);
      source.close();
    };
  }, [loadWorklist]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/lab/catalog", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { tests: LabTestOption[] };
        setCatalog(data.tests);
      } catch {
        // Catalogue failure is non-fatal: the screen still works.
      }
    })();
  }, []);

  function selectOrder(order: LabWorklistOrder): void {
    setSelectedId(order.id);
    selectedRef.current = order.id;
    setSelectedSnapshot(order);
    setDrafts(draftsFromOrder(order));
    setDirtyValue(false);
  }

  async function runAction(
    label: string,
    scope: string,
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(label);
    try {
      await action();
      clearKey(scope);
      toast.success(successMessage);
      setDirtyValue(false);
      await loadWorklist();
      return true;
    } catch (error) {
      if (await handleSessionMismatch(error)) return false;
      toast.error(error instanceof Error ? error.message : "The request could not be completed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function collectSample(order: LabWorklistOrder): Promise<void> {
    const scope = `collect:${order.id}`;
    await runAction(
      scope,
      scope,
      () =>
        postJson("/api/lab/collect", {
          labOrderId: order.id,
          idempotencyKey: keyFor(scope),
        }),
      "Sample collected and labelled",
    );
  }

  async function startProcessing(order: LabWorklistOrder): Promise<void> {
    const scope = `start:${order.id}`;
    await runAction(
      scope,
      scope,
      () =>
        postJson("/api/lab/start", {
          labOrderId: order.id,
          idempotencyKey: keyFor(scope),
        }),
      "Processing started",
    );
  }

  async function saveResults(order: LabWorklistOrder): Promise<void> {
    const results: Array<{ labOrderItemId: string; parameter: string; value: string }> = [];
    for (const item of order.items) {
      for (const parameter of item.parameters) {
        const value = (drafts[draftKey(item.id, parameter.name)] ?? "").trim();
        if (!value) continue;
        try {
          evaluateLabFlag(value, parameter);
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : `${parameter.name} has an invalid value`,
          );
          return;
        }
        results.push({ labOrderItemId: item.id, parameter: parameter.name, value });
      }
    }

    if (results.length === 0) {
      toast.error("Enter at least one result before saving");
      return;
    }

    const scope = `results:${order.id}`;
    const saved = await runAction(
      scope,
      scope,
      () =>
        postJson<{ status: string }>("/api/lab/results", {
          labOrderId: order.id,
          results,
          idempotencyKey: keyFor(scope),
        }).then((response) => {
          if (response.status === "resulted") {
            toast.success("All results entered — ready for verification");
          }
          return response;
        }),
      "Results saved",
    );
    if (saved) setDirtyValue(false);
  }

  async function verifyResults(order: LabWorklistOrder): Promise<void> {
    const scope = `verify:${order.id}`;
    setBusy(scope);
    try {
      await postJson("/api/lab/verify", {
        labOrderId: order.id,
        idempotencyKey: keyFor(scope),
      });
      clearKey(scope);
      setDirtyValue(false);
      toast.success("Results verified and released to the doctor");
      setFilter("verified");
      // Load the verified list explicitly: the closure still holds the old
      // filter, which would drop the just-verified order from the selection.
      await loadWorklist("verified");
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not verify the results");
    } finally {
      setBusy(null);
    }
  }

  const selectedBusy = (scope: string) => busy === scope;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <aside className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className={SECTION_TITLE_CLASS}>Worklist</h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="lab-refresh"
              onClick={() => void loadWorklist()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>

          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              data-testid="lab-search"
              aria-label="Search the laboratory worklist"
              placeholder="MRN, name, visit or sample"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-7"
            />
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Worklist filter">
            {LAB_WORKLIST_FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                size="xs"
                variant={filter === value ? "default" : "outline"}
                data-testid={`lab-filter-${value}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {LAB_WORKLIST_FILTER_LABELS[value]}
              </Button>
            ))}
          </div>

          <div data-testid="lab-worklist" className="space-y-2">
            {loading ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                Loading the worklist…
              </p>
            ) : orders.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                No {LAB_WORKLIST_FILTER_LABELS[filter].toLowerCase()} laboratory orders.
              </p>
            ) : (
              orders.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  data-testid={`lab-order-${order.id}`}
                  onClick={() => selectOrder(order)}
                  aria-pressed={selectedId === order.id}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                    selectedId === order.id
                      ? "border-primary bg-secondary/50"
                      : "border-border bg-card hover:bg-secondary/30",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {order.firstName} {order.lastName}
                    </span>
                    <Badge variant="outline" className={STATUS_STYLES[order.status]}>
                      {LAB_ORDER_STATUS_LABELS[order.status] ?? order.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {order.mrn} · {order.encounterNo}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {order.items.map((item) => item.testName).join(", ")}
                  </p>
                  {order.sampleId ? (
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {order.sampleId}
                    </p>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="min-w-0">
          {selected ? (
            <div className="space-y-4">
              <div
                data-testid="lab-patient-banner"
                className={cn(CARD_CLASS, "px-4 py-3")}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <UserRound aria-hidden="true" className="size-4 text-primary" />
                      <p className="truncate text-base font-semibold">
                        {selected.firstName} {selected.lastName}
                      </p>
                      <Badge variant="outline" data-testid="lab-status" className={STATUS_STYLES[selected.status]}>
                        {LAB_ORDER_STATUS_LABELS[selected.status] ?? selected.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected.mrn} · {selected.sex} · {patientAge(selected.dob)} ·{" "}
                      {selected.encounterNo}
                    </p>
                    {selected.sampleId ? (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        Sample {selected.sampleId} · collected {formatDateTime(selected.collectedAt)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canCollectLabOrder(selected.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        data-testid="lab-collect"
                        disabled={selectedBusy(`collect:${selected.id}`)}
                        onClick={() => void collectSample(selected)}
                      >
                        <TestTube2 aria-hidden="true" />
                        Collect sample
                      </Button>
                    ) : null}
                    {canStartLabProcessing(selected.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="lab-start"
                        disabled={selectedBusy(`start:${selected.id}`)}
                        onClick={() => void startProcessing(selected)}
                      >
                        <FlaskConical aria-hidden="true" />
                        Start processing
                      </Button>
                    ) : null}
                    {canVerifyLabResults(selected.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        data-testid="lab-verify"
                        disabled={selectedBusy(`verify:${selected.id}`)}
                        onClick={() => void verifyResults(selected)}
                      >
                        <ShieldCheck aria-hidden="true" />
                        Verify results
                      </Button>
                    ) : null}
                  </div>
                </div>

                {selected.allergies.length > 0 ? (
                  <p className="mt-3 flex items-center gap-1.5 rounded-md border border-[var(--status-warning)] bg-[var(--status-warning-background)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning-foreground)]">
                    <AlertTriangle aria-hidden="true" className="size-3.5" />
                    Allergies: {selected.allergies.join(", ")}
                  </p>
                ) : null}

                {selected.clinicalNotes ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Clinical notes: {selected.clinicalNotes}
                  </p>
                ) : null}
              </div>

              {selected.status === "verified" ? (
                <p className="flex items-center gap-1.5 rounded-md border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-3 py-2 text-xs text-[var(--status-normal-foreground)]">
                  <CheckCircle2 aria-hidden="true" className="size-3.5" />
                  Verified results are locked and visible to the doctor.
                </p>
              ) : null}

              {selected.items.map((item) => {
                const progress = itemProgress(item);
                const readOnly = selected.status === "verified" || selected.status === "cancelled";
                return (
                  <div key={item.id} data-testid={`lab-item-${item.id}`} className={CARD_CLASS}>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                      <div>
                        <p className="text-sm font-medium">
                          {item.testName}{" "}
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {item.testCode}
                          </span>
                        </p>
                        <p className="text-[11px] text-muted-foreground">{item.sampleType}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {progress.done}/{progress.total} parameters
                        </span>
                        <Badge variant="outline" className={STATUS_STYLES[item.status]}>
                          {LAB_ORDER_STATUS_LABELS[item.status] ?? item.status}
                        </Badge>
                      </div>
                    </div>

                    <ul className="divide-y divide-border">
                      {item.parameters.map((parameter) => {
                        const key = draftKey(item.id, parameter.name);
                        const result = item.results.find(
                          (row) => row.parameter === parameter.name,
                        );
                        const value = readOnly
                          ? (result?.value ?? "")
                          : (drafts[key] ?? "");
                        const flag = readOnly
                          ? ((result?.flag as LabFlag | undefined) ?? null)
                          : previewFlag(parameter, value);
                        return (
                          <li
                            key={parameter.name}
                            className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_7rem_9rem]"
                          >
                            <label
                              htmlFor={`${item.id}-${slugifyParameter(parameter.name)}`}
                              className="text-xs"
                            >
                              <span className="font-medium">{parameter.name}</span>
                              <span className="ml-1 text-[11px] text-muted-foreground">
                                {parameter.unit || "—"}
                                {formatRefRange(parameter)
                                  ? ` · ref ${formatRefRange(parameter)}`
                                  : ""}
                              </span>
                            </label>
                            {readOnly ? (
                              <p className="text-sm font-medium tabular-nums">
                                {value || "—"}
                              </p>
                            ) : (
                              <Input
                                id={`${item.id}-${slugifyParameter(parameter.name)}`}
                                data-testid={`lab-result-input-${item.id}-${slugifyParameter(parameter.name)}`}
                                aria-label={`${parameter.name} for ${item.testName}`}
                                inputMode={isNumericParameter(parameter) ? "decimal" : "text"}
                                value={value}
                                onChange={(event) => {
                                  setDrafts((current) => ({
                                    ...current,
                                    [key]: event.target.value,
                                  }));
                                  setDirtyValue(true);
                                }}
                                disabled={!canEnterLabResults(selected.status)}
                                placeholder={
                                  isNumericParameter(parameter) ? "Numeric" : "Text"
                                }
                              />
                            )}
                            <div className="flex items-center gap-1.5 sm:justify-end">
                              {flag ? (
                                <Badge variant="outline" className={FLAG_STYLES[flag]}>
                                  {LAB_RESULT_FLAG_LABELS[flag] ?? flag}
                                </Badge>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">
                                  {isCriticalLabFlag(result?.flag) ? "Critical" : ""}
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}

              {canEnterLabResults(selected.status) && !selectedBusy("verify") ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    {dirty
                      ? "Unsaved changes — corrections are allowed until verification."
                      : "Values auto-flag against the reference range. Save partial results at any time."}
                  </p>
                  <Button
                    type="button"
                    data-testid="lab-save-results"
                    disabled={selectedBusy(`results:${selected.id}`)}
                    onClick={() => void saveResults(selected)}
                  >
                    <FlaskConical aria-hidden="true" />
                    Save results
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid h-full min-h-64 place-items-center rounded-lg border border-dashed border-border px-6 py-12 text-center">
              <div>
                <FlaskConical aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">Select an order from the worklist</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Collect the sample, enter each parameter and verify the results.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      <section data-testid="lab-catalog" className={cn(CARD_CLASS, "px-4 py-3")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className={SECTION_TITLE_CLASS}>Test catalogue</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Available tests and their reference parameters. Catalogue changes are managed in
              Administration.
            </p>
          </div>
          <Badge variant="outline">{catalog.length} tests</Badge>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {catalog.map((test) => (
            <div key={test.id} className="rounded-md border border-border px-3 py-2">
              <p className="text-xs font-medium">
                {test.name}{" "}
                <span className="font-mono text-[10px] text-muted-foreground">{test.code}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">{test.sampleType}</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {test.parameters.map((parameter) => (
                  <li key={parameter.name} className="text-[10px] text-muted-foreground">
                    {parameter.name}
                    {parameter.unit ? ` (${parameter.unit})` : ""}
                    {formatRefRange(parameter) ? ` · ${formatRefRange(parameter)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {catalog.length === 0 ? (
            <p className="text-xs text-muted-foreground">No laboratory tests are configured.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
