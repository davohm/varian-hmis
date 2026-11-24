"use client";

import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  Loader2,
  Phone,
  RotateCw,
  Search,
  UserCheck,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  createdAt?: string;
}

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "reception-station" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
      detail?: string;
    } | null;
    const message = detail?.detail ?? detail?.error ?? `Request failed (${response.status})`;
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

function initials(patient: SearchResult): string {
  return `${patient.firstName[0] ?? ""}${patient.lastName[0] ?? ""}`.toUpperCase();
}

function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const years = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? `${years}y` : null;
}

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;
const MAX_CACHE_ENTRIES = 30;

type SearchState = "idle" | "too-short" | "loading" | "ready" | "error";

export function CheckInPanel({
  onCheckedIn,
  recentPatients = [],
}: {
  onCheckedIn?: () => void;
  recentPatients?: SearchResult[];
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedTerm, setSearchedTerm] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<SearchResult | null>(null);
  const [checkInPending, setCheckInPending] = useState(false);
  const [keys, setKeys] = useState<Record<string, { visit: string; queue: string }>>({});

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const cacheRef = useRef(new Map<string, SearchResult[]>());
  const [retryToken, setRetryToken] = useState(0);

  const rememberResults = useCallback((term: string, patients: SearchResult[]) => {
    const cache = cacheRef.current;
    if (cache.has(term)) cache.delete(term);
    cache.set(term, patients);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }, []);

  useEffect(() => {
    const term = searchTerm.trim();
    if (!term) {
      abortRef.current?.abort();
      setResults([]);
      setSearchedTerm("");
      setSearchError(null);
      setSearchState("idle");
      return;
    }
    if (term.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      setResults([]);
      setSearchedTerm("");
      setSearchError(null);
      setSearchState("too-short");
      return;
    }

    const cached = cacheRef.current.get(term);
    if (cached) {
      setResults(cached);
      setSearchedTerm(term);
      setSearchError(null);
      setSearchState("ready");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(async () => {
      // Keep the previous list visible while the next term resolves, so the
      // panel never collapses to an empty box between keystrokes.
      setSearchState("loading");
      setSearchError(null);
      try {
        const response = await fetch(
          `/api/patients/search?q=${encodeURIComponent(term)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const data = (await response.json()) as { patients: SearchResult[] };
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        const patients = data.patients ?? [];
        rememberResults(term, patients);
        setResults(patients);
        setSearchedTerm(term);
        setSearchState("ready");
      } catch (error) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setResults([]);
        setSearchedTerm(term);
        setSearchError(error instanceof Error ? error.message : "Could not search patients");
        setSearchState("error");
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [searchTerm, retryToken, rememberResults]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const checkIn = useCallback(
    async (patient: SearchResult) => {
      setCheckInPending(true);
      try {
        const patientKeys = keys[patient.id] ?? {
          visit: crypto.randomUUID(),
          queue: crypto.randomUUID(),
        };
        if (!keys[patient.id]) setKeys((current) => ({ ...current, [patient.id]: patientKeys }));

        const visit = await postJson<{ encounterId: string }>("/api/reception/start-visit", {
          patientId: patient.id,
          idempotencyKey: patientKeys.visit,
        });
        await postJson("/api/reception/queue", {
          encounterId: visit.encounterId,
          idempotencyKey: patientKeys.queue,
          department: "Triage",
          priority: "normal",
        });
        toast.success(`${patient.firstName} ${patient.lastName} queued for triage`);
        setSelectedPatient(null);
        setSearchTerm("");
        setResults([]);
        setSearchedTerm("");
        setSearchState("idle");
        onCheckedIn?.();
      } catch (error) {
        if (await handleSessionMismatch(error)) return;
        toast.error(error instanceof Error ? error.message : "Could not check in patient");
      } finally {
        setCheckInPending(false);
      }
    },
    [keys, onCheckedIn],
  );

  const clearSearch = useCallback(() => {
    abortRef.current?.abort();
    setSearchTerm("");
    setResults([]);
    setSearchedTerm("");
    setSearchError(null);
    setSearchState("idle");
    setSelectedPatient(null);
  }, []);

  const term = searchTerm.trim();
  const showSearchResults = term.length > 0 && !selectedPatient;
  const isSearching = searchState === "loading";
  const hasResults = results.length > 0;
  const showRecent = !term && !selectedPatient && recentPatients.length > 0;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-border/80 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Check in a patient</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Search the registry, confirm the record, then start the visit and send the patient to
              triage.
            </p>
          </div>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/reception/register" />}>
            <UserPlus aria-hidden="true" />
            New patient
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="patient-search"
            data-testid="patient-search"
            className="h-11 pr-10 pl-10 text-[15px]"
            placeholder="Name, MRN, phone, or national ID"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              if (selectedPatient) setSelectedPatient(null);
            }}
            autoComplete="off"
            aria-label="Search patients"
            aria-describedby="patient-search-hint"
            style={{}}
          />
          <span className="absolute top-1/2 right-2 -translate-y-1/2">
            {isSearching ? (
              <Loader2
                className="size-4 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : searchTerm ? (
              <button
                type="button"
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={clearSearch}
                aria-label="Clear search"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </div>
        <p id="patient-search-hint" className="sr-only">
          Type at least {MIN_QUERY_LENGTH} characters to search.
        </p>

        {selectedPatient ? (
          <div
            data-testid="selected-patient"
            className="rounded-lg border border-[var(--status-normal)]/25 bg-[var(--status-normal-background)]/30 p-4"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-card font-semibold text-primary ring-1 ring-border">
                  {initials(selectedPatient)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-foreground">
                    {selectedPatient.firstName} {selectedPatient.lastName}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {selectedPatient.mrn}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSelectedPatient(null)}
                  disabled={checkInPending}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  data-testid="start-visit-selected"
                  onClick={() => void checkIn(selectedPatient)}
                  disabled={checkInPending}
                >
                  <UserCheck aria-hidden="true" />
                  {checkInPending ? "Checking in…" : "Start visit & queue"}
                </Button>
              </div>
            </div>
            <dl className="mt-4 grid gap-3 border-t border-border/60 pt-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Phone</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 text-foreground">
                  <Phone className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {selectedPatient.phone ?? "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Date of birth</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 text-foreground">
                  <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {selectedPatient.dob
                    ? `${selectedPatient.dob}${ageFromDob(selectedPatient.dob) ? ` · ${ageFromDob(selectedPatient.dob)}` : ""}`
                    : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sex</dt>
                <dd className="mt-0.5 capitalize text-foreground">{selectedPatient.sex}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {showSearchResults ? (
          <div
            className="overflow-hidden rounded-lg border border-border bg-background"
            aria-busy={isSearching}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
              <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
                {searchState === "too-short"
                  ? `Type at least ${MIN_QUERY_LENGTH} characters`
                  : searchState === "loading"
                    ? "Searching…"
                    : searchState === "error"
                      ? "Search unavailable"
                      : isSearching
                        ? "Updating results…"
                        : `${results.length} result${results.length === 1 ? "" : "s"}`}
              </p>
              {searchState === "ready" && hasResults ? (
                <p className="shrink-0 text-xs text-muted-foreground">Select a record</p>
              ) : null}
            </div>

            {searchState === "too-short" ? (
              <div className="px-4 py-5">
                <p className="text-sm text-muted-foreground">
                  Keep typing — at least {MIN_QUERY_LENGTH} characters are needed to search the
                  registry.
                </p>
              </div>
            ) : searchState === "error" ? (
              <div className="p-3">
                <div
                  role="alert"
                  className="flex flex-col items-start gap-3 rounded-md bg-[var(--status-critical-background)]/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0 text-[var(--status-critical)]"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="font-medium text-foreground">Search unavailable</p>
                      <p className="mt-0.5 text-muted-foreground">{searchError}</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRetryToken((token) => token + 1)}
                  >
                    <RotateCw aria-hidden="true" />
                    Try again
                  </Button>
                </div>
              </div>
            ) : searchState === "loading" && !hasResults ? (
              <div className="space-y-2 p-3" aria-hidden="true">
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
                <span className="sr-only">Searching patients</span>
              </div>
            ) : hasResults ? (
              <ul
                className={cn(
                  "divide-y divide-border/70 transition-opacity",
                  isSearching && "opacity-60",
                )}
                data-testid="search-results"
              >
                {results.map((patient) => (
                  <li key={patient.id}>
                    <button
                      type="button"
                      data-testid={`patient-result-${patient.id}`}
                      onClick={() => {
                        setSelectedPatient(patient);
                        setResults([]);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-primary">
                          {initials(patient)}
                        </span>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {patient.firstName} {patient.lastName}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {[patient.phone, patient.dob ? `DOB ${patient.dob}` : null]
                              .filter(Boolean)
                              .join(" · ") || "No phone or DOB on file"}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {patient.mrn}
                        </span>
                        <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <p className="text-sm font-medium text-foreground">No matching patient</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Nothing matches “{searchedTerm || term}”. Check the spelling, MRN or phone
                  number, or create a new record.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  nativeButton={false}
                  render={<Link href="/reception/register" />}
                >
                  <UserPlus aria-hidden="true" />
                  Register a new patient
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {showRecent ? (
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
              <p className="text-xs font-medium text-muted-foreground">Recently registered</p>
              <Link
                href="/reception/patients"
                className="text-xs font-medium text-primary hover:underline"
              >
                View registry
              </Link>
            </div>
            <ul className="divide-y divide-border/70">
              {recentPatients.map((patient) => (
                <li key={patient.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedPatient(patient)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-primary">
                        {initials(patient)}
                      </span>
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {patient.firstName} {patient.lastName}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                          {patient.mrn}
                          {patient.phone ? ` · ${patient.phone}` : ""}
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!term && !selectedPatient && !showRecent ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/15 px-4 py-6">
            <p className="text-sm font-medium text-foreground">Ready for the next patient</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start typing at least {MIN_QUERY_LENGTH} characters of a name, MRN or phone number.
              Results appear as you type.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
