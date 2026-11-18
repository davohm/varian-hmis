import { NextRequest } from "next/server";

import { recordDiagnosis, type RecordDiagnosisInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<RecordDiagnosisInput, unknown>(
    request,
    "Invalid diagnosis",
    recordDiagnosis,
  );
}
