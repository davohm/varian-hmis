import { redirect } from "next/navigation";

import { FacilitySwitcher } from "@/components/shell/facility-switcher";
import { Sidebar } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { getSessionContext, requireStaff } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { APP_MODE } from "@/server/env";
import { getSyncStatus } from "@/server/sync/outbox";
import { ROLE_LABELS } from "@/lib/navigation";

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

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-2.5">
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase lg:block">
              Facility
            </span>
            <div className="hidden h-5 w-px bg-border lg:block" aria-hidden="true" />
            <FacilitySwitcher
              facilities={context.facilities}
              activeFacilityId={context.activeFacilityId}
              activeBranchId={context.activeBranchId}
            />
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium ${connectionClasses}`}
              data-testid="connection-status"
            >
              <span className={`size-2 rounded-full ${connectionDot}`} aria-hidden="true" />
              {connectionLabel}
            </span>
            <UserMenu name={staff.user.name} email={staff.user.email} roleLabel={roleLabel} />
          </div>
        </header>
        <main id="main-content" className="min-w-0 flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
