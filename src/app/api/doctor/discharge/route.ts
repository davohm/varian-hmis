import { NextRequest } from "next/server";

import { dischargeEncounter, type DischargeEncounterInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<DischargeEncounterInput, unknown>(
    request,
    "Invalid discharge request",
    dischargeEncounter,
  );
}
