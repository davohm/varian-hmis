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

const DEFAULT_CONSENT_VERSION = "v1";
const DEFAULT_CONSENT_TEXT =
  "I confirm that I have received information about the collection and use of personal and health data for treatment, care coordination, billing and related lawful purposes. I consent to processing of this data as explained.";

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

function dateOfBirthFromAge(age: number): string {
  const year = new Date().getUTCFullYear() - age;
  return `${String(year).padStart(4, "0")}-01-01`;
}

function resolvedDob(values: Pick<FormValues, "dob" | "estimatedAge">): string | null {
  if (values.dob) return values.dob;
  if (values.estimatedAge) {
    const age = Number(values.estimatedAge);
    if (Number.isFinite(age)) return dateOfBirthFromAge(age);
  }
  return null;
}

function isMinorDob(dob: string): boolean {
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const ageMs = Date.now() - birth.getTime();
  return ageMs / (365.25 * 24 * 60 * 60 * 1000) < 18;
}

async function hashConsentText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const FIELD_CLASS = "mt-1";

export function ReceptionWorkspace() {
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<SearchResult | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [pending, setPending] = useState(false);
  const [lastRegistered, setLastRegistered] = useState<{ name: string; mrn: string } | null>(null);
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [consentVersion, setConsentVersion] = useState(DEFAULT_CONSENT_VERSION);
  const [consentText, setConsentText] = useState(DEFAULT_CONSENT_TEXT);
  const [consentGrantedBy, setConsentGrantedBy] = useState("");
  const consentDialogRef = useRef<HTMLDialogElement>(null);
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
  const watchedEstimatedAge = watch("estimatedAge");

  const dobForMinor = resolvedDob({ dob: watchedDob, estimatedAge: watchedEstimatedAge });
  const registrationIsMinor = dobForMinor ? isMinorDob(dobForMinor) : false;

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

  async function performRegistration(values: FormValues, consentTextHash: string) {
    setPending(true);
    try {
      const keys = keysRef.current ?? newKeys();
      const dob = resolvedDob(values);
      const minor = dob ? isMinorDob(dob) : false;
      const patientFullName = `${values.firstName} ${values.lastName}`.trim();
      const grantedBy =
        consentGrantedBy.trim() || (minor ? values.kinName.trim() : patientFullName);
      const grantedAt = new Date().toISOString();

      const body: Record<string, unknown> = {
        firstName: values.firstName,
        lastName: values.lastName,
        otherNames: values.otherNames || null,
        dob: values.dob || null,
        estimatedAge: values.estimatedAge ? Number(values.estimatedAge) : null,
        sex: values.sex,
        phone: values.phone || null,
        nationalId: values.nationalId || null,
        email: values.email || null,
        address: values.address || null,
        payerType: values.payerType,
        payerMemberNo: values.payerMemberNo || null,
        allergies: values.allergies
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        bloodGroup: values.bloodGroup || null,
        nextOfKin: values.kinName
          ? [
              {
                name: values.kinName,
                relationship: values.kinRelationship || "Next of kin",
                phone: values.kinPhone || null,
              },
            ]
          : [],
        idempotencyKey: keys.register,
      };

      if (minor) {
        body.minorConsent = {
          consentType: "minor",
          consentVersion: consentVersion.trim() || DEFAULT_CONSENT_VERSION,
          consentTextHash,
          granted: true,
          grantedAt,
          grantedBy,
          source: "registration",
        };
      } else {
        body.treatmentConsent = {
          consentType: "treatment",
          consentVersion: consentVersion.trim() || DEFAULT_CONSENT_VERSION,
          consentTextHash,
          granted: true,
          grantedAt,
          grantedBy: grantedBy || patientFullName,
          source: "registration",
        };
      }

      const registered = await postJson<{ patientId: string; mrn: string }>(
        "/api/reception/register",
        body,
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

      setLastRegistered({ name: patientFullName, mrn: registered.mrn });
      toast.success(
        `${registered.mrn} registered${values.startVisit ? " and queued for triage" : ""}`,
      );
      reset(DEFAULT_VALUES);
      keysRef.current = newKeys();
      setDuplicates([]);
      setSelectedPatient(null);
      setSearchTerm("");
      setPendingValues(null);
      setConsentVersion(DEFAULT_CONSENT_VERSION);
      setConsentText(DEFAULT_CONSENT_TEXT);
      setConsentGrantedBy("");
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not register patient");
    } finally {
      setPending(false);
    }
  }

  const onSubmit = handleSubmit((values) => {
    const dob = resolvedDob(values);
    const minor = dob ? isMinorDob(dob) : false;
    if (minor && !values.kinName.trim()) {
      toast.error("A guardian or next of kin is required when registering a minor.");
      return;
    }
    setPendingValues(values);
    setConsentGrantedBy(
      minor ? values.kinName.trim() : `${values.firstName} ${values.lastName}`.trim(),
    );
    if (!consentText.trim()) setConsentText(DEFAULT_CONSENT_TEXT);
    consentDialogRef.current?.showModal();
  });

  async function confirmConsent() {
    if (!pendingValues) return;
    const version = consentVersion.trim();
    const text = consentText.trim();
    const dob = resolvedDob(pendingValues);
    const minor = dob ? isMinorDob(dob) : false;
    const grantedBy =
      consentGrantedBy.trim() ||
      (minor ? pendingValues.kinName.trim() : `${pendingValues.firstName} ${pendingValues.lastName}`.trim());
    if (!version) {
      toast.error("Consent version is required.");
      return;
    }
    if (!text) {
      toast.error("Consent text is required.");
      return;
    }
    if (!grantedBy) {
      toast.error(
        minor
          ? "Guardian name is required for minor consent."
          : "Consent signer name is required.",
      );
      return;
    }
    if (minor && !pendingValues.kinName.trim()) {
      toast.error("A guardian or next of kin is required when registering a minor.");
      return;
    }
    try {
      const hash = await hashConsentText(text);
      consentDialogRef.current?.close();
      await performRegistration(pendingValues, hash);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not capture consent");
    }
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-primary">Find a patient</h2>
            <p className="text-xs text-muted-foreground">
              Search by name, MRN, phone or national ID.
            </p>
          </div>
          <div className="p-4">
            <Label htmlFor="patient-search" className="sr-only">
              Search patients
            </Label>
            <div className="relative">
              <Search
                className="absolute top-2 left-2.5 size-4 text-muted-foreground"
                aria-hidden="true"
              />
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
              <ul
                className="mt-3 divide-y divide-border rounded-md border border-border"
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
            <p className="text-xs text-muted-foreground">
              All fields with an asterisk are required. Consent will be captured before saving.
            </p>
          </div>
          <div className="p-4">
            {lastRegistered ? (
              <div
                data-testid="registration-success"
                className="mb-3 rounded-md border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-3 py-2 text-xs text-[var(--status-normal-foreground)]"
              >
                <span className="font-medium">{lastRegistered.name}</span> —{" "}
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
                      {duplicate.mrn} — {duplicate.firstName} {duplicate.lastName} —{" "}
                      {duplicate.matchReason.replace("_", " ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {registrationIsMinor ? (
              <div className="mb-3 rounded-md border border-[var(--status-warning)] bg-[var(--status-warning-background)] px-3 py-2 text-xs text-[var(--status-warning-foreground)]">
                Minor patient: guardian/next of kin details and guardian consent are required before
                registration.
              </div>
            ) : null}

            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name *</Label>
                  <Input
                    id="firstName"
                    data-testid="patient-first-name"
                    className={FIELD_CLASS}
                    {...register("firstName")}
                  />
                  {errors.firstName ? (
                    <p className="mt-1 text-xs text-destructive">{errors.firstName.message}</p>
                  ) : null}
                </div>
                <div>
                  <Label htmlFor="lastName">Last name *</Label>
                  <Input
                    id="lastName"
                    data-testid="patient-last-name"
                    className={FIELD_CLASS}
                    {...register("lastName")}
                  />
                  {errors.lastName ? (
                    <p className="mt-1 text-xs text-destructive">{errors.lastName.message}</p>
                  ) : null}
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
                  <Input
                    id="dob"
                    type="date"
                    data-testid="patient-dob"
                    className={FIELD_CLASS}
                    {...register("dob")}
                  />
                  {errors.dob ? (
                    <p className="mt-1 text-xs text-destructive">{errors.dob.message}</p>
                  ) : null}
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
                  <Input
                    id="phone"
                    data-testid="patient-phone"
                    className={FIELD_CLASS}
                    {...register("phone")}
                  />
                </div>
                <div>
                  <Label htmlFor="nationalId">National ID</Label>
                  <Input
                    id="nationalId"
                    data-testid="patient-national-id"
                    className={FIELD_CLASS}
                    {...register("nationalId")}
                  />
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
                  <Label htmlFor="kinName">Next of kin{registrationIsMinor ? " *" : ""}</Label>
                  <Input id="kinName" className={FIELD_CLASS} {...register("kinName")} />
                </div>
                <div>
                  <Label htmlFor="kinRelationship">Relationship</Label>
                  <Input
                    id="kinRelationship"
                    className={FIELD_CLASS}
                    {...register("kinRelationship")}
                  />
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

      <dialog
        ref={consentDialogRef}
        aria-labelledby="registration-consent-title"
        aria-describedby="registration-consent-desc"
        className="m-auto w-full max-w-xl rounded-xl border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
        data-testid="registration-consent-dialog"
        onCancel={(event) => {
          event.preventDefault();
          consentDialogRef.current?.close();
        }}
      >
        <form
          method="dialog"
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmConsent();
          }}
        >
          <div className="space-y-1">
            <h3 id="registration-consent-title" className="text-base font-semibold text-primary">
              Capture consent
            </h3>
            <p id="registration-consent-desc" className="text-sm text-muted-foreground">
              {pendingValues && resolvedDob(pendingValues) && isMinorDob(resolvedDob(pendingValues)!)
                ? "Guardian consent for a minor is required. The consent text is versioned and its SHA-256 hash will be stored."
                : "Treatment consent is captured at registration. The consent text is versioned and its SHA-256 hash will be stored."}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="consent-version">Consent version *</Label>
              <Input
                id="consent-version"
                data-testid="registration-consent-version"
                className={FIELD_CLASS}
                value={consentVersion}
                onChange={(event) => setConsentVersion(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="consent-granted-by">
                {pendingValues && resolvedDob(pendingValues) && isMinorDob(resolvedDob(pendingValues)!)
                  ? "Guardian name *"
                  : "Consenting person *"}
              </Label>
              <Input
                id="consent-granted-by"
                data-testid="registration-consent-granted-by"
                className={FIELD_CLASS}
                value={consentGrantedBy}
                onChange={(event) => setConsentGrantedBy(event.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <Label htmlFor="consent-text">Consent text (hashed) *</Label>
            <textarea
              id="consent-text"
              data-testid="registration-consent-text"
              className="mt-1 min-h-32 w-full rounded-lg border border-input bg-transparent p-2.5 text-sm dark:bg-input/30"
              value={consentText}
              onChange={(event) => setConsentText(event.target.value)}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Review the text shown to the patient or guardian. Only the version and hash of this
              text are stored.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => consentDialogRef.current?.close()}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" data-testid="registration-consent-confirm" disabled={pending}>
              {pending ? "Saving…" : "Confirm consent & register"}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
