import { NextRequest } from "next/server";

import { cancelLabOrder, type CancelLabOrderInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<CancelLabOrderInput, unknown>(
    request,
    "Invalid laboratory order",
    cancelLabOrder,
  );
}
