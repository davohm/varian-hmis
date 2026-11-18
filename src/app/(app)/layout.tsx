import { redirect } from "next/navigation";

import { FacilitySwitcher } from "@/components/shell/facility-switcher";
import { Sidebar } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { getSessionContext, requireStaff } from "@/server/auth/guards";
import { ROLE_LABELS } from "@/lib/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff([]);
  const context = await getSessionContext();
  if (!context) redirect("/login");

  const role = staff.role;
  const roleLabel = role ? ROLE_LABELS[role] : "Staff";

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
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              {context.facilities.find((item) => item.id === context.activeFacilityId)?.code ?? "FAM"}
            </div>
            <div className="truncate text-sm font-medium">
              {context.facilities.find((item) => item.id === context.activeFacilityId)?.name ??
                "Family Afya Modern Medical Centre"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FacilitySwitcher
              facilities={context.facilities}
              activeFacilityId={context.activeFacilityId}
              activeBranchId={context.activeBranchId}
            />
            <span
              className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground"
              data-testid="connection-status"
            >
              <span className="size-2 rounded-full bg-[var(--status-normal)]" aria-hidden="true" />
              Online
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
