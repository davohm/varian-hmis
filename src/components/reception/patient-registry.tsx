"use client";

import {
  AlertCircle,
  Loader2,
  RefreshCw,
  Search,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface RegistryPatient {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  createdAt: string;
}

interface RegistryPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface RegistryResponse {
  patients: RegistryPatient[];
  pagination: RegistryPagination;
}

interface PatientRegistryProps {
  initialPatients: RegistryPatient[];
  initialTotal: number;
  initialPageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const QUERY_DEBOUNCE_MS = 300;
type LoadState = "ready" | "loading" | "refreshing" | "error";

function initials(patient: RegistryPatient): string {
  return `${patient.firstName[0] ?? ""}${patient.lastName[0] ?? ""}`.toUpperCase();
}

function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const years = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? `${years}y` : null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function PatientRegistry({
  initialPatients,
  initialTotal,
  initialPageSize = DEFAULT_PAGE_SIZE,
}: PatientRegistryProps) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [response, setResponse] = useState<RegistryResponse>({
    patients: initialPatients,
    pagination: {
      page: 1,
      pageSize: initialPageSize,
      total: initialTotal,
      totalPages: Math.max(1, Math.ceil(initialTotal / initialPageSize)),
    },
  });
  const [state, setState] = useState<LoadState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const skipFirstLoadRef = useRef(true);
  const hasRowsRef = useRef(initialPatients.length > 0);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = queryInput.trim();
      setQuery((current) => {
        if (current === next) return current;
        setPage(1);
        return next;
      });
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryInput]);

  const load = useCallback(
    async (term: string, nextPage: number, nextPageSize: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestIdRef.current;

      setError(null);
      setState(hasRowsRef.current ? "refreshing" : "loading");

      try {
        const params = new URLSearchParams({
          q: term,
          page: String(nextPage),
          pageSize: String(nextPageSize),
        });
        const result = await fetch(`/api/patients/registry?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!result.ok) throw new Error(`Could not load patients (${result.status})`);
        const data = (await result.json()) as RegistryResponse;
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setResponse(data);
        hasRowsRef.current = data.patients.length > 0;
        setState("ready");
        if (data.pagination.page !== nextPage) setPage(data.pagination.page);
      } catch (caught) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setError(caught instanceof Error ? caught.message : "Could not load patients");
        setState("error");
      }
    },
    [],
  );

  useEffect(() => {
    if (skipFirstLoadRef.current) {
      skipFirstLoadRef.current = false;
      if (query === "" && page === 1 && pageSize === initialPageSize) return;
    }
    void load(query, page, pageSize);
  }, [load, query, page, pageSize, retryToken, initialPageSize]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const total = response.pagination.total;
  const from = total === 0 ? 0 : (response.pagination.page - 1) * response.pagination.pageSize + 1;
  const to = Math.min(response.pagination.page * response.pagination.pageSize, total);
  const hasQuery = query.length > 0;
  const isBusy = state === "loading" || state === "refreshing";
  const showTable = response.patients.length > 0;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-border/80 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">Patient registry</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              {state === "loading"
                ? "Loading records…"
                : total === 0
                  ? hasQuery
                    ? `No records match “${query}”`
                    : "No patients registered yet"
                  : `Showing ${from}–${to} of ${total} record${total === 1 ? "" : "s"}${
                      hasQuery ? ` for “${query}”` : ", most recent first"
                    }`}
              {state === "refreshing" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh registry"
              onClick={() => setRetryToken((token) => token + 1)}
              disabled={isBusy}
            >
              <RefreshCw aria-hidden="true" className={cn(state === "refreshing" && "animate-spin")} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/reception/register" />}
            >
              <UserPlus aria-hidden="true" />
              Register patient
            </Button>
          </div>
        </div>

        <div className="relative mt-4">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="h-10 pr-10 pl-10"
            placeholder="Filter by name, MRN, phone, or national ID"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            aria-label="Filter patient registry"
            maxLength={100}
            autoComplete="off"
            style={{}}
          />
          {queryInput ? (
            <button
              type="button"
              className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setQueryInput("");
                setQuery("");
                setPage(1);
              }}
              aria-label="Clear filter"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {state === "error" && showTable ? (
        <div className="border-b border-[var(--status-critical)]/20 bg-[var(--status-critical-background)]/35 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="size-4 text-[var(--status-critical)]" aria-hidden="true" />
              Could not refresh the registry{error ? ` — ${error}` : ""}. Showing the last loaded page.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetryToken((token) => token + 1)}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {state === "loading" && !showTable ? (
        <div className="space-y-2 p-5" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
          <span className="sr-only">Loading patients</span>
        </div>
      ) : state === "error" && !showTable ? (
        <div className="p-5">
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-lg border border-[var(--status-critical)]/20 bg-[var(--status-critical-background)]/40 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0 text-[var(--status-critical)]"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-foreground">Could not load the registry</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetryToken((token) => token + 1)}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : total === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Users}
            title={hasQuery ? "No matching patients" : "No patients registered yet"}
            description={
              hasQuery
                ? `Nothing matches “${query}”. Check the spelling, MRN or phone number, or search a different term.`
                : "Patients appear here as soon as reception registers them."
            }
            action={
              hasQuery ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setQueryInput("")}>
                  Clear search
                </Button>
              ) : (
                <Button size="sm" nativeButton={false} render={<Link href="/reception/register" />}>
                  <UserPlus aria-hidden="true" />
                  Register patient
                </Button>
              )
            }
          />
        </div>
      ) : (
        <>
          <div
            className={cn(
              "overflow-x-auto transition-opacity",
              state === "refreshing" && "opacity-60",
            )}
            aria-busy={isBusy}
          >
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs tracking-wide text-muted-foreground uppercase">
                  <th className="px-5 py-3 font-medium">Patient</th>
                  <th className="px-5 py-3 font-medium">MRN</th>
                  <th className="px-5 py-3 font-medium">Sex</th>
                  <th className="px-5 py-3 font-medium">Age / DOB</th>
                  <th className="px-5 py-3 font-medium">Phone</th>
                  <th className="px-5 py-3 font-medium">Registered</th>
                </tr>
              </thead>
              <tbody>
                {response.patients.map((patient) => (
                  <tr
                    key={patient.id}
                    className="border-b border-border/70 last:border-b-0 hover:bg-muted/20"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-primary">
                          {initials(patient)}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {patient.firstName} {patient.lastName}
                          </div>
                          {patient.otherNames ? (
                            <div className="truncate text-xs text-muted-foreground">
                              {patient.otherNames}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted-foreground">
                      {patient.mrn}
                    </td>
                    <td className="px-5 py-3 capitalize text-muted-foreground">{patient.sex}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {ageFromDob(patient.dob) ?? "—"}
                      {patient.dob ? (
                        <span className="ml-1.5 font-mono text-xs">{patient.dob}</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{patient.phone ?? "—"}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                      {formatDate(patient.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 border-t border-border/70 bg-muted/15 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                Showing {from}–{to} of {total}
              </span>
              <label className="flex items-center gap-1.5">
                <span>Rows per page</span>
                <select
                  aria-label="Rows per page"
                  className="h-7 rounded-md border border-input bg-card px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                  value={pageSize}
                  disabled={isBusy}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Pagination
              page={response.pagination.page}
              totalPages={response.pagination.totalPages}
              onPageChange={setPage}
              disabled={isBusy}
            />
          </div>
        </>
      )}
    </section>
  );
}
