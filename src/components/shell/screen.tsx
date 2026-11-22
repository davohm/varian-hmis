import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  Boxes,
  Building2,
  ClipboardCheck,
  ClipboardList,
  FileText,
  FlaskConical,
  HeartPulse,
  Landmark,
  BookOpen,
  Scale,
  Wallet,
  FileSignature,
  Package,
  Pill,
  Receipt,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import { ROLE_LABELS } from "@/lib/navigation";
import type { Role } from "@/server/db/schema/staff";

interface WorkspaceTask {
  label: string;
  description: string;
  icon: LucideIcon;
}

const WORKSPACE_TASKS: Record<Role, WorkspaceTask[]> = {
  receptionist: [
    {
      label: "Patient registry",
      description: "Find or register patients and allocate MRNs.",
      icon: ClipboardList,
    },
    {
      label: "Visit queue",
      description: "Check patients in and route them to triage.",
      icon: Users,
    },
    {
      label: "Patient journey",
      description: "Move encounters through every clinical handoff.",
      icon: ArrowRight,
    },
  ],
  triage_nurse: [
    {
      label: "Triage queue",
      description: "Prioritise patients and see who is waiting.",
      icon: HeartPulse,
    },
    {
      label: "Observations",
      description: "Record vitals and assign a triage category.",
      icon: Activity,
    },
    {
      label: "Routing",
      description: "Send patients to the right clinician and room.",
      icon: ArrowRight,
    },
  ],
  doctor: [
    {
      label: "SOAP notes",
      description: "Record the clinical assessment and plan.",
      icon: FileText,
    },
    {
      label: "Orders and results",
      description: "Review lab tests and return findings.",
      icon: FlaskConical,
    },
    {
      label: "Prescriptions",
      description: "Send treatment to the pharmacy worklist.",
      icon: Pill,
    },
  ],
  lab_tech: [
    {
      label: "Sample worklist",
      description: "Collect and track specimens in order.",
      icon: FlaskConical,
    },
    {
      label: "Result entry",
      description: "Record parameters against reference ranges.",
      icon: ClipboardCheck,
    },
    {
      label: "Verification",
      description: "Confirm results before the doctor sees them.",
      icon: ShieldCheck,
    },
  ],
  pharmacist: [
    {
      label: "Dispense queue",
      description: "Work prescriptions in clinical order.",
      icon: Pill,
    },
    {
      label: "Batch stock",
      description: "Pick from FEFO batches and manage expiry.",
      icon: Boxes,
    },
    {
      label: "Stock movements",
      description: "Receive, adjust and transfer ledger entries.",
      icon: Package,
    },
  ],
  cashier: [
    {
      label: "Billing",
      description: "Build charges from the completed visit.",
      icon: Receipt,
    },
    {
      label: "Payments",
      description: "Take cash, M-Pesa, card or insurance tenders.",
      icon: Banknote,
    },
    {
      label: "Receipts",
      description: "Issue immutable sequential receipts.",
      icon: FileText,
    },
  ],
  accountant: [
    {
      label: "General ledger",
      description: "Post balanced journals and prove the ledger.",
      icon: BookOpen,
    },
    {
      label: "Trial balance",
      description: "Check debits equal credits before you close.",
      icon: Scale,
    },
    {
      label: "Period close",
      description: "Close fiscal periods with an audited trail.",
      icon: ClipboardCheck,
    },
  ],
  finance_officer: [
    {
      label: "Banking",
      description: "Manage bank accounts and reconciliations.",
      icon: Landmark,
    },
    {
      label: "Cash position",
      description: "See cash, bank and receivables at a glance.",
      icon: Wallet,
    },
    {
      label: "Revenue cycle",
      description: "Track payers, claims and remittances.",
      icon: Receipt,
    },
  ],
  revenue_cycle_officer: [
    {
      label: "Payers and contracts",
      description: "Maintain schemes, contracts and benefits.",
      icon: FileSignature,
    },
    {
      label: "Pre-authorisation",
      description: "Request, approve and track guarantees.",
      icon: ClipboardCheck,
    },
    {
      label: "Claims",
      description: "Submit, rework and settle claims.",
      icon: Receipt,
    },
  ],
  procurement_officer: [
    {
      label: "Requisitions",
      description: "Raise requests and compare supplier quotes.",
      icon: ClipboardList,
    },
    {
      label: "Purchase orders",
      description: "Approve LPOs and follow receipt status.",
      icon: FileSignature,
    },
    {
      label: "Supplier invoices",
      description: "Match invoices to orders and received goods.",
      icon: Receipt,
    },
  ],
  store_manager: [
    {
      label: "Goods receipt",
      description: "Receive orders into stock with batch and expiry details.",
      icon: Package,
    },
    {
      label: "Reorder levels",
      description: "Watch items below their minimum quantity.",
      icon: Boxes,
    },
    {
      label: "Stock valuation",
      description: "Review on-hand value from the append-only ledger.",
      icon: Wallet,
    },
  ],
  auditor: [
    {
      label: "Ledger review",
      description: "Read posted journals and their source records.",
      icon: BookOpen,
    },
    {
      label: "Trial balance",
      description: "Confirm the ledger balances without editing.",
      icon: Scale,
    },
    {
      label: "Audit trail",
      description: "Trace every financial write to its actor.",
      icon: ScrollText,
    },
  ],
  regulatory_officer: [
    {
      label: "Readiness",
      description: "See which licences and identifiers are current.",
      icon: ShieldCheck,
    },
    {
      label: "Licences",
      description: "Record facility, practitioner and service licences.",
      icon: FileSignature,
    },
    {
      label: "Statutory settings",
      description: "Maintain the regulator values the facility depends on.",
      icon: ScrollText,
    },
  ],
  dpo: [
    {
      label: "Privacy inbox",
      description: "Review consents, data-subject requests and breaches.",
      icon: ShieldCheck,
    },
    {
      label: "Chart access",
      description: "Inspect chart access history and restricted records.",
      icon: ScrollText,
    },
    {
      label: "Retention and sharing",
      description: "Track retention, sharing agreements and transfers.",
      icon: FileSignature,
    },
  ],
  admin: [
    {
      label: "Staff and roles",
      description: "Manage staff accounts and facility scopes.",
      icon: Users,
    },
    {
      label: "Facility setup",
      description: "Configure branches, stores and catalogues.",
      icon: Building2,
    },
    {
      label: "Audit and sync",
      description: "Review writes and connection health.",
      icon: ScrollText,
    },
  ],
};

interface ScreenProps {
  title: string;
  description: string;
  testId: string;
  role?: Role | null;
  children?: React.ReactNode;
}

export function Screen({ title, description, testId, role, children }: ScreenProps) {
  const tasks = role ? WORKSPACE_TASKS[role] : null;

  return (
    <section data-testid={testId} className="mx-auto w-full max-w-6xl">
      <header className="border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            Varian HMIS · Workspace
          </span>
          {role ? (
            <span className="inline-flex items-center rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
              {ROLE_LABELS[role]}
            </span>
          ) : null}
        </div>
        <h1 className="mt-3 text-2xl font-semibold text-primary">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </header>

      {children ? (
        <div className="mt-6">{children}</div>
      ) : (
        <div className="mt-6 space-y-6">
          {tasks ? (
            <div className="grid gap-4 md:grid-cols-3">
              {tasks.map((task) => {
                const Icon = task.icon;
                return (
                  <div
                    key={task.label}
                    className="group relative flex flex-col rounded-lg border border-border bg-card p-5"
                  >
                    <span className="grid size-9 place-items-center rounded-md bg-secondary text-primary">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="mt-4 text-sm font-semibold">{task.label}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {task.description}
                    </p>
                    <ArrowUpRight
                      className="mt-4 size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground">
            Operational forms and queues arrive in the next build stage.
          </div>
        </div>
      )}
    </section>
  );
}
