"use client";

import {
  Banknote,
  ClipboardList,
  Clock3,
  FlaskConical,
  HeartPulse,
  Landmark,
  Package,
  Pill,
  Receipt,
  ShieldCheck,
  ShieldPlus,
  ShoppingCart,
  Stethoscope,
  UserPlus,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { REPORT_READ_ROLES, ROLE_LABELS, ROLE_NAV_ITEMS } from "@/lib/navigation";
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
  asset_manager: Wrench,
  auditor: ShieldCheck,
  regulatory_officer: ShieldCheck,
  dpo: ShieldCheck,
  admin: ShieldCheck,
  super_admin: ShieldCheck,
};

const ITEM_ICONS: Record<string, LucideIcon> = {
  "/reception": ClipboardList,
  "/reception/queue": Clock3,
  "/reception/register": UserPlus,
  "/reception/patients": Users,
  "/reports": ClipboardList,
};

interface SidebarProps {
  role: Role | null;
  onNavigate?: () => void;
  className?: string;
  branchName?: string | null;
  facilityName?: string | null;
}

interface NavGroup {
  label: string;
  items: ReturnType<typeof navItemsFor>;
}

function navItemsFor(role: Role) {
  return ROLE_NAV_ITEMS[role] ?? [];
}

function activeHref(pathname: string, hrefs: string[]): string | null {
  const matches = hrefs.filter(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

function groupItems(role: Role): NavGroup[] {
  const groups = new Map<string, ReturnType<typeof navItemsFor>>();
  for (const item of navItemsFor(role)) {
    const group = item.group ?? "Workspace";
    const bucket = groups.get(group) ?? [];
    bucket.push(item);
    groups.set(group, bucket);
  }
  return Array.from(groups, ([label, items]) => ({ label, items }));
}

export function Sidebar({
  role,
  onNavigate,
  className,
  branchName,
  facilityName,
}: SidebarProps) {
  const pathname = usePathname();
  const items = role ? navItemsFor(role) : [];
  const canViewReports = role ? REPORT_READ_ROLES.includes(role) : false;
  const reportsActive =
    pathname === "/reports" || pathname.startsWith("/reports/");
  const currentHref = activeHref(
    pathname,
    canViewReports ? [...items.map((item) => item.href), "/reports"] : items.map((item) => item.href),
  );
  const groups = role ? groupItems(role) : [];

  return (
    <aside
      className={cn(
        "flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="px-5 py-5">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-sidebar-primary shadow-sm">
            <ShieldPlus className="size-5 text-sidebar-primary-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-wide">Varian HMIS</div>
            <div className="truncate font-mono text-[10px] tracking-[0.16em] text-sidebar-foreground/60 uppercase">
              Patient care system
            </div>
          </div>
        </div>
      </div>

      <nav aria-label="Role navigation" className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {groups.length > 0 ? (
          groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pb-1.5 font-mono text-[10px] tracking-[0.16em] text-sidebar-foreground/50 uppercase">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = ITEM_ICONS[item.href] ?? (role ? ROLE_ICONS[role] : ClipboardList);
                  const active = currentHref === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        active
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                      )}
                    >
                      {active ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-primary"
                        />
                      ) : null}
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-sidebar-primary" : "text-sidebar-foreground/55",
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <p className="px-3 py-2 text-sm text-sidebar-foreground/70">No role assigned.</p>
        )}

        {canViewReports ? (
          <div>
            <div className="px-2 pb-1.5 font-mono text-[10px] tracking-[0.16em] text-sidebar-foreground/50 uppercase">
              Insights
            </div>
            <Link
              href="/reports"
              data-testid="nav-reports"
              aria-current={reportsActive ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                reportsActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
              )}
            >
              <ClipboardList
                className={cn(
                  "size-4 shrink-0",
                  reportsActive ? "text-sidebar-primary" : "text-sidebar-foreground/55",
                )}
                aria-hidden="true"
              />
              <span>Reports</span>
            </Link>
          </div>
        ) : null}
      </nav>

      <div className="border-t border-sidebar-border px-5 py-4">
        <div className="font-mono text-[10px] tracking-[0.16em] text-sidebar-foreground/50 uppercase">
          Signed in as
        </div>
        <div className="mt-1 truncate text-sm font-medium">
          {role ? ROLE_LABELS[role] : "Staff"}
        </div>
        {branchName ? (
          <div className="mt-0.5 truncate text-xs text-sidebar-foreground/60">
            {branchName}
            {facilityName ? ` · ${facilityName}` : ""}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
