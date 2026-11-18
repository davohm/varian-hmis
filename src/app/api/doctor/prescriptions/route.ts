import { NextRequest } from "next/server";

import { prescribe, type PrescribeInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<PrescribeInput, unknown>(
    request,
    "Invalid prescription",
    prescribe,
  );
}
