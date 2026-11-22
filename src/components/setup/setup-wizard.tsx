"use client";

import { CheckCircle2, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type BranchDraft = {
  code: string;
  name: string;
  physicalLocation: string;
  telephone: string;
  managerName: string;
  isMain: boolean;
};

type SetupDraft = {
  admin: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    phone: string;
    staffNumber: string;
  };
  facility: {
    code: string;
    name: string;
    registrationDetails: string;
    physicalAddress: string;
    county: string;
    phone: string;
    email: string;
    logoUrl: string;
    currency: string;
    timezone: string;
    writeAuthority: "cloud" | "clinic";
  };
  branches: BranchDraft[];
};

const STEPS = ["Administrator", "Facility", "Branches", "Review"] as const;

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "00000000-0000-4000-8000-000000000000";
}

const initialDraft: SetupDraft = {
  admin: {
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
    staffNumber: "SA-001",
  },
  facility: {
    code: "",
    name: "",
    registrationDetails: "",
    physicalAddress: "",
    county: "",
    phone: "",
    email: "",
    logoUrl: "",
    currency: "KES",
    timezone: "Africa/Nairobi",
    writeAuthority: "cloud",
  },
  branches: [
    {
      code: "MAIN",
      name: "Main Branch",
      physicalLocation: "",
      telephone: "",
      managerName: "",
      isMain: true,
    },
  ],
};

function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SetupDraft>(initialDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(createIdempotencyKey);

  const canGoBack = step > 0 && !pending;

  function updateAdmin<K extends keyof SetupDraft["admin"]>(key: K, value: SetupDraft["admin"][K]) {
    setDraft((current) => ({ ...current, admin: { ...current.admin, [key]: value } }));
  }
  function updateFacility<K extends keyof SetupDraft["facility"]>(
    key: K,
    value: SetupDraft["facility"][K],
  ) {
    setDraft((current) => ({ ...current, facility: { ...current.facility, [key]: value } }));
  }
  function updateBranch(index: number, patch: Partial<BranchDraft>) {
    setDraft((current) => ({
      ...current,
      branches: current.branches.map((branch, i) => (i === index ? { ...branch, ...patch } : branch)),
    }));
  }
  function addBranch() {
    setDraft((current) => ({
      ...current,
      branches: [
        ...current.branches,
        {
          code: "",
          name: "",
          physicalLocation: "",
          telephone: "",
          managerName: "",
          isMain: false,
        },
      ],
    }));
  }
  function removeBranch(index: number) {
    setDraft((current) => {
      const branches = current.branches.filter((_, i) => i !== index);
      if (branches.length > 0 && !branches.some((b) => b.isMain)) branches[0].isMain = true;
      return { ...current, branches };
    });
  }
  function setMainBranch(index: number) {
    setDraft((current) => ({
      ...current,
      branches: current.branches.map((branch, i) => ({ ...branch, isMain: i === index })),
    }));
  }

  function validateCurrentStep(): string | null {
    if (step === 0) {
      const a = draft.admin;
      if (!a.name.trim()) return "Administrator name is required.";
      if (!a.email.trim()) return "Administrator email is required.";
      if (!a.phone.trim()) return "Administrator phone number is required.";
      if (a.password.length < 10) return "Password must be at least 10 characters.";
      if (a.password !== a.confirmPassword) return "Passwords do not match.";
      if (!a.staffNumber.trim()) return "Staff number is required.";
    }
    if (step === 1) {
      const f = draft.facility;
      if (!f.code.trim()) return "Facility code is required.";
      if (!f.name.trim()) return "Facility name is required.";
      if (!f.physicalAddress.trim()) return "Physical address is required.";
      if (!f.phone.trim()) return "Facility phone number is required.";
      if (!f.email.trim()) return "Facility email is required.";
      if (!f.currency.trim() || f.currency.trim().length !== 3) return "Currency must be a 3-letter code.";
      if (!f.timezone.trim()) return "Time zone is required.";
      if (f.logoUrl.trim()) {
        try {
          new URL(f.logoUrl.trim());
        } catch {
          return "Logo URL must be a valid URL.";
        }
      }
    }
    if (step === 2) {
      if (draft.branches.length === 0) return "At least one branch is required.";
      const codes = new Set<string>();
      let mainCount = 0;
      for (const [i, branch] of draft.branches.entries()) {
        if (!branch.code.trim()) return `Branch ${i + 1}: code is required.`;
        if (!branch.name.trim()) return `Branch ${i + 1}: name is required.`;
        const normalized = branch.code.trim().toUpperCase();
        if (codes.has(normalized)) return `Branch code ${normalized} is duplicated.`;
        codes.add(normalized);
        if (branch.isMain) mainCount += 1;
      }
      if (mainCount !== 1) return "Exactly one branch must be marked as main.";
    }
    return null;
  }

  function next() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  const reviewPayload = useMemo(() => {
    return {
      idempotencyKey,
      admin: {
        name: draft.admin.name.trim(),
        email: draft.admin.email.trim(),
        password: draft.admin.password,
        phone: draft.admin.phone.trim() || null,
        staffNumber: draft.admin.staffNumber.trim() || "SA-001",
      },
      facility: {
        code: draft.facility.code.trim().toUpperCase(),
        name: draft.facility.name.trim(),
        registrationDetails: draft.facility.registrationDetails.trim() || null,
        physicalAddress: draft.facility.physicalAddress.trim() || null,
        county: draft.facility.county.trim() || null,
        phone: draft.facility.phone.trim() || null,
        email: draft.facility.email.trim() || null,
        logoUrl: draft.facility.logoUrl.trim() || null,
        currency: draft.facility.currency.trim().toUpperCase() || "KES",
        timezone: draft.facility.timezone.trim() || "Africa/Nairobi",
        writeAuthority: draft.facility.writeAuthority,
      },
      branches: draft.branches.map((b) => ({
        code: b.code.trim().toUpperCase(),
        name: b.name.trim(),
        physicalLocation: b.physicalLocation.trim() || null,
        telephone: b.telephone.trim() || null,
        managerName: b.managerName.trim() || null,
        isMain: b.isMain,
      })),
    };
  }, [draft, idempotencyKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewPayload),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(data?.error || "Setup failed.");
      }
      toast.success("Initial setup complete. You can now sign in.");
      window.location.assign("/login");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          {STEPS.map((label, index) => {
            const active = index === step;
            const done = index < step;
            return (
              <div
                key={label}
                className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : done
                      ? "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                      : "bg-secondary text-muted-foreground"
                }`}
              >
                {done ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : null}
                <span>{index + 1}. {label}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Create the first super administrator, register the facility, configure branches, then review before saving.
        </p>
      </div>

      <form onSubmit={submit} className="px-6 py-6 space-y-6">
        {step === 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="admin-name" label="Full name">
              <Input id="admin-name" value={draft.admin.name} onChange={(e) => updateAdmin("name", e.target.value)} required />
            </Field>
            <Field id="admin-email" label="Email address">
              <Input id="admin-email" type="email" autoComplete="email" value={draft.admin.email} onChange={(e) => updateAdmin("email", e.target.value)} required />
            </Field>
            <Field id="admin-phone" label="Phone number">
              <Input id="admin-phone" value={draft.admin.phone} onChange={(e) => updateAdmin("phone", e.target.value)} required />
            </Field>
            <Field id="admin-staff-number" label="Staff number">
              <Input id="admin-staff-number" value={draft.admin.staffNumber} onChange={(e) => updateAdmin("staffNumber", e.target.value)} required />
            </Field>
            <Field id="admin-password" label="Password" hint="At least 10 characters.">
              <Input id="admin-password" type="password" autoComplete="new-password" value={draft.admin.password} onChange={(e) => updateAdmin("password", e.target.value)} required />
            </Field>
            <Field id="admin-confirm-password" label="Confirm password">
              <Input id="admin-confirm-password" type="password" autoComplete="new-password" value={draft.admin.confirmPassword} onChange={(e) => updateAdmin("confirmPassword", e.target.value)} required />
            </Field>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="facility-code" label="Facility code">
              <Input id="facility-code" value={draft.facility.code} onChange={(e) => updateFacility("code", e.target.value)} required />
            </Field>
            <Field id="facility-name" label="Hospital / facility name">
              <Input id="facility-name" value={draft.facility.name} onChange={(e) => updateFacility("name", e.target.value)} required />
            </Field>
            <Field id="facility-registration" label="Registration details">
              <Input id="facility-registration" value={draft.facility.registrationDetails} onChange={(e) => updateFacility("registrationDetails", e.target.value)} />
            </Field>
            <Field id="facility-county" label="County / region">
              <Input id="facility-county" value={draft.facility.county} onChange={(e) => updateFacility("county", e.target.value)} />
            </Field>
            <Field id="facility-address" label="Physical address">
              <Input id="facility-address" value={draft.facility.physicalAddress} onChange={(e) => updateFacility("physicalAddress", e.target.value)} required />
            </Field>
            <Field id="facility-phone" label="Contact phone">
              <Input id="facility-phone" value={draft.facility.phone} onChange={(e) => updateFacility("phone", e.target.value)} required />
            </Field>
            <Field id="facility-email" label="Contact email">
              <Input id="facility-email" type="email" value={draft.facility.email} onChange={(e) => updateFacility("email", e.target.value)} required />
            </Field>
            <Field id="facility-logo" label="Logo / branding URL" hint="Use a URL or document reference until file storage is available.">
              <Input id="facility-logo" type="url" value={draft.facility.logoUrl} onChange={(e) => updateFacility("logoUrl", e.target.value)} placeholder="https://..." />
            </Field>
            <Field id="facility-timezone" label="Time zone">
              <Input id="facility-timezone" value={draft.facility.timezone} onChange={(e) => updateFacility("timezone", e.target.value)} required />
            </Field>
            <Field id="facility-currency" label="Currency" hint="3-letter code, e.g. KES.">
              <Input id="facility-currency" value={draft.facility.currency} onChange={(e) => updateFacility("currency", e.target.value.toUpperCase())} maxLength={3} required />
            </Field>
            <Field id="facility-write-authority" label="Write authority">
              <select
                id="facility-write-authority"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={draft.facility.writeAuthority}
                onChange={(e) => updateFacility("writeAuthority", e.target.value as "cloud" | "clinic")}
              >
                <option value="cloud">Cloud</option>
                <option value="clinic">Clinic</option>
              </select>
            </Field>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            {draft.branches.map((branch, index) => (
              <div key={index} className="rounded-lg border border-border p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">Branch {index + 1}</div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="radio"
                        name="main-branch"
                        checked={branch.isMain}
                        onChange={() => setMainBranch(index)}
                      />
                      Main branch
                    </label>
                    {draft.branches.length > 1 ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeBranch(index)}>
                        <Trash2 className="size-4" aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field id={`branch-code-${index}`} label="Branch code">
                    <Input id={`branch-code-${index}`} value={branch.code} onChange={(e) => updateBranch(index, { code: e.target.value })} required />
                  </Field>
                  <Field id={`branch-name-${index}`} label="Branch name">
                    <Input id={`branch-name-${index}`} value={branch.name} onChange={(e) => updateBranch(index, { name: e.target.value })} required />
                  </Field>
                  <Field id={`branch-location-${index}`} label="Physical location">
                    <Input id={`branch-location-${index}`} value={branch.physicalLocation} onChange={(e) => updateBranch(index, { physicalLocation: e.target.value })} />
                  </Field>
                  <Field id={`branch-phone-${index}`} label="Telephone number">
                    <Input id={`branch-phone-${index}`} value={branch.telephone} onChange={(e) => updateBranch(index, { telephone: e.target.value })} />
                  </Field>
                  <Field id={`branch-manager-${index}`} label="Branch manager (optional)">
                    <Input id={`branch-manager-${index}`} value={branch.managerName} onChange={(e) => updateBranch(index, { managerName: e.target.value })} />
                  </Field>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={addBranch}>
              <Plus className="size-4" aria-hidden="true" />
              Add branch
            </Button>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm font-semibold text-foreground">Administrator</div>
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                <div><dt className="text-muted-foreground">Name</dt><dd>{reviewPayload.admin.name}</dd></div>
                <div><dt className="text-muted-foreground">Email</dt><dd>{reviewPayload.admin.email}</dd></div>
                <div><dt className="text-muted-foreground">Phone</dt><dd>{reviewPayload.admin.phone || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Staff number</dt><dd>{reviewPayload.admin.staffNumber}</dd></div>
              </dl>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm font-semibold text-foreground">Facility</div>
              <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                <div><dt className="text-muted-foreground">Code</dt><dd>{reviewPayload.facility.code}</dd></div>
                <div><dt className="text-muted-foreground">Name</dt><dd>{reviewPayload.facility.name}</dd></div>
                <div><dt className="text-muted-foreground">Registration</dt><dd>{reviewPayload.facility.registrationDetails || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Physical address</dt><dd>{reviewPayload.facility.physicalAddress || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Contact</dt><dd>{reviewPayload.facility.phone || "—"} · {reviewPayload.facility.email || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Timezone / Currency</dt><dd>{reviewPayload.facility.timezone} · {reviewPayload.facility.currency}</dd></div>
                <div><dt className="text-muted-foreground">Logo URL</dt><dd className="break-all">{reviewPayload.facility.logoUrl || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Write authority</dt><dd>{reviewPayload.facility.writeAuthority}</dd></div>
              </dl>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm font-semibold text-foreground">Branches</div>
              <div className="mt-3 space-y-2">
                {reviewPayload.branches.map((b) => (
                  <div key={b.code} className="rounded-md bg-secondary/50 px-3 py-2 text-sm">
                    <div className="font-medium">{b.name} <span className="text-muted-foreground">({b.code}){b.isMain ? " · Main" : ""}</span></div>
                    <div className="text-muted-foreground">{b.physicalLocation || "No location"} · {b.telephone || "No telephone"} · {b.managerName || "No manager"}</div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              This creates records through a server-side transaction. The password is hashed and never stored in plain text. You can change these details later through normal admin workflows.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-[var(--status-critical-background)] px-3 py-2 text-sm text-[var(--status-critical-foreground)]">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button type="button" variant="outline" onClick={back} disabled={!canGoBack}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={next}>
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          ) : (
            <Button type="submit" disabled={pending}>
              {pending ? "Completing setup…" : "Complete installation"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
