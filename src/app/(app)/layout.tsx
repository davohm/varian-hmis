import { Building2 } from "lucide-react";
import { redirect } from "next/navigation";

import { FacilitySwitcher } from "@/components/shell/facility-switcher";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { getSessionContext, requireStaff } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { APP_MODE } from "@/server/env";
import { getSyncStatus } from "@/server/sync/outbox";
import { FACILITY_SWITCH_ROLES, ROLE_LABELS } from "@/lib/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff([]);
  const context = await getSessionContext();
  if (!context) redirect("/login");

  const role = staff.role;
  const roleLabel = role ? ROLE_LABELS[role] : "Staff";

  let connectionLabel = "Online";
  let connectionTone = "normal" as "normal" | "warning" | "critical";
  if (APP_MODE === "clinic") {
    const sync = await getSyncStatus(db, context.activeFacilityId);
    if (sync.pendingCount > 0) {
      connectionLabel = "Syncing";
      connectionTone = "warning";
    } else if (sync.syncEnabled && !sync.lastSuccessAt && !sync.lastPulledAt) {
      connectionLabel = "Offline";
      connectionTone = "critical";
    }
  }
  const connectionClasses = {
    normal: "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
    warning: "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
    critical: "bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  }[connectionTone];
  const connectionDot = {
    normal: "bg-[var(--status-normal)]",
    warning: "bg-[var(--status-warning)]",
    critical: "bg-[var(--status-critical)]",
  }[connectionTone];

  const activeFacility =
    context.facilities.find((facility) => facility.id === context.activeFacilityId) ??
    context.facilities[0] ??
    null;
  const activeBranch =
    activeFacility?.branches.find((branch) => branch.id === context.activeBranchId) ??
    activeFacility?.branches[0] ??
    null;
  const canSwitch =
    Boolean(role && FACILITY_SWITCH_ROLES.includes(role)) &&
    context.facilities.length > 1;
  const branchName = activeBranch?.name ?? activeFacility?.name ?? "Assigned facility";

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar
        role={role}
        className="sticky top-0 hidden h-screen lg:flex"
        branchName={branchName}
        facilityName={activeFacility?.name ?? null}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <MobileNav
              role={role}
              branchName={branchName}
              facilityName={activeFacility?.name ?? null}
            />
            {canSwitch ? (
              <FacilitySwitcher
                facilities={context.facilities}
                activeFacilityId={context.activeFacilityId}
                activeBranchId={context.activeBranchId}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-2.5" data-testid="facility-context">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
                  <Building2 className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {branchName}
                  </div>
                  {activeFacility?.name ? (
                    <div className="truncate text-[11px] leading-4 text-muted-foreground">
                      {activeFacility.name}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span
              className={`inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs font-medium ${connectionClasses}`}
              data-testid="connection-status"
            >
              <span className={`size-1.5 rounded-full ${connectionDot}`} aria-hidden="true" />
              {connectionLabel}
            </span>
            <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
            <UserMenu name={staff.user.name} email={staff.user.email} roleLabel={roleLabel} />
          </div>
        </header>
        <main id="main-content" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
