"use client";

import { Menu, X } from "lucide-react";
import { useState } from "react";

import { Sidebar } from "@/components/shell/sidebar";
import type { Role } from "@/server/db/schema/staff";

interface MobileNavProps {
  role: Role | null;
  branchName?: string | null;
  facilityName?: string | null;
}

export function MobileNav({ role, branchName, facilityName }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mobile-sidebar"
      >
        <Menu className="size-4" aria-hidden="true" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-950/45"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-sidebar"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="absolute inset-y-0 left-0 w-[min(20rem,calc(100vw-1.5rem))] shadow-2xl"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-md text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label="Close navigation menu"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            <div className="h-full [&>aside]:flex [&>aside]:h-full [&>aside]:w-full">
              <Sidebar
                role={role}
                branchName={branchName}
                facilityName={facilityName}
                onNavigate={() => setOpen(false)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
