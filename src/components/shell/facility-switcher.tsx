"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { SessionFacility } from "@/server/auth/guards";

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
      <select
        aria-label="Facility"
        className="h-9 rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <select
        aria-label="Branch"
        className="h-9 rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  );
}
