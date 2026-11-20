import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  completeDataSubjectRequest,
  createDataSubjectRequest,
  createSharingAgreement,
  exportPatientData,
  logChartAccess,
  notifyBreach,
  recordBreach,
  recordConsent,
  recordTransferAssessment,
  restrictPatientRecord,
  withdrawConsent,
} from "@/server/commands/privacy";
import {
  getChartAccessHistory,
  getOverdueDataSubjectRequests,
  listBreaches,
  listConsents,
  listDataSubjectRequests,
  listOverdueBreaches,
  listRetentionDue,
  listSharingAgreements,
  listTransferAssessments,
} from "@/server/queries/privacy";

import { handleAdminCommand, requirePrivacyAccess } from "../_shared";

export const dynamic = "force-dynamic";

type RawInput = Record<string, unknown>;

const commands: Record<string, (input: RawInput) => Promise<unknown>> = {
  recordConsent: (input) => recordConsent(input as Parameters<typeof recordConsent>[0]),
  withdrawConsent: (input) => withdrawConsent(input as Parameters<typeof withdrawConsent>[0]),
  createDataSubjectRequest: (input) =>
    createDataSubjectRequest(input as Parameters<typeof createDataSubjectRequest>[0]),
  completeDataSubjectRequest: (input) =>
    completeDataSubjectRequest(input as Parameters<typeof completeDataSubjectRequest>[0]),
  recordBreach: (input) => recordBreach(input as Parameters<typeof recordBreach>[0]),
  notifyBreach: (input) => notifyBreach(input as Parameters<typeof notifyBreach>[0]),
  createSharingAgreement: (input) =>
    createSharingAgreement(input as Parameters<typeof createSharingAgreement>[0]),
  recordTransferAssessment: (input) =>
    recordTransferAssessment(input as Parameters<typeof recordTransferAssessment>[0]),
  restrictPatientRecord: (input) =>
    restrictPatientRecord(input as Parameters<typeof restrictPatientRecord>[0]),
  logChartAccess: (input) => logChartAccess(input as Parameters<typeof logChartAccess>[0]),
  exportPatientData: (input) => exportPatientData(input as Parameters<typeof exportPatientData>[0]),
};

export async function GET() {
  try {
    const access = await requirePrivacyAccess();
    const { facilityId } = access;

    const [consents, requests, overdueRequests, breaches, overdueBreaches, retentionDue, sharingAgreements, transfers, accessLog] =
      await Promise.all([
        listConsents(db, facilityId),
        listDataSubjectRequests(db, facilityId),
        getOverdueDataSubjectRequests(db, facilityId),
        listBreaches(db, facilityId),
        listOverdueBreaches(db, facilityId),
        listRetentionDue(db, facilityId),
        listSharingAgreements(db, facilityId),
        listTransferAssessments(db, facilityId),
        getChartAccessHistory(db, facilityId),
      ]);

    return NextResponse.json({
      facilityId,
      sections: access.sections,
      consents,
      requests,
      overdueRequests,
      breaches,
      overdueBreaches,
      retentionDue,
      sharingAgreements,
      transfers,
      accessLog,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  return handleAdminCommand(request, commands, requirePrivacyAccess);
}

export async function PUT() {
  return NextResponse.json({ error: "Use POST for privacy commands" }, { status: 405 });
}
