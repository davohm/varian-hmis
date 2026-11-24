"use client";

import Link from "next/link";

import { CheckInPanel } from "@/components/reception/check-in-panel";
import { QueueTable, type QueueEntry } from "@/components/reception/queue-table";
import { Button } from "@/components/ui/button";

interface RecentPatient {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  createdAt?: string;
}

export function ReceptionWorkspace({
  recentPatients = [],
  triageQueue,
}: {
  recentPatients?: RecentPatient[];
  triageQueue?: QueueEntry[];
}) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <CheckInPanel recentPatients={recentPatients} />
      <QueueTable
        department="Triage"
        title="Waiting for triage"
        testId="reception-queue"
        compact
        limit={6}
        initialEntries={triageQueue}
        action={
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/reception/queue" />}>
            Full queue
          </Button>
        }
      />
    </div>
  );
}
