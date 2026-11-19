import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  createLicenceAlertRule,
  updateFacilityLicence,
  upsertFacilityIdentifier,
  upsertFacilityRegulatoryProfile,
  upsertFacilitySetting,
  upsertIntegrationSetting,
  upsertPractitionerRegistration,
  upsertShaAdjudicationCode,
  upsertStatutoryFeeSchedule,
  upsertStatutoryRate,
  upsertSupportServiceLicence,
  verifyIntegrationConnection,
  verifyPractitionerLicence,
} from "@/server/commands/regulatory";
import {
  getFacilityIdentifiers,
  getFacilityReadinessStatus,
  getFacilityRegulatoryProfile,
  listExpiringLicences,
  listFacilityLicences,
  listFacilitySettings,
  listFacilityStaffProfiles,
  listIntegrationSettings,
  listLicenceAlertRules,
  listPractitionerRegistrations,
  listShaAdjudicationCodes,
  listStatutoryFeeSchedules,
  listStatutoryRates,
  listSupportServiceLicences,
} from "@/server/queries/regulatory";

import { handleAdminCommand, requireRegulatoryAccess } from "../_shared";

export const dynamic = "force-dynamic";

type RawInput = Record<string, unknown>;

const commands: Record<string, (input: RawInput) => Promise<unknown>> = {
  upsertFacilityRegulatoryProfile: (input) =>
    upsertFacilityRegulatoryProfile(input as Parameters<typeof upsertFacilityRegulatoryProfile>[0]),
  updateFacilityLicence: (input) =>
    updateFacilityLicence(input as Parameters<typeof updateFacilityLicence>[0]),
  upsertPractitionerRegistration: (input) =>
    upsertPractitionerRegistration(input as Parameters<typeof upsertPractitionerRegistration>[0]),
  verifyPractitionerLicence: (input) =>
    verifyPractitionerLicence(input as Parameters<typeof verifyPractitionerLicence>[0]),
  upsertSupportServiceLicence: (input) =>
    upsertSupportServiceLicence(input as Parameters<typeof upsertSupportServiceLicence>[0]),
  upsertFacilityIdentifier: (input) =>
    upsertFacilityIdentifier(input as Parameters<typeof upsertFacilityIdentifier>[0]),
  createLicenceAlertRule: (input) =>
    createLicenceAlertRule(input as Parameters<typeof createLicenceAlertRule>[0]),
  upsertFacilitySetting: (input) =>
    upsertFacilitySetting(input as Parameters<typeof upsertFacilitySetting>[0]),
  upsertStatutoryRate: (input) =>
    upsertStatutoryRate(input as Parameters<typeof upsertStatutoryRate>[0]),
  upsertStatutoryFeeSchedule: (input) =>
    upsertStatutoryFeeSchedule(input as Parameters<typeof upsertStatutoryFeeSchedule>[0]),
  upsertShaAdjudicationCode: (input) =>
    upsertShaAdjudicationCode(input as Parameters<typeof upsertShaAdjudicationCode>[0]),
  upsertIntegrationSetting: (input) =>
    upsertIntegrationSetting(input as Parameters<typeof upsertIntegrationSetting>[0]),
  verifyIntegrationConnection: (input) =>
    verifyIntegrationConnection(input as Parameters<typeof verifyIntegrationConnection>[0]),
};

export async function GET() {
  try {
    const access = await requireRegulatoryAccess();
    const { facilityId } = access;

    const [
      profile,
      licences,
      practitioners,
      supportServices,
      identifiers,
      readiness,
      expiring,
      settings,
      rates,
      fees,
      shaCodes,
      integrations,
      staff,
      alertRules,
    ] = await Promise.all([
      getFacilityRegulatoryProfile(db, facilityId),
      listFacilityLicences(db, facilityId),
      listPractitionerRegistrations(db, facilityId),
      listSupportServiceLicences(db, facilityId),
      getFacilityIdentifiers(db, facilityId),
      getFacilityReadinessStatus(db, facilityId),
      listExpiringLicences(db, facilityId, { withinDays: 30 }),
      listFacilitySettings(db, facilityId),
      listStatutoryRates(db, facilityId),
      listStatutoryFeeSchedules(db, facilityId),
      listShaAdjudicationCodes(db, facilityId),
      listIntegrationSettings(db, facilityId),
      listFacilityStaffProfiles(db, facilityId),
      listLicenceAlertRules(db, facilityId),
    ]);

    return NextResponse.json({
      facilityId,
      sections: access.sections,
      profile,
      licences,
      practitioners,
      supportServices,
      identifiers,
      readiness,
      expiring,
      settings,
      rates,
      fees,
      shaCodes,
      integrations,
      staff,
      alertRules,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  return handleAdminCommand(request, commands, requireRegulatoryAccess);
}

export async function PUT() {
  return NextResponse.json({ error: "Use POST for regulatory commands" }, { status: 405 });
}
