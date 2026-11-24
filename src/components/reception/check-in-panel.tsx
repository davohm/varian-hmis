"use client";

import {
  AlertCircle,
  Loader2,
  RotateCw,
  Search,
  UserCheck,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCheckIn } from "@/components/reception/check-in-context";
import type { PatientPayerType, SearchResult } from "@/components/reception/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function initials(patient: SearchResult): string {
  return `${patient.firstName[0] ?? ""}${patient.lastName[0] ?? ""}`.toUpperCase();
}

function fullName(patient: SearchResult): string {
  return [patient.firstName, patient.otherNames, patient.lastName].filter(Boolean).join(" ");
}

function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const years = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? `${years}y` : null;
}

function maskedNationalId(nationalId: string | null | undefined): string | null {
  if (!nationalId) return null;
  const trimmed = nationalId.trim();
  if (trimmed.length <= 4) return `ID ${trimmed}`;
  return `ID ••••${trimmed.slice(-4)}`;
}

const PAYER_LABELS: Record<PatientPayerType, string> = {
  cash: "Cash payer",
  sha: "SHA member",
  insurance: "Insured",
};

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;
const MAX_CACHE_ENTRIES = 30;

type SearchState = "idle" | "too-short" | "loading" | "ready" | "error";

/**
 * Registry lookup lives in a modal so reception has a single patient-flow table.
 * A result can be handed to that table or started as a visit directly.
 */
export function CheckInModal() {
  const {
    dialogRef,
    setSelectedPatient,
    closeCheckIn,
    registerSearchFocus,
    checkIn,
    checkingIn,
  } = useCheckIn();
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedTerm, setSearchedTerm] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [startingPatientId, setStartingPatientId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const cacheRef = useRef(new Map<string, SearchResult[]>());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerSearchFocus(() => searchRef.current?.focus());
    return () => registerSearchFocus(() => {});
  }, [registerSearchFocus]);

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
      // modal never collapses to an empty box between keystrokes.
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

  const clearResults = useCallback(() => {
    abortRef.current?.abort();
    setResults([]);
    setSearchedTerm("");
    setSearchError(null);
    setSearchState("idle");
    setSearchTerm("");
  }, []);

  const selectPatient = useCallback(
    (patient: SearchResult) => {
      clearResults();
      setSelectedPatient(patient);
      closeCheckIn();
    },
    [clearResults, closeCheckIn, setSelectedPatient],
  );

  const startVisit = useCallback(
    async (patient: SearchResult) => {
      if (checkingIn || startingPatientId) return;
      setStartingPatientId(patient.id);
      try {
        const started = await checkIn(patient);
        if (started) {
          clearResults();
          closeCheckIn();
        }
      } finally {
        setStartingPatientId(null);
      }
    },
    [checkIn, checkingIn, clearResults, closeCheckIn, startingPatientId],
  );

  const clearSearch = useCallback(() => {
    clearResults();
  }, [clearResults]);

  const term = searchTerm.trim();
  const showSearchResults = term.length > 0;
  const isSearching = searchState === "loading";
  const hasResults = results.length > 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="check-in-title"
      aria-describedby="check-in-description"
      data-testid="check-in-dialog"
      className="m-auto w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        closeCheckIn();
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border/80 px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Reception
          </p>
          <h2 id="check-in-title" className="mt-1 text-base font-semibold text-foreground">
            Check in a patient
          </h2>
          <p id="check-in-description" className="mt-1 text-sm leading-6 text-muted-foreground">
            Find the record, then select it for the patient-flow table or start the visit here.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={closeCheckIn}
          aria-label="Close check-in"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            id="patient-search"
            data-testid="patient-search"
            className="h-11 pr-10 pl-10 text-[15px]"
            placeholder="Name, MRN, phone, or national ID"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            autoComplete="off"
            autoFocus
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
                <p className="shrink-0 text-xs text-muted-foreground">Select or start visit</p>
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
                {results.map((patient) => {
                  const age = ageFromDob(patient.dob);
                  const nationalId = maskedNationalId(patient.nationalId);
                  const payerLabel = patient.payerType
                    ? (PAYER_LABELS[patient.payerType] ?? null)
                    : null;
                  const busy = startingPatientId === patient.id;
                  const startDisabled = checkingIn || startingPatientId !== null;

                  return (
                    <li
                      key={patient.id}
                      className="flex items-center gap-2 px-3 py-3 transition-colors hover:bg-muted/40"
                    >
                      <button
                        type="button"
                        data-testid={`patient-result-${patient.id}`}
                        onClick={() => selectPatient(patient)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-primary">
                          {initials(patient)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {fullName(patient)}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="font-mono">
                              <span className="sr-only">MRN </span>
                              {patient.mrn}
                            </span>
                            {patient.sex ? (
                              <span>
                                <span className="sr-only">Sex </span>
                                {patient.sex}
                              </span>
                            ) : null}
                            {age ? (
                              <span>
                                <span className="sr-only">Age </span>
                                {age}
                              </span>
                            ) : null}
                            {patient.phone ? (
                              <span>
                                <span className="sr-only">Phone </span>
                                {patient.phone}
                              </span>
                            ) : null}
                            {patient.dob ? <span>DOB {patient.dob}</span> : null}
                            {nationalId && patient.nationalId ? (
                              <>
                                <span aria-hidden="true">{nationalId}</span>
                                <span className="sr-only">
                                  National ID ending {patient.nationalId.trim().slice(-4)}
                                </span>
                              </>
                            ) : null}
                            {payerLabel ? <span>{payerLabel}</span> : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-medium text-primary">Select</span>
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        data-testid={`start-visit-${patient.id}`}
                        aria-label={`Start visit for ${fullName(patient)}`}
                        onClick={() => void startVisit(patient)}
                        disabled={startDisabled}
                        className="shrink-0"
                      >
                        <UserCheck aria-hidden="true" />
                        {busy ? "Starting…" : checkingIn ? "Working…" : "Start visit"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="p-4">
                <p className="text-sm font-medium text-foreground">No matching patient</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Nothing matches “{searchedTerm || term}”. Check the spelling, MRN, phone or
                  national ID, or create a new record.
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
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-muted/15 px-4 py-6">
            <p className="text-sm font-medium text-foreground">Ready for the next patient</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start typing at least {MIN_QUERY_LENGTH} characters of a name, MRN or phone number.
              Results appear as you type.
            </p>
          </div>
        )}
      </div>
    </dialog>
  );
}
