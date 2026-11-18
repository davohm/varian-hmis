import { NextRequest } from "next/server";

import { orderLabTests, type OrderLabTestsInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<OrderLabTestsInput, unknown>(
    request,
    "Invalid laboratory order",
    orderLabTests,
  );
}
