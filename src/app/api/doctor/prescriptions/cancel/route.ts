import { NextRequest } from "next/server";

import { cancelPrescription, type CancelPrescriptionInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<CancelPrescriptionInput, unknown>(
    request,
    "Invalid prescription",
    cancelPrescription,
  );
}
