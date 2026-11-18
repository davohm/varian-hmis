import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

type QueryResult = { rows?: Array<Record<string, unknown>> };

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as QueryResult).rows ?? [];
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

export interface QueueRow {
  id: string;
  encounterId: string;
  patientId: string;
  mrn: string;
  firstName: string;
  lastName: string;
  encounterNo: string;
  department: string;
  priority: "red" | "yellow" | "green" | "normal";
  status: "waiting" | "called" | "in_service" | "done" | "cancelled";
  queuedAt: string;
}

/** Queue order is clinical priority first, then arrival time. */
export async function getActiveQueue(
  db: DbExecutor,
  facilityId: string,
  department = "Triage",
): Promise<QueueRow[]> {
  const result = await db.execute(sql`
    SELECT q.id, q.encounter_id, q.patient_id, q.department, q.priority, q.status,
      q.queued_at, p.mrn, p.first_name, p.last_name, e.encounter_no
    FROM queue_entries q
    INNER JOIN patients p ON p.id = q.patient_id AND p.facility_id = q.facility_id
    INNER JOIN encounters e ON e.id = q.encounter_id AND e.facility_id = q.facility_id
    WHERE q.facility_id = ${facilityId}::uuid
      AND q.department = ${department}
      AND q.status IN ('waiting', 'called', 'in_service')
    ORDER BY
      CASE q.priority WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'green' THEN 2 ELSE 3 END,
      q.queued_at ASC
  `);

  return rowsFrom(result).map((row) => ({
    id: text(row.id),
    encounterId: text(row.encounter_id),
    patientId: text(row.patient_id),
    mrn: text(row.mrn),
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    encounterNo: text(row.encounter_no),
    department: text(row.department),
    priority: (["red", "yellow", "green", "normal"].includes(text(row.priority))
      ? text(row.priority)
      : "normal") as QueueRow["priority"],
    status: (["waiting", "called", "in_service", "done", "cancelled"].includes(text(row.status))
      ? text(row.status)
      : "waiting") as QueueRow["status"],
    queuedAt: text(row.queued_at),
  }));
}
