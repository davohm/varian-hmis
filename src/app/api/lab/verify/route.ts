import { NextRequest } from "next/server";

import { verifyLabResults, type VerifyLabResultsInput } from "@/server/commands/lab";

import { handleLabCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleLabCommand<VerifyLabResultsInput, unknown>(
    request,
    "Invalid verification request",
    verifyLabResults,
  );
}
