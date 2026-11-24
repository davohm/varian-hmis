"use client";

import { useCheckIn } from "@/components/reception/check-in-context";
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
  const { selectedPatient, setSelectedPatient, checkIn, checkingIn } = useCheckIn();

  return (
    <FrontDeskTable
      patients={recentPatients}
      queue={triageQueue}
      selectedPatient={selectedPatient}
      onSelectPatient={setSelectedPatient}
      onStartVisit={checkIn}
      checkingIn={checkingIn}
      limit={8}
    />
  );
}
