"use client";

import {
  Banknote,
  ClipboardList,
  FlaskConical,
  HeartPulse,
  Landmark,
  Package,
  Pill,
  Receipt,
  ShieldCheck,
  ShoppingCart,
  ShieldPlus,
  Stethoscope,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ROLE_LABELS, ROLE_NAV } from "@/lib/navigation";
import type { Role } from "@/server/db/schema/staff";
import { cn } from "@/lib/utils";

const ROLE_ICONS: Record<Role, LucideIcon> = {
  receptionist: ClipboardList,
  triage_nurse: HeartPulse,
  doctor: Stethoscope,
  lab_tech: FlaskConical,
  pharmacist: Pill,
  cashier: Receipt,
  accountant: Landmark,
  finance_officer: Banknote,
  revenue_cycle_officer: Receipt,
  procurement_officer: ShoppingCart,
  store_manager: Package,
  hr_officer: Users,
  payroll_officer: Wallet,
  auditor: ShieldCheck,
  regulatory_officer: ShieldCheck,
  dpo: ShieldCheck,
  admin: ShieldCheck,
};

interface SidebarProps {
  role: Role | null;
}

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname();
  const item = role ? ROLE_NAV[role] : null;
  const Icon = role ? ROLE_ICONS[role] : ClipboardList;
  const active = item
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : false;

  return (
    <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-5 py-5">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md bg-sidebar-primary">
            <ShieldPlus className="size-5 text-sidebar-primary-foreground" aria-hidden="true" />
          </span>
          <div>
            <div className="text-sm font-semibold tracking-wide">Varian HMIS</div>
            <div className="font-mono text-[10px] tracking-[0.18em] text-sidebar-foreground/65 uppercase">
              Patient care system
            </div>
          </div>
        </div>
      </div>

      <nav aria-label="Role navigation" className="flex-1 px-3 py-4">
        <div className="px-2 pb-2 font-mono text-[10px] tracking-[0.18em] text-sidebar-foreground/60 uppercase">
          Workspace
        </div>
        {item ? (
          <Link
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            {active ? (
              <span
                aria-hidden="true"
                className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-primary"
              />
            ) : null}
            <Icon className="size-4" aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        ) : (
          <p className="px-3 py-2 text-sm text-sidebar-foreground/70">No role assigned.</p>
        )}
      </nav>

      <div className="border-t border-sidebar-border px-5 py-4">
        <div className="font-mono text-[10px] tracking-[0.18em] text-sidebar-foreground/60 uppercase">
          Signed in as
        </div>
        <div className="mt-1 text-sm font-medium">{role ? ROLE_LABELS[role] : "Staff"}</div>
      </div>
    </aside>
  );
}
