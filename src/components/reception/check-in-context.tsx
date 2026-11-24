"use client";

import { UserCheck } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { SearchResult } from "@/components/reception/types";

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

interface CheckInContextValue {
  selectedPatient: SearchResult | null;
  setSelectedPatient: (patient: SearchResult | null) => void;
  checkIn: (patient: SearchResult) => Promise<boolean>;
  checkingIn: boolean;
  openCheckIn: () => void;
  closeCheckIn: () => void;
  registerSearchFocus: (focus: () => void) => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
}

const CheckInContext = createContext<CheckInContextValue | null>(null);

export function CheckInProvider({ children }: { children: ReactNode }) {
  const [selectedPatient, setSelectedPatient] = useState<SearchResult | null>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [keys, setKeys] = useState<Record<string, { visit: string; queue: string }>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusSearchRef = useRef<() => void>(() => {});

  const checkIn = useCallback(
    async (patient: SearchResult) => {
      setCheckingIn(true);
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
        return true;
      } catch (error) {
        if (await handleSessionMismatch(error)) return false;
        toast.error(error instanceof Error ? error.message : "Could not check in patient");
        return false;
      } finally {
        setCheckingIn(false);
      }
    },
    [keys],
  );

  const openCheckIn = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusSearchRef.current();
  }, []);

  const closeCheckIn = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const registerSearchFocus = useCallback((focus: () => void) => {
    focusSearchRef.current = focus;
  }, []);

  const value = useMemo<CheckInContextValue>(
    () => ({
      selectedPatient,
      setSelectedPatient,
      checkIn,
      checkingIn,
      openCheckIn,
      closeCheckIn,
      registerSearchFocus,
      dialogRef,
    }),
    [
      selectedPatient,
      checkIn,
      checkingIn,
      openCheckIn,
      closeCheckIn,
      registerSearchFocus,
      dialogRef,
    ],
  );

  return <CheckInContext.Provider value={value}>{children}</CheckInContext.Provider>;
}

export function useCheckIn(): CheckInContextValue {
  const context = useContext(CheckInContext);
  if (!context) throw new Error("useCheckIn must be used inside CheckInProvider");
  return context;
}

export function CheckInTrigger() {
  const { openCheckIn } = useCheckIn();

  return (
    <Button type="button" variant="outline" onClick={openCheckIn} data-testid="check-in-trigger">
      <UserCheck aria-hidden="true" />
      Check in patient
    </Button>
  );
}
