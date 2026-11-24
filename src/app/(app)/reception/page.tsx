import { ClipboardList, UserPlus } from "lucide-react";
import Link from "next/link";

import { ReceptionWorkspace } from "@/components/reception/reception-workspace";
import { Screen } from "@/components/shell/screen";
import { Button } from "@/components/ui/button";
import { requireScreen } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { listPatients } from "@/server/queries/patients";
import { getActiveQueue } from "@/server/queries/queue";

const RECENT_PATIENT_COUNT = 12;

export default async function ReceptionPage() {
  const staff = await requireScreen(["receptionist"]);

  // The check-in panel and the combined patient-flow table are server-rendered
  // on first paint. The client still refreshes them live after hydration.
  const [{ rows: recentPatients }, triageQueue] = await Promise.all([
    listPatients(db, staff.facilityId, "", RECENT_PATIENT_COUNT, 0),
    getActiveQueue(db, staff.facilityId, "Triage"),
  ]);

  return (
    <Screen
      title="Front desk"
      description="Check patients in, start visits, and keep an eye on who is waiting for triage."
      testId="screen-reception"
      role={staff.role}
      eyebrow="Front desk"
      actions={
        <>
          <Button variant="outline" nativeButton={false} render={<Link href="/reception/patients" />}>
            <ClipboardList aria-hidden="true" />
            Patient registry
          </Button>
          <Button nativeButton={false} render={<Link href="/reception/register" />}>
            <UserPlus aria-hidden="true" />
            Register patient
          </Button>
        </>
      }
    >
      <ReceptionWorkspace recentPatients={recentPatients} triageQueue={triageQueue} />
    </Screen>
  );
}
