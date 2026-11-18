import { NextRequest } from "next/server";

import { voidDiagnosis, type VoidDiagnosisInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<VoidDiagnosisInput, unknown>(
    request,
    "Invalid diagnosis",
    voidDiagnosis,
  );
}
