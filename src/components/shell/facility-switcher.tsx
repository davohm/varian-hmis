"use client";

import { Building2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { SessionFacility } from "@/server/auth/guards";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-card pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 appearance-none";

interface FacilitySwitcherProps {
  facilities: SessionFacility[];
  activeFacilityId: string | null;
  activeBranchId: string | null;
}

export function FacilitySwitcher({
  facilities,
  activeFacilityId,
  activeBranchId,
}: FacilitySwitcherProps) {
  const router = useRouter();
  const [facilityId, setFacilityId] = useState(activeFacilityId ?? facilities[0]?.id ?? "");
  const [branchId, setBranchId] = useState(activeBranchId ?? "");
  const [saving, setSaving] = useState(false);

  const facility = facilities.find((item) => item.id === facilityId);

  useEffect(() => {
    setFacilityId(activeFacilityId ?? facilities[0]?.id ?? "");
    setBranchId(activeBranchId ?? "");
  }, [activeFacilityId, activeBranchId, facilities]);

  async function activate(nextFacilityId: string, nextBranchId: string) {
    setSaving(true);
    try {
      const response = await fetch("/api/session/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          facilityId: nextFacilityId,
          branchId: nextBranchId || null,
        }),
      });
      if (!response.ok) throw new Error("Selection rejected");
      router.refresh();
    } catch {
      toast.error("Could not change the active facility.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2" data-testid="facility-switcher">
      <div className="relative w-56">
        <Building2
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <select
          aria-label="Facility"
          className={SELECT_CLASS}
          value={facilityId}
          disabled={saving}
          onChange={(event) => {
            const next = event.target.value;
            setFacilityId(next);
            const nextBranch = facilities.find((item) => item.id === next)?.branches[0]?.id ?? "";
            setBranchId(nextBranch);
            void activate(next, nextBranch);
          }}
        >
          {facilities.map((item) => (
            <option key={item.id} value={item.id}>
              {item.code} · {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="relative w-44">
        <MapPin
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <select
          aria-label="Branch"
          className={SELECT_CLASS}
          value={branchId}
          disabled={saving || !facility?.branches.length}
          onChange={(event) => {
            const next = event.target.value;
            setBranchId(next);
            void activate(facilityId, next);
          }}
        >
          {!facility?.branches.length ? <option value="">No branches</option> : null}
          {facility?.branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
