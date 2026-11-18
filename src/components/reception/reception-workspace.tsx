"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Search, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { QueueTable } from "@/components/reception/queue-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SearchResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
}

interface DuplicateMatch {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  matchReason: "national_id" | "phone_and_dob";
}

const formSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    otherNames: z.string(),
    dob: z.string(),
    estimatedAge: z.string(),
    sex: z.enum(["male", "female", "other"]),
    phone: z.string(),
    nationalId: z.string(),
    email: z.string(),
    address: z.string(),
    payerType: z.enum(["cash", "sha", "insurance"]),
    payerMemberNo: z.string(),
    allergies: z.string(),
    bloodGroup: z.string(),
    kinName: z.string(),
    kinRelationship: z.string(),
    kinPhone: z.string(),
    startVisit: z.boolean(),
  })
  .superRefine((values, context) => {
    if (!values.dob && !values.estimatedAge) {
      context.addIssue({
        code: "custom",
        path: ["dob"],
        message: "Enter a date of birth or an estimated age",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  firstName: "",
  lastName: "",
  otherNames: "",
  dob: "",
  estimatedAge: "",
  sex: "female",
  phone: "",
  nationalId: "",
  email: "",
  address: "",
  payerType: "cash",
  payerMemberNo: "",
  allergies: "",
  bloodGroup: "",
  kinName: "",
  kinRelationship: "",
  kinPhone: "",
  startVisit: true,
};

interface CommandKeys {
  register: string;
  visit: string;
  queue: string;
}

function newKeys(): CommandKeys {
  return {
    register: crypto.randomUUID(),
    visit: crypto.randomUUID(),
    queue: crypto.randomUUID(),
  };
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

/** A stale tab can keep showing reception after the session switches roles. */
async function handleSessionMismatch(error: unknown): Promise<boolean> {
  if (!(error instanceof SessionMismatchError)) return false;
  toast.error("Your session changed. Returning to your workspace.");
  window.location.assign("/");
  return true;
}

const FIELD_CLASS = "mt-1";

export function ReceptionWorkspace() {
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<SearchResult | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [pending, setPending] = useState(false);
  const [lastRegistered, setLastRegistered] = useState<{ name: string; mrn: string } | null>(null);
  const keysRef = useRef<CommandKeys | null>(null);
  const checkInKeysRef = useRef<Record<string, { visit: string; queue: string }>>({});
  if (!keysRef.current) keysRef.current = newKeys();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  const watchedPhone = watch("phone");
  const watchedDob = watch("dob");
  const watchedNationalId = watch("nationalId");

  useEffect(() => {
    const term = searchTerm.trim();
    if (!term) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { patients: SearchResult[] };
        setResults(data.patients);
      } catch {
        // Aborted or offline searches simply keep the previous results.
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [searchTerm]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (watchedPhone?.trim()) params.set("phone", watchedPhone.trim());
    if (watchedDob) params.set("dob", watchedDob);
    if (watchedNationalId?.trim()) params.set("nationalId", watchedNationalId.trim());
    if ([...params.keys()].length === 0) {
      setDuplicates([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients/duplicates?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { duplicates: DuplicateMatch[] };
        setDuplicates(data.duplicates);
      } catch {
        // Ignore aborted duplicate checks.
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [watchedPhone, watchedDob, watchedNationalId]);

  const checkIn = useCallback(async (patient: SearchResult) => {
    try {
      if (!checkInKeysRef.current[patient.id]) {
        checkInKeysRef.current[patient.id] = {
          visit: crypto.randomUUID(),
          queue: crypto.randomUUID(),
        };
      }
      const keys = checkInKeysRef.current[patient.id];
      const visit = await postJson<{ encounterId: string }>("/api/reception/start-visit", {
        patientId: patient.id,
        idempotencyKey: keys.visit,
      });
      await postJson("/api/reception/queue", {
        encounterId: visit.encounterId,
        idempotencyKey: keys.queue,
        department: "Triage",
        priority: "normal",
      });
      toast.success(`${patient.firstName} ${patient.lastName} queued for triage`);
      setSelectedPatient(null);
      setSearchTerm("");
      setResults([]);
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not check in patient");
    }
  }, []);

  const onSubmit = handleSubmit(async (values) => {
    setPending(true);
    try {
      const keys = keysRef.current ?? newKeys();
      const registered = await postJson<{ patientId: string; mrn: string }>(
        "/api/reception/register",
        {
          ...values,
          idempotencyKey: keys.register,
          dob: values.dob || null,
          estimatedAge: values.estimatedAge ? Number(values.estimatedAge) : null,
          phone: values.phone || null,
          nationalId: values.nationalId || null,
          email: values.email || null,
          address: values.address || null,
          otherNames: values.otherNames || null,
          payerMemberNo: values.payerMemberNo || null,
          bloodGroup: values.bloodGroup || null,
          allergies: values.allergies
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          nextOfKin: values.kinName
            ? [
                {
                  name: values.kinName,
                  relationship: values.kinRelationship || "Next of kin",
                  phone: values.kinPhone || null,
                },
              ]
            : [],
          startVisit: undefined,
        },
      );

      if (values.startVisit) {
        const visit = await postJson<{ encounterId: string }>("/api/reception/start-visit", {
          patientId: registered.patientId,
          idempotencyKey: keys.visit,
          payerType: values.payerType,
        });
        await postJson("/api/reception/queue", {
          encounterId: visit.encounterId,
          idempotencyKey: keys.queue,
          department: "Triage",
          priority: "normal",
        });
      }

      setLastRegistered({ name: `${values.firstName} ${values.lastName}`, mrn: registered.mrn });
      toast.success(`${registered.mrn} registered${values.startVisit ? " and queued for triage" : ""}`);
      reset(DEFAULT_VALUES);
      keysRef.current = newKeys();
      setDuplicates([]);
      setSelectedPatient(null);
      setSearchTerm("");
      setResults([]);
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not register patient");
    } finally {
      setPending(false);
    }
  });

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-primary">Find a patient</h2>
            <p className="text-xs text-muted-foreground">Search by name, MRN, phone or national ID.</p>
          </div>
          <div className="p-4">
            <Label htmlFor="patient-search" className="sr-only">Search patients</Label>
            <div className="relative">
              <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                id="patient-search"
                data-testid="patient-search"
                className="pl-8"
                placeholder="Search patients"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                autoComplete="off"
              />
            </div>

            {selectedPatient ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-secondary-foreground">
                    {selectedPatient.firstName} {selectedPatient.lastName}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{selectedPatient.mrn}</p>
                </div>
                <Button
                  type="button"
                  data-testid="start-visit-selected"
                  onClick={() => void checkIn(selectedPatient)}
                >
                  Start visit &amp; queue
                </Button>
              </div>
            ) : null}

            {results.length > 0 && !selectedPatient ? (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border" data-testid="search-results">
                {results.map((patient) => (
                  <li key={patient.id}>
                    <button
                      type="button"
                      data-testid={`patient-result-${patient.id}`}
                      onClick={() => {
                        setSelectedPatient(patient);
                        setResults([]);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-secondary"
                    >
                      <span className="text-sm font-medium">
                        {patient.firstName} {patient.lastName}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{patient.mrn}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-primary">Registration</h2>
            <p className="text-xs text-muted-foreground">All fields with an asterisk are required.</p>
          </div>
          <div className="p-4">
            {lastRegistered ? (
              <div
                data-testid="registration-success"
                className="mb-3 rounded-md border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-3 py-2 text-xs text-[var(--status-normal-foreground)]"
              >
                <span className="font-medium">{lastRegistered.name}</span> ·{" "}
                <span className="font-mono">{lastRegistered.mrn}</span>
              </div>
            ) : null}
            {duplicates.length > 0 ? (
              <div
                role="alert"
                data-testid="duplicate-warning"
                className="mb-3 rounded-md border border-[var(--status-warning)] bg-[var(--status-warning-background)] px-3 py-2 text-xs text-[var(--status-warning-foreground)]"
              >
                <p className="font-semibold">Possible duplicate record</p>
                <ul className="mt-1 space-y-1">
                  {duplicates.map((duplicate) => (
                    <li key={duplicate.id} className="font-mono">
                      {duplicate.mrn} · {duplicate.firstName} {duplicate.lastName} ·{" "}
                      {duplicate.matchReason.replace("_", " ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name *</Label>
                  <Input id="firstName" data-testid="patient-first-name" className={FIELD_CLASS} {...register("firstName")} />
                  {errors.firstName ? <p className="mt-1 text-xs text-destructive">{errors.firstName.message}</p> : null}
                </div>
                <div>
                  <Label htmlFor="lastName">Last name *</Label>
                  <Input id="lastName" data-testid="patient-last-name" className={FIELD_CLASS} {...register("lastName")} />
                  {errors.lastName ? <p className="mt-1 text-xs text-destructive">{errors.lastName.message}</p> : null}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="otherNames">Other names</Label>
                  <Input id="otherNames" className={FIELD_CLASS} {...register("otherNames")} />
                </div>
                <div>
                  <Label htmlFor="sex">Sex *</Label>
                  <select
                    id="sex"
                    data-testid="patient-sex"
                    className="mt-1 h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    {...register("sex")}
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="dob">Date of birth</Label>
                  <Input id="dob" type="date" data-testid="patient-dob" className={FIELD_CLASS} {...register("dob")} />
                  {errors.dob ? <p className="mt-1 text-xs text-destructive">{errors.dob.message}</p> : null}
                </div>
                <div>
                  <Label htmlFor="estimatedAge">or estimated age</Label>
                  <Input
                    id="estimatedAge"
                    type="number"
                    min="0"
                    max="120"
                    placeholder="Years"
                    className={FIELD_CLASS}
                    {...register("estimatedAge")}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" data-testid="patient-phone" className={FIELD_CLASS} {...register("phone")} />
                </div>
                <div>
                  <Label htmlFor="nationalId">National ID</Label>
                  <Input id="nationalId" data-testid="patient-national-id" className={FIELD_CLASS} {...register("nationalId")} />
                </div>
              </div>

              <div>
                <Label htmlFor="address">Address</Label>
                <Input id="address" className={FIELD_CLASS} {...register("address")} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="payerType">Payer</Label>
                  <select
                    id="payerType"
                    className="mt-1 h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    {...register("payerType")}
                  >
                    <option value="cash">Cash</option>
                    <option value="sha">SHA</option>
                    <option value="insurance">Insurance</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="payerMemberNo">Member number</Label>
                  <Input id="payerMemberNo" className={FIELD_CLASS} {...register("payerMemberNo")} />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="allergies">Allergies (comma separated)</Label>
                  <Input id="allergies" className={FIELD_CLASS} {...register("allergies")} />
                </div>
                <div>
                  <Label htmlFor="bloodGroup">Blood group</Label>
                  <Input id="bloodGroup" className={FIELD_CLASS} {...register("bloodGroup")} />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="kinName">Next of kin</Label>
                  <Input id="kinName" className={FIELD_CLASS} {...register("kinName")} />
                </div>
                <div>
                  <Label htmlFor="kinRelationship">Relationship</Label>
                  <Input id="kinRelationship" className={FIELD_CLASS} {...register("kinRelationship")} />
                </div>
                <div>
                  <Label htmlFor="kinPhone">Phone</Label>
                  <Input id="kinPhone" className={FIELD_CLASS} {...register("kinPhone")} />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm" htmlFor="startVisit">
                <input
                  id="startVisit"
                  type="checkbox"
                  data-testid="start-visit-checkbox"
                  className="size-4 accent-[var(--brand-navy)]"
                  {...register("startVisit")}
                />
                Start visit and queue to triage
              </label>

              <Button type="submit" data-testid="register-patient" disabled={pending} className="w-full">
                <UserPlus aria-hidden="true" />
                {pending ? "Registering…" : "Register patient"}
              </Button>
            </form>
          </div>
        </section>
      </div>

      <QueueTable department="Triage" testId="reception-queue" />
    </div>
  );
}
