import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { isConsentValid, toDateOnly } from "@/lib/privacy";
import { db } from "@/server/db/client";
import {
  chartAccessLog,
  dataBreaches,
  dataConsents,
  dataSharingAgreements,
  dataSubjectRequests,
  patients,
  retentionPolicies,
  transferAssessments,
} from "@/server/db/schema";

export type PrivacyDatabase = typeof db;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ConsentRow {
  id: string;
  facilityId: string;
  patientId: string;
  patientName: string | null;
  patientMrn: string | null;
  consentType: string;
  consentVersion: string;
  granted: boolean;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  source: string | null;
  createdAt: Date;
  isValid: boolean;
}

export async function listConsents(
  database: PrivacyDatabase,
  facilityId: string,
  options: { patientId?: string; consentType?: string; limit?: number } = {},
): Promise<ConsentRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const conditions = [eq(dataConsents.facilityId, facilityId)];
  if (options.patientId) conditions.push(eq(dataConsents.patientId, options.patientId));
  if (options.consentType) conditions.push(eq(dataConsents.consentType, options.consentType));

  const rows = await database
    .select({
      id: dataConsents.id,
      facilityId: dataConsents.facilityId,
      patientId: dataConsents.patientId,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      patientMrn: patients.mrn,
      consentType: dataConsents.consentType,
      consentVersion: dataConsents.consentVersion,
      granted: dataConsents.granted,
      grantedAt: dataConsents.grantedAt,
      withdrawnAt: dataConsents.withdrawnAt,
      validFrom: dataConsents.validFrom,
      validTo: dataConsents.validTo,
      source: dataConsents.source,
      createdAt: dataConsents.createdAt,
    })
    .from(dataConsents)
    .leftJoin(patients, eq(patients.id, dataConsents.patientId))
    .where(and(...conditions))
    .orderBy(desc(dataConsents.createdAt), desc(dataConsents.version))
    .limit(limit);

  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facilityId,
    patientId: row.patientId,
    patientName:
      row.patientFirstName || row.patientLastName
        ? `${row.patientFirstName ?? ""} ${row.patientLastName ?? ""}`.trim()
        : null,
    patientMrn: row.patientMrn,
    consentType: row.consentType,
    consentVersion: row.consentVersion,
    granted: row.granted,
    grantedAt: row.grantedAt,
    withdrawnAt: row.withdrawnAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    source: row.source,
    createdAt: row.createdAt,
    isValid: isConsentValid(
      {
        granted: row.granted,
        withdrawnAt: row.withdrawnAt,
        validFrom: row.validFrom,
        validTo: row.validTo,
      },
      now,
    ),
  }));
}

export interface ConsentStatus {
  patientId: string;
  consentType: string;
  status: "valid" | "missing" | "withdrawn" | "expired" | "not_granted";
  currentConsentId: string | null;
  currentVersion: string | null;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
}

export async function getConsentStatus(
  database: PrivacyDatabase,
  facilityId: string,
  patientId: string,
  consentType: string,
): Promise<ConsentStatus> {
  const rows = await database
    .select()
    .from(dataConsents)
    .where(
      and(
        eq(dataConsents.facilityId, facilityId),
        eq(dataConsents.patientId, patientId),
        eq(dataConsents.consentType, consentType),
      ),
    )
    .orderBy(desc(dataConsents.createdAt), desc(dataConsents.version));

  if (rows.length === 0) {
    return {
      patientId,
      consentType,
      status: "missing",
      currentConsentId: null,
      currentVersion: null,
      grantedAt: null,
      withdrawnAt: null,
      validFrom: null,
      validTo: null,
    };
  }

  const now = new Date();
  const today = toDateOnly(now);
  const current = rows[0]!;
  const base = {
    patientId,
    consentType,
    currentConsentId: current.id,
    currentVersion: current.consentVersion,
    grantedAt: current.grantedAt,
    withdrawnAt: current.withdrawnAt,
    validFrom: current.validFrom,
    validTo: current.validTo,
  };

  if (isConsentValid(current, now)) {
    return { ...base, status: "valid" };
  }
  if (current.withdrawnAt) {
    return { ...base, status: "withdrawn" };
  }
  if (!current.granted) {
    return { ...base, status: "not_granted" };
  }
  if (current.validTo && toDateOnly(current.validTo) < today) {
    return { ...base, status: "expired" };
  }
  if (current.validFrom && toDateOnly(current.validFrom) > today) {
    return { ...base, status: "missing" };
  }
  // Superseded by newer version or otherwise not currently valid.
  return { ...base, status: "missing" };
}

export interface DataSubjectRequestRow {
  id: string;
  facilityId: string;
  patientId: string;
  patientName: string | null;
  patientMrn: string | null;
  requestType: string;
  status: string;
  receivedAt: Date | null;
  dueAt: Date | null;
  completedAt: Date | null;
  identityVerified: boolean;
  outcome: string | null;
  overdue: boolean;
}

export async function listDataSubjectRequests(
  database: PrivacyDatabase,
  facilityId: string,
  options: { status?: string; overdueOnly?: boolean } = {},
): Promise<DataSubjectRequestRow[]> {
  const conditions = [eq(dataSubjectRequests.facilityId, facilityId)];
  if (options.status) conditions.push(eq(dataSubjectRequests.status, options.status));

  const rows = await database
    .select({
      id: dataSubjectRequests.id,
      facilityId: dataSubjectRequests.facilityId,
      patientId: dataSubjectRequests.patientId,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      patientMrn: patients.mrn,
      requestType: dataSubjectRequests.requestType,
      status: dataSubjectRequests.status,
      receivedAt: dataSubjectRequests.receivedAt,
      dueAt: dataSubjectRequests.dueAt,
      completedAt: dataSubjectRequests.completedAt,
      identityVerified: dataSubjectRequests.identityVerified,
      outcome: dataSubjectRequests.outcome,
    })
    .from(dataSubjectRequests)
    .leftJoin(patients, eq(patients.id, dataSubjectRequests.patientId))
    .where(and(...conditions))
    .orderBy(desc(dataSubjectRequests.receivedAt));

  const now = new Date();
  const mapped = rows.map((row) => {
    const due = row.dueAt ? new Date(row.dueAt) : null;
    const overdue = Boolean(
      due && !row.completedAt && !["completed", "rejected"].includes(row.status) && due.getTime() < now.getTime(),
    );
    return {
      id: row.id,
      facilityId: row.facilityId,
      patientId: row.patientId,
      patientName:
        row.patientFirstName || row.patientLastName
          ? `${row.patientFirstName ?? ""} ${row.patientLastName ?? ""}`.trim()
          : null,
      patientMrn: row.patientMrn,
      requestType: row.requestType,
      status: row.status,
      receivedAt: row.receivedAt,
      dueAt: row.dueAt,
      completedAt: row.completedAt,
      identityVerified: row.identityVerified,
      outcome: row.outcome,
      overdue,
    };
  });
  return options.overdueOnly ? mapped.filter((r) => r.overdue) : mapped;
}

export async function getOverdueDataSubjectRequests(
  database: PrivacyDatabase,
  facilityId: string,
): Promise<DataSubjectRequestRow[]> {
  return listDataSubjectRequests(database, facilityId, { overdueOnly: true });
}

export interface BreachRow {
  id: string;
  facilityId: string;
  reference: string;
  discoveredAt: Date;
  containedAt: Date | null;
  odpcNotifiedAt: Date | null;
  affectedSubjects: number | null;
  severity: string;
  status: string;
  description: string | null;
}

export async function listBreaches(
  database: PrivacyDatabase,
  facilityId: string,
  options: { status?: string } = {},
): Promise<BreachRow[]> {
  const conditions = [eq(dataBreaches.facilityId, facilityId)];
  if (options.status) conditions.push(eq(dataBreaches.status, options.status));
  return database
    .select({
      id: dataBreaches.id,
      facilityId: dataBreaches.facilityId,
      reference: dataBreaches.reference,
      discoveredAt: dataBreaches.discoveredAt,
      containedAt: dataBreaches.containedAt,
      odpcNotifiedAt: dataBreaches.odpcNotifiedAt,
      affectedSubjects: dataBreaches.affectedSubjects,
      severity: dataBreaches.severity,
      status: dataBreaches.status,
      description: dataBreaches.description,
    })
    .from(dataBreaches)
    .where(and(...conditions))
    .orderBy(desc(dataBreaches.discoveredAt));
}

export async function listOverdueBreaches(
  database: PrivacyDatabase,
  facilityId: string,
): Promise<BreachRow[]> {
  // High-severity unnotified breaches must be surfaced for alerting.
  return database
    .select({
      id: dataBreaches.id,
      facilityId: dataBreaches.facilityId,
      reference: dataBreaches.reference,
      discoveredAt: dataBreaches.discoveredAt,
      containedAt: dataBreaches.containedAt,
      odpcNotifiedAt: dataBreaches.odpcNotifiedAt,
      affectedSubjects: dataBreaches.affectedSubjects,
      severity: dataBreaches.severity,
      status: dataBreaches.status,
      description: dataBreaches.description,
    })
    .from(dataBreaches)
    .where(
      and(
        eq(dataBreaches.facilityId, facilityId),
        eq(dataBreaches.severity, "high"),
        isNull(dataBreaches.odpcNotifiedAt),
      ),
    )
    .orderBy(desc(dataBreaches.discoveredAt));
}

export async function listRetentionDue(
  database: PrivacyDatabase,
  facilityId: string,
): Promise<Array<typeof retentionPolicies.$inferSelect>> {
  const now = new Date();
  const today = todayIso();
  return database
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.facilityId, facilityId),
        or(
          and(
            isNotNull(retentionPolicies.destroyAfter),
            sql`${retentionPolicies.destroyAfter} <= ${today}::date`,
            eq(retentionPolicies.legalHold, false),
          ),
          and(isNotNull(retentionPolicies.reviewAt), lte(retentionPolicies.reviewAt, now)),
        ),
      ),
    )
    .orderBy(asc(retentionPolicies.reviewAt), asc(retentionPolicies.destroyAfter));
}

export async function listSharingAgreements(
  database: PrivacyDatabase,
  facilityId: string,
): Promise<Array<typeof dataSharingAgreements.$inferSelect>> {
  return database
    .select()
    .from(dataSharingAgreements)
    .where(eq(dataSharingAgreements.facilityId, facilityId))
    .orderBy(desc(dataSharingAgreements.createdAt));
}

export async function listTransferAssessments(
  database: PrivacyDatabase,
  facilityId: string,
): Promise<Array<typeof transferAssessments.$inferSelect>> {
  return database
    .select()
    .from(transferAssessments)
    .where(eq(transferAssessments.facilityId, facilityId))
    .orderBy(desc(transferAssessments.createdAt));
}

export interface ChartAccessRow {
  id: string;
  facilityId: string;
  patientId: string;
  patientName: string | null;
  patientMrn: string | null;
  userId: string | null;
  accessedAt: Date;
  accessType: string | null;
  reason: string | null;
  deviceId: string | null;
  ip: string | null;
}

export async function getChartAccessHistory(
  database: PrivacyDatabase,
  facilityId: string,
  options: { patientId?: string; limit?: number } = {},
): Promise<ChartAccessRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const conditions = [eq(chartAccessLog.facilityId, facilityId)];
  if (options.patientId) conditions.push(eq(chartAccessLog.patientId, options.patientId));

  const rows = await database
    .select({
      id: chartAccessLog.id,
      facilityId: chartAccessLog.facilityId,
      patientId: chartAccessLog.patientId,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      patientMrn: patients.mrn,
      userId: chartAccessLog.userId,
      accessedAt: chartAccessLog.accessedAt,
      accessType: chartAccessLog.accessType,
      reason: chartAccessLog.reason,
      deviceId: chartAccessLog.deviceId,
      ip: chartAccessLog.ip,
    })
    .from(chartAccessLog)
    .leftJoin(patients, eq(patients.id, chartAccessLog.patientId))
    .where(and(...conditions))
    .orderBy(desc(chartAccessLog.accessedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facilityId,
    patientId: row.patientId,
    patientName:
      row.patientFirstName || row.patientLastName
        ? `${row.patientFirstName ?? ""} ${row.patientLastName ?? ""}`.trim()
        : null,
    patientMrn: row.patientMrn,
    userId: row.userId,
    accessedAt: row.accessedAt,
    accessType: row.accessType,
    reason: row.reason,
    deviceId: row.deviceId,
    ip: row.ip,
  }));
}
