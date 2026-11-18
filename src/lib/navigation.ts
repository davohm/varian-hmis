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
  admin: "Administrator",
};
