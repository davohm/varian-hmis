import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { fromCents, toCents } from "@/lib/billing";
import { claimOutstanding } from "@/lib/finance";
import { db } from "@/server/db/client";
import {
  claimDenials,
  claimLines,
  claims,
  payers,
  patients,
  payerBenefits,
  payerContracts,
  preAuthorizations,
  remittances,
} from "@/server/db/schema";

export type RevenueDatabase = typeof db;

/* ------------------------------------------------------------------ */
/* Payers                                                              */
/* ------------------------------------------------------------------ */

export interface PayerRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
  contractCount: number;
}

export async function listPayers(
  database: RevenueDatabase,
  facilityId: string,
): Promise<PayerRow[]> {
  const rows = await database
    .select({
      id: payers.id,
      code: payers.code,
      name: payers.name,
      kind: payers.kind,
      contactName: payers.contactName,
      phone: payers.phone,
      email: payers.email,
      active: payers.active,
      contractCount: sql<number>`count(${payerContracts.id})::int`,
    })
    .from(payers)
    .leftJoin(payerContracts, eq(payerContracts.payerId, payers.id))
    .where(eq(payers.facilityId, facilityId))
    .groupBy(payers.id)
    .orderBy(asc(payers.name));
  return rows;
}

export interface PayerContractRow {
  id: string;
  payerId: string;
  payerName: string;
  contractNo: string;
  startDate: string;
  endDate: string;
  status: string;
  benefitCount: number;
}

export async function listPayerContracts(
  database: RevenueDatabase,
  facilityId: string,
): Promise<PayerContractRow[]> {
  return database
    .select({
      id: payerContracts.id,
      payerId: payerContracts.payerId,
      payerName: payers.name,
      contractNo: payerContracts.contractNo,
      startDate: payerContracts.startDate,
      endDate: payerContracts.endDate,
      status: payerContracts.status,
      benefitCount: sql<number>`(select count(*)::int from ${payerBenefits} where ${payerBenefits.contractId} = ${payerContracts.id})`,
    })
    .from(payerContracts)
    .innerJoin(payers, eq(payerContracts.payerId, payers.id))
    .where(eq(payerContracts.facilityId, facilityId))
    .orderBy(desc(payerContracts.startDate));
}

/* ------------------------------------------------------------------ */
/* Pre-authorisation                                                   */
/* ------------------------------------------------------------------ */

export interface PreAuthorizationRow {
  id: string;
  authNo: string;
  payerId: string;
  payerName: string;
  patientId: string;
  patientName: string;
  encounterId: string | null;
  requestedAmount: string;
  approvedAmount: string | null;
  status: string;
  reference: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listPreAuthorizations(
  database: RevenueDatabase,
  facilityId: string,
  status?: string,
): Promise<PreAuthorizationRow[]> {
  const conditions: SQL[] = [eq(preAuthorizations.facilityId, facilityId)];
  if (status) conditions.push(eq(preAuthorizations.status, status as never));

  const rows = await database
    .select({
      id: preAuthorizations.id,
      authNo: preAuthorizations.authNo,
      payerId: preAuthorizations.payerId,
      payerName: payers.name,
      patientId: preAuthorizations.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      encounterId: preAuthorizations.encounterId,
      requestedAmount: preAuthorizations.requestedAmount,
      approvedAmount: preAuthorizations.approvedAmount,
      status: preAuthorizations.status,
      reference: preAuthorizations.reference,
      expiresAt: preAuthorizations.expiresAt,
      createdAt: preAuthorizations.createdAt,
    })
    .from(preAuthorizations)
    .innerJoin(payers, eq(preAuthorizations.payerId, payers.id))
    .innerJoin(patients, eq(preAuthorizations.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(desc(preAuthorizations.createdAt))
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    authNo: row.authNo,
    payerId: row.payerId,
    payerName: row.payerName,
    patientId: row.patientId,
    patientName: `${row.firstName} ${row.lastName}`.trim(),
    encounterId: row.encounterId,
    requestedAmount: row.requestedAmount,
    approvedAmount: row.approvedAmount,
    status: row.status,
    reference: row.reference,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export interface ClaimRow {
  id: string;
  claimNo: string;
  payerId: string;
  payerName: string;
  patientId: string;
  patientName: string;
  encounterId: string;
  invoiceId: string | null;
  status: string;
  total: string;
  approvedAmount: string;
  paidAmount: string;
  outstanding: string;
  submittedAt: string | null;
  createdAt: string;
}

export interface ClaimFilters {
  status?: string;
  payerId?: string;
  limit?: number;
}

export async function listClaims(
  database: RevenueDatabase,
  facilityId: string,
  filters: ClaimFilters = {},
): Promise<ClaimRow[]> {
  const conditions: SQL[] = [eq(claims.facilityId, facilityId)];
  if (filters.status) conditions.push(eq(claims.status, filters.status as never));
  if (filters.payerId) conditions.push(eq(claims.payerId, filters.payerId));

  const rows = await database
    .select({
      id: claims.id,
      claimNo: claims.claimNo,
      payerId: claims.payerId,
      payerName: payers.name,
      patientId: claims.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      encounterId: claims.encounterId,
      invoiceId: claims.invoiceId,
      status: claims.status,
      total: claims.total,
      approvedAmount: claims.approvedAmount,
      paidAmount: claims.paidAmount,
      submittedAt: claims.submittedAt,
      createdAt: claims.createdAt,
    })
    .from(claims)
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .innerJoin(patients, eq(claims.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(desc(claims.createdAt))
    .limit(Math.min(Math.max(Math.trunc(filters.limit ?? 200), 1), 500));

  return rows.map((row) => {
    const target = toCents(row.approvedAmount) > 0 ? row.approvedAmount : row.total;
    return {
      id: row.id,
      claimNo: row.claimNo,
      payerId: row.payerId,
      payerName: row.payerName,
      patientId: row.patientId,
      patientName: `${row.firstName} ${row.lastName}`.trim(),
      encounterId: row.encounterId,
      invoiceId: row.invoiceId,
      status: row.status,
      total: row.total,
      approvedAmount: row.approvedAmount,
      paidAmount: row.paidAmount,
      outstanding: claimOutstanding(target, row.paidAmount),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export interface ClaimDetail extends ClaimRow {
  notes: string | null;
  lines: Array<{
    id: string;
    description: string;
    amount: string;
    approvedAmount: string;
    denialReason: string | null;
  }>;
  remittances: Array<{
    id: string;
    remittanceNo: string;
    amount: string;
    receivedAt: string;
    reference: string | null;
  }>;
  denials: Array<{
    id: string;
    amount: string;
    reason: string;
    status: string;
    resolutionNote: string | null;
    createdAt: string;
  }>;
}

export async function getClaim(
  database: RevenueDatabase,
  facilityId: string,
  claimId: string,
): Promise<ClaimDetail | null> {
  const headers = await database
    .select({
      id: claims.id,
      claimNo: claims.claimNo,
      payerId: claims.payerId,
      payerName: payers.name,
      patientId: claims.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      encounterId: claims.encounterId,
      invoiceId: claims.invoiceId,
      status: claims.status,
      total: claims.total,
      approvedAmount: claims.approvedAmount,
      paidAmount: claims.paidAmount,
      submittedAt: claims.submittedAt,
      createdAt: claims.createdAt,
      notes: claims.notes,
    })
    .from(claims)
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .innerJoin(patients, eq(claims.patientId, patients.id))
    .where(and(eq(claims.id, claimId), eq(claims.facilityId, facilityId)))
    .limit(1);
  const claim = headers[0];
  if (!claim) return null;

  const [lines, cash, denials] = await Promise.all([
    database
      .select({
        id: claimLines.id,
        description: claimLines.description,
        amount: claimLines.amount,
        approvedAmount: claimLines.approvedAmount,
        denialReason: claimLines.denialReason,
      })
      .from(claimLines)
      .where(and(eq(claimLines.claimId, claimId), eq(claimLines.facilityId, facilityId)))
      .orderBy(asc(claimLines.createdAt)),
    database
      .select({
        id: remittances.id,
        remittanceNo: remittances.remittanceNo,
        amount: remittances.amount,
        receivedAt: remittances.receivedAt,
        reference: remittances.reference,
      })
      .from(remittances)
      .where(and(eq(remittances.claimId, claimId), eq(remittances.facilityId, facilityId)))
      .orderBy(desc(remittances.receivedAt)),
    database
      .select({
        id: claimDenials.id,
        amount: claimDenials.amount,
        reason: claimDenials.reason,
        status: claimDenials.status,
        resolutionNote: claimDenials.resolutionNote,
        createdAt: claimDenials.createdAt,
      })
      .from(claimDenials)
      .where(and(eq(claimDenials.claimId, claimId), eq(claimDenials.facilityId, facilityId)))
      .orderBy(desc(claimDenials.createdAt)),
  ]);

  const target = toCents(claim.approvedAmount) > 0 ? claim.approvedAmount : claim.total;
  return {
    id: claim.id,
    claimNo: claim.claimNo,
    payerId: claim.payerId,
    payerName: claim.payerName,
    patientId: claim.patientId,
    patientName: `${claim.firstName} ${claim.lastName}`.trim(),
    encounterId: claim.encounterId,
    invoiceId: claim.invoiceId,
    status: claim.status,
    total: claim.total,
    approvedAmount: claim.approvedAmount,
    paidAmount: claim.paidAmount,
    outstanding: claimOutstanding(target, claim.paidAmount),
    submittedAt: claim.submittedAt ? claim.submittedAt.toISOString() : null,
    createdAt: claim.createdAt.toISOString(),
    notes: claim.notes,
    lines,
    remittances: cash.map((row) => ({
      ...row,
      receivedAt: row.receivedAt.toISOString(),
    })),
    denials: denials.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

/* ------------------------------------------------------------------ */
/* Remittances and denials                                             */
/* ------------------------------------------------------------------ */

export interface RemittanceRow {
  id: string;
  remittanceNo: string;
  claimId: string;
  claimNo: string;
  payerName: string;
  amount: string;
  receivedAt: string;
  reference: string | null;
}

export async function listRemittances(
  database: RevenueDatabase,
  facilityId: string,
  limit = 100,
): Promise<RemittanceRow[]> {
  const rows = await database
    .select({
      id: remittances.id,
      remittanceNo: remittances.remittanceNo,
      claimId: remittances.claimId,
      claimNo: claims.claimNo,
      payerName: payers.name,
      amount: remittances.amount,
      receivedAt: remittances.receivedAt,
      reference: remittances.reference,
    })
    .from(remittances)
    .innerJoin(claims, eq(remittances.claimId, claims.id))
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .where(eq(remittances.facilityId, facilityId))
    .orderBy(desc(remittances.receivedAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 500));
  return rows.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString() }));
}

export interface ClaimDenialRow {
  id: string;
  claimId: string;
  claimNo: string;
  payerName: string;
  amount: string;
  reason: string;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
}

export async function listClaimDenials(
  database: RevenueDatabase,
  facilityId: string,
  status?: string,
): Promise<ClaimDenialRow[]> {
  const conditions: SQL[] = [eq(claimDenials.facilityId, facilityId)];
  if (status) conditions.push(eq(claimDenials.status, status as never));

  const rows = await database
    .select({
      id: claimDenials.id,
      claimId: claimDenials.claimId,
      claimNo: claims.claimNo,
      payerName: payers.name,
      amount: claimDenials.amount,
      reason: claimDenials.reason,
      status: claimDenials.status,
      resolutionNote: claimDenials.resolutionNote,
      createdAt: claimDenials.createdAt,
    })
    .from(claimDenials)
    .innerJoin(claims, eq(claimDenials.claimId, claims.id))
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .where(and(...conditions))
    .orderBy(desc(claimDenials.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/* ------------------------------------------------------------------ */
/* Overview and ageing                                                 */
/* ------------------------------------------------------------------ */

export interface ClaimAgeingBucket {
  label: string;
  claimCount: number;
  outstanding: string;
}

export interface RevenueOverview {
  openClaims: number;
  openClaimValue: string;
  outstanding: string;
  paidThisMonth: string;
  openDenials: number;
  denialValue: string;
  pendingPreAuths: number;
  ageing: ClaimAgeingBucket[];
}

export async function getRevenueOverview(
  database: RevenueDatabase,
  facilityId: string,
): Promise<RevenueOverview> {
  const open = await listClaims(database, facilityId, { limit: 500 });
  const activeStatuses = new Set(["draft", "submitted", "accepted", "queried", "resubmitted"]);
  const active = open.filter((claim) => activeStatuses.has(claim.status));

  const now = Date.now();
  const buckets: Array<{ label: string; min: number; max: number }> = [
    { label: "0–30 days", min: 0, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "90+ days", min: 91, max: Number.POSITIVE_INFINITY },
  ];
  const ageing = buckets.map((bucket) => {
    const matching = active.filter((claim) => {
      const age = Math.floor((now - new Date(claim.createdAt).getTime()) / 86_400_000);
      return age >= bucket.min && age <= bucket.max;
    });
    return {
      label: bucket.label,
      claimCount: matching.length,
      outstanding: fromCents(
        matching.reduce((total, claim) => total + toCents(claim.outstanding), 0),
      ),
    };
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [paidThisMonth] = await database
    .select({ amount: sql<string>`coalesce(sum(${remittances.amount}), 0)` })
    .from(remittances)
    .where(
      and(
        eq(remittances.facilityId, facilityId),
        gte(remittances.receivedAt, monthStart),
      ),
    );

  const [denials] = await database
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${claimDenials.amount}), 0)`,
    })
    .from(claimDenials)
    .where(and(eq(claimDenials.facilityId, facilityId), eq(claimDenials.status, "open")));

  const [preAuths] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(preAuthorizations)
    .where(
      and(
        eq(preAuthorizations.facilityId, facilityId),
        eq(preAuthorizations.status, "requested"),
      ),
    );

  return {
    openClaims: active.length,
    openClaimValue: fromCents(active.reduce((total, claim) => total + toCents(claim.total), 0)),
    outstanding: fromCents(
      active.reduce((total, claim) => total + toCents(claim.outstanding), 0),
    ),
    paidThisMonth: fromCents(toCents(paidThisMonth?.amount ?? 0)),
    openDenials: denials?.count ?? 0,
    denialValue: fromCents(toCents(denials?.amount ?? 0)),
    pendingPreAuths: preAuths?.count ?? 0,
    ageing,
  };
}

