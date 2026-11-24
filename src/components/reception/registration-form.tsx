"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

function SectionHeading({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[11px] font-semibold text-primary">
        {step}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-xs text-destructive">{message}</p>;
}

const FIELD_CLASS = "mt-1.5";
const SELECT_CLASS =
  "mt-1.5 h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function RegistrationForm() {
  const [pending, setPending] = useState(false);
  const [lastRegistered, setLastRegistered] = useState<{ name: string; mrn: string } | null>(
    null,
  );
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [duplicateState, setDuplicateState] = useState<"idle" | "checking" | "clear">("idle");
  const duplicateAbortRef = useRef<AbortController | null>(null);
  const [consentVersion, setConsentVersion] = useState(DEFAULT_CONSENT_VERSION);
  const [consentText, setConsentText] = useState(DEFAULT_CONSENT_TEXT);
  const [consentGrantedBy, setConsentGrantedBy] = useState("");
  const consentDialogRef = useRef<HTMLDialogElement>(null);
  const keysRef = useRef<CommandKeys | null>(null);
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

  async function checkDuplicates(criteria: {
    phone?: string;
    dob?: string;
    nationalId?: string;
  }) {
    const params = new URLSearchParams();
    if (criteria.phone?.trim()) params.set("phone", criteria.phone.trim());
    if (criteria.dob) params.set("dob", criteria.dob);
    if (criteria.nationalId?.trim()) params.set("nationalId", criteria.nationalId.trim());
    if ([...params.keys()].length === 0) {
      duplicateAbortRef.current?.abort();
      setDuplicates([]);
      setDuplicateState("idle");
      return;
    }

    duplicateAbortRef.current?.abort();
    const controller = new AbortController();
    duplicateAbortRef.current = controller;
    setDuplicateState("checking");
    try {
      const response = await fetch(`/api/patients/duplicates?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Duplicate check failed (${response.status})`);
      const data = (await response.json()) as { duplicates: DuplicateMatch[] };
      if (controller.signal.aborted) return;
      setDuplicates(data.duplicates);
      setDuplicateState(data.duplicates.length === 0 ? "clear" : "idle");
    } catch {
      if (controller.signal.aborted) return;
      // Duplicate detection is advisory; a network hiccup must not block registration.
      setDuplicates([]);
      setDuplicateState("idle");
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkDuplicates({
        phone: watchedPhone,
        dob: watchedDob,
        nationalId: watchedNationalId,
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [watchedPhone, watchedDob, watchedNationalId]);

  useEffect(() => () => duplicateAbortRef.current?.abort(), []);

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
      setDuplicateState("idle");
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
    void checkDuplicates({
      phone: values.phone,
      dob: values.dob,
      nationalId: values.nationalId,
    });
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
      (minor
        ? pendingValues.kinName.trim()
        : `${pendingValues.firstName} ${pendingValues.lastName}`.trim());
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
        minor ? "Guardian name is required for minor consent." : "Consent signer name is required.",
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
    <div className="space-y-6">
      {lastRegistered ? (
        <div
          data-testid="registration-success"
          className="flex flex-col gap-4 rounded-xl border border-[var(--status-normal)]/25 bg-[var(--status-normal-background)]/45 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2
              className="mt-0.5 size-5 shrink-0 text-[var(--status-normal)]"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-[var(--status-normal-foreground)]">
                Patient registered
              </p>
              <p className="mt-0.5 text-sm text-[var(--status-normal-foreground)]/85">
                <span className="font-medium">{lastRegistered.name}</span> —{" "}
                <span className="font-mono">{lastRegistered.mrn}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => setLastRegistered(null)}>
              Register another
            </Button>
            <Button size="sm" nativeButton={false} render={<Link href="/reception" />}>
              Back to front desk
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border/80 px-5 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-foreground">New patient record</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Capture demographics, payer details, and consent. Fields marked * are required.
          </p>
        </div>

        <div className="p-5 sm:p-6">
          {duplicates.length > 0 ? (
            <div
              role="alert"
              data-testid="duplicate-warning"
              className="mb-5 rounded-lg border border-[var(--status-warning)]/25 bg-[var(--status-warning-background)]/40 px-4 py-3 text-sm text-[var(--status-warning-foreground)]"
            >
              <p className="font-semibold">Possible duplicate record</p>
              <p className="mt-0.5 text-xs opacity-90">
                Review matching records before creating a new MRN.
              </p>
              <ul className="mt-2 space-y-1.5">
                {duplicates.map((duplicate) => (
                  <li
                    key={duplicate.id}
                    className="rounded-md bg-background/50 px-2.5 py-1.5 font-mono text-xs"
                  >
                    {duplicate.mrn} — {duplicate.firstName} {duplicate.lastName} —{" "}
                    {duplicate.matchReason.replace("_", " ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : duplicateState === "checking" ? (
            <p
              className="mb-5 flex items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Checking for possible duplicates…
            </p>
          ) : duplicateState === "clear" ? (
            <p
              className="mb-5 flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="duplicate-clear"
              aria-live="polite"
            >
              <CheckCircle2 className="size-3.5 text-[var(--status-normal)]" aria-hidden="true" />
              No possible duplicates found for the phone, date of birth or national ID entered.
            </p>
          ) : null}

          {registrationIsMinor ? (
            <div className="mb-5 rounded-lg border border-[var(--status-warning)]/25 bg-[var(--status-warning-background)]/40 px-4 py-3 text-sm text-[var(--status-warning-foreground)]">
              Minor patient: guardian/next of kin details and guardian consent are required before
              registration.
            </div>
          ) : null}

          <form onSubmit={onSubmit} noValidate className="space-y-7">
            <div>
              <SectionHeading
                step="1"
                title="Identity"
                description="Basic patient details for the medical record."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name *</Label>
                  <Input
                    id="firstName"
                    data-testid="patient-first-name"
                    className={FIELD_CLASS}
                    {...register("firstName")}
                  />
                  <FieldError message={errors.firstName?.message} />
                </div>
                <div>
                  <Label htmlFor="lastName">Last name *</Label>
                  <Input
                    id="lastName"
                    data-testid="patient-last-name"
                    className={FIELD_CLASS}
                    {...register("lastName")}
                  />
                  <FieldError message={errors.lastName?.message} />
                </div>
                <div>
                  <Label htmlFor="otherNames">Other names</Label>
                  <Input id="otherNames" className={FIELD_CLASS} {...register("otherNames")} />
                </div>
                <div>
                  <Label htmlFor="sex">Sex *</Label>
                  <select
                    id="sex"
                    data-testid="patient-sex"
                    className={SELECT_CLASS}
                    {...register("sex")}
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="dob">Date of birth</Label>
                  <Input
                    id="dob"
                    type="date"
                    data-testid="patient-dob"
                    className={FIELD_CLASS}
                    {...register("dob")}
                  />
                  <FieldError message={errors.dob?.message} />
                </div>
                <div>
                  <Label htmlFor="estimatedAge">Estimated age (years)</Label>
                  <Input
                    id="estimatedAge"
                    type="number"
                    min="0"
                    max="120"
                    placeholder="If DOB unknown"
                    className={FIELD_CLASS}
                    {...register("estimatedAge")}
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-border/70 pt-6">
              <SectionHeading
                step="2"
                title="Contact and payer"
                description="How to reach the patient and how the visit is billed."
              />
              <div className="grid gap-4 sm:grid-cols-2">
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
                <div className="sm:col-span-2">
                  <Label htmlFor="address">Address</Label>
                  <Input id="address" className={FIELD_CLASS} {...register("address")} />
                </div>
                <div>
                  <Label htmlFor="payerType">Payer</Label>
                  <select id="payerType" className={SELECT_CLASS} {...register("payerType")}>
                    <option value="cash">Cash</option>
                    <option value="sha">SHA</option>
                    <option value="insurance">Insurance</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="payerMemberNo">Member number</Label>
                  <Input
                    id="payerMemberNo"
                    className={FIELD_CLASS}
                    {...register("payerMemberNo")}
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-border/70 pt-6">
              <SectionHeading
                step="3"
                title="Clinical safety and next of kin"
                description="Allergies, blood group and an emergency contact."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="allergies">Allergies (comma separated)</Label>
                  <Input
                    id="allergies"
                    className={FIELD_CLASS}
                    placeholder="e.g. Penicillin, Nuts"
                    {...register("allergies")}
                  />
                </div>
                <div>
                  <Label htmlFor="bloodGroup">Blood group</Label>
                  <Input
                    id="bloodGroup"
                    className={FIELD_CLASS}
                    placeholder="e.g. O+"
                    {...register("bloodGroup")}
                  />
                </div>
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
                <div className="sm:col-span-2">
                  <Label htmlFor="kinPhone">Next of kin phone</Label>
                  <Input id="kinPhone" className={FIELD_CLASS} {...register("kinPhone")} />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4 rounded-lg bg-muted/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex items-start gap-3 text-sm" htmlFor="startVisit">
                <input
                  id="startVisit"
                  type="checkbox"
                  data-testid="start-visit-checkbox"
                  className="mt-0.5 size-4 accent-[var(--brand-navy)]"
                  {...register("startVisit")}
                />
                <span>
                  <span className="font-medium text-foreground">
                    Start visit and queue to triage
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Creates the encounter and places the patient in the triage queue after
                    registration.
                  </span>
                </span>
              </label>

              <Button
                type="submit"
                data-testid="register-patient"
                disabled={pending}
                className="sm:min-w-44"
              >
                <UserPlus aria-hidden="true" />
                {pending ? "Registering…" : "Register patient"}
              </Button>
            </div>
          </form>
        </div>
      </div>

      <dialog
        ref={consentDialogRef}
        aria-labelledby="registration-consent-title"
        aria-describedby="registration-consent-desc"
        className="m-auto w-full max-w-xl rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
        data-testid="registration-consent-dialog"
        onCancel={(event) => {
          event.preventDefault();
          consentDialogRef.current?.close();
        }}
      >
        <form
          method="dialog"
          className="space-y-5 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmConsent();
          }}
        >
          <div className="space-y-1">
            <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              Required before saving
            </p>
            <h3 id="registration-consent-title" className="text-base font-semibold text-foreground">
              Capture consent
            </h3>
            <p
              id="registration-consent-desc"
              className="text-sm leading-6 text-muted-foreground"
            >
              {pendingValues && resolvedDob(pendingValues) && isMinorDob(resolvedDob(pendingValues)!)
                ? "Guardian consent for a minor is required. The consent text is versioned and its SHA-256 hash will be stored."
                : "Treatment consent is captured at registration. The consent text is versioned and its SHA-256 hash will be stored."}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
              className="mt-1.5 min-h-32 w-full rounded-lg border border-input bg-transparent p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={consentText}
              onChange={(event) => setConsentText(event.target.value)}
              required
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Review the text shown to the patient or guardian. Only the version and hash of this
              text are stored.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => consentDialogRef.current?.close()}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="registration-consent-confirm"
              disabled={pending}
            >
              {pending ? "Saving…" : "Confirm consent & register"}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
