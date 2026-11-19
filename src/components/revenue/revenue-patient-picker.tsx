"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { INPUT_CLASS } from "@/components/finance/finance-primitives";
import type { PatientResult } from "@/components/revenue/revenue-types";

interface PatientPickerProps {
  onPatientChange: (patient: PatientResult | null) => void;
  testId?: string;
}

/** Debounced registry lookup used by pre-authorisation and claim forms. */
export function PatientPicker({ onPatientChange, testId = "revenue-patient" }: PatientPickerProps) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientResult[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setPatients([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/patients/search?q=${encodeURIComponent(term)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : { patients: [] }))
        .then((body: { patients?: PatientResult[] }) => {
          if (!cancelled) setPatients(body.patients ?? []);
        })
        .catch(() => {
          if (!cancelled) setPatients([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function choose(id: string) {
    setSelectedId(id);
    onPatientChange(patients.find((patient) => patient.id === id) ?? null);
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">Find patient</span>
        <span className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedId("");
              onPatientChange(null);
            }}
            placeholder="MRN, phone or name"
            aria-label="Patient search"
            data-testid={`${testId}-search`}
            className={`${INPUT_CLASS} pl-8`}
          />
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">Patient</span>
        <select
          value={selectedId}
          onChange={(event) => choose(event.target.value)}
          aria-label="Patient"
          data-testid={`${testId}-select`}
          className={INPUT_CLASS}
          disabled={patients.length === 0}
        >
          <option value="">
            {searching
              ? "Searching…"
              : patients.length === 0
                ? "Search for a patient first"
                : "Select a patient"}
          </option>
          {patients.map((patient) => (
            <option key={patient.id} value={patient.id}>
              {patient.mrn} · {patient.firstName} {patient.lastName}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
