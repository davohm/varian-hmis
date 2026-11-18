import { NextRequest } from "next/server";

import { startConsultation, type StartConsultationInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<StartConsultationInput, unknown>(
    request,
    "Invalid consultation request",
    startConsultation,
  );
}
