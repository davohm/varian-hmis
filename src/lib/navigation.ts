import type { Role } from "@/server/db/schema/staff";

export interface NavItem {
  label: string;
  href: string;
  description: string;
}

export const ROLE_NAV: Record<Role, NavItem> = {
  receptionist: {
    label: "Reception",
    href: "/reception",
    description: "Register patients and manage the visit queue.",
  },
  triage_nurse: {
    label: "Triage",
    href: "/triage",
    description: "Record vitals and assign triage category.",
  },
  doctor: {
    label: "Consultation",
    href: "/doctor",
    description: "Review patients, order tests and prescribe treatment.",
  },
  lab_tech: {
    label: "Laboratory",
    href: "/lab",
    description: "Collect samples and verify results.",
  },
  pharmacist: {
    label: "Pharmacy",
    href: "/pharmacy",
    description: "Dispense medicines from current stock batches.",
  },
  cashier: {
    label: "Cashier",
    href: "/cashier",
    description: "Bill visits and record payments.",
  },
  accountant: {
    label: "Finance",
    href: "/finance",
    description: "Post journals, close periods and prove the ledger.",
  },
  finance_officer: {
    label: "Finance",
    href: "/finance",
    description: "Manage bank accounts, reconciliations and revenue.",
  },
  revenue_cycle_officer: {
    label: "Revenue cycle",
    href: "/finance/revenue",
    description: "Manage payers, pre-authorisation, claims and remittances.",
  },
  auditor: {
    label: "Audit",
    href: "/finance",
    description: "Read the ledger, trial balance and audit trail.",
  },
  regulatory_officer: {
    label: "Regulatory",
    href: "/admin/regulatory",
    description: "Maintain licences, regulatory identifiers and readiness.",
  },
  admin: {
    label: "Administration",
    href: "/admin",
    description: "Manage staff, facilities, catalogues and audit.",
  },
};

export const ROLE_HOME: Record<Role, string> = Object.fromEntries(
  Object.entries(ROLE_NAV).map(([role, item]) => [role, item.href]),
) as Record<Role, string>;

export const ROLE_LABELS: Record<Role, string> = {
  receptionist: "Receptionist",
  triage_nurse: "Triage Nurse",
  doctor: "Doctor",
  lab_tech: "Laboratory Technician",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  accountant: "Accountant",
  finance_officer: "Finance Officer",
  revenue_cycle_officer: "Revenue Cycle Officer",
  auditor: "Auditor",
  regulatory_officer: "Regulatory Officer",
  admin: "Administrator",
};

/** Roles an administrator can assign, in display order. */
export const ASSIGNABLE_ROLES: Role[] = [
  "receptionist",
  "triage_nurse",
  "doctor",
  "lab_tech",
  "pharmacist",
  "cashier",
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "auditor",
  "regulatory_officer",
  "admin",
];

/** ERP roles may read finance screens; only finance roles may write. */
export const FINANCE_READ_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "auditor",
  "admin",
];

export const FINANCE_WRITE_ROLES: Role[] = ["accountant", "finance_officer", "admin"];

export const REVENUE_WRITE_ROLES: Role[] = [
  "revenue_cycle_officer",
  "finance_officer",
  "cashier",
  "admin",
];
