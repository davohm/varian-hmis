"use client";

import { useState } from "react";

import { CheckInPanel, type SearchResult } from "@/components/reception/check-in-panel";
import {
  FrontDeskTable,
  type FrontDeskPatient,
} from "@/components/reception/front-desk-table";
import type { QueueEntry } from "@/components/reception/queue-table";

export function ReceptionWorkspace({
  recentPatients = [],
  triageQueue = [],
}: {
  recentPatients?: FrontDeskPatient[];
  triageQueue?: QueueEntry[];
}) {
  const [selectedPatient, setSelectedPatient] = useState<SearchResult | null>(null);

  return (
    <div className="space-y-6">
      <CheckInPanel
        selectedPatient={selectedPatient}
        onSelectedPatientChange={setSelectedPatient}
        onCheckedIn={() => setSelectedPatient(null)}
      />
      <FrontDeskTable
        patients={recentPatients}
        queue={triageQueue}
        onCheckIn={setSelectedPatient}
        limit={8}
      />
    </div>
  );
}
