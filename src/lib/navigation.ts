import type { Role } from "@/server/db/schema/staff";

export interface NavItem {
  label: string;
  href: string;
  description: string;
  group?: string;
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
  procurement_officer: {
    label: "Procurement",
    href: "/procurement",
    description: "Raise requisitions, compare quotes and manage purchase orders.",
  },
  store_manager: {
    label: "Procurement",
    href: "/procurement",
    description: "Receive goods, set reorder levels and review stock valuation.",
  },
  hr_officer: {
    label: "HR",
    href: "/hr",
    description: "Maintain employees, contracts, shifts, attendance and leave.",
  },
  payroll_officer: {
    label: "Payroll",
    href: "/payroll",
    description: "Prepare, approve and post payslips and statutory summaries.",
  },
  asset_manager: {
    label: "Assets",
    href: "/assets",
    description: "Track assets, depreciation, maintenance, valuation and disposal.",
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
  dpo: {
    label: "Privacy",
    href: "/admin/privacy",
    description: "Manage consents, data-subject requests, breaches and chart access.",
  },
  admin: {
    label: "Administration",
    href: "/admin",
    description: "Manage staff, facilities, catalogues and audit.",
  },
  super_admin: {
    label: "Administration",
    href: "/admin",
    description: "Configure the installation and manage all facilities and staff.",
  },
};

/**
 * Every role keeps one primary workspace so guards, redirects and audit
 * labels stay stable. Roles whose day spans more than one screen get extra
 * entries; the sidebar groups them by task instead of hiding them behind
 * a single link.
 */
export const ROLE_NAV_ITEMS: Record<Role, NavItem[]> = {
  ...(Object.fromEntries(
    Object.entries(ROLE_NAV).map(([role, item]) => [
      role,
      [{ ...item, group: "Workspace" }],
    ]),
  ) as Record<Role, NavItem[]>),
  receptionist: [
    {
      label: "Reception",
      href: "/reception",
      description: "Check patients in and keep the visit queue moving.",
      group: "Front desk",
    },
    {
      label: "Queue",
      href: "/reception/queue",
      description: "Watch every waiting patient and their wait time.",
      group: "Front desk",
    },
    {
      label: "Patient registry",
      href: "/reception/patients",
      description: "Search the facility's patient records.",
      group: "Patients",
    },
  ],
};

export const ROLE_HOME: Record<Role, string> = Object.fromEntries(
  Object.entries(ROLE_NAV).map(([role, item]) => [role, item.href]),
) as Record<Role, string>;

/**
 * Front-line staff are bound to the branch they report to. Their header shows
 * that branch as a title. Switching is reserved for roles whose job spans
 * facilities, and even then only when the account actually has more than one.
 */
export const FACILITY_SWITCH_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "procurement_officer",
  "store_manager",
  "hr_officer",
  "payroll_officer",
  "asset_manager",
  "auditor",
  "regulatory_officer",
  "dpo",
  "admin",
  "super_admin",
];

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
  procurement_officer: "Procurement Officer",
  store_manager: "Store Manager",
  hr_officer: "HR Officer",
  payroll_officer: "Payroll Officer",
  asset_manager: "Asset Manager",
  auditor: "Auditor",
  regulatory_officer: "Regulatory Officer",
  dpo: "Data Protection Officer",
  admin: "Administrator",
  super_admin: "Super Administrator",
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
  "procurement_officer",
  "store_manager",
  "hr_officer",
  "payroll_officer",
  "asset_manager",
  "auditor",
  "regulatory_officer",
  "dpo",
  "admin",
  "super_admin",
];

/** ERP roles may read finance screens; only finance roles may write. */
export const FINANCE_READ_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "auditor",
  "admin",
  "super_admin",
];

export const FINANCE_WRITE_ROLES: Role[] = ["accountant", "finance_officer", "admin", "super_admin"];

/** Roles that may read payer, authorisation and claim data. */
export const REVENUE_READ_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "cashier",
  "auditor",
  "admin",
  "super_admin",
];

export const REVENUE_WRITE_ROLES: Role[] = [
  "revenue_cycle_officer",
  "finance_officer",
  "cashier",
  "admin",
  "super_admin",
];

/** SHA/SHIF revenue cycle: revenue owns claims, finance owns cash and reconciliation. */
export const SHA_READ_ROLES: Role[] = [...REVENUE_READ_ROLES];

export const SHA_SETUP_ROLES: Role[] = ["revenue_cycle_officer", "admin", "super_admin"];

export const SHA_ELIGIBILITY_ROLES: Role[] = [
  "cashier",
  "revenue_cycle_officer",
  "admin",
  "super_admin",
];

/** Prompt 22 approvals belong to the revenue owner; finance roles only handle cash. */
export const SHA_APPROVAL_ROLES: Role[] = ["revenue_cycle_officer", "admin", "super_admin"];

export const SHA_CLAIM_ROLES: Role[] = ["revenue_cycle_officer", "admin", "super_admin"];

/** Cashier verifies eligibility and records the patient co-pay before a claim exists. */
export const SHA_CO_PAY_ROLES: Role[] = ["cashier", "admin", "super_admin"];

export const SHA_FINANCE_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "admin",
  "super_admin",
];

export const SHA_WRITE_ROLES: Role[] = Array.from(
  new Set<Role>([
    ...SHA_SETUP_ROLES,
    ...SHA_ELIGIBILITY_ROLES,
    ...SHA_CO_PAY_ROLES,
    ...SHA_APPROVAL_ROLES,
    ...SHA_CLAIM_ROLES,
    ...SHA_FINANCE_ROLES,
  ]),
);

/** Procurement and stock roles may read purchasing documents and inventory reports. */
export const PROCUREMENT_READ_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "procurement_officer",
  "store_manager",
  "pharmacist",
  "auditor",
  "admin",
  "super_admin",
];

export const PROCUREMENT_WRITE_ROLES: Role[] = [
  "procurement_officer",
  "store_manager",
  "finance_officer",
  "admin",
  "super_admin",
];

/** Personnel data is restricted: HR maintains it, payroll consumes it, audit reads it. */
export const HR_READ_ROLES: Role[] = [
  "hr_officer",
  "payroll_officer",
  "auditor",
  "admin",
  "super_admin",
];

export const HR_WRITE_ROLES: Role[] = ["hr_officer", "admin", "super_admin"];

export const PAYROLL_READ_ROLES: Role[] = [
  "payroll_officer",
  "hr_officer",
  "auditor",
  "admin",
  "super_admin",
];

export const PAYROLL_WRITE_ROLES: Role[] = ["payroll_officer", "admin", "super_admin"];

/** Asset registers and maintenance history are visible to finance, audit and assets. */
export const ASSET_READ_ROLES: Role[] = [
  "asset_manager",
  "accountant",
  "finance_officer",
  "procurement_officer",
  "store_manager",
  "auditor",
  "admin",
  "super_admin",
];

export const ASSET_WRITE_ROLES: Role[] = ["asset_manager", "finance_officer", "admin", "super_admin"];

/**
 * Management reports read across finance, revenue, purchasing, stock, payroll
 * and assets. Every ERP manager can generate and save a view; the underlying
 * documents remain writable only through their own guarded workspaces.
 */
export const REPORT_READ_ROLES: Role[] = [
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "procurement_officer",
  "store_manager",
  "hr_officer",
  "payroll_officer",
  "asset_manager",
  "auditor",
  "admin",
  "super_admin",
];

export const REPORT_WRITE_ROLES: Role[] = REPORT_READ_ROLES;
