import { and, asc, desc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";

import { claimOutstanding } from "@/lib/finance";
import { db } from "@/server/db/client";
import {
  benefitPackageItems,
  benefitPackages,
  claimDenials,
  claimLines,
  claims,
  encounters,
  facilities,
  invoices,
  journalEntries,
  payers,
  patients,
  preAuthorizations,
  remittances,
  shaAdjudicationCodes,
  shaCoPayAssessments,
  shaEligibilityChecks,
  shaEmpanelments,
  shaPaymentReconciliation,
  shaReconciliationLines,
  shaWaivers,
} from "@/server/db/schema";
import type { ShaCoPayLine } from "@/server/db/schema/sha";

export type ShaDatabase = typeof db;

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

/* ------------------------------------------------------------------ */
/* Empanelment and benefit packages                                    */
/* ------------------------------------------------------------------ */

export interface ShaEmpanelmentRow {
  id: string;
  kmpdcNumber: string | null;
  fund: string;
  schemeCode: string;
  schemeName: string | null;
  contractNo: string | null;
  contractStatus: string;
  effectiveFrom: string;
  expiryDate: string | null;
  tariffVersion: string | null;
  qualityCertProgram: string | null;
  qualityCertExpiry: string | null;
  openedAt: string;
  closedAt: string | null;
  closureReason: string | null;
  createdAt: string;
}

export async function listEmpanelments(
  database: ShaDatabase,
  facilityId: string,
  status?: string,
): Promise<ShaEmpanelmentRow[]> {
  const conditions: SQL[] = [eq(shaEmpanelments.facilityId, facilityId)];
  if (status) conditions.push(eq(shaEmpanelments.contractStatus, status as never));
  const rows = await database
    .select()
    .from(shaEmpanelments)
    .where(and(...conditions))
    .orderBy(desc(shaEmpanelments.effectiveFrom))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    kmpdcNumber: row.kmpdcNumber,
    fund: row.fund,
    schemeCode: row.schemeCode,
    schemeName: row.schemeName,
    contractNo: row.contractNo,
    contractStatus: row.contractStatus,
    effectiveFrom: row.effectiveFrom,
    expiryDate: row.expiryDate,
    tariffVersion: row.tariffVersion,
    qualityCertProgram: row.qualityCertProgram,
    qualityCertExpiry: row.qualityCertExpiry,
    openedAt: row.openedAt.toISOString(),
    closedAt: iso(row.closedAt),
    closureReason: row.closureReason,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface BenefitPackageItemRow {
  id: string;
  serviceId: string | null;
  itemId: string | null;
  shaServiceCode: string | null;
  category: string | null;
  description: string | null;
  coverage: string;
  limitAmount: string | null;
  limitDays: string | null;
  limitVisits: string | null;
  requiresPreauth: boolean;
  preauthThreshold: string | null;
  coPayPercent: string;
  unitPrice: string;
  notes: string | null;
}

export interface BenefitPackageRow {
  id: string;
  fund: string;
  packageCode: string;
  name: string;
  careLevel: string | null;
  careType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  items: BenefitPackageItemRow[];
  createdAt: string;
}

function mapBenefitItem(row: typeof benefitPackageItems.$inferSelect): BenefitPackageItemRow {
  return {
    id: row.id,
    serviceId: row.serviceId,
    itemId: row.itemId,
    shaServiceCode: row.shaServiceCode,
    category: row.category,
    description: row.description,
    coverage: row.coverage,
    limitAmount: row.limitAmount,
    limitDays: row.limitDays,
    limitVisits: row.limitVisits,
    requiresPreauth: row.requiresPreauth,
    preauthThreshold: row.preauthThreshold,
    coPayPercent: row.coPayPercent,
    unitPrice: row.unitPrice,
    notes: row.notes,
  };
}

export async function listBenefitPackages(
  database: ShaDatabase,
  facilityId: string,
  fund?: string,
): Promise<BenefitPackageRow[]> {
  const conditions: SQL[] = [eq(benefitPackages.facilityId, facilityId)];
  if (fund) conditions.push(eq(benefitPackages.fund, fund as never));
  const packages = await database
    .select()
    .from(benefitPackages)
    .where(and(...conditions))
    .orderBy(desc(benefitPackages.effectiveFrom), asc(benefitPackages.packageCode))
    .limit(200);
  if (packages.length === 0) return [];
  const items = await database
    .select()
    .from(benefitPackageItems)
    .where(eq(benefitPackageItems.facilityId, facilityId))
    .orderBy(asc(benefitPackageItems.shaServiceCode));
  const byPackage = new Map<string, BenefitPackageItemRow[]>();
  for (const item of items) {
    const list = byPackage.get(item.benefitPackageId) ?? [];
    list.push(mapBenefitItem(item));
    byPackage.set(item.benefitPackageId, list);
  }
  return packages.map((row) => ({
    id: row.id,
    fund: row.fund,
    packageCode: row.packageCode,
    name: row.name,
    careLevel: row.careLevel,
    careType: row.careType,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    active: row.active,
    items: byPackage.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getBenefitPackage(
  database: ShaDatabase,
  facilityId: string,
  benefitPackageId: string,
): Promise<BenefitPackageRow | null> {
  const rows = await database
    .select()
    .from(benefitPackages)
    .where(
      and(eq(benefitPackages.facilityId, facilityId), eq(benefitPackages.id, benefitPackageId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const items = await database
    .select()
    .from(benefitPackageItems)
    .where(
      and(
        eq(benefitPackageItems.facilityId, facilityId),
        eq(benefitPackageItems.benefitPackageId, benefitPackageId),
      ),
    )
    .orderBy(asc(benefitPackageItems.shaServiceCode));
  return {
    id: row.id,
    fund: row.fund,
    packageCode: row.packageCode,
    name: row.name,
    careLevel: row.careLevel,
    careType: row.careType,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    active: row.active,
    items: items.map(mapBenefitItem),
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Eligibility and coverage                                            */
/* ------------------------------------------------------------------ */

export interface EligibilityCheckRow {
  id: string;
  patientId: string;
  payerId: string | null;
  empanelmentId: string | null;
  fund: string | null;
  memberRef: string | null;
  eligibility: string;
  checkRef: string | null;
  checkedAt: string;
  notes: string | null;
}

export interface PatientBenefitCoverage {
  patient: {
    id: string;
    mrn: string;
    name: string;
    payerType: string;
    payerMemberNo: string | null;
  };
  eligibility: EligibilityCheckRow | null;
  checks: EligibilityCheckRow[];
  packages: BenefitPackageRow[];
}

/** Latest eligibility plus effective benefit items for a patient claim builder. */
export async function getPatientBenefitCoverage(
  database: ShaDatabase,
  facilityId: string,
  patientId: string,
  fund?: string,
): Promise<PatientBenefitCoverage | null> {
  const patientRows = await database
    .select({
      id: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      payerType: patients.payerType,
      payerMemberNo: patients.payerMemberNo,
    })
    .from(patients)
    .where(and(eq(patients.facilityId, facilityId), eq(patients.id, patientId)))
    .limit(1);
  const patient = patientRows[0];
  if (!patient) return null;

  const checks = await database
    .select()
    .from(shaEligibilityChecks)
    .where(
      and(eq(shaEligibilityChecks.facilityId, facilityId), eq(shaEligibilityChecks.patientId, patientId)),
    )
    .orderBy(desc(shaEligibilityChecks.checkedAt))
    .limit(20);
  const mapCheck = (row: typeof shaEligibilityChecks.$inferSelect): EligibilityCheckRow => ({
    id: row.id,
    patientId: row.patientId,
    payerId: row.payerId,
    empanelmentId: row.empanelmentId,
    fund: row.fund,
    memberRef: row.memberRef,
    eligibility: row.eligibility,
    checkRef: row.checkRef,
    checkedAt: row.checkedAt.toISOString(),
    notes: row.notes,
  });
  const mapped = checks.map(mapCheck);
  const packages = await listBenefitPackages(database, facilityId, fund);
  return {
    patient: {
      id: patient.id,
      mrn: patient.mrn,
      name: `${patient.firstName} ${patient.lastName}`.trim(),
      payerType: patient.payerType,
      payerMemberNo: patient.payerMemberNo,
    },
    eligibility: mapped[0] ?? null,
    checks: mapped,
    packages: packages.filter(
      (row) => row.active && !row.effectiveTo,
    ),
  };
}

export interface ShaCoPayAssessmentRow {
  id: string;
  patientId: string;
  encounterId: string;
  invoiceId: string;
  empanelmentId: string;
  benefitPackageId: string;
  eligibilityCheckId: string | null;
  payerId: string | null;
  fund: string;
  amount: string;
  lines: ShaCoPayLine[];
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
  createdAt: string;
}

/** Cashier co-pay assessments retained for the patient before a claim exists. */
export async function listShaCoPayAssessments(
  database: ShaDatabase,
  facilityId: string,
  patientId?: string,
): Promise<ShaCoPayAssessmentRow[]> {
  const conditions: SQL[] = [eq(shaCoPayAssessments.facilityId, facilityId)];
  if (patientId) conditions.push(eq(shaCoPayAssessments.patientId, patientId));
  const rows = await database
    .select()
    .from(shaCoPayAssessments)
    .where(and(...conditions))
    .orderBy(desc(shaCoPayAssessments.recordedAt))
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    patientId: row.patientId,
    encounterId: row.encounterId,
    invoiceId: row.invoiceId,
    empanelmentId: row.empanelmentId,
    benefitPackageId: row.benefitPackageId,
    eligibilityCheckId: row.eligibilityCheckId,
    payerId: row.payerId,
    fund: row.fund,
    amount: row.amount,
    lines: row.lines,
    notes: row.notes,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export interface ShaClaimRow {
  id: string;
  claimNo: string;
  shaClaimRef: string | null;
  fund: string | null;
  status: string;
  patientId: string;
  patientName: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  payerName: string;
  empanelmentId: string | null;
  benefitPackageId: string | null;
  billedAmount: string;
  patientCoPay: string;
  total: string;
  approvedAmount: string;
  paidAmount: string;
  outstanding: string;
  adjudicationCode: string | null;
  submissionBatch: string | null;
  submittedAt: string | null;
  createdAt: string;
  supersedesClaimId: string | null;
  denialCount: number;
}

export interface ShaClaimFilters {
  status?: string;
  fund?: string;
  shaClaimRef?: string;
  limit?: number;
}

export async function listShaClaims(
  database: ShaDatabase,
  facilityId: string,
  filters: ShaClaimFilters = {},
): Promise<ShaClaimRow[]> {
  const conditions: SQL[] = [
    eq(claims.facilityId, facilityId),
    or(isNotNull(claims.fund), isNotNull(claims.empanelmentId), isNotNull(claims.shaClaimRef))!,
  ];
  if (filters.status) conditions.push(eq(claims.status, filters.status as never));
  if (filters.fund) conditions.push(eq(claims.fund, filters.fund as never));
  if (filters.shaClaimRef) conditions.push(eq(claims.shaClaimRef, filters.shaClaimRef));

  const rows = await database
    .select({
      claim: claims,
      firstName: patients.firstName,
      lastName: patients.lastName,
      mrn: patients.mrn,
      encounterNo: encounters.encounterNo,
      invoiceNo: invoices.invoiceNo,
      payerName: payers.name,
      denialCount: sql<number>`(select count(*)::int from ${claimDenials} where ${claimDenials.claimId} = ${claims.id})`,
    })
    .from(claims)
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .innerJoin(patients, eq(claims.patientId, patients.id))
    .innerJoin(encounters, eq(claims.encounterId, encounters.id))
    .leftJoin(invoices, eq(claims.invoiceId, invoices.id))
    .where(and(...conditions))
    .orderBy(desc(claims.createdAt))
    .limit(Math.min(Math.max(Math.trunc(filters.limit ?? 200), 1), 500));

  return rows.map(({ claim, firstName, lastName, mrn, encounterNo, invoiceNo, payerName, denialCount }) => {
    const target = toCentsSafe(claim.approvedAmount) > 0 ? claim.approvedAmount : claim.total;
    return {
      id: claim.id,
      claimNo: claim.claimNo,
      shaClaimRef: claim.shaClaimRef,
      fund: claim.fund,
      status: claim.status,
      patientId: claim.patientId,
      patientName: `${firstName} ${lastName}`.trim(),
      mrn,
      encounterId: claim.encounterId,
      encounterNo,
      invoiceId: claim.invoiceId,
      invoiceNo,
      payerName,
      empanelmentId: claim.empanelmentId,
      benefitPackageId: claim.benefitPackageId,
      billedAmount: claim.billedAmount,
      patientCoPay: claim.patientCoPay,
      total: claim.total,
      approvedAmount: claim.approvedAmount,
      paidAmount: claim.paidAmount,
      outstanding: claimOutstanding(target, claim.paidAmount),
      adjudicationCode: claim.adjudicationCode,
      submissionBatch: claim.submissionBatch,
      submittedAt: iso(claim.submittedAt),
      createdAt: claim.createdAt.toISOString(),
      supersedesClaimId: claim.supersedesClaimId,
      denialCount,
    };
  });
}

function toCentsSafe(value: string): number {
  return Math.round(Number(value || "0") * 100);
}

export interface ShaClaimDetail extends ShaClaimRow {
  notes: string | null;
  tariffVersion: string | null;
  adjudicationStatus: string | null;
  waiverId: string | null;
  preAuthId: string | null;
  coPayAssessmentId: string | null;
  approvedAt: string | null;
  submittedBy: string | null;
  facilityName: string | null;
  facilityAddress: string | null;
  empanelment: {
    id: string;
    kmpdcNumber: string | null;
    fund: string;
    schemeCode: string;
    contractNo: string | null;
    tariffVersion: string | null;
  } | null;
  benefitPackage: { id: string; packageCode: string; name: string } | null;
  invoice: {
    id: string;
    invoiceNo: string;
    total: string;
    status: string;
    isShaClaimable: boolean;
  } | null;
  encounter: {
    id: string;
    encounterNo: string;
    startedAt: string;
    status: string;
  };
  preAuth: {
    id: string;
    authNo: string;
    shaAuthRef: string | null;
    status: string;
    expiresAt: string | null;
  } | null;
  lines: Array<{
    id: string;
    description: string;
    shaServiceCode: string | null;
    quantity: string;
    unitPrice: string;
    amount: string;
    approvedAmount: string;
    shaPatientPay: boolean;
    shaCoverage: string | null;
    shaBilledAmount: string;
    shaPatientAmount: string;
    shaPreauthRequired: boolean;
    denialCode: string | null;
    denialReason: string | null;
  }>;
  remittances: Array<{
    id: string;
    remittanceNo: string;
    amount: string;
    receivedAt: string;
    shaPaymentReportRef: string | null;
    bankReference: string | null;
    paymentDate: string | null;
    reference: string | null;
    claimLineId: string | null;
  }>;
  denials: Array<{
    id: string;
    amount: string;
    code: string | null;
    reason: string;
    status: string;
    createdAt: string;
  }>;
}

export async function getShaClaim(
  database: ShaDatabase,
  facilityId: string,
  claimId: string,
): Promise<ShaClaimDetail | null> {
  const [row] = await database
    .select({
      claim: claims,
      firstName: patients.firstName,
      lastName: patients.lastName,
      mrn: patients.mrn,
      encounterNo: encounters.encounterNo,
      encounterStartedAt: encounters.startedAt,
      encounterStatus: encounters.status,
      facilityName: facilities.name,
      facilityAddress: facilities.physicalAddress,
      invoiceNo: invoices.invoiceNo,
      invoiceTotal: invoices.total,
      invoiceStatus: invoices.status,
      invoiceClaimable: invoices.isShaClaimable,
      payerName: payers.name,
      denialCount: sql<number>`(select count(*)::int from ${claimDenials} where ${claimDenials.claimId} = ${claims.id})`,
    })
    .from(claims)
    .innerJoin(payers, eq(claims.payerId, payers.id))
    .innerJoin(patients, eq(claims.patientId, patients.id))
    .innerJoin(encounters, eq(claims.encounterId, encounters.id))
    .innerJoin(facilities, eq(claims.facilityId, facilities.id))
    .leftJoin(invoices, eq(claims.invoiceId, invoices.id))
    .where(and(eq(claims.facilityId, facilityId), eq(claims.id, claimId)))
    .limit(1);
  if (!row) return null;
  const claim = row.claim;

  const [empanelment, benefitPackage, preauth, lines, cash, denials] = await Promise.all([
    claim.empanelmentId
      ? database
          .select({
            id: shaEmpanelments.id,
            kmpdcNumber: shaEmpanelments.kmpdcNumber,
            fund: shaEmpanelments.fund,
            schemeCode: shaEmpanelments.schemeCode,
            contractNo: shaEmpanelments.contractNo,
            tariffVersion: shaEmpanelments.tariffVersion,
          })
          .from(shaEmpanelments)
          .where(eq(shaEmpanelments.id, claim.empanelmentId))
          .limit(1)
      : Promise.resolve([]),
    claim.benefitPackageId
      ? database
          .select({
            id: benefitPackages.id,
            packageCode: benefitPackages.packageCode,
            name: benefitPackages.name,
          })
          .from(benefitPackages)
          .where(eq(benefitPackages.id, claim.benefitPackageId))
          .limit(1)
      : Promise.resolve([]),
    database
      .select({
        id: preAuthorizations.id,
        authNo: preAuthorizations.authNo,
        shaAuthRef: preAuthorizations.shaAuthRef,
        status: preAuthorizations.status,
        expiresAt: preAuthorizations.expiresAt,
      })
      .from(preAuthorizations)
      .where(
        claim.preAuthId
          ? eq(preAuthorizations.id, claim.preAuthId)
          : and(
              eq(preAuthorizations.facilityId, facilityId),
              eq(preAuthorizations.patientId, claim.patientId),
              eq(preAuthorizations.fund, claim.fund ?? ""),
            ),
      )
      .orderBy(desc(preAuthorizations.createdAt))
      .limit(1),
    database
      .select()
      .from(claimLines)
      .where(and(eq(claimLines.claimId, claimId), eq(claimLines.facilityId, facilityId)))
      .orderBy(asc(claimLines.createdAt)),
    database
      .select()
      .from(remittances)
      .where(and(eq(remittances.claimId, claimId), eq(remittances.facilityId, facilityId)))
      .orderBy(desc(remittances.receivedAt)),
    database
      .select()
      .from(claimDenials)
      .where(and(eq(claimDenials.claimId, claimId), eq(claimDenials.facilityId, facilityId)))
      .orderBy(desc(claimDenials.createdAt)),
  ]);

  const target = toCentsSafe(claim.approvedAmount) > 0 ? claim.approvedAmount : claim.total;
  return {
    id: claim.id,
    claimNo: claim.claimNo,
    shaClaimRef: claim.shaClaimRef,
    fund: claim.fund,
    status: claim.status,
    patientId: claim.patientId,
    patientName: `${row.firstName} ${row.lastName}`.trim(),
    mrn: row.mrn,
    encounterId: claim.encounterId,
    encounterNo: row.encounterNo,
    invoiceId: claim.invoiceId,
    invoiceNo: row.invoiceNo,
    payerName: row.payerName,
    empanelmentId: claim.empanelmentId,
    benefitPackageId: claim.benefitPackageId,
    billedAmount: claim.billedAmount,
    patientCoPay: claim.patientCoPay,
    total: claim.total,
    approvedAmount: claim.approvedAmount,
    paidAmount: claim.paidAmount,
    outstanding: claimOutstanding(target, claim.paidAmount),
    adjudicationCode: claim.adjudicationCode,
    submissionBatch: claim.submissionBatch,
    submittedAt: iso(claim.submittedAt),
    createdAt: claim.createdAt.toISOString(),
    supersedesClaimId: claim.supersedesClaimId,
    denialCount: row.denialCount,
    notes: claim.notes,
    tariffVersion: claim.tariffVersion,
    adjudicationStatus: claim.adjudicationStatus,
    waiverId: claim.waiverId,
    preAuthId: claim.preAuthId,
    coPayAssessmentId: claim.coPayAssessmentId,
    approvedAt: iso(claim.approvedAt),
    submittedBy: claim.submittedBy,
    facilityName: row.facilityName,
    facilityAddress: row.facilityAddress,
    empanelment: empanelment[0] ?? null,
    benefitPackage: benefitPackage[0] ?? null,
    invoice: claim.invoiceId
      ? {
          id: claim.invoiceId,
          invoiceNo: row.invoiceNo ?? "",
          total: row.invoiceTotal ?? "0",
          status: row.invoiceStatus ?? "open",
          isShaClaimable: Boolean(row.invoiceClaimable),
        }
      : null,
    encounter: {
      id: claim.encounterId,
      encounterNo: row.encounterNo,
      startedAt: row.encounterStartedAt.toISOString(),
      status: row.encounterStatus,
    },
    preAuth: preauth[0]
      ? {
          id: preauth[0].id,
          authNo: preauth[0].authNo,
          shaAuthRef: preauth[0].shaAuthRef,
          status: preauth[0].status,
          expiresAt: preauth[0].expiresAt,
        }
      : null,
    lines: lines.map((line) => ({
      id: line.id,
      description: line.description,
      shaServiceCode: line.shaServiceCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      approvedAmount: line.approvedAmount,
      shaPatientPay: line.shaPatientPay,
      shaCoverage: line.shaCoverage,
      shaBilledAmount: line.shaBilledAmount,
      shaPatientAmount: line.shaPatientAmount,
      shaPreauthRequired: line.shaPreauthRequired,
      denialCode: line.denialCode,
      denialReason: line.denialReason,
    })),
    remittances: cash.map((item) => ({
      id: item.id,
      remittanceNo: item.remittanceNo,
      amount: item.amount,
      receivedAt: item.receivedAt.toISOString(),
      shaPaymentReportRef: item.shaPaymentReportRef,
      bankReference: item.bankReference,
      paymentDate: item.paymentDate,
      reference: item.reference,
      claimLineId: item.claimLineId,
    })),
    denials: denials.map((item) => ({
      id: item.id,
      amount: item.amount,
      code: item.shaDenialCode,
      reason: item.reason,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Remittances and reconciliation                                      */
/* ------------------------------------------------------------------ */

export interface ShaRemittanceRow {
  id: string;
  remittanceNo: string;
  claimId: string;
  claimNo: string;
  shaClaimRef: string | null;
  patientName: string;
  amount: string;
  receivedAt: string;
  shaPaymentReportRef: string | null;
  bankReference: string | null;
  paymentDate: string | null;
  reference: string | null;
  claimLineId: string | null;
  lineDescription: string | null;
}

export async function listShaRemittances(
  database: ShaDatabase,
  facilityId: string,
  limit = 200,
): Promise<ShaRemittanceRow[]> {
  const rows = await database
    .select({
      remittance: remittances,
      claimNo: claims.claimNo,
      shaClaimRef: claims.shaClaimRef,
      firstName: patients.firstName,
      lastName: patients.lastName,
      lineDescription: claimLines.description,
    })
    .from(remittances)
    .innerJoin(claims, eq(remittances.claimId, claims.id))
    .innerJoin(patients, eq(claims.patientId, patients.id))
    .leftJoin(claimLines, eq(remittances.claimLineId, claimLines.id))
    .where(
      and(
        eq(remittances.facilityId, facilityId),
        or(isNotNull(claims.fund), isNotNull(claims.shaClaimRef))!,
      ),
    )
    .orderBy(desc(remittances.receivedAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 500));
  return rows.map(({ remittance, claimNo, shaClaimRef, firstName, lastName, lineDescription }) => ({
    id: remittance.id,
    remittanceNo: remittance.remittanceNo,
    claimId: remittance.claimId,
    claimNo,
    shaClaimRef,
    patientName: `${firstName} ${lastName}`.trim(),
    amount: remittance.amount,
    receivedAt: remittance.receivedAt.toISOString(),
    shaPaymentReportRef: remittance.shaPaymentReportRef,
    bankReference: remittance.bankReference,
    paymentDate: remittance.paymentDate,
    reference: remittance.reference,
    claimLineId: remittance.claimLineId,
    lineDescription,
  }));
}

export interface ShaReconciliationLineRow {
  id: string;
  claimId: string | null;
  claimNo: string | null;
  shaAmount: string;
  facilityAmount: string;
  variance: string;
  status: string;
  reason: string | null;
}

export interface ShaReconciliationRow {
  id: string;
  kmpdcNumber: string;
  reportPeriod: string;
  reportRef: string | null;
  shaReportedAmount: string;
  facilityInvoicedAmount: string;
  matchedAmount: string;
  unmatchedAmount: string;
  variance: string;
  status: string;
  journalEntryNo: string | null;
  generatedAt: string;
  lines: ShaReconciliationLineRow[];
}

export async function getShaReconciliation(
  database: ShaDatabase,
  facilityId: string,
  reconciliationId?: string,
): Promise<ShaReconciliationRow | null> {
  const conditions: SQL[] = [eq(shaPaymentReconciliation.facilityId, facilityId)];
  if (reconciliationId) conditions.push(eq(shaPaymentReconciliation.id, reconciliationId));
  const rows = await database
    .select({
      reconciliation: shaPaymentReconciliation,
      journalEntryNo: journalEntries.entryNo,
    })
    .from(shaPaymentReconciliation)
    .leftJoin(journalEntries, eq(shaPaymentReconciliation.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(desc(shaPaymentReconciliation.generatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const lines = await database
    .select()
    .from(shaReconciliationLines)
    .where(
      and(
        eq(shaReconciliationLines.facilityId, facilityId),
        eq(shaReconciliationLines.reconciliationId, row.reconciliation.id),
      ),
    )
    .orderBy(asc(shaReconciliationLines.claimNo));
  return {
    id: row.reconciliation.id,
    kmpdcNumber: row.reconciliation.kmpdcNumber,
    reportPeriod: row.reconciliation.reportPeriod,
    reportRef: row.reconciliation.reportRef,
    shaReportedAmount: row.reconciliation.shaReportedAmount,
    facilityInvoicedAmount: row.reconciliation.facilityInvoicedAmount,
    matchedAmount: row.reconciliation.matchedAmount,
    unmatchedAmount: row.reconciliation.unmatchedAmount,
    variance: row.reconciliation.variance,
    status: row.reconciliation.status,
    journalEntryNo: row.journalEntryNo,
    generatedAt: row.reconciliation.generatedAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      claimId: line.claimId,
      claimNo: line.claimNo,
      shaAmount: line.shaAmount,
      facilityAmount: line.facilityAmount,
      variance: line.variance,
      status: line.status,
      reason: line.reason,
    })),
  };
}

export async function listShaReconciliations(
  database: ShaDatabase,
  facilityId: string,
): Promise<Array<Omit<ShaReconciliationRow, "lines">>> {
  const rows = await database
    .select({
      reconciliation: shaPaymentReconciliation,
      journalEntryNo: journalEntries.entryNo,
    })
    .from(shaPaymentReconciliation)
    .leftJoin(journalEntries, eq(shaPaymentReconciliation.journalEntryId, journalEntries.id))
    .where(eq(shaPaymentReconciliation.facilityId, facilityId))
    .orderBy(desc(shaPaymentReconciliation.generatedAt))
    .limit(100);
  return rows.map(({ reconciliation, journalEntryNo }) => ({
    id: reconciliation.id,
    kmpdcNumber: reconciliation.kmpdcNumber,
    reportPeriod: reconciliation.reportPeriod,
    reportRef: reconciliation.reportRef,
    shaReportedAmount: reconciliation.shaReportedAmount,
    facilityInvoicedAmount: reconciliation.facilityInvoicedAmount,
    matchedAmount: reconciliation.matchedAmount,
    unmatchedAmount: reconciliation.unmatchedAmount,
    variance: reconciliation.variance,
    status: reconciliation.status,
    journalEntryNo,
    generatedAt: reconciliation.generatedAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Claim ageing and reference codes                                    */
/* ------------------------------------------------------------------ */

export interface ShaAgeingBucket {
  label: string;
  claimCount: number;
  outstanding: string;
}

export async function getShaClaimAging(
  database: ShaDatabase,
  facilityId: string,
): Promise<ShaAgeingBucket[]> {
  const claims = await listShaClaims(database, facilityId, { limit: 500 });
  const active = claims.filter((claim) =>
    ["draft", "submitted", "accepted", "queried", "resubmitted"].includes(claim.status),
  );
  const now = Date.now();
  const buckets: Array<{ label: string; min: number; max: number }> = [
    { label: "0–30 days", min: 0, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "90+ days", min: 91, max: Number.POSITIVE_INFINITY },
  ];
  return buckets.map((bucket) => {
    const matching = active.filter((claim) => {
      const age = Math.floor((now - new Date(claim.createdAt).getTime()) / 86_400_000);
      return age >= bucket.min && age <= bucket.max;
    });
    return {
      label: bucket.label,
      claimCount: matching.length,
      outstanding: matching
        .reduce((sum, claim) => sum + toCentsSafe(claim.outstanding), 0)
        .toFixed(2),
    };
  });
}

export interface ShaAdjudicationCodeRow {
  id: string;
  code: string;
  description: string;
  category: string;
  retryable: boolean;
  actionHint: string | null;
}

export async function listShaAdjudicationCodes(
  database: ShaDatabase,
  facilityId: string,
): Promise<ShaAdjudicationCodeRow[]> {
  return database
    .select({
      id: shaAdjudicationCodes.id,
      code: shaAdjudicationCodes.code,
      description: shaAdjudicationCodes.description,
      category: shaAdjudicationCodes.category,
      retryable: shaAdjudicationCodes.retryable,
      actionHint: shaAdjudicationCodes.actionHint,
    })
    .from(shaAdjudicationCodes)
    .where(and(eq(shaAdjudicationCodes.facilityId, facilityId), eq(shaAdjudicationCodes.active, true)))
    .orderBy(asc(shaAdjudicationCodes.code));
}

export interface ShaPreAuthRow {
  id: string;
  authNo: string;
  shaAuthRef: string | null;
  patientId: string;
  patientName: string;
  fund: string | null;
  status: string;
  requestedAmount: string;
  approvedAmount: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listShaPreAuthorizations(
  database: ShaDatabase,
  facilityId: string,
): Promise<ShaPreAuthRow[]> {
  const rows = await database
    .select({
      auth: preAuthorizations,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(preAuthorizations)
    .innerJoin(patients, eq(preAuthorizations.patientId, patients.id))
    .where(
      and(
        eq(preAuthorizations.facilityId, facilityId),
        or(isNotNull(preAuthorizations.fund), isNotNull(preAuthorizations.shaAuthRef))!,
      ),
    )
    .orderBy(desc(preAuthorizations.createdAt))
    .limit(200);
  return rows.map(({ auth, firstName, lastName }) => ({
    id: auth.id,
    authNo: auth.authNo,
    shaAuthRef: auth.shaAuthRef,
    patientId: auth.patientId,
    patientName: `${firstName} ${lastName}`.trim(),
    fund: auth.fund,
    status: auth.status,
    requestedAmount: auth.requestedAmount,
    approvedAmount: auth.approvedAmount,
    expiresAt: auth.expiresAt,
    createdAt: auth.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Waivers and eligibility history                                     */
/* ------------------------------------------------------------------ */

export interface ShaWaiverRow {
  id: string;
  kind: string;
  claimId: string | null;
  claimNo: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  amount: string;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  status: string;
  decidedAt: string | null;
  createdAt: string;
}

export async function listShaWaivers(
  database: ShaDatabase,
  facilityId: string,
): Promise<ShaWaiverRow[]> {
  const rows = await database
    .select({
      waiver: shaWaivers,
      claimNo: claims.claimNo,
      invoiceNo: invoices.invoiceNo,
    })
    .from(shaWaivers)
    .leftJoin(claims, eq(shaWaivers.claimId, claims.id))
    .leftJoin(invoices, eq(shaWaivers.invoiceId, invoices.id))
    .where(eq(shaWaivers.facilityId, facilityId))
    .orderBy(desc(shaWaivers.createdAt))
    .limit(200);
  return rows.map(({ waiver, claimNo, invoiceNo }) => ({
    id: waiver.id,
    kind: waiver.kind,
    claimId: waiver.claimId,
    claimNo,
    invoiceId: waiver.invoiceId,
    invoiceNo,
    amount: waiver.amount,
    reason: waiver.reason,
    requestedBy: waiver.requestedBy,
    approvedBy: waiver.approvedBy,
    status: waiver.status,
    decidedAt: iso(waiver.decidedAt),
    createdAt: waiver.createdAt.toISOString(),
  }));
}

export async function listShaEligibilityChecks(
  database: ShaDatabase,
  facilityId: string,
  limit = 100,
): Promise<EligibilityCheckRow[]> {
  const rows = await database
    .select()
    .from(shaEligibilityChecks)
    .where(eq(shaEligibilityChecks.facilityId, facilityId))
    .orderBy(desc(shaEligibilityChecks.checkedAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 500));
  return rows.map((row) => ({
    id: row.id,
    patientId: row.patientId,
    payerId: row.payerId,
    empanelmentId: row.empanelmentId,
    fund: row.fund,
    memberRef: row.memberRef,
    eligibility: row.eligibility,
    checkRef: row.checkRef,
    checkedAt: row.checkedAt.toISOString(),
    notes: row.notes,
  }));
}
